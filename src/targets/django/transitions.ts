/**
 * Prototype PAGE transitions for the Django (MPA) target: `IrNode.navigate.transition` is
 * captured by `ir.ts`'s `readNavigateReaction`, but every Django emitter dropped it on the floor
 * — the equivalent logic existed only in the Tauri target (`src/targets/tauri/transitions.ts`).
 * Hoisted here so BOTH targets share one implementation; Tauri imports from this module instead
 * of duplicating it.
 *
 * Mechanism (MDN cross-document view transitions; Baseline Newly Available since Chrome/Edge 111,
 * Safari 18, Firefox 144):
 *   - `@view-transition { navigation: auto; }` opts every same-origin navigation into a
 *     transition whenever ANY page-to-page NAVIGATE reaction exists — Django's MPA gets this
 *     natively, no JS required, and unsupported browsers just navigate instantly (the at-rule is
 *     silently ignored, same as an unknown CSS property).
 *   - DISSOLVE (or an edge with no captured transition at all) is the browser's own default: an
 *     un-styled root cross-fade. Only the explicit duration/easing override needs emitting, and
 *     only when at least one edge captured a real transition.
 *   - MOVE_IN/MOVE_OUT/PUSH/SLIDE_IN/SLIDE_OUT become directional root `@keyframes`, direction
 *     from `transition.direction` — only when every edge that HAS a transition agrees on
 *     style+direction (a shared stylesheet can't scope per-navigation without per-page markup).
 *   - SMART_ANIMATE: `matchLayers` (name+path — the same algorithm Smart Animate itself uses,
 *     docs/research/05 §1.1) finds the layers a source/destination page PAIR share, and those get
 *     the same `view-transition-name` — keyed by the export's own `.n<node id>` class
 *     (`toClassName`), never a slugified layer name (which could never match the rendered
 *     markup). An `instance-ref` is addressed by its COMPONENT's id, not its own instance id: its
 *     DOM subtree renders from the component partial, so the component id is what's actually on
 *     the page (mirrors `css-emitter.ts`'s `.n<id>` convention for instances).
 *   - `prefers-reduced-motion: reduce` zeroes every view-transition pseudo-element's animation —
 *     the transition still runs, instantly, so navigation itself never breaks.
 */

import type { IrNode, IrNavigateTransition } from './ir.ts'
import { toClassName } from './css-emitter.ts'
import { matchLayers } from './smart-animate/match-layers.ts'
import type { DiffableNode } from './smart-animate/types.ts'

export interface PageTransitionsInput {
  readonly nodes: readonly IrNode[]
  /** Rendered page root ids — a navigate transition to anything else is not a page transition. */
  readonly pageRootIds: ReadonlySet<string>
}

export interface PageTransitionsOutput {
  readonly css: string
  readonly js: string
}

export interface NavEdge {
  readonly sourcePageId: string
  readonly destPageId: string
  readonly transition?: IrNavigateTransition
}

/** Walks every rendered page root and returns the NAVIGATE edges whose destination is ALSO a
 * rendered page root — a reaction targeting anything else (an off-tree variant, a page that
 * collapsed into a breakpoint group) is not a page transition and is left to `interactions.ts`. */
export function collectNavEdges(nodes: readonly IrNode[], pageRootIds: ReadonlySet<string>): NavEdge[] {
  const edges: NavEdge[] = []
  const seen = new Set<string>()
  for (const root of nodes) {
    if (!pageRootIds.has(root.id)) continue
    const visit = (node: IrNode): void => {
      const navigate = node.navigate
      if (navigate && pageRootIds.has(navigate.destinationId)) {
        const key = `${root.id}\u0000${navigate.destinationId}\u0000${navigate.transition?.style ?? 'NONE'}`
        if (!seen.has(key)) {
          seen.add(key)
          edges.push({ sourcePageId: root.id, destPageId: navigate.destinationId, transition: navigate.transition })
        }
      }
      if ('children' in node) for (const child of node.children) visit(child)
    }
    visit(root)
  }
  return edges
}

const DIRECTIONAL_STYLES = new Set<IrNavigateTransition['style']>(['MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT'])

/** The `from` transform of the incoming root snapshot for a directional transition, and (PUSH/
 * MOVE_OUT/SLIDE_OUT only) the `to` transform of the outgoing one. Figma's "direction" is where
 * the NEW screen enters FROM (MOVE_IN LEFT slides the new page in from the left). */
export function directionTransforms(style: IrNavigateTransition['style'], direction: string): { newFrom: string; oldTo?: string } {
  const enter: Record<string, string> = {
    LEFT: 'translateX(-100%)',
    RIGHT: 'translateX(100%)',
    TOP: 'translateY(-100%)',
    BOTTOM: 'translateY(100%)',
  }
  const exit: Record<string, string> = {
    LEFT: 'translateX(100%)',
    RIGHT: 'translateX(-100%)',
    TOP: 'translateY(100%)',
    BOTTOM: 'translateY(-100%)',
  }
  const newFrom = enter[direction] ?? enter.RIGHT
  if (style === 'PUSH') return { newFrom, oldTo: exit[direction] ?? exit.RIGHT }
  if (style === 'MOVE_OUT' || style === 'SLIDE_OUT') return { newFrom: 'none', oldTo: exit[direction] ?? exit.RIGHT }
  return { newFrom }
}

/** Per-edge cap on morphing layers — each named group costs a snapshot pair at transition time; a
 * page with hundreds of layers should not turn navigation into a screenshot storm. */
const MAX_MATCHED_LAYERS = 40

interface IdDiffableNode extends DiffableNode {
  readonly id: string
}

/** A page root as a `DiffableNode` tree, `id`-carrying, for `matchLayers`. An `instance-ref`'s
 * subtree renders from its COMPONENT partial (not the instance's own IR children — those ids
 * never appear in the DOM for an instance), so it's addressed by `componentId` and NOT descended
 * into, mirroring the Tauri target's original `selectorIdFor`/`nodesByName` behavior. The page
 * root itself is never compared (`matchLayers`' `indexTree` only walks `.children`), which is
 * exactly right — the root is the `::view-transition-group(root)`, handled separately. */
function toPageDiffable(node: IrNode): IdDiffableNode {
  const id = node.type === 'instance-ref' && node.componentId ? node.componentId : node.id
  const children = node.type === 'instance-ref' ? undefined : 'children' in node ? node.children.map(toPageDiffable) : undefined
  return { id, name: node.name, type: node.type, x: 0, y: 0, width: 0, height: 0, children }
}

/** How many times each selector id (see `toPageDiffable`) occurs anywhere on ONE page — a
 * component instantiated more than once on the same page can't be given a unique
 * `view-transition-name` (two elements sharing one name makes the browser skip the transition
 * entirely), so any id occurring more than once is excluded from morph assignments. */
function idOccurrenceCounts(page: IrNode): Map<string, number> {
  const counts = new Map<string, number>()
  const visit = (node: IrNode, isRoot: boolean): void => {
    if (!isRoot) {
      const id = node.type === 'instance-ref' && node.componentId ? node.componentId : node.id
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    if (node.type === 'instance-ref') return
    if ('children' in node) for (const child of node.children) visit(child, false)
  }
  visit(page, true)
  return counts
}

export function emitPageTransitions(input: PageTransitionsInput): PageTransitionsOutput {
  const edges = collectNavEdges(input.nodes, input.pageRootIds)
  if (edges.length === 0) return { css: '', js: '' }

  const pageById = new Map(input.nodes.filter((node) => input.pageRootIds.has(node.id)).map((node) => [node.id, node]))
  const animated = edges.filter((edge): edge is NavEdge & { transition: IrNavigateTransition } => Boolean(edge.transition))

  const lines: string[] = [
    '/* Prototype page transitions — generated from Figma NAVIGATE reactions (django/transitions.ts). */',
    '@view-transition {',
    '  navigation: auto;',
    '}',
    '',
  ]

  if (animated.length > 0) {
    // Root timing: longest animated edge wins — a shared stylesheet cannot scope per-destination
    // without per-page markup hooks, and the longest duration keeps every morph inside the window.
    const slowest = animated.reduce((a, b) => (b.transition.durationMs > a.transition.durationMs ? b : a))
    lines.push(
      '::view-transition-group(root),',
      '::view-transition-old(root),',
      '::view-transition-new(root) {',
      `  animation-duration: ${slowest.transition.durationMs}ms;`,
      `  animation-timing-function: ${slowest.transition.timingFunction};`,
      '}',
      ''
    )

    // Directional root motion — only when every animated edge agrees (see module doc).
    const directional = animated.filter((edge) => DIRECTIONAL_STYLES.has(edge.transition.style))
    const styles = new Set(directional.map((edge) => `${edge.transition.style}/${edge.transition.direction ?? 'RIGHT'}`))
    if (directional.length === animated.length && styles.size === 1) {
      const { style, direction = 'RIGHT' } = directional[0].transition
      const { newFrom, oldTo } = directionTransforms(style, direction)
      if (newFrom !== 'none') {
        lines.push(
          '@keyframes pgvt-enter {',
          `  from { transform: ${newFrom}; }`,
          '  to { transform: none; }',
          '}',
          '::view-transition-new(root) {',
          '  animation-name: pgvt-enter;',
          '}',
          ''
        )
      }
      if (oldTo) {
        lines.push(
          '@keyframes pgvt-exit {',
          '  from { transform: none; }',
          `  to { transform: ${oldTo}; }`,
          '}',
          '::view-transition-old(root) {',
          '  animation-name: pgvt-exit;',
          '}',
          ''
        )
      }
    }

    // SMART_ANIMATE — shared-element morph between each edge's source/destination page roots.
    const morphEdges = animated.filter((edge) => edge.transition.style === 'SMART_ANIMATE')
    if (morphEdges.length > 0) {
      const countsByPage = new Map<string, Map<string, number>>()
      const countsFor = (pageId: string): Map<string, number> => {
        let counts = countsByPage.get(pageId)
        if (!counts) {
          const page = pageById.get(pageId)
          counts = page ? idOccurrenceCounts(page) : new Map()
          countsByPage.set(pageId, counts)
        }
        return counts
      }

      /** ident → selector ids sharing it, across every edge (a component reused across many
       * page-pairs accumulates into the SAME ident, which is exactly the desired behavior). */
      const assignments = new Map<string, Set<string>>()
      for (const edge of morphEdges) {
        const sourcePage = pageById.get(edge.sourcePageId)
        const destPage = pageById.get(edge.destPageId)
        if (!sourcePage || !destPage) continue
        const sourceCounts = countsFor(edge.sourcePageId)
        const destCounts = countsFor(edge.destPageId)
        const { matched } = matchLayers(toPageDiffable(sourcePage), toPageDiffable(destPage))

        let assigned = 0
        for (const pair of matched) {
          if (assigned >= MAX_MATCHED_LAYERS) break
          const aId = (pair.a as IdDiffableNode).id
          const bId = (pair.b as IdDiffableNode).id
          if ((sourceCounts.get(aId) ?? 0) > 1 || (destCounts.get(bId) ?? 0) > 1) continue
          const ident = toClassName(aId)
          const ids = assignments.get(ident) ?? new Set<string>()
          ids.add(aId)
          ids.add(bId)
          assignments.set(ident, ids)
          assigned++
        }
      }

      const sortedAssignments = [...assignments.entries()].sort(([a], [b]) => a.localeCompare(b))
      for (const [ident, ids] of sortedAssignments) {
        const selectors = [...ids].map((id) => `.${toClassName(id)}`).sort().join(', ')
        lines.push(`${selectors} { view-transition-name: ${ident}; }`)
      }
      if (sortedAssignments.length > 0) lines.push('')
    }
  }

  // Reduced motion: the transition mechanism stays on (navigation must still work), only the
  // animation is zeroed — an instant swap rather than a suppressed-but-still-running fade/slide.
  lines.push(
    '@media (prefers-reduced-motion: reduce) {',
    '  ::view-transition-group(*),',
    '  ::view-transition-old(*),',
    '  ::view-transition-new(*) {',
    '    animation: none !important;',
    '  }',
    '}',
    ''
  )

  // Pure CSS: `@view-transition` degrades to a no-op on unsupported browsers (plain instant
  // navigation), and `view-transition-name` matching needs no JS trigger for cross-document
  // navigation (unlike the SPA `document.startViewTransition` toggle in smart-animate/
  // view-transitions.ts) — so there's nothing for a progressive-enhancement script to do.
  return { css: lines.join('\n'), js: '' }
}
