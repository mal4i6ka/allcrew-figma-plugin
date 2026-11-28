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
  TRANSFORM_3D_TRANSLATION_Z: 'translateZ',
  TRANSFORM_3D_ROTATION_X: 'rotateX',
  TRANSFORM_3D_ROTATION_Y: 'rotateY',
  TRANSFORM_3D_ROTATION_Z: 'rotateZ',
  SCENE_3D_PERSPECTIVE: 'perspective',
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

/** Plugin data key: `{ [settingId]: name }` for shader settings this plugin has animated. */
export const SHADER_SETTING_NAMES_KEY = 'shaderSettingNames'

/** The names this plugin kept for a layer's animated shader settings; empty when there are none. */
export function shaderSettingNames(node: unknown): Record<string, string> {
  try {
    const raw = (node as { getPluginData?: (key: string) => string }).getPluginData?.(SHADER_SETTING_NAMES_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** One stored track as `{ from?, at }` — or null when nothing in it is readable. */
function readFrames(binding: unknown): { from?: unknown; at: unknown[] } | null {
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
  return { ...(from === undefined ? {} : { from }), at }
}

/** One stored track, in the shape `keyframes` takes — or null when nothing in it is readable. */
function readTrack(word: string, binding: unknown): unknown | null {
  const frames = readFrames(binding)
  return frames ? { field: word, ...frames } : null
}

/**
 * A shader's animated settings: `fills[1].properties[<setting id>]`. Figma leaves an animated
 * setting out of the paint itself, so this is the only place it can be read from. The setting is
 * given by id — which a write takes — because the tracks carry no names.
 */
function readShaderTracks(collection: 'fills' | 'strokes' | 'effects', index: string, slot: unknown, out: unknown[]): boolean {
  const settings = (slot as { properties?: unknown } | undefined)?.properties
  if (!settings || typeof settings !== 'object') return false
  const word = collection === 'fills' ? 'fill' : collection === 'strokes' ? 'stroke' : 'effect'
  for (const [setting, binding] of Object.entries(settings as Record<string, unknown>)) {
    const frames = readFrames(binding)
    if (frames) out.push({ shader: { setting, in: word, index: Number(index) }, ...frames })
  }
  return true
}

export function readKeyframes(tracks: unknown): { keyframes?: unknown[] } {
  if (typeof tracks !== 'object' || tracks === null) return {}
  const out: unknown[] = []

  for (const [name, binding] of Object.entries(tracks as Record<string, unknown>)) {
    if (binding === undefined || binding === null) continue
    // Paints and effects are keyed by index under their collection rather than named. A slot
    // holding `{ properties }` is a shader's settings, read as `shader: { setting, in, index }`.
    if (name === 'fills' || name === 'strokes') {
      for (const [index, paint] of Object.entries(binding as Record<string, unknown>)) {
        if (readShaderTracks(name, index, paint, out)) continue
        const word = indexedWord(name, Number(index))
        const track = word ? readTrack(word, paint) : null
        if (track) out.push(track)
      }
      continue
    }
    if (name === 'effects') {
      for (const [index, fields] of Object.entries(binding as Record<string, Record<string, unknown>>)) {
        if (readShaderTracks('effects', index, fields, out)) continue
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
