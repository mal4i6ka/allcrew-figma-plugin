/**
 * Effects read back in the shape `effects` takes on the way in.
 *
 * The prose form — `"drop shadow #0A1F44 @0.2 0,4 blur 12"` — reads well and cannot be sent, and
 * a screen whose elevation is half its design could be read and not rebuilt. The prose stays
 * where it belongs: describing what a write just did. This is the reading.
 *
 * A field bound to a variable is bound on the EFFECT, not on the node, so it never appears in the
 * node's own `boundVariables`; each field is therefore asked for its binding first and the number
 * only stands in when there is none. That is why this is async.
 */

import { formatHex } from '../tokens/color.ts'

const point = (value: { x: number; y: number } | undefined): [number, number] | undefined =>
  value ? [round(value.x), round(value.y)] : undefined

const round = (value: number): number => Math.round(value * 100) / 100

/** `#RRGGBB`, with the alpha only when it is not 1 — the same spelling a paint uses. */
function colourWords(colour: { r: number; g: number; b: number; a: number }): string {
  return formatHex({ r: colour.r, g: colour.g, b: colour.b }).toUpperCase()
}

export async function readEffects(value: unknown): Promise<unknown[] | null> {
  if (!Array.isArray(value) || value.length === 0) return null

  const out: unknown[] = []
  for (const effect of value as Effect[]) {
    const bound = (effect as { boundVariables?: Record<string, { id?: string }> }).boundVariables ?? {}
    /** The variable a field follows, or the number it holds. */
    const field = async (name: string, held: number | undefined): Promise<number | { variable: string } | undefined> => {
      const id = bound[name]?.id
      if (!id) return held
      const variable = await figma.variables.getVariableByIdAsync(id).catch(() => null)
      return { variable: variable?.name ?? id }
    }
    const hidden = effect.visible === false ? { visible: false } : {}

    switch (effect.type) {
      case 'DROP_SHADOW':
      case 'INNER_SHADOW': {
        const colour = bound.color?.id
          ? { variable: (await figma.variables.getVariableByIdAsync(bound.color.id).catch(() => null))?.name ?? bound.color.id }
          : colourWords(effect.color)
        out.push({
          shadow: effect.type === 'DROP_SHADOW' ? 'drop' : 'inner',
          color: colour,
          ...(effect.color.a !== 1 ? { opacity: round(effect.color.a) } : {}),
          offset: [await field('offsetX', round(effect.offset.x)), await field('offsetY', round(effect.offset.y))],
          radius: await field('radius', round(effect.radius)),
          ...(effect.spread ? { spread: await field('spread', round(effect.spread)) } : {}),
          ...hidden,
        })
        break
      }

      case 'LAYER_BLUR':
      case 'BACKGROUND_BLUR': {
        const progressive = (effect as { blurType?: string }).blurType === 'PROGRESSIVE'
        const one = effect as unknown as { startRadius?: number; startOffset?: { x: number; y: number }; endOffset?: { x: number; y: number } }
        out.push({
          blur: progressive ? 'progressive' : effect.type === 'LAYER_BLUR' ? 'layer' : 'background',
          radius: await field('radius', round(effect.radius)),
          ...(progressive
            ? {
                startRadius: round(one.startRadius ?? 0),
                from: point(one.startOffset),
                to: point(one.endOffset),
              }
            : {}),
          ...hidden,
        })
        break
      }

      case 'NOISE': {
        const one = effect as unknown as {
          noiseType: string
          color: { r: number; g: number; b: number; a: number }
          secondaryColor?: { r: number; g: number; b: number; a: number }
          noiseSize: number
          density: number
          opacity?: number
        }
        const kinds: Record<string, string> = { MONOTONE: 'mono', DUOTONE: 'duo', MULTITONE: 'multi' }
        out.push({
          noise: kinds[one.noiseType] ?? one.noiseType,
          color: colourWords(one.color),
          ...(one.secondaryColor ? { second: colourWords(one.secondaryColor) } : {}),
          size: round(one.noiseSize),
          density: round(one.density),
          ...(one.opacity !== undefined ? { opacity: round(one.opacity) } : {}),

          ...hidden,
        })
        break
      }

      case 'TEXTURE': {
        const one = effect as unknown as { radius: number; noiseSize: number; clipToShape: boolean }
        out.push({ texture: round(one.radius), size: round(one.noiseSize), ...(one.clipToShape ? {} : { clip: false }), ...hidden })
        break
      }

      case 'GLASS': {
        const one = effect as unknown as {
          radius: number
          depth: number
          refraction: number
          dispersion: number
          lightAngle: number
          lightIntensity: number
        }
        out.push({
          glass: round(one.radius),
          depth: round(one.depth),
          refraction: round(one.refraction),
          dispersion: round(one.dispersion),
          lightAngle: round(one.lightAngle),
          lightIntensity: round(one.lightIntensity),
          ...hidden,
        })
        break
      }

      case 'SHADER': {
        const one = effect as unknown as { id: string; properties?: Record<string, unknown> }
        out.push({ shader: one.id, ...(one.properties ? { properties: one.properties } : {}), ...hidden })
        break
      }

      default:
        // Named rather than dropped: an effect nobody here has a word for is still on the layer,
        // and a reading that pretends otherwise is worse than one that says so.
        out.push({ unread: (effect as { type: string }).type })
    }
  }
  return out
}
