import test from 'node:test'
import assert from 'node:assert/strict'

/* `figma` is a sandbox global and the module reads it at call time, so a stub carrying just the
 * variable lookup is enough — and it has to exist before the import. */
const VARIABLES: Record<string, { name: string }> = {
  'VariableID:1': { name: 'accent/primary' },
  'VariableID:2': { name: 'content/primary' },
}
;(globalThis as { figma?: unknown }).figma = {
  // Async on purpose: `documentAccess: "dynamic-page"` makes the sync lookup throw, so a mock
  // that offers the sync form would pass a test the real sandbox fails.
  variables: { getVariableByIdAsync: async (id: string) => VARIABLES[id] ?? null },
}

const { tokeniseInlineSvg } = await import('./assets.ts')

const bound = (hex: [number, number, number], id: string) => ({
  type: 'SOLID',
  color: { r: hex[0], g: hex[1], b: hex[2] },
  boundVariables: { color: { id } },
})

test('a bound vector fill comes out as var(), not the hex Figma rendered', async () => {
  const source: any = { fills: [bound([0.984313, 0.356862, 0.039215], 'VariableID:1')] }
  const svg = '<svg><path d="M0 0" fill="#FB5B0A"/></svg>'
  assert.equal(await tokeniseInlineSvg(svg, source), '<svg><path d="M0 0" fill="var(--accent-primary, #FB5B0A)"/></svg>')
})

test('an unbound paint is left exactly as it was', async () => {
  const source: any = { fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] }
  const svg = '<svg><path fill="#FF0000"/></svg>'
  assert.equal(await tokeniseInlineSvg(svg, source), svg)
})

test('a colour two of the node\'s own tokens share is left alone rather than guessed', async () => {
  // Same hex, two different variables: the node itself cannot say which one the attribute meant.
  const source: any = {
    fills: [bound([0, 0, 0], 'VariableID:1')],
    strokes: [bound([0, 0, 0], 'VariableID:2')],
  }
  const svg = '<svg><path fill="#000000" stroke="#000000"/></svg>'
  assert.equal(await tokeniseInlineSvg(svg, source), svg)
})

test('strokes are substituted too, and unrelated colours in the same markup are untouched', async () => {
  const source: any = { strokes: [bound([0, 0, 0], 'VariableID:2')] }
  const svg = '<svg><path stroke="#000000" fill="#123456"/></svg>'
  assert.equal(
    await tokeniseInlineSvg(svg, source),
    '<svg><path stroke="var(--content-primary, #000000)" fill="#123456"/></svg>'
  )
})

test('a node with no bound paints skips the rewrite entirely', async () => {
  const svg = '<svg><path fill="#ABCDEF"/></svg>'
  assert.equal(await tokeniseInlineSvg(svg, {} as any), svg)
})
