/**
 * New-palette sources that need the document: a swatch board on canvas, and a team library.
 *
 * Both exist because of how designers actually hand a palette over. One sends a `.fig` with
 * the ramps drawn as rectangles, and asking them to retype sixty hexes into a text box would
 * be the tool's fault, not theirs. The other has already published the scheme as a library,
 * which is the richest form it ever takes — names, collections and modes all agreed on.
 *
 * The pure half (the generator's own output, and name parsing) is in tokens/remap/sources.ts;
 * everything here produces the same `ParsedSwatch[]` shape so the planner cannot tell which
 * source it was handed.
 */

import type { ParsedSwatch } from '../../tokens/remap/input.ts'
import { swatchesFromNamedColors } from '../../tokens/remap/sources.ts'
import { findAllWithCriteria, yieldToHost } from '../../utils/tree.ts'
import { hexOf, isGradient, paintsOf, withAlpha } from './remap-inventory.ts'

export interface SourceResult {
  swatches: ParsedSwatch[]
  warnings: string[]
}

/* ------------------------------------------------------------------ canvas */

/**
 * Every solid fill under the selection, in the order the layers sit in.
 *
 * Layer names are read as token names, because a swatch board is almost always labelled the
 * way the tokens will be — a frame called `Violet/500` around a rectangle is a designer
 * telling you the family and the step. Gradient stops count too: a board that shows a ramp as
 * one gradient strip is still showing the ramp.
 */
export async function swatchesFromSelection(): Promise<SourceResult> {
  const selection = figma.currentPage.selection
  if (selection.length === 0) {
    return { swatches: [], warnings: ['nothing is selected — select the swatches, a frame, or a whole board'] }
  }

  const entries: Array<{ hex: string; alpha: number; name: string }> = []
  const collect = (node: SceneNode): void => {
    for (const property of ['fills', 'strokes'] as const) {
      for (const paint of paintsOf(node, property)) {
        if (paint.visible === false) continue
        if (paint.type === 'SOLID') {
          entries.push({ hex: hexOf(paint.color), alpha: paint.opacity ?? 1, name: node.name })
          continue
        }
        if (!isGradient(paint)) continue
        for (const [index, stop] of paint.gradientStops.entries()) {
          const color = withAlpha(stop.color)
          entries.push({ hex: hexOf(color), alpha: color.a, name: `${node.name}/${index + 1}` })
        }
      }
    }
  }

  for (const root of selection) {
    collect(root)
    for (const node of await findAllWithCriteria(root, (node): node is SceneNode => true)) collect(node)
  }

  const { swatches, duplicates } = swatchesFromNamedColors(entries)
  const warnings: string[] = []
  if (swatches.length === 0) warnings.push('the selection holds no solid fills')
  if (duplicates > 0) warnings.push(`${duplicates} repeated color(s) in the selection were read once`)
  return { swatches, warnings }
}

/* ------------------------------------------------------------------ library */

export interface LibraryCollection {
  key: string
  name: string
  library: string
}

/** The library collections this file can see, for the picker. */
export async function listLibraryCollections(): Promise<{ collections: LibraryCollection[]; warnings: string[] }> {
  try {
    const available = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()
    return {
      collections: available.map((collection) => ({
        key: collection.key,
        name: collection.name,
        library: collection.libraryName,
      })),
      warnings: available.length === 0 ? ['no libraries are enabled for this file'] : [],
    }
  } catch (error) {
    // The manifest asks for `teamlibrary`, but a session can still be denied it.
    return { collections: [], warnings: [`libraries are unreadable here: ${String((error as Error).message)}`] }
  }
}

const isAlias = (value: VariableValue): value is VariableAlias =>
  typeof value === 'object' && value !== null && (value as VariableAlias).type === 'VARIABLE_ALIAS'

const isRgb = (value: VariableValue): value is RGB | RGBA =>
  typeof value === 'object' && value !== null && 'r' in value && 'g' in value && 'b' in value

/**
 * Importing a published design system is thousands of round-trips, and doing them without
 * coming up for air is how a plugin gets killed rather than merely slowed — the same reason
 * the linter chunks its own library reads.
 */
const IMPORT_CHUNK = 50

/**
 * Follows an alias chain to the color at its end.
 *
 * Aliases used to be skipped here, on the reasoning that they point at colors already in the
 * list. That is only true when the alias points *inside the collection being read*. A real
 * design system's `neutral/0` can be an alias into a base collection this reader never
 * visits — skip it and the palette has no white at all, at which point every white in the
 * target file "moves" to the lightest gray that made it in. The mapping was blamed; the
 * reader was the thief.
 *
 * The chain is followed with the requested mode where the next variable has it and that
 * variable's own default mode where it does not, and abandoned past a depth no sane token
 * graph reaches.
 */
const ALIAS_DEPTH = 6

async function resolveColor(variable: Variable, modeId: string): Promise<RGB | RGBA | null> {
  let current = variable
  let mode = modeId
  for (let depth = 0; depth < ALIAS_DEPTH; depth++) {
    const value = current.valuesByMode[mode] ?? (await defaultValueOf(current))
    if (value === undefined) return null
    if (isRgb(value)) return value
    if (!isAlias(value)) return null
    const next = await figma.variables.getVariableByIdAsync(value.id).catch(() => null)
    if (!next) return null
    current = next
    if (!(mode in current.valuesByMode)) {
      const collection = await figma.variables
        .getVariableCollectionByIdAsync(current.variableCollectionId)
        .catch(() => null)
      mode = collection?.defaultModeId ?? Object.keys(current.valuesByMode)[0] ?? mode
    }
  }
  return null
}

const defaultValueOf = async (variable: Variable): Promise<VariableValue | undefined> => {
  const collection = await figma.variables
    .getVariableCollectionByIdAsync(variable.variableCollectionId)
    .catch(() => null)
  const mode = collection?.defaultModeId ?? Object.keys(variable.valuesByMode)[0]
  return mode === undefined ? undefined : variable.valuesByMode[mode]
}

/**
 * A published collection's color variables, taken from one mode.
 *
 * Alias-valued variables resolve to the color at the end of their chain — see above for the
 * palette-shaped hole that skipping them leaves. Identical colors still collapse afterwards,
 * so an alias that merely restates a color already in the list costs nothing.
 */
export async function swatchesFromLibrary(
  key: string,
  modeName?: string | null,
  progress?: (label: string) => void
): Promise<SourceResult> {
  const warnings: string[] = []
  let published: LibraryVariable[]
  try {
    published = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(key)
  } catch (error) {
    return { swatches: [], warnings: [`that collection could not be read: ${String((error as Error).message)}`] }
  }

  const colors = published.filter((variable) => variable.resolvedType === 'COLOR')
  if (colors.length === 0) return { swatches: [], warnings: ['that collection holds no color variables'] }

  const entries: Array<{ hex: string; alpha: number; name: string }> = []
  let modeId: string | null = null
  let chosenMode: string | null = null
  let unresolved = 0

  for (const [index, candidate] of colors.entries()) {
    if (index % IMPORT_CHUNK === 0) {
      progress?.(`importing library colors… ${index}/${colors.length}`)
      await yieldToHost()
    }
    const variable = await figma.variables.importVariableByKeyAsync(candidate.key).catch(() => null)
    if (!variable) continue

    if (modeId === null) {
      const collection = await figma.variables
        .getVariableCollectionByIdAsync(variable.variableCollectionId)
        .catch(() => null)
      const modes = collection?.modes ?? []
      const wanted = modeName ? modes.find((mode) => mode.name === modeName) : undefined
      const fallback = modes.find((mode) => mode.modeId === collection?.defaultModeId) ?? modes[0]
      const mode = wanted ?? fallback
      if (!mode) continue
      modeId = mode.modeId
      chosenMode = mode.name
      if (modeName && !wanted) warnings.push(`that library has no "${modeName}" mode — read "${mode.name}" instead`)
    }

    const value = await resolveColor(variable, modeId)
    if (value === null) {
      unresolved++
      continue
    }
    const color = withAlpha(value)
    entries.push({ hex: hexOf(color), alpha: color.a, name: variable.name })
  }

  const { swatches, duplicates } = swatchesFromNamedColors(entries)
  if (chosenMode) warnings.unshift(`read the "${chosenMode}" mode of that collection`)
  if (unresolved > 0) warnings.push(`${unresolved} token(s) could not be resolved to a color and were left out`)
  if (duplicates > 0) warnings.push(`${duplicates} repeated color(s) were read once`)
  return { swatches, warnings }
}
