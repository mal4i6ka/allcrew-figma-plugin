/**
 * The package's Markdown, laid out on the canvas next to the design it documents.
 *
 * Figma Specs would be the natural home — a Markdown container on the canvas — but a plugin cannot
 * make or fill one (see `markdown.ts`). So each document becomes a frame of ordinary layers:
 * headings, paragraphs, native bulleted and numbered lists, tables, code, quotes and the component
 * previews COMPONENTS.md points at. Links keep working: a URL stays a URL, `#anchor` jumps to its
 * heading, and `COMPONENTS.md` jumps to that document's frame.
 *
 * A document is found again by plugin data, not by name, so a re-export refreshes the same frame
 * in place — same id, same position — and anything that linked to it keeps pointing at it. The
 * frame says it is generated: what a designer types into it is replaced on the next export, and
 * the place to change the words is the component descriptions and the file they come from.
 */

import { checkpoint } from '../utils/budget.ts'
import { parseMarkdown, plainText, type Block, type ListItem, type Run } from './markdown.ts'

export const DOC_KEY = 'allcrewDoc'
export const DOCS_PAGE = 'Docs'

const WIDTH = 960
const PAD = 56
const GAP = 80
/** Past these the canvas copy stops and says where the rest is: an icon library's COMPONENTS.md is
 * thousands of entries, and a frame of thousands of layers makes the file slower for everyone. */
const MAX_BLOCKS = 600
const MAX_TABLE_ROWS = 100

const ORDER = ['DESIGN.md', 'COMPONENTS.md', 'ICONS.md']

/** The documents of a package: Markdown at its root, the ones the plugin writes first. */
export function docNames(files: Readonly<Record<string, unknown>>): string[] {
  const rank = (name: string) => (ORDER.includes(name) ? ORDER.indexOf(name) : ORDER.length)
  return Object.keys(files)
    .filter((path) => !path.includes('/') && /\.md$/i.test(path) && typeof files[path] === 'string')
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** Which document a link names, if any — `COMPONENTS.md`, `./COMPONENTS.md#button`. */
export function linkedDoc(href: string, names: readonly string[]): { name: string; anchor: string } | null {
  const match = /^(?:\.\/)?([^/#?]+\.md)(?:#(.*))?$/i.exec(href)
  if (!match) return null
  const name = names.find((candidate) => candidate.toLowerCase() === match[1].toLowerCase())
  return name ? { name, anchor: match[2] ?? '' } : null
}

/* ------------------------------------------------------------------ look */

const hex = (value: string): RGB => ({
  r: parseInt(value.slice(1, 3), 16) / 255,
  g: parseInt(value.slice(3, 5), 16) / 255,
  b: parseInt(value.slice(5, 7), 16) / 255,
})
const solid = (value: string): SolidPaint[] => [{ type: 'SOLID', color: hex(value) }]

const INK = '#1F2328'
const MUTED = '#59636E'
const LINK = '#0969DA'
const CODE_INK = '#953800'
const BORDER = '#D1D9E0'
const SURFACE = '#F6F8FA'

const HEADING = [
  { size: 30, line: 38 },
  { size: 23, line: 30 },
  { size: 19, line: 26 },
  { size: 16, line: 24 },
  { size: 15, line: 22 },
  { size: 14, line: 20 },
]

interface Fonts {
  regular: FontName
  italic: FontName
  bold: FontName
  boldItalic: FontName
  semibold: FontName
  mono: FontName
}

async function firstLoadable(candidates: FontName[], fallback: FontName): Promise<FontName> {
  for (const font of candidates) {
    try {
      await figma.loadFontAsync(font)
      return font
    } catch {
      /* not installed here — try the next */
    }
  }
  return fallback
}

async function loadFonts(): Promise<Fonts> {
  const regular = { family: 'Inter', style: 'Regular' }
  await figma.loadFontAsync(regular)
  const inter = (style: string) => firstLoadable([{ family: 'Inter', style }], regular)
  return {
    regular,
    italic: await inter('Italic'),
    bold: await inter('Bold'),
    boldItalic: await inter('Bold Italic'),
    semibold: await inter('Semi Bold'),
    mono: await firstLoadable(
      ['JetBrains Mono', 'Roboto Mono', 'Source Code Pro', 'SF Mono', 'Menlo', 'Courier New'].map((family) => ({ family, style: 'Regular' })),
      regular
    ),
  }
}

/* ------------------------------------------------------------------ layers */

interface Link {
  node: TextNode
  start: number
  end: number
  href: string
}

interface Context {
  name: string
  fonts: Fonts
  images: Readonly<Record<string, Uint8Array>>
  anchors: Map<string, string>
  pendingAnchor: string | null
  links: Link[]
  nativeLists: boolean
}

interface TextLook {
  size: number
  line: number
  font: FontName
  color: string
}

const BODY = (ctx: Context, color = INK): TextLook => ({ size: 15, line: 24, font: ctx.fonts.regular, color })

function stack(name: string, direction: 'VERTICAL' | 'HORIZONTAL', spacing: number): FrameNode {
  const frame = figma.createFrame()
  frame.name = name
  frame.layoutMode = direction
  frame.primaryAxisSizingMode = 'AUTO'
  frame.counterAxisSizingMode = 'AUTO'
  frame.itemSpacing = spacing
  frame.fills = []
  frame.clipsContent = false
  return frame
}

/** Appends `child` and stretches it across the parent — in that order: FILL means nothing to a
 * node that is not yet inside an auto-layout frame. */
function fill(parent: FrameNode, child: FrameNode | TextNode | RectangleNode): void {
  parent.appendChild(child)
  child.layoutSizingHorizontal = 'FILL'
}

function fontFor(run: Run, base: FontName, fonts: Fonts): FontName {
  if (run.code) return fonts.mono
  // A heading is already bold; emphasis inside it only adds the slant.
  const bold = run.bold || base === fonts.bold || base === fonts.semibold
  if (bold && run.italic) return fonts.boldItalic
  if (run.italic) return fonts.italic
  if (run.bold) return fonts.bold
  return base
}

/** A text layer holding `runs`, styled run by run; links are collected to resolve once every
 * heading and every document has a node to point at. */
function textOf(parent: FrameNode, runs: readonly Run[], look: TextLook, ctx: Context): TextNode {
  const text = figma.createText()
  text.fontName = look.font
  text.fontSize = look.size
  text.lineHeight = { unit: 'PIXELS', value: look.line }
  text.characters = plainText(runs) || ' '
  text.fills = solid(look.color)
  fill(parent, text)
  text.textAutoResize = 'HEIGHT'
  let at = 0
  for (const run of runs) {
    const end = at + run.text.length
    if (end > at) {
      const font = fontFor(run, look.font, ctx.fonts)
      if (font !== look.font) text.setRangeFontName(at, end, font)
      if (run.code) {
        text.setRangeFontSize(at, end, Math.max(11, look.size - 2))
        text.setRangeFills(at, end, solid(CODE_INK))
      }
      if (run.href) {
        text.setRangeFills(at, end, solid(LINK))
        text.setRangeTextDecoration(at, end, 'UNDERLINE')
        ctx.links.push({ node: text, start: at, end, href: run.href })
      }
    }
    at = end
  }
  return text
}

function listOf(parent: FrameNode, items: readonly ListItem[], ordered: boolean, ctx: Context): TextNode {
  // Native lists when this Figma has them: the designer can then edit the list as a list. Without
  // them the markers are written into the words.
  const lines = items.map((item, index) => {
    const task = item.checked === undefined ? [] : [{ text: item.checked ? '☑ ' : '☐ ' }]
    const marker = ctx.nativeLists ? [] : [{ text: `${'    '.repeat(item.depth)}${ordered ? `${index + 1}.` : '•'} ` }]
    return [...marker, ...task, ...item.runs]
  })
  const runs: Run[] = []
  lines.forEach((line, index) => {
    if (index > 0) runs.push({ text: '\n' })
    runs.push(...line)
  })
  const text = textOf(parent, runs, BODY(ctx), ctx)
  if (ctx.nativeLists) {
    try {
      let at = 0
      lines.forEach((line, index) => {
        const end = at + plainText(line).length
        text.setRangeListOptions(at, Math.max(end, at + 1), { type: ordered ? 'ORDERED' : 'UNORDERED' })
        text.setRangeIndentation(at, Math.max(end, at + 1), items[index].depth + 1)
        at = end + 1
      })
      text.setRangeListSpacing(0, text.characters.length, 4)
    } catch {
      text.remove()
      ctx.nativeLists = false
      return listOf(parent, items, ordered, ctx)
    }
  }
  return text
}

function codeOf(parent: FrameNode, block: Extract<Block, { kind: 'code' }>, ctx: Context): void {
  const box = stack(block.lang ? `code · ${block.lang}` : 'code', 'VERTICAL', 0)
  box.paddingTop = box.paddingBottom = box.paddingLeft = box.paddingRight = 16
  box.cornerRadius = 8
  box.fills = solid(SURFACE)
  fill(parent, box)
  textOf(box, [{ text: block.text }], { size: 13, line: 20, font: ctx.fonts.mono, color: INK }, ctx)
}

function tableOf(parent: FrameNode, block: Extract<Block, { kind: 'table' }>, ctx: Context): void {
  // The rules between cells are the table's own colour showing through one-pixel gaps: no strokes
  // to double up where two cells meet.
  const table = stack('table', 'VERTICAL', 1)
  table.fills = solid(BORDER)
  table.paddingTop = table.paddingBottom = table.paddingLeft = table.paddingRight = 1
  table.cornerRadius = 6
  table.clipsContent = true
  fill(parent, table)
  const rows = block.rows.slice(0, MAX_TABLE_ROWS)
  const align = { left: 'LEFT', center: 'CENTER', right: 'RIGHT' } as const
  ;[block.head, ...rows].forEach((cells, index) => {
    const row = stack(index === 0 ? 'header' : `row ${index}`, 'HORIZONTAL', 1)
    fill(table, row)
    cells.forEach((runs, column) => {
      const cell = stack(`cell ${column + 1}`, 'VERTICAL', 0)
      cell.paddingTop = cell.paddingBottom = 8
      cell.paddingLeft = cell.paddingRight = 12
      cell.fills = solid(index === 0 ? SURFACE : '#FFFFFF')
      row.appendChild(cell)
      cell.layoutGrow = 1
      cell.layoutSizingVertical = 'FILL'
      const look = { size: 13, line: 20, font: index === 0 ? ctx.fonts.semibold : ctx.fonts.regular, color: INK }
      textOf(cell, runs, look, ctx).textAlignHorizontal = align[block.align[column] ?? 'left']
    })
  })
  if (block.rows.length > rows.length) {
    textOf(parent, [{ text: `… ${block.rows.length - rows.length} more row(s) in ${ctx.name}.`, italic: true }], BODY(ctx, MUTED), ctx)
  }
}

async function imageOf(parent: FrameNode, block: Extract<Block, { kind: 'image' }>, ctx: Context): Promise<void> {
  const bytes = ctx.images[block.src.replace(/^\.\//, '')]
  if (!bytes) {
    textOf(parent, [{ text: `${block.alt || 'image'} — ${block.src}`, italic: true }], BODY(ctx, MUTED), ctx)
    return
  }
  const image = figma.createImage(bytes)
  const size = await image.getSizeAsync()
  const scale = Math.min(1, (WIDTH - PAD * 2) / size.width, 480 / size.height)
  const picture = figma.createRectangle()
  picture.name = block.alt || block.src
  picture.resize(Math.max(1, Math.round(size.width * scale)), Math.max(1, Math.round(size.height * scale)))
  picture.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FIT' }]
  picture.cornerRadius = 6
  parent.appendChild(picture)
}

async function blocksInto(parent: FrameNode, blocks: readonly Block[], ctx: Context, color = INK): Promise<void> {
  for (const block of blocks) {
    await checkpoint()
    switch (block.kind) {
      case 'anchor':
        ctx.pendingAnchor = block.id
        break
      case 'heading': {
        const level = HEADING[block.level - 1]
        // A frame around the words, because a link can land on a frame and not on a text layer
        // ("Invalid hyperlink target node specified") — and the index links need somewhere to go.
        const node = stack(`${'#'.repeat(block.level)} ${plainText(block.runs)}`.slice(0, 80), 'VERTICAL', 8)
        node.paddingTop = block.level <= 2 ? 12 : 4
        fill(parent, node)
        textOf(node, block.runs, { size: level.size, line: level.line, font: block.level === 1 ? ctx.fonts.bold : ctx.fonts.semibold, color }, ctx)
        if (block.level <= 2) {
          const rule = figma.createRectangle()
          rule.name = 'rule'
          rule.resize(10, 1)
          rule.fills = solid(BORDER)
          fill(node, rule)
        }
        // The heading's own slug and the `<a id>` written above it both land here; the first
        // heading with a slug keeps it, as on GitHub.
        if (!ctx.anchors.has(block.slug)) ctx.anchors.set(block.slug, node.id)
        if (ctx.pendingAnchor) ctx.anchors.set(ctx.pendingAnchor, node.id)
        ctx.pendingAnchor = null
        break
      }
      case 'paragraph':
        textOf(parent, block.runs, BODY(ctx, color), ctx)
        break
      case 'list':
        listOf(parent, block.items, block.ordered, ctx)
        break
      case 'code':
        codeOf(parent, block, ctx)
        break
      case 'table':
        tableOf(parent, block, ctx)
        break
      case 'quote': {
        const quote = stack('quote', 'VERTICAL', 10)
        quote.paddingLeft = 16
        quote.strokes = solid(BORDER)
        quote.strokeAlign = 'INSIDE'
        quote.strokeTopWeight = quote.strokeRightWeight = quote.strokeBottomWeight = 0
        quote.strokeLeftWeight = 4
        fill(parent, quote)
        await blocksInto(quote, block.blocks, ctx, MUTED)
        break
      }
      case 'rule': {
        const rule = figma.createRectangle()
        rule.name = 'rule'
        rule.resize(10, 2)
        rule.fills = solid(BORDER)
        fill(parent, rule)
        break
      }
      case 'image':
        await imageOf(parent, block, ctx)
        break
    }
  }
}

/* ------------------------------------------------------------------ placing */

async function docsPage(): Promise<PageNode> {
  if (figma.editorType === 'figjam') return figma.currentPage
  if (figma.editorType && figma.editorType !== 'figma') {
    throw new Error(`documents go on a Design or FigJam canvas — this file is open in ${figma.editorType}`)
  }
  let page =
    figma.root.children.find((candidate) => candidate.getPluginData(DOC_KEY) === 'page') ??
    figma.root.children.find((candidate) => candidate.name === DOCS_PAGE)
  if (!page) {
    page = figma.createPage()
    page.name = DOCS_PAGE
  }
  page.setPluginData(DOC_KEY, 'page')
  await page.loadAsync()
  return page
}

function docFrames(page: PageNode): Map<string, FrameNode> {
  const frames = new Map<string, FrameNode>()
  for (const node of page.children) {
    const name = node.type === 'FRAME' ? node.getPluginData(DOC_KEY) : ''
    if (name && !frames.has(name)) frames.set(name, node as FrameNode)
  }
  return frames
}

function frameFor(page: PageNode, name: string, existing: Map<string, FrameNode>): FrameNode {
  const known = existing.get(name)
  if (known) {
    for (const child of [...known.children]) child.remove()
    return known
  }
  const frame = figma.createFrame()
  // To the right of the documents already here; on a shared FigJam board, to the right of
  // everything, so a document never lands on someone's work.
  const neighbours = existing.size > 0 ? [...existing.values()] : page.children.filter((node) => node !== frame)
  const right = neighbours.reduce((edge, node) => Math.max(edge, node.x + node.width), -Infinity)
  const top = existing.size > 0 ? Math.min(...[...existing.values()].map((node) => node.y)) : 0
  frame.x = Number.isFinite(right) ? Math.round(right + GAP) : 0
  frame.y = Number.isFinite(top) ? top : 0
  page.appendChild(frame)
  frame.setPluginData(DOC_KEY, name)
  existing.set(name, frame)
  return frame
}

export interface PlacedDoc {
  name: string
  id: string
  blocks: number
  /** Blocks past {@link MAX_BLOCKS} that stayed in the file only. */
  omitted: number
}

export interface PlacedDocs {
  page: { id: string; name: string }
  docs: PlacedDoc[]
}

export async function placeDocs(
  docs: ReadonlyArray<{ name: string; markdown: string }>,
  images: Readonly<Record<string, Uint8Array>> = {}
): Promise<PlacedDocs> {
  if (docs.length === 0) throw new Error('no Markdown documents to place — export with Documentation on first')
  const page = await docsPage()
  const fonts = await loadFonts()
  const existing = docFrames(page)
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const placed: PlacedDoc[] = []
  const contexts: Context[] = []
  let nativeLists = true

  for (const doc of docs) {
    const blocks = parseMarkdown(doc.markdown)
    const shown = blocks.slice(0, MAX_BLOCKS)
    const frame = frameFor(page, doc.name, existing)
    frame.name = doc.name
    frame.layoutMode = 'VERTICAL'
    frame.primaryAxisSizingMode = 'AUTO'
    frame.counterAxisSizingMode = 'FIXED'
    frame.resize(WIDTH, frame.height)
    frame.itemSpacing = 14
    frame.paddingTop = frame.paddingBottom = frame.paddingLeft = frame.paddingRight = PAD
    frame.fills = solid('#FFFFFF')
    frame.strokes = solid(BORDER)
    frame.strokeWeight = 1
    frame.cornerRadius = 16
    frame.clipsContent = false

    const ctx: Context = { name: doc.name, fonts, images, anchors: new Map(), pendingAnchor: null, links: [], nativeLists }
    textOf(
      frame,
      [{ text: `${doc.name} · generated by AllCrew ${stamp} · re-export to update — edits made here are replaced` }],
      { size: 12, line: 16, font: fonts.regular, color: MUTED },
      ctx
    )
    await blocksInto(frame, shown, ctx)
    if (blocks.length > shown.length) {
      textOf(frame, [{ text: `… ${blocks.length - shown.length} more block(s) are in ${doc.name} itself — the canvas copy stops here to keep the file light.`, italic: true }], BODY(ctx, MUTED), ctx)
    }
    nativeLists = ctx.nativeLists
    contexts.push(ctx)
    placed.push({ name: doc.name, id: frame.id, blocks: shown.length, omitted: blocks.length - shown.length })
  }

  // Links last: an index entry points at a heading further down, and DESIGN.md points at
  // COMPONENTS.md, which did not exist yet when DESIGN.md was drawn.
  const names = [...existing.keys()]
  for (const ctx of contexts) {
    for (const link of ctx.links) {
      let target: HyperlinkTarget | null = null
      if (/^(https?:|mailto:)/i.test(link.href)) target = { type: 'URL', value: link.href }
      else if (link.href.startsWith('#')) {
        const id = ctx.anchors.get(link.href.slice(1))
        if (id) target = { type: 'NODE', value: id }
      } else {
        const doc = linkedDoc(link.href, names)
        const frame = doc && existing.get(doc.name)
        const anchored = doc && doc.anchor ? contexts.find((other) => other.name === doc.name)?.anchors.get(doc.anchor) : undefined
        if (frame) target = { type: 'NODE', value: anchored ?? frame.id }
      }
      // A link to a file of the package that is not on the canvas (tokens.css, previews/…) has
      // nowhere to go here; it keeps the link colour so the reader still sees it was one.
      if (target) {
        try {
          link.node.setRangeHyperlink(link.start, link.end, target)
        } catch {
          /* a URL Figma refuses stays styled text */
        }
      }
    }
  }
  return { page: { id: page.id, name: page.name }, docs: placed }
}
