/**
 * Reads the Figma Motion Plugin API (Beta, Update 127 — see
 * docs/research/02-figma-motion-prototyping-api.md) off a scene node and normalizes it into
 * a `MotionSnapshot`. The API is typed as always-present on `SceneNode` (it's part of
 * `SceneNodeMixin`), but as an Open Beta it can still be absent or throw at runtime on older
 * Figma builds — every accessor below is `'in'`-guarded and the whole read is wrapped in
 * try/catch so a Motion read failure degrades to `null` instead of breaking extraction.
 */

import { MOTION_PROPERTY_ALLOWLIST, type MotionSnapshot, type MotionTrack } from './types.ts'

function hasMotionApi(node: SceneNode): boolean {
  return (
    'animations' in node &&
    'timelines' in node &&
    'animationStyles' in node &&
    'manualKeyframeTracks' in node
  )
}

/** Warns and skips indexed fills/strokes/effects tracks Figma reports as `SHADER` — shader
 * sub-properties aren't part of the 30-property scalar allowlist this adapter snapshots. */
function warnOnShaderTracks(indexedTracks: Partial<Record<number, unknown>> | undefined, paintsOrEffects: unknown): void {
  if (!indexedTracks || !Array.isArray(paintsOrEffects)) return
  for (const indexKey of Object.keys(indexedTracks)) {
    const type = (paintsOrEffects[Number(indexKey)] as { type?: string } | undefined)?.type
    if (type === 'SHADER') {
      console.warn('[motion] skipping shader/unknown track:', type)
    }
  }
}

export function readMotionData(node: SceneNode): MotionSnapshot | null {
  if (!hasMotionApi(node)) return null

  try {
    const manualTracks = node.manualKeyframeTracks
    const animations = node.animations

    const tracks: MotionTrack[] = []
    for (const field of MOTION_PROPERTY_ALLOWLIST) {
      const binding = manualTracks?.[field]
      if (!binding) continue
      tracks.push({
        field,
        baseValue: binding.baseValue,
        timelineDuration: animations?.[field]?.timelineDuration ?? 0,
        keyframes: binding.keyframes.map((keyframe) => ({
          id: keyframe.id,
          timelinePosition: keyframe.timelinePosition,
          easing: keyframe.easing,
          value: keyframe.value,
        })),
      })
    }

    warnOnShaderTracks(manualTracks?.fills, 'fills' in node ? node.fills : undefined)
    warnOnShaderTracks(manualTracks?.strokes, 'strokes' in node ? node.strokes : undefined)
    warnOnShaderTracks(manualTracks?.effects, 'effects' in node ? node.effects : undefined)

    return {
      animationStyles: node.animationStyles ?? [],
      timelines: node.timelines ?? [],
      tracks,
    }
  } catch (error) {
    console.warn('[motion] failed to read motion data, skipping node:', node.id, error)
    return null
  }
}
