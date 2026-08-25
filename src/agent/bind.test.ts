import test from 'node:test'
import assert from 'node:assert/strict'
import { BINDABLE_FIELDS, bindFieldType, expandBindField } from './write-ops.ts'

test('a group field expands to the fields the API actually takes', () => {
  assert.deepEqual(expandBindField('cornerRadius'), [
    'topLeftRadius',
    'topRightRadius',
    'bottomLeftRadius',
    'bottomRightRadius',
  ])
  assert.deepEqual(expandBindField('padding'), ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'])
})

test('a plain field stands for itself', () => {
  assert.deepEqual(expandBindField('width'), ['width'])
  assert.deepEqual(expandBindField('fill'), ['fill'])
})

test('every field declares the variable type it takes', () => {
  assert.equal(bindFieldType('fill'), 'COLOR')
  assert.equal(bindFieldType('stroke'), 'COLOR')
  assert.equal(bindFieldType('itemSpacing'), 'FLOAT')
  assert.equal(bindFieldType('characters'), 'STRING')
  assert.equal(bindFieldType('visible'), 'BOOLEAN')
})

test('an unbindable field is refused rather than passed to the API blind', () => {
  assert.equal(bindFieldType('rotation'), null)
  assert.equal(bindFieldType(''), null)
})

test('a group name is advertised but is not itself typed — it only expands', () => {
  assert.ok(BINDABLE_FIELDS.includes('cornerRadius'), 'cornerRadius is not offered to agents')
  assert.equal(bindFieldType('cornerRadius'), null)
  for (const field of expandBindField('cornerRadius')) {
    assert.equal(bindFieldType(field), 'FLOAT', `${field} lost its type`)
  }
})

test('every advertised field either expands or is directly bindable', () => {
  for (const field of BINDABLE_FIELDS) {
    const expanded = expandBindField(field)
    const resolvable = expanded.every((one) => bindFieldType(one) !== null)
    assert.ok(resolvable, `"${field}" is advertised but nothing can bind it`)
  }
})
