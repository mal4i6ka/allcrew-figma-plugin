/**
 * Resumable sweeps — how a mass read finishes on a file of any size.
 *
 * A document-wide walk on a real design-system file is tens of thousands of nodes across dozens
 * of pages, some of which Figma has not even loaded yet (~40 s for a heavy one). No single call
 * can promise to finish that inside the bridge's 180 s, and a call that tries anyway either dies
 * at the ceiling with nothing to show or keeps the sandbox busy after nobody is waiting. A sweep
 * instead works in slices: each call walks until its time is nearly up (or the op's own limit is
 * reached), parks its position and its accumulated state in the sandbox, and answers with a
 * `cursor`. The same call with that `cursor` picks up exactly where the last one stopped — no
 * node visited twice, none skipped — and the call that reaches the end answers as if the whole
 * sweep had happened at once.
 *
 * What makes it stable:
 * - **Lazy pages.** A document sweep loads one page when it reaches it, never all of them up
 *   front, and does not start a cold page with too little time left to finish it.
 * - **A deadline below the bridge's.** The slice ends while there is still time to reply.
 * - **Parked state, not re-walks.** Position and accumulators stay in the sandbox between
 *   calls, keyed by the cursor; nothing is recomputed from the start.
 * - **Drift-tolerant resume.** A node deleted between two calls ends its branch, it does not
 *   fail the sweep; a sibling that moved is found again by id.
 *
 * Parked sweeps live only as long as the plugin window (and {@link SESSION_TTL_MS} without
 * use): an unknown cursor says so and the caller starts over.
 */

import { ParamError, type ParamSpec } from './protocol.ts'
import { checkpoint, currentRun, holdSkipInvisible, pauseDue } from '../utils/budget.ts'
import { findAllByTypes } from '../utils/tree.ts'
import { getNodeByIdTimed, isWarm, markWarm, noteLoad } from './loading.ts'

/* ------------------------------------------------------------------ params */

/** The two params every sweeping op takes, merged into its own spec. */
export const SWEEP_PARAMS: Readonly<Record<'cursor' | 'budgetMs', ParamSpec>> = {
  cursor: {
    type: 'string',
    description:
      'Continue a sweep: the `cursor` the previous answer handed back (with `complete: false`). Send the same ' +
      'other params with it; the sweep resumes exactly where it stopped.',
  },
  budgetMs: {
    type: 'number',
    min: 1000,
    max: 600_000,
    description:
      'How long this call may sweep before answering with a `cursor`. Defaults to the time the call has left ' +
      'before the bridge stops waiting.',
  },
}

/* ---------------------------------------------------------------- sessions */

/** A parked sweep nobody resumed in this long is dropped. */
export const SESSION_TTL_MS = 15 * 60_000
/** Parked sweeps kept at once; the least recently used goes first. */
const MAX_SESSIONS = 8
/** Never start loading a cold page with less than this left — a heavy page takes ~40 s and the
 * load cannot be interrupted once it starts. The next call starts with it instead. */
export const COLD_PAGE_RESERVE_MS = 30_000

/** What a visitor may answer: nothing (carry on), `'stop'` (end this slice after this node —
 * the op's limit), or `'skip'` (do not descend into this node; walk mode only). */
export type SweepVerdict = void | 'stop' | 'skip'
export type SweepVisitor = (node: SceneNode, insideInstance: boolean) => SweepVerdict | Promise<SweepVerdict>

interface Frame {
  node: BaseNode
  kids: readonly SceneNode[]
  next: number
  /** The child at `next` when the sweep parked — how the position is found again if the
   * children moved in between. */
  nextId: string | null
  /** True when this frame's node is an INSTANCE or sits inside one. */
  inInstance: boolean
}

interface Session {
  id: string
  op: string
  fingerprint: string
  roots: BaseNode[]
  labels: string[]
  types: readonly string[] | null
  skipInstanceChildren: boolean
  includeRoots: boolean
  invisibleInstanceChildren: boolean
  root: number
  frames: Frame[] | null
  batch: SceneNode[] | null
  offset: number
  state: unknown
  visited: number
  drifted: number
  calls: number
  touchedAt: number
}

const sessions = new Map<string, Session>()
let minted = 0

function sweepSessions(now: number): void {
  for (const [id, session] of sessions) if (now - session.touchedAt > SESSION_TTL_MS) sessions.delete(id)
  while (sessions.size > MAX_SESSIONS) {
    let oldest: Session | null = null
    for (const session of sessions.values()) if (!oldest || session.touchedAt < oldest.touchedAt) oldest = session
    if (!oldest) break
    sessions.delete(oldest.id)
  }
}

/** Test seam: forget every parked sweep. */
export function resetSweeps(): void {
  sessions.clear()
}

/** Parked sweeps right now — reported by `page.warm`-style diagnostics and the tests. */
export function parkedSweeps(): number {
  return sessions.size
}

/** Everything that defines WHAT is being swept. Two calls that differ in any of it are two
 * different sweeps; a cursor from one must not continue the other. */
function fingerprintOf(params: Record<string, unknown>): string {
  const keys = Object.keys(params)
    .filter((key) => key !== 'cursor' && key !== 'budgetMs' && params[key] !== undefined)
    .sort()
  return JSON.stringify(keys.map((key) => [key, params[key]]))
}

/* ------------------------------------------------------------------- roots */

export interface SweepRoots {
  roots: BaseNode[]
  labels: string[]
}

/**
 * What a sweep walks, from the usual scope params: `nodeId` (one subtree), `pageId` or
 * `scope: "page"` (one page), otherwise every page. Pages are NOT loaded here — the sweep loads
 * each one when it gets to it, which is the whole difference from `resolveWalkRoots`.
 */
export async function resolveSweepRoots(params: Record<string, unknown>): Promise<SweepRoots> {
  if (typeof params.nodeId === 'string' && params.nodeId !== '') {
    const found = await getNodeByIdTimed(params.nodeId)
    if (!found || found.type === 'DOCUMENT') throw new Error(`no node with id ${params.nodeId}`)
    if (found.type === 'PAGE') return { roots: [found], labels: [found.name] }
    return { roots: [found], labels: [`${found.name} (subtree)`] }
  }
  if (params.scope === 'page' || (typeof params.pageId === 'string' && params.pageId !== '')) {
    const page =
      typeof params.pageId === 'string' && params.pageId !== ''
        ? await figma.getNodeByIdAsync(params.pageId)
        : figma.currentPage
    if (!page || page.type !== 'PAGE') throw new Error(`no page with id ${String(params.pageId)}`)
    return { roots: [page], labels: [page.name] }
  }
  const pages = figma.root.children.slice()
  return { roots: pages, labels: pages.map((page) => page.name) }
}

/* ------------------------------------------------------------------- sweep */

export interface SweepOptions<S> {
  /** The op's name — part of what a cursor is bound to. */
  op: string
  /** The call's validated params. Everything but `cursor`/`budgetMs` must match on resume. */
  params: Record<string, unknown>
  /** Resolved on the first call only; a resumed sweep keeps the roots it started with. */
  roots: () => Promise<SweepRoots>
  /** The accumulator, created on the first call only and handed back on every resume. */
  state: () => S
  /** Sweep only these node types, through Figma's own type index (fast, one page at a time).
   * Omit to walk every node. */
  types?: readonly string[]
  /** Walk mode: visit an INSTANCE but not the mirror of its main component's insides. */
  skipInstanceChildren?: boolean
  /** Also visit each root itself when it is a scene node (a `nodeId` subtree root). Default true. */
  includeRoots?: boolean
  /** Walk mode: also see the children of instances the designer switched off. Figma hides them
   * from every read while `skipInvisibleInstanceChildren` is on, which the sweep turns on by
   * default (an inventory of hidden layers is the one reader that wants them). */
  invisibleInstanceChildren?: boolean
}

export interface SweepProgress {
  complete: boolean
  /** Why a slice ended early: out of time, or the visitor asked to stop (its limit). */
  stoppedOn?: 'budget' | 'limit'
}

/** What every sweeping op merges into its answer. */
export interface SweepReport {
  complete: boolean
  cursor?: string
  stoppedOn?: 'budget' | 'limit'
  swept: {
    nodes: number
    roots: { done: number; of: number }
    calls: number
    /** Branches that ended early because a node was deleted or moved between calls. */
    drifted?: number
  }
}

export interface Sweep<S> {
  readonly state: S
  readonly labels: string[]
  /** True when this call continues a parked sweep. */
  readonly resumed: boolean
  /** Walks until the end, the budget, or a visitor's `'stop'`. Call once per op call. */
  walk(visit: SweepVisitor): Promise<SweepProgress>
  /** The fields to merge into the answer. Parks the sweep when it is not complete, forgets it
   * when it is. */
  report(): SweepReport
}

/**
 * Starts a sweep, or resumes the one `params.cursor` names. Throws a `ParamError` for a cursor
 * that is unknown (plugin reopened, expired) or was minted by a different call.
 */
export async function openSweep<S>(options: SweepOptions<S>): Promise<Sweep<S>> {
  const now = Date.now()
  sweepSessions(now)
  const fingerprint = fingerprintOf(options.params)
  const cursor = typeof options.params.cursor === 'string' && options.params.cursor !== '' ? options.params.cursor : null

  let session: Session
  const resumed = cursor !== null
  if (cursor !== null) {
    const parked = sessions.get(cursor)
    if (!parked) {
      throw new ParamError(
        `cursor ${JSON.stringify(cursor)} is unknown — the plugin was reopened or the sweep sat unused for more than ` +
          `${SESSION_TTL_MS / 60_000} minutes. Start over without a cursor.`
      )
    }
    if (parked.op !== options.op || parked.fingerprint !== fingerprint) {
      throw new ParamError(
        `cursor ${JSON.stringify(cursor)} belongs to a different ${parked.op} call — resume it with exactly the params ` +
          'it started with (only cursor and budgetMs may change), or drop cursor to start a new sweep.'
      )
    }
    session = parked
    resync(session)
  } else {
    const { roots, labels } = await options.roots()
    minted += 1
    session = {
      id: `sweep-${now.toString(36)}-${minted.toString(36)}`,
      op: options.op,
      fingerprint,
      roots,
      labels,
      types: options.types && options.types.length > 0 ? options.types.slice() : null,
      skipInstanceChildren: options.skipInstanceChildren === true,
      invisibleInstanceChildren: options.invisibleInstanceChildren === true,
      includeRoots: options.includeRoots !== false,
      root: 0,
      frames: null,
      batch: null,
      offset: 0,
      state: options.state(),
      visited: 0,
      drifted: 0,
      calls: 0,
      touchedAt: now,
    }
  }
  session.calls += 1
  session.touchedAt = now

  const budgetMs = typeof options.params.budgetMs === 'number' ? options.params.budgetMs : null
  const deadline = sliceDeadline(now, budgetMs)
  let progress: SweepProgress | null = null

  return {
    state: session.state as S,
    labels: session.labels,
    resumed,
    async walk(visit) {
      progress = session.types ? await walkTypes(session, visit, deadline) : await walkTree(session, visit, deadline)
      return progress
    },
    report() {
      const done = progress?.complete ?? session.root >= session.roots.length
      const swept = {
        nodes: session.visited,
        roots: { done: Math.min(session.root, session.roots.length), of: session.roots.length },
        calls: session.calls,
        ...(session.drifted > 0 ? { drifted: session.drifted } : {}),
      }
      if (done) {
        sessions.delete(session.id)
        return { complete: true, swept }
      }
      session.touchedAt = Date.now()
      sessions.set(session.id, session)
      sweepSessions(session.touchedAt)
      return { complete: false, cursor: session.id, stoppedOn: progress?.stoppedOn ?? 'budget', swept }
    },
  }
}

/**
 * When this slice must stop: the caller's `budgetMs` if it gave one, and in any case early
 * enough before the run's own deadline to build and send the answer.
 */
function sliceDeadline(now: number, budgetMs: number | null): number {
  let deadline = budgetMs !== null ? now + budgetMs : Infinity
  const run = currentRun()
  if (run) {
    const left = run.deadline - now
    const reserve = Math.min(8000, Math.max(1500, left * 0.1))
    deadline = Math.min(deadline, run.deadline - reserve)
  }
  return deadline
}

function outOfTime(deadline: number): boolean {
  const run = currentRun()
  return Date.now() >= deadline || (run !== null && run.cancelled !== null)
}

/** Loads the page a root sits on before reading it — or declines, when there is too little time
 * left to pay for a cold one and this call has already done some work. */
async function enterRoot(root: BaseNode, deadline: number, visitedThisCall: number): Promise<boolean> {
  let walk: BaseNode | null = root
  while (walk && walk.type !== 'PAGE') walk = walk.parent
  if (!walk) return true
  const page = walk as PageNode
  if (!isWarm(page.id) && visitedThisCall > 0 && deadline - Date.now() < COLD_PAGE_RESERVE_MS) return false
  const started = Date.now()
  await page.loadAsync()
  noteLoad(page.name, Date.now() - started)
  markWarm(page.id)
  return true
}

function childrenOf(node: BaseNode): readonly SceneNode[] {
  return 'children' in node ? ((node as ChildrenMixin).children as readonly SceneNode[]) : []
}

function isSceneNode(node: BaseNode): node is SceneNode {
  return node.type !== 'DOCUMENT' && node.type !== 'PAGE'
}

function isGone(node: BaseNode): boolean {
  try {
    return node.removed === true
  } catch {
    return true
  }
}

/**
 * Re-reads a parked position against the document as it is now. Children arrays are re-read
 * (a parked one is a snapshot), the pending child is found again by id, and a frame whose node
 * was deleted ends there — its remaining siblings are still visited.
 */
function resync(session: Session): void {
  // A type-index batch is left as it was parked: its offset counts positions in it, and a node
  // deleted in between is skipped where the walk meets it.
  if (session.types) return
  const frames = session.frames
  if (!frames) return
  for (let depth = 0; depth < frames.length; depth++) {
    const frame = frames[depth]
    if (isGone(frame.node)) {
      frames.length = depth
      session.drifted += 1
      break
    }
    frame.kids = kidsOf(session, frame.node)
    if (frame.nextId !== null) {
      const at = frame.kids.findIndex((kid) => kid.id === frame.nextId)
      if (at >= 0) frame.next = at
      else {
        frame.next = Math.min(frame.next, frame.kids.length)
        session.drifted += 1
      }
    }
    frame.nextId = null
  }
  if (frames.length === 0) {
    // The whole parked branch is gone: carry on with the next root.
    session.frames = null
    session.root += 1
  }
}

function park(session: Session): void {
  if (!session.frames) return
  for (const frame of session.frames) frame.nextId = frame.kids[frame.next]?.id ?? null
}

/** The children a frame walks: none for an instance in a `skipInstanceChildren` sweep — the
 * same rule whether the instance is the sweep's root or met on the way down. */
function kidsOf(session: Session, node: BaseNode): readonly SceneNode[] {
  return session.skipInstanceChildren && node.type === 'INSTANCE' ? [] : childrenOf(node)
}

async function walkTree(session: Session, visit: SweepVisitor, deadline: number): Promise<SweepProgress> {
  const release = session.invisibleInstanceChildren ? () => {} : holdSkipInvisible()
  try {
    let visitedThisCall = 0
    while (session.root < session.roots.length) {
      if (!session.frames) {
        if (outOfTime(deadline)) return { complete: false, stoppedOn: 'budget' }
        const root = session.roots[session.root]
        if (isGone(root)) {
          session.root += 1
          session.drifted += 1
          continue
        }
        if (!(await enterRoot(root, deadline, visitedThisCall))) return { complete: false, stoppedOn: 'budget' }
        session.frames = [{ node: root, kids: kidsOf(session, root), next: 0, nextId: null, inInstance: root.type === 'INSTANCE' }]
        if (session.includeRoots && isSceneNode(root)) {
          session.visited += 1
          visitedThisCall += 1
          const verdict = await visit(root, false)
          if (verdict === 'skip') session.frames = []
          if (verdict === 'stop') {
            park(session)
            return { complete: false, stoppedOn: 'limit' }
          }
        }
      }
      const frames = session.frames
      while (frames.length > 0) {
        const top = frames[frames.length - 1]
        if (top.next >= top.kids.length) {
          frames.pop()
          continue
        }
        if (outOfTime(deadline)) {
          park(session)
          return { complete: false, stoppedOn: 'budget' }
        }
        const child = top.kids[top.next]
        top.next += 1
        session.visited += 1
        visitedThisCall += 1
        const verdict = await visit(child, top.inInstance)
        if (verdict !== 'skip' && 'children' in child && !(session.skipInstanceChildren && child.type === 'INSTANCE')) {
          frames.push({
            node: child,
            kids: childrenOf(child),
            next: 0,
            nextId: null,
            inInstance: top.inInstance || child.type === 'INSTANCE',
          })
        }
        if (verdict === 'stop') {
          park(session)
          return { complete: false, stoppedOn: 'limit' }
        }
        if (pauseDue()) await checkpoint()
      }
      session.frames = null
      session.root += 1
    }
    return { complete: true }
  } finally {
    release()
  }
}

async function walkTypes(session: Session, visit: SweepVisitor, deadline: number): Promise<SweepProgress> {
  let visitedThisCall = 0
  while (session.root < session.roots.length) {
    if (!session.batch) {
      if (outOfTime(deadline)) return { complete: false, stoppedOn: 'budget' }
      const root = session.roots[session.root]
      if (isGone(root)) {
        session.root += 1
        session.drifted += 1
        continue
      }
      if (!(await enterRoot(root, deadline, visitedThisCall))) return { complete: false, stoppedOn: 'budget' }
      session.batch = await findAllByTypes<SceneNode>(root, session.types!, { includeRoot: session.includeRoots })
      session.offset = 0
    }
    const batch = session.batch
    while (session.offset < batch.length) {
      if (outOfTime(deadline)) return { complete: false, stoppedOn: 'budget' }
      const node = batch[session.offset]
      session.offset += 1
      if (isGone(node)) continue
      session.visited += 1
      visitedThisCall += 1
      if ((await visit(node, false)) === 'stop') return { complete: false, stoppedOn: 'limit' }
      if (pauseDue()) await checkpoint()
    }
    session.batch = null
    session.root += 1
  }
  return { complete: true }
}
