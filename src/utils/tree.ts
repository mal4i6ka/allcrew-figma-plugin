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

  /* Per-page `loadAsync` is enough to READ a page, but not enough for a document-wide
   * `findAllWithCriteria`: the runtime gates that on `figma.loadAllPagesAsync()` having been
   * called — the call itself, not the state it produces — and otherwise throws "Cannot call with
   * documentAccess: dynamic-page without calling figma.loadAllPagesAsync() first". Every page is
   * already warm by now, so this opens the gate without the 50-way load storm the batching above
   * exists to avoid. */
  await figma.loadAllPagesAsync?.()
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

/** A node whose `findAllWithCriteria` is Figma's own — the method the hand-written DFS above
 * stands in for wherever it's missing (older runtimes, or the plain objects plugin tests use as
 * documents). Duck-typed rather than a Figma type check: `BaseNode` does not statically carry
 * this method (it comes from `ChildrenMixin` or `DocumentNode`, not `BaseNode` itself), and a
 * test double only needs to look like the real thing. */
function nativeFindAllWithCriteria(
  root: BaseNode
): ((criteria: { types: NodeType[] }) => Array<PageNode | SceneNode>) | null {
  if (!('findAllWithCriteria' in root) || typeof root.findAllWithCriteria !== 'function') return null
  // Figma's own method, once present, always has this signature — TypeScript has no static link
  // from `BaseNode` to it because the method lives on `ChildrenMixin` / `DocumentNode`, not here.
  const method = root.findAllWithCriteria as (criteria: { types: NodeType[] }) => Array<PageNode | SceneNode>
  return method.bind(root)
}

/**
 * Search a subtree for scene nodes of the given types, the same shape of query as
 * `findAllWithCriteria` above but restricted to a type list. Prefer this whenever the caller
 * only needs types: Figma's own `node.findAllWithCriteria({ types })` is backed by an index the
 * host maintains per document, answering in roughly constant overhead per match regardless of
 * document size — the hand-rolled DFS above walks every node in JS and, on a ~200k-node live
 * file, didn't return within a 170s bridge call for exactly this query. Falls back to that same
 * DFS when `root` has no native method (older Figma runtime, or a plain mock in a test), so a
 * caller never has to special-case the difference.
 *
 * Excludes `root` itself, matching the DFS's default (`includeRoot` restores it either way) —
 * Figma's own method never considers its receiver a match.
 */
export async function findAllByTypes<T extends SceneNode = SceneNode>(
  root: BaseNode,
  types: readonly string[],
  opts?: FindAllWithCriteriaOptions
): Promise<T[]> {
  const native = nativeFindAllWithCriteria(root)
  if (native) {
    // Same flag, same reason as the DFS path: a search that walks into instances by default
    // would count (and pay for) every override mirror, which no caller of this helper wants.
    figma.skipInvisibleInstanceChildren = true
    try {
      const found = native({ types: types as NodeType[] }).filter(isSceneNode) as T[]
      if (opts?.includeRoot && isSceneNode(root) && types.includes(root.type)) {
        found.unshift(root as unknown as T)
      }
      return found
    } finally {
      figma.skipInvisibleInstanceChildren = false
    }
  }
  const typeSet = new Set(types)
  return findAllWithCriteria(root, (node): node is T => typeSet.has(node.type), opts)
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
