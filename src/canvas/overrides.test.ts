import test from 'node:test'
import assert from 'node:assert/strict'
import { addressIn } from './overrides.ts'

test('an override addresses the same path in any instance of the component', () => {
  // This is the whole reason an override read on one instance can be applied to a copy: the
  // child's id is the instance's id and then the component child's, which does not change.
  assert.equal(addressIn({ id: '15595:92877' } as SceneNode, '4530:298013'), 'I15595:92877;4530:298013')
})

test('an instance inside an instance keeps the chain rather than starting a new one', () => {
  assert.equal(addressIn({ id: 'I15595:92877;1820:18058' } as SceneNode, '4518:286745'), 'I15595:92877;1820:18058;4518:286745')
})
