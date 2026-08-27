import test from 'node:test'
import assert from 'node:assert/strict'
import { loadAllPagesAsync, findAllWithCriteria, walkSceneNodes } from './tree.ts'

function setFigma(mock: any) {
  ;(globalThis as any).figma = mock
}

function makeNode(overrides: any): any {
  return { children: [], ...overrides }
}

test('loadAllPagesAsync loads every page under figma.root', async () => {
  const loaded: string[] = []
  setFigma({
    root: {
      children: [
        { id: 'page1', loadAsync: async () => loaded.push('page1') },
        { id: 'page2', loadAsync: async () => loaded.push('page2') },
      ],
    },
  })

  await loadAllPagesAsync()

  assert.deepEqual(loaded.sort(), ['page1', 'page2'])
})

test('loadAllPagesAsync keeps at most four loads in flight', async () => {
  // The regression this guards: a 50-way parallel burst is what dropped the Figma client's
  // connection on the 50-page Mobile DS. Bounded is the contract; four is today's batch size.
  let inFlight = 0
  let peak = 0
  let loaded = 0
  const page = (id: string) => ({
    id,
    name: id,
    loadAsync: async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
      loaded += 1
    },
  })
  setFigma({ root: { children: Array.from({ length: 11 }, (_, at) => page(`page${at}`)) } })

  await loadAllPagesAsync()

  assert.equal(loaded, 11)
  assert.equal(peak <= 4, true, `expected at most 4 concurrent loads, saw ${peak}`)
})

test('loadAllPagesAsync retries a page that fails once', async () => {
  let attempts = 0
  setFigma({
    root: {
      children: [
        {
          name: 'Flaky',
          loadAsync: async () => {
            attempts += 1
            if (attempts === 1) throw new Error('transient')
          },
        },
      ],
    },
  })

  await loadAllPagesAsync()

  assert.equal(attempts, 2)
})

test('loadAllPagesAsync names the page that would not load after the retry', async () => {
  setFigma({
    root: {
      children: [
        { name: 'Fine', loadAsync: async () => {} },
        {
          name: '-- Main',
          loadAsync: async () => {
            throw new Error('Unable to establish connection to Figma after 10 seconds')
          },
        },
      ],
    },
  })

  await assert.rejects(loadAllPagesAsync(), /page "-- Main" would not load/)
})

test('findAllWithCriteria recursively collects nodes matching the predicate', async () => {
  setFigma({ skipInvisibleInstanceChildren: false })

  const leafText = makeNode({ id: 'text1', type: 'TEXT' })
  const nestedFrame = makeNode({ id: 'frame2', type: 'FRAME', children: [leafText] })
  const root = makeNode({
    id: 'root',
    type: 'PAGE',
    children: [makeNode({ id: 'rect1', type: 'RECTANGLE' }), nestedFrame],
  })

  const isText = (node: any): node is any => node.type === 'TEXT'
  const results = await findAllWithCriteria(root, isText)

  assert.deepEqual(
    results.map((n: any) => n.id),
    ['text1']
  )
})

test('findAllWithCriteria toggles figma.skipInvisibleInstanceChildren only for the duration of the walk', async () => {
  const figmaMock = { skipInvisibleInstanceChildren: false }
  setFigma(figmaMock)

  const root = makeNode({ id: 'root', type: 'PAGE', children: [] })
  let sawFlagDuringWalk = false

  const isText = (node: any): node is any => {
    sawFlagDuringWalk = sawFlagDuringWalk || figmaMock.skipInvisibleInstanceChildren === true
    return false
  }

  await findAllWithCriteria(makeNode({ id: 'other', type: 'FRAME', children: [root] }), isText)

  assert.equal(sawFlagDuringWalk, true)
  assert.equal(figmaMock.skipInvisibleInstanceChildren, false)
})

test('findAllWithCriteria resets the flag even if the predicate throws', async () => {
  const figmaMock = { skipInvisibleInstanceChildren: false }
  setFigma(figmaMock)

  const root = makeNode({
    id: 'root',
    type: 'PAGE',
    children: [makeNode({ id: 'child', type: 'TEXT' })],
  })

  await assert.rejects(
    findAllWithCriteria(root, () => {
      throw new Error('boom')
    })
  )

  assert.equal(figmaMock.skipInvisibleInstanceChildren, false)
})

test('findAllWithCriteria includeRoot tests the root node itself when it is a SceneNode', async () => {
  setFigma({ skipInvisibleInstanceChildren: false })

  const root = makeNode({ id: 'root', type: 'FRAME', children: [] })
  const isFrame = (node: any): node is any => node.type === 'FRAME'

  const withoutRoot = await findAllWithCriteria(root, isFrame)
  const withRoot = await findAllWithCriteria(root, isFrame, { includeRoot: true })

  assert.deepEqual(withoutRoot, [])
  assert.deepEqual(
    withRoot.map((n: any) => n.id),
    ['root']
  )
})

test('walkSceneNodes visits every scene node once, and knows which sat inside instances', async () => {
  setFigma({ skipInvisibleInstanceChildren: false })

  const inInstance = makeNode({ id: 'inner', type: 'RECTANGLE' })
  const instance = makeNode({ id: 'inst', type: 'INSTANCE', children: [inInstance] })
  const plain = makeNode({ id: 'rect', type: 'RECTANGLE' })
  const root = makeNode({ id: 'root', type: 'PAGE', children: [plain, instance] })

  const seen: Array<[string, boolean]> = []
  const stats = await walkSceneNodes(root, (node: any, inside) => seen.push([node.id, inside]))

  assert.deepEqual(seen, [
    ['rect', false],
    ['inst', false],
    ['inner', true],
  ])
  assert.deepEqual(stats, { visited: 3, insideInstances: 1 })
})

test('walkSceneNodes with skipInstanceChildren visits the instance but not its mirror', async () => {
  setFigma({ skipInvisibleInstanceChildren: false })

  const inInstance = makeNode({ id: 'inner', type: 'RECTANGLE' })
  const instance = makeNode({ id: 'inst', type: 'INSTANCE', children: [inInstance] })
  const root = makeNode({ id: 'root', type: 'PAGE', children: [instance] })

  const seen: string[] = []
  const stats = await walkSceneNodes(root, (node: any) => seen.push(node.id), { skipInstanceChildren: true })

  // The instance itself still carries its own overrides, so it is visited; what is skipped is
  // the subtree that mirrors the main component, which a document-scope walk counts at the main.
  assert.deepEqual(seen, ['inst'])
  assert.deepEqual(stats, { visited: 1, insideInstances: 0 })
})

test('walkSceneNodes restores the skip flag even when the visitor throws', async () => {
  const figmaMock = { skipInvisibleInstanceChildren: false }
  setFigma(figmaMock)

  const root = makeNode({ id: 'root', type: 'PAGE', children: [makeNode({ id: 'rect', type: 'RECTANGLE' })] })

  await assert.rejects(
    walkSceneNodes(root, () => {
      throw new Error('boom')
    })
  )
  assert.equal(figmaMock.skipInvisibleInstanceChildren, false)
})
