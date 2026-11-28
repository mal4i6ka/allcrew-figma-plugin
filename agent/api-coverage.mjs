#!/usr/bin/env node
/**
 * What the official plugin API offers, and what our channel reaches.
 *
 * The list of "recent API areas" cannot be a list somebody remembers: it has to be derived, or it
 * is out of date the week after it is written. So it is derived twice —
 *
 *   the SURFACE, from `@figma/plugin-typings` as installed: every interface, type and member,
 *   which is the whole API and nothing anyone had to transcribe;
 *
 *   the ORDER, from the diff between published versions of those same typings: what each release
 *   ADDED, newest first. A changelog says what Figma thought worth announcing; a diff says what
 *   actually appeared.
 *
 * Against that goes what our own source touches. That signal is deliberately crude — a word
 * present anywhere in `src/` — because the alternative (parsing which command reaches which call)
 * is a second program with its own bugs. A hit here means "we have heard of it"; a MISS is the
 * honest finding, and misses are what the ledger is for.
 *
 *   node agent/api-coverage.mjs                         # print the ledger
 *   node agent/api-coverage.mjs --releases 1.107.0     # include release history
 *   node agent/api-coverage.mjs --releases 1.107.0 --write
 *
 * `--write` replaces the generated block in TASK-api-coverage.md. `--releases` fetches tarballs
 * from npm into a cache directory; without network it prints the namespace half alone.
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TYPINGS = join(ROOT, 'node_modules/@figma/plugin-typings/plugin-api.d.ts')
const CACHE = join(ROOT, 'node_modules/.cache/figma-typings')

/* ------------------------------------------------------------------ the surface */

const DECL = /^(?:export\s+)?(?:declare\s+)?(interface|type|enum|namespace|class)\s+([A-Za-z0-9_]+)/
const MEMBER = /^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*[(:<]/
const KEYWORDS = new Set(['readonly', 'export', 'declare', 'interface', 'type', 'enum', 'namespace', 'class', 'extends', 'return', 'if', 'else'])

/**
 * Every declaration, plus every member qualified by the block that holds it.
 *
 * A block is pushed when its opening brace arrives rather than when its name does: `interface
 * TextNode extends …` wraps over several lines, and pushing on the name lost every member of the
 * node types that matter most.
 */
export function surfaceOf(source) {
  const out = new Set()
  const stack = []
  let pending = null
  let depth = 0
  // Inside a parameter list that wraps over lines, `layoutGrid: LayoutGrid,` is a parameter, not
  // a member — counting it made `VariablesAPI.layoutGrid` and `PluginAPI.targetNode` "gaps".
  let parens = 0

  for (const raw of source.split('\n')) {
    const line = raw.split('//')[0]
    const declared = DECL.exec(line.trim())
    if (declared) {
      out.add(declared[2])
      pending = ['interface', 'namespace', 'class'].includes(declared[1]) ? declared[2] : null
    } else if (stack.length > 0 && depth === stack[stack.length - 1][1] + 1 && parens === 0) {
      const member = MEMBER.exec(raw)
      if (member && !KEYWORDS.has(member[1])) out.add(`${stack[stack.length - 1][0]}.${member[1]}`)
    }
    if (!line.trim().startsWith('*')) parens = Math.max(0, parens + (line.match(/\(/g)?.length ?? 0) - (line.match(/\)/g)?.length ?? 0))

    for (let index = 0; index < (line.match(/{/g)?.length ?? 0); index++) {
      if (pending !== null) {
        stack.push([pending, depth])
        pending = null
      }
      depth++
    }
    depth -= line.match(/}/g)?.length ?? 0
    while (stack.length > 0 && depth <= stack[stack.length - 1][1]) stack.pop()
  }
  return out
}

/**
 * What the typings themselves say about a member: which editors it is limited to (`Note: This API
 * is only available in FigJam`) and whether it is `@deprecated`. A gap in FigJam's sticky notes is
 * not a gap in a plugin that declares `editorType: ["figma", "dev"]`, and a deprecated synchronous
 * getter is not one in a `dynamic-page` plugin that is forbidden to call it — so both are counted
 * apart instead of inflating the "untouched" column. Derived from the same file, never listed.
 */
export function notesOf(source) {
  const notes = new Map()
  const stack = []
  let pending = null
  let depth = 0
  let parens = 0
  let doc = ''
  let inDoc = false

  for (const raw of source.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed.startsWith('/**')) {
      inDoc = true
      doc = ''
    }
    if (inDoc) {
      doc += ` ${trimmed}`
      if (trimmed.endsWith('*/')) inDoc = false
      continue
    }
    const line = raw.split('//')[0]
    const declared = DECL.exec(line.trim())
    if (declared) {
      pending = ['interface', 'namespace', 'class'].includes(declared[1]) ? declared[2] : null
    } else if (stack.length > 0 && depth === stack[stack.length - 1][1] + 1 && parens === 0) {
      const member = MEMBER.exec(raw)
      if (member && !KEYWORDS.has(member[1]) && doc) {
        const only = /only available in ([^.@*]+?)(?:\.|$| \*)/.exec(doc)?.[1]?.trim()
        const deprecated = /@deprecated/.test(doc)
        if (only || deprecated) notes.set(`${stack[stack.length - 1][0]}.${member[1]}`, { only, deprecated })
      }
    }
    if (trimmed !== '' && parens === 0 && !/[(,]\s*$/.test(line)) doc = ''
    parens = Math.max(0, parens + (line.match(/\(/g)?.length ?? 0) - (line.match(/\)/g)?.length ?? 0))

    for (let index = 0; index < (line.match(/{/g)?.length ?? 0); index++) {
      if (pending !== null) {
        stack.push([pending, depth])
        pending = null
      }
      depth++
    }
    depth -= line.match(/}/g)?.length ?? 0
    while (stack.length > 0 && depth <= stack[stack.length - 1][1]) stack.pop()
  }
  return notes
}

/** Whether a member is out of reach for this manifest: limited to editors it does not declare. */
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'))
const EDITOR_WORDS = { figma: 'Figma Design', dev: 'Dev Mode', figjam: 'FigJam', slides: 'Figma Slides', buzz: 'Figma Buzz' }
const OURS = (MANIFEST.editorType ?? []).map((editor) => EDITOR_WORDS[editor] ?? editor)
const elsewhere = (only) => typeof only === 'string' && !OURS.some((editor) => only.includes(editor))

/* ------------------------------------------------------------------- our source */

function ourSource() {
  const parts = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) parts.push(readFileSync(path, 'utf8'))
    }
  }
  walk(join(ROOT, 'src'))
  return parts.join('\n')
}

const TEXT = ourSource()
const seen = new Map()
const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether our source touches an identifier.
 *
 * Crude on purpose — see the note at the top — but not so crude that it flatters us. A member is
 * looked up WITH its dot, because `figma.devResources.on` is `on`, and a bare `on` matches every
 * event listener we ever wrote: the first version of this reported dev resources as three-quarters
 * covered when nothing in the plugin has ever called them.
 *
 * A namespace member is doubly gated: if `figma.<accessor>` appears nowhere, the whole namespace
 * is untouched whatever its members happen to be called.
 */
function touched(identifier) {
  if (seen.has(identifier)) return seen.get(identifier)
  const [owner, member] = identifier.includes('.') ? identifier.split('.') : [null, identifier]

  let hit
  if (owner === null) hit = new RegExp(`\\b${escape(member)}\\b`).test(TEXT)
  else if (!reachable(owner)) hit = false
  else hit = new RegExp(`\\.${escape(member)}\\b`).test(TEXT) || new RegExp(`\\b${escape(member)}\\s*[(:]`).test(TEXT)

  seen.set(identifier, hit)
  return hit
}

/** `DevResourcesAPI` is reached as `figma.devResources`; without that, none of it is reached. */
const ACCESSORS = new Map()
function reachable(owner) {
  if (!owner.endsWith('API') || owner === 'PluginAPI') return true
  if (!ACCESSORS.has(owner)) {
    // `figma.motion: MotionAPI` — the accessor is whatever PluginAPI calls the namespace.
    // `readonly devResources?: DevResourcesAPI` — the optional marker sits between the name and
    // the colon, and missing it made dev resources look three-quarters covered.
    const declared = new RegExp(`^\\s*(?:readonly\\s+)?([A-Za-z]+)\\??\\s*:\\s*${escape(owner)}\\b`, 'm')
    const found = declared.exec(readFileSync(TYPINGS, 'utf8'))
    ACCESSORS.set(owner, found ? new RegExp(`figma\\.${found[1]}\\b`).test(TEXT) : true)
  }
  return ACCESSORS.get(owner)
}

/* -------------------------------------------------------------- release history */

function versions() {
  const time = JSON.parse(execFileSync('npm', ['view', '@figma/plugin-typings', 'time', '--json'], { encoding: 'utf8' }))
  return Object.entries(time)
    .filter(([version]) => /^\d+\.\d+\.\d+$/.test(version))
    .sort((a, b) => compare(a[0], b[0]))
}

const compare = (a, b) => {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index]
  return 0
}

function typingsFor(version) {
  const cached = join(CACHE, `${version}.d.ts`)
  if (existsSync(cached)) return readFileSync(cached, 'utf8')
  mkdirSync(CACHE, { recursive: true })
  execFileSync('npm', ['pack', `@figma/plugin-typings@${version}`, '--silent'], { cwd: CACHE, stdio: 'ignore' })
  const tarball = join(CACHE, `figma-plugin-typings-${version}.tgz`)
  const source = execFileSync('tar', ['-xzOf', tarball, 'package/plugin-api.d.ts'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  writeFileSync(cached, source)
  return source
}

/**
 * A type name we never write is not a gap.
 *
 * We annotate almost nothing — `MotionAPI` appears nowhere in our source although the plugin calls
 * `figma.motion` on every animation. So a bare declaration counts as covered when any of its
 * members is touched; only a type with nothing of it used is a real miss.
 */
function covered(name, surface) {
  if (touched(name)) return true
  if (name.includes('.')) return false
  const members = [...surface].filter((entry) => entry.startsWith(`${name}.`))
  return members.length > 0 && members.some(touched)
}

/* ------------------------------------------------------------------- the ledger */

function namespaceTable(surface, notes) {
  const spaces = [...surface].filter((name) => name.endsWith('API') && !name.includes('.')).sort()
  // A namespace reached through an accessor limited to other editors (`figma.buzz`) is out of
  // reach whole, whatever its own members say.
  const accessorOf = (space) => {
    const declared = new RegExp(`^\\s*(?:readonly\\s+)?([A-Za-z]+)\\??\\s*:\\s*${escape(space)}\\b`, 'm').exec(readFileSync(TYPINGS, 'utf8'))
    return declared ? notes.get(`PluginAPI.${declared[1]}`) : undefined
  }
  const rows = []
  for (const space of spaces) {
    const members = [...surface].filter((name) => name.startsWith(`${space}.`)).map((name) => name.slice(space.length + 1))
    if (members.length === 0) continue
    const untouched = members.filter((member) => !touched(`${space}.${member}`)).sort()
    const whole = accessorOf(space)
    const away = untouched.filter((member) => elsewhere(whole?.only) || elsewhere(notes.get(`${space}.${member}`)?.only))
    const old = untouched.filter((member) => !away.includes(member) && notes.get(`${space}.${member}`)?.deprecated)
    const missing = untouched.filter((member) => !away.includes(member) && !old.includes(member))
    rows.push({ space, total: members.length, missing, away, old })
  }
  return rows
}

function releaseTable(since) {
  const all = versions()
  const window = all.filter(([version]) => compare(version, since) >= 0)
  const rows = []
  let previous = null
  for (const [version, date] of window) {
    let surface
    try {
      surface = surfaceOf(typingsFor(version))
    } catch {
      continue
    }
    if (previous) {
      const added = [...surface].filter((name) => !previous.has(name)).sort()
      const untouched = added.filter((name) => !covered(name, surface))
      // The same two exclusions as the namespace table, by the notes of the installed typings.
      const away = untouched.filter((name) => elsewhere(NOTES.get(name)?.only) || elsewhere(NOTES.get(`PluginAPI.${ACCESSOR_OF.get(name.split('.')[0]) ?? ''}`)?.only))
      const old = untouched.filter((name) => !away.includes(name) && NOTES.get(name)?.deprecated)
      const missing = untouched.filter((name) => !away.includes(name) && !old.includes(name))
      if (added.length > 0) rows.push({ version, date: date.slice(0, 10), added, missing, away, old })
    }
    previous = surface
  }
  return rows.reverse()
}

const surface = surfaceOf(readFileSync(TYPINGS, 'utf8'))
const notes = notesOf(readFileSync(TYPINGS, 'utf8'))
const NOTES = notes
/** Namespace → the PluginAPI accessor that reaches it (`BuzzAPI` → `buzz`). */
const ACCESSOR_OF = new Map(
  [...readFileSync(TYPINGS, 'utf8').matchAll(/^\s*(?:readonly\s+)?([A-Za-z]+)\??\s*:\s*([A-Za-z]+API)\b/gm)].map((match) => [match[2], match[1]])
)
const installed = JSON.parse(readFileSync(join(ROOT, 'node_modules/@figma/plugin-typings/package.json'), 'utf8')).version

const lines = []
const emit = (line = '') => lines.push(line)

emit(`# Покрытие Figma Plugin API\n`)
emit(`Типизации ${installed}, идентификаторов в поверхности: ${surface.size}.`)
emit(`Сигнал «у нас» — слово встречается в src/ (кроме тестов): грубо, но без вранья в пользу покрытия.\n`)

emit(`## Неймспейсы\n`)
emit(`Манифест объявляет ${OURS.join(', ')}. «Другой редактор» — член, который типизации сами ограничивают`)
emit(`редакторами вне манифеста; «устарело» — помечен \`@deprecated\`. Ни то, ни другое пробелом не считается.\n`)
emit(`| API | членов | не тронуто | что именно | другой редактор | устарело |`)
emit(`| --- | ---: | ---: | --- | ---: | ---: |`)
const list = (names) => (names.length > 0 ? names.slice(0, 8).join(', ') + (names.length > 8 ? ' …' : '') : '—')
for (const row of namespaceTable(surface, notes)) {
  emit(`| ${row.space} | ${row.total} | ${row.missing.length} | ${list(row.missing)} | ${row.away.length} | ${row.old.length} |`)
}

if (process.argv.includes('--releases')) {
  const since = process.argv[process.argv.indexOf('--releases') + 1] ?? '1.107.0'
  emit(`\n## Релизы, от свежего к старому (с ${since})\n`)
  for (const row of releaseTable(since)) {
    const aside = [row.away.length > 0 ? `другой редактор ${row.away.length}` : '', row.old.length > 0 ? `устарело ${row.old.length}` : ''].filter(Boolean)
    emit(`### ${row.version} — ${row.date}  (+${row.added.length}, не тронуто ${row.missing.length}${aside.length > 0 ? `; ${aside.join(', ')}` : ''})\n`)
    if (row.missing.length > 0) emit(`${row.missing.join(', ')}\n`)
    else emit(`всё тронуто\n`)
  }
}

const report = lines.join('\n') + '\n'
if (process.argv.includes('--write')) {
  const path = join(ROOT, 'TASK-api-coverage.md')
  const source = readFileSync(path, 'utf8')
  const start = '<!-- api-coverage:start -->'
  const end = '<!-- api-coverage:end -->'
  if (!source.includes(start) || !source.includes(end)) {
    throw new Error(`${path} is missing ${start} / ${end} markers`)
  }
  const embedded = report.replace(/^# Покрытие Figma Plugin API\n\n/, '').trimEnd()
  const updated = source.replace(
    new RegExp(`${start}[\\s\\S]*?${end}`),
    `${start}\n\n${embedded}\n\n${end}`
  )
  writeFileSync(path, updated)
  console.log(`updated ${path}`)
} else {
  process.stdout.write(report)
}
