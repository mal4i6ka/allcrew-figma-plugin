/**
 * ComponentSet + reactions extractor (T5.6, docs/research/05-smart-animate-css-diff.md §1.3):
 * walks every variant under a `ComponentSetNode` and its `reactions` for a `NODE` action whose
 * `transition` is Smart Animate-eligible (`SMART_ANIMATE`, or a `DirectionalTransition` with
 * `matchLayers: true`), resolving the destination via `figma.getNodeById`. This is preferred
 * over guessing pairs from a "State" variant property name: the designer already linked the two
 * states and chose the transition's duration/easing explicitly.
 */

export interface SmartAnimatePair {
  readonly trigger: Trigger
  readonly from: SceneNode
  readonly to: SceneNode
  readonly transition: Transition
}

function isSmartAnimateTransition(transition: Transition | null): transition is Transition {
  if (!transition) return false
  if (transition.type === 'SMART_ANIMATE') return true
  return 'matchLayers' in transition && transition.matchLayers === true
}

function collectFromNode(node: SceneNode): SmartAnimatePair[] {
  const reactionNode = node as SceneNode & { reactions?: ReadonlyArray<Reaction> }
  const out: SmartAnimatePair[] = []

  for (const reaction of reactionNode.reactions ?? []) {
    if (!reaction.trigger) continue
    for (const action of reaction.actions ?? []) {
      if (action.type !== 'NODE' || !action.destinationId || !isSmartAnimateTransition(action.transition)) continue
      const destination = figma.getNodeById(action.destinationId)
      if (!destination || !('type' in destination)) continue
      out.push({ trigger: reaction.trigger, from: node, to: destination as SceneNode, transition: action.transition })
    }
  }

  return out
}

/** Collects every Smart Animate `{trigger, from, to}` pair from a ComponentSet's variants. */
export function extractSmartAnimatePairs(componentSet: ComponentSetNode): SmartAnimatePair[] {
  return componentSet.children.flatMap((variant) => collectFromNode(variant as SceneNode))
}

/**
 * Variant-to-variant links that exist but do NOT animate: a `CHANGE_TO` whose transition is
 * absent (an instant swap) or of a type Smart Animate does not cover.
 *
 * Without this an empty pair list has two meanings a caller cannot tell apart - "this set has no
 * prototype at all" and "the designer linked the states and chose no animation" - and the second
 * one is common enough that the first reading sends an agent looking for a bug in the reader.
 */
export function countInstantVariantLinks(componentSet: ComponentSetNode): number {
  let instant = 0
  for (const variant of componentSet.children) {
    const reactions = (variant as SceneNode & { reactions?: ReadonlyArray<Reaction> }).reactions ?? []
    for (const reaction of reactions) {
      for (const action of reaction.actions ?? []) {
        if (action.type !== 'NODE' || !action.destinationId) continue
        if (!isSmartAnimateTransition(action.transition)) instant += 1
      }
    }
  }
  return instant
}
