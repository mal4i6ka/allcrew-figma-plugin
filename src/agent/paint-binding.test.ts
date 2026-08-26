import test from 'node:test'
import assert from 'node:assert/strict'

/* `figma` is a sandbox global. The comparison helpers only ever test identity against
 * `figma.mixed`, so a stub carrying that one sentinel exercises every branch — and it has to
 * exist before `ops.ts` is imported, since the registry is built at module scope. */
;(globalThis as { figma?: unknown }).figma = { mixed: Symbol('figma.mixed') }
const MIXED = (globalThis as unknown as { figma: { mixed: symbol } }).figma.mixed

const { paintColor, sameColor, renderedValue, differsOnlyByCase } = await import('./ops.ts')

test("a solid paint's alpha comes from its opacity, not from color", () => {
  assert.deepEqual(paintColor({ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.5 }), {
    r: 1,
    g: 0,
    b: 0,
    a: 0.5,
  })
  // No opacity means fully opaque — not "assume the token's alpha and call it a match".
  assert.deepEqual(paintColor({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }), { r: 0, g: 0, b: 0, a: 1 })
})

test('a paint that is not a solid colour has no colour to compare', () => {
  assert.equal(paintColor({ type: 'GRADIENT_LINEAR' }), null)
  assert.equal(paintColor({ type: 'IMAGE' }), null)
  assert.equal(paintColor(null), null)
  assert.equal(paintColor(undefined), null)
})

test('float noise is not a colour difference, but a byte is', () => {
  const base = { r: 0.5, g: 0.5, b: 0.5, a: 1 }
  assert.equal(sameColor(base, { r: 0.5001, g: 0.4999, b: 0.5, a: 1 }), true)
  assert.equal(sameColor(base, { r: 0.51, g: 0.5, b: 0.5, a: 1 }), false)
})

test('a colour matching in rgb but not in alpha is still a mismatch', () => {
  const base = { r: 0, g: 0, b: 0, a: 1 }
  assert.equal(sameColor(base, { r: 0, g: 0, b: 0, a: 0.5 }), false)
})

test('a font binding reads its half of fontName', () => {
  const text = { fontName: { family: 'Inter', style: 'Semi Bold' } }
  assert.equal(renderedValue(text, 'fontFamily'), 'Inter')
  assert.equal(renderedValue(text, 'fontStyle'), 'Semi Bold')
})

test('mixed formatting has no single value to compare', () => {
  assert.equal(renderedValue({ fontName: MIXED }, 'fontFamily'), undefined)
  assert.equal(renderedValue({ fontSize: MIXED }, 'fontSize'), undefined)
})

test('a pixel line-height compares, a percentage or AUTO does not', () => {
  assert.equal(renderedValue({ lineHeight: { value: 20, unit: 'PIXELS' } }, 'lineHeight'), 20)
  // A percentage against a pixel token is a different kind of number, not drift.
  assert.equal(renderedValue({ lineHeight: { value: 140, unit: 'PERCENT' } }, 'lineHeight'), undefined)
  assert.equal(renderedValue({ lineHeight: { unit: 'AUTO' } }, 'lineHeight'), undefined)
})

test('plain numbers and strings pass through, rounded where noisy', () => {
  assert.equal(renderedValue({ fontSize: 15.004 }, 'fontSize'), 15)
  assert.equal(renderedValue({ characters: 'Next' }, 'characters'), 'Next')
  assert.equal(renderedValue({ itemSpacing: 8 }, 'itemSpacing'), 8)
})

test('an absent field yields no comparison rather than a zero', () => {
  assert.equal(renderedValue({}, 'itemSpacing'), undefined)
  assert.equal(renderedValue({ opacity: null }, 'opacity'), undefined)
})

test('capitalisation and spacing alone are not a mismatch', () => {
  assert.equal(differsOnlyByCase('semi bold', 'Semi Bold'), true)
  assert.equal(differsOnlyByCase('Regular', 'regular'), true)
  assert.equal(differsOnlyByCase('semi  bold', 'Semi Bold'), true)
  assert.equal(differsOnlyByCase(' Bold ', 'bold'), true)
})

test('identical strings differ in no way at all', () => {
  assert.equal(differsOnlyByCase('Inter', 'Inter'), false)
})

test('a genuinely different style is not a capitalisation quirk', () => {
  assert.equal(differsOnlyByCase('Semi Bold', 'Bold'), false)
  assert.equal(differsOnlyByCase('Inter', 'Museo Sans'), false)
})
