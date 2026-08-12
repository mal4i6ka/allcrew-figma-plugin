/**
 * Layer matching (T5.6, docs/research/05-smart-animate-css-diff.md §1.1/§1.4): Figma matches
 * layers between two states by **name + position in the hierarchy** — a layer key is its path
 * of names from the comparison root, with a `#dupIndex` suffix so same-named siblings (two
 * `Rect`s under one parent) match the i-th of one state to the i-th of the other rather than
 * colliding. A path present in only one state, or matched to a different node `type`, cannot be
 * Smart Animated between — it falls back to Figma's own behavior of dissolve (fade-out on the
 * source side, fade-in on the destination side).
 */

import type { DiffableNode, NodePath } from './types.ts'

export interface MatchedPair {
  readonly path: NodePath
  readonly a: DiffableNode
  readonly b: DiffableNode
}

export interface UnmatchedNode {
  readonly path: NodePath
  readonly node: DiffableNode
}

export interface LayerMatchResult {
  readonly matched: readonly MatchedPair[]
  /** Present in `base` only, or type-mismatched against `target` — dissolve (fade-out). */
  readonly removed: readonly UnmatchedNode[]
  /** Present in `target` only, or type-mismatched against `base` — dissolve (fade-in). */
  readonly added: readonly UnmatchedNode[]
}

function indexTree(root: DiffableNode): Map<NodePath, DiffableNode> {
  const map = new Map<NodePath, DiffableNode>()

  const walk = (node: DiffableNode, prefix: string): void => {
    const seen = new Map<string, number>()
    for (const child of node.children ?? []) {
      const dupIndex = seen.get(child.name) ?? 0
      seen.set(child.name, dupIndex + 1)
      const path = `${prefix}${child.name}#${dupIndex}`
      map.set(path, child)
      walk(child, `${path}/`)
    }
  }
  walk(root, '')

  return map
}

/** Matches every layer under `base` against `target` by name+nesting-path (see module doc). */
export function matchLayers(base: DiffableNode, target: DiffableNode): LayerMatchResult {
  const baseIndex = indexTree(base)
  const targetIndex = indexTree(target)

  const matched: MatchedPair[] = []
  const removed: UnmatchedNode[] = []
  const added: UnmatchedNode[] = []

  for (const [path, node] of baseIndex) {
    const other = targetIndex.get(path)
    if (other && other.type === node.type) {
      matched.push({ path, a: node, b: other })
    } else {
      removed.push({ path, node })
      if (other) added.push({ path, node: other })
    }
  }
  for (const [path, node] of targetIndex) {
    if (!baseIndex.has(path)) added.push({ path, node })
  }

  return { matched, removed, added }
}
