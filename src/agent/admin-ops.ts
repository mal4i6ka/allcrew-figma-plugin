import type { OpDef } from './protocol.ts'
import {
  coerceVariableValue,
  describeValue,
  isAlias,
  isLibraryKey,
  resolveCollection,
  resolveVariableRef,
} from './values.ts'

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
  const byId = collections.find((collection) => collection.id === ref || collection.key === ref)
  if (byId) return byId
  const named = collections.filter((collection) => collection.name.toLowerCase() === ref.toLowerCase())
  if (named.length === 0) throw new Error(`${where} "${ref}" does not match a local collection`)
  if (named.length > 1) throw new Error(`${where} "${ref}" is ambiguous; use its id`)
  return named[0]
}

export function resolveMode(
  modes: readonly { modeId: string; name: string }[],
  reference: unknown,
  where: string
): { modeId: string; name: string } {
  const ref = text(reference, where)
  const byId = modes.find((mode) => mode.modeId === ref)
  if (byId) return byId
  const named = modes.filter((mode) => mode.name.toLowerCase() === ref.toLowerCase())
  if (named.length === 0) throw new Error(`${where} "${ref}" does not match a mode`)
  if (named.length > 1) throw new Error(`${where} "${ref}" is ambiguous; use its id`)
  return named[0]
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
    if (newName !== undefined && newName.toLowerCase() !== collection.name.toLowerCase()) {
      const clash = collections.some(
        (candidate) => candidate.id !== collection.id && candidate.name.toLowerCase() === newName.toLowerCase()
      )
      if (clash) throw new Error(`a collection named "${newName}" already exists`)
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
      if (step.remove === true && step.newName !== undefined) {
        throw new Error(`collections[${index}].modes[${stepIndex}] cannot combine remove with newName`)
      }
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

export interface PagePlan {
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

export function expectedPageOrder(ids: readonly string[], plans: readonly PagePlan[]): string[] {
  const order = ids.filter((id) => !plans.some((plan) => plan.remove && plan.id === id))
  for (const plan of plans) {
    if (plan.index === undefined) continue
    const current = order.indexOf(plan.id)
    if (current >= 0) order.splice(current, 1)
    order.splice(Math.min(plan.index, order.length), 0, plan.id)
  }
  return order
}

export type AuditKind = 'MIXED' | 'MISSING_MODE' | 'UNRESOLVED_ALIAS' | 'LITERAL'

export function classifyModeColumns(
  valuesByMode: Readonly<Record<string, unknown>>,
  modeIds: readonly string[],
  unresolved: ReadonlySet<string> = new Set(),
  aliasOnly = false
): AuditKind[] {
  const kinds: AuditKind[] = []
  let aliases = 0
  let literals = 0
  let missing = 0
  let broken = 0
  for (const modeId of modeIds) {
    const value = valuesByMode[modeId]
    if (value === undefined) missing++
    else if (isAlias(value)) {
      aliases++
      if (unresolved.has(value.id)) broken++
    } else literals++
  }
  if (aliases > 0 && literals > 0) kinds.push('MIXED')
  if (missing > 0) kinds.push('MISSING_MODE')
  if (broken > 0) kinds.push('UNRESOLVED_ALIAS')
  if (aliasOnly && literals > 0 && aliases === 0) kinds.push('LITERAL')
  return kinds
}

export const isLibraryId = (id: string): boolean => id.includes('/')

async function describeCached(value: unknown, lookups: ReadonlyMap<string, Variable | null>): Promise<string> {
  if (value === undefined) return '(unset)'
  if (isAlias(value)) {
    const target = lookups.get(value.id)
    if (target === undefined && isLibraryId(value.id)) return '→ (library variable, not read)'
    if (!target) return `→ ${value.id} (unresolved)`
    return target.remote ? `→ ${target.name} (library)` : `→ ${target.name}`
  }
  return describeValue(value as VariableValue)
}

export async function auditVariables(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const strings = (raw: unknown): string[] =>
    (Array.isArray(raw) ? raw : []).filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  const started = Date.now()
  const budgetMs = Math.min(110_000, Math.max(1_000, typeof params.budgetMs === 'number' ? params.budgetMs : 60_000))
  const deadline = started + budgetMs
  const includeRemote = params.libraries !== false
  const ignore = strings(params.ignore)
  const wanted = strings(params.collections)
  const locals = await localCollections()
  const queue = wanted.length
    ? await Promise.all(wanted.map((ref) => resolveCollection(ref)))
    : [...locals]
  const audited = new Set(queue.map((collection) => collection.id))
  const aliasOnly = new Set<string>()
  for (const ref of strings(params.aliasOnly)) {
    if (ref.endsWith('*')) {
      const prefix = ref.slice(0, -1).toLowerCase()
      for (const collection of locals) {
        if (collection.name.toLowerCase().startsWith(prefix)) aliasOnly.add(collection.id)
      }
    } else {
      aliasOnly.add((await resolveCollection(ref)).id)
    }
  }

  /* Read local variables in one batch. Looking them up individually turns each library alias
   * into a network trip and can make a large design-system audit take several minutes. */
  const lookups = new Map<string, Variable | null>()
  for (const variable of await figma.variables.getLocalVariablesAsync()) lookups.set(variable.id, variable)
  const localMs = Date.now() - started

  let networkFailures = 0
  let skippedLibrary = 0
  const inBudget = () => Date.now() < deadline
  const fetchLibrary = async (id: string): Promise<Variable | null | undefined> => {
    if (lookups.has(id)) return lookups.get(id)!
    if (!includeRemote || !inBudget()) {
      skippedLibrary++
      return undefined
    }
    try {
      const found = await figma.variables.getVariableByIdAsync(id)
      lookups.set(id, found)
      return found
    } catch {
      networkFailures++
      skippedLibrary++
      return undefined
    }
  }

  const findings: Array<Record<string, unknown>> = []
  const summary: Array<Record<string, unknown>> = []
  for (let at = 0; at < queue.length; at++) {
    const collection = queue[at]
    const modeIds = collection.modes.map((mode) => mode.modeId)
    const modeName = new Map(collection.modes.map((mode) => [mode.modeId, mode.name]))
    if (modeIds.length < 2 && params.singleMode !== true && !aliasOnly.has(collection.id)) {
      summary.push({ collection: collection.name, remote: collection.remote, modes: modeIds.length, skipped: 'single mode' })
      continue
    }
    let read = 0
    let unreadable = 0
    let flagged = 0
    let incomplete = false
    for (const id of collection.variableIds) {
      const variable = isLibraryId(id) ? await fetchLibrary(id) : (lookups.get(id) ?? null)
      if (variable === undefined) {
        incomplete = true
        continue
      }
      if (!variable) {
        unreadable++
        continue
      }
      read++
      const values = variable.valuesByMode ?? {}
      const unresolved = new Set<string>()
      for (const value of Object.values(values)) {
        if (!isAlias(value)) continue
        if (!isLibraryId(value.id)) {
          if (!lookups.get(value.id)) unresolved.add(value.id)
          continue
        }
        if (!includeRemote) continue
        const target = await fetchLibrary(value.id)
        if (target === null) unresolved.add(value.id)
        if (target && !audited.has(target.variableCollectionId) && inBudget()) {
          let remote: VariableCollection | null
          try {
            remote = await figma.variables.getVariableCollectionByIdAsync(target.variableCollectionId)
          } catch {
            networkFailures++
            skippedLibrary++
            remote = null
          }
          if (remote) {
            audited.add(remote.id)
            queue.push(remote)
          }
        }
      }
      if (matches(variable.name, ignore)) continue
      const kinds = classifyModeColumns(values, modeIds, unresolved, aliasOnly.has(collection.id))
      if (kinds.length === 0) continue
      flagged++
      const byMode: Record<string, string> = {}
      for (const modeId of modeIds) byMode[modeName.get(modeId)!] = await describeCached(values[modeId], lookups)
      findings.push({
        collection: collection.name,
        remote: collection.remote,
        variable: variable.name,
        variableId: variable.id,
        kinds,
        values: byMode,
      })
    }
    summary.push({
      collection: collection.name,
      remote: collection.remote,
      modes: modeIds.length,
      variables: collection.variableIds.length,
      read,
      ...(unreadable ? { unreadable } : {}),
      ...(incomplete ? { incomplete: true } : {}),
      flagged,
    })
  }
  const counts: Record<string, number> = {}
  for (const finding of findings) {
    for (const kind of finding.kinds as AuditKind[]) counts[kind] = (counts[kind] ?? 0) + 1
  }
  const ranOut = skippedLibrary > 0 && includeRemote
  return {
    clean: findings.length === 0 && !ranOut && networkFailures === 0,
    total: findings.length,
    counts,
    collections: summary,
    findings,
    libraries: {
      enabled: includeRemote,
      read: [...lookups.keys()].filter(isLibraryId).length,
      errors: networkFailures,
      timedOut: ranOut,
    },
    ms: { local: localMs, total: Date.now() - started },
    ...(ranOut
      ? {
          stoppedOn: 'budgetMs',
          skippedLibrary,
          note: 'the library half was incomplete; rerun with a larger budgetMs or name one collection',
        }
      : {}),
    ...(networkFailures
      ? {
          networkFailures,
          networkNote: 'the library service did not answer some lookups; those aliases were not judged or flagged',
        }
      : {}),
  }
}

async function describeExtension(collection: ExtendedVariableCollection) {
  const modeNames = new Map(collection.modes.map((mode) => [mode.modeId, mode.name]))
  const overrides: Array<{ variable: string; mode: string; value: string }> = []
  for (const [variableId, byMode] of Object.entries(collection.variableOverrides ?? {})) {
    const variable = await figma.variables.getVariableByIdAsync(variableId)
    for (const [modeId, value] of Object.entries(byMode)) {
      overrides.push({
        variable: variable?.name ?? variableId,
        mode: modeNames.get(modeId) ?? modeId,
        value: await describeValue(value),
      })
    }
  }
  return {
    id: collection.id,
    name: collection.name,
    parentVariableCollectionId: collection.parentVariableCollectionId,
    rootVariableCollectionId: collection.rootVariableCollectionId,
    modes: collection.modes,
    variables: collection.variableIds.length,
    overrides,
  }
}

export const ADMIN_OPS: readonly OpDef[] = [
  {
    name: 'collections.update',
    summary: 'Rename, hide, edit modes or remove local variable collections as one validated plan.',
    agent:
      'The whole batch is validated before the first write. Default and last modes cannot be removed; destructive mode or collection removal requires force: true and dryRun reports the loss first.',
    mutates: true,
    destructive: true,
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
        const problems: string[] = []
        if (!collection) {
          problems.push('collection disappeared')
        } else {
          if (collection.name !== expectedName) problems.push(`name is "${collection.name}", not "${expectedName}"`)
          if (collection.hiddenFromPublishing !== expectedHidden) problems.push('hiddenFromPublishing did not change')
          for (const step of plan.modes) {
            if (step.kind === 'rename' && !collection.modes.some((mode) => mode.modeId === step.modeId && mode.name === step.after)) {
              problems.push(`mode "${step.after}" is missing after the rename`)
            }
            if (step.kind === 'add' && !collection.modes.some((mode) => mode.name === step.name)) {
              problems.push(`mode "${step.name}" was not added`)
            }
            if (step.kind === 'remove' && collection.modes.some((mode) => mode.modeId === step.modeId)) {
              problems.push(`mode "${step.before}" is still present`)
            }
          }
        }
        return {
          collection: plan.id,
          ok: problems.length === 0,
          after: collection ? { name: collection.name, hiddenFromPublishing: collection.hiddenFromPublishing, modes: collection.modes } : null,
          ...(problems.length ? { problems } : {}),
        }
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
    destructive: true,
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
      const beforeOrder = figma.root.children.map((page) => page.id)
      const pages = new Map(figma.root.children.map((page) => [page.id, page]))
      for (const plan of plans) if (!plan.remove && plan.newName !== undefined) pages.get(plan.id)!.name = plan.newName
      for (const plan of plans) {
        if (!plan.remove) continue
        const page = pages.get(plan.id)!
        if (figma.currentPage.id === page.id) {
          const next = figma.root.children.find(
            (candidate) => candidate.id !== page.id && !plans.some((entry) => entry.remove && entry.id === candidate.id)
          )
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
      const expected = expectedPageOrder(beforeOrder, plans)
      const actual = roster.map((page) => page.id)
      const orderOk = actual.length === expected.length && actual.every((id, index) => id === expected[index])
      const results = plans.map((plan) => {
        const page = roster.find((candidate) => candidate.id === plan.id)
        if (plan.remove) return { page: plan.id, removed: !page, ok: !page }
        const expectedIndex = expected.indexOf(plan.id)
        const ok = Boolean(
          page &&
          (plan.newName === undefined || page.name === plan.newName) &&
          roster.indexOf(page) === expectedIndex
        )
        return { page: plan.id, ok, after: page ? { name: page.name, index: roster.indexOf(page) } : null }
      })
      return {
        dryRun,
        changed: results.filter((row) => row.ok).length,
        failed: results.filter((row) => !row.ok).length + (orderOk ? 0 : 1),
        results,
        ...(orderOk ? {} : { problems: ['final page order does not match the validated plan'] }),
      }
    },
  },
  {
    name: 'variables.extend',
    summary: 'Create, read or edit an Enterprise extended collection and its variable overrides.',
    agent:
      'Enterprise only. Every override row is resolved and validated before the first write. Overrides accept {variable,mode,value}, {variable,mode,remove:true}, or {variable,removeAll:true}.',
    mutates: true,
    params: {
      source: { type: 'string', description: 'Create from this local collection id/name/key or published library collection key.' },
      name: { type: 'string', description: 'Name for a new extended collection; required with source.' },
      collection: { type: 'string', description: 'Existing extended collection id or name to read or edit.' },
      overrides: { type: 'json', default: [], description: 'Override actions for inherited variables.' },
      dryRun: { type: 'boolean', default: false, description: 'Validate every row and report without writing.' },
    },
    async run(params) {
      if (params.source !== undefined && params.collection !== undefined) {
        throw new Error('send source + name to create, or collection to read or edit, not both')
      }
      const creating = params.source !== undefined
      const dryRun = params.dryRun === true
      let source: string | undefined
      let name: string | undefined
      let context: VariableCollection | null
      let extension: ExtendedVariableCollection | null = null

      if (creating) {
        source = text(params.source, 'source')
        name = text(params.name, 'name')
        try {
          context = resolveCollectionFrom(await localCollections(), source, 'source')
        } catch (error) {
          if (source.startsWith('VariableCollectionId:')) {
            context = await resolveCollection(source)
          } else {
            if (!isLibraryKey(source)) throw error
            context = null
          }
        }
        if (context && context.remote) {
          throw new Error(`"${context.name}" is a library collection seen through this file; pass its published key instead`)
        }
      } else {
        context = await resolveCollection(params.collection)
        if (!context.isExtension) throw new Error(`"${context.name}" is not an extended collection`)
        extension = context as unknown as ExtendedVariableCollection
      }

      const rawRows = params.overrides === undefined ? [] : params.overrides
      if (!Array.isArray(rawRows)) throw new Error('overrides must be an array')
      const planned: Array<{
        variable: Variable
        mode?: { modeId: string; name: string }
        action: 'set' | 'remove' | 'removeAll'
        value?: VariableValue
      }> = []
      const report: Array<Record<string, unknown>> = []
      let libraryContext: VariableCollection | null = null
      for (const [index, rawRow] of rawRows.entries()) {
        const where = `overrides[${index}]`
        const row = object(rawRow, where)
        const variableRef = text(row.variable, `${where}.variable`)
        const variable = await resolveVariableRef(variableRef)
        if (!context) {
          libraryContext = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId)
          if (!libraryContext || libraryContext.key !== source) {
            throw new Error(`${where}.variable "${variable.name}" is not in the source library collection`)
          }
          context = libraryContext
        }
        if (!context || !context.variableIds.includes(variable.id)) {
          throw new Error(`${where}.variable "${variable.name}" is not in "${context?.name ?? 'the source collection'}" or its parent`)
        }
        if (row.removeAll === true) {
          if (row.remove === true || row.mode !== undefined || row.value !== undefined) {
            throw new Error(`${where}.removeAll cannot be combined with mode, value or remove`)
          }
          planned.push({ variable, action: 'removeAll' })
          report.push({ op: 'removeAll', variable: variable.name })
          continue
        }
        const mode = resolveMode(context.modes, row.mode, `${where}.mode`)
        if (row.remove === true) {
          if (row.value !== undefined) throw new Error(`${where}.remove cannot be combined with value`)
          planned.push({ variable, mode, action: 'remove' })
          report.push({ op: 'remove', variable: variable.name, mode: mode.name })
          continue
        }
        if (row.value === undefined) throw new Error(`${where} needs value, remove: true or removeAll: true`)
        const value = await coerceVariableValue(variable, row.value)
        planned.push({ variable, mode, action: 'set', value })
        report.push({ op: 'override', variable: variable.name, mode: mode.name, value: await describeValue(value) })
      }

      if (dryRun) {
        return {
          dryRun,
          created: false,
          source: creating ? (context ? { id: context.id, name: context.name } : { key: source }) : undefined,
          name,
          steps: report,
          ...(extension ? { extension: await describeExtension(extension) } : {}),
        }
      }
      if (creating) {
        figma.commitUndo()
        try {
          extension = context && !context.remote
            ? context.extend(name!)
            : await figma.variables.extendLibraryCollectionByKeyAsync(source!, name!)
        } catch (error) {
          const message = errorMessage(error)
          if (/enterprise/i.test(message)) {
            throw new Error(`variables.extend requires an Enterprise Figma plan; nothing was created (${message})`)
          }
          throw error
        }
      } else if (planned.length > 0) {
        figma.commitUndo()
      }
      for (const step of planned) {
        if (step.action === 'removeAll') {
          extension!.removeOverridesForVariable(step.variable)
          continue
        }
        const mode = resolveMode(extension!.modes, step.mode!.name, 'override mode')
        if (step.action === 'remove') step.variable.removeOverrideForMode(mode.modeId)
        else step.variable.setValueForMode(mode.modeId, step.value!)
      }
      const fresh = await figma.variables.getVariableCollectionByIdAsync(extension!.id) as ExtendedVariableCollection | null
      if (!fresh || !fresh.isExtension) throw new Error('extended collection did not appear in the fresh collection roster')
      return { dryRun, created: creating, steps: report, extension: await describeExtension(fresh) }
    },
  },
  {
    name: 'variables.audit',
    summary: 'Audit variable modes for missing values, mixed aliases, broken aliases and forbidden literals.',
    agent:
      'Reads local variables in one batch and follows library aliases by default. Set aliasOnly to semantic collections and ignore to exact names or prefix* patterns. Network failures are reported as unread, never as false broken aliases.',
    mutates: false,
    params: {
      collections: { type: 'string[]', description: 'Collection ids or case-insensitive names. Empty means every local collection.' },
      aliasOnly: { type: 'string[]', default: [], description: 'Collection names or ids whose variables must contain aliases.' },
      ignore: { type: 'string[]', default: [], description: 'Exact variable names or prefix* patterns to omit.' },
      libraries: { type: 'boolean', default: true, description: 'Follow aliases into library collections and audit those collections too.' },
      singleMode: { type: 'boolean', default: false, description: 'Audit single-mode collections instead of skipping them.' },
      budgetMs: { type: 'number', default: 60000, min: 1000, max: 110000, description: 'Maximum time to start library reads.' },
    },
    run: auditVariables,
  },
]
