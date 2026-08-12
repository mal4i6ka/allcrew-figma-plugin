/**
 * Async tree traversal helpers for `documentAccess: "dynamic-page"` manifests, where
 * pages must be loaded on demand before their subtree can be read.
 */

export async function loadAllPagesAsync(): Promise<void> {
  await Promise.all(figma.root.children.map((page) => page.loadAsync()))
}

export interface FindAllWithCriteriaOptions {
  /** Also test `root` itself against the predicate. Defaults to `false`. */
  includeRoot?: boolean
}

/** Plugin code runs on Figma's main thread — a long synchronous walk freezes the whole app.
 * Yield to the host every this many visited nodes so large pages stay responsive. */
const YIELD_EVERY = 500

export function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export async function findAllWithCriteria<T extends SceneNode>(
  root: BaseNode,
  predicate: (node: SceneNode) => node is T,
  opts?: FindAllWithCriteriaOptions
): Promise<T[]> {
  figma.skipInvisibleInstanceChildren = true
  try {
    const results: T[] = []

    if (opts?.includeRoot && isSceneNode(root) && predicate(root)) {
      results.push(root)
    }

    // Iterative preorder DFS (same visit order as the recursive version) with periodic yields.
    let visited = 0
    const stack: BaseNode[] = [root]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (hasChildren(node)) {
        for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
      }
      if (node !== root && predicate(node as SceneNode)) results.push(node as T)
      if (++visited % YIELD_EVERY === 0) await yieldToHost()
    }

    return results
  } finally {
    figma.skipInvisibleInstanceChildren = false
  }
}

function hasChildren(node: BaseNode): node is BaseNode & ChildrenMixin {
  return 'children' in node
}

function isSceneNode(node: BaseNode): node is SceneNode {
  return node.type !== 'DOCUMENT' && node.type !== 'PAGE'
}
