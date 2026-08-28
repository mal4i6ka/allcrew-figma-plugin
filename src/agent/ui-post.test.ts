import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const panel: unknown[] = []
;(globalThis as { figma?: unknown }).figma = {
  ui: {
    postMessage(message: unknown, options?: unknown) {
      panel.push(options === undefined ? message : { message, options })
    },
  },
}

const { postToUi, beginRecording, endRecording, isRecording } = await import('./ui-post.ts')

test.beforeEach(() => {
  panel.length = 0
})

test('a reply reaches the panel whether or not anyone is recording', () => {
  postToUi({ type: 'A' })
  const sink = beginRecording()
  postToUi({ type: 'B' })
  endRecording(sink)
  postToUi({ type: 'C' })

  assert.deepEqual(panel, [{ type: 'A' }, { type: 'B' }, { type: 'C' }])
  assert.deepEqual(sink, [{ type: 'B' }])
})

test('the options argument is passed through', () => {
  postToUi({ type: 'A' }, { origin: '*' })
  assert.deepEqual(panel, [{ message: { type: 'A' }, options: { origin: '*' } }])
})

test('a stale close cannot silence a live recording', () => {
  // The array is the token. An abandoned call closing "the recording" would otherwise stop
  // recording whichever call the queue has moved on to.
  const abandoned = beginRecording()
  const live = beginRecording()
  endRecording(abandoned)

  assert.equal(isRecording(), true)
  postToUi({ type: 'MINE' })
  assert.deepEqual(live, [{ type: 'MINE' }])
  assert.deepEqual(abandoned, [])

  endRecording(live)
  assert.equal(isRecording(), false)
})

/* ------------------------------------------------------- the rule this module exists for */

test('no production file posts to the UI behind this module', () => {
  // Figma will not let `figma.ui.postMessage` be wrapped (observed 2026-08-28: the assignment
  // and defineProperty both fail), so this indirection is the only way a command's reply can
  // be recorded. A call site that bypasses it is a reply the agent silently never hears.
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      if (path.endsWith(join('agent', 'ui-post.ts'))) continue
      // Calls, not mentions — the modules that explain why this rule exists name the host
      // method in their comments, and should be able to.
      const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      if (code.includes('figma.ui.postMessage(')) offenders.push(path)
    }
  }
  walk(new URL('..', import.meta.url).pathname)

  assert.deepEqual(offenders, [], 'these files must post through postToUi (src/agent/ui-post.ts)')
})
