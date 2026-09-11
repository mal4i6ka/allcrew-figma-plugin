import test from 'node:test'
import assert from 'node:assert/strict'
import { emitInteractions, collectReactionDestinationIds } from './interactions.ts'
import type { IrContainerNode, IrOverlay } from './ir.ts'
import type { DjangoNodeSource } from './css-emitter.ts'

function makeBase() {
  return {
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' as const }, height: { mode: 'hug' as const } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
  }
}

function container(id: string, name: string, children: IrContainerNode['children'] = [], extra: Partial<IrContainerNode> = {}): IrContainerNode {
  return {
    ...makeBase(),
    id,
    name,
    type: 'container',
    layout: { kind: 'absolute' },
    component: null,
    children,
    ...extra,
  } as IrContainerNode
}

/** A live-scene-node-shaped mock (`.name`/`.type`/`.children`/`.getCSSAsync`) for the descendant
 * walk — the same duck type a real Figma node satisfies. */
function liveNode(name: string, type: string, css: Record<string, string>, children: DjangoNodeSource[] = []): DjangoNodeSource {
  return { name, type, children, getCSSAsync: async () => css } as unknown as DjangoNodeSource
}

test('a hover variant that both re-pads the trigger AND recolours a descendant emits BOTH rules', async () => {
  const trigger = container('trig:1', 'Button', [container('trig:1-icon', 'Icon', [])], {
    interactions: [{ trigger: 'ON_HOVER', destinationId: 'dest:1', durationMs: 200, timingFunction: 'ease' }],
  })
  const sceneNodes = new Map<string, DjangoNodeSource>([
    ['trig:1', liveNode('Button', 'FRAME', { padding: '4px' }, [liveNode('Icon', 'VECTOR', { color: 'rgb(0, 0, 0)' })])],
    ['dest:1', liveNode('Button', 'FRAME', { padding: '8px' }, [liveNode('Icon', 'VECTOR', { color: 'rgb(255, 0, 0)' })])],
  ])

  const result = await emitInteractions([trigger], sceneNodes)

  assert.match(result.css, /\.ntrig-1:hover \{\n {2}padding: 8px;\n\}/)
  assert.match(result.css, /\.ntrig-1:hover \.ntrig-1-icon \{\n {2}color: rgb\(255, 0, 0\);\n\}/)
})

test('a hover that swaps a photo ships the exported url, and ships nothing when the asset is absent', async () => {
  const trigger = container('img:1', 'Cover', [], {
    interactions: [{ trigger: 'ON_HOVER', destinationId: 'img:2', durationMs: 200, timingFunction: 'ease' }],
  })
  const sceneNodes = new Map<string, DjangoNodeSource>([
    ['img:1', liveNode('Cover', 'FRAME', { background: 'url(<path-to-image>) center / cover' })],
    ['img:2', liveNode('Cover', 'FRAME', { background: 'url(<path-to-image>) center / contain' })],
  ])

  const resolved = await emitInteractions([trigger], sceneNodes, {
    imageUrlsByNodeId: new Map([['img:2', ['../img/cover-hover.png']]]),
  })
  assert.match(resolved.css, /background: url\(\.\.\/img\/cover-hover\.png\) center \/ contain;/)

  // Without an exported asset the placeholder would resolve to /static/css/%3Cpath-to-image%3E —
  // a 404 that blanks the element on hover, which is worse than not animating the swap.
  const unresolved = await emitInteractions([trigger], sceneNodes)
  assert.doesNotMatch(unresolved.css, /path-to-image/)
  assert.doesNotMatch(unresolved.css, /background:/)
})

test('IR_OWNED_CSS boundary: structural layout stays excluded, box-model/typography do not', async () => {
  const trigger = container('b:1', 'Card', [], {
    interactions: [{ trigger: 'ON_HOVER', destinationId: 'b:2', durationMs: 150, timingFunction: 'linear' }],
  })
  const sceneNodes = new Map<string, DjangoNodeSource>([
    ['b:1', liveNode('Card', 'FRAME', { display: 'flex', position: 'static', 'font-weight': '400', margin: '0px' })],
    ['b:2', liveNode('Card', 'FRAME', { display: 'grid', position: 'absolute', 'font-weight': '700', margin: '4px' })],
  ])

  const result = await emitInteractions([trigger], sceneNodes)

  assert.match(result.css, /font-weight: 700;/)
  assert.match(result.css, /margin: 4px;/)
  assert.doesNotMatch(result.css, /display: grid;/)
  assert.doesNotMatch(result.css, /position: absolute;/)
})

test('a descendant present only in the destination variant (a reveal badge) is hidden at rest and revealed on hover', async () => {
  const trigger = container('r:1', 'Toggle', [container('r:1-badge', 'Badge', [])], {
    interactions: [{ trigger: 'ON_HOVER', destinationId: 'r:2', durationMs: 100, timingFunction: 'ease' }],
  })
  const sceneNodes = new Map<string, DjangoNodeSource>([
    ['r:1', liveNode('Toggle', 'FRAME', {}, [])],
    ['r:2', liveNode('Toggle', 'FRAME', {}, [liveNode('Badge', 'VECTOR', {})])],
  ])

  const result = await emitInteractions([trigger], sceneNodes)

  assert.match(result.css, /\.nr-1 \.nr-1-badge \{\n {2}opacity: 0;\n {2}visibility: hidden;\n {2}pointer-events: none;\n\}/)
  assert.match(result.css, /\.nr-1:hover \.nr-1-badge \{\n {2}opacity: 1;\n {2}visibility: visible;\n {2}pointer-events: auto;\n\}/)
  assert.match(result.css, /visibility 100ms ease allow-discrete/)
})

test('a descendant present only in the source variant (a hide-on-hover icon) fades out with pointer-events: none', async () => {
  const trigger = container('h:1', 'Toggle', [container('h:1-icon', 'Icon', [])], {
    interactions: [{ trigger: 'ON_PRESS', destinationId: 'h:2', durationMs: 120, timingFunction: 'ease' }],
  })
  const sceneNodes = new Map<string, DjangoNodeSource>([
    ['h:1', liveNode('Toggle', 'FRAME', {}, [liveNode('Icon', 'VECTOR', {})])],
    ['h:2', liveNode('Toggle', 'FRAME', {}, [])],
  ])

  const result = await emitInteractions([trigger], sceneNodes)

  assert.match(result.css, /\.nh-1:active \.nh-1-icon \{\n {2}opacity: 0;\n {2}visibility: hidden;\n {2}pointer-events: none;\n\}/)
  assert.doesNotMatch(result.css, /\.nh-1 \.nh-1-icon \{\n {2}opacity: 0;/) // no unconditional "hidden at rest" — it starts visible
})

test('AFTER_TIMEOUT emits a real setTimeout opener, not a click listener', async () => {
  const overlay: IrOverlay = {
    trigger: 'AFTER_TIMEOUT',
    triggerTimeoutMs: 1500,
    destinationId: 'ov:1',
    positionType: 'CENTER',
    background: { type: 'NONE' },
    closeInteraction: 'NONE',
  }
  const trigger = container('t:1', 'Toast', [], { overlays: [overlay] })
  const sceneNodes = new Map<string, DjangoNodeSource>([['ov:1', liveNode('Toast', 'FRAME', {})]])

  const result = await emitInteractions([trigger], sceneNodes)

  assert.match(result.js, /setTimeout\(\(\) => \{[\s\S]*showModal[\s\S]*\}, 1500\)/)
  assert.doesNotMatch(result.js, /addEventListener\('click'/)
})

test('ON_KEY_DOWN filters by the reaction\'s own keyCodes', async () => {
  const overlay: IrOverlay = {
    trigger: 'ON_KEY_DOWN',
    triggerKeyCodes: [27],
    destinationId: 'ov:1',
    positionType: 'CENTER',
    background: { type: 'NONE' },
    closeInteraction: 'NONE',
  }
  const trigger = container('k:1', 'Panel', [], { overlays: [overlay] })
  const sceneNodes = new Map<string, DjangoNodeSource>([['ov:1', liveNode('Panel', 'FRAME', {})]])

  const result = await emitInteractions([trigger], sceneNodes)

  assert.match(result.js, /addEventListener\('keydown'/)
  assert.match(result.js, /\[27\]\.length && !\[27\]\.includes\(e\.keyCode\)/)
})

test('the plain <dialog> path gets an open/close animation honoring the reaction transition, guarded by prefers-reduced-motion', async () => {
  const overlay: IrOverlay = {
    trigger: 'ON_CLICK',
    destinationId: 'ov:1',
    positionType: 'TOP_RIGHT',
    background: { type: 'NONE' },
    closeInteraction: 'NONE',
    transition: { style: 'DISSOLVE', durationMs: 300, timingFunction: 'ease-out' },
  }
  const trigger = container('d:1', 'Panel', [], { overlays: [overlay] })
  const sceneNodes = new Map<string, DjangoNodeSource>([['ov:1', liveNode('Panel', 'FRAME', {})]])

  const result = await emitInteractions([trigger], sceneNodes)

  assert.match(result.css, /@media \(prefers-reduced-motion: no-preference\) \{/)
  assert.match(result.css, /transition: opacity 300ms ease-out, transform 300ms ease-out, overlay 300ms allow-discrete, display 300ms allow-discrete;/)
  assert.match(result.css, /@starting-style/)
  assert.match(result.overlayDialogs.get('d:1')![0], /position: fixed; margin: 0; top: 0; right: 0; left: auto;/)
})

test('renderOverlayBody fills the plain <dialog> body; absent callback keeps the legacy empty shell', async () => {
  const overlay: IrOverlay = {
    trigger: 'ON_CLICK',
    destinationId: 'ov:1',
    positionType: 'CENTER',
    background: { type: 'NONE' },
    closeInteraction: 'NONE',
  }
  const trigger = container('body:1', 'Panel', [], { overlays: [overlay] })
  const sceneNodes = new Map<string, DjangoNodeSource>([['ov:1', liveNode('Panel', 'FRAME', {})]])

  const withBody = await emitInteractions([trigger], sceneNodes, {
    renderOverlayBody: (id) => (id === 'ov:1' ? '<p>hello</p>' : undefined),
  })
  assert.match(withBody.overlayDialogs.get('body:1')![0], /<dialog[^>]*><p>hello<\/p><\/dialog>/)

  const legacy = await emitInteractions([trigger], sceneNodes)
  assert.match(legacy.overlayDialogs.get('body:1')![0], /<dialog[^>]*><\/dialog>/)
})

test('BACK/CLOSE/SCROLL_TO each wire their own click listener', async () => {
  const back = container('back:1', 'Back', [], { back: true })
  const close = container('close:1', 'Close', [], { closeDialog: true })
  const scroll = container('scroll:1', 'ScrollLink', [], { scrollTo: { destinationId: 'anchor:1' } })

  const result = await emitInteractions([back, close, scroll], new Map())

  assert.match(result.js, /nback-1[\s\S]*history\.back\(\)/)
  assert.match(result.js, /nclose-1[\s\S]*el\.closest\('dialog'\)/)
  assert.match(result.js, /nscroll-1[\s\S]*querySelector\('\.nanchor-1'\)[\s\S]*scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/)
})

test('collectReactionDestinationIds still walks interactions/overlays only (NAVIGATE stays excluded)', () => {
  const node = container('n:1', 'Node', [], {
    interactions: [{ trigger: 'ON_HOVER', destinationId: 'v:1', durationMs: 0, timingFunction: 'linear' }],
    overlays: [
      {
        trigger: 'ON_CLICK',
        destinationId: 'o:1',
        positionType: 'CENTER',
        background: { type: 'NONE' },
        closeInteraction: 'NONE',
      },
    ],
    navigate: { destinationId: 'page:1' },
  })
  const ids = collectReactionDestinationIds([node])
  assert.deepEqual([...ids].sort(), ['o:1', 'v:1'])
})
