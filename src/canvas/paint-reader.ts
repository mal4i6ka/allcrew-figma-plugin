/**
 * A layer's paints, read in the shape `fill` and `stroke` take on the way in.
 *
 * `describePaints` prints one line — `image:3f9a… FILL`, `gradient:linear #FFF → #000`, two
 * paints joined with ` + ` — which is right for a report and useless for a copy: none of those
 * lines is something the vocabulary accepts, so every image, every gradient and every stacked
 * fill came out of a round trip as `dropped`. Here the ordinary case stays the short string it
 * always was (`#FB5B0A`, `#000000 @0.4`, `var:surface/l0`) and everything else becomes the object
 * the write takes: `{ gradient, from, to, stops }`, `{ image: { hash }, scaleMode }`,
 * `{ video: { hash } }`, and a list when there is more than one.
 *
 * Shaders stay the descriptive line: their settings travel on `paints.stack`, and a copy built
 * from a guess at them would be a different shader that looks like a match.
 */

import { gradientEnds } from './props.ts'

type Rgb = { r: number; g: number; b: number; a?: number }

const round = (value: number) => Math.round(value * 1000) / 1000

function hex(colour: Rgb): string {
  return `#${[colour.r, colour.g, colour.b]
    .map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
}

/** Variable id → its name, or null when it cannot be found. */
export type NameOf = (id: string) => Promise<string | null>

async function readOne(paint: Record<string, unknown>, nameOf: NameOf): Promise<unknown> {
  const opacity = typeof paint.opacity === 'number' && paint.opacity < 1 ? round(paint.opacity) : undefined
  const type = String(paint.type)
  const bound = (paint.boundVariables as { color?: { id?: string } } | undefined)?.color?.id

  if (type === 'SOLID') {
    if (bound) {
      const name = (await nameOf(bound)) ?? bound
      return opacity === undefined ? `var:${name}` : { variable: name, opacity }
    }
    const colour = hex(paint.color as Rgb)
    return opacity === undefined ? colour : `${colour} @${opacity}`
  }

  if (type === 'IMAGE' || type === 'VIDEO') {
    const key = type === 'IMAGE' ? 'image' : 'video'
    const hash = type === 'IMAGE' ? paint.imageHash : paint.videoHash
    if (typeof hash !== 'string' || hash === '') return type
    // The image panel's sliders, a quarter turn, a tile size and a crop: a filtered photo read
    // without them copied as an unfiltered one. Filters are 32-bit floats — exposure 0.3 reads
    // 0.30000001192092896 — so they are said to three places, as everything else here is.
    const filters = Object.fromEntries(
      Object.entries((paint.filters as Record<string, number> | undefined) ?? {})
        .filter(([, amount]) => typeof amount === 'number' && amount !== 0)
        .map(([name, amount]) => [name, round(amount)])
    )
    const mode = paint.scaleMode
    return {
      [key]: { hash },
      ...(typeof mode === 'string' && mode !== 'FILL' ? { scaleMode: mode } : {}),
      ...(opacity === undefined ? {} : { opacity }),
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
      ...(typeof paint.rotation === 'number' && paint.rotation !== 0 ? { rotation: paint.rotation } : {}),
      ...(type === 'IMAGE' && mode === 'TILE' && typeof paint.scalingFactor === 'number' && paint.scalingFactor !== 1
        ? { tile: round(paint.scalingFactor) }
        : {}),
      ...(type === 'IMAGE' && mode === 'CROP' && Array.isArray(paint.imageTransform)
        ? { crop: (paint.imageTransform as number[][]).map((row) => row.map((value) => Math.round(value * 1e6) / 1e6)) }
        : {}),
    }
  }

  if (type.startsWith('GRADIENT_')) {
    const kind = type.slice('GRADIENT_'.length)
    const ends = gradientEnds(paint.gradientTransform as number[][], kind)
    const stops = []
    for (const stop of (paint.gradientStops as Array<{ position: number; color: Rgb; boundVariables?: { color?: { id?: string } } }>) ?? []) {
      const id = stop.boundVariables?.color?.id
      const alpha = typeof stop.color.a === 'number' && stop.color.a < 1 ? round(stop.color.a) : undefined
      stops.push({
        at: round(stop.position),
        color: id ? { variable: (await nameOf(id)) ?? id } : hex(stop.color),
        ...(alpha === undefined || id ? {} : { opacity: alpha }),
      })
    }
    return {
      gradient: kind,
      ...(ends ? { from: ends.from, to: ends.to } : {}),
      stops,
      ...(opacity === undefined ? {} : { opacity }),
    }
  }

  if (type === 'PATTERN') {
    const spacing = paint.spacing as { x: number; y: number } | undefined
    return {
      pattern: String(paint.sourceNodeId),
      ...(paint.tileType && paint.tileType !== 'RECTANGULAR' ? { tile: paint.tileType } : {}),
      ...(typeof paint.scalingFactor === 'number' && paint.scalingFactor !== 1 ? { scale: round(paint.scalingFactor) } : {}),
      ...(spacing && (spacing.x !== 0 || spacing.y !== 0) ? { spacing: [round(spacing.x), round(spacing.y)] } : {}),
      ...(paint.horizontalAlignment && paint.horizontalAlignment !== 'START' ? { align: paint.horizontalAlignment } : {}),
      ...(opacity === undefined ? {} : { opacity }),
    }
  }

  if (type === 'SHADER') {
    const settings = Object.keys((paint.properties as object) ?? {})
    return `shader:${String(paint.id)}${settings.length > 0 ? ` (${settings.join(', ')})` : ''}`
  }
  return type
}

/**
 * `figma.mixed` reads as `"mixed"`, no paints as `"none"`, one paint as itself and a stack as a
 * list bottom-up — the order Figma holds it and the order a write lays it down.
 */
export async function readPaintsForWrite(value: unknown, nameOf: NameOf, mixed?: unknown): Promise<unknown> {
  if (mixed !== undefined && value === mixed) return 'mixed'
  if (!Array.isArray(value)) return value === undefined ? null : String(value)
  if (value.length === 0) return 'none'
  const read = []
  for (const paint of value) {
    read.push(typeof paint === 'object' && paint !== null ? await readOne(paint as Record<string, unknown>, nameOf) : String(paint))
  }
  return read.length === 1 ? read[0] : read
}
