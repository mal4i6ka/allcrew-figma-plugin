import test from 'node:test'
import assert from 'node:assert/strict'
import { componentApi } from './component-api.ts'
import { boundTokensByCssProperty } from './bound-tokens.ts'

/* ------------------------------------------------------------------ fixtures */

interface Layer {
  id: string
  name: string
  type: string
  children?: Layer[]
  componentPropertyReferences?: Record<string, string> | null
  variantProperties?: Record<string, string> | null
  boundVariables?: Record<string, unknown> | null
  getCSSAsync?: () => Promise<Record<string, string>>
}

function layer(id: string, name: string, css: Record<string, string>, extra: Partial<Layer> = {}): Layer {
  return { id, name, type: 'FRAME', children: [], getCSSAsync: async () => css, ...extra }
}

function variant(
  id: string,
  values: Record<string, string>,
  css: Record<string, string>,
  children: Layer[] = [],
  boundVariables: Record<string, unknown> | null = null
): Layer {
  return {
    id,
    name: Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join(', '),
    type: 'COMPONENT',
    variantProperties: values,
    children,
    boundVariables,
    getCSSAsync: async () => css,
  }
}

/** The two tokens the fixture binds — the op layer reads these from Figma. */
const TOKENS = new Map([
  ['VariableID:brand', 'Brand/500'],
  ['VariableID:inverse', 'Neutral/0'],
])
const resolveToken = async (id: string) => TOKENS.get(id) ?? null

const DEFS = {
  Type: { type: 'VARIANT', defaultValue: 'Primary', variantOptions: ['Primary', 'Secondary'] },
  Size: { type: 'VARIANT', defaultValue: 'Large', variantOptions: ['Large', 'Small'] },
  'Right Icon#198:4': { type: 'BOOLEAN', defaultValue: true },
  'Label#1:2': { type: 'TEXT', defaultValue: 'Button' },
}

/** Primary/Large is the resting variant; each sibling isolates exactly one axis. */
function buttonSet() {
  const label = (id: string) =>
    layer(id, 'label', { color: '#fff' }, { componentPropertyReferences: { characters: 'Label#1:2' } })
  const primaryLarge = variant(
    '1:1',
    { Type: 'Primary', Size: 'Large' },
    { background: 'var(--Brand-500, #FB5B0A)', padding: '20px 32px' },
    [label('1:11')],
    { fills: [{ id: 'VariableID:brand' }] }
  )
  const secondaryLarge = variant(
    '1:2',
    { Type: 'Secondary', Size: 'Large' },
    { background: 'var(--Neutral-0, #000)', padding: '20px 32px' },
    [label('1:21'), layer('1:22', 'arrow', { width: '24px' }, { componentPropertyReferences: { visible: 'Right Icon#198:4' } })],
    { fills: [{ id: 'VariableID:inverse' }] }
  )
  const primarySmall = variant(
    '1:3',
    { Type: 'Primary', Size: 'Small' },
    { background: 'var(--Brand-500, #FB5B0A)', padding: '8px 16px' },
    [label('1:31')],
    { fills: [{ id: 'VariableID:brand' }] }
  )
  // A combination the set does not contain: nothing isolates Secondary+Small, and that is fine.
  return {
    id: '1:0',
    name: 'Button',
    type: 'COMPONENT_SET',
    key: 'button-key',
    children: [primaryLarge, secondaryLarge, primarySmall],
  } as unknown as Parameters<typeof componentApi>[0]
}

/* ------------------------------------------------------------------- axes */

test('an axis reports its options, its default, and the variant that isolates each option', async () => {
  const api = await componentApi(buttonSet(), DEFS as never, undefined, { changes: false, resolveToken })

  assert.deepEqual(api.defaultVariant, { id: '1:1', name: 'Type=Primary, Size=Large' })
  assert.deepEqual(
    api.axes.map((axis) => ({ name: axis.name, default: axis.default, options: axis.options.map((o) => [o.value, o.variantId]) })),
    [
      { name: 'Type', default: 'Primary', options: [['Primary', '1:1'], ['Secondary', '1:2']] },
      { name: 'Size', default: 'Large', options: [['Large', '1:1'], ['Small', '1:3']] },
    ]
  )
})

test('one axis at a time: Size is diffed against the sibling whose other axes sit at their defaults', async () => {
  // Diffing against an arbitrary member would report Secondary's colour as something Size does.
  const api = await componentApi(buttonSet(), DEFS as never, undefined, { resolveToken })
  const small = api.axes.find((axis) => axis.name === 'Size')!.options.find((o) => o.value === 'Small')!

  assert.deepEqual(small.changes, [{ path: '', property: 'padding', from: '20px 32px', to: '8px 16px' }])
})

test('a delta names the token behind each value, not only the CSS string', async () => {
  const api = await componentApi(buttonSet(), DEFS as never, undefined, { resolveToken })
  const secondary = api.axes.find((axis) => axis.name === 'Type')!.options.find((o) => o.value === 'Secondary')!
  const background = secondary.changes!.find((change) => change.property === 'background')

  // `var(--Brand-500, #FB5B0A)` is a name mangled for CSS; a consumer cannot look it back up.
  assert.equal(background?.fromToken, 'Brand/500')
  assert.equal(background?.toToken, 'Neutral/0')
})

test('a layer that exists in only one variant is a presence change, not a silent omission', async () => {
  const api = await componentApi(buttonSet(), DEFS as never, undefined, { resolveToken })
  const secondary = api.axes.find((axis) => axis.name === 'Type')!.options.find((o) => o.value === 'Secondary')!

  assert.deepEqual(
    secondary.changes!.filter((change) => change.property === 'presence'),
    [{ path: 'arrow#0', property: 'presence', from: 'absent', to: 'added' }]
  )
})

test('the default option carries no changes — it is the baseline, not a state that changes nothing', async () => {
  const api = await componentApi(buttonSet(), DEFS as never, undefined, { resolveToken })
  for (const axis of api.axes) {
    const isDefault = axis.options.find((option) => option.isDefault)
    assert.ok(isDefault, `${axis.name} has no default option`)
    assert.equal(isDefault.changes, undefined)
  }
})

/* -------------------------------------------------------------- properties */

test('a non-variant property names the layer it drives and the field it drives on it', async () => {
  // A BOOLEAN acts inside every variant, so it cannot be diffed — "which layer" is the answer.
  const api = await componentApi(buttonSet(), DEFS as never, undefined, { changes: false, resolveToken })
  const byName = new Map(api.properties.map((property) => [property.name, property]))

  assert.deepEqual(byName.get('Label#1:2')?.targets, [{ nodeId: '1:11', path: 'label', field: 'characters' }])
  // Found on a sibling, because the resting variant has no arrow layer at all — searching only
  // the default answered "wired to nothing" for a property the file plainly uses.
  assert.deepEqual(byName.get('Right Icon#198:4')?.targets, [
    { nodeId: '1:22', path: 'arrow', field: 'visible', variantId: '1:2', variantName: 'Type=Secondary, Size=Large' },
  ])
})

test('a set whose definitions Figma refuses reports the refusal instead of empty axes', async () => {
  const api = await componentApi(buttonSet(), undefined, 'Component set has existing errors', { resolveToken })

  assert.equal(api.propertiesError, 'Component set has existing errors')
  assert.deepEqual(api.axes, [])
  // The members are still real and still addressable — that much never depended on the getter.
  assert.equal(api.variants.length, 3)
})

/* ------------------------------------------------------------ bound tokens */

test('a binding is read per CSS property, and an unresolvable variable is left out', async () => {
  const node = {
    boundVariables: {
      fills: [{ id: 'VariableID:1' }],
      itemSpacing: { id: 'VariableID:2' },
      topLeftRadius: { id: 'VariableID:gone' },
    },
  }
  const names = new Map([
    ['VariableID:1', 'Text/Primary'],
    ['VariableID:2', 'spacing/md'],
  ])

  const tokens = await boundTokensByCssProperty(node, async (id) => names.get(id) ?? null)

  assert.equal(tokens.background, 'Text/Primary')
  assert.equal(tokens.color, 'Text/Primary', 'a fill is background on a box and color on text')
  assert.equal(tokens.gap, 'spacing/md')
  assert.equal('border-radius' in tokens, false, 'a variable that will not resolve is not reported as its own id')
})

test('when the budget runs out the signature survives and the gap is named', async () => {
  // One option is a getCSSAsync walk of two subtrees; a wide set is minutes of it. Losing the
  // axes and defaults along with the deltas would be the worst of both.
  const realNow = Date.now
  let offsetMs = 0
  Date.now = () => realNow() + offsetMs
  try {
    const api = await componentApi(buttonSet(), DEFS as never, undefined, {
      resolveToken: async (id) => {
        offsetMs += 5000
        return TOKENS.get(id) ?? null
      },
      budgetMs: 1,
    })

    assert.equal(api.stoppedOn, 'budgetMs')
    assert.match(api.note ?? '', /not the same as measuring them and finding nothing/)
    assert.equal(api.axes.length, 2, 'the axes are still there')
    assert.ok(api.axes.every((axis) => axis.options.every((option) => option.value.length > 0)))
  } finally {
    Date.now = realNow
  }
})
