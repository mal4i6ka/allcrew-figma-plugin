/**
 * Agent listener — the board renderer.
 *
 * A migration argued in a chat log is a migration nobody can check. This draws the argument
 * into the file itself: headings, callouts, swatch grids and before/after rows, laid out with
 * real auto-layout so a designer can read it, comment on it and keep it next to the work.
 *
 * The board's own chrome is deliberately hard-coded hex, never tokens — a board that explains
 * a palette change must not restyle itself when the palette changes. The exception is opt-in
 * and the whole point of the "after" column: a swatch given `variable` is *bound*, so it
 * repaints the moment the variable does, and a group given `modes` renders its bound swatches
 * in that theme. Render before, apply, and the right-hand column moves on its own.
 */

import { parseColor, type Rgba } from './values.ts'

/* ------------------------------------------------------------------- chrome */

interface Chrome {
  bg: string
  panel: string
  panelAlt: string
  ink: string
  inkMuted: string
  border: string
}

const CHROME: Record<'light' | 'dark', Chrome> = {
  light: { bg: '#FFFFFF', panel: '#F7F8F8', panelAlt: '#F2F4F5', ink: '#191B1C', inkMuted: '#797979', border: '#E4E7E9' },
  dark: { bg: '#0F1011', panel: '#191B1C', panelAlt: '#202020', ink: '#FFFFFF', inkMuted: '#8C8C8C', border: '#333434' },
}

const TONES: Record<string, string> = {
  info: '#435E93',
  ok: '#26A23F',
  warn: '#B8860B',
  danger: '#CD1918',
  neutral: '#797979',
}

const STATUS_TONE: Record<string, string> = {
  same: 'neutral',
  unchanged: 'neutral',
  changed: 'info',
  new: 'ok',
  added: 'ok',
  removed: 'danger',
  warn: 'warn',
  check: 'warn',
}

/* -------------------------------------------------------------------- fonts */

type Weight = 'regular' | 'medium' | 'bold'

let FONTS: Record<Weight, FontName> = {
  regular: { family: 'Inter', style: 'Regular' },
  medium: { family: 'Inter', style: 'Medium' },
  bold: { family: 'Inter', style: 'Semi Bold' },
}

/** Inter ships with Figma, but a file can be opened where it does not — fall back rather than
 * failing the whole board on a font load. */
async function loadFonts(): Promise<void> {
  const candidates: Array<Record<Weight, FontName>> = [
    FONTS,
    { regular: { family: 'Roboto', style: 'Regular' }, medium: { family: 'Roboto', style: 'Medium' }, bold: { family: 'Roboto', style: 'Bold' } },
  ]
  for (const set of candidates) {
    try {
      await Promise.all(Object.values(set).map((font) => figma.loadFontAsync(font)))
      FONTS = set
      return
    } catch {
      /* try the next family */
    }
  }
  throw new Error('no usable font — install Inter or Roboto')
}

/* ------------------------------------------------------------------ helpers */

function solid(hex: string, fallback = '#000000'): SolidPaint {
  const color = parseColor(hex) ?? parseColor(fallback) ?? ({ r: 0, g: 0, b: 0, a: 1 } as Rgba)
  return { type: 'SOLID', color: { r: color.r, g: color.g, b: color.b }, opacity: color.a }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value)
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

interface Ctx {
  chrome: Chrome
  width: number
  /** Collected while rendering: swatches whose variable could not be resolved. */
  warnings: string[]
}

function frame(name: string, direction: 'VERTICAL' | 'HORIZONTAL', gap: number): FrameNode {
  const node = figma.createFrame()
  node.name = name
  node.layoutMode = direction
  node.itemSpacing = gap
  node.primaryAxisSizingMode = 'AUTO'
  node.counterAxisSizingMode = 'AUTO'
  node.fills = []
  node.clipsContent = false
  return node
}

function pad(node: FrameNode, vertical: number, horizontal: number): void {
  node.paddingTop = vertical
  node.paddingBottom = vertical
  node.paddingLeft = horizontal
  node.paddingRight = horizontal
}

function text(chars: string, size: number, weight: Weight, color: string): TextNode {
  const node = figma.createText()
  node.fontName = FONTS[weight]
  node.characters = chars
  node.fontSize = size
  node.lineHeight = { unit: 'PERCENT', value: 140 }
  node.fills = [solid(color)]
  return node
}

function paragraph(chars: string, size: number, weight: Weight, color: string, width: number): TextNode {
  const node = text(chars, size, weight, color)
  node.textAutoResize = 'HEIGHT'
  node.resize(width, node.height)
  return node
}

/** A colour chip. `variable` binds the fill, so the chip tracks the token rather than copying it. */
async function chip(
  spec: Record<string, unknown>,
  ctx: Ctx,
  width: number,
  height: number
): Promise<{ node: RectangleNode; label: string }> {
  const rect = figma.createRectangle()
  rect.resize(width, height)
  rect.cornerRadius = Math.min(14, Math.round(height / 3))
  rect.strokes = [solid(ctx.chrome.border)]
  rect.strokeWeight = 1
  rect.name = str(spec.label) || str(spec.color) || str(spec.variable) || 'swatch'

  const ref = spec.variable
  if (typeof ref === 'string' && ref !== '') {
    const variable = await findVariable(ref)
    if (variable) {
      const base: SolidPaint = { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }
      rect.fills = [figma.variables.setBoundVariableForPaint(base, 'color', variable)]
      return { node: rect, label: str(spec.sub) }
    }
    ctx.warnings.push(`no variable "${ref}" — chip left empty`)
    rect.fills = []
    rect.dashPattern = [4, 4]
    return { node: rect, label: str(spec.sub) }
  }

  const color = parseColor(spec.color)
  if (!color) {
    rect.fills = []
    rect.dashPattern = [4, 4]
    return { node: rect, label: str(spec.sub) }
  }
  rect.fills = [solid(String(spec.color))]
  // A transparent token reads as "nothing" on a white board — a checker underlay would be
  // noise, so the alpha is stated in the caption instead (see describeColor's percent form).
  return { node: rect, label: str(spec.sub) }
}

const variableCache = new Map<string, Variable | null>()

/** Same reference forms as `variables.set`, cached because a board asks for the same token
 * many times over. */
async function findVariable(ref: string): Promise<Variable | null> {
  if (variableCache.has(ref)) return variableCache.get(ref) ?? null
  let found: Variable | null = null
  try {
    if (ref.startsWith('VariableID:')) {
      found = await figma.variables.getVariableByIdAsync(ref)
    } else {
      const variables = await figma.variables.getLocalVariablesAsync()
      found = variables.find((variable) => variable.name === ref) ?? null
      if (!found) {
        const slash = ref.indexOf('/')
        if (slash > 0) {
          const collections = await figma.variables.getLocalVariableCollectionsAsync()
          const collection = collections.find((entry) => entry.name.toLowerCase() === ref.slice(0, slash).toLowerCase())
          const name = ref.slice(slash + 1)
          found =
            variables.find((variable) => variable.variableCollectionId === collection?.id && variable.name === name) ??
            null
        }
      }
    }
  } catch {
    found = null
  }
  variableCache.set(ref, found)
  return found
}

/* --------------------------------------------------------------------- pill */

function pill(label: string, tone: string, chrome: Chrome): FrameNode {
  const node = frame(`status/${label}`, 'HORIZONTAL', 0)
  pad(node, 4, 10)
  node.cornerRadius = 999
  const hex = TONES[tone] ?? TONES.neutral
  node.fills = [{ ...solid(hex), opacity: 0.12 }]
  node.appendChild(text(label, 11, 'medium', hex))
  return node
}

/* ------------------------------------------------------------------- blocks */

async function renderBlock(raw: unknown, ctx: Ctx): Promise<SceneNode | null> {
  const spec = obj(raw)
  const type = str(spec.type, 'text')
  const chrome = ctx.chrome

  switch (type) {
    case 'heading': {
      const level = num(spec.level, 2)
      const size = level <= 1 ? 40 : level === 2 ? 26 : 18
      const node = frame('heading', 'VERTICAL', 6)
      node.appendChild(text(str(spec.text), size, 'bold', chrome.ink))
      if (spec.sub) node.appendChild(paragraph(str(spec.sub), 14, 'regular', chrome.inkMuted, ctx.width - 128))
      return node
    }

    case 'text':
      return paragraph(str(spec.text), num(spec.size, 14), 'regular', str(spec.color) || chrome.inkMuted, ctx.width - 128)

    case 'spacer': {
      const node = frame('spacer', 'VERTICAL', 0)
      node.resize(1, num(spec.height, 24))
      node.counterAxisSizingMode = 'FIXED'
      node.primaryAxisSizingMode = 'FIXED'
      return node
    }

    case 'callout': {
      const tone = str(spec.tone, 'info')
      const hex = TONES[tone] ?? TONES.info
      const node = frame(`callout/${tone}`, 'VERTICAL', 6)
      pad(node, 16, 20)
      node.cornerRadius = 16
      node.fills = [{ ...solid(hex), opacity: 0.08 }]
      node.strokes = [{ ...solid(hex), opacity: 0.24 }]
      node.strokeWeight = 1
      if (spec.title) node.appendChild(text(str(spec.title), 14, 'bold', hex))
      if (spec.text) node.appendChild(paragraph(str(spec.text), 13, 'regular', chrome.ink, ctx.width - 200))
      return node
    }

    case 'swatches': {
      const items = list(spec.items)
      const columns = Math.max(1, num(spec.columns, 8))
      const cell = num(spec.cellWidth, 132)
      const node = frame(str(spec.title, 'swatches'), 'VERTICAL', 16)
      if (spec.title) node.appendChild(text(str(spec.title), 16, 'bold', chrome.ink))

      for (let start = 0; start < items.length; start += columns) {
        const row = frame('row', 'HORIZONTAL', 12)
        for (const item of items.slice(start, start + columns)) {
          const itemSpec = obj(item)
          const cellFrame = frame(str(itemSpec.label, 'swatch'), 'VERTICAL', 8)
          cellFrame.resize(cell, 10)
          cellFrame.counterAxisSizingMode = 'FIXED'
          const { node: rect } = await chip(itemSpec, ctx, cell, num(spec.cellHeight, 64))
          cellFrame.appendChild(rect)
          if (itemSpec.label) cellFrame.appendChild(text(str(itemSpec.label), 12, 'medium', chrome.ink))
          if (itemSpec.sub) cellFrame.appendChild(text(str(itemSpec.sub), 11, 'regular', chrome.inkMuted))
          row.appendChild(cellFrame)
        }
        node.appendChild(row)
      }
      return node
    }

    case 'diff': {
      const rows = list(spec.rows)
      const labelWidth = num(spec.labelWidth, 260)
      const node = frame(str(spec.title, 'diff'), 'VERTICAL', 8)
      if (spec.title) node.appendChild(text(str(spec.title), 16, 'bold', chrome.ink))

      for (const raw of rows) {
        const row = obj(raw)
        const line = frame(str(row.label, 'row'), 'HORIZONTAL', 16)
        line.counterAxisAlignItems = 'CENTER'
        pad(line, 10, 14)
        line.cornerRadius = 14
        line.fills = [solid(chrome.panel)]
        line.layoutAlign = 'STRETCH'
        line.primaryAxisSizingMode = 'FIXED'

        const label = frame('label', 'VERTICAL', 2)
        label.resize(labelWidth, 10)
        label.counterAxisSizingMode = 'FIXED'
        label.appendChild(text(str(row.label), 13, 'medium', chrome.ink))
        if (row.sub) label.appendChild(text(str(row.sub), 11, 'regular', chrome.inkMuted))
        line.appendChild(label)

        for (const side of ['old', 'new'] as const) {
          const value = row[side]
          const cell = frame(side, 'VERTICAL', 6)
          cell.resize(96, 10)
          cell.counterAxisSizingMode = 'FIXED'
          const spec = typeof value === 'object' && value !== null ? obj(value) : { color: value }
          const { node: rect } = await chip(spec, ctx, 96, 40)
          cell.appendChild(rect)
          const caption = typeof spec.caption === 'string' ? spec.caption : str(spec.color ?? spec.variable, '—')
          cell.appendChild(text(caption, 11, 'regular', chrome.inkMuted))
          line.appendChild(cell)
          if (side === 'old') line.appendChild(text('→', 16, 'regular', chrome.inkMuted))
        }

        if (row.status) line.appendChild(pill(str(row.status), STATUS_TONE[str(row.status)] ?? 'neutral', chrome))
        if (row.note) {
          const note = paragraph(str(row.note), 12, 'regular', chrome.inkMuted, 200)
          note.layoutGrow = 1
          line.appendChild(note)
        }
        node.appendChild(line)
      }
      return node
    }

    case 'table': {
      const headers = list(spec.headers).map((entry) => str(entry))
      const rows = list(spec.rows)
      const widths = list(spec.widths).map((entry) => num(entry, 160))
      const columnWidth = (index: number): number =>
        widths[index] ?? Math.floor((ctx.width - 128 - 16 * Math.max(0, headers.length - 1)) / Math.max(1, headers.length))

      const node = frame(str(spec.title, 'table'), 'VERTICAL', 4)
      if (spec.title) node.appendChild(text(str(spec.title), 16, 'bold', chrome.ink))

      if (headers.length > 0) {
        const head = frame('header', 'HORIZONTAL', 16)
        pad(head, 8, 14)
        headers.forEach((header, index) => {
          const cell = text(header, 11, 'medium', chrome.inkMuted)
          cell.textAutoResize = 'HEIGHT'
          cell.resize(columnWidth(index), cell.height)
          head.appendChild(cell)
        })
        node.appendChild(head)
      }

      rows.forEach((raw, rowIndex) => {
        const cells = list(raw)
        const line = frame(`row/${rowIndex}`, 'HORIZONTAL', 16)
        line.counterAxisAlignItems = 'CENTER'
        pad(line, 10, 14)
        line.cornerRadius = 10
        if (rowIndex % 2 === 0) line.fills = [solid(chrome.panel)]
        cells.forEach((value, index) => {
          const cell = paragraph(str(value), 12, index === 0 ? 'medium' : 'regular', index === 0 ? chrome.ink : chrome.inkMuted, columnWidth(index))
          line.appendChild(cell)
        })
        node.appendChild(line)
      })
      return node
    }

    case 'group': {
      const direction = str(spec.direction, 'VERTICAL').toUpperCase() === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL'
      const node = frame(str(spec.title, 'group'), direction, num(spec.gap, 24))
      if (spec.padding !== undefined || spec.background) {
        pad(node, num(spec.padding, 24), num(spec.padding, 24))
        node.cornerRadius = num(spec.radius, 20)
        node.fills = [solid(str(spec.background) || chrome.panel)]
      }
      if (spec.title && direction === 'VERTICAL') node.appendChild(text(str(spec.title), 18, 'bold', chrome.ink))

      await applyModes(node, obj(spec.modes), ctx)

      const inner: Ctx = { ...ctx, width: direction === 'HORIZONTAL' ? Math.floor(ctx.width / Math.max(1, list(spec.blocks).length)) : ctx.width }
      for (const child of list(spec.blocks)) {
        const rendered = await renderBlock(child, inner)
        if (rendered) node.appendChild(rendered)
      }
      return node
    }

    default:
      ctx.warnings.push(`unknown block type "${type}" — skipped`)
      return null
  }
}

/**
 * `{ "One": "Dark" }` pins this subtree to a mode, which is what makes a side-by-side
 * Light/Dark preview possible in a single board: the same bound swatch renders twice, once
 * per column, with no duplicated values to keep in sync.
 */
async function applyModes(node: FrameNode, modes: Record<string, unknown>, ctx: Ctx): Promise<void> {
  const entries = Object.entries(modes)
  if (entries.length === 0) return
  const collections = await figma.variables.getLocalVariableCollectionsAsync()
  for (const [collectionName, modeRef] of entries) {
    const collection = collections.find((entry) => entry.name.toLowerCase() === collectionName.toLowerCase())
    if (!collection) {
      ctx.warnings.push(`no collection "${collectionName}" — mode pin skipped`)
      continue
    }
    const mode =
      collection.modes.find((entry) => entry.modeId === modeRef) ??
      collection.modes.find((entry) => entry.name.toLowerCase() === str(modeRef).toLowerCase())
    if (!mode) {
      ctx.warnings.push(`"${collectionName}" has no mode "${str(modeRef)}" — pin skipped`)
      continue
    }
    try {
      node.setExplicitVariableModeForCollection(collection, mode.modeId)
    } catch {
      try {
        // Older typings took the id; a plugin can meet either at runtime.
        ;(node as unknown as { setExplicitVariableModeForCollection: (id: string, modeId: string) => void })
          .setExplicitVariableModeForCollection(collection.id, mode.modeId)
      } catch (err) {
        ctx.warnings.push(`could not pin ${collectionName} → ${mode.name}: ${String((err as Error)?.message || err)}`)
      }
    }
  }
}

/* --------------------------------------------------------------------- page */

async function resolveBoardPage(ref: unknown): Promise<PageNode> {
  if (typeof ref !== 'string' || ref === '') {
    await figma.currentPage.loadAsync()
    return figma.currentPage
  }
  if (/^\d+:\d+$/.test(ref)) {
    const node = await figma.getNodeByIdAsync(ref)
    if (node && node.type === 'PAGE') {
      await node.loadAsync()
      return node
    }
  }
  const existing = figma.root.children.find((page) => page.name === ref)
  if (existing) {
    await existing.loadAsync()
    return existing
  }
  const page = figma.createPage()
  page.name = ref
  return page
}

/** Right of everything already on the page, so a board never lands on top of the work it
 * documents. */
function freeSpot(page: PageNode): { x: number; y: number } {
  let right = 0
  let top = 0
  let first = true
  for (const child of page.children) {
    if (!('x' in child)) continue
    right = Math.max(right, child.x + child.width)
    top = first ? child.y : Math.min(top, child.y)
    first = false
  }
  return first ? { x: 0, y: 0 } : { x: right + 240, y: top }
}

/* -------------------------------------------------------------------- entry */

export interface BoardOptions {
  replace: boolean
  focus: boolean
}

export async function renderBoard(spec: Record<string, unknown>, options: BoardOptions): Promise<unknown> {
  await loadFonts()
  variableCache.clear()

  const themeName = str(spec.theme, 'light') === 'dark' ? 'dark' : 'light'
  const chrome = CHROME[themeName]
  const width = num(spec.width, 1680)
  const name = str(spec.name, 'Board')
  const page = await resolveBoardPage(spec.page)

  let replaced = false
  if (options.replace) {
    for (const child of [...page.children]) {
      if (child.name === name && child.type === 'FRAME') {
        child.remove()
        replaced = true
      }
    }
  }

  const ctx: Ctx = { chrome, width, warnings: [] }

  const board = frame(name, 'VERTICAL', num(spec.gap, 36))
  board.fills = [solid(chrome.bg)]
  pad(board, 64, 64)
  board.cornerRadius = 32
  board.counterAxisSizingMode = 'FIXED'
  board.resize(width, 100)
  // resize() pins *both* axes, and the blocks are appended after this point — without handing
  // the primary axis back to auto-layout the board keeps the stub height and every section
  // spills outside its own background.
  board.primaryAxisSizingMode = 'AUTO'
  board.strokes = [solid(chrome.border)]
  board.strokeWeight = 1

  page.appendChild(board)

  for (const raw of list(spec.blocks)) {
    const node = await renderBlock(raw, ctx)
    if (!node) continue
    board.appendChild(node)
    if ('layoutAlign' in node && obj(raw).stretch !== false) node.layoutAlign = 'STRETCH'
  }

  const spot = spec.x !== undefined || spec.y !== undefined
    ? { x: num(spec.x, 0), y: num(spec.y, 0) }
    : freeSpot(page)
  board.x = spot.x
  board.y = spot.y

  if (options.focus) {
    await figma.setCurrentPageAsync(page)
    figma.viewport.scrollAndZoomIntoView([board])
    figma.currentPage.selection = [board]
  }

  return {
    board: { id: board.id, name: board.name, width: board.width, height: board.height, x: board.x, y: board.y },
    page: { id: page.id, name: page.name },
    replaced,
    blocks: board.children.length,
    warnings: ctx.warnings,
  }
}
