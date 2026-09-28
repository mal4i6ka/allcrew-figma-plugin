/**
 * History: who changed what, and when.
 *
 * Figma answers "who" and "when" directly and "what" not at all. Version history is a list of
 * snapshots with an author and an optional label; nothing in it says what moved. Measured on a
 * real file: 50 checkpoints over 12 days, ONE of them named, 16 authored by "Figma" itself
 * (autosave, not a person). So the list is a record of contact, not of intent.
 *
 * The "what" is computed by rendering the file at two versions and diffing. These tests pin the
 * three things that can be wrong about that: the diff (including that a changed child must not
 * make every ancestor read as changed), the attribution rule (only adjacent checkpoints have one
 * author), and the bisection that finds the checkpoint responsible without paying for a linear
 * walk — which at 8–10 seconds a render is the difference between a usable op and a timeout.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { diffDocuments, runHistoryOp, versionList } from './bridge.mjs'

const FILE_KEY = 'aBcDeFgHiJkLmNoPqRsTuV'

const version = (id, at, user, label) => ({
  id,
  created_at: at,
  user: { handle: user },
  label: label ?? null,
  description: null,
})

/* ------------------------------------------------------------- the list */

test('an autosave and a named version are told apart, because only one records intent', () => {
  const listed = versionList([
    version('5', '2026-09-15T12:00:00Z', 'Alexander Lugachev'),
    version('4', '2026-09-14T20:00:00Z', 'Figma'),
    version('3', '2026-09-14T08:00:00Z', 'Alexander Lugachev', 'Checkpoint'),
    version('2', '2026-09-13T08:00:00Z', 'Teo M'),
    version('1', '2026-09-12T08:00:00Z', 'Figma'),
  ])
  assert.equal(listed.checkpoints, 5)
  // The distinction that makes the list worth reading at all.
  assert.equal(listed.autosaves, 2, 'Figma saving on its own is not a person doing something')
  assert.equal(listed.named, 1, 'a label is the only place anybody records what they meant')
  assert.equal(listed.items.find((r) => r.id === '4').autosave, true)
  assert.equal(listed.items.find((r) => r.id === '3').named, true)
  assert.equal(listed.items.find((r) => r.id === '3').label, 'Checkpoint')
  // "Who has been working in here", which is the cheapest honest question this can answer.
  assert.deepEqual(listed.authors, [
    { author: 'Alexander Lugachev', checkpoints: 2 },
    { author: 'Figma', checkpoints: 2 },
    { author: 'Teo M', checkpoints: 1 },
  ])
})

/* ------------------------------------------------------------- the diff */

const doc = (over = {}) => ({
  id: '0:1',
  name: 'Page',
  type: 'CANVAS',
  children: [
    {
      id: '1:1',
      name: 'Screen',
      type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
      children: [
        { id: '1:2', name: 'Card', type: 'FRAME', fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }], children: [] },
        { id: '1:3', name: 'Label', type: 'TEXT', characters: 'Hello', children: [] },
      ],
    },
  ],
  ...over,
})

test('a change is the node’s own — an edited child does not make every ancestor read as edited', () => {
  /* Without excluding `children` from a node's identity, editing one label reports its card, its
   * screen and its page as changed too, and a diff of a real screen becomes a list of everything
   * above the edit. */
  const before = doc()
  const after = doc()
  after.children[0].children[1].characters = 'Goodbye'

  const diff = diffDocuments(before, after)
  assert.deepEqual(diff.counts, { added: 0, removed: 0, changed: 1 })
  assert.equal(diff.changed[0].id, '1:3')
  assert.deepEqual(diff.changed[0].moved, [{ property: 'characters', from: '"Hello"', to: '"Goodbye"' }])
})

test('added and removed layers are named, not just counted', () => {
  const before = doc()
  const after = doc()
  after.children[0].children.push({ id: '1:4', name: 'Badge', type: 'FRAME', children: [] })
  after.children[0].children = after.children[0].children.filter((n) => n.id !== '1:2')

  const diff = diffDocuments(before, after)
  assert.deepEqual(diff.counts, { added: 1, removed: 1, changed: 0 })
  assert.deepEqual(diff.added, [{ id: '1:4', name: 'Badge', type: 'FRAME' }])
  assert.deepEqual(diff.removed, [{ id: '1:2', name: 'Card', type: 'FRAME' }])
})

test('the property histogram is the readable answer, ordered by how many layers moved', () => {
  /* On a real 12-day span this said "37 fills, 25 backgrounds, 5 overrides" — which is a
   * sentence about what somebody did. The list of 40 changed layers underneath it was not. */
  const before = doc()
  const after = doc()
  const screen = after.children[0]
  screen.children[0].fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]
  screen.children[1].fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]
  screen.children[1].name = 'Title'

  const diff = diffDocuments(before, after)
  assert.deepEqual(diff.properties, [
    { property: 'fills', layers: 2 },
    { property: 'name', layers: 1 },
  ])
})

test('the detail list is bounded while the counts and histogram stay complete', () => {
  const before = doc()
  const after = doc()
  const screen = after.children[0]
  for (let i = 0; i < 30; i++) {
    const id = `2:${i}`
    before.children[0].children.push({ id, name: `n${i}`, type: 'FRAME', opacity: 1, children: [] })
    screen.children.push({ id, name: `n${i}`, type: 'FRAME', opacity: 0.5, children: [] })
  }
  const diff = diffDocuments(before, after, { limit: 5 })
  assert.equal(diff.counts.changed, 30, 'the count covers everything')
  assert.equal(diff.changed.length, 5, 'the detail is capped')
  assert.equal(diff.changedOmitted, 25, 'and the cap is stated, never silent')
  assert.deepEqual(diff.properties, [{ property: 'opacity', layers: 30 }])
})

test('a long value is clipped rather than pasted whole into the report', () => {
  const before = doc()
  const after = doc()
  after.children[0].children[0].fills = [{ type: 'IMAGE', imageRef: 'x'.repeat(400) }]
  const moved = diffDocuments(before, after).changed[0].moved[0]
  assert.ok(moved.to.length < 200, 'a diff is a report, not a payload')
  assert.ok(moved.to.endsWith('…'), 'and the clip is visible')
})

/* --------------------------------------------------------- attribution */

/** A fake history: five checkpoints, and a node whose fill changed at '3'. */
const HISTORY = [
  version('5', '2026-09-15T12:00:00Z', 'Alexander Lugachev'),
  version('4', '2026-09-14T20:00:00Z', 'Figma'),
  version('3', '2026-09-14T08:00:00Z', 'Teo M', 'Rework the card'),
  version('2', '2026-09-13T08:00:00Z', 'Alexander Lugachev'),
  version('1', '2026-09-12T08:00:00Z', 'Alexander Lugachev'),
]

/** The card is white up to and including version 2, black from version 3 on. */
function documentAt(versionId) {
  const black = Number(versionId ?? 99) >= 3
  const tree = doc()
  tree.children[0].children[0].fills = [
    { type: 'SOLID', color: black ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 } },
  ]
  return tree
}

function harness({ onFetch } = {}) {
  const fetched = []
  return {
    fetched,
    listVersions: async (_key, { limit } = {}) => HISTORY.slice(0, limit ?? 30),
    fetchVersion: async (_key, { version: v } = {}) => {
      fetched.push(v ?? 'current')
      if (onFetch) onFetch(v)
      return documentAt(v)
    },
  }
}

test('a diff across a span refuses to name anybody for it', async () => {
  const h = harness()
  const answer = await runHistoryOp('history.diff', { fileKey: FILE_KEY, from: '1', to: '5', nodeId: '1:2', limit: 20 }, h)
  // Crediting the author of the endpoint would be a claim about work that is not theirs.
  assert.equal(answer.by, null)
  assert.match(answer.note, /nobody can be named/)
  assert.equal(answer.counts.changed, 1)
  assert.equal(answer.fetches, 2)
})

test('attribute: true refuses two versions that are not adjacent', async () => {
  const h = harness()
  await assert.rejects(
    () => runHistoryOp('history.diff', { fileKey: FILE_KEY, from: '1', to: '5', attribute: true, nodeId: '1:2' }, h),
    /ADJACENT checkpoints/
  )
})

test('attribute: true names the author when the pair IS adjacent', async () => {
  const h = harness()
  const answer = await runHistoryOp(
    'history.diff',
    { fileKey: FILE_KEY, from: '2', to: '3', attribute: true, nodeId: '1:2', limit: 20 },
    h
  )
  // Consecutive checkpoints have exactly one author, so this is a fact rather than an inference.
  assert.equal(answer.by.author, 'Teo M')
  assert.equal(answer.by.label, 'Rework the card')
  assert.equal(answer.counts.changed, 1)
})

/* ------------------------------------------------------------- bisection */

test('blame finds the one checkpoint that changed the node, and names its author', async () => {
  const h = harness()
  const answer = await runHistoryOp(
    'history.blame',
    { fileKey: FILE_KEY, nodeId: '1:2', window: 5, depth: 2, budgetMs: 120000 },
    h
  )
  assert.equal(answer.found.id, '3')
  assert.equal(answer.found.author, 'Teo M')
  assert.equal(answer.found.label, 'Rework the card')
  // The step before it, so a reader can see what it was and what it became.
  assert.equal(answer.found.previous.id, '2')
  assert.equal(answer.change.counts.changed, 1)
  assert.deepEqual(answer.change.properties, [{ property: 'fills', layers: 1 }])
  assert.deepEqual(answer.searched, { checkpoints: 5, from: HISTORY[4].created_at, to: HISTORY[0].created_at })
})

test('bisection costs log2(N) renders, not N — which is the whole reason it exists', async () => {
  /* At 8–10 seconds per render against the live API, a linear walk of 32 checkpoints is minutes
   * inside a 180-second ceiling. Renders are cached per version because bisection revisits
   * midpoints, so the count is distinct versions touched. */
  const h = harness()
  await runHistoryOp('history.blame', { fileKey: FILE_KEY, nodeId: '1:2', window: 5, depth: 2 }, h)
  assert.ok(h.fetched.length <= 4, `expected at most 4 renders for 5 checkpoints, got ${h.fetched.length}`)
  assert.equal(new Set(h.fetched).size, h.fetched.length, 'a version is never rendered twice')
})

test('a node that did not change in the window says so instead of blaming the nearest edit', async () => {
  const h = harness()
  const answer = await runHistoryOp(
    'history.blame',
    { fileKey: FILE_KEY, nodeId: '1:3', window: 5, depth: 2 },
    h
  )
  assert.equal(answer.found, null)
  assert.match(answer.note, /unchanged across this whole window/)
  // Two renders to establish it, and no search.
  assert.equal(answer.fetches, 2)
})

test('property narrows the search so an unrelated edit does not answer the question', async () => {
  /* "Who changed the fill" must not stop on somebody having moved the layer. */
  const moved = []
  const h = {
    listVersions: async (_k, { limit } = {}) => HISTORY.slice(0, limit ?? 30),
    fetchVersion: async (_k, { version: v } = {}) => {
      moved.push(v)
      const tree = documentAt(v)
      // Everybody nudges the card; only version 3 repaints it.
      tree.children[0].children[0].x = Number(v ?? 99)
      return tree
    },
  }
  const anyChange = await runHistoryOp('history.blame', { fileKey: FILE_KEY, nodeId: '1:2', window: 5, depth: 2 }, h)
  assert.equal(anyChange.found.id, '5', 'without a property, the most recent nudge is the answer')

  const byFill = await runHistoryOp(
    'history.blame',
    { fileKey: FILE_KEY, nodeId: '1:2', property: 'fills', window: 5, depth: 2 },
    h
  )
  assert.equal(byFill.found.id, '3')
  assert.equal(byFill.found.author, 'Teo M')
})

test('the search gives up on its budget and says where it got to', async () => {
  let clock = 0
  const h = harness()
  const answer = await runHistoryOp(
    'history.blame',
    { fileKey: FILE_KEY, nodeId: '1:2', window: 5, depth: 2, budgetMs: 1 },
    { ...h, now: () => (clock += 1000) }
  )
  // Partial, and labelled partial: dying on the bridge ceiling with nothing to show is the
  // failure this avoids.
  assert.equal(answer.stoppedOn, 'budgetMs')
  assert.equal(answer.partial, true)
})

/* ----------------------------------------------------------------- reads */

test('a window with no named checkpoint says the history records no intent', async () => {
  const h = {
    listVersions: async () => [version('2', '2026-09-15T12:00:00Z', 'Figma'), version('1', '2026-09-14T12:00:00Z', 'Teo M')],
    fetchVersion: async () => doc(),
  }
  const answer = await runHistoryOp('history.versions', { fileKey: FILE_KEY, limit: 30 }, h)
  assert.equal(answer.named, 0)
  assert.match(answer.note, /none of them records what anybody intended/)
})

test('named: true returns only the checkpoints a human meant to leave', async () => {
  const h = harness()
  const answer = await runHistoryOp('history.versions', { fileKey: FILE_KEY, limit: 30, named: true }, h)
  assert.deepEqual(answer.items.map((r) => r.id), ['3'])
  // The totals still describe the whole window, so "1 of 5" stays visible.
  assert.equal(answer.checkpoints, 5)
})

/* ------------------------------------------------------------ the depth trap */

test('a node too deep for the render is refused, never reported as unchanged', async () => {
  /* Figma counts `depth` from the DOCUMENT ROOT, not from the node named in `ids` — measured on
   * the live API, where the same node was absent at depth 1 and 2 and present at depth 4. So a
   * shallow render prunes the node out of BOTH sides, both shapes come back absent, and a naive
   * comparison says "unchanged across this whole window". That is a confident wrong answer to
   * "who changed this", which is the one answer this op must never give. It cost a live run to
   * find, so it gets a test. */
  const shallow = {
    listVersions: async (_k, { limit } = {}) => HISTORY.slice(0, limit ?? 30),
    // A payload that simply does not contain the node being asked about.
    fetchVersion: async () => ({ id: '0:1', name: 'Page', type: 'CANVAS', children: [] }),
  }
  await assert.rejects(
    () => runHistoryOp('history.blame', { fileKey: FILE_KEY, nodeId: '1:2', window: 5, depth: 1 }, shallow),
    /not in the rendered payload at depth 1[\s\S]*DOCUMENT ROOT/
  )
  await assert.rejects(
    () => runHistoryOp('history.diff', { fileKey: FILE_KEY, nodeId: '1:2', from: '1', to: '5', depth: 1 }, shallow),
    /not in the rendered payload at depth 1/
  )
})

test('a node that genuinely appears or disappears is still a finding, not a refusal', async () => {
  // Present on one side only is an add or a remove — a real answer, and it must survive the
  // guard that catches the depth trap.
  const appearing = {
    listVersions: async (_k, { limit } = {}) => HISTORY.slice(0, limit ?? 30),
    fetchVersion: async (_k, { version: v } = {}) => {
      const tree = { id: '0:1', name: 'Page', type: 'CANVAS', children: [] }
      if (Number(v ?? 99) >= 3) tree.children.push({ id: '1:2', name: 'Card', type: 'FRAME', children: [] })
      return tree
    },
  }
  const answer = await runHistoryOp('history.blame', { fileKey: FILE_KEY, nodeId: '1:2', window: 5, depth: 6 }, appearing)
  assert.equal(answer.found.id, '3', 'the checkpoint that introduced the layer')
  assert.equal(answer.found.author, 'Teo M')
})

test('no file key is a named refusal — the plugin cannot supply one', async () => {
  const h = harness()
  await assert.rejects(() => runHistoryOp('history.versions', {}, h), /Organization-private/)
})
