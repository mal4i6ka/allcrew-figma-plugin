/**
 * Components → partials (T3.2, docs/research/04-figma-to-django-templates.md §2–3): a
 * ComponentNode's IR subtree becomes its own template fragment (a "partial"), and a page's
 * instance-refs become `{% include "partials/…" with … only %}` calls instead of the inlined
 * markup T3.1's `html-emitter` produces. Targets the "vanilla" backend the research doc
 * recommends as the zero-dependency baseline (`{% include with … only %}`); the `partialdef`/
 * django-cotton backends are noted there as later options and are out of this task's scope.
 *
 * `componentPropertyReferences` (docs §2.2) drives where each Django construct lands:
 *   - `characters` (TEXT)     → `{{ var }}` in place of the bound text node's literal characters
 *   - `visible` (BOOLEAN)     → `{% if var %}…{% endif %}` around the bound node
 *   - `mainComponent` (INSTANCE_SWAP) → `{% include var %}` instead of a fixed partial path
 *   - a component's `VARIANT` properties → a BEM modifier class on the component root
 *
 * Instance overrides become include params two ways: `componentProperties` (the design's own
 * properties) map straight to `key=value`; text edited on an instance *without* a TEXT property
 * (docs §2.2 "overrides инстансов") are detected by diffing characters against the main
 * component (matched by the `<instanceId>;<mainNodeId>` id convention) and passed as a
 * `text_<id>` param — but only for components that some instance actually overrides
 * (`collectOverriddenTextNodeIds`), so components nobody overrides keep T3.1's exact-fidelity
 * multi-segment `<span>` rendering.
 *
 * T4.3/E4: literal text nodes (the multi-segment `<span>` rendering above) go through
 * `html-emitter`'s `renderTextSpans`, so they carry `{% translate %}`/`{% blocktranslate %}`
 * exactly like the single-page emitter — every partial/page gets its own `{% load i18n %}`
 * since `{% load %}` doesn't propagate across `{% extends %}`/`{% include %}`.
 */

import type {
  IrComponentDef,
  IrComponentPropertyDef,
  IrComponentPropertyValue,
  IrContainerNode,
  IrInstanceRefNode,
  IrNode,
  IrTextNode,
} from './ir.ts'
import { groupComponentVariantSets, toClassName, type DjangoNodeSource } from './css-emitter.ts'
import {
  createHeadingState,
  escapeHtml,
  NO_LANDMARK_ANCESTRY,
  renderAssetLeaf,
  renderBackgroundVideoLayer,
  renderTextBlock,
  resolveContainerTag,
  resolveHeadingTag,
  wrapNavigate,
  type HeadingState,
  type LandmarkAncestry,
} from './html-emitter.ts'
import { segmentClassName } from './text-styles.ts'
import {
  matchBootstrapComponent,
  partForName,
  partKeyForName,
  type BootstrapCollapseSpec,
  type BootstrapComponentMatch,
  type BootstrapPartSpec,
} from './bootstrap/components.ts'

/** Maps a Figma component/property display name to a Django-identifier-safe variable name. */
function toVarName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return slug || 'prop'
}

/** Sanitizes a Figma node id (`"1:23"`, `"comp:1;icon"`) into a path-safe fragment. Unlike the
 * display-name slug, this never changes when a designer renames a layer — it's the part that
 * keeps a partial's identity stable across regenerations (T3.3, docs §4.4 point 7). */
function idSlug(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Internal marker stamped by `collectComponents`'s set-collapsing pass (below) onto every
 * member of a component set it decided to merge into ONE partial — not part of the public IR
 * shape, so it's only ever read through `isCollapsedSetMember`. `partialPath` keys a marked
 * member off the shared set name instead of its own id: every variant of a collapsed set must
 * resolve to the identical partial path, regardless of which specific variant an instance's
 * `componentKey` happens to reference. */
const COLLAPSED_SET_MEMBER = Symbol('collapsedSetMember')

function markCollapsedSetMember(node: IrContainerNode): IrContainerNode {
  return { ...node, [COLLAPSED_SET_MEMBER]: true } as unknown as IrContainerNode
}

function isCollapsedSetMember(node: IrContainerNode): boolean {
  return (node as unknown as Record<symbol, boolean>)[COLLAPSED_SET_MEMBER] === true
}

/** Maps a component to its partial's project-relative path: a human-readable name slug plus a
 * node-id suffix. The id suffix is what makes the path stable by node id — a rename only shifts
 * the readable part, so regeneration (`regenerate.ts`) still finds the right file via its
 * `GENERATED` marker even if this exact path drifts.
 *
 * A collapsed component-set member (`isCollapsedSetMember`, set by `collectComponents`) is the
 * one exception: every variant of the set must resolve to this SAME path since an instance can
 * reference any one of them, so the slug there is the shared set name alone — there's no single
 * node id that identifies "the set" itself, only one that identifies one of its variants. */
export function partialPath(component: IrContainerNode): string {
  if (isCollapsedSetMember(component)) {
    const setName = component.component!.setName!.trim()
    const slug = setName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    return `components/${slug || 'component'}.html`
  }
  const slug = component.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `components/${slug || 'component'}--${idSlug(component.id)}.html`
}

/** Django's unquoted `{{ navMap.<slug> }}` lookup only allows `[a-zA-Z0-9_.]` — `idSlug`'s
 * dashes would break the dotted lookup, so this is underscore-based instead. The `nav_` prefix
 * keeps the key a stable, readable identifier distinct from any other context variable. */
export function navMapKey(id: string): string {
  return `nav_${id.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`
}

/** `nameOverride` lets a breakpoint group name the merged page by its shared slug ("One Main")
 * instead of the widest frame's full name ("One Main / 1920px"). */
function pageTemplatePath(page: IrContainerNode, nameOverride?: string): string {
  const name = nameOverride ?? page.name
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `pages/${slug || 'page'}--${idSlug(page.id)}.html`
}

function textOverrideVarName(mainComponentNodeId: string): string {
  return `text_${mainComponentNodeId.replace(/[^a-zA-Z0-9]+/g, '_')}`
}

/** Escapes a value for use inside a single-quoted or double-quoted Django template string literal. */
function escapeDjangoString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function djangoStringLiteral(value: string): string {
  return `"${escapeDjangoString(value)}"`
}

/** Recursively finds every `container` node with a non-null `component` (i.e. every serialized
 * ComponentNode) inside `nodes`, then collapses each structurally-uniform component set's
 * variants down to one shared partial (`collapseComponentSetVariants`) — an N-variant set no
 * longer produces N near-identical partial files, just one, with the variant deltas expressed as
 * CSS modifier classes (css-emitter.ts's `emitComponentVariantModifierCss`) instead of duplicated
 * markup. */
export function collectComponents(nodes: readonly IrNode[]): IrContainerNode[] {
  const found: IrContainerNode[] = []
  const visit = (node: IrNode): void => {
    if (node.type === 'container' && node.component) found.push(node)
    if ('children' in node) node.children.forEach(visit)
  }
  nodes.forEach(visit)
  return collapseComponentSetVariants(found)
}

/** Groups `flat` via `groupComponentVariantSets` (css-emitter.ts — shared with the variant-
 * modifier CSS pass so both agree on which sets collapse and which member is the default) and
 * marks EVERY member of a structurally-uniform set as collapsed, default variant last.
 *
 * Keeping every member (rather than dropping the non-default ones) means `buildComponentRegistry`
 * needs no changes of its own: its existing per-component loop still registers every variant's
 * own `key`/`id` against the shared path (now identical for the whole set — see `partialPath`).
 * Ordering the default last means `emitDjangoProject`'s `partials[partialPath(component)] = …`
 * loop (index.ts, outside this module) ends up with the default's markup as the final write for
 * that shared path — the earlier writes for the other members still render (and get discarded), a
 * deliberate small waste that keeps every caller of `collectComponents` completely unaware
 * collapsing happens at all.
 *
 * A structurally divergent set (different child count/types across variants — `uniform: false`)
 * can't share one partial body safely, so its members pass through unmarked: pre-collapse
 * one-partial-per-variant behavior, unchanged. */
function collapseComponentSetVariants(flat: readonly IrContainerNode[]): IrContainerNode[] {
  const setsByName = new Map(groupComponentVariantSets(flat).map((set) => [set.setName, set]))
  const collapsedSetNames = new Set<string>()
  const result: IrContainerNode[] = []
  for (const component of flat) {
    const setName = component.component?.setName?.trim()
    if (!setName) {
      result.push(component)
      continue
    }
    if (collapsedSetNames.has(setName)) continue // this set's whole group was already emitted
    collapsedSetNames.add(setName)
    const set = setsByName.get(setName)!
    if (!set.uniform || set.members.length < 2) {
      result.push(...set.members)
      continue
    }
    const rest = set.members.filter((member) => member !== set.defaultVariant)
    result.push(...rest.map(markCollapsedSetMember), markCollapsedSetMember(set.defaultVariant))
  }
  return result
}

export interface ComponentRegistry {
  readonly pathByComponentKey: ReadonlyMap<string, string>
  readonly nodeByComponentId: ReadonlyMap<string, IrContainerNode>
}

/** Indexes every known component by both its `key` (what instances carry) and its node `id`
 * (what INSTANCE_SWAP `componentProperties` values reference), so instances/swaps resolve to a
 * partial path regardless of which identifier Figma exposed at that call site. */
export function buildComponentRegistry(components: readonly IrContainerNode[]): ComponentRegistry {
  const pathByComponentKey = new Map<string, string>()
  const nodeByComponentId = new Map<string, IrContainerNode>()
  for (const component of components) {
    const path = partialPath(component)
    if (component.component) pathByComponentKey.set(component.component.key, path)
    nodeByComponentId.set(component.id, component)
  }
  return { pathByComponentKey, nodeByComponentId }
}

/** Does this subtree contain any TEXT node? Used to tell a real inline component (a Button with a
 * label, a Navbar, a Card — all carry text) from a decorative GLYPH instance (vector/image only)
 * whose `componentSetName` merely collides with a Bootstrap component name. Only the former should
 * be inline-recognized; recognizing a glyph as e.g. `Range`/`Table` would drop or misparent it. */
function subtreeHasText(node: IrNode): boolean {
  if (node.type === 'text') return true
  if ('children' in node) return node.children.some(subtreeHasText)
  return false
}

function findTextNodeById(node: IrNode, id: string): IrTextNode | null {
  if (node.id === id) return node.type === 'text' ? node : null
  if ('children' in node) {
    for (const child of node.children) {
      const found = findTextNodeById(child, id)
      if (found) return found
    }
  }
  return null
}

/** An instance descendant's id is `<instanceId>;<mainComponentNodeId>` (nested instances repeat
 * the pattern) — the suffix after the last `;` is the id to match against the main component's
 * own IR tree. */
function mainComponentNodeId(instanceDescendantId: string): string {
  const index = instanceDescendantId.lastIndexOf(';')
  return index === -1 ? instanceDescendantId : instanceDescendantId.slice(index + 1)
}

/** Diffs `instanceNode`'s text descendants against `mainComponent`'s, skipping any node already
 * covered by a TEXT `componentPropertyReferences` — those already flow through `componentProperties`.
 * Returns `{ <mainComponentNodeId>: <instance's characters> }` for every node whose text actually differs. */
function collectTextOverrides(instanceNode: IrNode, mainComponent: IrContainerNode): Record<string, string> {
  const overrides: Record<string, string> = {}
  const visit = (node: IrNode): void => {
    if (node.type === 'text' && !node.componentPropertyReferences.characters) {
      const mainId = mainComponentNodeId(node.id)
      const mainTextNode = findTextNodeById(mainComponent, mainId)
      if (mainTextNode && mainTextNode.characters !== node.characters) overrides[mainId] = node.characters
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(instanceNode)
  return overrides
}

/** Whole-document pass (docs §2.2 "overrides инстансов"): finds, per component, which of its own
 * text nodes *some* instance overrides without a TEXT property. Feed the result into
 * `emitComponentPartial` so only genuinely-overridden nodes trade their multi-segment `<span>`
 * rendering for a `{{ text_<id>|default:"…" }}` placeholder — components no instance overrides
 * keep T3.1's exact-fidelity rendering untouched. */
export function collectOverriddenTextNodeIds(
  roots: readonly IrNode[],
  registry: ComponentRegistry
): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>()
  const visit = (node: IrNode): void => {
    if (node.type === 'instance-ref' && node.componentId) {
      const mainComponent = registry.nodeByComponentId.get(node.componentId)
      if (mainComponent) {
        const overrides = collectTextOverrides(node, mainComponent)
        const ids = result.get(node.componentId) ?? new Set<string>()
        Object.keys(overrides).forEach((id) => ids.add(id))
        if (ids.size > 0) result.set(node.componentId, ids)
      }
    }
    if ('children' in node) node.children.forEach(visit)
  }
  roots.forEach(visit)
  return result
}

function componentPropertyLiteral(value: IrComponentPropertyValue, registry: ComponentRegistry): string {
  if (value.type === 'BOOLEAN') return value.value ? 'True' : 'False'
  if (value.type === 'INSTANCE_SWAP') {
    const path = registry.nodeByComponentId.get(value.value)
    return djangoStringLiteral(path ? partialPath(path) : value.value)
  }
  return djangoStringLiteral(value.value)
}

/** Builds the `{% include … with %}` params for an instance: its `componentProperties` first
 * (docs §2.2, point 1), then any bare-text overrides (point 2). */
function buildIncludeParams(node: IrInstanceRefNode, registry: ComponentRegistry): string[] {
  const params = Object.entries(node.componentProperties).map(
    ([name, value]) => `${toVarName(name)}=${componentPropertyLiteral(value, registry)}`
  )

  const mainComponent = node.componentId ? registry.nodeByComponentId.get(node.componentId) : undefined
  if (mainComponent) {
    const textOverrides = collectTextOverrides(node, mainComponent)
    for (const [mainId, characters] of Object.entries(textOverrides)) {
      params.push(`${textOverrideVarName(mainId)}=${djangoStringLiteral(characters)}`)
    }
  }

  return params
}

function renderIncludeTag(path: string, params: readonly string[]): string {
  const withClause = params.length > 0 ? ` with ${params.join(' ')}` : ''
  return `{% include "${path}"${withClause} only %}`
}

/** VARIANT properties become a BEM modifier appended to the component root's class, e.g.
 * `btn btn--{{ size|default:'md' }}` (docs §2.2 example). */
function variantModifierClasses(className: string, component: IrComponentDef): string[] {
  return component.properties
    .filter((prop): prop is IrComponentPropertyDef & { type: 'VARIANT' } => prop.type === 'VARIANT')
    .map((prop) => {
      const varName = toVarName(prop.name)
      const fallback = typeof prop.defaultValue === 'string' ? prop.defaultValue : String(prop.defaultValue)
      return `${className}--{{ ${varName}|default:'${fallback}' }}`
    })
}

function rootClassAttr(className: string, component: IrComponentDef | null): string {
  if (!component) return className
  return [className, ...variantModifierClasses(className, component)].join(' ')
}

interface PartialCtx {
  readonly sceneNodesById: ReadonlyMap<string, DjangoNodeSource>
  readonly registry: ComponentRegistry
  readonly overriddenTextNodeIds: ReadonlySet<string>
  readonly navMap: ReadonlyMap<string, string>
  /** REFORM phase 7: components fidelity — recognized components render native Bootstrap markup. */
  readonly bootstrapComponents?: boolean
  /** REFORM wave 2: the matched component's named parts — container layers whose name matches
   * a key (`Header`, `Item`, `Menu`…) get the part's tag/classes at any subtree depth. */
  readonly bootstrapParts?: Record<string, BootstrapPartSpec>
  /** REFORM wave 3c/3f: node id → behavioral wiring (extra classes/attrs the emitter injects to
   * link toggles↔targets for collapse, tabs, and carousel — all via Bootstrap's data API). */
  readonly wiring?: ReadonlyMap<string, WiringEntry>
  /** REFORM phase 13 (P1c): render component-property/override-bound TEXT as its literal Figma
   * characters instead of `{{ var }}`. Set only when recognizing a component INLINE ON A PAGE —
   * a page has no `{% include %}` to supply the label, so an unbound `{{ var }}` renders empty
   * (the label visually vanishes). Partials leave this unset so their labels stay parametric. */
  readonly literalText?: boolean
  /** Landmark kinds already emitted on the path from the partial's own root to this node — see
   * `html-emitter.ts`'s `resolveContainerTag`. Never promotes a node to `<section>` inside a
   * partial (no page-root concept here — a component is a reusable fragment, not a page). */
  readonly ancestry: LandmarkAncestry
  /** Shared H1-uniqueness tracker for the document this partial ultimately renders into — a
   * fresh one per `emitComponentPartial` call (its own file), or the ambient page's own state
   * when recognized inline on a page (REFORM phase 12/13). */
  readonly headingState: HeadingState
}

/** Generic wiring for a node: classes/attributes the emitter appends so Bootstrap's data API
 * drives the behavior (collapse toggle/target, tab link/pane, carousel root/slide/control). Each
 * wiring pre-pass computes these; the renderer just merges them in — it knows no mechanism. */
interface WiringEntry {
  addClasses?: string[]
  /** Leading-spaced attribute string, e.g. ` data-bs-toggle="tab" data-bs-target="#p"`. */
  addAttrs?: string
  /** REFORM phase 12: extra `{% include with %}` params for an item INSTANCE (`collapse_id="…"`,
   * `pane_id="…"`) — the parent-minted unique ids a reused item partial reads as `{{ … }}`. */
  addIncludeParams?: string[]
}

function mergeWiringEntry(map: Map<string, WiringEntry>, nodeId: string, entry: WiringEntry): void {
  const existing = map.get(nodeId)
  if (!existing) {
    map.set(nodeId, {
      addClasses: entry.addClasses ? [...entry.addClasses] : undefined,
      addAttrs: entry.addAttrs,
      addIncludeParams: entry.addIncludeParams ? [...entry.addIncludeParams] : undefined,
    })
    return
  }
  if (entry.addClasses) existing.addClasses = [...(existing.addClasses ?? []), ...entry.addClasses]
  if (entry.addAttrs) existing.addAttrs = (existing.addAttrs ?? '') + entry.addAttrs
  if (entry.addIncludeParams) existing.addIncludeParams = [...(existing.addIncludeParams ?? []), ...entry.addIncludeParams]
}

/** Depth-first search for the first descendant whose part key is `partKey`, without crossing
 * into a nested component (instance-ref renders its own partial) or — when `scopeKey` is set —
 * into a nested scope of the same kind (e.g. an accordion item inside an item). */
function findPartNode(root: IrNode, partKey: string, scopeKey?: string): IrContainerNode | null {
  const search = (node: IrNode, isRoot: boolean): IrContainerNode | null => {
    if (!isRoot && node.type === 'instance-ref') return null
    if (!isRoot && scopeKey && partKeyForName(node.name) === scopeKey) return null
    if (!isRoot && node.type === 'container' && partKeyForName(node.name) === partKey) return node
    if ('children' in node) {
      for (const child of node.children) {
        const found = search(child, false)
        if (found) return found
      }
    }
    return null
  }
  return search(root, true)
}

/** Collects every scope-root node (nodes whose part key is `scopeKey`) under `root`, not
 * descending into a nested component or a nested scope of the same kind. */
function findScopeNodes(root: IrContainerNode, scopeKey: string): IrContainerNode[] {
  const out: IrContainerNode[] = []
  const walk = (node: IrNode, isRoot: boolean): void => {
    if (!isRoot && node.type === 'instance-ref') return
    if (!isRoot && node.type === 'container' && partKeyForName(node.name) === scopeKey) {
      out.push(node)
      return // don't descend — nested same-key scopes are not paired separately
    }
    if ('children' in node) for (const child of node.children) walk(child, false)
  }
  walk(root, true)
  return out
}

/** All descendant container nodes whose part key is `partKey`, in document order, not crossing
 * into a nested component — used for order-based pairing (tabs) and enumeration (carousel slides). */
function findAllPartNodes(root: IrContainerNode, partKey: string): IrContainerNode[] {
  const out: IrContainerNode[] = []
  const walk = (node: IrNode, isRoot: boolean): void => {
    if (!isRoot && node.type === 'instance-ref') return
    if (!isRoot && node.type === 'container' && partKeyForName(node.name) === partKey) out.push(node)
    if ('children' in node) for (const child of node.children) walk(child, false)
  }
  walk(root, true)
  return out
}

/** Collapse wiring (Collapse, Accordion, responsive Navbar): per pairing scope, the toggle gets
 * `data-bs-toggle="collapse"` at a unique id, the target gets that id + the collapse class. */
function buildCollapseWiring(map: Map<string, WiringEntry>, root: IrContainerNode, spec: BootstrapCollapseSpec): void {
  if (spec.idParam) {
    // REFORM phase 12: param-driven collapse for an ITEM sub-component's own partial (AccordionItem).
    // The id is the `{{ idParam }}` template var the parent mints per instance, so N reused item
    // partials never collide; `parentParam` (guarded) points data-bs-parent at the parent id.
    const toggle = findPartNode(root, spec.toggle)
    const target = findPartNode(root, spec.target)
    if (!toggle || !target) return
    const idRef = `{{ ${spec.idParam} }}`
    const parentAttr = spec.parentParam
      ? `{% if ${spec.parentParam} %} data-bs-parent="#{{ ${spec.parentParam} }}"{% endif %}`
      : ''
    mergeWiringEntry(map, target.id, {
      addClasses: spec.targetClass.split(/\s+/).filter(Boolean),
      addAttrs: ` id="${idRef}"${parentAttr}`,
    })
    mergeWiringEntry(map, toggle.id, {
      addClasses: spec.toggleCollapsedClass ? [spec.toggleCollapsedClass] : [],
      addAttrs: ` data-bs-toggle="collapse" data-bs-target="#${idRef}" aria-expanded="false" aria-controls="${idRef}"`,
    })
    return
  }
  const scopeRoots = spec.scope ? findScopeNodes(root, spec.scope) : [root]
  for (const scopeRoot of scopeRoots) {
    const toggle = findPartNode(scopeRoot, spec.toggle, spec.scope)
    const target = findPartNode(scopeRoot, spec.target, spec.scope)
    if (!toggle || !target) continue
    const domId = `${toClassName(target.id)}-collapse`
    mergeWiringEntry(map, target.id, { addClasses: spec.targetClass.split(/\s+/).filter(Boolean), addAttrs: ` id="${domId}"` })
    mergeWiringEntry(map, toggle.id, {
      addAttrs: ` data-bs-toggle="collapse" data-bs-target="#${domId}" aria-expanded="false" aria-controls="${domId}"`,
    })
  }
}

/** Tabs wiring (REFORM wave 3f): order-pair the i-th `toggle` (nav-link) with the i-th `pane`
 * (tab-pane) by document order; each link points `data-bs-toggle="tab"` at its pane's unique id,
 * and the first link/pane are `active`. */
function buildTabsWiring(map: Map<string, WiringEntry>, root: IrContainerNode, spec: { toggle: string; pane: string }): void {
  const toggles = findAllPartNodes(root, spec.toggle)
  const panes = findAllPartNodes(root, spec.pane)
  const count = Math.min(toggles.length, panes.length)
  for (let i = 0; i < count; i++) {
    const paneId = `${toClassName(panes[i].id)}-pane`
    const first = i === 0
    mergeWiringEntry(map, toggles[i].id, {
      addClasses: first ? ['active'] : [],
      addAttrs:
        ` data-bs-toggle="tab" data-bs-target="#${paneId}" aria-controls="${paneId}"` +
        (first ? ' aria-selected="true"' : ' aria-selected="false"'),
    })
    mergeWiringEntry(map, panes[i].id, { addClasses: first ? ['show', 'active'] : [], addAttrs: ` id="${paneId}"` })
  }
}

/** Carousel wiring (REFORM wave 3f): the root gets a unique id, the first `slide` is `active`, and
 * each prev/next control targets the root id with its `data-bs-slide` (set by the part spec). */
function buildCarouselWiring(
  map: Map<string, WiringEntry>,
  root: IrContainerNode,
  spec: { slide: string; prev?: string; next?: string }
): void {
  const rootId = `${toClassName(root.id)}-carousel`
  mergeWiringEntry(map, root.id, { addAttrs: ` id="${rootId}"` })
  findAllPartNodes(root, spec.slide).forEach((slide, i) => {
    if (i === 0) mergeWiringEntry(map, slide.id, { addClasses: ['active'] })
  })
  for (const controlKey of [spec.prev, spec.next]) {
    if (!controlKey) continue
    for (const control of findAllPartNodes(root, controlKey)) {
      mergeWiringEntry(map, control.id, { addAttrs: ` data-bs-target="#${rootId}"` })
    }
  }
}

/** REFORM phase 12: all descendant INSTANCE-refs whose resolved Bootstrap kind is `kind`, in
 * document order, not descending into an instance. The instance counterpart of `findAllPartNodes`
 * — used to pair/mint ids for a parent composed of recognized item instances. */
function findAllInstanceRefs(root: IrContainerNode, registry: ComponentRegistry, kind: string): IrInstanceRefNode[] {
  const out: IrInstanceRefNode[] = []
  const walk = (node: IrNode): void => {
    if (node.type === 'instance-ref') {
      const main = node.componentId ? registry.nodeByComponentId.get(node.componentId) : undefined
      const mkind = main?.component
        ? matchBootstrapComponent(main.component.setName ?? main.name, main.component, toVarName)?.kind
        : undefined
      if (mkind === kind) out.push(node)
      return // never descend into an instance's own subtree
    }
    if ('children' in node) for (const child of node.children) walk(child)
  }
  for (const child of root.children) walk(child)
  return out
}

/** REFORM phase 12: a parent (Accordion) composed of collapse item instances mints a unique
 * `idParam` per item + a shared `parentParam` (also stamped on the parent root), passed as
 * `{% include with %}` params so each reused item partial gets a unique, wired collapse id. */
function buildItemIdParams(
  map: Map<string, WiringEntry>,
  root: IrContainerNode,
  spec: NonNullable<BootstrapComponentMatch['itemInstanceIdParams']>,
  registry: ComponentRegistry
): void {
  const items = findAllInstanceRefs(root, registry, spec.childKind)
  if (items.length === 0) return
  const parentId = `${toClassName(root.id)}-accordion`
  if (spec.parentParam) mergeWiringEntry(map, root.id, { addAttrs: ` id="${parentId}"` })
  for (const item of items) {
    const collapseId = `${toClassName(item.id)}-collapse`
    const params = [`${spec.idParam}="${collapseId}"`]
    if (spec.parentParam) params.push(`${spec.parentParam}="${parentId}"`)
    mergeWiringEntry(map, item.id, { addIncludeParams: params })
  }
}

/** REFORM phase 12: a Tabs parent composed of item instances zips the i-th toggle-kind instance
 * with the i-th pane-kind instance, minting one shared `pane_id` per pair (the toggle points its
 * `data-bs-target` at it, the pane uses it as its own id). Order-paired, truncated to the min. */
function buildTabInstanceParams(
  map: Map<string, WiringEntry>,
  root: IrContainerNode,
  spec: NonNullable<BootstrapComponentMatch['tabItems']>,
  registry: ComponentRegistry
): void {
  const toggles = findAllInstanceRefs(root, registry, spec.toggle)
  const panes = findAllInstanceRefs(root, registry, spec.pane)
  const count = Math.min(toggles.length, panes.length)
  for (let i = 0; i < count; i++) {
    const paneId = `${toClassName(panes[i].id)}-pane`
    mergeWiringEntry(map, toggles[i].id, { addIncludeParams: [`tab_id="${paneId}"`] })
    mergeWiringEntry(map, panes[i].id, { addIncludeParams: [`pane_id="${paneId}"`] })
  }
}

/** Builds the full behavioral wiring for a matched component from whichever specs it declares.
 * `registry` (when given) enables the phase-12 instance-composition passes (Accordion/Tabs made of
 * recognized item instances); without it those no-op, so inline-authored components are unaffected. */
function buildWiring(
  root: IrContainerNode,
  match: BootstrapComponentMatch,
  registry?: ComponentRegistry
): ReadonlyMap<string, WiringEntry> | undefined {
  const map = new Map<string, WiringEntry>()
  if (match.collapse) buildCollapseWiring(map, root, match.collapse)
  if (match.tabs) buildTabsWiring(map, root, match.tabs)
  if (match.carousel) buildCarouselWiring(map, root, match.carousel)
  if (registry && match.itemInstanceIdParams) buildItemIdParams(map, root, match.itemInstanceIdParams, registry)
  if (registry && match.tabItems) buildTabInstanceParams(map, root, match.tabItems, registry)
  return map.size > 0 ? map : undefined
}

/** Wraps `rendered` in `{% if %}` when `node` is the BOOLEAN-bound node (`componentPropertyReferences.visible`).
 * REFORM phase 13 (P1c sibling): on a page (`literalText`) there is no include to bind the flag, so an
 * unbound `{% if l_ico %}` renders empty and the child vanishes. But a hidden child is already ABSENT
 * from the IR — `serializeNode` drops `visible === false` nodes — so any child that reached here IS
 * visible on this instance. Render it directly (unwrapped) instead of gating it. Partials leave
 * `literalText` unset so their BOOLEAN nodes stay parametric behind `{% if %}`. */
function wrapVisible(node: IrNode, rendered: string, indent: string, literalText: boolean): string {
  const propName = node.componentPropertyReferences.visible
  if (!propName || literalText) return rendered
  return `${indent}{% if ${toVarName(propName)} %}\n${rendered}\n${indent}{% endif %}`
}

function renderPartialText(node: IrTextNode, className: string, ctx: PartialCtx, indent: string): string {
  const headingTag = resolveHeadingTag(node.name, ctx.headingState)

  // On a page (inline recognition) there is no include to bind a label — render the literal Figma
  // characters, exactly as renderPageNode's own text path does, so the text doesn't vanish.
  if (ctx.literalText) return renderTextBlock(node, ctx.sceneNodesById.get(node.id), className, indent, headingTag)

  const propName = node.componentPropertyReferences.characters
  if (propName) {
    const varName = toVarName(propName)
    const tag = headingTag ?? 'p'
    return `${indent}<${tag} class="${className}"><span class="${segmentClassName(className, 0)}">{{ ${varName} }}</span></${tag}>`
  }

  if (ctx.overriddenTextNodeIds.has(node.id)) {
    const varName = textOverrideVarName(node.id)
    const fallback = escapeDjangoString(node.characters)
    const tag = headingTag ?? 'p'
    return `${indent}<${tag} class="${className}"><span class="${segmentClassName(className, 0)}">{{ ${varName}|default:"${fallback}" }}</span></${tag}>`
  }

  return renderTextBlock(node, ctx.sceneNodesById.get(node.id), className, indent, headingTag)
}

function renderPartialInstanceRef(node: IrInstanceRefNode, className: string, ctx: PartialCtx, indent: string): string {
  const swapProp = node.componentPropertyReferences.mainComponent
  // REFORM phase 13 (P1c sibling): on a page (`literalText`) an INSTANCE_SWAP var is unbound — no
  // include supplies it — so `{% include l_ico2 %}` renders nothing and the icon vanishes. Skip the
  // parametric branch and fall through to the instance's ACTUAL resolved swap: its own componentKey
  // partial if that component was exported, else its concrete child subtree (the real icon that
  // `serializeChildren` captured on this instance). Partials keep the parametric `{% include var %}`.
  if (swapProp && !ctx.literalText) {
    const varName = toVarName(swapProp)
    const fallbackComponent = node.componentId ? ctx.registry.nodeByComponentId.get(node.componentId) : undefined
    const expr = fallbackComponent ? `${varName}|default:'${partialPath(fallbackComponent)}'` : varName
    return `${indent}{% include ${expr} %}`
  }

  const path = node.componentKey ? ctx.registry.pathByComponentKey.get(node.componentKey) : undefined
  if (path) {
    // Append any parent-minted id params (phase 12) for this instance to its own componentProperties.
    const params = buildIncludeParams(node, ctx.registry)
    const extra = ctx.wiring?.get(node.id)?.addIncludeParams
    if (extra) params.push(...extra)
    return `${indent}${renderIncludeTag(path, params)}`
  }

  // REFORM phase 13: an inline instance with no registered partial (its main def lives outside the
  // export) is still recognized as a Bootstrap component — native tag + classes + data-API wiring —
  // exactly like the page emitter does. Without this, a recognized container (Navbar, Card…) would
  // render a Button dropped inside it as a bare `<div>`, silently losing its `.btn` look and hover.
  // Recognition thus survives at any nesting depth, not just on unrecognized-parent page nodes.
  if (ctx.bootstrapComponents) {
    const recognizable = recognizableContainerOnPage(node, ctx.registry)
    const comp = recognizable?.component
    const match = comp ? matchBootstrapComponent(comp.setName ?? recognizable!.name, comp, toVarName) : null
    // Guard (P2f): recognize ONLY a real UI component, not a decorative glyph whose name happens to
    // collide with a Bootstrap component (an icon named "Range"/"Table"/… would otherwise be wrapped
    // in wrong/void native markup — a void match with children even DROPS the glyph). A real component
    // carries a text label; a glyph is vector/image only. Also never route a node with children
    // through a void match. Fails safe to the bare `<div>` + children path below (the correct icon).
    if (recognizable && match && subtreeHasText(node) && !(match.void && node.children.length > 0)) {
      // A nested recognized component opens its OWN part scope + wiring (parts never bleed across
      // component boundaries); keep the ambient text-override set so bound labels still resolve.
      const childCtx: PartialCtx = { ...ctx, bootstrapParts: match.parts, wiring: buildWiring(recognizable, match, ctx.registry) }
      return renderPartialContainer(recognizable, className, childCtx, indent)
    }
  }

  const { tag, attrs, landmarkKind } = resolveContainerTag(node, ctx.ancestry, false)
  const childCtx: PartialCtx = landmarkKind ? { ...ctx, ancestry: new Set([...ctx.ancestry, landmarkKind]) } : ctx
  const bgVideo = renderBackgroundVideoLayer(node, `${indent}  `)
  if (node.children.length === 0 && !bgVideo) return `${indent}<${tag}${attrs} class="${className}"></${tag}>`
  const inner = node.children.map((child) => renderPartialNode(child, childCtx, `${indent}  `)).join('\n')
  const parts = [bgVideo, inner].filter(Boolean)
  return `${indent}<${tag}${attrs} class="${className}">\n${parts.join('\n')}\n${indent}</${tag}>`
}

function renderPartialContainer(node: IrContainerNode, className: string, ctx: PartialCtx, indent: string): string {
  // REFORM phase 7 / B3: a recognized Bootstrap component KEEPS its custom classes (our CSS
  // still carries the exact Figma look, loaded after bootstrap.css) and adds the native tag,
  // Bootstrap classes (variant prop threaded as a template expression) and attributes.
  const bootstrap =
    ctx.bootstrapComponents && node.component
      ? matchBootstrapComponent(node.component.setName ?? node.name, node.component, toVarName)
      : null
  // REFORM wave 2: inside a matched component, a container layer named like a part
  // (`Header`, `Item`, `Menu`…) renders with the part's tag/classes/attributes.
  const part = !node.component && ctx.bootstrapComponents ? partForName(ctx.bootstrapParts, node.name) : null
  // Landmark/button/section semantics (docs items 1/3) apply ONLY when neither Bootstrap
  // mechanism has an opinion about this node's name — a Card's "Header"/"Footer" part or an
  // Accordion's "Header" toggle are Bootstrap-semantic regions, not page landmarks, even though
  // they share the English word. `false`: a partial is a reusable fragment, never a page root,
  // so it never promotes an unnamed child to `<section>`.
  const semantic = !bootstrap && !part ? resolveContainerTag(node, ctx.ancestry, false) : null
  const childCtx: PartialCtx = semantic?.landmarkKind ? { ...ctx, ancestry: new Set([...ctx.ancestry, semantic.landmarkKind]) } : ctx
  // REFORM wave 3c/3f: behavioral wiring — extra classes/attrs that link toggles↔targets for
  // collapse, tabs, and carousel via Bootstrap's data API (the pre-passes decided them).
  const wiring = ctx.wiring?.get(node.id)
  // Theme phase A: on a page (literalText) BEM variant modifiers (`nX--{{ size|default:'md' }}`)
  // are dead weight — no CSS targets them and nothing binds the vars — so the root keeps only its
  // node class; the Bootstrap variant classes below carry the styling role instead.
  const joinedClasses = [rootClassAttr(className, ctx.literalText ? null : node.component), ...(bootstrap?.classes ?? []), ...(part?.classes ?? []), ...(wiring?.addClasses ?? [])]
    .filter(Boolean)
    .join(' ')
  // Theme phase A: on a page nothing binds the variant vars — fold `{{ v|default:'x'|lower }}` to
  // the concrete class so page markup reads `btn btn-primary`, not a dead template expression.
  const classAttr = ctx.literalText ? foldDefaultClassExprs(joinedClasses) : joinedClasses
  const tag = bootstrap?.tag ?? part?.tag ?? semantic?.tag ?? 'div'
  const attrs = (bootstrap?.attributes ?? part?.attributes ?? semantic?.attrs ?? '') + (wiring?.addAttrs ?? '')
  // REFORM wave 3: a void form control (`<input>`) has no children and no closing tag —
  // anything a designer nested inside it (there shouldn't be) is dropped.
  if (bootstrap?.void || part?.void) return `${indent}<${tag} class="${classAttr}"${attrs}>`
  // REFORM wave 3d: static markup the match appends inside (e.g. an Alert's dismiss button).
  const appended = bootstrap?.appendHtml ? `${indent}  ${bootstrap.appendHtml}` : ''
  const bgVideo = renderBackgroundVideoLayer(node, `${indent}  `)
  if (node.children.length === 0 && !bgVideo && !appended) return `${indent}<${tag} class="${classAttr}"${attrs}></${tag}>`
  const inner = node.children.map((child) => renderPartialNode(child, childCtx, `${indent}  `)).join('\n')
  const parts = [bgVideo, inner, appended].filter(Boolean)
  return `${indent}<${tag} class="${classAttr}"${attrs}>\n${parts.join('\n')}\n${indent}</${tag}>`
}

function renderPartialNode(node: IrNode, ctx: PartialCtx, indent: string): string {
  const className = toClassName(node.id)
  const rendered = (() => {
    switch (node.type) {
      case 'text':
        return renderPartialText(node, className, ctx, indent)
      case 'image':
      case 'vector':
        return renderAssetLeaf(node, indent)
      case 'instance-ref':
        return renderPartialInstanceRef(node, className, ctx, indent)
      case 'container':
        return renderPartialContainer(node, className, ctx, indent)
    }
  })()
  return wrapVisible(node, wrapNavigate(node, rendered, indent, ctx.navMap), indent, ctx.literalText ?? false)
}

/** Emits a ComponentNode's IR subtree as a standalone Django partial fragment (no `<html>`/`<head>`
 * wrapper — it's meant to be `{% include %}`-ed). `overriddenTextNodeIds` should come from
 * `collectOverriddenTextNodeIds` for the whole document being exported. `{% load %}` only applies
 * to the template file it appears in (docs/research/03-i18n-figma-django.md §2.2), so every
 * partial carries its own `{% load i18n %}` for the `{% translate %}`/`{% blocktranslate %}` tags
 * `renderTextSpans` may have emitted inside it. */
export function emitComponentPartial(
  component: IrContainerNode,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  registry: ComponentRegistry,
  overriddenTextNodeIds: ReadonlySet<string> = new Set(),
  navMap: ReadonlyMap<string, string> = new Map(),
  bootstrapComponents = false
): string {
  // The matched component's parts apply to its whole subtree (nested instances render their
  // own partials, so parts never bleed across component boundaries).
  const match =
    bootstrapComponents && component.component
      ? matchBootstrapComponent(component.component.setName ?? component.name, component.component, toVarName)
      : null
  const wiring = match ? buildWiring(component, match, registry) : undefined
  const body = renderPartialNode(
    component,
    { sceneNodesById, registry, overriddenTextNodeIds, navMap, bootstrapComponents, bootstrapParts: match?.parts, wiring, ancestry: NO_LANDMARK_ANCESTRY, headingState: createHeadingState() },
    ''
  )
  // {% load %} is per-file (never inherited via include/extends) — static is needed for the
  // <img>/<video> tags renderAssetLeaf emits for image nodes and marked graphics.
  return `{% load i18n %}\n{% load static %}\n${body}`
}

/** REFORM phase 12 (page recognition): a node the page emitter should render as a recognized
 * Bootstrap component INLINE (native markup + parts + data-API wiring), because it isn't a
 * registered partial. A container that IS a component def qualifies directly; an inline instance
 * (main def outside the export → no partial) is treated as a component via its captured
 * `componentSetName`. Returns the container to feed `renderPartialContainer`, or null. */
function recognizableContainerOnPage(node: IrNode, registry: ComponentRegistry): IrContainerNode | null {
  if (node.type === 'container' && node.component) return node
  if (node.type === 'instance-ref' && node.componentSetName) {
    const hasPartial = node.componentKey != null && registry.pathByComponentKey.has(node.componentKey)
    if (hasPartial) return null // handled as an {% include %} instead
    // REFORM theme phase A: synthesize the component def's VARIANT properties from the INSTANCE's
    // actual values (`Variant=Primary, Size=lg` → defs whose defaultValue is that value). The
    // matcher then emits `btn-{{ variant|default:'primary'|lower }}` — and on a page, where nothing
    // binds the var, `foldDefaultClassExprs` (literalText) collapses it to the concrete
    // `btn-primary`. Role-colored components now get their real Bootstrap variant class inline,
    // not just the base class.
    const properties: IrComponentPropertyDef[] = Object.entries(node.componentProperties)
      .filter((entry): entry is [string, { type: 'VARIANT'; value: string }] => entry[1].type === 'VARIANT')
      .map(([name, value]) => ({ name, type: 'VARIANT', defaultValue: value.value, variantOptions: [value.value] }))
    return {
      ...node,
      type: 'container',
      component: { key: node.componentKey ?? node.id, setName: node.componentSetName, properties },
    } as unknown as IrContainerNode
  }
  return null
}

/** REFORM theme phase A: on a page (literalText) every class expression the matcher emits follows
 * the `{{ var|default:'value'|lower }}` shape, and no include ever binds the var — Django would
 * render the default anyway. Fold it to the literal at EMIT time so page templates carry concrete
 * Bootstrap classes (`btn btn-primary btn-lg`), not dead template expressions. The fallback is
 * already lowercased by the matcher. Behavioral attrs (`{{ collapse_id }}` etc.) have no default
 * and are left alone — wiring mints those. */
function foldDefaultClassExprs(classAttr: string): string {
  return classAttr.replace(/\{\{ [a-zA-Z0-9_]+\|default:'([^']*)'(?:\|lower)? \}\}/g, '$1')
}

function renderPageNode(
  node: IrNode,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  registry: ComponentRegistry,
  navMap: ReadonlyMap<string, string>,
  indent: string,
  bootstrapComponents: boolean,
  headingState: HeadingState,
  ancestry: LandmarkAncestry = NO_LANDMARK_ANCESTRY,
  isPageRootChild = false,
  isPageRoot = true
): string {
  const className = toClassName(node.id)

  const rendered = (() => {
    if (node.type === 'instance-ref') {
      const path = node.componentKey ? registry.pathByComponentKey.get(node.componentKey) : undefined
      if (path) return `${indent}${renderIncludeTag(path, buildIncludeParams(node, registry))}`
    }

    // REFORM phase 12: recognize an inline Bootstrap component on the page — so a component placed
    // directly on a page (not via a registered partial) still emits native markup + data-bs-*
    // wiring, exactly like a partial would. Delegates the subtree to the partial renderer, which
    // applies the match's parts + wiring at any depth.
    if (bootstrapComponents) {
      const recognizable = recognizableContainerOnPage(node, registry)
      if (recognizable) {
        const comp = recognizable.component
        const match = comp ? matchBootstrapComponent(comp.setName ?? recognizable.name, comp, toVarName) : null
        if (match) {
          const wiring = buildWiring(recognizable, match, registry)
          const ctx: PartialCtx = {
            sceneNodesById,
            registry,
            overriddenTextNodeIds: new Set(),
            navMap,
            bootstrapComponents,
            bootstrapParts: match.parts,
            wiring,
            literalText: true, // page-inline: no include binds the labels → render literal characters
            ancestry, // continue the page's own landmark-ancestry into the recognized subtree
            headingState, // continue the page's own H1-uniqueness tracking into the recognized subtree
          }
          return renderPartialContainer(recognizable, className, ctx, indent)
        }
      }
    }

    switch (node.type) {
      case 'text':
        return renderTextBlock(node, sceneNodesById.get(node.id), className, indent, resolveHeadingTag(node.name, headingState))
      case 'image':
      case 'vector':
        return renderAssetLeaf(node, indent)
      case 'container':
      case 'instance-ref': {
        const { tag, attrs, landmarkKind } = resolveContainerTag(node, ancestry, isPageRootChild)
        const childAncestry = landmarkKind ? new Set([...ancestry, landmarkKind]) : ancestry
        const bgVideo = renderBackgroundVideoLayer(node, `${indent}  `)
        if (node.children.length === 0 && !bgVideo) return `${indent}<${tag}${attrs} class="${className}"></${tag}>`
        const inner = node.children
          .map((child) => renderPageNode(child, sceneNodesById, registry, navMap, `${indent}  `, bootstrapComponents, headingState, childAncestry, isPageRoot, false))
          .join('\n')
        const parts = [bgVideo, inner].filter(Boolean)
        return `${indent}<${tag}${attrs} class="${className}">\n${parts.join('\n')}\n${indent}</${tag}>`
      }
    }
  })()
  return wrapNavigate(node, rendered, indent, navMap)
}

/** Emits a top-level page frame as `{% extends "base.html" %}` + `{% block content %}` (docs §3.1),
 * replacing any instance-ref whose component is known to `registry` with an `{% include %}` call.
 * `{% load i18n %}` follows `{% extends %}` (which must stay the template's first tag) rather than
 * preceding it — see `emitComponentPartial` for why every template needs its own `{% load %}`.
 * `bootstrapComponents` enables inline Bootstrap component recognition on the page (phase 12). */
export function emitPage(
  root: IrContainerNode,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  registry: ComponentRegistry,
  navMap: ReadonlyMap<string, string> = new Map(),
  bootstrapComponents = false
): string {
  const body = renderPageNode(root, sceneNodesById, registry, navMap, '    ', bootstrapComponents, createHeadingState())
  // {% load static %} is per-file — base.html's own load does NOT cover this template's
  // {% static %} refs (image nodes, marked graphics).
  return ['{% extends "base.html" %}', '{% load i18n %}', '{% load static %}', '{% block content %}', body, '{% endblock %}'].join('\n')
}

/** Renders an overlay destination frame's markup as a standalone fragment — no `{% extends %}`/
 * `{% block %}` wrapper, unlike `emitPage`. Motion's interactions emitter splices this straight
 * into the TRIGGERING page's own `{% block content %}` (as the `<dialog>`'s body), so it must not
 * carry template-inheritance tags of its own — the page already has its `{% load %}`s. Reuses the
 * same page-node renderer `emitPage` calls, so an overlay body gets identical fidelity (recognized
 * components, includes, nav links) to a real page instead of rendering EMPTY. */
export function renderOverlayFragment(
  node: IrNode,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  registry: ComponentRegistry,
  navMap: ReadonlyMap<string, string>,
  bootstrapComponents: boolean
): string {
  return renderPageNode(node, sceneNodesById, registry, navMap, '  ', bootstrapComponents, createHeadingState())
}

/** One Google Fonts `<link>` per family (variable-range weights). Per-family links keep one
 * unhosted family (e.g. the commercial Museo Sans → 400 response) from breaking the rest — a
 * failed stylesheet just leaves that family on its generic fallback stack. */
function fontLinks(fontFamilies: readonly string[]): string[] {
  if (fontFamilies.length === 0) return []
  return [
    '  <link rel="preconnect" href="https://fonts.googleapis.com">',
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    ...fontFamilies.map(
      (family) =>
        `  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@100..900&display=swap">`
    ),
  ]
}

export type BaseHtmlGsapPluginName = 'CustomEase' | 'DrawSVGPlugin' | 'TextPlugin'

/** GSAP core/plugin sources. The export cannot ship the runtime (the plugin has no network), and
 * `{% static 'vendor/gsap/…' %}` was a guaranteed 404 that silently killed every Motion timeline:
 * nothing in this pipeline ever wrote those files. GSAP 3.13 publishes every plugin — the former
 * Club ones included — to npm, so the pinned jsDelivr build is a complete runtime. An offline
 * deployment copies the files into `static/vendor/gsap/` and repoints these tags in base.html,
 * outside the generated marker so regeneration keeps the edit. */
const GSAP_CDN_VERSION = '3.13.0'
const GSAP_CORE_SRC = `https://cdn.jsdelivr.net/npm/gsap@${GSAP_CDN_VERSION}/dist/gsap.min.js`
const GSAP_PLUGIN_SRC_BY_NAME: Record<BaseHtmlGsapPluginName, string> = {
  CustomEase: `https://cdn.jsdelivr.net/npm/gsap@${GSAP_CDN_VERSION}/dist/CustomEase.min.js`,
  DrawSVGPlugin: `https://cdn.jsdelivr.net/npm/gsap@${GSAP_CDN_VERSION}/dist/DrawSVGPlugin.min.js`,
  TextPlugin: `https://cdn.jsdelivr.net/npm/gsap@${GSAP_CDN_VERSION}/dist/TextPlugin.min.js`,
}

/** Options for linking animation assets from `base.html` (M10). */
export interface BaseHtmlAnimationLinks {
  /** Link `static/css/animations.css` — emitted for CSS-keyframes Motion timelines. */
  animationsCss: boolean
  /** Link `static/js/animations.js` plus the local GSAP core/plugin files. */
  animationsJs: boolean
  /** GSAP plugins the generated `animations.js` actually uses. */
  gsapPlugins: readonly BaseHtmlGsapPluginName[]
}

/** REFORM phase 4 (docs/REFORM.md §5.2): how base.html links the CSS framework itself.
 * Rendered as `{% block framework_css %}` / `{% block framework_js %}` so a project can
 * override the delivery without touching the generated markup. */
export interface BaseHtmlFrameworkLinks {
  /** `assume` — the project links Bootstrap itself (blocks carry only a comment);
   * `cdn` — jsdelivr links pinned to `version`; `vendored` — `{% static 'vendor/bootstrap/…' %}`. */
  source: 'assume' | 'cdn' | 'vendored'
  version: string
  /** `css/bootstrap-tokens.css` (linked AFTER the framework, BEFORE tokens.css), or null
   * when the tokens module is off. */
  bootstrapTokensCssFile: string | null
  /** REFORM phase 14 (B): `css/bootstrap-theme.css` — per-component Bootstrap variable sets
   * extracted from the kit masters. Linked after bootstrap-tokens.css so component var sets
   * refine the global mapping. Null/absent when the theme is empty or fidelity < theme. */
  themeCssFile?: string | null
  /** REFORM phase 6: at `utilities`/`components`/`theme` the emitters rewrite exact-scale layout
   * declarations into Bootstrap utility classes (frameworks/bootstrap/utilities.ts).
   * base.html itself ignores this field. */
  fidelity?: 'tokens' | 'utilities' | 'components' | 'theme'
}

/** Options for linking interaction and animation assets from `base.html` (M9/M10). */
export interface BaseHtmlInteractionLinks {
  /** Link `static/css/interactions.css` — emitted when ON_HOVER/ON_PRESS interactions exist. */
  interactionsCss: boolean
  /** Link `static/js/interactions.js` — emitted when overlay dialogs need JS wiring. */
  interactionsJs: boolean
  /** Link `static/css/animations.css` — emitted for CSS-keyframes Motion timelines. */
  animationsCss?: boolean
  /** Link `static/js/animations.js` plus the local GSAP core/plugin files. */
  animationsJs?: boolean
  /** GSAP plugins the generated `animations.js` actually uses. */
  gsapPlugins?: readonly BaseHtmlGsapPluginName[]
}

/** Shell options for `base.html` (adaptive multipage upgrade): each links/wires an asset another
 * slice emits, so base.html only ever references files that actually exist for this export. */
export interface BaseHtmlShellOptions {
  /** Links `static/css/transitions.css` (page-to-page prototype transitions) after interactions.css. */
  readonly transitionsCss?: boolean
  /** Links `static/js/transitions.js`, deferred, after every other script. */
  readonly transitionsJs?: boolean
  /** Renders `{% include 'partials/language-switcher.html' %}` inside `{% block language_switcher %}`
   * near the top of `<body>` — the partial itself belongs to the i18n slice; base.html only wires
   * it in and loads `{% load i18n %}` for it. */
  readonly languageSwitcher?: boolean
}

/** Emits the shared `base.html` skeleton every page `{% extends %}` (docs §3.1/§3.3) as a
 * production document, not a bare fragment: charset/viewport meta FIRST (every `@media
 * (max-width:…)` the pipeline emits is inert on a real phone without the viewport tag), an
 * `<html lang>`/`dir` pair driven by Django's active-language context vars, title/description
 * blocks a page can fill in, and a skip-link + `<main id="content">` landmark for keyboard/screen-
 * reader navigation (WCAG 2.4.1). `extra_head`/`body_end` blocks let a project inject anything
 * this skeleton doesn't anticipate without touching the generated markup.
 *
 * `tokensCssFile` links the design-token variables stylesheet BEFORE the project css — without
 * it every fallback-less `var(--…)` reference (bound fills, lint-fix auto variables) resolves
 * to nothing and the element renders transparent. Pass `null` when the tokens module is off.
 * `fontFamilies` (the families the emitted CSS actually uses) become best-effort Google Fonts
 * links — font binaries can't leave Figma through the Plugin API.
 * `interactionLinks` (M9) conditionally links `css/interactions.css` and `js/interactions.js`
 * after the project stylesheet — only when the export produced them.
 * `shell` links the adaptive/i18n additions (page transitions, language switcher) other slices
 * produce — every field defaults off, so an export that doesn't use them gets the pre-existing
 * link set exactly. */
export function emitBaseHtml(
  cssFile: string,
  tokensCssFile: string | null = 'css/tokens.css',
  fontFamilies: readonly string[] = [],
  interactionLinks: BaseHtmlInteractionLinks = { interactionsCss: false, interactionsJs: false },
  framework: BaseHtmlFrameworkLinks | null = null,
  shell: BaseHtmlShellOptions = {}
): string {
  // Stylesheet order (REFORM §5.2): bootstrap.css → bootstrap-tokens.css → tokens.css → project.
  // Bootstrap loads into a CASCADE LAYER (phase 13 / P2g): un-layered author CSS (tokens/project/
  // interactions) beats layered rules for every conflicting property REGARDLESS of specificity, so
  // Bootstrap's decorations can never override the pixel-exact Figma CSS — `.btn:hover`'s undefined
  // state vars won't blank a custom background, `.btn-group > .btn`'s corner-zeroing won't cut a
  // custom radius. Utility classes (`.d-flex` …) keep working: they are `!important`, and layered
  // !important still outranks un-layered normal declarations. Bootstrap's JS needs no CSS cascade.
  const frameworkCssLines = framework
    ? [
        '  {% block framework_css %}',
        ...(framework.source === 'cdn'
          ? [
              `  <style>@import url("https://cdn.jsdelivr.net/npm/bootstrap@${framework.version}/dist/css/bootstrap.min.css") layer(bootstrap);</style>`,
            ]
          : framework.source === 'vendored'
            ? [`  <style>@import url("{% static 'vendor/bootstrap/bootstrap.min.css' %}") layer(bootstrap);</style>`]
            : [
                "  {# Bootstrap CSS is expected from the project (Settings → Bootstrap source: In project)." +
                  ' Override this block to link it, or run `allcrew-channel bootstrap vendor`. #}',
              ]),
        '  {% endblock %}',
        ...(framework.bootstrapTokensCssFile
          ? [`  <link rel="stylesheet" href="{% static '${framework.bootstrapTokensCssFile}' %}">`]
          : []),
        ...(framework.themeCssFile
          ? [`  <link rel="stylesheet" href="{% static '${framework.themeCssFile}' %}">`]
          : []),
      ]
    : []
  const frameworkJsLines = framework
    ? [
        '  {% block framework_js %}',
        ...(framework.source === 'cdn'
          ? [
              `  <script src="https://cdn.jsdelivr.net/npm/bootstrap@${framework.version}/dist/js/bootstrap.bundle.min.js" defer></script>`,
            ]
          : framework.source === 'vendored'
            ? [`  <script src="{% static 'vendor/bootstrap/bootstrap.bundle.min.js' %}" defer></script>`]
            : ['  {# Bootstrap JS (bundle) is expected from the project — override this block to link it. #}']),
        '  {% endblock %}',
      ]
    : []
  const interactionCssLink = interactionLinks.interactionsCss
    ? [`  <link rel="stylesheet" href="{% static 'css/interactions.css' %}">`]
    : []
  const animationCssLink = interactionLinks.animationsCss
    ? [`  <link rel="stylesheet" href="{% static 'css/animations.css' %}">`]
    : []
  const transitionsCssLink = shell.transitionsCss ? [`  <link rel="stylesheet" href="{% static 'css/transitions.css' %}">`] : []
  const interactionJsLink = interactionLinks.interactionsJs
    ? [`  <script src="{% static 'js/interactions.js' %}" defer></script>`]
    : []
  const animationJsLink = interactionLinks.animationsJs
    ? [
        `  <script src="${GSAP_CORE_SRC}"></script>`,
        ...(interactionLinks.gsapPlugins ?? []).map(
          (plugin) => `  <script src="${GSAP_PLUGIN_SRC_BY_NAME[plugin]}" defer></script>`
        ),
        `  <script src="{% static 'js/animations.js' %}" defer></script>`,
      ]
    : []
  const transitionsJsLink = shell.transitionsJs ? [`  <script src="{% static 'js/transitions.js' %}" defer></script>`] : []
  const languageSwitcherBlock = shell.languageSwitcher
    ? ["  {% block language_switcher %}{% include 'partials/language-switcher.html' %}{% endblock %}"]
    : []
  return [
    '{% load static %}',
    ...(shell.languageSwitcher ? ['{% load i18n %}'] : []),
    '<!DOCTYPE html>',
    "<html lang=\"{{ LANGUAGE_CODE|default:'en' }}\"{% if LANGUAGE_BIDI %} dir=\"rtl\"{% endif %}>",
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  {% block head_meta %}{% endblock %}',
    '  <title>{% block title %}{{ page_title|default:\'\' }}{% endblock %}</title>',
    '  <meta name="description" content="{% block meta_description %}{{ page_description|default:\'\' }}{% endblock %}">',
    ...fontLinks(fontFamilies),
    ...frameworkCssLines,
    ...(tokensCssFile ? [`  <link rel="stylesheet" href="{% static '${tokensCssFile}' %}">`] : []),
    `  <link rel="stylesheet" href="{% static '${cssFile}' %}">`,
    ...interactionCssLink,
    ...animationCssLink,
    ...transitionsCssLink,
    '  {% block extra_head %}{% endblock %}',
    '</head>',
    '<body>',
    // The skip link is ALWAYS the first body child — its whole purpose is to be the first stop
    // for keyboard/screen-reader navigation, ahead of ANY page chrome, the language switcher
    // included.
    '  <a class="skip-to-content" href="#content">Skip to content</a>',
    ...languageSwitcherBlock,
    '  <main id="content">',
    '  {% block content %}{% endblock %}',
    '  </main>',
    ...frameworkJsLines,
    ...interactionJsLink,
    ...animationJsLink,
    ...transitionsJsLink,
    '  {% block body_end %}{% endblock %}',
    '</body>',
    '</html>',
  ].join('\n')
}

export { pageTemplatePath }
