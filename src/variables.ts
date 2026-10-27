/**
 * Variable reading — reads local + team-library variables into a snapshot
 * the token engine can consume. Ported from allcrew-channel-django src/variables.ts.
 */

import { foldSplitThemeCollections, type CollectionMerge } from './tokens/split-theme.ts'
import { foldExtensions, type ExtensionReading } from './tokens/extensions.ts'

export interface CollectionEntry {
  id: string
  name: string
  defaultModeId: string
  modes: Array<{ modeId: string; name: string }>
  /** Reached only by following an alias out of the file (`readAliasTargets`): its values are
   * substituted into the tokens that point at it, and it is never emitted as the file's own. */
  inlineOnly?: true
}

export interface VariableEntry {
  id: string
  key: string
  name: string
  collectionId: string
  scopes: VariableScope[]
  resolvedType: VariableResolvedDataType
  valuesByMode: { [modeId: string]: VariableValue }
  /** What the designer wrote about this token. Empty for most, and the difference between a
   * token an agent can use correctly and one it can only copy when it is not. */
  description?: string
  /** Omitted when false. True means the token is intentionally excluded from library publishing. */
  hiddenFromPublishing?: true
  /** Per-platform names the design system has already committed to — `WEB`, `ANDROID`, `iOS`.
   * A generator that reads this stops inventing its own. */
  codeSyntax?: Variable['codeSyntax']
}

export interface VariableSnapshot {
  collections: CollectionEntry[]
  variables: VariableEntry[]
}

function toCollectionEntry(collection: VariableCollection): CollectionEntry {
  return {
    id: collection.id,
    name: collection.name,
    defaultModeId: collection.defaultModeId,
    modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })),
  }
}

function toVariableEntry(variable: Variable): VariableEntry {
  return {
    id: variable.id,
    key: variable.key,
    name: variable.name,
    collectionId: variable.variableCollectionId,
    scopes: variable.scopes,
    resolvedType: variable.resolvedType,
    valuesByMode: variable.valuesByMode,
    ...(variable.description ? { description: variable.description } : {}),
    ...(variable.hiddenFromPublishing ? { hiddenFromPublishing: true as const } : {}),
    ...(variable.codeSyntax && Object.keys(variable.codeSyntax).length > 0
      ? { codeSyntax: variable.codeSyntax }
      : {}),
  }
}

export async function readLocalVariables(): Promise<VariableSnapshot> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync()
  const variables = await figma.variables.getLocalVariablesAsync()

  const snapshot: VariableSnapshot = {
    collections: collections.map(toCollectionEntry),
    variables: variables.map(toVariableEntry),
  }
  return foldExtensions(snapshot, await readExtensions(collections))
}

/**
 * What each extended collection says about every variable it inherits. Values come from
 * `valuesByModeForCollectionAsync` — inherited or overridden, the answer Figma renders — and fall
 * back to `variableOverrides` over the parent's own values on a host that predates it. One
 * extension that cannot be read is skipped, not fatal: the rest of the export is still true.
 */
async function readExtensions(collections: readonly VariableCollection[]): Promise<ExtensionReading<VariableEntry>[]> {
  const out: ExtensionReading<VariableEntry>[] = []
  for (const collection of collections) {
    const extension = collection as unknown as ExtendedVariableCollection
    if (extension.isExtension !== true) continue
    try {
      const values: Record<string, Record<string, unknown>> = {}
      const entries: VariableEntry[] = []
      for (const id of extension.variableIds) {
        const variable = await figma.variables.getVariableByIdAsync(id)
        if (!variable) continue
        entries.push(toVariableEntry(variable))
        if (typeof variable.valuesByModeForCollectionAsync === 'function') {
          values[id] = await variable.valuesByModeForCollectionAsync(extension as unknown as VariableCollection)
        } else {
          const own = extension.variableOverrides?.[id] ?? {}
          values[id] = Object.fromEntries(
            extension.modes
              .map((mode) => [mode.modeId, own[mode.modeId] ?? variable.valuesByMode[mode.parentModeId]] as const)
              .filter(([, value]) => value !== undefined)
          )
        }
      }
      out.push({
        id: extension.id,
        name: extension.name,
        rootId: extension.rootVariableCollectionId,
        modes: extension.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name, parentModeId: mode.parentModeId })),
        values,
        variables: entries,
      })
    } catch {
      /* an unreadable extension drops out of the fold; its collection entry is still listed */
    }
  }
  return out
}

function aliasIdsOf(value: unknown, into: string[]): void {
  if (typeof value !== 'object' || value === null) return
  const record = value as { type?: unknown; id?: unknown; color?: unknown; opacity?: unknown }
  if (record.type === 'VARIABLE_ALIAS' && typeof record.id === 'string') into.push(record.id)
  // A composed colour holds its aliases one level down, per channel.
  if ('color' in record) aliasIdsOf(record.color, into)
  if ('opacity' in record) aliasIdsOf(record.opacity, into)
}

/**
 * The variables an alias points at that the read did not return, fetched by id.
 *
 * A file that consumes a library holds its tokens as aliases onto variables it does not own, and
 * the export wrote each unknown target as its raw id - `var(--variableid-73e58…-411-1)`, which
 * resolves to nothing in a browser. Figma already has every variable this file references (that
 * is how the canvas renders), so `getVariableByIdAsync` answers from the file without the
 * team-library service: no network, no enabled-library requirement - the case the "include
 * libraries" sweep cannot reach, since it only sees libraries switched on in this file. Chains are
 * followed until nothing new turns up.
 */
export async function readAliasTargets(known: VariableSnapshot): Promise<VariableSnapshot> {
  const variableIds = new Set(known.variables.map((variable) => variable.id))
  const collectionIds = new Set(known.collections.map((collection) => collection.id))
  const collections: CollectionEntry[] = []
  const variables: VariableEntry[] = []
  let frontier: VariableEntry[] = known.variables

  while (frontier.length > 0) {
    const wanted: string[] = []
    for (const variable of frontier) {
      for (const value of Object.values(variable.valuesByMode)) aliasIdsOf(value, wanted)
    }
    const next: VariableEntry[] = []
    for (const id of wanted) {
      if (variableIds.has(id)) continue
      variableIds.add(id)
      let variable: Variable | null = null
      try {
        variable = await figma.variables.getVariableByIdAsync(id)
      } catch {
        variable = null
      }
      if (!variable) continue
      const entry = toVariableEntry(variable)
      next.push(entry)
      if (!collectionIds.has(entry.collectionId)) {
        collectionIds.add(entry.collectionId)
        let collection: VariableCollection | null = null
        try {
          collection = await figma.variables.getVariableCollectionByIdAsync(entry.collectionId)
        } catch {
          collection = null
        }
        // Without its collection a variable has no mode names; its own mode keys still let the
        // engine resolve the value, which is all an inlined primitive needs.
        const modeIds = Object.keys(entry.valuesByMode)
        collections.push({
          ...(collection
            ? toCollectionEntry(collection)
            : {
                id: entry.collectionId,
                name: 'Library',
                defaultModeId: modeIds[0] ?? '',
                modes: modeIds.map((modeId, index) => ({ modeId, name: index === 0 ? 'Value' : modeId })),
              }),
          inlineOnly: true,
        })
      }
    }
    variables.push(...next)
    frontier = next
  }

  return { collections, variables }
}

/**
 * How much of the library sweep one call may do, and where a previous one stopped.
 *
 * Every library variable is a separate round trip to Figma's team-library service. Measured on a
 * real file: 213 of them took 48 seconds on a good afternoon and ran past 400 on a bad one - so
 * a sweep with no ceiling is a call that sometimes finishes and sometimes dies, and the token
 * sync downstream inherits both moods. With a budget it always comes back, and says where to
 * resume; with `collection` it imports one collection instead of every enabled library, which is
 * what a caller after one palette actually wanted.
 */
export interface LibraryReadOptions {
  /** Import only this collection, by name or by key. The filter runs BEFORE the network work,
   * which is the whole point - filtering the result afterwards still pays for everything. */
  readonly collection?: string
  /** Stop importing after this long and hand back what was read. */
  readonly budgetMs?: number
  /** Skip this many variables of the (flattened, ordered) sweep - the `nextOffset` of the call
   * before. */
  readonly offset?: number
  /** Explicit single-mode collections grouped into exported theme structures. */
  readonly collectionMerges?: readonly CollectionMerge[]
  /** Called once the sweep's size is known and again after every import - the only sign of life
   * a panel gets during a read that runs for a minute and more. `total` counts the whole sweep,
   * so `done` starts at the offset when one was passed. */
  readonly onProgress?: (done: number, total: number) => void
}

export interface LibraryReadProgress {
  /** Variables imported so far across the whole sweep, or absent when it finished. */
  readonly nextOffset?: number
  /** Why it stopped short, when it did. */
  readonly stoppedOn?: 'budgetMs'
}

export async function readLibraryVariables(options: LibraryReadOptions = {}): Promise<VariableSnapshot & LibraryReadProgress> {
  const collections: CollectionEntry[] = []
  const variables: VariableEntry[] = []
  const wanted = options.collection?.trim().toLowerCase()
  const deadline = options.budgetMs === undefined ? Infinity : Date.now() + options.budgetMs
  const skip = Math.max(0, options.offset ?? 0)
  let seen = 0
  let ranOut = false

  let libraryCollections: LibraryVariableCollection[]
  try {
    libraryCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()
  } catch {
    return { collections, variables }
  }

  // Listed up front - one cheap call per collection - so the sweep knows its size before the slow
  // part starts and progress can be reported as N of M rather than as a count with no end.
  const listed: { libraryCollection: LibraryVariableCollection; libraryVariables: LibraryVariable[] }[] = []
  for (const libraryCollection of libraryCollections) {
    if (wanted && libraryCollection.name.toLowerCase() !== wanted && libraryCollection.key !== options.collection) {
      continue
    }
    try {
      listed.push({
        libraryCollection,
        libraryVariables: await figma.teamLibrary.getVariablesInLibraryCollectionAsync(libraryCollection.key),
      })
    } catch (error) {
      console.error(`Failed to list library collection "${libraryCollection.name}"`, error)
    }
  }
  const total = listed.reduce((sum, entry) => sum + entry.libraryVariables.length, 0)
  options.onProgress?.(Math.min(skip, total), total)

  for (const { libraryCollection, libraryVariables } of listed) {
    if (ranOut) break
    try {
      const importedVariables: Variable[] = []
      for (const libraryVariable of libraryVariables) {
        // Counted before the skip so `nextOffset` means the same thing on every page: how many
        // variables of this sweep are behind us, not how many this call imported.
        seen += 1
        if (seen <= skip) continue
        if (Date.now() > deadline) {
          ranOut = true
          seen -= 1
          break
        }
        importedVariables.push(await figma.variables.importVariableByKeyAsync(libraryVariable.key))
        options.onProgress?.(seen, total)
      }

      if (importedVariables.length === 0) continue

      const collectionId = importedVariables[0].variableCollectionId
      const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId)

      collections.push(
        collection
          ? toCollectionEntry(collection)
          : { id: collectionId, name: libraryCollection.name, defaultModeId: '', modes: [] }
      )
      variables.push(...importedVariables.map(toVariableEntry))
    } catch (error) {
      console.error(`Failed to read library collection "${libraryCollection.name}"`, error)
    }
  }

  return {
    collections,
    variables,
    ...(ranOut ? { nextOffset: seen, stoppedOn: 'budgetMs' as const } : {}),
  }
}

function mergeSnapshots(a: VariableSnapshot, b: VariableSnapshot): VariableSnapshot {
  const collectionsById = new Map<string, CollectionEntry>()
  for (const collection of [...a.collections, ...b.collections]) {
    collectionsById.set(collection.id, collection)
  }

  const variablesById = new Map<string, VariableEntry>()
  for (const variable of [...a.variables, ...b.variables]) {
    variablesById.set(variable.id, variable)
  }

  return {
    collections: [...collectionsById.values()],
    variables: [...variablesById.values()],
  }
}

export async function readAllVariables(options: LibraryReadOptions = {}): Promise<VariableSnapshot & LibraryReadProgress> {
  const [local, library] = await Promise.all([readLocalVariables(), readLibraryVariables(options)])
  // Folded at the single point every consumer reads through, so a theme split across two
  // collections (Figma's free plan caps a collection at one mode) is invisible downstream.
  const merged = foldSplitThemeCollections(mergeSnapshots(local, library), options.collectionMerges)
  return {
    ...merged,
    ...(library.nextOffset === undefined ? {} : { nextOffset: library.nextOffset }),
    ...(library.stoppedOn === undefined ? {} : { stoppedOn: library.stoppedOn }),
  }
}

export interface ResolvedVariableValue {
  value: VariableValue
  resolvedType: VariableResolvedDataType
}

function isVariableAlias(value: unknown): value is VariableAlias {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'VARIABLE_ALIAS'
}

function isVariableComposedColor(value: unknown): value is VariableComposedColor {
  if (typeof value !== 'object' || value === null || !('color' in value) || !('opacity' in value)) return false
  const composed = value as { color: unknown; opacity: unknown }
  return isVariableAlias(composed.color) || isVariableAlias(composed.opacity)
}

export async function resolveVariableValue(
  variable: Variable,
  modeId: string,
  visited: Set<string> = new Set()
): Promise<ResolvedVariableValue> {
  if (visited.has(variable.id)) {
    throw new Error(`Circular variable alias detected at "${variable.name}" (${variable.id})`)
  }
  visited.add(variable.id)

  let value = variable.valuesByMode[modeId]

  if (value === undefined) {
    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId)
    if (!collection) {
      throw new Error(`Variable collection not found for "${variable.name}" (${variable.variableCollectionId})`)
    }
    value = variable.valuesByMode[collection.defaultModeId]
  }

  if (isVariableAlias(value)) {
    const target = await figma.variables.getVariableByIdAsync(value.id)
    if (!target) throw new Error(`Broken alias: ${value.id}`)
    return resolveVariableValue(target, modeId, visited)
  }

  if (isVariableComposedColor(value)) {
    let color: RGB | RGBA
    if (isVariableAlias(value.color)) {
      const target = await figma.variables.getVariableByIdAsync(value.color.id)
      if (!target) throw new Error(`Broken composed color alias: ${value.color.id}`)
      const resolved = await resolveVariableValue(target, modeId, new Set(visited))
      if (typeof resolved.value !== 'object' || resolved.value === null || !('r' in resolved.value)) {
        throw new Error(`Composed color alias "${target.name}" did not resolve to a color`)
      }
      color = resolved.value as RGB | RGBA
    } else {
      color = value.color
    }

    let opacity: number
    if (isVariableAlias(value.opacity)) {
      const target = await figma.variables.getVariableByIdAsync(value.opacity.id)
      if (!target) throw new Error(`Broken composed opacity alias: ${value.opacity.id}`)
      const resolved = await resolveVariableValue(target, modeId, new Set(visited))
      if (typeof resolved.value !== 'number') {
        throw new Error(`Composed opacity alias "${target.name}" did not resolve to a number`)
      }
      opacity = resolved.value
    } else {
      opacity = value.opacity
    }
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) {
      throw new Error(`Composed opacity must be between 0% and 100% — got ${opacity}%`)
    }
    const baseAlpha = 'a' in color ? color.a : 1
    return {
      value: { r: color.r, g: color.g, b: color.b, a: baseAlpha * (opacity / 100) },
      resolvedType: 'COLOR',
    }
  }

  return { value, resolvedType: variable.resolvedType }
}

async function resolveModeForCollection(
  collectionId: string,
  consumer: SceneNode
): Promise<string | undefined> {
  const resolved = (consumer as SceneNode & { resolvedVariableModes?: { [collectionId: string]: string } })
    .resolvedVariableModes?.[collectionId]
  if (resolved) return resolved

  let node: BaseNode | null = consumer
  while (node) {
    const explicit = (node as ExplicitVariableModesMixin).explicitVariableModes?.[collectionId]
    if (explicit) return explicit
    node = 'parent' in node ? node.parent : null
  }
  return undefined
}

export async function resolveForConsumer(
  variable: Variable,
  consumer: SceneNode
): Promise<ResolvedVariableValue> {
  const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId)
  if (!collection) {
    throw new Error(`Variable collection not found for "${variable.name}" (${variable.variableCollectionId})`)
  }

  const modeId = (await resolveModeForCollection(collection.id, consumer)) ?? collection.defaultModeId
  return resolveVariableValue(variable, modeId)
}
