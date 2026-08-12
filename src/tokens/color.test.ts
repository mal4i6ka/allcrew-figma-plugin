import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BLACK,
  WHITE,
  clampToGamut,
  contrastRatio,
  formatHex,
  hexToOklch,
  maxChroma,
  mixRgb,
  oklchToHex,
  parseHex,
  readableInk,
  rgbToOklch,
} from './color.ts'

test('parses shorthand and full hex, and round-trips through formatting', () => {
  assert.deepEqual(parseHex('#fff'), { r: 1, g: 1, b: 1 })
  assert.equal(formatHex(parseHex('#FB5B0A')!), '#FB5B0A')
  assert.equal(formatHex(parseHex('2364aa')!), '#2364AA')
  assert.equal(parseHex('#12345'), null)
  assert.equal(parseHex('nope'), null)
})

test('OKLCH round-trips every channel of a saturated color', () => {
  for (const hex of ['#FB5B0A', '#2364AA', '#00FF00', '#123456', '#FFFFFF', '#000000']) {
    assert.equal(oklchToHex(hexToOklch(hex)!), hex, `round trip failed for ${hex}`)
  }
})

test('white and black land on the ends of the lightness axis with no chroma', () => {
  const white = rgbToOklch(WHITE)
  const black = rgbToOklch(BLACK)
  assert.ok(Math.abs(white.l - 1) < 1e-6, `white L was ${white.l}`)
  assert.ok(white.c < 1e-6)
  assert.ok(Math.abs(black.l) < 1e-6, `black L was ${black.l}`)
})

test('equal OKLCH lightness reads as equal lightness across hues — the HSL failure mode', () => {
  // In HSL, yellow and blue at L=50% differ hugely in perceived brightness. In OKLab the
  // same L must produce the same relative luminance ordering, within a narrow band.
  const yellow = clampToGamut({ l: 0.7, c: 0.12, h: 100 })
  const blue = clampToGamut({ l: 0.7, c: 0.12, h: 260 })
  assert.ok(Math.abs(yellow.l - blue.l) < 1e-9)
  const ratio = contrastRatio(parseHex(oklchToHex(yellow))!, parseHex(oklchToHex(blue))!)
  assert.ok(ratio < 1.35, `same-L hues should not differ much in contrast, got ${ratio}`)
})

test('maxChroma returns a chroma that fits sRGB while a hair more does not', () => {
  const c = maxChroma(0.6, 30)
  assert.ok(c > 0.05, `expected room for chroma at mid lightness, got ${c}`)
  const inside = oklchToHex({ l: 0.6, c, h: 30 })
  assert.ok(/^#[0-9A-F]{6}$/.test(inside))
  // Past the boundary, chroma reduction must kick in rather than the value passing through.
  assert.ok(clampToGamut({ l: 0.6, c: c + 0.05, h: 30 }).c <= c + 1e-6)
})

test('gamut clamping preserves lightness and hue instead of clipping channels', () => {
  const requested = { l: 0.5, c: 0.35, h: 260 }
  const clamped = clampToGamut(requested)
  assert.equal(clamped.l, requested.l)
  assert.equal(clamped.h, requested.h)
  assert.ok(clamped.c < requested.c)
})

test('extremes have no chroma room at all', () => {
  assert.equal(maxChroma(0, 30), 0)
  assert.equal(maxChroma(1, 30), 0)
})

test('contrast ratio and ink selection follow WCAG', () => {
  assert.equal(Math.round(contrastRatio(WHITE, BLACK)), 21)
  assert.equal(contrastRatio(WHITE, WHITE), 1)
  assert.deepEqual(readableInk(WHITE), BLACK)
  assert.deepEqual(readableInk(BLACK), WHITE)
})

test('mixing interpolates in sRGB and saturates at the ends', () => {
  const key = parseHex('#FB5B0A')!
  assert.equal(formatHex(mixRgb(key, WHITE, 0)), '#FB5B0A')
  assert.equal(formatHex(mixRgb(key, WHITE, 1)), '#FFFFFF')
  assert.equal(formatHex(mixRgb(key, BLACK, 1)), '#000000')
  assert.equal(formatHex(mixRgb(key, WHITE, 0.5)), '#FDAD85')
})
