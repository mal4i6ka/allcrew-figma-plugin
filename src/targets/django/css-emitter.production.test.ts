import test from 'node:test'
import assert from 'node:assert/strict'
import { emitCss, groupComponentVariantSets, type DjangoNodeSource } from './css-emitter.ts'
import type { IrContainerNode } from './ir.ts'

function makeBase() {
  return {
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' as const }, height: { mode: 'hug' as const } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
  }
}

function source(css: Record<string, string>): DjangoNodeSource {
  return { getCSSAsync: async () => css }
}

// --- CSS preamble ------------------------------------------------------------------------------

test('emitCss preamble adds the skip-link, media/video sizing, and reduced-motion rules on top of the existing reset', () => {
  const css = emitCss([], new Map())
  return css.then((result) => {
    assert.match(result, /\*, \*::before, \*::after \{\n {2}box-sizing: border-box;\n\}/)
    assert.match(result, /body \{\n {2}margin: 0;\n\}/)
    assert.match(result, /img, svg, video \{\n {2}display: block;\n {2}max-width: 100%;\n\}/)
    assert.match(result, /\.skip-to-content \{[^}]*position: absolute;[^}]*\}/)
    assert.match(result, /\.skip-to-content:focus \{\n {2}left: 0;\n\}/)
    assert.match(result, /@media \(prefers-reduced-motion: reduce\) \{\n {2}\* \{\n {4}animation-duration: \.01ms !important;/)
  })
})

test('emitCss preamble is fully suppressed by preamble: false, same as before', async () => {
  const css = await emitCss([], new Map(), new Map(), { preamble: false })
  assert.equal(css, '')
})

// --- component-set variant grouping -------------------------------------------------------------

function buttonVariant(id: string, name: string, key: string, children: IrContainerNode['children'] = []): IrContainerNode {
  return {
    ...makeBase(),
    id,
    name,
    type: 'container',
    layout: { kind: 'absolute' },
    component: {
      key,
      setName: 'Button',
      properties: [{ name: 'Size', type: 'VARIANT', defaultValue: 'md', variantOptions: ['sm', 'md', 'lg'] }],
    },
    children,
  }
}

test('groupComponentVariantSets picks the member matching every VARIANT prop default, and flags shape mismatches as non-uniform', () => {
  const lg = buttonVariant('1:1', 'Size=lg', 'k-lg')
  const md = buttonVariant('1:2', 'Size=md', 'k-md')
  const [uniformSet] = groupComponentVariantSets([lg, md])
  assert.equal(uniformSet.uniform, true)
  assert.equal(uniformSet.defaultVariant.id, '1:2')
  assert.equal(uniformSet.members.length, 2)

  const withChild = buttonVariant('2:1', 'Size=lg', 'k2-lg', [
    { ...makeBase(), id: '2:1;icon', name: 'Icon', type: 'container', layout: { kind: 'absolute' }, component: null, children: [] },
  ])
  const withoutChild = buttonVariant('2:2', 'Size=md', 'k2-md')
  const [divergentSet] = groupComponentVariantSets([withChild, withoutChild])
  assert.equal(divergentSet.uniform, false)
})

test('groupComponentVariantSets excludes standalone (non-set) components entirely', () => {
  const card: IrContainerNode = {
    ...makeBase(),
    id: '3:1',
    name: 'Card',
    type: 'container',
    layout: { kind: 'absolute' },
    component: { key: 'card', properties: [] },
    children: [],
  }
  assert.deepEqual(groupComponentVariantSets([card]), [])
})

// --- variant modifier CSS: real diffed declarations, scoped under the modifier class -----------

test('emitCss emits a root-level modifier rule with ONLY the declarations that differ from the default variant', async () => {
  const md = buttonVariant('10:1', 'Size=md', 'k-md')
  const lg = buttonVariant('10:2', 'Size=lg', 'k-lg')
  const sceneNodesById = new Map<string, DjangoNodeSource>([
    ['10:1', source({ 'background-color': '#FF0000', 'border-radius': '4px' })],
    ['10:2', source({ 'background-color': '#FF0000', 'border-radius': '8px' })],
  ])

  const css = await emitCss([md, lg], sceneNodesById, new Map(), { preamble: false })
  assert.match(css, /\.n10-1--lg \{\n {2}border-radius: 8px;\n\}/)
  // background-color is identical between variants — it must NOT show up in the diff rule.
  assert.doesNotMatch(css, /\.n10-1--lg \{\n(?:.*\n)*?\s*background-color: #FF0000;/)
})

test('emitCss covers a differing DESCENDANT, scoped under the modifier class using the DEFAULT variant\'s own descendant id', async () => {
  const md = buttonVariant('20:1', 'Size=md', 'k3-md', [
    { ...makeBase(), id: '20:3', name: 'Icon', type: 'container', layout: { kind: 'absolute' }, component: null, children: [] },
  ])
  const lg = buttonVariant('20:2', 'Size=lg', 'k3-lg', [
    { ...makeBase(), id: '20:4', name: 'Icon', type: 'container', layout: { kind: 'absolute' }, component: null, children: [] },
  ])
  const sceneNodesById = new Map<string, DjangoNodeSource>([
    ['20:1', source({})],
    ['20:2', source({})],
    ['20:3', source({ 'background-color': '#000000' })],
    ['20:4', source({ 'background-color': '#FFFFFF' })],
  ])

  const css = await emitCss([md, lg], sceneNodesById, new Map(), { preamble: false })
  // The shared partial only ever renders the DEFAULT's descendant ids — the modifier rule must be
  // scoped under n20-3 (the default's own Icon), never n20-4 (the sibling's), even though the
  // VALUE it carries (#FFFFFF) comes from diffing against that sibling.
  assert.match(css, /\.n20-1--lg \.n20-3 \{\n {2}background-color: #FFFFFF;\n\}/)
})

test('emitCss emits no modifier rules for a structurally divergent set', async () => {
  const withChild = buttonVariant('30:1', 'Size=lg', 'k4-lg', [
    { ...makeBase(), id: '30:3', name: 'Icon', type: 'container', layout: { kind: 'absolute' }, component: null, children: [] },
  ])
  const withoutChild = buttonVariant('30:2', 'Size=md', 'k4-md')
  const sceneNodesById = new Map<string, DjangoNodeSource>([
    ['30:1', source({ 'background-color': '#FF0000' })],
    ['30:2', source({ 'background-color': '#00FF00' })],
    ['30:3', source({})],
  ])

  const css = await emitCss([withChild, withoutChild], sceneNodesById, new Map(), { preamble: false })
  assert.doesNotMatch(css, /--lg/)
})

// --- per-layer scroll behavior --------------------------------------------------------------

test('a layer marked fixed/sticky in the prototype gets that position, not the scrolling default', async () => {
  const header: IrContainerNode = {
    ...makeBase(),
    id: '1:2',
    name: 'Header',
    type: 'container',
    layout: { kind: 'absolute' },
    component: null,
    children: [],
    scrollBehavior: 'sticky',
  }
  const page: IrContainerNode = {
    ...makeBase(),
    id: '1:1',
    name: 'Page',
    type: 'container',
    layout: { kind: 'absolute' },
    component: null,
    children: [header],
  }

  const css = await emitCss([page], new Map([['1:2', source({})]]), new Map(), { preamble: false })
  const rule = /\.n1-2 \{([^}]*)\}/.exec(css)

  assert.ok(rule, `no rule for the sticky header:\n${css}`)
  assert.match(rule[1], /position: sticky;/)
  // Without an offset a sticky box never sticks to anything, so one is always present — here the
  // absolute placement already supplied it.
  assert.match(rule[1], /top: 0px;/)
})

test('a fixed layer keeps the offset the design already gave it', async () => {
  const banner: IrContainerNode = {
    ...makeBase(),
    id: '2:2',
    name: 'Banner',
    type: 'container',
    layout: { kind: 'absolute' },
    position: { x: 0, y: 40 },
    component: null,
    children: [],
    scrollBehavior: 'fixed',
  }
  const page: IrContainerNode = {
    ...makeBase(),
    id: '2:1',
    name: 'Page',
    type: 'container',
    layout: { kind: 'absolute' },
    component: null,
    children: [banner],
  }

  const css = await emitCss([page], new Map([['2:2', source({})]]), new Map(), { preamble: false })
  const rule = /\.n2-2 \{([^}]*)\}/.exec(css)

  assert.ok(rule)
  assert.match(rule[1], /position: fixed;/)
  assert.match(rule[1], /top: 40px;/)
  assert.doesNotMatch(rule[1], /top: 0;/)
})
