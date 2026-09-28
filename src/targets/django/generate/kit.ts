/**
 * REFORM phase 10b–11 / B4+: the live Figma builder for the design kit (code→design). Consumes
 * the pure plan (plan.ts), the pixel-accurate blueprints (blueprint.ts), and the sheet layout
 * (sheet.ts), and creates real component sets on a fresh page: each variant drawn 1:1 with
 * Bootstrap metrics, role fills bound to the file's tokens, laid out as a labeled sticker sheet
 * (title + subtitle per component, variants in a grid). Uses the global `figma` sandbox API; the
 * pure/decidable parts are tested elsewhere, this glue is verified live.
 */

import { planKit, type ComponentPlan, type VariantPlan } from './plan.ts'
import { buildReport, variantFillTokenPath, type KitReport } from './build.ts'
import { blueprintVariant, type Fill, type KitFrame, type KitInstance, type KitNode, type SlotSpec, type Stroke } from './blueprint.ts'
import { clusterSubtitle, packShelves, variantCells, type Placed, type Size } from './sheet.ts'
import { BOOTSTRAP_SPECS } from '../bootstrap/specs.ts'
import { COLOR, FONT, ROLES, type Rgb } from './metrics.ts'

/** An auto-layout-capable container the interpreter writes into — a frame, the component root, or
 * a slot (SlotNode extends the same frame mixins). */
type Container = FrameNode | ComponentNode | SlotNode

const KIT_PAGE_NAME = 'AllCrew Channel Bootstrap Kit'

// Sticker-sheet layout constants (px).
const HEADER_OFFSET = 140 // clusters start below the page header
const CLUSTER_HEAD_H = 68 // title + subtitle block above each set
const CLUSTER_MIN_W = 260
const CELL_GAP = 24 // gap between variant cells inside a set
const SHEET_MAX_W = 1720
const SHEET_GAP_X = 88
const SHEET_GAP_Y = 96

interface Fonts {
  regular: FontName
  bold: FontName
}

/** A slot created during a component build, to be wired (description/preferred/limits) once every
 * component exists and its Figma `key` is known. */
interface PendingSlot {
  component: ComponentNode
  propName: string
  spec: SlotSpec
}

interface BuildCtx {
  fonts: Fonts
  /** role (lowercased) → the file's bound Variable, or null when the file has no matching token. */
  roleVars: Map<string, Variable | null>
  /** Set true whenever a token fill binds while building the current variant. */
  variantBound: boolean
  /** The component currently being built — the owner for any slot it declares. */
  root: ComponentNode | null
  /** Feature flag: false once `createSlot` is missing/throws, so we degrade to plain frames. */
  slotsSupported: boolean
  /** Slots to wire after the whole kit is built (keys of preferred components are known then). */
  pendingSlots: PendingSlot[]
  /** phase 12: item spec name → its built component (set/lone), so a master can compose from
   * INSTANCES of it. Populated by the first (items) build pass. */
  itemComponents: Map<string, ComponentSetNode | ComponentNode>
  /** Feature flag: false once `createInstance` is missing/throws, so masters degrade to inline. */
  instancesSupported: boolean
}

/** Loads Regular + a bold weight for the kit's text, preferring Inter/Roboto. */
async function loadKitFonts(): Promise<Fonts> {
  for (const family of ['Inter', 'Roboto', 'Helvetica', 'Arial']) {
    try {
      const regular: FontName = { family, style: 'Regular' }
      await figma.loadFontAsync(regular)
      let bold: FontName = regular
      for (const style of ['Bold', 'Semi Bold', 'Medium']) {
        try {
          const candidate: FontName = { family, style }
          await figma.loadFontAsync(candidate)
          bold = candidate
          break
        } catch {
          // try the next bold weight
        }
      }
      return { regular, bold }
    } catch {
      // try the next family
    }
  }
  const available = await figma.listAvailableFontsAsync()
  const fallback = available[0]?.fontName ?? { family: 'Roboto', style: 'Regular' }
  await figma.loadFontAsync(fallback)
  return { regular: fallback, bold: fallback }
}

function solidPaint(color: Rgb): SolidPaint {
  return { type: 'SOLID', color }
}

/** Resolves a blueprint Fill to Figma paints, binding role fills to the file's token when present.
 * Marks `ctx.variantBound` when a bind happens (drives the report). */
function resolveFill(fill: Fill | undefined, ctx: BuildCtx): Paint[] {
  if (!fill || fill.kind === 'none') return []
  if (fill.kind === 'solid') return [solidPaint(fill.color)]
  const variable = ctx.roleVars.get(fill.role.trim().toLowerCase())
  if (variable) {
    ctx.variantBound = true
    return [figma.variables.setBoundVariableForPaint(solidPaint(fill.fallback), 'color', variable)]
  }
  return [solidPaint(fill.fallback)]
}

function applyStroke(el: Container, stroke: Stroke): void {
  el.strokes = [solidPaint(stroke.color)]
  el.strokeAlign = 'INSIDE'
  if (!stroke.side || stroke.side === 'all') {
    el.strokeWeight = stroke.weight
    return
  }
  el.strokeTopWeight = stroke.side === 'top' ? stroke.weight : 0
  el.strokeRightWeight = stroke.side === 'right' ? stroke.weight : 0
  el.strokeBottomWeight = stroke.side === 'bottom' ? stroke.weight : 0
  el.strokeLeftWeight = stroke.side === 'left' ? stroke.weight : 0
}

function applyPadding(el: Container, padding: KitFrame['padding']): void {
  if (padding == null) return
  const [t, r, b, l] = typeof padding === 'number' ? [padding, padding, padding, padding] : padding
  el.paddingTop = t
  el.paddingRight = r
  el.paddingBottom = b
  el.paddingLeft = l
}

const PRIMARY_ALIGN = { min: 'MIN', center: 'CENTER', max: 'MAX', 'space-between': 'SPACE_BETWEEN' } as const
const COUNTER_ALIGN = { min: 'MIN', center: 'CENTER', max: 'MAX' } as const

function configureFrame(el: Container, node: KitFrame, ctx: BuildCtx): void {
  if (node.direction && node.direction !== 'none') {
    el.layoutMode = node.direction === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL'
    if (node.gap != null) el.itemSpacing = node.gap
    applyPadding(el, node.padding)
    if (node.primaryAlign) el.primaryAxisAlignItems = PRIMARY_ALIGN[node.primaryAlign]
    if (node.counterAlign) el.counterAxisAlignItems = COUNTER_ALIGN[node.counterAlign]
  } else {
    el.layoutMode = 'NONE'
  }
  el.fills = resolveFill(node.fill, ctx)
  if (node.stroke) applyStroke(el, node.stroke)
  if (node.radius != null) el.cornerRadius = node.radius
  if (node.clip != null) el.clipsContent = node.clip
  if (node.opacity != null) el.opacity = node.opacity
}

/** Sets a frame's own hug/fixed sizing after its children exist. */
function applyOwnSizing(el: Container, node: KitFrame): void {
  const num = (v: KitFrame['width']) => (typeof v === 'number' ? v : undefined)
  if (!node.direction || node.direction === 'none') {
    el.resizeWithoutConstraints(Math.max(0.01, num(node.width) ?? el.width), Math.max(0.01, num(node.height) ?? el.height))
    return
  }
  const horizontal = node.direction === 'horizontal'
  const primaryDim = horizontal ? node.width : node.height
  const counterDim = horizontal ? node.height : node.width
  el.primaryAxisSizingMode = primaryDim === 'hug' || primaryDim == null ? 'AUTO' : 'FIXED'
  el.counterAxisSizingMode = counterDim === 'hug' || counterDim == null ? 'AUTO' : 'FIXED'
  if (num(node.width) != null || num(node.height) != null) {
    el.resizeWithoutConstraints(Math.max(0.01, num(node.width) ?? el.width), Math.max(0.01, num(node.height) ?? el.height))
  }
}

/** Applies parent-relative fill (layoutGrow / STRETCH) to a child of an auto-layout frame. */
function applyParentFill(el: SceneNode & LayoutMixin, node: KitNode, parentDir: KitFrame['direction']): void {
  if (!parentDir || parentDir === 'none') return
  const parentHorizontal = parentDir === 'horizontal'
  const width = node.type === 'text' ? undefined : node.width
  const height = node.type === 'text' ? undefined : node.height
  if (width === 'fill') {
    if (parentHorizontal) el.layoutGrow = 1
    else el.layoutAlign = 'STRETCH'
  }
  if (height === 'fill') {
    if (parentHorizontal) el.layoutAlign = 'STRETCH'
    else el.layoutGrow = 1
  }
  if (node.grow) el.layoutGrow = 1
}

function buildText(node: Extract<KitNode, { type: 'text' }>, ctx: BuildCtx): TextNode {
  const el = figma.createText()
  el.name = node.name
  el.fontName = node.bold ? ctx.fonts.bold : ctx.fonts.regular
  el.characters = node.text
  el.fontSize = node.fontSize
  const paints = resolveFill(node.color, ctx)
  el.fills = paints.length ? paints : [solidPaint(COLOR.bodyText)]
  el.textAlignHorizontal = (node.align ?? 'left').toUpperCase() as 'LEFT' | 'CENTER' | 'RIGHT'
  el.textAutoResize = node.grow ? 'HEIGHT' : 'WIDTH_AND_HEIGHT'
  return el
}

/** Builds a reference to an item sub-component as a live INSTANCE of its built set (phase 12
 * composition). Falls back to rendering the item's blueprint inline if instances aren't available
 * or the item wasn't built — so a composed master never fails to generate. */
function buildInstance(parent: Container, node: KitInstance, parentDir: KitFrame['direction'], ctx: BuildCtx): SceneNode {
  const target = ctx.itemComponents.get(node.of)
  if (target && ctx.instancesSupported) {
    try {
      const main: ComponentNode = target.type === 'COMPONENT_SET' ? target.defaultVariant : target
      if (typeof main.createInstance !== 'function') throw new Error('createInstance unavailable')
      const instance = main.createInstance()
      parent.appendChild(instance)
      if (node.values && Object.keys(node.values).length > 0) {
        try {
          instance.setProperties(node.values)
        } catch {
          // variant selection is best-effort — keep the default variant on mismatch
        }
      }
      if (node.text) {
        for (const [layer, chars] of Object.entries(node.text)) {
          const t = instance.findOne((n) => n.type === 'TEXT' && n.name === layer) as TextNode | null
          if (t) {
            try {
              t.characters = chars
            } catch {
              // font of the overridden text not loaded — keep the instance's default text
            }
          }
        }
      }
      applyParentFill(instance, node, parentDir)
      if (parentDir === 'none') {
        instance.x = node.x ?? 0
        instance.y = node.y ?? 0
      }
      return instance
    } catch {
      ctx.instancesSupported = false // stop trying for the rest of this run
    }
  }
  // Fallback: render the item's blueprint inline (visually identical, just not a linked instance).
  const spec = SPEC_BY_NAME.get(node.of)
  if (!spec) {
    const placeholder = figma.createFrame()
    placeholder.name = node.of
    parent.appendChild(placeholder)
    return placeholder
  }
  return buildInto(parent, blueprintVariant(spec, node.values ?? {}), parentDir, ctx)
}

/** Recursively builds a KitNode into `parent`, an auto-layout or plain frame. */
function buildInto(parent: Container, node: KitNode, parentDir: KitFrame['direction'], ctx: BuildCtx): SceneNode {
  if (node.type === 'instance') return buildInstance(parent, node, parentDir, ctx)
  if (node.type === 'text') {
    const el = buildText(node, ctx)
    parent.appendChild(el)
    applyParentFill(el, node, parentDir)
    if (parentDir === 'none') {
      el.x = node.x ?? 0
      el.y = node.y ?? 0
    }
    return el
  }
  // A slot-marked frame becomes a real Figma SLOT on the owning component (createSlot also adds a
  // SLOT component property). Feature-detected + guarded: any failure degrades to a plain frame so
  // kit generation never breaks on runtimes without slots.
  let slotNode: SlotNode | undefined
  let slotProp: string | undefined
  if (node.slot && ctx.root && ctx.slotsSupported && typeof ctx.root.createSlot === 'function') {
    try {
      const before = new Set(Object.keys(ctx.root.componentPropertyDefinitions))
      slotNode = ctx.root.createSlot()
      slotProp = Object.keys(ctx.root.componentPropertyDefinitions).find((k) => !before.has(k))
    } catch {
      ctx.slotsSupported = false
    }
  }
  const el: FrameNode | SlotNode = slotNode ?? figma.createFrame()
  el.name = node.name
  parent.appendChild(el)
  configureFrame(el, node, ctx)
  for (const child of node.children) buildInto(el, child, node.direction ?? 'vertical', ctx)
  applyOwnSizing(el, node)
  applyParentFill(el, node, parentDir)
  if (parentDir === 'none') {
    el.x = node.x ?? 0
    el.y = node.y ?? 0
  }
  if (slotProp && node.slot && ctx.root) ctx.pendingSlots.push({ component: ctx.root, propName: slotProp, spec: node.slot })
  return el
}

/** Builds ONE variant as a ComponentNode whose own frame IS the blueprint root. Sets `ctx.root`
 * so any slot-marked descendant creates its slot on this component. */
function buildVariantComponent(root: KitFrame, name: string, ctx: BuildCtx): ComponentNode {
  const component = figma.createComponent()
  component.name = name
  const prevRoot = ctx.root
  ctx.root = component
  configureFrame(component, root, ctx)
  for (const child of root.children) buildInto(component, child, root.direction ?? 'vertical', ctx)
  applyOwnSizing(component, root)
  ctx.root = prevRoot
  return component
}

interface Cluster {
  nodes: SceneNode[]
  node: SceneNode // the set or lone component
  /** The set/component Figma key + kind — used to wire slot preferredValues across the kit. */
  key: string
  isSet: boolean
  heading: TextNode
  subtitle: TextNode
  size: Size
}

/** Builds a component's cluster: its variant set (variants drawn + gridded) plus a title/subtitle
 * block. Nodes are created at the origin; the caller repositions them after packing. */
function buildCluster(page: PageNode, plan: ComponentPlan, ctx: BuildCtx): { cluster: Cluster; bound: number } {
  let bound = 0
  const components: ComponentNode[] = []
  for (const variant of plan.variants) {
    ctx.variantBound = false
    const root = blueprintVariant(findSpec(plan.name), variant.values)
    const component = buildVariantComponent(root, variantNodeName(plan, variant), ctx)
    page.appendChild(component)
    if (ctx.variantBound) bound += 1
    components.push(component)
  }

  // Arrange variants in a labeled grid (rows = first prop, cols = the rest), uniform cell size.
  const cells = variantCells(plan)
  const cellW = Math.max(...components.map((c) => c.width))
  const cellH = Math.max(...components.map((c) => c.height))
  for (let i = 0; i < components.length; i++) {
    components[i].x = cells[i].x * (cellW + CELL_GAP)
    components[i].y = cells[i].y * (cellH + CELL_GAP)
  }

  let node: SceneNode
  let key: string
  let isSet: boolean
  if (plan.isSet && components.length > 1) {
    const set = figma.combineAsVariants(components, page)
    set.name = plan.name
    node = set
    key = set.key
    isSet = true
  } else {
    node = components[0]
    key = components[0].key
    isSet = false
  }

  const heading = figma.createText()
  heading.fontName = ctx.fonts.bold
  heading.characters = plan.name
  heading.fontSize = FONT.heading
  heading.fills = [solidPaint(COLOR.bodyText)]
  page.appendChild(heading)

  const subtitle = figma.createText()
  subtitle.fontName = ctx.fonts.regular
  subtitle.characters = clusterSubtitle(plan)
  subtitle.fontSize = 13
  subtitle.fills = [solidPaint(COLOR.secondaryText)]
  page.appendChild(subtitle)

  const size: Size = { w: Math.max(node.width, CLUSTER_MIN_W), h: CLUSTER_HEAD_H + node.height }
  return { cluster: { nodes: [heading, subtitle, node], node, key, isSet, heading, subtitle, size }, bound }
}

/** Wires every slot created during the build: names it, sets the guidance description, resolves
 * preferred inserts to Figma keys, and applies the min/max limits. All best-effort. */
function wireSlots(ctx: BuildCtx, keyByName: Map<string, InstanceSwapPreferredValue>): number {
  let wired = 0
  for (const ps of ctx.pendingSlots) {
    try {
      const preferredValues = (ps.spec.preferredKinds ?? [])
        .map((name) => keyByName.get(name))
        .filter((v): v is InstanceSwapPreferredValue => v != null)
      ps.component.editComponentProperty(ps.propName, {
        description: ps.spec.description,
        preferredValues,
        slotSettings: {
          allowPreferredValuesOnly: ps.spec.allowPreferredOnly ?? false,
          minChildren: ps.spec.minChildren ?? null,
          maxChildren: ps.spec.maxChildren ?? null,
          stretchChildOnInsert: ps.spec.stretchOnInsert ?? true,
        },
      })
      wired += 1
    } catch {
      // slot wiring is best-effort — a failure leaves the slot with its default settings
    }
  }
  return wired
}

const CLUSTER_PAD = 20

function placeCluster(cluster: Cluster, at: Placed): void {
  cluster.heading.x = at.x
  cluster.heading.y = at.y
  cluster.subtitle.x = at.x
  cluster.subtitle.y = at.y + 28
  cluster.node.x = at.x
  cluster.node.y = at.y + CLUSTER_HEAD_H
}

/** Draws a light panel behind a placed cluster (title + set) so each component reads as its own
 * grouped card on the sheet. Inserted at the back of the page's z-order. */
function addClusterBackground(page: PageNode, cluster: Cluster, at: Placed): void {
  const rect = figma.createRectangle()
  rect.name = `${cluster.heading.characters} · panel`
  rect.x = at.x - CLUSTER_PAD
  rect.y = at.y - CLUSTER_PAD
  rect.resizeWithoutConstraints(cluster.size.w + CLUSTER_PAD * 2, cluster.size.h + CLUSTER_PAD * 2)
  rect.fills = [solidPaint(COLOR.surface)]
  rect.strokes = [solidPaint(COLOR.border)]
  rect.strokeWeight = 1
  rect.cornerRadius = 12
  page.insertChild(0, rect)
}

function pageHeader(page: PageNode, ctx: BuildCtx, plans: readonly ComponentPlan[], variants: number): void {
  const title = figma.createText()
  title.fontName = ctx.fonts.bold
  title.characters = 'AllCrew Channel Bootstrap Kit'
  title.fontSize = 32
  title.fills = [solidPaint(COLOR.bodyText)]
  title.x = 0
  title.y = 0
  page.appendChild(title)

  const subtitle = figma.createText()
  subtitle.fontName = ctx.fonts.regular
  subtitle.characters = `${plans.length} master components · ${variants} variants · pixel-accurate Bootstrap 5.3 blanks — restyle these, keep the layer names.`
  subtitle.fontSize = 15
  subtitle.fills = [solidPaint(COLOR.secondaryText)]
  subtitle.x = 0
  subtitle.y = 46
  page.appendChild(subtitle)

  const legend = figma.createText()
  legend.fontName = ctx.fonts.regular
  legend.characters = 'Role fills bind to your color tokens where names match · see docs/BOOTSTRAP-CATALOG.md for the full component reference.'
  legend.fontSize = 13
  legend.fills = [solidPaint(COLOR.secondaryText)]
  legend.x = 0
  legend.y = 72
  page.appendChild(legend)
}

/** Item sub-components (phase 12) — built first so masters compose from their instances. */
const ITEM_SPEC_NAMES = new Set([
  'AccordionItem', 'ListGroupItem', 'NavLink', 'PageItem', 'DropdownItem', 'TableRow', 'BreadcrumbItem', 'TabPane', 'CarouselSlide',
])

const SPEC_BY_NAME = new Map(BOOTSTRAP_SPECS.map((spec) => [spec.name, spec]))
function findSpec(name: string) {
  const spec = SPEC_BY_NAME.get(name)
  if (!spec) throw new Error(`no spec for ${name}`)
  return spec
}

/** Figma variant node name (`Variant=Primary, Size=md`) for a set member, else the plan name. */
function variantNodeName(plan: ComponentPlan, variant: VariantPlan): string {
  return plan.isSet ? variant.name : plan.name
}

/** Generates the full Bootstrap kit on a fresh page and reports what was created. */
export async function generateDesignKit(
  colorVariables: ReadonlyArray<{ id: string; name: string }>
): Promise<KitReport> {
  const fonts = await loadKitFonts()
  const plans = planKit(BOOTSTRAP_SPECS)

  // Resolve each role to the file's matching color Variable once (canonical dotted paths →
  // variable id, then id → Variable). variantFillTokenPath slugs both sides the same way.
  const availablePaths: string[] = []
  const pathToVarId = new Map<string, string>()
  for (const variable of colorVariables) {
    const path = variable.name.split('/').join('.')
    availablePaths.push(path)
    if (!pathToVarId.has(path)) pathToVarId.set(path, variable.id)
  }
  const roleVars = new Map<string, Variable | null>()
  for (const role of [...ROLES, 'Link']) {
    const path = variantFillTokenPath(role, availablePaths)
    const varId = path ? pathToVarId.get(path) : null
    roleVars.set(role.toLowerCase(), varId ? await figma.variables.getVariableByIdAsync(varId) : null)
  }

  const ctx: BuildCtx = {
    fonts,
    roleVars,
    variantBound: false,
    root: null,
    slotsSupported: true,
    pendingSlots: [],
    itemComponents: new Map(),
    instancesSupported: true,
  }

  const page = figma.createPage()
  page.name = KIT_PAGE_NAME

  const variantCount = plans.reduce((sum, plan) => sum + plan.variants.length, 0)
  pageHeader(page, ctx, plans, variantCount)

  // Two-pass build: item sub-components first, so masters can compose from live INSTANCES of them
  // (phase 12). Masters are placed first on the sheet for readability; items follow.
  const itemPlans = plans.filter((plan) => ITEM_SPEC_NAMES.has(plan.name))
  const masterPlans = plans.filter((plan) => !ITEM_SPEC_NAMES.has(plan.name))

  let bound = 0
  // Preferred-insert keys for slot wiring: spec name → its built component's key + kind.
  const keyByName = new Map<string, InstanceSwapPreferredValue>()
  const record = (name: string, cluster: Cluster) =>
    keyByName.set(name, { type: cluster.isSet ? 'COMPONENT_SET' : 'COMPONENT', key: cluster.key })

  const itemClusters: Cluster[] = []
  for (const plan of itemPlans) {
    const { cluster, bound: clusterBound } = buildCluster(page, plan, ctx)
    bound += clusterBound
    ctx.itemComponents.set(plan.name, cluster.node as ComponentSetNode | ComponentNode)
    record(plan.name, cluster)
    itemClusters.push(cluster)
  }
  const masterClusters: Cluster[] = []
  for (const plan of masterPlans) {
    const { cluster, bound: clusterBound } = buildCluster(page, plan, ctx)
    bound += clusterBound
    record(plan.name, cluster)
    masterClusters.push(cluster)
  }
  const clusters: Cluster[] = [...masterClusters, ...itemClusters]

  const positions = packShelves(clusters.map((c) => c.size), SHEET_MAX_W, SHEET_GAP_X, SHEET_GAP_Y)
  for (let i = 0; i < clusters.length; i++) {
    const at = { x: positions[i].x, y: positions[i].y + HEADER_OFFSET }
    placeCluster(clusters[i], at)
    addClusterBackground(page, clusters[i], at)
  }

  // Wire slot preferred-inserts now that every component exists and its key is known (keyByName
  // was populated as each cluster was built).
  const slots = wireSlots(ctx, keyByName)

  return buildReport(plans, bound, slots)
}

export type { KitReport }
