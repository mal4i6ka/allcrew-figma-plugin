/**
 * T2.3 IR optimization passes (docs/research/04-figma-to-django-templates.md §4.4, §5): these run
 * on the IR tree after layout normalization (T2.2/ir.ts) and before codegen (T3.1/django/*), fixing
 * the "grabli" that survive a literal Figma → IR translation.
 */

import type { IrNode } from './ir.ts'

/**
 * Collapses a `container` node into its single child when it contributes nothing of its own: no
 * component definition, no flex/grid layout (`absolute` only — a pure positional passthrough), and
 * exactly one child. The child's position is offset by the collapsed node's position so its final
 * position relative to its new parent is unchanged (docs §4.4.2: "фрейм без визуальных свойств с
 * одним ребёнком — слить с ребёнком"). Runs bottom-up so chains of wrapper frames collapse fully.
 */
export function collapseRedundantNesting(nodes: readonly IrNode[]): IrNode[] {
  return nodes.map(collapseNode)
}

function isRedundantWrapper(node: IrNode): node is Extract<IrNode, { type: 'container' }> {
  return (
    node.type === 'container' &&
    node.component === null &&
    node.backgroundImages === undefined && // an image fill is a visual property of its own — keep the box
    node.layout.kind === 'absolute' &&
    node.children.length === 1
  )
}

function collapseNode(node: IrNode): IrNode {
  if (!('children' in node)) return node

  const collapsedChildren = node.children.map(collapseNode)
  const withCollapsedChildren = { ...node, children: collapsedChildren }

  if (!isRedundantWrapper(withCollapsedChildren)) return withCollapsedChildren

  const child = collapsedChildren[0]
  return {
    ...child,
    position: {
      x: withCollapsedChildren.position.x + child.position.x,
      y: withCollapsedChildren.position.y + child.position.y,
    },
  }
}

export type SemanticTag = 'nav' | 'button' | 'img'

/** First `/`-separated segment of a layer name, lowercased — Figma's component-set naming idiom
 * (`nav/Header`, `btn/Primary`) doubles as a semantics convention (docs §4.3, Locofy "tagging"). */
const SEMANTIC_TAG_BY_PREFIX: Record<string, SemanticTag> = {
  nav: 'nav',
  navigation: 'nav',
  btn: 'button',
  button: 'button',
  img: 'img',
  image: 'img',
}

export interface SemanticTagInfo {
  /** `null` when the layer name doesn't match a known convention — caller falls back to a generic tag. */
  tag: SemanticTag | null
  /** Layer name with the recognized prefix stripped — a cleaner `alt`/label source than the raw
   * "img/Hero shot" (docs §4.4.4: alt-тексты нужны из конвенций именования). */
  label: string
}

/** Docs §4.4.4: HTML tag semantics don't exist in Figma — infer them from the layer-name convention. */
export function inferSemanticTag(name: string): SemanticTagInfo {
  const slashIndex = name.indexOf('/')
  if (slashIndex === -1) return { tag: null, label: name.trim() }

  const prefix = name.slice(0, slashIndex).trim().toLowerCase()
  const label = name.slice(slashIndex + 1).trim()
  return { tag: SEMANTIC_TAG_BY_PREFIX[prefix] ?? null, label: label === '' ? name.trim() : label }
}

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug === '') return 'n'
  return /^[0-9]/.test(slug) ? `n-${slug}` : slug
}

function uniqueClassName(base: string, usedNames: Set<string>): string {
  if (!usedNames.has(base)) {
    usedNames.add(base)
    return base
  }
  let suffix = 2
  while (usedNames.has(`${base}-${suffix}`)) suffix++
  const name = `${base}-${suffix}`
  usedNames.add(name)
  return name
}

/** Order-independent key for a declarations map, so two nodes with the same rules in a different
 * insertion order still dedup to the same class. */
function declarationsKey(declarations: Record<string, string>): string {
  return Object.keys(declarations)
    .sort()
    .map((property) => `${property}:${declarations[property]}`)
    .join(';')
}

function collectNodesPreOrder(nodes: readonly IrNode[], out: IrNode[]): void {
  for (const node of nodes) {
    out.push(node)
    if ('children' in node) collectNodesPreOrder(node.children, out)
  }
}

export interface CssClassAssignment {
  /** Every IR node's assigned class name, keyed by node id. */
  classNameById: Map<string, string>
  /** The deduplicated rule set to emit: one entry per distinct declarations map, keyed by the
   * (possibly shared) class name nodes with identical style were assigned. */
  declarationsByClassName: Map<string, Record<string, string>>
}

/**
 * Docs §4.4.5: class names sourced from layer names collide ("Frame 427" repeated) and layer-name
 * dedup alone doesn't catch nodes that render *identical* CSS under different names — so this pass
 * does both: sanitizes+dedupes names for uniqueness, then merges nodes whose declarations are
 * byte-for-byte identical onto a single shared class instead of emitting the same rule twice.
 */
export function assignCssClasses(
  nodes: readonly IrNode[],
  declarationsById: ReadonlyMap<string, Record<string, string>>
): CssClassAssignment {
  const allNodes: IrNode[] = []
  collectNodesPreOrder(nodes, allNodes)

  const usedNames = new Set<string>()
  const classNameById = new Map<string, string>()
  const declarationsByClassName = new Map<string, Record<string, string>>()
  const classNameByDeclarationsKey = new Map<string, string>()

  for (const node of allNodes) {
    const declarations = declarationsById.get(node.id)
    const key = declarations ? declarationsKey(declarations) : null

    const sharedClassName = key !== null ? classNameByDeclarationsKey.get(key) : undefined
    if (sharedClassName !== undefined) {
      classNameById.set(node.id, sharedClassName)
      continue
    }

    const className = uniqueClassName(slugify(node.name), usedNames)
    classNameById.set(node.id, className)
    if (key !== null && declarations) {
      classNameByDeclarationsKey.set(key, className)
      declarationsByClassName.set(className, declarations)
    }
  }

  return { classNameById, declarationsByClassName }
}
