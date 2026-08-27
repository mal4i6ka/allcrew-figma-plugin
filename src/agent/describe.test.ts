import test from 'node:test'
import assert from 'node:assert/strict'
import { MARKDOWN_SUPPORTED, MARKDOWN_UNSUPPORTED, markdownWarnings, planDescribe } from './write-ops.ts'

/* A description is prose a human wrote, and the row that carries it is hand-typed JSON. These
 * tests are about the refusals: every one of them exists because the alternative is a write that
 * reports success and lands somewhere nobody reads. */

test('plain text and markdown are refused together — they are one field', () => {
  assert.throws(
    () => planDescribe({ description: 'A', markdown: '**A**' }, 'components[0]'),
    /write the same field/
  )
})

test('a row that asks for nothing is refused rather than counted as written', () => {
  assert.throws(() => planDescribe({ node: '1:2' }, 'components[0]'), /nothing to write/)
})

test('null and empty string clear a field instead of being skipped', () => {
  assert.deepEqual(planDescribe({ description: null }, 'r'), { description: '', variant: false })
  assert.deepEqual(planDescribe({ markdown: '' }, 'r'), { markdown: '', variant: false })
  assert.deepEqual(planDescribe({ documentationLinks: null }, 'r'), { links: [], variant: false })
})

test('a lone URL string is a one-element list — the shape the API takes', () => {
  assert.deepEqual(planDescribe({ documentationLinks: 'https://x.dev' }, 'r'), {
    links: ['https://x.dev'],
    variant: false,
  })
})

test('a second link is refused before anything is written', () => {
  // The API throws on a list longer than one — it does NOT keep the first. Caught at the write,
  // that throw arrives after the description has already been assigned, leaving a row that
  // reports failure over a document that changed. Observed against a live file, not assumed.
  assert.throws(
    () => planDescribe({ documentationLinks: ['https://a.dev', 'https://b.dev'] }, 'components[2]'),
    /at most one link.*got 2/s
  )
  assert.deepEqual(planDescribe({ documentationLinks: ['https://a.dev'] }, 'r').links, ['https://a.dev'])
})

test('a malformed row names the field and its index', () => {
  assert.throws(() => planDescribe({ description: 42 }, 'components[3]'), /components\[3\]\.description/)
  assert.throws(() => planDescribe({ documentationLinks: [''] }, 'components[1]'), /documentationLinks\[0\]/)
  assert.throws(() => planDescribe({ documentationLinks: 7 }, 'r'), /URL, an array of URLs, or null/)
})

test('writing a variant on purpose is opt-in and survives into the plan', () => {
  assert.equal(planDescribe({ markdown: 'x' }, 'r').variant, false)
  assert.equal(planDescribe({ markdown: 'x', variant: true }, 'r').variant, true)
})

/* ------------------------------------------------------------------ markdown */

test('the support list is what Figma renders, not what a parser accepts', () => {
  const joined = MARKDOWN_SUPPORTED.join(' ')
  assert.match(joined, /## only/, 'the # demotion is the trap and has to be stated')
  assert.match(joined, /strikethrough/)
  assert.match(joined, /code block/)
  assert.deepEqual([...MARKDOWN_UNSUPPORTED], ['tables', 'images', 'first-level headings'])
})

/* The normalizer canonicalizes and does not filter, so these traps reach the panel intact. Each
 * case below was observed through figma.util.normalizeMarkdown against a live file, not derived
 * from the docs — the code-block one contradicts what a Markdown reader would expect. */

test('prose after a code block is the trap the normalizer creates, and it is warned about', () => {
  assert.deepEqual(markdownWarnings('```js\nconst a = 1\n```\n\nAfter.'), [
    'text after a code block is absorbed into it — put code blocks last',
  ])
})

test('a code block that ends the description is fine', () => {
  assert.deepEqual(markdownWarnings('Before.\n\n```js\nconst a = 1\n```'), [])
  assert.deepEqual(markdownWarnings('no code here at all'), [])
})

test('unsupported syntax is named rather than silently shipped as characters', () => {
  assert.deepEqual(markdownWarnings('| a | b |\n|---|---|\n| 1 | 2 |'), [
    'tables are not supported — this renders as literal characters',
  ])
  assert.deepEqual(markdownWarnings('![alt](https://x.dev/i.png)'), [
    'images are not supported — this renders as literal characters',
  ])
  assert.deepEqual(markdownWarnings('# Title\n\nbody'), ['a first-level heading is demoted to ##'])
})

test('## is the supported heading and draws no warning', () => {
  assert.deepEqual(markdownWarnings('## Behaviour\n\n- **bold** and *italic*'), [])
})
