import test from 'node:test'
import assert from 'node:assert/strict'
import { GUIDES, validateGuides } from './guides.ts'
import { OPS_BY_NAME } from './ops.ts'

test('nothing is named that the build does not have', () => {
  // The module contract's rule, applied to playbooks: a step citing an op that was renamed
  // would send a fresh agent at a command this build cannot run — and it would fail in front
  // of a user rather than here.
  assert.deepEqual(validateGuides(GUIDES, OPS_BY_NAME), [])
})

test('a step that names a param the op does not take is a problem, not a hint', () => {
  const ops = new Map([['node.get', { params: { nodeId: {} } }]])
  const problems = validateGuides(
    [
      {
        id: 'probe.one',
        title: 'Probe',
        goal: 'g',
        when: 'w',
        steps: [{ op: 'node.get', why: 'y', params: { nodeId: '1:2', depth: 3 } }],
      },
    ],
    ops
  )

  assert.deepEqual(problems, [{ guide: 'probe.one', step: 'node.get', problem: 'op takes no param "depth"' }])
})

test('playbook ids are unique and every one says what it is for', () => {
  const ids = GUIDES.map((guide) => guide.id)
  assert.deepEqual(ids, [...new Set(ids)])
  for (const guide of GUIDES) {
    assert.ok(guide.steps.length > 0, `${guide.id} has no steps`)
    assert.ok(guide.goal.length > 20, `${guide.id} has no goal worth reading`)
    assert.ok(guide.when.length > 20, `${guide.id} does not say when to use it`)
    for (const step of guide.steps) {
      assert.ok(step.why.length > 20, `${guide.id}/${step.op} does not say why it is at this point`)
    }
  }
})

test('the task a fresh agent starts with is covered', () => {
  // These five are the reason playbooks exist at all: an agent that cannot find them ends up
  // reading pixels or inventing product direction. Losing one silently is the failure this test blocks.
  for (const id of ['file.bootstrap', 'product.fidelity', 'screen.build', 'mobile.app', 'system.extract']) {
    assert.ok(GUIDES.some((guide) => guide.id === id), `playbook ${id} is gone`)
  }
})
