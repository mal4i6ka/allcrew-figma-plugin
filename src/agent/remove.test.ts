import test from 'node:test'
import assert from 'node:assert/strict'
import { screenRemoval } from './remove-ops.ts'

/* Deleting is the one write with no `before` to read back afterwards, so its policy is a
 * screen that runs before anything is touched. These tests pin the refusals — each one exists
 * because the alternative is damage that cannot be inspected, only rediscovered. */

test('a page is refused outright — force does not open that door', () => {
  assert.throws(() => screenRemoval({ type: 'PAGE', name: 'Foundation' }, false), /PAGE cannot be deleted/)
  assert.throws(() => screenRemoval({ type: 'PAGE', name: 'Foundation' }, true), /PAGE cannot be deleted/)
  assert.throws(() => screenRemoval({ type: 'DOCUMENT' }, true), /DOCUMENT cannot be deleted/)
})

test('a main component is refused without force, and the message says why', () => {
  // The damage is remote: instances of it sit on pages this call never walked, and they break
  // where nobody is looking. That is the whole reason the refusal is not a warning.
  assert.throws(
    () => screenRemoval({ type: 'COMPONENT', name: 'Button' }, false),
    /Button is a COMPONENT.*instances elsewhere would break.*force: true/s
  )
  assert.throws(
    () => screenRemoval({ type: 'COMPONENT_SET', name: 'Card_Input' }, false),
    /Card_Input is a COMPONENT_SET/
  )
})

test('force allows a component, because sometimes deleting the main IS the intent', () => {
  assert.doesNotThrow(() => screenRemoval({ type: 'COMPONENT', name: 'Button' }, true))
  assert.doesNotThrow(() => screenRemoval({ type: 'COMPONENT_SET', name: 'Card_Input' }, true))
})

test('ordinary nodes need no force — an instance or a frame is a copy, not a source', () => {
  for (const type of ['FRAME', 'INSTANCE', 'GROUP', 'TEXT', 'VECTOR', 'SECTION']) {
    assert.doesNotThrow(() => screenRemoval({ type, name: 'x' }, false), `${type} should pass`)
  }
})

test('a nameless node still names its type in the refusal', () => {
  // Rows are hand-typed; a message that says only "undefined is a COMPONENT" wastes the report.
  assert.throws(() => screenRemoval({ type: 'COMPONENT' }, false), /COMPONENT is a COMPONENT/)
})
