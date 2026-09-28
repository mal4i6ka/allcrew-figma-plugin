import test from 'node:test'
import assert from 'node:assert/strict'
import { auditGuardrails, buildTokenAudit } from './audit.ts'
import type { TokenGraph } from '../../tokens/engine.ts'

const GRAPH: TokenGraph = {
  fileName: 'AllCrew Figma Workspace',
  collections: [
    { id: 'c1', name: 'Colors', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }] },
    { id: 'c2', name: 'Scales', defaultModeId: 'm3', modes: [{ modeId: 'm3', name: 'Value' }] },
  ],
  variables: [
    { id: 'v1', name: 'Color/Text', collectionId: 'c1', resolvedType: 'COLOR', valuesByMode: { m1: '#111', m2: '#eee' } },
    // No value in Dark — it silently falls back to the default mode.
    { id: 'v2', name: 'Color/Accent', collectionId: 'c1', resolvedType: 'COLOR', valuesByMode: { m1: '#f00' } },
  ],
  textStyles: [
    { id: 't1', name: 'Body/md', fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16, boundVariables: {} },
    { id: 't2', name: 'Body/lg', fontName: { family: 'Inter', style: 'Regular' }, fontSize: 20, boundVariables: { fontSize: 'v9' } },
  ],
}

test('buildTokenAudit counts detached and partially bound text styles', () => {
  const audit = buildTokenAudit(GRAPH)
  assert.equal(audit.textStyleCount, 2)
  assert.equal(audit.detachedTextStyles, 1)
  assert.equal(audit.partiallyBoundTextStyles, 1)
})

test('buildTokenAudit reports variable/mode pairs that never got a value', () => {
  const audit = buildTokenAudit(GRAPH)
  assert.deepEqual(audit.missingModeValues, ['Color/Accent · Dark'])
  assert.deepEqual(audit.singleModeCollections, ['Scales'])
  assert.equal(audit.hasBreakpointCollection, false)
})

test('auditGuardrails turns the findings into imperative rules', () => {
  const rules = auditGuardrails(buildTokenAudit(GRAPH))
  assert.ok(rules.some((rule) => /1\/2 Figma text styles are not bound/.test(rule)))
  assert.ok(rules.some((rule) => /partially bound/.test(rule)))
  assert.ok(rules.some((rule) => /no `Breakpoints` variable collection/.test(rule)))
})

test('a clean graph produces no text-style warnings', () => {
  const rules = auditGuardrails(
    buildTokenAudit({
      collections: [{ id: 'c1', name: 'Breakpoints', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Value' }] }],
      variables: [],
      textStyles: [],
    })
  )
  assert.deepEqual(rules, [])
})
