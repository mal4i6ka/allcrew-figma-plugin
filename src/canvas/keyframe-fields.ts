/**
 * The keyframe fields that are not properties of the node but of one of its paints or effects.
 *
 * Figma addresses those as `{ type: 'INDEXED_ITEM', collection, index, field? }` — "the second
 * fill", "the first effect's blur radius". A person says `fill`, `stroke[1]`, `effect.radius`,
 * `effect[2].color`, and the words after the dot are the ones the `effects` vocabulary already
 * uses for that effect, so a shadow is animated with the same `radius` and `spread` it was built
 * with. Kept pure, so both directions are tested without a Figma to ask.
 */

export type IndexedKeyframeField =
  | { type: 'INDEXED_ITEM'; collection: 'fills' | 'strokes'; index: number }
  | { type: 'INDEXED_ITEM'; collection: 'effects'; index: number; field: string }

/** Figma's effect field → the word the `effects` vocabulary uses for the same thing. */
const EFFECT_WORDS: Readonly<Record<string, string>> = {
  OFFSET_X: 'x',
  OFFSET_Y: 'y',
  RADIUS: 'radius',
  SPREAD: 'spread',
  COLOR: 'color',
  SECONDARY_COLOR: 'second',
  EFFECT_OPACITY: 'opacity',
  DENSITY: 'density',
  NOISE_SIZE_X: 'sizeX',
  NOISE_SIZE_Y: 'sizeY',
  START_RADIUS: 'startRadius',
  // Glass: the five words `{ glass }` is written with, plus splay, which it has no word for yet.
  REFRACTION_RADIUS: 'depth',
  REFRACTION_INTENSITY: 'refraction',
  CHROMATIC_ABERRATION: 'dispersion',
  SPECULAR_ANGLE: 'lightAngle',
  SPECULAR_INTENSITY: 'lightIntensity',
  SPLAY: 'splay',
}

const EFFECT_FIELDS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EFFECT_WORDS).map(([figma, ours]) => [ours, figma])
)

const COLOUR_EFFECT_FIELDS = ['COLOR', 'SECONDARY_COLOR']

const COLLECTIONS: Readonly<Record<string, 'fills' | 'strokes' | 'effects'>> = {
  fill: 'fills',
  stroke: 'strokes',
  effect: 'effects',
}

/** Every word after `effect.` — for the refusal that lists them. */
export const EFFECT_KEYFRAME_WORDS: readonly string[] = Object.values(EFFECT_WORDS)

/**
 * `fill`, `stroke[1]`, `effect.radius`, `effect[2].color` → the field Figma takes, and whether
 * its values are colours or numbers. Null when the word is not one of these — which includes
 * every node property, so the caller can ask this first and fall back to its own map.
 */
export function parseIndexedField(word: string): { field: IndexedKeyframeField; value: 'COLOR' | 'FLOAT' } | null {
  const match = /^(fill|stroke|effect)(?:\[(\d+)\])?(?:\.([A-Za-z]+))?$/.exec(word.trim())
  if (!match) return null
  const collection = COLLECTIONS[match[1]]
  const index = match[2] === undefined ? 0 : Number(match[2])
  const part = match[3]
  if (collection === 'effects') {
    if (part === undefined) return null
    const field = EFFECT_FIELDS[part]
    if (!field) return null
    return {
      field: { type: 'INDEXED_ITEM', collection, index, field },
      value: COLOUR_EFFECT_FIELDS.includes(field) ? 'COLOR' : 'FLOAT',
    }
  }
  // A paint is animated as a whole colour; there is no `.something` to name inside it.
  if (part !== undefined) return null
  return { field: { type: 'INDEXED_ITEM', collection, index }, value: 'COLOR' }
}

/** The other direction: what a read prints for an indexed track. The first item has no index. */
export function indexedWord(collection: string, index: number, effectField?: string): string | null {
  const noun = collection === 'fills' ? 'fill' : collection === 'strokes' ? 'stroke' : collection === 'effects' ? 'effect' : null
  if (!noun) return null
  const head = index === 0 ? noun : `${noun}[${index}]`
  if (noun !== 'effect') return effectField === undefined ? head : null
  const part = effectField === undefined ? undefined : EFFECT_WORDS[effectField]
  return part ? `${head}.${part}` : null
}

const clamp = (n: number) => Math.min(1, Math.max(0, n))
const channel = (n: number) => Math.round(clamp(n) * 255).toString(16).padStart(2, '0').toUpperCase()

/** An RGBA as a read prints it: `#RRGGBB`, or `#RRGGBB @0.4` when it is not opaque. */
export function formatKeyframeColour(colour: { r: number; g: number; b: number; a?: number }): string {
  const hex = `#${channel(colour.r)}${channel(colour.g)}${channel(colour.b)}`
  const alpha = colour.a === undefined ? 1 : Math.round(clamp(colour.a) * 1000) / 1000
  return alpha === 1 ? hex : `${hex} @${alpha}`
}

/**
 * The colours a keyframe takes: `#RRGGBB`, `#RRGGBB @0.4` (the read's own spelling) and
 * `#RRGGBBAA`. Anything else — a CSS function, a colour-space object — goes to `fallback`, which
 * is Figma's own parser in the plugin and nothing under the tests.
 */
export function keyframeColour(
  value: unknown,
  fallback: (value: unknown) => { r: number; g: number; b: number; a: number } | null
): { r: number; g: number; b: number; a: number } | null {
  if (typeof value === 'string') {
    const text = value.trim()
    const faded = /^#([0-9a-fA-F]{6})(?:\s*@\s*(\d*\.?\d+))?$/.exec(text)
    const eight = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/.exec(text)
    const hex = faded?.[1] ?? eight?.[1]
    if (hex) {
      const alpha = faded?.[2] !== undefined ? Number(faded[2]) : eight ? parseInt(eight[2], 16) / 255 : 1
      if (!(alpha >= 0 && alpha <= 1)) return null
      return {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
        a: alpha,
      }
    }
  }
  return fallback(value)
}
