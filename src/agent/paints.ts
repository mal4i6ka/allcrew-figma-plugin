/**
 * Agent listener — the one description of a paint.
 *
 * Extracted from `ops.ts` because it is a leaf and `ops.ts` is not: `ops.ts` owns the op
 * registry, which imports every op module, and the appearance pass (`appearance.ts`) is reached
 * from one of them. Paint description living in the registry file therefore closed a runtime
 * import cycle — `ops -> ir-ops -> appearance -> ops` — and a cycle in a Figma plugin bundle is a
 * TDZ error at load, not a warning.
 *
 * It is one function on purpose. `node.get` and `styles.list` answered the same question
 * differently for a while — the style op reported gradient stops and the node op did not — and
 * the gap was invisible until a gradient had to be told apart from another gradient and neither
 * answer could do it. Two descriptions of one thing drift; one cannot.
 */

/** One paint in a stack, described so it can be acted on: what it renders, whether it is
 * bound, and its index — the same index `node.bind` and `lint.colors` use. */
export interface PaintSummary {
  /** SOLID, GRADIENT_LINEAR, IMAGE, … — a non-solid paint has no single colour to report. */
  type: string
  index: number
  /** `#RRGGBB`. Solid paints only; a gradient carries its colours per stop. */
  color?: string
  /** Only when the paint is not fully opaque — an absent `alpha` means 1. */
  alpha?: number
  /** Present only when the paint is hidden — an invisible paint is not a lint finding. */
  visible?: boolean
  /** The token on this paint, or null when it is raw. Paint-level bindings are what an
   * instance sublayer inherits from its main component, so this is not the same question as
   * the node-level `bindings` map. Always null on a gradient: a gradient binds per stop. */
  bound?: string | null
  /** IMAGE paints: the content hash of the picture — two layers with the same hash paint the
   * same file, which is what an asset pass needs to know before it exports either. */
  imageHash?: string
  /** VIDEO paints: the content hash. The Plugin API hands out nothing else for a video — no
   * bytes, no export — so the hash is the whole identity a consumer can act on: count the
   * distinct videos a design needs and ask for those files. */
  videoHash?: string
  /** IMAGE and VIDEO paints: FILL, FIT, CROP or TILE. */
  scaleMode?: string
  /** Gradients only. A gradient's tokens live on its stops, so a paint reported without them
   * says almost nothing — and `bound` above is null for a gradient however well tokenised it
   * is, which reads as "raw" and is not. */
  stops?: PaintStopSummary[]
  /** How much of this paint shows through, 0..1, when it is not 1. Reported on every paint
   * type, not just solids: a layer painted with three fills is a stack, and a stack read
   * without the opacity of each slice cannot be put back together — the colour underneath
   * either shows or it does not, and nothing else in the reading says which. */
  opacity?: number
  /** How this paint combines with the ones below it, when it is not NORMAL. The other half of
   * what makes a stack a stack: a MULTIPLY layer over a photo and a NORMAL one over the same
   * photo are two different pictures out of identical colours. */
  blendMode?: string
  /** Gradients: Figma's 2×3 matrix — where the ramp starts, where it ends, how it is turned.
   * Two gradients with the same stops and different transforms are two different gradients,
   * and the stops alone say nothing about the angle. */
  transform?: number[][]
  /** IMAGE and VIDEO: the crop, the tile size, the rotation and the colour adjustments Figma
   * applies on top of the file. The hash names the picture; these say what was done to it,
   * and a re-export that ignores them lands a different image. */
  imageTransform?: number[][]
  scalingFactor?: number
  rotation?: number
  filters?: Record<string, number>
  /** The same crop as numbers a layout engine takes, instead of a matrix nobody can apply.
   *
   * `imageTransform` is Figma's own 2x3, and every consumer of it re-derives the same three
   * quantities by hand (this is what Figma does internally to print
   * `background-size: 265% 114%; background-position: -523px 0`). `placement` is that
   * derivation, done once, in units that are not CSS: `scale` is the image's size as a multiple
   * of the layer's box, `offset` the image's top-left corner in the same multiples. A rotated
   * crop is refused rather than flattened - `fit: 'matrix'` says "read `imageTransform`". */
  placement?: {
    /** `cover` (FILL), `contain` (FIT), `tile` (TILE), `crop` (CROP with an axis-aligned
     * matrix) or `matrix` (a CROP this projection cannot express). */
    fit: 'cover' | 'contain' | 'tile' | 'crop' | 'matrix'
    /** CROP only. 1 means the image exactly covers the box on that axis. */
    scale?: { x: number; y: number }
    /** CROP only. 0 means flush with the box's own edge; negative means cropped off it. */
    offset?: { x: number; y: number }
    /** TILE only - Figma's own repeat scale, carried through unchanged. */
    scalingFactor?: number
  }
  /** PATTERN paints: the paint is another node, tiled. `sourceNodeId` is the whole content —
   * without it the paint reads as an empty type name. */
  pattern?: {
    sourceNodeId?: string
    tileType?: string
    scalingFactor?: number
    spacing?: { x: number; y: number }
    horizontalAlignment?: string
    verticalAlignment?: string
  }
  /** SHADER paints: the shader and the settings it was given. Everything a shader layer is
   * lives here — the paint itself carries no colour, no stops and no hash, so a reading
   * without this says only that something unreadable is in the stack. */
  shader?: ShaderSummary
}

export interface PaintStopSummary {
  /** Percent along the gradient — the unit a `pNN` token name is written in. */
  position: number
  color: string
  alpha?: number
  bound: string | null
}

/**
 * A shader paint or effect, as far as this file can describe it.
 *
 * The uniform ids are opaque (`2331874402:1925656642`) and mean nothing on their own; their
 * names live in the shader's `propertyDefinitions`, which only `listAvailableShaders()` and
 * `importShaderById()` hand out. On a file that merely *uses* a shader the first comes back
 * empty, so `named` says plainly whether the settings below are named or just numbered —
 * silently reporting ids as if they were the whole answer is what made a shader layer look
 * like a paint with nothing in it.
 */
export interface ShaderSummary {
  /** The id that puts this shader, and no other, on another layer. */
  id: string
  name?: string
  kind?: 'fill' | 'effect'
  /** False when the file could not name the settings — then `properties[].name` is absent and
   * the ids are all there is. */
  named: boolean
  properties?: ShaderPropertySummary[]
}

export interface ShaderPropertySummary {
  /** The property-definition id — the key a write puts back into `properties`. */
  id: string
  /** The author's name for the setting, when the shader could be named. */
  name?: string
  /** NUMBER, COLOR, GRADIENT, POINT, … — the shape `value` is in. */
  type?: string
  /** The value as Figma holds it. Variable aliases inside it — a gradient stop bound to a
   * token, a colour bound to one — are replaced by `{ token, id }`, because an id alone
   * cannot be read and a name alone cannot be written back. */
  value: unknown
}

/** `#RRGGBB`, uppercase — the spelling every reader in this channel uses for a colour. */
const paintChannel = (value: number) => Math.round(value * 255).toString(16).toUpperCase().padStart(2, '0')
const paintHex = (color: { r: number; g: number; b: number }) =>
  `#${paintChannel(color.r)}${paintChannel(color.g)}${paintChannel(color.b)}`

/**
 * How a paint's bound variable gets a name. Defaults to asking Figma, which is the only answer
 * inside the sandbox — and injectable because a caller that already walks a whole subtree has a
 * CACHE (`variableNameResolver`), and paying a fresh round trip per paint per layer for the same
 * few tokens is the difference between a fast answer and a slow one. It also makes the paint
 * describer readable from a test, which is how the appearance pass is covered at all.
 */
export type ResolveVariableName = (id: string) => Promise<string | null>

const figmaVariableName: ResolveVariableName = async (id) => {
  const variable = await figma.variables.getVariableByIdAsync(id)
  // The id rather than null on purpose: a token deleted out from under a paint still identifies
  // the binding, and reporting nothing would read as "this paint is raw", which it is not.
  return variable ? variable.name : id
}

async function boundTokenName(
  holder: unknown,
  resolve: ResolveVariableName = figmaVariableName
): Promise<string | null> {
  const id = (holder as { boundVariables?: { color?: { id?: string } } })?.boundVariables?.color?.id
  if (!id) return null
  return resolve(id)
}

/**
 * The variable aliases buried inside a shader's settings, named.
 *
 * A shader colour or gradient stop can be bound to a token exactly like any other colour, and
 * Figma hands the binding back as `{ type: 'VARIABLE_ALIAS', id }` nested wherever the value
 * happens to be. An id is unreadable and a name is unwritable, so both are kept: `token` is
 * for the person, `id` is what goes back on a write.
 */
async function nameAliasesWithin(value: unknown): Promise<unknown> {
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) out.push(await nameAliasesWithin(item))
    return out
  }
  if (!value || typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  if (record.type === 'VARIABLE_ALIAS' && typeof record.id === 'string') {
    let variable: Variable | null = null
    try {
      variable = await figma.variables.getVariableByIdAsync(record.id)
    } catch {
      /* an unresolvable alias is still the binding that is there — report it unnamed */
    }
    return { token: variable?.name ?? record.id, id: record.id, ...(variable?.key ? { key: variable.key } : {}) }
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) out[key] = await nameAliasesWithin(item)
  return out
}

/**
 * One shader — paint or effect — with its settings.
 *
 * `definitions` is the shader catalogue when the file could produce one. It is optional
 * because `listAvailableShaders()` costs a round trip and comes back empty on a file that
 * only uses shaders it did not author, which is the common case: the settings are then
 * reported by id, and `named: false` says so rather than leaving the reader to wonder why
 * every name is missing.
 */
export async function describeShader(
  shader: { id?: unknown; properties?: unknown },
  definitions?: Map<string, Shader>
): Promise<ShaderSummary> {
  const id = typeof shader?.id === 'string' ? shader.id : ''
  const known = definitions?.get(id)
  const declared = known?.propertyDefinitions ?? {}
  const out: ShaderSummary = {
    id,
    named: known !== undefined,
    ...(known ? { name: known.name, kind: known.type } : {}),
  }

  const properties = shader?.properties
  if (properties && typeof properties === 'object') {
    const described: ShaderPropertySummary[] = []
    for (const [defId, value] of Object.entries(properties as Record<string, unknown>)) {
      const definition = declared[defId]
      described.push({
        id: defId,
        ...(definition ? { name: definition.name, type: definition.type } : {}),
        value: await nameAliasesWithin(value),
      })
    }
    if (described.length > 0) out.properties = described
  }
  return out
}

/**
 * The one description of a paint, shared by `node.get` and `styles.list`.
 *
 * It is one function on purpose. These two ops answered the same question differently for a
 * while — the style op reported gradient stops and the node op did not — and the gap was
 * invisible until a gradient had to be told apart from another gradient and neither answer
 * could do it. Two descriptions of one thing drift; one cannot.
 */
/**
 * Figma's image matrix as the placement a layout engine takes.
 *
 * `FILL`/`FIT`/`TILE` need no matrix at all - they are `cover`, `contain` and a repeat. Only
 * `CROP` carries one, and it is a 2x3 mapping the layer's box back onto the image in normalised
 * coordinates: `[[a, b, tx], [c, d, ty]]`. With no rotation (`b` and `c` zero, which is every
 * crop a designer makes by dragging handles) the image is `1/a` by `1/d` boxes big and its top
 * left corner sits at `-tx/a`, `-ty/d`. That is exactly the arithmetic behind Figma's own
 * `background-size: 265.451% 114.231%; background-position: -523.197px 0px`, measured on
 * 4477:114155 and checked against this function.
 *
 * A rotated crop is reported as `matrix` rather than squashed into two axes: there is no honest
 * `background-position` for it, and a silently wrong number is worse than a named refusal.
 */
export function imagePlacement(
  scaleMode: unknown,
  transform: unknown,
  scalingFactor: unknown
): PaintSummary['placement'] | null {
  if (scaleMode === 'FILL') return { fit: 'cover' }
  if (scaleMode === 'FIT') return { fit: 'contain' }
  if (scaleMode === 'TILE') {
    return { fit: 'tile', ...(typeof scalingFactor === 'number' ? { scalingFactor } : {}) }
  }
  if (scaleMode !== 'CROP') return null
  const rows = transform as number[][] | undefined
  if (!Array.isArray(rows) || rows.length < 2 || !Array.isArray(rows[0]) || !Array.isArray(rows[1])) return null
  const [[a, b, tx], [c, d, ty]] = rows as [number[], number[]]
  if (b !== 0 || c !== 0 || !a || !d) return { fit: 'matrix' }
  const round = (value: number) => Math.round(value * 10000) / 10000
  return {
    fit: 'crop',
    scale: { x: round(1 / a), y: round(1 / d) },
    offset: { x: round(-tx / a), y: round(-ty / d) },
  }
}

export async function describePaint(
  paint: any,
  index: number,
  shaders?: Map<string, Shader>,
  resolve?: ResolveVariableName
): Promise<PaintSummary> {
  const out: PaintSummary = { type: String(paint?.type ?? 'UNKNOWN'), index }
  if (paint?.visible === false) out.visible = false
  // Every paint type carries these two, and a stack cannot be reassembled without them.
  // Reported before the per-type branches precisely because those branches return early —
  // that is how they went missing from images and gradients in the first place.
  if (typeof paint?.opacity === 'number' && paint.opacity < 1) out.opacity = paint.opacity
  if (typeof paint?.blendMode === 'string' && paint.blendMode !== 'NORMAL') out.blendMode = paint.blendMode

  if (paint?.type === 'SOLID' && paint.color) {
    out.color = paintHex(paint.color)
    // `alpha` predates `opacity` here and means the same thing on a solid. Kept because
    // callers read it; the two never disagree.
    if (typeof paint.opacity === 'number' && paint.opacity < 1) out.alpha = paint.opacity
    out.bound = await boundTokenName(paint, resolve)
    return out
  }

  if (Array.isArray(paint?.gradientStops)) {
    out.bound = null
    if (Array.isArray(paint.gradientTransform)) out.transform = paint.gradientTransform
    out.stops = []
    for (const stop of paint.gradientStops) {
      const described: PaintStopSummary = {
        position: Math.round(stop.position * 100),
        color: paintHex(stop.color),
        bound: await boundTokenName(stop, resolve),
      }
      if (typeof stop.color?.a === 'number' && stop.color.a < 1) described.alpha = stop.color.a
      out.stops.push(described)
    }
    return out
  }

  if (paint?.type === 'IMAGE' || paint?.type === 'VIDEO') {
    if (paint.type === 'IMAGE' && typeof paint.imageHash === 'string') out.imageHash = paint.imageHash
    if (paint.type === 'VIDEO' && typeof paint.videoHash === 'string') out.videoHash = paint.videoHash
    if (typeof paint.scaleMode === 'string') out.scaleMode = paint.scaleMode
    const transform = paint.type === 'IMAGE' ? paint.imageTransform : paint.videoTransform
    if (Array.isArray(transform)) out.imageTransform = transform
    if (typeof paint.scalingFactor === 'number') out.scalingFactor = paint.scalingFactor
    // The matrix, projected into the two numbers every consumer of it was computing by hand.
    const placement = imagePlacement(paint.scaleMode, transform, paint.scalingFactor)
    if (placement) out.placement = placement
    if (typeof paint.rotation === 'number' && paint.rotation !== 0) out.rotation = paint.rotation
    if (paint.filters && typeof paint.filters === 'object') {
      // Figma writes every adjustment it holds, zeroes included; only the ones that do
      // something are worth carrying.
      const filters: Record<string, number> = {}
      for (const [name, value] of Object.entries(paint.filters as Record<string, unknown>)) {
        if (typeof value === 'number' && value !== 0) filters[name] = value
      }
      if (Object.keys(filters).length > 0) out.filters = filters
    }
    out.bound = null
    return out
  }

  if (paint?.type === 'PATTERN') {
    out.pattern = {
      ...(typeof paint.sourceNodeId === 'string' ? { sourceNodeId: paint.sourceNodeId } : {}),
      ...(typeof paint.tileType === 'string' ? { tileType: paint.tileType } : {}),
      ...(typeof paint.scalingFactor === 'number' ? { scalingFactor: paint.scalingFactor } : {}),
      ...(paint.spacing ? { spacing: { x: paint.spacing.x, y: paint.spacing.y } } : {}),
      ...(typeof paint.horizontalAlignment === 'string'
        ? { horizontalAlignment: paint.horizontalAlignment }
        : {}),
      ...(typeof paint.verticalAlignment === 'string' ? { verticalAlignment: paint.verticalAlignment } : {}),
    }
    out.bound = null
    return out
  }

  if (paint?.type === 'SHADER') {
    out.shader = await describeShader(paint, shaders)
    out.bound = null
    return out
  }

  out.bound = await boundTokenName(paint, resolve)
  return out
}
