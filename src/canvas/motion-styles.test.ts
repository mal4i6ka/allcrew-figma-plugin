import test from 'node:test'
import assert from 'node:assert/strict'
import { replaceCustomAnimationEntries, resolveFigmaAnimationStyle, resolveMotionStyleTarget } from './motion-styles.ts'
import { applyProps, describeAnimation } from './apply.ts'
import { planProps } from './props.ts'

const figmaStyles = [
  { styleId: 'Opacity', name: 'Opacity' },
  { styleId: 'Position', name: 'Move in' },
] as AvailableAnimationStyle[]

const customStyles = [
  { id: 'S:custom', name: 'Hero entrance' },
  { id: 'S:duplicate', name: 'Move in' },
] as CustomAnimationStyle[]

test('motion style resolution accepts Figma and custom ids', () => {
  assert.deepEqual(resolveMotionStyleTarget('Position', figmaStyles, customStyles), {
    type: 'FIGMA',
    id: 'Position',
    name: 'Move in',
  })
  assert.deepEqual(resolveMotionStyleTarget('S:custom', figmaStyles, customStyles), {
    type: 'CUSTOM',
    id: 'S:custom',
    name: 'Hero entrance',
  })
})

test('motion style resolution refuses an ambiguous display name', () => {
  assert.throws(
    () => resolveMotionStyleTarget('Move in', figmaStyles, customStyles),
    /ambiguous.*Position.*S:duplicate/i
  )
})

test('custom animation entries resolve only Figma-provided animation styles', () => {
  assert.equal(resolveFigmaAnimationStyle('Move in', figmaStyles).styleId, 'Position')
  assert.throws(() => resolveFigmaAnimationStyle('Hero entrance', figmaStyles), /no Figma animation/i)
})
test('custom styles apply with the CUSTOM discriminator and only an offset override', async () => {
  const calls: unknown[] = []
  let removed = 0
  Object.assign(globalThis, {
    figma: {
      motion: { figmaAnimationStyles: () => figmaStyles },
      getLocalCustomAnimationStylesAsync: async () => customStyles,
    },
  })
  const node = {
    type: 'FRAME',
    animationStyles: [{ id: 'applied:old', styleId: 'Opacity', name: 'Opacity', type: 'FIGMA' }],
    removeAnimationStyle() { removed++ },
    applyAnimationStyle(id: string, configuration: unknown) { calls.push([id, configuration]); return 'applied:new' },
  }
  const plan = planProps({ animation: { style: 'S:custom', offset: 0.25 } })
  const report = await applyProps(node as never, plan.steps)

  assert.equal(report.failed, 0)
  assert.equal(removed, 1)
  assert.deepEqual(calls, [['S:custom', { type: 'CUSTOM', timelineOffset: 0.25 }]])
})

test('custom style validation happens before existing animations are removed', async () => {
  let removed = 0
  Object.assign(globalThis, {
    figma: {
      motion: { figmaAnimationStyles: () => figmaStyles },
      getLocalCustomAnimationStylesAsync: async () => customStyles,
    },
  })
  const node = {
    type: 'FRAME',
    animationStyles: [{ id: 'applied:old', styleId: 'Opacity', name: 'Opacity', type: 'FIGMA' }],
    removeAnimationStyle() { removed++ },
    applyAnimationStyle() { return 'never' },
  }
  const plan = planProps({ animation: { style: 'S:custom', duration: 1 } })
  const report = await applyProps(node as never, plan.steps)

  assert.equal(report.failed, 1)
  assert.equal(removed, 0)
  assert.match(report.applied[0].error ?? '', /owns its durations and props/i)
})

test('custom applied animation descriptions stay readable', async () => {
  assert.equal(
    await describeAnimation([{ id: 'applied:1', styleId: 'S:custom', name: 'Hero entrance', type: 'CUSTOM' }]),
    'Hero entrance (custom)'
  )
})

test('custom animation entry replacement restores the original order after a failed add', async () => {
  let sequence = [
    { id: 'old:1', styleId: 'Opacity', name: 'Opacity', type: 'FIGMA' as const, props: {} },
    { id: 'old:2', styleId: 'Position', name: 'Move in', type: 'FIGMA' as const, props: {} },
  ]
  let next = 0
  const style = {
    get animationEntries() { return sequence },
    removeAnimationEntry(id: string) { sequence = sequence.filter((entry) => entry.id !== id) },
    async addAnimationEntryAsync(styleId: string, props: Record<string, AnimationStylePropValue>) {
      if (styleId === 'Broken') throw new Error('cannot add Broken')
      const entry = { id: `new:${next++}`, styleId, name: styleId, type: 'FIGMA' as const, props }
      sequence.push(entry)
      return entry
    },
  }

  await assert.rejects(
    replaceCustomAnimationEntries(style as never, [
      { styleId: 'Opacity', props: {} },
      { styleId: 'Broken', props: {} },
    ]),
    /cannot add Broken/
  )
  assert.deepEqual(sequence.map((entry) => entry.styleId), ['Opacity', 'Position'])
})
