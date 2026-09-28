/**
 * Agent listener — the text a screen actually says.
 *
 * The rule a localized build lives by is simple: **a TEXT node is a string, and
 * a string belongs in the translation file**. Checking that rule used to need a
 * copy of the design conventions on the consumer side — the importer in the
 * Django repository carried its own list of "these frames are illustrations, the
 * text inside them is drawn, not written". A second machine, a second repository
 * or a fresh checkout got a different answer, because it carried a different
 * copy.
 *
 * So the rule lives here, next to the file it describes. `text.inventory` walks a
 * subtree and reports every TEXT node with the one verdict a build needs:
 *
 * - `content` — copy. It must reach the CMS and the translation file.
 * - `baked` — text drawn INSIDE an illustration (`img/*`, `Img`, `Interface`,
 *   `Calculator`, …): «Randy F.», «- $3,500.00», «Balance:». It ships as pixels
 *   or as a vector overlay, and putting it in the copy deck would mean the same
 *   sentence twice — once translatable, once burnt into a PNG.
 *
 * Nothing here is repository-specific except the default list of illustration
 * names, and that list is a parameter.
 */

import type { OpDef } from './protocol.ts'

/** Frames whose insides are a picture, not copy — the names this file uses for them. */
const ILLUSTRATION_NAMES = ['Img', 'Img_hero', 'Interface', 'Calculator', 'World', 'Points']

/** `img/verticalcard_*`, `img/topiccard_template` — every illustration the designers name by role. */
const ILLUSTRATION_PREFIX = 'img/'

interface TextRow {
  id: string
  name: string
  path: string
  characters: string
  length: number
  role: 'content' | 'baked'
  /** For `baked`: the illustration the text is drawn inside. */
  bakedIn?: string
  style?: string
  visible: boolean
}

function isIllustration(name: string, extra: readonly string[]): boolean {
  return (
    name.startsWith(ILLUSTRATION_PREFIX) ||
    ILLUSTRATION_NAMES.includes(name) ||
    extra.includes(name)
  )
}

export const TEXT_OPS: readonly OpDef[] = [
  {
    name: 'text.inventory',
    summary: 'Every TEXT node of a subtree, split into copy that must be translated and text drawn inside illustrations.',
    agent:
      'The op behind "a text node is a string, and a string belongs in the translation file". Each row carries ' +
      'the characters, the layer path and a role: `content` is copy a CMS field and a PO entry must exist for; ' +
      '`baked` is text inside an illustration (`img/*`, `Img`, `Interface`, `Calculator`) — it ships as pixels or ' +
      'as an SVG overlay and must NOT be duplicated into the copy deck. Compare `content` against the strings a ' +
      'build exports and the difference is the localization gap, computed from the design rather than from a ' +
      "copy of the design's conventions kept somewhere else. `illustrations` extends the name list; " +
      '`includeHidden` adds layers the designer switched off.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Frame, section or page-level frame to inventory.' },
      illustrations: {
        type: 'string[]',
        description:
          'Extra layer names to treat as illustrations, beside `img/*`, ' +
          `${ILLUSTRATION_NAMES.join(', ')}.`,
      },
      includeHidden: { type: 'boolean', default: false, description: 'Also report layers that are switched off.' },
      role: {
        type: 'string',
        enum: ['content', 'baked', 'all'],
        default: 'all',
        description: 'Report only copy, only drawn text, or both.',
      },
      limit: { type: 'number', default: 500, min: 1, max: 5000, description: 'Maximum rows reported.' },
    },
    async run(params) {
      const root = await figma.getNodeByIdAsync(String(params.nodeId))
      if (!root) throw new Error(`no node with id ${String(params.nodeId)}`)
      if (root.type === 'DOCUMENT') throw new Error('give a frame or a page-level node, not the document')

      const extra = (params.illustrations as string[] | undefined) ?? []
      const includeHidden = params.includeHidden === true
      const wanted = String(params.role ?? 'all')
      const limit = params.limit as number

      const rows: TextRow[] = []
      let scanned = 0
      let truncated = false

      const stack: Array<{ node: BaseNode; path: string; bakedIn: string | null }> = [
        { node: root, path: root.name, bakedIn: isIllustration(root.name, extra) ? root.name : null },
      ]
      while (stack.length > 0) {
        const current = stack.pop()!
        const node = current.node
        scanned += 1
        const visible = (node as SceneNode).visible !== false
        if (!visible && !includeHidden) continue

        if (node.type === 'TEXT') {
          const text = node as TextNode
          const role: TextRow['role'] = current.bakedIn ? 'baked' : 'content'
          if (wanted === 'all' || wanted === role) {
            if (rows.length >= limit) {
              truncated = true
            } else {
              const style = text.textStyleId
                ? await figma.getStyleByIdAsync(String(text.textStyleId))
                : null
              rows.push({
                id: text.id,
                name: text.name,
                path: current.path,
                // Newlines escaped: a paragraph mark in the middle of a report reads as a broken row.
                characters: text.characters.replace(/\n/g, '\\n'),
                length: text.characters.length,
                role,
                ...(current.bakedIn ? { bakedIn: current.bakedIn } : {}),
                ...(style ? { style: style.name } : {}),
                visible,
              })
            }
          }
        }

        if ('children' in node) {
          for (const child of (node as BaseNode & ChildrenMixin).children) {
            stack.push({
              node: child,
              path: `${current.path}/${child.name}`,
              // Once inside an illustration, always inside it: depth changes nothing.
              bakedIn: current.bakedIn ?? (isIllustration(child.name, extra) ? child.name : null),
            })
          }
        }
      }

      const content = rows.filter((row) => row.role === 'content')
      return {
        node: { id: root.id, name: root.name, type: root.type },
        scanned,
        truncated,
        counts: {
          total: rows.length,
          content: content.length,
          baked: rows.length - content.length,
          distinct: new Set(content.map((row) => row.characters.trim())).size,
        },
        texts: rows,
      }
    },
  },
]
