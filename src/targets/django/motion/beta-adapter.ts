/**
 * Reads the Figma Motion Plugin API (Beta, Update 127 — see
 * docs/research/02-figma-motion-prototyping-api.md) off a scene node and normalizes it into
 * a `MotionSnapshot`. The API is typed as always-present on `SceneNode` (it's part of
 * `SceneNodeMixin`), but as an Open Beta it can still be absent or throw at runtime on older
 * Figma builds — every accessor below is `'in'`-guarded and the whole read is wrapped in
 * try/catch so a Motion read failure degrades to `null` instead of breaking extraction.
 */

import { MOTION_PROPERTY_ALLOWLIST, type MotionSnapshot, type MotionStaticTransform3d, type MotionTrack } from './types.ts'

function hasMotionApi(node: SceneNode): boolean {
  return (
    'animations' in node &&
    'timelines' in node &&
    'animationStyles' in node &&
    'manualKeyframeTracks' in node
  )
}

/** Warns and skips indexed fills/strokes/effects tracks Figma reports as `SHADER` — shader
 * sub-properties aren't part of the 35-property scalar allowlist this adapter snapshots. */
function warnOnShaderTracks(indexedTracks: Partial<Record<number, unknown>> | undefined, paintsOrEffects: unknown): void {
  if (!indexedTracks || !Array.isArray(paintsOrEffects)) return
  for (const indexKey of Object.keys(indexedTracks)) {
    const type = (paintsOrEffects[Number(indexKey)] as { type?: string } | undefined)?.type
    if (type === 'SHADER') {
      console.warn('[motion] skipping shader/unknown track:', type)
    }
  }
}

/**
 * The node's static 3D transform, for the composite `transform` a 3D track is emitted into.
 * Only `FIXED_ORDER` carries numbers: `NONE` has none, and `FREEFORM` (an imported transform)
 * reads back without them — nothing is invented for either.
 */
function readStaticTransform3d(node: SceneNode): MotionStaticTransform3d | undefined {
  if (!('transform3d' in node)) return undefined
  const held = (node as { transform3d?: Transform3d }).transform3d
  if (!held || held.type !== 'FIXED_ORDER') return undefined
  return { translateZ: held.translateZ, rotateX: held.rotateX, rotateY: held.rotateY, rotateZ: held.rotateZ }
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

    const transform3d = readStaticTransform3d(node)
    return {
      animationStyles: node.animationStyles ?? [],
      timelines: node.timelines ?? [],
      tracks,
      ...(transform3d ? { transform3d } : {}),
    }
  } catch (error) {
    console.warn('[motion] failed to read motion data, skipping node:', node.id, error)
    return null
  }
}
