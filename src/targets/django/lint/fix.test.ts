import test from 'node:test'
import assert from 'node:assert/strict'
import {
  annotateUnfixableFindings,
  applyLintFix,
  autoVariableName,
  canMergeAutoLayoutWrapper,
  colorDeltaE,
  colorsMatch,
  inferAutoLayout,
  isDissolvableWrapper,
  isRedundantWrapper,
  FIX_COLLECTION_NAME,
  SNAP_DELTA_E,
  type FixContext,
} from './fix.ts'

// --- pure helpers ---

test('colorsMatch treats missing alpha as 1 and tolerates float noise', () => {
  assert.ok(colorsMatch({ r: 1, g: 0.5, b: 0 }, { r: 1, g: 0.5001, b: 0, a: 1 }))
  assert.ok(!colorsMatch({ r: 1, g: 0.5, b: 0 }, { r: 1, g: 0.5, b: 0, a: 0.5 }))
})

test('autoVariableName renders hex and only appends alpha when translucent', () => {
  assert.equal(autoVariableName({ r: 1, g: 0, b: 0, a: 1 }), 'auto/ff0000')
  assert.equal(autoVariableName({ r: 0, g: 0, b: 0, a: 0.5 }), 'auto/000000-a50')
})

test('inferAutoLayout detects a horizontal row with spacing and padding', () => {
  const layout = inferAutoLayout(
    [
      { x: 10, y: 10, width: 50, height: 30 },
      { x: 70, y: 10, width: 50, height: 30 },
      { x: 130, y: 10, width: 50, height: 30 },
    ],
    200,
    50
  )
  assert.ok(layout)
  assert.equal(layout.layoutMode, 'HORIZONTAL')
  assert.equal(layout.itemSpacing, 10)
  assert.equal(layout.paddingLeft, 10)
  assert.equal(layout.paddingTop, 10)
  assert.equal(layout.paddingRight, 20)
  assert.equal(layout.paddingBottom, 10)
  assert.deepEqual(layout.order, [0, 1, 2])
})

test('inferAutoLayout detects a vertical stack and sorts children by y', () => {
  const layout = inferAutoLayout(
    [
      { x: 0, y: 120, width: 100, height: 40 },
      { x: 0, y: 0, width: 100, height: 40 },
      { x: 0, y: 60, width: 100, height: 40 },
    ],
    100,
    160
  )
  assert.ok(layout)
  assert.equal(layout.layoutMode, 'VERTICAL')
  assert.equal(layout.itemSpacing, 20)
  assert.deepEqual(layout.order, [1, 2, 0])
})

test('inferAutoLayout returns null when children overlap on both axes', () => {
  const layout = inferAutoLayout(
    [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 20, y: 20, width: 100, height: 100 },
    ],
    200,
    200
  )
  assert.equal(layout, null)
})

test('inferAutoLayout handles an empty frame', () => {
  const layout = inferAutoLayout([], 100, 100)
  assert.ok(layout)
  assert.equal(layout.layoutMode, 'VERTICAL')
  assert.deepEqual(layout.order, [])
})

// --- fixers against a mocked `figma` global ---

const MIXED = Symbol('mixed')

function mockFigma() {
  const created: { variables: any[]; collections: any[]; textStyles: any[]; nodesById: Map<string, any> } = {
    variables: [],
    collections: [],
    textStyles: [],
    nodesById: new Map(),
  }
  ;(globalThis as any).figma = {
    mixed: MIXED,
    loadFontAsync: async () => {},
    getNodeByIdAsync: async (id: string) => created.nodesById.get(id) ?? null,
    createTextStyle: () => {
      const style = { id: `style-${created.textStyles.length + 1}`, name: '', fontName: null, fontSize: 0 }
      created.textStyles.push(style)
      return style
    },
    variables: {
      getLocalVariablesAsync: async () => [],
      getLocalVariableCollectionsAsync: async () => created.collections,
      createVariableCollection: (name: string) => {
        const collection = { name, modes: [{ modeId: 'mode-1' }] }
        created.collections.push(collection)
        return collection
      },
      createVariable: (name: string, _collection: any, _type: string) => {
        const variable = {
          id: `var-${created.variables.length + 1}`,
          name,
          valuesByMode: {} as Record<string, unknown>,
          setValueForMode(modeId: string, value: unknown) {
            this.valuesByMode[modeId] = value
          },
        }
        created.variables.push(variable)
        return variable
      },
      setBoundVariableForPaint: (paint: any, _field: string, variable: any) => ({
        ...paint,
        boundVariables: { color: { type: 'VARIABLE_ALIAS', id: variable.id } },
      }),
    },
  }
  return created
}

function emptyContext(): FixContext {
  return {
    colorVariables: [],
    libraryColorVariables: null,
    colorCandidates: null,
    collectionDefaultMode: new Map(),
    textStyles: [],
    remoteTextStyles: null,
    fixCollection: null,
    boundPaintKeys: new Set(),
  }
}

/** Installs a `figma.teamLibrary` mock exposing one enabled library collection with the given
 * variables (default resolvedType COLOR). `aliasTargets` backs getVariableByIdAsync so library
 * values may be VARIABLE_ALIAS objects. Returns the keys passed to importVariableByKeyAsync. */
function mockTeamLibrary(
  variables: Array<{
    key: string
    name: string
    resolvedType?: string
    valuesByMode: Record<string, unknown>
    scopes?: string[]
    collectionId?: string
  }>,
  aliasTargets: Record<string, unknown> = {}
) {
  const importedKeys: string[] = []
  ;(globalThis as any).figma.teamLibrary = {
    getAvailableLibraryVariableCollectionsAsync: async () => [{ key: 'lib-col', name: 'Colors', libraryName: 'DS' }],
    getVariablesInLibraryCollectionAsync: async () =>
      variables.map(({ key, name, resolvedType }) => ({ key, name, resolvedType: resolvedType ?? 'COLOR' })),
  }
  ;(globalThis as any).figma.variables.importVariableByKeyAsync = async (key: string) => {
    importedKeys.push(key)
    const found = variables.find((v) => v.key === key)
    if (!found) throw new Error(`no published variable with key ${key}`)
    return {
      id: `lib-${found.key}`,
      name: found.name,
      remote: true,
      valuesByMode: found.valuesByMode,
      scopes: found.scopes,
      variableCollectionId: found.collectionId,
    }
  }
  ;(globalThis as any).figma.variables.getVariableByIdAsync = async (id: string) => aliasTargets[id] ?? null
  return importedKeys
}

test('unbound-fill binds to an existing variable with a matching value', async () => {
  mockFigma()
  const ctx = emptyContext()
  ctx.colorVariables.push({
    id: 'var-existing',
    name: 'brand/red',
    valuesByMode: { m: { r: 1, g: 0, b: 0 } },
  } as any)
  const node: any = {
    id: 'n1',
    name: 'Union',
    type: 'VECTOR',
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
  }
  const result = await applyLintFix(node, 'unbound-fill', ctx)
  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /brand\/red/)
  assert.equal(node.fills[0].boundVariables.color.id, 'var-existing')
})

test('unbound-fill creates a variable in the fix collection when nothing matches', async () => {
  const created = mockFigma()
  const ctx = emptyContext()
  const node: any = {
    id: 'n1',
    name: 'Vector',
    type: 'VECTOR',
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 }, opacity: 0.5 }],
  }
  const result = await applyLintFix(node, 'unbound-fill', ctx)
  assert.equal(result.status, 'fixed')
  assert.equal(created.collections[0].name, FIX_COLLECTION_NAME)
  assert.equal(created.variables[0].name, 'auto/0000ff-a50')
  assert.deepEqual(created.variables[0].valuesByMode['mode-1'], { r: 0, g: 0, b: 1, a: 0.5 })
})

test('colorDeltaE: black↔white is ~100, #020202 is imperceptible from black, #1a1a1a is not', () => {
  assert.ok(Math.abs(colorDeltaE({ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }) - 100) < 0.5)
  assert.ok(colorDeltaE({ r: 0, g: 0, b: 0 }, { r: 2 / 255, g: 2 / 255, b: 2 / 255 }) < SNAP_DELTA_E)
  assert.ok(colorDeltaE({ r: 0, g: 0, b: 0 }, { r: 26 / 255, g: 26 / 255, b: 26 / 255 }) > SNAP_DELTA_E)
})

test('unbound-fill matches a library token through an alias chain', async () => {
  const created = mockFigma()
  mockTeamLibrary(
    [{ key: 'k-primary', name: 'text/primary', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'v-base' } } }],
    {
      'v-base': {
        id: 'v-base',
        name: 'base/black',
        variableCollectionId: 'col-base',
        valuesByMode: { m: { r: 0, g: 0, b: 0, a: 1 } },
      },
    }
  )
  const node: any = { id: 'n1', name: 'Vector', type: 'VECTOR', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] }
  const result = await applyLintFix(node, 'unbound-fill', emptyContext())
  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /text\/primary \(library\)/)
  assert.equal(created.variables.length, 0, 'the aliased token matched — nothing created')
})

test('unbound-fill matches in the mode that renders at the node, not any mode', async () => {
  const created = mockFigma()
  mockTeamLibrary([
    {
      key: 'k-bg',
      name: 'color/bg',
      collectionId: 'col-theme',
      valuesByMode: { light: { r: 1, g: 1, b: 1, a: 1 }, dark: { r: 0, g: 0, b: 0, a: 1 } },
    },
  ])
  const ctx = emptyContext()
  const black = () => [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]
  const darkNode: any = {
    id: 'n-dark', name: 'Dark', type: 'VECTOR',
    resolvedVariableModes: { 'col-theme': 'dark' },
    fills: black(),
  }
  const darkResult = await applyLintFix(darkNode, 'unbound-fill', ctx)
  assert.match(darkResult.detail, /color\/bg \(library\)/, 'black matches the dark-mode value')

  const lightNode: any = { id: 'n-light', name: 'Light', type: 'VECTOR', fills: black() }
  const lightResult = await applyLintFix(lightNode, 'unbound-fill', ctx)
  assert.equal(lightResult.status, 'fixed')
  assert.equal(created.variables[0].name, 'auto/000000', 'default (light) mode renders white — black must not match')
})

test('unbound-fill snaps an imperceptibly-off color to the nearest token', async () => {
  const created = mockFigma()
  mockTeamLibrary([{ key: 'k-black', name: 'color/black', valuesByMode: { m: { r: 0, g: 0, b: 0, a: 1 } } }])
  const ctx = emptyContext()
  const off = 2 / 255
  const nearNode: any = { id: 'n1', name: 'Near', type: 'VECTOR', fills: [{ type: 'SOLID', color: { r: off, g: off, b: off } }] }
  const nearResult = await applyLintFix(nearNode, 'unbound-fill', ctx)
  assert.match(nearResult.detail, /color\/black \(library, snapped from #020202\)/)
  assert.equal(created.variables.length, 0, 'no near-duplicate auto variable minted')

  const far = 26 / 255 // #1a1a1a — visibly different from black
  const farNode: any = { id: 'n2', name: 'Far', type: 'VECTOR', fills: [{ type: 'SOLID', color: { r: far, g: far, b: far } }] }
  await applyLintFix(farNode, 'unbound-fill', ctx)
  assert.equal(created.variables[0].name, 'auto/1a1a1a', 'a visibly different color still gets its own variable')
})

test('unbound-fill ranks scope-compatible tokens above scope-mismatched ones', async () => {
  mockFigma()
  mockTeamLibrary([
    { key: 'k-border', name: 'border/dark', scopes: ['STROKE_COLOR'], valuesByMode: { m: { r: 0, g: 0, b: 0, a: 1 } } },
    { key: 'k-bg', name: 'bg/dark', scopes: ['ALL_SCOPES'], valuesByMode: { m: { r: 0, g: 0, b: 0, a: 1 } } },
  ])
  const node: any = { id: 'n1', name: 'Vector', type: 'VECTOR', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] }
  const result = await applyLintFix(node, 'unbound-fill', emptyContext())
  assert.match(result.detail, /bg\/dark/, 'the stroke-scoped token loses despite coming first')
})

test('unbound-stroke binds stroke paints to a matching token', async () => {
  mockFigma()
  mockTeamLibrary([{ key: 'k-border', name: 'border/dark', scopes: ['STROKE_COLOR'], valuesByMode: { m: { r: 0, g: 0, b: 0, a: 1 } } }])
  const node: any = { id: 'n1', name: 'Rect', type: 'RECTANGLE', strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] }
  const result = await applyLintFix(node, 'unbound-stroke', emptyContext())
  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /border\/dark \(library\)/)
  assert.equal(node.strokes[0].boundVariables.color.id, 'lib-k-border')
})

test('unbound-fill binds to a matching library token instead of creating a variable', async () => {
  const created = mockFigma()
  mockTeamLibrary([{ key: 'k-black', name: 'color/black', valuesByMode: { m: { r: 0, g: 0, b: 0, a: 1 } } }])
  const node: any = {
    id: 'n1',
    name: 'Vector',
    type: 'VECTOR',
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
  }
  const result = await applyLintFix(node, 'unbound-fill', emptyContext())
  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /color\/black \(library\)/)
  assert.equal(node.fills[0].boundVariables.color.id, 'lib-k-black')
  assert.equal(created.variables.length, 0, 'no auto variable created')
  assert.equal(created.collections.length, 0, 'no fix collection created')
})

test('unbound-fill prefers a library token over a matching local variable', async () => {
  mockFigma()
  mockTeamLibrary([{ key: 'k-black', name: 'color/black', valuesByMode: { m: { r: 0, g: 0, b: 0, a: 1 } } }])
  const ctx = emptyContext()
  ctx.colorVariables.push({
    id: 'var-local-auto',
    name: 'auto/000000',
    valuesByMode: { m: { r: 0, g: 0, b: 0, a: 1 } },
  } as any)
  const node: any = {
    id: 'n1',
    name: 'Vector',
    type: 'VECTOR',
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
  }
  await applyLintFix(node, 'unbound-fill', ctx)
  assert.equal(node.fills[0].boundVariables.color.id, 'lib-k-black')
})

test('library tokens load once per batch and only COLOR candidates are imported', async () => {
  mockFigma()
  const importedKeys = mockTeamLibrary([
    { key: 'k-black', name: 'color/black', valuesByMode: { m: { r: 0, g: 0, b: 0, a: 1 } } },
    { key: 'k-gap', name: 'space/gap', resolvedType: 'FLOAT', valuesByMode: { m: 16 } },
  ])
  const ctx = emptyContext()
  const nodeA: any = { id: 'a', name: 'A', type: 'VECTOR', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] }
  const nodeB: any = { id: 'b', name: 'B', type: 'VECTOR', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] }
  await applyLintFix(nodeA, 'unbound-fill', ctx)
  await applyLintFix(nodeB, 'unbound-fill', ctx)
  assert.deepEqual(importedKeys, ['k-black'], 'one import for the batch, FLOAT token skipped')
})

test('unbound-fill skips paints that come from a paint style instead of breaking the link', async () => {
  const created = mockFigma()
  const node: any = {
    id: 'n1',
    name: 'Vector',
    type: 'VECTOR',
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
    fillStyleId: 'S:paint1',
  }
  const result = await applyLintFix(node, 'unbound-fill', emptyContext())
  assert.equal(result.status, 'skipped')
  assert.match(result.detail, /paint style/)
  assert.ok(!node.fills[0].boundVariables, 'the styled fill is left untouched')
  assert.equal(created.variables.length, 0)
})

test('unbound-fill reuses one created variable across a batch', async () => {
  const created = mockFigma()
  const ctx = emptyContext()
  const fill = () => ({ type: 'SOLID', color: { r: 0, g: 1, b: 0 } })
  const nodeA: any = { id: 'a', name: 'A', type: 'VECTOR', fills: [fill()] }
  const nodeB: any = { id: 'b', name: 'B', type: 'VECTOR', fills: [fill()] }
  await applyLintFix(nodeA, 'unbound-fill', ctx)
  await applyLintFix(nodeB, 'unbound-fill', ctx)
  assert.equal(created.variables.length, 1)
})

// --- instance sublayers: fixes redirect to the main component ---

/** Builds an instance-sublayer scene node (id `I<inst>;<mainId>`) whose parent chain reaches an
 * INSTANCE, plus the main-component counterpart it should redirect to. Registers both for
 * `getNodeByIdAsync`. Mirrors Figma's override semantics: the sublayer renders the main
 * component's paints until it gets its own override (`overriddenFills`, or any assignment to
 * `fills`). `remote` marks the instance's main component as a library node. */
function instanceSublayer(
  created: any,
  mainId: string,
  mainFills: any[],
  opts: { remote?: boolean; overriddenFills?: any[] } = {}
) {
  const mainNode: any = { id: mainId, name: 'Vector', type: 'VECTOR', fills: mainFills, parent: null }
  const instance: any = {
    id: '10:1',
    type: 'INSTANCE',
    parent: { type: 'PAGE' },
    async getMainComponentAsync() {
      return { id: '99:99', remote: !!opts.remote }
    },
  }
  let overrideFills: any[] | null = opts.overriddenFills ?? null
  const sublayer: any = {
    id: `I10:1;${mainId}`,
    name: 'Vector',
    type: 'VECTOR',
    parent: instance,
    get fills() {
      return overrideFills ?? mainNode.fills
    },
    set fills(next: any[]) {
      overrideFills = next
    },
    hasOwnOverride: () => overrideFills !== null,
  }
  created.nodesById.set(mainId, mainNode)
  return { sublayer, mainNode }
}

test('unbound-fill on an instance sublayer binds the main component and notes it', async () => {
  const created = mockFigma()
  const { sublayer, mainNode } = instanceSublayer(created, '5:6', [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }])
  const result = await applyLintFix(sublayer, 'unbound-fill', emptyContext())
  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /on main component/)
  assert.doesNotMatch(result.detail, /overridden/, 'no per-instance override was needed')
  assert.equal(result.nodeId, sublayer.id, 'result stays keyed to the flagged sublayer')
  assert.ok(mainNode.fills[0].boundVariables, 'the binding lands on the main component node')
  assert.ok(!sublayer.hasOwnOverride(), 'binding propagates from the main component — no override minted')
})

test('unbound-fill re-binds a sublayer whose fill is overridden on this instance', async () => {
  const created = mockFigma()
  const { sublayer, mainNode } = instanceSublayer(created, '5:6', [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], {
    overriddenFills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }],
  })
  const result = await applyLintFix(sublayer, 'unbound-fill', emptyContext())
  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /on main component/)
  assert.match(result.detail, /overridden fills on this instance re-bound/)
  assert.ok(mainNode.fills[0].boundVariables, 'main component bound (red)')
  assert.ok(sublayer.fills[0].boundVariables, 'the override bound too (blue)')
  assert.equal(created.variables.length, 2, 'one variable per distinct color')
})

test('unbound-fill across instances of one component binds the main node just once', async () => {
  const created = mockFigma()
  const ctx = emptyContext()
  const first = instanceSublayer(created, '5:6', [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }])
  const r1 = await applyLintFix(first.sublayer, 'unbound-fill', ctx)
  // A second instance points at the same main sublayer id.
  const secondSublayer: any = { ...first.sublayer, id: 'I10:2;5:6', parent: first.sublayer.parent }
  const r2 = await applyLintFix(secondSublayer, 'unbound-fill', ctx)
  assert.equal(r1.status, 'fixed')
  assert.equal(r2.status, 'fixed')
  assert.match(r2.detail, /shared main component/)
  assert.equal(created.variables.length, 1, 'only one auto variable created for the shared color')
})

test('unbound-fill fixes an overridden sublayer even when the main component is already bound', async () => {
  const created = mockFigma()
  const boundRed = {
    type: 'SOLID',
    color: { r: 1, g: 0, b: 0 },
    boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'var-main' } },
  }
  const { sublayer, mainNode } = instanceSublayer(created, '5:6', [boundRed], {
    overriddenFills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }],
  })
  const result = await applyLintFix(sublayer, 'unbound-fill', emptyContext())
  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /override on this instance; main component already bound/)
  assert.ok(sublayer.fills[0].boundVariables, 'the override got its own binding')
  assert.equal(mainNode.fills[0], boundRed, 'the already-bound main paint is untouched')
  assert.equal(created.variables.length, 1, 'one variable for the override color')
})

test('unbound-fill inside a remote library instance is applied as an override on the sublayer', async () => {
  const created = mockFigma()
  const { sublayer, mainNode } = instanceSublayer(created, '5:6', [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], {
    remote: true,
  })
  const result = await applyLintFix(sublayer, 'unbound-fill', emptyContext())
  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /override on this instance/)
  assert.ok(sublayer.fills[0].boundVariables, 'the override lands on the sublayer itself')
  assert.ok(!mainNode.fills[0].boundVariables, 'the library main component is untouched')
})

test('text-without-style also restyles text overridden on this instance', async () => {
  const created = mockFigma()
  const mainText: any = {
    id: '7:1', name: 'Label', type: 'TEXT',
    fontName: { family: 'Inter', style: 'Regular' }, fontSize: 14,
    lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PERCENT', value: 0 },
    textStyleId: '',
    async setTextStyleIdAsync(id: string) { this.textStyleId = id },
    parent: null,
  }
  const instance: any = {
    id: '10:1',
    type: 'INSTANCE',
    parent: { type: 'PAGE' },
    async getMainComponentAsync() {
      return { id: '99:99', remote: false }
    },
  }
  const sublayer: any = {
    id: 'I10:1;7:1', name: 'Label', type: 'TEXT',
    // Per-instance font override — styling the main component won't reach this sublayer.
    fontName: { family: 'Inter', style: 'Bold' }, fontSize: 14,
    lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PERCENT', value: 0 },
    textStyleId: '',
    async setTextStyleIdAsync(id: string) { this.textStyleId = id },
    parent: instance,
  }
  created.nodesById.set('7:1', mainText)
  const result = await applyLintFix(sublayer, 'text-without-style', emptyContext())
  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /on main component/)
  assert.match(result.detail, /overridden text on this instance restyled/)
  assert.notEqual(mainText.textStyleId, '')
  assert.notEqual(sublayer.textStyleId, '')
  assert.equal(created.textStyles.length, 2, 'Regular for the main, Bold for the override')
})

test('missing-auto-layout inside a library instance is skipped — layout is not overridable', async () => {
  mockFigma()
  const instance: any = {
    id: '10:1',
    type: 'INSTANCE',
    parent: { type: 'PAGE' },
    async getMainComponentAsync() {
      return { id: '99:99', remote: true }
    },
  }
  const frame: any = {
    id: 'I10:1;7:7',
    name: 'Frame',
    type: 'FRAME',
    layoutMode: 'NONE',
    width: 100,
    height: 100,
    children: [],
    parent: instance,
  }
  const result = await applyLintFix(frame, 'missing-auto-layout', emptyContext())
  assert.equal(result.status, 'skipped')
  assert.match(result.detail, /library component/)
})

test('text-without-style applies an existing matching style', async () => {
  mockFigma()
  const ctx = emptyContext()
  ctx.textStyles.push({
    id: 'style-existing',
    name: 'Body',
    fontName: { family: 'Inter', style: 'Regular' },
    fontSize: 14,
    lineHeight: { unit: 'AUTO' },
    letterSpacing: { unit: 'PERCENT', value: 0 },
  } as any)
  const node: any = {
    id: 't1',
    name: 'Text',
    type: 'TEXT',
    fontName: { family: 'Inter', style: 'Regular' },
    fontSize: 14,
    lineHeight: { unit: 'AUTO' },
    letterSpacing: { unit: 'PERCENT', value: 0 },
    textStyleId: '',
    async setTextStyleIdAsync(id: string) {
      this.textStyleId = id
    },
  }
  const result = await applyLintFix(node, 'text-without-style', ctx)
  assert.equal(result.status, 'fixed')
  assert.equal(node.textStyleId, 'style-existing')
})

test('text-without-style creates a style when nothing matches, and fails on mixed fonts', async () => {
  const created = mockFigma()
  const ctx = emptyContext()
  const node: any = {
    id: 't1',
    name: 'Text',
    type: 'TEXT',
    fontName: { family: 'Museo Sans', style: 'Medium' },
    fontSize: 16,
    lineHeight: { unit: 'AUTO' },
    letterSpacing: { unit: 'PERCENT', value: 0 },
    textStyleId: '',
    async setTextStyleIdAsync(id: string) {
      this.textStyleId = id
    },
  }
  const result = await applyLintFix(node, 'text-without-style', ctx)
  assert.equal(result.status, 'fixed')
  assert.equal(created.textStyles[0].name, 'auto/Museo Sans Medium 16')
  assert.equal(node.textStyleId, created.textStyles[0].id)

  const mixedNode: any = { ...node, fontName: MIXED }
  const mixedResult = await applyLintFix(mixedNode, 'text-without-style', ctx)
  assert.equal(mixedResult.status, 'failed')
})

test('text-without-style with mixed fonts applies per-segment styles', async () => {
  const created = mockFigma()
  const ctx = emptyContext()
  ctx.textStyles.push({
    id: 'style-body',
    name: 'Body',
    fontName: { family: 'Inter', style: 'Regular' },
    fontSize: 14,
    lineHeight: { unit: 'AUTO' },
    letterSpacing: { unit: 'PERCENT', value: 0 },
  } as any)
  const ranges: Array<[number, number, string]> = []
  const node: any = {
    id: 't1',
    name: 'Text',
    type: 'TEXT',
    fontName: MIXED,
    fontSize: 14,
    textStyleId: '',
    getStyledTextSegments: () => [
      {
        start: 0, end: 5,
        fontName: { family: 'Inter', style: 'Regular' }, fontSize: 14,
        lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PERCENT', value: 0 },
        textStyleId: '',
      },
      {
        start: 5, end: 12,
        fontName: { family: 'Inter', style: 'Bold' }, fontSize: 14,
        lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PERCENT', value: 0 },
        textStyleId: '',
      },
    ],
    async setRangeTextStyleIdAsync(start: number, end: number, id: string) {
      ranges.push([start, end, id])
    },
  }
  const result = await applyLintFix(node, 'text-without-style', ctx)
  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /per-segment/)
  assert.deepEqual(
    ranges.map((r) => r[2]),
    ['style-body', created.textStyles[0].id],
    'existing style reused for the first run, the bold run gets a created style'
  )
  assert.equal(created.textStyles[0].name, 'auto/Inter Bold 14')
})

test('text-without-style applies a remote style already used on the page', async () => {
  mockFigma()
  ;(globalThis as any).figma.currentPage = {
    findAllWithCriteria: () => [{ textStyleId: 'S:remote' }],
  }
  ;(globalThis as any).figma.getStyleByIdAsync = async (id: string) =>
    id === 'S:remote'
      ? {
          id,
          type: 'TEXT',
          remote: true,
          name: 'DS/Body',
          fontName: { family: 'Inter', style: 'Regular' },
          fontSize: 14,
          lineHeight: { unit: 'AUTO' },
          letterSpacing: { unit: 'PERCENT', value: 0 },
        }
      : null
  const node: any = {
    id: 't1',
    name: 'Text',
    type: 'TEXT',
    fontName: { family: 'Inter', style: 'Regular' },
    fontSize: 14,
    lineHeight: { unit: 'AUTO' },
    letterSpacing: { unit: 'PERCENT', value: 0 },
    textStyleId: '',
    async setTextStyleIdAsync(id: string) {
      this.textStyleId = id
    },
  }
  const result = await applyLintFix(node, 'text-without-style', emptyContext())
  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /"DS\/Body" \(library\)/)
  assert.equal(node.textStyleId, 'S:remote')
})

test('text-without-style does not reuse a style whose line height differs', async () => {
  const created = mockFigma()
  const ctx = emptyContext()
  ctx.textStyles.push({
    id: 'style-existing',
    name: 'Body',
    fontName: { family: 'Inter', style: 'Regular' },
    fontSize: 14,
    lineHeight: { unit: 'PIXELS', value: 24 },
    letterSpacing: { unit: 'PERCENT', value: 0 },
  } as any)
  const node: any = {
    id: 't1',
    name: 'Text',
    type: 'TEXT',
    fontName: { family: 'Inter', style: 'Regular' },
    fontSize: 14,
    lineHeight: { unit: 'AUTO' },
    letterSpacing: { unit: 'PERCENT', value: 0 },
    textStyleId: '',
    async setTextStyleIdAsync(id: string) {
      this.textStyleId = id
    },
  }
  const result = await applyLintFix(node, 'text-without-style', ctx)
  assert.equal(result.status, 'fixed')
  assert.equal(created.textStyles.length, 1, 'a matching-look style is created instead of reflowing the text')
  assert.equal(node.textStyleId, created.textStyles[0].id)
})

test('missing-auto-layout skips when children would visibly shift (uneven gaps)', async () => {
  mockFigma()
  const children = [
    { x: 0, y: 0, width: 100, height: 40 },
    { x: 0, y: 48, width: 100, height: 40 },
    { x: 0, y: 200, width: 100, height: 40 },
  ]
  const node: any = {
    id: 'f1',
    name: 'Frame',
    type: 'FRAME',
    layoutMode: 'NONE',
    width: 100,
    height: 240,
    children,
    appendChild() {
      throw new Error('must not mutate a skipped frame')
    },
    resize() {
      throw new Error('must not mutate a skipped frame')
    },
  }
  const result = await applyLintFix(node, 'missing-auto-layout', emptyContext())
  assert.equal(result.status, 'skipped')
  assert.match(result.detail, /would shift/)
  assert.equal(node.layoutMode, 'NONE')
})

test('missing-auto-layout infers centered cross-axis alignment', async () => {
  mockFigma()
  const children = [
    { x: 50, y: 0, width: 100, height: 40 },
    { x: 75, y: 60, width: 50, height: 40 },
  ]
  const node: any = {
    id: 'f1',
    name: 'Frame',
    type: 'FRAME',
    layoutMode: 'NONE',
    width: 200,
    height: 100,
    children,
    appendChild(child: any) {
      children.splice(children.indexOf(child), 1)
      children.push(child)
    },
    resize() {},
  }
  const result = await applyLintFix(node, 'missing-auto-layout', emptyContext())
  assert.equal(result.status, 'fixed')
  assert.equal(node.layoutMode, 'VERTICAL')
  assert.equal(node.counterAxisAlignItems, 'CENTER', 'centered children keep their centering')
})

test('missing-auto-layout applies inferred layout and keeps the frame size', async () => {
  mockFigma()
  const resizes: Array<[number, number]> = []
  const children = [
    { x: 0, y: 60, width: 100, height: 40 },
    { x: 0, y: 0, width: 100, height: 40 },
  ]
  const node: any = {
    id: 'f1',
    name: 'Frame',
    type: 'FRAME',
    layoutMode: 'NONE',
    width: 100,
    height: 100,
    children,
    appendChild(child: any) {
      children.splice(children.indexOf(child), 1)
      children.push(child)
    },
    resize(w: number, h: number) {
      resizes.push([w, h])
    },
  }
  const result = await applyLintFix(node, 'missing-auto-layout', emptyContext())
  assert.equal(result.status, 'fixed')
  assert.equal(node.layoutMode, 'VERTICAL')
  assert.equal(node.itemSpacing, 20)
  assert.equal(node.primaryAxisSizingMode, 'FIXED')
  assert.deepEqual(resizes, [[100, 100]])
  assert.equal(children[0].y, 0, 'children reordered into visual order')
})

// --- excessive-nesting: unwrap redundant single-child wrappers ---

/** Builds a live-ish node tree: wires parent pointers and working insertChild/appendChild/remove. */
function wire(node: any, parent: any = null): any {
  node.parent = parent
  node.children = node.children ?? []
  node.insertChild = (index: number, child: any) => {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    node.children.splice(index, 0, child)
    child.parent = node
  }
  node.appendChild = (child: any) => node.insertChild(node.children.length, child)
  node.remove = () => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = null
  }
  node.children.forEach((c: any) => wire(c, node))
  return node
}

test('isRedundantWrapper: single-child group / bare frame yes; decorated or multi-child no', () => {
  mockFigma()
  const kid = () => ({ id: 'k', type: 'VECTOR' })
  assert.ok(isRedundantWrapper(wire({ type: 'GROUP', children: [kid()] })))
  assert.ok(isRedundantWrapper(wire({ type: 'FRAME', layoutMode: 'NONE', children: [kid()] })))
  assert.ok(!isRedundantWrapper(wire({ type: 'FRAME', layoutMode: 'NONE', children: [kid(), kid()] })))
  assert.ok(!isRedundantWrapper(wire({ type: 'FRAME', layoutMode: 'NONE', fills: [{ type: 'SOLID' }], children: [kid()] })))
  assert.ok(!isRedundantWrapper(wire({ type: 'FRAME', layoutMode: 'NONE', clipsContent: true, children: [kid()] })))
})

test('isRedundantWrapper: padding blocks only inside an Auto Layout parent (absolute snapshots bake it in)', () => {
  mockFigma()
  const padded = () => ({ type: 'FRAME', layoutMode: 'NONE', paddingLeft: 8, children: [{ id: 'k', type: 'VECTOR' }] })
  const absolute: any = padded()
  wire({ type: 'FRAME', layoutMode: 'NONE', children: [absolute] })
  assert.ok(isRedundantWrapper(absolute), 'absolute parent: padding is baked into the position snapshot')
  const slotted: any = padded()
  wire({ type: 'FRAME', layoutMode: 'VERTICAL', children: [slotted] })
  assert.ok(!isRedundantWrapper(slotted), 'Auto Layout parent: losing the padding would shift the child')
})

test('clipsContent that clips nothing no longer blocks unwrapping; real overflow still does', () => {
  mockFigma()
  const makeFrame = (childBox: any) =>
    wire({
      type: 'FRAME', layoutMode: 'NONE', clipsContent: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      children: [{ id: 'k', type: 'VECTOR', absoluteBoundingBox: childBox }],
    })
  assert.ok(isRedundantWrapper(makeFrame({ x: 10, y: 10, width: 50, height: 50 })), 'child fully inside — clipping is a no-op')
  assert.ok(!isRedundantWrapper(makeFrame({ x: 60, y: 60, width: 80, height: 80 })), 'child overflows — clipping is visible')
})

test('isDissolvableWrapper: neutral multi-child group/frame in absolute parents; never in Auto Layout parents', () => {
  mockFigma()
  const kids = () => [{ id: 'a', type: 'VECTOR' }, { id: 'b', type: 'VECTOR' }]
  const inAbsolute = (wrapper: any) => {
    wire({ type: 'FRAME', layoutMode: 'NONE', children: [wrapper] })
    return wrapper
  }
  assert.ok(isDissolvableWrapper(inAbsolute({ type: 'GROUP', children: kids() })))
  assert.ok(isDissolvableWrapper(inAbsolute({ type: 'FRAME', layoutMode: 'NONE', children: kids() })))
  assert.ok(
    isDissolvableWrapper(inAbsolute({ type: 'FRAME', layoutMode: 'VERTICAL', children: kids() })),
    'an Auto Layout wrapper in an absolute parent ungroups — laid-out positions freeze in place'
  )
  assert.ok(
    !isDissolvableWrapper(inAbsolute({ type: 'FRAME', layoutMode: 'NONE', fills: [{ type: 'SOLID' }], children: kids() })),
    'a painted frame renders something of its own'
  )
  const slotted: any = { type: 'GROUP', children: kids() }
  wire({ type: 'FRAME', layoutMode: 'HORIZONTAL', children: [slotted] })
  assert.ok(!isDissolvableWrapper(slotted), 'in an Auto Layout parent the wrapper is one slot — N children would re-flow it')
})

test('excessive-nesting dissolves a neutral multi-child group (children keep container-space positions)', async () => {
  mockFigma()
  const deep = { id: 'deep', name: 'Deep', type: 'FRAME', layoutMode: 'NONE', x: 30, y: 40, children: [] }
  const sib = { id: 'sib', name: 'Sib', type: 'VECTOR', x: 70, y: 80 }
  const group = { id: 'g', name: 'Group', type: 'GROUP', x: 30, y: 40, children: [deep, sib] }
  const container = { id: 'c', name: 'C', type: 'FRAME', layoutMode: 'NONE', children: [group] }
  wire({ type: 'PAGE', children: [container] })

  const result = await applyLintFix(deep as any, 'excessive-nesting', emptyContext())

  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /removed 1/)
  assert.equal(deep.parent, container)
  assert.equal((sib as any).parent, container)
  assert.deepEqual(container.children.map((c: any) => c.id), ['deep', 'sib'], 'z-order preserved')
  assert.equal(deep.x, 30, 'group children are already in container space — no offset')
  assert.equal(group.parent, null, 'group removed')
})

test('excessive-nesting dissolves a bare multi-child frame, offsetting children by the frame position', async () => {
  mockFigma()
  const deep = { id: 'deep', name: 'Deep', type: 'FRAME', layoutMode: 'NONE', x: 5, y: 6, children: [] }
  const sib = { id: 'sib', name: 'Sib', type: 'VECTOR', x: 50, y: 60 }
  const bare = { id: 'w', name: 'W', type: 'FRAME', layoutMode: 'NONE', x: 10, y: 20, children: [deep, sib] }
  const container = { id: 'c', name: 'C', type: 'FRAME', layoutMode: 'NONE', children: [bare] }
  wire({ type: 'PAGE', children: [container] })

  const result = await applyLintFix(deep as any, 'excessive-nesting', emptyContext())

  assert.equal(result.status, 'fixed')
  assert.equal(deep.x, 15, 'x = frame.x + child.x')
  assert.equal(deep.y, 26)
  assert.equal((sib as any).x, 60)
  assert.equal((sib as any).y, 80)
  assert.equal((bare as any).parent, null, 'bare frame removed')
})

test('excessive-nesting merges a padded same-direction Auto Layout container into its parent', async () => {
  mockFigma()
  const deep: any = { id: 'deep', name: 'Deep', type: 'TEXT' }
  // Section (V, 800×600, padding 40) > Container (V, spans the content box, padding 24) > deep
  const container: any = {
    id: 'cont', name: 'Container', type: 'FRAME', layoutMode: 'VERTICAL',
    width: 720, height: 520, itemSpacing: 16,
    paddingLeft: 24, paddingRight: 24, paddingTop: 24, paddingBottom: 24,
    primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'CENTER',
    children: [deep],
  }
  const section: any = {
    id: 'sec', name: 'Section', type: 'FRAME', layoutMode: 'VERTICAL',
    width: 800, height: 600, itemSpacing: 0, fills: [{ type: 'SOLID', visible: true }],
    paddingLeft: 40, paddingRight: 40, paddingTop: 40, paddingBottom: 40,
    children: [container],
  }
  const template = { id: 'tpl', name: 'T', type: 'FRAME', layoutMode: 'NONE', children: [section] }
  wire({ type: 'PAGE', children: [template] })

  const result = await applyLintFix(deep as any, 'excessive-nesting', emptyContext())

  assert.equal(result.status, 'fixed')
  assert.equal(deep.parent, section, 'child adopted by the section')
  assert.equal(section.paddingLeft, 64, 'paddings summed')
  assert.equal(section.itemSpacing, 16, 'spacing taken from the merged container')
  assert.equal(section.counterAxisAlignItems, 'CENTER')
  assert.equal(container.parent, null, 'container removed')
})

test('canMergeAutoLayoutWrapper refuses direction mismatch, siblings, paint, or a smaller box', () => {
  mockFigma()
  const build = (over: any, parentOver: any = {}) => {
    const wrapper: any = {
      type: 'FRAME', layoutMode: 'VERTICAL', width: 720, height: 520,
      paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
      children: [{ id: 'k', type: 'VECTOR' }], ...over,
    }
    wire({
      type: 'FRAME', layoutMode: 'VERTICAL', width: 800, height: 600,
      paddingLeft: 40, paddingRight: 40, paddingTop: 40, paddingBottom: 40,
      children: [wrapper], ...parentOver,
    })
    return wrapper
  }
  assert.ok(canMergeAutoLayoutWrapper(build({})))
  assert.ok(!canMergeAutoLayoutWrapper(build({ layoutMode: 'HORIZONTAL' })), 'direction mismatch')
  assert.ok(!canMergeAutoLayoutWrapper(build({ fills: [{ type: 'SOLID' }] })), 'painted wrapper')
  assert.ok(!canMergeAutoLayoutWrapper(build({ width: 400 })), 'does not span the content box')
  const withSibling = build({})
  withSibling.parent.children.push({ id: 's', type: 'VECTOR' })
  assert.ok(!canMergeAutoLayoutWrapper(withSibling), 'parent has other children')
})

test('excessive-nesting ungroups an Auto Layout frame inside an absolute parent (positions frozen)', async () => {
  mockFigma()
  const deep = { id: 'deep', name: 'Deep', type: 'TEXT', x: 24, y: 24 }
  const sib = { id: 'sib', name: 'Sib', type: 'VECTOR', x: 24, y: 80 }
  const stack: any = {
    id: 'st', name: 'Stack', type: 'FRAME', layoutMode: 'VERTICAL', x: 100, y: 50,
    paddingLeft: 24, paddingTop: 24, children: [deep, sib],
  }
  // The fill pins canvasFrame itself (paint role) so only the stack dissolves in this walk.
  const canvasFrame = { id: 'c', name: 'C', type: 'FRAME', layoutMode: 'NONE', fills: [{ type: 'SOLID' }], children: [stack] }
  wire({ type: 'PAGE', children: [{ id: 'tpl', type: 'FRAME', layoutMode: 'NONE', children: [canvasFrame] }] })

  const result = await applyLintFix(deep as any, 'excessive-nesting', emptyContext())

  assert.equal(result.status, 'fixed')
  assert.equal((deep as any).parent, canvasFrame)
  assert.equal((deep as any).x, 124, 'laid-out position frozen: frame.x + child.x')
  assert.equal((sib as any).y, 130)
  assert.equal(stack.parent, null)
})

test('excessive-nesting never dissolves a top-level frame into the page', async () => {
  mockFigma()
  const deep = { id: 'deep', name: 'Deep', type: 'FRAME', layoutMode: 'NONE', children: [] }
  const sib = { id: 'sib', name: 'Sib', type: 'VECTOR' }
  const template = { id: 'tpl', name: 'Template', type: 'FRAME', layoutMode: 'NONE', children: [deep, sib] }
  const page = wire({ type: 'PAGE', children: [template] })

  const result = await applyLintFix(deep as any, 'excessive-nesting', emptyContext())

  assert.equal(result.status, 'skipped')
  assert.equal((template as any).parent, page, 'template root untouched')
})

test('excessive-nesting unwraps an absolute wrapper, snapshotting the child’s rendered position', async () => {
  mockFigma()
  const deep = { id: 'deep', name: 'Deep', type: 'FRAME', layoutMode: 'NONE', x: 3, y: 4, children: [] }
  const wrapper = { id: 'w', name: 'Wrapper', type: 'FRAME', layoutMode: 'NONE', x: 10, y: 20, children: [deep] }
  const sibling = { id: 's', name: 'S', type: 'FRAME', layoutMode: 'NONE', children: [] }
  const container = { id: 'c', name: 'Container', type: 'FRAME', layoutMode: 'NONE', children: [wrapper, sibling] }
  wire({ type: 'PAGE', children: [container] })

  const result = await applyLintFix(deep as any, 'excessive-nesting', emptyContext())

  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /removed 1/)
  assert.equal(deep.parent, container, 'child lifted into the grandparent')
  assert.equal(deep.x, 13, 'x = wrapper.x + child.x')
  assert.equal(deep.y, 24)
  assert.equal(wrapper.parent, null, 'wrapper removed')
})

test('excessive-nesting unwraps an Auto Layout wrapper, transferring its layout-participation props', async () => {
  mockFigma()
  const deep: any = { id: 'deep', name: 'Deep', type: 'FRAME', layoutMode: 'NONE', children: [] }
  const wrapper = {
    id: 'w', name: 'Wrapper', type: 'FRAME', layoutMode: 'NONE',
    layoutGrow: 1, layoutAlign: 'STRETCH', layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG',
    layoutPositioning: 'AUTO', children: [deep],
  }
  const sibling = { id: 's', type: 'FRAME', layoutMode: 'NONE', children: [] }
  const container = { id: 'c', type: 'FRAME', layoutMode: 'HORIZONTAL', children: [wrapper, sibling] }
  wire({ type: 'PAGE', children: [container] })

  const result = await applyLintFix(deep as any, 'excessive-nesting', emptyContext())

  assert.equal(result.status, 'fixed')
  assert.equal(deep.parent, container)
  assert.equal(deep.layoutGrow, 1)
  assert.equal(deep.layoutAlign, 'STRETCH')
  assert.equal(deep.layoutSizingHorizontal, 'FILL')
})

test('excessive-nesting is skipped when there are no redundant wrappers to remove', async () => {
  mockFigma()
  const deep = { id: 'deep', type: 'FRAME', layoutMode: 'NONE', children: [] }
  const other = { id: 'o', type: 'FRAME', layoutMode: 'NONE', children: [] }
  const container = { id: 'c', type: 'FRAME', layoutMode: 'NONE', children: [deep, other] }
  wire({ type: 'PAGE', children: [container] })

  const result = await applyLintFix(deep as any, 'excessive-nesting', emptyContext())

  assert.equal(result.status, 'skipped')
  assert.match(result.detail, /no redundant wrapper/)
})

test('annotateUnfixableFindings marks hopeless findings and leaves fixable ones alone', async () => {
  mockFigma()
  // excessive-nesting with nothing to unwrap: the parent holds two children (not a wrapper).
  const deep = { id: 'deep', name: 'Deep', type: 'FRAME', layoutMode: 'NONE', children: [] }
  const sibling = { id: 's', name: 'S', type: 'FRAME', layoutMode: 'NONE', children: [] }
  wire({ type: 'PAGE', children: [{ id: 'c', name: 'C', type: 'FRAME', layoutMode: 'NONE', children: [deep, sibling] }] })

  const overlap: any = {
    id: 'ov', name: 'Overlap', type: 'FRAME', layoutMode: 'NONE', width: 200, height: 200,
    children: [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 20, y: 20, width: 100, height: 100 },
    ],
    parent: { type: 'PAGE' },
  }
  const stack: any = {
    id: 'st', name: 'Stack', type: 'FRAME', layoutMode: 'NONE', width: 100, height: 100,
    children: [
      { x: 0, y: 0, width: 100, height: 40 },
      { x: 0, y: 60, width: 100, height: 40 },
    ],
    parent: { type: 'PAGE' },
  }

  const findings: any[] = [
    { nodeId: 'deep', nodeName: 'Deep', rule: 'excessive-nesting', message: 'too deep' },
    { nodeId: 'ov', nodeName: 'Overlap', rule: 'missing-auto-layout', message: 'no AL' },
    { nodeId: 'st', nodeName: 'Stack', rule: 'missing-auto-layout', message: 'no AL' },
  ]
  const byId = new Map<string, any>([
    ['deep', deep],
    ['ov', overlap],
    ['st', stack],
  ])
  await annotateUnfixableFindings(findings, byId)

  assert.equal(findings[0].fixable, false)
  assert.match(findings[0].message, /manual flattening/)
  assert.equal(findings[1].fixable, false)
  assert.match(findings[1].message, /overlap/)
  assert.equal(findings[2].fixable, undefined, 'a clean stack stays fixable')
})

test('excessive-nesting detaches a blocking component, then unwraps the freed structure', async () => {
  mockFigma()
  // Live instance sublayers (read-only): a redundant wrapper around the flagged node.
  const deep = { id: 'I1;deep', type: 'FRAME', layoutMode: 'NONE', children: [] }
  const wrapper = { id: 'I1;w', type: 'FRAME', layoutMode: 'NONE', children: [deep] }

  // What detachInstance() returns: the same structure as an editable frame (new ids).
  const deepCopy: any = { id: 'deep2', name: 'Deep', type: 'FRAME', layoutMode: 'NONE', x: 5, y: 6, children: [] }
  const wrapperCopy = { id: 'w2', type: 'FRAME', layoutMode: 'NONE', x: 1, y: 2, children: [deepCopy] }
  const detachedFrame = wire({ id: 'det', type: 'FRAME', layoutMode: 'NONE', children: [wrapperCopy] })

  const instance: any = { id: 'I1', name: 'Card', type: 'INSTANCE', children: [wrapper], detachInstance: () => detachedFrame }
  wire({ type: 'PAGE', children: [instance] })

  const result = await applyLintFix(deep as any, 'excessive-nesting', emptyContext())

  assert.equal(result.status, 'fixed')
  assert.match(result.detail, /detached/)
  assert.equal(deepCopy.parent, detachedFrame, 'freed child lifted out of the copied wrapper')
  assert.equal(deepCopy.x, 6, 'x = wrapperCopy.x + deepCopy.x')
})
