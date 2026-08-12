import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planTypographyVariables, type TokenGraph, type TokenGraphTextStyle } from './engine.ts'

const style = (over: Partial<TokenGraphTextStyle>): TokenGraphTextStyle => ({
  id: `S:${over.name}`,
  name: 'Body',
  fontName: { family: 'Inter', style: 'Regular' },
  fontSize: 16,
  ...over,
})

const plan = (styles: TokenGraphTextStyle[]) =>
  planTypographyVariables({ fileName: 'f', collections: [], variables: [], textStyles: styles } as TokenGraph, {})

const weightOf = (styles: TokenGraphTextStyle[], styleName: string) => {
  const p = plan(styles)
  const binding = p.bindings.find((b) => b.styleName === styleName && b.field === 'fontWeight')
  if (!binding) return undefined
  return p.variables.find((v) => v.name === binding.varName)?.value
}

test('uses the weight Figma reports, not the one guessed from the style name', () => {
  const styles = [style({ name: 'Heading', fontName: { family: 'Acme', style: 'Medium' }, fontWeight: 700 })]
  assert.equal(weightOf(styles, 'Heading'), 700)
  assert.ok(plan(styles).variables.some((v) => v.name === 'font-weight/bold'))
})

test('keeps distinct faces apart when their names collide on the heuristic', () => {
  const styles = [
    style({ name: 'A', fontName: { family: 'Acme', style: 'Text' }, fontWeight: 400 }),
    style({ name: 'B', fontName: { family: 'Acme', style: 'Book' }, fontWeight: 450, fontSize: 18 }),
    style({ name: 'C', fontName: { family: 'Acme', style: 'Display' }, fontWeight: 700, fontSize: 20 }),
  ]
  assert.deepEqual([weightOf(styles, 'A'), weightOf(styles, 'B'), weightOf(styles, 'C')], [400, 450, 700])
})

test('falls back to the style name only when Figma reported nothing', () => {
  assert.equal(weightOf([style({ name: 'H', fontName: { family: 'Inter', style: 'Bold' } })], 'H'), 700)
  assert.equal(weightOf([style({ name: 'H', fontName: { family: 'Inter', style: 'SemiBold' } })], 'H'), 600)
  assert.equal(weightOf([style({ name: 'H', fontName: { family: 'Inter', style: 'Medium Italic' } })], 'H'), 500)
})

test('fallback reads an explicit numeric weight out of the style name', () => {
  assert.equal(weightOf([style({ name: 'H', fontName: { family: 'Roboto Flex', style: '700' } })], 'H'), 700)
  assert.equal(weightOf([style({ name: 'H', fontName: { family: 'Acme', style: 'Weight 300 Italic' } })], 'H'), 300)
})
