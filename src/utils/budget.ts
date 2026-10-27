/**
 * The time and cancellation budget every long loop in the sandbox answers to.
 *
 * Plugin code runs on Figma's main thread. A walk that never hands the thread back freezes the
 * editor; a walk that hands it back but never looks at the clock keeps going long after the
 * bridge has stopped waiting (180 s), and the agent's retry then starts a SECOND walk next to the
 * first. Two or three of those side by side is what "Plugin runtime aborted" looks like from the
 * outside. So every long loop calls {@link checkpoint}: it yields on a time slice (not a node
 * count — fifty expensive property reads can cost more than five hundred cheap ones), and it
 * stops the loop when the run it belongs to was cancelled or has run past its deadline.
 *
 * A "run" is one agent request. The listener runs them one at a time (see `listener.ts`), which
 * is what lets this module keep the current run in a plain variable: there is no async context
 * in the sandbox, and with one run at a time there does not need to be. Code outside any run —
 * a designer clicking a panel button — still gets the time-sliced yields, and is never stopped.
 */

/**
 * Waits `ms` and resolves. The executor form is deliberate: the plugin sandbox is pinned to
 * ES2020 (see `tsconfig.json`), so `Promise.withResolvers` does not exist there.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** How long a loop may hold the main thread before it yields. Long enough that the yield (a
 * `setTimeout(0)`, a few ms) costs little, short enough that the editor stays responsive. */
export const SLICE_MS = 40

export type StopReason = 'deadline' | 'cancelled'

export interface Run {
  /** The agent request id — what a cancel names. */
  readonly id: string
  readonly op: string
  readonly startedAt: number
  /** Absolute `Date.now()` past which this run must have answered. */
  readonly deadline: number
  /** Set by a cancel from the bridge, or by the listener when the run overstayed its deadline. */
  cancelled: string | null
  /** Whether {@link checkpoint} may throw at the deadline. Off for writes: stopping a batch of
   * writes half way leaves a half-applied change, which is worse than finishing late. A write op
   * turns it on for its read-only phase with {@link enforceDeadline}. */
  enforce: boolean
}

/** Thrown out of a loop that was told to stop. The listener turns it into a `timeout` answer the
 * caller can act on, instead of a generic failure. */
export class RunStopped extends Error {
  readonly reason: StopReason
  constructor(reason: StopReason, message: string) {
    super(message)
    this.name = 'RunStopped'
    this.reason = reason
  }
}

let current: Run | null = null
let lastYield = Date.now()
let panelCommands = 0

export function currentRun(): Run | null {
  return current
}

/** Installs the run the listener is about to execute; `null` clears it. */
export function setCurrentRun(run: Run | null): void {
  current = run
  lastYield = Date.now()
}

/**
 * Runs one of the designer's own panel commands. Those do not go through the agent lane — a
 * click must not wait behind a three-minute sweep — so they can overlap an agent run, and with
 * one global run they would inherit its deadline and its cancel: a remap the designer started
 * could stop half applied because an agent read ran out of time. While any panel command is in
 * progress, nothing is stopped; the agent run is still answered for by the listener's own
 * overstay timer, it just loses its early, cooperative stop for that while.
 */
export async function asPanelCommand<T>(fn: () => Promise<T>): Promise<T> {
  panelCommands += 1
  try {
    return await fn()
  } finally {
    panelCommands -= 1
  }
}

/** Whether the current run may be stopped right now: it is a read (or a write's enforced
 * phase), and no panel command of the designer's is running beside it. */
function stoppable(run: Run | null): run is Run {
  return run !== null && run.enforce && panelCommands === 0
}

/** Milliseconds left before the current run must answer — `Infinity` outside any run. */
export function timeLeft(): number {
  return current ? current.deadline - Date.now() : Infinity
}

/** Why the current run must stop now, or `null` while it may keep going. `reserveMs` is time
 * held back for building the answer: a loop stops while there is still room to reply. */
export function stopReason(reserveMs = 0): StopReason | null {
  if (!stoppable(current)) return null
  if (current.cancelled) return 'cancelled'
  return Date.now() + reserveMs >= current.deadline ? 'deadline' : null
}

function stopped(run: Run, reason: StopReason): RunStopped {
  const seconds = Math.round((Date.now() - run.startedAt) / 1000)
  return new RunStopped(
    reason,
    reason === 'cancelled'
      ? `${run.op} was cancelled after ${seconds}s (${run.cancelled}) — the plugin stopped it itself and is free again`
      : `${run.op} ran out of its ${seconds}s time budget before finishing — the plugin stopped it itself so the ` +
          'file stays responsive. Narrow the call (pageId, nodeId, a smaller limit) or continue it with the ' +
          '`cursor` it hands back where the op supports one'
  )
}

/**
 * Whether {@link checkpoint} has anything to do right now — a yield is due, or the run must
 * stop. Synchronous on purpose: an `await` per node costs a microtask per node, and a walk over a
 * hundred thousand nodes should pay for the clock read only. Hot loops write
 * `if (pauseDue()) await checkpoint()`; everything else just awaits `checkpoint()`.
 */
export function pauseDue(): boolean {
  const now = Date.now()
  const run = current
  if (stoppable(run) && (run.cancelled || now >= run.deadline)) return true
  return now - lastYield >= SLICE_MS
}

/**
 * The call every long loop makes once per item. Cheap when there is nothing to do (one clock
 * read); yields the main thread once per {@link SLICE_MS}; throws {@link RunStopped} when the
 * current run may be stopped (`enforce`) and was cancelled or is past its deadline.
 *
 * A write that is not enforcing is never stopped here — not by its deadline and not by a
 * cancel. Half of a batch of writes applied is worse than all of it applied late, and a cancel
 * only means nobody is waiting for the answer, not that the change is unwanted.
 */
export async function checkpoint(): Promise<void> {
  const now = Date.now()
  const run = current
  if (stoppable(run)) {
    if (run.cancelled) throw stopped(run, 'cancelled')
    if (now >= run.deadline) throw stopped(run, 'deadline')
  }
  if (now - lastYield >= SLICE_MS) {
    await sleep(0)
    lastYield = Date.now()
  }
}

/** Runs `fn` with deadline enforcement on, for the read-only phase of a write op: a reference
 * count or a scope walk that runs out of time should stop BEFORE the first write, not be allowed
 * to run on until the bridge gives up. */
export async function enforceDeadline<T>(fn: () => Promise<T>): Promise<T> {
  const run = current
  if (!run) return fn()
  const before = run.enforce
  run.enforce = true
  try {
    return await fn()
  } finally {
    run.enforce = before
  }
}

/* ---------------------------------------------------- skipInvisibleInstanceChildren */

let skipHolders = 0
let skipBefore = false

/**
 * `figma.skipInvisibleInstanceChildren` is one global switch shared by everything running in the
 * sandbox. Setting it for a walk and forcing it back to `false` afterwards switches it off under
 * any other walk still in progress (a panel command, an abandoned run). Holders are counted
 * instead: the first one in remembers what the switch was, the last one out puts that back.
 */
export function holdSkipInvisible(): () => void {
  if (skipHolders === 0) skipBefore = figma.skipInvisibleInstanceChildren === true
  skipHolders += 1
  figma.skipInvisibleInstanceChildren = true
  let released = false
  return () => {
    if (released) return
    released = true
    skipHolders -= 1
    if (skipHolders === 0) figma.skipInvisibleInstanceChildren = skipBefore
  }
}

/** Test seam: forget every holder and the remembered value. */
export function resetSkipInvisible(): void {
  skipHolders = 0
  skipBefore = false
}
