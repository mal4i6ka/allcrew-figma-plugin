/**
 * Agent listener — moving and duplicating nodes: cut-and-paste and copy-and-paste as ops.
 *
 * The panel commands NODE_SET (props.parent) and NODE_CLONE already do both, and modules keep
 * using them. These are the same two edits with the contract every op here keeps: by id, in a
 * batch, a dry run that answers exactly what the real run would, and a report per node of what
 * actually happened — where it was, where it is now, and on which page.
 *
 * Like node.remove, a batch is resolved and screened in full before the first change: a refusal
 * found halfway through must not leave the nodes ahead of it already moved.
 */

import type { OpDef } from './protocol.ts'

/** What a move or a copy needs to know about a node, without needing a document. */
export interface Placeable {
  id: string
  type: string
  name?: string
  parent: Placeable | null
}

/** Inside an instance, a layer belongs to the main component: Figma refuses to move it out, to
 * put anything into it, and to copy it. True for the instance itself only when `self` is set. */
export function insideInstance(node: Placeable, self = false): boolean {
  if (self && node.type === 'INSTANCE') return true
  for (let walk = node.parent; walk; walk = walk.parent) if (walk.type === 'INSTANCE') return true
  return false
}

const CONTAINERS = new Set(['PAGE', 'FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'BOOLEAN_OPERATION', 'TRANSFORM_GROUP'])

/** The whole refusal policy for a destination, as a pure function. Throws with the message the
 * report will carry. `node` is null for a copy, which cannot land inside itself. */
export function screenDestination(target: Placeable, node: Placeable | null): void {
  if (!CONTAINERS.has(target.type)) throw new Error(`${target.name ?? target.id} is a ${target.type}, which cannot hold layers`)
  if (target.type === 'INSTANCE' || insideInstance(target)) {
    throw new Error(`${target.name ?? target.id} is inside an instance — its layers belong to the main component`)
  }
  if (target.type === 'COMPONENT_SET' && node && node.type !== 'COMPONENT') {
    throw new Error('a component set holds only its variants')
  }
  if (node) {
    for (let walk: Placeable | null = target; walk; walk = walk.parent) {
      if (walk.id === node.id) throw new Error(`${target.name ?? target.id} is ${walk === target ? 'the node itself' : 'inside the node'} — a node cannot go into itself`)
    }
  }
}

/** The refusal policy for the node being moved or copied. */
export function screenSource(node: Placeable, kind: 'move' | 'copy'): void {
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error(`a ${node.type} cannot be ${kind === 'move' ? 'moved' : 'copied'} here`)
  if (insideInstance(node)) {
    throw new Error(`${node.name ?? node.id} is a layer inside an instance — it belongs to the main component; ${kind === 'move' ? 'detach the instance or move the instance itself' : 'copy the instance, or detach it first'}`)
  }
}

interface Row {
  node: string
  parent?: string
  index?: number
  x?: number
  y?: number
  name?: string
}

function asRows(value: unknown): Row[] {
  const list = Array.isArray(value) ? (value as unknown[]) : []
  const rows = list.map((entry, i) => {
    if (typeof entry === 'string' && entry !== '') return { node: entry }
    if (entry && typeof entry === 'object' && typeof (entry as Row).node === 'string' && (entry as Row).node !== '') {
      const row = entry as Row
      for (const key of ['index', 'x', 'y'] as const) {
        if (row[key] !== undefined && (typeof row[key] !== 'number' || !Number.isFinite(row[key]))) throw new Error(`nodes[${i}].${key} must be a number`)
      }
      if (row.parent !== undefined && (typeof row.parent !== 'string' || row.parent === '')) throw new Error(`nodes[${i}].parent must be a node id`)
      return row
    }
    throw new Error(`nodes[${i}] must be a node id or { node, parent?, index?, x?, y? }`)
  })
  if (rows.length === 0) throw new Error('"nodes" must be a non-empty array')
  return rows
}

const pageOf = (node: BaseNode | null): { id: string; name: string } | null => {
  let walk: BaseNode | null = node
  while (walk && walk.type !== 'PAGE') walk = walk.parent
  return walk ? { id: walk.id, name: (walk as PageNode).name } : null
}

const where = (node: SceneNode) => {
  const parent = node.parent
  return {
    parent: parent ? { id: parent.id, name: (parent as BaseNode).name, type: parent.type } : null,
    index: parent && 'children' in parent ? (parent as ChildrenMixin).children.indexOf(node) : null,
    page: pageOf(node),
    x: Math.round(node.x * 100) / 100,
    y: Math.round(node.y * 100) / 100,
  }
}

/** Absolute canvas position — the transform's translation, which is what a designer sees. */
const absoluteOf = (node: BaseNode): { x: number; y: number } | null => {
  if (!('absoluteTransform' in node)) return null
  const t = (node as SceneNode).absoluteTransform
  return { x: t[0][2], y: t[1][2] }
}

const laysOut = (parent: BaseNode | null) =>
  !!parent && 'layoutMode' in parent && (parent as FrameNode).layoutMode !== 'NONE'

const stays = (node: SceneNode) => 'layoutPositioning' in node && (node as FrameNode).layoutPositioning === 'ABSOLUTE'

async function resolveContainer(id: string): Promise<BaseNode & ChildrenMixin> {
  const found = await figma.getNodeByIdAsync(id)
  if (!found) throw new Error(`no node with id ${id}`)
  if (found.type === 'PAGE') await (found as PageNode).loadAsync()
  return found as BaseNode & ChildrenMixin
}

/** Puts `node` into `parent` at `index`, then where the caller said or — when the parent does not
 * lay it out — where it was on the canvas, so a move to another frame does not jump. */
function place(node: SceneNode, parent: BaseNode & ChildrenMixin, row: Row, keepAt: { x: number; y: number } | null): void {
  if (row.index === undefined) parent.appendChild(node)
  else parent.insertChild(Math.max(0, Math.min(row.index, parent.children.length)), node)
  if (laysOut(parent) && !stays(node)) return
  if (row.x !== undefined || row.y !== undefined) {
    if (row.x !== undefined) node.x = row.x
    if (row.y !== undefined) node.y = row.y
    return
  }
  const origin = parent.type === 'PAGE' ? { x: 0, y: 0 } : absoluteOf(parent)
  if (keepAt && origin) {
    node.x = keepAt.x - origin.x
    node.y = keepAt.y - origin.y
  }
}

const CLONE_GAP = 40

export const ARRANGE_OPS: readonly OpDef[] = [
  {
    name: 'node.move',
    summary: 'Move nodes into another frame, group, section or page, or reorder them — cut and paste, by id.',
    agent:
      'Cut-and-paste as one call. `parent` is where the node goes (any frame, group, section or page); `index` is its place ' +
      'among the new siblings — 0 is the bottom of the layer stack, so `index` alone, without `parent`, is "bring forward / ' +
      'send backward". A node moved into a parent that does not lay it out keeps its place on the canvas, the way a drag ' +
      'between frames does, unless `x`/`y` say otherwise; into an auto-layout frame it simply joins the flow. Refused: a layer ' +
      'inside an instance (it belongs to the main component), a destination inside an instance, and a node into itself. ' +
      'Every row reports `before` and `after` — parent, index, page, position. One call is one undo step.',
    mutates: true,
    params: {
      nodes: {
        type: 'json',
        required: true,
        description:
          'What to move: `[{ node: "<id>", parent?: "<id>", index?: n, x?: n, y?: n }]`. Give at least one of parent, index, x, y.',
      },
      dryRun: { type: 'boolean', default: false, description: 'Screen every row and report where each node would go, moving nothing.' },
    },
    async run(params) {
      const rows = asRows(params.nodes)
      const dryRun = params.dryRun === true
      const planned: Array<{ node: SceneNode; parent: BaseNode & ChildrenMixin; row: Row }> = []
      const results: Array<Record<string, unknown>> = []
      for (const row of rows) {
        try {
          if (row.parent === undefined && row.index === undefined && row.x === undefined && row.y === undefined) {
            throw new Error('nothing to do — give parent, index, x or y')
          }
          const found = await figma.getNodeByIdAsync(row.node)
          if (!found) throw new Error(`no node with id ${row.node}`)
          screenSource(found as unknown as Placeable, 'move')
          const node = found as SceneNode
          const parent = row.parent !== undefined ? await resolveContainer(row.parent) : (node.parent as BaseNode & ChildrenMixin)
          if (!parent) throw new Error('the node has no parent to move within')
          screenDestination(parent as unknown as Placeable, node as unknown as Placeable)
          planned.push({ node, parent, row })
        } catch (err) {
          results.push({ node: row.node, ok: false, moved: false, error: String((err as Error)?.message || err) })
        }
      }

      if (dryRun) {
        for (const { node, parent, row } of planned) {
          results.push({
            node: node.id,
            name: node.name,
            ok: true,
            moved: false,
            before: where(node),
            to: { parent: { id: parent.id, name: parent.name, type: parent.type }, index: row.index ?? null, page: pageOf(parent) },
          })
        }
        return { dryRun, total: rows.length, moved: 0, failed: results.filter((r) => !r.ok).length, results }
      }

      for (const { node, parent, row } of planned) {
        const before = where(node)
        try {
          const keepAt = row.parent !== undefined && row.parent !== before.parent?.id ? absoluteOf(node) : null
          if (row.parent === undefined && row.index === undefined) {
            if (row.x !== undefined) node.x = row.x
            if (row.y !== undefined) node.y = row.y
          } else {
            place(node, parent, row, keepAt)
          }
          const after = where(node)
          // Read back rather than assumed: Figma clamps an index and can refuse a parent quietly.
          const landed = after.parent?.id === parent.id
          results.push({ node: node.id, name: node.name, ok: landed, moved: landed, before, after, ...(landed ? {} : { error: 'the node is not where it was put' }) })
        } catch (err) {
          results.push({ node: node.id, name: node.name, ok: false, moved: false, before, error: String((err as Error)?.message || err) })
        }
      }
      if (planned.length > 0) figma.commitUndo()
      return { dryRun, total: rows.length, moved: results.filter((r) => r.moved === true).length, failed: results.filter((r) => !r.ok).length, results }
    },
  },

  {
    name: 'node.duplicate',
    summary: 'Copy nodes and paste the copies beside them or into any frame or page — copy and paste, by id.',
    agent:
      'Copy-and-paste as one call. Without `parent` the copy goes right above its source in the same parent and — where the ' +
      'parent does not lay it out — steps to the right of it, so it is not hidden exactly on top; with `parent` it lands there ' +
      '(keeping the source\'s canvas position unless `x`/`y` say otherwise). `name` renames the copy. A main COMPONENT or a ' +
      'COMPONENT_SET is copied as a new main only with `components: "clone"`; by default a component pastes as an INSTANCE ' +
      'and a set is refused, because a second main is a worse defect than the question the copy was for. A layer inside an ' +
      'instance cannot be copied — copy the instance. Each row reports the new id. One call is one undo step.',
    mutates: true,
    params: {
      nodes: {
        type: 'json',
        required: true,
        description: 'What to copy: `[{ node: "<id>", parent?: "<id>", index?: n, x?: n, y?: n, name?: "…" }]`, or plain ids.',
      },
      components: {
        type: 'string',
        enum: ['instance', 'clone'],
        default: 'instance',
        description: 'A main COMPONENT pastes as an instance of itself (default), or as a second main with "clone". A set needs "clone".',
      },
      dryRun: { type: 'boolean', default: false, description: 'Screen every row and report where each copy would go, creating nothing.' },
    },
    async run(params) {
      const rows = asRows(params.nodes)
      const dryRun = params.dryRun === true
      const cloneMains = params.components === 'clone'
      const planned: Array<{ node: SceneNode; parent: BaseNode & ChildrenMixin; row: Row; as: 'clone' | 'instance' }> = []
      const results: Array<Record<string, unknown>> = []
      for (const row of rows) {
        try {
          const found = await figma.getNodeByIdAsync(row.node)
          if (!found) throw new Error(`no node with id ${row.node}`)
          screenSource(found as unknown as Placeable, 'copy')
          const node = found as SceneNode
          if (node.type === 'COMPONENT_SET' && !cloneMains) {
            throw new Error(`${node.name} is a component set — copying it makes a second set of mains; pass components: "clone" if that is intended`)
          }
          const parent = row.parent !== undefined ? await resolveContainer(row.parent) : (node.parent as BaseNode & ChildrenMixin)
          if (!parent) throw new Error('the node has no parent to paste beside')
          screenDestination(parent as unknown as Placeable, null)
          const as = node.type === 'COMPONENT' && !cloneMains ? 'instance' : 'clone'
          if (as === 'instance' && parent.type === 'COMPONENT_SET') throw new Error('an instance cannot go into a component set')
          planned.push({ node, parent, row, as })
        } catch (err) {
          results.push({ source: row.node, ok: false, error: String((err as Error)?.message || err) })
        }
      }

      if (dryRun) {
        for (const { node, parent, row, as } of planned) {
          results.push({ source: node.id, name: row.name ?? node.name, type: node.type, as, ok: true, to: { parent: { id: parent.id, name: parent.name }, page: pageOf(parent) } })
        }
        return { dryRun, total: rows.length, copied: 0, failed: results.filter((r) => !r.ok).length, results }
      }

      for (const { node, parent, row, as } of planned) {
        try {
          const copy: SceneNode = as === 'instance' ? (node as ComponentNode).createInstance() : node.clone()
          const beside = row.parent === undefined
          if (beside) {
            const siblings = (parent as ChildrenMixin).children
            const at = siblings.indexOf(node)
            parent.insertChild(row.index ?? (at >= 0 ? at + 1 : siblings.length), copy)
            if (row.x !== undefined || row.y !== undefined) {
              if (row.x !== undefined) copy.x = row.x
              if (row.y !== undefined) copy.y = row.y
            } else if (!laysOut(parent) || stays(copy)) {
              copy.x = node.x + node.width + CLONE_GAP
              copy.y = node.y
            }
          } else {
            place(copy, parent, row, absoluteOf(node))
          }
          if (row.name !== undefined) copy.name = row.name
          const at = where(copy)
          results.push({ source: node.id, node: copy.id, name: copy.name, type: copy.type, as, ok: at.parent?.id === parent.id, ...at })
        } catch (err) {
          results.push({ source: node.id, name: node.name, ok: false, error: String((err as Error)?.message || err) })
        }
      }
      if (planned.length > 0) figma.commitUndo()
      return { dryRun, total: rows.length, copied: results.filter((r) => r.ok && r.node).length, failed: results.filter((r) => !r.ok).length, results }
    },
  },
]
