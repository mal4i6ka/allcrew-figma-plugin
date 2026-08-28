/**
 * Making nodes, from a description.
 *
 * The counterpart to `apply.ts`: that changes what exists, this brings it into being. A tree of
 * `{ kind, props, children }` becomes a tree of real nodes, each one's properties applied through
 * the same plan the change path uses — one vocabulary for both, so a caller who can style a frame
 * can style a frame they just made.
 *
 * The order is not an accident. A node is created detached, filled in, and only then put where it
 * belongs: appending first means the designer watches an unstyled rectangle appear and then
 * change, and a node created inside an auto-layout parent gets laid out twice.
 */

import { applyProps, type AppliedProp } from './apply.ts'
import { componentFor } from './components.ts'
import { dependsOnChildren, planProps, type PropStep } from './props.ts'

export const NODE_KINDS = [
  'frame',
  'text',
  'rectangle',
  'ellipse',
  'line',
  'section',
  'component',
  'instance',
  'vector',
  'svg',
  'star',
  'polygon',
  'textPath',
] as const

export type NodeKind = (typeof NODE_KINDS)[number]

export interface CreateSpec {
  kind: NodeKind
  /** For `instance`: the component to instantiate — an id, or a published component key.
   *  For `svg`: the markup itself. For `textPath`: the VECTOR the text will follow. */
  of?: string
  /** `textPath` only: [segment, position] — where on the outline the text starts. */
  at?: [number, number]
  props?: unknown
  children?: unknown
}

export interface CreatedNode {
  kind: NodeKind
  id: string
  name: string
  parent: { id: string; name: string } | null
  applied: AppliedProp[]
  children: CreatedNode[]
  failed: number
}

export interface CreatePlan {
  kind: NodeKind
  of?: string
  /** `textPath` only: which segment of the vector the text starts on, and how far along it. */
  at?: [number, number]
  steps: PropStep[]
  children: CreatePlan[]
}

/**
 * Reads a create spec without touching the document — every problem in the tree, with the path
 * that caused it, before anything is made. One bad grandchild should not leave half a card on the
 * canvas.
 */
export function planCreate(raw: unknown, where: string, problems: string[]): CreatePlan | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push(`${where} must be an object`)
    return null
  }
  const spec = raw as Record<string, unknown>
  const kind = spec.kind
  if (typeof kind !== 'string' || !NODE_KINDS.includes(kind as NodeKind)) {
    problems.push(`${where}.kind must be one of: ${NODE_KINDS.join(', ')}`)
    return null
  }
  if (kind === 'instance' && typeof spec.of !== 'string') {
    problems.push(`${where}.of must name the component to instantiate (an id or a published key)`)
    return null
  }
  if (kind === 'svg' && (typeof spec.of !== 'string' || !spec.of.includes('<svg'))) {
    problems.push(`${where}.of must be the SVG markup itself, starting with <svg`)
    return null
  }
  if (kind === 'textPath') {
    if (typeof spec.of !== 'string') {
      problems.push(`${where}.of must name the VECTOR whose outline the text will follow`)
      return null
    }
    if (spec.at !== undefined) {
      const at = spec.at
      if (
        !Array.isArray(at) ||
        at.length !== 2 ||
        typeof at[0] !== 'number' ||
        !Number.isInteger(at[0]) ||
        at[0] < 0 ||
        typeof at[1] !== 'number' ||
        at[1] < 0 ||
        at[1] > 1
      ) {
        problems.push(`${where}.at must be [segment, position] — a whole segment index and 0..1 along it`)
        return null
      }
    }
  }
  for (const key of Object.keys(spec)) {
    if (!['kind', 'of', 'props', 'children', 'at'].includes(key)) {
      problems.push(`${where}: unknown key "${key}" — accepted: kind, of, props, children, at`)
    }
  }

  const plan = planProps(spec.props, `${where}.props`)
  problems.push(...plan.problems)

  const children: CreatePlan[] = []
  if (spec.children !== undefined) {
    if (!Array.isArray(spec.children)) problems.push(`${where}.children must be an array`)
    else {
      for (const [index, child] of spec.children.entries()) {
        const childPlan = planCreate(child, `${where}.children[${index}]`, problems)
        if (childPlan) children.push(childPlan)
      }
    }
  }

  return {
    kind: kind as NodeKind,
    ...(typeof spec.of === 'string' ? { of: spec.of } : {}),
    ...(Array.isArray(spec.at) ? { at: spec.at as [number, number] } : {}),
    steps: plan.steps,
    children,
  }
}

export async function createNode(plan: CreatePlan, fallbackParent: BaseNode & ChildrenMixin, dry: boolean): Promise<CreatedNode> {
  // A dry run answers without making anything, so the caller can see the tree it would get.
  if (dry) {
    return {
      kind: plan.kind,
      id: '(dry run)',
      name: nameFrom(plan) ?? plan.kind,
      parent: { id: fallbackParent.id, name: fallbackParent.name },
      applied: plan.steps.map((step) => ({ property: describeStep(step), after: 'would be set' })),
      children: await Promise.all(plan.children.map((child) => createNode(child, fallbackParent, true))),
      failed: 0,
    }
  }

  const node = await make(plan)
  // Everything except what describes children the node does not have yet.
  const later = plan.steps.filter(dependsOnChildren)
  const report = await applyProps(node, plan.steps.filter((step) => !dependsOnChildren(step)), false)

  const children: CreatedNode[] = []
  for (const child of plan.children) {
    const made = await createNode(child, fallbackParent, false)
    const childNode = await figma.getNodeByIdAsync(made.id)
    // A child whose own props named a parent has already been placed there; the rest belong to
    // the node that declared them.
    if (childNode && childNode.parent === figma.currentPage && !child.steps.some((step) => step.step === 'reparent')) {
      ;(node as FrameNode).appendChild(childNode as SceneNode)
    }
    children.push(made)
  }

  // Now that the children are in, the properties that talk about them can be set.
  const late = later.length > 0 ? await applyProps(node, later, false) : { applied: [], failed: 0 }

  // Placed last, and only if nothing in its own props already placed it.
  if (!plan.steps.some((step) => step.step === 'reparent') && node.parent === null) {
    fallbackParent.appendChild(node)
  }

  return {
    kind: plan.kind,
    id: node.id,
    name: node.name,
    parent: node.parent ? { id: node.parent.id, name: node.parent.name } : null,
    applied: [...report.applied, ...late.applied],
    children,
    failed: report.failed + late.failed + children.reduce((total, child) => total + child.failed, 0),
  }
}

async function make(plan: CreatePlan): Promise<SceneNode> {
  switch (plan.kind) {
    case 'frame':
      return figma.createFrame()
    case 'rectangle':
      return figma.createRectangle()
    case 'ellipse':
      return figma.createEllipse()
    case 'line':
      return figma.createLine()
    case 'section':
      return figma.createSection()
    case 'component':
      return figma.createComponent()
    case 'text': {
      const text = figma.createText()
      // A fresh text node has Inter Regular loaded by the editor, but a file whose default font
      // is missing hands back a node nothing can be written into — so the font it claims is
      // loaded before anyone tries.
      const font = text.fontName
      if (font !== figma.mixed) await figma.loadFontAsync(font as FontName)
      return text
    }
    case 'vector':
      return figma.createVector()
    case 'star':
      return figma.createStar()
    case 'polygon':
      return figma.createPolygon()
    case 'svg':
      // Figma parses the markup itself and hands back a frame of real vector layers — which is
      // how an icon gets onto the canvas without anyone hand-writing a path.
      return figma.createNodeFromSvg(plan.of!)
    case 'textPath': {
      const outline = await figma.getNodeByIdAsync(plan.of!)
      if (!outline || outline.type !== 'VECTOR') {
        throw new Error(`${plan.of} is ${outline ? `a ${outline.type}` : 'not a node'}, and text follows a VECTOR`)
      }
      // `createTextPath` CHANGES the type of the node it is given, so the returned object is the
      // one to keep — the original handle now describes something that no longer exists.
      const [segment, position] = plan.at ?? [0, 0]
      const path = figma.createTextPath(outline, segment, position)
      const font = path.fontName
      if (font !== figma.mixed) await figma.loadFontAsync(font as FontName)
      return path
    }
    case 'instance': {
      const target = await componentFor(plan.of!)
      return target.createInstance()
    }
  }
}

const nameFrom = (plan: CreatePlan): string | null => {
  for (const step of plan.steps) if (step.step === 'assign' && step.property === 'name') return String(step.value)
  return null
}

const describeStep = (step: PropStep): string =>
  step.step === 'assign' || step.step === 'paint' ? step.property : step.step
