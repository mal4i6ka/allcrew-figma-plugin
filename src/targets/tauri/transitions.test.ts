import test from 'node:test'
import assert from 'node:assert/strict'
import type { IrContainerNode, IrNode } from '../django/ir.ts'
import { collectNavEdges, emitViewTransitionsCss } from './transitions.ts'

function container(id: string, name: string, children: IrNode[] = [], extra: Partial<IrContainerNode> = {}): IrContainerNode {
  return {
    id,
    name,
    type: 'container',
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'fixed', px: 100 }, height: { mode: 'fixed', px: 100 } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
    children,
    layout: { mode: 'none' },
    component: null,
    ...extra,
  } as unknown as IrContainerNode
}

const SMART = { style: 'SMART_ANIMATE' as const, durationMs: 300, timingFunction: 'ease-out' }

test('collectNavEdges finds NAVIGATE edges to exported pages only, deduped', () => {
  const btn = container('1:5', 'Button', [], { navigate: { destinationId: 'p:2', transition: SMART } })
  const btn2 = container('1:6', 'Button 2', [], { navigate: { destinationId: 'p:404' } })
  const pageA = container('p:1', 'Home', [btn, btn2])
  const pageB = container('p:2', 'Settings')
  const edges = collectNavEdges([pageA, pageB])
  assert.equal(edges.length, 1)
  assert.deepEqual(edges[0], { sourcePageId: 'p:1', destPageId: 'p:2', transition: SMART })
})

test('no animated edges → empty stylesheet', () => {
  const btn = container('1:5', 'B', [], { navigate: { destinationId: 'p:2' } })
  const pageA = container('p:1', 'Home', [btn])
  const pageB = container('p:2', 'Settings')
  const edges = collectNavEdges([pageA, pageB])
  assert.equal(emitViewTransitionsCss({ pages: [pageA, pageB], edges }), '')
})

test('smart-animate edge emits opt-in, slowest timing, and name-matched morph layers', () => {
  const heroA = container('1:10', 'Hero')
  const heroB = container('2:10', 'Hero')
  const onlyA = container('1:11', 'Only Here')
  const btn = container('1:5', 'Go', [], { navigate: { destinationId: 'p:2', transition: SMART } })
  const pageA = container('p:1', 'Home', [heroA, onlyA, btn])
  const pageB = container('p:2', 'Settings', [heroB])
  const css = emitViewTransitionsCss({ pages: [pageA, pageB], edges: collectNavEdges([pageA, pageB]) })

  assert.ok(css.includes('@view-transition'))
  assert.ok(css.includes('navigation: auto;'))
  assert.ok(css.includes('animation-duration: 300ms;'))
  assert.ok(css.includes('animation-timing-function: ease-out;'))
  assert.ok(css.includes('.n1-10, .n2-10 { view-transition-name: hero; }'))
  assert.ok(!css.includes('only-here'))
  // The clicked button itself has no counterpart — no name assignment.
  assert.ok(!css.includes('view-transition-name: go;'))
})

test('uniform PUSH edges emit directional root keyframes', () => {
  const push = { style: 'PUSH' as const, direction: 'LEFT' as const, durationMs: 250, timingFunction: 'linear' }
  const btn = container('1:5', 'Go', [], { navigate: { destinationId: 'p:2', transition: push } })
  const pageA = container('p:1', 'Home', [btn])
  const pageB = container('p:2', 'Settings')
  const css = emitViewTransitionsCss({ pages: [pageA, pageB], edges: collectNavEdges([pageA, pageB]) })

  assert.ok(css.includes('@keyframes tauri-vt-enter'))
  assert.ok(css.includes('from { transform: translateX(-100%); }'))
  assert.ok(css.includes('@keyframes tauri-vt-exit'))
  assert.ok(css.includes('to { transform: translateX(100%); }'))
})

test('mixed directional styles degrade to cross-fade (no keyframes)', () => {
  const pushBtn = container('1:5', 'Go', [], {
    navigate: { destinationId: 'p:2', transition: { style: 'PUSH' as const, direction: 'LEFT' as const, durationMs: 250, timingFunction: 'linear' } },
  })
  const moveBtn = container('2:5', 'Back', [], {
    navigate: { destinationId: 'p:1', transition: { style: 'MOVE_IN' as const, direction: 'RIGHT' as const, durationMs: 200, timingFunction: 'ease' } },
  })
  const pageA = container('p:1', 'Home', [pushBtn])
  const pageB = container('p:2', 'Settings', [moveBtn])
  const css = emitViewTransitionsCss({ pages: [pageA, pageB], edges: collectNavEdges([pageA, pageB]) })

  assert.ok(css.includes('@view-transition'))
  assert.ok(!css.includes('@keyframes'))
  // Slowest edge wins the root timing.
  assert.ok(css.includes('animation-duration: 250ms;'))
})

test('instance-refs morph via their component master class; duplicated components are excluded', () => {
  function instance(id: string, name: string, componentId: string, extra: object = {}): IrNode {
    return {
      ...container(id, name),
      type: 'instance-ref',
      componentId,
      componentKey: `key-${componentId}`,
      componentProperties: {},
      ...extra,
    } as unknown as IrNode
  }
  const go = container('1:5', 'Go', [], { navigate: { destinationId: 'p:2', transition: SMART } })
  // "Card" exists on both pages as an instance of component c:1 → matched via .n<c:1> class.
  // "Chip" appears TWICE on page B → its component class would collide → excluded.
  const pageA = container('p:1', 'Home', [instance('1:10', 'Card', 'c:1'), instance('1:12', 'Chip', 'c:2'), go])
  const pageB = container('p:2', 'Settings', [
    instance('2:10', 'Card', 'c:1'),
    instance('2:12', 'Chip', 'c:2'),
    instance('2:13', 'Chip Copy', 'c:2'),
  ])
  const css = emitViewTransitionsCss({ pages: [pageA, pageB], edges: collectNavEdges([pageA, pageB]) })

  assert.ok(css.includes('.nc-1 { view-transition-name: card; }'))
  assert.ok(!css.includes('nc-2'))
})

test('duplicate layer names within one page participate once', () => {
  const twinA1 = container('1:20', 'Twin')
  const twinA2 = container('1:21', 'Twin')
  const twinB = container('2:20', 'Twin')
  const btn = container('1:5', 'Go', [], { navigate: { destinationId: 'p:2', transition: SMART } })
  const pageA = container('p:1', 'Home', [twinA1, twinA2, btn])
  const pageB = container('p:2', 'Settings', [twinB])
  const css = emitViewTransitionsCss({ pages: [pageA, pageB], edges: collectNavEdges([pageA, pageB]) })

  assert.ok(css.includes('.n1-20, .n2-20 { view-transition-name: twin; }'))
  assert.ok(!css.includes('.n1-21'))
})
