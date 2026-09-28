/**
 * Agent listener — the measuring stick.
 *
 * Everything else in this listener answers "what is in the file". This op answers a different
 * question: "what numbers should the built page hit". The difference matters because the way a
 * design is checked today is a screenshot diff — it sees a dark band where a section should be
 * and calls it 90% similar, while the padding is off by 20px and the heading is set two steps
 * too large. A pixel score cannot name the property that is wrong, so the correction lands by
 * hand, page after page.
 *
 * Figma already computes the exact declarations for a layer (`getCSSAsync`). Handing those out,
 * addressed by a stable path, turns "looks close" into an assertion a test can make: the
 * consumer reads the same node it built a block from and compares declaration by declaration.
 *
 * The op deliberately returns Figma's own CSS rather than an interpretation of it: an
 * interpretation is another place to disagree with the source, and the point here is to have
 * one source both sides can quote.
 */

import type { OpDef } from './protocol.ts'
import { comparableProperties, judge, type BuiltLayer } from './audit.ts'
import { annotateAppearance, type AppearanceSource } from './appearance.ts'
import { variableNameResolver } from './bound-tokens.ts'
import { isPlatform, unitProfile } from './platform.ts'
import { indexSceneNodes, resolveSceneNode } from './subtree.ts'
import { serializeNode } from '../targets/django/ir.ts'
import { sleep } from '../utils/tree.ts'
import {
  anchorOf,
  ANCHOR_POINTS,
  isAnchorPoint,
  pinFor,
  type AnchorSource,
} from './anchor.ts'

/** One layer of a measured subtree. */
export interface MeasuredLayer {
  /** Index chain from the root, e.g. `0.2.1` — stable while the layer keeps its position. */
  path: string
  /** Name chain, for a human reading the diff: `Container / Cards / Card`. */
  label: string
  id: string
  name: string
  type: string
  /** Position relative to the measured root, in design pixels. */
  box: { x: number; y: number; width: number; height: number }
  /** Figma's own CSS for the layer. Absent when the API cannot produce it (vectors, masks). */
  css?: Record<string, string>
}

/** The node shape this module needs — kept structural so tests can hand in plain objects. */
interface MeasurableNode {
  id: string
  name: string
  type: string
  x?: number
  y?: number
  width?: number
  height?: number
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null
  children?: readonly MeasurableNode[]
  visible?: boolean
  getCSSAsync?: () => Promise<Record<string, string>>
}

function boxOf(node: MeasurableNode): { x: number; y: number; width: number; height: number } {
  const absolute = node.absoluteBoundingBox
  if (absolute) return { x: absolute.x, y: absolute.y, width: absolute.width, height: absolute.height }
  return { x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? 0, height: node.height ?? 0 }
}

export interface MeasureOptions {
  depth: number
  limit: number
  /** Hidden layers are skipped: they are not on the page the consumer is checking against. */
  includeHidden?: boolean
}

export interface MeasureResult {
  root: { id: string; name: string; type: string; width: number; height: number }
  layers: MeasuredLayer[]
  /** True when `limit` cut the walk short — the consumer is looking at a prefix, not the whole. */
  truncated: boolean
}

/**
 * Walks a subtree and records each layer's box and Figma CSS.
 *
 * Boxes are relative to the measured root, not to the canvas: a section pasted anywhere on the
 * page must measure the same, otherwise every comparison would first have to subtract an offset
 * the consumer has no reason to know about.
 */
export async function measureSubtree(root: MeasurableNode, options: MeasureOptions): Promise<MeasureResult> {
  const origin = boxOf(root)
  const layers: MeasuredLayer[] = []
  let truncated = false

  const visit = async (node: MeasurableNode, depth: number, path: string, label: string): Promise<void> => {
    if (layers.length >= options.limit) {
      truncated = true
      return
    }
    if (node.visible === false && !options.includeHidden) return

    const box = boxOf(node)
    let css: Record<string, string> | undefined
    if (typeof node.getCSSAsync === 'function') {
      try {
        css = await node.getCSSAsync()
      } catch {
        // A layer Figma cannot express as CSS (a mask, a boolean operation) still has a box,
        // and the box is half the answer — reporting nothing for it would hide it from the diff.
        css = undefined
      }
    }

    layers.push({
      path,
      label,
      id: node.id,
      name: node.name,
      type: node.type,
      box: {
        x: Math.round(box.x - origin.x),
        y: Math.round(box.y - origin.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      ...(css && Object.keys(css).length > 0 ? { css } : {}),
    })

    if (depth <= 0) return
    const children = node.children ?? []
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]
      await visit(child, depth - 1, path === '' ? String(index) : `${path}.${index}`, `${label} / ${child.name}`)
      if (layers.length >= options.limit) {
        truncated = true
        return
      }
    }
  }

  await visit(root, options.depth, '', root.name)
  return {
    root: { id: root.id, name: root.name, type: root.type, width: Math.round(origin.width), height: Math.round(origin.height) },
    layers,
    truncated,
  }
}

async function resolveMeasurable(ref: unknown): Promise<MeasurableNode> {
  if (typeof ref !== 'string' || ref === '') throw new Error('nodeId must be a non-empty string')
  const node = await figma.getNodeByIdAsync(ref)
  if (!node) throw new Error(`no node with id ${ref}`)
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error(`${ref} is a ${node.type}, not a layer`)
  return node as unknown as MeasurableNode
}

export const ANCHOR_OP: OpDef = {
  name: 'node.anchor',
  summary: 'Where a comment pin goes for a node: the frame to address it to, and the offset inside it.',
  agent:
    'The aiming primitive, and the call to make BEFORE comments.post. Figma pins a comment with ' +
    '`{node_id, node_offset}` where the offset is measured from the top-left of a FRAME — and a node id out of ' +
    'design.ir is usually a deep layer whose own position is relative to its parent, which is not the frame. This ' +
    'walks up to the frame a pin has to be addressed to and returns the offset in that frame\'s space, plus all nine ' +
    'named points of the node\'s box (`center`, `top-right`, …) so "the corner of the badge" is a word instead of ' +
    'arithmetic. `pin` is the exact `client_meta` to post. Addressing the frame rather than the canvas is what makes ' +
    'the comment MOVE WITH the screen when the designer drags it; an absolute point does not. `frame: null` means the ' +
    'node sits under no frame, and then the pin is absolute canvas coordinates. `rotated: true` warns that a corner ' +
    'anchor lands outside a rotated layer — `center` is still exact. You can usually skip this: comments.post takes ' +
    'a nodeId and calls it for you. Reach for it when you want to see the numbers first, or aim several pins at once.',
  mutates: false,
  params: {
    nodeId: { type: 'string', required: true, description: 'The layer to aim at.' },
    anchor: {
      type: 'string',
      default: 'center',
      enum: [...ANCHOR_POINTS],
      description: 'Which point of the node the pin sits on. `center` is what an annotation almost always wants.',
    },
  },
  async run(params) {
    const node = await resolveAnchorable(params.nodeId)
    const anchor = anchorOf(node)
    const point = isAnchorPoint(params.anchor) ? params.anchor : 'center'
    return { ...anchor, anchor: point, pin: pinFor(anchor, point) }
  },
}

/**
 * The node behind an id.
 *
 * `figma.getNodeByIdAsync` handles composite instance-sublayer ids (`I4658:161436;823:99713`)
 * on its own — measured, after a false alarm: a batch of those ids failed to resolve and looked
 * like an API limitation, when in fact the designer had restructured the component between the
 * `design.ir` run that produced them and the test that used them. They were stale, not
 * unresolvable. A fallback that walked the instance to find them was written and then deleted,
 * because it was answering a question nothing was asking.
 */
async function resolveAnchorable(ref: unknown): Promise<AnchorSource> {
  if (typeof ref !== 'string' || ref === '') throw new Error('nodeId must be a non-empty string')
  const node = await figma.getNodeByIdAsync(ref)
  if (!node) {
    throw new Error(
      `no node with id ${ref} — if it came from an earlier design.ir or node.find, the layer may have been ` +
        'restructured since; read the tree again'
    )
  }
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') {
    throw new Error(`${ref} is a ${node.type} — a pin is placed on a layer, not on a page`)
  }
  // `documentAccess: "dynamic-page"` — the ancestors this walks may live on an unloaded page.
  let parent: BaseNode | null = (node as unknown as { parent: BaseNode | null }).parent
  while (parent && parent.type !== 'PAGE') parent = parent.parent
  if (parent) await (parent as PageNode).loadAsync()
  return node as unknown as AnchorSource
}

/**
 * `history.mark` — the one write into version history the API allows.
 *
 * REST has no way to create a version; `figma.saveVersionHistoryAsync` is it, and it is a plugin
 * call. Worth having as an op because of what version history actually looks like on a real
 * file: 50 checkpoints over 12 days, of which ONE was named. An unnamed checkpoint records that
 * somebody touched the file; a named one records what they meant. An agent about to make a batch
 * of changes can leave a marker before and after, and that turns `history.diff` from "something
 * moved in these two hours" into "this is what that run did".
 */
export const HISTORY_MARK_OP: OpDef = {
  name: 'history.mark',
  summary: 'Save a named version of the file — the only way to put intent into version history.',
  agent:
    'Call this AROUND a batch of changes, not after the fact: a named checkpoint before and after turns a diff ' +
    'across an anonymous span into "this is what that run did". It is the only write into history the API has — ' +
    'REST cannot create a version at all — and on a real file 1 checkpoint in 50 was named, so almost all of the ' +
    'history nobody can interpret. The title is required and must be non-empty; put the WHY in `description`, since ' +
    'that is the field a person reads when they are deciding whether to restore. Figma warns that changes made ' +
    'immediately before the call may not be included, so this waits briefly first rather than saving a version that ' +
    'is missing the work it claims to mark. Restoring a version is not possible through any API — that is a person ' +
    'in the Figma UI. One measured surprise: on a file with no changes since the last autosave, this RENAMES that ' +
    'checkpoint instead of adding one — the id it returns is the existing one. So marking before and after a run ' +
    'that changed nothing leaves a single version, not two, and the second title wins. Nothing in the API docs ' +
    'says so.',
  mutates: true,
  params: {
    title: { type: 'string', required: true, description: 'The version name, as it appears in Figma\'s history panel.' },
    description: { type: 'string', description: 'Why this version exists — the field somebody reads before restoring.' },
  },
  async run(params) {
    const title = String(params.title ?? '').trim()
    if (!title) throw new Error('title is required and must be non-empty — an unnamed version is what Figma already makes on its own')
    const description = typeof params.description === 'string' ? params.description : undefined
    /* Figma's own caveat: "It is not guaranteed that all changes made before this method is used
     * will be saved to version history", and the documented workaround is to wait. A version
     * that is missing the very work it was created to mark is worse than no version. */
    await sleep(1000)
    const saved = await figma.saveVersionHistoryAsync(title, description)
    return {
      version: saved?.id ?? null,
      title,
      ...(description ? { description } : {}),
      note: 'read it back with history.versions; compare against it with history.diff',
    }
  },
}

export const SPEC_OPS: readonly OpDef[] = [
  {
    name: 'design.measure',
    summary: 'The numbers a built page has to hit — Figma’s own CSS for every layer of a section, addressed by path.',
    agent:
      'Use this to CHECK an implementation, not to write one: read the section you built a block from, then compare the ' +
      'browser’s computed styles against `layers[].css` property by property. A screenshot diff says "90% similar" and ' +
      'cannot name the padding that is wrong; this names it. `design.context` is the op for generating markup — this one ' +
      'is the assertion behind it. Boxes are relative to the measured root, so a section measures the same wherever it sits.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Section or frame to measure.' },
      depth: { type: 'number', default: 3, min: 0, max: 8, description: 'How deep to walk. 0 measures the node alone.' },
      limit: { type: 'number', default: 200, min: 1, max: 2000, description: 'Maximum layers reported; the answer says when it cut.' },
      includeHidden: {
        type: 'boolean',
        default: false,
        description: 'Measure layers the designer switched off. Off by default — they are not on the page being checked.',
      },
    },
    async run(params) {
      const root = await resolveMeasurable(params.nodeId)
      return await measureSubtree(root, {
        depth: params.depth as number,
        limit: params.limit as number,
        includeHidden: params.includeHidden as boolean,
      })
    },
  },

  {
    name: 'design.audit',
    summary: 'Judges a build against the design: what it dropped, what diverged, and what the channel could not tell it.',
    agent:
      'The assertion for a NON-web build, and the counterpart to design.measure (which compares CSS in a browser). ' +
      'After you generate a screen, report what you actually emitted — per layer, keyed by the Figma node id, in this ' +
      'channel\'s own property names (fill, radius, gap, paddingLeft, fontSize, lineHeight, width, text, …) — and this ' +
      'compares it against the design. Three verdicts, because they are three different bugs: `dropped` means the design ' +
      'said it and you emitted nothing (your bug), `diverged` means you disagree on the value (usually a unit or a mode), ' +
      'and `missing` means YOU needed it and THIS CHANNEL could not answer — which is the channel\'s bug, and `wanted` ' +
      'collects those most-reached-for first, so report them. Naming the TOKEN counts as a match and is a better answer ' +
      'than the literal. Pass `platform` and lengths are compared at the artboard\'s own density, so a 2× frame does not ' +
      'report every number as wrong. Requires the tree from design.ir with `appearance: true` — without it every paint ' +
      'property comes back `missing`, which is true but not useful.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'The frame or component the build was generated from.' },
      built: {
        type: 'json',
        required: true,
        description:
          'What you emitted: `[{ nodeId, properties: { fill: "#112233", radius: 8, gap: "spacing/md" } }]`. A property ' +
          'name this channel does not describe comes back as `unknown` rather than being quietly counted as a pass.',
      },
      platform: {
        type: 'string',
        enum: ['web', 'ios', 'android'],
        description:
          'Compare lengths in this platform\'s unit. A 750px artboard is 2× an iPhone, so every honest pt value is half ' +
          'the Figma number — without this the judge reports all of them as diverged.',
      },
      only: {
        type: 'string[]',
        description:
          'Judge just these properties. A build that emitted colour and no type asks about colour, instead of being ' +
          'told it dropped the whole type scale.',
      },
      appearance: {
        type: 'boolean',
        default: true,
        description:
          'Read paint, strokes, radii, effects and type off the live layers before judging. On by default: this op is ' +
          'useless without it, and a report of nothing but `missing` is the shape of that uselessness.',
      },
    },
    async run(params) {
      const root = await resolveSceneNode(params.nodeId)
      let parent: BaseNode | null = (root as unknown as { parent: BaseNode | null }).parent
      while (parent && parent.type !== 'PAGE') parent = parent.parent
      if (parent) await (parent as PageNode).loadAsync()

      const ir = await serializeNode(root)
      if (!ir) throw new Error(`"${root.name}" (${root.type}) produced no exportable structure`)

      if (params.appearance !== false) {
        const sceneNodesById = await indexSceneNodes([root])
        await annotateAppearance(
          [ir],
          sceneNodesById as unknown as ReadonlyMap<string, AppearanceSource>,
          variableNameResolver()
        )
      }

      const built = Array.isArray(params.built) ? (params.built as BuiltLayer[]) : null
      if (!built) throw new Error('"built" must be an array of { nodeId, properties }')

      const profile = isPlatform(params.platform) ? unitProfile(params.platform, root.width) : null
      const report = judge(ir, built, {
        scale: profile?.scale ?? 1,
        ...(Array.isArray(params.only) ? { only: params.only as string[] } : {}),
      })
      return {
        node: { id: root.id, name: root.name, type: root.type },
        ...(profile ? { units: profile } : {}),
        /* Every property this channel can be asked about, so a build that got a pile of
         * `unknown` back can see the vocabulary instead of guessing at it. */
        vocabulary: comparableProperties(),
        ...report,
      }
    },
  },

  ANCHOR_OP,
  HISTORY_MARK_OP,
]
