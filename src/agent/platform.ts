/**
 * Agent listener — what one Figma pixel is, on the platform that is going to build this.
 *
 * Everything in the IR is raw Figma pixels. For a 1× artboard that is also one CSS pixel, one
 * iOS point and one Android dp, and the tree needs no annotation at all. For an artboard a
 * designer drew at 2× or 3× — still common, and invisible in the data — every single number in
 * the tree is two or three times what the build should emit. Nothing in `design.ir` declared the
 * reference density, so a generator had no way to notice, and the failure mode is a screen that
 * is correct in proportion and twice the size.
 *
 * The other half is which unit the numbers land in. `px`, `pt` and `dp` are interchangeable at 1×,
 * but Android measures TEXT in `sp` so the system font-size setting reaches it, and a build that
 * emits `dp` for a font size has shipped the most common accessibility defect on the platform.
 * That distinction belongs next to the numbers, not in a generator's memory.
 *
 * The density is DERIVED FROM EVIDENCE and says what the evidence was. A frame 750 points wide
 * matches no iPhone; 750/2 = 375 matches several, so the answer is `scale: 2` with the match
 * named. A frame that matches nothing gets `scale: 1` and `basis: 'unmatched'` — this file does
 * not guess, for the same reason `screenSummary` refuses to invent a safe-area inset.
 */

export type Platform = 'web' | 'ios' | 'android'

export interface UnitProfile {
  platform: Platform
  /** The unit a length in this profile is measured in once divided by `scale`. */
  unit: 'px' | 'pt' | 'dp'
  /** The unit a TEXT size is measured in. Differs from `unit` on Android only, and that
   * difference is the whole reason this field exists. */
  textUnit: 'px' | 'pt' | 'sp'
  /**
   * Figma pixels per platform unit. Divide every length in the tree by this before emitting it.
   * 1 means the tree is already in platform units.
   */
  scale: number
  /** What `scale` was concluded from, in words. Never omitted: a scale a build cannot audit is
   * a scale it should not trust. */
  basis: string
  /** The densities this platform wants raster assets at — the `scales` to hand `assets.export`. */
  assetScales: readonly number[]
  /** The `naming` value `assets.export` should be called with for this platform. */
  assetNaming: 'web' | 'ios' | 'android'
}

/**
 * Logical widths the platforms actually ship, in their own units.
 *
 * Written out rather than computed: there is no formula, they are a list of devices, and a
 * range test would match a 2× artboard as readily as a 1× one, which is exactly the confusion
 * this is here to resolve.
 */
const LOGICAL_WIDTHS: Readonly<Record<Platform, readonly number[]>> = {
  // iPhone SE through Pro Max, then iPad mini through Pro 12.9 in points.
  ios: [320, 375, 390, 393, 402, 414, 428, 430, 440, 744, 768, 810, 820, 834, 1024, 1032, 1210],
  // Compose's own reference widths plus the common vendor ones, in dp.
  android: [360, 384, 392, 393, 400, 411, 412, 432, 448, 600, 672, 800, 840, 1280],
  // The breakpoint widths this plugin already uses when a file declares none
  // (`breakpoint-frames.ts` NAMED_WIDTHS), plus the phone widths a responsive design starts at.
  web: [320, 360, 375, 390, 414, 768, 1024, 1280, 1440, 1536, 1920],
}

/** Density factors each platform asks for. Android's buckets are the ones `assetPath` already
 * maps to `drawable-<bucket>`; anything else there falls back to `drawable-nodpi`. */
const ASSET_SCALES: Readonly<Record<Platform, readonly number[]>> = {
  ios: [1, 2, 3],
  android: [1, 1.5, 2, 3, 4],
  web: [1, 2],
}

const UNITS: Readonly<Record<Platform, { unit: UnitProfile['unit']; textUnit: UnitProfile['textUnit'] }>> = {
  ios: { unit: 'pt', textUnit: 'pt' },
  android: { unit: 'dp', textUnit: 'sp' },
  web: { unit: 'px', textUnit: 'px' },
}

/** Densities worth testing, in the order a designer is likely to have used them. 1 first so an
 * artboard that is already logical is never reported as a coincidental 2×. */
const CANDIDATE_SCALES: readonly number[] = [1, 2, 3]

/** Half a point of slack: a designer's 393.5 is a 393 frame, not a mystery. */
const WIDTH_TOLERANCE = 0.5

export function isPlatform(value: unknown): value is Platform {
  return value === 'web' || value === 'ios' || value === 'android'
}

/**
 * The unit profile for a platform, given the frame the caller is describing.
 *
 * `width` is the root frame's own width in Figma pixels. Absent (or zero) means no evidence, so
 * the profile is 1× and says so — a component read on its own has no artboard to reason from and
 * must not be treated as if it did.
 */
export function unitProfile(platform: Platform, width?: number): UnitProfile {
  const { unit, textUnit } = UNITS[platform]
  const base = {
    platform,
    unit,
    textUnit,
    assetScales: ASSET_SCALES[platform],
    assetNaming: platform,
  } as const

  const measured = typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 0
  if (measured === 0) {
    return { ...base, scale: 1, basis: 'no frame width to reason from — treated as 1×' }
  }

  for (const scale of CANDIDATE_SCALES) {
    const logical = measured / scale
    const match = LOGICAL_WIDTHS[platform].find((candidate) => Math.abs(candidate - logical) <= WIDTH_TOLERANCE)
    if (match === undefined) continue
    if (scale === 1) {
      return { ...base, scale: 1, basis: `${measured}px matches a ${match}${unit} ${platform} width` }
    }
    return {
      ...base,
      scale,
      basis: `${measured}px is ${scale}× a ${match}${unit} ${platform} width — divide every length by ${scale}`,
    }
  }

  return {
    ...base,
    scale: 1,
    basis: `${measured}px matches no standard ${platform} width — treated as 1×, check the artboard`,
  }
}
