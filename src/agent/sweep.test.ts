import test from 'node:test'
import assert from 'node:assert/strict'
import { COLD_PAGE_RESERVE_MS, openSweep, resetSweeps, resolveSweepRoots, type SweepVisitor } from './sweep.ts'
import { resetLoading } from './loading.ts'
import { ParamError } from './protocol.ts'

/* A small document: two pages, nested frames, one instance with insides. Ids say where they sit. */
function makeDocument() {
  const node = (id: string, type: string, children: any[] = []): any => {
    const self: any = { id, name: id, type, children, removed: false, parent: null }
    for (const child of children) child.parent = self
    return self
  }
  const loads: string[] = []
  const page = (id: string, children: any[]) => {
    const self = node(id, 'PAGE', children)
    self.loadAsync = async () => { loads.push(id) }
    self.findAllWithCriteria = ({ types }: { types: string[] }) => {
      const out: any[] = []
      const walk = (n: any) => { for (const c of n.children) { if (types.includes(c.type)) out.push(c); walk(c) } }
      walk(self)
      return out
    }
    return self
  }
  const p1 = page('p1', [
    node('a', 'FRAME', [node('a1', 'TEXT'), node('a2', 'FRAME', [node('a2x', 'TEXT')])]),
    node('b', 'INSTANCE', [node('b1', 'TEXT')]),
  ])
  const p2 = page('p2', [node('c', 'FRAME', [node('c1', 'TEXT')]), node('d', 'TEXT')])
  const root = node('0:0', 'DOCUMENT', [p1, p2])
  ;(globalThis as any).figma = {
    root,
    currentPage: p1,
    skipInvisibleInstanceChildren: false,
    getNodeByIdAsync: async (id: string) => {
      const find = (n: any): any => (n.id === id ? n : n.children.map(find).find(Boolean) ?? null)
      return find(root)
    },
  }
  return { root, p1, p2, loads }
}

const ORDER = ['a', 'a1', 'a2', 'a2x', 'b', 'b1', 'c', 'c1', 'd']

/** Drives a sweep to the end, one call per slice, the way an agent following `cursor` would. */
async function drain(params: Record<string, unknown>, visitFor: (seen: string[]) => SweepVisitor, extra: object = {}) {
  const seen: string[] = []
  let cursor: string | undefined
  const reports = []
  for (let call = 0; call < 50; call++) {
    const sweep = await openSweep({
      op: 'test.sweep',
      params: { ...params, ...(cursor ? { cursor } : {}) },
      roots: () => resolveSweepRoots(params),
      state: () => ({ count: 0 }),
      ...extra,
    })
    await sweep.walk(visitFor(seen))
    const report = sweep.report()
    reports.push(report)
    if (report.complete) return { seen, reports, state: sweep.state }
    cursor = report.cursor
  }
  throw new Error('sweep never completed')
}

test.beforeEach(() => {
  resetSweeps()
  resetLoading()
})

test('a sweep stopped at a limit resumes after the last node it visited — nothing twice, nothing skipped', async () => {
  makeDocument()
  const { seen, reports } = await drain({}, (seen) => {
    let thisCall = 0
    return (node) => {
      seen.push(node.id)
      return ++thisCall === 2 ? 'stop' : undefined
    }
  })
  assert.deepEqual(seen, ORDER)
  assert.equal(reports[0].complete, false)
  assert.equal(reports[0].stoppedOn, 'limit')
  assert.equal(reports.at(-1)!.swept.nodes, ORDER.length)
})

test('a sweep that runs out of time parks and the next call carries on from exactly there', async () => {
  makeDocument()
  const realNow = Date.now
  let clock = 1_000_000
  Date.now = () => clock
  try {
    // Each visit costs 400 ms of a 1 s slice: two or three nodes per call.
    const { seen, reports } = await drain({ budgetMs: 1000 }, (seen) => (node) => {
      seen.push(node.id)
      clock += 400
    })
    assert.deepEqual(seen, ORDER)
    assert.ok(reports.length > 2)
    assert.ok(reports.slice(0, -1).every((report) => report.stoppedOn === 'budget' && typeof report.cursor === 'string'))
  } finally {
    Date.now = realNow
  }
})

test('accumulated state survives between calls and the completing call sees all of it', async () => {
  makeDocument()
  let cursor: string | undefined
  for (let call = 0; call < 20; call++) {
    const sweep = await openSweep({
      op: 'test.sweep',
      params: cursor ? { cursor } : {},
      roots: () => resolveSweepRoots({}),
      state: () => ({ texts: 0 }),
    })
    let thisCall = 0
    await sweep.walk((node) => {
      if (node.type === 'TEXT') sweep.state.texts += 1
      return ++thisCall === 3 ? 'stop' : undefined
    })
    const report = sweep.report()
    if (report.complete) {
      assert.ok(call > 0, 'expected the count to span several calls')
      assert.equal(sweep.state.texts, 5)
      return
    }
    cursor = report.cursor
  }
  assert.fail('sweep never completed')
})

test('pages are loaded one at a time as the sweep reaches them, never all up front', async () => {
  const { loads } = makeDocument()
  const sweep = await openSweep({
    op: 'test.sweep',
    params: {},
    roots: () => resolveSweepRoots({}),
    state: () => null,
  })
  await sweep.walk((node) => (node.id === 'a1' ? 'stop' : undefined))
  assert.deepEqual(loads, ['p1'])
})

test('a cold page is not started with too little time left once the call has done work', async () => {
  const { loads } = makeDocument()
  const realNow = Date.now
  let clock = 5_000_000
  Date.now = () => clock
  try {
    const sweep = await openSweep({
      op: 'test.sweep',
      params: { budgetMs: COLD_PAGE_RESERVE_MS + 5_000 },
      roots: () => resolveSweepRoots({}),
      state: () => null,
    })
    // Page one eats the time; page two is cold and would not fit.
    await sweep.walk(() => { clock += 1_000 })
    const report = sweep.report()
    assert.equal(report.complete, false)
    assert.deepEqual(loads, ['p1'])
    assert.deepEqual(report.swept.roots, { done: 1, of: 2 })
  } finally {
    Date.now = realNow
  }
})

test('the type-index mode resumes by position within a page and moves page by page', async () => {
  makeDocument()
  const { seen } = await drain(
    {},
    (seen) => {
      let thisCall = 0
      return (node) => {
        seen.push(node.id)
        return ++thisCall === 2 ? 'stop' : undefined
      }
    },
    { types: ['TEXT'] }
  )
  assert.deepEqual(seen, ['a1', 'a2x', 'b1', 'c1', 'd'])
})

test('skipInstanceChildren visits an instance but not the mirror inside it', async () => {
  makeDocument()
  const { seen } = await drain({}, (seen) => (node) => { seen.push(node.id) }, { skipInstanceChildren: true })
  assert.deepEqual(seen, ['a', 'a1', 'a2', 'a2x', 'b', 'c', 'c1', 'd'])
})

test('a branch deleted between two calls ends there; its siblings are still visited', async () => {
  const { p1 } = makeDocument()
  const seen: string[] = []
  const first = await openSweep({ op: 'test.sweep', params: {}, roots: () => resolveSweepRoots({}), state: () => null })
  await first.walk((node) => {
    seen.push(node.id)
    return node.id === 'a1' ? 'stop' : undefined
  })
  const { cursor } = first.report()

  // The designer deletes frame a2 (and with it a2x) before the next call.
  const a = p1.children[0]
  a.children[1].removed = true
  a.children[1].children[0].removed = true
  a.children = [a.children[0]]

  const second = await openSweep({ op: 'test.sweep', params: { cursor }, roots: () => resolveSweepRoots({}), state: () => null })
  await second.walk((node) => { seen.push(node.id) })
  assert.equal(second.report().complete, true)
  assert.deepEqual(seen, ['a', 'a1', 'b', 'b1', 'c', 'c1', 'd'])
})

test('a cursor only continues the call it came from', async () => {
  makeDocument()
  const first = await openSweep({ op: 'test.sweep', params: { pageId: 'p1' }, roots: () => resolveSweepRoots({ pageId: 'p1' }), state: () => null })
  await first.walk(() => 'stop')
  const { cursor } = first.report()

  await assert.rejects(
    openSweep({ op: 'test.sweep', params: { pageId: 'p2', cursor }, roots: () => resolveSweepRoots({}), state: () => null }),
    (err: unknown) => err instanceof ParamError && /different/.test((err as Error).message)
  )
  await assert.rejects(
    openSweep({ op: 'test.sweep', params: { cursor: 'sweep-gone' }, roots: () => resolveSweepRoots({}), state: () => null }),
    (err: unknown) => err instanceof ParamError && /unknown/.test((err as Error).message)
  )
  // budgetMs may change between calls; it is not part of what is being swept.
  const resumed = await openSweep({
    op: 'test.sweep',
    params: { pageId: 'p1', cursor, budgetMs: 5000 },
    roots: () => resolveSweepRoots({ pageId: 'p1' }),
    state: () => null,
  })
  assert.equal(resumed.resumed, true)
})

test('a node deleted before a type-index sweep resumes does not make it skip the live node after it', async () => {
  const { p1 } = makeDocument()
  const seen: string[] = []
  const first = await openSweep({ op: 'test.sweep', params: {}, roots: () => resolveSweepRoots({}), state: () => null, types: ['TEXT'] })
  await first.walk((node) => {
    seen.push(node.id)
    return 'stop'
  })
  const { cursor } = first.report()
  // a1 — already visited — is deleted before the next call.
  p1.children[0].children[0].removed = true

  const second = await openSweep({ op: 'test.sweep', params: { cursor }, roots: () => resolveSweepRoots({}), state: () => null, types: ['TEXT'] })
  await second.walk((node) => { seen.push(node.id) })
  assert.deepEqual(seen, ['a1', 'a2x', 'b1', 'c1', 'd'])
})

test('a shallow sweep rooted at an instance does not walk the mirror inside it', async () => {
  makeDocument()
  const seen: string[] = []
  const sweep = await openSweep({
    op: 'test.sweep',
    params: { nodeId: 'b' },
    roots: () => resolveSweepRoots({ nodeId: 'b' }),
    state: () => null,
    skipInstanceChildren: true,
  })
  await sweep.walk((node) => { seen.push(node.id) })
  assert.deepEqual(seen, ['b'])
})
