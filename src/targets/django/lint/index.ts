/**
 * Design linter (T6.1's "отчёт линтера": a first pass over the rules docs/PLAN.md's T7.1 lists —
 * full rule coverage/UI deep-linking (`figma.viewport.scrollAndZoomIntoView`) is T7.1's job).
 * Walks the export scope and flags frames without Auto Layout, solid fills not bound to a
 * variable, text nodes without a text style, and excessively deep nesting — all signals that the
 * exported Django markup will need manual cleanup.
 */

import { isExportedGraphic } from '../../../utils/graphics.ts'
import { isBootstrapComponentName, wantsVariantProp, VARIANT_PROP_NAMES } from '../bootstrap/components.ts'

/** Default `excessive-nesting` threshold; overridable per team via Settings → lint.maxNestingDepth. */
export const DEFAULT_MAX_NESTING_DEPTH = 8

export interface LintOptions {
  maxNestingDepth?: number
}

export type LintRule =
  | 'missing-auto-layout'
  | 'unbound-fill'
  | 'unbound-stroke'
  | 'text-without-style'
  | 'excessive-nesting'
  | 'bootstrap-component-mismatch'

export interface LintFinding {
  nodeId: string
  nodeName: string
  rule: LintRule
  message: string
  /** `false` when the fix is guaranteed to skip from this file (e.g. layout inside a library
   * instance) — the UI hides the Fix button and excludes it from "Fix all". Set by the scan
   * post-pass in code.ts, not by the pure lint walk. */
  fixable?: boolean
}

/** A non-empty (or mixed, for text) paint-style id: the paints come from a style, which is as
 * tokenized as a variable binding — flagging it would fight the design system. */
function paintStyleSet(styleId: unknown): boolean {
  return styleId !== undefined && styleId !== ''
}

/** Paint-level binding view. On instance sublayers the binding inherited from the main
 * component shows up on the paint object, not in the sublayer's own `boundVariables` map —
 * checking only node-level flags already-bound design-system internals forever (the fixer
 * correctly finds nothing to bind, so the finding can never be cleared). */
function paintBound(paint: { boundVariables?: { color?: unknown } }): boolean {
  return Boolean(paint.boundVariables?.color)
}

function hasChildren(node: SceneNode): node is SceneNode & ChildrenMixin {
  return 'children' in node
}

/** True for nodes whose subtree exports as its own template file: an INSTANCE renders as a single
 * `{% include %}` and a COMPONENT as its own partial (see django/component-emitter). Nesting depth
 * is measured per output file, so the counter resets when the walk crosses one of these. */
function startsNewTemplateFile(node: SceneNode): boolean {
  return node.type === 'INSTANCE' || node.type === 'COMPONENT'
}

function checkNodeShallow(node: SceneNode, depth: number, findings: LintFinding[], maxDepth: number): void {
  if (depth > maxDepth) {
    findings.push({
      nodeId: node.id,
      nodeName: node.name,
      rule: 'excessive-nesting',
      message: `Nesting depth ${depth} exceeds ${maxDepth} in one template — flatten wrapper layers`,
    })
  }

  if (node.type === 'FRAME' && node.layoutMode === 'NONE') {
    findings.push({
      nodeId: node.id,
      nodeName: node.name,
      rule: 'missing-auto-layout',
      message: 'Frame has no Auto Layout — children will export with absolute positioning',
    })
  }

  if ('fills' in node && Array.isArray(node.fills) && !paintStyleSet((node as { fillStyleId?: unknown }).fillStyleId)) {
    const boundFills = 'boundVariables' in node ? node.boundVariables?.fills : undefined
    const hasUnboundSolidFill = node.fills.some(
      (fill, index) => fill.type === 'SOLID' && fill.visible !== false && !paintBound(fill) && !boundFills?.[index]
    )
    if (hasUnboundSolidFill) {
      findings.push({
        nodeId: node.id,
        nodeName: node.name,
        rule: 'unbound-fill',
        message: 'Solid fill is not bound to a color variable',
      })
    }
  }

  if ('strokes' in node && Array.isArray(node.strokes) && !paintStyleSet((node as { strokeStyleId?: unknown }).strokeStyleId)) {
    const boundStrokes = 'boundVariables' in node ? node.boundVariables?.strokes : undefined
    const hasUnboundSolidStroke = node.strokes.some(
      (stroke, index) => stroke.type === 'SOLID' && stroke.visible !== false && !paintBound(stroke) && !boundStrokes?.[index]
    )
    if (hasUnboundSolidStroke) {
      findings.push({
        nodeId: node.id,
        nodeName: node.name,
        rule: 'unbound-stroke',
        message: 'Solid stroke is not bound to a color variable',
      })
    }
  }

  if (node.type === 'TEXT' && node.textStyleId === '') {
    findings.push({
      nodeId: node.id,
      nodeName: node.name,
      rule: 'text-without-style',
      message: 'Text node has no text style applied',
    })
  }

  checkBootstrapComponentNaming(node, findings)
}

/** REFORM phase 7 / B3: a component (set) NAMED like a Bootstrap pattern whose variant prop
 * isn't recognizable will silently export as a custom partial instead of native Bootstrap
 * markup — surface the near-miss so the designer can rename the prop
 * (docs/DESIGN-CONVENTIONS.md §6). Jump-only: renaming a prop is a design decision. */
function checkBootstrapComponentNaming(node: SceneNode, findings: LintFinding[]): void {
  const isSet = node.type === 'COMPONENT_SET'
  const isLoneComponent = node.type === 'COMPONENT' && node.parent?.type !== 'COMPONENT_SET'
  if (!isSet && !isLoneComponent) return
  if (!isBootstrapComponentName(node.name) || !wantsVariantProp(node.name)) return

  let variantPropNames: string[] = []
  try {
    // `componentPropertyDefinitions` throws on variant children — never on sets or lone
    // components — but stay defensive: a lint pass must not abort the scan.
    const definitions = (node as ComponentSetNode | ComponentNode).componentPropertyDefinitions ?? {}
    variantPropNames = Object.entries(definitions)
      .filter(([, def]) => def.type === 'VARIANT')
      .map(([rawName]) => rawName.split('#')[0].trim().toLowerCase())
  } catch {
    return
  }
  if (variantPropNames.some((name) => VARIANT_PROP_NAMES.includes(name))) return

  findings.push({
    nodeId: node.id,
    nodeName: node.name,
    rule: 'bootstrap-component-mismatch',
    message: `Named like a Bootstrap component but no variant prop (${VARIANT_PROP_NAMES.join('/')}) was found — it will export as a custom partial, not native Bootstrap markup`,
  })
}

function checkNode(node: SceneNode, depth: number, findings: LintFinding[], maxDepth: number): void {
  // A designer-marked graphic (export settings) is a flat asset — its internals are art, not
  // layout, so don't lint the node or descend into it.
  if (isExportedGraphic(node)) return
  checkNodeShallow(node, depth, findings, maxDepth)
  if (hasChildren(node)) {
    const childDepth = startsNewTemplateFile(node) ? 0 : depth + 1
    for (const child of node.children) checkNode(child, childDepth, findings, maxDepth)
  }
}

/** Lints every root and its descendants; roots themselves are checked at depth 0.
 * NOTE: instances of export-marked components are only skipped by `lintScopeAsync` (the runtime
 * path) — detecting them needs an async main-component lookup this sync walk can't do. */
export function lintScope(roots: readonly SceneNode[], options: LintOptions = {}): LintFinding[] {
  const maxDepth = options.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH
  const findings: LintFinding[] = []
  for (const root of roots) checkNode(root, 0, findings, maxDepth)
  return findings
}

/** An instance of an export-marked component (icons, country flags) is an opaque graphic too:
 * the export flag lives on the main component, and Figma does NOT surface it on the instance
 * node itself — without this lookup the linter descends into every icon instance and flags
 * artwork colors that will never be design-system tokens. Cached per main component. */
async function instanceOfExportedComponent(instance: InstanceNode, cache: Map<string, boolean>): Promise<boolean> {
  let main: ComponentNode | null = null
  try {
    main = await instance.getMainComponentAsync()
  } catch {
    return false
  }
  if (!main) return false
  const cached = cache.get(main.id)
  if (cached !== undefined) return cached
  const flagged = isExportedGraphic(main)
  cache.set(main.id, flagged)
  return flagged
}

/** Same walk and output order as `lintScope`, but yields to the host thread periodically —
 * plugin code runs on Figma's main thread, and a sync walk over a large page freezes the app. */
export async function lintScopeAsync(roots: readonly SceneNode[], options: LintOptions = {}): Promise<LintFinding[]> {
  const maxDepth = options.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH
  const YIELD_EVERY = 500
  const findings: LintFinding[] = []
  let visited = 0
  const exportedMainCache = new Map<string, boolean>()
  const stack: Array<{ node: SceneNode; depth: number }> = []
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], depth: 0 })
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!
    // Skip designer-marked graphics and their subtrees — they export as a single asset.
    if (isExportedGraphic(node)) continue
    if (node.type === 'INSTANCE' && (await instanceOfExportedComponent(node, exportedMainCache))) continue
    checkNodeShallow(node, depth, findings, maxDepth)
    if (hasChildren(node)) {
      const childDepth = startsNewTemplateFile(node) ? 0 : depth + 1
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i], depth: childDepth })
      }
    }
    if (++visited % YIELD_EVERY === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return findings
}
