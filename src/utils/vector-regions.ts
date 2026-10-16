/**
 * Region fills: the paints a vector carries per enclosed area of its network, instead of one
 * stack for the whole node.
 *
 * A logo drawn as one vector with a black wordmark and an orange mark is the usual case. Figma
 * keeps those colours on `vectorNetwork.regions[i].fills`, and the node's own `fills` then reads
 * as `figma.mixed` — not an array. Every op that went through `node.fills` therefore saw nothing
 * at all: `node.get` returned no paints, `node.bind` answered "fills are unreadable on this
 * node", `variables.rebind` matched the binding and skipped it, and `lint.colors` never flagged
 * a raw colour there. The only way back in is the network itself, and the only way to write it
 * is `setVectorNetworkAsync` with the whole network — regions are not individually settable.
 */

/** One region's own paint stack, as the network holds it. */
export interface RegionPaints {
  /** Position in `vectorNetwork.regions` — the address a write needs. */
  region: number
  fills: Paint[]
  /** Set when this region follows a paint style rather than carrying its own paints. */
  fillStyleId?: string
}

/**
 * The region paints of a vector whose node-level fills are mixed, or null when the node paints
 * with ordinary fills (an array — even an empty one) or has no regions to speak of.
 *
 * Regions without their own `fills` inherit the node's, which is exactly the non-mixed case, so
 * a null here never hides a colour: the caller's existing `node.fills` path covers it.
 */
export function regionFills(node: unknown): RegionPaints[] | null {
  const holder = node as { fills?: unknown; vectorNetwork?: VectorNetwork } | null
  if (!holder || Array.isArray(holder.fills)) return null
  let network: VectorNetwork | undefined
  try {
    network = holder.vectorNetwork
  } catch {
    // Not a vector, or a sandbox that refuses the read — either way there is nothing to report.
    return null
  }
  const regions = network?.regions
  if (!Array.isArray(regions) || regions.length === 0) return null
  return regions.map((one, index) => {
    const out: RegionPaints = { region: index, fills: Array.isArray(one.fills) ? one.fills.slice() : [] }
    if (typeof one.fillStyleId === 'string' && one.fillStyleId !== '') out.fillStyleId = one.fillStyleId
    return out
  })
}

/**
 * A copy of `network` with the given regions' fills replaced and everything else — vertices,
 * segments, loops, winding rules, untouched regions — exactly as it was. The network is
 * written whole, so anything this drops would be lost from the drawing, not just the colour.
 */
export function withRegionFills(network: VectorNetwork, next: ReadonlyMap<number, Paint[]>): VectorNetwork {
  return {
    vertices: network.vertices,
    segments: network.segments,
    regions: (network.regions ?? []).map((one, index) => {
      const fills = next.get(index)
      return fills ? { ...one, fills } : one
    }),
  }
}

/** Write region fills back. Throws where Figma does — inside an instance a network is not
 * editable, which is reported to the caller rather than swallowed. */
export async function writeRegionFills(node: SceneNode, next: ReadonlyMap<number, Paint[]>): Promise<void> {
  const vector = node as SceneNode & {
    vectorNetwork?: VectorNetwork
    setVectorNetworkAsync?: (network: VectorNetwork) => Promise<void>
  }
  if (!vector.vectorNetwork || typeof vector.setVectorNetworkAsync !== 'function') {
    throw new Error(`a ${node.type} has no vector network to write region fills into`)
  }
  await vector.setVectorNetworkAsync(withRegionFills(vector.vectorNetwork, next))
}

/** The alias id a solid paint is bound to, or '' — the key every rebind map is looked up by. */
export function paintAliasId(paint: Paint): string {
  return (paint as { boundVariables?: { color?: { id?: string } } }).boundVariables?.color?.id ?? ''
}


/** What a read reports for one region paint. Deliberately plain: colour, opacity, the alias it
 * is bound to and nothing that needs a lookup. The full paint describer resolves tokens and
 * styles on the way, and that path took a live plugin session down on a logo vector — a region
 * read has to be the one read that cannot fail. Token names are a `variables.usage` away. */
export interface RegionPaintSummary {
  index: number
  type: string
  color?: string
  opacity?: number
  /** Variable id the colour is bound to — the `from` a rebind map takes. */
  boundTo?: string
  visible?: false
}

export interface RegionSummary {
  region: number
  fills: RegionPaintSummary[]
  /** Style id when the region follows a paint style; its name is not fetched (network). */
  fillStyleId?: string
}

const hex = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0')

export function summarizeRegions(regions: RegionPaints[]): RegionSummary[] {
  return regions.map((one) => {
    const fills = one.fills.map((paint, index) => {
      const out: RegionPaintSummary = { index, type: paint.type }
      if (paint.type === 'SOLID') {
        const { r, g, b } = (paint as SolidPaint).color
        out.color = `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase()
      }
      if (typeof paint.opacity === 'number' && paint.opacity < 1) out.opacity = paint.opacity
      const alias = paintAliasId(paint)
      if (alias) out.boundTo = alias
      if (paint.visible === false) out.visible = false
      return out
    })
    const entry: RegionSummary = { region: one.region, fills }
    if (one.fillStyleId) entry.fillStyleId = one.fillStyleId
    return entry
  })
}
