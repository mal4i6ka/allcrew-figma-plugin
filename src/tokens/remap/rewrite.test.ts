import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MAPPING_FORMAT, parseMappingFile, type MappingFile, type MappingRecord } from './contract.ts'
import { rewriteColors } from './rewrite.ts'

const record = (over: Partial<MappingRecord> & { name: string; from: string; to: string }): MappingRecord => ({
  kind: 'variable',
  id: over.name,
  newName: null,
  mode: null,
  fromAlpha: 1,
  toAlpha: 1,
  fromFamily: null,
  fromStep: null,
  toFamily: null,
  toStep: null,
  via: 'step',
  deltaE: 10,
  flags: [],
  ...over,
})

const mapping = (records: MappingRecord[]): MappingFile => ({
  format: MAPPING_FORMAT,
  version: 1,
  generatedAt: null,
  source: { file: null, palette: null },
  families: [],
  renames: [],
  records,
  warnings: [],
})

const BLUE_TO_VIOLET = mapping([
  record({ name: 'colors/Blue/500', from: '#3B82F6', to: '#8B5CF6' }),
  record({ name: 'colors/Blue/600', from: '#2563EB', to: '#7C3AED' }),
  record({ name: 'colors/Gray/50', from: '#FFFFFF', to: '#FAFAFA' }),
])

test('a hard-coded color is replaced wherever it sits, in any file', () => {
  const css = '.button { background: #3B82F6; border: 1px solid #2563EB; }'
  const result = rewriteColors(css, BLUE_TO_VIOLET)
  assert.equal(result.text, '.button { background: #8B5CF6; border: 1px solid #7C3AED; }')
  assert.equal(result.replacements.length, 2)
  assert.deepEqual(result.replacements[0], {
    line: 1,
    column: 23,
    from: '#3B82F6',
    to: '#8B5CF6',
    via: 'literal',
    snapped: false,
  })
})

test('the notation the file used is the notation it keeps', () => {
  const source = [
    'a { color: rgb(59, 130, 246); }',
    'b { color: rgba(59, 130, 246, 0.4); }',
    'c { color: #3b82f6; }',
    'd { color: hsl(217.22, 91.22%, 59.8%); }',
  ].join('\n')
  const { text } = rewriteColors(source, BLUE_TO_VIOLET)
  assert.match(text, /a \{ color: rgb\(139, 92, 246\); \}/)
  assert.match(text, /b \{ color: rgba\(139, 92, 246, 0\.4\); \}/)
  assert.match(text, /c \{ color: #8B5CF6; \}/)
  assert.match(text, /d \{ color: hsl\(/)
})

test('alpha comes from the file and never from the mapping', () => {
  const { text } = rewriteColors('a { color: #3B82F680; b: rgba(59,130,246,.25); }', BLUE_TO_VIOLET)
  assert.match(text, /#8B5CF680/)
  assert.match(text, /rgba\(139, 92, 246, 0\.25\)/)
})

test('a color keyword is replaced by a keyword when the new color has one', () => {
  const { text, replacements } = rewriteColors('a { background: white; }', BLUE_TO_VIOLET)
  assert.equal(text, 'a { background: #FAFAFA; }')
  assert.equal(replacements[0].from, 'white')
})

test('a color near the token, but not equal, is snapped and said to be snapped', () => {
  // Somebody eyedropped the mock and lost a bit in the process.
  const { text, replacements } = rewriteColors('a { color: #3B83F7; }', BLUE_TO_VIOLET, { snap: 2 })
  assert.equal(text, 'a { color: #8B5CF6; }')
  assert.equal(replacements[0].snapped, true)

  const exactOnly = rewriteColors('a { color: #3B83F7; }', BLUE_TO_VIOLET, { snap: 0 })
  assert.equal(exactOnly.replacements.length, 0)
  assert.equal(exactOnly.untouched, 1)
})

test('a color the mapping never mentions is counted, not touched', () => {
  const { text, untouched } = rewriteColors('a { color: #123456; }', BLUE_TO_VIOLET)
  assert.equal(text, 'a { color: #123456; }')
  assert.equal(untouched, 1)
})

test('by name, a declaration is rewritten even when its value drifted', () => {
  // The one case the literal pass cannot reach: a value nudged by hand years ago.
  const css = ':root {\n  --colors-blue-500: #3F86FA;\n}'
  const literalOnly = rewriteColors(css, BLUE_TO_VIOLET, { snap: 0 })
  assert.equal(literalOnly.replacements.length, 0)

  const byName = rewriteColors(css, BLUE_TO_VIOLET, { snap: 0, byName: true })
  assert.equal(byName.text, ':root {\n  --colors-blue-500: #8B5CF6;\n}')
  assert.equal(byName.replacements[0].via, 'name')
  assert.equal(byName.replacements[0].line, 2)
})

test('by name works on a flat token file too, and leaves the key alone', () => {
  const json = '{\n  "colors.blue.500": "#3F86FA",\n  "spacing.md": "16px"\n}'
  const { text, replacements } = rewriteColors(json, BLUE_TO_VIOLET, { snap: 0, byName: true })
  assert.equal(text, '{\n  "colors.blue.500": "#8B5CF6",\n  "spacing.md": "16px"\n}')
  assert.equal(replacements.length, 1)
  assert.match(text, /"colors\.blue\.500"/, 'the key is untouched')
})

test('by name refuses a declaration that is not purely a color', () => {
  const css = '--colors-blue-500: 1px solid #3F86FA;'
  const { replacements } = rewriteColors(css, BLUE_TO_VIOLET, { snap: 0, byName: true })
  assert.deepEqual(replacements, [], 'a shorthand names a border, not a colour token')
})

test('the two passes never both rewrite one value', () => {
  const css = '--colors-blue-500: #3B82F6;'
  const { text, replacements } = rewriteColors(css, BLUE_TO_VIOLET, { byName: true })
  assert.equal(text, '--colors-blue-500: #8B5CF6;')
  assert.equal(replacements.length, 1)
})

test('one old color mapping two ways is left alone until a mode is named', () => {
  const ambiguous = mapping([
    record({ name: 'brand/base', from: '#3B82F6', to: '#8B5CF6', mode: 'Light' }),
    record({ name: 'brand/base', from: '#3B82F6', to: '#14B8A6', mode: 'Dark' }),
  ])

  const undecided = rewriteColors('a { color: #3B82F6; }', ambiguous)
  assert.equal(undecided.replacements.length, 0)
  assert.match(undecided.warnings[0], /more than one new color/)

  const decided = rewriteColors('a { color: #3B82F6; }', ambiguous, { mode: 'Light' })
  assert.equal(decided.text, 'a { color: #8B5CF6; }')
  assert.deepEqual(decided.warnings, [])
})

test('a color that did not move is not an edit', () => {
  const unchanged = mapping([record({ name: 'colors/Violet/500', from: '#8B5CF6', to: '#8B5CF6' })])
  const { text, replacements } = rewriteColors('a { color: #8B5CF6; }', unchanged)
  assert.equal(text, 'a { color: #8B5CF6; }')
  assert.deepEqual(replacements, [])
})

test('positions are 1-based and point at the value a human will look for', () => {
  const source = 'x\ny\n  color: #3B82F6;\n'
  const { replacements } = rewriteColors(source, BLUE_TO_VIOLET)
  assert.equal(replacements[0].line, 3)
  assert.equal(source.split('\n')[2].slice(replacements[0].column - 1), '#3B82F6;')
})

/* ------------------------------------------------------------------ cross-engine parity */

const fixtures = fileURLToPath(new URL('../../../tests/fixtures/remap/', import.meta.url))
const read = (relative: string): string => readFileSync(fixtures + relative, 'utf8')

test('the rewrite matches the one altery-dj writes, byte for byte', () => {
  // tests/test_cli.py runs the CLI over the same inputs and asserts the same expected files.
  // A mapping that produced one result in the plugin and another in the repository would be
  // worse than no tool at all, so this is the lock that keeps the two engines honest.
  const shared = parseMappingFile(read('mapping.json'))
  const report: string[] = []

  for (const name of readdirSync(fixtures + 'input').sort()) {
    const result = rewriteColors(read(`input/${name}`), shared, { snap: 2, byName: true })
    assert.equal(result.text, read(`expected/${name}`), name)
    for (const entry of result.replacements) {
      report.push(
        `${name}:${entry.line}:${entry.column} ${entry.from} -> ${entry.to}` +
          (entry.snapped ? ' [snapped]' : '') +
          (entry.via === 'name' ? ' [by name]' : '')
      )
    }
    report.push(`${name}: ${result.replacements.length} replaced, ${result.untouched} untouched`)
  }

  assert.equal(report.join('\n') + '\n', read('expected/report.txt'))
})
