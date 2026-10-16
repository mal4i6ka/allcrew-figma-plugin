import test from 'node:test'
import assert from 'node:assert/strict'
import { segmentToDeclarations, textWrapRules, TEXT_SEGMENT_FIELDS, type TextStyleSegment } from './text-styles.ts'

const base: TextStyleSegment = {
  characters: 'Hello',
  fontName: { family: 'Inter', style: 'Regular' },
  fontSize: 16,
  fontWeight: 400,
  lineHeight: { unit: 'AUTO' },
  letterSpacing: { value: 0, unit: 'PIXELS' },
}

test('a variable font writes every axis Figma reports, sorted, tags as spelled', () => {
  const decl = segmentToDeclarations({ ...base, fontName: { family: 'Inter', style: 'Regular', variationSettings: { wght: 650, slnt: -10, GRAD: 50 } } })
  assert.ok(decl.includes('font-variation-settings: "GRAD" 50, "slnt" -10, "wght" 650;'), decl.join('\n'))
})

test('a static font writes no variation settings', () => {
  assert.ok(!segmentToDeclarations(base).some((d) => d.startsWith('font-variation-settings')))
})

test('the wrap style is asked for with every segment', () => {
  assert.ok((TEXT_SEGMENT_FIELDS as readonly string[]).includes('textWrapStyle'))
})

test('one wrap style across the node is one rule on the paragraph class, as the longhand', () => {
  const rules = textWrapRules('t-1', [
    { characters: 'A heading\n', textWrapStyle: 'BALANCE' },
    { characters: 'that wraps', textWrapStyle: 'BALANCE' },
  ])
  assert.deepEqual(rules, ['.t-1 {\n  text-wrap-style: balance;\n}'])
})

test('AUTO everywhere, or no wrap style reported, writes nothing', () => {
  assert.deepEqual(textWrapRules('t-1', [{ characters: 'x', textWrapStyle: 'AUTO' }]), [])
  assert.deepEqual(textWrapRules('t-1', [{ characters: 'x' }]), [])
})

test('paragraphs that differ are picked out by the segment they hold', () => {
  const rules = textWrapRules('t-1', [
    { characters: 'Title\n', textWrapStyle: 'BALANCE' },
    { characters: 'Body copy\n', textWrapStyle: 'AUTO' },
    { characters: 'Closing line', textWrapStyle: 'PRETTY' },
  ])
  assert.deepEqual(rules, [
    '.t-1:has(.t-1--segment-0) {\n  text-wrap-style: balance;\n}',
    '.t-1:has(.t-1--segment-2) {\n  text-wrap-style: pretty;\n}',
  ])
})

test('a blank trailing run does not turn a uniform style into a mixed one', () => {
  const rules = textWrapRules('t-1', [
    { characters: 'Title', textWrapStyle: 'BALANCE' },
    { characters: '\n', textWrapStyle: 'AUTO' },
  ])
  assert.deepEqual(rules, ['.t-1 {\n  text-wrap-style: balance;\n}'])
})
