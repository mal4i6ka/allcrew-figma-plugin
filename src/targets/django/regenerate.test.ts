import test from 'node:test'
import assert from 'node:assert/strict'
import { planRegeneration, wrapGenerated, type FreshFile } from './regenerate.ts'

function fresh(nodeId: string, content: string | Uint8Array): FreshFile {
  return { nodeId, content }
}

test('planRegeneration merges text inside the marker pair and diffs the result', () => {
  const existing = ['<!-- handwritten header -->', wrapGenerated('1:2', '<p>old</p>'), '<!-- footer -->'].join('\n')
  const plan = planRegeneration(
    new Map([['pages/landing.html', existing]]),
    new Map([['pages/landing.html', fresh('1:2', wrapGenerated('1:2', '<p>new</p>'))]])
  )

  const [file] = plan.files
  assert.equal(file.action, 'update')
  assert.equal(file.binary, false)
  assert.match(file.content as string, /handwritten header/)
  assert.match(file.content as string, /<p>new<\/p>/)
  assert.deepEqual(
    file.diff.filter((line) => line.kind !== 'equal'),
    [{ kind: 'remove', text: '<p>old</p>' }, { kind: 'add', text: '<p>new</p>' }]
  )
})

test('planRegeneration leaves a file with no marker for the node alone', () => {
  const plan = planRegeneration(
    new Map([['pages/landing.html', '<p>entirely hand-written</p>']]),
    new Map([['pages/landing.html', fresh('1:2', wrapGenerated('1:2', '<p>generated</p>'))]])
  )

  assert.equal(plan.files[0].action, 'skipped-hand-edited')
  assert.equal(plan.files[0].content, '<p>entirely hand-written</p>')
  assert.equal(plan.files[0].binary, false)
  assert.equal(plan.warnings.length, 1)
})

// --- Binary assets (static/img/…): part of the plan, compared as bytes. An image that never
// appears in a dry run is an image the user is asked to approve blind. ---

const HERO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])

test('planRegeneration reports a new image as create with binary: true and no diff', () => {
  const plan = planRegeneration(new Map(), new Map([['static/img/hero.png', fresh('3:4', HERO)]]))

  assert.equal(plan.files[0].path, 'static/img/hero.png')
  assert.equal(plan.files[0].action, 'create')
  assert.equal(plan.files[0].binary, true)
  assert.deepEqual(plan.files[0].diff, [])
  assert.deepEqual(plan.files[0].content, HERO)
  assert.deepEqual(plan.warnings, [])
})

test('planRegeneration reports the same image bytes as unchanged', () => {
  const plan = planRegeneration(
    new Map([['static/img/hero.png', HERO]]),
    new Map([['static/img/hero.png', fresh('3:4', new Uint8Array([...HERO]))]])
  )

  assert.equal(plan.files[0].action, 'unchanged')
  assert.equal(plan.files[0].binary, true)
  assert.deepEqual(plan.files[0].diff, [])
})

test('planRegeneration reports changed bytes as update — same length and different length both count', () => {
  const sameLength = planRegeneration(
    new Map([['static/img/hero.png', HERO]]),
    new Map([['static/img/hero.png', fresh('3:4', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0b]))]])
  )
  assert.equal(sameLength.files[0].action, 'update')
  assert.equal(sameLength.files[0].binary, true)
  assert.deepEqual(sameLength.files[0].diff, [])

  const shorter = planRegeneration(
    new Map([['static/img/hero.png', HERO]]),
    new Map([['static/img/hero.png', fresh('3:4', new Uint8Array([0x89, 0x50]))]])
  )
  assert.equal(shorter.files[0].action, 'update')
})

test('planRegeneration treats a text/bytes swap at one path as a binary update', () => {
  const toBytes = planRegeneration(
    new Map([['static/img/logo.svg', '<svg/>']]),
    new Map([['static/img/logo.svg', fresh('3:4', HERO)]])
  )
  assert.equal(toBytes.files[0].action, 'update')
  assert.equal(toBytes.files[0].binary, true)

  const toText = planRegeneration(
    new Map([['static/img/logo.svg', HERO]]),
    new Map([['static/img/logo.svg', fresh('3:4', '<svg/>')]])
  )
  assert.equal(toText.files[0].action, 'update')
  assert.equal(toText.files[0].binary, true)
  assert.deepEqual(toText.files[0].diff, [])
})

test('a text file next to a binary one still merges and diffs normally', () => {
  const template = ['<!-- keep me -->', wrapGenerated('1:2', '<p>old</p>')].join('\n')
  const plan = planRegeneration(
    new Map<string, string | Uint8Array>([
      ['pages/landing.html', template],
      ['static/img/hero.png', HERO],
    ]),
    new Map([
      ['pages/landing.html', fresh('1:2', wrapGenerated('1:2', '<p>new</p>'))],
      ['static/img/hero.png', fresh('3:4', new Uint8Array([0x00]))],
    ])
  )

  const text = plan.files.find((file) => file.path === 'pages/landing.html')!
  const image = plan.files.find((file) => file.path === 'static/img/hero.png')!

  assert.equal(text.binary, false)
  assert.equal(text.action, 'update')
  assert.match(text.content as string, /keep me/)
  assert.ok(text.diff.some((line) => line.kind === 'add' && line.text === '<p>new</p>'))

  assert.equal(image.binary, true)
  assert.equal(image.action, 'update')
  assert.deepEqual(image.diff, [])
})
