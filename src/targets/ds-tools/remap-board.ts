/**
 * The remap drawn on canvas: old above, new below, one pair per token.
 *
 * The table in the panel is where a mapping is edited; this is where it is *shown to someone
 * else*. A designer approving a palette move wants to see the ramps side by side at size, and
 * wants the comparison to stay in the file afterwards as the record of what happened — a
 * panel closes, a section does not.
 *
 * Only rows that actually move are drawn. A board padded with unchanged swatches reads as a
 * bigger change than it was.
 */

import { contrastRatio, parseHex } from '../../tokens/color.ts'
import { toHex } from '../../tokens/remap/color-literal.ts'
import type { RemapEntry, RemapPlan } from '../../tokens/remap/plan.ts'

const SECTION_KEY = 'altery-remap-board'
const SECTION_NAME = 'Color remap'

const SWATCH_WIDTH = 96
const SWATCH_HEIGHT = 46
const CAPTION_SIZE = 9
const LABEL_SIZE = 11
const ROW_GAP = 22
const PADDING = 48

/** Rows beyond this are summarised rather than drawn — a board nobody can scan is not a board. */
const MAX_ROWS_PER_FAMILY = 24

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
  if (!first) throw new Error('No fonts are available to label the board.')
  await figma.loadFontAsync(first)
  return { body: first }
}

const rgbOf = (hex: string): RGB => {
  const rgb = parseHex(hex)
  return rgb ? { r: rgb.r, g: rgb.g, b: rgb.b } : { r: 0.5, g: 0.5, b: 0.5 }
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

/** Black or white, whichever stays legible on this swatch. */
const inkOn = (color: { r: number; g: number; b: number }): string =>
  contrastRatio(color, { r: 0, g: 0, b: 0 }) >= contrastRatio(color, { r: 1, g: 1, b: 1 }) ? '#000000' : '#FFFFFF'

function block(color: { r: number; g: number; b: number; a: number }, caption: string, fonts: Fonts): FrameNode {
  const frame = autoLayout('swatch', 'VERTICAL', 0)
  frame.primaryAxisSizingMode = 'FIXED'
  frame.counterAxisSizingMode = 'FIXED'
  frame.resize(SWATCH_WIDTH, SWATCH_HEIGHT)
  frame.fills = [{ type: 'SOLID', color: { r: color.r, g: color.g, b: color.b }, opacity: color.a }]
  frame.paddingLeft = 8
  frame.paddingTop = 7
  frame.primaryAxisAlignItems = 'MIN'

  const hex = toHex(color)
  frame.appendChild(label(hex, fonts, CAPTION_SIZE, inkOn(color)))
  if (caption !== '') frame.appendChild(label(caption, fonts, CAPTION_SIZE, inkOn(color)))
  return frame
}

/**
 * The left-hand gutter naming the two rows.
 *
 * "old above, new below" in the heading is a caption someone reads once and then loses while
 * scrolling through a hundred swatches; the pair only reads unambiguously if the axis is
 * labelled where the eye already is.
 */
function gutter(fonts: Fonts): FrameNode {
  const column = autoLayout('legend', 'VERTICAL', 3)
  for (const text of ['old', 'new']) {
    const cell = autoLayout(text, 'VERTICAL', 0)
    cell.primaryAxisSizingMode = 'FIXED'
    cell.counterAxisSizingMode = 'FIXED'
    cell.resize(34, SWATCH_HEIGHT)
    cell.primaryAxisAlignItems = 'CENTER'
    cell.counterAxisAlignItems = 'MAX'
    cell.paddingRight = 8
    cell.appendChild(label(text, fonts, CAPTION_SIZE, '#8A8A8A'))
    column.appendChild(cell)
  }
  return column
}

function pair(entry: RemapEntry, fonts: Fonts): FrameNode {
  const column = autoLayout(entry.site.name, 'VERTICAL', 3)
  column.appendChild(block(entry.from, entry.fromStep === null ? '' : String(entry.fromStep), fonts))
  column.appendChild(block(entry.to, entry.toStep === null ? '' : String(entry.toStep), fonts))

  const name = entry.site.name.length > 22 ? '…' + entry.site.name.slice(-21) : entry.site.name
  column.appendChild(label(name, fonts, CAPTION_SIZE, '#8A8A8A'))
  return column
}

interface FamilyGroup {
  title: string
  entries: RemapEntry[]
}

function groupEntries(plan: RemapPlan): FamilyGroup[] {
  const moving = plan.entries.filter((entry) => !entry.flags.includes('unchanged'))
  const targetByFamily = new Map(plan.families.map((family) => [family.fromLabel, family.toLabel]))

  const order: string[] = []
  const grouped = new Map<string, RemapEntry[]>()
  for (const entry of moving) {
    const key = entry.fromFamily ?? 'Ungrouped'
    const group = grouped.get(key)
    if (group) group.push(entry)
    else {
      grouped.set(key, [entry])
      order.push(key)
    }
  }

  return order.map((key) => {
    const target = targetByFamily.get(key)
    return {
      title: target ? `${key}  →  ${target}` : key,
      entries: grouped.get(key)!,
    }
  })
}

export interface RemapBoardReport {
  section: string
  rows: number
  families: number
  omitted: number
}

/**
 * Draws the board on the current page, replacing the previous one.
 *
 * The old section is torn down *before* the new content is built: every created node is born
 * at the canvas origin, and a section covering that spot adopts it — so removing the old one
 * afterwards would take the half-built board with it.
 */
export async function drawRemapBoard(plan: RemapPlan): Promise<RemapBoardReport> {
  const fonts = await loadFonts()
  const groups = groupEntries(plan)
  if (groups.length === 0) return { section: SECTION_NAME, rows: 0, families: 0, omitted: 0 }

  const previous = figma.currentPage
    .findAllWithCriteria({ types: ['SECTION'] })
    .find((node) => node.getPluginData(SECTION_KEY) === '1')
  const previousBox = previous?.absoluteBoundingBox ?? null
  const spot = previousBox ? { x: previousBox.x, y: previousBox.y } : placementFor(groups)
  if (previous) previous.remove()

  const content = autoLayout(SECTION_NAME, 'VERTICAL', ROW_GAP)
  content.x = spot.x + PADDING
  content.y = spot.y + PADDING

  const heading = autoLayout('heading', 'VERTICAL', 4)
  heading.appendChild(label(SECTION_NAME, fonts, LABEL_SIZE + 3, '#1A1A1A'))
  heading.appendChild(
    label(
      `old above, new below · ${plan.entries.filter((entry) => !entry.flags.includes('unchanged')).length} of ${plan.entries.length} colors move`,
      fonts,
      CAPTION_SIZE + 1,
      '#8A8A8A'
    )
  )
  content.appendChild(heading)

  let rows = 0
  let omitted = 0
  for (const group of groups) {
    const row = autoLayout(group.title, 'VERTICAL', 8)
    row.appendChild(label(group.title, fonts, LABEL_SIZE, '#1A1A1A'))

    const strip = autoLayout('strip', 'HORIZONTAL', 6)
    strip.appendChild(gutter(fonts))
    const shown = group.entries.slice(0, MAX_ROWS_PER_FAMILY)
    for (const entry of shown) strip.appendChild(pair(entry, fonts))
    row.appendChild(strip)
    rows += shown.length

    const hidden = group.entries.length - shown.length
    if (hidden > 0) {
      omitted += hidden
      row.appendChild(label(`+ ${hidden} more in this family`, fonts, CAPTION_SIZE, '#8A8A8A'))
    }
    content.appendChild(row)
  }

  const section = figma.createSection()
  section.name = SECTION_NAME
  section.fills = [solid('#FFFFFF')]
  section.setPluginData(SECTION_KEY, '1')

  figma.currentPage.appendChild(section)
  // Move before resizing. A section grows by covering canvas, and whatever it covers it
  // adopts — sized up at the origin it would pull in the designer's own work.
  section.x = spot.x
  section.y = spot.y
  section.resizeWithoutConstraints(content.width + PADDING * 2, content.height + PADDING * 2)
  section.appendChild(content)

  // Re-parenting into a section may or may not preserve the absolute position, and guessing
  // wrong leaves the board sitting outside its own frame. Measure where the content actually
  // landed and close the gap, which is right either way.
  const sectionBox = section.absoluteBoundingBox
  const contentBox = content.absoluteBoundingBox
  if (sectionBox && contentBox) {
    content.x += sectionBox.x + PADDING - contentBox.x
    content.y += sectionBox.y + PADDING - contentBox.y
  }

  return { section: SECTION_NAME, rows, families: groups.length, omitted }
}

function placementFor(groups: readonly FamilyGroup[]): { x: number; y: number } {
  const widest = groups.reduce(
    (most, group) => Math.max(most, Math.min(group.entries.length, MAX_ROWS_PER_FAMILY)),
    0
  )
  const width = widest * (SWATCH_WIDTH + 6) + PADDING * 2

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
