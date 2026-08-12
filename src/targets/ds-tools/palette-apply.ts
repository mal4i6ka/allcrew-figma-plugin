/**
 * Writes a generated palette into the Figma document: variables, theme modes, and the
 * swatch board on canvas.
 *
 * Variables are upserted by name, never wiped and recreated. A color collection is the one
 * thing a whole file binds to — dropping and rebuilding it would break every existing binding
 * in the document, so an existing `colors` variable keeps its id and only takes a new value.
 */

import { parseHex } from '../../tokens/color.ts'
import { themeRoles, type Palette, type PaletteWarning, type Spectrum, type Swatch, type ThemeRole } from '../../tokens/palette.ts'
import { darkCompanionName } from '../../tokens/split-theme.ts'

export interface PaletteApplyOptions {
  /** Write the `colors` collection (ramps + Main/Light/Dark aliases). */
  variables: boolean
  /** Write the `theme` collection with Light/Dark modes aliasing into `colors`. */
  theme: boolean
  /** Draw the swatch board on the current page. */
  canvas: boolean
  collectionName: string
  themeCollectionName: string
  /**
   * Store the dark theme in a companion collection rather than a second mode. Set by the
   * warning's fix button when the file's plan refuses a second mode.
   */
  splitDarkTheme: boolean
}

export const DEFAULT_APPLY_OPTIONS: PaletteApplyOptions = {
  variables: true,
  theme: true,
  canvas: true,
  collectionName: 'colors',
  themeCollectionName: 'theme',
  splitDarkTheme: false,
}

export interface PaletteApplyReport {
  collection: string
  created: number
  updated: number
  aliases: number
  themeRoles: number
  /** Where the dark values went — `split` means a companion collection was used. */
  themeLayout: ThemeLayout
  swatches: number
  sectionName: string | null
  warnings: PaletteWarning[]
}

const SECTION_PLUGIN_KEY = 'altery-palette-section'
const SWATCH_COMPONENT_PLUGIN_KEY = 'altery-palette-swatch'

/* ------------------------------------------------------------------ variables */

function createVariable(name: string, collection: VariableCollection, type: VariableResolvedDataType): Variable {
  try {
    return figma.variables.createVariable(name, collection, type)
  } catch {
    // Older plugin API took a collection id rather than the collection itself.
    return figma.variables.createVariable(name, collection.id as never, type)
  }
}

async function findOrCreateCollection(name: string): Promise<{ collection: VariableCollection; existed: boolean }> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync()
  const existing = collections.find((c) => c.name.toLowerCase() === name.toLowerCase())
  if (existing) return { collection: existing, existed: true }
  return { collection: figma.variables.createVariableCollection(name), existed: false }
}

interface VariableWriter {
  upsert(name: string): { variable: Variable; created: boolean }
}

async function variableWriter(collection: VariableCollection): Promise<VariableWriter> {
  const locals = await figma.variables.getLocalVariablesAsync('COLOR')
  const byName = new Map<string, Variable>()
  for (const variable of locals) {
    if (variable.variableCollectionId === collection.id) byName.set(variable.name, variable)
  }

  return {
    upsert(name) {
      const existing = byName.get(name)
      if (existing) return { variable: existing, created: false }
      const variable = createVariable(name, collection, 'COLOR')
      byName.set(name, variable)
      return { variable, created: true }
    },
  }
}

const rgbOf = (hex: string): RGB => {
  const rgb = parseHex(hex)
  return rgb ? { r: rgb.r, g: rgb.g, b: rgb.b } : { r: 0.5, g: 0.5, b: 0.5 }
}

/** `Orange/O500` — group by spectrum label, leaf named prefix + step. */
const variablePath = (spectrum: Spectrum, swatch: Swatch): string => `${spectrum.label}/${swatch.name}`

interface WrittenVariables {
  created: number
  updated: number
  aliases: number
  /** `Orange/O500` → the variable, so the theme collection and canvas can alias/bind it. */
  byPath: Map<string, Variable>
}

async function writeColorVariables(palette: Palette, collectionName: string): Promise<WrittenVariables> {
  const { collection } = await findOrCreateCollection(collectionName)
  const writer = await variableWriter(collection)
  const modeId = collection.defaultModeId

  const result: WrittenVariables = { created: 0, updated: 0, aliases: 0, byPath: new Map() }

  for (const spectrum of palette.spectra) {
    for (const swatch of spectrum.swatches) {
      const path = variablePath(spectrum, swatch)
      const { variable, created } = writer.upsert(path)
      variable.setValueForMode(modeId, rgbOf(swatch.hex))
      result.byPath.set(path, variable)
      if (created) result.created++
      else result.updated++
    }

    // Main/Light/Dark are aliases, not copies: renaming or retuning a step propagates to
    // everything bound to the semantic name.
    const marks: Array<[string, Swatch | undefined]> = [
      ['Main', spectrum.swatches.find((s) => s.isMain)],
      ['Light', spectrum.swatches.find((s) => s.isLight)],
      ['Dark', spectrum.swatches.find((s) => s.isDark)],
    ]
    for (const [markName, swatch] of marks) {
      if (!swatch) continue
      const target = result.byPath.get(variablePath(spectrum, swatch))
      if (!target) continue
      const { variable, created } = writer.upsert(`${spectrum.label}/${markName}`)
      variable.setValueForMode(modeId, figma.variables.createVariableAlias(target))
      if (created) result.created++
      else result.updated++
      result.aliases++
    }
  }

  return result
}

/** How the dark theme ended up stored — the report and the panel both explain it. */
export type ThemeLayout = 'modes' | 'split' | 'light-only'

async function findCollection(name: string): Promise<VariableCollection | null> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync()
  return collections.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null
}

/**
 * Writes the dark half into a companion collection.
 *
 * The free plan caps a collection at one mode, so Light and Dark cannot share one. Two
 * single-mode collections holding the same variable names carry the same information, and
 * `foldSplitThemeCollections` folds them back into one two-mode collection on the way out —
 * the export is byte-identical to a paid-plan file's.
 */
async function writeDarkCompanion(
  themeCollectionName: string,
  roles: ThemeRole[],
  colorsByPath: Map<string, Variable>
): Promise<number> {
  const { collection } = await findOrCreateCollection(darkCompanionName(themeCollectionName))
  const modeId = collection.modes[0].modeId
  try {
    collection.renameMode(modeId, 'Dark')
  } catch {
    /* already named Dark */
  }

  const writer = await variableWriter(collection)
  let written = 0
  for (const role of roles) {
    const dark = colorsByPath.get(role.dark)
    if (!dark) continue
    // Same variable name as in the base collection — that pairing is what the fold matches on.
    const { variable } = writer.upsert(role.name)
    variable.setValueForMode(modeId, figma.variables.createVariableAlias(dark))
    written++
  }
  return written
}

async function writeThemeCollection(
  palette: Palette,
  themeCollectionName: string,
  colorsByPath: Map<string, Variable>,
  splitDarkTheme: boolean
): Promise<{ roles: number; layout: ThemeLayout; warnings: PaletteWarning[] }> {
  const roles = themeRoles(palette)
  if (roles.length === 0) return { roles: 0, layout: 'light-only', warnings: [] }

  const { collection } = await findOrCreateCollection(themeCollectionName)
  const warnings: PaletteWarning[] = []

  // Reuse whatever modes are already there — renaming beats adding duplicates on a re-run.
  let lightModeId = collection.modes[0].modeId
  try {
    collection.renameMode(lightModeId, 'Light')
  } catch {
    /* a mode named Light already exists */
  }

  // Once a companion exists the file is committed to the split layout; going back to modes
  // would leave a stale second collection shadowing the real one.
  const companionExists = (await findCollection(darkCompanionName(themeCollectionName))) !== null
  let split = splitDarkTheme || companionExists

  let darkMode = collection.modes.find((m) => m.name.toLowerCase() === 'dark')
  if (!split && !darkMode) {
    try {
      const darkModeId = collection.addMode('Dark')
      darkMode = { modeId: darkModeId, name: 'Dark' }
    } catch {
      warnings.push({
        message:
          'This file cannot hold a second mode in one collection — that needs a paid Figma plan. ' +
          'Only the Light values were written. The dark theme can live in a linked "' +
          darkCompanionName(themeCollectionName) +
          '" collection instead; the export folds the two back into one Light/Dark stylesheet.',
        fixLabel: 'Create the linked Dark collection',
        fix: { kind: 'split-dark-theme' },
      })
    }
  }
  lightModeId = collection.modes[0].modeId

  const writer = await variableWriter(collection)
  let written = 0
  for (const role of roles) {
    const light = colorsByPath.get(role.light)
    const dark = colorsByPath.get(role.dark)
    if (!light) continue
    const { variable } = writer.upsert(role.name)
    variable.setValueForMode(lightModeId, figma.variables.createVariableAlias(light))
    if (!split && darkMode && dark) {
      variable.setValueForMode(darkMode.modeId, figma.variables.createVariableAlias(dark))
    }
    written++
  }

  if (split) {
    try {
      await writeDarkCompanion(themeCollectionName, roles, colorsByPath)
    } catch (error) {
      split = false
      warnings.push({ message: `The linked Dark collection could not be written: ${String((error as Error)?.message || error)}` })
    }
  }

  const layout: ThemeLayout = split ? 'split' : darkMode ? 'modes' : 'light-only'
  return { roles: written, layout, warnings }
}

/* ------------------------------------------------------------------ canvas */

const SWATCH_WIDTH = 150
const SWATCH_COLOR_HEIGHT = 105
const LABEL_HEIGHT = 20
const MARK_HEIGHT = 20
const ROW_GAP = 72
const SECTION_PADDING = 128
const LABEL_SIZE = 13
const CAPTION_SIZE = 11

interface Fonts {
  body: FontName
}

async function loadFonts(): Promise<Fonts> {
  const candidates: FontName[] = [
    { family: 'Inter', style: 'Regular' },
    { family: 'Roboto', style: 'Regular' },
    { family: 'Helvetica', style: 'Regular' },
  ]
  for (const font of candidates) {
    try {
      await figma.loadFontAsync(font)
      return { body: font }
    } catch {
      /* try the next one */
    }
  }
  const available = await figma.listAvailableFontsAsync()
  const first = available[0]?.fontName
  if (!first) throw new Error('No fonts are available to label the swatches.')
  await figma.loadFontAsync(first)
  return { body: first }
}

const solid = (hex: string): SolidPaint => ({ type: 'SOLID', color: rgbOf(hex) })

function label(text: string, fonts: Fonts, size: number, hex: string): TextNode {
  const node = figma.createText()
  node.fontName = fonts.body
  node.fontSize = size
  node.characters = text
  node.fills = [solid(hex)]
  return node
}

function autoLayout(name: string, direction: 'HORIZONTAL' | 'VERTICAL', gap: number): FrameNode {
  const frame = figma.createFrame()
  frame.name = name
  frame.layoutMode = direction
  frame.itemSpacing = gap
  frame.primaryAxisSizingMode = 'AUTO'
  frame.counterAxisSizingMode = 'AUTO'
  frame.fills = []
  frame.clipsContent = false
  return frame
}

/* ---------------------------------------------------------------- master component */

/** Layer names the instance overrides address. Renaming one breaks reuse of an old master. */
const PART = { color: 'color', step: 'step', hex: 'hex', mark: 'mark', markName: 'markName' }

/**
 * The master every swatch on the board is an instance of.
 *
 * The board is one component with N instances rather than N frames, so the whole system is
 * restyled from a single place — change the label size or the block height on the master and
 * every ramp follows.
 */
function buildSwatchComponent(fonts: Fonts): ComponentNode {
  const component = figma.createComponent()
  component.name = 'Color swatch'
  component.setPluginData(SWATCH_COMPONENT_PLUGIN_KEY, '1')
  component.layoutMode = 'VERTICAL'
  component.itemSpacing = 0
  component.primaryAxisSizingMode = 'FIXED'
  component.counterAxisSizingMode = 'FIXED'
  component.fills = []
  component.clipsContent = false
  component.resize(SWATCH_WIDTH, SWATCH_COLOR_HEIGHT + LABEL_HEIGHT + MARK_HEIGHT)

  const block = figma.createRectangle()
  block.name = PART.color
  block.resize(SWATCH_WIDTH, SWATCH_COLOR_HEIGHT)
  block.fills = [solid('#CCCCCC')]
  component.appendChild(block)

  const labelRow = autoLayout('label', 'HORIZONTAL', 10)
  labelRow.primaryAxisSizingMode = 'FIXED'
  labelRow.counterAxisSizingMode = 'FIXED'
  labelRow.resize(SWATCH_WIDTH, LABEL_HEIGHT)
  labelRow.paddingLeft = 10
  labelRow.counterAxisAlignItems = 'CENTER'

  const step = label('500', fonts, LABEL_SIZE, '#1A1A1A')
  step.name = PART.step
  // Fix the resize mode before resizing — resize() on a WIDTH_AND_HEIGHT text node drops it to NONE.
  step.textAutoResize = 'HEIGHT'
  step.resize(44, LABEL_SIZE * 1.4)
  labelRow.appendChild(step)

  const hex = label('#000000', fonts, LABEL_SIZE, '#1A1A1A')
  hex.name = PART.hex
  labelRow.appendChild(hex)
  component.appendChild(labelRow)

  // Always present, hidden when unmarked: a fixed-height component keeps every strip's labels
  // on one line whether or not the swatch carries a Main/Light/Dark mark.
  const markRow = autoLayout(PART.mark, 'HORIZONTAL', 0)
  markRow.primaryAxisSizingMode = 'FIXED'
  markRow.counterAxisSizingMode = 'FIXED'
  markRow.resize(SWATCH_WIDTH, MARK_HEIGHT)
  markRow.primaryAxisAlignItems = 'CENTER'
  markRow.counterAxisAlignItems = 'CENTER'
  const markText = label('Main', fonts, LABEL_SIZE, '#1A1A1A')
  markText.name = PART.markName
  markRow.appendChild(markText)
  component.appendChild(markRow)

  return component
}

const findPart = (instance: InstanceNode, name: string): SceneNode | null =>
  instance.findOne((node) => node.name === name)

function instantiateSwatch(master: ComponentNode, swatch: Swatch, variable: Variable | undefined): InstanceNode {
  const markName = swatch.isMain ? 'Main' : swatch.isLight ? 'Light' : swatch.isDark ? 'Dark' : null
  const instance = master.createInstance()
  instance.name = `${swatch.name}${markName ? ` · ${markName}` : ''}`

  const block = findPart(instance, PART.color)
  if (block && 'fills' in block) {
    let paint = solid(swatch.hex)
    // Bind the fill so the board stays live: retuning the variable repaints the board.
    if (variable) paint = figma.variables.setBoundVariableForPaint(paint, 'color', variable) as SolidPaint
    block.fills = [paint]
  }

  const step = findPart(instance, PART.step)
  if (step && step.type === 'TEXT') step.characters = String(swatch.step)

  const hex = findPart(instance, PART.hex)
  if (hex && hex.type === 'TEXT') hex.characters = swatch.hex

  const mark = findPart(instance, PART.mark)
  if (mark) mark.visible = markName !== null
  const markText = findPart(instance, PART.markName)
  if (markName && markText && markText.type === 'TEXT') markText.characters = markName

  return instance
}

function buildRow(
  spectrum: Spectrum,
  master: ComponentNode,
  fonts: Fonts,
  colorsByPath: Map<string, Variable>
): FrameNode {
  const row = autoLayout(spectrum.label, 'VERTICAL', 8)

  // Not on the reference board, which only ever showed three rows — but a generated board can
  // hold a dozen spectra, and an unlabelled strip is unreadable at that point.
  row.appendChild(label(`${spectrum.label}  ·  ${spectrum.keyHex}`, fonts, CAPTION_SIZE, '#8A8A8A'))

  const strip = autoLayout('strip', 'HORIZONTAL', 0)
  for (const swatch of spectrum.swatches) {
    strip.appendChild(instantiateSwatch(master, swatch, colorsByPath.get(variablePath(spectrum, swatch))))
  }
  row.appendChild(strip)
  return row
}

/**
 * Reuses the master from a previous run when its structure is still intact.
 *
 * Regenerating must not orphan instances the designer placed elsewhere in the file, so the
 * master is rescued out of the old section before that section is removed, rather than being
 * rebuilt from scratch every run.
 */
async function adoptSwatchComponent(fonts: Fonts): Promise<ComponentNode> {
  const existing = figma.currentPage
    .findAllWithCriteria({ types: ['COMPONENT'] })
    .find((node) => node.getPluginData(SWATCH_COMPONENT_PLUGIN_KEY) === '1')

  if (existing) {
    const intact = [PART.color, PART.step, PART.hex, PART.mark, PART.markName].every(
      (name) => existing.findOne((node) => node.name === name) !== null
    )
    if (intact) {
      // A reused master may have been restyled by hand, so load whatever fonts it uses now —
      // writing characters with an unloaded font throws.
      for (const text of existing.findAllWithCriteria({ types: ['TEXT'] })) {
        if (text.fontName !== figma.mixed) {
          try {
            await figma.loadFontAsync(text.fontName)
          } catch {
            /* the override below is guarded */
          }
        }
      }
      return existing
    }
    existing.remove()
  }

  return buildSwatchComponent(fonts)
}

/** Right of everything already on the page, so a re-run never lands on existing work. */
function placementFor(width: number): { x: number; y: number } {
  const nodes = figma.currentPage.children
  if (nodes.length === 0) {
    const { x, y } = figma.viewport.center
    return { x: x - width / 2, y: y - 200 }
  }
  let right = -Infinity
  let top = Infinity
  for (const node of nodes) {
    right = Math.max(right, node.x + node.width)
    top = Math.min(top, node.y)
  }
  return { x: right + 200, y: top }
}

async function drawBoard(
  palette: Palette,
  colorsByPath: Map<string, Variable>
): Promise<{ section: SectionNode; swatches: number }> {
  const fonts = await loadFonts()

  // Tear the old board down BEFORE building the new one. Every created node is born at the
  // canvas origin, and a section covering that spot adopts it — so removing the old section
  // afterwards would take the half-built board with it, and appendChild would then fail on a
  // node that no longer exists.
  const previous = figma.currentPage
    .findAllWithCriteria({ types: ['SECTION'] })
    .find((node) => node.getPluginData(SECTION_PLUGIN_KEY) === '1')
  const previousBox = previous?.absoluteBoundingBox ?? null
  const previousSpot = previousBox ? { x: previousBox.x, y: previousBox.y } : null

  const master = await adoptSwatchComponent(fonts)
  // Lift the master clear of the doomed section before it goes.
  figma.currentPage.appendChild(master)
  if (previous) previous.remove()

  // Settle the destination before building: the board is parked there as it grows, well away
  // from the origin where a stray section could otherwise swallow it mid-build.
  const widestRamp = palette.spectra.reduce((widest, s) => Math.max(widest, s.swatches.length), 0)
  const spot = previousSpot ?? placementFor(widestRamp * SWATCH_WIDTH + SECTION_PADDING * 2)

  const content = autoLayout('Palettes', 'VERTICAL', ROW_GAP)
  content.x = spot.x + SECTION_PADDING
  content.y = spot.y + SECTION_PADDING

  const masterRow = autoLayout('Master', 'VERTICAL', 8)
  masterRow.appendChild(label('Swatch — master component', fonts, CAPTION_SIZE, '#8A8A8A'))
  masterRow.appendChild(master)
  content.appendChild(masterRow)

  let swatches = 0
  for (const spectrum of palette.spectra) {
    content.appendChild(buildRow(spectrum, master, fonts, colorsByPath))
    swatches += spectrum.swatches.length
  }

  const section = figma.createSection()
  section.name = 'Colors'
  section.fills = [solid('#FFFFFF')]
  section.setPluginData(SECTION_PLUGIN_KEY, '1')

  const width = content.width + SECTION_PADDING * 2
  const height = content.height + SECTION_PADDING * 2

  figma.currentPage.appendChild(section)
  // Move before resizing. A section grows by covering canvas, and whatever it covers it
  // adopts — sized up at the origin it would pull in the designer's own work.
  section.x = spot.x
  section.y = spot.y
  section.resizeWithoutConstraints(width, height)
  section.appendChild(content)

  // A section is not a "container parent" in Figma's transform model (canvases, frames,
  // components and instances are), so its children keep page-absolute coordinates.
  content.x = section.x + SECTION_PADDING
  content.y = section.y + SECTION_PADDING

  // Misplaced content would be invisible rather than obviously broken, so confirm where it
  // actually landed and correct by the observed delta.
  const sectionBox = section.absoluteBoundingBox
  const contentBox = content.absoluteBoundingBox
  if (sectionBox && contentBox) {
    const dx = sectionBox.x + SECTION_PADDING - contentBox.x
    const dy = sectionBox.y + SECTION_PADDING - contentBox.y
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      content.x += dx
      content.y += dy
    }
  }

  return { section, swatches }
}

/* ------------------------------------------------------------------ entry point */

export async function applyPalette(palette: Palette, options: PaletteApplyOptions): Promise<PaletteApplyReport> {
  if (figma.editorType === 'dev') {
    throw new Error("Switch to Design mode — Dev Mode can't create variables or draw on the canvas.")
  }
  if (palette.spectra.length === 0) throw new Error('Add at least one spectrum before generating.')

  // Ramp advisories are already on screen in the panel, carrying their own fix buttons — the
  // report repeats them as plain text so the run's record is self-contained.
  const warnings: PaletteWarning[] = palette.warnings.map((warning) => ({ message: warning.message }))
  for (const spectrum of palette.spectra) {
    for (const warning of spectrum.warnings) warnings.push({ message: `${spectrum.label}: ${warning.message}` })
  }

  let written: WrittenVariables = { created: 0, updated: 0, aliases: 0, byPath: new Map() }
  if (options.variables) written = await writeColorVariables(palette, options.collectionName)

  let roles = 0
  let themeLayout: ThemeLayout = 'light-only'
  if (options.theme) {
    if (!options.variables) {
      warnings.push({ message: 'Theme modes need the colors collection — enable it to generate the theme.' })
    } else {
      const themeResult = await writeThemeCollection(
        palette,
        options.themeCollectionName,
        written.byPath,
        options.splitDarkTheme
      )
      roles = themeResult.roles
      themeLayout = themeResult.layout
      warnings.push(...themeResult.warnings)
    }
  }

  let swatches = 0
  let sectionName: string | null = null
  if (options.canvas) {
    const board = await drawBoard(palette, written.byPath)
    swatches = board.swatches
    sectionName = board.section.name
    figma.currentPage.selection = [board.section]
    figma.viewport.scrollAndZoomIntoView([board.section])
  }

  return {
    collection: options.collectionName,
    created: written.created,
    updated: written.updated,
    aliases: written.aliases,
    themeLayout,
    themeRoles: roles,
    swatches,
    sectionName,
    warnings,
  }
}
