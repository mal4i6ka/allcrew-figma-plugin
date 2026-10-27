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
import { openSweep, resolveSweepRoots, SWEEP_PARAMS } from './sweep.ts'

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
      '`includeHidden` adds layers the designer switched off. Rows and `counts` describe this call\'s page and are ' +
      'paged by `limit`; on `complete: false`, call again with the same params plus `cursor`.',
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
      ...SWEEP_PARAMS,
    },
    async run(params) {
      const extra = (params.illustrations as string[] | undefined) ?? []
      const includeHidden = params.includeHidden === true
      const wanted = String(params.role ?? 'all')
      const limit = params.limit as number
      let rootNode: BaseNode | null = null
      const sweep = await openSweep({
        op: 'text.inventory',
        params,
        roots: async () => {
          const resolved = await resolveSweepRoots({ nodeId: params.nodeId })
          rootNode = resolved.roots[0] ?? null
          return resolved
        },
        state: () => ({
          root: rootNode
            ? { id: rootNode.id, name: rootNode.name, type: rootNode.type }
            : { id: String(params.nodeId), name: '', type: 'UNKNOWN' },
        }),
        skipInstanceChildren: false,
        includeRoots: true,
        // Hidden layers inside instances exist for this read only when Figma is told not to
        // skip them — the one inventory that asks for them must see them.
        invisibleInstanceChildren: includeHidden,
      })
      const rows: TextRow[] = []

      await sweep.walk(async (node) => {
        // `swept.nodes` is the resumable running total; rows below belong only to this call.
        if (node.type !== 'TEXT') return

        const names: string[] = []
        let walk: BaseNode | null = node
        let visible = true
        let bakedIn: string | null = null
        while (walk && walk.type !== 'DOCUMENT') {
          names.unshift(walk.name)
          if ('visible' in walk && walk.visible === false) visible = false
          if (isIllustration(walk.name, extra)) bakedIn = walk.name
          if (walk.id === String(params.nodeId)) break
          walk = walk.parent
        }
        if (!visible && !includeHidden) return
        const role: TextRow['role'] = bakedIn ? 'baked' : 'content'
        if (wanted !== 'all' && wanted !== role) return

        const text = node as TextNode
        const style = text.textStyleId ? await figma.getStyleByIdAsync(String(text.textStyleId)) : null
        rows.push({
          id: text.id,
          name: text.name,
          path: names.join('/'),
          characters: text.characters.replace(/\n/g, '\\n'),
          length: text.characters.length,
          role,
          ...(bakedIn ? { bakedIn } : {}),
          ...(style ? { style: style.name } : {}),
          visible,
        })
        if (rows.length >= limit) return 'stop'
      })

      const report = sweep.report()
      const content = rows.filter((row) => row.role === 'content')
      return {
        ...report,
        node: sweep.state.root,
        ...(report.complete ? { scanned: report.swept.nodes } : { scannedSoFar: report.swept.nodes }),
        truncated: !report.complete,
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
