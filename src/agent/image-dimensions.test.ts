import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageAlpha, imageDimensions } from './image-dimensions.ts'

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

/* ------------------------------------------------------------------- alpha */

/** A PNG header with a chosen colour type, optionally followed by a tRNS chunk. */
const pngWith = (colourType: number, chunks: string[] = []) => {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
  const ihdr = [0, 0, 0, 16, 0, 0, 0, 16, 8, colourType, 0, 0, 0, 0, 0, 0, 0]
  const rest: number[] = []
  for (const name of chunks) {
    rest.push(0, 0, 0, 0)
    for (const ch of name) rest.push(ch.charCodeAt(0))
    rest.push(0, 0, 0, 0)
  }
  return new Uint8Array([...head, ...ihdr, ...rest])
}

test('a png says whether it can hold transparency, palette included', () => {
  // The case that mattered on a real file: a palette PNG cut-out, transparent through tRNS.
  assert.equal(imageAlpha(pngWith(3, ['tRNS', 'IDAT'])), 'alpha')
  assert.equal(imageAlpha(pngWith(3, ['IDAT'])), 'none')
  assert.equal(imageAlpha(pngWith(6)), 'alpha')
  assert.equal(imageAlpha(pngWith(4)), 'alpha')
  assert.equal(imageAlpha(pngWith(2, ['IDAT'])), 'none')
})

test('a jpeg never holds transparency, and says so rather than shrugging', () => {
  const jpeg = new Uint8Array(40)
  jpeg[0] = 0xff
  jpeg[1] = 0xd8
  assert.equal(imageAlpha(jpeg), 'none')
})

test('webp answers from the flag its container carries', () => {
  const webp = (chunk: string, flagByte: number, at: number) => {
    const b = new Uint8Array(40)
    b.set([0x52, 0x49, 0x46, 0x46])
    b[8] = 0x57
    for (let i = 0; i < 4; i++) b[12 + i] = chunk.charCodeAt(i)
    b[at] = flagByte
    return b
  }
  assert.equal(imageAlpha(webp('VP8X', 0x10, 20)), 'alpha')
  assert.equal(imageAlpha(webp('VP8X', 0x00, 20)), 'none')
  assert.equal(imageAlpha(webp('VP8L', 0x10, 24)), 'alpha')
  assert.equal(imageAlpha(webp('VP8 ', 0x00, 20)), 'none')
})

test('a format this reader cannot judge says unknown instead of none', () => {
  // A GIF keeps transparency in an extension block anywhere in the stream; "none" would be a
  // claim, and a consumer would place a cut-out as if it were a photograph.
  const gif = new Uint8Array(40)
  gif.set([0x47, 0x49, 0x46, 0x38])
  assert.equal(imageAlpha(gif), 'unknown')
  assert.equal(imageAlpha(new Uint8Array(4)), 'unknown')
})
