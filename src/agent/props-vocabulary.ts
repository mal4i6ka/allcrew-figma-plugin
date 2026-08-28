/**
 * The property vocabulary, extracted rather than described.
 *
 * The command table taught the channel every command this plugin has, and did it by reading the
 * source at build time so that adding a feature adds it to the channel. The vocabulary those
 * commands take never got the same treatment: it was one hand-written paragraph on the `props`
 * marker, and by the time gradients, grids, brushes, styles, bindings, animation, paths and
 * shaders had been added it described about half of what existed. An agent reading the channel
 * would have believed that half was all there was — which is the same silence the markers were
 * invented to end, moved one level down.
 *
 * So `NodeProps` is read the way `handleUiMessage` is read: each field with the type it declares
 * and the sentence written above it. The vocabulary cannot fall behind the code, because it IS
 * the code.
 */

export interface VocabularyEntry {
  name: string
  /** The TypeScript annotation, verbatim and collapsed to one line. */
  type: string
  /** The doc comment above the field, if it has one. */
  note?: string
}

const INTERFACE = 'export interface NodeProps {'

/**
 * Reads `NodeProps` out of `src/canvas/props.ts`.
 *
 * Deliberately a small parser rather than a TypeScript one: the shape is one flat interface of
 * `name?: type` lines with `/** … *​/` comments above them, and a real parser would be a
 * dependency and a build step to keep a hundred lines honest.
 */
export function extractProps(source: string): VocabularyEntry[] {
  const start = source.indexOf(INTERFACE)
  if (start === -1) return []
  const body = source.slice(start + INTERFACE.length)
  const end = body.indexOf('\n}')
  if (end === -1) return []

  const entries: VocabularyEntry[] = []
  let note: string[] = []
  // Deliberately NOT carried to the next field. A comment above a run of related fields reads as
  // covering all of them, and for the five style slots it does — but `name`'s sentence is not
  // `visible`'s, and a wrong sentence on a property is worse than none. Each field says its own
  // thing, and the build prints the ones that say nothing.

  for (const raw of body.slice(0, end).split('\n')) {
    const line = raw.trim()
    if (line === '') continue

    // A comment, in any of the three shapes the file uses.
    if (line.startsWith('/**') || line.startsWith('*') || line.startsWith('*/') || line.startsWith('//')) {
      const text = line
        .replace(/^\/\*\*/, '')
        .replace(/^\*\//, '')
        .replace(/^\*/, '')
        .replace(/^\/\//, '')
        .replace(/\*\/$/, '')
        .trim()
      if (text !== '') note.push(text)
      continue
    }

    const field = /^([A-Za-z_$][A-Za-z0-9_$]*)\??:\s*(.+?)$/.exec(line)
    if (!field) continue

    entries.push({
      name: field[1],
      // Trailing comma or not, and multi-line unions collapsed by the file's own formatting.
      type: field[2].replace(/,$/, '').trim(),
      ...(note.length > 0 ? { note: note.join(' ') } : {}),
    })
    note = []
  }

  return entries
}

const INJECTED = '__ALTERY_PROPS__'

/** Filled in at build time by `build.mjs`; empty in a test run, which is what the tests use. */
export const PROPS_VOCABULARY: VocabularyEntry[] = (() => {
  if (!INJECTED.startsWith('[')) return []
  try {
    return JSON.parse(INJECTED) as VocabularyEntry[]
  } catch {
    return []
  }
})()
