import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findColorLiterals,
  formatColorLiteral,
  hslToRgb,
  hwbToRgb,
  namedColorFor,
  parseColorLiteral,
  rgbToHsl,
  rgbToHwb,
  rgbaEquals,
  type Rgba,
} from './color-literal.ts'

const near = (actual: number, expected: number, epsilon = 1e-3): void => {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${expected}, got ${actual}`)
}

test('parses every hex width, keeping alpha out of the RGB channels', () => {
  const short = parseColorLiteral('#FB0')!
  assert.equal(short.notation, 'hex3')
  near(short.rgba.r, 1)
  near(short.rgba.g, 0xbb / 255)
  assert.equal(short.rgba.a, 1)

  const long = parseColorLiteral('#2563EB')!
  assert.equal(long.notation, 'hex6')
  near(long.rgba.b, 0xeb / 255)

  const alpha = parseColorLiteral('#2563EB80')!
  assert.equal(alpha.notation, 'hex8')
  near(alpha.rgba.r, 0x25 / 255)
  near(alpha.rgba.a, 0x80 / 255)

  const shortAlpha = parseColorLiteral('#25BE')!
  assert.equal(shortAlpha.notation, 'hex4')
  near(shortAlpha.rgba.r, 0x22 / 255)
  near(shortAlpha.rgba.a, 0xee / 255)
})

test('an 8-digit hex is never read as a 6-digit one with junk after it', () => {
  // Getting this wrong would strip alpha on rewrite — the one thing a remap must not touch.
  const found = findColorLiterals('color: #2563EB80;')
  assert.equal(found.length, 1)
  assert.equal(found[0].source, '#2563EB80')
})

test('parses rgb/rgba/hsl/hsla in comma, space and slash-alpha forms', () => {
  const rgb = parseColorLiteral('rgb(37, 99, 235)')!
  assert.equal(rgb.notation, 'rgb')
  near(rgb.rgba.r, 37 / 255)
  assert.equal(rgb.rgba.a, 1)

  const rgba = parseColorLiteral('rgba(37,99,235,.5)')!
  near(rgba.rgba.a, 0.5)

  const spaced = parseColorLiteral('rgb(37 99 235 / 50%)')!
  near(spaced.rgba.g, 99 / 255)
  near(spaced.rgba.a, 0.5)

  const percent = parseColorLiteral('rgb(100%, 0%, 0%)')!
  near(percent.rgba.r, 1)
  near(percent.rgba.g, 0)

  const hsl = parseColorLiteral('hsl(220, 83%, 53%)')!
  assert.equal(hsl.notation, 'hsl')
  near(hsl.rgba.b, 0.92, 0.02)

  const hsla = parseColorLiteral('hsla(220 83% 53% / 0.25)')!
  near(hsla.rgba.a, 0.25)
})

test('scans a stylesheet and reports literals in source order with offsets', () => {
  const css = ':root { --a: #FFF; --b: rgba(0, 0, 0, .12); --c: hsl(30 100% 50%); }'
  const found = findColorLiterals(css)
  assert.deepEqual(
    found.map((literal) => literal.source),
    ['#FFF', 'rgba(0, 0, 0, .12)', 'hsl(30 100% 50%)']
  )
  assert.equal(css.slice(found[1].start, found[1].end), 'rgba(0, 0, 0, .12)')
})

test('ignores things that only look like colors', () => {
  assert.deepEqual(findColorLiterals('#hello world and #12345'), [])
  assert.equal(parseColorLiteral('rgb(37, 99)'), null)
  assert.equal(parseColorLiteral('#FFF #000'), null, 'two literals is not a single literal')
})

test('writes a replacement back in the notation it was found in', () => {
  const violet: Rgba = { r: 0x7c / 255, g: 0x3a / 255, b: 0xed / 255, a: 1 }
  assert.equal(formatColorLiteral(violet, 'hex6'), '#7C3AED')
  assert.equal(formatColorLiteral(violet, 'rgb'), 'rgb(124, 58, 237)')
  assert.equal(formatColorLiteral(violet, 'hex3'), '#7C3AED', 'shorthand widens rather than rounding the color')

  const translucent: Rgba = { ...violet, a: 0.5 }
  assert.equal(formatColorLiteral(translucent, 'rgb'), 'rgba(124, 58, 237, 0.5)')
  assert.equal(formatColorLiteral(translucent, 'hex6'), '#7C3AED80', 'a translucent color upgrades hex6 to hex8')
  assert.equal(formatColorLiteral(violet, 'hex8'), '#7C3AEDFF', 'an explicit 8-digit source keeps its width')
})

test('hsl round-trips through rgb', () => {
  for (const [h, s, l] of [
    [0, 1, 0.5],
    [220, 0.83, 0.53],
    [30, 1, 0.5],
    [140, 0.4, 0.25],
    [0, 0, 0.6],
  ]) {
    const back = rgbToHsl(hslToRgb(h, s, l))
    near(back.l, l)
    near(back.s, s)
    if (s > 0) near(back.h, h, 0.5)
  }
})

test('rgbaEquals tolerates 8-bit rounding but not a real difference', () => {
  const a: Rgba = { r: 0.5, g: 0.5, b: 0.5, a: 1 }
  assert.ok(rgbaEquals(a, { r: 0.5005, g: 0.4995, b: 0.5, a: 1 }))
  assert.ok(!rgbaEquals(a, { r: 0.52, g: 0.5, b: 0.5, a: 1 }))
  assert.ok(!rgbaEquals(a, { ...a, a: 0.9 }), 'alpha is part of identity')
})

/* ------------------------------------------------------------------ CSS Color 4 */

test('parses the modern colour spaces a stylesheet can hold today', () => {
  const hwb = parseColorLiteral('hwb(220 20% 10%)')!
  assert.equal(hwb.notation, 'hwb')
  near(hwb.rgba.r, 0.2)
  near(hwb.rgba.b, 0.9)

  // Tailwind 4 writes its palette in oklch, so this is not a hypothetical notation.
  const oklch = parseColorLiteral('oklch(0.546 0.215 262.9)')!
  assert.equal(oklch.notation, 'oklch')
  near(oklch.rgba.r, 37 / 255, 0.02)
  near(oklch.rgba.b, 235 / 255, 0.02)

  const oklab = parseColorLiteral('oklab(0.546 -0.03 -0.21)')!
  assert.equal(oklab.notation, 'oklab')
  near(oklab.rgba.b, 235 / 255, 0.03)

  const withAlpha = parseColorLiteral('oklch(0.546 0.215 262.9 / 0.5)')!
  near(withAlpha.rgba.a, 0.5)
})

test('the modern spaces round-trip through their own notation', () => {
  const violet: Rgba = { r: 0x7c / 255, g: 0x3a / 255, b: 0xed / 255, a: 1 }
  for (const notation of ['hwb', 'oklch', 'oklab'] as const) {
    const written = formatColorLiteral(violet, notation)
    const back = parseColorLiteral(written)!
    assert.equal(back.notation, notation, written)
    near(back.rgba.r, violet.r, 0.01)
    near(back.rgba.g, violet.g, 0.01)
    near(back.rgba.b, violet.b, 0.01)
  }
})

test('hwb round-trips through rgb', () => {
  for (const [h, w, b] of [
    [220, 0.2, 0.1],
    [0, 0, 0],
    [140, 0.5, 0.4],
  ]) {
    const back = rgbToHwb(hwbToRgb(h, w, b))
    near(back.w, w, 0.01)
    near(back.b, b, 0.01)
  }
  // Whiteness and blackness over 1 collapse to their own gray, per the spec.
  const gray = hwbToRgb(200, 0.6, 0.6)
  near(gray.r, 0.5)
  near(gray.g, 0.5)
})

test('a colour keyword counts only where a value goes', () => {
  const found = (text: string) => findColorLiterals(text).map((literal) => literal.source)

  assert.deepEqual(found('color: tan;'), ['tan'])
  assert.deepEqual(found('{ "surface": "white" }'), ['white'])
  assert.deepEqual(found('border: 1px solid red;'), ['red'], 'a shorthand still holds a colour')

  // The half of the table that is also ordinary English is why this guard exists.
  assert.deepEqual(found('/* the tan leather and linen plum */'), [])
  assert.deepEqual(found(' * wheat and snow, in a block comment'), [])
  assert.deepEqual(found('// a plum coloured thing'), [])
  assert.deepEqual(found('.snow-container { }'), [])
  assert.deepEqual(found('--color-red-500: #EF4444;'), ['#EF4444'])
  assert.deepEqual(found('const label = "the tan one"'), [], 'prose in a string is still prose')
})

test('a keyword is written back as a keyword when the new colour has one', () => {
  assert.equal(formatColorLiteral({ r: 0, g: 0, b: 0, a: 1 }, 'named'), 'black')
  assert.equal(formatColorLiteral({ r: 0x7c / 255, g: 0x3a / 255, b: 0xed / 255, a: 1 }, 'named'), '#7C3AED')
  assert.equal(formatColorLiteral({ r: 1, g: 1, b: 1, a: 0.5 }, 'named'), '#FFFFFF80')
})

test('the shorter spelling wins when two keywords share a colour', () => {
  assert.equal(namedColorFor({ r: 0, g: 1, b: 1 }), 'aqua')
  assert.equal(namedColorFor({ r: 0.5019607843137255, g: 0.5019607843137255, b: 0.5019607843137255 }), 'gray')
  assert.equal(namedColorFor({ r: 0.1, g: 0.2, b: 0.3 }), null)
})
