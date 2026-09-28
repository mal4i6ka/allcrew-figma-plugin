import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WRITE_OPS,
  normaliseVariableScopes,
  planVariableMetadata,
} from './write-ops.ts'
import { coerceVariableValue, describeValue } from './values.ts'

test('FLOAT scopes include both layer and color opacity from the current Figma docs', () => {
  assert.deepEqual(normaliseVariableScopes(['OPACITY', 'COLOR_OPACITY'], 'FLOAT'), [
    'OPACITY',
    'COLOR_OPACITY',
  ])
})

test('scope validation refuses impossible picker combinations and wrong variable types', () => {
  assert.throws(
    () => normaliseVariableScopes(['ALL_SCOPES', 'OPACITY'], 'FLOAT'),
    /ALL_SCOPES cannot be combined/
  )
  assert.throws(() => normaliseVariableScopes(['OPACITY'], 'COLOR'), /must be one of/)
  assert.throws(() => normaliseVariableScopes(['ALL_FILLS', 'TEXT_FILL'], 'COLOR'), /ALL_FILLS cannot be combined/)
})

test('variable metadata covers every writable metadata field', () => {
  assert.deepEqual(
    planVariableMetadata(
      {
        newName: 'opacity/muted',
        description: 'Muted content',
        scopes: ['OPACITY'],
        hiddenFromPublishing: true,
        codeSyntax: { WEB: '--opacity-muted', ANDROID: 'opacityMuted', iOS: null },
      },
      'FLOAT',
      'updates[0]'
    ),
    {
      newName: 'opacity/muted',
      description: 'Muted content',
      scopes: ['OPACITY'],
      hiddenFromPublishing: true,
      codeSyntax: { WEB: '--opacity-muted', ANDROID: 'opacityMuted', iOS: null },
    }
  )
})

test('metadata-only no-ops and unknown code syntax platforms are refused', () => {
  assert.throws(() => planVariableMetadata({}, 'FLOAT', 'updates[0]'), /nothing to update/)
  assert.throws(
    () => planVariableMetadata({ codeSyntax: { WINDOWS: 'opacityMuted' } }, 'FLOAT', 'updates[0]'),
    /WINDOWS is unknown/
  )
})

test('opacity values accept explicit percentages and keep Figma percent storage', async () => {
  const layerOpacity = { name: 'opacity/muted', resolvedType: 'FLOAT', scopes: ['OPACITY'] } as Variable
  const colorOpacity = {
    name: 'opacity/color-muted',
    resolvedType: 'FLOAT',
    scopes: ['COLOR_OPACITY'],
  } as unknown as Variable
  const ordinaryFloat = { name: 'spacing/m', resolvedType: 'FLOAT', scopes: ['GAP'] } as Variable
  const freshOpacity = { name: 'opacity/new', resolvedType: 'FLOAT', scopes: [] } as unknown as Variable

  assert.equal(await coerceVariableValue(layerOpacity, '40%'), 40)
  assert.equal(await coerceVariableValue(colorOpacity, '12.5%'), 12.5)
  assert.equal(
    await coerceVariableValue(freshOpacity, '25%', ['COLOR_OPACITY']),
    25,
    'variables.create validates values against the scopes it is about to apply'
  )
  assert.equal(await coerceVariableValue(layerOpacity, 0.5), 0.5, 'a raw number stays a raw Figma percentage')
  await assert.rejects(() => coerceVariableValue(layerOpacity, '101%'), /between 0% and 100%/)
  await assert.rejects(() => coerceVariableValue(ordinaryFloat, '40%'), /only when scoped/)
})

test('COLOR values support the official composed-color forms', async (t) => {
  const color = {
    id: 'VariableID:color',
    name: 'surface/subtle',
    resolvedType: 'COLOR',
  } as Variable
  const baseColor = {
    id: 'VariableID:base-color',
    name: 'brand/primary',
    resolvedType: 'COLOR',
    remote: false,
  } as Variable
  const opacity = {
    id: 'VariableID:opacity',
    name: 'Trancperancy/subtle',
    resolvedType: 'FLOAT',
    scopes: ['COLOR_OPACITY'],
    remote: false,
  } as Variable
  const previousFigma = globalThis.figma
  const writableGlobal = globalThis as unknown as { figma: unknown }
  writableGlobal.figma = {
    variables: {
      getVariableByIdAsync: async (id: string) => {
        if (id === opacity.id) return opacity
        if (id === baseColor.id) return baseColor
        return null
      },
      createVariableAlias: (target: Variable) => ({ type: 'VARIABLE_ALIAS', id: target.id }),
    },
  }
  t.after(() => {
    writableGlobal.figma = previousFigma
  })

  const opacityAlias = await coerceVariableValue(color, {
    color: '#FB5B0A',
    opacity: { alias: opacity.id },
  })
  assert.deepEqual(opacityAlias, {
    color: { r: 251 / 255, g: 91 / 255, b: 10 / 255, a: 1 },
    opacity: { type: 'VARIABLE_ALIAS', id: opacity.id },
  })
  assert.equal(await describeValue(opacityAlias), '#FB5B0A · opacity → Trancperancy/subtle')

  const colorAlias = await coerceVariableValue(color, {
    color: { alias: baseColor.id },
    opacity: '60%',
  })
  assert.deepEqual(colorAlias, {
    color: { type: 'VARIABLE_ALIAS', id: baseColor.id },
    opacity: 60,
  })
  assert.equal(await describeValue(colorAlias), '→ brand/primary · opacity 60%')

  await assert.rejects(
    () => coerceVariableValue(color, { color: '#FB5B0A', opacity: 40 }),
    /needs a variable alias/
  )
})


test('variables.update previews and applies opacity metadata without touching values', async (t) => {
  const syntax: Record<string, string> = { WEB: '--old-opacity' }
  const variable = {
    id: 'VariableID:1',
    key: 'key',
    name: 'opacity/old',
    description: '',
    scopes: ['OPACITY'],
    hiddenFromPublishing: false,
    codeSyntax: syntax,
    remote: false,
    variableCollectionId: 'VariableCollectionId:1',
    resolvedType: 'FLOAT',
    valuesByMode: { m1: 40 },
    setVariableCodeSyntax: (platform: string, value: string) => {
      syntax[platform] = value
    },
    removeVariableCodeSyntax: (platform: string) => {
      delete syntax[platform]
    },
  } as unknown as Variable
  const previousFigma = globalThis.figma
  // Tests replace the host global with the narrow API surface this operation uses.
  const writableGlobal = globalThis as unknown as { figma: unknown }
  writableGlobal.figma = {
    commitUndo: () => undefined,
    notify: () => undefined,
    variables: {
      getLocalVariablesAsync: async () => [variable],
      getVariableByIdAsync: async (id: string) => (id === variable.id ? variable : null),
    },
  }
  t.after(() => {
    writableGlobal.figma = previousFigma
  })

  const op = WRITE_OPS.find((entry) => entry.name === 'variables.update')!
  const update = {
    variable: 'opacity/old',
    newName: 'opacity/muted',
    description: 'Muted content',
    scopes: ['COLOR_OPACITY'],
    hiddenFromPublishing: true,
    codeSyntax: { WEB: null, iOS: 'Opacity.muted' },
  }
  const preview = (await op.run({ updates: [update], dryRun: true })) as {
    changed: number
    results: Array<{ after: Record<string, unknown> }>
  }
  assert.equal(preview.changed, 1)
  assert.equal(variable.name, 'opacity/old', 'dry run changed the variable')
  assert.deepEqual(preview.results[0].after.codeSyntax, { iOS: 'Opacity.muted' })

  const applied = (await op.run({ updates: [update] })) as { changed: number }
  assert.equal(applied.changed, 1)
  assert.equal(variable.name, 'opacity/muted')
  assert.equal(variable.description, 'Muted content')
  assert.deepEqual(variable.scopes, ['COLOR_OPACITY'])
  assert.equal(variable.hiddenFromPublishing, true)
  assert.deepEqual(variable.codeSyntax, { iOS: 'Opacity.muted' })
  assert.deepEqual(variable.valuesByMode, { m1: 40 })
})
test('the registry exposes the complete metadata update operation', () => {
  const op = WRITE_OPS.find((entry) => entry.name === 'variables.update')
  assert.ok(op)
  assert.equal(op.mutates, true)
  assert.match(op.params.updates.description, /COLOR_OPACITY/)
})
