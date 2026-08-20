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
 * A published collection's color variables, taken from one mode.
 *
 * Alias-valued variables are skipped: a semantic token pointing at a primitive is not a color
 * the new palette offers, it is a second name for one that is already in the list, and
 * entering it twice would let it compete with itself in the family assignment.
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
  let aliased = 0

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

    const value = variable.valuesByMode[modeId]
    if (value === undefined) continue
    if (isAlias(value)) {
      aliased++
      continue
    }
    if (!isRgb(value)) continue
    const color = withAlpha(value)
    entries.push({ hex: hexOf(color), alpha: color.a, name: variable.name })
  }

  const { swatches, duplicates } = swatchesFromNamedColors(entries)
  if (chosenMode) warnings.unshift(`read the "${chosenMode}" mode of that collection`)
  if (aliased > 0) warnings.push(`${aliased} alias-valued token(s) skipped — they point at colors already in the list`)
  if (duplicates > 0) warnings.push(`${duplicates} repeated color(s) were read once`)
  return { swatches, warnings }
}
