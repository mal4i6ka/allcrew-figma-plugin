/**
 * Agent listener — reading one subtree.
 *
 * The pieces every op that looks at a screen needs first: resolve a node id, index its
 * descendants, collect the tokens it binds, render it, and name the assets it references.
 *
 * They live here rather than beside the ops that use them for one structural reason. The op
 * registry (`ops.ts`) imports every op module, so an op module that imports another op module
 * closes a cycle through the registry — and a cycle whose entry point is not `ops.ts` (a test,
 * for instance) evaluates the registry before its halves exist. Shared machinery in a leaf
 * module has no such edge: `context-ops` and `ir-ops` both import this, and neither imports
 * the other.
 */

import { imageStaticPath } from '../targets/django/html-emitter.ts'
import { collectManualAssets } from '../targets/django/export/assets.ts'
import { isVideoAssetPath, primaryDesignerSetting, type DesignerExportSetting } from '../targets/django/assets.ts'
import { resolveExportSettings, type ExportMarkedInstanceNode } from '../utils/graphics.ts'
import { findAllWithCriteria } from '../utils/tree.ts'
import { getNodeByIdTimed } from './loading.ts'
import { readLocalVariables } from '../variables.ts'
import type { IrNode } from '../targets/django/ir.ts'

/* ----------------------------------------------------------------- helpers */

export async function resolveSceneNode(ref: unknown): Promise<SceneNode> {
  if (typeof ref !== 'string' || ref === '') throw new Error('nodeId must be a non-empty string')
  // Timed: the first touch of a cold page costs tens of seconds, and the answer says so
  // instead of looking like a hung channel (see `loading.ts`).
  const node = await getNodeByIdTimed(ref)
  if (!node) throw new Error(`no node with id ${ref}`)
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error(`${ref} is a ${node.type}, not a layer`)
  return node as SceneNode
}

/** Lifted from the plugin UI's own export path so the agent walks the identical tree. */
export async function indexSceneNodes(roots: readonly SceneNode[]): Promise<Map<string, SceneNode>> {
  const index = new Map<string, SceneNode>()
  for (const root of roots) {
    index.set(root.id, root)
    for (const node of await findAllWithCriteria(root, (candidate): candidate is SceneNode => true)) {
      index.set(node.id, node)
    }
  }
  return index
}

export interface TokenReport {
  /** id → name, for the emitter, which takes a static map. */
  readonly names: Map<string, string>
  /** What the subtree binds and how often — the part an agent reads. */
  readonly usage: Array<{ token: string; uses: number }>
}

/**
 * Every variable the subtree actually binds, by token name and how often. This is the half a
 * screenshot cannot carry: it tells a generating agent which tokens are in play before it
 * writes a single declaration, and — because the count is there — which of them carry the
 * design and which appear once.
 *
 * Names come from the *local* variables plus a lookup for each bound id that is not among
 * them. The obvious alternative, `readAllVariables()`, is what the plugin's own export uses —
 * and it pulls every enabled library over the network, which is fine for an export a person
 * asked for and pathological for an op an agent is waiting on. A library variable that a layer
 * actually binds has already been imported into this file, so resolving it by id is a local
 * read; the cost stays proportional to the subtree rather than to the libraries.
 */
export async function collectTokens(nodes: Iterable<SceneNode>): Promise<TokenReport> {
  const local = await readLocalVariables()
  const names = new Map(local.variables.map((variable) => [variable.id, variable.name]))
  const counts = new Map<string, number>()
  const missing = new Set<string>()

  const nameFor = async (id: string): Promise<string | null> => {
    const known = names.get(id)
    if (known !== undefined) return known
    if (missing.has(id)) return null
    try {
      const variable = await figma.variables.getVariableByIdAsync(id)
      if (variable) {
        names.set(id, variable.name)
        return variable.name
      }
    } catch {
      /* fall through — an id we cannot resolve is reported as absent, not as an error */
    }
    missing.add(id)
    return null
  }

  for (const node of nodes) {
    const bound = (node as unknown as { boundVariables?: Record<string, unknown> }).boundVariables
    if (!bound) continue
    for (const entry of Object.values(bound)) {
      // A field is either one alias (`fills` on a shape) or an array of them (`fills` on a
      // multi-paint node) — flattening here keeps the caller from caring which.
      const aliases = Array.isArray(entry) ? entry : [entry]
      for (const alias of aliases) {
        const id = (alias as { id?: unknown } | null)?.id
        if (typeof id !== 'string') continue
        const name = await nameFor(id)
        if (!name) continue
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }
  }
  return {
    names,
    usage: [...counts.entries()]
      .map(([token, uses]) => ({ token, uses }))
      .sort((a, b) => b.uses - a.uses || a.token.localeCompare(b.token)),
  }
}


export async function screenshot(node: SceneNode, scale: number): Promise<Uint8Array> {
  return node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } })
}

/** One asset the emitted HTML/CSS actually references — named so a caller can hand `nodeId`
 * straight to `NODE_EXPORT` instead of reverse-engineering it out of `filename` (the failure this
 * op exists to close — see the module note). Derived from the same IR `emitDjango` reads, never
 * by re-parsing the markup. */
export interface ContextAsset {
  /** `static`-relative filename the emitted markup asks for — `img/<this>`. */
  filename: string
  /** Figma node id whose export produces `filename` — the argument `NODE_EXPORT` wants. */
  nodeId: string
  kind: 'raster' | 'vector' | 'video' | 'poster'
  /** Designer `@Nx` export scale; 1 for anything without one (plain leaves, container fills, masks). */
  scale: number
  /** File extension without the dot. */
  format: string
  /** False only when the plugin already knows this can't ship — a video `collectManualAssets`
   * reports as unexportable. `NODE_EXPORT` will fail on `nodeId` the same way; don't retry it. */
  exportable?: false
  reason?: string
}

/** The designer's own export scale for `nodeId` — `resolveExportSettings` is the exact check
 * `serializeNode` uses to decide whether a leaf was routed through `serializeExportedGraphic` at
 * all, so this never guesses a scale for a plain leaf, container fill, or mask, none of which
 * carry one. */
export async function designerScale(nodeId: string, sceneNodesById: ReadonlyMap<string, SceneNode>): Promise<number> {
  const source = sceneNodesById.get(nodeId)
  if (!source) return 1
  const settings = (await resolveExportSettings(
    source as unknown as ExportMarkedInstanceNode
  )) as ReadonlyArray<DesignerExportSetting>
  const primary = primaryDesignerSetting(settings)
  return primary?.constraint?.type === 'SCALE' ? primary.constraint.value : 1
}

/**
 * Every asset the emitted HTML/CSS references, one entry per file, named so `NODE_EXPORT` can be
 * called on `nodeId` directly. Walks the IR after `annotateVectorLeaves`/`annotateVideoFills` have
 * resolved every leaf, so an entry only appears once a real file (or a documented reason it can't
 * exist) backs it — a small inlined vector with no `assetSrc` contributes nothing, since nothing
 * in the markup names a file for it.
 */
export async function collectContextAssets(
  nodes: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, SceneNode>
): Promise<ContextAsset[]> {
  // `collectManualAssets` is the plugin's own "this video will never export" signal — reused
  // rather than re-derived so this list and the export report never disagree.
  const manual = collectManualAssets(nodes)
  const manualReason =
    "Figma's export API already refused this video (see the export report's manualAssets) — " +
    'NODE_EXPORT will fail on this nodeId the same way; the file has to be attached manually.'

  const out: ContextAsset[] = []
  const push = async (nodeId: string, assetSrc: string, kind: ContextAsset['kind'], scale: number): Promise<void> => {
    const filename = assetSrc.replace(/^img\//, '')
    const failing = manual.some((asset) => asset.nodeId === nodeId && asset.assetSrc === assetSrc)
    out.push({
      filename,
      nodeId,
      kind,
      scale,
      format: filename.slice(filename.lastIndexOf('.') + 1),
      ...(failing ? { exportable: false, reason: manualReason } : {}),
    })
  }

  const visit = async (node: IrNode): Promise<void> => {
    if (node.type === 'image') {
      const assetSrc = node.assetSrc ?? imageStaticPath(node)
      const video = isVideoAssetPath(assetSrc)
      await push(node.id, assetSrc, video ? 'video' : 'raster', video ? 1 : await designerScale(node.id, sceneNodesById))
      if (node.posterSrc) await push(node.id, node.posterSrc, 'poster', 1)
      return
    }
    if (node.type === 'vector') {
      if (node.assetSrc) await push(node.id, node.assetSrc, 'vector', await designerScale(node.id, sceneNodesById))
      return
    }
    if (node.type === 'container' || node.type === 'instance-ref') {
      for (const bg of node.backgroundImages ?? []) await push(node.id, bg.assetSrc, 'raster', 1)
      if (node.backgroundVideo) {
        await push(node.id, node.backgroundVideo.assetSrc, 'video', 1)
        await push(node.id, node.backgroundVideo.posterSrc, 'poster', 1)
      }
      if (node.type === 'container' && node.mask?.kind === 'image') {
        await push(node.mask.nodeId, node.mask.assetSrc, 'vector', 1)
      }
      for (const child of node.children) await visit(child)
    }
  }
  for (const node of nodes) await visit(node)
  return out
}
