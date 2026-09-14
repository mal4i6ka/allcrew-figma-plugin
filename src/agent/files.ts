/**
 * Agent listener — handing a file back instead of a payload.
 *
 * A plugin cannot write to disk and an agent cannot read the sandbox, so anything bigger than
 * a summary — a PNG, a page of generated CSS — has to cross the channel as bytes and land
 * somewhere the agent can open. The sandbox wraps it in an envelope; the bridge, which does
 * have a filesystem, writes it out and replaces the envelope with the path it wrote.
 *
 * That split is the point. Keeping base64 out of the agent's context is why `design.context`
 * can return a whole template without drowning the conversation, and it is the same rule the
 * ops registry states for bulk output: return paths, not payloads.
 */

/** The marker the bridge looks for. Deliberately ugly — it must never collide with a real key. */
export const FILE_ENVELOPE = '__alteryFile'

export interface FileEnvelope {
  [FILE_ENVELOPE]: {
    /** Basename only. The bridge decides the directory; a name with a separator is rejected. */
    name: string
    mime: string
    /** Base64 for binary, plain text for everything else — `encoding` says which. */
    encoding: 'base64' | 'utf8'
    data: string
  }
}

/** Rejects anything that could climb out of the directory the bridge picks.
 *
 * `@` is in the set because platform asset names use it — `icon@2x.png` is what iOS and every
 * web build expect, and renaming it to `icon-2x.png` on the way out would make the agent
 * rename it back. It cannot form a path or a traversal; separators and `..` still cannot. */
export function isSafeFileName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && /^[A-Za-z0-9._@-]+$/.test(name) && !name.startsWith('.')
}

export function isFileEnvelope(value: unknown): value is FileEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const inner = (value as Record<string, unknown>)[FILE_ENVELOPE]
  if (typeof inner !== 'object' || inner === null) return false
  const spec = inner as Record<string, unknown>
  return typeof spec.name === 'string' && typeof spec.data === 'string'
}

export function textFile(name: string, mime: string, text: string): FileEnvelope {
  if (!isSafeFileName(name)) throw new Error(`unsafe file name "${name}"`)
  return { [FILE_ENVELOPE]: { name, mime, encoding: 'utf8', data: text } }
}

export function binaryFile(name: string, mime: string, bytes: Uint8Array): FileEnvelope {
  if (!isSafeFileName(name)) throw new Error(`unsafe file name "${name}"`)
  return { [FILE_ENVELOPE]: { name, mime, encoding: 'base64', data: figma.base64Encode(bytes) } }
}

/** A file name derived from a layer name: lowercased, punctuation collapsed, never empty. */
export function slugify(name: string, fallback = 'node'): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || fallback
}
