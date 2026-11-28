/**
 * Text review: the plugin as a reviewer Figma consults while someone types.
 *
 * With the `textreview` capability, Figma runs a second, headless copy of the plugin in
 * `textreview` mode and asks it, every few keystrokes, which stretches of the text to underline
 * and what to offer instead. That copy shares nothing with the open panel but `clientStorage`, so
 * the rules travel through storage one way and what was flagged travels back the other.
 *
 * The rules are a design system's copy rules — "Sign in", not "Log in"; no "Click here" — set by a
 * person or an agent. Pure, so the matching is tested without Figma.
 */

export const TEXT_REVIEW_RULES_KEY = 'allcrewChannel.v1.textReviewRules'
export const TEXT_REVIEW_LOG_KEY = 'allcrewChannel.v1.textReviewLog'
export const TEXT_REVIEW_LOG_LIMIT = 200

export interface TextReviewRule {
  /** The words to flag. A plain string matches as typed; `regex: true` reads it as a pattern. */
  match: string
  /** What to offer instead; empty means "flag, nothing to suggest". */
  suggestions?: string[]
  /** Treat `match` as a regular expression. */
  regex?: boolean
  /** Match case exactly. Off by default — copy rules are about words, not capitals. */
  caseSensitive?: boolean
  /** Whole words only, on by default: "app" should not fire inside "approve". */
  wholeWord?: boolean
  /** Figma's underline colour: RED for an error, BLUE for a suggestion, GREEN for a nudge. */
  color?: 'RED' | 'GREEN' | 'BLUE'
}

export interface ReviewRange {
  start: number
  end: number
  suggestions: string[]
  color?: 'RED' | 'GREEN' | 'BLUE'
}

const COLORS = ['RED', 'GREEN', 'BLUE']

/** Rules checked before they are stored, so the headless reviewer never meets a broken one. */
export function planTextReviewRules(raw: unknown): { rules: TextReviewRule[]; problems: string[] } {
  const problems: string[] = []
  const rules: TextReviewRule[] = []
  if (!Array.isArray(raw)) return { rules, problems: ['rules must be a list of { match, suggestions?, regex?, caseSensitive?, wholeWord?, color? }'] }
  for (const [index, entry] of raw.entries()) {
    const at = `rules[${index}]`
    const rule = entry as Record<string, unknown> | null
    if (typeof rule !== 'object' || rule === null || typeof rule.match !== 'string' || rule.match === '') {
      problems.push(`${at}.match must be the words to flag`)
      continue
    }
    for (const key of Object.keys(rule)) {
      if (!['match', 'suggestions', 'regex', 'caseSensitive', 'wholeWord', 'color'].includes(key)) problems.push(`${at}: unknown key "${key}"`)
    }
    if (rule.suggestions !== undefined && (!Array.isArray(rule.suggestions) || !rule.suggestions.every((one) => typeof one === 'string'))) {
      problems.push(`${at}.suggestions must be a list of replacements`)
    }
    for (const flag of ['regex', 'caseSensitive', 'wholeWord']) {
      if (rule[flag] !== undefined && typeof rule[flag] !== 'boolean') problems.push(`${at}.${flag} must be true or false`)
    }
    if (rule.color !== undefined && !COLORS.includes(String(rule.color))) problems.push(`${at}.color must be RED, GREEN or BLUE`)
    if (rule.regex === true) {
      try {
        new RegExp(rule.match)
      } catch (error) {
        problems.push(`${at}.match is not a pattern: ${String((error as Error).message)}`)
      }
    }
    rules.push(rule as unknown as TextReviewRule)
  }
  return { rules: problems.length > 0 ? [] : rules, problems }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every stretch of `text` a rule flags, in order, overlapping matches left to the first rule. */
export function reviewText(text: string, rules: readonly TextReviewRule[]): ReviewRange[] {
  const ranges: ReviewRange[] = []
  for (const rule of rules) {
    const body = rule.regex ? rule.match : escape(rule.match)
    const bounded = rule.wholeWord === false ? body : `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`
    let pattern: RegExp
    try {
      pattern = new RegExp(bounded, `gu${rule.caseSensitive ? '' : 'i'}`)
    } catch {
      continue
    }
    for (const found of text.matchAll(pattern)) {
      const start = found.index ?? 0
      const end = start + found[0].length
      if (end === start || ranges.some((one) => start < one.end && end > one.start)) continue
      ranges.push({ start, end, suggestions: rule.suggestions ?? [], ...(rule.color ? { color: rule.color } : {}) })
    }
  }
  return ranges.sort((a, b) => a.start - b.start)
}
