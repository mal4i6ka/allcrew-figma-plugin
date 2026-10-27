/**
 * Async tree traversal helpers for `documentAccess: "dynamic-page"` manifests, where
 * pages must be loaded on demand before their subtree can be read.
 *
 * Every loop here goes through `checkpoint()` (see `budget.ts`): it yields the main thread on a
 * time slice and stops the walk when the agent run it belongs to was cancelled or ran out of
 * time. A walk that cannot be stopped is a walk that outlives the call that asked for it.
 */

import { checkpoint, holdSkipInvisible, pauseDue } from './budget.ts'

export async function loadAllPagesAsync(): Promise<void> {
  /* Not Promise.all: on a 50-page file that fires 50 parallel loads at once, which is exactly
   * what "Unable to establish connection to Figma after 10 seconds" and the sandbox abort look
   * like from the inside. Batches of four, one retry per page, and a failure NAMES its page —
   * an anonymous rejection from a 50-way race helps nobody. */
  const pages = figma.root.children.slice()
  const BATCH = 4
  for (let start = 0; start < pages.length; start += BATCH) {
    // Between batches, not inside one: a page load cannot be interrupted, but the next four
    // need not start once the run that wanted them has been cancelled or ran out of time.
    await checkpoint()
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

export async function findAllWithCriteria<T extends SceneNode>(
  root: BaseNode,
  predicate: (node: SceneNode) => node is T,
  opts?: FindAllWithCriteriaOptions
): Promise<T[]> {
  const release = holdSkipInvisible()
  try {
    const results: T[] = []

    if (opts?.includeRoot && isSceneNode(root) && predicate(root)) {
      results.push(root)
    }

    // Iterative preorder DFS (same visit order as the recursive version); `checkpoint` yields
    // on a time slice and stops the walk when its run is cancelled or out of time.
    const stack: BaseNode[] = [root]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (hasChildren(node)) {
        for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
      }
      if (node !== root && predicate(node as SceneNode)) results.push(node as T)
      if (pauseDue()) await checkpoint()
    }

    return results
  } finally {
    release()
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
 *
 * Instance contents are included, exactly as the walk sees them. Measured 16.10 on New Website
 * Django, frame 2259:129906, its page never opened since launch: TEXT 174 (130 inside instances),
 * INSTANCE 103 (55 nested), FRAME 253 (136) — the same ids from the index and from the walk,
 * before and after `page.loadAsync()`, at 0–6 ms against ~350 ms. The flag below is the only
 * difference it makes: off, the same index also returns invisible instance children (206 TEXT).
 * So a caller counting nested copies (the instance census) can keep this; a caller that wants
 * only top-level nodes has to filter, not switch engines.
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
    // The native call itself is one blocking host call — it cannot yield part way, which is
    // why document-wide callers shard it per page (see `sweep.ts`).
    await checkpoint()
    const release = holdSkipInvisible()
    try {
      const found = native({ types: types as NodeType[] }).filter(isSceneNode) as T[]
      if (opts?.includeRoot && isSceneNode(root) && types.includes(root.type)) {
        found.unshift(root as unknown as T)
      }
      return found
    } finally {
      release()
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
 * Preorder walk that hands each scene node to a visitor, with the same checkpoint cadence as
 * `findAllWithCriteria`.
 *
 * This exists because "collect everything, then scan" puts the expensive half outside the
 * checkpoints: property getters are the real cost of any scan (each one crosses the sandbox
 * boundary and materialises fresh objects), so the checkpoints have to cover the visitor, not
 * just the traversal.
 *
 * Returns how many nodes were visited and how many of those sat inside instances — the second
 * number, measured on a deep walk, is exactly what a `skipInstanceChildren` walk would save.
 */
export async function walkSceneNodes(
  root: BaseNode,
  visit: (node: SceneNode, insideInstance: boolean) => void,
  opts?: WalkOptions
): Promise<{ visited: number; insideInstances: number }> {
  const release = holdSkipInvisible()
  try {
    let visited = 0
    let insideInstances = 0
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
      if (pauseDue()) await checkpoint()
    }
    return { visited, insideInstances }
  } finally {
    release()
  }
}

/**
 * Returns the scene node directly under a page.
 *
 * Figma can emit `selectionchange` with a stale instance sublayer immediately after its
 * component was replaced. Reading `.parent` on that proxy throws `get_parent` instead of
 * returning null, so ancestry consumers must fail closed for that one transient event.
 */
export function topLevelAncestorOrNull(node: SceneNode): SceneNode | null {
  let current = node
  try {
    while (true) {
      const parent = current.parent
      if (!parent || parent.type === 'PAGE' || parent.type === 'DOCUMENT') return current
      current = parent as SceneNode
    }
  } catch {
    return null
  }
}

function hasChildren(node: BaseNode): node is BaseNode & ChildrenMixin {
  return 'children' in node
}

function isSceneNode(node: BaseNode): node is SceneNode {
  return node.type !== 'DOCUMENT' && node.type !== 'PAGE'
}
