import test from 'node:test'
import assert from 'node:assert/strict'
import { emitCss, type DjangoNodeSource, type EmitterNote } from './css-emitter.ts'
import { summarizeEmitterNotes } from './export/report.ts'
import type { IrContainerNode, IrNode } from './ir.ts'
import { apply3dDeclarations, type Transform3dNote, type Transform3dSource } from './transform3d.ts'

/**
 * 3D transforms in static CSS (@figma/plugin-typings 1.143.0, beta). The sources here are plain
 * objects holding what Figma holds; whether `getCSSAsync` writes any of this itself is not
 * something these tests can know, so they also cover the case where it does.
 */

const fixed = (over: Partial<{ translateZ: number; rotateX: number; rotateY: number; rotateZ: number; backfaceVisible: boolean; visible: boolean }> = {}) =>
  ({ type: 'FIXED_ORDER', translateZ: 0, rotateX: 0, rotateY: 0, rotateZ: 0, ...over }) as Transform3d

const declarations = (source: Transform3dSource, decl: Record<string, string> = {}) => {
  const notes: Transform3dNote[] = []
  apply3dDeclarations(decl, source, '1:1', notes)
  return { decl, notes }
}

/* ---------------------------------------------------------------- the pose */

test('a FIXED_ORDER transform is the four functions, all four, in Figma’s order', () => {
  const { decl, notes } = declarations({ transform3d: fixed({ translateZ: 40, rotateX: 10, rotateY: 30, rotateZ: 5 }) })
  assert.deepEqual(decl, { transform: 'translateZ(40px) rotateX(10deg) rotateY(30deg) rotateZ(5deg)' })
  assert.deepEqual(notes, [])
})

test('the numbers Figma hands back in single precision are written as the numbers that were set', () => {
  // Read live: 10 comes back as 9.99999970909292, 30 as 30.000000834826057.
  const { decl } = declarations({ transform3d: fixed({ rotateX: 9.99999970909292, rotateY: 30.000000834826057 }) })
  assert.equal(decl.transform, 'translateZ(0px) rotateX(10deg) rotateY(30deg) rotateZ(0deg)')
})

test('no transform, a transform switched off, and no source at all write nothing', () => {
  assert.deepEqual(declarations({ transform3d: { type: 'NONE' } }).decl, {})
  assert.deepEqual(declarations({ transform3d: fixed({ rotateY: 45, backfaceVisible: false, visible: false }) }).decl, {})
  assert.deepEqual(declarations({}).decl, {})
  const untouched = { opacity: '0.5' }
  apply3dDeclarations(untouched, undefined, '1:1')
  assert.deepEqual(untouched, { opacity: '0.5' })
})

test('a hidden backface is said, a shown one is the CSS default and is not', () => {
  assert.equal(declarations({ transform3d: fixed({ rotateY: 180, backfaceVisible: false }) }).decl['backface-visibility'], 'hidden')
  assert.equal(declarations({ transform3d: fixed({ rotateY: 180, backfaceVisible: true }) }).decl['backface-visibility'], undefined)
  assert.equal(declarations({ transform3d: fixed({ rotateY: 180 }) }).decl['backface-visibility'], undefined)
})

test('an imported FREEFORM transform is not guessed at: nothing is written and a note says so', () => {
  const { decl, notes } = declarations({ transform3d: { type: 'FREEFORM', backfaceVisible: false } })
  assert.deepEqual(decl, {})
  assert.deepEqual(notes, [{ type: 'transform3d-freeform', node: '1:1' }])
  // Switched off, it is not drawn in Figma either — nothing to report.
  assert.deepEqual(declarations({ transform3d: { type: 'FREEFORM', backfaceVisible: true, visible: false } }).notes, [])
})

/* --------------------------------------------------------------- the origin */

test('an origin is written in its own units, and the centre — CSS’s default too — is left unsaid', () => {
  const door = declarations({
    transform3d: fixed({ rotateY: 45 }),
    transformOrigin: { x: { unit: 'PIXELS', value: 0 }, y: { unit: 'PERCENT', value: 50 } },
  })
  assert.equal(door.decl['transform-origin'], '0px 50%')

  const centred = declarations({
    transform3d: fixed({ rotateY: 45 }),
    transformOrigin: { x: { unit: 'PERCENT', value: 50 }, y: { unit: 'PERCENT', value: 50 } },
  })
  assert.equal(centred.decl['transform-origin'], undefined)
})

test('an origin without a transform is not written — it is the pivot of something that is not there', () => {
  const { decl } = declarations({ transformOrigin: { x: { unit: 'PIXELS', value: 0 }, y: { unit: 'PIXELS', value: 0 } } })
  assert.deepEqual(decl, {})
})

/* ------------------------------------------------------ beside the 2D path */

test('a layer already turned in 2D keeps its transform and its top-left origin; the 3D pivot is baked in', () => {
  const { decl, notes } = declarations({ transform3d: fixed({ rotateY: 60 }) }, { transform: 'rotate(-30deg)', 'transform-origin': '0 0' })
  assert.equal(decl['transform-origin'], '0 0')
  assert.equal(decl.transform, 'rotate(-30deg) translate(50%, 50%) translateZ(0px) rotateX(0deg) rotateY(60deg) rotateZ(0deg) translate(-50%, -50%)')
  assert.deepEqual(notes, [{ type: 'transform3d-with-2d', node: '1:1' }])
})

test('with the 3D origin at the top-left as well, there is no pivot to bake', () => {
  const { decl } = declarations(
    { transform3d: fixed({ rotateX: 20 }), transformOrigin: { x: { unit: 'PIXELS', value: 0 }, y: { unit: 'PERCENT', value: 0 } } },
    { transform: 'rotate(15deg)', 'transform-origin': '0 0' }
  )
  assert.equal(decl.transform, 'rotate(15deg) translateZ(0px) rotateX(20deg) rotateY(0deg) rotateZ(0deg)')
})

test('a turned image fill stays innermost and keeps turning about the centre', () => {
  const centred = declarations({ transform3d: fixed({ rotateY: 30 }) }, { transform: 'rotate(90deg)' })
  assert.equal(centred.decl.transform, 'translateZ(0px) rotateX(0deg) rotateY(30deg) rotateZ(0deg) rotate(90deg)')
  assert.equal(centred.decl['transform-origin'], undefined)
  assert.deepEqual(centred.notes, [])

  // A hinge on the left edge: half the layer's width back from the centre.
  const hinged = declarations(
    { transform3d: fixed({ rotateY: 30 }), transformOrigin: { x: { unit: 'PIXELS', value: 0 }, y: { unit: 'PERCENT', value: 50 } } },
    { transform: 'rotate(90deg)' }
  )
  assert.equal(hinged.decl.transform, 'translate(-50%, 0%) translateZ(0px) rotateX(0deg) rotateY(30deg) rotateZ(0deg) translate(50%, 0%) rotate(90deg)')

  // Twelve pixels in from the left: pixels against a percentage, so the offset is a calc().
  const inset = declarations(
    { transform3d: fixed({ rotateY: 30 }), transformOrigin: { x: { unit: 'PIXELS', value: 12 }, y: { unit: 'PERCENT', value: 25 } } },
    { transform: 'rotate(90deg)' }
  )
  assert.equal(
    inset.decl.transform,
    'translate(calc(12px - 50%), -25%) translateZ(0px) rotateX(0deg) rotateY(30deg) rotateZ(0deg) translate(calc(50% - 12px), 25%) rotate(90deg)'
  )
})

test('3D functions a CSS generator wrote for the same transform are not written twice', () => {
  const only3d = declarations({ transform3d: fixed({ rotateY: 30 }) }, { transform: 'rotateY(30deg)', 'transform-origin': '0 0' })
  assert.deepEqual(only3d.decl, { transform: 'translateZ(0px) rotateX(0deg) rotateY(30deg) rotateZ(0deg)' })

  const mixed = declarations({ transform3d: fixed({ rotateY: 30 }) }, { transform: 'rotate(10deg) rotateY(30deg)', 'transform-origin': '0 0' })
  assert.equal(mixed.decl.transform, 'rotate(10deg) translate(50%, 50%) translateZ(0px) rotateX(0deg) rotateY(30deg) rotateZ(0deg) translate(-50%, -50%)')
})

/* ---------------------------------------------------------------- the scene */

test('a scene is perspective and preserve-3d, each only when it is on', () => {
  assert.deepEqual(declarations({ scene3d: { perspective: 800, preserve3d: true } }).decl, { perspective: '800px', 'transform-style': 'preserve-3d' })
  assert.deepEqual(declarations({ scene3d: { perspective: 800, preserve3d: false } }).decl, { perspective: '800px' })
  // Negative is Figma's "no perspective"; zero is a real (if extreme) one.
  assert.deepEqual(declarations({ scene3d: { perspective: -1, preserve3d: true } }).decl, { 'transform-style': 'preserve-3d' })
  assert.deepEqual(declarations({ scene3d: { perspective: 0, preserve3d: false } }).decl, { perspective: '0px' })
  assert.deepEqual(declarations({ scene3d: null }).decl, {})
})

test('a scene switched off keeps preserve-3d, which Figma applies independently', () => {
  assert.deepEqual(declarations({ scene3d: { perspective: 800, preserve3d: true, visible: false } }).decl, { 'transform-style': 'preserve-3d' })
  assert.deepEqual(declarations({ scene3d: { perspective: 800, preserve3d: false, visible: false } }).decl, {})
})

test('what Figma does not render on a preserve3d container is left out, and each one is named', () => {
  const { decl, notes } = declarations(
    { scene3d: { perspective: 800, preserve3d: true } },
    {
      opacity: '0.5',
      'mix-blend-mode': 'multiply',
      'box-shadow': '0 4px 8px rgba(0, 0, 0, 0.25)',
      filter: 'blur(2px)',
      'backdrop-filter': 'blur(4px)',
      '-webkit-backdrop-filter': 'blur(4px)',
      overflow: 'hidden',
      background: '#fff',
    }
  )
  assert.deepEqual(decl, { background: '#fff', perspective: '800px', 'transform-style': 'preserve-3d' })
  assert.deepEqual(
    notes.map((note) => (note.type === 'preserve3d-not-rendered' ? note.property : note.type)),
    ['opacity', 'mix-blend-mode', 'box-shadow', 'filter', 'backdrop-filter', 'overflow']
  )
})

test('a flat scene keeps all of it, and a scrolling preserve3d frame keeps its scroll', () => {
  const flat = declarations({ scene3d: { perspective: 800, preserve3d: false } }, { opacity: '0.5', overflow: 'hidden' })
  assert.deepEqual(flat.decl, { opacity: '0.5', overflow: 'hidden', perspective: '800px' })
  assert.deepEqual(flat.notes, [])
  const scrolling = declarations({ scene3d: { perspective: -1, preserve3d: true } }, { overflow: 'auto' })
  assert.equal(scrolling.decl.overflow, 'auto')
})

/* ------------------------------------------------------- through the emitter */

function makeBase() {
  return {
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' as const }, height: { mode: 'hug' as const } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
  }
}

const container = (id: string, children: IrNode[] = [], layout: IrContainerNode['layout'] = { kind: 'absolute' }): IrContainerNode => ({
  ...makeBase(),
  id,
  name: id,
  type: 'container',
  layout,
  children,
})

const source = (css: Record<string, string>, extra: Partial<DjangoNodeSource> = {}): DjangoNodeSource => ({ getCSSAsync: async () => css, ...extra })

const ruleFor = (css: string, className: string): string => new RegExp(`\\.${className} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''

test('emitCss writes a scene on the container and the pose on the child, beside what the 2D pass produced', async () => {
  const tree = container('1:1', [container('1:2'), container('1:3')])
  const notes: EmitterNote[] = []
  const css = await emitCss(
    [tree],
    new Map([
      ['1:1', source({ background: '#fff', opacity: '0.5' }, { scene3d: { perspective: 800, preserve3d: true } })],
      ['1:2', source({ background: '#f00' }, { transform3d: fixed({ translateZ: 40, rotateY: 30, backfaceVisible: false }) })],
      // Already rotated in 2D: `getCSSAsync` gives the rotate, the emitter pins the origin.
      ['1:3', source({ transform: 'rotate(-15deg)' }, { transform3d: fixed({ rotateX: 20 }) })],
    ]),
    new Map(),
    { preamble: false, notes }
  )

  const scene = ruleFor(css, 'n1-1')
  assert.match(scene, /perspective: 800px;/)
  assert.match(scene, /transform-style: preserve-3d;/)
  assert.doesNotMatch(scene, /opacity/)
  assert.match(scene, /background: #fff;/)

  const card = ruleFor(css, 'n1-2')
  assert.match(card, /transform: translateZ\(40px\) rotateX\(0deg\) rotateY\(30deg\) rotateZ\(0deg\);/)
  assert.match(card, /backface-visibility: hidden;/)
  assert.doesNotMatch(card, /transform-origin/)

  const turned = ruleFor(css, 'n1-3')
  assert.match(turned, /transform: rotate\(-15deg\) translate\(50%, 50%\) translateZ\(0px\) rotateX\(20deg\) rotateY\(0deg\) rotateZ\(0deg\) translate\(-50%, -50%\);/)
  assert.match(turned, /transform-origin: 0 0;/)

  assert.deepEqual(notes, [
    { type: 'preserve3d-not-rendered', node: '1:1', property: 'opacity' },
    { type: 'transform3d-with-2d', node: '1:3' },
  ])
})

test('a clipping preserve3d frame loses the clip the layout pass gave it', async () => {
  const clipped = container('2:1', [], { kind: 'absolute', clip: true } as IrContainerNode['layout'])
  const css = await emitCss([clipped], new Map([['2:1', source({}, { scene3d: { perspective: -1, preserve3d: true } })]]), new Map(), { preamble: false })
  assert.doesNotMatch(ruleFor(css, 'n2-1'), /overflow/)
  // The same frame without the scene still clips — the pass above is what removed it.
  const plain = await emitCss([clipped], new Map([['2:1', source({})]]), new Map(), { preamble: false })
  assert.match(ruleFor(plain, 'n2-1'), /overflow: hidden;/)
})

test('a node without any of it emits exactly what it did before', async () => {
  const tree = container('3:1')
  const before = await emitCss([tree], new Map([['3:1', source({ transform: 'rotate(10deg)', opacity: '0.4' })]]), new Map(), { preamble: false })
  const after = await emitCss(
    [tree],
    new Map([['3:1', source({ transform: 'rotate(10deg)', opacity: '0.4' }, { transform3d: { type: 'NONE' }, scene3d: null })]]),
    new Map(),
    { preamble: false }
  )
  assert.equal(after, before)
  assert.match(before, /transform: rotate\(10deg\);/)
  assert.match(before, /transform-origin: 0 0;/)
})

test('the export report groups the 3D notes by what was done about each', () => {
  const summary = summarizeEmitterNotes([
    { type: 'transform3d-freeform', node: '4:2' },
    { type: 'transform3d-with-2d', node: '4:3' },
    { type: 'preserve3d-not-rendered', node: '4:1', property: 'opacity' },
    { type: 'preserve3d-not-rendered', node: '4:4', property: 'opacity' },
    { type: 'preserve3d-not-rendered', node: '4:1', property: 'overflow' },
  ])
  assert.deepEqual(summary, {
    'transform3d-freeform': { 'exported-flat': ['4:2'] },
    'transform3d-with-2d': { 'composed-2d-outside': ['4:3'] },
    'preserve3d-not-rendered': { opacity: ['4:1', '4:4'], overflow: ['4:1'] },
  })
})
