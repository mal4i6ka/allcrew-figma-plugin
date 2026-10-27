/**
 * Markdown, read into the blocks a canvas can draw.
 *
 * Figma's Specs (open beta, October 2026) put Markdown on the canvas — but only a person can make
 * one: dropping a `.md` file or pressing D. The Plugin API has no spec node to create or fill, in
 * the shipped typings or in the beta build (`node.probe` on `figma` lists no such constructor). So
 * the documents the export writes — DESIGN.md, COMPONENTS.md, ICONS.md — are laid out on the
 * canvas as ordinary layers instead, and this is the half of that which knows nothing of Figma.
 *
 * It reads the Markdown the export itself writes, not every dialect: ATX headings, paragraphs,
 * lists (nested, ordered, tasks), fenced code, GFM tables, quotes, rules, images on their own
 * line, and the inline marks inside them. HTML comments vanish; an `<a id>` anchor survives as an
 * anchor, because the index links of COMPONENTS.md point at them.
 */

export interface Run {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  href?: string
}

export interface ListItem {
  runs: Run[]
  depth: number
  checked?: boolean
}

export type Block =
  | { kind: 'heading'; level: number; runs: Run[]; slug: string }
  | { kind: 'paragraph'; runs: Run[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; head: Run[][]; rows: Run[][][]; align: Array<'left' | 'center' | 'right'> }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'rule' }
  | { kind: 'image'; alt: string; src: string }
  | { kind: 'anchor'; id: string }

/** GitHub's heading anchor: lower case, punctuation gone, spaces to hyphens. */
export function anchorSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

export function plainText(runs: readonly Run[]): string {
  return runs.map((run) => run.text).join('')
}

/* ------------------------------------------------------------------ inline */

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|<>~"']/

function sameStyle(a: Run, b: Run): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.href === b.href
}

function styled(text: string, style: Omit<Run, 'text'>): Run {
  const run: Run = { text }
  if (style.bold) run.bold = true
  if (style.italic) run.italic = true
  if (style.code) run.code = true
  if (style.href) run.href = style.href
  return run
}

/** The index of the bracket that closes the one at `open`, or -1. */
function closing(src: string, open: number, left: string, right: string): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '\\') {
      i++
      continue
    }
    if (src[i] === left) depth++
    else if (src[i] === right && --depth === 0) return i
  }
  return -1
}

const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)

function parseRuns(src: string, style: Omit<Run, 'text'>, out: Run[]): void {
  let text = ''
  const flush = () => {
    if (text) out.push(styled(text, style))
    text = ''
  }
  for (let i = 0; i < src.length; ) {
    const ch = src[i]
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) {
      text += src[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      let ticks = 1
      while (src[i + ticks] === '`') ticks++
      const fence = '`'.repeat(ticks)
      const end = src.indexOf(fence, i + ticks)
      if (end !== -1) {
        flush()
        const inner = src.slice(i + ticks, end)
        out.push(styled(inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') ? inner.slice(1, -1) : inner, { ...style, code: true }))
        i = end + ticks
        continue
      }
    }
    if ((ch === '!' && src[i + 1] === '[') || ch === '[') {
      const open = ch === '!' ? i + 1 : i
      const close = closing(src, open, '[', ']')
      if (close !== -1 && src[close + 1] === '(') {
        const end = closing(src, close + 1, '(', ')')
        if (end !== -1) {
          flush()
          const label = src.slice(open + 1, close)
          const target = src.slice(close + 2, end).trim().split(/\s+/)[0].replace(/^<|>$/g, '')
          // An image inside a sentence has nowhere to go but its words.
          if (ch === '!') out.push(styled(label, { ...style, italic: true }))
          else parseRuns(label, { ...style, href: target }, out)
          i = end + 1
          continue
        }
      }
    }
    if (ch === '<') {
      const end = src.indexOf('>', i)
      if (end !== -1) {
        const inner = src.slice(i + 1, end)
        if (/^(https?:\/\/|mailto:)[^\s<>]+$/.test(inner)) {
          flush()
          out.push(styled(inner, { ...style, href: inner }))
          i = end + 1
          continue
        }
        // Inline HTML (`<br>`, `<a id>`, `<kbd>`) carries no words of its own.
        if (/^\/?[a-zA-Z][\w-]*(\s[^<>]*)?\/?$/.test(inner)) {
          if (/^br\b/i.test(inner)) text += '\n'
          i = end + 1
          continue
        }
      }
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const double = src[i + 1] === ch
      const marker = double ? ch + ch : ch
      // `snake_case` and `2 * 3` are not emphasis: an underscore must open at a word's edge and
      // any marker must touch the word it opens.
      const opens = !isWordChar(ch === '_' ? src[i - 1] : undefined) && src[i + marker.length] !== undefined && !/\s/.test(src[i + marker.length])
      if (opens && !(ch === '~' && !double)) {
        let end = src.indexOf(marker, i + marker.length + 1)
        while (end !== -1 && (/\s/.test(src[end - 1]) || (ch === '_' && isWordChar(src[end + marker.length])) || (!double && src[end + 1] === ch))) {
          end = src.indexOf(marker, end + (!double && src[end + 1] === ch ? 2 : 1))
        }
        if (end !== -1) {
          flush()
          const inner = src.slice(i + marker.length, end)
          if (ch === '~') parseRuns(inner, style, out)
          else parseRuns(inner, double ? { ...style, bold: true } : { ...style, italic: true }, out)
          i = end + marker.length
          continue
        }
      }
    }
    text += ch
    i++
  }
  flush()
}

export function parseInline(src: string): Run[] {
  const raw: Run[] = []
  parseRuns(src, {}, raw)
  const merged: Run[] = []
  for (const run of raw) {
    const last = merged[merged.length - 1]
    if (last && sameStyle(last, run)) last.text += run.text
    else merged.push({ ...run })
  }
  return merged
}

/* ------------------------------------------------------------------ blocks */

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*$/
const ANCHOR_LINE = /^\s*<a\s+(?:id|name)="([^"]+)"\s*>\s*<\/a>\s*$/i
const TAG_LINE = /^\s*(<\/?[a-zA-Z][^<>]*>\s*)+$/

/** A table row's cells — split on bars that are neither escaped nor inside code. */
export function splitRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && body[i + 1] === '|') {
      cell += '|'
      i++
    } else if (ch === '`') {
      inCode = !inCode
      cell += ch
    } else if (ch === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
    } else cell += ch
  }
  cells.push(cell.trim())
  return cells
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    ITEM.test(line) ||
    /^\s{0,3}>/.test(line) ||
    IMAGE_LINE.test(line) ||
    ANCHOR_LINE.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_RULE.test(next) && next.includes('-'))
  )
}

export function parseMarkdown(markdown: string): Block[] {
  // Comments are notes to whoever edits the file — "GENERATED, do not hand-edit" — not content.
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n')
  return parseLines(lines)
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++])
      i++
      blocks.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const runs = parseInline(heading[2])
      blocks.push({ kind: 'heading', level: heading[1].length, runs, slug: anchorSlug(plainText(runs)) })
      i++
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }

    const anchor = ANCHOR_LINE.exec(line)
    if (anchor) {
      blocks.push({ kind: 'anchor', id: anchor[1] })
      i++
      continue
    }

    const image = IMAGE_LINE.exec(line)
    if (image) {
      blocks.push({ kind: 'image', alt: image[1], src: image[2] })
      i++
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]).map((rule) =>
        rule.startsWith(':') && rule.endsWith(':') ? 'center' : rule.endsWith(':') ? 'right' : 'left'
      ) as Array<'left' | 'center' | 'right'>
      const rows: Run[][][] = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitRow(lines[i++])
        rows.push(head.map((_, column) => parseInline(cells[column] ?? '')))
      }
      blocks.push({ kind: 'table', head: head.map((cell) => parseInline(cell)), rows, align })
      continue
    }

    if (/^\s{0,3}>/.test(line)) {
      const inner: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) inner.push(lines[i++].replace(/^\s{0,3}>\s?/, ''))
      blocks.push({ kind: 'quote', blocks: parseLines(inner) })
      continue
    }

    const first = ITEM.exec(line)
    if (first) {
      const ordered = /\d/.test(first[2])
      const items: ListItem[] = []
      const base = first[1].length
      while (i < lines.length) {
        const item = ITEM.exec(lines[i])
        if (item && (/\d/.test(item[2]) === ordered || item[1].length > base)) {
          let text = item[3]
          let checked: boolean | undefined
          const task = /^\[([ xX])\]\s+(.*)$/.exec(text)
          if (task) {
            checked = task[1] !== ' '
            text = task[2]
          }
          i++
          // Lazy continuation: an indented or plain line that starts nothing new belongs to the
          // item above it.
          while (i < lines.length && lines[i].trim() && !ITEM.test(lines[i]) && !startsBlock(lines[i], lines[i + 1])) {
            text += ` ${lines[i++].trim()}`
          }
          items.push({ runs: parseInline(text), depth: Math.min(4, Math.floor(Math.max(0, item[1].length - base) / 2)), ...(checked === undefined ? {} : { checked }) })
          continue
        }
        // One blank line between items keeps the list going; anything else ends it.
        if (!lines[i].trim() && i + 1 < lines.length && ITEM.test(lines[i + 1])) {
          i++
          continue
        }
        break
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items })
      continue
    }

    if (TAG_LINE.test(line)) {
      // `<details>`, `<summary>Notes</summary>`: the words inside the tags, if any.
      const words = line.replace(/<[^<>]*>/g, '').trim()
      if (words) blocks.push({ kind: 'paragraph', runs: parseInline(words) })
      i++
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() && (paragraph.length === 0 || !startsBlock(lines[i], lines[i + 1]))) {
      const own = lines[i++]
      // Two trailing spaces or a backslash end the line hard; otherwise lines join with a space.
      paragraph.push(/( {2,}|\\)$/.test(own) ? `${own.replace(/( {2,}|\\)$/, '')}<br>` : own.trim())
    }
    blocks.push({ kind: 'paragraph', runs: parseInline(paragraph.join(' ').replace(/<br> /g, '<br>')) })
  }
  return blocks
}
