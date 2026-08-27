import test from 'node:test'
import assert from 'node:assert/strict'

/* `figma` is a sandbox global read at call time, and the registry in ops.ts is built at module
 * scope — so the stub goes in before the import. Async lookup only: `documentAccess:
 * "dynamic-page"` makes the sync form throw, and a mock offering it would pass a test the real
 * sandbox fails. */
const VARIABLES: Record<string, { name: string }> = {
  'VariableID:1': { name: 'accent/primary' },
  'VariableID:2': { name: 'gradient/glow/p16' },
}
;(globalThis as { figma?: unknown }).figma = {
  mixed: Symbol('figma.mixed'),
  variables: { getVariableByIdAsync: async (id: string) => VARIABLES[id] ?? null },
}

const { describePaint } = await import('./ops.ts')

test('a solid paint reports its colour, and alpha only when it has one', async () => {
  assert.deepEqual(await describePaint({ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }, 0), {
    type: 'SOLID',
    index: 0,
    color: '#FF0000',
    bound: null,
  })
  const half = await describePaint({ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 0.24 }, 2)
  assert.equal(half.alpha, 0.24)
  assert.equal(half.color, '#FFFFFF')
})

test('a solid paint names the token bound to it', async () => {
  const described = await describePaint(
    { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { id: 'VariableID:1' } } },
    0
  )
  assert.equal(described.bound, 'accent/primary')
})

test('a gradient reports every stop, with position in percent', async () => {
  const described = await describePaint(
    {
      type: 'GRADIENT_LINEAR',
      gradientStops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 0.16, color: { r: 0, g: 1, b: 0, a: 1 }, boundVariables: { color: { id: 'VariableID:2' } } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
      ],
    },
    0
  )
  assert.deepEqual(described.stops, [
    { position: 0, color: '#FF0000', bound: null },
    { position: 16, color: '#00FF00', bound: 'gradient/glow/p16' },
    { position: 100, color: '#0000FF', bound: null, alpha: 0.5 },
  ])
  // A gradient binds per stop, so paint-level `bound` is null however well tokenised it is —
  // which is exactly why reporting it without the stops read as "raw" and was wrong.
  assert.equal(described.bound, null)
  assert.equal(described.color, undefined)
})

test('an image paint has no colour and no stops to report', async () => {
  const described = await describePaint({ type: 'IMAGE', visible: false }, 3)
  assert.deepEqual(described, { type: 'IMAGE', index: 3, visible: false, bound: null })
})
