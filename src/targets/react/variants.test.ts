import test from 'node:test'
import assert from 'node:assert/strict'
import { alignVariants, orderRules, pairOrExplain, pairTrees, scopeVariantCss, variantClass, variantKey } from './variants.ts'
import type { IrNode } from '../django/ir.ts'

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

test('a variant that does not line up says which layer, not just that it did not', () => {
  const withIcon = node('a', 'container', [node('a1', 'text'), node('a2', 'container')])
  const withoutIcon = node('b', 'container', [node('b1', 'text')])
  const { pairs, why } = pairOrExplain(withoutIcon, withIcon)
  assert.equal(pairs, null)
  // "built differently" was said 108 times on one button without once naming the icon.
  assert.match(why!, /holds 1 layer\(s\) in one and 2 in the other/)
  assert.match(why!, /the extra one is a2/)
})

test('a layer that changed kind says so by kind', () => {
  const { why } = pairOrExplain(node('a', 'container', [node('a1', 'text')]), node('b', 'container', [node('b1', 'instance-ref')]))
  assert.match(why!, /is a text in one and a instance-ref in the other/)
})

test('variants lay over each other by layer name, not by position', () => {
  // The button that started this: `Icon=None` holds a label, `Icon=Trailing` holds a label and an
  // icon. By position the label lined up with the icon.
  const none = node('a', 'container', [{ ...node('a1', 'text'), name: 'Label' } as never])
  const trailing = node('b', 'container', [
    { ...node('b1', 'text'), name: 'Label' } as never,
    { ...node('b2', 'container'), name: 'Icons' } as never,
  ])
  const aligned = alignVariants([
    { key: 'Icon=None', node: none },
    { key: 'Icon=Trailing', node: trailing },
  ])

  const names = (aligned.union as { children: Array<{ name: string }> }).children.map((one) => one.name)
  assert.deepEqual(names, ['Label', 'Icons'], 'the union holds every layer any variant has')
  // The label is in both; the icon is only in one, and that is what becomes the condition.
  assert.deepEqual([...aligned.membership.get('a1')!], ['Icon=None', 'Icon=Trailing'])
  assert.deepEqual([...aligned.membership.get('b2')!], ['Icon=Trailing'])
  // And each variant's own ids map onto the union's, so its stylesheet can be renamed.
  assert.equal(aligned.maps.get('Icon=Trailing')!.get('b1'), 'a1')
})

test('a layer that changes kind is two layers, not one with two shapes', () => {
  const text = node('a', 'container', [{ ...node('a1', 'text'), name: 'Label' } as never])
  const swapped = node('b', 'container', [{ ...node('b1', 'instance-ref'), name: 'Label' } as never])
  const aligned = alignVariants([
    { key: 'Icon=None', node: text },
    { key: 'Icon=Only', node: swapped },
  ])
  const kids = (aligned.union as { children: Array<{ id: string; type: string }> }).children
  assert.deepEqual(kids.map((one) => one.type), ['text', 'instance-ref'])
  assert.deepEqual([...aligned.membership.get('a1')!], ['Icon=None'])
  assert.deepEqual([...aligned.membership.get('b1')!], ['Icon=Only'])
})

test('a variant says only what it changes, not the whole stylesheet again', () => {
  const base = '.n1-1 {\n  display: flex;\n  background: red;\n}'
  const variant = '.n2-1 {\n  display: flex;\n  background: blue;\n}'
  const scoped = scopeVariantCss(variant, new Map([['2:1', '1:1']]), 'v-x', base)
  assert.match(scoped, /background: blue/)
  assert.doesNotMatch(scoped, /display: flex/, 'what the base already says is not worth saying twice')
})

test('a variant identical to the base emits nothing at all', () => {
  const base = '.n1-1 {\n  background: red;\n}'
  const same = '.n2-1 {\n  background: red;\n}'
  assert.equal(scopeVariantCss(same, new Map([['2:1', '1:1']]), 'v-x', base).trim(), '')
})

test('a variant that holds its layers the other way round says so in CSS', () => {
  const box = (id: string, name: string) => ({ id, name, type: 'container', children: [] }) as unknown as IrNode
  const union = {
    id: '1:1',
    name: 'Row',
    type: 'container',
    children: [box('1:2', 'Box'), box('1:3', 'Label')],
  } as unknown as IrNode
  const flipped = {
    id: '2:1',
    name: 'Row',
    type: 'container',
    children: [box('2:3', 'Label'), box('2:2', 'Box')],
  } as unknown as IrNode
  const map = new Map([['2:1', '1:1'], ['2:2', '1:2'], ['2:3', '1:3']])

  const css = orderRules(union, flipped, map, 'v-orientation-right')
  assert.match(css, /\.v-orientation-right \.n1-3 \{\n  order: 0;/)
  assert.match(css, /\.v-orientation-right \.n1-2 \{\n  order: 1;/)

  // The same order says nothing.
  const same = {
    id: '3:1',
    name: 'Row',
    type: 'container',
    children: [box('3:2', 'Box'), box('3:3', 'Label')],
  } as unknown as IrNode
  assert.equal(orderRules(union, same, new Map([['3:1', '1:1'], ['3:2', '1:2'], ['3:3', '1:3']]), 'v-x'), '')
})
