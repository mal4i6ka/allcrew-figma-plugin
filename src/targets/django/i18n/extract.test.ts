import test from 'node:test'
import assert from 'node:assert/strict'
import { extractStrings } from './extract.ts'

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

test('extractStrings builds <strong> markup from a heavier-weight segment', async () => {
  setFigma()
  const node = makeTextNode({
    characters: 'Read the docs',
    getStyledTextSegments: () => [
      { characters: 'Read the ', start: 0, end: 9, fontWeight: 400, hyperlink: null },
      { characters: 'docs', start: 9, end: 13, fontWeight: 700, hyperlink: null },
    ],
  })
  const root = makePage('Page 1', [node])

  const [entry] = await extractStrings(root)

  assert.equal(entry.markup, 'Read the <strong>docs</strong>')
})

test('extractStrings builds <a> markup from a URL hyperlink segment', async () => {
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

  const [entry] = await extractStrings(root)

  assert.equal(entry.markup, 'Read <a href="https://example.com">the docs</a> before starting')
})

test('extractStrings uses the layer name as the #. extracted comment', async () => {
  setFigma()
  const node = makeTextNode({ id: 'text:1', name: 'Primary CTA' })
  const root = makePage('Page 1', [node])

  const [entry] = await extractStrings(root)

  assert.equal(entry.comment, 'Primary CTA')
})
