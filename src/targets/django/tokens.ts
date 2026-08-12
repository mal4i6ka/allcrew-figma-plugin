/**
 * Naming + motion-token helpers shared by the CSS emitter and the export pipeline.
 *
 * REFORM phase 3: the tokens.css / tokens.json emission moved to the ported engine in
 * `src/tokens/` (docs/REFORM.md §3) — this module keeps only what the rest of the code
 * still needs: the `var(--…)` naming contract (`toCssVarName`, used by
 * src/django/css-emitter.ts for bound-variable references — the engine's `varName`
 * matches it), color rendering, and the GSAP-facing motion-token emitter.
 */

import type { VariableEntry, VariableSnapshot } from '../../variables.ts'

function isVariableAlias(value: VariableValue | undefined): value is VariableAlias {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'VARIABLE_ALIAS'
}

function isRgbColor(value: unknown): value is RGB | RGBA {
  return typeof value === 'object' && value !== null && 'r' in value && 'g' in value && 'b' in value
}

function kebabSegment(segment: string): string {
  return segment.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '')
}

/** Figma group path (`color/bg/primary`) -> CSS custom property name (`--color-bg-primary`).
 * The naming contract between project.css references and tokens.css definitions — keep in
 * sync with `varName` (src/tokens/engine.ts). */
export function toCssVarName(figmaName: string): string {
  return '--' + figmaName.split('/').map(kebabSegment).join('-')
}

/** Figma group path (`color/bg/primary`) -> DTCG dotted path segments (`["color", "bg", "primary"]`). */
export function toDtcgPath(figmaName: string): string[] {
  return figmaName.split('/').map(kebabSegment)
}

function channelToHex(channel: number): string {
  return Math.round(channel * 255).toString(16).padStart(2, '0')
}

/** RGBA (components 0..1) -> `#rrggbb` when opaque, otherwise CSS Color 4 `rgb(r g b / a)`. */
export function rgbaToCss(color: RGB | RGBA): string {
  const alpha = 'a' in color ? color.a : 1
  if (alpha === 1) {
    return `#${channelToHex(color.r)}${channelToHex(color.g)}${channelToHex(color.b)}`
  }
  const to255 = (channel: number) => Math.round(channel * 255)
  return `rgb(${to255(color.r)} ${to255(color.g)} ${to255(color.b)} / ${+alpha.toFixed(4)})`
}

/** Convention (docs/research/06-motion-to-gsap-tokens.md §3.2): FLOAT ms values under this prefix. */
const MOTION_DURATION_PREFIX = 'motion/duration/'
/** Convention: STRING CSS timing-function values (e.g. `cubic-bezier(...)`) under this prefix. */
const MOTION_EASING_PREFIX = 'motion/easing/'

function literalValue(variable: VariableEntry, value: VariableValue): string | number | boolean {
  if (variable.resolvedType === 'COLOR' && isRgbColor(value)) return rgbaToCss(value)
  return value as string | number | boolean
}

/** Figma group path (`motion/duration/short`) -> camelCase JS identifier (`motionDurationShort`). */
function toCamelCaseName(figmaName: string): string {
  return toDtcgPath(figmaName).join('-').replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase())
}

function resolveLiteralValue(
  variable: VariableEntry,
  modeId: string,
  variablesById: Map<string, VariableEntry>,
  visited: Set<string> = new Set()
): string | number | boolean {
  if (visited.has(variable.id)) throw new Error(`Circular variable alias detected at "${variable.name}"`)
  visited.add(variable.id)

  const value = variable.valuesByMode[modeId]
  if (value === undefined) throw new Error(`Missing value for mode "${modeId}" on "${variable.name}"`)
  if (isVariableAlias(value)) {
    const target = variablesById.get(value.id)
    if (!target) throw new Error(`Broken alias: ${value.id}`)
    return resolveLiteralValue(target, modeId, variablesById, visited)
  }
  return literalValue(variable, value)
}

/**
 * Emits `tokens.js`: mirrors `motion/duration/*` (converted to seconds — GSAP's native unit)
 * and `motion/easing/*` (raw CSS timing-function string) from each collection's first mode
 * (Figma's default mode). Aliases resolve to their target's literal value, since GSAP code
 * needs concrete numbers/strings rather than a `var()` reference.
 */
export function emitMotionTokensJs(snapshot: VariableSnapshot): string {
  const variablesById = new Map(snapshot.variables.map((variable) => [variable.id, variable]))
  const lines: string[] = []

  for (const collection of snapshot.collections) {
    const modeId = collection.modes[0]?.modeId
    if (!modeId) continue

    for (const variable of snapshot.variables.filter((v) => v.collectionId === collection.id)) {
      if (variable.valuesByMode[modeId] === undefined) continue

      if (variable.resolvedType === 'FLOAT' && variable.name.startsWith(MOTION_DURATION_PREFIX)) {
        const ms = resolveLiteralValue(variable, modeId, variablesById) as number
        lines.push(`export const ${toCamelCaseName(variable.name)} = ${ms / 1000};`)
      } else if (variable.resolvedType === 'STRING' && variable.name.startsWith(MOTION_EASING_PREFIX)) {
        const css = resolveLiteralValue(variable, modeId, variablesById) as string
        lines.push(`export const ${toCamelCaseName(variable.name)} = ${JSON.stringify(css)};`)
      }
    }
  }

  return lines.join('\n')
}
