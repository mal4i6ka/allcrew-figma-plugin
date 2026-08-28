import test from 'node:test'
import assert from 'node:assert/strict'
import { extractProps } from './props-vocabulary.ts'
import { readFileSync } from 'node:fs'

test('a field comes out with its type and the sentence above it', () => {
  const source = `
export interface NodeProps {
  /** What the layer is called. */
  name?: string
  visible?: boolean
}`
  assert.deepEqual(extractProps(source), [
    { name: 'name', type: 'string', note: 'What the layer is called.' },
    { name: 'visible', type: 'boolean' },
  ])
})

test('a sentence belongs to the field under it and to no other', () => {
  // Carrying it to the next field would read well for the five style slots and badly for
  // everything else: `name`'s sentence is not `visible`'s, and a wrong sentence on a property is
  // worse than none. The build prints whatever is left silent.
  const source = `
export interface NodeProps {
  /** Styles the layer follows. */
  fillStyle?: string | null
  strokeStyle?: string | null
}`
  const props = extractProps(source)
  assert.equal(props[0].note, 'Styles the layer follows.')
  assert.equal(props[1].note, undefined)
})

test('a multi-line comment is collapsed, and a trailing comma is not part of the type', () => {
  const source = `
export interface NodeProps {
  /**
   * Two lines
   * of prose.
   */
  gap?: number,
}`
  assert.deepEqual(extractProps(source), [{ name: 'gap', type: 'number', note: 'Two lines of prose.' }])
})

test('no interface, no vocabulary — and it says so by being empty rather than by guessing', () => {
  assert.deepEqual(extractProps('export interface Other { name?: string }'), [])
})

test('the real vocabulary comes out whole, and every entry says what it is for', () => {
  // The point of extracting rather than describing: this asserts against the file itself, so a
  // property added without a sentence fails here rather than reaching an agent undocumented.
  const props = extractProps(readFileSync(new URL('../canvas/props.ts', import.meta.url), 'utf8'))
  assert.ok(props.length > 40, `expected the whole vocabulary, got ${props.length}`)
  const silent = props.filter((entry) => !entry.note).map((entry) => entry.name)
  assert.deepEqual(silent, [], 'every property needs a sentence above it')
  for (const name of ['fill', 'brush', 'shader' in {} ? 'shader' : 'grid', 'links', 'bind', 'animation', 'runs', 'network']) {
    assert.ok(
      props.some((entry) => entry.name === name),
      `${name} must be in the vocabulary`
    )
  }
})
