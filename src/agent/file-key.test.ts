import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error — the CLI is plain JS, imported for the one pure helper it exports.
import { fileKeyFrom } from '../../agent/allcrew-channel.mjs'

test('a file key is pulled out of any Figma URL an agent might be handed', () => {
  assert.equal(fileKeyFrom('https://www.figma.com/design/AbC123/AllCrew-Figma-Workspace?node-id=676-9581'), 'AbC123')
  assert.equal(fileKeyFrom('https://www.figma.com/file/XyZ789/Old-Style'), 'XyZ789')
  assert.equal(fileKeyFrom('https://www.figma.com/proto/Qq11/Proto?page-id=0'), 'Qq11')
  assert.equal(fileKeyFrom('https://www.figma.com/board/Bd22/Jam'), 'Bd22')
})

test('a bare key passes through, trimmed', () => {
  assert.equal(fileKeyFrom('AbC123'), 'AbC123')
  assert.equal(fileKeyFrom('  AbC123  '), 'AbC123')
})

test('nothing in yields nothing out rather than a bad request', () => {
  assert.equal(fileKeyFrom(''), '')
  assert.equal(fileKeyFrom(undefined), '')
  assert.equal(fileKeyFrom(null), '')
})
