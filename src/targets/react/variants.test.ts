import test from 'node:test'
import assert from 'node:assert/strict'
import { pairTrees, scopeVariantCss, variantClass, variantKey } from './variants.ts'

const node = (id: string, type: string, children: unknown[] = []) =>
  ({ id, type, name: id, children }) as never

test('a variant is named by its axes, in a stable order', () => {
  assert.equal(
    variantKey({ 'Size#1:2': { type: 'VARIANT', value: 'L' }, 'Type#1:3': { type: 'VARIANT', value: 'Primary' } } as never),
    'Size=L,Type=Primary'
  )
  // A boolean or a text property is not an axis: two instances differing only in their label are
  // the same variant wearing different words.
  assert.equal(variantKey({ 'Label#1:4': { type: 'TEXT', value: 'Pay' } } as never), '')
  assert.equal(variantClass('Type=Primary,Size=L'), 'v-type-primary-size-l')
})

test('two variants of one shape pair up layer by layer', () => {
  const left = node('a', 'container', [node('a1', 'text'), node('a2', 'container', [node('a3', 'text')])])
  const right = node('b', 'container', [node('b1', 'text'), node('b2', 'container', [node('b3', 'text')])])
  assert.deepEqual([...pairTrees(left, right)!], [['b', 'a'], ['b1', 'a1'], ['b2', 'a2'], ['b3', 'a3']])
})

test('a variant built differently does not pair, and nothing is renamed onto the wrong layer', () => {
  const left = node('a', 'container', [node('a1', 'text')])
  assert.equal(pairTrees(left, node('b', 'container', [node('b1', 'text'), node('b2', 'text')])), null)
  assert.equal(pairTrees(left, node('b', 'container', [node('b1', 'container')])), null)
})

test('a variant stylesheet is renamed onto the first variant and scoped to its class', () => {
  const css = '.n1-2 {\n  background: red;\n}\n\n.n1-3 {\n  color: blue;\n}'
  const scoped = scopeVariantCss(css, new Map([['1:2', '9:9'], ['1:3', '8:8']]), 'v-type-secondary')
  assert.match(scoped, /\.v-type-secondary \.n9-9 \{/)
  assert.match(scoped, /\.v-type-secondary \.n8-8 \{/)
  assert.doesNotMatch(scoped, /\.n1-2|\.n1-3/)
})

test('an at-rule passes through rather than being prefixed into nonsense', () => {
  const css = '@media (prefers-reduced-motion: reduce) {\n  .n1-2 { animation: none; }\n}'
  const scoped = scopeVariantCss(css, new Map(), 'v-x')
  assert.equal(scoped.trim(), css)
})
