/**
 * Agent listener — where a scan is allowed to walk.
 *
 * One subtree, one page, or the whole document. Lives in its own module because three
 * registries need the same answer — the read ops in `ops.ts`, the component/instance ops in
 * `component-ops.ts` — and a second copy of "an explicit pageId IS the scope" is exactly the
 * kind of duplicate that drifts into a silent document-wide walk on one of them.
 */

import { getNodeByIdTimed } from './loading.ts'
import { loadAllPagesAsync } from '../utils/tree.ts'

/** The page a node sits on — a node id alone does not say, and half the ops here report one. */
export function pageOf(node: BaseNode | null): PageNode | null {
  let walk: BaseNode | null = node
  while (walk && walk.type !== 'PAGE') walk = walk.parent
  return walk && walk.type === 'PAGE' ? walk : null
}

/**
 * What a scan should walk: one subtree, one page, or the whole document. `nodeId` is the
 * sharding escape hatch — a page too big for one bridge call (a real DS file's "-- Main" is 22k
 * nodes) cannot be split by `pageId`, but it can be split by its top-level frames, and the
 * per-shard answers sum exactly like the per-page ones do.
 */
export async function resolveWalkRoots(
  params: Record<string, unknown>
): Promise<{ roots: BaseNode[]; labels: string[] }> {
  if (typeof params.nodeId === 'string' && params.nodeId !== '') {
    const found = await getNodeByIdTimed(params.nodeId)
    if (!found || found.type === 'DOCUMENT') throw new Error(`no node with id ${params.nodeId}`)
    if (found.type === 'PAGE') {
      await (found as PageNode).loadAsync()
      return { roots: [found], labels: [found.name] }
    }
    let page: BaseNode | null = found.parent
    while (page && page.type !== 'PAGE') page = page.parent
    if (page) await (page as PageNode).loadAsync()
    return { roots: [found], labels: [`${found.name} (subtree)`] }
  }
  /* An explicit pageId IS the scope. A declared page that is silently ignored can turn a
   * targeted request into an unexpectedly expensive document-wide walk, so ambiguity resolves
   * toward the cheaper read. */
  if (params.scope === 'page' || (typeof params.pageId === 'string' && params.pageId !== '')) {
    const page = await resolvePage(params.pageId)
    return { roots: [page], labels: [page.name] }
  }
  await loadAllPagesAsync()
  const pages = figma.root.children.slice()
  return { roots: pages, labels: pages.map((one) => one.name) }
}

export async function resolvePage(pageId?: unknown): Promise<PageNode> {
  if (typeof pageId !== 'string' || pageId === '') return figma.currentPage
  const page = await figma.getNodeByIdAsync(pageId)
  if (!page || page.type !== 'PAGE') throw new Error(`no page with id ${pageId}`)
  await page.loadAsync()
  return page
}
