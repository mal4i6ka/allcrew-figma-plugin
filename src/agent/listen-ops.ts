/**
 * Agent listener — what happened in the file while nobody was asking, and the text reviewer.
 *
 * `events.read` reads the feed `events.ts` keeps from startup. The text reviewer is a second,
 * headless copy of this plugin Figma runs in `textreview` mode and consults while someone types;
 * it shares nothing with the open panel but `clientStorage`, so the copy rules travel there one
 * way and what was flagged comes back the other, folded into the feed as TEXT_REVIEW.
 */

import { feed, recordEvent } from './events.ts'
import type { OpDef } from './protocol.ts'
import {
  planTextReviewRules,
  reviewText,
  TEXT_REVIEW_LOG_KEY,
  TEXT_REVIEW_LOG_LIMIT,
  TEXT_REVIEW_RULES_KEY,
  type TextReviewRule,
} from './text-review.ts'

/* ------------------------------------------------------------------ the headless reviewer */

let reviewRules: { rules: TextReviewRule[]; readAt: number } = { rules: [], readAt: 0 }
let reviewLog: Array<{ at: string; length: number; hits: Array<{ text: string; suggestions: string[] }> }> = []
let reviewLogTimer: ReturnType<typeof setTimeout> | null = null

/** Run in `textreview` mode: answer "what is wrong with this text" from the stored rules, and
 * leave a note of what was flagged for the panel's event feed. */
export function startTextReview(): void {
  figma.on('textreview', async ({ text }) => {
    // Rules are re-read every few seconds, not every keystroke: storage is a round trip, and a
    // rule changed in the panel reaching the reviewer five seconds later is soon enough.
    if (Date.now() - reviewRules.readAt > 5_000) {
      const stored = await figma.clientStorage.getAsync(TEXT_REVIEW_RULES_KEY).catch(() => null)
      reviewRules = { rules: Array.isArray(stored) ? (stored as TextReviewRule[]) : [], readAt: Date.now() }
    }
    const ranges = reviewText(text, reviewRules.rules)
    if (ranges.length > 0) {
      reviewLog.push({
        at: new Date().toISOString(),
        length: text.length,
        hits: ranges.map((range) => ({ text: text.slice(range.start, range.end), suggestions: range.suggestions })),
      })
      // Written in a batch a moment later, so a burst of typing is one storage write.
      if (reviewLogTimer === null) {
        reviewLogTimer = setTimeout(() => {
          reviewLogTimer = null
          void (async () => {
            const stored = await figma.clientStorage.getAsync(TEXT_REVIEW_LOG_KEY).catch(() => null)
            const all = [...(Array.isArray(stored) ? stored : []), ...reviewLog].slice(-TEXT_REVIEW_LOG_LIMIT)
            reviewLog = []
            await figma.clientStorage.setAsync(TEXT_REVIEW_LOG_KEY, all).catch(() => undefined)
          })()
        }, 2_000)
      }
    }
    return ranges
  })
}

/** What the headless reviewer flagged since the panel last looked, folded into the event feed. */
let reviewMergedUpTo = ''
async function mergeTextReviewLog(): Promise<void> {
  const stored = await figma.clientStorage.getAsync(TEXT_REVIEW_LOG_KEY).catch(() => null)
  if (!Array.isArray(stored)) return
  for (const entry of stored as Array<{ at: string; length: number; hits: unknown[] }>) {
    if (entry.at <= reviewMergedUpTo) continue
    recordEvent({ kind: 'TEXT_REVIEW', data: { reviewedAt: entry.at, length: entry.length, hits: entry.hits } })
    reviewMergedUpTo = entry.at
  }
}

/** `figma.textreview` exists only for a plugin that declares the capability. */
const reviewer = (): TextReviewAPI | undefined => (figma as unknown as { textreview?: TextReviewAPI }).textreview

async function reviewState(withLog: boolean) {
  const rules = await figma.clientStorage.getAsync(TEXT_REVIEW_RULES_KEY)
  const log = withLog ? await figma.clientStorage.getAsync(TEXT_REVIEW_LOG_KEY) : null
  return {
    enabled: reviewer() ? reviewer()!.isEnabled : null,
    rules: Array.isArray(rules) ? rules : [],
    ...(withLog ? { flagged: Array.isArray(log) ? (log as unknown[]).slice(-20) : [] } : {}),
  }
}

export const LISTEN_OPS: readonly OpDef[] = [
  {
    name: 'events.read',
    summary: 'What happened in the file since a point — selection, pages, views, the FigJam timer, runs, drops, toasts, text review.',
    agent:
      'Recorded from the moment the plugin started, whether or not anyone was asking: the designer selecting, switching ' +
      'pages or Slides/Buzz views, the FigJam timer, launches and quick actions with their parameters, files dropped ' +
      'on the canvas, a plugin.notify toast dismissed or its button pressed, what the text reviewer flagged. Pass the ' +
      '`next` you got back as `since` to read only what is new. Plugin-data changes are data.watch.',
    mutates: false,
    params: {
      since: { type: 'number', min: 0, description: 'The `next` a previous read answered; omitted, everything still held (the last 1000).' },
      limit: { type: 'number', min: 1, max: 1000, description: 'How many events, newest last; 200 by default.' },
      kinds: { type: 'string[]', description: 'Keep only these kinds, e.g. ["SELECTION", "DROP", "TIMERDONE"].' },
      forget: { type: 'boolean', description: 'Empty the feed after reading it.' },
    },
    async run(params) {
      await mergeTextReviewLog()
      const read = feed.read({
        since: params.since as number | undefined,
        limit: params.limit as number | undefined,
        kinds: params.kinds as string[] | undefined,
      })
      if (params.forget === true) feed.forget()
      return read
    },
  },

  {
    name: 'text.review',
    summary: 'Whether this plugin is the text reviewer Figma consults while people type, its copy rules, and what it flagged lately.',
    mutates: false,
    params: {},
    async run() {
      return reviewState(true)
    },
  },

  {
    name: 'text.review.set',
    summary: 'Set the copy rules the text reviewer applies as people type, or ask Figma to switch the reviewer on or off.',
    agent:
      'Copy rules are a design system\'s words: "Sign in", not "Log in"; no "Click here". `rules` replaces the list ' +
      '([] clears it) and is checked whole before it is stored. `enable` / `disable` ask Figma, which asks the ' +
      'designer to confirm — declining is an answer, not a failure. Whole words and any case by default.',
    mutates: true,
    params: {
      rules: {
        type: 'json',
        description: '[{ match, suggestions?, regex?, caseSensitive?, wholeWord? (default true), color?: RED|GREEN|BLUE }]',
      },
      enable: { type: 'boolean', description: 'Ask Figma to make this plugin the text reviewer.' },
      disable: { type: 'boolean', description: 'Ask Figma to stop using it.' },
    },
    async run(params) {
      if (params.rules === undefined && params.enable !== true && params.disable !== true) throw new Error('send rules, enable or disable')
      if (params.rules !== undefined) {
        const { rules, problems } = planTextReviewRules(params.rules)
        if (problems.length > 0) throw new Error(problems.join(' · '))
        await figma.clientStorage.setAsync(TEXT_REVIEW_RULES_KEY, rules)
      }
      if (params.enable === true || params.disable === true) {
        const api = reviewer()
        if (!api) throw new Error('this build of the plugin does not declare the textreview capability')
        if (params.enable === true) await api.requestToBeEnabledAsync()
        else await api.requestToBeDisabledAsync()
      }
      return reviewState(false)
    },
  },
]
