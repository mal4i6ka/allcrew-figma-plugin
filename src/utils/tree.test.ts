import test from 'node:test'
import assert from 'node:assert/strict'
import { loadAllPagesAsync, findAllWithCriteria } from './tree.ts'

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
