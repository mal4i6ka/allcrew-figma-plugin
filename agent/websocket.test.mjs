import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  MAX_WEBSOCKET_MESSAGE,
  WebSocketPeer,
  encodeFrame,
  websocketAccept,
} from './websocket.mjs'

class Socket extends EventEmitter {
  constructor() { super(); this.writes = []; this.destroyed = false; this.ended = false }
  write(value) { this.writes.push(Buffer.from(value)); return true }
  end() { this.ended = true }
  destroy() { this.destroyed = true }
}

const clientFrame = (payload, options = {}) => encodeFrame(payload, {
  masked: true,
  maskKey: Buffer.from([1, 2, 3, 4]),
  ...options,
})

test('WebSocket accept key matches RFC 6455', () => {
  assert.equal(
    websocketAccept('dGhlIHNhbXBsZSBub25jZQ=='),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
  )
})

test('server frames encode 7, 16 and 64 bit lengths', () => {
  assert.equal(encodeFrame('x'.repeat(125))[1] & 0x7f, 125)
  assert.equal(encodeFrame('x'.repeat(126))[1] & 0x7f, 126)
  assert.equal(encodeFrame('x'.repeat(70_000))[1] & 0x7f, 127)
})

test('a masked JSON frame split across TCP chunks is reassembled', () => {
  const socket = new Socket()
  const messages = []
  const peer = new WebSocketPeer(socket, { onMessage: (message) => messages.push(message) })
  const frame = clientFrame(JSON.stringify({ type: 'result', body: { ok: true } }))
  peer.feed(frame.subarray(0, 3))
  peer.feed(frame.subarray(3, 11))
  peer.feed(frame.subarray(11))
  assert.deepEqual(messages, [{ type: 'result', body: { ok: true } }])
})

test('fragmentation survives a ping in the middle and returns a pong', () => {
  const socket = new Socket()
  const messages = []
  const peer = new WebSocketPeer(socket, { onMessage: (message) => messages.push(message) })
  peer.feed(clientFrame('{"value":', { opcode: 0x1, fin: false }))
  peer.feed(clientFrame('ping', { opcode: 0x9 }))
  peer.feed(clientFrame('42}', { opcode: 0x0, fin: true }))
  assert.deepEqual(messages, [{ value: 42 }])
  assert.equal(socket.writes.length, 1)
  assert.equal(socket.writes[0][0] & 0x0f, 0x0a)
})

test('an unmasked client frame is a protocol error', () => {
  const socket = new Socket()
  const peer = new WebSocketPeer(socket)
  peer.feed(encodeFrame('{"x":1}'))
  assert.equal(peer.closed, true)
  assert.equal(socket.ended, true)
  assert.equal(socket.writes[0][0] & 0x0f, 0x08)
})

test('a declared message beyond 16 MiB is closed before its body is buffered', () => {
  const socket = new Socket()
  const peer = new WebSocketPeer(socket)
  const header = Buffer.alloc(14)
  header[0] = 0x81
  header[1] = 0x80 | 127
  header.writeBigUInt64BE(BigInt(MAX_WEBSOCKET_MESSAGE + 1), 2)
  header.writeUInt32BE(0x01020304, 10)
  peer.feed(header)
  assert.equal(peer.closed, true)
  assert.equal(socket.writes[0][0] & 0x0f, 0x08)
})
