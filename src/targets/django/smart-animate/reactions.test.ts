import test from 'node:test'
import assert from 'node:assert/strict'
import { extractSmartAnimatePairs } from './reactions.ts'

function setFigma(mock: unknown) {
  ;(globalThis as any).figma = mock
}

function smartAnimateTransition(overrides: Partial<Transition> = {}): Transition {
  return { type: 'SMART_ANIMATE', easing: { type: 'EASE_OUT' }, duration: 0.3, ...overrides } as Transition
}

test('extractSmartAnimatePairs collects a CHANGE_TO reaction with a SMART_ANIMATE transition', () => {
  const destination = { id: 'dest-1', type: 'COMPONENT' }
  setFigma({ getNodeById: (id: string) => (id === 'dest-1' ? destination : null) })

  const variant = {
    id: 'var-default',
    type: 'COMPONENT',
    reactions: [
      {
        trigger: { type: 'ON_HOVER' },
        actions: [{ type: 'NODE', destinationId: 'dest-1', navigation: 'CHANGE_TO', transition: smartAnimateTransition() }],
      },
    ],
  }
  const componentSet = { children: [variant] } as unknown as ComponentSetNode

  const pairs = extractSmartAnimatePairs(componentSet)

  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].from, variant)
  assert.equal(pairs[0].to, destination)
  assert.deepEqual(pairs[0].trigger, { type: 'ON_HOVER' })
})

test('extractSmartAnimatePairs walks every variant under the ComponentSet', () => {
  const destA = { id: 'a', type: 'COMPONENT' }
  const destB = { id: 'b', type: 'COMPONENT' }
  setFigma({ getNodeById: (id: string) => ({ a: destA, b: destB } as Record<string, unknown>)[id] ?? null })

  const variant1 = {
    id: 'v1',
    reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: 'a', navigation: 'CHANGE_TO', transition: smartAnimateTransition() }] }],
  }
  const variant2 = {
    id: 'v2',
    reactions: [{ trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', destinationId: 'b', navigation: 'CHANGE_TO', transition: smartAnimateTransition() }] }],
  }
  const componentSet = { children: [variant1, variant2] } as unknown as ComponentSetNode

  const pairs = extractSmartAnimatePairs(componentSet)

  assert.deepEqual(
    pairs.map((p) => [p.from, p.to]),
    [[variant1, destA], [variant2, destB]]
  )
})

test('extractSmartAnimatePairs accepts a DirectionalTransition with matchLayers: true', () => {
  const destination = { id: 'dest', type: 'COMPONENT' }
  setFigma({ getNodeById: () => destination })

  const variant = {
    id: 'v',
    reactions: [
      {
        trigger: { type: 'ON_CLICK' },
        actions: [
          {
            type: 'NODE',
            destinationId: 'dest',
            navigation: 'CHANGE_TO',
            transition: { type: 'PUSH', direction: 'LEFT', matchLayers: true, easing: { type: 'LINEAR' }, duration: 0.2 },
          },
        ],
      },
    ],
  }
  const componentSet = { children: [variant] } as unknown as ComponentSetNode

  assert.equal(extractSmartAnimatePairs(componentSet).length, 1)
})

test('extractSmartAnimatePairs ignores a DISSOLVE transition (no layer matching) and reactions with no destination', () => {
  const destination = { id: 'dest', type: 'COMPONENT' }
  setFigma({ getNodeById: () => destination })

  const variant = {
    id: 'v',
    reactions: [
      { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: 'dest', navigation: 'CHANGE_TO', transition: { type: 'DISSOLVE', easing: { type: 'LINEAR' }, duration: 0.2 } }] },
      { trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', destinationId: null, navigation: 'CHANGE_TO', transition: smartAnimateTransition() }] },
      { trigger: null, actions: [{ type: 'NODE', destinationId: 'dest', navigation: 'CHANGE_TO', transition: smartAnimateTransition() }] },
    ],
  }
  const componentSet = { children: [variant] } as unknown as ComponentSetNode

  assert.deepEqual(extractSmartAnimatePairs(componentSet), [])
})

test('extractSmartAnimatePairs skips a destinationId that no longer resolves to a node', () => {
  setFigma({ getNodeById: () => null })

  const variant = {
    id: 'v',
    reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: 'gone', navigation: 'CHANGE_TO', transition: smartAnimateTransition() }] }],
  }
  const componentSet = { children: [variant] } as unknown as ComponentSetNode

  assert.deepEqual(extractSmartAnimatePairs(componentSet), [])
})
