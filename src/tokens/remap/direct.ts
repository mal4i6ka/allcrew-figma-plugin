import type { Rgba } from './color-literal.ts'
import { deltaE } from './match.ts'
import type { ColorSite, RemapEntry, RemapPlan } from './plan.ts'
import { parseTokenName } from './token-name.ts'

export interface DirectColorReplacementRequest {
  sites: readonly ColorSite[]
  from: Rgba
  to: Rgba
}

const sameRgb = (a: Rgba, b: Rgba): boolean =>
  Math.abs(a.r - b.r) < 1 / 512 && Math.abs(a.g - b.g) < 1 / 512 && Math.abs(a.b - b.b) < 1 / 512

/**
 * Builds an exact RGB find/replace plan. Alpha belongs to the usage site and is preserved.
 * No family matching, renaming, adjacency correction, or variable binding is involved.
 */
export function buildDirectColorReplacement(request: DirectColorReplacementRequest): RemapPlan {
  const entries: RemapEntry[] = []

  for (const site of request.sites) {
    if (!sameRgb(site.rgba, request.from)) continue
    const parsed = parseTokenName(site.name)
    const to = { r: request.to.r, g: request.to.g, b: request.to.b, a: site.rgba.a }
    const flags: RemapEntry['flags'] = ['manual']
    if (!site.editable) flags.push('library')
    if (sameRgb(site.rgba, to)) flags.push('unchanged')

    entries.push({
      site,
      from: site.rgba,
      to,
      toName: null,
      toVariableKey: null,
      fromFamily: parsed.family,
      toFamily: null,
      fromStep: parsed.step,
      toStep: null,
      via: 'nearest',
      deltaE: deltaE(site.rgba, to),
      flags,
    })
  }

  const warnings: string[] = []
  if (entries.length === 0) warnings.push('No exact RGB matches were found in the selected scope.')

  const libraryNames = new Set(
    entries.filter((entry) => entry.flags.includes('library')).map((entry) => entry.site.name)
  )
  if (libraryNames.size > 0) {
    warnings.push(
      `${libraryNames.size} ${libraryNames.size === 1 ? 'token comes' : 'tokens come'} from a library and cannot be written from this file.`
    )
  }

  return { entries, renames: [], families: [], unusedFamilies: [], warnings }
}
