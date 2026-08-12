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

export async function readLibraryVariables(): Promise<VariableSnapshot> {
  const collections: CollectionEntry[] = []
  const variables: VariableEntry[] = []

  let libraryCollections: LibraryVariableCollection[]
  try {
    libraryCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()
  } catch {
    return { collections, variables }
  }

  for (const libraryCollection of libraryCollections) {
    try {
      const libraryVariables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(
        libraryCollection.key
      )

      const importedVariables: Variable[] = []
      for (const libraryVariable of libraryVariables) {
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

  return { collections, variables }
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

export async function readAllVariables(): Promise<VariableSnapshot> {
  const [local, library] = await Promise.all([readLocalVariables(), readLibraryVariables()])
  // Folded at the single point every consumer reads through, so a theme split across two
  // collections (Figma's free plan caps a collection at one mode) is invisible downstream.
  return foldSplitThemeCollections(mergeSnapshots(local, library))
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
