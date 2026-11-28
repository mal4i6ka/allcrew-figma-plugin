/**
 * 3D transforms in static CSS (@figma/plugin-typings 1.143.0 — beta, "subject to change").
 *
 * The mapping is the one Figma's own typings spell out:
 *
 *   transform3d (FIXED_ORDER)   → transform: translateZ() rotateX() rotateY() rotateZ()
 *   backfaceVisible: false      → backface-visibility: hidden
 *   transformOrigin             → transform-origin (percent or pixels)
 *   scene3d.perspective >= 0    → perspective
 *   scene3d.preserve3d          → transform-style: preserve-3d
 *
 * Three things are not that simple, and each is handled here rather than left to the cascade:
 *
 * 1. The 2D path already owns `transform` and pins `transform-origin: 0 0` (Figma turns a layer
 *    about its top-left), and a rotated image fill appends its own `rotate()`. An element has one
 *    `transform` and one origin, so the 3D functions are written into the same declaration with
 *    their pivot baked in as a `translate()` pair — nothing overwrites anything.
 * 2. A container with `preserve3d` does not render its own opacity, blend mode, effects or
 *    clipping in Figma (the values are kept, not drawn). CSS would both draw them and — because
 *    each of those forces `transform-style: flat` — flatten the scene. They are left out, and said.
 * 3. A `FREEFORM` transform (imported) reads back with no numbers. Nothing is guessed: no
 *    transform is written and a note says the layer is not what the export shows.
 */

export interface Transform3dSource {
  readonly transform3d?: Transform3d
  readonly transformOrigin?: TransformOrigin
  readonly scene3d?: Scene3d | null
}

export type Transform3dNote =
  /** An imported 3D transform Figma hands back without its numbers — exported flat. */
  | { type: 'transform3d-freeform'; node: string }
  /** A layer both rotated in 2D and transformed in 3D: composed 2D-outside, 3D-inside. */
  | { type: 'transform3d-with-2d'; node: string }
  /** Declarations left out of a `preserve3d` container because Figma does not render them there. */
  | { type: 'preserve3d-not-rendered'; node: string; property: string }

const round = (value: number): number => Math.round(value * 1000) / 1000

interface Axis {
  readonly unit: 'PERCENT' | 'PIXELS'
  readonly value: number
}

const CENTRE: Axis = { unit: 'PERCENT', value: 50 }

const axisCss = (axis: Axis): string => `${round(axis.value)}${axis.unit === 'PERCENT' ? '%' : 'px'}`

const isCentre = (axis: Axis): boolean => axis.unit === 'PERCENT' && Math.abs(axis.value - 50) < 1e-6
const isZero = (axis: Axis): boolean => Math.abs(axis.value) < 1e-6

/** `axis - base` as a CSS length usable in `translate()`, where a percentage is of the element's own box. */
function offsetCss(axis: Axis, base: Axis, sign: 1 | -1): string {
  // Nothing to subtract from nothing, whatever unit the nothing is in.
  if (isZero(base)) return axisCss({ unit: axis.unit, value: sign * axis.value })
  if (isZero(axis)) return axisCss({ unit: base.unit, value: -sign * base.value })
  if (axis.unit === base.unit) return axisCss({ unit: axis.unit, value: sign * (axis.value - base.value) })
  const [left, right] = sign === 1 ? [axis, base] : [base, axis]
  return `calc(${axisCss(left)} - ${axisCss(right)})`
}

/**
 * `functions` turned about `origin` when the element's own `transform-origin` is its top-left —
 * the convention every layer with a 2D turn is placed by. The pivot is reached by translating to
 * it and back; a percentage in `translate()` is of the element's own box, which is what an origin
 * percentage means too.
 */
export function pivotFromTopLeft(functions: string, origin?: { x?: Axis; y?: Axis }): string {
  const x = origin?.x ?? CENTRE
  const y = origin?.y ?? CENTRE
  if (isZero(x) && isZero(y)) return functions
  const zero: Axis = { unit: 'PIXELS', value: 0 }
  return `translate(${offsetCss(x, zero, 1)}, ${offsetCss(y, zero, 1)}) ${functions} translate(${offsetCss(x, zero, -1)}, ${offsetCss(y, zero, -1)})`
}

/** The four functions, always all four and always in Figma's order. */
export function transform3dFunctions(value: { translateZ: number; rotateX: number; rotateY: number; rotateZ: number }): string {
  return `translateZ(${round(value.translateZ)}px) rotateX(${round(value.rotateX)}deg) rotateY(${round(value.rotateY)}deg) rotateZ(${round(value.rotateZ)}deg)`
}

/** 3D functions a CSS generator could have written for the same transform. */
const GENERATED_3D_FUNCTION = /(?:rotateX|rotateY|rotateZ|rotate3d|translateZ|translate3d|matrix3d|perspective)\([^)]*\)/g

/** Takes the 3D functions out of `transform`; with nothing left, the 2D pass's origin goes too. */
function strip3dFunctions(decl: Record<string, string>): void {
  const flat = decl['transform']?.replace(GENERATED_3D_FUNCTION, '').replace(/\s{2,}/g, ' ').trim()
  if (flat === undefined) return
  if (flat === '') {
    delete decl['transform']
    delete decl['transform-origin']
  } else decl['transform'] = flat
}

/** Declarations Figma does not render on a `preserve3d` container, and CSS flattens the scene for. */
const NOT_RENDERED_UNDER_PRESERVE_3D = ['opacity', 'mix-blend-mode', 'box-shadow', 'filter', 'backdrop-filter', '-webkit-backdrop-filter']

/**
 * Writes the node's 3D transform and scene into `decl`, the declaration map the 2D passes have
 * already filled. Run last, so it sees the `transform` and `transform-origin` they produced.
 */
export function apply3dDeclarations(
  decl: Record<string, string>,
  source: Transform3dSource | undefined,
  nodeId: string,
  notes?: { push(note: Transform3dNote): unknown }
): void {
  if (!source) return

  const transform = source.transform3d
  // `visible: false` is the transform switched off with its numbers kept — nothing to draw. But
  // `getCSSAsync` writes its functions all the same (read live: `rotateY(45deg)` for a transform
  // that is off), so they are taken out here rather than left to tilt a layer Figma shows flat.
  if (transform?.type === 'FIXED_ORDER' && transform.visible === false) {
    strip3dFunctions(decl)
    delete decl['backface-visibility']
  }
  if (transform && transform.type !== 'NONE' && transform.visible !== false) {
    if (transform.type === 'FREEFORM') {
      notes?.push({ type: 'transform3d-freeform', node: nodeId })
    } else if (transform.type === 'FIXED_ORDER') {
      const functions = transform3dFunctions(transform)
      const origin = { x: source.transformOrigin?.x ?? CENTRE, y: source.transformOrigin?.y ?? CENTRE }
      // `getCSSAsync` writes the 3D functions itself (read live: `translateZ(40px) rotateY(30deg)`,
      // zeros left out). Those are the same numbers again: they are taken out so the transform is
      // written once, here, all four functions in the order Figma names.
      strip3dFunctions(decl)
      const existing = decl['transform']

      if (!existing) {
        decl['transform'] = functions
        // The centre is also where CSS turns things by default, so it is only said when it is not.
        if (!(isCentre(origin.x) && isCentre(origin.y))) decl['transform-origin'] = `${axisCss(origin.x)} ${axisCss(origin.y)}`
      } else {
        // The 2D pass pins its origin to the top-left; a lone image rotation leaves the default
        // centre. Either way that pivot stays, and the 3D pivot is reached by translating to it.
        const pinned = decl['transform-origin'] !== undefined
        const base = pinned ? { x: { unit: 'PIXELS', value: 0 } as Axis, y: { unit: 'PIXELS', value: 0 } as Axis } : { x: CENTRE, y: CENTRE }
        const atBase = pinned ? isZero(origin.x) && isZero(origin.y) : isCentre(origin.x) && isCentre(origin.y)
        const pivoted = atBase
          ? functions
          : `translate(${offsetCss(origin.x, base.x, 1)}, ${offsetCss(origin.y, base.y, 1)}) ${functions} translate(${offsetCss(origin.x, base.x, -1)}, ${offsetCss(origin.y, base.y, -1)})`
        if (pinned) {
          // The layer's own 2D turn places it in its parent; the 3D transform happens inside that.
          // This is the order Figma's own `getCSSAsync` writes (2D rotate first, then the 3D
          // functions — read live). The note stays: the pivot is baked, not a plain origin.
          decl['transform'] = `${existing} ${pivoted}`
          notes?.push({ type: 'transform3d-with-2d', node: nodeId })
        } else {
          // Only the picture inside the layer is turned: innermost, so it is written last.
          decl['transform'] = `${pivoted} ${existing}`
        }
      }
      if (transform.backfaceVisible === false) decl['backface-visibility'] = 'hidden'
    }
  }

  const scene = source.scene3d
  if (scene) {
    // Negative is Figma's "no perspective"; `visible: false` switches it off and keeps the number.
    // `preserve3d` applies independently of that switch.
    if (scene.visible !== false && Number.isFinite(scene.perspective) && scene.perspective >= 0) {
      decl['perspective'] = `${round(scene.perspective)}px`
    } else {
      // Whatever a CSS generator wrote for a perspective that is off.
      delete decl['perspective']
    }
    if (scene.preserve3d === true) {
      decl['transform-style'] = 'preserve-3d'
      for (const property of NOT_RENDERED_UNDER_PRESERVE_3D) {
        if (decl[property] === undefined) continue
        delete decl[property]
        if (!property.startsWith('-webkit-')) notes?.push({ type: 'preserve3d-not-rendered', node: nodeId, property })
      }
      // Clipping only — a scrolling frame keeps its `overflow: auto`.
      if (decl['overflow'] === 'hidden') {
        delete decl['overflow']
        notes?.push({ type: 'preserve3d-not-rendered', node: nodeId, property: 'overflow' })
      }
    }
  }
}
