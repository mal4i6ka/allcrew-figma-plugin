/**
 * What a FILE says about itself — written into the document, read by everyone who opens it.
 *
 * Settings that decide WHAT an export package is must not live in one person's `clientStorage`,
 * or the same file exports one package on one laptop and another on the next. Two halves of
 * that contract were still per-person:
 *
 *  - the documentation half of the export (COMPONENTS.md on or off, previews, their budget) —
 *    a colleague with component docs switched off shipped a DESIGN.md that pointed at nothing;
 *  - the instructions themselves. A design system's brand rules, a creative skill, a DESIGN.md
 *    written by its owners — they lived in a repository or a zip beside the file, so a person
 *    (or an agent) who opened the file had no way to know they existed.
 *
 * Both now live in the file's shared plugin data on the document root, under the plugin's own
 * namespace (`PLUGIN_DATA_NAMESPACE`, the one `utils/plugin-data.ts` uses for every node):
 *
 *  - `docsExport`   the pinned documentation settings, JSON;
 *  - `guidelines`   the manifest of the file's guideline files, JSON;
 *  - `guidelines.<gen>.<file>.<chunk>`  their text, cut to fit Figma's 100 kB per entry.
 *
 * Shared, not private, plugin data: file mail (`mail/store.ts`) keeps per-plugin state on the
 * root with `setPluginData`, but guidelines are meant to be read by anything that opens the
 * file, the same way the i18n keys on nodes are.
 *
 * A rewrite stores the new files under a fresh generation and switches the manifest last, so a
 * reader never sees a manifest that points at half-written text; the old generation is removed
 * after the switch. Everything here is pure over a small `host` interface so it is testable
 * without Figma — `figma.root` is the host in the plugin.
 */

import { PLUGIN_DATA_NAMESPACE } from '../utils/plugin-data.ts'

export const FILE_DOCS_NAMESPACE = PLUGIN_DATA_NAMESPACE
export const DOCS_CONFIG_KEY = 'docsExport'
export const GUIDELINES_KEY = 'guidelines'

/** Figma refuses an entry (namespace + key + value) over 100 kB; leave room for the key. */
export const CHUNK_BYTES = 90_000
export const MAX_FILE_BYTES = 512 * 1024
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024
export const MAX_FILES = 200

/** Text formats only — this is documentation that travels with a design file, not an asset store. */
export const GUIDELINE_EXTENSIONS = ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'css', 'js', 'mjs', 'html', 'svg'] as const

export interface SharedDataHost {
  getSharedPluginData(namespace: string, key: string): string
  setSharedPluginData(namespace: string, key: string, value: string): void
  getSharedPluginDataKeys(namespace: string): string[]
}

/* ------------------------------------------------------------ docs settings */

/** The documentation settings a file may pin — the `docs` half of the export options. */
export interface FileDocsConfig {
  componentDocs?: boolean
  componentPreviews?: boolean
  previewBudgetMb?: number
}

export const DOCS_CONFIG_FIELDS = ['componentDocs', 'componentPreviews', 'previewBudgetMb'] as const

/** Validates a docs config from any source. Unknown keys and wrong types are reported, never kept. */
export function normalizeFileDocsConfig(raw: unknown): { config: FileDocsConfig; problems: string[] } {
  const config: FileDocsConfig = {}
  const problems: string[] = []
  if (raw === null || raw === undefined) return { config, problems }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { config, problems: ['the docs config must be an object'] }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'componentDocs' || key === 'componentPreviews') {
      if (typeof value === 'boolean') config[key] = value
      else problems.push(`"${key}" must be true or false`)
    } else if (key === 'previewBudgetMb') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 512) config.previewBudgetMb = Math.round(value)
      else problems.push('"previewBudgetMb" must be a number of megabytes from 1 to 512')
    } else {
      problems.push(`unknown setting "${key}" — the file can pin: ${DOCS_CONFIG_FIELDS.join(', ')}`)
    }
  }
  return { config, problems }
}

export function readFileDocsConfig(host: Pick<SharedDataHost, 'getSharedPluginData'>): FileDocsConfig | null {
  let raw = ''
  try {
    raw = host.getSharedPluginData(FILE_DOCS_NAMESPACE, DOCS_CONFIG_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const { config } = normalizeFileDocsConfig(JSON.parse(raw))
    return Object.keys(config).length > 0 ? config : null
  } catch {
    return null
  }
}

export function writeFileDocsConfig(config: FileDocsConfig | null, host: Pick<SharedDataHost, 'setSharedPluginData'>): void {
  host.setSharedPluginData(FILE_DOCS_NAMESPACE, DOCS_CONFIG_KEY, config && Object.keys(config).length > 0 ? JSON.stringify(config) : '')
}

/** The person's export options with the FILE's docs settings over them. */
export function applyFileDocsConfig<T extends { docs: { componentDocs: boolean; componentPreviews: boolean; previewBudgetMb: number } }>(
  options: T,
  config: FileDocsConfig | null
): T {
  if (!config || Object.keys(config).length === 0) return options
  return { ...options, docs: { ...options.docs, ...config } }
}

/* --------------------------------------------------------------- guidelines */

export interface GuidelineFileEntry {
  path: string
  /** UTF-8 bytes of the text. */
  bytes: number
  chunks: number
}

export interface GuidelinesManifest {
  version: 1
  /** What the set is, e.g. "Acme brand kit" — shown to agents and in the export notes. */
  name: string
  /** Which file to read first, e.g. "SKILL.md". */
  entry?: string
  /** One line for a reader deciding whether these apply: who they are for, what they cover. */
  description?: string
  updatedAt: string
  /** Generation id the chunk keys carry. */
  gen: string
  files: GuidelineFileEntry[]
}

export interface GuidelineFile {
  path: string
  text: string
}

/** UTF-8 byte length without TextEncoder (the plugin sandbox does not promise one). */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return bytes
}

/** Cuts text into pieces of at most `maxBytes` UTF-8 bytes, never inside a code point. */
export function chunkUtf8(text: string, maxBytes: number = CHUNK_BYTES): string[] {
  if (text === '') return ['']
  const out: string[] = []
  let current = ''
  let size = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (size + n > maxBytes && current !== '') {
      out.push(current)
      current = ''
      size = 0
    }
    current += ch
    size += n
  }
  out.push(current)
  return out
}

/** A relative POSIX path of plain segments with a text extension — or the reason it is not. */
export function guidelinePathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || path === '') return 'a file path must be a non-empty string'
  if (path.length > 160) return `"${path.slice(0, 40)}…" is longer than 160 characters`
  if (path.startsWith('/') || path.includes('\\')) return `"${path}" must be a relative path with forward slashes`
  const segments = path.split('/')
  if (segments.length > 5) return `"${path}" is nested deeper than 5 folders`
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return `"${path}" has an empty, "." or ".." segment`
    if (!/^[A-Za-z0-9._@-]+$/.test(segment)) return `"${path}": use letters, digits, ".", "_", "-" and "@" only`
  }
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
  if (!(GUIDELINE_EXTENSIONS as readonly string[]).includes(ext)) {
    return `"${path}" is not a text format this file stores (${GUIDELINE_EXTENSIONS.join(', ')})`
  }
  return null
}

const chunkKey = (gen: string, file: number, chunk: number) => `${GUIDELINES_KEY}.${gen}.${file}.${chunk}`

export function readGuidelinesManifest(host: Pick<SharedDataHost, 'getSharedPluginData'>): GuidelinesManifest | null {
  let raw = ''
  try {
    raw = host.getSharedPluginData(FILE_DOCS_NAMESPACE, GUIDELINES_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as GuidelinesManifest
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.files) || typeof parsed.gen !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export interface ReadGuidelinesResult {
  manifest: GuidelinesManifest | null
  files: GuidelineFile[]
  /** Files whose stored text does not add up to what the manifest promised. */
  damaged: string[]
}

/** The file's guidelines — all of them, or only the paths asked for. */
export function readGuidelines(host: Pick<SharedDataHost, 'getSharedPluginData'>, only?: readonly string[]): ReadGuidelinesResult {
  const manifest = readGuidelinesManifest(host)
  if (!manifest) return { manifest: null, files: [], damaged: [] }
  const files: GuidelineFile[] = []
  const damaged: string[] = []
  manifest.files.forEach((entry, index) => {
    if (only && !only.includes(entry.path)) return
    let text = ''
    for (let chunk = 0; chunk < entry.chunks; chunk++) text += host.getSharedPluginData(FILE_DOCS_NAMESPACE, chunkKey(manifest.gen, index, chunk))
    if (utf8Bytes(text) !== entry.bytes) damaged.push(entry.path)
    files.push({ path: entry.path, text })
  })
  return { manifest, files, damaged }
}

export interface GuidelinesChange {
  /** Files to add or replace; a null text removes that path. */
  files?: Record<string, string | null>
  /** Start from nothing instead of the stored set. */
  replace?: boolean
  /** Remove every guideline file and the manifest. */
  clear?: boolean
  name?: string
  entry?: string | null
  description?: string | null
}

export interface GuidelinesPlan {
  before: GuidelinesManifest | null
  after: GuidelinesManifest | null
  added: string[]
  replaced: string[]
  removed: string[]
  unchanged: string[]
  /** Every shared-data write the change takes, in order: chunks first, manifest, then cleanup. */
  writes: Array<{ key: string; value: string }>
  totalBytes: number
}

/**
 * Plans a change to the file's guidelines without touching it. Throws, whole, on anything
 * invalid — a partial write of a documentation set is worse than none.
 */
export function planGuidelines(
  host: SharedDataHost,
  change: GuidelinesChange,
  now: () => string = () => new Date().toISOString(),
  newGen: () => string = () => Date.now().toString(36)
): GuidelinesPlan {
  const current = readGuidelines(host)
  const before = current.manifest
  const stale = host.getSharedPluginDataKeys(FILE_DOCS_NAMESPACE).filter((key) => key.startsWith(`${GUIDELINES_KEY}.`))

  if (change.clear) {
    return {
      before,
      after: null,
      added: [],
      replaced: [],
      removed: current.files.map((f) => f.path),
      unchanged: [],
      writes: [{ key: GUIDELINES_KEY, value: '' }, ...stale.map((key) => ({ key, value: '' }))],
      totalBytes: 0,
    }
  }

  const problems: string[] = []
  const incoming = change.files ?? {}
  if (typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('"files" must be an object of { path: text | null }')
  for (const [path, text] of Object.entries(incoming)) {
    const problem = guidelinePathProblem(path)
    if (problem) problems.push(problem)
    if (text !== null && typeof text !== 'string') problems.push(`"${path}": the text must be a string (or null to remove it)`)
  }

  const next = new Map<string, string>(change.replace ? [] : current.files.map((f) => [f.path, f.text]))
  const added: string[] = []
  const replaced: string[] = []
  const removed: string[] = []
  for (const [path, text] of Object.entries(incoming)) {
    if (text === null) {
      if (next.delete(path)) removed.push(path)
      continue
    }
    const existed = current.files.find((f) => f.path === path)
    if (!existed) added.push(path)
    else if (existed.text !== text) replaced.push(path)
    next.set(path, text)
  }
  if (change.replace) for (const f of current.files) if (!next.has(f.path)) removed.push(f.path)
  const unchanged = [...next.keys()].filter((p) => !added.includes(p) && !replaced.includes(p))

  if (next.size > MAX_FILES) problems.push(`${next.size} files — a file stores at most ${MAX_FILES}`)
  let totalBytes = 0
  for (const [path, text] of next) {
    const bytes = utf8Bytes(text)
    totalBytes += bytes
    if (bytes > MAX_FILE_BYTES) problems.push(`"${path}" is ${Math.round(bytes / 1024)} KB — at most ${MAX_FILE_BYTES / 1024} KB per file`)
  }
  if (totalBytes > MAX_TOTAL_BYTES) problems.push(`${Math.round(totalBytes / 1024)} KB in all — at most ${MAX_TOTAL_BYTES / 1024 / 1024} MB per Figma file`)

  const name = (change.name ?? before?.name ?? '').trim()
  if (next.size > 0 && name === '') problems.push('name the set ("name"), e.g. "Acme brand kit" — it is what a reader sees first')
  const entry = change.entry === null ? undefined : change.entry ?? before?.entry
  if (entry !== undefined && !next.has(entry)) problems.push(`"entry" names ${entry}, which is not among the files`)
  if (problems.length > 0) throw new Error(`nothing was written: ${problems.join('; ')}`)

  if (next.size === 0) {
    return {
      before,
      after: null,
      added,
      replaced,
      removed,
      unchanged,
      writes: [{ key: GUIDELINES_KEY, value: '' }, ...stale.map((key) => ({ key, value: '' }))],
      totalBytes: 0,
    }
  }

  let gen = newGen()
  if (before && before.gen === gen) gen = `${gen}x`
  const description = change.description === null ? undefined : change.description ?? before?.description
  const files: GuidelineFileEntry[] = []
  const chunkWrites: Array<{ key: string; value: string }> = []
  const paths = [...next.keys()].sort((a, b) => a.localeCompare(b))
  paths.forEach((path, index) => {
    const text = next.get(path) as string
    const chunks = chunkUtf8(text)
    chunks.forEach((value, chunk) => chunkWrites.push({ key: chunkKey(gen, index, chunk), value }))
    files.push({ path, bytes: utf8Bytes(text), chunks: chunks.length })
  })
  const after: GuidelinesManifest = {
    version: 1,
    name,
    ...(entry ? { entry } : {}),
    ...(description ? { description } : {}),
    updatedAt: now(),
    gen,
    files,
  }
  const fresh = new Set(chunkWrites.map((w) => w.key))
  return {
    before,
    after,
    added,
    replaced,
    removed,
    unchanged,
    writes: [
      ...chunkWrites,
      { key: GUIDELINES_KEY, value: JSON.stringify(after) },
      ...stale.filter((key) => !fresh.has(key)).map((key) => ({ key, value: '' })),
    ],
    totalBytes,
  }
}

/** Applies a plan's writes in their order. Throws where the file is read-only (Dev Mode, a viewer). */
export function applyGuidelines(host: Pick<SharedDataHost, 'setSharedPluginData'>, plan: GuidelinesPlan): void {
  for (const { key, value } of plan.writes) host.setSharedPluginData(FILE_DOCS_NAMESPACE, key, value)
}

/** What `document.info` and the export say about a file's guidelines — the manifest, no text. */
export function guidelinesSummary(manifest: GuidelinesManifest | null): null | {
  name: string
  entry?: string
  description?: string
  updatedAt: string
  files: Array<{ path: string; bytes: number }>
  read: string
} {
  if (!manifest) return null
  return {
    name: manifest.name,
    ...(manifest.entry ? { entry: manifest.entry } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    updatedAt: manifest.updatedAt,
    files: manifest.files.map((f) => ({ path: f.path, bytes: f.bytes })),
    read: 'This file carries its own guidelines — read them with docs.read before designing or building from it.',
  }
}

/** What the panel shows as decided by the file: pinned docs settings and the guidelines it carries. */
export function filePins(host: Pick<SharedDataHost, 'getSharedPluginData'>): {
  docs: FileDocsConfig | null
  guidelines: { name: string; files: number; entry?: string } | null
} {
  const manifest = readGuidelinesManifest(host)
  return {
    docs: readFileDocsConfig(host),
    guidelines: manifest ? { name: manifest.name, files: manifest.files.length, ...(manifest.entry ? { entry: manifest.entry } : {}) } : null,
  }
}
