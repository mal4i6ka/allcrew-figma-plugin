/**
 * GSAP emitter (T5.5, docs/research/06-motion-to-gsap-tokens.md §2): turns a Motion
 * timeline — one or more nodes with their T5.2 `MotionTrack`s — into a standalone
 * `gsap.timeline({paused: true})` script: one `fromTo` tween with percent-based
 * `keyframes` per track (all added at absolute position 0, per §2.1), easing resolved
 * through T5.1's shared easing module (`CustomEase` for bezier curves, `back.out()` for
 * low-bounce springs, a sampled `registerEase` curve otherwise). Nodes are addressed via
 * `data-node-id`; the emitted script starts the timeline on first intersection
 * (DOMContentLoaded + IntersectionObserver, §2.5) — the only trigger this task covers.
 */

import { BEZIER_PRESETS, perceptualAngularFrequency, resolveSpringBounce, sampleSpring } from '../easing/index.ts'
import type { MotionTrack } from './types.ts'

export type GsapPluginName = 'CustomEase' | 'DrawSVGPlugin' | 'TextPlugin'

export interface GsapTimelineNode {
  readonly nodeId: string
  /** Optional production selector. Preview keeps using data-node-id; Django export uses node classes. */
  readonly selector?: string
  readonly tracks: readonly MotionTrack[]
}

export interface GsapTimelineInput {
  readonly timelineId: string
  /** Timeline duration in seconds (`Timeline.duration`) — the denominator for every percent keyframe. */
  readonly duration: number
  readonly nodes: readonly GsapTimelineNode[]
}

export interface GsapEmitResult {
  readonly js: string
  readonly usedPlugins: readonly GsapPluginName[]
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

export const NODE_ID_ATTRIBUTE = 'data-node-id'

function nodeSelector(nodeId: string): string {
  return `[${NODE_ID_ATTRIBUTE}="${nodeId}"]`
}

/** Springs at or below this bounce settle close enough to a single overshoot for `back.out()` (§2.4). */
const SPRING_BACK_BOUNCE_THRESHOLD = 0.25

/** `TRANSLATION_X/Y`, `ROTATION`, ... → single GSAP tween property (§2.2). */
const SCALAR_PROPERTY_MAP: Partial<Record<KeyframePropertyFieldName, string>> = {
  TRANSLATION_X: 'x',
  TRANSLATION_Y: 'y',
  ROTATION: 'rotation',
  SCALE_X: 'scaleX',
  SCALE_Y: 'scaleY',
  OPACITY: 'opacity',
  WIDTH: 'width',
  HEIGHT: 'height',
  CORNER_RADIUS: 'borderRadius',
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: 'borderTopLeftRadius',
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: 'borderTopRightRadius',
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: 'borderBottomLeftRadius',
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: 'borderBottomRightRadius',
  STROKE_WEIGHT: 'borderWidth',
  BORDER_TOP_WEIGHT: 'borderTopWidth',
  BORDER_BOTTOM_WEIGHT: 'borderBottomWidth',
  BORDER_LEFT_WEIGHT: 'borderLeftWidth',
  BORDER_RIGHT_WEIGHT: 'borderRightWidth',
  // Figma doesn't expose the stack's axis direction on the track itself (§2.2) — spacing maps
  // to the main-axis gap, counter-spacing to the cross-axis one; ambiguous for wrapping stacks.
  STACK_SPACING: 'columnGap',
  STACK_COUNTER_SPACING: 'rowGap',
  STACK_PADDING_LEFT: 'paddingLeft',
  STACK_PADDING_TOP: 'paddingTop',
  STACK_PADDING_RIGHT: 'paddingRight',
  STACK_PADDING_BOTTOM: 'paddingBottom',
  GRID_ROW_GAP: 'rowGap',
  GRID_COLUMN_GAP: 'columnGap',
}

/** `TRANSLATION_XY`/`SCALE_XY` (VECTOR value) → two GSAP properties in the same keyframe. */
const VECTOR_PROPERTY_MAP: Partial<Record<KeyframePropertyFieldName, readonly [string, string]>> = {
  TRANSLATION_XY: ['x', 'y'],
  SCALE_XY: ['scaleX', 'scaleY'],
}

function gsapKeysForField(field: KeyframePropertyFieldName): readonly string[] | undefined {
  const vector = VECTOR_PROPERTY_MAP[field]
  if (vector) return vector
  const scalar = SCALAR_PROPERTY_MAP[field]
  return scalar ? [scalar] : undefined
}

function requireFloat(value: KeyframeValue, context: string): number {
  if (value.type !== 'FLOAT') throw new Error(`Expected FLOAT value for ${context}, got ${value.type}`)
  return value.value
}

function requireVector(value: KeyframeValue, context: string): Vector {
  if (value.type !== 'VECTOR') throw new Error(`Expected VECTOR value for ${context}, got ${value.type}`)
  return value.value
}

function requireTextData(value: KeyframeValue, context: string): string {
  if (value.type !== 'TEXT_DATA') throw new Error(`Expected TEXT_DATA value for ${context}, got ${value.type}`)
  return value.value
}

/** Registers one `CustomEase.create`/`gsap.registerEase` statement per distinct curve, dedup'd by value. */
class EaseRegistry {
  private readonly namesByKey = new Map<string, string>()
  private nextIndex = 0
  usesSampledSpring = false
  readonly bezierStatements: string[] = []
  readonly springStatements: string[] = []

  private allocateName(prefix: string): string {
    return `figma${prefix}${this.nextIndex++}`
  }

  bezier(bezier: EasingFunctionBezier): string {
    const key = `bezier:${bezier.x1},${bezier.y1},${bezier.x2},${bezier.y2}`
    const existing = this.namesByKey.get(key)
    if (existing) return existing

    const name = this.allocateName('Ease')
    this.namesByKey.set(key, name)
    this.bezierStatements.push(`    CustomEase.create(${JSON.stringify(name)}, "${bezier.x1}, ${bezier.y1}, ${bezier.x2}, ${bezier.y2}");`)
    return name
  }

  sampledSpring(points: readonly number[]): string {
    const rounded = points.map((point) => round(point, 4))
    const key = `spring:${rounded.join(',')}`
    const existing = this.namesByKey.get(key)
    if (existing) return existing

    const name = this.allocateName('Spring')
    this.namesByKey.set(key, name)
    this.usesSampledSpring = true
    this.springStatements.push(`    gsap.registerEase(${JSON.stringify(name)}, __figmaLerpEase([${rounded.join(', ')}]));`)
    return name
  }
}

/**
 * Figma `MotionEasing` → GSAP ease (§2.3-2.4). `VARIABLE_ALIAS` easing can't be resolved
 * statically (no build-time value) and falls back to `"none"`, same treatment T5.3's
 * `pickBackend` gives it.
 */
function resolveEase(
  easing: MotionEasing | VariableAlias,
  registry: EaseRegistry,
  plugins: Set<GsapPluginName>,
  /** Length of the keyframe segment this ease covers, in seconds. A GSAP ease is normalized over
   * that segment, so the spring must be solved at the segment's own period — otherwise a short
   * segment gets a curve shaped for a much slower spring, squeezed. */
  segmentSec: number
): string {
  if (easing.type === 'VARIABLE_ALIAS') return 'none'
  if (easing.type === 'LINEAR' || easing.type === 'HOLD') return 'none'

  if (easing.type === 'CUSTOM_CUBIC_BEZIER') {
    if (!easing.easingFunctionCubicBezier) {
      throw new Error('CUSTOM_CUBIC_BEZIER easing is missing easingFunctionCubicBezier')
    }
    plugins.add('CustomEase')
    return registry.bezier(easing.easingFunctionCubicBezier)
  }

  if (
    easing.type === 'GENTLE' ||
    easing.type === 'QUICK' ||
    easing.type === 'BOUNCY' ||
    easing.type === 'SLOW' ||
    easing.type === 'CUSTOM_SPRING'
  ) {
    const bounce = resolveSpringBounce(easing)
    if (bounce <= SPRING_BACK_BOUNCE_THRESHOLD) {
      return `back.out(${round(1 + 2.5 * bounce, 3)})`
    }
    return registry.sampledSpring(sampleSpring(bounce, perceptualAngularFrequency(segmentSec)).points)
  }

  // Remaining named presets (EASE_IN, EASE_OUT_BACK, ...): Figma gives exact control points
  // for these too — CustomEase reproduces them precisely instead of approximating with `power*`/`back`.
  plugins.add('CustomEase')
  return registry.bezier(BEZIER_PRESETS[easing.type])
}

function formatPercentLabel(percent: number): string {
  return `${round(percent, 3)}%`
}

interface TweenVars {
  readonly fromVars: Record<string, unknown>
  readonly keyframes: Record<string, unknown>
}

/**
 * Ensures the keyframes object reaches `100%` — GSAP's percent-keyframes stop changing once
 * the last entry is passed, but the tween must still span the *timeline's* full duration so
 * every node's tracks stay in sync (§2.7's own generated example duplicates the last value at
 * `100%` for exactly this reason).
 */
function ensureTerminalKeyframe(keyframes: Record<string, unknown>, lastPercent: number, lastVars: Record<string, unknown>): void {
  if (lastPercent < 100 - 1e-6) {
    keyframes['100%'] = { ...lastVars, ease: 'none' }
  }
}

function trackValueVars(value: KeyframeValue, gsapKeys: readonly string[], context: string): Record<string, number> {
  if (gsapKeys.length === 2) {
    const vector = requireVector(value, context)
    return { [gsapKeys[0]]: vector.x, [gsapKeys[1]]: vector.y }
  }
  return { [gsapKeys[0]]: requireFloat(value, context) }
}

/**
 * One scalar/vector `KeyframeField` track → one tween's `fromVars`/`keyframes` (§2.1-2.2).
 * `baseValue` becomes the `fromTo` "from" (Figma holds it until the first keyframe); any
 * keyframe at `timelinePosition === 0` is skipped since `fromVars` already covers it.
 */
function buildPropertyTween(
  track: MotionTrack,
  gsapKeys: readonly string[],
  timelineDuration: number,
  registry: EaseRegistry,
  plugins: Set<GsapPluginName>
): TweenVars {
  const fromVars = trackValueVars(track.baseValue, gsapKeys, `${track.field} baseValue`)
  const sorted = [...track.keyframes].sort((a, b) => a.timelinePosition - b.timelinePosition)

  const keyframes: Record<string, unknown> = {}
  let lastVars: Record<string, unknown> = fromVars
  let lastPercent = 0
  let lastPositionSec = 0

  for (const keyframe of sorted) {
    const vars = trackValueVars(keyframe.value, gsapKeys, `${track.field} keyframe ${keyframe.id}`)
    lastVars = vars
    if (keyframe.timelinePosition <= 0) {
      lastPercent = 0
      continue
    }
    const percent = (keyframe.timelinePosition / timelineDuration) * 100
    const ease = resolveEase(keyframe.easing, registry, plugins, keyframe.timelinePosition - lastPositionSec)
    keyframes[formatPercentLabel(percent)] = { ...vars, ease }
    lastPercent = percent
    lastPositionSec = keyframe.timelinePosition
  }

  ensureTerminalKeyframe(keyframes, lastPercent, lastVars)
  return { fromVars, keyframes }
}

/** `TEXT_DATA` track → TextPlugin (`text: { value }`); no interpolation, just per-keyframe strings. */
function buildTextTween(track: MotionTrack, timelineDuration: number, registry: EaseRegistry, plugins: Set<GsapPluginName>): TweenVars {
  plugins.add('TextPlugin')

  const baseText = requireTextData(track.baseValue, `${track.field} baseValue`)
  const fromVars = { text: { value: baseText } }
  const sorted = [...track.keyframes].sort((a, b) => a.timelinePosition - b.timelinePosition)

  const keyframes: Record<string, unknown> = {}
  let lastVars: Record<string, unknown> = fromVars
  let lastPercent = 0
  let lastPositionSec = 0

  for (const keyframe of sorted) {
    const text = requireTextData(keyframe.value, `${track.field} keyframe ${keyframe.id}`)
    const vars = { text: { value: text } }
    lastVars = vars
    if (keyframe.timelinePosition <= 0) {
      lastPercent = 0
      continue
    }
    const percent = (keyframe.timelinePosition / timelineDuration) * 100
    const ease = resolveEase(keyframe.easing, registry, plugins, keyframe.timelinePosition - lastPositionSec)
    keyframes[formatPercentLabel(percent)] = { ...vars, ease }
    lastPercent = percent
    lastPositionSec = keyframe.timelinePosition
  }

  ensureTerminalKeyframe(keyframes, lastPercent, lastVars)
  return { fromVars, keyframes }
}

function valueAtOrBefore(track: MotionTrack | undefined, position: number, fallback: number): { value: number; easing?: MotionEasing | VariableAlias } {
  if (!track) return { value: fallback }

  let value = requireFloat(track.baseValue, `${track.field} baseValue`)
  let easing: MotionEasing | VariableAlias | undefined
  for (const keyframe of [...track.keyframes].sort((a, b) => a.timelinePosition - b.timelinePosition)) {
    if (keyframe.timelinePosition > position) break
    value = requireFloat(keyframe.value, `${track.field} keyframe ${keyframe.id}`)
    if (keyframe.timelinePosition === position) easing = keyframe.easing
  }
  return { value, easing }
}

/**
 * `PATH_TRIM_START` + `PATH_TRIM_END` → one DrawSVGPlugin tween (`drawSVG: "start% end%"`,
 * §2.2/2.6) — CSS can only animate one dash-offset torch, so a paired trim always forces GSAP.
 * The two Figma tracks can carry independent keyframe grids; positions are merged and each
 * track contributes a step-held value at positions where only the other track has a keyframe.
 */
function buildDrawSvgTween(
  startTrack: MotionTrack | undefined,
  endTrack: MotionTrack | undefined,
  timelineDuration: number,
  registry: EaseRegistry,
  plugins: Set<GsapPluginName>
): TweenVars {
  plugins.add('DrawSVGPlugin')

  const startBase = startTrack ? requireFloat(startTrack.baseValue, 'PATH_TRIM_START baseValue') : 0
  const endBase = endTrack ? requireFloat(endTrack.baseValue, 'PATH_TRIM_END baseValue') : 1
  const drawSvgLabel = (start: number, end: number) => `${round(start * 100, 3)}% ${round(end * 100, 3)}%`

  const positions = new Set<number>()
  for (const keyframe of startTrack?.keyframes ?? []) positions.add(keyframe.timelinePosition)
  for (const keyframe of endTrack?.keyframes ?? []) positions.add(keyframe.timelinePosition)

  const fromVars = { drawSVG: drawSvgLabel(startBase, endBase) }
  const keyframes: Record<string, unknown> = {}
  let lastVars: Record<string, unknown> = fromVars
  let lastPercent = 0
  let lastPositionSec = 0

  for (const position of [...positions].sort((a, b) => a - b)) {
    if (position <= 0) continue

    const start = valueAtOrBefore(startTrack, position, startBase)
    const end = valueAtOrBefore(endTrack, position, endBase)
    const easing = start.easing ?? end.easing ?? { type: 'LINEAR' as const }
    const ease = resolveEase(easing, registry, plugins, position - lastPositionSec)
    const vars = { drawSVG: drawSvgLabel(start.value, end.value) }

    const percent = (position / timelineDuration) * 100
    keyframes[formatPercentLabel(percent)] = { ...vars, ease }
    lastVars = vars
    lastPercent = percent
    lastPositionSec = position
  }

  ensureTerminalKeyframe(keyframes, lastPercent, lastVars)
  return { fromVars, keyframes }
}

function renderTween(selector: string, duration: number, { fromVars, keyframes }: TweenVars): string {
  return `      tl.fromTo(q(${JSON.stringify(selector)}), ${JSON.stringify(fromVars)}, { duration: ${round(duration, 4)}, keyframes: ${JSON.stringify(keyframes)} }, 0);`
}

const LERP_EASE_HELPER = `    function __figmaLerpEase(points) {
      return function (p) {
        var scaled = Math.max(0, Math.min(1, p)) * (points.length - 1);
        var index = Math.floor(scaled);
        if (index >= points.length - 1) return points[points.length - 1];
        var fraction = scaled - index;
        return points[index] + (points[index + 1] - points[index]) * fraction;
      };
    }`

const PLUGIN_GLOBAL_BY_NAME: Record<GsapPluginName, string> = {
  CustomEase: 'CustomEase',
  DrawSVGPlugin: 'DrawSVGPlugin',
  TextPlugin: 'TextPlugin',
}

function renderScript(timelineId: string, registry: EaseRegistry, plugins: Set<GsapPluginName>, tweenStatements: readonly string[]): string {
  const pluginNames = [...plugins]
  const registerPlugin = pluginNames.length > 0 ? `    gsap.registerPlugin(${pluginNames.map((name) => PLUGIN_GLOBAL_BY_NAME[name]).join(', ')});\n\n` : ''
  const easeSetup = [...registry.bezierStatements, ...(registry.usesSampledSpring ? [LERP_EASE_HELPER] : []), ...registry.springStatements].join('\n')

  return `(function () {
  function init() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

${registerPlugin}${easeSetup ? easeSetup + '\n\n' : ''}    var build = function (root) {
      var q = gsap.utils.selector(root);
      var tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
${tweenStatements.join('\n')}
      return tl;
    };

    var roots = document.querySelectorAll('[data-timeline="${timelineId}"]');
    (roots.length ? Array.prototype.slice.call(roots) : [document.documentElement]).forEach(function (root) {
      var tl = build(root);
      new IntersectionObserver(function (entries, io) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            tl.play();
            io.disconnect();
          }
        });
      }, { threshold: 0.3 }).observe(root);
    });
  }
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
    : init();
})();
`
}

/** Emits one Motion timeline as a standalone GSAP animation script (see module doc). */
export function emitGsapTimeline(input: GsapTimelineInput): GsapEmitResult {
  const registry = new EaseRegistry()
  const plugins = new Set<GsapPluginName>()
  const tweenStatements: string[] = []

  for (const node of input.nodes) {
    const selector = node.selector ?? nodeSelector(node.nodeId)
    const pathTrimStart = node.tracks.find((track) => track.field === 'PATH_TRIM_START')
    const pathTrimEnd = node.tracks.find((track) => track.field === 'PATH_TRIM_END')

    if (pathTrimStart || pathTrimEnd) {
      tweenStatements.push(renderTween(selector, input.duration, buildDrawSvgTween(pathTrimStart, pathTrimEnd, input.duration, registry, plugins)))
    }

    for (const track of node.tracks) {
      if (track.field === 'PATH_TRIM_START' || track.field === 'PATH_TRIM_END') continue

      if (track.baseValue.type === 'TEXT_DATA') {
        tweenStatements.push(renderTween(selector, input.duration, buildTextTween(track, input.duration, registry, plugins)))
        continue
      }

      const gsapKeys = gsapKeysForField(track.field)
      if (!gsapKeys) {
        console.warn('[gsap-emitter] unsupported KeyframeField, skipping:', track.field)
        continue
      }

      tweenStatements.push(renderTween(selector, input.duration, buildPropertyTween(track, gsapKeys, input.duration, registry, plugins)))
    }
  }

  return { js: renderScript(input.timelineId, registry, plugins, tweenStatements), usedPlugins: [...plugins] }
}
