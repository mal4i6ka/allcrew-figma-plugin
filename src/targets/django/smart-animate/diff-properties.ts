/**
 * Property diff (T5.6, docs/research/05-smart-animate-css-diff.md §1.2/§1.5): reduces a matched
 * pair of nodes to every property group Smart Animate interpolates — position, size, rotation,
 * opacity, fills, strokes, corner radius, effects (shadows/blur), text style, auto-layout
 * spacing, visibility, blend mode. `figma.mixed` (represented here as the local `MIXED`
 * sentinel, see `types.ts`) always short-circuits a comparison, matching Figma's own behavior
 * of not interpolating a property it can't read a single value for.
 */

import { matchLayers } from './match-layers.ts'
import { MIXED } from './types.ts'
import type {
  DiffableEffect,
  DiffableImagePaint,
  DiffableLetterSpacing,
  DiffableLineHeight,
  DiffableNode,
  DiffablePaint,
  NodePath,
} from './types.ts'

export interface RGBA {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

/** One composed drop/inner shadow layer, in Figma's `effects` order — the order `box-shadow`
 * lists its comma-separated layers in. */
export interface DiffableShadowLayer {
  readonly type: 'DROP_SHADOW' | 'INNER_SHADOW'
  readonly color: RGBA
  readonly offsetX: number
  readonly offsetY: number
  readonly radius: number
  readonly spread: number
}

export type PropertyChange =
  | { readonly prop: 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity'; readonly from: number; readonly to: number }
  | { readonly prop: 'cornerRadius'; readonly from: number; readonly to: number }
  | {
      readonly prop: 'cornerRadii'
      readonly from: readonly [number, number, number, number]
      readonly to: readonly [number, number, number, number]
    }
  | { readonly prop: 'fillColor'; readonly from: RGBA; readonly to: RGBA }
  | { readonly prop: 'strokeColor'; readonly from: RGBA; readonly to: RGBA }
  | { readonly prop: 'strokeWeight'; readonly from: number; readonly to: number }
  | {
      readonly prop: 'background'
      readonly from: readonly DiffablePaint[]
      readonly to: readonly DiffablePaint[]
      /** Whether a CSS `transition` can animate this — a solid-only stack collapses to one
       * `background-color`; a stack holding a gradient or image paint can't, because CSS has
       * no way to interpolate between two `background-image` values. */
      readonly interpolable: boolean
      /** The destination stack's visible `IMAGE` paints, topmost (last-painted, see
       * `DiffablePaint`'s ordering note) last — lets the emitter build a cross-fade overlay for
       * a photo swap instead of only knowing "this stack has an image, give up". Optional so
       * hand-authored fixtures/older callers that predate image cross-fade still type-check;
       * `diffProperties` itself always sets it (to `[]` when the stack has no image). */
      readonly images?: readonly DiffableImagePaint[]
    }
  | { readonly prop: 'boxShadow'; readonly from: readonly DiffableShadowLayer[]; readonly to: readonly DiffableShadowLayer[] }
  | { readonly prop: 'layerBlur'; readonly from: readonly number[]; readonly to: readonly number[] }
  | { readonly prop: 'backgroundBlur'; readonly from: readonly number[]; readonly to: readonly number[] }
  | { readonly prop: 'fontSize' | 'fontWeight'; readonly from: number; readonly to: number }
  | { readonly prop: 'letterSpacing'; readonly from: DiffableLetterSpacing; readonly to: DiffableLetterSpacing }
  | { readonly prop: 'lineHeight'; readonly from: DiffableLineHeight; readonly to: DiffableLineHeight }
  | { readonly prop: 'textColor'; readonly from: RGBA; readonly to: RGBA }
  | {
      readonly prop: 'padding'
      readonly from: readonly [number, number, number, number]
      readonly to: readonly [number, number, number, number]
    }
  | { readonly prop: 'gap' | 'crossGap'; readonly from: number; readonly to: number }
  | { readonly prop: 'visible'; readonly from: boolean; readonly to: boolean }
  | { readonly prop: 'blendMode'; readonly from: string; readonly to: string }

const EPS = 0.01

function neq(a: number, b: number): boolean {
  return Math.abs(a - b) > EPS
}

function cornerRadii(node: DiffableNode): readonly [number, number, number, number] | null {
  if (typeof node.cornerRadius === 'number') {
    return [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius]
  }
  if (
    node.cornerRadius === MIXED &&
    node.topLeftRadius !== undefined &&
    node.topRightRadius !== undefined &&
    node.bottomRightRadius !== undefined &&
    node.bottomLeftRadius !== undefined
  ) {
    return [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius]
  }
  return null
}

/** A stack collapsed to exactly one SOLID paint is the only shape Figma itself exposes as a
 * flat color — anything else (multiple paints, a gradient, an image) has no single RGB to
 * read, so callers must fall back to comparing the whole stack. `requireVisible` distinguishes
 * fill/text discipline (unchanged, matches the paint regardless of `visible`) from the new
 * stroke discipline, which Figma itself skips rendering when `visible` is false. */
function singleSolidPaint(paints: readonly DiffablePaint[] | typeof MIXED | undefined, requireVisible: boolean): DiffablePaint | null {
  if (paints === undefined || paints === MIXED || paints.length !== 1) return null
  const paint = paints[0]
  if (paint.type !== 'SOLID' || !paint.color) return null
  if (requireVisible && paint.visible === false) return null
  return paint
}

/** Folds a SOLID paint's separate `color`/`opacity` into one RGBA the same way the emitter's
 * `rgba()` writer wants it — called only after `singleSolidPaint` has confirmed `color` is
 * present, but re-checked here (rather than cast) since that guarantee doesn't survive the
 * function boundary as a type. */
function solidRgba(paint: DiffablePaint): RGBA {
  if (!paint.color) return { r: 0, g: 0, b: 0, a: 0 }
  return { ...paint.color, a: paint.opacity ?? 1 }
}

/** Narrows an effect to the two shadow types before `shadowLayers` reads shadow-only fields —
 * a type guard rather than a cast so a third shadow-like type added to Figma's `Effect` union
 * later fails to compile here instead of silently reading undefined shadow fields. */
function isShadowEffect(effect: DiffableEffect): effect is DiffableEffect & { readonly type: 'DROP_SHADOW' | 'INNER_SHADOW' } {
  return effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW'
}

function shadowLayers(node: DiffableNode): readonly DiffableShadowLayer[] {
  return (node.effects ?? [])
    .filter((effect) => effect.visible !== false)
    .filter(isShadowEffect)
    .map((effect) => ({
      type: effect.type,
      color: effect.color ?? { r: 0, g: 0, b: 0, a: 0 },
      offsetX: effect.offset?.x ?? 0,
      offsetY: effect.offset?.y ?? 0,
      radius: effect.radius,
      spread: effect.spread ?? 0,
    }))
}

function blurRadii(node: DiffableNode, type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'): readonly number[] {
  return (node.effects ?? []).filter((effect) => effect.visible !== false && effect.type === type).map((effect) => effect.radius)
}

/** Figma renders as though a `visible: false` paint were absent — comparing the raw arrays
 * would report a change every time a hidden paint's unrelated fields (e.g. an unused
 * gradient's stops) happened to differ between states. */
function isRenderedPaint(paint: DiffablePaint): boolean {
  return paint.visible !== false
}

/** Reduces a paint stack to the `IMAGE` layers a `background` change carries forward for the
 * emitter's cross-fade overlay — `imageHash` is filtered to a definite `string` here (Figma
 * allows `null` while a fill is mid-edit) so nothing downstream has to re-check it. */
function imagePaints(paints: readonly DiffablePaint[]): readonly DiffableImagePaint[] {
  return paints
    .filter((paint): paint is DiffablePaint & { imageHash: string } => paint.type === 'IMAGE' && typeof paint.imageHash === 'string')
    .map((paint) => ({ imageHash: paint.imageHash, scaleMode: paint.scaleMode, opacity: paint.opacity }))
}

/** Diffs one matched pair of nodes across every property Smart Animate interpolates. */
export function diffProperties(a: DiffableNode, b: DiffableNode): PropertyChange[] {
  const out: PropertyChange[] = []

  if (neq(a.x, b.x)) out.push({ prop: 'x', from: a.x, to: b.x })
  if (neq(a.y, b.y)) out.push({ prop: 'y', from: a.y, to: b.y })
  if (neq(a.width, b.width)) out.push({ prop: 'width', from: a.width, to: b.width })
  if (neq(a.height, b.height)) out.push({ prop: 'height', from: a.height, to: b.height })
  if (a.rotation !== undefined && b.rotation !== undefined && neq(a.rotation, b.rotation)) {
    out.push({ prop: 'rotation', from: a.rotation, to: b.rotation })
  }
  if (a.opacity !== undefined && b.opacity !== undefined && neq(a.opacity, b.opacity)) {
    out.push({ prop: 'opacity', from: a.opacity, to: b.opacity })
  }
  if (a.visible !== undefined && b.visible !== undefined && a.visible !== b.visible) {
    out.push({ prop: 'visible', from: a.visible, to: b.visible })
  }
  if (a.blendMode !== undefined && b.blendMode !== undefined && a.blendMode !== b.blendMode) {
    out.push({ prop: 'blendMode', from: a.blendMode, to: b.blendMode })
  }

  const isText = a.type === 'TEXT' && b.type === 'TEXT'

  if (isText) {
    // A TEXT node's `fills` paints its characters, not a background rectangle behind them —
    // reporting it as `background` too would make the emitter draw a filled box behind text
    // that Figma never draws one behind.
    const singleA = singleSolidPaint(a.fills, false)
    const singleB = singleSolidPaint(b.fills, false)
    if (singleA && singleB && JSON.stringify(singleA) !== JSON.stringify(singleB)) {
      out.push({ prop: 'textColor', from: solidRgba(singleA), to: solidRgba(singleB) })
    }
  } else if (a.fills !== undefined && b.fills !== undefined && a.fills !== MIXED && b.fills !== MIXED) {
    const singleA = singleSolidPaint(a.fills, false)
    const singleB = singleSolidPaint(b.fills, false)
    if (singleA && singleB && JSON.stringify(singleA) !== JSON.stringify(singleB)) {
      out.push({ prop: 'fillColor', from: solidRgba(singleA), to: solidRgba(singleB) })
    } else {
      const visibleA = a.fills.filter(isRenderedPaint)
      const visibleB = b.fills.filter(isRenderedPaint)
      if (JSON.stringify(visibleA) !== JSON.stringify(visibleB)) {
        const interpolable = visibleA.every((p) => p.type === 'SOLID') && visibleB.every((p) => p.type === 'SOLID')
        out.push({ prop: 'background', from: visibleA, to: visibleB, interpolable, images: imagePaints(visibleB) })
      }
    }
  }

  if (a.strokes !== undefined && b.strokes !== undefined && a.strokes !== MIXED && b.strokes !== MIXED) {
    const singleA = singleSolidPaint(a.strokes, true)
    const singleB = singleSolidPaint(b.strokes, true)
    if (singleA && singleB && JSON.stringify(singleA) !== JSON.stringify(singleB)) {
      out.push({ prop: 'strokeColor', from: solidRgba(singleA), to: solidRgba(singleB) })
    }
  }
  if (
    a.strokeWeight !== undefined &&
    b.strokeWeight !== undefined &&
    a.strokeWeight !== MIXED &&
    b.strokeWeight !== MIXED &&
    neq(a.strokeWeight, b.strokeWeight)
  ) {
    out.push({ prop: 'strokeWeight', from: a.strokeWeight, to: b.strokeWeight })
  }

  const ra = cornerRadii(a)
  const rb = cornerRadii(b)
  if (ra && rb && ra.some((v, i) => neq(v, rb[i]))) {
    const aUniform = ra.every((v) => v === ra[0])
    const bUniform = rb.every((v) => v === rb[0])
    out.push(
      aUniform && bUniform ? { prop: 'cornerRadius', from: ra[0], to: rb[0] } : { prop: 'cornerRadii', from: ra, to: rb }
    )
  }

  if (a.effects !== undefined && b.effects !== undefined) {
    const shadowsA = shadowLayers(a)
    const shadowsB = shadowLayers(b)
    if (JSON.stringify(shadowsA) !== JSON.stringify(shadowsB)) out.push({ prop: 'boxShadow', from: shadowsA, to: shadowsB })

    const layerBlurA = blurRadii(a, 'LAYER_BLUR')
    const layerBlurB = blurRadii(b, 'LAYER_BLUR')
    if (JSON.stringify(layerBlurA) !== JSON.stringify(layerBlurB)) {
      out.push({ prop: 'layerBlur', from: layerBlurA, to: layerBlurB })
    }

    const bgBlurA = blurRadii(a, 'BACKGROUND_BLUR')
    const bgBlurB = blurRadii(b, 'BACKGROUND_BLUR')
    if (JSON.stringify(bgBlurA) !== JSON.stringify(bgBlurB)) {
      out.push({ prop: 'backgroundBlur', from: bgBlurA, to: bgBlurB })
    }
  }

  if (a.fontSize !== undefined && b.fontSize !== undefined && a.fontSize !== MIXED && b.fontSize !== MIXED && neq(a.fontSize, b.fontSize)) {
    out.push({ prop: 'fontSize', from: a.fontSize, to: b.fontSize })
  }
  if (
    a.fontWeight !== undefined &&
    b.fontWeight !== undefined &&
    a.fontWeight !== MIXED &&
    b.fontWeight !== MIXED &&
    neq(a.fontWeight, b.fontWeight)
  ) {
    out.push({ prop: 'fontWeight', from: a.fontWeight, to: b.fontWeight })
  }
  if (a.letterSpacing !== undefined && b.letterSpacing !== undefined && a.letterSpacing !== MIXED && b.letterSpacing !== MIXED) {
    const sameUnit = a.letterSpacing.unit === b.letterSpacing.unit
    if (!sameUnit || neq(a.letterSpacing.value, b.letterSpacing.value)) {
      out.push({ prop: 'letterSpacing', from: a.letterSpacing, to: b.letterSpacing })
    }
  }
  if (a.lineHeight !== undefined && b.lineHeight !== undefined && a.lineHeight !== MIXED && b.lineHeight !== MIXED) {
    const sameUnit = a.lineHeight.unit === b.lineHeight.unit
    // `AUTO` carries no `value` to compare — two `AUTO` line-heights are equal regardless of
    // whatever pixel value Figma happens to report alongside them.
    const changed = !sameUnit || (a.lineHeight.unit !== 'AUTO' && b.lineHeight.unit !== 'AUTO' && neq(a.lineHeight.value, b.lineHeight.value))
    if (changed) out.push({ prop: 'lineHeight', from: a.lineHeight, to: b.lineHeight })
  }

  if (
    a.paddingTop !== undefined &&
    b.paddingTop !== undefined &&
    a.paddingRight !== undefined &&
    b.paddingRight !== undefined &&
    a.paddingBottom !== undefined &&
    b.paddingBottom !== undefined &&
    a.paddingLeft !== undefined &&
    b.paddingLeft !== undefined
  ) {
    const pa: readonly [number, number, number, number] = [a.paddingTop, a.paddingRight, a.paddingBottom, a.paddingLeft]
    const pb: readonly [number, number, number, number] = [b.paddingTop, b.paddingRight, b.paddingBottom, b.paddingLeft]
    if (pa.some((v, i) => neq(v, pb[i]))) out.push({ prop: 'padding', from: pa, to: pb })
  }
  if (a.itemSpacing !== undefined && b.itemSpacing !== undefined && neq(a.itemSpacing, b.itemSpacing)) {
    out.push({ prop: 'gap', from: a.itemSpacing, to: b.itemSpacing })
  }
  // `counterAxisSpacing` is `null` when Figma has it synced to `itemSpacing` — never invented
  // here, exactly like a `MIXED` property, since resolving it would require reading a second
  // field this diff doesn't otherwise need.
  if (typeof a.counterAxisSpacing === 'number' && typeof b.counterAxisSpacing === 'number' && neq(a.counterAxisSpacing, b.counterAxisSpacing)) {
    out.push({ prop: 'crossGap', from: a.counterAxisSpacing, to: b.counterAxisSpacing })
  }

  return out
}

export interface StateDiff {
  readonly pairs: ReadonlyArray<{ readonly path: NodePath; readonly changes: readonly PropertyChange[] }>
  /** Present only in `base` (or type-mismatched) — fade out. */
  readonly fadeOut: readonly NodePath[]
  /** Present only in `target` (or type-mismatched) — fade in. */
  readonly fadeIn: readonly NodePath[]
}

/**
 * Matches layers between two states, then diffs every matched pair — the two roots included.
 * `matchLayers` indexes descendants only, so a state whose change lives on the trigger itself
 * (the button's own background, padding, stroke or radius — the most ordinary case there is)
 * produced an empty diff and no CSS at all. The root pair carries the empty path, which every
 * `pathToSelector` maps to the base selector.
 */
export function diffStates(base: DiffableNode, target: DiffableNode): StateDiff {
  const { matched, removed, added } = matchLayers(base, target)
  return {
    pairs: [{ path: '', a: base, b: target }, ...matched]
      .map(({ path, a, b }) => ({ path, changes: diffProperties(a, b) }))
      .filter((pair) => pair.changes.length > 0),
    fadeOut: removed.map((r) => r.path),
    fadeIn: added.map((r) => r.path),
  }
}
