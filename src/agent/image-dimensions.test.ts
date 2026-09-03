import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageDimensions } from './image-dimensions.ts'

const png = (w: number, h: number) => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, w)
  new DataView(b.buffer).setUint32(20, h)
  return b
}

test('png dimensions come from IHDR', () => {
  assert.deepEqual(imageDimensions(png(2952, 3198)), { width: 2952, height: 3198 })
})

test('jpeg dimensions come from the first start-of-frame segment', () => {
  // SOI, APP0 (length 16), SOF0 with height 788 and width 612.
  const b = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x14, 0x02, 0x64, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ])
  assert.deepEqual(imageDimensions(b), { width: 612, height: 788 })
})

test('webp VP8X extended header carries the canvas size', () => {
  const b = new Uint8Array(30)
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0])
  b[24] = 0x0f
  b[25] = 0x05 // 1295 + 1 = 1296
  b[27] = 0xa7
  b[28] = 0x02 // 679 + 1 = 680
  assert.deepEqual(imageDimensions(b), { width: 1296, height: 680 })
})

test('unknown or short data answers zeros instead of throwing', () => {
  assert.deepEqual(imageDimensions(new Uint8Array([1, 2, 3])), { width: 0, height: 0 })
  assert.deepEqual(imageDimensions(new Uint8Array(40)), { width: 0, height: 0 })
})
