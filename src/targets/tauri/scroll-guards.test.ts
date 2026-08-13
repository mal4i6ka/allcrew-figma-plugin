import test from 'node:test'
import assert from 'node:assert/strict'
import type { IrContainerNode, IrNode } from '../django/ir.ts'
import { emitScrollGuardsCss } from './scroll-guards.ts'

function node(id: string, over: Partial<Record<string, unknown>> = {}): IrContainerNode {
  return {
    id,
    name: id,
    type: 'container',
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' }, height: { mode: 'hug' } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
    children: [],
    layout: { kind: 'absolute' },
    component: null,
    ...over,
  } as unknown as IrContainerNode
}

const column = (children: IrNode[]) => ({ kind: 'flex', direction: 'column', wrap: false, gap: 0, justifyContent: 'flex-start', alignItems: 'flex-start', padding: { top: 0, right: 0, bottom: 0, left: 0 } })

test('fill container in a column gets an overflow-y guard; clipping/hug/leaf children do not', () => {
  const fillList = node('1:10', {
    sizing: { width: { mode: 'fill' }, height: { mode: 'fill' } },
    children: [node('1:11')],
  })
  const clipped = node('1:20', {
    sizing: { width: { mode: 'fill' }, height: { mode: 'fill' } },
    layout: { kind: 'flex', direction: 'column', clip: true },
    children: [node('1:21')],
  })
  const hug = node('1:30', { children: [node('1:31')] })
  const emptyFill = node('1:40', { sizing: { width: { mode: 'hug' }, height: { mode: 'fill' } } })
  const sidebar = node('1:1', {
    layout: column([]),
    children: [fillList, clipped, hug, emptyFill],
  })

  const css = emitScrollGuardsCss([sidebar])
  assert.match(css, /\.n1-10 \{ overflow-y: auto; \}/)
  assert.doesNotMatch(css, /n1-20/)
  assert.doesNotMatch(css, /n1-30/)
  assert.doesNotMatch(css, /n1-40/)
})

test('row layout guards overflow-x on width-fill children; no candidates → empty string', () => {
  const fillRegion = node('2:10', {
    sizing: { width: { mode: 'fill' }, height: { mode: 'hug' } },
    children: [node('2:11')],
  })
  const row = node('2:1', {
    layout: { kind: 'flex', direction: 'row', wrap: false, gap: 0, justifyContent: 'flex-start', alignItems: 'flex-start', padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    children: [fillRegion],
  })
  assert.match(emitScrollGuardsCss([row]), /\.n2-10 \{ overflow-x: auto; \}/)
  assert.equal(emitScrollGuardsCss([node('3:1')]), '')
})
