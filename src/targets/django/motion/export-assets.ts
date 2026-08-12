/**
 * M10 export assembly: turns normalized Motion snapshots into the concrete static files the
 * Django export ships. The beta adapter owns API reads; this module only groups tracks by
 * timeline, delegates CSS-vs-GSAP policy to `pickBackend`, and calls the existing emitters.
 */

import { toClassName } from '../css-emitter.ts'
import { pickBackend } from './backend.ts'
import { emitNodeAnimationCss } from './css-emitter.ts'
import { emitGsapTimeline, type GsapPluginName, type GsapTimelineNode } from './gsap-emitter.ts'
import type { MotionSnapshot, MotionTimeline, MotionTrack } from './types.ts'

export interface MotionExportNode {
  readonly nodeId: string
  readonly snapshot: MotionSnapshot
}

export interface MotionAnimationOutput {
  readonly css: string
  readonly js: string
  readonly gsapPlugins: readonly GsapPluginName[]
}

export interface MotionAnimationLinks {
  readonly animationsCss: boolean
  readonly animationsJs: boolean
  readonly gsapPlugins: readonly GsapPluginName[]
}

export interface MotionExportArtifacts {
  readonly animation: MotionAnimationOutput
  readonly animationLinks: MotionAnimationLinks
}

export const EMPTY_MOTION_EXPORT_ARTIFACTS: MotionExportArtifacts = {
  animation: { css: '', js: '', gsapPlugins: [] },
  animationLinks: { animationsCss: false, animationsJs: false, gsapPlugins: [] },
}

interface TimelineNodeTracks {
  readonly nodeId: string
  readonly tracks: MotionTrack[]
}

interface TimelineGroup {
  readonly id: string
  duration: number
  readonly nodes: Map<string, TimelineNodeTracks>
}

const DURATION_EPSILON = 0.0001

function sameDuration(a: number, b: number): boolean {
  return Math.abs(a - b) <= DURATION_EPSILON
}

function syntheticTimeline(track: MotionTrack): MotionTimeline {
  return {
    id: `timeline-${String(track.timelineDuration).replace(/[^a-zA-Z0-9_-]+/g, '-') || '0'}`,
    duration: track.timelineDuration,
  } as MotionTimeline
}

function timelineForTrack(nodeId: string, snapshot: MotionSnapshot, track: MotionTrack): MotionTimeline | null {
  if (snapshot.timelines.length === 0) return syntheticTimeline(track)

  const durationMatch = snapshot.timelines.find((timeline) => sameDuration(timeline.duration, track.timelineDuration))
  if (durationMatch) return durationMatch

  if (snapshot.timelines.length === 1) return snapshot.timelines[0]

  console.warn(
    `[motion] node "${nodeId}" has multiple timelines but track "${track.field}" has no timeline id; skipping ambiguous track`
  )
  return null
}

function groupTimelines(nodes: readonly MotionExportNode[]): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>()

  for (const node of nodes) {
    for (const track of node.snapshot.tracks) {
      const timeline = timelineForTrack(node.nodeId, node.snapshot, track)
      if (!timeline) continue

      const group =
        groups.get(timeline.id) ??
        {
          id: timeline.id,
          duration: timeline.duration,
          nodes: new Map<string, TimelineNodeTracks>(),
        }
      if (!groups.has(timeline.id)) groups.set(timeline.id, group)

      if (group.duration <= 0 && track.timelineDuration > 0) group.duration = track.timelineDuration
      const nodeTracks = group.nodes.get(node.nodeId) ?? { nodeId: node.nodeId, tracks: [] }
      nodeTracks.tracks.push(track)
      group.nodes.set(node.nodeId, nodeTracks)
    }
  }

  return [...groups.values()]
}

function cssIdentPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'motion'
}

function nodeSelector(nodeId: string): string {
  return `.${toClassName(nodeId)}`
}

function animationName(nodeId: string, timelineId: string, track: MotionTrack): string {
  return `${toClassName(nodeId)}-${cssIdentPart(timelineId)}-${track.field.toLowerCase().replace(/_/g, '-')}`
}

function isCssTrackSupported(selector: string, timelineId: string, nodeId: string, track: MotionTrack): boolean {
  try {
    emitNodeAnimationCss({
      selector,
      tracks: [track],
      nameForTrack: () => animationName(nodeId, timelineId, track),
    })
    return true
  } catch (error) {
    console.warn(`[motion] skipping unsupported CSS animation track "${track.field}" on node "${nodeId}"`, error)
    return false
  }
}

function emitCssTimeline(group: TimelineGroup): string {
  const blocks: string[] = []

  for (const node of group.nodes.values()) {
    const selector = nodeSelector(node.nodeId)
    const tracks = node.tracks.filter((track) => isCssTrackSupported(selector, group.id, node.nodeId, track))
    if (tracks.length === 0) continue

    blocks.push(
      emitNodeAnimationCss({
        selector,
        tracks,
        nameForTrack: (track) => animationName(node.nodeId, group.id, track),
      })
    )
  }

  return blocks.join('\n\n')
}

function emitGsapTimelineGroup(group: TimelineGroup): { js: string; usedPlugins: readonly GsapPluginName[] } {
  const nodes: GsapTimelineNode[] = [...group.nodes.values()].map((node) => ({
    nodeId: node.nodeId,
    selector: nodeSelector(node.nodeId),
    tracks: node.tracks,
  }))
  return emitGsapTimeline({ timelineId: group.id, duration: group.duration, nodes })
}

export function emitMotionExportArtifacts(nodes: readonly MotionExportNode[]): MotionExportArtifacts {
  const cssBlocks: string[] = []
  const jsBlocks: string[] = []
  const usedPlugins = new Set<GsapPluginName>()

  for (const group of groupTimelines(nodes)) {
    const nodeTracks = [...group.nodes.values()]
    const tracks = nodeTracks.flatMap((node) => node.tracks)
    if (tracks.length === 0) continue

    const decision = pickBackend({ tracks, nodeCount: nodeTracks.length, trigger: 'autoplay' })
    if (decision.backend === 'css') {
      const css = emitCssTimeline(group)
      if (css) cssBlocks.push(css)
      continue
    }

    try {
      const result = emitGsapTimelineGroup(group)
      if (result.js.trim()) jsBlocks.push(result.js)
      result.usedPlugins.forEach((plugin) => usedPlugins.add(plugin))
    } catch (error) {
      console.warn(`[motion] failed to emit GSAP timeline "${group.id}", skipping`, error)
    }
  }

  const animation: MotionAnimationOutput = {
    css: cssBlocks.join('\n\n'),
    js: jsBlocks.join('\n\n'),
    gsapPlugins: [...usedPlugins],
  }
  return {
    animation,
    animationLinks: {
      animationsCss: animation.css.length > 0,
      animationsJs: animation.js.length > 0,
      gsapPlugins: animation.gsapPlugins,
    },
  }
}
