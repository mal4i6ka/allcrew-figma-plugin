import test from 'node:test'
import assert from 'node:assert/strict'
import { ANSWER_MARGIN_MS, cancelAgentRequest, handleAgentRequest, resetLane, setGates } from './listener.ts'
import { OPS_BY_NAME } from './ops.ts'
import type { OpDef } from './protocol.ts'
import { checkpoint, sleep } from '../utils/budget.ts'

/* Test ops registered on the real registry, so the real dispatcher (gates, validation, lane,
 * deadline) is what runs them. */
function register(op: Partial<OpDef> & Pick<OpDef, 'name' | 'run'>): void {
  OPS_BY_NAME.set(op.name, { summary: 'test op', mutates: false, params: {}, ...op })
}

test.beforeEach(() => {
  ;(globalThis as { figma?: unknown }).figma = { ui: { postMessage() {} }, skipInvisibleInstanceChildren: false }
  setGates({ read: true, write: true })
  resetLane()
})

test.after(() => {
  for (const name of ['test.slow', 'test.loop', 'test.budget', 'test.stuck', 'test.never']) OPS_BY_NAME.delete(name)
})

test('requests to one file run one at a time, in the order they arrived', async () => {
  const log: string[] = []
  register({
    name: 'test.slow',
    params: { tag: { type: 'string', description: 'which call' } },
    async run(params) {
      log.push(`start ${params.tag}`)
      await sleep(30)
      log.push(`end ${params.tag}`)
      return params.tag
    },
  })
  const answers = await Promise.all([
    handleAgentRequest({ id: '1', op: 'test.slow', params: { tag: 'a' } }),
    handleAgentRequest({ id: '2', op: 'test.slow', params: { tag: 'b' } }),
  ])
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b'])
  assert.deepEqual(answers.map((answer) => answer.result), ['a', 'b'])
})

test('a read the bridge withdraws stops at its next checkpoint and frees the plugin', async () => {
  let iterations = 0
  register({
    name: 'test.loop',
    async run() {
      for (;;) {
        iterations += 1
        await checkpoint()
        await sleep(1)
      }
    },
  })
  const pending = handleAgentRequest({ id: 'loop-1', op: 'test.loop' })
  await sleep(20)
  assert.equal(cancelAgentRequest('loop-1', 'the bridge stopped waiting'), true)
  const answer = await pending
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'timeout')
  assert.match(answer.error!, /cancelled/)
  const after = iterations
  await sleep(20)
  assert.equal(iterations, after, 'the loop kept running after its answer')
})

test('a request whose time ran out while it queued is answered without running', async () => {
  let ran = false
  register({ name: 'test.slow', async run() { await sleep(1_200); return 'first' } })
  register({ name: 'test.never', async run() { ran = true; return 'late' } })
  const first = handleAgentRequest({ id: 'q1', op: 'test.slow', budgetMs: 60_000 })
  // Its own deadline (the 1 s floor) passes while test.slow holds the lane.
  const second = await handleAgentRequest({ id: 'q2', op: 'test.never', budgetMs: ANSWER_MARGIN_MS + 1 })
  assert.equal(second.code, 'timeout')
  assert.match(second.error!, /waited/)
  assert.equal(ran, false)
  assert.equal((await first).result, 'first')
})

test("an op's own budgetMs never outlives the time the call has", async () => {
  let seen: unknown
  register({
    name: 'test.budget',
    params: { budgetMs: { type: 'number', description: 'budget', default: 60_000 } },
    async run(params) {
      seen = params.budgetMs
      return null
    },
  })
  await handleAgentRequest({ id: 'b1', op: 'test.budget', budgetMs: 20_000 })
  assert.equal(typeof seen, 'number')
  assert.ok((seen as number) <= 20_000 - ANSWER_MARGIN_MS, `budgetMs ${seen}`)
  // With room to spare the caller's own value stands.
  await handleAgentRequest({ id: 'b2', op: 'test.budget', params: { budgetMs: 2_000 }, budgetMs: 120_000 })
  assert.equal(seen, 2_000)
})

test('an op that ignores its deadline is answered for in time, and the next call waits until it lets go', async () => {
  let settledAt = 0
  register({
    name: 'test.stuck',
    async run() {
      await sleep(5_000)
      settledAt = Date.now()
      return 'too late'
    },
  })
  let nextStartedAt = 0
  register({ name: 'test.slow', async run() { nextStartedAt = Date.now(); return 'next' } })
  const started = Date.now()
  // Deadline: the 1 s floor; answered at deadline + the 3 s overstay allowance.
  const answer = await handleAgentRequest({ id: 's1', op: 'test.stuck', budgetMs: ANSWER_MARGIN_MS + 1 })
  const took = Date.now() - started
  assert.equal(answer.code, 'timeout')
  assert.match(answer.error!, /stopped by the plugin/)
  assert.ok(took < 4_800, `answered after ${took}ms`)
  // Running the next call beside it would hand the stuck one the next call's budget.
  const next = await handleAgentRequest({ id: 's2', op: 'test.slow', budgetMs: 60_000 })
  assert.equal(next.result, 'next')
  assert.ok(settledAt > 0 && nextStartedAt >= settledAt, 'the next call started while the overstaying one was still running')
})
