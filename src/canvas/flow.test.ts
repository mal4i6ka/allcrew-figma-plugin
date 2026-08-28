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

const only = (links: unknown) => linkStep(links).links[0]

/* ---------------------------------------------------------------------- links */

test('a click through to a screen is the whole of what a caller has to say', () => {
  const step = linkStep([{ to: '10:20' }])
  assert.deepEqual(step.links, [
    {
      trigger: { type: 'ON_CLICK' },
      actions: [{ kind: 'node', destinationId: '10:20', navigation: 'NAVIGATE', transition: null }],
    },
  ])
  // The destination is collected so the applier can refuse a link to nothing.
  assert.deepEqual(step.destinations, ['10:20'])
})

test('a direction is part of the animation name, not a fourth nested object', () => {
  assert.deepEqual(only([{ on: 'press', to: '1:2', animation: 'PUSH_LEFT', duration: 0.5 }]), {
    trigger: { type: 'ON_PRESS' },
    actions: [
      {
        kind: 'node',
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
})

test('back and close carry no destination, and are not case-sensitive', () => {
  assert.deepEqual(only([{ to: 'back' }]).actions, [{ kind: 'back' }])
  const step = linkStep([{ on: 'click', to: 'CLOSE' }])
  assert.deepEqual(step.links[0].actions, [{ kind: 'close' }])
  assert.deepEqual(step.destinations, [], 'nothing to check for existence')
})

test('time is said in seconds and stored in milliseconds, because Figma is inconsistent about it', () => {
  // The Trigger docs say `timeout` and `delay` are milliseconds; the Transition example shows a
  // duration of 0.20000000298023224, which is seconds. Passing that on would have callers
  // writing 2 in one field and 2000 in the next.
  assert.deepEqual(only([{ on: 'timeout', after: 2.5, to: '1:2' }]).trigger, { type: 'AFTER_TIMEOUT', timeout: 2500 })
  assert.deepEqual(only([{ on: 'mouseEnter', delay: 0.2, to: '1:2' }]).trigger, { type: 'MOUSE_ENTER', delay: 200 })
  // A transition's duration is left alone, because that one really is seconds.
  const action = only([{ to: '1:2', animation: 'DISSOLVE', duration: 0.4 }]).actions[0] as { transition: { duration: number } }
  assert.equal(action.transition.duration, 0.4)
})

test('an empty list is a caller removing every link, not a mistake', () => {
  assert.deepEqual(linkStep([]).links, [])
})

/* ------------------------------------------------------- actions, not just going */

test('one interaction may set a variable, switch a mode and then navigate', () => {
  // Which is what "remember that they agreed and go to the next screen" means, and what Figma's
  // own panel offers.
  const link = only([
    {
      to: '1:2',
      set: { variable: 'flags/agreed', value: true },
      mode: { collection: 'Semantic', mode: 'Dark' },
    },
  ])
  assert.deepEqual(link.actions, [
    { kind: 'setVariable', variable: 'flags/agreed', value: true },
    { kind: 'setMode', collection: 'Semantic', mode: 'Dark' },
    { kind: 'node', destinationId: '1:2', navigation: 'NAVIGATE', transition: null },
  ])
})

test('a variable may be set from another variable rather than a literal', () => {
  assert.deepEqual(only([{ set: { variable: 'theme/current', value: { variable: 'theme/next' } } }]).actions, [
    { kind: 'setVariable', variable: 'theme/current', value: { variable: 'theme/next' } },
  ])
})

test('a link that goes nowhere and does nothing is refused', () => {
  assert.match(planProps({ links: [{ on: 'click' }] }).problems[0], /must do something — name a `to`, a `set`/)
})

test('opening a link is an action too, in a new tab unless told otherwise', () => {
  assert.deepEqual(only([{ url: 'https://altery.com' }]).actions, [
    { kind: 'url', url: 'https://altery.com', newTab: true },
  ])
  assert.equal((only([{ url: 'https://altery.com', newTab: false }]).actions[0] as { newTab: boolean }).newTab, false)
})

test('every way of getting an action wrong is named', () => {
  assert.match(planProps({ links: [{ set: { value: 1 } }] }).problems[0], /set.variable must name a variable/)
  assert.match(
    planProps({ links: [{ set: { variable: 'x', value: [] } }] }).problems[0],
    /set.value must be a string, a number, a boolean, or \{ variable \}/
  )
  assert.match(planProps({ links: [{ mode: { collection: 'Semantic' } }] }).problems[0], /mode must be \{ collection/)
  assert.match(planProps({ links: [{ url: '' }] }).problems[0], /url must be a link to open/)
})

/* ------------------------------------------------------------------- refusals */

test('every way of getting a link wrong is named, with what was accepted', () => {
  assert.match(planProps({ links: {} }).problems[0], /must be an array of \{ on, to \} links/)
  assert.match(planProps({ links: [{ to: '1:2', on: 'tap' }] }).problems[0], /on must be one of: click, hover/)
  assert.match(planProps({ links: [{ to: '', on: 'click' }] }).problems[0], /to must be a node id/)
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

/* -------------------------------------------------------------------- motion */

const transitionOf = (link: Record<string, unknown>) => {
  const action = only([{ to: '1:2', animation: 'SMART_ANIMATE', ...link }]).actions[0]
  return (action as { transition: Record<string, unknown> }).transition
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

test('matching layers is a directional thing', () => {
  assert.equal(transitionOf({ animation: 'PUSH_LEFT', matchLayers: true }).matchLayers, true)
})

test('the new triggers carry what they need', () => {
  assert.deepEqual(only([{ on: 'keyDown', keys: [13], to: '1:2' }]).trigger, {
    type: 'ON_KEY_DOWN',
    device: 'KEYBOARD',
    keyCodes: [13],
  })
  // No `deprecatedVersion`, whatever the docs and typings say: the running host refuses the key.
  assert.deepEqual(only([{ on: 'mouseEnter', delay: 0.2, to: '1:2' }]).trigger, { type: 'MOUSE_ENTER', delay: 200 })
  assert.match(planProps({ links: [{ on: 'keyDown', to: '1:2' }] }).problems[0], /keyDown needs keys/)
})

test('arriving fresh is asked for per link, and only when asked', () => {
  const plain = only([{ to: '1:2' }]).actions[0] as Record<string, unknown>
  assert.equal('resetScroll' in plain, false)
  const fresh = only([{ to: '1:2', resetScroll: true, resetInteractive: false }]).actions[0] as Record<string, unknown>
  assert.equal(fresh.resetScroll, true)
  assert.equal(fresh.resetInteractive, false)
  assert.equal('resetVideo' in fresh, false)
})

test('a scrolling frame is two words', () => {
  assert.deepEqual(planProps({ scroll: 'vertical', fixedChildren: 1 }).steps, [
    { step: 'assign', property: 'overflowDirection', value: 'VERTICAL' },
    { step: 'assign', property: 'numberOfFixedChildren', value: 1 },
  ])
  assert.match(planProps({ scroll: 'sideways' }).problems[0], /scroll must be one of: NONE, HORIZONTAL/)
})

/* --------------------------------------------------------------- reading back */

test('reactions read back as the line a caller could have written', async () => {
  const line = await describeLinks([
    {
      trigger: { type: 'ON_CLICK' },
      actions: [
        {
          type: 'NODE',
          destinationId: '1:2',
          navigation: 'NAVIGATE',
          transition: { type: 'PUSH', direction: 'LEFT', matchLayers: true, easing: { type: 'BOUNCY' }, duration: 0.3 },
        },
      ],
    },
    { trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', destinationId: '3:4', navigation: 'OVERLAY', transition: null }] },
    { trigger: { type: 'ON_CLICK' }, action: { type: 'BACK' } },
  ])
  assert.equal(line, 'click → 1:2 PUSH_LEFT 0.3s BOUNCY +match · hover → 3:4 (OVERLAY) · click → back')
})

test('a variable action reads with names when the caller offers a lookup', async () => {
  const names: Record<string, string> = { 'VariableID:1': 'flags/agreed', 'VariableID:2': 'theme/next' }
  const lookup = async (id: string) => names[id] ?? null
  const line = await describeLinks(
    [
      {
        trigger: { type: 'ON_CLICK' },
        actions: [
          { type: 'SET_VARIABLE', variableId: 'VariableID:1', variableValue: { type: 'BOOLEAN', resolvedType: 'BOOLEAN', value: true } },
          {
            type: 'SET_VARIABLE',
            variableId: 'VariableID:1',
            variableValue: { type: 'VARIABLE_ALIAS', resolvedType: 'BOOLEAN', value: { type: 'VARIABLE_ALIAS', id: 'VariableID:2' } },
          },
          { type: 'URL', url: 'https://altery.com' },
        ],
      },
    ],
    lookup
  )
  assert.equal(line, 'click → set flags/agreed = true · click → set flags/agreed = var:theme/next · click → open https://altery.com')
})

test('without a lookup the id is printed rather than nothing', async () => {
  const line = await describeLinks([
    { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'SET_VARIABLE', variableId: 'VariableID:9', variableValue: { value: 3 } }] },
  ])
  assert.equal(line, 'click → set VariableID:9 = 3')
})

test('a timeout link says how long it waits — the wait is the whole of what it says', async () => {
  const line = await describeLinks([
    {
      trigger: { type: 'AFTER_TIMEOUT', timeout: 3000 },
      actions: [{ type: 'NODE', destinationId: '1:2', navigation: 'NAVIGATE', transition: null }],
    },
  ])
  assert.equal(line, 'timeout 3s → 1:2')
})

test('a duration read back from Figma is not printed as 32-bit noise', async () => {
  // Figma stores seconds as floats: 0.6 comes back as 0.6000000238418579.
  const line = await describeLinks([
    {
      trigger: { type: 'AFTER_TIMEOUT', timeout: 200 },
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

test('nothing to say reads as nothing, not as an empty structure', async () => {
  assert.equal(await describeLinks([]), '')
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

/* ---------------------------------------------------------------- conditions */

test('a question with two answers is one interaction with one conditional action', () => {
  const link = only([
    {
      on: 'click',
      if: { left: { variable: 'flags/agreed' }, is: '==', right: true },
      then: { to: '1:2' },
      else: { to: '3:4', animation: 'DISSOLVE' },
    },
  ])
  assert.equal(link.actions.length, 1)
  const conditional = link.actions[0] as Extract<(typeof link.actions)[number], { kind: 'conditional' }>
  assert.equal(conditional.kind, 'conditional')
  assert.deepEqual(conditional.blocks[0].condition, {
    fn: 'EQUALS',
    args: [
      { kind: 'variable', name: 'flags/agreed' },
      { kind: 'literal', value: true },
    ],
  })
  assert.deepEqual(conditional.blocks[0].actions, [
    { kind: 'node', destinationId: '1:2', navigation: 'NAVIGATE', transition: null },
  ])
  // The `else` block carries no condition — which is how Figma spells "otherwise".
  assert.equal(conditional.blocks[1].condition, undefined)
  assert.equal(conditional.blocks[1].actions.length, 1)
})

test('an else that asks another question is refused, because Figma cannot store one', () => {
  // Both spellings were tried against a real file. Three sibling blocks are ACCEPTED and
  // silently truncated to two with the middle condition dropped — the prototype then takes that
  // branch unconditionally. A conditional nested inside the else is refused outright:
  //   Invalid enum value. Expected 'BACK' | 'CLOSE', received 'CONDITIONAL'
  // So the chain is refused here, where the reason can be given.
  const problem = planProps({
    links: [
      {
        if: { left: { variable: 'plan/tier' }, is: '==', right: 'gold' },
        then: { to: '1:1' },
        else: {
          if: { left: { variable: 'plan/tier' }, is: '==', right: 'silver' },
          then: { to: '2:2' },
          else: { to: '3:3' },
        },
      },
    ],
  }).problems[0]
  assert.match(problem, /an `else` cannot ask another question/)
  assert.match(problem, /separate links on the same trigger/)
})

test('a branch may do anything a link may do, including setting state', () => {
  const link = only([
    {
      if: { left: { variable: 'count' }, is: '>=', right: 3 },
      then: { set: { variable: 'flags/limit', value: true }, to: '1:2' },
    },
  ])
  const conditional = link.actions[0] as Extract<(typeof link.actions)[number], { kind: 'conditional' }>
  assert.deepEqual(conditional.blocks[0].actions.map((one) => one.kind), ['setVariable', 'node'])
  assert.equal(conditional.blocks[0].condition?.fn, 'GREATER_THAN_OR_EQUAL')
})

test('two questions join with and / or', () => {
  const link = only([
    {
      if: {
        left: { left: { variable: 'a' }, is: '==', right: true },
        is: 'and',
        right: { left: { variable: 'b' }, is: '>', right: 2 },
      },
      then: { to: '1:2' },
    },
  ])
  const conditional = link.actions[0] as Extract<(typeof link.actions)[number], { kind: 'conditional' }>
  assert.equal(conditional.blocks[0].condition?.fn, 'AND')
  assert.equal(conditional.blocks[0].condition?.args[0].kind, 'condition')
})

test('every way of getting a condition wrong is named', () => {
  assert.match(planProps({ links: [{ if: { left: 1, is: '==', right: 2 } }] }).problems[0], /an `if` needs a `then`/)
  assert.match(
    planProps({ links: [{ if: { left: 1, is: 'roughly', right: 2 }, then: { to: '1:2' } }] }).problems[0],
    /is must be one of: ==/
  )
  assert.match(
    planProps({ links: [{ if: { left: [], is: '==', right: 2 }, then: { to: '1:2' } }] }).problems[0],
    /if.left must be a value, \{ variable \}, or another \{ left, is, right \}/
  )
  assert.match(planProps({ links: [{ if: 'agreed', then: { to: '1:2' } }] }).problems[0], /if must be \{ left, is, right \}/)
  // A branch that does nothing is as empty as a link that does nothing.
  assert.match(planProps({ links: [{ if: { left: 1, is: '==', right: 1 }, then: {} }] }).problems[0], /must do something/)
})

test('a conditional reads back as its shape rather than as its expression tree', async () => {
  const line = await describeLinks([
    {
      trigger: { type: 'ON_CLICK' },
      actions: [
        {
          type: 'CONDITIONAL',
          conditionalBlocks: [
            { condition: { type: 'EXPRESSION', resolvedType: 'BOOLEAN', value: { expressionFunction: 'EQUALS', expressionArguments: [] } }, actions: [] },
            { actions: [] },
          ],
        },
      ],
    },
  ])
  assert.equal(line, 'click → if {nothing} else {nothing}')
})

test('an else-if that Figma stored as a nested conditional reads back as three branches', async () => {
  // Figma does not keep a third block: it nests. Reading only the top level said "2" for a
  // sentence that plainly had three answers.
  const condition = { type: 'EXPRESSION', resolvedType: 'BOOLEAN', value: { expressionFunction: 'EQUALS', expressionArguments: [] } }
  const line = await describeLinks([
    {
      trigger: { type: 'ON_CLICK' },
      actions: [
        {
          type: 'CONDITIONAL',
          conditionalBlocks: [
            { condition, actions: [] },
            {
              actions: [
                {
                  type: 'CONDITIONAL',
                  conditionalBlocks: [{ condition, actions: [] }, { actions: [] }],
                },
              ],
            },
          ],
        },
      ],
    },
  ])
  // Nested or flat, it reads as the sentence somebody wrote — and each branch says what it does.
  assert.equal(line, 'click → if {nothing} else {else if {nothing} else {nothing}}')
})
