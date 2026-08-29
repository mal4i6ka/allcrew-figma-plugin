import test from 'node:test'
import assert from 'node:assert/strict'
import { sendableLinks } from './link-reader.ts'

const reaction = (trigger: unknown, ...actions: unknown[]) =>
  ({ trigger, actions }) as unknown as Reaction

test('a navigation reads back as the link that would make it', () => {
  const links = sendableLinks([
    reaction({ type: 'ON_PRESS' }, {
      type: 'NODE',
      destinationId: '1:2',
      navigation: 'CHANGE_TO',
      transition: { type: 'DISSOLVE', duration: 0.05, easing: { type: 'EASE_IN_AND_OUT' } },
    }),
  ])
  assert.deepEqual(links, [
    { on: 'press', to: '1:2', as: 'CHANGE_TO', animation: 'DISSOLVE', duration: 0.05, easing: 'EASE_IN_AND_OUT' },
  ])
})

test('a directional transition puts its direction back in the word', () => {
  const [link] = sendableLinks([
    reaction({ type: 'ON_CLICK' }, {
      type: 'NODE',
      destinationId: '1:2',
      transition: { type: 'PUSH', direction: 'LEFT', matchLayers: true, duration: 0.3, easing: { type: 'GENTLE' } },
    }),
  ])
  assert.equal(link.animation, 'PUSH_LEFT')
  assert.equal(link.matchLayers, true)
  // NAVIGATE is the default, so it is not repeated.
  assert.equal(link.as, undefined)
})

test('milliseconds come back as the seconds the write takes', () => {
  const [link] = sendableLinks([reaction({ type: 'AFTER_TIMEOUT', timeout: 2500 }, { type: 'BACK' })])
  assert.deepEqual(link, { on: 'timeout', after: 2.5, to: 'back' })
})

test('a spring comes back as a spring, not as its name', () => {
  const [link] = sendableLinks([
    reaction({ type: 'ON_CLICK' }, {
      type: 'NODE',
      destinationId: '1:2',
      transition: {
        type: 'SMART_ANIMATE',
        duration: 0.4,
        easing: { type: 'CUSTOM_SPRING', easingFunctionSpring: { mass: 1, stiffness: 200, damping: 20 } },
      },
    }),
  ])
  assert.deepEqual(link.spring, { mass: 1, stiffness: 200, damping: 20 })
  assert.equal(link.easing, undefined, 'a curve and a name would say the same thing twice')
})

test('one reaction with two actions is two links, because that is how they are written', () => {
  const links = sendableLinks([
    reaction({ type: 'ON_CLICK' }, { type: 'BACK' }, { type: 'URL', url: 'https://altery.com' }),
  ])
  assert.deepEqual(links, [
    { on: 'click', to: 'back' },
    { on: 'click', url: 'https://altery.com' },
  ])
})

test('what the vocabulary has no word for is named, never silently dropped', () => {
  const [link] = sendableLinks([reaction({ type: 'ON_CLICK' }, { type: 'UPDATE_MEDIA_RUNTIME' })])
  assert.deepEqual(link.unread, ['action UPDATE_MEDIA_RUNTIME'])
})

test('a conditional reads as if / then / else, and says when there is more', () => {
  const block = (value: unknown, to: string) => ({
    condition: {
      expressionFunction: 'EQUALS',
      expressionArguments: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' }, { value }],
    },
    actions: [{ type: 'NODE', destinationId: to }],
  })
  const [link] = sendableLinks([
    reaction({ type: 'ON_CLICK' }, { type: 'CONDITIONAL', conditionalBlocks: [block(true, '1:2'), block(false, '1:3'), block(1, '1:4')] }),
  ])
  assert.deepEqual(link.if, { left: { variable: 'VariableID:1:1' }, is: '==', right: true })
  assert.deepEqual(link.then, { to: '1:2' })
  assert.deepEqual(link.else, { to: '1:3' })
  assert.match(link.unread![0], /else-if/)
})
