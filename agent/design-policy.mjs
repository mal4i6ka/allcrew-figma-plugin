export const FIDELITY_POLICY = Object.freeze({
  id: 'allcrew.fidelity-first',
  version: 1,
  purpose: 'Reproduce the product and brand from evidence; never invent missing product or visual direction.',
  sourceOrder: [
    'USER_EXPLICIT',
    'REPO_CONTRACT',
    'FIGMA_REFERENCE',
    'EXISTING_PRODUCT',
    'PLATFORM_DEFAULT',
  ],
  repositoryContext: [
    'AGENTS.md',
    'PRODUCT.md',
    'DESIGN.md',
    '.agents/context/',
    'README and architecture/design decision records',
    'existing product code',
  ],
  figmaEvidence: [
    'frames and sections',
    'variables and modes',
    'styles',
    'components, variants and properties',
    'annotations and dev resources',
    'prototype reactions and flows',
    'motion and transitions',
    'layout grids and inferred auto layout',
    'exported assets and measurements',
  ],
  neverInvent: [
    'brand attributes',
    'product goals',
    'information architecture',
    'tokens',
    'components',
    'visual language',
    'copy',
    'motion',
    'breakpoints',
  ],
  taskClasses: {
    evidenceBound: ['reproduction', 'bug-fix', 'measured-adaptation'],
    choiceBearing: ['new-surface', 'new-flow', 'redesign'],
  },
  platformDefaults: {
    allowedFor: ['accessibility', 'keyboard behavior', 'system semantics', 'safe areas', 'native gestures'],
    forbiddenFor: ['brand styling', 'visual language', 'product goals', 'copy tone'],
    label: 'PLATFORM_DEFAULT',
    standards: {
      web: ['WCAG 2.2', 'ARIA Authoring Practices'],
      ios: ['Apple Human Interface Guidelines'],
      android: ['Material Design 3'],
    },
  },
  provenanceLabels: [
    'FIGMA_NODE',
    'FIGMA_TOKEN',
    'FIGMA_STYLE',
    'FIGMA_COMPONENT',
    'FIGMA_ANNOTATION',
    'FIGMA_DEV_RESOURCE',
    'FIGMA_PROTOTYPE',
    'FIGMA_MOTION',
    'REPO_CONTRACT',
    'USER_EXPLICIT',
    'PLATFORM_DEFAULT',
    'INFERENCE',
    'UNRESOLVED',
  ],
  reportSections: ['Figma evidence used', 'Repository evidence used', 'Explicit user decisions', 'Platform defaults', 'Inferences', 'Unresolved gaps'],
})

const evidenceBound = new Set(FIDELITY_POLICY.taskClasses.evidenceBound)
const choiceBearing = new Set(FIDELITY_POLICY.taskClasses.choiceBearing)

function directionQuestion(missing) {
  return (
    'Чтобы не придумывать продукт и бренд за вас, давайте определим направление продуктового дизайна. ' +
    `Нужно уточнить: ${missing.join(', ')}. ` +
    'Какую задачу решает экран, кто основной пользователь и нужно ли продолжить язык существующего продукта, ' +
    'повторить конкретный Figma flow или создать явно новое направление? Для нового направления назовите ' +
    '2–3 желаемых качества и нежелательные референсы.'
  )
}

/** Pure decision contract used by tests and mirrored verbatim into Skill/MCP instructions. */
export function decideFidelityPreflight(input = {}) {
  const taskKind = String(input.taskKind || 'other')
  const figmaReference = input.figmaReference === true
  const existingProduct = input.existingProduct === true
  const repoContext = input.repoContext === true
  const neighboringSurfaces = input.neighboringSurfaces === true
  const missingAffectsOutcome = input.missingAffectsOutcome !== false
  const platformGap = input.platformGap === true

  if (input.materialConflict === true) {
    const sources = Array.isArray(input.conflictingSources) && input.conflictingSources.length > 0
      ? input.conflictingSources
      : ['repository contract', 'Figma evidence']
    return {
      action: 'ask',
      question: `Источники истины конфликтуют: ${sources.join(' ↔ ')}. Какой источник должен определять результат?`,
      reason: 'A material source conflict cannot be resolved without silently choosing somebody’s intent.',
      labels: ['MATERIAL_CONFLICT', 'UNRESOLVED'],
    }
  }

  if (evidenceBound.has(taskKind)) {
    if (figmaReference || existingProduct || repoContext) {
      return {
        action: 'proceed',
        question: null,
        reason: 'The task is evidence-bound and has an existing source to reproduce or measure.',
        labels: [...(platformGap ? ['PLATFORM_DEFAULT'] : []), 'EVIDENCE_BOUND'],
      }
    }
    return {
      action: 'ask',
      question: 'Какой существующий экран, компонент или поведение является источником истины для этой задачи?',
      reason: 'An evidence-bound task has no existing source to reproduce.',
      labels: ['REFERENCE_MISSING', 'UNRESOLVED'],
    }
  }

  if (choiceBearing.has(taskKind)) {
    const missing = []
    if (input.productGoal !== true) missing.push('цель продукта или экрана')
    if (input.primaryUser !== true) missing.push('основной пользователь и его задача')
    if (!(input.visualDirection === true || figmaReference || repoContext || neighboringSurfaces)) {
      missing.push('визуальное направление или референсная поверхность')
    }
    if (missing.length > 0 && missingAffectsOutcome) {
      return {
        action: 'ask',
        question: directionQuestion(missing),
        reason: 'The task requires product or visual choices that no available source defines.',
        labels: ['DIRECTION_REQUIRED', 'UNRESOLVED'],
      }
    }
  }

  return {
    action: 'proceed',
    question: null,
    reason: input.explicitCreative === true
      ? 'The user explicitly authorized invention within this task’s stated scope.'
      : 'Available evidence or explicit requirements are sufficient for the requested outcome.',
    labels: [...(platformGap ? ['PLATFORM_DEFAULT'] : []), ...(input.explicitCreative === true ? ['USER_EXPLICIT'] : [])],
  }
}

export function fidelityInstructions() {
  const p = FIDELITY_POLICY
  return [
    'Fidelity-first product design contract:',
    '1. Classify the task before asking: reproduction/bug-fix/measured adaptation vs new surface/new flow/redesign.',
    `2. Exhaust evidence in this order: ${p.sourceOrder.join(' → ')}. Search repository context before asking the user.`,
    `3. Never invent: ${p.neverInvent.join(', ')}. Explicit user authorization overrides this only within its stated scope.`,
    '4. For an existing Figma surface, proceed from frames, tokens, components, annotations, prototypes and motion; do not ask for a broad design direction.',
    '5. For choice-bearing work, ask one grouped direction question only when product goal, primary user/job or visual direction is missing and materially affects the result.',
    '6. Material conflicts between repository contracts and Figma must be asked about, never resolved silently.',
    `7. Platform conventions fill functional/accessibility gaps only and must be labelled ${p.platformDefaults.label}; they never replace brand styling.`,
    `8. Final reporting must include: ${p.reportSections.join('; ')}.`,
  ].join('\n')
}
