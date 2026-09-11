/**
 * CSS emitter (T5.6, docs/research/05-smart-animate-css-diff.md §2.1/§2.2/§2.5): turns a
 * `StateDiff` into a base class + modifier rule with `transition` naming only the properties
 * that actually changed (never `transition: all` — see module doc §2.1 for why). Geometry goes
 * through the independent `translate`/`scale`/`rotate` transform properties (composited, no
 * reflow) rather than `left/top/width/height`. The modifier's selector/toggle mechanism comes
 * from `triggers.ts`'s `TriggerMechanism` — `css-pseudo-class` needs no JS at all, the rest emit
 * a matching class-toggle snippet.
 */

import type { DiffableLetterSpacing, DiffableLineHeight, DiffablePaint, DiffableTransform } from './types.ts'
import type { DiffableShadowLayer, PropertyChange, RGBA, StateDiff } from './diff-properties.ts'
import type { TriggerMechanism } from './triggers.ts'

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function rgbaToCss(color: RGBA): string {
  const to255 = (channel: number) => Math.round(channel * 255)
  return `rgba(${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)}, ${round(color.a, 4)})`
}

/** Figma's blend modes outnumber CSS `mix-blend-mode` keywords by a few (`PASS_THROUGH` has no
 * blending concept in CSS at all; the additive dodge/burn modes have no exact match). Falling
 * back to `normal` for anything unmapped beats emitting an invalid keyword the browser ignores
 * the whole declaration for. */
const BLEND_MODE_CSS: Record<string, string> = {
  PASS_THROUGH: 'normal',
  NORMAL: 'normal',
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  LINEAR_BURN: 'plus-darker',
  COLOR_BURN: 'color-burn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  LINEAR_DODGE: 'plus-lighter',
  COLOR_DODGE: 'color-dodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
}

/** Figma's `gradientTransform` maps gradient space (x-axis = the gradient's own direction) onto
 * node space; its first column `[a, c]` is that direction vector. CSS `linear-gradient(<angle>)`
 * measures clockwise from "pointing up" (`(0, -1)` in the same screen-space y-down coordinates),
 * so `atan2(dx, -dy)` — swapping in `-dy` for the math convention's `x` — lands exactly on that
 * definition: `(1, 0)` (pointing right) resolves to 90deg, `(0, 1)` (pointing down) to 180deg. */
function gradientAngleDeg(transform: DiffableTransform): number {
  const [[dx], [dy]] = transform
  const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI
  return ((degrees % 360) + 360) % 360
}

function colorStopsCss(paint: DiffablePaint): string {
  return (paint.gradientStops ?? []).map((stop) => `${rgbaToCss(stop.color)} ${round(stop.position * 100, 2)}%`).join(', ')
}

/** Builds the CSS `background-image` value for a gradient paint, or `undefined` if this layer
 * has nothing to render (no stops). `GRADIENT_DIAMOND` has no CSS primitive at all; `radial-
 * gradient` is the closest visual approximation and keeps the stop colors correct even though
 * the diamond shape is lost. */
function gradientCss(paint: DiffablePaint): string | undefined {
  if (!paint.gradientStops || paint.gradientStops.length === 0) return undefined
  const stops = colorStopsCss(paint)
  switch (paint.type) {
    case 'GRADIENT_LINEAR': {
      const angle = paint.gradientTransform ? gradientAngleDeg(paint.gradientTransform) : 180
      return `linear-gradient(${round(angle, 2)}deg, ${stops})`
    }
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_DIAMOND':
      return `radial-gradient(circle, ${stops})`
    case 'GRADIENT_ANGULAR': {
      const angle = paint.gradientTransform ? gradientAngleDeg(paint.gradientTransform) : 0
      return `conic-gradient(from ${round(angle, 2)}deg, ${stops})`
    }
    default:
      return undefined
  }
}

/** Figma `scaleMode` → CSS `background-size` for the cross-fade overlay's image layer. `TILE`
 * has nothing to scale to — the image repeats at its natural size, which CSS expresses as
 * `background-repeat: repeat` at `auto` size rather than by stretching it to fit the box. */
const SCALE_MODE_BACKGROUND_SIZE: Record<string, string> = {
  FILL: 'cover',
  FIT: 'contain',
  CROP: 'cover',
  TILE: 'auto',
}

/**
 * Builds the `::after` overlay pair a `background` change needs when its destination stack
 * carries a real photo: CSS can't interpolate `background-image` (§2.2), so the destination
 * image is pre-painted into a full-bleed overlay at `opacity: 0`, and the state rule simply
 * reveals it — turning an otherwise un-animatable swap into an ordinary opacity cross-fade.
 *
 * The overlay is positioned with `inset: 0`, which anchors to the nearest *positioned*
 * ancestor. For a node the structural CSS (the django target's own `css-emitter.ts`) already
 * made `position: relative`/`absolute` — any auto-layout frame, grid, or absolutely-positioned
 * child — that ancestor is this node itself, so the overlay lands correctly. A node the
 * structural CSS left `position: static` (a plain frame with no auto-layout and no absolute
 * children) has no positioning context of its own; the overlay then anchors to whichever
 * ancestor does. That's `inset`'s ordinary behavior, not something fixable from this layer,
 * which never sees the node's resolved `position`.
 *
 * Returns `undefined` when `imageUrlFor` is absent, the destination stack has no image paint,
 * a gradient on the same stack takes precedence (matching `buildDeclarations`'s own gradient-
 * over-image preference), or the resolver can't place this particular hash — the caller then
 * keeps today's "reported, not emitted" behaviour instead of writing a `url()` that 404s.
 */
function imageOverlayCss(
  change: Extract<PropertyChange, { prop: 'background' }>,
  restSelector: string,
  activeSelector: string,
  durationMs: number,
  timingFunction: string,
  imageUrlFor: ((imageHash: string) => string | undefined) | undefined
): { readonly restRule: string; readonly activeRule: string } | undefined {
  if (imageUrlFor === undefined) return undefined
  const images = change.images ?? []
  if (images.length === 0) return undefined
  const hasGradient = change.to.some((paint) => paint.visible !== false && paint.type.startsWith('GRADIENT'))
  if (hasGradient) return undefined
  // Topmost (last-painted, see `types.ts`'s `DiffablePaint` ordering note) image wins, the same
  // convention `topSolidColor` uses for solid stacks.
  const image = images[images.length - 1]
  const url = imageUrlFor(image.imageHash)
  if (url === undefined) return undefined
  const size = SCALE_MODE_BACKGROUND_SIZE[image.scaleMode ?? ''] ?? 'cover'
  const repeat = image.scaleMode === 'TILE' ? 'repeat' : 'no-repeat'
  const restRule = [
    `${restSelector}::after {`,
    '  content: "";',
    '  position: absolute;',
    '  inset: 0;',
    `  background-image: url(${url});`,
    `  background-size: ${size};`,
    '  background-position: center;',
    `  background-repeat: ${repeat};`,
    '  opacity: 0;',
    '  pointer-events: none;',
    `  transition: opacity ${durationMs}ms ${timingFunction};`,
    '}',
  ].join('\n')
  const activeRule = `${activeSelector}::after {\n  opacity: 1;\n}`
  return { restRule, activeRule }
}

/** The effective flat color of a solid-only paint stack — the last (topmost, see
 * `types.ts`'s `DiffablePaint` ordering note) visible SOLID paint wins, matching how a single
 * color reads on screen when nothing above it has been painted. */
function topSolidColor(paints: readonly DiffablePaint[]): RGBA {
  for (let i = paints.length - 1; i >= 0; i--) {
    const paint = paints[i]
    if (paint.type === 'SOLID' && paint.color) return { ...paint.color, a: paint.opacity ?? 1 }
  }
  return { r: 0, g: 0, b: 0, a: 0 }
}

function shadowCss(layer: DiffableShadowLayer): string {
  const inset = layer.type === 'INNER_SHADOW' ? 'inset ' : ''
  return `${inset}${round(layer.offsetX, 2)}px ${round(layer.offsetY, 2)}px ${round(layer.radius, 2)}px ${round(layer.spread, 2)}px ${rgbaToCss(layer.color)}`
}

function letterSpacingCss(letterSpacing: DiffableLetterSpacing): string {
  return `${round(letterSpacing.value, 2)}${letterSpacing.unit === 'PERCENT' ? '%' : 'px'}`
}

function lineHeightCss(lineHeight: DiffableLineHeight): string {
  if (lineHeight.unit === 'AUTO') return 'normal'
  return `${round(lineHeight.value, 2)}${lineHeight.unit === 'PERCENT' ? '%' : 'px'}`
}

interface PropertyDeclaration {
  readonly cssProperty: string
  readonly value: string
  /** Whether a browser can tween this declaration at all. `false` excludes it from the
   * `transition:` list built in `emitTransitionCss` — naming `background-image` or `mix-blend-
   * mode` there would be inert noise, since neither can be interpolated. */
  readonly interpolable: boolean
  /** CSS `transition-behavior` keyword to pair with this property in the `transition:` list,
   * even though `interpolable` is false — currently only `visibility`, which needs
   * `allow-discrete` so it participates in the fade instead of snapping away instantly. */
  readonly transitionBehavior?: string
}

/** Merges x/y into one `translate`, width/height into one `scale` — else the modifier rule's second axis clobbers the first. */
function buildDeclarations(changes: readonly PropertyChange[]): PropertyDeclaration[] {
  const decls: PropertyDeclaration[] = []
  let dx: number | null = null
  let dy: number | null = null
  let sx: number | null = null
  let sy: number | null = null

  for (const change of changes) {
    switch (change.prop) {
      case 'x':
        dx = change.to - change.from
        break
      case 'y':
        dy = change.to - change.from
        break
      case 'width':
        sx = change.from !== 0 ? change.to / change.from : 1
        break
      case 'height':
        sy = change.from !== 0 ? change.to / change.from : 1
        break
      case 'rotation':
        decls.push({ cssProperty: 'rotate', value: `${round(change.to - change.from, 2)}deg`, interpolable: true })
        break
      case 'opacity':
        decls.push({ cssProperty: 'opacity', value: `${round(change.to, 4)}`, interpolable: true })
        break
      case 'fillColor':
        decls.push({ cssProperty: 'background-color', value: rgbaToCss(change.to), interpolable: true })
        break
      case 'cornerRadius':
        decls.push({ cssProperty: 'border-radius', value: `${round(change.to, 2)}px`, interpolable: true })
        break
      case 'cornerRadii':
        decls.push({ cssProperty: 'border-radius', value: change.to.map((v) => `${round(v, 2)}px`).join(' '), interpolable: true })
        break
      case 'strokeColor':
        decls.push({ cssProperty: 'border-color', value: rgbaToCss(change.to), interpolable: true })
        break
      case 'strokeWeight':
        decls.push({ cssProperty: 'border-width', value: `${round(change.to, 2)}px`, interpolable: true })
        break
      case 'background':
        if (change.interpolable) {
          decls.push({ cssProperty: 'background-color', value: rgbaToCss(topSolidColor(change.to)), interpolable: true })
        } else {
          const gradient = change.to.find((paint) => paint.visible !== false && paint.type.startsWith('GRADIENT'))
          const image = gradient ? undefined : change.to.find((paint) => paint.visible !== false && paint.type === 'IMAGE')
          if (gradient) {
            const value = gradientCss(gradient)
            if (value !== undefined) decls.push({ cssProperty: 'background-image', value, interpolable: false })
          } else if (image) {
            // An IMAGE paint only carries `imageHash`, an internal Figma id — this layer has no
            // way to turn that into a fetchable URL, so the change is recognized but
            // deliberately left unexpressed rather than emit a `url()` that always 404s.
          }
        }
        break
      case 'boxShadow':
        decls.push({
          cssProperty: 'box-shadow',
          value: change.to.length > 0 ? change.to.map(shadowCss).join(', ') : 'none',
          interpolable: true,
        })
        break
      case 'layerBlur':
        decls.push({
          cssProperty: 'filter',
          value: change.to.length > 0 ? change.to.map((radius) => `blur(${round(radius, 2)}px)`).join(' ') : 'none',
          interpolable: true,
        })
        break
      case 'backgroundBlur':
        decls.push({
          cssProperty: 'backdrop-filter',
          value: change.to.length > 0 ? change.to.map((radius) => `blur(${round(radius, 2)}px)`).join(' ') : 'none',
          interpolable: true,
        })
        break
      case 'fontSize':
        decls.push({ cssProperty: 'font-size', value: `${round(change.to, 2)}px`, interpolable: true })
        break
      case 'fontWeight':
        decls.push({ cssProperty: 'font-weight', value: `${change.to}`, interpolable: true })
        break
      case 'letterSpacing':
        decls.push({ cssProperty: 'letter-spacing', value: letterSpacingCss(change.to), interpolable: true })
        break
      case 'lineHeight':
        decls.push({ cssProperty: 'line-height', value: lineHeightCss(change.to), interpolable: true })
        break
      case 'textColor':
        decls.push({ cssProperty: 'color', value: rgbaToCss(change.to), interpolable: true })
        break
      case 'padding':
        decls.push({ cssProperty: 'padding', value: change.to.map((v) => `${round(v, 2)}px`).join(' '), interpolable: true })
        break
      case 'gap':
        decls.push({ cssProperty: 'gap', value: `${round(change.to, 2)}px`, interpolable: true })
        break
      case 'crossGap':
        // `counterAxisSpacing` is the wrapped-track gap, perpendicular to `itemSpacing`'s main
        // axis. This diff doesn't carry `layoutMode`, so it can't know which physical CSS axis
        // that is; `row-gap` is the common case (a horizontal, wrapping auto-layout frame) and
        // leaves `column-gap` at whatever `gap` above already set from `itemSpacing`.
        decls.push({ cssProperty: 'row-gap', value: `${round(change.to, 2)}px`, interpolable: true })
        break
      case 'visible':
        decls.push({
          cssProperty: 'visibility',
          value: change.to ? 'visible' : 'hidden',
          interpolable: false,
          transitionBehavior: 'allow-discrete',
        })
        decls.push({ cssProperty: 'opacity', value: change.to ? '1' : '0', interpolable: true })
        // Without this, a hidden-but-still-`display`ed layer keeps intercepting clicks/hovers
        // underneath it for the whole fade — `pointer-events` flips the instant the class does.
        decls.push({ cssProperty: 'pointer-events', value: change.to ? 'auto' : 'none', interpolable: false })
        break
      case 'blendMode':
        decls.push({ cssProperty: 'mix-blend-mode', value: BLEND_MODE_CSS[change.to] ?? 'normal', interpolable: false })
        break
    }
  }

  if (dx !== null || dy !== null) {
    decls.unshift({ cssProperty: 'translate', value: `${round(dx ?? 0, 2)}px ${round(dy ?? 0, 2)}px`, interpolable: true })
  }
  if (sx !== null || sy !== null) {
    decls.unshift({ cssProperty: 'scale', value: `${round(sx ?? 1, 4)} ${round(sy ?? 1, 4)}`, interpolable: true })
  }

  return decls
}

function modifierSelector(baseSelector: string, mechanism: TriggerMechanism, toggleClass: string): string {
  return mechanism.kind === 'css-pseudo-class' ? `${baseSelector}:${mechanism.pseudoClass}` : `${baseSelector}.${toggleClass}`
}

function mechanismJs(baseSelector: string, mechanism: TriggerMechanism, toggleClass: string): string | undefined {
  const selectorJson = JSON.stringify(baseSelector)
  const classJson = JSON.stringify(toggleClass)
  switch (mechanism.kind) {
    case 'css-pseudo-class':
      return undefined
    case 'toggle-class':
      return `document.querySelectorAll(${selectorJson}).forEach((el) => {\n  el.addEventListener('click', () => el.classList.toggle(${classJson}))\n})`
    case 'timeout':
      return `document.querySelectorAll(${selectorJson}).forEach((el) => {\n  setTimeout(() => el.classList.add(${classJson}), ${mechanism.timeoutMs})\n})`
    case 'js-listener':
      return `document.querySelectorAll(${selectorJson}).forEach((el) => {\n  el.addEventListener(${JSON.stringify(mechanism.event)}, () => el.classList.toggle(${classJson}))\n})`
  }
}

export interface EmitTransitionCssInput {
  readonly baseSelector: string
  readonly diff: StateDiff
  /** Maps a matched/added/removed `NodePath` to the descendant-combinator suffix appended to the selector (e.g. ` .btn__badge`). */
  readonly pathToSelector: (path: string) => string
  readonly durationMs: number
  readonly timingFunction: string
  readonly mechanism: TriggerMechanism
  /** Class toggled by non-`css-pseudo-class` mechanisms. Defaults to `is-active`. */
  readonly toggleClass?: string
  /** Maps a Figma image hash to a URL the emitted CSS can reference. Absent, or returning
   * undefined, keeps the current behaviour: the image change is reported and not emitted. */
  readonly imageUrlFor?: (imageHash: string) => string | undefined
}

export interface EmitTransitionCssResult {
  readonly css: string
  /** `undefined` for `css-pseudo-class` mechanisms, which need no script. */
  readonly js?: string
}

/**
 * Emits one `transition:` rule per rest-state selector that receives a changed/fade
 * declaration, plus one modifier rule per changed/added/removed node. `transition` isn't
 * inherited, so a single rule scoped to `baseSelector` alone would leave every matched
 * descendant (`baseSelector + pathToSelector(path)`) and dissolve target un-transitioned —
 * each affected selector needs its own `transition` naming just the properties it changes.
 */
export function emitTransitionCss(input: EmitTransitionCssInput): EmitTransitionCssResult {
  const toggleClass = input.toggleClass ?? 'is-active'
  const modifier = modifierSelector(input.baseSelector, input.mechanism, toggleClass)
  const rules: string[] = []
  // selector -> (cssProperty -> transition-behavior, if any); properties are discovered by
  // walking `diff`, so the key set isn't known up front and insertion order must survive to
  // the emitted list.
  const transitionProps = new Map<string, Map<string, string | undefined>>()

  const trackTransition = (path: string, cssProperty: string, interpolable: boolean, transitionBehavior: string | undefined): void => {
    if (!interpolable && transitionBehavior === undefined) return
    const selector = `${input.baseSelector}${input.pathToSelector(path)}`
    const props = transitionProps.get(selector) ?? new Map<string, string | undefined>()
    props.set(cssProperty, transitionBehavior)
    transitionProps.set(selector, props)
  }

  for (const pair of input.diff.pairs) {
    const decls = buildDeclarations(pair.changes)
    const suffix = input.pathToSelector(pair.path)
    const backgroundChange = pair.changes.find(
      (c): c is Extract<PropertyChange, { prop: 'background' }> => c.prop === 'background' && !c.interpolable
    )
    const overlay = backgroundChange
      ? imageOverlayCss(
          backgroundChange,
          `${input.baseSelector}${suffix}`,
          `${modifier}${suffix}`,
          input.durationMs,
          input.timingFunction,
          input.imageUrlFor
        )
      : undefined
    if (decls.length === 0 && overlay === undefined) continue
    if (decls.length > 0) {
      decls.forEach((d) => trackTransition(pair.path, d.cssProperty, d.interpolable, d.transitionBehavior))
      rules.push(`${modifier}${suffix} {\n${decls.map((d) => `  ${d.cssProperty}: ${d.value};`).join('\n')}\n}`)
    }
    if (overlay !== undefined) {
      // The overlay carries its own `transition:` declaration inline (see `imageOverlayCss`) —
      // it must NOT join `transitionProps`, or the host element's own `transition:` list would
      // end up naming `opacity` twice for two different rules.
      rules.push(overlay.restRule)
      rules.push(overlay.activeRule)
    }
  }

  for (const path of input.diff.fadeIn) {
    trackTransition(path, 'opacity', true, undefined)
    const suffix = input.pathToSelector(path)
    rules.push(`${input.baseSelector}${suffix} { opacity: 0; }`)
    rules.push(`${modifier}${suffix} { opacity: 1; }`)
  }
  for (const path of input.diff.fadeOut) {
    trackTransition(path, 'opacity', true, undefined)
    rules.push(`${modifier}${input.pathToSelector(path)} { opacity: 0; }`)
  }

  const transitionRules = [...transitionProps.entries()].map(([selector, props]) => {
    const transitionList = [...props.entries()].map(
      ([prop, behavior]) => `${prop} ${input.durationMs}ms ${input.timingFunction}${behavior ? ` ${behavior}` : ''}`
    )
    return `${selector} {\n  transition:\n    ${transitionList.join(',\n    ')};\n}`
  })

  return { css: [...transitionRules, ...rules].join('\n\n'), js: mechanismJs(input.baseSelector, input.mechanism, toggleClass) }
}
