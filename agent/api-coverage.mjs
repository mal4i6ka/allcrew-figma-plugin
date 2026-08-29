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
 *   node agent/api-coverage.mjs            # the ledger, from the installed typings
 *   node agent/api-coverage.mjs --releases # download past versions and add the release history
 *
 * `--releases` fetches tarballs from npm into a cache directory; without network it prints the
 * namespace half alone rather than failing.
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

  for (const raw of source.split('\n')) {
    const line = raw.split('//')[0]
    const declared = DECL.exec(line.trim())
    if (declared) {
      out.add(declared[2])
      pending = ['interface', 'namespace', 'class'].includes(declared[1]) ? declared[2] : null
    } else if (stack.length > 0 && depth === stack[stack.length - 1][1] + 1) {
      const member = MEMBER.exec(raw)
      if (member && !KEYWORDS.has(member[1])) out.add(`${stack[stack.length - 1][0]}.${member[1]}`)
    }

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

function namespaceTable(surface) {
  const spaces = [...surface].filter((name) => name.endsWith('API') && !name.includes('.')).sort()
  const rows = []
  for (const space of spaces) {
    const members = [...surface].filter((name) => name.startsWith(`${space}.`)).map((name) => name.slice(space.length + 1))
    if (members.length === 0) continue
    const missing = members.filter((member) => !touched(`${space}.${member}`)).sort()
    rows.push({ space, total: members.length, missing })
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
      if (added.length > 0) rows.push({ version, date: date.slice(0, 10), added, missing: added.filter((name) => !covered(name, surface)) })
    }
    previous = surface
  }
  return rows.reverse()
}

const surface = surfaceOf(readFileSync(TYPINGS, 'utf8'))
const installed = JSON.parse(readFileSync(join(ROOT, 'node_modules/@figma/plugin-typings/package.json'), 'utf8')).version

console.log(`# Покрытие Figma Plugin API\n`)
console.log(`Типизации ${installed}, идентификаторов в поверхности: ${surface.size}.`)
console.log(`Сигнал «у нас» — слово встречается в src/ (кроме тестов): грубо, но без вранья в пользу покрытия.\n`)

console.log(`## Неймспейсы\n`)
console.log(`| API | членов | не тронуто | что именно |`)
console.log(`| --- | ---: | ---: | --- |`)
for (const row of namespaceTable(surface)) {
  const names = row.missing.length > 0 ? row.missing.slice(0, 8).join(', ') + (row.missing.length > 8 ? ' …' : '') : '—'
  console.log(`| ${row.space} | ${row.total} | ${row.missing.length} | ${names} |`)
}

if (process.argv.includes('--releases')) {
  const since = process.argv[process.argv.indexOf('--releases') + 1] ?? '1.107.0'
  console.log(`\n## Релизы, от свежего к старому (с ${since})\n`)
  for (const row of releaseTable(since)) {
    console.log(`### ${row.version} — ${row.date}  (+${row.added.length}, не тронуто ${row.missing.length})\n`)
    if (row.missing.length > 0) console.log(`${row.missing.join(', ')}\n`)
    else console.log(`всё тронуто\n`)
  }
}
