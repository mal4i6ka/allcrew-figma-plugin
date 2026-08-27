import test from 'node:test'
import assert from 'node:assert/strict'
import { isOwnOverride } from './write-ops.ts'

/* The whole safety of `variables.rebind overrides: true` rests on this one comparison: edit a
 * binding the instance owns, never write over one it merely inherits. Writing over an inherited
 * binding would mint an override per instance — the thing the walk avoids by skipping instance
 * children in the first place. */

test('a sublayer binding that differs from its main is the instance own override', () => {
  assert.equal(isOwnOverride('VariableID:1:2', 'VariableID:9:9'), true)
})

test('a binding equal to the main is inherited — writing there would mint an override', () => {
  assert.equal(isOwnOverride('VariableID:1:2', 'VariableID:1:2'), false)
})

test('main binds nothing while the sublayer does — still the instance own', () => {
  // Happens when someone bound a colour on the instance that the component never bound at all.
  assert.equal(isOwnOverride('VariableID:1:2', undefined), true)
})

test('an empty alias is never an override — there is nothing to repoint', () => {
  assert.equal(isOwnOverride('', undefined), false)
  assert.equal(isOwnOverride('', 'VariableID:1:2'), false)
})
