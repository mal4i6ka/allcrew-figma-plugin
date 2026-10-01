import fs from 'node:fs'
import path from 'node:path'

/**
 * Static relative ESM imports. Anchored to line starts so a path shown in a comment or string is
 * never mistaken for a dependency. The `}` arm covers a multiline named import whose final line is
 * `} from './module.mjs'`.
 */
const LOCAL_IMPORT = /^(?:(?:import|export)\s+[^\n]*\sfrom\s+|}\s+from\s+|import\s+)['"](\.\.?\/[^'"]+\.mjs)['"]/gm

export function localImports(source) {
  const out = []
  LOCAL_IMPORT.lastIndex = 0
  for (const match of source.matchAll(LOCAL_IMPORT)) out.push(match[1])
  return out
}

/** Entry first, then each local import at its first encounter, transitively. */
export function sourceSetFiles(entry) {
  const ordered = []
  const seen = new Set()
  const visit = (file) => {
    const absolute = path.resolve(file)
    if (seen.has(absolute)) return
    seen.add(absolute)
    const source = fs.readFileSync(absolute, 'utf8')
    ordered.push({ file: absolute, source })
    for (const specifier of localImports(source)) visit(path.resolve(path.dirname(absolute), specifier))
  }
  visit(entry)
  return ordered
}

export function fingerprint(source) {
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * The same logical version whether the bridge is run from this checkout or bundled into the
 * plugin download: path relative to the entry plus exact source, once per module.
 */
export function sourceSetFingerprint(entry) {
  const root = path.dirname(path.resolve(entry))
  const material = sourceSetFiles(entry)
    .map(({ file, source }) => `${path.relative(root, file).replaceAll(path.sep, '/')}\0${source}`)
    .join('\0')
  return fingerprint(material)
}
