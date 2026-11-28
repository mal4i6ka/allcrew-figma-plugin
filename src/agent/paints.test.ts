import test from 'node:test'
import assert from 'node:assert/strict'
import { animatedShaderProperties, describePaint, describeShader, sameShaderInCatalogue } from './paints.ts'

/* `figma` is a sandbox global these functions read at CALL time, so a module-scope stub is
 * enough — this used to need `await import()` because the describer lived in `ops.ts`, whose op
 * registry is built at module scope and touches the global on the way up. Async lookup only:
 * `documentAccess: "dynamic-page"` makes the sync form throw, and a mock offering it would pass
 * a test the real sandbox fails. */
const VARIABLES: Record<string, { name: string }> = {
  'VariableID:1': { name: 'accent/primary' },
  'VariableID:2': { name: 'gradient/glow/p16' },
}
;(globalThis as { figma?: unknown }).figma = {
  mixed: Symbol('figma.mixed'),
  variables: {
    getVariableByIdAsync: async (id: string) => VARIABLES[id] ?? null,
    // A binding is reported with or without its collection; the stub has none, which is the
    // path a variable from an unloaded library takes on a real file.
    getVariableCollectionByIdAsync: async () => null,
  },
}

test('a solid paint reports its colour, and alpha only when it has one', async () => {
  assert.deepEqual(await describePaint({ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }, 0), {
    type: 'SOLID',
    index: 0,
    color: '#FF0000',
    bound: null,
  })
  const half = await describePaint({ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 0.24 }, 2)
  assert.equal(half.alpha, 0.24)
  assert.equal(half.color, '#FFFFFF')
})

test('a solid paint names the token bound to it', async () => {
  const described = await describePaint(
    { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { id: 'VariableID:1' } } },
    0
  )
  assert.equal(described.bound, 'accent/primary')
})

test('a gradient reports every stop, with position in percent', async () => {
  const described = await describePaint(
    {
      type: 'GRADIENT_LINEAR',
      gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 0.16, color: { r: 0, g: 1, b: 0, a: 1 }, boundVariables: { color: { id: 'VariableID:2' } } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
      ],
    },
    0
  )
  assert.deepEqual(described.stops, [
    { position: 0, color: '#FF0000', bound: null },
    { position: 16, color: '#00FF00', bound: 'gradient/glow/p16' },
    { position: 100, color: '#0000FF', bound: null, alpha: 0.5 },
  ])
  // A gradient binds per stop, so paint-level `bound` is null however well tokenised it is —
  // which is exactly why reporting it without the stops read as "raw" and was wrong.
  assert.equal(described.bound, null)
  assert.equal(described.color, undefined)
})

test('an image paint has no colour and no stops to report', async () => {
  const described = await describePaint({ type: 'IMAGE', visible: false }, 3)
  assert.deepEqual(described, { type: 'IMAGE', index: 3, visible: false, bound: null })
})

/* The stack. A layer painted with three fills is a sandwich, and what makes it one — how far
 * each slice lets the one below through, and how the two are combined — used to be dropped on
 * every paint that was not solid. Three fills read without it are three colours in a bag. */

test('every paint carries its opacity and its blend mode, not just the solid ones', async () => {
  const image = await describePaint({ type: 'IMAGE', imageHash: 'h', scaleMode: 'CROP', opacity: 0.4, blendMode: 'MULTIPLY' }, 1)
  assert.equal(image.opacity, 0.4)
  assert.equal(image.blendMode, 'MULTIPLY')
  const gradient = await describePaint(
    { type: 'GRADIENT_LINEAR', gradientStops: [], opacity: 0.2, blendMode: 'OVERLAY' },
    0
  )
  assert.equal(gradient.opacity, 0.2)
  assert.equal(gradient.blendMode, 'OVERLAY')
  // NORMAL and 1 are the defaults and say nothing — a reading full of them is noise.
  const plain = await describePaint({ type: 'IMAGE', opacity: 1, blendMode: 'NORMAL' }, 0)
  assert.equal(plain.opacity, undefined)
  assert.equal(plain.blendMode, undefined)
})

test('an image paint reports the crop and the adjustments, and the zeroes are left out', async () => {
  const described = await describePaint(
    {
      type: 'IMAGE',
      imageHash: 'abc',
      scaleMode: 'CROP',
      imageTransform: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      scalingFactor: 2,
      rotation: 90,
      filters: { exposure: 0.3, contrast: 0, saturation: -0.2, temperature: 0 },
    },
    0
  )
  assert.equal(described.imageHash, 'abc')
  assert.equal(described.scalingFactor, 2)
  assert.equal(described.rotation, 90)
  assert.deepEqual(described.imageTransform, [
    [1, 0, 0],
    [0, 1, 0],
  ])
  assert.deepEqual(described.filters, { exposure: 0.3, saturation: -0.2 })
})

test('a gradient reports the transform — the stops alone say nothing about the angle', async () => {
  const described = await describePaint(
    { type: 'GRADIENT_LINEAR', gradientStops: [], gradientTransform: [[0, 1, 0], [-1, 0, 1]] },
    0
  )
  assert.deepEqual(described.transform, [[0, 1, 0], [-1, 0, 1]])
})

test('a shader paint is its id and its settings, and says when it could not be named', async () => {
  const described = await describePaint(
    { type: 'SHADER', id: 'sh/1', properties: { '11:22': 4.08, '33:44': { stops: [] } } },
    1
  )
  assert.equal(described.type, 'SHADER')
  assert.equal(described.shader?.id, 'sh/1')
  assert.equal(described.shader?.named, false)
  assert.deepEqual(described.shader?.properties?.map((p) => p.id), ['11:22', '33:44'])
  assert.equal(described.shader?.properties?.[0].value, 4.08)
  // A shader has no colour of its own to bind, so claiming a token here would be a lie.
  assert.equal(described.bound, null)
})

test('a named shader gives its settings names, and the ids stay for the write back', async () => {
  const catalogue = new Map([
    [
      'sh/1',
      {
        id: 'sh/1',
        name: 'Aurora',
        type: 'fill' as const,
        imported: true,
        propertyDefinitions: { '11:22': { name: 'Blur', type: 'NUMBER' as const } },
      },
    ],
  ])
  const described = await describeShader({ id: 'sh/1', properties: { '11:22': 4.08 } }, catalogue as never)
  assert.equal(described.named, true)
  assert.equal(described.name, 'Aurora')
  assert.equal(described.kind, 'fill')
  assert.deepEqual(described.properties, [{ id: '11:22', name: 'Blur', type: 'NUMBER', value: 4.08 }])
})

test('an applied shader names its own settings from propertyMetadata, with no catalogue at all', async () => {
  const described = await describeShader({
    id: 'sh/3',
    properties: { '11:22': 4.08 },
    propertyMetadata: {
      '11:22': { name: 'Blur', type: 'NUMBER', defaultValue: 1, description: 'How soft the edge is' },
    },
  })
  assert.equal(described.named, true)
  assert.deepEqual(described.properties, [
    { id: '11:22', name: 'Blur', type: 'NUMBER', default: 1, description: 'How soft the edge is', value: 4.08 },
  ])
})

test("the layer's own metadata wins over the catalogue, which may be stale", async () => {
  const catalogue = new Map([
    [
      'sh/1',
      {
        id: 'sh/1',
        name: 'Aurora',
        type: 'fill' as const,
        imported: true,
        propertyDefinitions: { '11:22': { name: 'Old name', type: 'NUMBER' as const } },
      },
    ],
  ])
  const described = await describeShader(
    { id: 'sh/1', properties: { '11:22': 2, '33:44': 7 }, propertyMetadata: { '11:22': { name: 'Blur', type: 'NUMBER' } } },
    catalogue as never
  )
  assert.equal(described.properties?.[0].name, 'Blur')
  // An id the metadata skips still falls back to the catalogue — here it names nothing either.
  assert.equal(described.properties?.[1].name, undefined)
})

test('a variable bound inside a shader setting is named where it sits', async () => {
  const described = await describeShader({
    id: 'sh/2',
    properties: {
      '55:66': {
        stops: [
          { position: 0, color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } },
          { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
        ],
      },
    },
  })
  const value = described.properties?.[0].value as { stops: Array<{ color: unknown }> }
  assert.deepEqual(value.stops[0].color, { token: 'accent/primary', id: 'VariableID:1' })
  assert.deepEqual(value.stops[1].color, { r: 1, g: 1, b: 1, a: 1 })
})

test('a pattern paint reports the node it tiles — without it the paint is an empty name', async () => {
  const described = await describePaint(
    {
      type: 'PATTERN',
      sourceNodeId: '1:2',
      tileType: 'RECTANGULAR',
      scalingFactor: 1,
      spacing: { x: 4, y: 8 },
      horizontalAlignment: 'CENTER',
    },
    0
  )
  assert.deepEqual(described.pattern, {
    sourceNodeId: '1:2',
    tileType: 'RECTANGULAR',
    scalingFactor: 1,
    spacing: { x: 4, y: 8 },
    horizontalAlignment: 'CENTER',
  })
})

/* Which paint a token belongs to. `boundVariables.fills` is a flat list of every variable the
 * field reaches; nothing says it lines up with `fills`, and on a stack holding a shader it
 * does not — the aliases there are the shader's own stops. Zipping the two named the wrong
 * paint and reported a mismatch on a paint that renders exactly what its token says. */

const { describeBindings } = await import('./ops.ts')

test('a token belongs to the paint that carries it, not to the one at the same index', async () => {
  const bindings = await describeBindings(
    {
      fills: [
        { type: 'SOLID', color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { id: 'VariableID:1' } } },
        { type: 'SHADER', id: 'sh/1' },
        { type: 'IMAGE', imageHash: 'h' },
      ],
      // What Figma hands back on such a layer: three aliases, in the shader's order.
      boundVariables: {
        fills: [{ id: 'VariableID:2' }, { id: 'VariableID:1' }, { id: 'VariableID:3' }],
      },
    },
    { id: 'x', name: 'Banner', type: 'INSTANCE' }
  )
  assert.equal(bindings?.['fills[0]']?.token, 'accent/primary')
  // The shader and the image carry no colour, so nothing may be claimed for them.
  assert.equal(bindings?.['fills[1]'], undefined)
  assert.equal(bindings?.['fills[2]'], undefined)
})

test('a variable the field reaches but no paint carries is reported apart, and marked', async () => {
  const bindings = await describeBindings(
    {
      fills: [{ type: 'SHADER', id: 'sh/1' }],
      boundVariables: { fills: [{ id: 'VariableID:2' }] },
    },
    { id: 'x', name: 'Banner', type: 'FRAME' }
  )
  assert.equal(bindings?.['fills[*0]']?.token, 'gradient/glow/p16')
  assert.equal(bindings?.['fills[*0]']?.unattributed, true)
  // And it is not passed off as the paint's own binding.
  assert.equal(bindings?.fills, undefined)
})

test('one bound paint keeps the bare `fills` key it always had', async () => {
  const bindings = await describeBindings(
    {
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { id: 'VariableID:1' } } }],
      boundVariables: { fills: [{ id: 'VariableID:1' }] },
    },
    { id: 'x', name: 'Swatch', type: 'RECTANGLE' }
  )
  assert.equal(bindings?.fills?.token, 'accent/primary')
})

test('a colour authored outside sRGB says so beside its hex projection', async () => {
  const p3 = await describePaint({ type: 'SOLID', color: { r: 1, g: 0, b: 0, sourceColor: { space: 'DISPLAY_P3', r: 1, g: 0, b: 0 } } }, 0)
  assert.equal(p3.color, '#FF0000')
  assert.equal(p3.authored, 'color(display-p3 1 0 0)')

  const gradient = await describePaint(
    {
      type: 'GRADIENT_LINEAR',
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: [
        { position: 0, color: { r: 0.2, g: 0.4667, b: 0.6, a: 1, sourceColor: { space: 'HSL', h: 200, s: 0.5, l: 0.4 } } },
        { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
      ],
    },
    0
  )
  assert.equal(gradient.stops?.[0].authored, 'hsl(200 50% 40%)')
  assert.equal('authored' in (gradient.stops?.[1] ?? {}), false)
})

/* ---------------------------------- animated shader settings (typings 1.143.0) */

const track = (base: unknown, count: number) => ({ baseValue: { type: 'FLOAT', value: base }, keyframes: Array.from({ length: count }, (_, i) => ({ id: `k${i}` })) })

test('animated shader settings are found in the slot they belong to, and nowhere else', () => {
  const node = {
    manualKeyframeTracks: {
      OPACITY: track(1, 2),
      fills: { 1: { properties: { '11:22': track(0.2, 3) } } },
      effects: { 0: { RADIUS: track(4, 2), properties: { '33:44': track(1, 2) } } },
    },
  }
  assert.deepEqual(Object.keys(animatedShaderProperties(node, 'fills', 1) ?? {}), ['11:22'])
  assert.deepEqual(Object.keys(animatedShaderProperties(node, 'effects', 0) ?? {}), ['33:44'])
  assert.equal(animatedShaderProperties(node, 'fills', 0), undefined)
  assert.equal(animatedShaderProperties(node, 'strokes', 1), undefined)
})

test('a node without Motion, a plain style paint list and a throwing getter all read as no tracks', () => {
  assert.equal(animatedShaderProperties({}, 'fills', 0), undefined)
  assert.equal(animatedShaderProperties(null, 'fills', 0), undefined)
  assert.equal(animatedShaderProperties({ manualKeyframeTracks: { fills: { 0: { baseValue: {}, keyframes: [] } } } }, 'fills', 0), undefined)
  const throwing = Object.defineProperty({}, 'manualKeyframeTracks', {
    get() {
      throw new Error('Motion API unavailable')
    },
  })
  assert.equal(animatedShaderProperties(throwing, 'fills', 0), undefined)
})

test('a setting Figma left out because it is animated is described from its track, not lost', async () => {
  // What a read returns since 1.143.0: `speed` is animated, so `properties` holds only `scale`.
  const described = await describeShader(
    {
      id: 'sh/1',
      properties: { '1:1': 2 },
      propertyMetadata: {
        '1:1': { name: 'scale', type: 'NUMBER', defaultValue: 1 },
        '1:2': { name: 'speed', type: 'NUMBER', defaultValue: 0.5 },
      },
    },
    undefined,
    { '1:2': track(0.1, 3) }
  )
  assert.deepEqual(described.properties, [
    { id: '1:1', name: 'scale', type: 'NUMBER', default: 1, value: 2 },
    // The base value the track starts from — not the author's default of 0.5.
    { id: '1:2', name: 'speed', type: 'NUMBER', default: 0.5, value: 0.1, animated: true, keyframes: 3 },
  ])
})

test('a runtime that still lists an animated setting describes it once, and marks it', async () => {
  const described = await describeShader({ id: 'sh/1', properties: { '1:2': 0.7 } }, undefined, { '1:2': track(0.1, 2) })
  assert.deepEqual(described.properties, [{ id: '1:2', value: 0.7, animated: true, keyframes: 2 }])
})

test('a shader whose every setting is animated still has settings', async () => {
  const described = await describeShader({ id: 'sh/1', properties: {} }, undefined, { '9:9': track(1, 2) })
  assert.deepEqual(described.properties, [{ id: '9:9', value: 1, animated: true, keyframes: 2 }])
  // And with no tracks, nothing changed from before.
  assert.equal((await describeShader({ id: 'sh/1', properties: {} })).properties, undefined)
})

test('a shader paint takes its slot’s tracks through describePaint', async () => {
  const described = await describePaint({ type: 'SHADER', id: 'sh/1', properties: {} }, 0, undefined, undefined, { '9:9': track(1, 2) })
  assert.deepEqual(described.shader?.properties, [{ id: '9:9', value: 1, animated: true, keyframes: 2 }])
})

/* ------------------------- naming an animated setting from the catalogue (read live) */

// Read live on 19.11.2026 from a Water caustic fill whose `scale` was keyframed: the paint id is
// `40f03f78…/8370`, the catalogue's is `published:1650660549837923423/8370`, and the animated
// setting is gone from the paint's `propertyMetadata` as well as from its `properties`.
const waterCatalogue = new Map([
  [
    'published:1650660549837923423/8370',
    {
      id: 'published:1650660549837923423/8370',
      name: '',
      type: 'fill',
      propertyDefinitions: {
        '2793279086:389096460': { name: 'scale', type: 'NUMBER', defaultValue: 1 },
        '3753036810:3652539474': { name: 'intensity', type: 'NUMBER', defaultValue: 0.5 },
        '3071380467:4236873122': { name: 'playhead', type: 'NUMBER', defaultValue: 0 },
      },
    },
  ],
  ['other/1', { id: 'other/1', name: 'Other', type: 'fill', propertyDefinitions: { '9:9': { name: 'unrelated', type: 'NUMBER' } } }],
])

test('an animated setting the paint no longer names is named from the catalogue shader with the same settings', async () => {
  const described = await describeShader(
    {
      id: '40f03f78407c1c973fc891fbca9ff3d0387485e6/8370',
      properties: { '3753036810:3652539474': 0.5, '3071380467:4236873122': 0 },
      propertyMetadata: {
        '3753036810:3652539474': { name: 'intensity', type: 'NUMBER', defaultValue: 0.5 },
        '3071380467:4236873122': { name: 'playhead', type: 'NUMBER', defaultValue: 0 },
      },
    },
    waterCatalogue as never,
    { '2793279086:389096460': track(1, 2) }
  )
  assert.deepEqual(described.properties?.at(-1), {
    id: '2793279086:389096460',
    name: 'scale',
    type: 'NUMBER',
    default: 1,
    value: 1,
    animated: true,
    keyframes: 2,
  })
})

test('a catalogue is only believed when exactly one shader defines every setting', () => {
  assert.equal(sameShaderInCatalogue(['2793279086:389096460', '3753036810:3652539474'], waterCatalogue as never)?.['2793279086:389096460']?.name, 'scale')
  // One id the candidate does not define: not the same shader.
  assert.equal(sameShaderInCatalogue(['2793279086:389096460', '1:1'], waterCatalogue as never), undefined)
  // Two shaders that both define the ids: no way to tell which.
  const twins = new Map([...waterCatalogue, ['twin/1', { ...waterCatalogue.get('published:1650660549837923423/8370')!, id: 'twin/1' }]])
  assert.equal(sameShaderInCatalogue(['2793279086:389096460'], twins as never), undefined)
  assert.equal(sameShaderInCatalogue([], waterCatalogue as never), undefined)
  assert.equal(sameShaderInCatalogue(['2793279086:389096460']), undefined)
})
