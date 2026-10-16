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

// sourceColor (plugin API 1.142): the authored colour beside the sRGB projection. Shapes are
// the ones figma.util.rgba returned in a live file on 16.10.
test('an authored OKLCH, OKLAB or P3 colour is written as authored', async () => {
  const { sourceColorCss, sourceColorOf } = await import('./color.ts')
  const { rgbaToCss } = await import('../targets/django/tokens.ts')
  const { shadowEffectToCss } = await import('./engine.ts')

  const oklch = { r: 0.49, g: 0.139, b: 0.159, a: 1, sourceColor: { space: 'OKLCH', l: 0.401, c: 0.123, h: 21.569999999999993 } }
  assert.equal(sourceColorCss(sourceColorOf(oklch)!), 'oklch(40.1% 0.123 21.57)')
  assert.equal(rgbaToCss(oklch as unknown as RGBA), 'oklch(40.1% 0.123 21.57)')
  assert.equal(rgbaToCss({ ...oklch, a: 0.5 } as unknown as RGBA), 'oklch(40.1% 0.123 21.57 / 0.5)')

  const p3 = { r: 1, g: 0, b: 0, a: 1, sourceColor: { space: 'DISPLAY_P3', r: 1, g: 0, b: 0 } }
  assert.equal(rgbaToCss(p3 as unknown as RGBA), 'color(display-p3 1 0 0)')

  const oklab = { r: 0.5, g: 0.27, b: 0.6, a: 0.25, sourceColor: { space: 'OKLAB', l: 0.5, a: 0.1, b: -0.1 } }
  assert.equal(
    shadowEffectToCss({ type: 'DROP_SHADOW', offset: { x: 0, y: 4 }, radius: 8, color: oklab } as never),
    '0px 4px 8px oklab(50% 0.1 -0.1 / 0.25)',
  )
})

test('sRGB-family and missing source colours keep the hex the export always wrote', async () => {
  const { sourceColorOf } = await import('./color.ts')
  const { rgbaToCss } = await import('../targets/django/tokens.ts')
  const hsl = { r: 0.2, g: 0.4667, b: 0.6, a: 1, sourceColor: { space: 'HSL', h: 200, s: 0.5, l: 0.4 } }
  assert.equal(rgbaToCss(hsl as unknown as RGBA), '#337799')
  assert.equal(rgbaToCss({ r: 1, g: 0, b: 0, a: 1 }), '#ff0000')
  assert.equal(sourceColorOf({ r: 0, g: 0, b: 0, sourceColor: { space: 'CMYK', c: 1 } }), null)
  assert.equal(sourceColorOf({ r: 0, g: 0, b: 0, sourceColor: { space: 'OKLCH', l: NaN, c: 0, h: 0 } }), null)
})
