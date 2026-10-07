import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHex } from '../color.ts'
import type { ColorSite } from './plan.ts'
import { buildDirectColorReplacement } from './direct.ts'

const rgba = (hex: string, alpha = 1) => ({ ...parseHex(hex)!, a: alpha })

const site = (id: string, color: string, alpha = 1, editable = true): ColorSite => ({
  id,
  kind: 'variable',
  name: `colors/${id}/500`,
  modeId: null,
  modeName: null,
  rgba: rgba(color, alpha),
  usage: 1,
  editable,
  primitive: true,
})

test('direct replacement changes only exact RGB matches and preserves each site alpha', () => {
  const plan = buildDirectColorReplacement({
    sites: [site('red', '#FE012D', 1), site('red-muted', '#FE012D', 0.35), site('near-red', '#FD012D')],
    from: rgba('#FE012D'),
    to: rgba('#FFBC03'),
  })

  assert.deepEqual(plan.entries.map((entry) => entry.site.id), ['red', 'red-muted'])
  assert.deepEqual(plan.entries.map((entry) => entry.to), [rgba('#FFBC03', 1), rgba('#FFBC03', 0.35)])
  assert.ok(plan.entries.every((entry) => entry.flags.includes('manual')))
  assert.deepEqual(plan.renames, [])
})

test('direct replacement reports library matches but keeps them in the review plan', () => {
  const plan = buildDirectColorReplacement({
    sites: [site('local', '#FE012D'), site('library', '#FE012D', 1, false)],
    from: rgba('#FE012D'),
    to: rgba('#FFBC03'),
  })

  assert.equal(plan.entries.length, 2)
  assert.ok(plan.entries[1].flags.includes('library'))
  assert.ok(plan.warnings.some((warning) => warning.includes('from a library')))
})
