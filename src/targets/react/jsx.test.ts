import test from 'node:test'
import assert from 'node:assert/strict'
import { componentName, emitJsx, newContext, propName } from './jsx.ts'

test('a Figma name becomes an identifier a compiler accepts', () => {
  assert.equal(componentName('Cards List Status'), 'CardsListStatus')
  assert.equal(componentName('list-Item-InTheMiddle-Contents'), 'ListItemInTheMiddleContents')
  // A component named "3-rd party" is not `3RdParty`.
  assert.equal(componentName('3-rd party'), 'C3RdParty')
})

test('a layer named after what it says still makes a prop', () => {
  assert.equal(propName('Label text'), 'labelText')
  assert.equal(propName('Has dot#15591:36'), 'hasDot')
  // "373,00" is a good layer name and a syntax error as a prop.
  assert.equal(propName('373,00'), 'value37300')
  assert.equal(propName('•'), 'value')
})

test('a text wears the class its typography is written in', () => {
  const text = {
    id: '1:2',
    name: 'Amount',
    type: 'text',
    characters: '373,00 €',
  } as unknown as Parameters<typeof emitJsx>[0]

  const context = newContext('payment')
  context.segments = new Map([['n1-2', 1]])
  const markup = emitJsx(text, context, 0)
  // Everything the text looks like — font, size, weight, colour — is in the segment rule. The
  // markup that wore only the box class rendered the whole screen in the browser's default 16px.
  assert.match(markup, /styles\["n1-2--segment-0"\]/)

  // Nothing to wear when the stylesheet has no such rule.
  const bare = newContext('payment')
  bare.segments = new Map()
  assert.doesNotMatch(emitJsx(text, bare, 0), /segment/)
})

test('a text of several styles says which one survived', () => {
  const text = {
    id: '1:3',
    name: 'Balance',
    type: 'text',
    characters: 'Баланс: 5 125,17 EUR',
  } as unknown as Parameters<typeof emitJsx>[0]

  const context = newContext('payment')
  context.segments = new Map([['n1-3', 2]])
  emitJsx(text, context, 0)
  assert.equal(context.gaps.length, 1)
  assert.match(context.gaps[0], /2 differently-styled runs/)
})

test('a prop is passed only when the component means the same thing by the name', () => {
  const instance = {
    id: '1:4',
    name: 'Row',
    type: 'instance-ref',
    componentSetName: 'List-Items-Title',
    componentProperties: { 'Subtitle#1:1': { type: 'BOOLEAN', value: false } },
    children: [],
  } as unknown as Parameters<typeof emitJsx>[0]

  const context = newContext('payment')
  context.declares = new Map([['ListItemsTitle', new Map([['subtitle', 'boolean' as const]])]])
  assert.match(emitJsx(instance, context, 0), /subtitle=\{false\}/)

  // The same name declared as a text: the boolean is not sent, and the drop is reported rather
  // than left for a developer to notice on the screen.
  const other = newContext('payment')
  other.declares = new Map([['ListItemsTitle', new Map([['subtitle', 'text' as const]])]])
  const markup = emitJsx(instance, other, 0)
  assert.doesNotMatch(markup, /subtitle/)
  assert.match(other.gaps[0], /declares a text of that name/)
})
