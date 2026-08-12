/**
 * Auto-layout overflow detection (T4.4): after translations are applied, some strings are
 * longer than their English original and blow past a FIXED-size auto-layout container.
 * Surfaced as a dismissible report (T6.1) rather than silently letting Figma clip the text.
 */

export interface OverflowReport {
  nodeId: string
  nodeName: string
  /** Available size along the container's fixed axis, in px. */
  expected: number
  /** Size the mutated node now occupies along that axis, in px. */
  actual: number
}

type AutoLayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL'
type AxisSizingMode = 'FIXED' | 'AUTO'

interface AutoLayoutFrame {
  layoutMode: AutoLayoutMode
  primaryAxisSizingMode: AxisSizingMode
  counterAxisSizingMode: AxisSizingMode
  width: number
  absoluteBoundingBox: Rect | null
}

function isAutoLayoutFrame(node: BaseNode | null): node is BaseNode & AutoLayoutFrame {
  return !!node && 'layoutMode' in node && (node as { layoutMode: AutoLayoutMode }).layoutMode !== 'NONE'
}

function findAutoLayoutParent(node: TextNode): (BaseNode & AutoLayoutFrame) | null {
  let cur = node.parent
  while (cur) {
    if (isAutoLayoutFrame(cur)) return cur
    cur = 'parent' in cur ? cur.parent : null
  }
  return null
}

/** Whether `parent`'s width is pinned rather than hugging/growing with its own content. */
function hasFixedWidth(parent: AutoLayoutFrame): boolean {
  return parent.layoutMode === 'HORIZONTAL' ? parent.primaryAxisSizingMode === 'FIXED' : parent.counterAxisSizingMode === 'FIXED'
}

export function detectOverflows(nodes: readonly TextNode[]): OverflowReport[] {
  const reports: OverflowReport[] = []

  for (const node of nodes) {
    const parent = findAutoLayoutParent(node)
    if (!parent || !hasFixedWidth(parent)) continue

    const nodeBox = node.absoluteBoundingBox
    const parentBox = parent.absoluteBoundingBox
    if (!nodeBox || !parentBox) continue

    const expected = parent.width
    const actual = nodeBox.x + nodeBox.width - parentBox.x

    if (actual > expected) {
      reports.push({ nodeId: node.id, nodeName: node.name, expected, actual })
    }
  }

  return reports
}
