/**
 * Variable reading — reads local + team-library variables into a snapshot
 * the token engine can consume. Ported from altery-figma-django src/variables.ts.
 */

import { foldSplitThemeCollections } from './tokens/split-theme.ts'

export interface CollectionEntry {
  id: string
  name: string
  defaultModeId: string
  modes: Array<{ modeId: string; name: string }>
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
    ...(variable.codeSyntax && Object.keys(variable.codeSyntax).length > 0
      ? { codeSyntax: variable.codeSyntax }
      : {}),
  }
}

export async function readLocalVariables(): Promise<VariableSnapshot> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync()
  const variables = await figma.variables.getLocalVariablesAsync()

  return {
    collections: collections.map(toCollectionEntry),
    variables: variables.map(toVariableEntry),
  }
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

  for (const libraryCollection of libraryCollections) {
    if (ranOut) break
    if (wanted && libraryCollection.name.toLowerCase() !== wanted && libraryCollection.key !== options.collection) {
      continue
    }
    try {
      const libraryVariables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(
        libraryCollection.key
      )

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
  const merged = foldSplitThemeCollections(mergeSnapshots(local, library))
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

function isVariableAlias(value: VariableValue | undefined): value is VariableAlias {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'VARIABLE_ALIAS'
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
