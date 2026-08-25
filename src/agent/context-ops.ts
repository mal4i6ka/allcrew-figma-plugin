/**
 * Agent listener — design context.
 *
 * The export pipeline in `src/targets` already turns a Figma subtree into HTML and CSS that
 * speak in token references rather than raw hex. It was only ever reachable from the plugin's
 * own UI, which meant a CLI agent could read a file in detail and still had nothing to
 * implement *from*. These two ops are the bridge to it.
 *
 * What makes this worth having next to Figma's own design-context tool is the token layer: a
 * generic exporter reports the colour it found, `#F2F4F5`, while this one reports the variable
 * that produced it, `colors/neutral/100`, because it reads `boundVariables` on the way past.
 * An agent generating code from the first has to guess which token to use; from the second it
 * does not have to guess at all.
 *
 * Both ops return *paths*, never payloads — see `files.ts` for why.
 */

import { emitDjango } from '../targets/django/index.ts'
import { pickBackend, type MotionTrigger } from '../targets/django/motion/backend.ts'
import { readMotionData } from '../targets/django/motion/beta-adapter.ts'
import { emitMotionExportArtifacts, type MotionExportNode } from '../targets/django/motion/export-assets.ts'
import type { MotionTrack } from '../targets/django/motion/types.ts'
import { serializeNode, type IrNode } from '../targets/django/ir.ts'
import { annotateVectorLeaves, type AssetSourceNode } from '../targets/django/export/assets.ts'
import { findAllWithCriteria } from '../utils/tree.ts'
import { readAllVariables } from '../variables.ts'
import { binaryFile, slugify, textFile } from './files.ts'
import type { OpDef } from './protocol.ts'

/* ----------------------------------------------------------------- helpers */

async function resolveSceneNode(ref: unknown): Promise<SceneNode> {
  if (typeof ref !== 'string' || ref === '') throw new Error('nodeId must be a non-empty string')
  const node = await figma.getNodeByIdAsync(ref)
  if (!node) throw new Error(`no node with id ${ref}`)
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error(`${ref} is a ${node.type}, not a layer`)
  return node as SceneNode
}

/** Lifted from the plugin UI's own export path so the agent walks the identical tree. */
async function indexSceneNodes(roots: readonly SceneNode[]): Promise<Map<string, SceneNode>> {
  const index = new Map<string, SceneNode>()
  for (const root of roots) {
    index.set(root.id, root)
    for (const node of await findAllWithCriteria(root, (candidate): candidate is SceneNode => true)) {
      index.set(node.id, node)
    }
  }
  return index
}

/**
 * Every variable the subtree actually binds, by token name and how often. This is the half a
 * screenshot cannot carry: it tells a generating agent which tokens are in play before it
 * writes a single declaration, and — because the count is there — which of them carry the
 * design and which appear once.
 */
async function tokenUsage(nodes: Iterable<SceneNode>): Promise<Array<{ token: string; uses: number }>> {
  const counts = new Map<string, number>()
  const names = new Map<string, string | null>()

  const nameFor = async (id: string): Promise<string | null> => {
    if (!names.has(id)) {
      try {
        const variable = await figma.variables.getVariableByIdAsync(id)
        names.set(id, variable?.name ?? null)
      } catch {
        names.set(id, null)
      }
    }
    return names.get(id) ?? null
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
  return [...counts.entries()]
    .map(([token, uses]) => ({ token, uses }))
    .sort((a, b) => b.uses - a.uses || a.token.localeCompare(b.token))
}

/** Figma's Motion API is a beta that is simply absent for most accounts. Saying so beats
 * answering "no animations" for a file full of them. */
function hasMotionApi(): boolean {
  return Boolean((figma as unknown as { motion?: unknown }).motion)
}

/**
 * An easing reads back as a Figma object, and when it is bound to a variable it reads back as
 * an alias with an id and nothing else. Resolving the name here keeps the op's promise: this
 * channel reports the token, not the number it happened to resolve to.
 */
async function describeEasing(easing: MotionTrack['keyframes'][number]['easing']): Promise<unknown> {
  if ((easing as { type?: string }).type !== 'VARIABLE_ALIAS') return easing
  const id = (easing as unknown as { id?: unknown }).id
  if (typeof id !== 'string') return easing
  try {
    const variable = await figma.variables.getVariableByIdAsync(id)
    return { type: 'VARIABLE_ALIAS', token: variable?.name ?? id }
  } catch {
    return easing
  }
}

async function screenshot(node: SceneNode, scale: number): Promise<Uint8Array> {
  return node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } })
}

/* --------------------------------------------------------------------- ops */

export const CONTEXT_OPS: readonly OpDef[] = [
  {
    name: 'node.screenshot',
    summary: 'Render a node to PNG — the one way an agent can check what it actually drew.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Layer to render.' },
      scale: { type: 'number', default: 1, min: 0.1, max: 4, description: 'Export scale. 2 for retina.' },
    },
    async run(params) {
      const node = await resolveSceneNode(params.nodeId)
      const scale = params.scale as number
      const bytes = await screenshot(node, scale)
      return {
        node: { id: node.id, name: node.name, type: node.type, width: node.width, height: node.height },
        scale,
        bytes: bytes.length,
        file: binaryFile(`${slugify(node.name)}.png`, 'image/png', bytes),
      }
    },
  },

  {
    name: 'design.context',
    summary: 'Reference HTML + CSS + PNG for a node, with the tokens it binds — implement from this.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Frame or component to describe.' },
      cssFile: { type: 'string', default: 'design.css', description: 'Name the emitted HTML links to.' },
      screenshot: { type: 'boolean', default: true, description: 'Also render a PNG reference.' },
      scale: { type: 'number', default: 1, min: 0.1, max: 4, description: 'Screenshot scale.' },
    },
    async run(params) {
      const root = await resolveSceneNode(params.nodeId)
      // `documentAccess: "dynamic-page"` — the node's page has to be loaded before its subtree
      // can be walked, and a node handed over by id may live on a page nobody has opened.
      const page = (() => {
        let parent: BaseNode | null = root.parent
        while (parent && parent.type !== 'PAGE') parent = parent.parent
        return parent as PageNode | null
      })()
      if (page) await page.loadAsync()

      const roots = [root]
      const [ir, sceneNodesById, snapshot] = await Promise.all([
        serializeNode(root),
        indexSceneNodes(roots),
        readAllVariables(),
      ])
      if (!ir) throw new Error(`"${root.name}" (${root.type}) produced no exportable structure`)

      const nodes: readonly IrNode[] = [ir]
      const variableNamesById = new Map(snapshot.variables.map((variable) => [variable.id, variable.name]))
      await annotateVectorLeaves(nodes, sceneNodesById as unknown as ReadonlyMap<string, AssetSourceNode>)

      const cssFile = params.cssFile as string
      const { html, css } = await emitDjango(nodes, sceneNodesById, variableNamesById, { cssFile })

      const slug = slugify(root.name)
      const files: unknown[] = [
        textFile(`${slug}.html`, 'text/html', html),
        textFile(`${slug}.css`, 'text/css', css),
      ]
      if (params.screenshot !== false) {
        files.push(binaryFile(`${slug}.png`, 'image/png', await screenshot(root, params.scale as number)))
      }

      return {
        node: { id: root.id, name: root.name, type: root.type, width: root.width, height: root.height },
        layers: sceneNodesById.size,
        tokens: await tokenUsage(sceneNodesById.values()),
        files,
      }
    },
  },
  {
    name: 'motion.context',
    summary: 'Keyframe tracks, the CSS/GSAP they compile to, and which backend fits — for a subtree.',
    mutates: false,
    params: {
      nodeId: { type: 'string', required: true, description: 'Root to scan for animated layers.' },
      trigger: {
        type: 'string',
        default: 'autoplay',
        enum: ['autoplay', 'loop', 'hover', 'scrub', 'replay', 'click', 'other-interactive'],
        description: 'How the timeline is meant to start. Changes which backend fits.',
      },
      keyframes: { type: 'boolean', default: true, description: 'Include per-keyframe detail, not just counts.' },
    },
    async run(params) {
      if (!hasMotionApi()) {
        // Not an error: the file may be fine and the account simply lacks the beta. An agent
        // needs to tell "nothing animates here" apart from "I cannot see animation at all".
        return {
          available: false,
          reason: 'this Figma build exposes no Motion API — the beta is not enabled for this account',
          animated: [],
        }
      }

      const root = await resolveSceneNode(params.nodeId)
      const sceneNodesById = await indexSceneNodes([root])

      const motionNodes: MotionExportNode[] = []
      for (const node of sceneNodesById.values()) {
        const snapshot = readMotionData(node)
        if (snapshot && snapshot.tracks.length > 0) motionNodes.push({ nodeId: node.id, snapshot })
      }

      if (motionNodes.length === 0) {
        return { available: true, scanned: sceneNodesById.size, animated: [], files: [] }
      }

      const trigger = params.trigger as MotionTrigger
      const wantKeyframes = params.keyframes !== false

      const animated = []
      for (const entry of motionNodes) {
        const node = sceneNodesById.get(entry.nodeId)
        const tracks = entry.snapshot.tracks
        // Per node rather than per timeline: the same question ("CSS or GSAP, and why") is what
        // the export asks, and answering it here means an agent sees the reasoning instead of
        // just the output it produced.
        const decision = pickBackend({ tracks, nodeCount: 1, trigger })
        animated.push({
          nodeId: entry.nodeId,
          name: node?.name ?? entry.nodeId,
          type: node?.type ?? null,
          timelines: entry.snapshot.timelines.length,
          backend: decision.backend,
          reason: decision.reason,
          tracks: await Promise.all(
            tracks.map(async (track) => ({
              field: track.field,
              duration: track.timelineDuration,
              keyframes: wantKeyframes
                ? await Promise.all(
                    track.keyframes.map(async (frame) => ({
                      at: frame.timelinePosition,
                      easing: await describeEasing(frame.easing),
                      value: frame.value,
                    }))
                  )
                : track.keyframes.length,
            }))
          ),
        })
      }

      const { animation } = emitMotionExportArtifacts(motionNodes)
      const files: unknown[] = []
      if (animation.css) files.push(textFile('animations.css', 'text/css', animation.css))
      if (animation.js) files.push(textFile('animations.js', 'text/javascript', animation.js))

      return {
        available: true,
        scanned: sceneNodesById.size,
        animated,
        gsapPlugins: animation.gsapPlugins,
        files,
      }
    },
  },
]
