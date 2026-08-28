import test from 'node:test'
import assert from 'node:assert/strict'
import { describeLinks, planProps } from './props.ts'

const linkStep = (links: unknown) => {
  const plan = planProps({ links })
  assert.deepEqual(plan.problems, [], `unexpected problems: ${plan.problems.join(' · ')}`)
  const step = plan.steps[0]
  assert.equal(step.step, 'links')
  return step as Extract<typeof step, { step: 'links' }>
}

/* ---------------------------------------------------------------------- links */

test('a click through to a screen is the whole of what a caller has to say', () => {
  const step = linkStep([{ to: '10:20' }])
  assert.deepEqual(step.reactions, [
    {
      trigger: { type: 'ON_CLICK' },
      actions: [{ type: 'NODE', destinationId: '10:20', navigation: 'NAVIGATE', transition: null }],
    },
  ])
  // The destination is collected so the applier can refuse a link to nothing.
  assert.deepEqual(step.destinations, ['10:20'])
  assert.equal(step.summary, 'click → 10:20')
})

test('a direction is part of the animation name, not a fourth nested object', () => {
  const step = linkStep([{ on: 'press', to: '1:2', animation: 'PUSH_LEFT', duration: 0.5 }])
  assert.deepEqual(step.reactions[0], {
    trigger: { type: 'ON_PRESS' },
    actions: [
      {
        type: 'NODE',
        destinationId: '1:2',
        navigation: 'NAVIGATE',
        transition: {
          type: 'PUSH',
          direction: 'LEFT',
          matchLayers: false,
          easing: { type: 'EASE_OUT' },
          duration: 0.5,
        },
      },
    ],
  })
  assert.equal(step.summary, 'press → 1:2 PUSH_LEFT 0.5s')
})

test('dissolve is simple, and 0.3s is what it is unless someone says otherwise', () => {
  const step = linkStep([{ to: '1:2', animation: 'DISSOLVE' }])
  const action = step.reactions[0].actions![0] as { transition: { type: string; duration: number } }
  assert.deepEqual(action.transition, { type: 'DISSOLVE', easing: { type: 'EASE_OUT' }, duration: 0.3 })
})

test('back and close carry no destination, and are not case-sensitive', () => {
  assert.deepEqual(linkStep([{ to: 'back' }]).reactions[0].actions, [{ type: 'BACK' }])
  const step = linkStep([{ on: 'click', to: 'CLOSE' }])
  assert.deepEqual(step.reactions[0].actions, [{ type: 'CLOSE' }])
  assert.deepEqual(step.destinations, [], 'nothing to check for existence')
})

test('a timeout carries its seconds in the trigger', () => {
  const step = linkStep([{ on: 'timeout', after: 2.5, to: '1:2' }])
  assert.deepEqual(step.reactions[0].trigger, { type: 'AFTER_TIMEOUT', timeout: 2.5 })
})

test('an overlay says so, and the summary shows it', () => {
  const step = linkStep([{ to: '1:2', as: 'OVERLAY' }])
  const action = step.reactions[0].actions![0] as { navigation: string }
  assert.equal(action.navigation, 'OVERLAY')
  assert.equal(step.summary, 'click → 1:2 (OVERLAY)')
})

test('an empty list is a caller removing every link, not a mistake', () => {
  const step = linkStep([])
  assert.deepEqual(step.reactions, [])
  assert.equal(step.summary, 'none')
})

/* ------------------------------------------------------------------- refusals */

test('every way of getting a link wrong is named, with what was accepted', () => {
  assert.match(planProps({ links: {} }).problems[0], /must be an array of \{ on, to \} links/)
  assert.match(planProps({ links: [{ to: '1:2', on: 'tap' }] }).problems[0], /on must be one of: click, hover/)
  assert.match(planProps({ links: [{ on: 'click' }] }).problems[0], /to must be a node id/)
  assert.match(planProps({ links: [{ to: '1:2', as: 'GOTO' }] }).problems[0], /as must be one of: NAVIGATE/)
  assert.match(planProps({ links: [{ to: '1:2', animation: 'FADE' }] }).problems[0], /animation must be one of/)
  assert.match(planProps({ links: [{ to: '1:2', animation: 'PUSH_SIDEWAYS' }] }).problems[0], /PUSH\/SLIDE_IN/)
  assert.match(planProps({ links: [{ to: '1:2', duration: 30 }] }).problems[0], /between 0 and 10/)
  assert.match(planProps({ links: [{ on: 'timeout', after: 0, to: '1:2' }] }).problems[0], /greater than 0/)
  assert.match(planProps({ links: [{ to: '1:2', delay: 3 }] }).problems[0], /unknown key "delay"/)
})

test('one bad link does not take the good ones with it', () => {
  const plan = planProps({ links: [{ to: '1:2' }, { to: '3:4', animation: 'WOOSH' }, { to: '5:6' }] })
  assert.equal(plan.problems.length, 1)
  const step = plan.steps[0] as Extract<(typeof plan.steps)[number], { step: 'links' }>
  assert.deepEqual(step.destinations, ['1:2', '5:6'])
})

/* --------------------------------------------------------------- reading back */

test('reactions read back as the line a caller could have written', () => {
  const step = linkStep([
    { to: '1:2', animation: 'PUSH_LEFT' },
    { on: 'hover', to: '3:4', as: 'OVERLAY' },
    { to: 'back' },
  ])
  assert.equal(describeLinks(step.reactions), 'click → 1:2 PUSH_LEFT 0.3s · hover → 3:4 (OVERLAY) · click → back')
})

test('a reaction from Figma with the deprecated single action still reads', () => {
  const line = describeLinks([{ trigger: { type: 'ON_CLICK' }, action: { type: 'BACK' } }])
  assert.equal(line, 'click → back')
})

test('nothing to say reads as nothing, not as an empty structure', () => {
  assert.equal(describeLinks([]), '')
})

/* ---------------------------------------------------------------------- data */

test('plugin data is planned as given, and null is how a key is cleared', () => {
  const plan = planProps({ data: { flow: 'onboarding', step: null } })
  assert.deepEqual(plan.problems, [])
  assert.deepEqual(plan.steps, [{ step: 'data', data: { flow: 'onboarding', step: null } }])
})

test('data that is not text is refused rather than stringified behind the caller', () => {
  assert.match(planProps({ data: { n: 3 } }).problems[0], /data.n must be a string, or null to clear it/)
  assert.match(planProps({ data: 'onboarding' }).problems[0], /data must be an object/)
})

test('links and data are set after the node looks the way it should', () => {
  const plan = planProps({ data: { flow: 'x' }, links: [{ to: '1:2' }], name: 'Screen', width: 375 })
  assert.deepEqual(
    plan.steps.map((step) => (step.step === 'assign' ? step.property : step.step)),
    ['name', 'resize', 'links', 'data']
  )
})
