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
  type DiffableNode,
  type DiffablePaint,
  type StateDiff,
} from '../targets/django/smart-animate/index.ts'
import { slugify, textFile } from './files.ts'
import type { OpDef } from './protocol.ts'

/* ------------------------------------------------------------------ adapter */

/** `figma.mixed` is a sentinel object; the diff module uses its own symbol so it never has to
 * import the plugin typings. This is the only place the two meet. */
function orMixed<T>(value: T | typeof figma.mixed): T | typeof MIXED {
  return value === figma.mixed ? MIXED : (value as T)
}

function paints(node: SceneNode): readonly DiffablePaint[] | typeof MIXED | undefined {
  const fills = (node as unknown as { fills?: unknown }).fills
  if (fills === undefined) return undefined
  if (fills === figma.mixed) return MIXED
  if (!Array.isArray(fills)) return undefined
  return (fills as Paint[]).map((paint) => ({
    type: paint.type,
    color: paint.type === 'SOLID' ? (paint as SolidPaint).color : undefined,
    opacity: paint.opacity,
  }))
}

/** Reads only the fields the diff actually looks at — geometry, radii, opacity, fills, kids. */
function toDiffable(node: SceneNode): DiffableNode {
  const any = node as unknown as Record<string, unknown>
  const children = (node as unknown as { children?: readonly SceneNode[] }).children
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: typeof any.rotation === 'number' ? any.rotation : undefined,
    opacity: typeof any.opacity === 'number' ? any.opacity : undefined,
    cornerRadius: any.cornerRadius === undefined ? undefined : orMixed(any.cornerRadius as number),
    topLeftRadius: typeof any.topLeftRadius === 'number' ? any.topLeftRadius : undefined,
    topRightRadius: typeof any.topRightRadius === 'number' ? any.topRightRadius : undefined,
    bottomRightRadius: typeof any.bottomRightRadius === 'number' ? any.bottomRightRadius : undefined,
    bottomLeftRadius: typeof any.bottomLeftRadius === 'number' ? any.bottomLeftRadius : undefined,
    fills: paints(node),
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

      const transitions = []
      const css: string[] = []
      const js: string[] = []

      for (const pair of pairs) {
        const diff = diffStates(toDiffable(pair.from), toDiffable(pair.to))
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
          })
          if (result.css) { css.push(result.css); emitted.push('transition') }
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

      const slug = slugify(node.name, 'transitions')
      const files: unknown[] = []
      if (css.length > 0) files.push(textFile(`${slug}.transitions.css`, 'text/css', css.join('\n\n')))
      if (js.length > 0) files.push(textFile(`${slug}.transitions.js`, 'text/javascript', js.join('\n\n')))

      return { componentSet: { id: node.id, name: node.name }, transitions, files }
    },
  },
]
