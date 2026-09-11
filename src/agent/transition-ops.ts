/**
 * Agent listener — prototype transitions.
 *
 * `smart-animate/` has been finished and tested for a while and has never had a caller: only
 * `matchLayers` is used anywhere, by the breakpoint matcher, and the rest of the path — diff
 * two states, map the trigger to a mechanism, convert the easing, emit the CSS — has been
 * sitting complete and unreachable. This is its first consumer.
 *
 * The diff module is deliberately free of `@figma/plugin-typings` so its algorithm stays
 * testable against plain fixtures, which is why the SceneNode → DiffableNode adapter lives
 * here rather than beside it. Translating `figma.mixed` is the whole job of that boundary, and
 * the module's own docs say the caller owns it.
 */

import {
  diffStates,
  emitFlipToggle,
  emitTransitionCss,
  emitViewTransition,
  extractSmartAnimatePairs,
  mapTriggerToMechanism,
  namesForPaths,
  transitionToCssTiming,
  MIXED,
  type DiffableEffect,
  type DiffableLetterSpacing,
  type DiffableLineHeight,
  type DiffableNode,
  type DiffablePaint,
  type StateDiff,
} from '../targets/django/smart-animate/index.ts'
import { binaryFile, slugify, textFile, type FileEnvelope } from './files.ts'
import { detectImageFillFormat } from '../targets/django/assets.ts'
import type { OpDef } from './protocol.ts'

/* ------------------------------------------------------------------ adapter */

/** `figma.mixed` is a sentinel object; the diff module uses its own symbol so it never has to
 * import the plugin typings. This is the only place the two meet. */
function orMixed<T>(value: T | typeof figma.mixed): T | typeof MIXED {
  return value === figma.mixed ? MIXED : (value as T)
}

function isGradientPaint(paint: Paint): paint is GradientPaint {
  return (
    paint.type === 'GRADIENT_LINEAR' ||
    paint.type === 'GRADIENT_RADIAL' ||
    paint.type === 'GRADIENT_ANGULAR' ||
    paint.type === 'GRADIENT_DIAMOND'
  )
}

/** Shared by `fills` and `strokes` — both are a `Paint[] | figma.mixed`, and the diff needs the
 * same paint fields (color, gradient, image) off either. */
function paintList(raw: unknown): readonly DiffablePaint[] | typeof MIXED | undefined {
  if (raw === undefined) return undefined
  if (raw === figma.mixed) return MIXED
  if (!Array.isArray(raw)) return undefined
  const rawPaints = raw as Paint[] // trusted Figma plugin API value, not external input
  return rawPaints.map((paint) => ({
    type: paint.type,
    color: paint.type === 'SOLID' ? paint.color : undefined,
    opacity: paint.opacity,
    visible: paint.visible,
    blendMode: paint.blendMode,
    gradientStops: isGradientPaint(paint) ? paint.gradientStops.map((stop) => ({ position: stop.position, color: stop.color })) : undefined,
    gradientTransform: isGradientPaint(paint) ? paint.gradientTransform : undefined,
    imageHash: paint.type === 'IMAGE' ? paint.imageHash : undefined,
    scaleMode: paint.type === 'IMAGE' ? paint.scaleMode : undefined,
  }))
}

function isShadowEffect(effect: Effect): effect is DropShadowEffect | InnerShadowEffect {
  return effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW'
}

function isBlurEffect(effect: Effect): effect is BlurEffect {
  return effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR'
}

/** Reads only the shadow/blur fields `diff-properties.ts` composes into `box-shadow`/`filter`/
 * `backdrop-filter` — the other effect kinds (noise, texture, glass, shader) aren't part of
 * this diff yet, so they're carried through with `radius: 0` rather than dropped, keeping the
 * array's length (and thus "did the effect stack change at all") accurate. */
function effectsList(raw: unknown): readonly DiffableEffect[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return undefined
  const rawEffects = raw as Effect[] // trusted Figma plugin API value, not external input
  return rawEffects.map((effect) => {
    if (isShadowEffect(effect)) {
      return { type: effect.type, color: effect.color, offset: effect.offset, radius: effect.radius, spread: effect.spread, visible: effect.visible }
    }
    if (isBlurEffect(effect)) {
      return { type: effect.type, radius: effect.radius, visible: effect.visible }
    }
    return { type: effect.type, radius: 0, visible: effect.visible }
  })
}

/** `letterSpacing`/`lineHeight` are read off the same `fields` bag `toDiffable` builds — kept
 * out of that function only because each needs its own `figma.mixed` check before the cast. */
function letterSpacingOf(fields: Record<string, unknown>): DiffableLetterSpacing | typeof MIXED | undefined {
  if (fields.letterSpacing === undefined) return undefined
  return orMixed(fields.letterSpacing as LetterSpacing) // trusted Figma plugin API value, not external input
}

function lineHeightOf(fields: Record<string, unknown>): DiffableLineHeight | typeof MIXED | undefined {
  if (fields.lineHeight === undefined) return undefined
  return orMixed(fields.lineHeight as LineHeight) // trusted Figma plugin API value, not external input
}

/** Reads every field the diff looks at — geometry, radii, opacity, fills/strokes, effects,
 * auto-layout spacing, text style, visibility, blend mode, and children. Guards every access
 * the same way: a field absent on this node's concrete type reads as `undefined`, never a
 * fabricated default the diff could mistake for a real (non-)change. */
function toDiffable(node: SceneNode): DiffableNode {
  const fields = node as unknown as Record<string, unknown>
  const children = (node as unknown as { children?: readonly SceneNode[] }).children
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: typeof fields.rotation === 'number' ? fields.rotation : undefined,
    opacity: typeof fields.opacity === 'number' ? fields.opacity : undefined,
    visible: typeof fields.visible === 'boolean' ? fields.visible : undefined,
    blendMode: typeof fields.blendMode === 'string' ? fields.blendMode : undefined,
    cornerRadius: fields.cornerRadius === undefined ? undefined : orMixed(fields.cornerRadius as number),
    topLeftRadius: typeof fields.topLeftRadius === 'number' ? fields.topLeftRadius : undefined,
    topRightRadius: typeof fields.topRightRadius === 'number' ? fields.topRightRadius : undefined,
    bottomRightRadius: typeof fields.bottomRightRadius === 'number' ? fields.bottomRightRadius : undefined,
    bottomLeftRadius: typeof fields.bottomLeftRadius === 'number' ? fields.bottomLeftRadius : undefined,
    fills: paintList(fields.fills),
    strokes: paintList(fields.strokes),
    strokeWeight: fields.strokeWeight === undefined ? undefined : orMixed(fields.strokeWeight as number),
    strokeAlign: typeof fields.strokeAlign === 'string' ? fields.strokeAlign : undefined,
    effects: effectsList(fields.effects),
    paddingTop: typeof fields.paddingTop === 'number' ? fields.paddingTop : undefined,
    paddingRight: typeof fields.paddingRight === 'number' ? fields.paddingRight : undefined,
    paddingBottom: typeof fields.paddingBottom === 'number' ? fields.paddingBottom : undefined,
    paddingLeft: typeof fields.paddingLeft === 'number' ? fields.paddingLeft : undefined,
    itemSpacing: typeof fields.itemSpacing === 'number' ? fields.itemSpacing : undefined,
    counterAxisSpacing:
      fields.counterAxisSpacing === null ? null : typeof fields.counterAxisSpacing === 'number' ? fields.counterAxisSpacing : undefined,
    fontSize: fields.fontSize === undefined ? undefined : orMixed(fields.fontSize as number),
    fontWeight: fields.fontWeight === undefined ? undefined : orMixed(fields.fontWeight as number),
    letterSpacing: letterSpacingOf(fields),
    lineHeight: lineHeightOf(fields),
    characters: typeof fields.characters === 'string' ? fields.characters : undefined,
    children: children ? children.map(toDiffable) : undefined,
  }
}

/* ------------------------------------------------------------------ summary */

/** What actually moves between two states, in words rather than coordinates. */
export function describeDiff(diff: StateDiff): { moved: number; fadeIn: number; fadeOut: number; properties: string[] } {
  const properties = new Set<string>()
  for (const pair of diff.pairs) for (const change of pair.changes) properties.add(change.prop)
  return {
    moved: diff.pairs.filter((pair) => pair.changes.length > 0).length,
    fadeIn: diff.fadeIn.length,
    fadeOut: diff.fadeOut.length,
    properties: [...properties].sort(),
  }
}

/** A matched path becomes a descendant selector. Paths are `name#dup` joined by `/`. */
export function pathToSelector(path: string): string {
  if (path === '') return ''
  return path
    .split('/')
    .map((segment) => ` .${slugify(segment.replace(/#\d+$/, ''), 'layer')}`)
    .join('')
}

/* ------------------------------------------------------------ image crossfade */

/** Every distinct image hash a set of diffs' non-interpolable `background` changes reference —
 * deduplicated so a photo shared by two variant pairs is fetched once. */
function imageHashesIn(diffs: readonly StateDiff[]): readonly string[] {
  const hashes = new Set<string>()
  for (const diff of diffs) {
    for (const pair of diff.pairs) {
      for (const change of pair.changes) {
        if (change.prop !== 'background' || change.interpolable) continue
        for (const image of change.images ?? []) hashes.add(image.imageHash)
      }
    }
  }
  return [...hashes]
}

/** A read that never comes back is worse than one that says it failed — the same race
 * `context-ops.ts`'s `image.fills` op runs, reused verbatim so a hash `getBytesAsync` hangs on
 * degrades this transition to "no cross-fade for that image" instead of hanging the whole op. */
function deadline<T>(work: Promise<T>, what: string, ms = 20000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Fetches the original bytes behind every image hash a batch of transitions' `background`
 * changes reference, and hands back a resolver `emitTransitionCss`'s `imageUrlFor` can call
 * directly, plus the binary files the bridge needs to write next to the generated CSS/JS. A
 * hash whose bytes never arrive (`deadline` above) — or that no longer resolves to an image at
 * all — is left out of the resolver: the emitter then falls back to its "reported, not
 * emitted" behaviour for that one swap instead of writing a `url()` that always 404s, and the
 * miss is surfaced as a warning rather than dropped silently.
 */
async function resolveImageUrls(
  root: BaseNode,
  diffs: readonly StateDiff[],
  slug: string
): Promise<{ readonly urlFor: (imageHash: string) => string | undefined; readonly files: FileEnvelope[]; readonly warnings: string[] }> {
  const hashes = imageHashesIn(diffs)
  const urls = new Map<string, string>()
  const files: FileEnvelope[] = []
  const warnings: string[] = []
  if (hashes.length === 0) return { urlFor: () => undefined, files, warnings }

  // Image data belongs to a loaded page — with dynamic page loading, an image on a page the
  // designer hasn't opened is a promise that never settles. Load it first, same as `image.fills`.
  let page: BaseNode | null = root
  while (page && page.type !== 'PAGE') page = page.parent
  if (page) await (page as PageNode).loadAsync()

  for (const hash of hashes) {
    const image = figma.getImageByHash(hash)
    if (!image) {
      warnings.push(`image crossfade skipped: no image for hash ${hash}`)
      continue
    }
    let bytes: Uint8Array
    try {
      bytes = await deadline(image.getBytesAsync(), `getBytesAsync ${hash}`, 60000)
    } catch (error) {
      warnings.push(`image crossfade skipped for hash ${hash}: ${String(error)}`)
      continue
    }
    const format = detectImageFillFormat(bytes)
    const filename = `${slug}-${hash.slice(0, 8)}.${format}`
    files.push(binaryFile(filename, format === 'jpg' ? 'image/jpeg' : `image/${format}`, bytes))
    urls.set(hash, filename)
  }

  return { urlFor: (imageHash) => urls.get(imageHash), files, warnings }
}

/* --------------------------------------------------------------------- ops */

export const TRANSITION_OPS: readonly OpDef[] = [
  {
    name: 'transition.context',
    summary: 'Smart Animate between variants, as CSS transitions, a FLIP toggle or View Transitions.',
    mutates: false,
    params: {
      nodeId: {
        type: 'string',
        required: true,
        description: 'A component set. Its variants carry the Smart Animate reactions to read.',
      },
      strategy: {
        type: 'string',
        default: 'transition',
        enum: ['transition', 'flip', 'view-transitions', 'all'],
        description:
          'How to express it. `transition` emits property transitions, `flip` a measure-and-animate toggle ' +
          'for layout that CSS cannot tween, `view-transitions` the native API. `all` emits every one.',
      },
      toggleClass: { type: 'string', default: 'is-active', description: 'Class the non-hover mechanisms toggle.' },
    },
    async run(params) {
      const ref = params.nodeId as string
      const node = await figma.getNodeByIdAsync(ref)
      if (!node) throw new Error(`no node with id ${ref}`)
      if (node.type !== 'COMPONENT_SET') {
        throw new Error(
          `${ref} is a ${node.type} — Smart Animate lives on the reactions between a component set's variants`
        )
      }

      const pairs = extractSmartAnimatePairs(node)
      if (pairs.length === 0) {
        // A component set with no Smart Animate is a normal, correct answer — say which set,
        // so the caller can tell it apart from having named the wrong node.
        return { componentSet: { id: node.id, name: node.name }, transitions: [], files: [] }
      }

      const strategy = params.strategy as string
      const toggleClass = params.toggleClass as string
      const wants = (kind: string): boolean => strategy === 'all' || strategy === kind
      const slug = slugify(node.name, 'transitions')

      // Diffed once up front: the CSS pass below reuses each pair's diff, and the image pass
      // needs every diff's `background` changes before it knows which hashes to fetch.
      const diffed = pairs.map((pair) => ({ pair, diff: diffStates(toDiffable(pair.from), toDiffable(pair.to)) }))

      const imageCrossfade = wants('transition')
        ? await resolveImageUrls(node, diffed.map((entry) => entry.diff), slug)
        : { urlFor: (): string | undefined => undefined, files: [] as FileEnvelope[], warnings: [] as string[] }

      const transitions = []
      const css: string[] = []
      const js: string[] = []

      for (const { pair, diff } of diffed) {
        const mechanism = mapTriggerToMechanism(pair.trigger)
        // A SMART_ANIMATE transition always carries easing and duration; the union it is typed
        // as also covers instant navigation, which has neither.
        const timing = transitionToCssTiming(pair.transition as unknown as { easing: Easing; duration: number })
        const baseSelector = `.${slugify(pair.from.name, 'variant')}`

        const emitted: string[] = []
        if (wants('transition')) {
          const result = emitTransitionCss({
            baseSelector,
            diff,
            pathToSelector,
            durationMs: timing.durationMs,
            timingFunction: timing.timingFunction,
            mechanism,
            toggleClass,
            imageUrlFor: imageCrossfade.urlFor,
          })
          if (result.css) {
            css.push(result.css)
            emitted.push('transition')
            if (result.css.includes('::after')) emitted.push('image-crossfade')
          }
          if (result.js) js.push(result.js)
        }
        if (wants('flip')) {
          js.push(
            emitFlipToggle({
              rootSelector: baseSelector,
              toggleClass,
              durationMs: timing.durationMs,
              timingFunction: timing.timingFunction,
            })
          )
          emitted.push('flip')
        }
        if (wants('view-transitions')) {
          const paths = diff.pairs.filter((entry) => entry.changes.length > 0).map((entry) => entry.path)
          const result = emitViewTransition({
            pathToSelector,
            names: namesForPaths(paths),
            durationMs: timing.durationMs,
            timingFunction: timing.timingFunction,
            toggleSelector: baseSelector,
            toggleClass,
          })
          css.push(result.css)
          js.push(result.js)
          emitted.push('view-transitions')
        }

        transitions.push({
          from: { id: pair.from.id, name: pair.from.name },
          to: { id: pair.to.id, name: pair.to.name },
          trigger: pair.trigger.type,
          mechanism: mechanism.kind,
          durationMs: timing.durationMs,
          timingFunction: timing.timingFunction,
          diff: describeDiff(diff),
          emitted,
        })
      }

      const files: unknown[] = [...imageCrossfade.files]
      if (css.length > 0) files.push(textFile(`${slug}.transitions.css`, 'text/css', css.join('\n\n')))
      if (js.length > 0) files.push(textFile(`${slug}.transitions.js`, 'text/javascript', js.join('\n\n')))

      return {
        componentSet: { id: node.id, name: node.name },
        transitions,
        files,
        ...(imageCrossfade.warnings.length > 0 ? { warnings: imageCrossfade.warnings } : {}),
      }
    },
  },
]
