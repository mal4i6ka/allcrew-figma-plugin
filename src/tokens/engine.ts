/**
 * Canonical token engine — a TypeScript port of allcrew-channel code.js pure functions.
 * Dependency-free, figma-global-free, Node-testable.
 *
 * Feeds from a VariableSnapshot (src/variables.ts) and emits:
 *   - W3C/DTCG token tree (lossless, all modes)
 *   - tokens.css (themed CSS custom properties)
 *   - tokens.json (canonical tree)
 *   - tokens.ts (typed var refs + theme list)
 *   - Per-theme .module.css files
 *   - README.md
 *
 * Also includes text style extraction (typography scale) and breakpoint token extraction.
 */

import { isRecord } from '../utils/type-guards.ts'
import { easingToCss, resolveSpringBounce, springToCssLinear } from '../targets/django/easing/index.ts'
import { toNativeFiles } from './native.ts'
import { sourceColorCss, sourceColorOf } from './color.ts'
import { cellKey, foldThemeSources, normalizeThemeAxesSpec, orderAxes, type ThemeAxesSpec, type ThemeAxis } from './theme-axes.ts'
import { cellName, deriveLegacy, materializeStructure, normalizeStructure, type ExportStructure, type Materialized } from './structure.ts'

/* ------------------------------------------------------------------ types */

export interface TokenGraphCollection {
  id: string
  name: string
  defaultModeId?: string
  modes: Array<{ modeId: string; name: string }>
  generated?: boolean
  /** Reached only because a token here aliases it — a library collection fetched by id. Its
   * values are substituted into the tokens that point at it and it is never emitted itself:
   * the file consumes it, it does not own it. */
  inlineOnly?: boolean
  /** A product's own collection while its package is built: it claims token names first, so a
   * base collection's same-named token is the one that yields. */
  product?: boolean
  /** Never emitted (the designer hid it), so it claims token names last: a hidden `One` must not
   * push the theme collection's `background/base` to `-2`. Ordering only — unlike `inlineOnly`,
   * a value reached through it still counts as reached through the file's own layer. */
  yields?: boolean
}

export interface TokenGraphVariable {
  id: string
  name: string
  collectionId: string
  resolvedType: string
  valuesByMode: { [modeId: string]: unknown }
  /** Figma variable scopes (`FRAME_FILL`, `TEXT_FILL`, `CORNER_RADIUS`, …). The designer's own
   * statement of where the token may be applied — authoritative for DESIGN.md's "apply to"
   * column, which otherwise has to guess from the name, and for `tokenKind`, which otherwise has
   * to guess the unit from it. Absent on older snapshots. */
  scopes?: readonly string[]
  /** Per-platform names the design system already committed to, straight off Figma's
   * `Variable.codeSyntax`. A generator that reads this stops inventing its own spelling. */
  codeSyntax?: { WEB?: string; ANDROID?: string; iOS?: string }
}

export interface TokenGraph {
  fileName?: string
  collections: readonly TokenGraphCollection[]
  variables: readonly TokenGraphVariable[]
  textStyles?: readonly TokenGraphTextStyle[]
  effectStyles?: readonly TokenGraphEffectStyle[]
}

/** A Figma effect style (`Focus/Default`, `Elevation/Card`, …) — shadows and blurs, the layer of a
 * design system that lives in styles rather than variables and would otherwise never reach code. */
export interface TokenGraphEffectStyle {
  id: string
  name: string
  effects: readonly TokenGraphEffect[]
}

export interface TokenGraphEffect {
  type: string
  color?: { r: number; g: number; b: number; a?: number } | null
  offset?: { x: number; y: number } | null
  radius?: number
  spread?: number
  visible?: boolean
}

export interface TokenGraphTextStyle {
  id: string
  name: string
  fontName?: { family: string; style: string; variationSettings?: Record<string, number> } | null
  /** Real weight reported by Figma for the resolved font face. Authoritative — the style-name heuristic is only a fallback. */
  fontWeight?: number
  /** Real italic flag reported by Figma for the resolved font face. */
  italic?: boolean
  fontSize?: number
  lineHeight?: { unit: string; value?: number } | null
  letterSpacing?: { unit: string; value: number } | null
  paragraphSpacing?: number
  paragraphIndent?: number
  boundVariables?: Record<string, string>
}

export type TokenValue = string | number | boolean | Record<string, unknown>

export interface W3CToken {
  $type: string
  $value: TokenValue
  $extensions: {
    modes: Record<string, TokenValue>
    figma?: {
      collection: string
      defaultMode: string
      scopes?: readonly string[]
      codeSyntax?: { WEB?: string; ANDROID?: string; iOS?: string }
      /** See `TokenGraphCollection.inlineOnly`. */
      inlineOnly?: true
      /** A group or name starting with `_` or `.` — Figma's own spelling for "not for consumers"
       * (`_deprecated/font-size/sm`). The slug drops the underscore, so this is the only record. */
      private?: true
      /** Held an alias into a layer of this file that `shapeForCode` hid, and now holds its value
       * — a semantic token, never a primitive, however raw that value looks. */
      resolved?: true
      /** See `UnitWitness`. */
      unitWitness?: UnitWitness
    }
  }
}

/**
 * The link of an alias chain that `shapeForCode` cut out with a layer it does not emit, kept
 * because it said what the number at the end measures: an unscoped `button/fade` over a hidden
 * `opacity/30` holds a bare `30` afterwards, and only the primitive's OPACITY scope said that is
 * 30%. Recorded only on a number whose own `$type` and scopes say nothing, as the token
 * `unitWitness` would have picked had the chain survived — and beside the token's scopes, never in
 * them, since the designer did not scope it.
 */
export interface UnitWitness {
  path: string[]
  $type: string
  scopes?: readonly string[]
}

/** All a number's unit is decided by: a `$type`, Figma's scopes and a recorded `UnitWitness`. A
 * `W3CToken` is one; so is the link a `UnitWitness` stands for. */
export interface UnitEvidence {
  readonly $type?: string
  readonly $extensions?: {
    readonly figma?: { readonly scopes?: readonly string[]; readonly unitWitness?: UnitWitness }
  }
}

/** A token as `unitWitness` weighs it: a name to fall back on and the evidence it carries. */
export interface UnitLink {
  readonly path: readonly string[]
  readonly token: UnitEvidence
}

export type TokenTree = { [key: string]: TokenTree | W3CToken }

export interface TokenLeaf {
  path: string[]
  token: W3CToken
}

export interface TokenSummary {
  fileName: string
  collections: Array<{ name: string; modes: string[]; variableCount: number }>
  totalVariables: number
  textStyleCount: number
  effectStyleCount: number
  hasTypographyVars: boolean
  hasGeneratedTypoCollection: boolean
  hasBreakpointCollection: boolean
  hasGeneratedBpCollection: boolean
  tokenCount: number
  themes: string[]
  /** Things the package is missing and the reason, in the designer's words - e.g. the library
   * collections a local-only read left out. Absent when there is nothing to say. */
  notes?: string[]
  /** One per collection with the `product` role: its file, its themes, and the tokens other
   * products define that it does not. Absent when no collection is a product. */
  products?: ProductSummary[]
}

export interface ProductSummary {
  name: string
  file: string
  themes: string[]
  tokenCount: number
  /** Tokens (as CSS names) another product defines and this one does not — the ones a component
   * written against that product would find missing here. */
  missing: string[]
}

export interface TokenPackage {
  summary: TokenSummary
  files: Record<string, string>
  options: NormalizedOptions
  /** The tree `tokens.css`/`tokens.ts` were emitted from (primitives inlined per options), plus
   * the resolved theme order — i.e. exactly the variables this package declares. Consumers that
   * document the package (DESIGN.md) must read this rather than re-deriving it, or they describe
   * variables the CSS doesn't have. Empty tree when the file had no tokens. */
  emitted: { tree: TokenTree; themes: string[]; defaultTheme: string; grid?: ThemeGrid }
}

/* ------------------------------------------------------------------ helpers */

function slugSegments(name: string): string[] {
  return String(name)
    .trim()
    .replace(/^--/, '')
    .split(/[/.\s_-]+/)
    .map((p) => p.trim())
    .filter(Boolean)
}

function groupSegments(name: string): string[] {
  return String(name)
    .trim()
    .replace(/^--/, '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
}

function figmaColorToCss(value: Record<string, unknown>): string {
  const r = value.r as number, g = value.g as number, b = value.b as number
  if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number') return String(value)
  const a = typeof value.a === 'number' ? value.a : 1
  const source = sourceColorOf(value)
  const authored = source && sourceColorCss(source, a)
  if (authored) return authored
  const toByte = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255)))
  const hex = [toByte(r), toByte(g), toByte(b)].map((n) => n.toString(16).padStart(2, '0')).join('')
  if (a >= 1) return '#' + hex
  return `rgba(${toByte(r)}, ${toByte(g)}, ${toByte(b)}, ${Number(a.toFixed(3))})`
}

function figmaTypeToW3C(type: string | undefined, value: unknown): string {
  const n = typeof type === 'string' ? type.toUpperCase() : ''
  if (n === 'COLOR') return 'color'
  if (n === 'FLOAT' || n === 'NUMBER') return 'number'
  if (n === 'BOOLEAN') return 'boolean'
  if (n === 'TIMING') return 'duration'
  if (n === 'EASING') return 'easing'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string' && /^#|rgb\(|hsl\(/i.test(value.trim())) return 'color'
  return 'string'
}

const SPRING_EASINGS = new Set(['GENTLE', 'QUICK', 'BOUNCY', 'SLOW', 'CUSTOM_SPRING'])

/**
 * Figma's motion variable types (Update 133), as the CSS they stand for.
 *
 * A TIMING holds seconds and is written as milliseconds with the unit attached — the engine's
 * other durations are bare numbers that `cssValue` recognises by NAME, and a TIMING variable needs
 * no name to be a duration. An EASING holds a curve object, which `String()` turns into
 * "[object Object]"; it is written as the timing function itself, a spring as its sampled
 * `linear()`. Returns `undefined` for anything else, aliases included.
 */
function motionVariableValue(resolvedType: string | undefined, value: unknown): string | undefined {
  if (resolvedType === 'TIMING' && typeof value === 'number' && Number.isFinite(value)) {
    return `${roundEmitted(value * 1000)}ms`
  }
  if (resolvedType === 'EASING' && isRecord(value) && typeof value.type === 'string' && value.type !== 'VARIABLE_ALIAS') {
    const easing = value as unknown as MotionEasing
    try {
      return SPRING_EASINGS.has(easing.type) ? springToCssLinear(resolveSpringBounce(easing)).easing : easingToCss(easing)
    } catch {
      return undefined
    }
  }
  return undefined
}

function normalizeVariableValue(value: unknown, idToName: Map<string, string>, resolvedType?: string): TokenValue {
  if (isRecord(value) && 'type' in value && value.type === 'VARIABLE_ALIAS') {
    const id = typeof value.id === 'string' ? value.id : ''
    const name = idToName.get(id)
    return name ? `{${name}}` : `{${id}}`
  }
  const motion = motionVariableValue(resolvedType, value)
  if (motion !== undefined) return motion
  if (isRecord(value) && 'r' in value && 'g' in value && 'b' in value) return figmaColorToCss(value)
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return isRecord(value) ? value : String(value != null ? value : '')
}

function setToken(root: TokenTree, path: readonly string[], token: W3CToken): void {
  let cursor = root
  for (const segment of path.slice(0, -1)) {
    const existing = cursor[segment]
    if (!isRecord(existing) || '$value' in existing) cursor[segment] = {}
    cursor = cursor[segment] as TokenTree
  }
  const leaf = path[path.length - 1]
  if (leaf) cursor[leaf] = token
}

/* ------------------------------------------------------------------ canonical paths */

export function resolveCanonicalPaths(
  variables: readonly TokenGraphVariable[],
  collectionById: Map<string, TokenGraphCollection>
): Map<string, string[]> {
  const SEP = '\u0000'
  const natural = (v: TokenGraphVariable): string[] | null => {
    const segs = groupSegments(v.name)
    if (segs.length === 0) return null
    return segs.length > 1 ? segs : [figmaTypeToW3C(v.resolvedType, undefined), segs[0]]
  }
  const ordered = variables
    .filter((v) => v && typeof v.id === 'string' && typeof v.name === 'string' && v.name.trim() !== '')
    .map((v) => ({ v, path: natural(v) }))
    .filter((x): x is { v: TokenGraphVariable; path: string[] } => x.path !== null)
    .sort((a, b) => {
      // A collection the file only reaches through an alias never gets emitted, so it must not
      // push a name the file owns to `-2`.
      const rank = (id: string) => {
        const c = collectionById.get(id)
        return c?.product ? -1 : c?.inlineOnly || c?.yields ? 1 : 0
      }
      const ia = rank(a.v.collectionId)
      const ib = rank(b.v.collectionId)
      const ca = collectionById.get(a.v.collectionId)?.name ?? ''
      const cb = collectionById.get(b.v.collectionId)?.name ?? ''
      return ia - ib || ca.localeCompare(cb) || a.v.name.localeCompare(b.v.name) || a.v.id.localeCompare(b.v.id)
    })
  const claimed = new Set<string>()
  const paths = new Map<string, string[]>()
  for (const entry of ordered) {
    let candidate = entry.path
    let key = candidate.join(SEP)
    if (claimed.has(key)) {
      const base = entry.path.slice(0, -1)
      const leaf = entry.path[entry.path.length - 1]
      let n = 2
      do {
        candidate = base.concat([`${leaf}-${n}`])
        key = candidate.join(SEP)
        n++
      } while (claimed.has(key))
    }
    claimed.add(key)
    paths.set(entry.v.id, candidate)
  }
  return paths
}

/* ------------------------------------------------------------------ text styles */

const TEXT_STYLE_COLLECTION = 'Text Styles'
const TEXT_STYLE_BOUND_FIELDS = [
  'fontFamily', 'fontStyle', 'fontWeight', 'fontSize', 'letterSpacing', 'lineHeight',
  'paragraphSpacing', 'paragraphIndent',
]

/**
 * Last-resort guess when Figma could not report the real weight (missing font, Dev Mode).
 * Never prefer this over `TokenGraphTextStyle.fontWeight` — see `fontWeightOf`.
 */
function styleToFontWeight(style: string): number {
  const s = String(style || '').toLowerCase()
  const numeric = s.match(/(?:^|[^0-9])([1-9]00|1000)(?:[^0-9]|$)/)
  if (numeric) return Number(numeric[1])
  if (/thin|hairline/.test(s)) return 100
  if (/extra[\s-]?light|ultra[\s-]?light/.test(s)) return 200
  if (/semi[\s-]?bold|demi[\s-]?bold|\bdemi\b|\bsemi\b/.test(s)) return 600
  if (/extra[\s-]?bold|ultra[\s-]?bold/.test(s)) return 800
  if (/black|heavy|ultra|fat|poster/.test(s)) return 900
  if (/medium\b|\bmed\b/.test(s)) return 500
  if (/light/.test(s)) return 300
  if (/bold/.test(s)) return 700
  return 400
}

/** Actual weight of the text style: what Figma resolved, falling back to the style-name heuristic. */
function fontWeightOf(ts: TokenGraphTextStyle): number | undefined {
  if (typeof ts.fontWeight === 'number' && isFinite(ts.fontWeight) && ts.fontWeight > 0) return ts.fontWeight
  if (!ts.fontName || typeof ts.fontName.style !== 'string') return undefined
  return styleToFontWeight(ts.fontName.style)
}

function isItalicStyle(style: string): boolean {
  return /italic|oblique/.test(String(style || '').toLowerCase())
}

/** Actual italic flag of the text style: what Figma resolved, falling back to the style-name heuristic. */
function isItalicOf(ts: TokenGraphTextStyle): boolean {
  if (typeof ts.italic === 'boolean') return ts.italic
  return isItalicStyle(ts.fontName?.style ?? '')
}

function lineHeightValue(lh: { unit: string; value: number } | null | undefined): { value: TokenValue; type: string } | null {
  if (!isRecord(lh)) return null
  if (lh.unit === 'AUTO') return { value: 'normal', type: 'string' }
  if (typeof lh.value !== 'number') return null
  if (lh.unit === 'PERCENT') return { value: Number((lh.value / 100).toFixed(4)), type: 'number' }
  return { value: `${Number(lh.value.toFixed(3))}px`, type: 'string' }
}

function letterSpacingValue(ls: { unit: string; value: number } | null | undefined): { value: TokenValue; type: string } | null {
  if (!isRecord(ls) || typeof ls.value !== 'number') return null
  if (ls.value === 0) return { value: 0, type: 'number' }
  if (ls.unit === 'PERCENT') return { value: `${Number((ls.value / 100).toFixed(4))}em`, type: 'string' }
  return { value: Number(ls.value.toFixed(3)), type: 'number' }
}

function boundAlias(boundVariables: Record<string, string> | undefined, field: string, idToName: Map<string, string>): string | undefined {
  if (!isRecord(boundVariables)) return undefined
  const id = boundVariables[field]
  if (typeof id !== 'string' || !id) return undefined
  const name = idToName.get(id)
  return name ? `{${name}}` : undefined
}

function textStyleLeaves(ts: TokenGraphTextStyle, idToName: Map<string, string>): Array<{ prop: string; token: W3CToken }> {
  const bv = ts.boundVariables as Record<string, string> | undefined
  const out: Array<{ prop: string; token: W3CToken }> = []
  const push = (prop: string, value: TokenValue | undefined, type: string) => {
    if (value === undefined || value === null) return
    out.push({ prop, token: { $type: type, $value: value, $extensions: { modes: {}, figma: { collection: TEXT_STYLE_COLLECTION, defaultMode: '' } } } })
  }

  let family: TokenValue | undefined = boundAlias(bv, 'fontFamily', idToName)
  if (family === undefined && ts.fontName && typeof ts.fontName.family === 'string') family = ts.fontName.family
  push('font-family', family, 'string')

  let size: TokenValue | undefined = boundAlias(bv, 'fontSize', idToName)
  if (size === undefined && typeof ts.fontSize === 'number') size = ts.fontSize
  push('font-size', size, 'number')

  let weight: TokenValue | undefined = boundAlias(bv, 'fontWeight', idToName)
  if (weight === undefined) weight = fontWeightOf(ts)
  push('font-weight', weight, 'number')

  if (isItalicOf(ts)) push('font-style', 'italic', 'string')

  const lhAlias = boundAlias(bv, 'lineHeight', idToName)
  if (lhAlias !== undefined) push('line-height', lhAlias, 'number')
  else { const lh = lineHeightValue(ts.lineHeight as { unit: string; value: number } | null); if (lh) push('line-height', lh.value, lh.type) }

  const lsAlias = boundAlias(bv, 'letterSpacing', idToName)
  if (lsAlias !== undefined) push('letter-spacing', lsAlias, 'number')
  else { const ls = letterSpacingValue(ts.letterSpacing as { unit: string; value: number } | null); if (ls) push('letter-spacing', ls.value, ls.type) }

  const psAlias = boundAlias(bv, 'paragraphSpacing', idToName)
  if (psAlias !== undefined) push('paragraph-spacing', psAlias, 'number')
  else if (typeof ts.paragraphSpacing === 'number' && ts.paragraphSpacing > 0) push('paragraph-spacing', ts.paragraphSpacing, 'number')

  const piAlias = boundAlias(bv, 'paragraphIndent', idToName)
  if (piAlias !== undefined) push('paragraph-indent', piAlias, 'number')
  else if (typeof ts.paragraphIndent === 'number' && ts.paragraphIndent > 0) push('paragraph-indent', ts.paragraphIndent, 'number')

  return out
}

function addTextStyleTokens(out: TokenTree, textStyles: readonly TokenGraphTextStyle[] | undefined, idToName: Map<string, string>): void {
  const SEP = ''
  const list = (Array.isArray(textStyles) ? textStyles : [])
    .filter((t) => t && typeof t.name === 'string' && t.name.trim() !== '')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)))
  const claimed = new Set<string>()
  for (const ts of list) {
    let base = ['typography'].concat(groupSegments(ts.name))
    let key = base.join(SEP)
    if (claimed.has(key)) {
      const stem = base.slice(0, -1)
      const last = base[base.length - 1]
      let n = 2
      do { base = stem.concat([`${last}-${n}`]); key = base.join(SEP); n++ } while (claimed.has(key))
    }
    claimed.add(key)
    const leavesArr = textStyleLeaves(ts, idToName)
    for (const leaf of leavesArr) setToken(out, base.concat([leaf.prop]), leaf.token)
  }
}

/* ------------------------------------------------------------------ effect styles */

const EFFECT_STYLE_COLLECTION = 'Effect Styles'
/** Root groups the emitted tokens land under: `shadow/Focus/Default`, `blur/Overlay`. */
const SHADOW_ROOT = 'shadow'
const BLUR_ROOT = 'blur'

function round(value: number): number {
  return Number(Number(value).toFixed(3))
}

/** Drops a redundant leading group (`Shadows/Button` under the `shadow/` root). Never empties the
 * path — a style named only `Shadows` keeps its segment. */
function stripLeadingGroup(segments: readonly string[], groups: readonly string[]): string[] {
  if (segments.length > 1 && groups.indexOf(segments[0].trim().toLowerCase()) !== -1) return segments.slice(1)
  return segments.slice()
}

/** One Figma shadow → one CSS `box-shadow` layer. Inner shadows carry the `inset` keyword. */
export function shadowEffectToCss(effect: TokenGraphEffect): string | null {
  if (effect.type !== 'DROP_SHADOW' && effect.type !== 'INNER_SHADOW') return null
  const offset = effect.offset ?? { x: 0, y: 0 }
  const parts = [
    `${round(offset.x)}px`,
    `${round(offset.y)}px`,
    `${round(effect.radius ?? 0)}px`,
  ]
  // `spread: 0` is Figma's default and adds nothing to the CSS.
  if (effect.spread) parts.push(`${round(effect.spread)}px`)
  const color = effect.color ? figmaColorToCss(effect.color as unknown as Record<string, unknown>) : 'rgba(0, 0, 0, 0.25)'
  const inset = effect.type === 'INNER_SHADOW' ? 'inset ' : ''
  return `${inset}${parts.join(' ')} ${color}`
}

/** A Figma blur → the CSS filter function both `filter` and `backdrop-filter` accept. */
export function blurEffectToCss(effect: TokenGraphEffect): string | null {
  if (effect.type !== 'LAYER_BLUR' && effect.type !== 'BACKGROUND_BLUR') return null
  return `blur(${round(effect.radius ?? 0)}px)`
}

/**
 * Effect styles → tokens. A style whose effects are all shadows becomes one `shadow/…` token
 * holding the full comma-separated `box-shadow` value; blur styles become `blur/…`. A style that
 * mixes both is split into one token per family, since they land on different CSS properties.
 * Effects Figma has no CSS equivalent for (noise, texture, glass) are skipped — silently emitting
 * a wrong value would be worse than the gap.
 */
function addEffectStyleTokens(out: TokenTree, effectStyles: readonly TokenGraphEffectStyle[] | undefined): void {
  const list: readonly TokenGraphEffectStyle[] = (Array.isArray(effectStyles) ? effectStyles : []).filter(
    (style: TokenGraphEffectStyle) => style && typeof style.name === 'string' && style.name.trim() !== ''
  )
  for (const style of list) {
    const visible = (style.effects || []).filter((effect) => effect && effect.visible !== false)
    const shadows = visible.map(shadowEffectToCss).filter((css): css is string => css !== null)
    const blurs = visible.map(blurEffectToCss).filter((css): css is string => css !== null)
    const segments = groupSegments(style.name)
    if (segments.length === 0) continue
    // A library that already groups its styles under `Shadows/…` would otherwise emit
    // `--shadow-shadows-button`; the root group carries no information the prefix doesn't.
    const named = stripLeadingGroup(segments, ['shadow', 'shadows', 'effect', 'effects', 'elevation', 'elevations'])
    const blurNamed = stripLeadingGroup(segments, ['blur', 'blurs', 'effect', 'effects'])
    const extensions = () => ({ modes: {}, figma: { collection: EFFECT_STYLE_COLLECTION, defaultMode: '' } })
    if (shadows.length > 0) {
      setToken(out, [SHADOW_ROOT].concat(named), { $type: 'shadow', $value: shadows.join(', '), $extensions: extensions() })
    }
    if (blurs.length > 0) {
      setToken(out, [BLUR_ROOT].concat(blurNamed), { $type: 'string', $value: blurs.join(' '), $extensions: extensions() })
    }
  }
}

/* ------------------------------------------------------------------ graph → W3C tree */

/**
 * A composed colour (Update 139) as the colour it paints, in one mode.
 *
 * Figma keeps a colour and an opacity as two halves, at least one an alias — a palette colour at
 * a 50% opacity token. Nothing downstream speaks that pair: it reached tokens.css as
 * "[object Object]". It is resolved here to the flat RGBA instead of a `color-mix()` over two
 * `var()`s, because the halves are usually primitives, and a flattened or hidden-primitives
 * package removes exactly the custom properties such an expression would point at. Each half is
 * read in the mode of the same NAME where its collection has one, so a themed composed colour
 * still comes out per theme. The colour half may itself alias another composed colour (a semantic
 * `Orange/Main` over a palette `Orange/O500` that carries its own opacity token), so a composed
 * target is flattened the same way before it is multiplied. `undefined` when either half does
 * not resolve.
 */
function resolveComposedColor(
  value: Record<string, unknown>,
  modeName: string,
  byId: ReadonlyMap<string, TokenGraphVariable>,
  collectionById: ReadonlyMap<string, TokenGraphCollection>,
  seen: ReadonlySet<string> = new Set()
): Record<string, number> | undefined {
  const literal = (raw: unknown, visited: ReadonlySet<string>): unknown => {
    if (!isRecord(raw)) return raw
    if (raw.type !== 'VARIABLE_ALIAS' || typeof raw.id !== 'string') {
      return 'color' in raw && 'opacity' in raw ? resolveComposedColor(raw, modeName, byId, collectionById, visited) : raw
    }
    if (visited.has(raw.id)) return undefined
    const target = byId.get(raw.id)
    if (!target || !isRecord(target.valuesByMode)) return undefined
    const collection = collectionById.get(target.collectionId)
    const modeId =
      (collection?.modes ?? []).find((m) => m.name === modeName)?.modeId ??
      (collection?.defaultModeId && collection.defaultModeId in target.valuesByMode ? collection.defaultModeId : undefined) ??
      Object.keys(target.valuesByMode)[0]
    if (modeId === undefined) return undefined
    return literal(target.valuesByMode[modeId], new Set(visited).add(raw.id))
  }
  const color = literal(value.color, seen)
  const opacity = literal(value.opacity, seen)
  if (!isRecord(color) || typeof color.r !== 'number' || typeof color.g !== 'number' || typeof color.b !== 'number') return undefined
  if (typeof opacity !== 'number' || !Number.isFinite(opacity)) return undefined
  // The opacity half is a percentage, the way Figma's opacity fields are.
  const base = typeof color.a === 'number' ? color.a : 1
  return { r: color.r, g: color.g, b: color.b, a: base * Math.min(1, Math.max(0, opacity / 100)) }
}

export function variablesToW3CMultiMode(graph: TokenGraph): TokenTree {
  const out: TokenTree = {}
  const collections = Array.isArray(graph?.collections) ? graph.collections : []
  const variables = Array.isArray(graph?.variables) ? graph.variables : []
  const collectionById = new Map<string, TokenGraphCollection>()
  for (const c of collections) if (c && typeof c.id === 'string') collectionById.set(c.id, c)

  const canonicalPaths = resolveCanonicalPaths(variables, collectionById)
  const idToName = new Map<string, string>()
  for (const [id, path] of canonicalPaths) idToName.set(id, path.join('.'))
  const byId = new Map<string, TokenGraphVariable>()
  for (const v of variables) if (v && typeof v.id === 'string') byId.set(v.id, v)

  for (const variable of variables) {
    const path = canonicalPaths.get(variable.id)
    if (!path) continue
    const valuesByMode = isRecord(variable.valuesByMode) ? variable.valuesByMode : {}
    const collection = collectionById.get(variable.collectionId)
    const modes =
      collection && Array.isArray(collection.modes) && collection.modes.length > 0
        ? collection.modes
        : Object.keys(valuesByMode).map((modeId) => ({ modeId, name: modeId }))
    if (modes.length === 0) continue

    const byMode: Record<string, TokenValue> = {}
    for (const mode of modes) {
      if (!(mode.modeId in valuesByMode)) continue
      const raw = valuesByMode[mode.modeId]
      const composed = isRecord(raw) && 'color' in raw && 'opacity' in raw
        ? resolveComposedColor(raw, mode.name, byId, collectionById)
        : undefined
      byMode[mode.name] = normalizeVariableValue(composed ?? raw, idToName, variable.resolvedType)
    }

    const defaultModeId =
      collection && typeof collection.defaultModeId === 'string' ? collection.defaultModeId : modes[0].modeId
    const defaultMode = modes.find((m) => m.modeId === defaultModeId) ?? modes[0]
    const defaultValue = defaultMode.name in byMode ? byMode[defaultMode.name] : Object.values(byMode)[0]
    if (defaultValue === undefined) continue

    const explicitType = figmaTypeToW3C(variable.resolvedType, defaultValue)
    const collectionName = collection && typeof collection.name === 'string' ? collection.name : undefined
    const $extensions: W3CToken['$extensions'] = { modes: byMode }
    if (collectionName) {
      $extensions.figma = { collection: collectionName, defaultMode: defaultMode.name }
      if (collection?.inlineOnly) $extensions.figma.inlineOnly = true
      if (String(variable.name).split('/').some((segment: string) => /^[_.]/.test(segment.trim()))) $extensions.figma.private = true
      // `ALL_SCOPES` is Figma's "unscoped" default and says nothing — carrying it would let a
      // consumer mistake it for a deliberate restriction.
      const scopes = Array.isArray(variable.scopes)
        ? (variable.scopes as readonly string[]).filter((scope) => scope !== 'ALL_SCOPES')
        : []
      if (scopes.length > 0) $extensions.figma.scopes = scopes
      // The names the team already committed to in Figma. Carried verbatim; each emitter decides
      // which platform key it answers to and how to make an identifier of it.
      const codeSyntax = isRecord(variable.codeSyntax) ? variable.codeSyntax : undefined
      if (codeSyntax) {
        const kept: { WEB?: string; ANDROID?: string; iOS?: string } = {}
        for (const key of ['WEB', 'ANDROID', 'iOS'] as const) {
          const name = (codeSyntax as Record<string, unknown>)[key]
          if (typeof name === 'string' && name.trim() !== '') kept[key] = name.trim()
        }
        if (Object.keys(kept).length > 0) $extensions.figma.codeSyntax = kept
      }
    }
    setToken(out, path, { $type: explicitType, $value: defaultValue, $extensions })
  }
  addTextStyleTokens(out, graph.textStyles, idToName)
  addEffectStyleTokens(out, graph.effectStyles)
  return out
}

/* ------------------------------------------------------------------ tree traversal */

export function isTokenLeaf(value: TokenTree | W3CToken): value is W3CToken {
  return isRecord(value) && '$value' in value
}

export function leaves(tree: TokenTree, prefix: string[] = []): TokenLeaf[] {
  const out: TokenLeaf[] = []
  for (const key of Object.keys(tree)) {
    const value = tree[key]
    const path = prefix.concat([key])
    if (isTokenLeaf(value)) out.push({ path, token: value })
    else if (isRecord(value)) out.push(...leaves(value, path))
  }
  return out
}

/**
 * Characters a CSS custom-property name may keep. Non-ASCII LETTERS stay: CSS identifiers accept
 * code points above U+00A0, so a Cyrillic (or Greek, CJK, accented-Latin) variable name yields
 * `--цвет-кнопка-фон` instead of being stripped to `--`, which is invalid CSS and collides with
 * every other such token in the file. Latin-1 punctuation and NBSP are deliberately excluded from
 * the ranges, and the class is spelled out rather than using `\p{L}` so the regex stays parseable
 * by older engines.
 */
const NON_IDENT_CHARS = /[^0-9a-zÀ-ɏͰ-ӿ԰-׿؀-ۿ฀-๿぀-ヿ一-鿿가-힯]+/g

/**
 * Figma variable path → CSS custom-property name (without the leading `--`).
 */
export function varName(segments: readonly string[]): string {
  return segments
    .reduce<string[]>((acc, segment) => acc.concat(slugSegments(segment)), [])
    .map((segment) => segment.toLowerCase().replace(NON_IDENT_CHARS, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('-')
}

function aliasTarget(value: TokenValue): string[] | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^\{(.+)\}$/)
  if (!match) return null
  return match[1].split('.').map((p) => p.trim()).filter(Boolean)
}

// `scale` is deliberately NOT a unitless family. In this system `scale/16` is sixteen PIXELS —
// the CSS emitter says so itself, writing `calc(var(--scale-16, 16px) * 1.36)` — and a unitless
// `16` made that calc invalid, so every radius derived from the scale silently squared off. A
// multiplier is what `ratio` and `aspect` are for. (`cli/allcrew_channel/tokens.py` still carried
// `scale` here long after this side dropped it; the golden fixtures now pin both.)
const LINE_HEIGHT_RATIO_MAX = 4

/** Figma stores floats — a 9.9px text size arrives as `9.899999618530273`. Two decimals is
 * already beyond anything CSS can render differently, and the raw float noise reads as data. */
function roundEmitted(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * What a token MEANS, as opposed to what type it stores. `number` is the whole problem: Figma
 * calls a corner radius, a gap, a font size and an opacity all `FLOAT`, and each one renders
 * differently in every language the package emits — `px` vs nothing in CSS, `.dp` vs `.sp` vs a
 * bare float in Compose. A boolean "is this a length" answered CSS and left Android emitting text
 * sizes in `dp`, which is the classic scaling bug: a user who raises the system font size sees
 * nothing change.
 */
export type TokenKind =
  | 'color'
  | 'spacing'
  | 'radius'
  | 'borderWidth'
  | 'fontSize'
  | 'lineHeight'
  | 'letterSpacing'
  | 'fontWeight'
  | 'fontFamily'
  | 'opacity'
  | 'duration'
  | 'length'
  | 'number'
  | 'string'
  | 'boolean'

/**
 * Figma's own scopes, which are the designer's statement of where a token may be applied and
 * therefore the only non-guessing answer to what it measures. Preferred over the name: a token
 * called `scale/16` scoped to `CORNER_RADIUS` is a radius whatever its name says.
 */
const KIND_BY_SCOPE: Readonly<Record<string, TokenKind>> = {
  CORNER_RADIUS: 'radius',
  GAP: 'spacing',
  WIDTH_HEIGHT: 'spacing',
  PARAGRAPH_SPACING: 'spacing',
  PARAGRAPH_INDENT: 'spacing',
  STROKE_FLOAT: 'borderWidth',
  EFFECT_FLOAT: 'length',
  FONT_SIZE: 'fontSize',
  LINE_HEIGHT: 'lineHeight',
  LETTER_SPACING: 'letterSpacing',
  FONT_WEIGHT: 'fontWeight',
  FONT_FAMILY: 'fontFamily',
  FONT_STYLE: 'fontFamily',
  OPACITY: 'opacity',
  // Update 139: a FLOAT shown only in colour opacity pickers — a percentage, never a length.
  COLOR_OPACITY: 'opacity',
  TEXT_CONTENT: 'string',
}

/** Name fallbacks, in priority order, for a file whose variables carry no scopes. Each pattern
 * reproduces a branch the old `UNITLESS_TOKEN`/`LINE_HEIGHT_TOKEN` pair already had, so a token
 * that used to render unitless still does. */
const KIND_BY_NAME: ReadonlyArray<readonly [RegExp, TokenKind]> = [
  [/(^|[-_])line-?height([-_]|$)/i, 'lineHeight'],
  [/(^|[-_])opacity([-_]|$)/i, 'opacity'],
  [/(^|[-_])(font-?weight|weight)([-_]|$)/i, 'fontWeight'],
  [/(^|[-_])(z-?index|flex|order|aspect|ratio|count|columns?)([-_]|$)/i, 'number'],
  [/(^|[-_])(font-?size|text-?size)([-_]|$)/i, 'fontSize'],
  [/(^|[-_])(letter-?spacing|tracking)([-_]|$)/i, 'letterSpacing'],
  [/(^|[-_])(radius|radii|rounded)([-_]|$)/i, 'radius'],
  [/(^|[-_])(duration|delay)([-_]|$)/i, 'duration'],
  [/(^|[-_])(font-?family|typeface)([-_]|$)/i, 'fontFamily'],
]

/** Text metrics: the kinds Android sizes in `sp` so the system font-size setting reaches them. */
const TEXT_METRIC_KINDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'fontSize',
  'lineHeight',
  'letterSpacing',
])

export function isTextMetricKind(kind: TokenKind): boolean {
  return TEXT_METRIC_KINDS.has(kind)
}

function scopesOf(token: UnitEvidence): readonly string[] {
  const figma = token.$extensions?.figma
  return figma && Array.isArray(figma.scopes) ? figma.scopes : []
}

/** The kind a token's own `$type` or scope states — `undefined` when only its name could guess.
 * This is the line between evidence and heuristic that `unitWitness` walks an alias chain by. */
function provenKind(token: UnitEvidence): TokenKind | undefined {
  if (token.$type === 'color') return 'color'
  if (token.$type === 'boolean') return 'boolean'
  if (token.$type === 'duration') return 'duration'
  for (const scope of scopesOf(token)) {
    const kind = KIND_BY_SCOPE[scope]
    if (kind) return kind
  }
  return undefined
}

/** `$type` and `scopes` first, the name only when neither has an answer. `path` alone is what the
 * CSS emitter has, which is why the name half has to stand on its own. */
export function tokenKind(
  token: UnitEvidence | undefined,
  path: readonly string[] = []
): TokenKind {
  if (token) {
    const proven = provenKind(token)
    if (proven) return proven
    if (token.$type === 'string' && scopesOf(token).length === 0) {
      // A string token with no scope to speak for it: the name is the only witness, and a family
      // is the only string kind a generator treats specially.
      for (const [pattern, kind] of KIND_BY_NAME) {
        if (kind === 'fontFamily' && path.some((seg) => pattern.test(seg))) return 'fontFamily'
      }
      return 'string'
    }
  }
  for (const [pattern, kind] of KIND_BY_NAME) {
    if (path.some((seg) => pattern.test(seg))) return kind
  }
  return 'length'
}

/**
 * Whether a numeric token of this kind carries a unit — CSS `px`, Swift `CGFloat`, Compose
 * `.dp`/`.sp` — rather than being a bare number.
 *
 * `lineHeight` is the one kind whose answer depends on the value: Figma stores a 150% leading as
 * `1.5` and a 24px leading as `24`, with nothing but the magnitude to tell them apart.
 */
export function isLengthKind(kind: TokenKind, value: number): boolean {
  if (roundEmitted(value) === 0) return false
  if (kind === 'lineHeight') return Math.abs(roundEmitted(value)) >= LINE_HEIGHT_RATIO_MAX
  return kind !== 'opacity' && kind !== 'fontWeight' && kind !== 'number' && kind !== 'duration'
}

/**
 * Whether a number token means pixels. Kept as the CSS-shaped question — it has only a path to go
 * on — and now answered through `tokenKind` so the heuristic exists once.
 */
export function isLengthToken(value: number, path?: readonly string[]): boolean {
  return isLengthKind(tokenKind(undefined, path ?? []), value)
}

/** Whether the variable's own scope says OPACITY or COLOR_OPACITY — the one proof that Figma stored
 * the number as a percentage (30 renders 30%). The name is no proof: a scope-less file's
 * `…opacity…` may hold a fraction already. Every emitter asks this same question. */
export function hasOpacityScope(token: UnitEvidence): boolean {
  const scopes = scopesOf(token)
  return scopes.includes('OPACITY') || scopes.includes('COLOR_OPACITY')
}

/**
 * Whether an opacity token's number is Figma's percentage rather than the 0–1 fraction CSS
 * `opacity`, SwiftUI `.opacity()` and Compose `alpha` take. The OPACITY / COLOR_OPACITY scope proves
 * it whatever the value. Without the scope the name is the only evidence, and a fraction never
 * exceeds 1 — so `Opacity/10` holding `10` is a percentage (emitted as is, `opacity: 10` clamps to
 * fully opaque), while a scope-less `overlay/opacity: 0.5` is a fraction already and stays.
 */
export function isOpacityPercent(token: UnitEvidence | undefined, value: number): boolean {
  return (token !== undefined && hasOpacityScope(token)) || value > 1
}

/** An opacity token's number as the 0–1 fraction code takes — see `isOpacityPercent`. */
export function opacityFraction(value: number, token?: UnitEvidence): number {
  return isOpacityPercent(token, value) ? value / 100 : value
}

/** `token`, when the caller has it, lets Figma's scopes decide the unit the way they already do
 * for the native packages — without it a `COLOR_OPACITY` or `OPACITY` float with a plain name came
 * out as pixels here and as a bare number in Swift. A token holding a number `shapeForCode`
 * substituted out of a hidden layer is read by the link it recorded, as `unitWitness` reads a
 * chain: `button/fade` alone says nothing about its `30`. */
export function cssValue(value: TokenValue, path?: readonly string[], token?: UnitEvidence): string {
  const alias = aliasTarget(value)
  if (alias) return `var(--${varName(alias)})`
  if (typeof value === 'number') {
    const rounded = roundEmitted(value)
    if (rounded === 0) return '0'
    if (token) {
      const witness = unitWitness([{ path: path ?? [], token }])
      const kind = tokenKind(witness.token, witness.path)
      if (kind === 'duration') return `${rounded}ms`
      // Figma stores an OPACITY / COLOR_OPACITY variable as a percentage (30 renders 30%); CSS
      // `opacity: 30` is fully opaque.
      if (kind === 'opacity') return String(roundEmitted(opacityFraction(value, witness.token)))
      return isLengthKind(kind, value) ? `${rounded}px` : String(rounded)
    }
    // A duration is the one numeric kind whose CSS unit is not `px`. Emitting `200px` for
    // `motion/duration/fast` made every `transition-duration` referencing it invalid — the
    // Python port had this right and this side did not, which is what the parity goldens exist
    // to catch.
    const kind = tokenKind(undefined, path ?? [])
    if (kind === 'duration') return `${rounded}ms`
    if (kind === 'opacity') return String(roundEmitted(opacityFraction(value)))
    return isLengthToken(value, path) ? `${rounded}px` : String(rounded)
  }
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return value
  return String(value != null ? value : '')
}

export function isAliasValue(value: TokenValue): value is string {
  return typeof value === 'string' && /^\{.+\}$/.test(value)
}

export function modesOf(token: W3CToken): Record<string, TokenValue> {
  const modes = token.$extensions?.modes
  return isRecord(modes) ? modes : {}
}

export function collectionOf(token: W3CToken): string | undefined {
  const figma = token.$extensions?.figma
  if (isRecord(figma) && typeof figma.collection === 'string') return figma.collection
  return undefined
}

/** The per-platform names Figma already holds for this token, if any. */
export function codeSyntaxOf(token: W3CToken): Record<string, string> | undefined {
  const figma = token.$extensions?.figma
  if (!isRecord(figma) || !isRecord(figma.codeSyntax)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(figma.codeSyntax)) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim()
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function collectionDefaultModeOf(token: W3CToken): string | undefined {
  const figma = token.$extensions?.figma
  if (isRecord(figma) && typeof figma.defaultMode === 'string') return figma.defaultMode
  return undefined
}

function pickDefaultTheme(allLeaves: TokenLeaf[], themes: string[], hint: string): string {
  if (themes.indexOf(hint) !== -1) return hint
  for (const entry of allLeaves) {
    const def = collectionDefaultModeOf(entry.token)
    if (def && themes.indexOf(def) !== -1) return def
  }
  return themes[0]
}

export function participatesInTheming(token: W3CToken): boolean {
  const modes = modesOf(token)
  const names = Object.keys(modes)
  return names.length >= 2 || isAliasValue(token.$value) || names.some((n) => isAliasValue(modes[n]))
}

/**
 * The themes a stylesheet switches between: the modes of collections that HAVE more than one.
 *
 * A single-mode collection is not a theme, whatever its one mode is called. Counting every mode
 * an alias passes through turned a consumer file into six blocks — `Mode 1` from its primitives,
 * `Light` from a one-mode semantic layer, `Desktop`/`Tablet`/`Mobile` from its breakpoints — each
 * repeating every variable. With no multi-mode collection there is exactly one theme, the hint.
 */
export function themeModesOf(allLeaves: TokenLeaf[], hint?: string): string[] {
  const themes: string[] = []
  for (const entry of allLeaves) {
    const names = Object.keys(modesOf(entry.token))
    if (names.length < 2) continue
    for (const name of names) if (themes.indexOf(name) === -1) themes.push(name)
  }
  if (themes.length === 0) {
    const firstModes = allLeaves.length ? Object.keys(modesOf(allLeaves[0].token)) : []
    themes.push((hint && hint.trim()) || firstModes[0] || 'default')
  }
  return themes
}

export function valueForTheme(token: W3CToken, theme: string): TokenValue {
  const modes = modesOf(token)
  return theme in modes ? modes[theme] : token.$value
}

/** Kebab-slug a theme name for use in CSS selectors (`Dark` → `dark`). */
export function themeSlug(theme: string): string {
  return varName([theme]) || theme
}

/* ------------------------------------------------------------------ typography scale */

const SCALE_TOKEN_KEY = 'allcrew-channel-typo-scale'

export function isScaleToken(token: W3CToken): boolean {
  const figma = token.$extensions?.figma
  return isRecord(figma) && figma.collection === 'Typography' && figma.defaultMode === SCALE_TOKEN_KEY
}

const TSHIRT_LADDER = ['3xs', '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl']
const WEIGHT_NAMES: Record<number, string> = { 100: 'thin', 200: 'extra-light', 300: 'light', 400: 'regular', 500: 'medium', 600: 'semi-bold', 700: 'bold', 800: 'extra-bold', 900: 'black' }

function numericKey(v: unknown): number {
  return typeof v === 'number' ? v : 0
}

function valueNameToken(v: unknown): string {
  if (typeof v === 'number') return String(Math.round(v))
  return slugSegments(String(v)).join('-') || 'default'
}

const TYPO_AXIS_SCOPE: Record<string, VariableScope[]> = {
  'font-size': ['FONT_SIZE'],
  'font-family': ['FONT_FAMILY'],
  'font-weight': ['FONT_WEIGHT'],
  'line-height': ['LINE_HEIGHT'],
  'letter-spacing': ['LETTER_SPACING'],
  'paragraph-spacing': ['PARAGRAPH_SPACING'],
  'paragraph-indent': ['PARAGRAPH_INDENT'],
}

export interface TypographyPlan {
  collectionName: string
  variables: Array<{ name: string; type: string; value: unknown; scopes: VariableScope[] }>
  bindings: Array<{ styleId: string; styleName: string; field: string; varName: string }>
}

export function planTypographyVariables(graph: TokenGraph, options: { typoNaming?: string }): TypographyPlan {
  const naming = options?.typoNaming === 'value' ? 'value' : 'tshirt'
  const styles = (Array.isArray(graph?.textStyles) ? graph.textStyles : [])
    .filter((t) => t && typeof t.name === 'string' && t.name.trim() !== '')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)))

  const axes: Record<string, { type: string; field: string; get: (t: TokenGraphTextStyle) => unknown; bindOk?: (t: TokenGraphTextStyle) => boolean }> = {
    'font-size': { type: 'FLOAT', field: 'fontSize', get: (t) => typeof t.fontSize === 'number' ? t.fontSize : undefined },
    'font-family': { type: 'STRING', field: 'fontFamily', get: (t) => t.fontName && typeof t.fontName.family === 'string' ? t.fontName.family : undefined },
    'font-weight': { type: 'FLOAT', field: 'fontWeight', get: (t) => fontWeightOf(t) },
    'line-height': {
      type: 'FLOAT', field: 'lineHeight',
      get: (t) => {
        const lh = t.lineHeight
        if (!isRecord(lh) || typeof lh.value !== 'number') return undefined
        if (lh.unit === 'PIXELS') return lh.value
        if (lh.unit === 'PERCENT') return Number((lh.value / 100).toFixed(4))
        return undefined
      },
      bindOk: (t) => isRecord(t.lineHeight) && t.lineHeight.unit === 'PIXELS',
    },
    'letter-spacing': { type: 'FLOAT', field: 'letterSpacing', get: (t) => isRecord(t.letterSpacing) && t.letterSpacing.unit === 'PIXELS' && typeof t.letterSpacing.value === 'number' ? t.letterSpacing.value : undefined },
    'paragraph-spacing': { type: 'FLOAT', field: 'paragraphSpacing', get: (t) => typeof t.paragraphSpacing === 'number' && t.paragraphSpacing > 0 ? t.paragraphSpacing : undefined },
    'paragraph-indent': { type: 'FLOAT', field: 'paragraphIndent', get: (t) => typeof t.paragraphIndent === 'number' && t.paragraphIndent > 0 ? t.paragraphIndent : undefined },
  }
  const order = ['font-size', 'font-family', 'font-weight', 'line-height', 'letter-spacing', 'paragraph-spacing', 'paragraph-indent']
  const keyOf = (v: unknown) => typeof v + ':' + String(v)

  const variables: TypographyPlan['variables'] = []
  const nameByAxisValue: Record<string, Map<string, string>> = {}
  for (const axis of order) {
    const ax = axes[axis]
    if (!ax) continue
    const distinct = new Map<string, unknown>()
    for (const t of styles) { const v = ax.get(t); if (v === undefined || v === null) continue; if (!distinct.has(keyOf(v))) distinct.set(keyOf(v), v) }
    if (distinct.size === 0) continue
    const entries = Array.from(distinct.values())
    if (axis === 'font-family') {
      entries.sort((a, b) => String(a).localeCompare(String(b)))
    } else {
      entries.sort((a, b) => numericKey(a) - numericKey(b))
    }
    let nameFor: (v: unknown) => string
    if (axis === 'font-family') {
      nameFor = (v) => varName([String(v)]) || 'default'
    } else if (axis === 'font-weight') {
      nameFor = (v) => WEIGHT_NAMES[Number(v)] || valueNameToken(v)
    } else if (naming === 'tshirt' && (axis === 'font-size' || axis === 'line-height')) {
      const idx = new Map<string, string>()
      entries.forEach((v, i) => { idx.set(keyOf(v), TSHIRT_LADDER[i] || valueNameToken(v)) })
      nameFor = (v) => idx.get(keyOf(v))!
    } else {
      nameFor = (v) => valueNameToken(v)
    }
    nameByAxisValue[axis] = new Map()
    const used: Record<string, boolean> = {}
    for (const v of entries) {
      let leaf = nameFor(v)
      while (used[leaf]) leaf = leaf + '-2'
      used[leaf] = true
      const name = axis + '/' + leaf
      nameByAxisValue[axis].set(keyOf(v), name)
      variables.push({ name, type: ax.type, value: v, scopes: TYPO_AXIS_SCOPE[axis] || [] })
    }
  }

  const bindings: TypographyPlan['bindings'] = []
  for (const t of styles) {
    for (const axis of order) {
      const ax = axes[axis]
      if (!ax) continue
      const v = ax.get(t)
      if (v === undefined || v === null) continue
      if (ax.bindOk && !ax.bindOk(t)) continue
      const varName_ = nameByAxisValue[axis]?.get(keyOf(v))
      if (varName_) bindings.push({ styleId: t.id, styleName: t.name, field: ax.field, varName: varName_ })
    }
  }

  return { collectionName: 'Typography', variables, bindings }
}

export function extractTypographyScale(tree: TokenTree, options: { typoNaming?: string; typoScaleOnly?: boolean; typoShorthand?: boolean }): TokenTree {
  // This is a pure function that would normally need the graph's textStyles.
  // For the DS plugin, the text styles are already in the graph and processed by addTextStyleTokens.
  // The scale extraction happens at the graph level (planTypographyVariables) and the result
  // is applied by the Figma sandbox. For the pure engine, we return the tree as-is —
  // the scale synthesis is a write-back operation, not a tree transform.
  return tree
}

/* ------------------------------------------------------------------ inline primitives */

/**
 * `value` (`leaf`'s value in `theme`) followed through every alias `follows` admits, to the value
 * it ends on. A target that is missing, already visited or refused stops the walk with that alias
 * in hand. `chain` is `leaf` and each token passed through after it — the evidence `unitWitness`
 * reads, which the value alone has lost: a `30` says nothing about being a percentage.
 */
export function followAliases(
  byName: ReadonlyMap<string, TokenLeaf>,
  leaf: TokenLeaf,
  value: TokenValue,
  theme: string,
  follows: (target: string) => boolean = () => true
): { value: TokenValue; chain: TokenLeaf[] } {
  const chain = [leaf]
  const seen = new Set<string>()
  let current = value
  while (isAliasValue(current)) {
    const target = aliasTarget(current)!.join('.')
    const entry = byName.get(target)
    if (!entry || seen.has(target) || !follows(target)) break
    seen.add(target)
    chain.push(entry)
    current = valueForTheme(entry.token, theme)
  }
  return { value: current, chain }
}

/**
 * The token in an alias chain whose `$type` or scope says what the number at its end measures:
 * the consumer first — its scope is where the designer applies the value — then each token it
 * passed through. `button/opacity/disabled` scoped OPACITY over a scope-less `opacity/30` is 30%,
 * and asking only the primitive answered `30`. A chain with no such statement falls back to the
 * token the value came from, read by name, as the inline step always has.
 *
 * A token that recorded a `UnitWitness` had the rest of its chain cut by `shapeForCode`; the
 * record stands right after it, where the hidden links stood, so the rule reads the same whether
 * the primitive layer is inlined or hidden.
 */
export function unitWitness(chain: readonly UnitLink[]): UnitLink {
  const links = chain.flatMap((link): UnitLink[] => {
    const cut = link.token.$extensions?.figma?.unitWitness
    if (!cut) return [link]
    const scopes = cut.scopes ? { figma: { scopes: cut.scopes } } : undefined
    return [link, { path: cut.path, token: { $type: cut.$type, ...(scopes ? { $extensions: scopes } : {}) } }]
  })
  return links.find((link) => provenKind(link.token) !== undefined) ?? links[links.length - 1]
}

/**
 * The `UnitWitness` a token keeps when `shapeForCode` substitutes it: for each value it resolved
 * (the default first), the witness of the links that were cut — the first of them that proves a
 * kind, else the default value's origin, read by name, as `unitWitness` falls back. Nothing for a
 * token whose own `$type` or scope proves its kind, which is its own witness, nor for anything but
 * a number, the one value whose rendering the unit decides.
 */
function cutWitness(token: W3CToken, cuts: readonly TokenLeaf[][]): UnitWitness | undefined {
  if (token.$type !== 'number' || provenKind(token) !== undefined) return undefined
  const witnesses = cuts.filter((links) => links.length > 0).map((links) => unitWitness(links))
  const witness = witnesses.find((link) => provenKind(link.token) !== undefined) ?? witnesses[0]
  if (!witness) return undefined
  const scopes = scopesOf(witness.token)
  return {
    path: [...witness.path],
    $type: witness.token.$type ?? token.$type,
    ...(scopes.length > 0 ? { scopes: [...scopes] } : {}),
  }
}

export function inlinePrimitivesTree(tree: TokenTree, flattenAll: boolean): TokenTree {
  const all = leaves(tree)
  const byName = new Map<string, TokenLeaf>()
  for (const e of all) byName.set(e.path.join('.'), e)

  const primitive = new Set<string>()
  // `resolved`: the token pointed at a hidden layer and now holds its value — it is the
  // semantic token the code asked for, and treating it as a primitive deleted every one another
  // token referenced (`--colors-action-default`, because the glyph colours point at it).
  for (const e of all) {
    if (participatesInTheming(e.token) || isScaleToken(e.token) || e.token.$extensions?.figma?.resolved) continue
    primitive.add(e.path.join('.'))
  }

  const referenced = new Set<string>()
  const noteRef = (value: TokenValue) => {
    if (!isAliasValue(value)) return
    const target = aliasTarget(value)!.join('.')
    if (primitive.has(target)) referenced.add(target)
  }
  for (const e of all) {
    noteRef(e.token.$value)
    const modes = modesOf(e.token)
    for (const k of Object.keys(modes)) noteRef(modes[k])
  }

  const follows = (target: string) => flattenAll || primitive.has(target)
  // The number is rendered here, while the chain that decides its unit is still known: past this
  // point it is the CSS string, which is why the native files resolve from the source tree.
  const inline = (leaf: TokenLeaf, value: TokenValue, theme: string): TokenValue => {
    const end = followAliases(byName, leaf, value, theme, follows)
    if (end.chain.length < 2 || typeof end.value !== 'number') return end.value
    const witness = unitWitness(end.chain)
    return cssValue(end.value, witness.path, witness.token)
  }

  const out: TokenTree = {}
  for (const e of all) {
    const name = e.path.join('.')
    if (primitive.has(name)) {
      if (referenced.has(name)) continue
      setToken(out, e.path, e.token)
      continue
    }
    const token = e.token
    const modes = modesOf(token)
    const newModes: Record<string, TokenValue> = {}
    for (const k of Object.keys(modes)) newModes[k] = inline(e, modes[k], k)
    const defMode = collectionDefaultModeOf(token)
    const themeForDefault = defMode && defMode in modes ? defMode : Object.keys(modes)[0]
    const newDefault = inline(e, token.$value, themeForDefault)
    const $extensions = { ...token.$extensions, modes: newModes }
    setToken(out, e.path, { $type: token.$type, $value: newDefault, $extensions })
  }
  return out
}

/* ------------------------------------------------------------------ shape for code */

export interface CodeShapeOptions {
  /** Collections (by name, any case) whose values are substituted into the tokens that use them
   * and which are not emitted themselves — a primitive layer the code should never see. */
  hidden?: readonly string[]
  /** Collections whose modes are viewport widths, emitted as `--bp-<mode>` rather than as
   * themes. A collection named `Breakpoints` always is. */
  breakpoints?: readonly string[]
  /** Leave the text-style mirror (`--typography-h3-*`) out when the file has a typography scale
   * to compose text from. */
  scaleOnly?: boolean
}

/**
 * The `Collection roles` setting, read for the two roles that change what is EMITTED (the rest
 * classify tokens for DESIGN.md — see `parseCollectionRoles`): `Primitives: hidden`,
 * `Breakpoints: breakpoints`.
 */
export interface CollectionModeRoles {
  hidden: string[]
  breakpoints: string[]
  products: string[]
  /** The collection whose modes ARE the themes (`Product: themes` — One Light, Business Dark, …).
   * With one declared, no other collection's modes become a theme. */
  themes: string[]
}

export function parseCollectionModes(raw: string | undefined): CollectionModeRoles {
  const hidden: string[] = []
  const breakpoints: string[] = []
  const products: string[] = []
  const themes: string[] = []
  for (const pair of String(raw ?? '').split(/[,;\n]+/)) {
    const separator = pair.indexOf(pair.indexOf(':') !== -1 ? ':' : '=')
    if (separator === -1) continue
    const collection = pair.slice(0, separator).trim()
    const role = pair.slice(separator + 1).trim().toLowerCase()
    if (!collection) continue
    if (role === 'hidden' || role === 'hide') hidden.push(collection)
    else if (role === 'breakpoints' || role === 'breakpoint' || role === 'bp') breakpoints.push(collection)
    else if (role === 'product') products.push(collection)
    else if (role === 'themes' || role === 'theme') themes.push(collection)
  }
  return { hidden, breakpoints, products, themes }
}

/**
 * The graph as the collection roles say it should be read, before any name is claimed.
 *
 * - A hidden collection yields its names (see `yields`), so the collection that IS emitted keeps
 *   `background/base` instead of `background/base-3`.
 * - With a `themes` collection, its modes are the only themes: it claims names first, and every
 *   other multi-mode collection is read at its default mode — otherwise the old `One` collection's
 *   Light/Dark would sit beside `One Light` / `One Dark` as two more themes.
 * - With `slugThemes`, theme mode names become selector-friendly (`One Light` → `one-light`), so
 *   `[data-theme-name="one-light"]` is what a developer types. Off by default: an existing
 *   consumer's `[data-theme-name="Dark"]` must not change under it.
 */
export function prepareRoleGraph(
  graph: TokenGraph,
  roles: CollectionModeRoles,
  options: { slugThemes?: boolean } = {}
): { graph: TokenGraph; themeDefault?: string; notes: string[] } {
  const lower = (name: string) => name.trim().toLowerCase()
  const hidden = new Set(roles.hidden.map(lower))
  const themeNames = new Set(roles.themes.map(lower))
  const bpNames = new Set(['breakpoints', ...roles.breakpoints.map(lower)])
  const collections = graph.collections || []
  const themeCollections = collections.filter((c) => themeNames.has(lower(c.name)))
  const notes: string[] = []
  for (const name of roles.themes) {
    if (!themeCollections.some((c) => lower(c.name) === lower(name))) notes.push(`"${name}" is set as the themes collection, but the file has no collection by that name`)
  }
  const pinned = new Map<string, string>() // collection id → the one mode it keeps
  const themed = new Set<string>()
  for (const c of collections) {
    if (c.inlineOnly || bpNames.has(lower(c.name)) || hidden.has(lower(c.name))) continue
    if (c.modes.length < 2) continue
    if (themeCollections.length > 0 && !themeNames.has(lower(c.name))) {
      const keep = c.defaultModeId ?? c.modes[0].modeId
      pinned.set(c.id, keep)
      notes.push(`${c.name} read at its default mode (${c.modes.find((m) => m.modeId === keep)?.name}): only ${themeCollections.map((t) => t.name).join(', ')} supplies themes`)
    } else themed.add(c.id)
  }
  const slug = (name: string) => (options.slugThemes ? themeSlug(name) : name)
  const out: TokenGraph = {
    ...graph,
    collections: collections.map((c) => {
      let next: TokenGraphCollection = c
      if (hidden.has(lower(c.name))) next = { ...next, yields: true }
      if (themeNames.has(lower(c.name))) next = { ...next, product: true }
      if (pinned.has(c.id)) next = { ...next, modes: c.modes.filter((m) => m.modeId === pinned.get(c.id)) }
      if (themed.has(c.id) && options.slugThemes) next = { ...next, modes: next.modes.map((m) => ({ ...m, name: slug(m.name) })) }
      return next
    }),
    variables: (graph.variables || []).map((v) =>
      pinned.has(v.collectionId)
        ? { ...v, valuesByMode: { [pinned.get(v.collectionId)!]: v.valuesByMode[pinned.get(v.collectionId)!] } }
        : v
    ),
  }
  const first = themeCollections[0]
  const themeDefault = first ? slug(first.modes.find((m) => m.modeId === first.defaultModeId)?.name ?? first.modes[0]?.name ?? '') : undefined
  return { graph: out, themeDefault, notes }
}

/**
 * The tree as code should see it: only the tokens the file means to hand over.
 *
 * Four layers of Figma bookkeeping go: collections reached only through an alias (a library
 * fetched by id), collections the designer marked hidden, variables named private (`_deprecated/…`)
 * and the breakpoint collection — whose
 * tokens are substituted into whatever points at them, so nothing dangles. Breakpoints come back
 * as `--bp-<mode>` widths, narrowest first, instead of as one theme per viewport. With
 * `scaleOnly`, the text-style mirror goes too, provided there is a scale left to compose from.
 */
export function shapeForCode(graph: TokenGraph, tree: TokenTree, options: CodeShapeOptions = {}): TokenTree {
  const lower = (name: string) => name.trim().toLowerCase()
  const hidden = new Set((options.hidden ?? []).map(lower))
  const bpNames = new Set(['breakpoints', ...(options.breakpoints ?? []).map(lower)])
  const bpCollections = (graph?.collections ?? []).filter((c) => bpNames.has(lower(c.name)))
  const dropTextStyles = options.scaleOnly === true && hasTypographyVars(graph)

  const all = leaves(tree)
  const byName = new Map<string, TokenLeaf>()
  for (const e of all) byName.set(e.path.join('.'), e)

  const isDropped = (token: W3CToken): boolean => {
    if (token.$extensions?.figma?.inlineOnly || token.$extensions?.figma?.private) return true
    const collection = collectionOf(token)
    if (collection === undefined) return false
    const name = lower(collection)
    return hidden.has(name) || bpCollections.some((c) => lower(c.name) === name)
  }
  // Whether a token reached its value through a layer the FILE owns and hid — as opposed to only
  // through a library it consumes. The first makes it a semantic token over a hidden primitive;
  // the second leaves a primitive a primitive (a consumer file's own `colors/b/800` aliasing the library).
  let throughOwnLayer = false
  // `through` collects the dropped tokens the value passes on its way: the part of its alias
  // chain this substitution cuts, and with it the only scope that may say what the number means.
  const resolve = (value: TokenValue, mode: string, through: TokenLeaf[]): TokenValue => {
    if (!isAliasValue(value)) return value
    const target = aliasTarget(value)!.join('.')
    const entry = byName.get(target)
    if (!entry || !isDropped(entry.token) || through.includes(entry)) return value
    if (!entry.token.$extensions?.figma?.inlineOnly) throughOwnLayer = true
    through.push(entry)
    return resolve(valueForTheme(entry.token, mode), mode, through)
  }

  const out: TokenTree = {}
  for (const e of all) {
    if (isDropped(e.token)) continue
    if (dropTextStyles && collectionOf(e.token) === TEXT_STYLE_COLLECTION) continue
    const modes = modesOf(e.token)
    throughOwnLayer = false
    const cuts: TokenLeaf[][] = []
    const newModes: Record<string, TokenValue> = {}
    for (const k of Object.keys(modes)) {
      const through: TokenLeaf[] = []
      newModes[k] = resolve(modes[k], k, through)
      cuts.push(through)
    }
    const defMode = collectionDefaultModeOf(e.token) || Object.keys(modes)[0] || ''
    const defThrough: TokenLeaf[] = []
    const $value = resolve(e.token.$value, defMode, defThrough)
    const wasAlias = throughOwnLayer
    const witness = cutWitness(e.token, [defThrough, ...cuts])
    const figma = e.token.$extensions.figma
    setToken(out, e.path, {
      ...e.token,
      $value,
      $extensions: {
        ...e.token.$extensions,
        modes: newModes,
        ...(figma && (wasAlias || witness)
          ? {
              figma: {
                ...figma,
                ...(wasAlias ? { resolved: true as const } : {}),
                ...(witness ? { unitWitness: witness } : {}),
              },
            }
          : {}),
      },
    })
  }
  for (const coll of bpCollections) {
    const thresholds = Object.entries(breakpointThresholdsOf(graph, coll)).sort((a, b) => a[1] - b[1])
    for (const [name, width] of thresholds) {
      const slug = varName([name])
      if (!slug) continue
      const value = `${width}px`
      setToken(out, ['bp', slug], {
        $type: 'dimension',
        $value: value,
        $extensions: { modes: {}, figma: { collection: coll.name, defaultMode: '' } },
      })
    }
  }
  return out
}

/**
 * One custom property per name. Two variables can spell the same one — `font-weight/regular`
 * (400) and `font/weight/regular` ("regular", a font style name kept for text styles) are both
 * `--font-weight-regular` — and a stylesheet declaring both lets the later win, so the page gets
 * `font-weight: regular`. The value CSS can use is kept: a number or a color over a string, else
 * the first; the rest are dropped and named in `dropped`. `tokens.json` keeps every variable.
 */
export function uniqueVarNames(tree: TokenTree): { tree: TokenTree; dropped: string[] } {
  const all = leaves(tree)
  const byName = new Map<string, TokenLeaf[]>()
  for (const leaf of all) {
    const name = varName(leaf.path)
    byName.set(name, [...(byName.get(name) ?? []), leaf])
  }
  const clashes = [...byName.entries()].filter(([, same]) => same.length > 1)
  if (clashes.length === 0) return { tree, dropped: [] }
  const out: TokenTree = {}
  const keep = new Set<TokenLeaf>()
  const dropped: string[] = []
  for (const [name, same] of byName) {
    const kept = same.find((leaf) => leaf.token.$type !== 'string') ?? same[0]
    keep.add(kept)
    if (same.length > 1) {
      const show = (leaf: TokenLeaf) => `${leaf.path.join('/')} (${JSON.stringify(leaf.token.$value)})`
      dropped.push(`--${name} is ${same.length} variables in Figma — kept ${show(kept)}, left out ${same.filter((l) => l !== kept).map(show).join(', ')}`)
    }
  }
  for (const leaf of all) if (keep.has(leaf)) setToken(out, leaf.path, leaf.token)
  return { tree: out, dropped }
}

/* ------------------------------------------------------------------ theme ordering */

function themeDeclarations(allLeaves: TokenLeaf[], theme: string, label = true): string[] {
  const order: string[] = []
  const groups = new Map<string, TokenLeaf[]>()
  for (const leaf of allLeaves) {
    const col = collectionOf(leaf.token) || ''
    if (!groups.has(col)) {
      groups.set(col, [])
      order.push(col)
    }
    groups.get(col)!.push(leaf)
  }
  const labeled = label && order.some((c) => c !== '')
  const lines: string[] = []
  for (const col of order) {
    if (labeled && col) lines.push(`  /* ${col} */`)
    for (const entry of groups.get(col)!) {
      lines.push(`  --${varName(entry.path)}: ${cssValue(valueForTheme(entry.token, theme), entry.path, entry.token)};`)
    }
  }
  return lines
}

export function orderedThemes(allLeaves: TokenLeaf[], defaultModeName?: string): { defaultTheme: string; ordered: string[] } {
  const themes = themeModesOf(allLeaves, defaultModeName)
  const defaultTheme = pickDefaultTheme(allLeaves, themes, defaultModeName || themes[0])
  const ordered = [defaultTheme].concat(themes.filter((t) => t !== defaultTheme))
  return { defaultTheme, ordered }
}

function themeBlock(allLeaves: TokenLeaf[], theme: string, selector: string): string {
  return `${selector} {\n${themeDeclarations(allLeaves, theme).join('\n')}\n}`
}

function cssAttrValue(value: string): string {
  return String(value).replace(/[\\"]/g, '\\$&')
}

/* ------------------------------------------------------------------ legacy aliases */

/**
 * Keeping an exported key alive after the variable behind it was renamed.
 *
 * A remap renames the primitive layer so `colors/Blue/500` stops claiming to be blue when it
 * is violet. In Figma that is free — a variable keeps its id, so every binding follows. In the
 * *export* it is not: the custom property is named after the variable, so a rename silently
 * deletes `--colors-blue-500` from `tokens.css` and whatever imported it stops resolving.
 *
 * That is the one cost the whole remap was supposed not to have, so the emitters carry the
 * old names forward as aliases:
 *
 *     :root { --colors-blue-500: var(--colors-violet-500); }
 *
 * Three cases are deliberately *not* aliased, because each would make the output worse:
 *
 * - The target never reached the stylesheet. With `inlinePrimitives` on, a primitive that only
 *   semantic tokens referenced is inlined away and has no custom property — so nothing was
 *   lost when it was renamed, and an alias would point at a name that does not exist.
 * - Something still owns the old name. A file that has a real `colors/Blue/500` again would
 *   get two declarations of one property, and the alias would win or lose by source order.
 * - The two names slug to the same custom property, which is a rename CSS never saw.
 */

/** Old variable name → the name it resolves to now. Chains are collapsed by the writer. */
export type RenameMap = Record<string, string>

export interface AliasPair {
  /** CSS custom property name, without the leading `--`. */
  from: string
  to: string
}

/** The `$extensions` key the rename map travels under, inside `tokens.json`. */
export const RENAMES_EXTENSION = 'allcrewChannel'

const segmentsOf = (name: string): string[] => name.split('/').filter((segment) => segment.trim() !== '')

/**
 * The aliases worth emitting for this tree.
 *
 * Order is by the old name so a re-export of an unchanged file produces an identical block.
 */
export function legacyAliasPairs(tree: TokenTree, renames: RenameMap | undefined): AliasPair[] {
  if (!renames) return []
  const emitted = new Set(leaves(tree).map((entry) => varName(entry.path)))
  const pairs: AliasPair[] = []
  const seen = new Set<string>()

  for (const key of Object.keys(renames)) {
    const from = varName(segmentsOf(key))
    const to = varName(segmentsOf(renames[key]))
    if (from === '' || to === '' || from === to) continue
    if (!emitted.has(to) || emitted.has(from) || seen.has(from)) continue
    seen.add(from)
    pairs.push({ from, to })
  }

  return pairs.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
}

export const LEGACY_COMMENT = '/* Renamed by a color remap — the old names keep resolving */'

/**
 * The alias block, or an empty string when there is nothing to alias.
 *
 * `selector` is passed in already wrapped, because the CSS-Module files put `:root` inside
 * `:global(…)` and the aliases have to sit in the same scope as the declarations they shadow.
 */
export function toLegacyAliasCss(pairs: readonly AliasPair[], selector = ':root'): string {
  if (pairs.length === 0) return ''
  const lines = pairs.map((pair) => `  --${pair.from}: var(--${pair.to});`)
  return `${LEGACY_COMMENT}\n${selector} {\n${lines.join('\n')}\n}\n`
}

/* ------------------------------------------------------------------ token emitters */

export function toTokensCss(
  tree: TokenTree,
  ordered: string[],
  defaultTheme: string,
  attr?: string,
  renames?: RenameMap
): string {
  const a = attr || 'data-theme-name'
  const allLeaves = leaves(tree)
  if (allLeaves.length === 0) return ''
  // One theme is no theme: a selector for it would only be something a consumer has to set.
  if (ordered.length <= 1) {
    const legacyOnly = toLegacyAliasCss(legacyAliasPairs(tree, renames))
    return themeBlock(allLeaves, defaultTheme, ':root') + '\n' + (legacyOnly === '' ? '' : '\n' + legacyOnly)
  }
  // The default block holds every token; another theme's block holds only what it changes, so a
  // variable that is the same everywhere is written once instead of once per theme.
  const blocks = ordered
    .map((theme) => {
      const themeSel = `[${a}="${cssAttrValue(theme)}"]`
      if (theme === defaultTheme) return themeBlock(allLeaves, theme, `:root,\n${themeSel}`)
      const differing = allLeaves.filter(
        (leaf) => cssValue(valueForTheme(leaf.token, theme), leaf.path, leaf.token) !== cssValue(valueForTheme(leaf.token, defaultTheme), leaf.path, leaf.token)
      )
      return differing.length === 0 ? '' : themeBlock(differing, theme, themeSel)
    })
    .filter((block) => block !== '')
  // Last, and outside the theme blocks: an alias resolves wherever it is used, so one copy
  // covers every theme.
  const legacy = toLegacyAliasCss(legacyAliasPairs(tree, renames))
  return blocks.join('\n\n') + '\n' + (legacy === '' ? '' : '\n' + legacy)
}

/* ------------------------------------------------------------------ theme axes */

export { parseThemeAxes, type ThemeAxis, type ThemeAxesSpec } from './theme-axes.ts'
export { materializeStructure, migrateStructure, normalizeStructure, deriveLegacy, type ExportStructure, type Materialized } from './structure.ts'

/** The themes laid out as a grid of attributes, the nested one last. Values are what the
 * attributes say (slugs unless the spec renames them). */
export interface ThemeGrid {
  axes: Array<{ attribute: string; values: string[] }>
  /** The theme (mode name) at these attribute values, in axis order. */
  theme: (coords: readonly string[]) => string
  /** The attribute values applied with nothing set, in axis order. */
  defaults: string[]
  /** The last attribute may be set again on a subtree (a dark card in a light page), and the
   * others below an element that sets it. Off: every attribute sits on one element, and the
   * stylesheet needs nothing but plain compound selectors. */
  nested?: boolean
}

/** Every cell of a grid as attribute values, the defaults first on every axis. */
export function gridCoords(grid: ThemeGrid): string[][] {
  let cells: string[][] = [[]]
  grid.axes.forEach((axis, n) => {
    const ordered = [grid.defaults[n], ...axis.values.filter((v) => v !== grid.defaults[n])]
    cells = cells.flatMap((cell) => ordered.map((v) => [...cell, v]))
  })
  return cells
}

/** A grid over materialized axes: cells named `cellName` style (`one-light`), base first. */
export function gridFromAxes(axes: ReadonlyArray<{ attribute: string; labels: string[]; values: string[]; base: string; nested?: boolean }>, name: (cell: readonly string[]) => string): ThemeGrid {
  const byValue = new Map<string, string>()
  let cells: string[][] = [[]]
  for (const axis of axes) cells = cells.flatMap((cell) => axis.labels.map((l) => [...cell, l]))
  for (const cell of cells) byValue.set(cell.map((l, n) => axes[n].values[axes[n].labels.indexOf(l)]).join('\u0000'), name(cell))
  return {
    axes: axes.map((a) => ({ attribute: a.attribute, values: [...a.values] })),
    theme: (coords) => byValue.get(coords.join('\u0000'))!,
    defaults: axes.map((a) => a.values[a.labels.indexOf(a.base)]),
    ...(axes.some((a) => a.nested) ? { nested: true } : {}),
  }
}

/**
 * Places every theme in a cell of the grid the spec describes, or says why it cannot.
 *
 * A cell is filled, in order of authority: by the fold (`fixedCells`, collections as a product
 * axis), by the spec's own `cells` (names that do not spell their cell), by reading the theme's
 * name as one value per attribute (`one-light` is One × Light, and nothing else may be left
 * over), and last by `sameAs` — a value or a cell that shows another. Every theme must land in
 * a cell and every cell must be filled: a mode the grid leaves out would silently never ship,
 * and an empty cell is a selector pair nobody can fill.
 */
export function resolveThemeGrid(
  ordered: readonly string[],
  defaultTheme: string,
  spec: ThemeAxesSpec,
  fixedCells: Record<string, string> = {}
): { grid: ThemeGrid } | { problem: string } {
  const placed = placeThemes(ordered, spec, fixedCells)
  if (placed.problems.length > 0) return { problem: placed.problems[0] }
  const { outer, inner } = orderAxes(spec)
  const slug = (name: string) => varName([name]) || ''
  const valueOf = (v: { label: string; value?: string }) => (v.value ? v.value.replace(/[^A-Za-z0-9_-]/g, '') : slug(v.label))
  const axes = (outer ? [outer, inner] : [inner]).map((axis) => ({ attribute: axis.attribute, labels: axis.values.map((v) => v.label), values: axis.values.map(valueOf) }))
  for (const axis of axes) {
    const twice = axis.values.find((v, n) => axis.values.indexOf(v) !== n)
    if (twice !== undefined) return { problem: `two values of one attribute both read "${twice}"` }
  }
  const cell = placed.cells
  const byValue = new Map<string, string>()
  const outerLabels = outer ? axes[0].labels : ['_']
  outerLabels.forEach((o, n) =>
    inner.values.forEach((i, m) => {
      const coords = outer ? [axes[0].values[n], axes[1].values[m]] : [axes[0].values[m]]
      byValue.set(coords.join('\u0000'), cell[cellKey(o, i.label)])
    })
  )
  let defaults = axes.map((a) => a.values[0])
  search: for (let n = 0; n < outerLabels.length; n++) {
    for (let m = 0; m < inner.values.length; m++) {
      if (cell[cellKey(outerLabels[n], inner.values[m].label)] === defaultTheme) {
        defaults = outer ? [axes[0].values[n], axes[1].values[m]] : [axes[0].values[m]]
        break search
      }
    }
  }
  return {
    grid: {
      axes: axes.map((a) => ({ attribute: a.attribute, values: a.values })),
      theme: (coords) => byValue.get(coords.join('\u0000'))!,
      defaults,
      ...(spec.axes.some((axis) => axis.nested === true) ? { nested: true } : {}),
    },
  }
}

/**
 * Every cell the spec can fill and every reason one cannot, in the order of authority
 * `resolveThemeGrid` describes — kept apart from building the grid so the panel can draw a grid
 * that is still half-filled, with the empty cells marked, instead of only the first complaint.
 */
export function placeThemes(
  ordered: readonly string[],
  spec: ThemeAxesSpec,
  fixedCells: Record<string, string> = {}
): { cells: Record<string, string>; how: Record<string, 'fixed' | 'set' | 'name' | 'same'>; problems: string[] } {
  const { outer, inner } = orderAxes(spec)
  const axes = outer ? [outer, inner] : [inner]
  const slug = (name: string) => varName([name]) || ''
  const segments = (name: string) => slug(name).split('-').filter((s) => s !== '')
  const themeBySlug = new Map(ordered.map((theme) => [slug(theme), theme]))
  const outerLabels = outer ? outer.values.map((v) => v.label) : ['_']
  const cells: Record<string, string> = {}
  const how: Record<string, 'fixed' | 'set' | 'name' | 'same'> = {}
  const problems: string[] = []

  for (const [source, entries] of [['fixed', fixedCells], ['set', spec.cells ?? {}]] as const) {
    for (const [k, mode] of Object.entries(entries)) {
      const theme = themeBySlug.get(slug(mode))
      if (!theme) problems.push(`the cell ${k.replace('|', ' × ')} names the mode "${mode}", which is not one of the themes`)
      else {
        cells[k] = theme
        how[k] = source
      }
    }
  }
  const placed = new Set(Object.values(cells))
  for (const theme of ordered) {
    if (placed.has(theme)) continue
    const parts = segments(theme)
    const used = new Array<boolean>(parts.length).fill(false)
    const picked: string[] = []
    let why = ''
    for (const axis of axes) {
      const hits: Array<{ label: string; at: number; length: number }> = []
      for (const value of axis.values) {
        const words = segments(value.label)
        for (let at = 0; words.length > 0 && at + words.length <= parts.length; at++) {
          if (words.every((word, n) => parts[at + n] === word)) hits.push({ label: value.label, at, length: words.length })
        }
      }
      const distinct = [...new Set(hits.map((hit) => hit.label))]
      if (distinct.length !== 1) {
        why =
          distinct.length === 0
            ? `the mode "${theme}" names no value of ${axis.attribute} (${axis.values.map((v) => v.label).join(', ')})`
            : `the mode "${theme}" names more than one value of ${axis.attribute} (${distinct.join(', ')})`
        break
      }
      const hit = hits[0]
      for (let n = hit.at; n < hit.at + hit.length; n++) {
        if (used[n]) why = `the mode "${theme}" spells two attributes with the same word`
        used[n] = true
      }
      picked.push(hit.label)
    }
    if (!why && used.some((u) => !u)) why = `the mode "${theme}" has words no attribute accounts for`
    if (why) {
      problems.push(why)
      continue
    }
    const k = outer ? cellKey(picked[0], picked[1]) : cellKey('_', picked[0])
    if (cells[k]) {
      problems.push(`the modes "${cells[k]}" and "${theme}" are the same ${k.replace('|', ' × ')}`)
      continue
    }
    cells[k] = theme
    how[k] = 'name'
  }

  // A value that shows another: every cell of it the names left empty.
  for (const axis of axes) {
    for (const value of axis.values) {
      if (!value.sameAs) continue
      for (const o of outerLabels) {
        for (const i of inner.values.map((v) => v.label)) {
          const here = cellKey(o, i)
          const there = axis === outer ? cellKey(value.sameAs, i) : cellKey(o, value.sameAs)
          if (!cells[here] && (axis === outer ? o : i) === value.label && cells[there]) {
            cells[here] = cells[there]
            how[here] = 'same'
          }
        }
      }
    }
  }
  for (const [here, there] of Object.entries(spec.sameAs ?? {})) {
    if (!cells[here] && cells[there]) {
      cells[here] = cells[there]
      how[here] = 'same'
    }
  }
  for (const o of outerLabels) {
    for (const i of inner.values) {
      if (!cells[cellKey(o, i.label)]) problems.push(`no mode is ${outer ? `${slug(o)} × ` : ''}${slug(i.label)} — pick what it shows`)
    }
  }
  return { cells, how, problems }
}

/** The string form's grid — `resolveThemeGrid` over `parseThemeAxes`, last axis nested. */
export function splitThemeGrid(
  ordered: readonly string[],
  defaultTheme: string,
  axes: readonly ThemeAxis[]
): { grid: ThemeGrid } | { problem: string } {
  if (axes.length < 1 || axes.length > 2) return { problem: `theme axes take one or two attributes, ${axes.length} given` }
  const spec: ThemeAxesSpec = {
    axes: axes.map((axis, n) => ({ attribute: axis.attribute, ...(n === axes.length - 1 ? { nested: true } : {}), values: axis.values.map((label) => ({ label })) })),
  }
  return resolveThemeGrid(ordered, defaultTheme, spec)
}

/**
 * The graph and roles a theme axes spec reads: when an attribute takes its values from
 * collections, those collections are folded into one whose modes are the grid
 * (`foldThemeSources`), and it becomes the themes collection — a collection that had that role
 * (a merged copy like a `Product` collection beside its sources) is left out, said in a note, since it would ship the same
 * names twice.
 */
export function applyThemeAxesSources(
  graph: TokenGraph,
  roles: CollectionModeRoles,
  themeAxes: unknown,
  structure?: ExportStructure | null
): { graph: TokenGraph; roles: CollectionModeRoles; cells?: Record<string, string>; found?: Record<string, Record<string, string[]>>; grid?: ThemeGrid; materialized?: Materialized; notes: string[]; problem?: string } {
  if (structure) {
    // The structure stands in for every older setting: the roles it derives are the ones read.
    const made = materializeStructure(graph, structure)
    if (made.problems.length > 0) return { graph, roles, notes: [], problem: made.problems.join('; ') }
    const next: CollectionModeRoles = { hidden: made.roles.hidden, breakpoints: made.roles.breakpoints, products: made.roles.products, themes: made.roles.themes }
    const grid = made.axes.length > 0 ? gridFromAxes(made.axes, (cell) => cellName(made.axes, cell)) : undefined
    return { graph: made.graph, roles: next, ...(grid ? { grid } : {}), materialized: made, notes: made.notes }
  }
  const { spec, problems } = normalizeThemeAxesSpec(themeAxes)
  if (problems.length > 0) return { graph, roles, notes: [], problem: problems.join('; ') }
  if (!spec) return { graph, roles, notes: [] }
  const fold = foldThemeSources(graph, spec)
  if (!fold) return { graph, roles, notes: [] }
  if ('problems' in fold) return { graph, roles, notes: [], problem: fold.problems.join('; ') }
  const notes = [...fold.notes, `Themes read from ${fold.consumed.join(', ')}, merged at export time`]
  const superseded = roles.themes.filter((name) => !fold.consumed.some((c) => c.toLowerCase() === name.trim().toLowerCase()))
  if (superseded.length > 0) notes.push(`${superseded.join(', ')} left out: the themes come from ${fold.consumed.join(', ')} now`)
  return {
    graph: fold.graph,
    roles: { ...roles, themes: [fold.collection], hidden: [...roles.hidden, ...superseded] },
    cells: fold.cells,
    found: fold.found,
    notes,
  }
}

/**
 * One part of the stylesheet for themes that are a grid of attributes, named the way a person
 * says it: the variables that are the same everywhere, the ones a theme changes, and what a
 * product overrides. `tokens.css` is every layer in order; each is also its own module file.
 */
export interface AxesLayer {
  /** The module file's name without `.module.css`: `base`, `light`, `dark`, `business`. */
  name: string
  /** The comment above the layer in `tokens.css` and atop its module file. */
  title: string
  blocks: Array<{ selectors: string[]; body: string }>
}

/**
 * The layers of `tokens.css` for themes that are a grid of attributes — `data-product` ×
 * `data-theme` — instead of one combined name. The last axis is the inner one (the theme), the
 * others outer (the product). Each token is declared under the narrowest selector it needs:
 *
 * - `base` — `:root`: every token that is the same in every cell.
 * - the default theme — `:root, [inner=default]`: every other token, at the default of every axis.
 * - each other theme — `[inner=x]`: every token that changes with the inner axis anywhere.
 * - each other product — `[O]`: what O changes at the default theme, then `[O][inner=x]`: what
 *   only the pair says. Products that change exactly the same things share one layer.
 *
 * With every attribute on one element (`<html data-product data-theme>`) that is all. A `nested`
 * grid also lets the inner attribute be set again on any subtree (a dark card in a light page)
 * and the outer ones below an element that set it (`<html data-theme>` with `<body
 * data-product>`): the product blocks then add `[O] [inner=x]` and `[inner=x] [O]:not([inner])`.
 * Two layouts stay out of reach of selectors even so, since CSS picks by specificity and source
 * order, never by which ancestor is nearer: an outer axis switched again inside itself, and outer
 * values split over two elements.
 */
export function axesLayers(tree: TokenTree, grid: ThemeGrid): AxesLayer[] {
  const allLeaves = leaves(tree)
  if (allLeaves.length === 0) return []
  const nested = grid.nested === true
  const n = grid.axes.length
  const inner = grid.axes[n - 1]
  const outerAxes = grid.axes.slice(0, n - 1)
  const i0 = grid.defaults[n - 1]
  const o0 = grid.defaults.slice(0, n - 1)
  const nonDefault = (o: readonly string[]) => o.filter((v, k) => v !== o0[k]).length
  const combos = gridCoords({ axes: outerAxes, theme: () => '', defaults: o0 }).sort((x, y) => nonDefault(x) - nonDefault(y))
  const key = (o: readonly string[]) => o.join('\u0000')
  const value = (leaf: TokenLeaf, o: readonly string[], i: string) => cssValue(valueForTheme(leaf.token, grid.theme([...o, i])), leaf.path, leaf.token)
  const sel = (attribute: string, v: string) => `[${attribute}="${cssAttrValue(v)}"]`
  const O = (o: readonly string[]) => outerAxes.map((axis, k) => (o[k] === o0[k] ? '' : sel(axis.attribute, o[k]))).join('')
  const I = (v: string) => sel(inner.attribute, v)
  // The combinations under `o`: `o` itself and every one with some of its values reset.
  const under = (o: readonly string[]) => combos.filter((c) => c.every((v, k) => v === o[k] || v === o0[k]))
  const isRoot = (o: readonly string[]) => key(o) === key(o0)
  const declarations = (declared: TokenLeaf[], theme: string) => themeDeclarations(declared, theme, false).join('\n')

  const constant = new Set(allLeaves.filter((leaf) => new Set(gridCoords(grid).map((cell) => value(leaf, cell.slice(0, n - 1), cell[n - 1]))).size === 1))
  const changesWithInner = new Set(allLeaves.filter((leaf) => combos.some((o) => new Set(inner.values.map((i) => value(leaf, o, i))).size > 1)))
  // What each block declares, filled in emission order, so a block states only what the blocks
  // already below it would get wrong — in each layout the selectors support.
  const outerDeclared = new Map<string, Set<TokenLeaf>>([[key(o0), new Set(allLeaves)]])
  const pairDeclared = new Map<string, Set<TokenLeaf>>()
  for (const i of inner.values) if (i !== i0) pairDeclared.set(`${key(o0)}|${i}`, changesWithInner)
  type Candidate = [spec: number, order: number, value: string]
  const best = (cands: Candidate[]) => cands.reduce<Candidate | undefined>((acc, c) => (!acc || c[0] > acc[0] || (c[0] === acc[0] && c[1] > acc[1]) ? c : acc), undefined)?.[2]
  /** The value the cascade yields for `leaf` at (o, i) from the blocks declared so far: with the
   * outer values and the inner on one element (`same`), with the inner switched on a subtree
   * below the outer (`nested`), and with the outer set below an element switching the inner
   * (`below`). A layout that matches nothing inherits from its ancestor. */
  const effective = (leaf: TokenLeaf, o: readonly string[], i: string, layout: 'same' | 'nested' | 'below'): string | undefined => {
    const cands: Candidate[] = []
    // Source order is the tie-break at equal specificity, and it is the order the layers are
    // emitted in: root, the inner blocks, then each product in `combos` order — its own block,
    // then its pairs in the order of the inner values.
    const position = (b: readonly string[]) => combos.findIndex((c) => key(c) === key(b))
    const outerOf = (b: readonly string[], extra: number) => {
      if (!isRoot(b) && outerDeclared.get(key(b))?.has(leaf)) cands.push([nonDefault(b) + extra, 10 + position(b) * 1000, value(leaf, b, i0)])
    }
    const pairOf = (b: readonly string[], extra: number) => {
      if (i !== i0 && pairDeclared.get(`${key(b)}|${i}`)?.has(leaf)) {
        cands.push([(isRoot(b) ? 0 : nonDefault(b)) + 1 + extra, isRoot(b) ? 1 : 11 + position(b) * 1000 + inner.values.indexOf(i), value(leaf, b, i)])
      }
    }
    if (layout === 'same') {
      cands.push([1, 0, value(leaf, o0, i0)])
      for (const b of under(o)) {
        outerOf(b, 0)
        pairOf(b, 0)
      }
      return best(cands)
    }
    if (layout === 'nested') {
      // The subtree element carries only the inner: `[inner=i]`, `O(b) [inner=i]`, and for the
      // default inner the root's `[inner=i0]` and `O(b) [inner=i0]`.
      if (i === i0) {
        cands.push([1, 0, value(leaf, o0, i0)])
        for (const b of under(o)) outerOf(b, 1)
      } else for (const b of under(o)) pairOf(b, 0)
      return cands.length ? best(cands) : effective(leaf, o, i0, 'same')
    }
    // `below`: the element carries the outer values under an ancestor that set the inner.
    for (const b of under(o)) {
      outerOf(b, 0)
      pairOf(b, 1)
    }
    return cands.length ? best(cands) : i === i0 ? value(leaf, o0, i0) : effective(leaf, o0, i, 'same')
  }
  const outerLayouts = nested ? (['same', 'nested'] as const) : (['same'] as const)
  const pairLayouts = nested ? (['same', 'nested', 'below'] as const) : (['same'] as const)

  const layers: AxesLayer[] = []
  const rootTheme = grid.theme([...o0, i0])
  const common = allLeaves.filter((leaf) => constant.has(leaf))
  if (common.length > 0) layers.push({ name: 'base', title: 'base — the same in every theme', blocks: [{ selectors: [':root'], body: declarations(common, rootTheme) }] })
  const themed = allLeaves.filter((leaf) => !constant.has(leaf))
  if (themed.length > 0) {
    layers.push({ name: i0, title: `${i0} — ${I(i0)}, the default`, blocks: [{ selectors: [':root', I(i0)], body: declarations(themed, rootTheme) }] })
  }
  for (const i of inner.values) {
    if (i === i0) continue
    const declared = allLeaves.filter((leaf) => changesWithInner.has(leaf))
    if (declared.length > 0) layers.push({ name: i, title: `${i} — ${I(i)}`, blocks: [{ selectors: [I(i)], body: declarations(declared, grid.theme([...o0, i])) }] })
  }

  const others = combos.filter((o) => !isRoot(o))
  const own = new Map<string, AxesLayer['blocks']>()
  for (const o of others) {
    const declared = allLeaves.filter((leaf) => outerLayouts.some((layout) => value(leaf, o, i0) !== effective(leaf, o, i0, layout)))
    outerDeclared.set(key(o), new Set(declared))
    own.set(key(o), declared.length === 0 ? [] : [{ selectors: nested ? [O(o), `${O(o)} ${I(i0)}`] : [O(o)], body: declarations(declared, grid.theme([...o, i0])) }])
  }
  for (const o of others) {
    for (const i of inner.values) {
      if (i === i0) continue
      const declared = allLeaves.filter((leaf) => pairLayouts.some((layout) => value(leaf, o, i) !== effective(leaf, o, i, layout)))
      pairDeclared.set(`${key(o)}|${i}`, new Set(declared))
      if (declared.length === 0) continue
      const selectors = nested ? [`${O(o)}${I(i)}`, `${O(o)} ${I(i)}`, `${I(i)} ${O(o)}:not([${inner.attribute}])`] : [`${O(o)}${I(i)}`]
      own.get(key(o))!.push({ selectors, body: declarations(declared, grid.theme([...o, i])) })
    }
  }
  // Products that change exactly the same things (Platform = Business today) share one layer —
  // only with one outer axis, where no element can match two of them; with more
  // (`[product=business]` and `[density=compact]`) each keeps its own place.
  const shared: Array<{ names: string[]; blocks: AxesLayer['blocks'] }> = []
  for (const o of others) {
    const blocks = own.get(key(o))!
    if (blocks.length === 0) continue
    const name = o.filter((v, k) => v !== o0[k]).join('-')
    const same = outerAxes.length === 1 ? shared.find((layer) => layer.blocks.length === blocks.length && layer.blocks.every((b, k) => b.body === blocks[k].body)) : undefined
    if (same) {
      same.names.push(name)
      same.blocks.forEach((b, k) => b.selectors.push(...blocks[k].selectors))
    } else shared.push({ names: [name], blocks: blocks.map((b) => ({ selectors: [...b.selectors], body: b.body })) })
  }
  const what = outerAxes.map((axis) => axis.attribute).join(', ')
  for (const layer of shared) layers.push({ name: layer.names[0], title: `${layer.names.join(', ')} — what ${what} changes`, blocks: layer.blocks })
  return layers
}

const renderBlocks = (blocks: AxesLayer['blocks'], wrap: (selector: string) => string = (s) => s) =>
  blocks.map((block) => `${block.selectors.map(wrap).join(',\n')} {\n${block.body}\n}`).join('\n\n')

/** `tokens.css` for a grid: every layer of `axesLayers` in order, each under its title. */
export function toAxesCss(tree: TokenTree, grid: ThemeGrid, renames?: RenameMap): string {
  const layers = axesLayers(tree, grid)
  if (layers.length === 0) return ''
  const legacy = toLegacyAliasCss(legacyAliasPairs(tree, renames))
  return layers.map((layer) => `/* ${layer.title} */\n${renderBlocks(layer.blocks)}`).join('\n\n') + '\n' + (legacy === '' ? '' : '\n' + legacy)
}

/** The layers of `tokens.css`, one CSS Module each (`base.module.css`, `dark.module.css`,
 * `business.module.css`): base plus a theme plus a product is one theme of one product, and all of
 * them together are `tokens.css`. The renamed-token aliases ride with the first file. */
export function toAxesModuleFiles(tree: TokenTree, grid: ThemeGrid, useGlobal?: boolean, renames?: RenameMap): Record<string, string> {
  const wrap = useGlobal ? (sel: string) => `:global(${sel})` : (sel: string) => sel
  const files: Record<string, string> = {}
  const used = new Set<string>()
  axesLayers(tree, grid).forEach((layer, n) => {
    const base = varName([layer.name]) || 'theme'
    let name = base
    for (let k = 2; used.has(name); k++) name = `${base}-${k}`
    used.add(name)
    const legacy = n === 0 ? toLegacyAliasCss(legacyAliasPairs(tree, renames), wrap(':root')) : ''
    files[`${name}.module.css`] = `/* ${layer.title} */\n${renderBlocks(layer.blocks, wrap)}\n` + (legacy === '' ? '' : '\n' + legacy)
  })
  return files
}

/**
 * The stylesheet for a tree: one block per theme, or — with theme axes the themes actually fit —
 * one attribute per axis (`toAxesCss`). `note` says why axes that were asked for were not used,
 * so the export can tell the designer instead of silently going flat; `grid` is what every other
 * document of the package describes.
 */
export function toStylesheet(
  tree: TokenTree,
  ordered: string[],
  defaultTheme: string,
  options: { themeAttr?: string; themeAxes?: unknown; renames?: RenameMap; cells?: Record<string, string>; problem?: string; grid?: ThemeGrid }
): { css: string; note?: string; grid?: ThemeGrid } {
  const flat = () => toTokensCss(tree, ordered, defaultTheme, options.themeAttr, options.renames)
  const fallback = (why: string) => ({
    css: flat(),
    note: `Theme axes not used — ${why}; tokens.css has one [${options.themeAttr || 'data-theme-name'}] block per mode instead`,
  })
  if (options.problem) return fallback(options.problem)
  // A materialized structure already knows its grid; the themes are its cells by construction.
  if (options.grid) return ordered.length > 1 ? { css: toAxesCss(tree, options.grid, options.renames), grid: options.grid } : { css: flat() }
  const { spec, problems } = normalizeThemeAxesSpec(options.themeAxes)
  if (problems.length > 0) return fallback(problems.join('; '))
  if (!spec || ordered.length < 2) return { css: flat() }
  const resolved = resolveThemeGrid(ordered, defaultTheme, spec, options.cells)
  if ('problem' in resolved) return fallback(resolved.problem)
  return { css: toAxesCss(tree, resolved.grid, options.renames), grid: resolved.grid }
}

/** The grid theme axes lay over these themes (default first), or undefined when the setting is
 * empty or does not fit — for callers that hold the setting but not the package's grid. */
export function themeGridOf(ordered: readonly string[], themeAxes: unknown, defaultTheme = ordered[0], cells?: Record<string, string>): ThemeGrid | undefined {
  const { spec } = normalizeThemeAxesSpec(themeAxes)
  if (!spec || ordered.length < 2) return undefined
  const resolved = resolveThemeGrid(ordered, defaultTheme, spec, cells)
  return 'grid' in resolved ? resolved.grid : undefined
}

/** A structure's grid names its cells as the file does (`Dark`); with slugged themes the tree
 * knows them as `dark`, and a cell read under the other name would silently show the default. */
export function slugGridThemes(grid: ThemeGrid | undefined, slugThemes: boolean): ThemeGrid | undefined {
  return grid && slugThemes ? { ...grid, theme: (coords) => themeSlug(grid.theme(coords)) } : grid
}

/** `[data-product="business"][data-theme="dark"]` — the selector of one theme of a grid. */
export function gridSelector(grid: ThemeGrid, theme: string): string {
  for (const coords of gridCoords(grid)) {
    if (grid.theme(coords) === theme) return grid.axes.map((axis, n) => `[${axis.attribute}="${cssAttrValue(coords[n])}"]`).join('')
  }
  return `:root`
}

export function toThemeModuleCssFiles(tree: TokenTree, ordered: string[], defaultTheme: string, attr?: string, useGlobal?: boolean, renames?: RenameMap): Record<string, string> {
  const a = attr || 'data-theme-name'
  const wrap = useGlobal ? (sel: string) => `:global(${sel})` : (sel: string) => sel
  const allLeaves = leaves(tree)
  const files: Record<string, string> = {}
  if (allLeaves.length === 0) return files
  const used = new Set<string>()
  const single = ordered.length <= 1
  for (const theme of ordered) {
    const themeSel = wrap(`[${a}="${cssAttrValue(theme)}"]`)
    const selector = single ? wrap(':root') : theme === defaultTheme ? `${wrap(':root')},\n${themeSel}` : themeSel
    const base = single ? 'default' : varName([theme]) || 'theme'
    let name = base
    let n = 2
    while (used.has(name)) name = `${base}-${n++}`
    used.add(name)
    // The aliases ride with the default theme's file: they belong in exactly one module, and
    // that is the one that also carries `:root`.
    const legacy = theme === defaultTheme ? toLegacyAliasCss(legacyAliasPairs(tree, renames), wrap(':root')) : ''
    files[`${name}.module.css`] = themeBlock(allLeaves, theme, selector) + '\n' + (legacy === '' ? '' : '\n' + legacy)
  }
  return files
}

function buildTsTree(allLeaves: TokenLeaf[]): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const entry of allLeaves) {
    let cursor = root
    for (const segment of entry.path.slice(0, -1)) {
      const next = cursor[segment]
      if (typeof next === 'string' || next === undefined) cursor[segment] = {}
      cursor = cursor[segment] as Record<string, unknown>
    }
    const leaf = entry.path[entry.path.length - 1]
    cursor[leaf] = `var(--${varName(entry.path)})`
  }
  return root
}

function renderTsTree(tree: Record<string, unknown>, indent: string): string {
  const inner = indent + '  '
  const entries = Object.keys(tree).map((key) => {
    const value = tree[key]
    const renderedKey = JSON.stringify(key)
    if (typeof value === 'string') return `${inner}${renderedKey}: ${JSON.stringify(value)},`
    return `${inner}${renderedKey}: ${renderTsTree(value as Record<string, unknown>, inner)},`
  })
  return `{\n${entries.join('\n')}\n${indent}}`
}

export function toTokensTs(tree: TokenTree, themes: string[]): string {
  const allLeaves = leaves(tree)
  const tsTree = buildTsTree(allLeaves)
  return (
    `export const tokens = ${renderTsTree(tsTree, '')} as const;\n` +
    `export type Tokens = typeof tokens;\n\n` +
    `export const themes = ${JSON.stringify(themes)} as const;\n` +
    `export type Theme = (typeof themes)[number];\n`
  )
}

export function toTokensJson(tree: TokenTree, renames?: RenameMap): string {
  // The map travels beside the tree rather than inside it: both walkers treat a node without
  // `$value` as a subtree and a non-object as nothing, so a root `$extensions` yields no
  // leaves in either engine.
  const payload =
    renames && Object.keys(renames).length > 0
      ? { ...tree, $extensions: { [RENAMES_EXTENSION]: { renames } } }
      : tree
  return JSON.stringify(payload, null, 2) + '\n'
}

/* ------------------------------------------------------------------ breakpoint tokens */

const BP_NAMED_WIDTHS: Record<string, number> = { desktop: 1280, tablet: 768, mobile: 375, xl: 1440, lg: 1024, md: 768, sm: 640, xs: 375 }
const DEFAULT_BREAKPOINTS: Record<string, number> = { Desktop: 1280, Tablet: 768, Mobile: 375 }

export function extractBreakpointTokens(graph: TokenGraph): Record<string, number> {
  if (!graph?.collections || !graph?.variables) return {}
  const coll = graph.collections.filter((c) => c.name.trim().toLowerCase() === 'breakpoints')[0]
  return coll ? breakpointWidthsOf(graph, coll) : {}
}

const THRESHOLD_GROUPS = new Set(['breakpoint', 'breakpoints', 'bp', 'min-width'])

/**
 * The min-widths a layout switches at, as code needs them — never the size of a Figma frame.
 *
 * A typical Breakpoints collection holds `Width` = 1440/834/390 per mode: the artboards designers
 * draw on (desktop, iPad 11", iPhone 15). Exported as `--bp-mobile: 390px` it read as "the mobile
 * layout starts at 390px", which is nonsense. Thresholds are variables named `breakpoint/<name>`
 * (or `bp/…`, `min-width/…`), one value whatever the mode. A single-mode collection of plain
 * numbers is read the old way — there every variable IS a threshold. A mode-based collection with
 * no threshold variables yields nothing, and the export says so.
 */
export function breakpointThresholdsOf(graph: TokenGraph, coll: TokenGraphCollection): Record<string, number> {
  const out: Record<string, number> = {}
  const modeId = coll.defaultModeId || coll.modes?.[0]?.modeId || ''
  const valueOf = (v: TokenGraphVariable): number | undefined => {
    const value = (v.valuesByMode as Record<string, unknown>)[modeId] ?? Object.values(v.valuesByMode)[0]
    return typeof value === 'number' && isFinite(value) && value >= 0 ? Math.round(value) : undefined
  }
  const numbers = graph.variables.filter((v) => v.collectionId === coll.id && v.resolvedType === 'FLOAT')
  for (const v of numbers) {
    const segs = v.name.split('/').map((seg) => seg.trim()).filter(Boolean)
    if (segs.length < 2 || !THRESHOLD_GROUPS.has(segs[0].toLowerCase())) continue
    const value = valueOf(v)
    if (value !== undefined) out[segs.slice(1).join('-').toLowerCase()] = value
  }
  if (Object.keys(out).length > 0 || (coll.modes || []).length >= 2) return out
  for (const v of numbers) {
    const value = valueOf(v)
    const segs = v.name.split('/')
    const key = segs[segs.length - 1].trim().toLowerCase()
    if (key && value !== undefined && value > 0) out[key] = value
  }
  return out
}

function breakpointWidthsOf(graph: TokenGraph, coll: TokenGraphCollection): Record<string, number> {
  const bpModeNames: Record<string, number> = { desktop: 1, tablet: 1, mobile: 1, xl: 1, lg: 1, md: 1, sm: 1, xs: 1 }
  const modeKeys = (coll.modes || []).map((m) => m.name.trim().toLowerCase())
  const looksModeBased = (coll.modes || []).length >= 2 && modeKeys.every((k) => bpModeNames[k] || /^\d{3,5}$/.test(k))
  if (looksModeBased) {
    const tokens: Record<string, number> = {}
    for (const v of graph.variables) {
      if (v.collectionId !== coll.id || v.resolvedType !== 'FLOAT') continue
      for (const mode of coll.modes || []) {
        const value = (v.valuesByMode as Record<string, unknown>)[mode.modeId]
        if (typeof value !== 'number' || !isFinite(value) || value <= 0) continue
        const key = mode.name.trim().toLowerCase()
        if (!key) continue
        const existing = tokens[key]
        if (existing === undefined || value > existing) tokens[key] = Math.round(value)
      }
    }
    if (Object.keys(tokens).length > 0) return tokens
  }
  // variable-based fallback
  const tokens2: Record<string, number> = {}
  for (const v of graph.variables) {
    if (v.collectionId !== coll.id || v.resolvedType !== 'FLOAT') continue
    const value = (v.valuesByMode as Record<string, unknown>)[coll.defaultModeId || '']
    if (typeof value !== 'number' || !isFinite(value) || value <= 0) continue
    const segs = v.name.split('/')
    const key = segs[segs.length - 1].trim().toLowerCase()
    if (key) tokens2[key] = Math.round(value)
  }
  return tokens2
}

export function parseBreakpointName(name: string, namedWidths?: Record<string, number>): { slug: string; width: number } | null {
  const nw = namedWidths || BP_NAMED_WIDTHS
  const match = /^(.*)\/([^/]+)$/.exec(String(name).trim())
  if (!match) return null
  const slug = match[1].trim()
  if (!slug) return null
  const suffix = match[2].trim().toLowerCase()
  if (suffix in nw) return { slug, width: nw[suffix] }
  const px = /^(\d+)\s*(?:px)?$/.exec(suffix)
  if (px) return { slug, width: Number(px[1]) }
  return null
}

export function planBreakpointSteps(breakpoints?: Record<string, number>): Array<{ mode: string; width: number }> {
  const bp = breakpoints || DEFAULT_BREAKPOINTS
  const steps: Array<{ mode: string; width: number }> = []
  for (const mode of Object.keys(bp)) {
    const name = String(mode).trim()
    if (!name) continue
    const width = bp[mode]
    if (typeof width !== 'number' || !isFinite(width) || width <= 0) continue
    steps.push({ mode: name, width: Math.round(width) })
  }
  return steps
}

/* ------------------------------------------------------------------ summary + README */

function primaryDefaultMode(graph: TokenGraph): string {
  const collections = (graph?.collections) || []
  for (const c of collections) {
    const modes = c.modes || []
    const mode = modes.find((m) => m.modeId === c.defaultModeId) || modes[0]
    if (mode?.name) return mode.name
  }
  return 'default'
}

function hasTypographyVars(graph: TokenGraph): boolean {
  return (graph?.collections || []).some((c) => c.name.trim().toLowerCase() === 'typography')
}

function hasBreakpointCollection(graph: TokenGraph): boolean {
  return (graph?.collections || []).some((c) => c.name.trim().toLowerCase() === 'breakpoints')
}

function hasGeneratedBpCollection(graph: TokenGraph): boolean {
  return (graph?.collections || []).some((c) => c.name?.trim().toLowerCase() === 'breakpoints' && c.generated)
}

export function buildSummary(graph: TokenGraph, tree: TokenTree): TokenSummary {
  const all = leaves(tree)
  const collections = (graph.collections || []).map((c) => ({
    name: c.name,
    modes: (c.modes || []).map((m) => m.name),
    variableCount: (graph.variables || []).filter((v) => v.collectionId === c.id).length,
  }))
  const textStyleCount = (graph.textStyles || []).length
  if (textStyleCount > 0) collections.push({ name: TEXT_STYLE_COLLECTION, modes: [], variableCount: textStyleCount })
  const effectStyleCount = (graph.effectStyles || []).length
  if (effectStyleCount > 0) collections.push({ name: EFFECT_STYLE_COLLECTION, modes: [], variableCount: effectStyleCount })
  return {
    fileName: graph.fileName || 'Untitled',
    collections,
    totalVariables: (graph.variables || []).length,
    textStyleCount,
    effectStyleCount,
    hasTypographyVars: hasTypographyVars(graph),
    hasGeneratedTypoCollection: (graph.collections || []).some((c) => c.generated),
    hasBreakpointCollection: hasBreakpointCollection(graph),
    hasGeneratedBpCollection: hasGeneratedBpCollection(graph),
    tokenCount: all.length,
    themes: themeModesOf(all),
  }
}

/** The README usage example, built only from variables that actually shipped. A hard-coded
 * `var(--spacing-md)` teaches the reader a name that may not exist — worse than no example. */
function readmeExample(tree: TokenTree | undefined): string {
  if (!tree) return ''
  const all = leaves(tree)
  const firstMatching = (test: (slug: string, type: string) => boolean) => {
    for (const leaf of all) {
      const slug = varName(leaf.path)
      if (test(slug, String(leaf.token.$type || ''))) return slug
    }
    return null
  }
  const background = firstMatching((_slug, type) => type === 'color')
  const padding = firstMatching(
    (slug, type) => type === 'number' && /(^|-)(spacing|space|gap|padding|inset)(-|$)/.test(slug)
  )
  const radius = firstMatching((slug, type) => type === 'number' && /(^|-)(radius|radii|corner)(-|$)/.test(slug))
  const lines = [
    background ? `  background: var(--${background});` : null,
    padding ? `  padding: var(--${padding});` : null,
    radius ? `  border-radius: var(--${radius});` : null,
  ].filter(Boolean)
  if (lines.length === 0) return ''
  return `\n\n\`\`\`css\n.button {\n${lines.join('\n')}\n}\n\`\`\``
}

/** How a consumer sets the theme attributes — the README's half of `toAxesCss`. */
function axesReadme(grid: ThemeGrid): string {
  const list = (values: string[]) => values.map((v) => `\`${v}\``).join(', ')
  const other = (n: number) => grid.axes[n].values.find((v) => v !== grid.defaults[n]) ?? grid.defaults[n]
  const inner = grid.axes[grid.axes.length - 1]
  const n = grid.axes.length - 1
  if (grid.axes.length === 1) {
    return (
      `\n\nThemes are one attribute, \`${inner.attribute}\` (${list(inner.values)}); with none set, \`${grid.defaults[0]}\` applies.\n\n` +
      `\`\`\`html\n<html ${inner.attribute}="${other(0)}">\n\`\`\`\n\nIt can be set again on any element inside (a \`${other(0)}\` card in a \`${grid.defaults[0]}\` page).`
    )
  }
  const outer = grid.axes.slice(0, -1)
  const example = grid.axes.map((axis, k) => `${axis.attribute}="${other(k)}"`).join(' ')
  const head =
    `\n\nThemes are ${grid.axes.length} attributes: ${grid.axes.map((axis) => `\`${axis.attribute}\` (${list(axis.values)})`).join(', ')}. With none set, ` +
    `${grid.defaults.map((d) => `\`${d}\``).join(' × ')} applies.\n\n\`\`\`html\n<html ${example}>\n\`\`\`\n\n`
  if (!grid.nested) return head + `Set ${grid.axes.length === 2 ? 'both' : 'all of them'} on the same element — \`<html>\`, or the root of an app.`
  return (
    head +
    `\`${inner.attribute}\` can be set again on any element inside (a \`${other(n)}\` card in a \`${grid.defaults[n]}\` page), and ` +
    `${outer.map((a) => `\`${a.attribute}\``).join(', ')} may sit on the same element as \`${inner.attribute}\` or below it (\`<body>\` under a themed \`<html>\`). ` +
    `Not supported: ${outer.map((a) => `\`${a.attribute}\``).join(' or ')} switched again inside itself, split over two elements, or set below two different \`${inner.attribute}\` ancestors.`
  )
}

/** `base`, `light`, `dark`, `business` — the layers a grid's stylesheet is cut into, as the
 * README lists them. */
function layerList(tree: TokenTree | undefined, grid: ThemeGrid): string {
  if (!tree) return ''
  return axesLayers(tree, grid)
    .map((layer) => `\`${varName([layer.name]) || 'theme'}\``)
    .join(', ')
}

export function buildReadme(summary: TokenSummary, options: NormalizedOptions, tree?: TokenTree, renames?: RenameMap, themeGrid?: ThemeGrid): string {
  const attr = options.themeAttr
  const themeList = summary.themes.map((t) => `\`${t}\``).join(', ')
  const moduleList = summary.themes.map((t) => `\`${varName([t])}.module.css\``).join(', ')
  const collLines = summary.collections
    .map((c) =>
      c.modes.length
        ? `- **${c.name}** — ${c.variableCount} variables, modes: ${c.modes.map((m) => `\`${m}\``).join(', ')}`
        : c.name === EFFECT_STYLE_COLLECTION
        ? `- **${c.name}** — ${c.variableCount} effect styles → \`shadow/…\` / \`blur/…\` tokens`
        : `- **${c.name}** — ${c.variableCount} text styles → \`typography/…\` tokens`
    )
    .join('\n')
  const defaultTheme = summary.themes[0] || 'Light'
  const others = summary.themes.filter((t) => t !== defaultTheme)
  const grid = themeGrid ?? themeGridOf(summary.themes, options.themeAxes)
  const switchExample = grid
    ? axesReadme(grid)
    : others.length
    ? `\n\nSwitch theme by setting the attribute on any ancestor (e.g. \`<html>\`):\n\n\`\`\`html\n<html ${attr}="${others[0]}">\n\`\`\``
    : ''

  const blockNote = grid
    ? '\n\nThe file is cut into layers, each under a comment: `base` holds what is the same in every theme, then one layer per theme, then what each product changes. ' +
      'A variable sits in the narrowest layer it needs, so a component written with `var(--…)` follows every attribute without knowing any.'
    : `\n\nEach \`[${attr}="…"]\` block re-declares **every** variable for that theme, so toggling\nthe attribute swaps the whole set.`
  const axesNames = grid ? grid.axes.map((axis) => `\`${axis.attribute}\``).join(' × ') : ''
  const layers = grid ? layerList(tree, grid) : ''
  const cssRow = grid
    ? `CSS custom properties, switched by ${axesNames}, in layers: ${layers}. The one file for runtime switching.`
    : 'CSS custom properties. One self-contained block per theme. The merged single file.'
  const rootSel = options.cssModulesGlobal ? ':global(:root)' : ':root'
  const pairSel = grid ? grid.axes.map((axis) => `[${axis.attribute}="…"]`).join('') : `[${attr}="…"]`
  const moduleSel = options.cssModulesGlobal ? `:global(${pairSel})` : pairSel
  const moduleRow = options.emitModuleFiles
    ? grid
      ? `\n| \`<layer>.module.css\` | The layers of \`tokens.css\`, one file each (${layers.replace(/`([^`]+)`/g, '`$1.module.css`')}). Together they are \`tokens.css\`. |`
      : `\n| \`<theme>.module.css\` | The same blocks, one file per theme (${moduleList}). Every variable under \`${moduleSel}\` — the default theme also on \`${rootSel}\`. Concatenated, they reproduce \`tokens.css\`. |`
    : ''

  const inlineNote = !options.inlinePrimitives
    ? 'Primitives are emitted as their own variables; semantic tokens reference them with `var(--…)`.'
    : options.flattenAliases
    ? '**Every** alias is resolved to a literal — no `var(--…)` references remain anywhere. `tokens.json` keeps the full, un-inlined tree for re-import.'
    : 'Primitive (raw, single-mode) values are **inlined** into the semantic tokens that use them, so the primitive layer doesn\'t appear as its own variables. References between semantic tokens stay as `var(--…)`. `tokens.json` keeps the full, un-inlined tree for re-import.'

  const settingsLine = [
    `inline primitives \`${options.inlinePrimitives ? 'on' : 'off'}\``,
    options.inlinePrimitives ? `flatten all \`${options.flattenAliases ? 'on' : 'off'}\`` : null,
    `typography scale \`${options.typoExtract ? 'on' : 'off'}\``,
    options.typoExtract ? `scale only \`${options.typoScaleOnly ? 'on' : 'off'}\`` : null,
    options.typoExtract ? `scale names \`${options.typoNaming === 'value' ? 'by value' : 't-shirt'}\`` : null,
    options.typoExtract && !options.typoScaleOnly ? `font shorthand \`${options.typoShorthand ? 'on' : 'off'}\`` : null,
    grid ? `theme axes ${axesNames}` : `theme attribute \`${attr}\``,
    `per-theme modules \`${options.emitModuleFiles ? 'on' : 'off'}\``,
    options.emitModuleFiles ? `\`:global()\` \`${options.cssModulesGlobal ? 'on' : 'off'}\`` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const typoNote = options.typoExtract && summary.textStyleCount
    ? options.typoScaleOnly
      ? '\n\nText-style values are factored into a shared typography scale (`--font-size-…`, `--font-weight-…`, …). Only the scale is emitted — compose each text style in your own CSS by referencing the primitives directly (e.g. `font-size: var(--font-size-md)`).'
      : '\n\nText-style values are factored into a shared typography scale (`--font-size-…`, `--font-weight-…`, …); each style references the scale with `var(--…)`' +
        (options.typoShorthand ? ', plus a CSS `font` shorthand token per style (`--<style>-font`)' : '') +
        '.'
    : ''

  const aliasPairs = tree ? legacyAliasPairs(tree, renames) : []
  const aliasSection = aliasPairs.length
    ? `\n\n## Renamed tokens\n\n${aliasPairs.length} custom propert${aliasPairs.length === 1 ? 'y was' : 'ies were'} renamed in Figma by a color remap. The old names are still declared at the bottom of \`tokens.css\`, pointing at the new ones, so nothing that already imported them breaks:\n\n\`\`\`css\n${aliasPairs
        .slice(0, 6)
        .map((pair) => `--${pair.from}: var(--${pair.to});`)
        .join('\n')}${aliasPairs.length > 6 ? `\n/* …and ${aliasPairs.length - 6} more */` : ''}\n\`\`\`\n\nThey are aliases, not a second source of truth — migrate to the new names when convenient. \`tokens.ts\` only carries the current names.`
    : ''

  const moduleSection = options.emitModuleFiles && grid
    ? `\n\n## CSS Modules\n\nThe layers of \`tokens.css\`, one file each — ${layers.replace(/`([^`]+)`/g, '`$1.module.css`')}${
        options.cssModulesGlobal ? ' — wrapped in `:global(…)` for CSS-Modules projects (Next.js, etc.)' : ''
      }. Import them in the order of \`tokens.css\`:\n\n\`\`\`ts\n${layers
        .split(', ')
        .map((name) => `import "./${name.replace(/`/g, '')}.module.css";`)
        .join('\n')}\n\`\`\`\n\nA build that never shows a theme or a product may leave its layer out; \`base\` and the default theme (\`${grid.defaults[grid.axes.length - 1]}\`) are always needed.`
    : options.emitModuleFiles
    ? `\n\n## Per-theme CSS Modules\n\nThe same blocks are also emitted one file per theme — ${moduleList}${
        options.cssModulesGlobal ? ' — wrapped in `:global(…)` for CSS-Modules projects (Next.js, etc.)' : ''
      }. Concatenated (or merged by your bundler), they reproduce \`tokens.css\`.\n\n\`\`\`ts\n// build-time: pick one theme, the bundler inlines it\nimport "./${varName([defaultTheme])}.module.css";\n\`\`\`\n\nFor **runtime** switching keep every theme present (use \`tokens.css\`, or import\nall \`*.module.css\`) and toggle \`${attr}\` on an ancestor.`
    : ''

  return `# AllCrew Figma Workspace Design Tokens\n\nGenerated by the **AllCrew Figma Workspace** Figma plugin from **${summary.fileName}**.\n\n- ${summary.totalVariables} variables across ${summary.collections.length} collection(s)${
    summary.textStyleCount ? `\n- ${summary.textStyleCount} text styles → \`typography/…\` tokens` : ''
  }\n- Themes (modes): ${themeList || '`default`'}\n- Settings: ${settingsLine}\n\n## Files\n\n| File | What it is |\n|------|------------|\n| \`tokens.css\` | ${cssRow} |${moduleRow}\n| \`tokens.json\` | Canonical W3C token tree (every mode under \`$extensions.modes\`, source collection under \`$extensions.figma\`). For diffing / re-import. |\n| \`tokens.ts\` | Typed \`tokens\` object (values are \`var(--…)\` refs) + \`themes\` / \`Theme\`. |\n\n${inlineNote}${typoNote}\n\n## Collections\n\n${collLines}\n\n## Using the tokens\n\nImport the stylesheet once:\n\n\`\`\`css\n@import "./tokens.css";\n\`\`\`\n\nThe default theme (\`${defaultTheme}\`) is applied on \`:root\`, so it works with no attribute set.${switchExample}${blockNote}${readmeExample(tree)}${aliasSection}${moduleSection}\n`
}

/* ------------------------------------------------------------------ options + buildPackage */

export interface NormalizedOptions {
  inlinePrimitives: boolean
  flattenAliases: boolean
  themeAttr: string
  emitModuleFiles: boolean
  cssModulesGlobal: boolean
  /** Also emit the asset catalogue, `values-night`, `Tokens.swift` and `Tokens.kt` - see
   * `tokens/native.ts`. Off by default: a colour palette becomes one directory per token, which
   * is noise in a package a web project will unzip. */
  emitNative: boolean
  typoExtract: boolean
  typoScaleOnly: boolean
  typoNaming: 'tshirt' | 'value'
  typoShorthand: boolean
  /** The `Collection roles` setting; `hidden` and `breakpoints` change what is emitted. */
  collectionRoles: string
  /** Theme names as selector slugs (`One Light` → `one-light`). See `prepareRoleGraph`. */
  slugThemes: boolean
  /** How themes become attributes — the picker's spec or its string form (`data-product: One,
   * Business; data-theme: Light, Dark`). See `theme-axes.ts`; empty: one attribute per mode. */
  themeAxes: string | ThemeAxesSpec
  /** The export structure — how collections, groups and modes become the package. When set it
   * supersedes collection roles, the theme table, the theme attribute and the theme axes. See
   * `structure.ts`. */
  structure: ExportStructure | null
  delivery: NormalizedDelivery
}

export interface NormalizedDelivery {
  endpoint: string
  secret: string
  target: 'folder' | 'git' | 'pr' | 'npm'
  route: {
    repo: string
    branch: string
    path: string
    package: string
  }
  onChange: boolean
  onOpen: boolean
}

export const DEFAULT_OPTIONS: NormalizedOptions = {
  inlinePrimitives: true,
  flattenAliases: false,
  themeAttr: 'data-theme-name',
  emitModuleFiles: true,
  cssModulesGlobal: true,
  typoExtract: true,
  typoScaleOnly: true,
  typoNaming: 'tshirt',
  typoShorthand: false,
  emitNative: false,
  collectionRoles: '',
  slugThemes: false,
  themeAxes: '',
  structure: null,
  delivery: {
    endpoint: '',
    secret: '',
    target: 'folder',
    route: { repo: '', branch: '', path: '', package: '' },
    onChange: false,
    onOpen: false,
  },
}

function sanitizeAttr(value: string): string {
  const cleaned = typeof value === 'string' ? value.trim().replace(/[^A-Za-z0-9_-]/g, '') : ''
  return cleaned || DEFAULT_OPTIONS.themeAttr
}

export function normalizeDelivery(d: unknown): NormalizedDelivery {
  const obj = isRecord(d) ? d : {}
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const route = isRecord(obj.route) ? obj.route : {}
  const targets = ['folder', 'git', 'pr', 'npm']
  return {
    endpoint: s(obj.endpoint).trim(),
    secret: s(obj.secret),
    target: targets.indexOf(obj.target as string) !== -1 ? obj.target as NormalizedDelivery['target'] : 'folder',
    route: {
      repo: s(route.repo).trim(),
      branch: s(route.branch).trim(),
      path: s(route.path).trim(),
      package: s(route.package).trim(),
    },
    onChange: !!obj.onChange,
    onOpen: !!obj.onOpen,
  }
}

export function normalizeOptions(o: unknown): NormalizedOptions {
  const obj = isRecord(o) ? o : {}
  const pick = (key: keyof NormalizedOptions) => (obj[key] === undefined ? DEFAULT_OPTIONS[key] : !!obj[key])
  return {
    inlinePrimitives: pick('inlinePrimitives') as boolean,
    flattenAliases: pick('flattenAliases') as boolean,
    emitModuleFiles: pick('emitModuleFiles') as boolean,
    cssModulesGlobal: pick('cssModulesGlobal') as boolean,
    emitNative: pick('emitNative') as boolean,
    typoExtract: pick('typoExtract') as boolean,
    typoScaleOnly: pick('typoScaleOnly') as boolean,
    typoNaming: obj.typoNaming === 'value' ? 'value' : 'tshirt',
    typoShorthand: pick('typoShorthand') as boolean,
    themeAttr: sanitizeAttr(obj.themeAttr as string),
    collectionRoles: typeof obj.collectionRoles === 'string' ? obj.collectionRoles : '',
    slugThemes: pick('slugThemes') as boolean,
    themeAxes: typeof obj.themeAxes === 'string' ? obj.themeAxes.trim() : isRecord(obj.themeAxes) ? (obj.themeAxes as unknown as ThemeAxesSpec) : '',
    structure: normalizeStructure(obj.structure).structure,
    delivery: normalizeDelivery(obj.delivery),
  }
}

/**
 * The graph a product's package is built from — or, with `product` undefined, the shared base.
 *
 * Products are parallel (One, Business, Platform): the same token names, different values, and a
 * consumer loads exactly one. So each package sees the base collections plus ITS product, which
 * claims names first; every other product is reachable only by substitution (`inlineOnly`), so a
 * base token aliasing into a product still resolves instead of dangling, and nothing of another
 * product is ever emitted here.
 */
function productGraph(graph: TokenGraph, productIds: ReadonlySet<string>, product?: string): TokenGraph {
  return {
    ...graph,
    collections: (graph.collections || []).map((c) => {
      if (!productIds.has(c.id)) return c
      return c.id === product ? { ...c, product: true } : { ...c, inlineOnly: true }
    }),
  }
}

function buildProductCss(
  graph: TokenGraph,
  collection: TokenGraphCollection,
  productIds: ReadonlySet<string>,
  opts: NormalizedOptions,
  roles: { hidden: string[]; breakpoints: string[] },
  grid?: ThemeGrid
): { tree: TokenTree; themes: string[]; defaultTheme: string; css: string; note?: string; modules: Record<string, string> } {
  const g = productGraph(graph, productIds, collection.id)
  const shaped = shapeForCode(g, variablesToW3CMultiMode(g), { ...roles, scaleOnly: opts.typoScaleOnly })
  const inlined = opts.inlinePrimitives ? inlinePrimitivesTree(shaped, opts.flattenAliases) : shaped
  const tree: TokenTree = {}
  for (const leaf of leaves(inlined)) if (collectionOf(leaf.token) === collection.name) setToken(tree, leaf.path, leaf.token)
  const hint = collection.modes.find((m) => m.modeId === collection.defaultModeId)?.name ?? collection.modes[0]?.name
  const { defaultTheme, ordered } = orderedThemes(leaves(tree), hint)
  const slug = varName([collection.name]) || 'product'
  const modules: Record<string, string> = {}
  const sheet = toStylesheet(tree, ordered, defaultTheme, { themeAttr: opts.themeAttr, themeAxes: opts.themeAxes, grid })
  if (opts.emitModuleFiles) {
    const themeFiles = sheet.grid ? toAxesModuleFiles(tree, sheet.grid, opts.cssModulesGlobal) : toThemeModuleCssFiles(tree, ordered, defaultTheme, opts.themeAttr, opts.cssModulesGlobal)
    for (const name of Object.keys(themeFiles)) modules[`${slug}-${name}`] = themeFiles[name]
  }
  return { tree, themes: ordered, defaultTheme, css: sheet.css, ...(sheet.note ? { note: `${collection.name}: ${sheet.note}` } : {}), modules }
}

export function buildPackage(rawGraph: TokenGraph, options: unknown, renames?: RenameMap): TokenPackage {
  let opts = normalizeOptions(options)
  // Theme axes may read products from collections: merged first, so every step after sees one
  // themes collection whose modes are the grid.
  const sources = applyThemeAxesSources(rawGraph, parseCollectionModes(opts.collectionRoles), opts.themeAxes, opts.structure)
  const roles = sources.roles
  if (opts.structure && !sources.problem) opts = { ...opts, themeAttr: deriveLegacy(opts.structure).themeAttribute }
  const prepared = prepareRoleGraph(sources.graph, roles, { slugThemes: opts.slugThemes })
  const graph = prepared.graph
  const productNames = new Set(roles.products.map((name) => name.trim().toLowerCase()))
  const products = (graph.collections || []).filter((c) => productNames.has(c.name.trim().toLowerCase()))
  const productIds = new Set(products.map((c) => c.id))
  // With products, tokens.css is the shared base and each product gets its own file.
  const baseGraph = products.length > 0 ? productGraph(graph, productIds) : graph
  // Shaped before anything is counted or emitted: what the file only consumes, what the designer
  // hid and the breakpoint bookkeeping never reach a theme, a stylesheet or the summary.
  const sourceTree = shapeForCode(baseGraph, variablesToW3CMultiMode(baseGraph), {
    hidden: roles.hidden,
    breakpoints: roles.breakpoints,
    scaleOnly: opts.typoScaleOnly,
  })
  const summary = buildSummary(graph, sourceTree)
  if (prepared.notes.length > 0 || sources.notes.length > 0) summary.notes = [...(summary.notes ?? []), ...sources.notes, ...prepared.notes]
  const files: Record<string, string> = {}
  const emitted: TokenPackage['emitted'] = { tree: {}, themes: [], defaultTheme: '' }
  const bpNames = new Set(['breakpoints', ...roles.breakpoints.map((name) => name.trim().toLowerCase())])
  for (const coll of (graph.collections || []).filter((c) => bpNames.has(c.name.trim().toLowerCase()))) {
    if (Object.keys(breakpointThresholdsOf(graph, coll)).length > 0) continue
    const frames = Object.entries(breakpointWidthsOf(graph, coll)).map(([mode, width]) => `${mode} ${width}`).join(', ')
    summary.notes = [
      ...(summary.notes ?? []),
      `${coll.name} holds frame widths${frames ? ` (${frames})` : ''} but no thresholds, so no --bp-* was exported — ` +
        'add FLOAT variables breakpoint/sm, breakpoint/md, … with the min-width of each layout',
    ]
  }
  if (products.length > 0) {
    const fileGrid = (name: string) => {
      const axes = sources.materialized?.fileAxes[name]
      return axes && axes.length > 0 ? slugGridThemes(gridFromAxes(axes, (cell) => cellName(axes, cell)), opts.slugThemes) : undefined
    }
    const built = products.map((collection) => ({ collection, ...buildProductCss(graph, collection, productIds, opts, roles, fileGrid(collection.name)) }))
    for (const b of built) if (b.note) summary.notes = [...(summary.notes ?? []), b.note]
    const namesOf = (tree: TokenTree) => new Set(leaves(tree).map((leaf) => varName(leaf.path)))
    const names = built.map((b) => namesOf(b.tree))
    const union = new Set<string>()
    for (const set of names) for (const name of set) union.add(name)
    summary.products = built.map((b, index) => {
      const file = `${varName([b.collection.name]) || 'product'}.css`
      files[file] = b.css
      for (const name of Object.keys(b.modules)) files[name] = b.modules[name]
      return {
        name: b.collection.name,
        file,
        themes: b.themes,
        tokenCount: names[index].size,
        missing: [...union].filter((name) => !names[index].has(name)).sort(),
      }
    })
    // A component written against one product reads a name another product never defines —
    // said here, where the developer looks, instead of as a blank in production.
    if (summary.products.length > 1) {
      const gaps = summary.products
        .filter((p) => p.missing.length > 0)
        .map((p) => `${p.name} lacks ${p.missing.length} token(s) another product defines (${p.missing.slice(0, 5).map((n) => '--' + n).join(', ')}${p.missing.length > 5 ? ', …' : ''})`)
      if (gaps.length > 0) summary.notes = [...(summary.notes ?? []), ...gaps]
    }
  }
  if (summary.tokenCount > 0 || products.length > 0) {
    const defaultMode = prepared.themeDefault || primaryDefaultMode(graph)
    const { defaultTheme, ordered } = orderedThemes(leaves(sourceTree), defaultMode)
    const unique = uniqueVarNames(opts.inlinePrimitives ? inlinePrimitivesTree(sourceTree, opts.flattenAliases) : sourceTree)
    const cssTree = unique.tree
    if (unique.dropped.length > 0) summary.notes = [...(summary.notes ?? []), ...unique.dropped]
    const sheet = toStylesheet(cssTree, ordered, defaultTheme, { themeAttr: opts.themeAttr, themeAxes: opts.themeAxes, renames, cells: sources.cells, problem: sources.problem, grid: slugGridThemes(sources.grid, opts.slugThemes) })
    files['tokens.css'] = sheet.css
    if (sheet.note) summary.notes = [...(summary.notes ?? []), sheet.note]
    // Everything may live in separate files: an empty shared stylesheet is not worth shipping.
    if (files['tokens.css'].trim() === '') delete files['tokens.css']
    if (opts.emitModuleFiles) {
      const themeFiles = sheet.grid
        ? toAxesModuleFiles(cssTree, sheet.grid, opts.cssModulesGlobal, renames)
        : toThemeModuleCssFiles(cssTree, ordered, defaultTheme, opts.themeAttr, opts.cssModulesGlobal, renames)
      for (const name of Object.keys(themeFiles)) files[name] = themeFiles[name]
    }
    files['tokens.json'] = toTokensJson(sourceTree, renames)
    files['tokens.ts'] = toTokensTs(cssTree, ordered)
    files['README.md'] = buildReadme(summary, opts, cssTree, renames, sheet.grid)
    if (opts.emitNative) {
      // The CSS tree says which tokens ship, so both packages name the same set; the source tree
      // says what they hold. A native constant cannot hold `var(--x)`, and the inlined tree's
      // `"16px"` is already CSS — Swift got that string for a CGFloat. Native follows every alias
      // in the source itself, to the number, whatever `flattenAliases` left for the stylesheet.
      const nativeFiles = toNativeFiles(cssTree, ordered, defaultTheme, sourceTree)
      for (const name of Object.keys(nativeFiles)) files[name] = nativeFiles[name]
    }
    emitted.tree = cssTree
    emitted.themes = ordered
    emitted.defaultTheme = defaultTheme
    if (sheet.grid) emitted.grid = sheet.grid
  }
  return { summary, files, options: opts, emitted }
}
