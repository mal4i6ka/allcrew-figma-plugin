/**
 * Fixture is the real "Progress bar" component configuration from the Corporate Design Library —
 * a description that encodes conditional fill colors. That logic exists nowhere else in the
 * export, so losing it is the whole failure mode this file guards against.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildComponentsMd,
  buildIconsMd,
  classifyDescription,
  componentDocsSection,
  isIconDoc,
  type ComponentDoc,
} from './component-docs.ts'

const PROGRESS: ComponentDoc = {
  id: '4945:2041',
  name: 'Progress bar',
  page: 'FEEDBACK',
  description:
    '# Progress bar\n\nProgress bar has fill color changing logic:\n' +
    '- 100% - 50% – fill color L300\n' +
    '- 25% - 49% – fill color Y300\n' +
    '- 0% - 24% – fill color R500',
  links: ['https://example.com/progress'],
  properties: [
    { name: 'Size', type: 'VARIANT', options: ['sm', 'md'], defaultValue: 'md' },
    { name: 'Label', type: 'TEXT', defaultValue: '50%' },
  ],
  variantCount: 2,
  preview: 'previews/progress-bar--4945-2041.png',
}

const UNDOCUMENTED: ComponentDoc = {
  id: '1:2',
  name: 'Avatar',
  description: '',
  links: [],
  properties: [],
}

/** Real icon-library entry: the description is search keywords, not behaviour. */
const LOCK_ICON: ComponentDoc = {
  id: '16:11919',
  name: 'Security / Lock',
  page: 'Icons',
  description: 'lock, privacy, security, protection, safe, key, keyhole',
  links: [],
  properties: [],
}

/** The designer's markdown-formatting test — prose, but not a rule an agent could implement. */
const SIDEBAR: ComponentDoc = {
  id: '20:7',
  name: 'Sidebar',
  description: '# Sidebar\n\n**Bold** and _italic_ text\n- list item 1\n- list item 2',
  links: [],
  properties: [],
}

test('COMPONENTS.md carries the behaviour contract verbatim', () => {
  const md = buildComponentsMd([PROGRESS], { fileName: 'Corporate Design Library', usage: 'Implement with the tokens in DESIGN.md.' })
  assert.match(md, /Behaviour contract — implement this/)
  assert.match(md, /> Progress bar has fill color changing logic:/)
  assert.match(md, /> - 25% - 49% – fill color Y300/)
  assert.match(md, /!\[Progress bar\]\(previews\/progress-bar--4945-2041\.png\)/)
  assert.match(md, /<https:\/\/example\.com\/progress>/)
  assert.match(md, /\| `Size` \| variant \| `sm`, `md` \| `md` \|/)
})

test("the designer's markdown cannot hijack the document outline", () => {
  const md = buildComponentsMd([PROGRESS], { fileName: 'DS', usage: '' })
  // The description starts with "# Progress bar"; quoted, it can never become a real heading.
  const headings = md.split('\n').filter((line) => /^#{1,2} /.test(line))
  assert.deepEqual(headings, ['# Components — DS', '## Index', '## Progress bar'])
})

test('an undocumented component is listed, not hidden', () => {
  const md = buildComponentsMd([PROGRESS, UNDOCUMENTED], { fileName: 'DS', usage: '' })
  assert.match(md, /## Avatar/)
  assert.match(md, /_No description in Figma\._/)
  // Documented components come first — that is what the file is for.
  assert.ok(md.indexOf('## Progress bar') < md.indexOf('## Avatar'))
  assert.match(md, /1 of 2 component\(s\) carry a behaviour contract/)
})

test('DESIGN.md points at the contracts instead of duplicating them', () => {
  const section = componentDocsSection([PROGRESS, UNDOCUMENTED])
  assert.match(section, /1 component\(s\) carry a behaviour contract/)
  assert.match(section, /COMPONENTS\.md/)
  assert.match(section, /\| `Progress bar` \| Progress bar \| \[preview\]/)
  // The full text stays in COMPONENTS.md — DESIGN.md only carries the first line.
  assert.equal(/Y300/.test(section), false)
})

test('no components means no file and no section', () => {
  assert.equal(buildComponentsMd([], { fileName: 'DS', usage: '' }), '')
  assert.equal(componentDocsSection([]), '')
})

/* ------------------------------------------------- description classification (finding 3) */

test('descriptions are classified before being promoted to contracts', () => {
  assert.equal(classifyDescription(LOCK_ICON.description), 'tags')
  assert.equal(classifyDescription(PROGRESS.description, PROGRESS.properties), 'contract')
  assert.equal(classifyDescription(SIDEBAR.description), 'notes')
})

test('search tags are rendered as metadata, never as a behaviour contract', () => {
  const md = buildComponentsMd([PROGRESS, LOCK_ICON, SIDEBAR], { fileName: 'DS', usage: '' })
  assert.match(md, /\*\*Search tags:\*\* lock, privacy, security/)
  // Exactly one contract in this file — the icon and the formatting test do not count.
  assert.match(md, /1 of 3 component\(s\) carry a behaviour contract/)
  assert.equal(md.split('Behaviour contract — implement this').length, 2)
  assert.match(md, /\*\*Designer notes\*\*/)
  assert.match(md, /> - list item 1/)
})

test('DESIGN.md §contracts counts only genuine contracts', () => {
  const section = componentDocsSection([PROGRESS, LOCK_ICON, SIDEBAR])
  assert.match(section, /\*\*1 component\(s\) carry a behaviour contract\*\*/)
  assert.match(section, /1 further component\(s\) carry designer notes/)
  assert.equal(/Security \/ Lock/.test(section), false)
})

/* ------------------------------------------------------- icon split + anchors (finding 7) */

test('icon-shaped components are recognized for the ICONS.md split', () => {
  assert.equal(isIconDoc(LOCK_ICON), true)
  assert.equal(isIconDoc(PROGRESS), false)
  assert.equal(isIconDoc(SIDEBAR), false)
  // A bare glyph with no prose and no props under an icon page is an icon too.
  assert.equal(
    isIconDoc({ id: '3:4', name: 'Arrows / Arrow', page: 'Icons', description: '', links: [], properties: [] }),
    true
  )
  // The same shape outside an icon page stays a component.
  assert.equal(isIconDoc(UNDOCUMENTED), false)
})

test('ICONS.md is a compact lookup table', () => {
  const md = buildIconsMd([LOCK_ICON], { fileName: 'DS' })
  assert.match(md, /# Icons — DS/)
  assert.match(md, /search keywords\*\*, not\s+behaviour contracts/)
  assert.match(md, /\| Security \/ Lock \| `16:11919` \| lock, privacy, security, protection, safe, key, keyhole \| — \|/)
  assert.equal(buildIconsMd([], { fileName: 'DS' }), '')
})

test('duplicate component names get unique node-id anchors in the index', () => {
  const twins: ComponentDoc[] = [
    { id: '16:11919', name: 'Arrows / Arrow', description: '', links: [], properties: [] },
    { id: '16:12001', name: 'Arrows / Arrow', description: '', links: [], properties: [] },
  ]
  const md = buildComponentsMd([...twins, PROGRESS], { fileName: 'DS', usage: '' })
  assert.match(md, /\[Arrows \/ Arrow\]\(#arrows-arrow--16-11919\)/)
  assert.match(md, /\[Arrows \/ Arrow\]\(#arrows-arrow--16-12001\)/)
  assert.match(md, /<a id="arrows-arrow--16-11919"><\/a>/)
  assert.match(md, /<a id="arrows-arrow--16-12001"><\/a>/)
  // A unique name keeps the native heading anchor — no HTML noise.
  assert.match(md, /\[Progress bar\]\(#progress-bar\)/)
  assert.equal(/<a id="progress-bar">/.test(md), false)
})
