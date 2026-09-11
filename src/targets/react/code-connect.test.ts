import test from 'node:test'
import assert from 'node:assert/strict'
import { codeConnectFile, type CodeConnectProp } from './code-connect.ts'
import { emitReact } from './index.ts'

function baseOptions(props: ReadonlyMap<string, CodeConnectProp>) {
  return {
    componentName: 'Button',
    componentPath: 'src/components/Button.tsx',
    nodeId: '819:95512',
    props,
    fileKey: 'ABC123XYZ',
    fileName: 'New Website Django',
  }
}

test('a Figma node id becomes the URL with a dash, never the colon Figma stores it with', () => {
  const file = codeConnectFile(baseOptions(new Map()))
  assert.match(file, /node-id=819-95512/)
  assert.doesNotMatch(file, /819:95512/)
})

test('a VARIANT prop becomes figma.enum naming every value the components own union type has, typos included', () => {
  const props = new Map<string, CodeConnectProp>([
    ['type', { kind: 'variant', figmaName: 'Type', values: ['Primary', 'Secondary', 'Meduim'] }],
  ])
  const file = codeConnectFile(baseOptions(props))
  assert.match(file, /type: figma\.enum\('Type', \{ Primary: 'Primary', Secondary: 'Secondary', Meduim: 'Meduim' \}\)/)
})

test('a BOOLEAN prop becomes figma.boolean', () => {
  const props = new Map<string, CodeConnectProp>([['rightIcon', { kind: 'boolean', figmaName: 'Right Icon' }]])
  const file = codeConnectFile(baseOptions(props))
  assert.match(file, /rightIcon: figma\.boolean\('Right Icon'\)/)
})

test('a TEXT prop becomes figma.string', () => {
  const props = new Map<string, CodeConnectProp>([['label', { kind: 'text', figmaName: 'Label' }]])
  const file = codeConnectFile(baseOptions(props))
  assert.match(file, /label: figma\.string\('Label'\)/)
})

test('the #nodeId suffix Figma appends to a property definition name never reaches the connect file', () => {
  const props = new Map<string, CodeConnectProp>([
    ['rightIcon', { kind: 'boolean', figmaName: 'Right Icon#1956:6' }],
  ])
  const file = codeConnectFile(baseOptions(props))
  assert.match(file, /rightIcon: figma\.boolean\('Right Icon'\)/)
  assert.doesNotMatch(file, /#1956:6/)
})

test('a component with no props of its own still gets a valid file, with an empty props object', () => {
  const file = codeConnectFile(baseOptions(new Map()))
  assert.match(file, /props: \{\},/)
  assert.match(file, /example: \(props\) => <Button \/>,/)
})

test('the full connect file for a Button — variant, text and boolean props together', () => {
  const props = new Map<string, CodeConnectProp>([
    ['type', { kind: 'variant', figmaName: 'Type', values: ['Primary', 'Secondary'] }],
    ['label', { kind: 'text', figmaName: 'Button-lable' }],
    ['rightIcon', { kind: 'boolean', figmaName: 'Right Icon' }],
  ])
  const file = codeConnectFile(baseOptions(props))
  assert.equal(
    file,
    `import figma from '@figma/code-connect'
import { Button } from './Button'

figma.connect(Button, 'https://www.figma.com/design/ABC123XYZ/New-Website-Django?node-id=819-95512', {
  props: {
    type: figma.enum('Type', { Primary: 'Primary', Secondary: 'Secondary' }),
    label: figma.string('Button-lable'),
    rightIcon: figma.boolean('Right Icon'),
  },
  example: (props) => <Button type={props.type} label={props.label} rightIcon={props.rightIcon} />,
})
`
  )
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

test('without a file key, emitReact writes no .figma.tsx files at all and says why', async () => {
  const b1 = buttonInstance('1:100', 'Primary')
  const b2 = buttonInstance('1:200', 'Secondary')
  const screen = screenWith([b1, b2])
  const sceneNodesById = new Map([
    ['1:1', sceneSource()],
    ['1:100', sceneSource()],
    ['1:200', sceneSource()],
  ])

  const result = await emitReact([screen] as never, sceneNodesById as never, new Map(), {})
  assert.equal(Object.keys(result.files).filter((path) => path.endsWith('.figma.tsx')).length, 0)
  assert.equal('figma.config.json' in result.files, false)
  assert.ok(result.gaps.some((gap) => gap.includes('figma.fileKey')))
})

test('with a file key, emitReact writes one .figma.tsx per library component plus a root figma.config.json', async () => {
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
    fileName: 'New Website Django',
  })
  assert.ok('src/components/Button.figma.tsx' in result.files)
  assert.match(result.files['src/components/Button.figma.tsx']!, /node-id=819-95512/)
  const config = JSON.parse(result.files['figma.config.json']!)
  assert.deepEqual(config.codeConnect.include, ['src/components/**/*.tsx'])
})
