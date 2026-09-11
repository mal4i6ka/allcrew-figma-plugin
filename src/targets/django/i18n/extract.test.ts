import test from 'node:test'
import assert from 'node:assert/strict'
import { extractStrings } from './extract.ts'
import { renderTextSpans } from '../html-emitter.ts'

function makeTextNode(overrides: any = {}): any {
  const store = new Map<string, string>()
  return {
    id: 'text:1',
    type: 'TEXT',
    name: 'Label',
    characters: 'Place order',
    parent: null,
    getStyledTextSegments: () => [{ characters: 'Place order', start: 0, end: 11, fontWeight: 400, hyperlink: null }],
    getSharedPluginData: (namespace: string, key: string) => store.get(`${namespace}:${key}`) ?? '',
    setSharedPluginData: (namespace: string, key: string, value: string) => {
      store.set(`${namespace}:${key}`, value)
    },
    ...overrides,
  }
}

function makeFrame(name: string, children: any[], parent: any = null): any {
  const frame = { id: `frame:${name}`, type: 'FRAME', name, children, parent }
  for (const child of children) child.parent = frame
  return frame
}

function makePage(name: string, children: any[]): any {
  const page = { id: `page:${name}`, type: 'PAGE', name, children, parent: { type: 'DOCUMENT' } }
  for (const child of children) child.parent = page
  return page
}

function setFigma(fileKey: string | undefined = 'AbC123') {
  ;(globalThis as any).figma = { skipInvisibleInstanceChildren: false, fileKey }
}

test('extractStrings walks TEXT nodes and normalizes whitespace into msgid', async () => {
  setFigma()
  const node = makeTextNode({ characters: 'Place  \norder' })
  const root = makePage('Page 1', [node])

  const [entry] = await extractStrings(root)

  assert.equal(entry.msgid, 'Place order')
})

test('extractStrings dedupes by (msgctxt, text) and aggregates references', async () => {
  setFigma()
  const a = makeTextNode({ id: 'text:1', name: 'CTA A', characters: 'Cancel' })
  const b = makeTextNode({ id: 'text:2', name: 'CTA B', characters: 'Cancel' })
  const root = makePage('Page 1', [a, b])

  const entries = await extractStrings(root)

  assert.equal(entries.length, 1)
  assert.equal(entries[0].nodeIds.length, 2)
  assert.deepEqual(entries[0].nodeIds, ['text:1', 'text:2'])
  assert.equal(entries[0].references.length, 2)
})

test('extractStrings keeps distinct msgctxt entries separate even for identical text', async () => {
  setFigma()
  const withCtx = makeTextNode({ id: 'text:1', characters: 'Cancel' })
  withCtx.setSharedPluginData('altery', 'i18nKey', JSON.stringify({ context: 'modal' }))
  const withoutCtx = makeTextNode({ id: 'text:2', characters: 'Cancel' })
  const root = makePage('Page 1', [withCtx, withoutCtx])

  const entries = await extractStrings(root)

  assert.equal(entries.length, 2)
  assert.deepEqual(
    entries.map((e) => e.msgctxt).sort(),
    ['', 'modal']
  )
})

test('extractStrings skips nodes that normalize to an empty string', async () => {
  setFigma()
  const empty = makeTextNode({ id: 'text:1', characters: '   ' })
  const root = makePage('Page 1', [empty])

  const entries = await extractStrings(root)

  assert.equal(entries.length, 0)
})

test('extractStrings builds figma:// reference with fileKey and layer path', async () => {
  setFigma('AbC123')
  const node = makeTextNode({ id: 'text:1', name: 'CTA' })
  const frame = makeFrame('Checkout', [node])
  const root = makePage('Page 1', [frame])

  const [entry] = await extractStrings(root)

  assert.equal(entry.references[0], 'figma://AbC123?node-id=text:1 Page 1/Checkout/CTA')
})

test('extractStrings leaves markup null for a single style run', async () => {
  setFigma()
  const node = makeTextNode({ characters: 'Place order' })
  const root = makePage('Page 1', [node])

  const [entry] = await extractStrings(root)

  assert.equal(entry.markup, null)
})

test("extractStrings splits a two-run node into one entry per style run, matching html-emitter's per-run translate tags", async () => {
  setFigma()
  const node = makeTextNode({
    characters: 'Read the docs',
    getStyledTextSegments: () => [
      { characters: 'Read the ', start: 0, end: 9, fontWeight: 400, hyperlink: null },
      { characters: 'docs', start: 9, end: 13, fontWeight: 700, hyperlink: null },
    ],
  })
  const root = makePage('Page 1', [node])

  const entries = await extractStrings(root)

  assert.equal(entries.length, 2)
  assert.deepEqual(
    entries.map((e) => e.msgid),
    ['Read the ', 'docs']
  )
  assert.ok(entries.every((e) => e.markup === null))

  // Cross-check against the actual template output: every extracted msgid must appear as its
  // own `{% translate %}` tag in what html-emitter.ts renders for these same segments.
  const rendered = renderTextSpans('label', node.getStyledTextSegments([]))
  for (const entry of entries) {
    assert.ok(rendered.includes(`{% translate "${entry.msgid}" %}`), `missing template tag for msgid "${entry.msgid}"`)
  }
})

test('extractStrings splits a hyperlink-spanning run out too, preserving inter-run spacing without markup', async () => {
  setFigma()
  const node = makeTextNode({
    characters: 'Read the docs before starting',
    getStyledTextSegments: () => [
      { characters: 'Read ', start: 0, end: 5, fontWeight: 400, hyperlink: null },
      { characters: 'the docs', start: 5, end: 13, fontWeight: 400, hyperlink: { type: 'URL', value: 'https://example.com' } },
      { characters: ' before starting', start: 13, end: 30, fontWeight: 400, hyperlink: null },
    ],
  })
  const root = makePage('Page 1', [node])

  const entries = await extractStrings(root)

  assert.deepEqual(
    entries.map((e) => e.msgid),
    ['Read ', 'the docs', ' before starting']
  )
})

test('extractStrings reaches a bound STRING variable through resolveKey, using its variable-name context', async () => {
  const node = makeTextNode({
    characters: 'stale cached text',
    boundVariables: { characters: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } },
  })
  const root = makePage('Page 1', [node])
  ;(globalThis as any).figma = {
    skipInvisibleInstanceChildren: false,
    fileKey: 'AbC123',
    variables: {
      getVariableByIdAsync: async () => ({
        name: 'checkout/submit_button',
        resolvedType: 'STRING',
        variableCollectionId: 'VariableCollectionId:1',
        valuesByMode: { modeEn: 'Place order' },
      }),
      getVariableCollectionByIdAsync: async () => ({ modes: [{ modeId: 'modeEn', name: 'en' }] }),
    },
  }

  const [entry] = await extractStrings(root)

  assert.equal(entry.msgid, 'Place order')
  assert.equal(entry.msgctxt, 'checkout')
})

test('extractStrings applies a manual placeholder annotation as a gettext %(name)s token', async () => {
  setFigma()
  const node = makeTextNode({ characters: 'Hello, Anna!' })
  node.setSharedPluginData('altery', 'i18nKey', JSON.stringify({ placeholders: [{ start: 7, end: 11, name: 'username' }] }))
  const root = makePage('Page 1', [node])

  const [entry] = await extractStrings(root)

  assert.equal(entry.msgid, 'Hello, %(username)s!')
})

test('extractStrings carries a manual plural annotation into msgid/msgidPlural', async () => {
  setFigma()
  const node = makeTextNode({ characters: '%(count)d item' })
  node.setSharedPluginData('altery', 'i18nKey', JSON.stringify({ plural: { one: '%(count)d item', other: '%(count)d items' } }))
  const root = makePage('Page 1', [node])

  const [entry] = await extractStrings(root)

  assert.equal(entry.msgid, '%(count)d item')
  assert.equal(entry.msgidPlural, '%(count)d items')
})

test('extractStrings uses the layer name as the #. extracted comment', async () => {
  setFigma()
  const node = makeTextNode({ id: 'text:1', name: 'Primary CTA' })
  const root = makePage('Page 1', [node])

  const [entry] = await extractStrings(root)

  assert.equal(entry.comment, 'Primary CTA')
})
