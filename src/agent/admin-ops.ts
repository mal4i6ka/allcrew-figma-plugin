import type { OpDef } from './protocol.ts'
import { coerceVariableValue, describeValue } from './values.ts'

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${where} must be a non-empty array`)
  return value
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${where} must be a non-empty string`)
  return value.trim()
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message || error)
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function matches(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : value === pattern)
}

async function localCollections(): Promise<VariableCollection[]> {
  return await figma.variables.getLocalVariableCollectionsAsync()
}

function resolveCollectionFrom(
  collections: readonly VariableCollection[],
  reference: unknown,
  where = 'collection'
): VariableCollection {
  const ref = text(reference, where)
  const exact = collections.filter((collection) => collection.id === ref || collection.key === ref || collection.name === ref)
  if (exact.length === 0) throw new Error(`${where} "${ref}" does not match a local collection`)
  if (exact.length > 1) throw new Error(`${where} "${ref}" is ambiguous; use its id`)
  return exact[0]
}

function resolveMode(
  modes: readonly { modeId: string; name: string }[],
  reference: unknown,
  where: string
): { modeId: string; name: string } {
  const ref = text(reference, where)
  const exact = modes.filter((mode) => mode.modeId === ref || mode.name === ref)
  if (exact.length === 0) throw new Error(`${where} "${ref}" does not match a mode`)
  if (exact.length > 1) throw new Error(`${where} "${ref}" is ambiguous; use its id`)
  return exact[0]
}

interface CollectionModePlan {
  kind: 'rename' | 'add' | 'remove'
  modeId?: string
  before?: string
  after?: string
  name?: string
  lostValues?: number
  lostVariables?: string[]
}

interface CollectionPlan {
  id: string
  before: { name: string; hiddenFromPublishing: boolean; modes: Array<{ modeId: string; name: string }>; variables: number }
  newName?: string
  hiddenFromPublishing?: boolean
  modes: CollectionModePlan[]
  remove: boolean
}

export async function planCollectionUpdates(raw: unknown, force = false): Promise<CollectionPlan[]> {
  const entries = array(raw, 'collections')
  const collections = await localCollections()
  const variables = await figma.variables.getLocalVariablesAsync()
  const byCollection = new Map<string, Variable[]>()
  for (const variable of variables) {
    const list = byCollection.get(variable.variableCollectionId) ?? []
    list.push(variable)
    byCollection.set(variable.variableCollectionId, list)
  }
  const plannedIds = new Set<string>()
  const plans: CollectionPlan[] = []

  for (const [index, rawEntry] of entries.entries()) {
    const entry = object(rawEntry, `collections[${index}]`)
    const collection = resolveCollectionFrom(collections, entry.collection, `collections[${index}].collection`)
    if (plannedIds.has(collection.id)) throw new Error(`collection "${collection.name}" occurs more than once`)
    plannedIds.add(collection.id)
    const ownVariables = byCollection.get(collection.id) ?? []
    const remove = entry.remove === true
    const newName = entry.newName === undefined ? undefined : text(entry.newName, `collections[${index}].newName`)
    const hidden = entry.hiddenFromPublishing
    if (hidden !== undefined && typeof hidden !== 'boolean') {
      throw new Error(`collections[${index}].hiddenFromPublishing must be a boolean`)
    }
    const steps = entry.modes === undefined ? [] : array(entry.modes, `collections[${index}].modes`)
    if (remove && (newName !== undefined || hidden !== undefined || steps.length > 0)) {
      throw new Error(`collections[${index}] cannot combine remove with other changes`)
    }
    if (remove && ownVariables.length > 0 && !force) {
      throw new Error(`collection "${collection.name}" contains ${ownVariables.length} variables; remove them first or pass force: true`)
    }

    const simulated = collection.modes.map((mode) => ({ ...mode }))
    const modePlans: CollectionModePlan[] = []
    for (const [stepIndex, rawStep] of steps.entries()) {
      const step = object(rawStep, `collections[${index}].modes[${stepIndex}]`)
      if (step.add !== undefined) {
        if (collection.isExtension) throw new Error(`extended collection "${collection.name}" cannot add modes`)
        const name = text(step.add, `collections[${index}].modes[${stepIndex}].add`)
        if (simulated.some((mode) => mode.name.toLowerCase() === name.toLowerCase())) {
          throw new Error(`mode "${name}" already exists in "${collection.name}"`)
        }
        const temporaryId = `planned:${index}:${stepIndex}`
        simulated.push({ modeId: temporaryId, name })
        modePlans.push({ kind: 'add', name })
        continue
      }

      const mode = resolveMode(simulated, step.mode, `collections[${index}].modes[${stepIndex}].mode`)
      if (step.remove === true) {
        if (mode.modeId === collection.defaultModeId) throw new Error(`default mode "${mode.name}" cannot be removed`)
        if (simulated.length === 1) throw new Error(`the last mode in "${collection.name}" cannot be removed`)
        const defaultValueId = collection.defaultModeId
        const lostVariables = ownVariables
          .filter((variable) => Object.prototype.hasOwnProperty.call(variable.valuesByMode, mode.modeId))
          .filter((variable) => !sameValue(variable.valuesByMode[mode.modeId], variable.valuesByMode[defaultValueId]))
          .map((variable) => variable.name)
        if (lostVariables.length > 0 && !force) {
          throw new Error(
            `mode "${mode.name}" has ${lostVariables.length} value(s) different from the default; pass force: true to remove it`
          )
        }
        simulated.splice(simulated.indexOf(mode), 1)
        modePlans.push({
          kind: 'remove',
          modeId: mode.modeId,
          before: mode.name,
          lostValues: lostVariables.length,
          lostVariables: lostVariables.slice(0, 20),
        })
        continue
      }

      const renamed = text(step.newName, `collections[${index}].modes[${stepIndex}].newName`)
      if (simulated.some((candidate) => candidate !== mode && candidate.name.toLowerCase() === renamed.toLowerCase())) {
        throw new Error(`renaming "${mode.name}" to "${renamed}" conflicts with another mode`)
      }
      const before = mode.name
      mode.name = renamed
      modePlans.push({ kind: 'rename', modeId: mode.modeId, before, after: renamed })
    }

    if (!remove && newName === undefined && hidden === undefined && modePlans.length === 0) {
      throw new Error(`collections[${index}] contains no changes`)
    }
    plans.push({
      id: collection.id,
      before: {
        name: collection.name,
        hiddenFromPublishing: collection.hiddenFromPublishing,
        modes: collection.modes.map((mode) => ({ ...mode })),
        variables: ownVariables.length,
      },
      ...(newName === undefined ? {} : { newName }),
      ...(hidden === undefined ? {} : { hiddenFromPublishing: hidden }),
      modes: modePlans,
      remove,
    })
  }
  return plans
}

function pageMatches(page: PageNode, reference: string): boolean {
  return page.id === reference || page.name === reference
}

interface PagePlan {
  id: string
  before: { name: string; index: number; children: number; components: number }
  newName?: string
  index?: number
  remove: boolean
}

export async function planPageUpdates(raw: unknown, force = false): Promise<PagePlan[]> {
  const entries = array(raw, 'pages')
  const pages = [...figma.root.children]
  const planned = new Set<string>()
  const plans: PagePlan[] = []
  let removeCount = 0
  for (const [entryIndex, rawEntry] of entries.entries()) {
    const entry = object(rawEntry, `pages[${entryIndex}]`)
    const ref = text(entry.page, `pages[${entryIndex}].page`)
    const found = pages.filter((page) => pageMatches(page, ref))
    if (found.length === 0) throw new Error(`page "${ref}" does not exist`)
    if (found.length > 1) throw new Error(`page "${ref}" is ambiguous; use its id`)
    const page = found[0]
    if (planned.has(page.id)) throw new Error(`page "${page.name}" occurs more than once`)
    planned.add(page.id)
    await page.loadAsync()
    const remove = entry.remove === true
    const newName = entry.newName === undefined ? undefined : text(entry.newName, `pages[${entryIndex}].newName`)
    let newIndex: number | undefined
    if (entry.index !== undefined) {
      if (typeof entry.index !== 'number' || !Number.isInteger(entry.index) || entry.index < 0) {
        throw new Error(`pages[${entryIndex}].index must be a non-negative integer`)
      }
      newIndex = entry.index
    }
    if (remove && (newName !== undefined || newIndex !== undefined)) {
      throw new Error(`pages[${entryIndex}] cannot combine remove with rename or move`)
    }
    const components = page.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] }).length
    if (remove) {
      removeCount++
      if (page.children.length > 0 && !force) {
        throw new Error(`page "${page.name}" contains ${page.children.length} top-level layer(s); pass force: true to remove it`)
      }
    }
    if (!remove && newName === undefined && newIndex === undefined) throw new Error(`pages[${entryIndex}] contains no changes`)
    plans.push({
      id: page.id,
      before: { name: page.name, index: pages.indexOf(page), children: page.children.length, components },
      ...(newName === undefined ? {} : { newName }),
      ...(newIndex === undefined ? {} : { index: newIndex }),
      remove,
    })
  }
  if (pages.length - removeCount < 1) throw new Error('the last page cannot be removed')
  const finalCount = pages.length - removeCount
  for (const plan of plans) {
    if (plan.index !== undefined && plan.index >= finalCount) {
      throw new Error(`page "${plan.before.name}" index ${plan.index} is outside the final ${finalCount}-page document`)
    }
  }
  return plans
}

interface AuditFinding {
  kind: 'MIXED' | 'MISSING_MODE' | 'UNRESOLVED_ALIAS' | 'LITERAL'
  variable: string
  variableId: string
  collection: string
  mode?: string
  detail: string
}

export async function auditVariables(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requested = Array.isArray(params.collections)
    ? (params.collections as unknown[]).filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : []
  const aliasOnly = Array.isArray(params.aliasOnly)
    ? (params.aliasOnly as unknown[]).filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : []
  const ignore = Array.isArray(params.ignore)
    ? (params.ignore as unknown[]).filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : []
  const includeLibraries = params.libraries === true
  const budgetMs = Math.min(110_000, Math.max(1_000, typeof params.budgetMs === 'number' ? params.budgetMs : 30_000))
  const started = Date.now()
  const collections = await localCollections()
  const selected = requested.length === 0
    ? collections
    : collections.filter((collection) => requested.some((ref) => ref === collection.id || ref === collection.name))
  if (requested.length > 0 && selected.length !== new Set(requested).size) {
    const matched = new Set(selected.flatMap((collection) => [collection.id, collection.name]))
    const missing = requested.filter((ref) => !matched.has(ref))
    if (missing.length > 0) throw new Error(`unknown collection(s): ${missing.join(', ')}`)
  }
  const collectionById = new Map(selected.map((collection) => [collection.id, collection]))
  const allVariables = await figma.variables.getLocalVariablesAsync()
  const localById = new Map(allVariables.map((variable) => [variable.id, variable]))
  const findings: AuditFinding[] = []
  const remoteCache = new Map<string, Variable | null>()
  let networkErrors = 0
  let timedOut = false

  for (const variable of allVariables) {
    const collection = collectionById.get(variable.variableCollectionId)
    if (!collection || matches(variable.name, ignore)) continue
    let aliases = 0
    let literals = 0
    for (const mode of collection.modes) {
      if (!Object.prototype.hasOwnProperty.call(variable.valuesByMode, mode.modeId)) {
        findings.push({
          kind: 'MISSING_MODE', variable: variable.name, variableId: variable.id, collection: collection.name,
          mode: mode.name, detail: `no value for ${mode.name}`,
        })
        continue
      }
      const value = variable.valuesByMode[mode.modeId] as VariableValue
      const alias = value as VariableAlias
      if (alias && typeof alias === 'object' && alias.type === 'VARIABLE_ALIAS') {
        aliases++
        if (localById.has(alias.id)) continue
        if (/^VariableID:\d+:\d+$/.test(alias.id)) {
          findings.push({
            kind: 'UNRESOLVED_ALIAS', variable: variable.name, variableId: variable.id,
            collection: collection.name, mode: mode.name, detail: `local alias ${alias.id} no longer exists`,
          })
          continue
        }
        if (!includeLibraries || Date.now() - started >= budgetMs) {
          if (Date.now() - started >= budgetMs) timedOut = true
          continue
        }
        let target = remoteCache.get(alias.id)
        if (target === undefined) {
          try {
            target = await figma.variables.getVariableByIdAsync(alias.id)
            remoteCache.set(alias.id, target)
          } catch {
            networkErrors++
            continue
          }
        }
        if (target === null) {
          findings.push({
            kind: 'UNRESOLVED_ALIAS', variable: variable.name, variableId: variable.id,
            collection: collection.name, mode: mode.name, detail: `alias ${alias.id} does not resolve`,
          })
        }
      } else {
        literals++
      }
    }
    if (aliases > 0 && literals > 0) {
      findings.push({
        kind: 'MIXED', variable: variable.name, variableId: variable.id, collection: collection.name,
        detail: `${aliases} alias mode(s), ${literals} literal mode(s)`,
      })
    }
    if (literals > 0 && aliases === 0 && matches(collection.name, aliasOnly)) {
      findings.push({
        kind: 'LITERAL', variable: variable.name, variableId: variable.id, collection: collection.name,
        detail: `all ${literals} populated mode(s) are literals in an alias-only collection`,
      })
    }
  }

  const counts = findings.reduce<Record<string, number>>((out, finding) => {
    out[finding.kind] = (out[finding.kind] ?? 0) + 1
    return out
  }, {})
  return {
    clean: findings.length === 0 && networkErrors === 0 && !timedOut,
    collections: selected.map((collection) => ({ id: collection.id, name: collection.name })),
    variables: allVariables.filter((variable) => collectionById.has(variable.variableCollectionId)).length,
    counts,
    findings,
    libraries: { enabled: includeLibraries, read: remoteCache.size, errors: networkErrors, timedOut },
    ms: Date.now() - started,
  }
}

export const ADMIN_OPS: readonly OpDef[] = [
  {
    name: 'collections.update',
    summary: 'Rename, hide, edit modes or remove local variable collections as one validated plan.',
    agent:
      'The whole batch is validated before the first write. Default and last modes cannot be removed; destructive mode or collection removal requires force: true and dryRun reports the loss first.',
    mutates: true,
    params: {
      collections: {
        type: 'json', required: true,
        description: 'Array of { collection, newName?, hiddenFromPublishing?, modes?: [{mode,newName}|{mode,remove:true}|{add}], remove? }.',
      },
      force: { type: 'boolean', default: false, description: 'Allow losing non-default mode values or deleting a non-empty collection.' },
      dryRun: { type: 'boolean', default: false, description: 'Validate and report the complete plan without writing.' },
    },
    async run(params) {
      const force = params.force === true
      const dryRun = params.dryRun === true
      const plans = await planCollectionUpdates(params.collections, force)
      if (dryRun) return { dryRun, changed: 0, plans }
      figma.commitUndo()
      const before = await localCollections()
      const byId = new Map(before.map((collection) => [collection.id, collection]))
      for (const plan of plans) {
        const collection = byId.get(plan.id)!
        if (plan.remove) {
          collection.remove()
          continue
        }
        if (plan.newName !== undefined) collection.name = plan.newName
        if (plan.hiddenFromPublishing !== undefined) collection.hiddenFromPublishing = plan.hiddenFromPublishing
        for (const step of plan.modes) {
          if (step.kind === 'rename') collection.renameMode(step.modeId!, step.after!)
          else if (step.kind === 'remove') collection.removeMode(step.modeId!)
          else collection.addMode(step.name!)
        }
      }
      const roster = await localCollections()
      const fresh = new Map(roster.map((collection) => [collection.id, collection]))
      const results = plans.map((plan) => {
        const collection = fresh.get(plan.id)
        if (plan.remove) return { collection: plan.id, removed: !collection, ok: !collection }
        const expectedName = plan.newName ?? plan.before.name
        const expectedHidden = plan.hiddenFromPublishing ?? plan.before.hiddenFromPublishing
        const ok = Boolean(collection && collection.name === expectedName && collection.hiddenFromPublishing === expectedHidden)
        return { collection: plan.id, ok, after: collection ? { name: collection.name, hiddenFromPublishing: collection.hiddenFromPublishing, modes: collection.modes } : null }
      })
      return { dryRun, changed: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok).length, results }
    },
  },
  {
    name: 'pages.update',
    summary: 'Rename, reorder or remove document pages as one validated plan.',
    agent:
      'Applies renames, then removals, then moves. A page with layers requires force: true; dryRun reports its layer and component counts. The last page is never removable.',
    mutates: true,
    params: {
      pages: { type: 'json', required: true, description: 'Array of { page, newName?, index?, remove? }; page is an id or exact name.' },
      force: { type: 'boolean', default: false, description: 'Allow removing pages that contain layers.' },
      dryRun: { type: 'boolean', default: false, description: 'Validate and report without writing.' },
    },
    async run(params) {
      const dryRun = params.dryRun === true
      const plans = await planPageUpdates(params.pages, params.force === true)
      if (dryRun) return { dryRun, changed: 0, plans }
      figma.commitUndo()
      const pages = new Map(figma.root.children.map((page) => [page.id, page]))
      for (const plan of plans) if (!plan.remove && plan.newName !== undefined) pages.get(plan.id)!.name = plan.newName
      for (const plan of plans) {
        if (!plan.remove) continue
        const page = pages.get(plan.id)!
        if (figma.currentPage.id === page.id) {
          const next = figma.root.children.find((candidate) => candidate.id !== page.id)
          if (!next) throw new Error('the last page cannot be removed')
          await figma.setCurrentPageAsync(next)
        }
        page.remove()
      }
      for (const plan of plans) {
        if (plan.remove || plan.index === undefined) continue
        const page = figma.root.children.find((candidate) => candidate.id === plan.id)
        if (page) figma.root.insertChild(plan.index, page)
      }
      const roster = [...figma.root.children]
      const results = plans.map((plan) => {
        const page = roster.find((candidate) => candidate.id === plan.id)
        if (plan.remove) return { page: plan.id, removed: !page, ok: !page }
        const ok = Boolean(page && (plan.newName === undefined || page.name === plan.newName) && (plan.index === undefined || roster.indexOf(page) === plan.index))
        return { page: plan.id, ok, after: page ? { name: page.name, index: roster.indexOf(page) } : null }
      })
      return { dryRun, changed: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok).length, results }
    },
  },
  {
    name: 'variables.extend',
    summary: 'Create an Enterprise extended collection and manage its variable overrides.',
    agent:
      'Enterprise only. A plan failure leaves nothing created; a pricing-tier refusal is returned verbatim. Overrides accept {variable,mode,value}, {variable,mode,remove:true}, or {variable,removeAll:true}.',
    mutates: true,
    params: {
      source: { type: 'string', required: true, description: 'Local collection id/name/key or a published library collection key.' },
      name: { type: 'string', required: true, description: 'Name for the extended collection.' },
      overrides: { type: 'json', default: [], description: 'Override actions for inherited variables.' },
      dryRun: { type: 'boolean', default: false, description: 'Validate the source and override shapes without creating anything.' },
    },
    async run(params) {
      const source = text(params.source, 'source')
      const name = text(params.name, 'name')
      const rows = params.overrides === undefined ? [] : (Array.isArray(params.overrides) ? params.overrides : (() => { throw new Error('overrides must be an array') })())
      const parsed = rows.map((row, index) => object(row, `overrides[${index}]`))
      for (const [index, row] of parsed.entries()) {
        text(row.variable, `overrides[${index}].variable`)
        if (row.removeAll === true) continue
        text(row.mode, `overrides[${index}].mode`)
        if (row.remove !== true && row.value === undefined) throw new Error(`overrides[${index}] needs value, remove: true or removeAll: true`)
      }
      let local: VariableCollection | null = null
      try { local = resolveCollectionFrom(await localCollections(), source, 'source') } catch { local = null }
      if (params.dryRun === true) return { dryRun: true, source: local ? { id: local.id, name: local.name } : { key: source }, name, overrides: parsed }
      figma.commitUndo()
      let extension: ExtendedVariableCollection
      try {
        extension = local
          ? local.extend(name)
          : await figma.variables.extendLibraryCollectionByKeyAsync(source, name)
      } catch (error) {
        const message = errorMessage(error)
        if (/outside of enterprise plan/i.test(message)) {
          throw new Error('variables.extend requires an Enterprise Figma plan: ' + message)
        }
        throw error
      }
      const inherited = (await Promise.all(extension.variableIds.map((id) => figma.variables.getVariableByIdAsync(id)))).filter((entry): entry is Variable => Boolean(entry))
      for (const [index, row] of parsed.entries()) {
        const ref = String(row.variable)
        const found = inherited.filter((variable) => variable.id === ref || variable.name === ref)
        if (found.length !== 1) throw new Error(`overrides[${index}].variable "${ref}" ${found.length ? 'is ambiguous' : 'does not exist'}`)
        const variable = found[0]
        if (row.removeAll === true) {
          extension.removeOverridesForVariable(variable)
          continue
        }
        const mode = resolveMode(extension.modes, row.mode, `overrides[${index}].mode`)
        if (row.remove === true) variable.removeOverrideForMode(mode.modeId)
        else variable.setValueForMode(mode.modeId, await coerceVariableValue(variable, row.value))
      }
      const roster = await localCollections()
      const fresh = roster.find((collection) => collection.id === extension.id) as ExtendedVariableCollection | undefined
      if (!fresh || !fresh.isExtension) throw new Error('extended collection did not appear in the fresh collection roster')
      return {
        dryRun: false,
        collection: { id: fresh.id, name: fresh.name, parentVariableCollectionId: fresh.parentVariableCollectionId, modes: fresh.modes },
        overrides: fresh.variableOverrides,
      }
    },
  },
  {
    name: 'variables.audit',
    summary: 'Audit variable modes for missing values, mixed aliases, broken aliases and forbidden literals.',
    agent:
      'Reads all local variables once. Set aliasOnly to semantic collection names and ignore to exact names or prefix* patterns. Library aliases are checked only when libraries: true; network failures are reported as unread, never as false broken aliases.',
    mutates: false,
    params: {
      collections: { type: 'string[]', description: 'Local collection ids or exact names. Empty means every local collection.' },
      aliasOnly: { type: 'string[]', default: [], description: 'Collection names or prefix* patterns whose variables must contain aliases.' },
      ignore: { type: 'string[]', default: [], description: 'Exact variable names or prefix* patterns to omit.' },
      libraries: { type: 'boolean', default: false, description: 'Resolve library alias ids one at a time within the time budget.' },
      budgetMs: { type: 'number', default: 30000, min: 1000, max: 110000, description: 'Maximum time to start library reads.' },
    },
    run: auditVariables,
  },
]
