import test from 'node:test'
import assert from 'node:assert/strict'
import { codeConnectFile, codeConnectId, fileKeyFrom, type CodeConnectProp } from './code-connect.ts'
import { emitReact } from './index.ts'

function baseOptions(props: ReadonlyMap<string, CodeConnectProp>) {
  return {
    componentName: 'Button',
    componentPath: 'src/components/Button.tsx',
    nodeId: '819:95512',
    props,
    fileKey: 'ABC123XYZ',
    fileName: 'Marketing Site',
  }
}

test('a template starts with the metadata comments Code Connect 2 reads, the node id written with a dash', () => {
  const lines = codeConnectFile(baseOptions(new Map())).split('\n')
  assert.deepEqual(lines.slice(0, 4), [
    '// url=https://www.figma.com/design/ABC123XYZ/Marketing-Site?node-id=819-95512',
    '// source=src/components/Button.tsx',
    '// component=Button',
    "import figma from 'figma'",
  ])
})

test('each prop is read with the accessor its Figma type maps to, variants mapped to the values the component compiles against', () => {
  const props = new Map<string, CodeConnectProp>([
    ['type', { kind: 'variant', figmaName: 'Type', values: ['Primary', 'Extra Large', 'Meduim'] }],
    ['label', { kind: 'text', figmaName: 'Button-lable' }],
    ['rightIcon', { kind: 'boolean', figmaName: 'Right Icon' }],
  ])
  const file = codeConnectFile(baseOptions(props))
  assert.match(file, /type: instance\.getEnum\('Type', \{ Primary: 'Primary', 'Extra Large': 'Extra Large', Meduim: 'Meduim' \}\),/)
  assert.match(file, /label: instance\.getString\('Button-lable'\),/)
  assert.match(file, /rightIcon: instance\.getBoolean\('Right Icon'\),/)
  // Rendered through Figma's own helper, never concatenated: the snippet stays sections Dev Mode can pill.
  assert.match(file, /figma\.code`<Button\$\{figma\.helpers\.react\.renderProp\('type', props\['type'\]\)\}/)
})

test('the #nodeId suffix Figma appends to a property definition name never reaches the template', () => {
  const props = new Map<string, CodeConnectProp>([['rightIcon', { kind: 'boolean', figmaName: 'Right Icon#1956:6' }]])
  const file = codeConnectFile(baseOptions(props))
  assert.match(file, /getBoolean\('Right Icon'\)/)
  assert.doesNotMatch(file, /#1956:6/)
})

test('a quote or backslash in a Figma name is escaped, so the template still parses', () => {
  const props = new Map<string, CodeConnectProp>([['label', { kind: 'text', figmaName: "Kid's \\ label" }]])
  assert.match(codeConnectFile(baseOptions(props)), /getString\('Kid\\'s \\\\ label'\)/)
})

test('a component with no props still gets a valid template, and reads nothing off the instance', () => {
  const file = codeConnectFile(baseOptions(new Map()))
  assert.doesNotMatch(file, /selectedInstance/)
  assert.match(file, /example: figma\.code`<Button \/>`,/)
  assert.match(file, /imports: \['import \{ Button \} from \\'\.\/components\/Button\\''\],/)
})

test('the template id follows the node, not the name, so a rename or re-export keeps the published mapping', () => {
  assert.equal(codeConnectId('819:95512'), 'allcrew-819-95512')
  const renamed = codeConnectFile({ ...baseOptions(new Map()), componentName: 'PrimaryButton' })
  assert.match(renamed, /id: 'allcrew-819-95512',/)
})

test('a file key is taken from a pasted Figma link, a branch link or a bare key, and never guessed', () => {
  assert.equal(fileKeyFrom('https://www.figma.com/design/AbC123xYz9/Site?node-id=1-2'), 'AbC123xYz9')
  assert.equal(fileKeyFrom('https://www.figma.com/file/AbC123xYz9/Site'), 'AbC123xYz9')
  assert.equal(fileKeyFrom('https://www.figma.com/design/AbC123xYz9/Site/branch/BrAnCh12345/Site'), 'BrAnCh12345')
  assert.equal(fileKeyFrom('AbC123xYz9'), 'AbC123xYz9')
  assert.equal(fileKeyFrom('https://example.com/design/AbC123xYz9'), null)
  assert.equal(fileKeyFrom('Marketing Site'), null)
  assert.equal(fileKeyFrom(undefined), null)
})

// --- emitReact wiring ---------------------------------------------------------------------------

/** The IrNodeBase fields every fixture below needs — none of them mean anything to Code Connect,
 * they exist only so the rest of the pipeline (CSS, JSX) has something to read. */
function irBase() {
  return {
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' as const }, height: { mode: 'hug' as const } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
  }
}

function buttonInstance(id: string, variant: string) {
  return {
    ...irBase(),
    id,
    name: 'Button',
    type: 'instance-ref' as const,
    layout: { kind: 'absolute' as const },
    componentId: '819:95512',
    componentKey: 'key-819',
    componentSetName: 'Button',
    componentProperties: {
      Type: { type: 'VARIANT' as const, value: variant },
      'Button-lable#1956:6': { type: 'TEXT' as const, value: variant },
      'Right Icon#1957:7': { type: 'BOOLEAN' as const, value: true },
    },
    restyled: true as const,
    children: [],
  }
}

function screenWith(children: unknown[]) {
  return { ...irBase(), id: '1:1', name: 'Screen', type: 'container' as const, layout: { kind: 'absolute' as const }, children }
}

function sceneSource() {
  return { getCSSAsync: async () => ({}) }
}

test('without a file key, emitReact writes no templates at all and says how to give it one', async () => {
  const b1 = buttonInstance('1:100', 'Primary')
  const b2 = buttonInstance('1:200', 'Secondary')
  const screen = screenWith([b1, b2])
  const sceneNodesById = new Map([
    ['1:1', sceneSource()],
    ['1:100', sceneSource()],
    ['1:200', sceneSource()],
  ])

  const result = await emitReact([screen] as never, sceneNodesById as never, new Map(), {})
  assert.equal(Object.keys(result.files).filter((path) => path.endsWith('.figma.ts')).length, 0)
  assert.equal('figma.config.json' in result.files, false)
  assert.ok(result.gaps.some((gap) => gap.includes('Code Connect file URL')))
})

test('with a file key, emitReact writes a template per component, a parserless config, and a typed project to check them', async () => {
  const b1 = buttonInstance('1:100', 'Primary')
  const b2 = buttonInstance('1:200', 'Secondary')
  const screen = screenWith([b1, b2])
  const sceneNodesById = new Map([
    ['1:1', sceneSource()],
    ['1:100', sceneSource()],
    ['1:200', sceneSource()],
  ])

  const result = await emitReact([screen] as never, sceneNodesById as never, new Map(), {
    fileKey: 'ABC123XYZ',
    fileName: 'Marketing Site',
  })
  assert.match(result.files['src/components/Button.figma.ts']!, /node-id=819-95512/)
  const config = JSON.parse(result.files['figma.config.json']!)
  assert.deepEqual(config, { codeConnect: { include: ['src/components/**/*.figma.ts'], label: 'React', language: 'jsx' } })
  const pkg = JSON.parse(result.files['package.json']!)
  assert.equal(pkg.devDependencies['@figma/code-connect'], '^2.0.2')
  assert.equal(pkg.scripts['figma:publish'], 'figma connect publish')
  // The app build never sees the `figma` module; the templates are their own typed project.
  assert.deepEqual(JSON.parse(result.files['tsconfig.json']!).exclude, ['src/**/*.figma.ts'])
  assert.deepEqual(JSON.parse(result.files['tsconfig.figma.json']!).compilerOptions.types, ['@figma/code-connect/figma-types'])
})
