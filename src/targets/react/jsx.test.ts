import test from 'node:test'
import assert from 'node:assert/strict'
import { componentName, propName } from './jsx.ts'

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
