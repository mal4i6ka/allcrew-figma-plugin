import test from 'node:test'
import assert from 'node:assert/strict'
import { applyProps, describeAnimation } from './apply.ts'
import { planProps } from './props.ts'
import { READ_OPS } from '../agent/ops.ts'

/**
 * Custom animation styles (Plugin API 1.140). What a read prints about one has to be what a
 * write takes back, and the two halves live in different files — which is exactly where a
 * round trip breaks without anybody noticing.
 */

const PRESETS = [
  { styleId: 'Opacity', name: 'Opacity', props: { easing: 'string' } },
  { styleId: 'Position', name: 'Position' },
]

interface FakeCustomStyle {
  id: string
  name: string
  type: 'CUSTOM_ANIMATION'
  animationEntries: Array<{ id: string; styleId: string; name: string; type: 'FIGMA'; props?: Record<string, unknown> }>
}

function withFigma(
  t: { after: (fn: () => void) => void },
  customStyles: FakeCustomStyle[],
  extra: Record<string, unknown> = {}
): void {
  const writableGlobal = globalThis as unknown as { figma: unknown }
  const previousFigma = writableGlobal.figma
  writableGlobal.figma = {
    motion: { figmaAnimationStyles: () => PRESETS },
    getLocalCustomAnimationStylesAsync: async () => customStyles,
    variables: { getVariableByIdAsync: async () => null },
    ...extra,
  }
  t.after(() => {
    writableGlobal.figma = previousFigma
  })
}

const node = (applied: unknown[]) => {
  const calls: Array<{ styleId: string; data: unknown }> = []
  const fake = {
    id: '1:2',
    type: 'FRAME',
    animationStyles: applied,
    applyAnimationStyle(styleId: string, data: unknown) {
      calls.push({ styleId, data })
      return 'applied-1'
    },
    removeAnimationStyle() {},
  }
  return { fake, calls }
}

test('an applied custom style reads as the name a write takes back', async (t) => {
  withFigma(t, [])
  const line = await describeAnimation([
    { type: 'CUSTOM', id: 'applied-1', styleId: 'S:hero', name: 'Hero entrance', timelineOffset: 0.5 },
  ])
  assert.equal(line, 'Hero entrance (custom) +0.5s')

  // The word before the marker, and the offset beside it, are the whole of the write.
  const plan = planProps({ animation: { style: 'Hero entrance', offset: 0.5 } })
  assert.deepEqual(plan.problems, [])
})

test('a custom style is applied by its own id, with type CUSTOM', async (t) => {
  withFigma(t, [{ id: 'S:hero', name: 'Hero entrance', type: 'CUSTOM_ANIMATION', animationEntries: [] }])
  const { fake, calls } = node([])
  const steps = planProps({ animation: { style: 'Hero entrance', offset: 0.5 } }).steps
  const report = await applyProps(fake as unknown as SceneNode, steps)
  assert.equal(report.failed, 0)
  assert.deepEqual(calls, [{ styleId: 'S:hero', data: { type: 'CUSTOM', timelineOffset: 0.5 } }])
})

test('styles.list reports a custom animation style with the animations it plays, in order', async (t) => {
  const custom: FakeCustomStyle = {
    id: 'S:hero',
    name: 'Hero entrance',
    type: 'CUSTOM_ANIMATION',
    animationEntries: [
      { id: 'e1', styleId: 'Opacity', name: 'Opacity', type: 'FIGMA', props: { easing: 'LINEAR' } },
      { id: 'e2', styleId: 'Position', name: 'Position', type: 'FIGMA' },
    ],
  }
  withFigma(t, [custom], {
    getLocalTextStylesAsync: async () => [],
    getLocalPaintStylesAsync: async () => [],
    getLocalEffectStylesAsync: async () => [],
    getLocalGridStylesAsync: async () => [],
  })

  const op = READ_OPS.find((entry) => entry.name === 'styles.list')!
  const listed = (await op.run({})) as {
    animation: Array<{ name: string; animations: Array<{ style: string; props?: unknown }> }>
  }
  assert.deepEqual(listed.animation, [
    {
      id: 'S:hero',
      key: undefined,
      name: 'Hero entrance',
      description: undefined,
      animations: [
        { id: 'e1', style: 'Opacity', name: 'Opacity', props: { easing: 'LINEAR' } },
        { id: 'e2', style: 'Position', name: 'Position' },
      ],
    },
  ])
})
