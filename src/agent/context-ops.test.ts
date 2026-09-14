// `context-ops.ts` and `ops.ts` import each other. Every real entry point (listener.ts,
// ops.test.ts) reaches `context-ops.ts` THROUGH `ops.ts`, so `ops.ts`'s own top-level
// `ALL_OPS = [...CONTEXT_OPS...]` never reads `CONTEXT_OPS` before `context-ops.ts` finished
// initializing it. Importing this file directly would reverse that order and crash on the
// same TDZ — importing `ops.ts` first here restores it (see `context-assets.test.ts`).
import './ops.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OPS_BY_NAME } from './ops.ts'
import { validateParams } from './protocol.ts'

function setFigma(mock: Record<string, unknown>) {
  ;(globalThis as { figma?: unknown }).figma = {
    base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
    ...mock,
  }
}

interface FakePaint {
  type: string
  imageHash: string | null
  visible?: boolean
  scaleMode: string
}

/** A minimal duck-typed live node — same shape unit tests across this target use in place of a
 * real Figma `SceneNode` (see `export/assets.test.ts`'s `makeSourceNode`, `context-assets.test.ts`'s
 * `FakeSceneNode`). Every field `image.fills`/`image.plate` might touch is present even where a
 * given fake node never exercises it, so a page, a frame, and an image-fill leaf can share it. */
interface FakeNode {
  id: string
  name: string
  type: string
  visible: boolean
  width: number
  height: number
  x: number
  y: number
  fills: FakePaint[]
  children: FakeNode[]
  parent: FakeNode | null
  absoluteTransform: [[number, number, number], [number, number, number]]
  loadAsync: () => Promise<void>
  clone: () => FakeNode
  exportAsync: (settings: { format: string; constraint: { type: string; value: number } }) => Promise<Uint8Array>
  remove: () => void
  appendChild: (child: FakeNode) => void
}

function reparent(container: FakeNode, child: FakeNode): void {
  if (child.parent) {
    const at = child.parent.children.indexOf(child)
    if (at >= 0) child.parent.children.splice(at, 1)
  }
  child.parent = container
  container.children.push(child)
}

function makeNode(id: string, type: string, overrides: Partial<FakeNode> = {}): FakeNode {
  const node: FakeNode = {
    id,
    name: id,
    type,
    visible: true,
    width: 10,
    height: 10,
    x: 0,
    y: 0,
    fills: [],
    children: [],
    parent: null,
    absoluteTransform: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    loadAsync: async () => {},
    appendChild: (child) => reparent(node, child),
    clone: () => {
      throw new Error(`${id} was never meant to be cloned in this test`)
    },
    exportAsync: () => {
      throw new Error(`${id} was never meant to be exported in this test`)
    },
    remove: () => {
      if (node.parent) {
        const at = node.parent.children.indexOf(node)
        if (at >= 0) node.parent.children.splice(at, 1)
      }
      node.parent = null
    },
    ...overrides,
  }
  return node
}

/* -------------------------------------------------------------- image.plate */

test('image.plate renders the node with every descendant hidden and names the file by format', async () => {
  const page = makeNode('0:1', 'PAGE')
  const badge = makeNode('1:2', 'TEXT')
  const card = makeNode('1:1', 'INSTANCE', { name: 'Topic Card' })
  page.appendChild(card)
  card.appendChild(badge)

  const exportCalls: Array<{ receiver: FakeNode; settings: unknown }> = []
  card.clone = () => {
    const clone = makeNode('1:1#clone', 'INSTANCE', { name: 'Topic Card' })
    for (const child of card.children) clone.appendChild(makeNode(`${child.id}#clone`, child.type))
    page.appendChild(clone)
    clone.exportAsync = async (settings) => {
      exportCalls.push({ receiver: clone, settings })
      return new Uint8Array([1, 2, 3, 4])
    }
    return clone
  }

  let commits = 0
  setFigma({
    commitUndo: () => { commits += 1 },
    getNodeByIdAsync: async (id: string) => (id === card.id ? card : null),
  })

  const op = OPS_BY_NAME.get('image.plate')!
  const params = validateParams(op.params, { nodeId: card.id, format: 'JPG', scale: 2 })
  const result = (await op.run(params)) as {
    node: { id: string }
    format: string
    bytes: number
    file: { __alteryFile: { name: string; mime: string } }
  }

  assert.equal(result.node.id, card.id)
  assert.equal(result.format, 'JPG')
  assert.equal(result.bytes, 4)
  assert.equal(result.file.__alteryFile.name, 'topic-card.jpg')
  assert.equal(result.file.__alteryFile.mime, 'image/jpeg')
  assert.equal(exportCalls.length, 1)
  assert.deepEqual(exportCalls[0].settings, { format: 'JPG', constraint: { type: 'SCALE', value: 2 } })
  // Every descendant of the clone was hidden before the render — the same guarantee plate.ts's
  // own tests cover in detail; this op-level test only has to prove the wiring reaches it.
  assert.equal(exportCalls[0].receiver.children[0].visible, false)
  assert.equal(commits, 1)
})

/* -------------------------------------------------------------- image.fills */

function paint(hash: string): FakePaint {
  return { type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' }
}

test('image.fills: imageHash narrows the whole subtree down to exactly one fill', async () => {
  const page = makeNode('0:1', 'PAGE')
  const root = makeNode('2:0', 'FRAME', { width: 400, height: 400 })
  const a = makeNode('2:1', 'RECTANGLE', { width: 300, height: 300, fills: [paint('hash-a')] })
  const b = makeNode('2:2', 'RECTANGLE', { width: 100, height: 100, fills: [paint('hash-b')] })
  page.appendChild(root)
  root.appendChild(a)
  root.appendChild(b)

  const fetched: string[] = []
  setFigma({
    getNodeByIdAsync: async (id: string) => [page, root, a, b].find((n) => n.id === id) ?? null,
    getImageByHash: (hash: string) => ({
      getBytesAsync: async () => {
        fetched.push(hash)
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
      },
    }),
  })

  const op = OPS_BY_NAME.get('image.fills')!
  const params = validateParams(op.params, { nodeId: root.id, imageHash: 'hash-b', minSide: 0 })
  const result = (await op.run(params)) as { count: number; images: Array<{ hash: string }>; failed: unknown[] }

  assert.equal(result.count, 1)
  assert.equal(result.images[0].hash, 'hash-b')
  assert.deepEqual(fetched, ['hash-b'], 'hash-a was filtered out before any byte fetch, not just from the report')
  assert.deepEqual(result.failed, [])
})

test('image.fills: paintIndex combined with imageHash pins one exact slot on a multi-fill node', async () => {
  const page = makeNode('0:1', 'PAGE')
  const root = makeNode('3:0', 'FRAME', {
    width: 200,
    height: 200,
    // Same hash stacked twice on the same node — imageHash alone could not tell the slots apart.
    fills: [paint('hash-x'), paint('hash-x')],
  })
  page.appendChild(root)

  setFigma({
    getNodeByIdAsync: async (id: string) => (id === root.id ? root : null),
    getImageByHash: () => ({
      getBytesAsync: async () => new Uint8Array([1, 2, 3]),
    }),
  })

  const op = OPS_BY_NAME.get('image.fills')!
  const params = validateParams(op.params, { nodeId: root.id, imageHash: 'hash-x', paintIndex: 1, self: true, minSide: 0 })
  const result = (await op.run(params)) as { count: number; images: Array<{ paintIndex: number }> }

  assert.equal(result.count, 1)
  assert.equal(result.images[0].paintIndex, 1)
})

test('image.fills: budgetMs returns whatever it reached instead of waiting out every image', async () => {
  const page = makeNode('0:1', 'PAGE')
  const root = makeNode('4:0', 'FRAME', { width: 900, height: 900 })
  // Ranked largest-first: the slow fill is reached first, the other two never get a chance
  // once the budget is spent on it.
  const slow = makeNode('4:1', 'RECTANGLE', { width: 300, height: 300, fills: [paint('hash-slow')] })
  const untouchedA = makeNode('4:2', 'RECTANGLE', { width: 200, height: 200, fills: [paint('hash-a')] })
  const untouchedB = makeNode('4:3', 'RECTANGLE', { width: 100, height: 100, fills: [paint('hash-b')] })
  page.appendChild(root)
  root.appendChild(slow)
  root.appendChild(untouchedA)
  root.appendChild(untouchedB)

  // The op's own budget bookkeeping reads `Date.now()` directly, so this drives that clock by
  // hand instead of a real wait: `getBytesAsync` below resolves on a plain microtask (no
  // `setTimeout`, no elapsed wall-clock time at all) but advances `clock` as a side effect,
  // exactly as if the fetch it stands in for had genuinely taken that long. Deterministic, and
  // the test pays none of the 1500 ms it simulates.
  const RealDate = Date
  let clock = 1_700_000_000_000
  class FakeDate extends RealDate {
    static now(): number {
      return clock
    }
  }
  globalThis.Date = FakeDate as unknown as DateConstructor

  const requestedHashes: string[] = []
  try {
    setFigma({
      getNodeByIdAsync: async (id: string) => [page, root, slow, untouchedA, untouchedB].find((n) => n.id === id) ?? null,
      getImageByHash: (hash: string) => {
        requestedHashes.push(hash)
        return {
          getBytesAsync: async () => {
            // Slower than the 1000 ms budget, faster than the (much longer) per-image
            // deadline — the fetch itself still succeeds; it is the call's own budget that
            // runs out.
            clock += 1500
            return new Uint8Array([1, 2, 3])
          },
        }
      },
    })

    const op = OPS_BY_NAME.get('image.fills')!
    const params = validateParams(op.params, { nodeId: root.id, budgetMs: 1000, imageMs: 5000, minSide: 0 })
    const result = (await op.run(params)) as {
      count: number
      timedOut: boolean
      images: Array<{ hash: string }>
      failed: Array<{ hash: string; error: string }>
    }

    assert.equal(result.timedOut, true)
    assert.equal(result.count, 1)
    assert.equal(result.images[0].hash, 'hash-slow')
    assert.deepEqual(
      result.failed.map((f) => f.hash).sort(),
      ['hash-a', 'hash-b']
    )
    assert.ok(result.failed.every((f) => /budget exhausted/.test(f.error)))
    // The two later fills were never even asked for — the budget check stops the loop before
    // `getImageByHash` runs, not after a wasted fetch.
    assert.deepEqual(requestedHashes, ['hash-slow'])
  } finally {
    globalThis.Date = RealDate
  }
})

/* -------------------------------------------------------------- design.context */

/** A real (if minimal) walkable scene tree — `design.context` drives the production
 * `serializeNode`/`emitDjango`/`emitCss` straight through, unlike the lighter fixtures above, so
 * every field those readers touch on a plain FRAME has to be present and Figma-shaped, not just
 * duck-typed to the one property a given test reads. */
interface FixtureNode {
  id: string
  name: string
  type: string
  visible: boolean
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
  blendMode: string
  fills: unknown[]
  strokes: unknown[]
  strokeWeight: number
  strokeAlign: string
  dashPattern: number[]
  cornerRadius: number
  effects: unknown[]
  exportSettings: unknown[]
  constraints: { horizontal: string; vertical: string }
  layoutAlign: string
  layoutGrow: number
  layoutSizingHorizontal: string
  layoutSizingVertical: string
  boundVariables: Record<string, unknown>
  componentPropertyReferences: Record<string, unknown>
  children: FixtureNode[]
  parent: FixtureNode | null
  reactions: unknown[]
  clipsContent: boolean
  layoutMode: string
  primaryAxisSizingMode: string
  counterAxisSizingMode: string
  primaryAxisAlignItems: string
  counterAxisAlignItems: string
  itemSpacing: number
  paddingLeft: number
  paddingRight: number
  paddingTop: number
  paddingBottom: number
  getCSSAsync: () => Promise<Record<string, string>>
  loadAsync?: () => Promise<void>
}

function makeFixtureNode(id: string, type: string, overrides: Partial<FixtureNode> = {}): FixtureNode {
  return {
    id,
    name: overrides.name ?? id,
    type,
    visible: true,
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    rotation: 0,
    opacity: 1,
    blendMode: 'NORMAL',
    fills: [],
    strokes: [],
    strokeWeight: 0,
    strokeAlign: 'INSIDE',
    dashPattern: [],
    cornerRadius: 0,
    effects: [],
    exportSettings: [],
    constraints: { horizontal: 'MIN', vertical: 'MIN' },
    layoutAlign: 'INHERIT',
    layoutGrow: 0,
    layoutSizingHorizontal: 'FIXED',
    layoutSizingVertical: 'FIXED',
    boundVariables: {},
    componentPropertyReferences: {},
    children: [],
    parent: null,
    reactions: [],
    clipsContent: false,
    layoutMode: 'NONE',
    primaryAxisSizingMode: 'FIXED',
    counterAxisSizingMode: 'FIXED',
    primaryAxisAlignItems: 'MIN',
    counterAxisAlignItems: 'MIN',
    itemSpacing: 0,
    paddingLeft: 0,
    paddingRight: 0,
    paddingTop: 0,
    paddingBottom: 0,
    getCSSAsync: async () => ({}),
    ...overrides,
  }
}

function setFigmaForDesignContext(registry: ReadonlyMap<string, FixtureNode>) {
  setFigma({
    getStyleByIdAsync: async () => null,
    variables: {
      getVariableByIdAsync: async () => null,
      getLocalVariableCollectionsAsync: async () => [],
      getLocalVariablesAsync: async () => [],
    },
    skipInvisibleInstanceChildren: false,
    getNodeByIdAsync: async (id: string) => registry.get(id) ?? null,
  })
}

test("design.context includes interactionsCss/interactionsJs only when the node's own reactions produce them", async () => {
  const page = makeFixtureNode('0:1', 'PAGE', { loadAsync: async () => {} })
  const modal = makeFixtureNode('1:3', 'FRAME', { name: 'Modal', width: 300, height: 200 })
  const button = makeFixtureNode('1:2', 'FRAME', {
    name: 'Open',
    reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', navigation: 'OVERLAY', destinationId: '1:3' }] }],
  })
  const root = makeFixtureNode('1:1', 'FRAME', { name: 'Card', children: [button, modal] })
  button.parent = root
  modal.parent = root
  root.parent = page

  setFigmaForDesignContext(new Map([[page.id, page], [root.id, root], [button.id, button], [modal.id, modal]]))

  const op = OPS_BY_NAME.get('design.context')!
  const withOverlay = (await op.run(validateParams(op.params, { nodeId: root.id, screenshot: false }))) as Record<string, unknown>
  assert.ok('interactionsCss' in withOverlay, 'the button’s OVERLAY reaction produced real CSS to link')
  assert.ok('interactionsJs' in withOverlay, 'showModal() wiring produced real JS to link')

  const withoutReactions = (await op.run(validateParams(op.params, { nodeId: modal.id, screenshot: false }))) as Record<string, unknown>
  assert.equal('interactionsCss' in withoutReactions, false, 'an empty stylesheet is not a file worth opening')
  assert.equal('interactionsJs' in withoutReactions, false)
})

test('design.context: pair merges the narrower frame’s @media CSS into a breakpoints field, keyed by width', async () => {
  const page = makeFixtureNode('0:1', 'PAGE', { loadAsync: async () => {} })
  const desktop = makeFixtureNode('1:1', 'FRAME', { name: 'Card', width: 200 })
  const mobile = makeFixtureNode('2:1', 'FRAME', { name: 'Card Mobile', width: 100 })
  desktop.parent = page
  mobile.parent = page

  setFigmaForDesignContext(new Map([[page.id, page], [desktop.id, desktop], [mobile.id, mobile]]))

  const op = OPS_BY_NAME.get('design.context')!
  const result = (await op.run(validateParams(op.params, { nodeId: desktop.id, pair: mobile.id, screenshot: false }))) as {
    breakpoints: { a: { id: string; width: number }; b: { id: string; width: number }; css: string }
  }

  assert.equal(result.breakpoints.a.id, desktop.id)
  assert.equal(result.breakpoints.a.width, 200)
  assert.equal(result.breakpoints.b.id, mobile.id)
  assert.equal(result.breakpoints.b.width, 100)
  assert.ok(result.breakpoints.css.includes('@media (max-width: 199px)'), 'thresholded one below the next-wider frame')

  const withoutPair = (await op.run(validateParams(op.params, { nodeId: desktop.id, screenshot: false }))) as Record<string, unknown>
  assert.equal('breakpoints' in withoutPair, false, 'no pair given — nothing to merge, nothing to report')
})

/* --------------------------------------------------------- motion.context target */

/** A node the Motion beta adapter recognises: one opacity track with two keyframes. */
function animatedNode() {
  return {
    id: '9:1',
    name: 'Card',
    type: 'FRAME',
    children: [],
    animations: { OPACITY: { baseValue: { type: 'FLOAT', value: 1 }, timelineDuration: 2, tracks: [] } },
    timelines: [{ id: 'tl-1', duration: 2 }],
    animationStyles: [],
    manualKeyframeTracks: {
      OPACITY: {
        id: 'track-opacity',
        baseValue: { type: 'FLOAT', value: 0 },
        keyframes: [
          { id: 'kf-0', timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: 0 } },
          { id: 'kf-1', timelinePosition: 2, easing: { type: 'EASE_OUT' }, value: { type: 'FLOAT', value: 1 } },
        ],
      },
    },
    fills: [],
    strokes: [],
    effects: [],
  }
}

function setMotionFigma(node: ReturnType<typeof animatedNode>) {
  setFigma({
    motion: {},
    skipInvisibleInstanceChildren: false,
    loadAllPagesAsync: async () => {},
    getNodeByIdAsync: async (id: string) => (id === node.id ? node : null),
    variables: { getVariableByIdAsync: async () => null },
  })
}

test('a keyframe carries the easing as numbers, whatever the target', async () => {
  const node = animatedNode()
  setMotionFigma(node)

  const op = OPS_BY_NAME.get('motion.context')!
  const result = (await op.run(validateParams(op.params, { nodeId: '9:1' }))) as {
    animated: Array<{ tracks: Array<{ keyframes: Array<{ curve?: { kind: string; preset?: string } }> }> }>
  }

  const keyframes = result.animated[0].tracks[0].keyframes
  assert.deepEqual(keyframes[0].curve, { kind: 'linear' })
  assert.deepEqual(keyframes[1].curve, { kind: 'bezier', x1: 0, y1: 0, x2: 0.58, y2: 1, preset: 'EASE_OUT' })
})

test('a native target is not given a choice between two browser runtimes', async () => {
  // `css`/`gsap` and the files that go with it are a stylesheet and a GSAP timeline; stating a
  // verdict for a SwiftUI build is answering a question nobody asked.
  const node = animatedNode()
  setMotionFigma(node)

  const op = OPS_BY_NAME.get('motion.context')!
  const web = (await op.run(validateParams(op.params, { nodeId: '9:1' }))) as {
    animated: Array<{ backend?: string; reason?: string }>
    files: unknown[]
  }
  const native = (await op.run(validateParams(op.params, { nodeId: '9:1', target: 'native' }))) as {
    animated: Array<{ backend?: string; tracks: unknown[] }>
    files: unknown[]
    note?: string
  }

  assert.equal(web.animated[0].backend, 'css')
  assert.ok(web.files.length > 0, 'a web target still gets the stylesheet it asked for')
  assert.equal(native.animated[0].backend, undefined)
  assert.deepEqual(native.files, [])
  // The tracks — the part that is true on every platform — survive.
  assert.equal(native.animated[0].tracks.length, 1)
  assert.match(native.note ?? '', /browser runtimes/)
})
