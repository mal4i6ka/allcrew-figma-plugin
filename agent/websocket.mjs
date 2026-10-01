import crypto from 'node:crypto'

export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const MAX_WEBSOCKET_MESSAGE = 16 * 1024 * 1024

export function websocketAccept(key) {
  return crypto.createHash('sha1').update(String(key) + WEBSOCKET_GUID).digest('base64')
}

export function encodeFrame(payload, { opcode = 0x1, fin = true, masked = false, maskKey } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload))
  let lengthBytes = 0
  if (body.length >= 126 && body.length <= 0xffff) lengthBytes = 2
  else if (body.length > 0xffff) lengthBytes = 8
  const maskBytes = masked ? 4 : 0
  const frame = Buffer.alloc(2 + lengthBytes + maskBytes + body.length)
  frame[0] = (fin ? 0x80 : 0) | (opcode & 0x0f)
  let offset = 2
  if (lengthBytes === 0) frame[1] = (masked ? 0x80 : 0) | body.length
  else if (lengthBytes === 2) {
    frame[1] = (masked ? 0x80 : 0) | 126
    frame.writeUInt16BE(body.length, offset)
    offset += 2
  } else {
    frame[1] = (masked ? 0x80 : 0) | 127
    frame.writeBigUInt64BE(BigInt(body.length), offset)
    offset += 8
  }
  const key = masked ? (maskKey ? Buffer.from(maskKey) : crypto.randomBytes(4)) : null
  if (key) {
    if (key.length !== 4) throw new Error('mask key must be four bytes')
    key.copy(frame, offset)
    offset += 4
  }
  for (let index = 0; index < body.length; index++) {
    frame[offset + index] = key ? body[index] ^ key[index % 4] : body[index]
  }
  return frame
}

function closePayload(code, reason) {
  const text = Buffer.from(String(reason || '')).subarray(0, 123)
  const payload = Buffer.alloc(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return payload
}

export class WebSocketPeer {
  constructor(socket, { maxMessage = MAX_WEBSOCKET_MESSAGE, requireMasked = true, onMessage, onClose, onPong } = {}) {
    this.socket = socket
    this.maxMessage = maxMessage
    this.requireMasked = requireMasked
    this.onMessage = onMessage || (() => {})
    this.onClose = onClose || (() => {})
    this.onPong = onPong || (() => {})
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentBytes = 0
    this.fragmentOpcode = null
    this.closed = false
    socket.on('data', (chunk) => this.feed(chunk))
    socket.on('close', () => this.finish())
    socket.on('error', () => this.finish())
  }

  send(payload, opcode = 0x1) {
    if (this.closed || this.socket.destroyed) return false
    this.socket.write(encodeFrame(payload, { opcode }))
    return true
  }

  sendJson(value) { return this.send(JSON.stringify(value), 0x1) }
  ping(payload = '') { return this.send(payload, 0x9) }

  close(code = 1000, reason = '') {
    if (this.closed) return
    this.send(closePayload(code, reason), 0x8)
    this.closed = true
    this.socket.end()
    this.onClose()
  }

  finish() {
    if (this.closed) return
    this.closed = true
    this.onClose()
  }

  protocolError(message, code = 1002) {
    this.close(code, message)
  }

  feed(chunk) {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
    while (!this.closed) {
      if (this.buffer.length < 2) return
      const first = this.buffer[0]
      const second = this.buffer[1]
      const fin = (first & 0x80) !== 0
      const rsv = first & 0x70
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      if (rsv !== 0) return this.protocolError('reserved bits are unsupported')
      if (this.requireMasked && !masked) return this.protocolError('client frames must be masked')
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const wide = this.buffer.readBigUInt64BE(2)
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return this.protocolError('frame is too large', 1009)
        length = Number(wide)
        offset = 10
      }
      if ((opcode & 0x08) !== 0 && (!fin || length > 125)) return this.protocolError('invalid control frame')
      if (length > this.maxMessage) return this.protocolError('message is too large', 1009)
      const needed = offset + (masked ? 4 : 0) + length
      if (this.buffer.length < needed) return
      let mask = null
      if (masked) {
        mask = this.buffer.subarray(offset, offset + 4)
        offset += 4
      }
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      this.buffer = this.buffer.subarray(needed)
      if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
      this.frame(opcode, fin, payload)
    }
  }

  frame(opcode, fin, payload) {
    if (opcode === 0x8) {
      if (!this.closed) this.send(payload, 0x8)
      this.closed = true
      this.socket.end()
      this.onClose()
      return
    }
    if (opcode === 0x9) { this.send(payload, 0xa); return }
    if (opcode === 0xa) { this.onPong(payload); return }
    if (opcode === 0x2) return this.protocolError('binary messages are unsupported', 1003)
    if (opcode === 0x1) {
      if (this.fragmentOpcode !== null) return this.protocolError('new message before fragmented message completed')
      if (fin) return this.deliver(payload)
      this.fragmentOpcode = opcode
      this.fragments = [payload]
      this.fragmentBytes = payload.length
      return
    }
    if (opcode === 0x0) {
      if (this.fragmentOpcode === null) return this.protocolError('continuation without a message')
      this.fragments.push(payload)
      this.fragmentBytes += payload.length
      if (this.fragmentBytes > this.maxMessage) return this.protocolError('message is too large', 1009)
      if (!fin) return
      const complete = Buffer.concat(this.fragments, this.fragmentBytes)
      this.fragments = []
      this.fragmentBytes = 0
      this.fragmentOpcode = null
      return this.deliver(complete)
    }
    this.protocolError('unsupported opcode')
  }

  deliver(payload) {
    if (payload.length > this.maxMessage) return this.protocolError('message is too large', 1009)
    let value
    try { value = JSON.parse(payload.toString('utf8')) }
    catch { return this.protocolError('text message is not valid JSON', 1007) }
    this.onMessage(value)
  }
}

export function acceptWebSocket(req, socket, head, handlers = {}) {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || key === '') throw new Error('missing Sec-WebSocket-Key')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`
  )
  const peer = new WebSocketPeer(socket, handlers)
  if (head && head.length > 0) peer.feed(head)
  return peer
}
