import test from 'node:test'
import assert from 'node:assert/strict'
import { FILE_ENVELOPE, isFileEnvelope, isSafeFileName, slugify, textFile } from './files.ts'

test('a file name may not climb out of the directory the bridge picks', () => {
  assert.equal(isSafeFileName('board.png'), true)
  assert.equal(isSafeFileName('a_b-c.1.css'), true)
  assert.equal(isSafeFileName('../secret'), false)
  assert.equal(isSafeFileName('nested/file.png'), false)
  assert.equal(isSafeFileName('.bashrc'), false)
  assert.equal(isSafeFileName(''), false)
  assert.equal(isSafeFileName('x'.repeat(129)), false)
})

test('textFile refuses a name it would not be safe to write', () => {
  assert.throws(() => textFile('../escape.css', 'text/css', 'body{}'), /unsafe file name/)
})

test('an envelope is recognised by its marker, not by shape alone', () => {
  assert.equal(isFileEnvelope(textFile('a.css', 'text/css', 'body{}')), true)
  assert.equal(isFileEnvelope({ name: 'a.css', data: 'body{}' }), false)
  assert.equal(isFileEnvelope({ [FILE_ENVELOPE]: { name: 'a.css' } }), false)
  assert.equal(isFileEnvelope(null), false)
  assert.equal(isFileEnvelope('a.css'), false)
})

test('a text envelope carries its bytes verbatim', () => {
  const file = textFile('design.css', 'text/css', ':root{--x:1px}')
  assert.deepEqual(file[FILE_ENVELOPE], {
    name: 'design.css',
    mime: 'text/css',
    encoding: 'utf8',
    data: ':root{--x:1px}',
  })
})

test('a layer name becomes a file name without ever becoming empty', () => {
  assert.equal(slugify('Board Column Header'), 'board-column-header')
  assert.equal(slugify('  --Card / Large--  '), 'card-large')
  assert.equal(slugify('🌅'), 'node')
  assert.equal(slugify('', 'frame'), 'frame')
  assert.equal(slugify('x'.repeat(80)).length, 48)
})
