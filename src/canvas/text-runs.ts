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

import { describePaints } from './apply.ts'

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

    if (differs('fontName', segment.fontName)) {
      const font = segment.fontName as { family: string; style: string }
      run.fontName = { family: font.family, style: font.style }
    }
    if (differs('fontSize', segment.fontSize)) run.fontSize = segment.fontSize
    if (differs('fills', segment.fills)) run.fill = await describePaints(segment.fills)
    if (differs('textDecoration', segment.textDecoration)) run.textDecoration = segment.textDecoration
    if (differs('textCase', segment.textCase)) run.textCase = segment.textCase
    if (differs('textWrapStyle', segment.textWrapStyle)) run.textWrap = segment.textWrapStyle
    if (differs('letterSpacing', segment.letterSpacing)) run.letterSpacing = writableMeasure(segment.letterSpacing)
    if (differs('lineHeight', segment.lineHeight)) run.lineHeight = writableMeasure(segment.lineHeight)
    if (differs('hyperlink', segment.hyperlink)) {
      const link = segment.hyperlink as { value?: string } | null
      run.link = link?.value ?? null
    }
    runs.push(run)
  }
  return runs
}

/** Leading and tracking as the write takes them: pixels as a number, a share as `"150%"`. */
export function writableMeasure(value: unknown): number | string {
  if (typeof value !== 'object' || value === null || !('unit' in value)) return 0
  const { unit, value: amount } = value as { unit: string; value?: number }
  if (unit === 'AUTO') return 'AUTO'
  const size = Math.round((amount ?? 0) * 100) / 100
  return unit === 'PERCENT' ? `${size}%` : size
}
