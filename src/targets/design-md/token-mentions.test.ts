/**
 * The other real library, whose ramps are `colors/y/300` — the SAME colours the second library
 * calls `Yellow/Y300`. Resolution is a lookup in this file's variable table, so what resolves here
 * is what this file actually names: `y/300` yes, `Y300` no. That is the contract with the
 * designer, and the reason nothing in this module knows what a "ramp" is.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { findTokenMentions } from './token-mentions.ts'
import { buildTokenEntries } from './model.ts'
import type { TokenTree, TokenValue, W3CToken } from '../../tokens/engine.ts'

function token(value: TokenValue, type = 'color', scopes?: readonly string[]): W3CToken {
  return {
    $type: type,
    $value: value,
    $extensions: { modes: { Light: value }, figma: { collection: 'Tokens', defaultMode: 'Light', scopes } },
  }
}

const TREE: TokenTree = {
  colors: {
    y: { 200: token('#fff2b3'), 300: token('#feea80') },
    r: { 300: token('#f28d8e'), 500: token('#e73232') },
    g: { 300: token('#a6d8a6') },
    glyph: { primary: token('#11141a'), tetriary: token('#b7bdc6') },
    fills: { primary: token('#ffffff') },
  },
  spacing: { md: token(12, 'number', ['GAP']) },
}

const ENTRIES = buildTokenEntries(TREE, ['Light'], 'Light')

const PROGRESS_DESCRIPTION =
  'Progress bar has fill color changing logic:\n' +
  '- 100% - 50% – fill color L300\n' +
  '- 25% - 49% – fill color Y300\n' +
  '- 0% - 24% – fill color R500'

test('a name this file uses resolves; a name from another file does not', () => {
  const written = PROGRESS_DESCRIPTION.replace('L300', 'g/300').replace('Y300', 'y/300').replace('R500', 'r/500')
  const { resolved, unresolved } = findTokenMentions(written, ENTRIES)
  const byText = new Map(resolved.map((mention) => [mention.text, mention.entry]))
  assert.equal(byText.get('y/300')!.cssRef, 'var(--colors-y-300)')
  assert.equal(byText.get('y/300')!.value, '#feea80')
  assert.equal(byText.get('r/500')!.cssRef, 'var(--colors-r-500)')
  assert.deepEqual(unresolved, [])

  // The second library's spelling of the same colour is simply not a name here.
  assert.deepEqual(findTokenMentions('fill color Y300', ENTRIES).resolved, [])
})

test('a path this file does not have is reported as drift', () => {
  const { unresolved } = findTokenMentions('Fill with colors/l/300 on completion.', ENTRIES)
  assert.deepEqual(unresolved, ['colors/l/300'])
})

test('path, alias and CSS-var forms all resolve', () => {
  const { resolved } = findTokenMentions(
    'Label stays at glyph/tetriary on a colors.fills.primary surface; ' +
      'gap is --spacing-md and the icon uses {colors.glyph.primary}.',
    ENTRIES
  )
  const refs = resolved.map((mention) => mention.entry.cssRef)
  assert.ok(refs.indexOf('var(--colors-glyph-tetriary)') !== -1)
  assert.ok(refs.indexOf('var(--colors-fills-primary)') !== -1)
  assert.ok(refs.indexOf('var(--spacing-md)') !== -1)
  assert.ok(refs.indexOf('var(--colors-glyph-primary)') !== -1)
})

test('ordinary prose is not mistaken for tokens', () => {
  // `H1`/`H2` are typography names, `50%`/`24%` are values, `100` is a number — none must be
  // reported as a missing token, or every description would carry a false alarm.
  const { resolved, unresolved } = findTokenMentions(
    'Use H1 for the title and H2 below it. Fills 100% at 24px, min 50% width.',
    ENTRIES
  )
  assert.deepEqual(resolved, [])
  assert.deepEqual(unresolved, [])
})

test('an ambiguous suffix is left alone rather than guessed', () => {
  const ambiguous = buildTokenEntries(
    {
      light: { colors: { primary: token('#fff') } },
      dark: { colors: { primary: token('#000') } },
    },
    ['Light'],
    'Light'
  )
  // `colors/primary` matches two different tokens — resolving it would be a coin flip.
  const { resolved } = findTokenMentions('Background is colors/primary.', ambiguous)
  assert.deepEqual(resolved, [])
})

test('a bare digit never resolves — `0%` is a value, not `letter-spacing/0`', () => {
  // Ramps index their trailing step, so `letter-spacing/0` answers to the key `0`. Prose is full
  // of bare digits ("0%", "list item 1") and none of them may produce a mention-table row.
  const withDigits = buildTokenEntries(
    {
      'letter-spacing': { '0': token(0, 'number'), '1': token(0.5, 'number') },
      text: { muted: token('#888888') },
    },
    ['Light'],
    'Light'
  )
  const { resolved, unresolved } = findTokenMentions(
    'Shows 0% at the start; list item 1 sits on text/muted.',
    withDigits
  )
  assert.deepEqual(resolved.map((mention) => mention.entry.slug), ['text-muted'])
  assert.deepEqual(unresolved, [])
  // The reference-shaped spelling of the same variable still resolves exactly.
  const qualified = findTokenMentions('Tracking is letter-spacing/0.', withDigits)
  assert.deepEqual(qualified.resolved.map((mention) => mention.entry.slug), ['letter-spacing-0'])
})

test('a file without letter ramps ignores the shorthand convention entirely', () => {
  const plain = buildTokenEntries({ color: { surface: { card: token('#fff') } } }, ['Light'], 'Light')
  const { resolved, unresolved } = findTokenMentions('Fill with Y300 on hover.', plain)
  assert.deepEqual(resolved, [])
  assert.deepEqual(unresolved, [])
})
