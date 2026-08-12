/**
 * DESIGN.md model — the role-annotated view of a token tree that both target writers render.
 *
 * A coding agent doesn't need a dump of hex codes; it needs to know WHERE a value belongs
 * (`--color-surface-card` → `background-color`) and WHICH values are off-limits. Everything in
 * this file is the derivation of that: token → role → CSS property, plus the context grouping
 * (component blocks, typography styles) that saves the agent from re-deriving relations itself.
 *
 * Pure and figma-global-free — fed by `TokenTree` (src/tokens/engine.ts), Node-testable.
 */

import {
  cssValue,
  leaves,
  varName,
  valueForTheme,
  collectionOf,
  type TokenTree,
  type W3CToken,
} from '../../tokens/engine.ts'

/* ------------------------------------------------------------------ roles */

export type TokenRole =
  | 'surface'
  | 'text'
  | 'border'
  | 'icon'
  | 'shadow'
  | 'blur'
  | 'color'
  | 'spacing'
  | 'radius'
  | 'border-width'
  | 'size'
  | 'font-family'
  | 'font-size'
  | 'font-weight'
  | 'line-height'
  | 'letter-spacing'
  | 'paragraph'
  | 'breakpoint'
  | 'z-index'
  | 'opacity'
  | 'duration'
  | 'easing'
  | 'flag'
  | 'other'

export interface RoleInfo {
  /** Table/section heading. */
  label: string
  /** The CSS property (or properties) this role is meant to land on. */
  css: string
  /** Compact form used when several roles are joined into one "apply to" cell. */
  cssShort?: string
  /** The one-line rule an agent must follow for this role. */
  rule: string
}

/** Rendering order — semantic colors first (what an agent reaches for most), plumbing last. */
export const ROLE_ORDER: readonly TokenRole[] = [
  'surface', 'text', 'border', 'icon', 'shadow', 'blur', 'color',
  'spacing', 'radius', 'border-width', 'size',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'paragraph',
  'breakpoint', 'z-index', 'opacity', 'duration', 'easing', 'flag', 'other',
]

export const ROLE_INFO: Record<TokenRole, RoleInfo> = {
  surface: { label: 'Surface / background', css: 'background-color', rule: 'Container and page backgrounds. Never pair with a hand-picked text color — use a `text` token.' },
  text: { label: 'Text / foreground', css: 'color', rule: 'Text and label color. Pick the one whose name matches the surface it sits on.' },
  border: { label: 'Border / divider', css: 'border-color', rule: 'Borders, dividers, outlines, focus rings.' },
  icon: { label: 'Icon', css: 'color (SVG uses fill: currentColor)', cssShort: 'fill / color', rule: 'Set `color` on the icon wrapper and let the SVG inherit it.' },
  shadow: { label: 'Shadow / elevation', css: 'box-shadow', rule: 'Use as-is; do not re-tune blur, spread or color. Focus rings live here too.' },
  blur: { label: 'Blur', css: 'filter / backdrop-filter', rule: 'Ready-made `blur(…)` function — pick `backdrop-filter` for overlays, `filter` for the element itself.' },
  color: {
    label: 'Color (unscoped)',
    css: 'color / background-color / border-color',
    rule:
      'Neither the name nor a Figma scope says which property this is for — read the token path ' +
      'and the component section before applying it. Scoping the variable in Figma (fill / text / ' +
      'stroke) makes the next export state the property exactly.',
  },
  spacing: { label: 'Spacing', css: 'padding / margin / gap', rule: 'The ONLY allowed spacing values. No arbitrary px.' },
  radius: { label: 'Radius', css: 'border-radius', rule: 'The only allowed corner radii.' },
  'border-width': { label: 'Border width', css: 'border-width / outline-width', rule: 'Stroke thickness.' },
  size: { label: 'Size', css: 'width / height / min-* / max-*', rule: 'Fixed dimensions (icon boxes, control heights, container widths).' },
  'font-family': { label: 'Font family', css: 'font-family', rule: 'Never name a font directly in CSS — reference the token.' },
  'font-size': { label: 'Font size', css: 'font-size', rule: 'The whole type scale. Do not interpolate intermediate sizes.' },
  'font-weight': { label: 'Font weight', css: 'font-weight', rule: 'Only these weights — a weight not on this list has no matching font face.' },
  'line-height': { label: 'Line height', css: 'line-height', rule: 'Unit-less values are ratios; `px` values are absolute.' },
  'letter-spacing': { label: 'Letter spacing', css: 'letter-spacing', rule: 'Tracking, in em or px as exported.' },
  paragraph: { label: 'Paragraph spacing / indent', css: 'margin-block-end / text-indent', rule: 'Figma paragraph metrics — apply to block text, not to headings.' },
  breakpoint: { label: 'Breakpoint', css: '@media (min-width: …)', rule: 'The only breakpoints. Never invent a media query width.' },
  'z-index': { label: 'Z-index / layering', css: 'z-index', rule: 'Stacking order — keep the scale, do not add ad-hoc values.' },
  opacity: { label: 'Opacity', css: 'opacity', rule: 'Use the token instead of a literal decimal.' },
  duration: { label: 'Motion duration', css: 'transition-duration / animation-duration', rule: 'Animation timing comes from tokens, not from taste.' },
  easing: { label: 'Motion easing', css: 'transition-timing-function', rule: 'Use the exported curve, not `ease-in-out`.' },
  flag: { label: 'Boolean flag', css: '— (build-time switch)', rule: 'Not a CSS value: a design-system switch. Read it, do not render it.' },
  other: { label: 'Unclassified', css: '—', rule: 'No role keyword in the name — inspect the path before using it.' },
}

/** Word-boundary matcher tolerant of the plural forms real libraries use — a corporate system
 * names its groups `colors/borders/…`, `colors/fills/…`, `colors/buttons/…`, and a singular-only
 * keyword list silently classifies that entire layer as "unknown". */
function keywords(...words: string[]): RegExp {
  return new RegExp(`(^|-)(?:${words.join('|')})(?:es|s)?(-|$)`)
}

/** Ordered keyword → role table. First match wins, so the specific axes precede the generic
 * color/size buckets (`text-size` must read as a font size, not as a text color). */
const ROLE_RULES: ReadonlyArray<{ role: TokenRole; test: RegExp; types?: readonly string[] }> = [
  { role: 'font-family', test: keywords('font-family', 'font-familie', 'typeface', 'font-stack') },
  { role: 'font-size', test: keywords('font-size', 'text-size', 'type-size', 'fontsize') },
  { role: 'font-weight', test: keywords('font-weight', 'weight', 'fontweight') },
  { role: 'line-height', test: keywords('line-height', 'leading', 'lineheight') },
  { role: 'letter-spacing', test: keywords('letter-spacing', 'tracking', 'letterspacing') },
  { role: 'paragraph', test: keywords('paragraph-spacing', 'paragraph-indent', 'paragraph') },
  { role: 'breakpoint', test: keywords('breakpoint', 'screen', 'viewport') },
  { role: 'duration', test: keywords('duration', 'delay', 'speed') },
  { role: 'easing', test: keywords('ease', 'easing', 'curve', 'bezier', 'timing') },
  { role: 'z-index', test: keywords('z', 'z-index', 'zindex', 'layer', 'stack') },
  { role: 'opacity', test: keywords('opacity', 'alpha', 'transparency') },
  { role: 'radius', test: keywords('radius', 'radii', 'corner', 'rounded', 'roundness') },
  { role: 'border-width', test: keywords('border-width', 'stroke-width', 'outline-width', 'border-size') },
  { role: 'spacing', test: keywords('spacing', 'space', 'gap', 'padding', 'margin', 'inset', 'gutter') },
  { role: 'shadow', test: keywords('shadow', 'elevation', 'glow') },
  { role: 'blur', test: keywords('blur', 'frost') },
  { role: 'icon', test: keywords('icon', 'glyph'), types: ['color'] },
  { role: 'border', test: keywords('border', 'stroke', 'outline', 'divider', 'separator', 'rule'), types: ['color'] },
  { role: 'text', test: keywords('text', 'fg', 'foreground', 'label', 'content', 'ink', 'caption', 'heading', 'title', 'on'), types: ['color'] },
  { role: 'surface', test: keywords('bg', 'background', 'surface', 'canvas', 'fill', 'backdrop', 'elevated', 'card', 'sheet'), types: ['color'] },
  { role: 'size', test: keywords('size', 'width', 'height', 'dimension', 'min', 'max') },
]

/* ------------------------------------------------------------------ scopes */

/**
 * Figma variable scope → role. This is what the DESIGNER declared about where a token may be
 * used, so it outranks every name heuristic: `colors/buttons/primary/default` says nothing in its
 * name, but a `FRAME_FILL` scope says "background" outright.
 */
const SCOPE_ROLES: Record<string, readonly TokenRole[]> = {
  // Figma distinguishes the CONTAINER fill from the VECTOR fill: a token scoped to SHAPE_FILL is
  // an icon/graphic color, not a background. Collapsing both into "surface" mislabels every
  // icon token in a library that scopes properly.
  FRAME_FILL: ['surface'],
  SHAPE_FILL: ['icon'],
  TEXT_FILL: ['text'],
  ALL_FILLS: ['surface', 'icon', 'text'],
  STROKE_COLOR: ['border'],
  EFFECT_COLOR: ['shadow'],
  STROKE_FLOAT: ['border-width'],
  CORNER_RADIUS: ['radius'],
  GAP: ['spacing'],
  WIDTH_HEIGHT: ['size'],
  OPACITY: ['opacity'],
  FONT_FAMILY: ['font-family'],
  FONT_STYLE: ['font-family'],
  FONT_WEIGHT: ['font-weight'],
  FONT_SIZE: ['font-size'],
  LINE_HEIGHT: ['line-height'],
  LETTER_SPACING: ['letter-spacing'],
  PARAGRAPH_SPACING: ['paragraph'],
  PARAGRAPH_INDENT: ['paragraph'],
}

/**
 * Every role a token's scopes allow, in rendering order. Multi-scope is the NORM in a real
 * library — a semantic color scoped to `FRAME_FILL + SHAPE_FILL + TEXT_FILL` is legitimately
 * usable as background, icon and text — so this returns the whole set instead of giving up when
 * the scopes name more than one home.
 */
export function rolesFromScopes(scopes: readonly string[] | undefined): TokenRole[] {
  if (!scopes || scopes.length === 0) return []
  const roles = new Set<TokenRole>()
  for (const scope of scopes) {
    for (const role of SCOPE_ROLES[scope] ?? []) roles.add(role)
  }
  return ROLE_ORDER.filter((role) => roles.has(role))
}

/**
 * Parses the "collection roles" export setting — `Mesure: spacing, Radii: radius` — into a
 * lookup by lowercased collection name. This is the escape hatch for files where scoping the
 * variables in Figma isn't practical: a whole numeric collection gets a role in one line.
 * Unknown role names are dropped rather than guessed.
 */
export function parseCollectionRoles(raw: string | undefined): Record<string, TokenRole> {
  const out: Record<string, TokenRole> = {}
  if (!raw) return out
  for (const pair of raw.split(/[,;\n]+/)) {
    const separator = pair.indexOf(pair.indexOf(':') !== -1 ? ':' : '=')
    if (separator === -1) continue
    const collection = pair.slice(0, separator).trim().toLowerCase()
    const role = pair.slice(separator + 1).trim().toLowerCase()
    if (!collection || !role) continue
    if (Object.prototype.hasOwnProperty.call(ROLE_INFO, role)) out[collection] = role as TokenRole
  }
  return out
}

/** Classifies a token by its Figma path + resolved type. `slug` is `varName(path)`. */
export function classifyRole(slug: string, type: string): TokenRole {
  for (const rule of ROLE_RULES) {
    if (rule.types && rule.types.indexOf(type) === -1) continue
    if (rule.test.test(slug)) return rule.role
  }
  if (type === 'color') return 'color'
  if (type === 'boolean') return 'flag'
  return 'other'
}

/* ------------------------------------------------------------------ interaction states */

/** Interaction states a design system encodes in the token name. Both spellings of each state
 * occur in the wild (`hover` and `hovered`, `press` and `pressed`) — a library that uses the
 * participle form must not read as unclassified. Longest first, so `focus-visible` wins over
 * `focus`. */
const STATE_WORDS = [
  'focus-visible', 'focused', 'focus', 'hovered', 'hover', 'pressed', 'press', 'activated',
  'active', 'disabled', 'readonly', 'selected', 'checked', 'visited', 'expanded', 'collapsed',
  'loading', 'error', 'invalid',
]

/** Resting-value markers. They are not a state delta — `colors/buttons/primary/default` IS the
 * button's base color — but they must be stripped before classification all the same, or the
 * name's role keyword (if any) is never reached. */
const BASE_WORDS = ['default', 'rest', 'resting', 'enabled', 'normal', 'idle', 'base']

/**
 * Splits a trailing state (or resting marker) off the token slug:
 * `…-bg-hovered` → `{ base: '…-bg', state: 'hovered' }`, `…-primary-default` → `{ base: '…-primary' }`.
 *
 * Without this, every `Buttons/Primary/Hovered` token classifies as "role unknown" — in a real
 * library that is most of the color layer, and an agent reading "unclassified" learns nothing.
 */
export function splitState(slug: string): { base: string; state?: string } {
  for (const state of STATE_WORDS) {
    if (slug === state) return { base: '', state }
    if (slug.endsWith(`-${state}`)) return { base: slug.slice(0, -(state.length + 1)), state }
  }
  for (const word of BASE_WORDS) {
    if (slug === word) return { base: '' }
    if (slug.endsWith(`-${word}`)) return { base: slug.slice(0, -(word.length + 1)) }
  }
  return { base: slug }
}

/* ------------------------------------------------------------------ entries */

export interface TokenEntry {
  path: string[]
  /** `colors-action-default` — the CSS custom-property name without the leading `--`. */
  slug: string
  /** `var(--colors-action-default)`. */
  cssRef: string
  /** `tokens.colors.action.default` — the accessor emitted into tokens.ts. */
  tsAccessor: string
  /** W3C `$type`: color | number | string | boolean. */
  type: string
  role: TokenRole
  /** Where the role came from: the variable's own scopes, the name heuristic, or the
   * collection→role export setting. */
  roleSource: 'scope' | 'name' | 'collection'
  /** Every role the token's scopes allow — empty when the variable is unscoped. */
  scopeRoles: TokenRole[]
  /** The CSS property (or properties) this token may land on, scopes first. */
  applyTo: string
  /** Interaction state encoded in the name (`hovered`, `disabled`, …), when there is one. */
  state?: string
  /** Lifecycle marker found in the token name (`EXPERIMENTAL`, `DEPRECATED`, …). */
  lifecycle?: string
  /** Source Figma collection, when the token came from one. */
  collection?: string
  /** Value in the default theme, exactly as `tokens.css` writes it. */
  value: string
  /** Value per theme — only populated when the token actually varies across themes. */
  themeValues: Record<string, string>
  /** True when `themeValues` holds more than one distinct value. */
  themed: boolean
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function tsAccessorOf(path: readonly string[]): string {
  return path.reduce(
    (acc, segment) => (IDENTIFIER.test(segment) ? `${acc}.${segment}` : `${acc}[${JSON.stringify(segment)}]`),
    'tokens'
  )
}

const COLOR_ROLES: readonly TokenRole[] = ['surface', 'text', 'border', 'icon', 'shadow']

/** Joins several roles' CSS properties into one cell, deduped — `text` and `icon` both land on
 * `color`, and printing it twice reads like two different answers. */
function joinCss(roles: readonly TokenRole[]): string {
  const seen: string[] = []
  for (const role of roles) {
    const css = ROLE_INFO[role].cssShort ?? ROLE_INFO[role].css
    for (const part of css.split(' / ')) if (seen.indexOf(part) === -1) seen.push(part)
  }
  return seen.join(' / ')
}

/** Words designers put in a token name to mark it as not-for-production. An agent has no way to
 * know `fills/background EXPERIMENTAL` is a trial balloon unless the spec says so. */
const LIFECYCLE_WORDS = ['experimental', 'deprecated', 'legacy', 'wip', 'draft', 'temp', 'temporary', 'obsolete', 'unused']

/** The lifecycle marker in a Figma path, matched per WORD so `Gold` is not read as `old`. */
export function lifecycleOf(path: readonly string[]): string | undefined {
  for (const segment of path) {
    for (const word of segment.split(/[^A-Za-z]+/)) {
      if (word && LIFECYCLE_WORDS.indexOf(word.toLowerCase()) !== -1) return word.toLowerCase()
    }
  }
  return undefined
}

/**
 * A state token whose own name carries no role (`Button/Primary/Hover`) inherits the role of its
 * siblings when they agree on exactly one — `{Bg, Hover}` makes `Hover` a background. When the
 * siblings disagree (`{Bg, Text, Border, Hover}`) the intent genuinely is not encoded in the name,
 * so it stays ambiguous rather than being guessed.
 */
function inheritSiblingRoles(entries: TokenEntry[]): void {
  const byParent = new Map<string, TokenEntry[]>()
  for (const entry of entries) {
    const parent = entry.path.slice(0, -1).join('/')
    const bucket = byParent.get(parent)
    if (bucket) bucket.push(entry)
    else byParent.set(parent, [entry])
  }
  for (const bucket of byParent.values()) {
    const anchors = new Set(
      bucket.filter((entry) => !entry.state && COLOR_ROLES.indexOf(entry.role) !== -1).map((entry) => entry.role)
    )
    if (anchors.size !== 1) continue
    const [role] = [...anchors]
    // Never override a scope-derived role — the designer already answered this question.
    for (const entry of bucket) if (entry.state && entry.role === 'color' && entry.roleSource === 'name') entry.role = role
  }
}

export function buildTokenEntries(
  tree: TokenTree,
  themes: readonly string[],
  defaultTheme: string,
  collectionRoles: Readonly<Record<string, TokenRole>> = {}
): TokenEntry[] {
  const themeList = themes.length > 0 ? themes : [defaultTheme]
  const entries = leaves(tree).map(({ path, token }) => {
    const slug = varName(path)
    const type = String((token as W3CToken).$type || '')
    const { base, state } = splitState(slug)
    const themeValues: Record<string, string> = {}
    for (const theme of themeList) themeValues[theme] = cssValue(valueForTheme(token, theme), path)
    const distinct = new Set(Object.keys(themeValues).map((theme) => themeValues[theme]))
    // The designer's scopes win. The name heuristic (on the state-stripped slug, so `…-bg-hovered`
    // is still a background) breaks ties inside a multi-scope set and covers unscoped variables:
    // `glyph/primary` scoped to shape+text fill keeps its icon reading, while
    // `buttons/primary/default` — nameless as to role — takes the surface its FRAME_FILL declares.
    const scopeRoles = rolesFromScopes(token.$extensions?.figma?.scopes)
    // A "modes as breakpoints" collection names its variable `Width`, which the size heuristic
    // would happily read as a fixed dimension. The collection it came from settles it.
    const collection = collectionOf(token)?.trim().toLowerCase()
    const named = collection === 'breakpoints' && type === 'number' ? 'breakpoint' : classifyRole(base || slug, type)
    // The collection→role setting only catches what scopes and names both missed — it exists for
    // the worded numeric scale (`number/Base`) that would otherwise land in "Unclassified".
    const mapped = scopeRoles.length === 0 && named === 'other' ? collectionRoles[collection ?? ''] : undefined
    const role = mapped ?? (scopeRoles.length === 0 ? named : scopeRoles.indexOf(named) !== -1 ? named : scopeRoles[0])
    return {
      path,
      slug,
      cssRef: `var(--${slug})`,
      tsAccessor: tsAccessorOf(path),
      type,
      role,
      roleSource: (mapped ? 'collection' : scopeRoles.length > 0 ? 'scope' : 'name') as 'scope' | 'name' | 'collection',
      scopeRoles,
      applyTo: scopeRoles.length > 0 ? joinCss(scopeRoles) : ROLE_INFO[role].css,
      state,
      lifecycle: lifecycleOf(path),
      collection: collectionOf(token),
      value: themeValues[defaultTheme] ?? cssValue(token.$value, path),
      themeValues,
      themed: distinct.size > 1,
    }
  })
  inheritSiblingRoles(entries)
  return entries
}

/* ------------------------------------------------------------------ typography */

/** Axis props `addTextStyleTokens` (engine.ts) writes under `typography/<style>/…`. */
const TYPO_AXES = [
  'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'paragraph-spacing', 'paragraph-indent',
]

export interface TypographyStyle {
  /** Figma text-style name as written in the file, e.g. `Heading/H1`. */
  name: string
  path: string[]
  /** Axis prop → entry (`font-size` → the `--typography-heading-h1-font-size` token). */
  axes: Record<string, TokenEntry>
}

/** Collects the per-text-style typography blocks. Empty when "scale only" dropped them. */
export function collectTypography(entries: readonly TokenEntry[]): TypographyStyle[] {
  const byStyle = new Map<string, TypographyStyle>()
  for (const entry of entries) {
    if (entry.path.length < 3) continue
    if (entry.path[0].toLowerCase() !== 'typography') continue
    const axis = entry.path[entry.path.length - 1]
    if (TYPO_AXES.indexOf(axis) === -1) continue
    const stylePath = entry.path.slice(0, -1)
    const key = stylePath.join('/')
    let style = byStyle.get(key)
    if (!style) {
      style = { name: stylePath.slice(1).join('/'), path: stylePath, axes: {} }
      byStyle.set(key, style)
    }
    style.axes[axis] = entry
  }
  return [...byStyle.values()]
}

/* ------------------------------------------------------------------ component blocks */

/** Names that make a token group a component even when it carries a single role. Matched
 * plural-tolerantly (`buttons`, `tags`) — real libraries pluralize their groups. */
const COMPONENT_WORDS = [
  'button', 'btn', 'card', 'input', 'field', 'form', 'select', 'checkbox', 'radio', 'switch',
  'toggle', 'slider', 'badge', 'chip', 'tag', 'pill', 'alert', 'toast', 'banner', 'modal',
  'dialog', 'drawer', 'offcanvas', 'popover', 'tooltip', 'dropdown', 'menu', 'nav', 'navbar',
  'sidebar', 'tab', 'table', 'list', 'pagination', 'breadcrumb', 'accordion', 'progress',
  'spinner', 'avatar', 'header', 'footer', 'panel', 'link', 'stepper', 'skeleton', 'divider',
  'segmented', 'timeline', 'upload', 'calendar', 'carousel', 'filter', 'rating', 'toolbar',
  'snackbar', 'notification', 'datepicker', 'tile', 'hero', 'empty', 'logo', 'avatar', 'sheet',
]

const COMPONENT_WORD_SET = new Set(COMPONENT_WORDS)

/** `buttons` → `button`, `badges` → `badge`; leaves `progress` alone (checked as-is first). */
function isComponentWord(segment: string): boolean {
  const lower = segment.toLowerCase()
  return COMPONENT_WORD_SET.has(lower) || COMPONENT_WORD_SET.has(lower.replace(/e?s$/, ''))
}

/** One variant of a component: `Color/Button/Primary/*` under the `Color/Button` block. */
export interface ComponentVariant {
  /** `Primary`, or `(base)` for tokens sitting directly on the component. */
  name: string
  entries: TokenEntry[]
}

export interface ComponentBlock {
  /** Display name, e.g. `Button`. */
  name: string
  /** Figma path prefix the component owns, e.g. `Color/Button`. */
  prefix: string[]
  variants: ComponentVariant[]
  entryCount: number
}

function titleCase(segment: string): string {
  return segment.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

const BASE_VARIANT = '(base)'

/** Index of the segment that names a component, or -1. `Component/Button/…` wrappers count too. */
function componentSegmentIndex(path: readonly string[]): number {
  for (let index = 0; index < path.length - 1; index++) {
    const segment = path[index].toLowerCase()
    if ((segment === 'component' || segment === 'components') && index + 1 < path.length - 1) return index + 1
    if (isComponentWord(segment)) return index
  }
  return -1
}

/**
 * Groups tokens by CONTEXT rather than by type, and rolls variants up under one component: a real
 * system has `Color/Button/{Primary,Secondary,Danger,…}/{Bg,Text,Border,Hover…}`, which as flat
 * per-prefix blocks explodes into dozens of near-identical sections. One `Button` block with a
 * variant per row stays readable at any size. Typography is excluded — it has its own section.
 */
export function detectComponentBlocks(entries: readonly TokenEntry[]): ComponentBlock[] {
  const blocks = new Map<string, ComponentBlock>()
  const leftovers: TokenEntry[] = []

  for (const entry of entries) {
    if (entry.path.length < 3) continue
    if (entry.path[0].toLowerCase() === 'typography') continue
    const index = componentSegmentIndex(entry.path)
    if (index === -1) {
      leftovers.push(entry)
      continue
    }
    const prefix = entry.path.slice(0, index + 1)
    const key = prefix.join('/')
    let block = blocks.get(key)
    if (!block) {
      block = { name: titleCase(prefix[prefix.length - 1]), prefix, variants: [], entryCount: 0 }
      blocks.set(key, block)
    }
    const variantName = entry.path.slice(index + 1, -1).map(titleCase).join(' · ') || BASE_VARIANT
    let variant = block.variants.find((candidate) => candidate.name === variantName)
    if (!variant) {
      variant = { name: variantName, entries: [] }
      block.variants.push(variant)
    }
    variant.entries.push(entry)
    block.entryCount++
  }

  // Groups whose name matches no known component word still qualify when one prefix covers
  // several roles (bg + text + border) — that shape only occurs on a component-like thing.
  const byPrefix = new Map<string, TokenEntry[]>()
  for (const entry of leftovers) {
    const prefix = entry.path.slice(0, -1).join('/')
    const bucket = byPrefix.get(prefix)
    if (bucket) bucket.push(entry)
    else byPrefix.set(prefix, [entry])
  }
  for (const [prefix, bucket] of byPrefix) {
    const roles = new Set(bucket.map((entry) => entry.role))
    // Several roles under one prefix (bg + text + border) means a component-like thing; so does a
    // base/hover/subtle triad, where the interaction STATE is the giveaway. A numeric ramp
    // (`Yellow/Y100…Y900`) has neither, and must not be dressed up as a component.
    const hasStates = bucket.some((entry) => entry.state)
    if (bucket.length < 2 || (roles.size < 2 && !hasStates)) continue
    const segments = prefix.split('/')
    blocks.set(prefix, {
      name: titleCase(segments[segments.length - 1]),
      prefix: segments,
      variants: [{ name: BASE_VARIANT, entries: bucket }],
      entryCount: bucket.length,
    })
  }

  for (const block of blocks.values()) {
    block.variants.sort((a, b) => (a.name === BASE_VARIANT ? -1 : b.name === BASE_VARIANT ? 1 : a.name.localeCompare(b.name)))
  }
  // Richest blocks first — they carry the most reusable context.
  return [...blocks.values()].sort(
    (a, b) => b.entryCount - a.entryCount || a.prefix.join('/').localeCompare(b.prefix.join('/'))
  )
}

/* ------------------------------------------------------------------ audits */

export interface DuplicateGroup {
  value: string
  slugs: string[]
}

/**
 * Tokens that resolve to the same value in the default theme. Not an error — but an agent
 * picking "the one with the right hex" instead of "the one with the right role" produces code
 * that breaks the moment the two diverge, so DESIGN.md names them explicitly.
 */
export function findDuplicateValues(entries: readonly TokenEntry[], type = 'color'): DuplicateGroup[] {
  const byValue = new Map<string, string[]>()
  for (const entry of entries) {
    if (entry.type !== type) continue
    if (entry.value.startsWith('var(')) continue
    const bucket = byValue.get(entry.value)
    if (bucket) bucket.push(entry.slug)
    else byValue.set(entry.value, [entry.slug])
  }
  const out: DuplicateGroup[] = []
  for (const [value, slugs] of byValue) if (slugs.length > 1) out.push({ value, slugs })
  return out.sort((a, b) => b.slugs.length - a.slugs.length)
}

/* ------------------------------------------------------------------ model */

export interface DesignTokenModel {
  entries: TokenEntry[]
  byRole: Map<TokenRole, TokenEntry[]>
  typography: TypographyStyle[]
  components: ComponentBlock[]
  duplicateColors: DuplicateGroup[]
  themes: string[]
  defaultTheme: string
}

export function buildTokenModel(
  tree: TokenTree,
  themes: readonly string[],
  defaultTheme: string,
  collectionRoles: Readonly<Record<string, TokenRole>> = {}
): DesignTokenModel {
  const entries = buildTokenEntries(tree, themes, defaultTheme, collectionRoles)
  const byRole = new Map<TokenRole, TokenEntry[]>()
  for (const entry of entries) {
    const bucket = byRole.get(entry.role)
    if (bucket) bucket.push(entry)
    else byRole.set(entry.role, [entry])
  }
  return {
    entries,
    byRole,
    typography: collectTypography(entries),
    components: detectComponentBlocks(entries),
    duplicateColors: findDuplicateValues(entries),
    themes: themes.length > 0 ? [...themes] : [defaultTheme],
    defaultTheme,
  }
}
