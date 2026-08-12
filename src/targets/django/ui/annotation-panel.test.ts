import test from 'node:test'
import assert from 'node:assert/strict'
import {
  loadAnnotationForm,
  formToAnnotation,
  applyAnnotationForm,
  renderAnnotationPanel,
  type AnnotationFormState,
} from './annotation-panel.ts'

function makeNode(characters = 'Hello, Anna!'): any {
  const store = new Map<string, string>()
  return {
    characters,
    getSharedPluginData: (namespace: string, key: string) => store.get(`${namespace}:${key}`) ?? '',
    setSharedPluginData: (namespace: string, key: string, value: string) => {
      store.set(`${namespace}:${key}`, value)
    },
  }
}

function emptyForm(overrides: Partial<AnnotationFormState> = {}): AnnotationFormState {
  return { context: '', pluralEnabled: false, pluralOne: '', pluralOther: '', placeholders: [], ...overrides }
}

test('loadAnnotationForm returns an empty form for a node with no annotation', () => {
  assert.deepEqual(loadAnnotationForm(makeNode()), emptyForm())
})

test('loadAnnotationForm surfaces a stored context', () => {
  const node = makeNode()
  node.setSharedPluginData('altery', 'i18nKey', JSON.stringify({ context: 'checkout.submit' }))
  assert.deepEqual(loadAnnotationForm(node), emptyForm({ context: 'checkout.submit' }))
})

test('loadAnnotationForm surfaces stored plural forms with the toggle enabled', () => {
  const node = makeNode()
  node.setSharedPluginData(
    'altery',
    'i18nKey',
    JSON.stringify({ plural: { one: '%(count)d item', other: '%(count)d items' } })
  )
  assert.deepEqual(
    loadAnnotationForm(node),
    emptyForm({ pluralEnabled: true, pluralOne: '%(count)d item', pluralOther: '%(count)d items' })
  )
})

test('loadAnnotationForm surfaces stored placeholder ranges', () => {
  const node = makeNode('Hello, Anna!')
  node.setSharedPluginData(
    'altery',
    'i18nKey',
    JSON.stringify({ placeholders: [{ start: 7, end: 11, name: 'username' }] })
  )
  assert.deepEqual(
    loadAnnotationForm(node),
    emptyForm({ placeholders: [{ start: 7, end: 11, name: 'username' }] })
  )
})

test('formToAnnotation drops the plural pair when the toggle is off', () => {
  const form = emptyForm({ pluralEnabled: false, pluralOne: '%(count)d item', pluralOther: '%(count)d items' })
  assert.deepEqual(formToAnnotation(form), {})
})

test('formToAnnotation includes context/plural/placeholders when set', () => {
  const form: AnnotationFormState = {
    context: 'cart',
    pluralEnabled: true,
    pluralOne: '%(count)d item',
    pluralOther: '%(count)d items',
    placeholders: [{ start: 0, end: 4, name: 'name' }],
  }
  assert.deepEqual(formToAnnotation(form), {
    context: 'cart',
    plural: { one: '%(count)d item', other: '%(count)d items' },
    placeholders: [{ start: 0, end: 4, name: 'name' }],
  })
})

test('applyAnnotationForm writes the form onto the node, round-tripping through loadAnnotationForm', () => {
  const node = makeNode('Hello, Anna!')
  const form = emptyForm({ context: 'greeting', placeholders: [{ start: 7, end: 11, name: 'username' }] })

  applyAnnotationForm(node, form)

  assert.deepEqual(loadAnnotationForm(node), form)
})

test('applyAnnotationForm throws on an invalid placeholder instead of silently storing it', () => {
  const node = makeNode('Hi!')
  const form = emptyForm({ placeholders: [{ start: 0, end: 20, name: 'name' }] })
  assert.throws(() => applyAnnotationForm(node, form), /out-of-range/)
})

test('renderAnnotationPanel includes the context input, plural fields, and placeholder rows', () => {
  const html = renderAnnotationPanel(
    emptyForm({
      context: 'checkout.submit',
      pluralEnabled: true,
      pluralOne: '%(count)d item',
      pluralOther: '%(count)d items',
      placeholders: [{ start: 7, end: 11, name: 'username' }],
    })
  )

  assert.match(html, /id="i18n-context" value="checkout\.submit"/)
  assert.match(html, /id="i18n-plural-enabled" checked/)
  assert.match(html, /id="i18n-plural-one" value="%\(count\)d item"/)
  assert.match(html, /id="i18n-plural-other" value="%\(count\)d items"/)
  assert.match(html, /class="i18n-placeholder-name" value="username"/)
})

test('renderAnnotationPanel escapes HTML-significant characters in field values', () => {
  const html = renderAnnotationPanel(emptyForm({ context: '<script>&"' }))
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;&amp;&quot;/)
})

test('renderAnnotationPanel renders a read-only notice when the key comes from a bound variable', () => {
  const html = renderAnnotationPanel(emptyForm(), { boundVariableName: 'checkout/submit_button' })
  assert.match(html, /checkout\/submit_button/)
  assert.doesNotMatch(html, /id="i18n-context"/)
})
