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

test('a timeout link says how long it waits — the wait is the whole of what it says', () => {
  assert.equal(linkStep([{ on: 'timeout', after: 3, to: '1:2' }]).summary, 'timeout 3s → 1:2')
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
  assert.match(planProps({ links: [{ to: '1:2', speed: 3 }] }).problems[0], /unknown key "speed"/)
  // A field that belongs to another trigger is not silently dropped either.
  assert.match(planProps({ links: [{ to: '1:2', delay: 3 }] }).problems[0], /delay only applies to mouseEnter/)
  assert.match(planProps({ links: [{ to: '1:2', keys: [13] }] }).problems[0], /keys only applies to keyDown/)
  assert.match(planProps({ links: [{ on: 'click', after: 2, to: '1:2' }] }).problems[0], /after only applies to a timeout/)
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

/* ------------------------------------------------------------------- motion */

const transitionOf = (link: Record<string, unknown>) => {
  const step = linkStep([{ to: '1:2', animation: 'SMART_ANIMATE', ...link }])
  return (step.reactions[0].actions![0] as { transition: Record<string, unknown> }).transition
}

test('the curve is EASE_OUT until someone says otherwise', () => {
  assert.deepEqual(transitionOf({}).easing, { type: 'EASE_OUT' })
  assert.deepEqual(transitionOf({ easing: 'GENTLE' }).easing, { type: 'GENTLE' })
  // A prompt does not shout.
  assert.deepEqual(transitionOf({ easing: 'ease-in-and-out' }).easing, { type: 'EASE_IN_AND_OUT' })
})

test('a curve of your own is four numbers, a spring is three', () => {
  assert.deepEqual(transitionOf({ bezier: [0.2, 0, 0, 1] }).easing, {
    type: 'CUSTOM_CUBIC_BEZIER',
    easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0, y2: 1 },
  })
  assert.deepEqual(transitionOf({ spring: { mass: 1, stiffness: 300, damping: 20 } }).easing, {
    type: 'CUSTOM_SPRING',
    easingFunctionSpring: { mass: 1, stiffness: 300, damping: 20, initialVelocity: 0 },
  })
})

test('naming a curve and numbers that disagree is refused rather than resolved', () => {
  // Which one was meant is a guess, and a wrong guess is invisible until someone plays it.
  assert.match(
    planProps({ links: [{ to: '1:2', animation: 'DISSOLVE', easing: 'BOUNCY', bezier: [0, 0, 1, 1] }] }).problems[0],
    /say different things — pass one/
  )
  assert.match(
    planProps({ links: [{ to: '1:2', bezier: [0, 0, 1, 1], spring: { mass: 1, stiffness: 1, damping: 1 } }] }).problems[0],
    /either a bezier or a spring, not both/
  )
  assert.match(planProps({ links: [{ to: '1:2', easing: 'SPRINGY' }] }).problems[0], /easing must be one of/)
  assert.match(planProps({ links: [{ to: '1:2', bezier: [0, 1] }] }).problems[0], /bezier must be \[x1, y1, x2, y2\]/)
  assert.match(
    planProps({ links: [{ to: '1:2', spring: { mass: 0, stiffness: 1, damping: 1 } }] }).problems[0],
    /spring.mass must be a number > 0/
  )
})

test('matching layers is a directional thing, and it shows in the line', () => {
  const step = linkStep([{ to: '1:2', animation: 'PUSH_LEFT', matchLayers: true, easing: 'BOUNCY' }])
  const transition = (step.reactions[0].actions![0] as { transition: Record<string, unknown> }).transition
  assert.equal(transition.matchLayers, true)
  assert.equal(step.summary, 'click → 1:2 PUSH_LEFT 0.3s BOUNCY +match')
})

test('the new triggers carry what they need, and say so when read', () => {
  const keyed = linkStep([{ on: 'keyDown', keys: [13], to: '1:2' }])
  assert.deepEqual(keyed.reactions[0].trigger, { type: 'ON_KEY_DOWN', device: 'KEYBOARD', keyCodes: [13] })
  assert.equal(keyed.summary, 'keyDown [13] → 1:2')

  const hovered = linkStep([{ on: 'mouseEnter', delay: 0.2, to: '1:2' }])
  // No `deprecatedVersion`, whatever the typings say: the running host refuses the key outright.
  assert.deepEqual(hovered.reactions[0].trigger, { type: 'MOUSE_ENTER', delay: 0.2 })
  assert.equal(hovered.summary, 'mouseEnter 0.2s → 1:2')

  assert.match(planProps({ links: [{ on: 'keyDown', to: '1:2' }] }).problems[0], /keyDown needs keys/)
})

test('arriving fresh is asked for per link, and only when asked', () => {
  const plain = linkStep([{ to: '1:2' }]).reactions[0].actions![0] as Record<string, unknown>
  assert.equal('resetScrollPosition' in plain, false)
  const fresh = linkStep([{ to: '1:2', resetScroll: true, resetInteractive: false }]).reactions[0].actions![0] as Record<string, unknown>
  assert.equal(fresh.resetScrollPosition, true)
  assert.equal(fresh.resetInteractiveComponents, false)
  assert.equal('resetVideoPosition' in fresh, false)
})

test('a scrolling frame is two words', () => {
  assert.deepEqual(planProps({ scroll: 'vertical', fixedChildren: 1 }).steps, [
    { step: 'assign', property: 'overflowDirection', value: 'VERTICAL' },
    { step: 'assign', property: 'numberOfFixedChildren', value: 1 },
  ])
  assert.match(planProps({ scroll: 'sideways' }).problems[0], /scroll must be one of: NONE, HORIZONTAL/)
})

test('a duration read back from Figma is not printed as 32-bit noise', () => {
  // Figma stores seconds as floats: 0.6 comes back as 0.6000000238418579.
  const line = describeLinks([
    {
      trigger: { type: 'AFTER_TIMEOUT', timeout: 0.20000000298023224 },
      actions: [
        {
          type: 'NODE',
          destinationId: '1:2',
          navigation: 'NAVIGATE',
          transition: { type: 'DISSOLVE', easing: { type: 'EASE_OUT' }, duration: 0.6000000238418579 },
        },
      ],
    },
  ])
  assert.equal(line, 'timeout 0.2s → 1:2 DISSOLVE 0.6s')
})
