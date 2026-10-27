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
import { editorProblem, gridPlace } from './board.ts'
import { componentFor } from './components.ts'
import { dependsOnChildren, dependsOnPlacement, movesToAnotherParent, planProps, type PropStep } from './props.ts'

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
  'slice',
  // FigJam
  'sticky',
  'shapeWithText',
  'connector',
  'codeBlock',
  'table',
  'linkPreview',
  'gif',
  // Figma Slides
  'slide',
  'slideRow',
  // Figma Buzz
  'asset',
] as const

/** The editor a kind can only be made in — the rest are made anywhere a canvas is. */
const KIND_FEATURE: Partial<Record<NodeKind, string>> = {
  component: 'components.create',
  sticky: 'stickies',
  shapeWithText: 'shapesWithText',
  connector: 'connectors',
  codeBlock: 'codeBlocks',
  table: 'tables',
  linkPreview: 'linkPreviews',
  gif: 'gifs',
  slide: 'slides',
  slideRow: 'slides',
  asset: 'buzz',
}

/** Why this kind cannot be made in this editor, or null. Pure, so the refusal is testable. */
export function kindProblem(kind: NodeKind, editor: string): string | null {
  const feature = KIND_FEATURE[kind]
  return feature ? editorProblem(feature, editor, kind) : null
}

/** Kinds whose `at` is a place on the Slides or Buzz grid, `[row, column]`. */
const GRID_PLACED: readonly string[] = ['slide', 'slideRow', 'asset']

export type NodeKind = (typeof NODE_KINDS)[number]

export interface CreateSpec {
  kind: NodeKind
  /** For `instance`: the component to instantiate — an id, or a published component key.
   *  For `svg`: the markup itself. For `textPath`: the VECTOR the text will follow.
   *  For `linkPreview`: the URL. For `gif`: the image hash. For `asset`: optionally a component. */
  of?: string
  /** `textPath`: [segment, position] — where on the outline the text starts.
   *  `slide`, `asset`: [row, column] on the grid; `slideRow`: [row]. */
  at?: [number, number] | [number]
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
  /**
   * The properties that did not take, and why — beside the count rather than inside `applied`.
   * A long `applied` list is spilled to a file by the digest, and `failed: 1` with the reason in
   * a file the caller has to go and open is a report that hides the only line that mattered.
   */
  failures?: string[]
}

export interface CreatePlan {
  kind: NodeKind
  of?: string
  /** `textPath`: which segment of the vector the text starts on, and how far along it.
   *  `slide`, `slideRow`, `asset`: the row and column on the grid. */
  at?: [number, number] | [number]
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
  if ((kind === 'linkPreview' || kind === 'gif') && (typeof spec.of !== 'string' || spec.of === '')) {
    problems.push(`${where}.of must be ${kind === 'gif' ? 'the image hash of the GIF' : 'the URL to preview'}`)
    return null
  }
  if (GRID_PLACED.includes(kind) && spec.at !== undefined) {
    const place = gridPlace(spec.at)
    if (!place || (kind === 'slideRow' && place.column !== undefined)) {
      problems.push(`${where}.at must be ${kind === 'slideRow' ? '[row]' : '[row, column]'} — whole numbers from 0`)
      return null
    }
  } else if (spec.at !== undefined && kind !== 'textPath') {
    problems.push(`${where}.at is for textPath, slide, slideRow and asset — not ${kind}`)
    return null
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
    ...(Array.isArray(spec.at) ? { at: spec.at as [number, number] | [number] } : {}),
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
  // Everything except what describes children the node does not have yet, and what describes its
  // place in a parent it is not in yet.
  const later = plan.steps.filter((step) => dependsOnChildren(step) || dependsOnPlacement(step))
  const report = await applyProps(
    node,
    plan.steps.filter((step) => !dependsOnChildren(step) && !dependsOnPlacement(step)),
    false
  )

  const children: CreatedNode[] = []
  for (const child of plan.children) {
    // The node that declared the child IS the child's parent, and it is handed over as such
    // rather than left to the page. A child built against the page and moved afterwards had
    // already run the half of its properties that only mean something inside a parent — FILL,
    // absolute positioning, its own size — against the wrong one, so each was applied, reported
    // and lost.
    children.push(await createNode(child, node as BaseNode & ChildrenMixin, false))
  }

  // Placed before the last pass, not after it: half of what is left describes where the node sits
  // in its parent, and until it has one there is nothing for those properties to describe.
  //
  // The test is "not already there" rather than "has no parent": every `figma.create*` hands back
  // a node already parented to the current page, so a check for a null parent is never true and
  // the child would sit on the page for ever.
  //
  // "A step that names a parent", not "a reparent step": `index` alone plans a reparent with an
  // empty parent, meaning "stay where you are, move to this position". Treating that as a move
  // left the node wherever `figma.create*` had put it — the page — so `index: 0` inside a call
  // that named a parent quietly built the node somewhere else, and the FILL that followed
  // failed with "FILL can only be set on children of auto-layout frames".
  const moves = plan.steps.some(movesToAnotherParent)
  // A slide or a Buzz asset is put on its grid by the call that made it; appending it to the page
  // would lift it out of the deck. Inside a row the caller named, it goes where it was told.
  const gridded = GRID_PLACED.includes(plan.kind) && fallbackParent.type === 'PAGE'
  if (!moves && !gridded && node.parent !== fallbackParent) {
    fallbackParent.appendChild(node)
  }

  // Now that the children are in and the node is placed, the rest can be set.
  const late = later.length > 0 ? await applyProps(node, later, false) : { applied: [], failed: 0 }

  const applied = [...report.applied, ...late.applied]
  const failures = applied
    .filter((entry) => entry.error)
    .map((entry) => `${entry.property}: ${entry.error}`)

  return {
    kind: plan.kind,
    id: node.id,
    name: node.name,
    parent: node.parent ? { id: node.parent.id, name: node.parent.name } : null,
    applied,
    children,
    failed: report.failed + late.failed + children.reduce((total, child) => total + child.failed, 0),
    ...(failures.length > 0 ? { failures } : {}),
  }
}

async function make(plan: CreatePlan): Promise<SceneNode> {
  const refusal = kindProblem(plan.kind, figma.editorType)
  if (refusal) throw new Error(refusal)
  const [row, column] = plan.at ?? []
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
    // An export area and nothing else: no fill, no children, only a box and the export rows
    // export.configure gives it — how a designer marks "ship this region" across several layers.
    case 'slice':
      return figma.createSlice()
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
      const [segment, position] = (plan.at ?? [0, 0]) as [number, number]
      const path = figma.createTextPath(outline, segment, position)
      const font = path.fontName
      if (font !== figma.mixed) await figma.loadFontAsync(font as FontName)
      return path
    }
    case 'instance': {
      const target = await componentFor(plan.of!)
      return target.createInstance()
    }
    case 'sticky':
      return withSublayerFont(figma.createSticky())
    case 'shapeWithText':
      return withSublayerFont(figma.createShapeWithText())
    case 'connector':
      return withSublayerFont(figma.createConnector())
    case 'codeBlock':
      return figma.createCodeBlock()
    case 'table': {
      // The size comes from `props.table`, which grows or cuts it after; Figma's default is 2×2.
      const table = figma.createTable()
      await figma.loadFontAsync(table.cellAt(0, 0).text.fontName as FontName)
      return table
    }
    case 'linkPreview':
      return (await figma.createLinkPreviewAsync(plan.of!)) as SceneNode
    case 'gif':
      return figma.createGif(plan.of!)
    case 'slide':
      return figma.createSlide(row, column)
    case 'slideRow':
      return figma.createSlideRow(row)
    case 'asset': {
      const buzz = figma.buzz
      if (plan.of) {
        const target = await componentFor(plan.of)
        return buzz.createInstance(target, row ?? 0, column)
      }
      return buzz.createFrame(row, column)
    }
  }
}

/** A new sticky's words are in the editor's default font, which has to be in memory before any
 * text step can touch them. */
async function withSublayerFont<T extends StickyNode | ShapeWithTextNode | ConnectorNode>(node: T): Promise<T> {
  const font = node.text.fontName
  // A new connector has no words and so no font at all — `{ family: "" }`, which cannot be loaded.
  // It is given the board's own default, Inter Medium, the font a new sticky already carries.
  if (font !== figma.mixed && font.family !== '') await figma.loadFontAsync(font)
  else if (font !== figma.mixed) {
    const fallback = { family: 'Inter', style: 'Medium' }
    await figma.loadFontAsync(fallback)
    node.text.fontName = fallback
  }
  return node
}

const nameFrom = (plan: CreatePlan): string | null => {
  for (const step of plan.steps) if (step.step === 'assign' && step.property === 'name') return String(step.value)
  return null
}

const describeStep = (step: PropStep): string =>
  step.step === 'assign' || step.step === 'paint' ? step.property : step.step
