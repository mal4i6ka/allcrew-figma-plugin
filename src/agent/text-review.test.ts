import test from 'node:test'
import assert from 'node:assert/strict'
import { planTextReviewRules, reviewText } from './text-review.ts'

test('a copy rule flags whole words in any case and offers its replacement', () => {
  const ranges = reviewText('Log in to continue — or LOG IN later. Login is fine.', [{ match: 'log in', suggestions: ['Sign in'] }])
  assert.deepEqual(ranges, [
    { start: 0, end: 6, suggestions: ['Sign in'] },
    { start: 24, end: 30, suggestions: ["Sign in"] },
  ])
})

test('whole words by default, so "app" does not fire inside "approve"', () => {
  assert.deepEqual(reviewText('approve the app', [{ match: 'app', color: 'BLUE' }]), [{ start: 12, end: 15, suggestions: [], color: 'BLUE' }])
  assert.equal(reviewText('approve', [{ match: 'app', wholeWord: false }]).length, 1)
})

test('patterns, case and overlaps: the first rule to claim a stretch keeps it', () => {
  const ranges = reviewText('Click here, click HERE', [
    { match: 'click here', caseSensitive: true, suggestions: ['Open the guide'] },
    { match: 'click \\w+', regex: true, suggestions: [] },
  ])
  assert.deepEqual(ranges, [
    { start: 0, end: 10, suggestions: [] },
    { start: 12, end: 22, suggestions: [] },
  ])
})

test('rules are refused whole when one is broken, naming where', () => {
  const { rules, problems } = planTextReviewRules([{ match: 'ok' }, { match: '(', regex: true }, { match: 'x', color: 'PINK' }])
  assert.deepEqual(rules, [])
  assert.equal(problems.length, 2)
  assert.match(problems[0], /rules\[1\]\.match is not a pattern/)
  assert.match(problems[1], /rules\[2\]\.color must be RED, GREEN or BLUE/)
})
