/**
 * Agent listener — export settings.
 *
 * The export panel in Figma is a design decision, not a rendering detail: a designer who
 * marks a frame "export SVG" is saying *this piece must not be baked into a raster*. Until
 * now the channel could render anything and read nothing about those marks — `node.get`,
 * `design.ir` and `NODE_QUERY props` all drop `exportSettings` — so the only way to find the
 * marked frames was Figma's REST API, with a token, outside this channel entirely. That is
 * the gap these ops close.
 *
 * Three things live here:
 *
 * - `export.settings` reads the marks over a subtree, with each marked node's box both in
 *   pixels and as a share of the root. A pipeline that puts a vector over a raster plate
 *   needs exactly that: the file, and where it sits on the plate at any width.
 * - `export.configure` writes them — the same panel, in batch, with a before/after report.
 * - `export.run` renders nodes *by their own settings*, honouring format, constraint and
 *   suffix as the designer set them, instead of making the caller restate all three.
 */

import { binaryFile, slugify, textFile } from './files.ts'
import type { OpDef } from './protocol.ts'

/** One row of Figma's export panel, flattened — every field the Plugin API exposes. */
export interface SettingSummary {
  format: string
  constraint?: { type: string; value: number }
  suffix?: string
  contentsOnly?: boolean
  useAbsoluteBounds?: boolean
  colorProfile?: string
  svgOutlineText?: boolean
  svgIdAttribute?: boolean
  svgSimplifyStroke?: boolean
}

const FORMATS = ['PNG', 'JPG', 'SVG', 'PDF'] as const
const CONSTRAINTS = ['SCALE', 'WIDTH', 'HEIGHT'] as const
const PROFILES = ['DOCUMENT', 'SRGB', 'DISPLAY_P3_V4'] as const

function summarize(setting: ExportSettings): SettingSummary {
  const raw = setting as ExportSettings & {
    constraint?: { type: string; value: number }
    suffix?: string
    contentsOnly?: boolean
    useAbsoluteBounds?: boolean
    colorProfile?: string
    svgOutlineText?: boolean
    svgIdAttribute?: boolean
    svgSimplifyStroke?: boolean
  }
  return {
    format: String(raw.format),
    ...(raw.constraint ? { constraint: { type: String(raw.constraint.type), value: Number(raw.constraint.value) } } : {}),
    ...(raw.suffix ? { suffix: raw.suffix } : {}),
    ...(raw.contentsOnly === undefined ? {} : { contentsOnly: raw.contentsOnly }),
    ...(raw.useAbsoluteBounds === undefined ? {} : { useAbsoluteBounds: raw.useAbsoluteBounds }),
    ...(raw.colorProfile === undefined ? {} : { colorProfile: String(raw.colorProfile) }),
    ...(raw.svgOutlineText === undefined ? {} : { svgOutlineText: raw.svgOutlineText }),
    ...(raw.svgIdAttribute === undefined ? {} : { svgIdAttribute: raw.svgIdAttribute }),
    ...(raw.svgSimplifyStroke === undefined ? {} : { svgSimplifyStroke: raw.svgSimplifyStroke }),
  }
}

/** Figma refuses a whole `exportSettings` assignment on one bad field, and its message names
 * neither the row nor the key. Validate first so the refusal says which one. */
function toSetting(raw: unknown, where: string): ExportSettings {
  if (!raw || typeof raw !== 'object') throw new Error(`${where}: expected an object`)
  const entry = raw as Record<string, unknown>
  const format = String(entry.format ?? 'PNG').toUpperCase()
  if (!FORMATS.includes(format as (typeof FORMATS)[number])) {
    throw new Error(`${where}: format must be one of ${FORMATS.join(', ')}`)
  }
  const out: Record<string, unknown> = { format }

  if (entry.constraint !== undefined) {
    const c = entry.constraint as Record<string, unknown>
    const type = String(c?.type ?? '').toUpperCase()
    if (!CONSTRAINTS.includes(type as (typeof CONSTRAINTS)[number])) {
      throw new Error(`${where}: constraint.type must be one of ${CONSTRAINTS.join(', ')}`)
    }
    const value = Number(c?.value)
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${where}: constraint.value must be a positive number`)
    out.constraint = { type, value }
  }
  if (entry.suffix !== undefined) out.suffix = String(entry.suffix)
  if (entry.contentsOnly !== undefined) out.contentsOnly = entry.contentsOnly === true
  if (entry.useAbsoluteBounds !== undefined) out.useAbsoluteBounds = entry.useAbsoluteBounds === true
  if (entry.colorProfile !== undefined) {
    const profile = String(entry.colorProfile).toUpperCase()
    if (!PROFILES.includes(profile as (typeof PROFILES)[number])) {
      throw new Error(`${where}: colorProfile must be one of ${PROFILES.join(', ')}`)
    }
    out.colorProfile = profile
  }
  if (format === 'SVG') {
    if (entry.svgOutlineText !== undefined) out.svgOutlineText = entry.svgOutlineText === true
    if (entry.svgIdAttribute !== undefined) out.svgIdAttribute = entry.svgIdAttribute === true
    if (entry.svgSimplifyStroke !== undefined) out.svgSimplifyStroke = entry.svgSimplifyStroke === true
  } else if (entry.svgOutlineText !== undefined || entry.svgIdAttribute !== undefined || entry.svgSimplifyStroke !== undefined) {
    throw new Error(`${where}: svg* flags belong to an SVG row`)
  }
  return out as unknown as ExportSettings
}

function hasExports(node: SceneNode): node is SceneNode & ExportMixin {
  return 'exportSettings' in node
}

function box(node: SceneNode): { x: number; y: number; width: number; height: number } | null {
  const bounds = (node as { absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null })
    .absoluteBoundingBox
  if (!bounds || !bounds.width || !bounds.height) return null
  return bounds
}

async function resolveScene(id: unknown): Promise<SceneNode> {
  const node = await figma.getNodeByIdAsync(String(id))
  if (!node) throw new Error(`no node with id ${String(id)}`)
  if (node.type === 'DOCUMENT' || node.type === 'PAGE') throw new Error(`${String(id)} is a ${node.type}, not a layer`)
  return node as SceneNode
}

/**
 * Preorder walk bounded by depth, carrying the layer path.
 *
 * `walkSceneNodes` visits everything below a root and tells the visitor nothing about where
 * it is; an export report has to say WHICH layer carries the mark, and a caller reading
 * "Frame 2085661054" three levels down needs the path to find it in Figma. Depth also caps
 * the cost: the marks that matter sit near the top of a slot, not in its glyphs.
 */
function* descend(root: SceneNode, maxDepth: number): Generator<{ node: SceneNode; depth: number; path: string }> {
  const stack: Array<{ node: SceneNode; depth: number; path: string }> = [{ node: root, depth: 0, path: root.name }]
  while (stack.length > 0) {
    const current = stack.pop()!
    yield current
    if (current.depth >= maxDepth || !('children' in current.node)) continue
    const children = current.node.children
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], depth: current.depth + 1, path: `${current.path}/${children[i].name}` })
    }
  }
}

export const EXPORT_OPS: readonly OpDef[] = [
  {
    name: 'export.settings',
    summary: "The export marks a designer set on a subtree — what Figma's export panel holds, which no other read reports.",
    agent:
      'The op for "which frames did the designer mark, and how". A mark is an instruction about the ASSET: SVG means ' +
      'do not bake this into a raster, a 2x SCALE row means ship it at that density, a suffix names the file. Each ' +
      'marked node reports its settings in full plus `box` (pixels) and `share` (percent of the root\'s box) — the ' +
      'numbers a build needs to place a vector over a raster plate at any width. `allChildrenMarked` answers the one ' +
      'question a plate export turns on: NODE_EXPORT can hide every child or none, so a partly marked parent cannot ' +
      'be split and stays a flat render. Without this op the marks are readable only over REST, with a token.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Root of the subtree to inspect.' },
      format: {
        type: 'string',
        description: 'Keep only nodes carrying a row of this format (PNG, JPG, SVG, PDF). Omitted — every marked node.',
        enum: [...FORMATS],
      },
      depth: { type: 'number', default: 6, min: 0, max: 24, description: 'How deep to walk below the root.' },
      limit: { type: 'number', default: 200, min: 1, max: 2000, description: 'Maximum marked nodes reported.' },
    },
    async run(params) {
      const root = await resolveScene(params.nodeId)
      const wanted = typeof params.format === 'string' ? params.format.toUpperCase() : null
      const limit = params.limit as number
      const frame = box(root)

      const marked: Array<Record<string, unknown>> = []
      let scanned = 0
      for (const { node, depth, path } of descend(root, params.depth as number)) {
        scanned += 1
        if (!hasExports(node)) continue
        const settings = [...node.exportSettings].map(summarize)
        if (settings.length === 0) continue
        if (wanted && !settings.some((s) => s.format === wanted)) continue
        if (marked.length >= limit) break
        const own = box(node)
        const children = 'children' in node ? node.children.filter((child) => child.visible !== false) : []
        marked.push({
          id: node.id,
          name: node.name,
          type: node.type,
          depth,
          path,
          visible: node.visible !== false,
          settings,
          ...(own ? { box: { x: Math.round(own.x), y: Math.round(own.y), width: own.width, height: own.height } } : {}),
          ...(own && frame
            ? {
                share: {
                  left: Number((((own.x - frame.x) / frame.width) * 100).toFixed(4)),
                  top: Number((((own.y - frame.y) / frame.height) * 100).toFixed(4)),
                  width: Number(((own.width / frame.width) * 100).toFixed(4)),
                  height: Number(((own.height / frame.height) * 100).toFixed(4)),
                },
              }
            : {}),
          childrenMarked: children.filter((child) => hasExports(child) && child.exportSettings.length > 0).length,
          children: children.length,
        })
      }

      const kids = 'children' in root ? root.children.filter((child) => child.visible !== false) : []
      return {
        node: { id: root.id, name: root.name, type: root.type, ...(frame ? { width: frame.width, height: frame.height } : {}) },
        scanned,
        marked,
        truncated: marked.length >= limit,
        // A plate export ("render the parent, hide the children, ship the children as files")
        // is only sound when every visible child is marked: `withoutChildren` hides all of
        // them, so one unmarked sibling would silently vanish from the picture.
        allChildrenMarked: kids.length > 0 && kids.every((child) => hasExports(child) && child.exportSettings.length > 0),
      }
    },
  },

  {
    name: 'export.run',
    summary: "Render nodes by THEIR OWN export settings — the designer's format, density and suffix, not the caller's guess.",
    agent:
      'The companion to export.settings: that one says what the designer asked for, this one produces it. A node with ' +
      'three rows comes back as three files, each named with its own suffix, so a 1x/2x/3x set arrives in one call. ' +
      'Nodes with no settings are reported, not silently skipped. Use NODE_EXPORT instead when the caller — not the ' +
      'file — decides the format.',
    mutates: false,
    params: {
      nodes: { type: 'string[]', required: true, description: 'Node ids to render by their own export rows.' },
      format: { type: 'string', enum: [...FORMATS], description: 'Only render rows of this format.' },
      budgetBytes: { type: 'number', default: 8_000_000, min: 100_000, max: 12_000_000, description: 'Stop once the answer reaches this size.' },
    },
    async run(params) {
      const ids = (params.nodes as string[]) ?? []
      const wanted = typeof params.format === 'string' ? params.format.toUpperCase() : null
      const budget = params.budgetBytes as number
      const files: unknown[] = []
      const reports: Array<Record<string, unknown>> = []
      let spent = 0

      for (const id of ids) {
        let node: SceneNode
        try {
          node = await resolveScene(id)
        } catch (error) {
          reports.push({ node: id, ok: false, error: String((error as Error)?.message || error) })
          continue
        }
        if (!hasExports(node) || node.exportSettings.length === 0) {
          reports.push({ node: id, name: node.name, ok: false, error: 'no export settings on this node' })
          continue
        }
        for (const [index, setting] of [...node.exportSettings].entries()) {
          const summary = summarize(setting)
          if (wanted && summary.format !== wanted) continue
          if (spent >= budget) {
            reports.push({ node: id, name: node.name, row: index, ok: false, error: 'budget spent before this row' })
            continue
          }
          try {
            const stem = `${slugify(node.name)}${summary.suffix ? slugify(summary.suffix) : ''}`
            if (summary.format === 'SVG') {
              const svg = await node.exportAsync({ ...(setting as object), format: 'SVG_STRING' } as ExportSettingsSVGString)
              spent += svg.length
              const name = `${stem}.svg`
              files.push(textFile(name, 'image/svg+xml', svg))
              reports.push({ node: id, name: node.name, row: index, ok: true, file: name, bytes: svg.length, settings: summary })
              continue
            }
            const bytes = await node.exportAsync(setting)
            spent += bytes.length
            const ext = summary.format.toLowerCase()
            const mime = summary.format === 'JPG' ? 'image/jpeg' : summary.format === 'PDF' ? 'application/pdf' : 'image/png'
            const name = `${stem}.${ext}`
            files.push(binaryFile(name, mime, bytes))
            reports.push({ node: id, name: node.name, row: index, ok: true, file: name, bytes: bytes.length, settings: summary })
          } catch (error) {
            reports.push({ node: id, name: node.name, row: index, ok: false, error: String((error as Error)?.message || error) })
          }
        }
      }
      return { files, nodes: reports, bytes: spent, budgetSpent: spent >= budget }
    },
  },

  {
    name: 'export.configure',
    summary: "Set, add or clear a layer's export rows — the export panel, in batch, with a before/after report.",
    agent:
      'Rows are the whole panel: `set` replaces them, `add` appends one, `clear` empties. A row is ' +
      '{ format, constraint: { type: SCALE|WIDTH|HEIGHT, value }, suffix?, contentsOnly?, useAbsoluteBounds?, ' +
      'colorProfile?, svg* flags }. Every entry reports `before` and `after`, because a write this API accepts is ' +
      'not yet a write the file kept. Marking a frame here is a design statement — it tells every downstream ' +
      'importer to ship that frame as its own asset — so prefer dryRun first and tell the designer what changed.',
    mutates: true,
    params: {
      nodes: {
        type: 'json',
        required: true,
        description:
          'Array of { node, set?: [row], add?: row, clear?: true }. Exactly one action per entry. A row is the ' +
          'object described above; `constraint` defaults to SCALE 1 as Figma\'s own panel does.',
      },
      dryRun: { type: 'boolean', default: false, description: 'Report what would change without writing anything.' },
    },
    async run(params) {
      const entries = Array.isArray(params.nodes) ? params.nodes : [params.nodes]
      const dryRun = params.dryRun === true
      if (!dryRun) figma.commitUndo()

      const results: Array<Record<string, unknown>> = []
      for (const [index, raw] of entries.entries()) {
        const where = `nodes[${index}]`
        try {
          const entry = (raw ?? {}) as Record<string, unknown>
          const node = await resolveScene(entry.node)
          // Every SceneNode carries exportSettings in the typings — a guard here is a branch into `never`.
          const before = [...node.exportSettings].map(summarize)

          const actions = ['set', 'add', 'clear'].filter((key) => entry[key] !== undefined)
          if (actions.length !== 1) throw new Error(`${where}: name exactly one of set, add, clear`)

          let next: ExportSettings[]
          if (entry.clear !== undefined) {
            if (entry.clear !== true) throw new Error(`${where}: clear takes true`)
            next = []
          } else if (entry.add !== undefined) {
            next = [...node.exportSettings, toSetting(entry.add, `${where}.add`)]
          } else {
            const rows = Array.isArray(entry.set) ? entry.set : [entry.set]
            next = rows.map((row, i) => toSetting(row, `${where}.set[${i}]`))
          }

          if (!dryRun) {
            node.exportSettings = next
          }
          const after = dryRun ? next.map((s) => summarize(s)) : [...node.exportSettings].map(summarize)
          results.push({
            node: node.id,
            name: node.name,
            ok: true,
            before,
            after,
            // Read back rather than echoed: Figma normalises a row (a missing constraint becomes
            // SCALE 1), and an agent that trusted the echo would describe settings the file
            // does not hold.
            verified: dryRun ? null : JSON.stringify(after) === JSON.stringify(next.map((s) => summarize(s))),
          })
        } catch (error) {
          results.push({ node: String((raw as { node?: unknown })?.node ?? where), ok: false, error: String((error as Error)?.message || error) })
        }
      }
      const written = results.filter((r) => r.ok === true).length
      return { dryRun, nodes: results, written: dryRun ? 0 : written }
    },
  },
]

/** What the sandbox→bridge hop carries in one answer. Measured, not documented: a 2592×1360
 *  PNG (3.5 MB) is refused, and the refusal names this number. */
const HOP_BYTES = 3 * 1024 * 1024

/** Bytes per megapixel of a photographic PNG — from the renders this channel actually produced
 *  (1296×580 @2x = 3.5 MP → 3.5 MB; a flat UI frame lands well under it). An estimate, and
 *  labelled as one: it decides which strategy to TRY first, never what the answer is. */
const PNG_BYTES_PER_MEGAPIXEL = 1_000_000

function hasImageFill(node: SceneNode): boolean {
  const fills = (node as { fills?: ReadonlyArray<{ type?: string; visible?: boolean }> | symbol }).fills
  if (!Array.isArray(fills)) return false
  return fills.some((paint) => paint?.type === 'IMAGE' && paint.visible !== false)
}

export const EXPORT_PLAN_OPS: readonly OpDef[] = [
  {
    name: 'export.plan',
    summary: 'How to get this slot out of Figma: vector, photo plate plus vector, or flat render — and at which density it still fits through the channel.',
    agent:
      'Reach for this BEFORE exporting a screen: it turns four facts that are each cheap to read — the node size, ' +
      'whether it paints a bitmap, which children the designer marked for export, and the 3 MB one answer carries — ' +
      'into one strategy plus the exact calls to make. `plate+vector` means the children are all marked: render the ' +
      'node with `withoutChildren` and ship each child as its own SVG, which is the only combination that keeps a ' +
      'vector widget crisp over a photo. `raster` means they are marked only in part, and `withoutChildren` is ' +
      'all-or-nothing, so splitting would drop the unmarked siblings. A node that paints a bitmap is never a whole-' +
      'SVG candidate: Figma embeds the photo as base64 and a hero frame comes out at 9 MB. `bytes` is an estimate ' +
      'from measured renders, and it only picks the density to try first — the export itself still reports the truth.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'The illustration slot to plan for.' },
      scale: { type: 'number', default: 2, min: 1, max: 4, description: 'Density the build wants (2 for a retina web build).' },
    },
    async run(params) {
      const node = await resolveScene(params.nodeId)
      const wanted = params.scale as number
      const frame = box(node)
      const children = 'children' in node ? node.children.filter((child) => child.visible !== false) : []
      const marked = children.filter((child) => hasExports(child) && child.exportSettings.length > 0)
      const allMarked = children.length > 0 && marked.length === children.length
      const photo = hasImageFill(node)

      const megapixels = frame ? (frame.width * frame.height) / 1_000_000 : 0
      const estimate = (scale: number) => Math.round(megapixels * scale * scale * PNG_BYTES_PER_MEGAPIXEL)
      const densities = [wanted, 1.5, 1].filter((scale, index, all) => all.indexOf(scale) === index)
      const fitting = densities.find((scale) => estimate(scale) <= HOP_BYTES)
      const fits = fitting ?? 1
      // Even 1× over the ceiling: a page-tall frame, not a slot. The plan says so instead of
      // handing back a call that is certain to be refused — export its sections one by one,
      // or fetch the render outside this channel (Figma's REST `/v1/images` has no such cap).
      const oversized = fitting === undefined

      const strategy = allMarked ? (photo ? 'plate+vector' : 'vector-over-plate') : 'raster'
      const calls: Array<Record<string, unknown>> = []
      if (allMarked) {
        calls.push({
          op: 'plugin.call',
          params: {
            command: 'NODE_EXPORT',
            params: { nodes: [node.id], format: 'PNG', scale: fits, withoutChildren: true },
          },
          why: 'the plate under the marked children — the photo or the flat background, nothing drawn on top of it',
        })
        calls.push({
          op: 'export.run',
          params: { nodes: marked.map((child) => child.id) },
          why: "each marked child by its own export row — the vectors that go over the plate",
        })
      } else {
        calls.push({
          op: 'plugin.call',
          params: { command: 'NODE_EXPORT', params: { nodes: [node.id], format: 'PNG', scale: fits } },
          why:
            children.length > 0 && marked.length > 0
              ? 'only some children are marked, and withoutChildren hides all of them — the whole slot renders flat'
              : 'no export marks on the children: the slot is one picture',
        })
      }
      if (oversized) {
        calls[0].why =
          `${calls[0].why} — but at ${Math.round(megapixels)} megapixels even 1× is past the ` +
          'hop: export the sections separately, or render this node outside the plugin channel'
      }

      return {
        node: { id: node.id, name: node.name, type: node.type, ...(frame ? { width: frame.width, height: frame.height } : {}) },
        strategy,
        paintsBitmap: photo,
        children: { total: children.length, marked: marked.length, allMarked },
        density: {
          wanted,
          fits,
          // Named so a caller can tell a refusal from a plan that already knew: at `wanted`
          // density this node is over the hop, and the plan stepped down before asking.
          steppedDown: fits !== wanted,
          oversized,
          estimatedBytes: Object.fromEntries(densities.map((scale) => [String(scale), estimate(scale)])),
          hopBytes: HOP_BYTES,
          estimate: 'PNG bytes extrapolated from measured renders — the export reports the real size',
        },
        calls,
      }
    },
  },
]
