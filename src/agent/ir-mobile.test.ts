import test from 'node:test'
import assert from 'node:assert/strict'
import { groupTypeStyles, iosContents, measureText, screenSummary, typeStyleOf } from './ir-mobile.ts'
import type { IrNode } from '../targets/django/ir.ts'

/* ------------------------------------------------------------------- type */

const TOKENS = new Map([
  ['VariableID:1', 'font-size/md'],
  ['VariableID:2', 'font-family/inter'],
])

test('a text style comes back with the token behind each value it has one for', () => {
  const style = typeStyleOf(
    {
      id: '1:2',
      name: 'Title',
      characters: 'Send money',
      fontName: { family: 'Inter', style: 'Semi Bold' },
      fontSize: 16,
      fontWeight: 600,
      lineHeight: { unit: 'PIXELS', value: 24 },
      letterSpacing: { unit: 'PERCENT', value: -0.02 },
      textCase: 'ORIGINAL',
      textDecoration: 'NONE',
      boundVariables: {
        fontSize: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' },
        fontFamily: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:2' }],
      },
    },
    TOKENS
  )

  assert.deepEqual(style, {
    family: 'Inter',
    face: 'Semi Bold',
    size: 16,
    weight: 600,
    lineHeight: '24px',
    letterSpacing: '-0.02%',
    // ORIGINAL case and NONE decoration are the defaults — reporting them would be noise in
    // every row of the table.
    tokens: { fontSize: 'font-size/md', fontFamily: 'font-family/inter' },
  })
})

test('a mixed property says so instead of picking one of the values', () => {
  // Figma reports a mixed property as a symbol. Reading the first run and calling it the
  // node's font is how a build ends up setting a whole paragraph in the style of its first
  // three characters.
  const style = typeStyleOf(
    { id: '1:3', name: 'Paragraph', fontName: Symbol('mixed'), fontSize: Symbol('mixed'), lineHeight: Symbol('mixed') },
    TOKENS
  )

  assert.equal(style.family, 'mixed')
  assert.equal(style.size, 0)
  assert.equal(style.lineHeight, 'mixed')
  assert.equal(style.tokens, undefined)
})

test('leading and tracking keep the unit Figma stated them in', () => {
  assert.equal(measureText({ unit: 'PIXELS', value: 24 }), '24px')
  assert.equal(measureText({ unit: 'PERCENT', value: 150 }), '150%')
  assert.equal(measureText({ unit: 'AUTO' }), 'auto')
  assert.equal(measureText(Symbol('mixed')), 'mixed')
})

test('ninety text layers become the handful of styles a build implements', () => {
  const heading = { family: 'Onest', face: 'Semi Bold', size: 26, lineHeight: '32px', letterSpacing: '0px' }
  const body = { family: 'Inter', face: 'Regular', size: 16, lineHeight: '24px', letterSpacing: '0px' }
  const entries = [
    { node: { id: '1:1', name: 'H2', characters: 'Send money quickly and safely' }, style: heading },
    { node: { id: '1:2', name: 'Body', characters: 'Transfers arrive in minutes.' }, style: body },
    { node: { id: '1:3', name: 'Body', characters: 'No hidden fees.' }, style: body },
    { node: { id: '1:4', name: 'Body', characters: 'Track every payment.' }, style: body },
    { node: { id: '1:5', name: 'Body', characters: 'A fifth one.' }, style: body },
  ]

  const table = groupTypeStyles(entries)

  assert.equal(table.length, 2)
  assert.equal(table[0].uses, 4, 'the most used style leads')
  assert.equal(table[0].family, 'Inter')
  assert.deepEqual(
    table[0].nodes.map((node) => node.id),
    ['1:2', '1:3', '1:4'],
    'enough layers to find the style, not every layer that uses it'
  )
  assert.equal(table[0].sample, 'Transfers arrive in minutes.')
})

/* ----------------------------------------------------------------- screen */

function frame(overrides: Record<string, unknown> = {}): IrNode {
  return {
    type: 'container',
    id: '1:0',
    name: 'Screen',
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'fixed', value: 390 }, height: { mode: 'fixed', value: 844 } },
    layout: { kind: 'flex', direction: 'column', clip: true, overflow: 'y' },
    children: [],
    ...overrides,
  } as unknown as IrNode
}

function child(id: string, name: string, y: number, height: number, extra: Record<string, unknown> = {}): IrNode {
  return {
    type: 'container',
    id,
    name,
    position: { x: 0, y },
    sizing: { width: { mode: 'fill' }, height: { mode: 'fixed', value: height } },
    children: [],
    ...extra,
  } as unknown as IrNode
}

test('the system bands report the layers that are there, not an inset', () => {
  // Figma has no safe area at all: a status bar drawn in the frame is a layer like any other,
  // and whether to keep it or inset around the real one is the build's decision. Naming the
  // layers is the honest half; inventing 47pt would not be.
  const screen = screenSummary(
    frame({
      children: [
        child('1:1', 'Status bar', 0, 44),
        child('1:2', 'Content', 60, 700),
        child('1:3', 'Tab bar', 760, 84, { scrollBehavior: 'fixed' }),
      ],
    })
  )

  assert.equal(screen.kind, 'phone')
  assert.deepEqual(screen.systemBands.top.map((node) => node.name), ['Status bar'])
  assert.deepEqual(screen.systemBands.bottom.map((node) => node.name), ['Tab bar'])
  assert.deepEqual(screen.pinned, [{ id: '1:3', name: 'Tab bar', behavior: 'fixed' }])
  assert.equal(screen.scroll, 'y')
  assert.equal(screen.absolute, 0, 'every child is in the stack')
})

test('a screen placed by coordinates says how much of it is', () => {
  const screen = screenSummary(
    frame({
      children: [child('1:1', 'Badge', 200, 40, { absoluteInLayout: true }), child('1:2', 'Body', 300, 200)],
    })
  )

  assert.equal(screen.absolute, 1)
})

test('a size is a hint about the target, never a claim about the design', () => {
  assert.equal(screenSummary(frame()).kind, 'phone')
  assert.equal(
    screenSummary(frame({ sizing: { width: { mode: 'fixed', value: 834 }, height: { mode: 'fixed', value: 1194 } } })).kind,
    'tablet'
  )
  assert.equal(
    screenSummary(frame({ sizing: { width: { mode: 'fixed', value: 1440 }, height: { mode: 'fixed', value: 900 } } })).kind,
    'desktop'
  )
})

/* ---------------------------------------------------------------- catalogue */

test('an imageset carries the manifest that makes it an imageset', () => {
  const contents = JSON.parse(
    iosContents([
      { scale: 1, file: 'card-cover.png' },
      { scale: 2, file: 'card-cover@2x.png' },
      { scale: 3, file: 'card-cover@3x.png' },
    ])
  )

  assert.deepEqual(contents.images, [
    { idiom: 'universal', filename: 'card-cover.png', scale: '1x' },
    { idiom: 'universal', filename: 'card-cover@2x.png', scale: '2x' },
    { idiom: 'universal', filename: 'card-cover@3x.png', scale: '3x' },
  ])
  assert.equal(contents.info.version, 1)
})

test('a vector imageset is single-scale, because that is the reason to ship a vector', () => {
  // `1x` would pin the icon to the density it happened to be exported at; Xcode rasterises a
  // preserved vector at whatever size the layout asks for.
  const contents = JSON.parse(iosContents([{ scale: 1, file: 'ic-24-arrow.svg' }], 'SVG'))

  assert.deepEqual(contents.images, [{ idiom: 'universal', filename: 'ic-24-arrow.svg' }])
  assert.deepEqual(contents.properties, { 'preserves-vector-representation': true })
})
