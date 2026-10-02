import test from 'node:test'
import assert from 'node:assert/strict'
import { FIDELITY_POLICY, decideFidelityPreflight, fidelityInstructions } from './design-policy.mjs'

test('existing Figma screen proceeds without a broad product-direction question', () => {
  const result = decideFidelityPreflight({ taskKind: 'reproduction', figmaReference: true })
  assert.equal(result.action, 'proceed')
  assert.equal(result.question, null)
  assert.ok(result.labels.includes('EVIDENCE_BOUND'))
})

test('an existing bug fix proceeds from Figma and product code without a brief', () => {
  const result = decideFidelityPreflight({ taskKind: 'bug-fix', figmaReference: true, existingProduct: true })
  assert.equal(result.action, 'proceed')
})

test('a new screen without a brief asks one grouped direction question', () => {
  const result = decideFidelityPreflight({ taskKind: 'new-surface' })
  assert.equal(result.action, 'ask')
  assert.match(result.question, /цель продукта|цель.*экрана/)
  assert.match(result.question, /основн.*пользователь/)
  assert.match(result.question, /визуальн.*направление/)
  assert.ok(result.labels.includes('DIRECTION_REQUIRED'))
})

test('a new confirmation screen can compose existing evidence when goal, user and copy are explicit', () => {
  const result = decideFidelityPreflight({
    taskKind: 'new-surface',
    productGoal: true,
    primaryUser: true,
    neighboringSurfaces: true,
  })
  assert.equal(result.action, 'proceed')
  assert.equal(result.question, null)
})

test('an accessibility-only gap uses a labelled platform default instead of blocking', () => {
  const result = decideFidelityPreflight({ taskKind: 'reproduction', figmaReference: true, platformGap: true })
  assert.equal(result.action, 'proceed')
  assert.ok(result.labels.includes('PLATFORM_DEFAULT'))
})

test('PRODUCT.md versus Figma is a material conflict, never a silent precedence choice', () => {
  const result = decideFidelityPreflight({
    taskKind: 'reproduction',
    figmaReference: true,
    repoContext: true,
    materialConflict: true,
    conflictingSources: ['PRODUCT.md: light restrained', 'Figma: dark saturated'],
  })
  assert.equal(result.action, 'ask')
  assert.match(result.question, /PRODUCT\.md: light restrained ↔ Figma: dark saturated/)
  assert.ok(result.labels.includes('MATERIAL_CONFLICT'))
})

test('explicit creative permission is bounded and visible in provenance', () => {
  const result = decideFidelityPreflight({
    taskKind: 'other',
    explicitCreative: true,
    productGoal: true,
    primaryUser: true,
  })
  assert.equal(result.action, 'proceed')
  assert.ok(result.labels.includes('USER_EXPLICIT'))
})

test('the published contract names repo-first discovery, no-invention and provenance reporting', () => {
  const instructions = fidelityInstructions()
  assert.match(instructions, /Search repository context before asking/)
  assert.match(instructions, /Never invent/)
  assert.match(instructions, /PLATFORM_DEFAULT/)
  assert.match(instructions, /Unresolved gaps/)
  assert.equal(FIDELITY_POLICY.id, 'allcrew.fidelity-first')
})
