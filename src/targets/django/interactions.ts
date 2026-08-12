/**
 * Interaction CSS/JS emitter (M9, docs/1TO1-FIDELITY.md Part C §M9): turns the IR's
 * `node.interactions` (ON_HOVER/ON_PRESS → CHANGE_TO) and `node.overlays` (OVERLAY navigation)
 * into `static/css/interactions.css` and `static/js/interactions.js`.
 *
 * Hover/press → `:hover`/`:active` CSS rules: the emitter diffs the source node's `getCSSAsync`
 * output against the destination variant's, keeping only properties that differ and are NOT in
 * the IR-owned set (layout/box-model/font-metrics — those are handled by the structural CSS).
 * `transition` names exactly the changed properties — never `transition: all` (docs/research/05
 * §2.1: `all` transitions properties the designer didn't animate, producing visual noise).
 *
 * Overlays → `<dialog>` elements with JS `showModal()`/`close()`: the trigger event listener is
 * wired per `mapTriggerToMechanism`, and `CLOSE_ON_CLICK_OUTSIDE` adds a backdrop-click handler.
 */

import type { IrNode, IrInteraction, IrOverlay } from './ir.ts'
import { toClassName, type DjangoNodeSource } from './css-emitter.ts'
import { escapeHtml } from './html-emitter.ts'

/** CSS properties the IR layout model and per-segment text rules own — the interaction emitter
 * must not transition these, or the `:hover`/`:active` rule fights the structural CSS. Mirrors the
 * `IR_OWNED_CSS` set in css-emitter.ts; kept as a local copy to avoid a cross-module dependency
 * on a non-exported const. */
const IR_OWNED_CSS = new Set<string>([
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'top', 'right', 'bottom', 'left', 'inset', 'position', 'float', 'clear', 'box-sizing',
  'overflow', 'overflow-x', 'overflow-y', 'aspect-ratio',
  'display', 'flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'flex-direction', 'flex-wrap', 'flex-flow',
  'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items', 'justify-self',
  'place-items', 'place-content', 'place-self', 'order', 'gap', 'row-gap', 'column-gap',
  'grid', 'grid-template', 'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
  'grid-column', 'grid-row', 'grid-area', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows',
  'grid-column-gap', 'grid-row-gap',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch',
  'line-height', 'letter-spacing', 'text-align', 'text-indent', 'white-space', 'word-break', 'word-wrap',
  'text-overflow', 'writing-mode', '-webkit-line-clamp', '-webkit-box-orient',
])

/** The pseudo-class each interaction trigger maps to. ON_HOVER → `:hover` (reverts on mouse
 * leave), ON_PRESS → `:active` (reverts on mouse up) — both native CSS, no JS needed. */
function pseudoClass(trigger: IrInteraction['trigger']): string {
  return trigger === 'ON_HOVER' ? 'hover' : 'active'
}

/** Diffs two `getCSSAsync` result maps, returning only the properties that differ and aren't
 * IR-owned. Each entry is `{ property, value }` where value is the destination's CSS value — the
 * `:hover`/`:active` rule applies the destination's values, and the base class already carries
 * the source's. Properties absent from the destination are skipped (no `unset`/`initial`). */
function diffCss(
  sourceCss: Record<string, string>,
  destCss: Record<string, string>
): { property: string; value: string }[] {
  const decls: { property: string; value: string }[] = []
  for (const [property, value] of Object.entries(destCss)) {
    if (IR_OWNED_CSS.has(property)) continue
    if (sourceCss[property] === value) continue
    // Skip properties where the source didn't have it either — no visual change to transition.
    if (!(property in sourceCss) && !value) continue
    decls.push({ property, value })
  }
  return decls
}

export interface EmitInteractionsCssInput {
  readonly nodes: readonly IrNode[]
  readonly sceneNodesById: ReadonlyMap<string, DjangoNodeSource>
}

export interface EmitInteractionsResult {
  /** Content for `static/css/interactions.css`. Empty string when no interactions or overlays
   * exist — the caller links the file only when it has content. */
  readonly css: string
  /** Content for `static/js/interactions.js`. Empty string when no overlays need JS. */
  readonly js: string
  /** `<dialog>`/modal markup for each overlay, to be placed in the page template. Keyed by
   * the source node id (the trigger), value is the HTML. */
  readonly overlayDialogs: Map<string, string[]>
  /** REFORM phase 7: attributes to inject into each trigger element (keyed by its CSS class),
   * e.g. ` data-bs-toggle="modal" …` — Bootstrap's data API replaces our overlay JS. */
  readonly triggerAttributes: Map<string, string>
}

export interface EmitInteractionsOptions {
  /** REFORM phase 7 / B3: ON_CLICK overlays render native Bootstrap modals wired through the
   * data API (no generated JS). Non-click overlay triggers have no Bootstrap data-API
   * equivalent and keep the `<dialog>` + JS path. */
  readonly bootstrapModals?: boolean
}

/** Every variant node id a CHANGE_TO interaction or OVERLAY reaction references — both the DESTINATION
 * and (P2d) the diff SOURCE (`interaction.sourceId`, the default variant when the reaction was
 * inherited from a main component) — across the whole IR tree.
 * REFORM phase 13 (P2b): these variants live in the component set — NOT descendants of the exported
 * frame — so they're absent from the scene-node index and `emitInteractions` silently skips them
 * (interactions.ts). The plugin resolves each id via `figma.getNodeByIdAsync` and adds it to the scene
 * map before export, so the source↔destination `getCSSAsync` diff (→ `.is-active` toggle / `:hover` /
 * `:active`) just works. NAVIGATE destinations are excluded — those are other pages, wired via navMap. */
export function collectReactionDestinationIds(nodes: readonly IrNode[]): Set<string> {
  const ids = new Set<string>()
  const visit = (node: IrNode): void => {
    for (const interaction of node.interactions ?? []) {
      ids.add(interaction.destinationId)
      if (interaction.sourceId) ids.add(interaction.sourceId)
    }
    for (const overlay of node.overlays ?? []) ids.add(overlay.destinationId)
    if ('children' in node) for (const child of node.children) visit(child)
  }
  for (const node of nodes) visit(node)
  return ids
}

/** Emits the interactions CSS and overlay JS from every node carrying `interactions` or
 * `overlays`. Walks the full IR tree to find them (they can be on any node, not just roots). */
export async function emitInteractions(
  nodes: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  options: EmitInteractionsOptions = {}
): Promise<EmitInteractionsResult> {
  const cssParts: string[] = []
  const jsParts: string[] = []
  const overlayDialogs = new Map<string, string[]>()
  const triggerAttributes = new Map<string, string>()
  // Tooltips/popovers are opt-in in Bootstrap (not auto-inited) — emit one shared init snippet.
  let needsTooltipInit = false
  let needsPopoverInit = false

  // REFORM wave 3: an overlay's destination decides WHICH Bootstrap popup it is. A destination
  // component named `Offcanvas` → data-bs-toggle="offcanvas"; anything else → modal (phase 7).
  // Build an id→IR-node index over the whole tree so the overlay handler can read the
  // destination's component/name (sceneNodesById only carries getCSSAsync).
  const irNodeById = new Map<string, IrNode>()
  const indexNode = (node: IrNode): void => {
    irNodeById.set(node.id, node)
    if ('children' in node) for (const child of node.children) indexNode(child)
  }
  for (const node of nodes) indexNode(node)

  const visit = async (node: IrNode): Promise<void> => {
    if (node.interactions) {
      const className = toClassName(node.id)
      // P2e: a node can carry BOTH an ON_HOVER and a chained ON_PRESS (and/or a click toggle). The
      // base `transition` must be a SINGLE rule per node — one `.class { transition }` per interaction
      // would override the previous at equal specificity, so only the last interaction's properties
      // would animate. Aggregate all animated properties into one rule (first duration/timing wins per
      // property), and emit each state's block (`:hover`/`:active`/`.is-active`) separately.
      const transitionByProp = new Map<string, string>()
      const stateBlocks: string[] = []
      for (const interaction of node.interactions) {
        // P2d: diff from the interaction's SOURCE variant (default variant for inherited reactions;
        // the hover variant for a chained press — P2e) rather than the instance, so only the designer-
        // intended delta is emitted and the instance's own overrides (e.g. cornerRadius) survive the
        // state. Fall back to the instance when there's no sourceId or it didn't resolve into the scene
        // map (a resolved-source failure would otherwise diff against {} = the whole variant).
        const sourceNode = (interaction.sourceId ? sceneNodesById.get(interaction.sourceId) : undefined) ?? sceneNodesById.get(node.id)
        const sourceCss = await sourceNode?.getCSSAsync() ?? {}
        const destNode = sceneNodesById.get(interaction.destinationId)
        const destCss = await destNode?.getCSSAsync() ?? {}
        if (!destNode) {
          console.warn(`"${node.name}" has a ${interaction.trigger} CHANGE_TO interaction targeting "${interaction.destinationId}", which isn't in the exported node set — skipping`)
          continue
        }
        const decls = diffCss(sourceCss, destCss)
        if (decls.length === 0) continue
        for (const d of decls) {
          if (!transitionByProp.has(d.property)) transitionByProp.set(d.property, `${d.property} ${interaction.durationMs}ms ${interaction.timingFunction}`)
        }
        const destBlock = decls.map((d) => `  ${d.property}: ${d.value};`).join('\n')
        if (interaction.trigger === 'ON_CLICK') {
          // P2: a click-driven CHANGE_TO becomes a PERSISTENT toggled state — the base transition
          // animates it (motion from the reaction's duration/easing), a tiny listener flips the
          // `is-active` class. Recognized Bootstrap widgets get their behavior from data-bs-* (P1);
          // this covers free-form components whose interactivity was a Figma prototype.
          stateBlocks.push(`.${className}.is-active {\n${destBlock}\n}`)
          jsParts.push(
            `document.querySelectorAll('.${className}').forEach(function (el) { el.addEventListener('click', function () { el.classList.toggle('is-active') }) })`
          )
        } else {
          // :hover before :active (interaction order) — at equal specificity the later `:active` wins
          // while the pointer is down, so the pressed state overrides the co-applied hover state.
          const pseudo = pseudoClass(interaction.trigger)
          stateBlocks.push(`.${className}:${pseudo} {\n${destBlock}\n}`)
        }
      }
      if (transitionByProp.size > 0) {
        const base = `.${className} {\n  transition:\n    ${[...transitionByProp.values()].join(',\n    ')};\n}`
        cssParts.push([base, ...stateBlocks].join('\n'))
      }
    }

    if (node.overlays) {
      const className = toClassName(node.id)
      const dialogs: string[] = []
      for (const overlay of node.overlays) {
        const destNode = sceneNodesById.get(overlay.destinationId)
        if (!destNode) {
          console.warn(`"${node.name}" has an OVERLAY reaction targeting "${overlay.destinationId}", which isn't in the exported node set — skipping`)
          continue
        }
        const dialogId = `${className}--overlay-${overlay.destinationId.replace(/[^a-zA-Z0-9]+/g, '-')}`
        const destComponentName = overlayDestinationComponentName(irNodeById.get(overlay.destinationId))

        // REFORM wave 3e: a Tooltip/Popover destination → data-bs-toggle on the TRIGGER plus its
        // text pulled from the destination. Unlike modal/offcanvas, Bootstrap does NOT auto-init
        // these (opt-in for performance), so a one-time init snippet is emitted (once, guarded).
        if (options.bootstrapModals && (destComponentName === 'tooltip' || destComponentName === 'popover')) {
          const text = escapeHtml(firstTextOf(irNodeById.get(overlay.destinationId)))
          const attr =
            destComponentName === 'tooltip'
              ? ` data-bs-toggle="tooltip" data-bs-title="${text}"`
              : ` data-bs-toggle="popover" data-bs-content="${text}"`
          triggerAttributes.set(className, `${triggerAttributes.get(className) ?? ''}${attr}`)
          needsTooltipInit ||= destComponentName === 'tooltip'
          needsPopoverInit ||= destComponentName === 'popover'
          continue
        }

        // REFORM phase 7 / B3 + wave 3: a click-triggered overlay becomes a NATIVE Bootstrap
        // popup — modal by default, or offcanvas when the destination component says so. Trigger
        // wired via injected data attributes; Bootstrap auto-inits both from the data API, so no
        // JS is generated.
        if (options.bootstrapModals && overlay.trigger === 'ON_CLICK') {
          if (destComponentName === 'offcanvas') {
            const placement = offcanvasPlacement(irNodeById.get(overlay.destinationId))
            dialogs.push(
              `<div class="offcanvas offcanvas-${placement}" tabindex="-1" id="${dialogId}" aria-hidden="true">` +
                `<div class="offcanvas-body"></div>` +
                `</div>`
            )
            const existingOc = triggerAttributes.get(className) ?? ''
            triggerAttributes.set(className, `${existingOc} data-bs-toggle="offcanvas" data-bs-target="#${dialogId}"`)
            continue
          }
          const backdropAttr = overlay.closeInteraction === 'CLOSE_ON_CLICK_OUTSIDE' ? '' : ' data-bs-backdrop="static"'
          dialogs.push(
            `<div class="modal fade" id="${dialogId}" tabindex="-1" aria-hidden="true"${backdropAttr}>` +
              `<div class="modal-dialog"><div class="modal-content"></div></div>` +
              `</div>`
          )
          const existing = triggerAttributes.get(className) ?? ''
          triggerAttributes.set(className, `${existing} data-bs-toggle="modal" data-bs-target="#${dialogId}"`)
          continue
        }

        // The <dialog> element — the interactions JS wires the trigger to showModal().
        const backdropCss = overlay.background.type === 'SOLID_COLOR'
          ? `backdrop: rgba(${Math.round(overlay.background.color.r * 255)}, ${Math.round(overlay.background.color.g * 255)}, ${Math.round(overlay.background.color.b * 255)}, ${overlay.background.color.a});`
          : ''
        const positionStyle = overlay.positionType === 'MANUAL' && overlay.relativePosition
          ? `top: ${overlay.relativePosition.y}px; left: ${overlay.relativePosition.x}px;`
          : ''
        dialogs.push(
          `<dialog id="${dialogId}" class="${className}--overlay" style="${positionStyle}">` +
          `</dialog>`
        )
        if (backdropCss) cssParts.push(`#${dialogId}::backdrop { ${backdropCss} }`)

        // JS: wire the trigger to showModal(). ON_CLICK → click, ON_HOVER → mouseenter, etc.
        const event = triggerToEvent(overlay.trigger)
        const closeJs = overlay.closeInteraction === 'CLOSE_ON_CLICK_OUTSIDE'
          ? `\n  d.addEventListener('click', (e) => { if (e.target === d) d.close() })`
          : ''
        jsParts.push(
          `document.querySelectorAll('.${className}').forEach((el) => {\n` +
          `  el.addEventListener('${event}', () => {\n` +
          `    var d = document.getElementById('${dialogId}')\n` +
          `    if (d && typeof d.showModal === 'function') d.showModal()\n` +
          `  })\n` +
          `})`
        )
        if (overlay.closeInteraction === 'CLOSE_ON_CLICK_OUTSIDE') {
          jsParts.push(
            `var _d${dialogId.replace(/-/g, '_')} = document.getElementById('${dialogId}')\n` +
            `if (_d${dialogId.replace(/-/g, '_')}) _d${dialogId.replace(/-/g, '_')}.addEventListener('click', function(e) { if (e.target === _d${dialogId.replace(/-/g, '_')}) _d${dialogId.replace(/-/g, '_')}.close() })`
          )
        }
      }
      if (dialogs.length > 0) overlayDialogs.set(node.id, dialogs)
    }

    if ('children' in node) {
      for (const child of node.children) await visit(child)
    }
  }

  for (const node of nodes) await visit(node)

  // One-time opt-in init for tooltips/popovers (Bootstrap doesn't auto-init them from the DOM).
  if (needsTooltipInit) {
    jsParts.push(
      `document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(function (el) { new bootstrap.Tooltip(el) })`
    )
  }
  if (needsPopoverInit) {
    jsParts.push(
      `document.querySelectorAll('[data-bs-toggle="popover"]').forEach(function (el) { new bootstrap.Popover(el) })`
    )
  }

  return {
    css: cssParts.join('\n\n'),
    js: jsParts.join('\n\n'),
    overlayDialogs,
    triggerAttributes,
  }
}

/** First non-empty text found in an IR subtree — the source of a tooltip/popover's text. Stops
 * at nested components (a tooltip's own content, not a nested widget's). */
function firstTextOf(node: IrNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text' && node.characters.trim() !== '') return node.characters.trim()
  if ('children' in node) {
    for (const child of node.children) {
      if (child.type === 'instance-ref') continue
      const found = firstTextOf(child)
      if (found) return found
    }
  }
  return ''
}

/** The overlay destination's component name (set name, else the node name), normalized to the
 * last `/`-segment lowercased — the cue for which Bootstrap popup the overlay opens. */
function overlayDestinationComponentName(node: IrNode | undefined): string | null {
  if (!node || !('component' in node) || !node.component) return null
  const raw = node.component.setName ?? node.name
  return (raw.split('/').pop() ?? raw).trim().toLowerCase()
}

/** `offcanvas-{start|end|top|bottom}` from a `placement` VARIANT prop on the destination
 * component (default `start`). Static skeleton, so the prop's default value is baked in. */
function offcanvasPlacement(node: IrNode | undefined): string {
  const placements = ['start', 'end', 'top', 'bottom']
  if (node && 'component' in node && node.component) {
    const prop = node.component.properties.find(
      (p) => p.type === 'VARIANT' && p.name.trim().toLowerCase() === 'placement'
    )
    const value = prop ? String(prop.defaultValue).trim().toLowerCase() : ''
    if (placements.includes(value)) return value
  }
  return 'start'
}

/** Maps a Figma trigger type to the DOM event name the JS listener should use. */
function triggerToEvent(trigger: IrOverlay['trigger']): string {
  switch (trigger) {
    case 'ON_CLICK': return 'click'
    case 'ON_HOVER': return 'mouseenter'
    case 'ON_PRESS': return 'mousedown'
    case 'MOUSE_UP': return 'mouseup'
    case 'MOUSE_ENTER': return 'mouseenter'
    case 'MOUSE_LEAVE': return 'mouseleave'
    case 'MOUSE_DOWN': return 'mousedown'
    case 'ON_DRAG': return 'pointerdown'
    case 'ON_KEY_DOWN': return 'keydown'
    case 'ON_MEDIA_END': return 'ended'
    case 'ON_MEDIA_HIT': return 'timeupdate'
    case 'AFTER_TIMEOUT': return 'click'
  }
}