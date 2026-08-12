import test from 'node:test'
import assert from 'node:assert/strict'
import { mapTriggerToMechanism } from './triggers.ts'

test('ON_HOVER maps to the :hover pseudo-class', () => {
  assert.deepEqual(mapTriggerToMechanism({ type: 'ON_HOVER' }), { kind: 'css-pseudo-class', pseudoClass: 'hover' })
})

test('ON_PRESS and MOUSE_DOWN/MOUSE_UP map to the :active pseudo-class', () => {
  assert.deepEqual(mapTriggerToMechanism({ type: 'ON_PRESS' }), { kind: 'css-pseudo-class', pseudoClass: 'active' })
  assert.deepEqual(mapTriggerToMechanism({ type: 'MOUSE_DOWN', delay: 0 }), { kind: 'css-pseudo-class', pseudoClass: 'active' })
  assert.deepEqual(mapTriggerToMechanism({ type: 'MOUSE_UP', delay: 0 }), { kind: 'css-pseudo-class', pseudoClass: 'active' })
})

test('ON_CLICK maps to a click class toggle', () => {
  assert.deepEqual(mapTriggerToMechanism({ type: 'ON_CLICK' }), { kind: 'toggle-class', event: 'click' })
})

test('AFTER_TIMEOUT maps to a setTimeout delay, converting seconds to ms', () => {
  assert.deepEqual(mapTriggerToMechanism({ type: 'AFTER_TIMEOUT', timeout: 1.5 }), { kind: 'timeout', timeoutMs: 1500 })
})

test('MOUSE_ENTER/MOUSE_LEAVE fall back to a JS listener (no auto-revert like :hover)', () => {
  assert.deepEqual(mapTriggerToMechanism({ type: 'MOUSE_ENTER', delay: 0, deprecatedVersion: false }), {
    kind: 'js-listener',
    event: 'mouseenter',
  })
  assert.deepEqual(mapTriggerToMechanism({ type: 'MOUSE_LEAVE', delay: 0, deprecatedVersion: false }), {
    kind: 'js-listener',
    event: 'mouseleave',
  })
})

test('ON_KEY_DOWN and ON_DRAG fall back to a JS listener', () => {
  assert.deepEqual(mapTriggerToMechanism({ type: 'ON_KEY_DOWN', device: 'KEYBOARD', keyCodes: [13] }), {
    kind: 'js-listener',
    event: 'keydown',
  })
  assert.deepEqual(mapTriggerToMechanism({ type: 'ON_DRAG' }), { kind: 'js-listener', event: 'pointerdown' })
})
