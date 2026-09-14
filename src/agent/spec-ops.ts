/**
 * Agent listener — the measuring stick.
 *
 * Everything else in this listener answers "what is in the file". This op answers a different
 * question: "what numbers should the built page hit". The difference matters because the way a
 * design is checked today is a screenshot diff — it sees a dark band where a section should be
 * and calls it 90% similar, while the padding is off by 20px and the heading is set two steps
 * too large. A pixel score cannot name the property that is wrong, so the correction lands by
 * hand, page after page.
 *
 * Figma already computes the exact declarations for a layer (`getCSSAsync`). Handing those out,
 * addressed by a stable path, turns "looks close" into an assertion a test can make: the
 * consumer reads the same node it built a block from and compares declaration by declaration.
 *
 * The op deliberately returns Figma's own CSS rather than an interpretation of it: an
 * interpretation is another place to disagree with the source, and the point here is to have
 * one source both sides can quote.
 */

import type { OpDef } from './protocol.ts'

/** One layer of a measured subtree. */
export interface MeasuredLayer {
  /** Index chain from the root, e.g. `0.2.1` — stable while the layer keeps its position. */
  path: string
  /** Name chain, for a human reading the diff: `Container / Cards / Card`. */
  label: string
  id: string
  name: string
  type: string
  /** Position relative to the measured root, in design pixels. */
  box: { x: number; y: number; width: number; height: number }
  /** Figma's own CSS for the layer. Absent when the API cannot produce it (vectors, masks). */
  css?: Record<string, string>
}

/** The node shape this module needs — kept structural so tests can hand in plain objects. */
interface MeasurableNode {
  id: string
  name: string
  type: string
  x?: number
  y?: number
  width?: number
  height?: number
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null
  children?: readonly MeasurableNode[]
  visible?: boolean
  getCSSAsync?: () => Promise<Record<string, string>>
}

function boxOf(node: MeasurableNode): { x: number; y: number; width: number; height: number } {
  const absolute = node.absoluteBoundingBox
  if (absolute) return { x: absolute.x, y: absolute.y, width: absolute.width, height: absolute.height }
  return { x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? 0, height: node.height ?? 0 }
}

export interface MeasureOptions {
  depth: number
  limit: number
  /** Hidden layers are skipped: they are not on the page the consumer is checking against. */
  includeHidden?: boolean
}

export interface MeasureResult {
  root: { id: string; name: string; type: string; width: number; height: number }
  layers: MeasuredLayer[]
  /** True when `limit` cut the walk short — the consumer is looking at a prefix, not the whole. */
  truncated: boolean
}

/**
 * Walks a subtree and records each layer's box and Figma CSS.
 *
 * Boxes are relative to the measured root, not to the canvas: a section pasted anywhere on the
 * page must measure the same, otherwise every comparison would first have to subtract an offset
 * the consumer has no reason to know about.
 */
export async function measureSubtree(root: MeasurableNode, options: MeasureOptions): Promise<MeasureResult> {
  const origin = boxOf(root)
  const layers: MeasuredLayer[] = []
  let truncated = false

  const visit = async (node: MeasurableNode, depth: number, path: string, label: string): Promise<void> => {
    if (layers.length >= options.limit) {
      truncated = true
      return
    }
    if (node.visible === false && !options.includeHidden) return

    const box = boxOf(node)
    let css: Record<string, string> | undefined
    if (typeof node.getCSSAsync === 'function') {
      try {
        css = await node.getCSSAsync()
      } catch {
        // A layer Figma cannot express as CSS (a mask, a boolean operation) still has a box,
        // and the box is half the answer — reporting nothing for it would hide it from the diff.
        css = undefined
      }
    }

    layers.push({
      path,
      label,
      id: node.id,
      name: node.name,
      type: node.type,
      box: {
        x: Math.round(box.x - origin.x),
        y: Math.round(box.y - origin.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      ...(css && Object.keys(css).length > 0 ? { css } : {}),
    })

    if (depth <= 0) return
    const children = node.children ?? []
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]
      await visit(child, depth - 1, path === '' ? String(index) : `${path}.${index}`, `${label} / ${child.name}`)
      if (layers.length >= options.limit) {
        truncated = true
        return
      }
    }
  }

  await visit(root, options.depth, '', root.name)
  return {
    root: { id: root.id, name: root.name, type: root.type, width: Math.round(origin.width), height: Math.round(origin.height) },
    layers,
    truncated,
  }
}

async function resolveMeasurable(ref: unknown): Promise<MeasurableNode> {
  if (typeof ref !== 'string' || ref === '') throw new Error('nodeId must be a non-empty string')
  const node = await figma.getNodeByIdAsync(ref)
  if (!node) throw new Error(`no node with id ${ref}`)
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error(`${ref} is a ${node.type}, not a layer`)
  return node as unknown as MeasurableNode
}

export const SPEC_OPS: readonly OpDef[] = [
  {
    name: 'design.measure',
    summary: 'The numbers a built page has to hit — Figma’s own CSS for every layer of a section, addressed by path.',
    agent:
      'Use this to CHECK an implementation, not to write one: read the section you built a block from, then compare the ' +
      'browser’s computed styles against `layers[].css` property by property. A screenshot diff says "90% similar" and ' +
      'cannot name the padding that is wrong; this names it. `design.context` is the op for generating markup — this one ' +
      'is the assertion behind it. Boxes are relative to the measured root, so a section measures the same wherever it sits.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Section or frame to measure.' },
      depth: { type: 'number', default: 3, min: 0, max: 8, description: 'How deep to walk. 0 measures the node alone.' },
      limit: { type: 'number', default: 200, min: 1, max: 2000, description: 'Maximum layers reported; the answer says when it cut.' },
      includeHidden: {
        type: 'boolean',
        default: false,
        description: 'Measure layers the designer switched off. Off by default — they are not on the page being checked.',
      },
    },
    async run(params) {
      const root = await resolveMeasurable(params.nodeId)
      return await measureSubtree(root, {
        depth: params.depth as number,
        limit: params.limit as number,
        includeHidden: params.includeHidden as boolean,
      })
    },
  },
]
