/**
 * Folds several single-mode Figma collections into logical multi-mode collections.
 *
 * Figma's free plan caps a variable collection at one mode. A designer can therefore map
 * `theme-light`, `theme-dark`, `theme-contrast`, … into one exported `Theme` collection without
 * changing how the file is organised. Conventional `theme` + `theme-dark` and
 * `theme-light` + `theme-dark` layouts are still detected automatically.
 */

export interface SplitThemeCollection {
  id: string
  name: string
  defaultModeId: string
  modes: Array<{ modeId: string; name: string }>
}

export interface SplitThemeVariable {
  id: string
  name: string
  collectionId: string
  valuesByMode: { [modeId: string]: unknown }
}

export interface SplitThemeSnapshot {
  collections: SplitThemeCollection[]
  variables: SplitThemeVariable[]
}

export interface SingleModeCollectionState {
  collections: Array<{ name: string; mode: string }>
  singleModeOnly: boolean
}

/** Observable capability used by the settings UI. Figma exposes collection modes but not the
 * account's plan name, so the workaround is shown only when every existing collection has at
 * most one mode. */
export function singleModeCollectionState(
  collections: readonly SplitThemeCollection[]
): SingleModeCollectionState {
  return {
    collections: collections
      .filter((collection) => collection.modes.length === 1)
      .map((collection) => ({ name: collection.name, mode: collection.modes[0]?.name || 'Mode 1' })),
    singleModeOnly: collections.length > 0 && collections.every((collection) => collection.modes.length <= 1),
  }
}

export interface CollectionMergeMode {
  collection: string
  name: string
}

export interface CollectionMerge {
  /** Logical collection name exposed to exporters. */
  name: string
  /** Ordered source collections. The first one supplies the default mode. */
  modes: CollectionMergeMode[]
}

const DARK_COMPANION = /^(.+?)[ _-]dark$/i
const LIGHT_COLLECTION = /^(.+?)[ _-]light$/i
const BREAKPOINTS = 'breakpoints'
const BREAKPOINT_COMPANION = /^breakpoints[ _-](.+)$/i
const GENERIC_MODE_NAMES = ['mode 1', 'mode', 'value', 'default']
const normalize = (name: string): string => name.trim().toLowerCase()
const isGenericModeName = (name: string): boolean =>
  name === '' || GENERIC_MODE_NAMES.indexOf(name.toLowerCase()) !== -1

function defaultModeNameOf(collection: SplitThemeCollection, fallback: string): string {
  const mode = collection.modes.find((entry) => entry.modeId === collection.defaultModeId) ?? collection.modes[0]
  const name = mode?.name?.trim() ?? ''
  return isGenericModeName(name) ? fallback : name
}

/** Legacy text-field parser, retained only to migrate already-saved settings. */
export function parseCollectionMerges(value: string): CollectionMerge[] {
  const merges: CollectionMerge[] = []
  const seen = new Set<string>()
  for (const row of value.split(/[;\n]+/)) {
    const match = /^\s*(.+?)\s*=\s*(.+?)\s*\+\s*(.+?)\s*$/.exec(row)
    if (!match) continue
    const name = match[1].trim()
    const light = match[2].trim()
    const dark = match[3].trim()
    if (!name || !light || !dark || normalize(light) === normalize(dark)) continue
    const key = `${normalize(light)}\u0000${normalize(dark)}`
    if (seen.has(key)) continue
    seen.add(key)
    merges.push({
      name,
      modes: [
        { collection: light, name: 'Light' },
        { collection: dark, name: 'Dark' },
      ],
    })
  }
  return merges
}

function variableNamesByCollection(snapshot: SplitThemeSnapshot): Map<string, Set<string>> {
  const namesByCollection = new Map<string, Set<string>>()
  for (const variable of snapshot.variables) {
    let names = namesByCollection.get(variable.collectionId)
    if (!names) {
      names = new Set<string>()
      namesByCollection.set(variable.collectionId, names)
    }
    names.add(variable.name)
  }
  return namesByCollection
}

function collectionsOverlap(
  a: SplitThemeCollection,
  b: SplitThemeCollection,
  namesByCollection: Map<string, Set<string>>
): boolean {
  const aNames = namesByCollection.get(a.id)
  const bNames = namesByCollection.get(b.id)
  if (!aNames || !bNames) return false
  for (const name of bNames) if (aNames.has(name)) return true
  return false
}

interface ResolvedMerge {
  name: string
  modes: Array<{ collection: SplitThemeCollection; name: string; modeId: string }>
}

function resolveConfiguredMerges(
  snapshot: SplitThemeSnapshot,
  configured: readonly CollectionMerge[],
  used: Set<string>
): ResolvedMerge[] {
  const byName = new Map(snapshot.collections.map((collection) => [normalize(collection.name), collection]))
  const namesByCollection = variableNamesByCollection(snapshot)
  const resolved: ResolvedMerge[] = []

  for (const merge of configured) {
    const outputName = merge.name.trim()
    if (!outputName || merge.modes.length < 2) continue
    const modeNames = new Set<string>()
    const members: ResolvedMerge['modes'] = []
    let invalid = false
    for (const mode of merge.modes) {
      const collection = byName.get(normalize(mode.collection))
      const modeName = mode.name.trim()
      const modeId = collection?.defaultModeId || collection?.modes[0]?.modeId
      if (!collection || !modeName || !modeId || used.has(collection.id) || modeNames.has(normalize(modeName))) {
        invalid = true
        break
      }
      modeNames.add(normalize(modeName))
      members.push({ collection, name: modeName, modeId })
    }
    if (invalid || members.length < 2) continue
    if (members.slice(1).some((member) => !collectionsOverlap(members[0].collection, member.collection, namesByCollection))) {
      continue
    }
    const outputOwner = byName.get(normalize(outputName))
    if (outputOwner && !members.some((member) => member.collection.id === outputOwner.id)) continue

    resolved.push({ name: outputName, modes: members })
    for (const member of members) used.add(member.collection.id)
  }
  return resolved
}

function automaticMerges(snapshot: SplitThemeSnapshot, used: Set<string>): ResolvedMerge[] {
  const byName = new Map(snapshot.collections.map((collection) => [normalize(collection.name), collection]))
  const namesByCollection = variableNamesByCollection(snapshot)
  const resolved: ResolvedMerge[] = []

  const add = (name: string, light: SplitThemeCollection | undefined, dark: SplitThemeCollection | undefined): void => {
    if (!light || !dark || light.id === dark.id || used.has(light.id) || used.has(dark.id)) return
    if (!collectionsOverlap(light, dark, namesByCollection)) return
    const lightModeId = light.defaultModeId || light.modes[0]?.modeId
    const darkModeId = dark.defaultModeId || dark.modes[0]?.modeId
    if (!lightModeId || !darkModeId) return
    resolved.push({
      name,
      modes: [
        { collection: light, name: defaultModeNameOf(light, 'Light'), modeId: lightModeId },
        { collection: dark, name: defaultModeNameOf(dark, 'Dark'), modeId: darkModeId },
      ],
    })
    used.add(light.id)
    used.add(dark.id)
  }

  // Common free-plan layout: `theme-light` + `theme-dark` → `theme`.
  for (const light of snapshot.collections) {
    const match = LIGHT_COLLECTION.exec(light.name.trim())
    if (!match) continue
    add(match[1], light, byName.get(normalize(`${match[1]}-dark`)))
  }

  // DS Tools layout: `theme` + `theme-dark` → `theme`.
  for (const dark of snapshot.collections) {
    const match = DARK_COMPANION.exec(dark.name.trim())
    if (!match) continue
    add(match[1], byName.get(normalize(match[1])), dark)
  }

  // Breakpoint generator on a single-mode plan: `Breakpoints` holds the first step and each
  // further step lives in `Breakpoints-<step>` with the same variables → one `Breakpoints`
  // collection with a mode per step, exactly what a paid-plan generator writes.
  for (const base of snapshot.collections) {
    if (normalize(base.name) !== BREAKPOINTS || used.has(base.id)) continue
    const baseModeId = base.defaultModeId || base.modes[0]?.modeId
    if (!baseModeId) continue
    const modes: ResolvedMerge['modes'] = [{ collection: base, name: defaultModeNameOf(base, 'Desktop'), modeId: baseModeId }]
    const seen = new Set([normalize(modes[0].name)])
    for (const companion of snapshot.collections) {
      const match = BREAKPOINT_COMPANION.exec(companion.name.trim())
      if (!match || used.has(companion.id) || !collectionsOverlap(base, companion, namesByCollection)) continue
      const modeId = companion.defaultModeId || companion.modes[0]?.modeId
      const name = defaultModeNameOf(companion, match[1].trim())
      if (!modeId || seen.has(normalize(name))) continue
      seen.add(normalize(name))
      modes.push({ collection: companion, name, modeId })
    }
    if (modes.length < 2) continue
    resolved.push({ name: base.name, modes })
    for (const mode of modes) used.add(mode.collection.id)
  }
  return resolved
}

export function collectionMergeProblems(
  snapshot: SplitThemeSnapshot,
  configured: readonly CollectionMerge[]
): string[] {
  const byName = new Map(snapshot.collections.map((collection) => [normalize(collection.name), collection]))
  const namesByCollection = variableNamesByCollection(snapshot)
  const problems: string[] = []
  for (const merge of configured) {
    if (!merge.name.trim()) problems.push('A theme structure has no output name.')
    if (merge.modes.length < 2) problems.push(`"${merge.name || 'Unnamed'}" needs at least two theme rows.`)
    const seenModes = new Set<string>()
    for (const mode of merge.modes) {
      const collection = byName.get(normalize(mode.collection))
      if (!collection) problems.push(`"${merge.name}": collection "${mode.collection}" was not found.`)
      if (!mode.name.trim()) problems.push(`"${merge.name}": collection "${mode.collection}" has no theme name.`)
      else if (seenModes.has(normalize(mode.name))) problems.push(`"${merge.name}": theme "${mode.name}" is duplicated.`)
      seenModes.add(normalize(mode.name))
    }
    const collections = merge.modes
      .map((mode) => byName.get(normalize(mode.collection)))
      .filter((collection): collection is SplitThemeCollection => Boolean(collection))
    if (collections.length >= 2 && collections.slice(1).some((collection) => !collectionsOverlap(collections[0], collection, namesByCollection))) {
      problems.push(`"${merge.name}": its collections share no variable names.`)
    }
  }
  return [...new Set(problems)]
}

export function foldSplitThemeCollections<
  S extends { collections: SplitThemeCollection[]; variables: SplitThemeVariable[] },
>(snapshot: S, configured: readonly CollectionMerge[] = []): S {
  const used = new Set<string>()
  const merges = [
    ...resolveConfiguredMerges(snapshot, configured, used),
    ...automaticMerges(snapshot, used),
  ]
  if (merges.length === 0) return snapshot

  const memberIds = new Set(merges.flatMap((merge) => merge.modes.map((mode) => mode.collection.id)))
  const mergeByMemberId = new Map<string, ResolvedMerge>()
  for (const merge of merges) for (const mode of merge.modes) mergeByMemberId.set(mode.collection.id, merge)

  const collections = snapshot.collections
    .filter((collection) => {
      const merge = mergeByMemberId.get(collection.id)
      return !merge || merge.modes[0].collection.id === collection.id
    })
    .map((collection) => {
      const merge = mergeByMemberId.get(collection.id)
      if (!merge) return collection
      return {
        ...collection,
        name: merge.name,
        defaultModeId: merge.modes[0].modeId,
        modes: merge.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })),
      }
    })

  const variablesOutsideMerges = snapshot.variables.filter((variable) => !memberIds.has(variable.collectionId))
  const mergedVariables: SplitThemeVariable[] = []
  for (const merge of merges) {
    const byVariableName = new Map<string, SplitThemeVariable[]>()
    for (const variable of snapshot.variables) {
      if (!mergeByMemberId.has(variable.collectionId) || mergeByMemberId.get(variable.collectionId) !== merge) continue
      const entries = byVariableName.get(variable.name) ?? []
      entries.push(variable)
      byVariableName.set(variable.name, entries)
    }
    for (const entries of byVariableName.values()) {
      const base = entries.find((variable) => variable.collectionId === merge.modes[0].collection.id) ?? entries[0]
      const valuesByMode: Record<string, unknown> = {}
      for (const mode of merge.modes) {
        const source = entries.find((variable) => variable.collectionId === mode.collection.id)
        if (!source) continue
        const value = source.valuesByMode[mode.modeId] ?? Object.values(source.valuesByMode)[0]
        if (value !== undefined) valuesByMode[mode.modeId] = value
      }
      mergedVariables.push({ ...base, collectionId: merge.modes[0].collection.id, valuesByMode })
    }
  }

  return { ...snapshot, collections, variables: [...variablesOutsideMerges, ...mergedVariables] }
}

export const darkCompanionName = (themeCollectionName: string): string => `${themeCollectionName.trim()}-dark`

/** Where the generator puts one breakpoint step when the plan allows a single mode. */
export const breakpointCompanionName = (step: string): string => `Breakpoints-${step.trim()}`

export function isDarkCompanionOf(name: string, base: string): boolean {
  const match = DARK_COMPANION.exec(name.trim())
  return match !== null && normalize(match[1]) === normalize(base)
}
