/**
 * Overflow detection (T4.4): after translations are applied, some strings are longer than their
 * English original and either blow past a FIXED-size ancestor or, for a fixed-size text box that
 * never resizes, get silently clipped inside the node's own bounds. Surfaced as a dismissible
 * report (T6.1) rather than letting Figma clip the text with no signal.
 *
 * Two detection paths:
 *
 * - `textAutoResize: 'NONE'` — the node's own box never grows, so Figma recomputes nothing for us
 *   to diff against (unlike `'HEIGHT'`/`'WIDTH_AND_HEIGHT'`, where `absoluteBoundingBox` already
 *   reflects the new content). Capacity is estimated from font metrics instead of measured.
 * - Everything else — walk up to the nearest ancestor whose relevant axis is pinned (an
 *   auto-layout frame with a `FIXED` sizing mode on that axis, or any plain frame/group with
 *   `clipsContent` — Figma clips anything sticking out of either) and diff the mutated node's own
 *   (now Figma-recomputed) box against it, on whichever axis(es) are pinned.
 */

export interface OverflowReport {
  nodeId: string
  nodeName: string
  /** Which dimension overran: the clipping ancestor's fixed axis, or (self-clip case) the text
   * node's own fixed height. */
  axis: 'horizontal' | 'vertical'
  /** Available size along `axis`, in px. */
  expected: number
  /** Size the mutated node (or, for the self-clip case, its estimated rendered content) now
   * occupies along that axis, in px. */
  actual: number
}

type AutoLayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL'
type AxisSizingMode = 'FIXED' | 'AUTO'

interface ClippingAncestor {
  layoutMode: AutoLayoutMode
  primaryAxisSizingMode: AxisSizingMode
  counterAxisSizingMode: AxisSizingMode
  width: number
  height: number
  clipsContent?: boolean
  absoluteBoundingBox: Rect | null
}

/** An auto-layout frame is always a candidate (its `FIXED`/`AUTO` sizing decides which axes
 * count); a plain (`layoutMode: 'NONE'`) frame only counts when it actually clips. */
function isClippingAncestor(node: BaseNode | null): node is BaseNode & ClippingAncestor {
  if (!node || !('layoutMode' in node)) return false
  const candidate = node as unknown as ClippingAncestor
  return candidate.layoutMode !== 'NONE' || candidate.clipsContent === true
}

function findClippingAncestor(node: TextNode): (BaseNode & ClippingAncestor) | null {
  let cur = node.parent
  while (cur) {
    if (isClippingAncestor(cur)) return cur
    cur = 'parent' in cur ? cur.parent : null
  }
  return null
}

/** A plain clipping frame has no auto-layout sizing mode of its own — both its axes are pinned
 * by definition, since it's just a fixed rectangle that hides overflow. */
function hasFixedWidth(container: ClippingAncestor): boolean {
  if (container.layoutMode === 'NONE') return !!container.clipsContent
  return container.layoutMode === 'HORIZONTAL' ? container.primaryAxisSizingMode === 'FIXED' : container.counterAxisSizingMode === 'FIXED'
}

function hasFixedHeight(container: ClippingAncestor): boolean {
  if (container.layoutMode === 'NONE') return !!container.clipsContent
  return container.layoutMode === 'HORIZONTAL' ? container.counterAxisSizingMode === 'FIXED' : container.primaryAxisSizingMode === 'FIXED'
}

interface LineHeightLike {
  readonly value?: number
  readonly unit: 'PIXELS' | 'PERCENT' | 'AUTO'
}

/** Figma's default line box for a fixed-size text node with no explicit line-height override. */
const AUTO_LINE_HEIGHT_FACTOR = 1.2
/** Rough average glyph advance width for a proportional Latin font, as a fraction of font size —
 * the same order-of-magnitude estimate truncation-width heuristics elsewhere in UI tooling use.
 * Conservative on purpose: it under-estimates capacity for condensed fonts/scripts (fewer false
 * negatives) at the cost of occasionally over-flagging a wide font (a dismissible report, not a
 * hard failure). */
const AVERAGE_GLYPH_WIDTH_FACTOR = 0.6

function lineHeightPx(fontSize: number, lineHeight: LineHeightLike | undefined): number {
  // `value` is absent on an AUTO line height, and Figma reports that shape for any node whose
  // line height was never set — reading it as 0 would make every line box zero-height and the
  // capacity estimate below would never flag anything.
  if (lineHeight && typeof lineHeight.value === 'number') {
    if (lineHeight.unit === 'PIXELS') return lineHeight.value
    if (lineHeight.unit === 'PERCENT') return fontSize * (lineHeight.value / 100)
  }
  return fontSize * AUTO_LINE_HEIGHT_FACTOR
}

interface SelfClippingTextNode {
  id: string
  name: string
  characters: string
  textAutoResize?: 'NONE' | 'HEIGHT' | 'WIDTH_AND_HEIGHT' | 'TRUNCATE'
  fontSize: number | symbol
  lineHeight: LineHeightLike | symbol
  absoluteBoundingBox: Rect | null
}

/** Estimates whether a `textAutoResize: 'NONE'` node's translated `characters` no longer fit its
 * fixed box — mixed font size across the node (`fontSize` is Figma's `figma.mixed` symbol) stays
 * conservative and reports nothing, same precedent as `lint/fix.ts`'s `clippingHasEffect` for
 * unmeasurable geometry. */
function detectSelfClippedText(node: SelfClippingTextNode): OverflowReport | null {
  if (node.textAutoResize !== 'NONE') return null
  const box = node.absoluteBoundingBox
  if (!box || typeof node.fontSize !== 'number') return null

  const fontSize = node.fontSize
  const lineHeight = typeof node.lineHeight === 'object' ? node.lineHeight : undefined
  const linePx = lineHeightPx(fontSize, lineHeight)
  const charsPerLine = Math.max(1, Math.floor(box.width / (fontSize * AVERAGE_GLYPH_WIDTH_FACTOR)))
  const maxLines = Math.max(1, Math.floor(box.height / linePx))
  const capacity = charsPerLine * maxLines

  const length = node.characters.length
  if (length <= capacity) return null

  const neededLines = Math.ceil(length / charsPerLine)
  return { nodeId: node.id, nodeName: node.name, axis: 'vertical', expected: box.height, actual: neededLines * linePx }
}

export function detectOverflows(nodes: readonly TextNode[]): OverflowReport[] {
  const reports: OverflowReport[] = []

  for (const node of nodes) {
    const selfClipped = detectSelfClippedText(node as unknown as SelfClippingTextNode)
    if (selfClipped) {
      reports.push(selfClipped)
      continue
    }

    const container = findClippingAncestor(node)
    if (!container) continue

    const nodeBox = node.absoluteBoundingBox
    const containerBox = container.absoluteBoundingBox
    if (!nodeBox || !containerBox) continue

    if (hasFixedWidth(container)) {
      const actual = nodeBox.x + nodeBox.width - containerBox.x
      if (actual > container.width) reports.push({ nodeId: node.id, nodeName: node.name, axis: 'horizontal', expected: container.width, actual })
    }

    if (hasFixedHeight(container)) {
      const actual = nodeBox.y + nodeBox.height - containerBox.y
      if (actual > container.height) reports.push({ nodeId: node.id, nodeName: node.name, axis: 'vertical', expected: container.height, actual })
    }
  }

  return reports
}
