/**
 * Interaction CSS/JS emitter (M9, docs/1TO1-FIDELITY.md Part C §M9): turns the IR's
 * `node.interactions` (ON_HOVER/ON_PRESS → CHANGE_TO) and `node.overlays` (OVERLAY navigation)
 * into `static/css/interactions.css` and `static/js/interactions.js`.
 *
 * Hover/press → `:hover`/`:active` CSS rules: the emitter diffs the source node's `getCSSAsync`
 * output against the destination variant's, keeping only properties that differ and are NOT in
 * the IR-owned set (structural layout only — see the set's own doc below). `transition` names
 * exactly the changed properties — never `transition: all` (docs/research/05 §2.1: `all`
 * transitions properties the designer didn't animate, producing visual noise).
 *
 * REFORM (M9 follow-up): the diff used to stop at the trigger node itself, so a hover that
 * recolours an icon, re-pads a label, or reveals a badge — all on a DESCENDANT of the trigger —
 * emitted nothing. `matchLayers` (smart-animate/match-layers.ts, the same name+path algorithm
 * Smart Animate itself uses) now walks the trigger's source/destination subtrees too; each
 * matched descendant gets its own nested `.nTRIGGER:hover .nCHILD` rule, and a descendant that
 * only exists in one of the two variants (a reveal-on-hover badge, a hide-on-hover icon) gets an
 * opacity/visibility toggle instead of being silently skipped.
 *
 * Overlays → `<dialog>` elements with JS `showModal()`/`close()`: the trigger event listener is
 * wired per `overlayOpenMechanism`, and `CLOSE_ON_CLICK_OUTSIDE` adds a backdrop-click handler.
 * `renderOverlayBody` (optional) fills the dialog/modal/offcanvas body with the destination's own
 * rendered markup instead of leaving an empty shell.
 */

import type { IrNode, IrInteraction, IrOverlay, IrNavigateTransition } from './ir.ts'
import { toClassName, type DjangoNodeSource } from './css-emitter.ts'
import { escapeHtml } from './html-emitter.ts'
import { matchLayers, indexTree } from './smart-animate/match-layers.ts'
import type { DiffableNode, NodePath } from './smart-animate/types.ts'
import { diffCssProperties } from './state-diff.ts'

/** Diffs two `getCSSAsync` result maps, returning only the properties that differ and aren't
 * IR-owned (`diffCssProperties`, `state-diff.ts` — shared with the agent bridge's `node.states`
 * op, which needs the identical exclusion list so an interaction hover rule and an agent's read
 * of "what hover changes" never disagree). Each entry is `{ property, value }` where value is the
 * destination's CSS value — the `:hover`/`:active` rule applies the destination's values, and the
 * base class already carries the source's. Properties absent from the destination are skipped
 * (no `unset`/`initial`). */
function diffCss(
  sourceCss: Record<string, string>,
  destCss: Record<string, string>,
  /** Stylesheet-relative url()s for the DESTINATION node's image fills, in `fills[]` order
   * (`css-emitter.ts`'s `imageFillUrls`). Absent/empty means the destination's images were never
   * exported, so a declaration referencing one is dropped rather than shipped. */
  imageUrls: readonly string[] = [],
  nodeLabel = ''
): { property: string; value: string }[] {
  const decls: { property: string; value: string }[] = []
  for (const { property, to } of diffCssProperties(sourceCss, destCss)) {
    // Skip properties where the source didn't have it either — no visual change to transition.
    if (!(property in sourceCss) && !to) continue
    // Plain substring, not the /g/ regex: `RegExp.test` on a global pattern carries `lastIndex`
    // between calls and would skip every other match.
    if (to.includes('<path-to-image>')) {
      // `getCSSAsync` writes every image fill as the literal `url(<path-to-image>)`. Shipped as-is
      // it is a guaranteed 404 (`/static/css/%3Cpath-to-image%3E`) that blanks the element on
      // hover — worse than not animating the swap at all.
      if (imageUrls.length === 0) {
        console.warn(`${nodeLabel || 'a state'} changes an image fill whose asset was not exported — dropping "${property}" from the state rule`)
        continue
      }
      decls.push({ property, value: resolveImagePlaceholders(to, imageUrls) })
      continue
    }
    decls.push({ property, value: to })
  }
  return decls
}

/** `getCSSAsync`'s image-fill placeholder, matched the same way `css-emitter.ts` matches it. */
const IMAGE_FILL_PLACEHOLDER = /url\(\s*(["']?)<path-to-image>\1\s*\)/g

/** Positional substitution, last url reused once the list runs out — the same rule
 * `css-emitter.ts`'s `resolveImageFillPlaceholders` follows, for the same reason: one fill can
 * render as more than one background layer. */
function resolveImagePlaceholders(value: string, imageUrls: readonly string[]): string {
  let index = 0
  return value.replace(IMAGE_FILL_PLACEHOLDER, () => {
    const url = imageUrls[Math.min(index, imageUrls.length - 1)]
    index++
    return `url(${url})`
  })
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
  /** Renders the overlay destination's markup as the dialog/modal/offcanvas body. Absent (or
   * returning `undefined` for a given destination) → legacy empty shell. */
  readonly renderOverlayBody?: (destinationId: string) => string | undefined
  /** Stylesheet-relative url()s for the image fills of nodes OUTSIDE the exported page tree — the
   * state variants a reaction points at. Their images are exported by the plugin alongside the
   * page assets (`src/code.ts`); without an entry here a state that swaps a photo drops the
   * declaration instead of shipping `url(<path-to-image>)`, which resolves to nothing. */
  readonly imageUrlsByNodeId?: ReadonlyMap<string, readonly string[]>
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

/** Duck-typed subset of a scene-node-like object (a `DjangoNodeSource`, or the real live Figma
 * node in production) that the descendant walk needs — name/type/children, exactly what
 * `matchLayers` reads. Carries the ORIGINAL object too (`live`), because descendants of an
 * off-tree CHANGE_TO variant are never individually registered in `sceneNodesById` (only the
 * variant's own top-level id is — see `collectReactionDestinationIds`'s doc), so there is nowhere
 * else to read a descendant's `getCSSAsync` from. */
interface LiveDiffableNode extends DiffableNode {
  readonly live: DjangoNodeSource
}

function toLiveDiffableTree(source: DjangoNodeSource): LiveDiffableNode {
  const duck = source as unknown as { name?: string; type?: string; children?: readonly DjangoNodeSource[] }
  return {
    name: duck.name ?? '',
    type: duck.type ?? '',
    // matchLayers only reads name/type/children (see match-layers.ts) — the geometry fields
    // `DiffableNode` declares (for its own FLIP-style diff, unused here) are irrelevant.
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    children: (duck.children ?? []).map(toLiveDiffableTree),
    live: source,
  }
}

/** The exported node's OWN children as a `DiffableNode` tree, `id`-carrying — the descendant
 * walk's source/destination trees (above) are built from off-tree variants whose ids never
 * appear in the rendered DOM; this tree's ids DO, so a matched/added/removed PATH from that walk
 * is resolved back to the real `.n<id>` selector through this one (`indexTree`, keyed identically
 * by name+dupIndex — see match-layers.ts). */
function toRenderDiffableTree(node: IrNode): DiffableNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    children: 'children' in node ? node.children.map(toRenderDiffableTree) : undefined,
  }
}

interface DescendantRule {
  readonly renderId: string
  readonly kind: 'changed' | 'removed' | 'added'
  readonly decls: readonly { property: string; value: string }[]
}

/** Walks the matched/added/removed layers between an interaction's source and destination
 * subtrees (`matchLayers` — name+path, the same algorithm Smart Animate itself uses, docs/
 * research/05 §1.1) and resolves each to the TRIGGER's own rendered descendant id via
 * `renderIndex`. A path absent from the render tree (added-only and not otherwise present, or the
 * instance's own structure diverges from the variant being diffed) has no DOM node to attach CSS
 * to and is skipped — there's nothing to reveal or restyle. */
async function descendantRules(
  sourceNode: DjangoNodeSource | undefined,
  destNode: DjangoNodeSource,
  renderIndex: ReadonlyMap<NodePath, DiffableNode>,
  /** Image-fill urls per destination NODE ID — a descendant carries its own fills, not the
   * trigger's, so the lookup is per matched node rather than one list for the whole subtree. */
  imageUrlsByNodeId: ReadonlyMap<string, readonly string[]>
): Promise<DescendantRule[]> {
  if (!sourceNode) return []
  const { matched, removed, added } = matchLayers(toLiveDiffableTree(sourceNode), toLiveDiffableTree(destNode))
  const rules: DescendantRule[] = []

  for (const pair of matched) {
    const renderNode = renderIndex.get(pair.path)
    if (!renderNode?.id) continue
    const a = pair.a as LiveDiffableNode
    const b = pair.b as LiveDiffableNode
    const [sourceCss, destCss] = await Promise.all([a.live.getCSSAsync(), b.live.getCSSAsync()])
    const decls = diffCss(sourceCss, destCss, imageUrlsByNodeId.get(b.id ?? '') ?? [], `"${b.name}"`)
    if (decls.length > 0) rules.push({ renderId: renderNode.id, kind: 'changed', decls })
  }
  for (const entry of removed) {
    const renderNode = renderIndex.get(entry.path)
    if (renderNode?.id) rules.push({ renderId: renderNode.id, kind: 'removed', decls: [] })
  }
  for (const entry of added) {
    const renderNode = renderIndex.get(entry.path)
    if (renderNode?.id) rules.push({ renderId: renderNode.id, kind: 'added', decls: [] })
  }
  return rules
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
      const renderIndex = indexTree(toRenderDiffableTree(node))
      // P2e: a node can carry BOTH an ON_HOVER and a chained ON_PRESS (and/or a click toggle). The
      // base `transition` must be a SINGLE rule per SELECTOR — one `.class { transition }` per
      // interaction would override the previous at equal specificity, so only the last
      // interaction's properties would animate. Aggregate per selector (trigger root, and now
      // each matched descendant), first duration/timing wins per property; emit each state's
      // block (`:hover`/`:active`/`.is-active`) separately.
      const transitionsBySelector = new Map<string, Map<string, string>>()
      const stateBlocks: string[] = []
      // Unconditional "at rest" declarations — only needed for a descendant that's revealed on
      // interaction (hidden by default is not the layout's job, it's this emitter's).
      const restBlocks: string[] = []

      const addTransition = (selector: string, property: string, durationMs: number, timingFunction: string, discrete = false): void => {
        const props = transitionsBySelector.get(selector) ?? new Map<string, string>()
        if (!props.has(property)) {
          props.set(property, `${property} ${durationMs}ms ${timingFunction}${discrete ? ' allow-discrete' : ''}`)
        }
        transitionsBySelector.set(selector, props)
      }

      for (const interaction of node.interactions) {
        // P2d: diff from the interaction's SOURCE variant (default variant for inherited reactions;
        // the hover variant for a chained press — P2e) rather than the instance, so only the designer-
        // intended delta is emitted and the instance's own overrides (e.g. cornerRadius) survive the
        // state. Fall back to the instance when there's no sourceId or it didn't resolve into the scene
        // map (a resolved-source failure would otherwise diff against {} = the whole variant).
        const sourceNode = (interaction.sourceId ? sceneNodesById.get(interaction.sourceId) : undefined) ?? sceneNodesById.get(node.id)
        const destNode = sceneNodesById.get(interaction.destinationId)
        if (!destNode) {
          console.warn(`"${node.name}" has a ${interaction.trigger} CHANGE_TO interaction targeting "${interaction.destinationId}", which isn't in the exported node set — skipping`)
          continue
        }
        const sourceCss = await sourceNode?.getCSSAsync() ?? {}
        const destCss = await destNode.getCSSAsync()
        const imageUrls = options.imageUrlsByNodeId ?? new Map<string, readonly string[]>()
        const rootDecls = diffCss(sourceCss, destCss, imageUrls.get(interaction.destinationId) ?? [], `"${node.name}"`)
        const descRules = await descendantRules(sourceNode, destNode, renderIndex, imageUrls)
        if (rootDecls.length === 0 && descRules.length === 0) continue

        const baseSelector = `.${className}`
        const triggerStateSelector =
          interaction.trigger === 'ON_CLICK'
            ? `${baseSelector}.is-active`
            : `${baseSelector}:${interaction.trigger === 'ON_HOVER' ? 'hover' : 'active'}`

        if (rootDecls.length > 0) {
          for (const d of rootDecls) addTransition(baseSelector, d.property, interaction.durationMs, interaction.timingFunction)
          stateBlocks.push(`${triggerStateSelector} {\n${rootDecls.map((d) => `  ${d.property}: ${d.value};`).join('\n')}\n}`)
        }

        for (const rule of descRules) {
          const descClass = toClassName(rule.renderId)
          const descSelector = `${baseSelector} .${descClass}`
          const descStateSelector = `${triggerStateSelector} .${descClass}`
          if (rule.kind === 'changed') {
            for (const d of rule.decls) addTransition(descSelector, d.property, interaction.durationMs, interaction.timingFunction)
            stateBlocks.push(`${descStateSelector} {\n${rule.decls.map((d) => `  ${d.property}: ${d.value};`).join('\n')}\n}`)
          } else if (rule.kind === 'removed') {
            // Present at rest, gone in the destination variant — fade it out. `visibility` is a
            // discrete property; `allow-discrete` lets it animate in step with opacity instead of
            // snapping to `hidden` at the start of the transition (docs/research/05 §2.3).
            addTransition(descSelector, 'opacity', interaction.durationMs, interaction.timingFunction)
            addTransition(descSelector, 'visibility', interaction.durationMs, interaction.timingFunction, true)
            stateBlocks.push(`${descStateSelector} {\n  opacity: 0;\n  visibility: hidden;\n  pointer-events: none;\n}`)
          } else {
            // Present ONLY in the destination variant (a badge/checkmark reveal) — hidden at rest
            // via opacity+visibility (never `display`, so there's something for the transition to
            // animate), revealed in the state rule.
            restBlocks.push(`${descSelector} {\n  opacity: 0;\n  visibility: hidden;\n  pointer-events: none;\n}`)
            addTransition(descSelector, 'opacity', interaction.durationMs, interaction.timingFunction)
            addTransition(descSelector, 'visibility', interaction.durationMs, interaction.timingFunction, true)
            stateBlocks.push(`${descStateSelector} {\n  opacity: 1;\n  visibility: visible;\n  pointer-events: auto;\n}`)
          }
        }

        if (interaction.trigger === 'ON_CLICK') {
          // P2: a click-driven CHANGE_TO becomes a PERSISTENT toggled state — the base transition
          // animates it (motion from the reaction's duration/easing), a tiny listener flips the
          // `is-active` class. Recognized Bootstrap widgets get their behavior from data-bs-* (P1);
          // this covers free-form components whose interactivity was a Figma prototype.
          jsParts.push(
            `document.querySelectorAll('.${className}').forEach(function (el) { el.addEventListener('click', function () { el.classList.toggle('is-active') }) })`
          )
        }
      }

      if (transitionsBySelector.size > 0) {
        const transitionRules = [...transitionsBySelector].map(
          ([selector, props]) => `${selector} {\n  transition:\n    ${[...props.values()].join(',\n    ')};\n}`
        )
        cssParts.push([...restBlocks, ...transitionRules, ...stateBlocks].join('\n'))
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
        const body = options.renderOverlayBody?.(overlay.destinationId) ?? ''

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
                `<div class="offcanvas-body">${body}</div>` +
                `</div>`
            )
            const existingOc = triggerAttributes.get(className) ?? ''
            triggerAttributes.set(className, `${existingOc} data-bs-toggle="offcanvas" data-bs-target="#${dialogId}"`)
            continue
          }
          const backdropAttr = overlay.closeInteraction === 'CLOSE_ON_CLICK_OUTSIDE' ? '' : ' data-bs-backdrop="static"'
          dialogs.push(
            `<div class="modal fade" id="${dialogId}" tabindex="-1" aria-hidden="true"${backdropAttr}>` +
              `<div class="modal-dialog"><div class="modal-content">${body}</div></div>` +
              `</div>`
          )
          const existing = triggerAttributes.get(className) ?? ''
          triggerAttributes.set(className, `${existing} data-bs-toggle="modal" data-bs-target="#${dialogId}"`)
          continue
        }

        // The <dialog> element — the interactions JS wires the trigger to showModal().
        // `::backdrop` paints through `background-color`; there is no `backdrop` property, so the
        // old spelling was a declaration every browser dropped and the scrim never appeared.
        const backdropCss = overlay.background.type === 'SOLID_COLOR'
          ? `background-color: rgba(${Math.round(overlay.background.color.r * 255)}, ${Math.round(overlay.background.color.g * 255)}, ${Math.round(overlay.background.color.b * 255)}, ${overlay.background.color.a});`
          : ''
        const positionStyle = overlayPositionStyle(overlay)
        dialogs.push(
          `<dialog id="${dialogId}" class="${className}--overlay" style="${positionStyle}">${body}</dialog>`
        )
        if (backdropCss) cssParts.push(`#${dialogId}::backdrop { ${backdropCss} }`)
        const animationCss = dialogAnimationCss(dialogId, overlay.transition)
        if (animationCss) cssParts.push(animationCss)

        jsParts.push(overlayOpenJs(className, dialogId, overlay))
        if (overlay.closeInteraction === 'CLOSE_ON_CLICK_OUTSIDE') {
          jsParts.push(
            `var _d${dialogId.replace(/-/g, '_')} = document.getElementById('${dialogId}')\n` +
            `if (_d${dialogId.replace(/-/g, '_')}) _d${dialogId.replace(/-/g, '_')}.addEventListener('click', function(e) { if (e.target === _d${dialogId.replace(/-/g, '_')}) _d${dialogId.replace(/-/g, '_')}.close() })`
          )
        }
      }
      if (dialogs.length > 0) overlayDialogs.set(node.id, dialogs)
    }

    // M9 follow-up: click actions that vanished silently (BACK/CLOSE/SCROLL_TO — URL is a plain
    // `<a href>` rendered by html-emitter.ts, no JS needed).
    if (node.back) {
      const className = toClassName(node.id)
      jsParts.push(
        `document.querySelectorAll('.${className}').forEach((el) => {\n` +
        `  el.addEventListener('click', (e) => {\n    e.preventDefault()\n    history.back()\n  })\n` +
        `})`
      )
    }
    if (node.closeDialog) {
      const className = toClassName(node.id)
      jsParts.push(
        `document.querySelectorAll('.${className}').forEach((el) => {\n` +
        `  el.addEventListener('click', (e) => {\n    e.preventDefault()\n    var d = el.closest('dialog')\n    if (d) d.close()\n  })\n` +
        `})`
      )
    }
    if (node.scrollTo) {
      const className = toClassName(node.id)
      const targetClass = toClassName(node.scrollTo.destinationId)
      jsParts.push(
        `document.querySelectorAll('.${className}').forEach((el) => {\n` +
        `  el.addEventListener('click', (e) => {\n    e.preventDefault()\n    var t = document.querySelector('.${targetClass}')\n    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' })\n  })\n` +
        `})`
      )
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

/** Inline `style` for a `<dialog>`'s placement. MANUAL uses the reaction's own relative offset
 * (unchanged); the other six `OverlayPositionType` values previously fell through to the
 * browser's default `<dialog>` centering regardless of what the designer picked — now each corner/
 * edge maps to an explicit `position: fixed` placement. CENTER needs no override: a modal
 * `<dialog>`'s UA stylesheet already centers it. */
function overlayPositionStyle(overlay: IrOverlay): string {
  if (overlay.positionType === 'MANUAL') {
    return overlay.relativePosition
      ? `position: fixed; margin: 0; top: ${overlay.relativePosition.y}px; left: ${overlay.relativePosition.x}px;`
      : ''
  }
  switch (overlay.positionType) {
    case 'TOP_LEFT': return 'position: fixed; margin: 0; top: 0; left: 0;'
    case 'TOP_CENTER': return 'position: fixed; margin: 0 auto; top: 0; left: 0; right: 0;'
    case 'TOP_RIGHT': return 'position: fixed; margin: 0; top: 0; right: 0; left: auto;'
    case 'BOTTOM_LEFT': return 'position: fixed; margin: 0; top: auto; bottom: 0; left: 0;'
    case 'BOTTOM_CENTER': return 'position: fixed; margin: 0 auto; top: auto; bottom: 0; left: 0; right: 0;'
    case 'BOTTOM_RIGHT': return 'position: fixed; margin: 0; top: auto; bottom: 0; right: 0; left: auto;'
    default: return ''
  }
}

/** Open/close fade+scale for the plain `<dialog>` path (Bootstrap modal/offcanvas keep their own
 * CSS animation and never call this). Uses the overlay reaction's own duration/easing when it
 * captured one, else a small sensible default. `@starting-style` + `overlay`/`display` in the
 * `transition` list (with `allow-discrete`) are what let a `<dialog>` animate OPEN at all — by
 * default it snaps from `display: none` with no starting state to transition from. Wrapped in
 * `prefers-reduced-motion: no-preference` so reduced-motion users get an instant, unanimated
 * open/close instead of a suppressed-but-still-there transition. */
function dialogAnimationCss(dialogId: string, transition: IrNavigateTransition | undefined): string {
  const durationMs = transition?.durationMs ?? 200
  const timingFunction = transition?.timingFunction ?? 'ease'
  if (durationMs <= 0) return ''
  const sel = `#${dialogId}`
  return [
    '@media (prefers-reduced-motion: no-preference) {',
    `  ${sel} {`,
    '    opacity: 0;',
    '    transform: scale(0.95);',
    `    transition: opacity ${durationMs}ms ${timingFunction}, transform ${durationMs}ms ${timingFunction}, overlay ${durationMs}ms allow-discrete, display ${durationMs}ms allow-discrete;`,
    '  }',
    `  ${sel}[open] {`,
    '    opacity: 1;',
    '    transform: scale(1);',
    '  }',
    '  @starting-style {',
    `    ${sel}[open] {`,
    '      opacity: 0;',
    '      transform: scale(0.95);',
    '    }',
    '  }',
    '}',
  ].join('\n')
}

/** How the interactions JS opens a `<dialog>` overlay: an event to listen for, or (`AFTER_TIMEOUT`)
 * a real `setTimeout`. Previously AFTER_TIMEOUT fell through to `'click'` — a timed overlay that
 * needed a click to "time out" never opened on its own. */
function overlayOpenMechanism(overlay: IrOverlay): { kind: 'event'; event: string } | { kind: 'timeout'; timeoutMs: number } {
  switch (overlay.trigger) {
    case 'AFTER_TIMEOUT': return { kind: 'timeout', timeoutMs: overlay.triggerTimeoutMs ?? 0 }
    case 'ON_CLICK': return { kind: 'event', event: 'click' }
    case 'ON_HOVER': return { kind: 'event', event: 'mouseenter' }
    case 'ON_PRESS': return { kind: 'event', event: 'mousedown' }
    case 'MOUSE_UP': return { kind: 'event', event: 'mouseup' }
    case 'MOUSE_DOWN': return { kind: 'event', event: 'mousedown' }
    case 'MOUSE_ENTER': return { kind: 'event', event: 'mouseenter' }
    case 'MOUSE_LEAVE': return { kind: 'event', event: 'mouseleave' }
    case 'ON_KEY_DOWN': return { kind: 'event', event: 'keydown' }
    case 'ON_DRAG': return { kind: 'event', event: 'pointerdown' }
    case 'ON_MEDIA_HIT': return { kind: 'event', event: 'timeupdate' }
    case 'ON_MEDIA_END': return { kind: 'event', event: 'ended' }
  }
}

/** The trigger listener that opens a `<dialog>` overlay — `setTimeout` for AFTER_TIMEOUT, a
 * key-filtered `keydown` for ON_KEY_DOWN (the reaction's `keyCodes`, or any key when unset), a
 * plain event listener otherwise. */
function overlayOpenJs(className: string, dialogId: string, overlay: IrOverlay): string {
  const openCall = `{ var d = document.getElementById(${JSON.stringify(dialogId)}); if (d && typeof d.showModal === 'function') d.showModal() }`
  const mechanism = overlayOpenMechanism(overlay)

  if (mechanism.kind === 'timeout') {
    return (
      `document.querySelectorAll('.${className}').forEach((el) => {\n` +
      `  setTimeout(() => ${openCall}, ${mechanism.timeoutMs})\n` +
      `})`
    )
  }
  if (overlay.trigger === 'ON_KEY_DOWN') {
    const codes = JSON.stringify(overlay.triggerKeyCodes ?? [])
    return (
      `document.querySelectorAll('.${className}').forEach((el) => {\n` +
      `  el.addEventListener('keydown', (e) => {\n` +
      `    if (${codes}.length && !${codes}.includes(e.keyCode)) return\n` +
      `    ${openCall}\n` +
      `  })\n` +
      `})`
    )
  }
  return (
    `document.querySelectorAll('.${className}').forEach((el) => {\n` +
    `  el.addEventListener('${mechanism.event}', () => ${openCall})\n` +
    `})`
  )
}
