import test from 'node:test'
import assert from 'node:assert/strict'
import { detectBreakpointGroups, mergeBreakpointVariants, emitBreakpointCss, type BreakpointGroup } from './breakpoint-frames.ts'
import { toClassName, type DjangoNodeSource } from './css-emitter.ts'
import type { IrContainerNode, IrFlexLayout, IrNode } from './ir.ts'

function base() {
  return {
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' as const }, height: { mode: 'hug' as const } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
  }
}

function absContainer(id: string, name: string, children: IrNode[] = []): IrContainerNode {
  return { ...base(), id, name, type: 'container', layout: { kind: 'absolute' }, component: null, children }
}

const FLEX_ROW: IrFlexLayout = {
  kind: 'flex',
  direction: 'row',
  wrap: false,
  gap: 0,
  justifyContent: 'flex-start',
  alignItems: 'flex-start',
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
}

function flexContainer(id: string, name: string, children: IrNode[] = []): IrContainerNode {
  return { ...base(), id, name, type: 'container', layout: FLEX_ROW, component: null, children }
}

const noSceneNodes = new Map<string, DjangoNodeSource>()

/* A desktop frame with Header/Content/Footer and a mobile frame that drops Footer, keeps
 * Header/Content (matched), and adds a Burger the desktop design never had. */
function buildGapGroup(): BreakpointGroup {
  const desktop = absContainer('d:1', 'Home/desktop', [
    absContainer('d:2', 'Header'),
    absContainer('d:3', 'Content'),
    absContainer('d:4', 'Footer'),
  ])
  const mobile = absContainer('m:1', 'Home/mobile', [
    absContainer('m:2', 'Header'),
    absContainer('m:5', 'Burger'),
    absContainer('m:3', 'Content'),
  ])
  const { groups } = detectBreakpointGroups([desktop, mobile])
  assert.equal(groups.length, 1)
  return groups[0]
}

test('mergeBreakpointVariants splices a mobile-only node into the merged tree at its mobile sibling position, tagged for its breakpoint', () => {
  const merged = mergeBreakpointVariants(buildGapGroup())
  assert.equal(merged.children.map((c) => c.name).join(','), 'Header,Burger,Content,Footer')
  const burger = merged.children.find((c) => c.name === 'Burger')
  assert.deepEqual(burger?.breakpointOnly, ['mobile'])
  const header = merged.children.find((c) => c.name === 'Header')
  assert.equal(header?.breakpointOnly, undefined, 'a node shared by every frame carries no breakpointOnly tag')
})

test('emitBreakpointCss hides a mobile-only node unconditionally at base and reveals it inside the mobile media block', async () => {
  const group = buildGapGroup()
  const burgerId = 'm:5'
  const css = await emitBreakpointCss(group, noSceneNodes)

  const burgerClass = toClassName(burgerId)
  const mediaStart = css.indexOf('@media')
  assert.ok(mediaStart > 0, 'base rules must precede the first @media block')
  const baseCss = css.slice(0, mediaStart)
  assert.match(baseCss, new RegExp(`\\.${burgerClass}\\s*\\{[^}]*display: none`))

  const mobileBlockStart = css.indexOf('@media (max-width: 1279px)')
  assert.ok(mobileBlockStart >= 0)
  const mobileBlock = css.slice(mobileBlockStart)
  assert.match(mobileBlock, new RegExp(`\\.${burgerClass}\\s*\\{[^}]*display: block`))
})

test('emitBreakpointCss hides a desktop-only node inside the mobile media block, never at base', async () => {
  const group = buildGapGroup()
  const footerId = 'd:4'
  const css = await emitBreakpointCss(group, noSceneNodes)

  const footerClass = toClassName(footerId)
  const mediaStart = css.indexOf('@media')
  const baseCss = css.slice(0, mediaStart)
  assert.ok(!baseCss.includes(`.${footerClass}`), 'a base-present node must not be hidden unconditionally')

  const mobileBlock = css.slice(css.indexOf('@media (max-width: 1279px)'))
  assert.match(mobileBlock, new RegExp(`\\.${footerClass}\\s*\\{[^}]*display: none`))
})

function buildOrderGroup(flex: boolean): BreakpointGroup {
  const makeRow = (id: string, children: IrNode[]): IrContainerNode =>
    flex ? flexContainer(id, 'Row', children) : absContainer(id, 'Row', children)
  const desktop = absContainer('d:1', 'Order/desktop', [makeRow('d:2', [absContainer('d:3', 'A'), absContainer('d:4', 'B')])])
  const mobile = absContainer('m:1', 'Order/mobile', [makeRow('m:2', [absContainer('m:4', 'B'), absContainer('m:3', 'A')])])
  const { groups } = detectBreakpointGroups([desktop, mobile])
  assert.equal(groups.length, 1)
  return groups[0]
}

test('emitBreakpointCss emits order on every flow child of a flex parent the mobile frame reorders', async () => {
  const css = await emitBreakpointCss(buildOrderGroup(true), noSceneNodes)
  const aClass = toClassName('d:3')
  const bClass = toClassName('d:4')
  assert.match(css, new RegExp(`\\.${aClass}\\s*\\{[^}]*order: 1`))
  assert.match(css, new RegExp(`\\.${bClass}\\s*\\{[^}]*order: 0`))
})

test('emitBreakpointCss never emits order for a reordered absolute parent — order is meaningless outside flex', async () => {
  const css = await emitBreakpointCss(buildOrderGroup(false), noSceneNodes)
  assert.ok(!/[^a-zA-Z-]order:/.test(css), 'no order declaration should appear under a non-flex parent')
})

test('emitBreakpointCss orders @media blocks widest-first so the narrowest breakpoint wins the cascade', async () => {
  const desktop = absContainer('d:1', 'Stack/desktop', [absContainer('d:2', 'Body')])
  const tablet = absContainer('t:1', 'Stack/tablet', [absContainer('t:2', 'Body')])
  const mobile = absContainer('mo:1', 'Stack/mobile', [absContainer('mo:2', 'Body')])
  const { groups } = detectBreakpointGroups([desktop, tablet, mobile])
  assert.equal(groups.length, 1)

  const css = await emitBreakpointCss(groups[0], noSceneNodes)
  const tabletBlockIndex = css.indexOf('@media (max-width: 1279px)')
  const mobileBlockIndex = css.indexOf('@media (max-width: 767px)')
  assert.ok(tabletBlockIndex >= 0 && mobileBlockIndex >= 0, 'both breakpoints below desktop must emit a block')
  assert.ok(tabletBlockIndex < mobileBlockIndex, 'the wider (tablet) block must precede the narrower (mobile) block')
})

test('a two-frame group (no tablet) interpolates a desktop-width fixed container to a bounded-fluid width, guarded above the mobile width', async () => {
  const desktop: IrContainerNode = { ...absContainer('d:1', 'Wide/desktop', []), sizing: { width: { mode: 'fixed', value: 1280 }, height: { mode: 'hug' } } }
  const mobile: IrContainerNode = { ...absContainer('m:1', 'Wide/mobile', []), sizing: { width: { mode: 'fixed', value: 375 }, height: { mode: 'hug' } } }
  const { groups } = detectBreakpointGroups([desktop, mobile])
  assert.equal(groups.length, 1)

  const css = await emitBreakpointCss(groups[0], noSceneNodes)
  const rootClass = toClassName('d:1')
  assert.match(css, new RegExp(`@media \\(min-width: 375px\\) \\{[^]*\\.${rootClass}\\s*\\{[^}]*width: 100%;[^}]*max-width: 1280px;`))
})

test('a node introduced by the tablet frame and also present at mobile is spliced once, tagged for both breakpoints, and revealed in both blocks', async () => {
  const desktop = absContainer('d:1', 'Panel/desktop', [absContainer('d:2', 'Body')])
  const tablet = absContainer('t:1', 'Panel/tablet', [absContainer('t:2', 'Body'), absContainer('t:3', 'Aside')])
  const mobile = absContainer('mo:1', 'Panel/mobile', [absContainer('mo:2', 'Body'), absContainer('mo:4', 'Aside')])
  const { groups } = detectBreakpointGroups([desktop, tablet, mobile])
  assert.equal(groups.length, 1)

  const merged = mergeBreakpointVariants(groups[0])
  const asideNodes = merged.children.filter((c) => c.name === 'Aside')
  assert.equal(asideNodes.length, 1, 'the tablet-introduced node must not be spliced a second time at mobile')
  assert.deepEqual(asideNodes[0].breakpointOnly, ['tablet', 'mobile'])

  const css = await emitBreakpointCss(groups[0], noSceneNodes)
  const asideClass = toClassName(asideNodes[0].id)
  const tabletBlock = css.slice(css.indexOf('@media (max-width: 1279px)'), css.indexOf('@media (max-width: 767px)'))
  const mobileBlock = css.slice(css.indexOf('@media (max-width: 767px)'))
  assert.match(tabletBlock, new RegExp(`\\.${asideClass}\\s*\\{[^}]*display: block`))
  assert.match(mobileBlock, new RegExp(`\\.${asideClass}\\s*\\{[^}]*display: block`))
})
