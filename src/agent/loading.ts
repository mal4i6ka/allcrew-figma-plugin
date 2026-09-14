/**
 * What a call spent waiting for Figma to load a page, and which page it was.
 *
 * Under `documentAccess: "dynamic-page"` (this plugin's mode) a page is loaded the first time
 * anything reaches into it. On a real file that is *forty seconds* for a heavy page and six
 * milliseconds for the same call afterwards - measured repeatedly on the components page of a
 * 40-page file. From outside the two are indistinguishable from a hung channel, and the honest
 * reaction to a hang ("something is broken, go look") is the wrong one here: nothing is broken,
 * the document is simply cold.
 *
 * So a node resolution is timed, and anything slow enough to look like a stall is reported with
 * the answer. Pages already paid for are remembered too, so a caller can plan an order of work
 * instead of discovering the cost one call at a time.
 */

/** Below this a load is indistinguishable from ordinary work and not worth a word. */
const SLOW_MS = 1000

const warmed = new Set<string>()
let pending: Array<{ page: string; ms: number }> = []

/** The page a node belongs to, walking up - a node id alone does not say. */
function pageOf(node: BaseNode | null): PageNode | null {
  let cursor: BaseNode | null = node
  while (cursor && cursor.type !== 'PAGE') cursor = cursor.parent ?? null
  return (cursor as PageNode | null) ?? null
}

/**
 * How long a single node resolution may wait for a cold page before answering instead of
 * hanging. Measured: a heavy page loads in ~40 s, so this leaves room for a slower one - but it
 * is well inside the bridge's own ceiling, which is the point. A call that dies at the ceiling
 * teaches the caller nothing; this one comes back with the reason and a retry that works.
 */
const LOAD_CEILING_MS = 60_000

/**
 * `figma.getNodeByIdAsync`, timed and bounded. Every op that starts from a node id goes through
 * here, so the cost is recorded - and capped - once, where it is actually paid.
 *
 * Losing the race does not lose the page: Figma goes on loading it, so the retry this error asks
 * for is the fast one. That is the whole difference between a three-minute silence and a
 * sentence a caller can act on.
 */
export async function getNodeByIdTimed(id: string, budgetMs: number = LOAD_CEILING_MS): Promise<BaseNode | null> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> = 0 as unknown as ReturnType<typeof setTimeout>
  const node = await Promise.race([
    figma.getNodeByIdAsync(id),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${id} sits on a page Figma has not finished loading (waited ${Math.round(budgetMs / 1000)}s). ` +
                'The load continues in the background — call again and it usually answers at once.'
            )
          ),
        budgetMs
      )
    }),
  ]).finally(() => clearTimeout(timer))
  const ms = Date.now() - started
  const page = pageOf(node)
  if (page) {
    const first = !warmed.has(page.id)
    warmed.add(page.id)
    // Only the FIRST touch of a page can be a load; a slow second read is the document being
    // busy, which is a different fact and not this module's to report.
    if (first && ms >= SLOW_MS) pending.push({ page: page.name, ms })
  }
  return node
}

/** A page load an op timed itself, for the ops that load a page explicitly rather than by
 * touching a node in it. Same rule as above: only a wait long enough to look like a stall. */
export function noteLoad(page: string, ms: number): void {
  if (ms >= SLOW_MS) pending.push({ page, ms })
}

/** Pages this plugin session has already reached into - the ones that will answer instantly. */
export function warmPages(): number {
  return warmed.size
}

/** Whether THIS page has already been paid for. A caller planning a sweep wants the map, not
 * the count: the order of work is the only lever it has over a cost it cannot avoid. */
export function isWarm(pageId: string): boolean {
  return warmed.has(pageId)
}

/** Records a page as loaded by something other than a node lookup - `page.warm` and the ops
 * that call `loadAsync` themselves. */
export function markWarm(pageId: string): void {
  warmed.add(pageId)
}

/** Hands over what this call waited for and clears it for the next one. */
export function takeLoading(): Array<{ page: string; ms: number }> | null {
  if (pending.length === 0) return null
  const out = pending
  pending = []
  return out
}

/** Test seam: a fresh session has no warm pages and nothing pending. */
export function resetLoading(): void {
  warmed.clear()
  pending = []
}
