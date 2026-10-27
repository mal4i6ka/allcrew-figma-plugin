/**
 * How an underline or a strikethrough is drawn — `textDecoration` says THAT there is one, this
 * says what it looks like: wavy or dotted, how far below the baseline, how thick, which colour,
 * whether it breaks around descenders.
 *
 * Five Figma properties, each with its own little union (`{ unit: 'AUTO' }`, `{ value, unit }`,
 * `{ value: SolidPaint }`), in one object a person would write: `{ style: "WAVY", offset: 2,
 * thickness: "10%", color: "#FB5B0A", skipInk: false }`. Only what differs from Figma's default
 * is read back, so a plain underline reads as nothing here at all.
 */

import { keyframeColour } from './keyframe-fields.ts'
import { colourFrom, solidColourOf } from './props.ts'

export interface DecorationSpec {
  style?: 'SOLID' | 'WAVY' | 'DOTTED'
  /** Pixels, a percentage of the font size like `"10%"`, or `"AUTO"`. */
  offset?: number | string
  thickness?: number | string
  /** A colour, or `"AUTO"` to follow the text. */
  color?: unknown
  /** Break the line around descenders. Figma's default is true. */
  skipInk?: boolean
}

type Measured = { value: number; unit: 'PIXELS' | 'PERCENT' } | { unit: 'AUTO' }

export interface DecorationValues {
  textDecorationStyle?: 'SOLID' | 'WAVY' | 'DOTTED'
  textDecorationOffset?: Measured
  textDecorationThickness?: Measured
  textDecorationColor?: { value: SolidPaint | 'AUTO' }
  textDecorationSkipInk?: boolean
}

const STYLES = ['SOLID', 'WAVY', 'DOTTED']

function measured(raw: unknown): Measured | null {
  if (raw === 'AUTO') return { unit: 'AUTO' }
  if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw, unit: 'PIXELS' }
  if (typeof raw === 'string') {
    const match = /^(-?\d+(?:\.\d+)?)(px|%)?$/.exec(raw.trim())
    if (match) return { value: Number(match[1]), unit: match[2] === '%' ? 'PERCENT' : 'PIXELS' }
  }
  return null
}

function measureWords(value: Measured): number | string {
  if (value.unit === 'AUTO') return 'AUTO'
  const rounded = Math.round(value.value * 100) / 100
  return value.unit === 'PERCENT' ? `${rounded}%` : rounded
}

/** The words, into the five properties Figma stores — or why not. */
export function planDecoration(raw: unknown): { values: DecorationValues } | { problem: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problem: 'must be { style, offset, thickness, color, skipInk }' }
  }
  const spec = raw as Record<string, unknown>
  const known = ['style', 'offset', 'thickness', 'color', 'skipInk']
  const extra = Object.keys(spec).filter((key) => !known.includes(key))
  if (extra.length > 0) return { problem: `takes ${known.join(', ')} — not ${extra.join(', ')}` }
  if (Object.keys(spec).length === 0) return { problem: 'names nothing to change' }

  const values: DecorationValues = {}
  if (spec.style !== undefined) {
    const style = String(spec.style).toUpperCase()
    if (!STYLES.includes(style)) return { problem: `style must be one of: ${STYLES.join(', ')}` }
    values.textDecorationStyle = style as DecorationValues['textDecorationStyle']
  }
  for (const [key, property] of [['offset', 'textDecorationOffset'], ['thickness', 'textDecorationThickness']] as const) {
    if (spec[key] === undefined) continue
    const value = measured(spec[key])
    if (!value) return { problem: `${key} must be pixels, a percentage like "10%", or "AUTO"` }
    values[property] = value
  }
  if (spec.color !== undefined) {
    if (spec.color === 'AUTO') values.textDecorationColor = { value: 'AUTO' }
    else {
      const colour = keyframeColour(spec.color, colourFrom)
      if (!colour) return { problem: 'color must be a colour, or "AUTO" to follow the text' }
      values.textDecorationColor = {
        value: { type: 'SOLID', color: solidColourOf(colour), ...(colour.a < 1 ? { opacity: colour.a } : {}) } as SolidPaint,
      }
    }
  }
  if (spec.skipInk !== undefined) {
    if (typeof spec.skipInk !== 'boolean') return { problem: 'skipInk must be true or false' }
    values.textDecorationSkipInk = spec.skipInk
  }
  return { values }
}

const hex = (colour: RGB) =>
  `#${[colour.r, colour.g, colour.b].map((n) => Math.round(n * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`

/**
 * What a node or a run says beyond Figma's defaults, in the words `planDecoration` takes. Null
 * when it says nothing — a plain underline, or a mixed value whose runs carry the detail.
 */
export function decorationWords(source: Record<string, unknown>): DecorationSpec | null {
  const out: DecorationSpec = {}
  const style = source.textDecorationStyle
  if (typeof style === 'string' && style !== 'SOLID') out.style = style as DecorationSpec['style']
  for (const [key, property] of [['offset', 'textDecorationOffset'], ['thickness', 'textDecorationThickness']] as const) {
    const value = source[property] as Measured | null | undefined
    if (value && typeof value === 'object' && value.unit !== 'AUTO') out[key] = measureWords(value)
  }
  const colour = source.textDecorationColor as { value?: SolidPaint | 'AUTO' } | null | undefined
  if (colour && typeof colour === 'object' && colour.value && colour.value !== 'AUTO') {
    const paint = colour.value
    const alpha = typeof paint.opacity === 'number' && paint.opacity < 1 ? Math.round(paint.opacity * 1000) / 1000 : undefined
    out.color = alpha === undefined ? hex(paint.color) : `${hex(paint.color)} @${alpha}`
  }
  if (source.textDecorationSkipInk === false) out.skipInk = false
  return Object.keys(out).length > 0 ? out : null
}
