/**
 * Just enough PNG to stitch screenshots: decode Chrome's output (8-bit RGB or RGBA,
 * non-interlaced, any row filter) and encode RGBA. node:zlib does the compression, so the
 * fidelity run still needs no npm packages.
 */

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** → { width, height, data } with data as RGBA, 4 bytes a pixel. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      colorType = body[9]
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || body[12] !== 0) {
        throw new Error(`unsupported PNG: depth ${depth}, colour type ${colorType}, interlace ${body[12]}`)
      }
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const bpp = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const rows = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = rows.subarray(y * stride, (y + 1) * stride)
    const up = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0
      const b = up ? up[x] : 0
      const c = up && x >= bpp ? up[x - bpp] : 0
      const v = src[x]
      out[x] = (filter === 0 ? v : filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 0xff
    }
  }
  if (bpp === 4) return { width, height, data: rows }
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0, j = 0; i < rows.length; i += 3, j += 4) {
    data[j] = rows[i]
    data[j + 1] = rows[i + 1]
    data[j + 2] = rows[i + 2]
    data[j + 3] = 255
  }
  return { width, height, data }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/** RGBA → PNG, every row unfiltered: screenshots compress well enough as they are. */
export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

/** Tiles of the same width, each placed at its y, into one picture `height` tall. */
export function stitch(tiles, width, height) {
  const data = Buffer.alloc(width * height * 4)
  for (const { y, png } of tiles) {
    const tile = decodePng(png)
    const rows = Math.min(tile.height, height - y)
    for (let r = 0; r < rows; r++) {
      tile.data.copy(data, (y + r) * width * 4, r * tile.width * 4, r * tile.width * 4 + Math.min(tile.width, width) * 4)
    }
  }
  return encodePng({ width, height, data })
}
