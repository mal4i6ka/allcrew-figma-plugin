/**
 * The styled runs of a text node, read back in the shape `runs` takes on the way in.
 *
 * `getStyledTextSegments` takes a list of fields and answers only those. The plugin was asking for
 * two of its twenty-six — `boundVariables` and `fills` — so a paragraph with one word in another
 * size, or a link on a single phrase, read back as uniform: runs were something the channel could
 * write and never return.
 *
 * That is the one promise the vocabulary rests on, so the list here is exactly the set the write
 * side understands, and a run reports only what DIFFERS from the layer it sits in — the layer's
 * own values travel in the same reply, and repeating them in every run would triple a read of a
 * three-colour heading to say nothing new.
 */

import { decorationWords } from './decoration.ts'
import { readPaintsForWrite } from './paint-reader.ts'
import type { FontSpec } from './props.ts'
import { styleRef } from './styles.ts'

/** The fields a run can carry in the write vocabulary, under the names Figma gives them. */
export const RUN_FIELDS = [
  'fontName',
  'fontSize',
  'fills',
  'textDecoration',
  'textCase',
  'textWrapStyle',
  'letterSpacing',
  'lineHeight',
  'hyperlink',
  'textStyleId',
  'fillStyleId',
  'listOptions',
  'indentation',
  'listSpacing',
  'paragraphSpacing',
  'paragraphIndent',
  'textDecorationStyle',
  'textDecorationOffset',
  'textDecorationThickness',
  'textDecorationColor',
  'textDecorationSkipInk',
] as const

type TextLike = TextNode | TextPathNode

export interface StyledRun {
  from: number
  to: number
  [field: string]: unknown
}

/** The fields above that a TEXT_PATH does not answer for — it is one line, with no paragraphs. */
const PARAGRAPH_FIELDS = new Set(['listOptions', 'indentation', 'paragraphSpacing', 'paragraphIndent', 'listSpacing'])

/**
 * A list and its depth, when the whole text shares them.
 *
 * Figma keeps neither on the layer — there is no `node.listOptions` — so the layer-level read is
 * worked out from the runs: a bulleted paragraph block is ONE segment, and `runs` is only printed
 * when there are two, so without this a list read back as plain text.
 */
export interface Paragraphs {
  list?: 'ORDERED' | 'UNORDERED'
  indent?: number
}

export async function styledRuns(node: TextLike): Promise<StyledRun[]> {
  return (await textRuns(node)).runs
}

/** The runs, and what the whole text shares that Figma only stores per range. */
export async function textRuns(node: TextLike): Promise<{ runs: StyledRun[]; paragraphs: Paragraphs }> {
  const fields = RUN_FIELDS.filter((field) => node.type === 'TEXT' || !PARAGRAPH_FIELDS.has(field))
  let segments: ReadonlyArray<Record<string, unknown>>
  try {
    segments = node.getStyledTextSegments(
      fields as unknown as ['fontName']
    ) as unknown as ReadonlyArray<Record<string, unknown>>
  } catch {
    // A font that will not load makes the call throw. The layer-level read still stands, and an
    // empty list says "nothing to add" rather than inventing a run.
    return { runs: [], paragraphs: {} }
  }

  // What every segment agrees on is the layer's; a run then reports only where it departs.
  const shared = (field: string): unknown => {
    const first = JSON.stringify(segments[0]?.[field])
    return segments.every((segment) => JSON.stringify(segment[field]) === first) ? segments[0]?.[field] : undefined
  }
  const listType = (shared('listOptions') as { type?: string } | undefined)?.type ?? 'NONE'
  const depth = shared('indentation')
  const paragraphs: Paragraphs = {
    ...(listType === 'ORDERED' || listType === 'UNORDERED' ? { list: listType } : {}),
    ...(typeof depth === 'number' && depth > 0 ? { indent: depth } : {}),
  }
  // The layer's view of the two, as the baseline a run is compared against: what they all share,
  // or — when they differ — no list at the outer level, which is what a write starts from.
  const baseline: Record<string, unknown> = {
    listOptions: { type: listType },
    indentation: typeof depth === 'number' ? depth : 0,
  }

  const bag = node as unknown as Record<string, unknown>
  const runs: StyledRun[] = []
  for (const segment of segments) {
    const run: StyledRun = { from: segment.start as number, to: segment.end as number }
    const differs = (field: string, value: unknown) =>
      JSON.stringify(field in baseline ? baseline[field] : bag[field]) !== JSON.stringify(value)

    if (differs('fontName', segment.fontName)) run.fontName = writableFont(segment.fontName)
    if (differs('fontSize', segment.fontSize)) run.fontSize = segment.fontSize
    if (differs('fills', segment.fills)) {
      run.fill = await readPaintsForWrite(
        segment.fills,
        async (id) => (await figma.variables.getVariableByIdAsync(id).catch(() => null))?.name ?? null
      )
    }
    if (differs('textDecoration', segment.textDecoration)) run.textDecoration = segment.textDecoration
    if (differs('textCase', segment.textCase)) run.textCase = segment.textCase
    if (differs('textWrapStyle', segment.textWrapStyle)) run.textWrap = segment.textWrapStyle
    if (differs('letterSpacing', segment.letterSpacing)) run.letterSpacing = writableMeasure(segment.letterSpacing)
    if (differs('lineHeight', segment.lineHeight)) run.lineHeight = writableMeasure(segment.lineHeight)
    if (differs('hyperlink', segment.hyperlink)) {
      const link = segment.hyperlink as { value?: string } | null
      run.link = link?.value ?? null
    }
    // A style on part of the text, by the word a write looks it up by — a local style's name, a
    // library style's key. An empty id is "no style" — the run left the node's style — and has no
    // word to be sent back with.
    for (const [field, word] of [['textStyleId', 'textStyle'], ['fillStyleId', 'fillStyle']] as const) {
      const id = segment[field]
      if (typeof id === 'string' && id !== '' && differs(field, id)) run[word] = (await styleRef(id)) ?? id
    }
    // The look of the line, when this run draws it differently from the node it sits in.
    const decoration = decorationWords(segment)
    if (decoration && JSON.stringify(decoration) !== JSON.stringify(decorationWords(bag))) run.decoration = decoration
    const list = (segment.listOptions as { type?: string } | undefined)?.type
    if (list && differs('listOptions', segment.listOptions)) run.list = list
    if (typeof segment.indentation === 'number' && differs('indentation', segment.indentation)) run.indent = segment.indentation
    for (const field of ['listSpacing', 'paragraphSpacing', 'paragraphIndent'] as const) {
      if (typeof segment[field] === 'number' && differs(field, segment[field])) run[field] = segment[field]
    }
    runs.push(run)
  }
  return { runs, paragraphs }
}

/**
 * A font as the write takes it back: the pair Figma loads, plus — for a variable font — the axis
 * values it is rendered at. Dropping `variationSettings` would read a 550-weight heading back as
 * its named instance and write it back heavier or lighter than it was.
 *
 * A read always names both halves, so anything missing one is not a font this can report.
 */
export function writableFont(value: unknown): (FontSpec & { style: string }) | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('family' in value) ||
    typeof value.family !== 'string' ||
    !('style' in value) ||
    typeof value.style !== 'string'
  ) {
    return undefined
  }
  const font: FontSpec & { style: string } = { family: value.family, style: value.style }
  if ('variationSettings' in value && typeof value.variationSettings === 'object' && value.variationSettings !== null) {
    const axes: Record<string, number> = {}
    for (const [tag, amount] of Object.entries(value.variationSettings)) {
      if (typeof amount === 'number') axes[tag] = amount
    }
    if (Object.keys(axes).length > 0) font.variationSettings = axes
  }
  return font
}

/** Leading and tracking as the write takes them: pixels as a number, a share as `"150%"`. */
export function writableMeasure(value: unknown): number | string {
  if (typeof value !== 'object' || value === null || !('unit' in value)) return 0
  const { unit, value: amount } = value as { unit: string; value?: number }
  if (unit === 'AUTO') return 'AUTO'
  const size = Math.round((amount ?? 0) * 100) / 100
  return unit === 'PERCENT' ? `${size}%` : size
}
