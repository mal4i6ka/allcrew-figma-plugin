/**
 * Prototype links read back in the shape `links` takes on the way in.
 *
 * A reading used to be prose — `"press → 570:15184 (CHANGE_TO) DISSOLVE 0.05s EASE_IN_AND_OUT"` —
 * which says everything and can be sent nowhere. It is the last of the class the round-trip
 * instrument kept finding: the read printed for a person and the write could not take it back, so
 * a screen with a prototype on it could be read and never rebuilt.
 *
 * This is the inverse of `planLinks`, and deliberately so: every value here is one the planner
 * accepts, in the spelling it accepts, or it is left out. A link that carries something the write
 * has no word for keeps the parts it does have and says what was lost in `unread` — half a link
 * with a note beats a whole one nobody can use.
 */

import type { FlowCondition, FlowLink, FlowOperand } from './props.ts'

/** Figma's trigger types, spelled the way the write spells them. */
const TRIGGER_WORDS: Readonly<Record<string, string>> = {
  ON_CLICK: 'click',
  ON_HOVER: 'hover',
  ON_PRESS: 'press',
  ON_DRAG: 'drag',
  AFTER_TIMEOUT: 'timeout',
  ON_KEY_DOWN: 'keyDown',
  MOUSE_ENTER: 'mouseEnter',
  MOUSE_LEAVE: 'mouseLeave',
  MOUSE_UP: 'mouseUp',
  MOUSE_DOWN: 'mouseDown',
}

const SIMPLE = ['DISSOLVE', 'SMART_ANIMATE', 'SCROLL_ANIMATE']

/** Milliseconds in, seconds out — the write takes seconds, so the read gives them. */
const inSeconds = (ms: number): number => Math.round((ms / 1000) * 1000) / 1000

export interface ReadLink extends FlowLink {
  /** What this link does that the write vocabulary has no word for. */
  unread?: string[]
}

export function sendableLinks(reactions: readonly Reaction[]): ReadLink[] {
  const links: ReadLink[] = []
  for (const reaction of reactions) {
    const trigger = triggerOf(reaction.trigger)
    // One reaction can hold several actions, and `links` is a flat list: the trigger is repeated
    // rather than nested, which is also how a caller writes two things on one click.
    const actions = reaction.actions ?? (reaction.action ? [reaction.action] : [])
    for (const action of actions) {
      const link = actionOf(action)
      if (link) links.push({ ...trigger, ...link } as ReadLink)
    }
  }
  return links
}

function triggerOf(trigger: Reaction['trigger']): Partial<ReadLink> {
  if (!trigger) return {}
  const on = TRIGGER_WORDS[trigger.type]
  if (!on) return { unread: [`trigger ${trigger.type}`] }

  const out: Partial<ReadLink> = { on: on as FlowLink['on'] }
  if (trigger.type === 'AFTER_TIMEOUT') out.after = inSeconds(trigger.timeout)
  else if (trigger.type === 'ON_KEY_DOWN') out.keys = [...(trigger.keyCodes ?? [])]
  else if ('delay' in trigger && trigger.delay) out.delay = inSeconds(trigger.delay)
  return out
}

function actionOf(action: Action): Partial<ReadLink> | null {
  switch (action.type) {
    case 'BACK':
      return { to: 'back' }
    case 'CLOSE':
      return { to: 'close' }
    case 'URL':
      return { url: action.url, ...(action.openInNewTab === false ? { newTab: false } : {}) }

    case 'NODE': {
      if (!action.destinationId) return { unread: ['a navigation with no destination'] }
      return {
        to: action.destinationId,
        ...(action.navigation && action.navigation !== 'NAVIGATE' ? { as: action.navigation } : {}),
        ...transitionOf(action.transition),
        ...(action.resetScrollPosition ? { resetScroll: true } : {}),
        ...(action.resetVideoPosition ? { resetVideo: true } : {}),
        ...(action.resetInteractiveComponents ? { resetInteractive: true } : {}),
      } as Partial<ReadLink>
    }

    case 'SET_VARIABLE': {
      if (!action.variableId) return { unread: ['a variable action with no variable'] }
      const value = action.variableValue
      // `{ variable }` copies another variable's value; anything else is the value itself.
      const resolved =
        value && typeof value === 'object' && 'type' in value && value.type === 'VARIABLE_ALIAS'
          ? { variable: (value as VariableAlias).id }
          : (value as string | number | boolean)
      return { set: { variable: action.variableId, value: resolved } } as Partial<ReadLink>
    }

    case 'SET_VARIABLE_MODE': {
      if (!action.variableCollectionId || !action.variableModeId) return { unread: ['a mode action with no mode'] }
      // Ids, not names: the write takes either, and only an id is certainly still right when the
      // collection has two modes called the same thing in different files.
      return { mode: { collection: action.variableCollectionId, mode: action.variableModeId } } as Partial<ReadLink>
    }

    case 'CONDITIONAL': {
      // Figma holds a list of blocks and takes the first whose condition holds; the vocabulary
      // says if / then / else, which is the same thing for one or two blocks. Three or more have
      // no spelling — Figma has no else-if — so the rest is named rather than quietly dropped.
      const blocks = action.conditionalBlocks ?? []
      if (blocks.length === 0) return { unread: ['an empty conditional'] }
      const [first, second, ...rest] = blocks
      const then = firstOf(first.actions ?? [])
      if (!then) return { unread: ['a conditional whose branch does nothing the write can say'] }
      const asked = expressionOf(first.condition)
      if (!asked) return { unread: ['a condition the vocabulary has no words for'] }
      const link: Partial<ReadLink> = { if: asked, then: then as FlowLink }
      const otherwise = second ? firstOf(second.actions ?? []) : null
      if (otherwise) link.else = otherwise as FlowLink
      if (rest.length > 0) link.unread = [`${rest.length} more branch(es) — Figma has no else-if and neither has this`]
      return link
    }

    default:
      return { unread: [`action ${(action as { type: string }).type}`] }
  }
}

const firstOf = (actions: readonly Action[]): Partial<ReadLink> | null => {
  for (const action of actions) {
    const link = actionOf(action)
    if (link && !link.unread) return link
  }
  return null
}

/**
 * A condition as the vocabulary asks it.
 *
 * Figma stores an expression tree; the write takes one comparison. A tree deeper than that is
 * reported by what it is rather than flattened into something that would read as true.
 */
function expressionOf(condition: unknown): FlowCondition | null {
  const node = condition as { expressionFunction?: string; expressionArguments?: unknown[] } | undefined
  if (!node?.expressionFunction) return null
  const args = node.expressionArguments ?? []
  const is = COMPARISONS[node.expressionFunction]
  if (!is || args.length !== 2) return null
  const left = operandOf(args[0])
  const right = operandOf(args[1])
  return left === null || right === null ? null : { left, is, right }
}

/** One side of a comparison: a value, a variable, or a comparison of its own. */
function operandOf(argument: unknown): FlowOperand | null {
  const one = argument as { type?: string; value?: unknown; resolvedType?: string } | undefined
  if (!one) return null
  if (one.type === 'VARIABLE_ALIAS') return { variable: String((one as unknown as VariableAlias).id) }
  if (one.type === 'EXPRESSION') return expressionOf(one.value)
  const value = one.value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return null
}

/** Figma's expression names, in the words the write takes. */
const COMPARISONS: Readonly<Record<string, string>> = {
  EQUALS: '==',
  NOT_EQUAL: '!=',
  LESS_THAN: '<',
  LESS_THAN_OR_EQUAL: '<=',
  GREATER_THAN: '>',
  GREATER_THAN_OR_EQUAL: '>=',
  AND: 'and',
  OR: 'or',
}

/** A transition as `animation` + `duration` + a curve, which is how it was written. */
function transitionOf(transition: Transition | null | undefined): Partial<ReadLink> {
  if (!transition) return {}
  const type = transition.type
  const animation = SIMPLE.includes(type)
    ? type
    : 'direction' in transition
      ? `${type}_${transition.direction}`
      : type
  return {
    animation,
    duration: inSeconds((transition.duration ?? 0.3) * 1000),
    ...easingOf(transition.easing),
    ...('matchLayers' in transition && transition.matchLayers ? { matchLayers: true } : {}),
  } as Partial<ReadLink>
}

function easingOf(easing: Easing | undefined): Partial<ReadLink> {
  if (!easing) return {}
  if (easing.type === 'CUSTOM_CUBIC_BEZIER') {
    const curve = easing.easingFunctionCubicBezier
    if (!curve) return {}
    return { bezier: [curve.x1, curve.y1, curve.x2, curve.y2] }
  }
  if (easing.type === 'CUSTOM_SPRING') {
    const spring = easing.easingFunctionSpring
    if (!spring) return {}
    return {
      spring: {
        mass: spring.mass,
        stiffness: spring.stiffness,
        damping: spring.damping,
        ...(spring.initialVelocity ? { initialVelocity: spring.initialVelocity } : {}),
      },
    }
  }
  return { easing: easing.type }
}
