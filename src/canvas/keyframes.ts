/**
 * Movement on a timeline, read back in the shape `keyframes` takes on the way in.
 *
 * Figma stores a track per property under its own name — `TRANSLATION_X`, `STACK_SPACING` — while
 * this vocabulary spells a property the way the property is spelled: `x`, `gap`. The map between
 * them lives with the planner; this is the other direction of the same map, so a read of an
 * animated node is a write that would animate it again.
 */

import { formatKeyframeColour, indexedWord } from './keyframe-fields.ts'

/** Figma's field names → ours. The planner holds the same pairs the other way round. */
const OUR_WORDS: Readonly<Record<string, string>> = {
  OPACITY: 'opacity',
  TRANSLATION_X: 'x',
  TRANSLATION_Y: 'y',
  TRANSLATION_XY: 'move',
  ROTATION: 'rotation',
  SCALE_X: 'scaleX',
  SCALE_Y: 'scaleY',
  SCALE_XY: 'scale',
  WIDTH: 'width',
  HEIGHT: 'height',
  CORNER_RADIUS: 'cornerRadius',
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: 'topLeftRadius',
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: 'topRightRadius',
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: 'bottomLeftRadius',
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: 'bottomRightRadius',
  STROKE_WEIGHT: 'strokeWeight',
  BORDER_TOP_WEIGHT: 'strokeTop',
  BORDER_BOTTOM_WEIGHT: 'strokeBottom',
  BORDER_LEFT_WEIGHT: 'strokeLeft',
  BORDER_RIGHT_WEIGHT: 'strokeRight',
  STACK_SPACING: 'gap',
  STACK_COUNTER_SPACING: 'wrapGap',
  STACK_PADDING_LEFT: 'paddingLeft',
  STACK_PADDING_TOP: 'paddingTop',
  STACK_PADDING_RIGHT: 'paddingRight',
  STACK_PADDING_BOTTOM: 'paddingBottom',
  GRID_ROW_GAP: 'rowGap',
  GRID_COLUMN_GAP: 'columnGap',
  PATH_TRIM_START: 'trimStart',
  PATH_TRIM_END: 'trimEnd',
}

/**
 * `{ type: 'FLOAT', value }` and `{ type: 'VECTOR', value: { x, y } }` are how Figma holds it; a
 * `COLOR` comes back as the hex the write takes, with `@alpha` when it is not opaque.
 */
const plainValue = (held: unknown): unknown => {
  const one = held as { type?: string; value?: unknown } | undefined
  if (!one || one.value === undefined) return undefined
  if (one.type === 'COLOR') return formatKeyframeColour(one.value as { r: number; g: number; b: number; a?: number })
  return one.value
}

/** One stored track, in the shape `keyframes` takes — or null when nothing in it is readable. */
function readTrack(word: string, binding: unknown): unknown | null {
  const held = binding as { baseValue?: unknown; keyframes?: unknown[] } | undefined
  const frames = Array.isArray(held?.keyframes) ? held.keyframes : []

  const at: unknown[] = []
  for (const frame of frames) {
    const one = frame as { timelinePosition?: number; value?: unknown; easing?: { type?: string } }
    if (typeof one?.timelinePosition !== 'number') continue
    const value = plainValue(one.value)
    if (value === undefined) continue
    at.push({
      time: one.timelinePosition,
      value,
      ...(one.easing?.type && one.easing.type !== 'CUSTOM_CUBIC_BEZIER' ? { easing: one.easing.type } : {}),
    })
  }
  if (at.length === 0) return null

  const from = plainValue(held?.baseValue)
  return { field: word, ...(from === undefined ? {} : { from }), at }
}

export function readKeyframes(tracks: unknown): { keyframes?: unknown[] } {
  if (typeof tracks !== 'object' || tracks === null) return {}
  const out: unknown[] = []

  for (const [name, binding] of Object.entries(tracks as Record<string, unknown>)) {
    if (binding === undefined || binding === null) continue
    // Paints and effects are keyed by index under their collection rather than named. A paint
    // track whose colour is a component property (`{ properties }`) has no word yet and is left
    // out rather than half-read.
    if (name === 'fills' || name === 'strokes') {
      for (const [index, paint] of Object.entries(binding as Record<string, unknown>)) {
        const word = indexedWord(name, Number(index))
        const track = word ? readTrack(word, paint) : null
        if (track) out.push(track)
      }
      continue
    }
    if (name === 'effects') {
      for (const [index, fields] of Object.entries(binding as Record<string, Record<string, unknown>>)) {
        for (const [field, effect] of Object.entries(fields ?? {})) {
          const word = indexedWord('effects', Number(index), field)
          const track = word ? readTrack(word, effect) : null
          if (track) out.push(track)
        }
      }
      continue
    }
    const word = OUR_WORDS[name]
    if (!word) continue
    const track = readTrack(word, binding)
    if (track) out.push(track)
  }

  return out.length > 0 ? { keyframes: out } : {}
}
