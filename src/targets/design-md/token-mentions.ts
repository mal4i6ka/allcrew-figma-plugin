/**
 * Token mentions inside a component description.
 *
 * Designers write contracts in the vocabulary of the Figma variables panel — "fill color
 * Yellow/Y300", "label stays at text/muted". A coding agent cannot turn that into
 * `var(--yellow-y300)` on its own, so it either guesses a hex or drops the rule.
 *
 * Resolution is a LOOKUP IN THE VARIABLE TABLE of the file being exported — never an inference
 * about how this or that team names its ramps. The plugin runs in files whose conventions it has
 * never seen; the only stable contract is "the designer wrote a real variable name". A mention is
 * accepted when it matches a variable that shipped, in any of the forms the panel and the exported
 * code use for it, and is rejected otherwise.
 *
 * Nothing here rewrites the designer's prose: the text stays verbatim and the resolution is
 * rendered beside it.
 */

import { varName } from '../../tokens/engine.ts'
import type { TokenEntry } from './model.ts'

export interface ResolvedMention {
  /** Exactly as written in the description (`Yellow/Y300`, `text/muted`, `--bg-canvas`). */
  text: string
  entry: TokenEntry
}

export interface TokenMentions {
  resolved: ResolvedMention[]
  /** Reference-shaped mentions (a path, an alias, a `--var`) that match no variable in the file. */
  unresolved: string[]
}

export interface MentionIndex {
  /** Every lookup key → the variable it identifies, or null when the key is ambiguous. */
  byKey: Map<string, TokenEntry | null>
}

function add(index: MentionIndex, key: string, entry: TokenEntry): void {
  if (!key) return
  const existing = index.byKey.get(key)
  if (existing === undefined) {
    index.byKey.set(key, entry)
    return
  }
  // Two different variables answer to the same key: resolving it would be a coin flip, so the
  // mention is left for the designer to disambiguate with a longer path.
  if (existing !== entry) index.byKey.set(key, null)
}

/**
 * Indexes the variable table by every name the designer might legitimately write: the full path,
 * and each trailing part of it (`Yellow/Y300` → also `Y300`; `accent/orange/base` → also
 * `orange/base` and `base`). Keys are normalized the same way the CSS variable name is, so
 * `Yellow/Y300`, `Yellow.Y300`, `yellow y300` and `--yellow-y300` all land on one key.
 */
export function buildMentionIndex(entries: readonly TokenEntry[]): MentionIndex {
  const index: MentionIndex = { byKey: new Map() }
  for (const entry of entries) {
    add(index, entry.slug, entry)
    for (let start = 1; start < entry.path.length; start++) {
      add(index, varName(entry.path.slice(start)), entry)
    }
  }
  return index
}

/** Normalizes any written form of a name to the key the index is built on. */
export function mentionKey(text: string): string {
  return varName([
    text
      .trim()
      .replace(/^--/, '')
      .replace(/^\{|\}$/g, '')
      .replace(/[/.]+/g, '-')
      .replace(/\s+/g, '-'),
  ])
}

/** `--bg-canvas`, `{Yellow.Y300}`, `accent/orange/base`, `Yellow.Y300` — unmistakably a reference,
 * so failing to resolve one is worth reporting. A bare word is not: it is ordinary prose until the
 * variable table says otherwise. */
const REFERENCE_SHAPED = /^(?:--[A-Za-z0-9-]+|\{[^}]+\}|[A-Za-z0-9][A-Za-z0-9_-]*(?:[/.][A-Za-z0-9_-]+)+)$/

/** Candidate strings: `--vars`, `{aliases}`, slash/dot paths, and bare words (a variable can be
 * named `Base`, and the table is what decides). */
const CANDIDATE = /--[A-Za-z0-9-]+|\{[^}\n]+\}|[A-Za-z0-9][A-Za-z0-9_-]*(?:[/.][A-Za-z0-9_-]+)*/g

/** A bare word is a lookup candidate only when it contains a letter. Ramps index their trailing
 * step (`letter-spacing/0` → `0`), so without this "0%" and "list item 1" resolve to
 * letter-spacing tokens — confidently wrong rows in the mention table. */
const HAS_LETTER = /[A-Za-z]/

/** Ramp-step shape: `Y300`, `R500`, `N1000`. A bare word — but once the description has proven it
 * names real tokens, a step that matches nothing is a stale palette reference, not prose. */
const RAMP_STEP = /^[A-Za-z]{1,2}\d{2,4}$/

export function findTokenMentions(
  description: string,
  entries: readonly TokenEntry[],
  index: MentionIndex = buildMentionIndex(entries)
): TokenMentions {
  const resolved: ResolvedMention[] = []
  const unresolved: string[] = []
  /** Unmatched ramp-shaped bare words — promoted to stale references only when the description
   * resolved at least one real token (finding a ramp step in a token-free sentence is prose). */
  const rampMisses: string[] = []
  const seen = new Set<string>()

  for (const match of description.match(CANDIDATE) ?? []) {
    const text = match.trim()
    const referenceShaped = REFERENCE_SHAPED.test(text)
    // Bare digits never enter the lookup — `0`, `1`, `100` are numbers in prose, not names.
    if (!referenceShaped && !HAS_LETTER.test(text)) continue
    const key = mentionKey(text)
    if (!key || seen.has(key)) continue

    const entry = index.byKey.get(key)
    if (entry) {
      seen.add(key)
      resolved.push({ text, entry })
      continue
    }
    // `entry === null` means ambiguous, `undefined` means absent. Both are unresolved, but only a
    // reference-shaped mention is reported — otherwise every ordinary word would be an alarm.
    if (referenceShaped) {
      seen.add(key)
      unresolved.push(text)
    } else if (RAMP_STEP.test(text)) {
      seen.add(key)
      rampMisses.push(text)
    }
  }
  if (resolved.length > 0) unresolved.push(...rampMisses)
  return { resolved, unresolved }
}
