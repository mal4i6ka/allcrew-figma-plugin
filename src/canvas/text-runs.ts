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

export async function styledRuns(node: TextLike): Promise<StyledRun[]> {
  let segments: ReadonlyArray<Record<string, unknown>>
  try {
    segments = node.getStyledTextSegments(
      RUN_FIELDS as unknown as ['fontName']
    ) as unknown as ReadonlyArray<Record<string, unknown>>
  } catch {
    // A font that will not load makes the call throw. The layer-level read still stands, and an
    // empty list says "nothing to add" rather than inventing a run.
    return []
  }

  const bag = node as unknown as Record<string, unknown>
  const runs: StyledRun[] = []
  for (const segment of segments) {
    const run: StyledRun = { from: segment.start as number, to: segment.end as number }
    const differs = (field: string, value: unknown) => JSON.stringify(bag[field]) !== JSON.stringify(value)

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
    // A style on part of the text, by the name a write looks it up by. An empty id is "no
    // style" — the run left the node's style — and has no word to be sent back with.
    for (const [field, word] of [['textStyleId', 'textStyle'], ['fillStyleId', 'fillStyle']] as const) {
      const id = segment[field]
      if (typeof id === 'string' && id !== '' && differs(field, id)) {
        run[word] = (await figma.getStyleByIdAsync(id).catch(() => null))?.name ?? id
      }
    }
    // The look of the line, when this run draws it differently from the node it sits in.
    const decoration = decorationWords(segment)
    if (decoration && JSON.stringify(decoration) !== JSON.stringify(decorationWords(bag))) run.decoration = decoration
    const list = (segment.listOptions as { type?: string } | undefined)?.type
    if (list && list !== 'NONE') run.list = list
    if (typeof segment.indentation === 'number' && segment.indentation > 0) run.indent = segment.indentation
    for (const field of ['listSpacing', 'paragraphSpacing', 'paragraphIndent'] as const) {
      if (typeof segment[field] === 'number' && differs(field, segment[field])) run[field] = segment[field]
    }
    runs.push(run)
  }
  return runs
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
