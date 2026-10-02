import type { OpDef } from './protocol.ts'

interface EvidenceNode {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly parent?: EvidenceNode | null
  readonly children?: readonly EvidenceNode[]
  readonly boundVariables?: Record<string, unknown>
  readonly annotations?: ReadonlyArray<Annotation>
  readonly layoutGrids?: ReadonlyArray<LayoutGrid>
  readonly inferredAutoLayout?: InferredAutoLayoutResult | null
  readonly layoutMode?: string
  readonly reactions?: readonly unknown[]
  readonly flowStartingPoints?: ReadonlyArray<{ nodeId: string; name: string }>
  loadAsync?: () => Promise<void>
  getReactionsAsync?: () => Promise<readonly unknown[]>
  getDevResourcesAsync?: (options?: { includeChildren?: boolean }) => Promise<DevResourceWithNodeId[]>
  getMainComponentAsync?: () => Promise<ComponentNode | null>
  readonly componentProperties?: ComponentProperties
  readonly description?: string
  readonly descriptionMarkdown?: string
  readonly documentationLinks?: ReadonlyArray<DocumentationLink>
  readonly fillStyleId?: string | symbol
  readonly strokeStyleId?: string | symbol
  readonly textStyleId?: string | symbol
  readonly effectStyleId?: string | symbol
  readonly gridStyleId?: string
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

function pageOf(node: EvidenceNode): EvidenceNode | null {
  let current: EvidenceNode | null = node
  while (current && current.type !== 'PAGE') current = current.parent ?? null
  return current?.type === 'PAGE' ? current : null
}

function aliases(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== 'object') return
  if ((value as { type?: string }).type === 'VARIABLE_ALIAS' && typeof (value as { id?: unknown }).id === 'string') {
    out.add((value as { id: string }).id)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) aliases(entry, out)
    return
  }
  for (const entry of Object.values(value as Record<string, unknown>)) aliases(entry, out)
}

function layoutGrid(grid: LayoutGrid): Record<string, unknown> {
  const common = {
    pattern: grid.pattern,
    ...(grid.visible === undefined ? {} : { visible: grid.visible }),
    ...(grid.color === undefined ? {} : { color: grid.color }),
  }
  if (grid.pattern === 'GRID') return { ...common, sectionSize: grid.sectionSize }
  return {
    ...common,
    alignment: grid.alignment,
    gutterSize: grid.gutterSize,
    count: grid.count,
    ...(grid.sectionSize === undefined ? {} : { sectionSize: grid.sectionSize }),
    ...(grid.offset === undefined ? {} : { offset: grid.offset }),
  }
}

function inferredLayout(value: InferredAutoLayoutResult): Record<string, unknown> {
  return {
    layoutMode: value.layoutMode,
    paddingLeft: value.paddingLeft,
    paddingRight: value.paddingRight,
    paddingTop: value.paddingTop,
    paddingBottom: value.paddingBottom,
    primaryAxisSizingMode: value.primaryAxisSizingMode,
    counterAxisSizingMode: value.counterAxisSizingMode,
    strokesIncludedInLayout: value.strokesIncludedInLayout,
    layoutWrap: value.layoutWrap,
    primaryAxisAlignItems: value.primaryAxisAlignItems,
    counterAxisAlignItems: value.counterAxisAlignItems,
    counterAxisAlignContent: value.counterAxisAlignContent,
    itemSpacing: value.itemSpacing,
    counterAxisSpacing: value.counterAxisSpacing,
    itemReverseZIndex: value.itemReverseZIndex,
  }
}

async function resolveRoot(reference: unknown): Promise<EvidenceNode> {
  if (typeof reference === 'string' && reference) {
    const found = await figma.getNodeByIdAsync(reference)
    if (!found || found.type === 'DOCUMENT') throw new Error(`no evidence-readable node ${reference}`)
    return found as unknown as EvidenceNode
  }
  const selected = figma.currentPage.selection[0]
  if (selected) return selected as unknown as EvidenceNode
  return figma.currentPage as unknown as EvidenceNode
}

export const DESIGN_EVIDENCE_OPS: readonly OpDef[] = [
  {
    name: 'design.evidence',
    summary: 'Figma evidence for fidelity-first work: intent, system atoms, behavior, grids and inferred layout.',
    agent:
      'Call this after checking AGENTS.md / PRODUCT.md / DESIGN.md and before choice-bearing product design. ' +
      'It reports Figma facts and gaps, not permission to invent. Existing-screen reproduction can proceed from ' +
      'strong visual evidence even when product intent is undocumented; new surfaces may need one grouped direction question.',
    mutates: false,
    params: {
      nodeId: {
        type: 'string',
        description: 'Frame, component, section or other subtree root. Omitted uses the current selection, then current page.',
      },
      includeChildren: {
        type: 'boolean',
        default: true,
        description: 'Read annotations, tokens, components, grids and behavior through the subtree rather than only the root.',
      },
      limit: {
        type: 'number',
        default: 500,
        min: 1,
        max: 5000,
        description: 'Maximum nodes inspected. The response names truncation instead of pretending the subtree was complete.',
      },
      budgetMs: {
        type: 'number',
        default: 15000,
        min: 1000,
        max: 110000,
        description: 'Stop starting optional reads after this time and report the evidence gap.',
      },
    },
    async run(params) {
      const started = Date.now()
      const budgetMs = Number(params.budgetMs ?? 15000)
      const deadline = started + budgetMs
      const limit = Number(params.limit ?? 500)
      const includeChildren = params.includeChildren !== false
      const root = await resolveRoot(params.nodeId)
      const page = pageOf(root)
      if (page?.loadAsync) await page.loadAsync()

      let categoryById = new Map<string, { label: string; color: string }>()
      try {
        const api = (figma as unknown as { annotations?: AnnotationsAPI }).annotations
        if (api && Date.now() < deadline) {
          const categories = await api.getAnnotationCategoriesAsync()
          categoryById = new Map(categories.map((category) => [category.id, { label: category.label, color: category.color }]))
        }
      } catch {
        categoryById = new Map()
      }

      const nodes: EvidenceNode[] = []
      const stack: EvidenceNode[] = [root]
      let truncated = false
      while (stack.length > 0) {
        if (nodes.length >= limit || Date.now() >= deadline) { truncated = true; break }
        const node = stack.pop()!
        nodes.push(node)
        if (includeChildren && Array.isArray(node.children)) {
          for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index])
        }
      }

      const annotations: Array<Record<string, unknown>> = []
      const grids: Array<Record<string, unknown>> = []
      const inferred: Array<Record<string, unknown>> = []
      const components: Array<Record<string, unknown>> = []
      const descriptions: Array<Record<string, unknown>> = []
      const styles = new Set<string>()
      const variables = new Set<string>()
      let reactions = 0
      let transitions = 0
      let textNodes = 0
      let explicitLayouts = 0

      for (const node of nodes) {
        if (node.type === 'TEXT') textNodes += 1
        aliases(node.boundVariables, variables)
        for (const styleId of [node.fillStyleId, node.strokeStyleId, node.textStyleId, node.effectStyleId, node.gridStyleId]) {
          if (typeof styleId === 'string' && styleId) styles.add(styleId)
        }
        if (node.layoutMode && node.layoutMode !== 'NONE') explicitLayouts += 1
        if (Array.isArray(node.layoutGrids) && node.layoutGrids.length > 0) {
          grids.push({ nodeId: node.id, name: node.name, grids: node.layoutGrids.map(layoutGrid) })
        }
        if ((!node.layoutMode || node.layoutMode === 'NONE') && node.inferredAutoLayout) {
          inferred.push({ nodeId: node.id, name: node.name, inferred: true, layout: inferredLayout(node.inferredAutoLayout) })
        }
        for (const annotation of Array.isArray(node.annotations) ? node.annotations : []) {
          const category = annotation.categoryId ? categoryById.get(annotation.categoryId) : undefined
          annotations.push({
            nodeId: node.id,
            name: node.name,
            ...(text(annotation.labelMarkdown) ? { markdown: text(annotation.labelMarkdown) } : {}),
            ...(text(annotation.label) ? { label: text(annotation.label) } : {}),
            properties: (annotation.properties ?? []).map((property: AnnotationProperty) => property.type),
            ...(annotation.categoryId ? { categoryId: annotation.categoryId } : {}),
            ...(category ? { category } : {}),
          })
        }
        if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
          components.push({ nodeId: node.id, name: node.name, type: node.type })
        } else if (node.type === 'INSTANCE') {
          const entry: Record<string, unknown> = {
            nodeId: node.id,
            name: node.name,
            type: node.type,
            properties: node.componentProperties ?? {},
          }
          if (Date.now() < deadline && typeof node.getMainComponentAsync === 'function') {
            try {
              const main = await node.getMainComponentAsync()
              if (main) entry.main = { id: main.id, name: main.name, key: main.key }
            } catch {
              entry.main = null
            }
          }
          components.push(entry)
        }
        const description = text(node.descriptionMarkdown) ?? text(node.description)
        const links = Array.isArray(node.documentationLinks) ? node.documentationLinks.map((link) => link.uri) : []
        if (description || links.length > 0) descriptions.push({ nodeId: node.id, name: node.name, description, links })
        let nodeReactions: readonly unknown[] = Array.isArray(node.reactions) ? node.reactions : []
        if (Date.now() < deadline && typeof node.getReactionsAsync === 'function') {
          try { nodeReactions = await node.getReactionsAsync() } catch { /* the static field remains */ }
        }
        reactions += nodeReactions.length
        for (const reaction of nodeReactions as Array<{ actions?: Array<{ transition?: unknown }>; action?: { transition?: unknown } }>) {
          const actions = reaction.actions ?? (reaction.action ? [reaction.action] : [])
          transitions += actions.filter((action) => action.transition).length
        }
      }

      let devResources: Array<Record<string, unknown>> = []
      if (Date.now() < deadline && typeof root.getDevResourcesAsync === 'function') {
        try {
          devResources = (await root.getDevResourcesAsync({ includeChildren })).map((resource) => ({
            nodeId: resource.nodeId,
            name: resource.name,
            url: resource.url,
            ...(resource.inheritedNodeId ? { inheritedNodeId: resource.inheritedNodeId } : {}),
          }))
        } catch {
          devResources = []
        }
      }

      const intentSignals = annotations.filter((annotation) => annotation.label || annotation.markdown).length +
        devResources.length + descriptions.length
      const visualSignals = variables.size + styles.size + components.length + grids.length + explicitLayouts
      const gaps: Array<Record<string, unknown>> = []
      if (intentSignals === 0) {
        gaps.push({
          code: 'FIGMA_INTENT_NOT_DOCUMENTED',
          detail: 'No annotations, dev resources or component documentation in this subtree.',
          blockingFor: ['new-surface', 'new-flow', 'redesign'],
          blockingForExistingReproduction: false,
        })
      }
      if (visualSignals === 0) {
        gaps.push({
          code: 'NO_DESIGN_SYSTEM_SIGNALS',
          detail: 'No variable bindings, shared styles, components, grids or explicit layout were found.',
          blockingFor: ['reproduction', 'new-surface', 'new-flow', 'redesign'],
        })
      }
      if (truncated) {
        gaps.push({
          code: 'EVIDENCE_TRUNCATED',
          detail: `Stopped after ${nodes.length} nodes or ${budgetMs} ms. Narrow the subtree or raise the bounded limit/budget.`,
          blockingFor: ['reproduction', 'new-surface', 'new-flow', 'redesign'],
        })
      }

      return {
        policy: 'allcrew.fidelity-first',
        scope: { id: root.id, name: root.name, type: root.type, page: page ? { id: page.id, name: page.name } : null },
        coverage: {
          visual: visualSignals >= 3 ? 'strong' : visualSignals > 0 ? 'partial' : 'missing',
          behavior: reactions > 0 ? 'declared' : 'not-declared',
          content: textNodes > 0 ? 'present' : 'not-present',
          productIntent: intentSignals > 0 ? 'signals-present' : 'not-documented-in-figma',
          layout: explicitLayouts > 0 ? 'configured' : inferred.length > 0 ? 'inferred-only' : 'absolute-or-unknown',
        },
        sources: {
          annotations,
          devResources,
          documentation: descriptions,
          designSystem: {
            variableBindings: variables.size,
            variableIds: [...variables].slice(0, 100),
            sharedStyles: styles.size,
            styleIds: [...styles].slice(0, 100),
            components,
          },
          behavior: { reactions, transitions, flowStartingPoints: page?.flowStartingPoints ?? [] },
          layout: { explicitAutoLayoutNodes: explicitLayouts, layoutGrids: grids, inferredLayouts: inferred },
          content: { textNodes },
        },
        gaps,
        provenance: {
          facts: intentSignals + visualSignals + reactions + transitions + textNodes,
          inferred: inferred.length,
          missing: gaps.length,
        },
        inspected: nodes.length,
        truncated,
        ms: Date.now() - started,
      }
    },
  },
]
