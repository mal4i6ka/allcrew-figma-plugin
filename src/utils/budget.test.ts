import test from 'node:test'
import assert from 'node:assert/strict'
import {
  asPanelCommand,
  checkpoint,
  enforceDeadline,
  holdSkipInvisible,
  pauseDue,
  resetSkipInvisible,
  RunStopped,
  setCurrentRun,
  stopReason,
  type Run,
} from './budget.ts'

function run(overrides: Partial<Run> = {}): Run {
  return { id: 'r1', op: 'test.op', startedAt: Date.now(), deadline: Date.now() + 60_000, cancelled: null, enforce: true, ...overrides }
}

test.afterEach(() => {
  setCurrentRun(null)
  resetSkipInvisible()
})

test('a read past its deadline is stopped at the next checkpoint, with a message that says how to continue', async () => {
  setCurrentRun(run({ deadline: Date.now() - 1 }))
  await assert.rejects(checkpoint(), (err: unknown) => {
    assert.ok(err instanceof RunStopped)
    assert.equal(err.reason, 'deadline')
    assert.match(err.message, /cursor/)
    return true
  })
  assert.equal(pauseDue(), true)
})

test('a cancelled read stops at the next checkpoint', async () => {
  setCurrentRun(run({ cancelled: 'the bridge stopped waiting' }))
  await assert.rejects(checkpoint(), (err: unknown) => err instanceof RunStopped && err.reason === 'cancelled')
})

test('a write is never stopped half way — not by its deadline, not by a cancel', async () => {
  setCurrentRun(run({ enforce: false, deadline: Date.now() - 1, cancelled: 'the caller went away' }))
  await checkpoint()
})

test("a write's read-only phase is stopped at the deadline, and the write after it is not", async () => {
  const writing = run({ enforce: false, deadline: Date.now() - 1 })
  setCurrentRun(writing)
  await assert.rejects(enforceDeadline(() => checkpoint()), RunStopped)
  // Enforcement ends with the phase: the writes that follow run to the end.
  assert.equal(writing.enforce, false)
  await checkpoint()
})

test("a designer's panel command overlapping a cancelled agent read is not stopped by it", async () => {
  setCurrentRun(run({ cancelled: 'the bridge stopped waiting', deadline: Date.now() - 1 }))
  await asPanelCommand(async () => {
    await checkpoint()
    assert.equal(stopReason(), null)
  })
  // Once the panel command is done, the agent read is stoppable again.
  await assert.rejects(checkpoint(), RunStopped)
})

test('outside any run (a designer clicking a panel command) nothing is ever stopped', async () => {
  setCurrentRun(null)
  await checkpoint()
})

test('the skip flag survives a walk ending inside another walk, and is put back to what it was', () => {
  const figma = { skipInvisibleInstanceChildren: false }
  ;(globalThis as { figma?: unknown }).figma = figma

  const outer = holdSkipInvisible()
  const inner = holdSkipInvisible()
  inner()
  // The old code forced it to false here, under the outer walk still running.
  assert.equal(figma.skipInvisibleInstanceChildren, true)
  outer()
  assert.equal(figma.skipInvisibleInstanceChildren, false)

  figma.skipInvisibleInstanceChildren = true
  const again = holdSkipInvisible()
  again()
  again()
  // A designer's own `true` is restored as `true`, and a double release counts once.
  assert.equal(figma.skipInvisibleInstanceChildren, true)
})
