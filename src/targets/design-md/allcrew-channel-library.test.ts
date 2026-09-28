/**
 * Second real library, whose naming shares nothing with the first: ramps are `Yellow/Y300`
 * (not `colors/y/300`), the measurement scale is worded (`Base`, `Double`, `Half-n-quarter`),
 * and the theme layer is `bg/*`, `text/*`, `accent/<hue>/*`.
 *
 * That is the point of these tests: the plugin runs in files whose conventions it has never seen,
 * so a mention is resolved by LOOKING IT UP in that file's variable table — never by inferring
 * what a ramp name is supposed to look like.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTokenEntries, buildTokenModel } from './model.ts'
import { findTokenMentions } from './token-mentions.ts'
import type { TokenTree, TokenValue, W3CToken } from '../../tokens/engine.ts'

function token(value: TokenValue, collection: string, mode: string, type = 'color'): W3CToken {
  return { $type: type, $value: value, $extensions: { modes: { [mode]: value }, figma: { collection, defaultMode: mode } } }
}
const primitive = (value: TokenValue) => token(value, 'colors', 'Mode 1')
const themed = (light: TokenValue, dark: TokenValue): W3CToken => ({
  $type: 'color',
  $value: light,
  $extensions: { modes: { Light: light, Dark: dark }, figma: { collection: 'theme', defaultMode: 'Light' } },
})
const measure = (value: number) => token(value, 'Mesure', 'Mode 1', 'number')

const TREE: TokenTree = {
  Yellow: { Y100: primitive('#ffd9ab'), Y300: primitive('#f59e0b'), Y500: primitive('#b77100'), Main: primitive('{Yellow.Y300}') },
  Red: { R100: primitive('#ffd8d3'), R300: primitive('#ffa49b'), R500: primitive('#eb5757'), Main: primitive('{Red.R500}') },
  Lime: { L100: primitive('#d2f1a2'), L300: primitive('#a8d467'), L600: primitive('#5e8d1c'), Main: primitive('{Lime.L600}') },
  Neutral: { N0: primitive('#ffffff'), N50: primitive('#f6f6f6'), N700: primitive('#424242'), Main: primitive('{Neutral.N500}') },
  bg: { canvas: themed('{Neutral.N0}', '{Neutral.N1000}'), surface: themed('{Neutral.N50}', '{Neutral.N900}') },
  border: { subtle: themed('{Neutral.N200}', '{Neutral.N700}') },
  text: { muted: themed('{Neutral.N700}', '{Neutral.N200}'), primary: themed('{Neutral.N900}', '{Neutral.N50}') },
  accent: { orange: { base: themed('{Orange.O500}', '{Orange.O300}'), hover: themed('{Orange.O700}', '{Orange.O500}') } },
  number: { Base: measure(8), Double: measure(16), 'Half-n-quarter': measure(6) },
}

const ENTRIES = buildTokenEntries(TREE, ['Light', 'Dark'], 'Light')
const bySlug = new Map(ENTRIES.map((entry) => [entry.slug, entry]))

/** The Progress bar contract, verbatim from this library's Component configuration. */
const PROGRESS_DESCRIPTION =
  'Progress bar has fill color changing logic:\n' +
  '- 100% - 50% – fill color L300\n' +
  '- 25% - 49% – fill color Y300\n' +
  '- 0% - 24% – fill color R500'

test('a name from this file resolves, whatever shape the file gives it', () => {
  const { resolved, unresolved } = findTokenMentions(PROGRESS_DESCRIPTION, ENTRIES)
  const byText = new Map(resolved.map((mention) => [mention.text, mention.entry]))
  assert.equal(byText.get('L300')!.cssRef, 'var(--lime-l300)')
  assert.equal(byText.get('L300')!.value, '#a8d467')
  assert.equal(byText.get('Y300')!.cssRef, 'var(--yellow-y300)')
  assert.equal(byText.get('Y300')!.value, '#f59e0b')
  assert.equal(byText.get('R500')!.cssRef, 'var(--red-r500)')
  // Every colour in this contract exists here — nothing to warn about.
  assert.deepEqual(unresolved, [])
})

test('any written form of the same name lands on the same variable', () => {
  const forms = ['N0', 'Neutral/N0', 'Neutral.N0', '{Neutral.N0}', '--neutral-n0', '`N0`']
  for (const form of forms) {
    const { resolved } = findTokenMentions(`Knob fill is ${form}.`, ENTRIES)
    assert.equal(resolved.length, 1, form)
    assert.equal(resolved[0].entry.cssRef, 'var(--neutral-n0)', form)
  }
})

test('a variable whose name is an ordinary word resolves from that word — by design', () => {
  // `bg/surface` can be written `surface`, and the lookup cannot tell that from prose. This is the
  // agreed contract (mention a real variable name) and it is visible in the output, so the fix is
  // in the designer's hands: qualify it (`bg/surface`) when the sentence also uses the word.
  const { resolved } = findTokenMentions('Sits on the surface.', ENTRIES)
  assert.deepEqual(resolved.map((mention) => mention.entry.slug), ['bg-surface'])
})

test('the semantic layer resolves by path', () => {
  const { resolved } = findTokenMentions('Track sits on bg/surface with a border/subtle outline; label text/muted.', ENTRIES)
  const refs = resolved.map((mention) => mention.entry.cssRef).sort()
  assert.deepEqual(refs, ['var(--bg-surface)', 'var(--border-subtle)', 'var(--text-muted)'])
})

test('a reference-shaped mention that no variable answers is reported as drift', () => {
  const { unresolved } = findTokenMentions('Hover uses Yellow/Y950 and --bg-elevated.', ENTRIES)
  assert.deepEqual(unresolved, ['Yellow/Y950', '--bg-elevated'])
})

test('ordinary prose is never reported, even when it is not a token', () => {
  // Bare words are prose until the variable table says otherwise — no alarms, no noise.
  const { resolved, unresolved } = findTokenMentions(
    'Keep the bar compact and use H1 for the title; fills 100% at 24px.',
    ENTRIES
  )
  assert.deepEqual(resolved, [])
  assert.deepEqual(unresolved, [])
})

test('an ambiguous short name needs a longer path from the designer', () => {
  // `Main` exists on four ramps: the bare word resolves to nothing…
  const bare = findTokenMentions('Use Main for the badge.', ENTRIES)
  assert.deepEqual(bare.resolved, [])
  // …and the qualified name the panel shows resolves exactly.
  const qualified = findTokenMentions('Use Yellow/Main for the badge.', ENTRIES)
  assert.deepEqual(qualified.resolved.map((mention) => mention.entry.slug), ['yellow-main'])
})

test('a worded measure scale is still addressable by name', () => {
  // `Base`/`Double`/`Half-n-quarter` say nothing about their role, and nothing in this file does
  // either — so they stay unclassified rather than being guessed into "spacing". They remain
  // fully usable: the designer names one and it resolves.
  assert.equal(bySlug.get('number-base')!.role, 'other')
  const { resolved } = findTokenMentions('Gap is number/Base, inset number/Half-n-quarter.', ENTRIES)
  assert.deepEqual(resolved.map((mention) => mention.entry.value), ['8px', '6px'])
})

test('an unmatched ramp step in a proven contract is reported as stale, not dropped', () => {
  // The observed failure: the Progress bar contract named L300, Y300, R500 — only L300 existed,
  // and the other two vanished without a warning. Once a description has resolved ≥1 real token,
  // a ramp-shaped word (`Q300`) that matches nothing is drift the designer must hear about.
  const description = PROGRESS_DESCRIPTION.replace('Y300', 'Q300').replace('R500', 'V500')
  const { resolved, unresolved } = findTokenMentions(description, ENTRIES)
  assert.ok(resolved.some((mention) => mention.text === 'L300'))
  assert.deepEqual(unresolved, ['Q300', 'V500'])
})

test('a ramp-shaped word in token-free prose stays silent', () => {
  // No resolved token = no proof the sentence talks about the palette at all.
  const { resolved, unresolved } = findTokenMentions('Ships with USB300 cable art.', ENTRIES)
  assert.deepEqual(resolved, [])
  assert.deepEqual(unresolved, [])
})

test('the collection→role setting classifies a worded numeric scale', () => {
  const mapped = buildTokenEntries(TREE, ['Light', 'Dark'], 'Light', { mesure: 'spacing' })
  const bySlugMapped = new Map(mapped.map((entry) => [entry.slug, entry]))
  assert.equal(bySlugMapped.get('number-base')!.role, 'spacing')
  assert.equal(bySlugMapped.get('number-base')!.roleSource, 'collection')
  // Colors and the theme layer are untouched — the mapping only catches the unclassified.
  assert.equal(bySlugMapped.get('bg-canvas')!.role, 'surface')
})

test('the theme layer keeps its roles and its two modes', () => {
  assert.equal(bySlug.get('bg-canvas')!.role, 'surface')
  assert.equal(bySlug.get('border-subtle')!.role, 'border')
  assert.equal(bySlug.get('text-primary')!.role, 'text')
  assert.equal(bySlug.get('bg-canvas')!.themed, true)

  const model = buildTokenModel(TREE, ['Light', 'Dark'], 'Light')
  assert.deepEqual(model.themes, ['Light', 'Dark'])
})
