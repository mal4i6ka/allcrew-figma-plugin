/**
 * Extended variable collections (plugin API 1.121–1.122), folded into what the exporters read.
 *
 * An extension is a brand or product variant of a collection: it inherits every variable of its
 * parent and overrides some of them, per mode of its own. The variables still belong to the root
 * — `variableCollectionId` names the root — so a snapshot read the ordinary way held the
 * extension as a collection with modes and no variables, and every exporter emitted nothing for
 * it. A whole brand disappeared from the token package without a word.
 *
 * In code a brand variant IS a theme of the same tokens, so when the root is in the snapshot the
 * extension's modes become more modes of the root — "Brand B Light", "Brand B Dark" — and the
 * engine's theme machinery does the rest. When the root is a library this file does not own, the
 * extension stands as its own collection, carrying the variables it inherits.
 */

export interface FoldableCollection {
  id: string
  name: string
  defaultModeId: string
  modes: Array<{ modeId: string; name: string }>
}

export interface FoldableVariable {
  id: string
  name: string
  collectionId: string
  valuesByMode: { [modeId: string]: unknown }
}

export interface ExtensionReading<V extends FoldableVariable = FoldableVariable> {
  id: string
  name: string
  /** The collection the variables actually belong to — the end of the extension chain. */
  rootId: string
  modes: Array<{ modeId: string; name: string; parentModeId: string }>
  /** Variable id → its value in each of this extension's modes, inherited or overridden. */
  values: Record<string, Record<string, unknown>>
  /** The inherited variables as entries, for when the root is not in the snapshot to carry them. */
  variables: V[]
}

export function foldExtensions<
  C extends FoldableCollection,
  V extends FoldableVariable,
  S extends { collections: C[]; variables: V[] },
>(snapshot: S, extensions: readonly ExtensionReading<V>[]): S {
  if (extensions.length === 0) return snapshot
  const extensionIds = new Set(extensions.map((extension) => extension.id))
  let collections = snapshot.collections.filter((collection) => !extensionIds.has(collection.id))
  let variables = snapshot.variables
  const added: V[] = []

  for (const extension of extensions) {
    if (extension.modes.length === 0) continue
    const root = collections.find((collection) => collection.id === extension.rootId)
    if (!root) {
      // A library root: the extension is the only place these values live in this file.
      collections = [
        ...collections,
        {
          id: extension.id,
          name: extension.name,
          defaultModeId: extension.modes[0].modeId,
          modes: extension.modes.map(({ modeId, name }) => ({ modeId, name })),
        } as C,
      ]
      for (const variable of extension.variables) {
        const values = extension.values[variable.id]
        if (!values || Object.keys(values).length === 0) continue
        added.push({ ...variable, collectionId: extension.id, valuesByMode: { ...values } })
      }
      continue
    }

    // One mode in the root means the extension's single mode is the brand itself; with several,
    // "Brand B" alone would not say which of Light and Dark it is.
    const single = root.modes.length === 1
    const modes = extension.modes.map(({ modeId, name }) => ({
      modeId,
      name: single ? extension.name : `${extension.name} ${name}`,
    }))
    collections = collections.map((collection) =>
      collection.id === root.id ? ({ ...collection, modes: [...collection.modes, ...modes] } as C) : collection
    )
    variables = variables.map((variable) => {
      if (variable.collectionId !== root.id) return variable
      const values = extension.values[variable.id] ?? {}
      const valuesByMode = { ...variable.valuesByMode }
      for (const mode of extension.modes) {
        // Inherited when the read had nothing for it: the parent mode's value is what Figma
        // renders, so it is what the theme has to say.
        const value = values[mode.modeId] ?? variable.valuesByMode[mode.parentModeId]
        if (value !== undefined) valuesByMode[mode.modeId] = value
      }
      return { ...variable, valuesByMode }
    })
  }

  return { ...snapshot, collections, variables: [...variables, ...added] }
}
