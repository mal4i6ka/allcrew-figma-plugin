/**
 * Async tree traversal helpers for `documentAccess: "dynamic-page"` manifests, where
 * pages must be loaded on demand before their subtree can be read.
 */

export async function loadAllPagesAsync(): Promise<void> {
  /* Not Promise.all: on a 50-page file that fires 50 parallel loads at once, which is exactly
   * what "Unable to establish connection to Figma after 10 seconds" and the sandbox abort look
   * like from the inside. Batches of four, one retry per page, and a failure NAMES its page —
   * an anonymous rejection from a 50-way race helps nobody. */
  const pages = figma.root.children.slice()
  const BATCH = 4
  for (let start = 0; start < pages.length; start += BATCH) {
    await Promise.all(
      pages.slice(start, start + BATCH).map(async (page) => {
        try {
          await page.loadAsync()
        } catch {
          try {
            await page.loadAsync()
          } catch (err) {
            throw new Error(`page "${page.name}" would not load: ${String((err as Error)?.message || err)}`)
          }
        }
      })
    )
  }
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

export interface WalkOptions {
  /** Visit `root` itself when it is a SceneNode. Defaults to true. */
  includeRoot?: boolean
  /** Do not descend into INSTANCE subtrees. The instance node itself is still visited, so its
   * own overrides are seen — what is skipped is the mirror of its main component's internals. */
  skipInstanceChildren?: boolean
}

/**
 * Preorder walk that hands each scene node to a visitor, with the same yield cadence as
 * `findAllWithCriteria`.
 *
 * This exists because "collect everything, then scan" puts the expensive half outside the
 * yields: the walk yields every {@link YIELD_EVERY} nodes, and then a tight loop reads
 * `boundVariables` / `fills` / `strokes` on tens of thousands of nodes with no yield at all —
 * on Figma's main thread, which that comment above warns about. Property getters are the real
 * cost of any scan (each one crosses the sandbox boundary and materialises fresh objects), so
 * the yields have to cover the visitor, not just the traversal.
 *
 * Returns how many nodes were visited and how many of those sat inside instances — the second
 * number, measured on a deep walk, is exactly what a `skipInstanceChildren` walk would save.
 */
export async function walkSceneNodes(
  root: BaseNode,
  visit: (node: SceneNode, insideInstance: boolean) => void,
  opts?: WalkOptions
): Promise<{ visited: number; insideInstances: number }> {
  figma.skipInvisibleInstanceChildren = true
  try {
    let visited = 0
    let insideInstances = 0
    let steps = 0
    const stack: Array<[BaseNode, boolean]> = [[root, false]]
    while (stack.length > 0) {
      const [node, inInstance] = stack.pop()!
      if (isSceneNode(node) && (node !== root || opts?.includeRoot !== false)) {
        visited += 1
        if (inInstance) insideInstances += 1
        visit(node, inInstance)
      }
      if (hasChildren(node) && !(opts?.skipInstanceChildren && node.type === 'INSTANCE')) {
        const below = inInstance || node.type === 'INSTANCE'
        for (let i = node.children.length - 1; i >= 0; i--) stack.push([node.children[i], below])
      }
      if (++steps % YIELD_EVERY === 0) await yieldToHost()
    }
    return { visited, insideInstances }
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
