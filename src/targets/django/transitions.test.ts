import test from 'node:test'
import assert from 'node:assert/strict'
import type { IrContainerNode, IrInstanceRefNode, IrNode } from './ir.ts'
import { collectNavEdges, emitPageTransitions, directionTransforms } from './transitions.ts'

function makeBase() {
  return {
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' as const }, height: { mode: 'hug' as const } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
  }
}

function container(id: string, name: string, children: IrNode[] = [], extra: Partial<IrContainerNode> = {}): IrContainerNode {
  return { ...makeBase(), id, name, type: 'container', layout: { kind: 'absolute' }, component: null, children, ...extra } as IrContainerNode
}

function instanceRef(id: string, name: string, componentId: string): IrInstanceRefNode {
  return {
    ...makeBase(),
    id,
    name,
    type: 'instance-ref',
    layout: { kind: 'absolute' },
    componentId,
    componentKey: 'k',
    componentSetName: null,
    componentProperties: {},
    children: [],
  } as unknown as IrInstanceRefNode
}

const SMART = { style: 'SMART_ANIMATE' as const, durationMs: 400, timingFunction: 'ease' }
const PUSH_LEFT = { style: 'PUSH' as const, direction: 'LEFT' as const, durationMs: 250, timingFunction: 'ease-out' }

test('collectNavEdges finds NAVIGATE edges between rendered page roots only, deduped', () => {
  const btn = container('1:5', 'Button', [], { navigate: { destinationId: 'p:2', transition: SMART } })
  const btn2 = container('1:6', 'Off-page', [], { navigate: { destinationId: 'p:404' } })
  const pageA = container('p:1', 'Home', [btn, btn2])
  const pageB = container('p:2', 'Settings')
  const pageRootIds = new Set(['p:1', 'p:2'])

  const edges = collectNavEdges([pageA, pageB], pageRootIds)
  assert.equal(edges.length, 1)
  assert.deepEqual(edges[0], { sourcePageId: 'p:1', destPageId: 'p:2', transition: SMART })
})

test('no NAVIGATE edges between pages → no output at all', () => {
  const pageA = container('p:1', 'Home')
  const pageB = container('p:2', 'Settings')
  const result = emitPageTransitions({ nodes: [pageA, pageB], pageRootIds: new Set(['p:1', 'p:2']) })
  assert.deepEqual(result, { css: '', js: '' })
})

test('any NAVIGATE edge (even unanimated) opts in via @view-transition; reduced-motion guard is always present', () => {
  const btn = container('1:1', 'Button', [], { navigate: { destinationId: 'p:2' } })
  const pageA = container('p:1', 'Home', [btn])
  const pageB = container('p:2', 'Settings')
  const result = emitPageTransitions({ nodes: [pageA, pageB], pageRootIds: new Set(['p:1', 'p:2']) })

  assert.match(result.css, /@view-transition \{\n {2}navigation: auto;\n\}/)
  assert.match(result.css, /@media \(prefers-reduced-motion: reduce\) \{/)
  assert.match(result.css, /animation: none !important;/)
  // No transition was captured on the edge — no duration override, no keyframes.
  assert.doesNotMatch(result.css, /animation-duration/)
  assert.doesNotMatch(result.css, /@keyframes/)
})

test('PUSH LEFT emits directional keyframes on both the incoming and outgoing root snapshots', () => {
  const btn = container('1:1', 'Button', [], { navigate: { destinationId: 'p:2', transition: PUSH_LEFT } })
  const pageA = container('p:1', 'Home', [btn])
  const pageB = container('p:2', 'Settings')
  const result = emitPageTransitions({ nodes: [pageA, pageB], pageRootIds: new Set(['p:1', 'p:2']) })

  assert.match(result.css, /@keyframes pgvt-enter \{\n {2}from \{ transform: translateX\(-100%\); \}/)
  assert.match(result.css, /::view-transition-new\(root\) \{\n {2}animation-name: pgvt-enter;\n\}/)
  // PUSH moves BOTH screens: the new one enters, the old one is pushed away in the same direction.
  assert.match(result.css, /@keyframes pgvt-exit \{\n {2}from \{ transform: none; \}\n {2}to \{ transform: translateX\(100%\); \}/)
  assert.match(result.css, /::view-transition-old\(root\) \{\n {2}animation-name: pgvt-exit;\n\}/)
  assert.match(result.css, /animation-duration: 250ms;/)
  assert.match(result.css, /animation-timing-function: ease-out;/)
})

test('directionTransforms: PUSH also exits the old root; MOVE_OUT/SLIDE_OUT never enters', () => {
  assert.deepEqual(directionTransforms('PUSH', 'LEFT'), { newFrom: 'translateX(-100%)', oldTo: 'translateX(100%)' })
  assert.deepEqual(directionTransforms('MOVE_OUT', 'RIGHT'), { newFrom: 'none', oldTo: 'translateX(-100%)' })
})

test('mixed directional styles across edges degrade to the default cross-fade (no keyframes)', () => {
  const toB = container('1:1', 'To B', [], { navigate: { destinationId: 'p:2', transition: PUSH_LEFT } })
  const toC = container('1:2', 'To C', [], { navigate: { destinationId: 'p:3', transition: { ...PUSH_LEFT, direction: 'RIGHT' } } })
  const pageA = container('p:1', 'Home', [toB, toC])
  const pageB = container('p:2', 'B')
  const pageC = container('p:3', 'C')
  const result = emitPageTransitions({ nodes: [pageA, pageB, pageC], pageRootIds: new Set(['p:1', 'p:2', 'p:3']) })

  assert.doesNotMatch(result.css, /@keyframes/)
  assert.match(result.css, /animation-duration: 250ms;/) // timing override still applies
})

test('SMART_ANIMATE assigns a shared view-transition-name keyed by .n<node id>, never a slugified layer name', () => {
  const heroA = container('h:1', 'Hero Image')
  const heroB = container('h:2', 'Hero Image')
  const pageA = container('p:1', 'Home', [container('1:1', 'Go', [], { navigate: { destinationId: 'p:2', transition: SMART } }), heroA])
  const pageB = container('p:2', 'Detail', [heroB])
  const result = emitPageTransitions({ nodes: [pageA, pageB], pageRootIds: new Set(['p:1', 'p:2']) })

  assert.match(result.css, /\.nh-1, \.nh-2 \{ view-transition-name: nh-1; \}/)
  assert.doesNotMatch(result.css, /hero-image/) // no slug of the layer name anywhere
})

test('SMART_ANIMATE: a componentId occurring more than once on either page is excluded (ambiguous view-transition-name)', () => {
  const cardA1 = instanceRef('inst:a1', 'Card', 'comp:card')
  const cardA2 = instanceRef('inst:a2', 'Card', 'comp:card')
  const cardB = instanceRef('inst:b1', 'Card', 'comp:card')
  const pageA = container('p:1', 'List', [
    container('1:1', 'Go', [], { navigate: { destinationId: 'p:2', transition: SMART } }),
    cardA1,
    cardA2,
  ])
  const pageB = container('p:2', 'Detail', [cardB])
  const result = emitPageTransitions({ nodes: [pageA, pageB], pageRootIds: new Set(['p:1', 'p:2']) })

  assert.doesNotMatch(result.css, /view-transition-name/)
})

test('SMART_ANIMATE: an instance-ref is keyed by its componentId, not its own instance id', () => {
  const logoA = instanceRef('inst:a', 'Logo', 'comp:logo')
  const logoB = instanceRef('inst:b', 'Logo', 'comp:logo')
  const pageA = container('p:1', 'Home', [container('1:1', 'Go', [], { navigate: { destinationId: 'p:2', transition: SMART } }), logoA])
  const pageB = container('p:2', 'Detail', [logoB])
  const result = emitPageTransitions({ nodes: [pageA, pageB], pageRootIds: new Set(['p:1', 'p:2']) })

  assert.match(result.css, /\.ncomp-logo \{ view-transition-name: ncomp-logo; \}/)
})

test('js is empty — cross-document view transitions need no progressive-enhancement script', () => {
  const btn = container('1:1', 'Button', [], { navigate: { destinationId: 'p:2', transition: SMART } })
  const pageA = container('p:1', 'Home', [btn])
  const pageB = container('p:2', 'Settings')
  const result = emitPageTransitions({ nodes: [pageA, pageB], pageRootIds: new Set(['p:1', 'p:2']) })
  assert.equal(result.js, '')
})
