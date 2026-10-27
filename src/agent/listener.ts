/**
 * Agent listener — main-thread dispatcher.
 *
 * The UI iframe owns the transport (it long-polls the bridge; the sandbox has `fetch` but no
 * socket, and keeping the poll out here also keeps the main thread free). Everything that
 * decides *whether* a request runs lives here instead, so the gate can't be talked around by
 * anything running in the iframe.
 *
 * It also decides *how* a request runs, because that is what keeps mass operations alive:
 * - **One at a time.** Figma does not await the message handler, so without a lane every
 *   request ran interleaved with every other: an agent's retry of a slow sweep started a second
 *   sweep beside the first, both holding thousands of nodes. Requests now queue.
 * - **A deadline below the bridge's.** The bridge says how long it will wait (`budgetMs` on the
 *   request); the run answers before that, through `checkpoint()` in every long loop and a hard
 *   overstay timer here. An answer the bridge never hears is work wasted twice.
 * - **Cancellable.** A bridge that stops waiting says so (`cancelAgentRequest`); the run stops
 *   at its next checkpoint instead of finishing for nobody.
 */

import {
  authorize,
  ParamError,
  toManifest,
  validateParams,
  type AgentGates,
  type OpManifestEntry,
} from './protocol.ts'
import { isRetryable, type AgentErrorCode } from './errors.ts'
import { ALL_OPS, OPS_BY_NAME } from './ops.ts'
import { postToUi } from './ui-post.ts'
import { takeLoading } from './loading.ts'
import { currentRun, RunStopped, setCurrentRun, type Run } from '../utils/budget.ts'

export interface AgentRequest {
  id: string
  op: string
  params?: unknown
  /** How long the bridge will still wait for this answer, as it handed the request over. An
   * older bridge does not send it; {@link DEFAULT_CALL_BUDGET_MS} stands in. */
  budgetMs?: unknown
}

export interface AgentResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
  /** Which KIND of refusal this is, so a caller's retry policy is a lookup rather than a regex
   * over English. Absent on success. See `errors.ts` for what each one means. */
  code?: AgentErrorCode
  /** Whether issuing the same call again could plausibly work. Derived from `code`; carried
   * because it is the question every caller actually asks. Absent on success. */
  retryable?: boolean
  /** Pages this call had to wait for Figma to load, and how long each took. Absent when
   * nothing was cold - see `loading.ts` for why a wait needs saying out loud. */
  loading?: Array<{ page: string; ms: number }>
}

/** The bridge's own default ceiling — what a call gets when the bridge did not say. */
export const DEFAULT_CALL_BUDGET_MS = 180_000
/** Held back from the bridge's budget for the trip home: the UI hop, the socket, the bridge
 * writing files. A run's deadline is the bridge's minus this. */
export const ANSWER_MARGIN_MS = 8_000
/** How long past its deadline a run that ignores it gets before it is answered for. */
export const OVERSTAY_MS = 3_000

/** Both off until the designer says otherwise, every time the plugin opens. Gate state is
 * persisted in export options for convenience, but the dispatcher only ever trusts what the
 * UI has explicitly pushed into `setGates` this session. */
let gates: AgentGates = { read: false, write: false }

export function setGates(next: Partial<AgentGates>): AgentGates {
  gates = { read: next.read === true, write: next.write === true }
  return gates
}

export function currentGates(): AgentGates {
  return gates
}

/** Everything the channel can do, reads and writes alike. The manifest is a description, not
 * a permission: `authorize` still refuses a mutating op while the write gate is off, so an
 * agent can see what exists and be told plainly why it is unavailable. */
export function agentManifest(): OpManifestEntry[] {
  return toManifest(ALL_OPS)
}

/* -------------------------------------------------------------------- lane */

interface Ticket {
  run: Run
  start: () => void
}

const queue: Ticket[] = []
/** Every run that has been accepted and not yet answered for, by request id — what a cancel
 * looks up, queued or running. */
const live = new Map<string, Run>()
let laneBusy = false

function enterLane(run: Run): Promise<void> {
  return new Promise((resolve) => {
    queue.push({ run, start: resolve })
    pump()
  })
}

function pump(): void {
  if (laneBusy) return
  const next = queue.shift()
  if (!next) return
  laneBusy = true
  next.start()
}

function leaveLane(): void {
  setCurrentRun(null)
  laneBusy = false
  pump()
}

/**
 * The bridge stopped waiting for `id` (its own timeout, or its caller went away). A queued run
 * is answered for without running; a running one stops at its next checkpoint. Unknown ids —
 * already answered — are ignored.
 */
export function cancelAgentRequest(id: string, reason: string): boolean {
  const run = live.get(id)
  if (!run || run.cancelled) return false
  run.cancelled = reason
  return true
}

/** Test seam: an empty lane with nothing running. */
export function resetLane(): void {
  queue.length = 0
  live.clear()
  laneBusy = false
  setCurrentRun(null)
}

/** Runs and requests waiting right now — the depth of the lane, for tests and diagnostics. */
export function laneDepth(): number {
  return queue.length + (laneBusy ? 1 : 0)
}

function failed(request: AgentRequest, code: AgentErrorCode, message: string): AgentResponse {
  const loading = takeLoading()
  return {
    id: request.id,
    ok: false,
    error: message,
    code,
    retryable: isRetryable(code),
    ...(loading ? { loading } : {}),
  }
}

export async function handleAgentRequest(request: AgentRequest): Promise<AgentResponse> {
  const started = Date.now()
  const op = OPS_BY_NAME.get(request.op)

  // The raw params, not the validated ones: an op like `plugin.call` is a read or a write
  // depending on what it was asked to run, and that has to be decided before anything runs.
  const permitted = authorize(op, gates, request.params)
  if (!permitted.ok) {
    report(request.op, false, Date.now() - started, permitted.error)
    return { id: request.id, ok: false, error: permitted.error, code: permitted.code, retryable: permitted.retryable }
  }

  const raw = request.params && typeof request.params === 'object' ? (request.params as Record<string, unknown>) : {}
  const writes = (op!.mutatesWhen ? op!.mutatesWhen(request.params) : op!.mutates) && raw.dryRun !== true
  const bridgeBudget =
    typeof request.budgetMs === 'number' && Number.isFinite(request.budgetMs) && request.budgetMs > 0
      ? request.budgetMs
      : DEFAULT_CALL_BUDGET_MS
  const run: Run = {
    id: request.id,
    op: request.op,
    startedAt: started,
    deadline: started + Math.max(1000, bridgeBudget - ANSWER_MARGIN_MS),
    cancelled: null,
    // A read can be stopped anywhere. A write is allowed to finish late rather than stop half
    // applied; its read-only phase opts back in with `enforceDeadline`.
    enforce: !writes,
  }
  live.set(run.id, run)
  // Named in the refusal if this request's time runs out in the queue.
  const ahead = laneBusy ? currentRun()?.op ?? 'another call' : null
  await enterLane(run)

  /* Its turn came too late, or the bridge gave up on it while it queued: answer without
   * running. The time it waited is the time the request before it took. */
  if (run.cancelled || Date.now() >= run.deadline) {
    live.delete(run.id)
    const waited = Math.round((Date.now() - started) / 1000)
    const message = run.cancelled
      ? `${request.op} was cancelled before it ran (${run.cancelled})`
      : `${request.op} waited ${waited}s behind ${ahead ?? 'other calls'} on this file and its time ran out before ` +
        'it started. The plugin runs one call at a time; retry once the long call ahead of it has answered.'
    leaveLane()
    report(request.op, false, Date.now() - started, message)
    return failed(request, 'timeout', message)
  }

  setCurrentRun(run)
  let released = false
  const release = () => {
    if (released) return
    released = true
    live.delete(run.id)
    leaveLane()
  }

  let params: Record<string, unknown>
  try {
    params = validateParams(op!.params, request.params)
  } catch (err) {
    release()
    const message = String((err as Error)?.message || err)
    report(request.op, false, Date.now() - started, message)
    return failed(request, err instanceof ParamError ? 'param_invalid' : 'figma_threw', message)
  }
  /* An op with its own time budget gets no more than the run has: a caller's (or a default's)
   * 60 s on a call with 20 s left is how an op ends up answering to nobody. */
  if ('budgetMs' in op!.params) {
    const room = Math.max(500, run.deadline - Date.now() - 1000)
    const asked = typeof params.budgetMs === 'number' ? params.budgetMs : Infinity
    if (asked > room) params.budgetMs = room
  }

  type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }
  const settled: Promise<Outcome> = op!.run(params).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  )
  let cancelOverstay = () => {}
  const overstayed = new Promise<'overstayed'>((resolve) => {
    const timer = setTimeout(() => resolve('overstayed'), Math.max(0, run.deadline + OVERSTAY_MS - Date.now()))
    cancelOverstay = () => clearTimeout(timer)
  })
  const first = await Promise.race([settled, overstayed])
  cancelOverstay()

  if (first === 'overstayed') {
    /* The op ignored its deadline (or is stuck in a host call that cannot be interrupted).
     * Answer for it now, while the bridge is still listening, and flag it so its next
     * checkpoint throws. The lane stays held until it actually lets go: the deadline and the
     * cancel that checkpoints consult belong to whichever run is current, so a run left going
     * beside the next one would read that one's budget — the very overlap the lane is for. */
    run.cancelled = 'it ran past its deadline'
    void settled.then(release)
    const seconds = Math.round((run.deadline - started) / 1000)
    const message = writes
      ? `${request.op} did not finish within ${seconds}s. Its writes are NOT interrupted — they finish in the ` +
        'background; read the document back before retrying any of it.'
      : `${request.op} did not finish within ${seconds}s and was stopped by the plugin. Narrow it (pageId, ` +
        'nodeId, a smaller limit), or continue with the `cursor` an op hands back.'
    report(request.op, false, Date.now() - started, message)
    return failed(request, 'timeout', message)
  }

  release()
  if (first.ok) {
    report(request.op, true, Date.now() - started)
    /* A call that spent half a minute waiting for Figma to load a page looks, from the other
     * side of the bridge, exactly like a call that hung. It is not, and the difference decides
     * what the caller does next: wait, or go looking for a broken channel. */
    const loading = takeLoading()
    const result = first.value
    return {
      id: request.id,
      ok: true,
      result: loading && result && typeof result === 'object' && !Array.isArray(result)
        ? { ...(result as Record<string, unknown>), loading }
        : result,
      ...(loading ? { loading } : {}),
    }
  }
  const err = first.error
  const message = String((err as Error)?.message || err)
  report(request.op, false, Date.now() - started, message)
  /* `ParamError` is the caller's mistake and never worth retrying as-is; a stopped run is a
   * `timeout` (narrow it or continue it); anything else came out of the op or out of Figma. */
  const code: AgentErrorCode =
    err instanceof ParamError ? 'param_invalid' : err instanceof RunStopped ? 'timeout' : 'figma_threw'
  return failed(request, code, message)
}

/** Every agent call shows up in the plugin window. A channel a designer can't watch is a
 * channel they can't sensibly consent to. */
function report(op: string, ok: boolean, ms: number, error?: string): void {
  postToUi({ type: 'AGENT_ACTIVITY', op, ok, ms, error })
}
