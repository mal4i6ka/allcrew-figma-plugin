/**
 * Shared CSS-diff core (M9 follow-up / node.states, docs/1TO1-FIDELITY.md Part C §M9):
 * `interactions.ts`'s stylesheet emitter and the agent bridge's `node.states` introspection op
 * (`src/agent/state-ops.ts`) both need the same answer to "which declarations actually changed
 * between two `getCSSAsync` snapshots, ignoring the properties the IR layout model owns" — this
 * is that one answer, extracted so a change to what counts as IR-owned never drifts between the
 * two callers instead of living as two hand-kept copies.
 *
 * `css-emitter.ts` keeps its OWN, much larger `IR_OWNED_CSS` (the box-declaration emitter's
 * exclusion list — a different job: which properties `layoutDeclarations` itself must never
 * write, not which properties a STATE change may touch) — that duplication predates this module,
 * is documented on its own copy, and is intentionally left alone here.
 */

/** CSS properties the IR layout model owns — a `:hover`/`:active`/variant-state rule (or the
 * `node.states` op reporting one) must never claim these changed, or the state would fight the
 * structural CSS (reflowing siblings, breaking the grid/flex algorithm) instead of just
 * restyling the node. Only genuinely structural properties are excluded: placement (position/
 * inset/float/clear/box-sizing/overflow/aspect-ratio/display) and the flex/grid ALGORITHM
 * (track/alignment definitions — changing these on one interaction state would reflow every
 * sibling, not just the node carrying the interaction). Size, spacing, font metrics, color, and
 * transform are all real visual state and are allowed to change between states. */
export const IR_OWNED_CSS: Readonly<Record<string, true>> = {
  position: true, top: true, right: true, bottom: true, left: true, inset: true, float: true, clear: true, 'box-sizing': true,
  overflow: true, 'overflow-x': true, 'overflow-y': true, 'aspect-ratio': true, display: true,
  flex: true, 'flex-grow': true, 'flex-shrink': true, 'flex-basis': true, 'flex-direction': true, 'flex-wrap': true, 'flex-flow': true,
  'align-items': true, 'align-self': true, 'align-content': true, 'justify-content': true, 'justify-items': true, 'justify-self': true,
  'place-items': true, 'place-content': true, 'place-self': true, order: true,
  grid: true, 'grid-template': true, 'grid-template-columns': true, 'grid-template-rows': true, 'grid-template-areas': true,
  'grid-column': true, 'grid-row': true, 'grid-area': true, 'grid-auto-flow': true, 'grid-auto-columns': true, 'grid-auto-rows': true,
  font: true, 'font-family': true, 'font-style': true, 'font-variant': true, 'font-stretch': true,
  'text-align': true, 'text-indent': true, 'white-space': true, 'word-break': true, 'word-wrap': true, 'text-overflow': true,
  'writing-mode': true, '-webkit-line-clamp': true, '-webkit-box-orient': true,
}

export interface CssDiffEntry {
  readonly property: string
  /** The source's value — `''` when the source never declared it (a state that reveals a
   * property with no "at rest" equivalent, e.g. a fill that only exists on the destination). */
  readonly from: string
  readonly to: string
}

/** Diffs two `getCSSAsync` result maps, returning one entry per property that (a) differs
 * between them and (b) isn't IR-owned. Iterates the DESTINATION's own properties only — a
 * property present in the source but absent from the destination is not "removed" by this pass
 * (Figma's `getCSSAsync` always reports a node's full declared box, so absence means "not part of
 * this node's own style", not "the state clears it"). Callers needing CSS-emission specifics
 * (image-fill placeholder resolution, drop-when-neither-side-had-a-value) layer that on top of
 * this — see `interactions.ts`'s `diffCss`. */
export function diffCssProperties(sourceCss: Record<string, string>, destCss: Record<string, string>): CssDiffEntry[] {
  const out: CssDiffEntry[] = []
  for (const [property, to] of Object.entries(destCss)) {
    if (IR_OWNED_CSS[property]) continue
    const from = sourceCss[property] ?? ''
    if (from === to) continue
    out.push({ property, from, to })
  }
  return out
}
