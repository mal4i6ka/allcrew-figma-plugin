import test from 'node:test'
import assert from 'node:assert/strict'
import { docNames, linkedDoc } from './docs.ts'

test('the documents are the Markdown at the package root, the plugin’s own first', () => {
  const files = {
    'README.md': '# r',
    'tokens.css': ':root{}',
    'ICONS.md': '# i',
    'COMPONENTS.md': '# c',
    'DESIGN.md': '# d',
    'docs/guide.md': '# nested — not a package document',
    'previews/button.png': new Uint8Array(1),
    'AGENTS.md': '# a',
  }
  assert.deepEqual(docNames(files), ['DESIGN.md', 'COMPONENTS.md', 'ICONS.md', 'AGENTS.md', 'README.md'])
})

test('a link to another document is recognised with or without its anchor', () => {
  const names = ['DESIGN.md', 'COMPONENTS.md']
  assert.deepEqual(linkedDoc('COMPONENTS.md', names), { name: 'COMPONENTS.md', anchor: '' })
  assert.deepEqual(linkedDoc('./components.md#button', names), { name: 'COMPONENTS.md', anchor: 'button' })
  assert.equal(linkedDoc('ICONS.md', names), null)
  assert.equal(linkedDoc('https://x.dev/DESIGN.md', names), null)
  assert.equal(linkedDoc('tokens.css', names), null)
})
