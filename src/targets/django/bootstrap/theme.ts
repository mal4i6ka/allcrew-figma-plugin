/**
 * REFORM phase 14 (B): Bootstrap theme extraction — the kit masters ARE the theme.
 *
 * Goal: legitimate Bootstrap markup + mechanics with the LOOK fully owned by the designer.
 * Bootstrap 5.3's documented customization API is per-component CSS variables: `.btn-primary`
 * defines `--bs-btn-bg/-hover-bg/-active-bg/…` and the component's structural rules read them.
 * So instead of fighting Bootstrap with pixel CSS, the exporter READS the (possibly designer-
 * modified) kit component sets and REWRITES those variables: recolor the `Variant=Primary`
 * master → `.btn-primary` retunes site-wide; the `State=hover/press` variants become the
 * `-hover-*`/`-active-*` values — Bootstrap's own `:hover`/`:active` rules drive the states,
 * no generated interactions CSS needed. A missing state variant falls back to the base value,
 * so nothing flashes a stock-Bootstrap default the designer never drew.
 *
 * The plugin-side collector (code.ts `collectThemableSets`) walks the export's INSTANCES to the
 * component sets they use (no full-file scan; only what the export actually references), reads
 * each variant's `getCSSAsync` (+ its first TEXT descendant for color/typography — text paint
 * lives on the label node in Figma) and hands this module pure data. Values keep whatever
 * `getCSSAsync` produced — including `var(--Token, #fallback)` references, so token-bound kit
 * fills flow into the theme as live token references.
 *
 * Pilot scope: `kind === 'button'`. The mapping table grows per-kind alongside specs.ts.
 */

/** One variant of a themable component set, as collected in the plugin sandbox. */
export interface ThemableVariantData {
  /** The variant component's name, e.g. `"Variant=Primary, Size=md, State=default"`. */
  name: string
  /** `getCSSAsync()` of the variant root (background, border, border-radius, padding …). */
  css: Record<string, string>
  /** `getCSSAsync()` of the variant's first TEXT descendant (color, font-*) — null when none. */
  labelCss: Record<string, string> | null
}

/** A component set the export references whose kind has a theme mapping. */
export interface ThemableSetData {
  /** Recognizer kind (`matchBootstrapComponent(...).kind`) — the pilot maps 'button'. */
  kind: string
  setName: string
  variants: ThemableVariantData[]
}

/** Aliases mirror the recognizer's variant-prop tolerance (components.ts VARIANT_PROP_NAMES). */
const ROLE_PROP_NAMES = new Set(['variant', 'type', 'style', 'color', 'kind'])
const SIZE_PROP_NAMES = new Set(['size'])
const STATE_PROP_NAMES = new Set(['state'])

/** `"Variant=Primary, Size=md, State=default"` → lower-cased prop map. A segment without `=`
 * (a single-axis set named by bare values) is treated as the role value. */
export function parseVariantName(name: string): Map<string, string> {
  const props = new Map<string, string>()
  for (const segment of name.split(',')) {
    const [rawKey, rawValue] = segment.split('=')
    if (rawValue === undefined) {
      const value = rawKey.trim().toLowerCase()
      if (value) props.set('variant', value)
      continue
    }
    props.set(rawKey.trim().toLowerCase(), rawValue.trim().toLowerCase())
  }
  return props
}

function findProp(props: Map<string, string>, names: ReadonlySet<string>): string | null {
  for (const [key, value] of props) if (names.has(key)) return value
  return null
}

/** default/Standart/rest → base; press/pressed → active (CSS `:active`); unknown states are
 * skipped — disabled/focus theming is a later rung of the mapping table. */
function normalizeState(state: string | null): 'base' | 'hover' | 'active' | null {
  if (state === null) return 'base'
  if (['default', 'standart', 'standard', 'rest', 'enabled', 'base', 'normal'].includes(state)) return 'base'
  if (state === 'hover') return 'hover'
  if (['press', 'pressed', 'active', 'click'].includes(state)) return 'active'
  return null
}

/** sm/Small → sm, md/Medium (and the kit files' "Meduim" typo) → md, lg/Large → lg. */
function normalizeSize(size: string | null): 'sm' | 'md' | 'lg' | null {
  if (size === null) return 'md'
  if (['sm', 'small'].includes(size)) return 'sm'
  if (['md', 'medium', 'meduim', 'default', 'regular'].includes(size)) return 'md'
  if (['lg', 'large'].includes(size)) return 'lg'
  return null
}

/** `"6px 12px 6px 12px"` / `"6px 12px"` / `"6px"` → `{ y, x }` (top and right take precedence —
 * Bootstrap's padding vars are symmetric). */
function parsePadding(padding: string | undefined): { y: string; x: string } | null {
  if (!padding) return null
  const parts = padding.trim().split(/\s+/)
  if (parts.length === 0) return null
  return { y: parts[0], x: parts[1] ?? parts[0] }
}

/** `"1px solid #F8F9FA"` → the color tail (handles `var(--x, #hex)` with inner spaces). */
function parseBorderColor(border: string | undefined): string | null {
  if (!border) return null
  const match = border.match(/^\s*\S+\s+\S+\s+(.+)$/)
  return match ? match[1].trim() : null
}

function background(css: Record<string, string>): string | null {
  return css['background'] ?? css['background-color'] ?? null
}

interface ButtonStateValues {
  color: string | null
  bg: string | null
  borderColor: string | null
}

function buttonStateValues(variant: ThemableVariantData): ButtonStateValues {
  return {
    color: variant.labelCss?.['color'] ?? null,
    bg: background(variant.css),
    borderColor: parseBorderColor(variant.css['border']) ?? variant.css['border-color'] ?? null,
  }
}

function declBlock(selector: string, decls: ReadonlyMap<string, string>): string {
  const lines = [...decls].map(([prop, value]) => `  ${prop}: ${value};`)
  return `${selector} {\n${lines.join('\n')}\n}`
}

/** The button mapping: role variants → `.btn-<role>` var sets (base/hover/active from the State
 * axis), sizes → `.btn`/`.btn-sm`/`.btn-lg` box vars. Returns css rule strings. */
function buildButtonTheme(set: ThemableSetData): string[] {
  interface Row {
    role: string
    size: 'sm' | 'md' | 'lg'
    state: 'base' | 'hover' | 'active'
    variant: ThemableVariantData
  }
  const rows: Row[] = []
  for (const variant of set.variants) {
    const props = parseVariantName(variant.name)
    const role = findProp(props, ROLE_PROP_NAMES)
    const size = normalizeSize(findProp(props, SIZE_PROP_NAMES))
    const state = normalizeState(findProp(props, STATE_PROP_NAMES))
    if (!role || !size || !state) continue
    rows.push({ role, size, state, variant })
  }
  if (rows.length === 0) return []

  const rules: string[] = []

  // Sizes → box vars. md themes the `.btn` base; sm/lg theme their size classes. All rules are
  // un-layered siblings, so `.btn` first + size classes after mirrors Bootstrap's own order and
  // the size class wins on elements carrying both.
  // Un-layered CONSUMER for the radius var: Bootstrap's own `.btn { border-radius: var(…) }` is
  // layered, and layered decorations with higher specificity (`.btn-group > .btn:not(:last-child)
  // { border-top-right-radius: 0 }`, input-group fusing) beat it INSIDE the layer — cutting the
  // design's corners. The theme file is un-layered, so this one declaration outranks every layered
  // decoration regardless of specificity; the var still resolves per element (base/size/instance).
  rules.push('/* un-layered consumer — btn-group/input-group corner-zeroing must not cut the design\'s corners */\n.btn {\n  border-radius: var(--bs-btn-border-radius);\n}')

  const sizeSelector = { md: '.btn', sm: '.btn-sm', lg: '.btn-lg' } as const
  for (const size of ['md', 'sm', 'lg'] as const) {
    const row = rows.find((r) => r.size === size && r.state === 'base')
    if (!row) continue
    const decls = new Map<string, string>()
    const padding = parsePadding(row.variant.css['padding'])
    if (padding) {
      decls.set('--bs-btn-padding-y', padding.y)
      decls.set('--bs-btn-padding-x', padding.x)
    }
    const fontSize = row.variant.labelCss?.['font-size']
    if (fontSize) decls.set('--bs-btn-font-size', fontSize)
    const fontWeight = row.variant.labelCss?.['font-weight']
    if (fontWeight) decls.set('--bs-btn-font-weight', fontWeight)
    const radius = row.variant.css['border-radius']
    if (radius) decls.set('--bs-btn-border-radius', radius)
    if (decls.size > 0) rules.push(declBlock(sizeSelector[size], decls))
  }

  // Roles → color vars per state. Prefer the md row (colors are size-invariant); a missing
  // hover/press variant falls back to the base value so no stock-Bootstrap default leaks in.
  const roleOrder = [...new Set(rows.map((r) => r.role))]
  for (const role of roleOrder) {
    const pick = (state: Row['state']): ThemableVariantData | null =>
      (rows.find((r) => r.role === role && r.state === state && r.size === 'md') ??
        rows.find((r) => r.role === role && r.state === state))?.variant ?? null
    const baseVariant = pick('base')
    if (!baseVariant) continue
    const base = buttonStateValues(baseVariant)
    const hover = pick('hover') ? buttonStateValues(pick('hover')!) : base
    const active = pick('active') ? buttonStateValues(pick('active')!) : base

    const decls = new Map<string, string>()
    const put = (name: string, value: string | null, fallback: string | null = null) => {
      const resolved = value ?? fallback
      if (resolved) decls.set(name, resolved)
    }
    put('--bs-btn-color', base.color)
    put('--bs-btn-bg', base.bg)
    put('--bs-btn-border-color', base.borderColor, 'transparent')
    put('--bs-btn-hover-color', hover.color, base.color)
    put('--bs-btn-hover-bg', hover.bg, base.bg)
    put('--bs-btn-hover-border-color', hover.borderColor, base.borderColor ?? 'transparent')
    put('--bs-btn-active-color', active.color, base.color)
    put('--bs-btn-active-bg', active.bg, base.bg)
    put('--bs-btn-active-border-color', active.borderColor, base.borderColor ?? 'transparent')
    if (decls.size > 0) rules.push(declBlock(`.btn-${role}`, decls))
  }

  return rules
}

const KIND_BUILDERS: Record<string, (set: ThemableSetData) => string[]> = {
  button: buildButtonTheme,
}

// ---- REFORM phase 14 (C): per-instance deltas as Bootstrap var overrides --------------------
//
// A designer override on a kit-button INSTANCE (radius 40 while the master variant has 8) is
// itself legitimate Bootstrap customization: redefine the component's own variables on the
// instance class — `.n4211 { --bs-btn-border-radius: 40px }` — and Bootstrap's structural rules
// pick it up in EVERY state. The css-emitter consults `collectThemedInstanceMasters` and runs
// `themeButtonInstanceDecl` on the instance's declarations: props the theme already carries
// (equal to the master) are dropped, props the designer overrode become var overrides. Figma
// preserves instance overrides across variant swaps, so an overridden background maps to the
// base AND hover AND active vars — the override persists through states, exactly like Figma.

/** Minimal IR shape the matcher needs — kept structural to avoid importing the full IR types. */
interface ThemableInstanceIr {
  id: string
  type: string
  componentSetName?: string | null
  componentProperties?: Record<string, { type: string; value: string | boolean }>
  children?: readonly ThemableInstanceIr[]
}

/** The instance's role/size axis values, read with the same alias tolerance as the set parser. */
function instanceAxisValues(props: Record<string, { type: string; value: string | boolean }>): { role: string | null; size: 'sm' | 'md' | 'lg' | null } {
  let role: string | null = null
  let size: string | null = null
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type !== 'VARIANT' || typeof prop.value !== 'string') continue
    const key = name.trim().toLowerCase()
    if (ROLE_PROP_NAMES.has(key)) role = prop.value.trim().toLowerCase()
    if (SIZE_PROP_NAMES.has(key)) size = prop.value.trim().toLowerCase()
  }
  return { role, size: normalizeSize(size) }
}

/** node id → the matching BASE master-variant css for every themed button instance in the tree.
 * An instance matches by set name, then by role+size (base state); a set with a single role
 * covers instances that carry no role prop. Unmatched instances keep the pixel-CSS path. */
export function collectThemedInstanceMasters(
  nodes: readonly ThemableInstanceIr[],
  sets: readonly ThemableSetData[]
): Map<string, Record<string, string>> {
  interface ParsedRow {
    role: string
    size: 'sm' | 'md' | 'lg'
    css: Record<string, string>
  }
  const parsedBySet = new Map<string, ParsedRow[]>()
  for (const set of sets) {
    if (set.kind !== 'button') continue
    const rows: ParsedRow[] = []
    for (const variant of set.variants) {
      const props = parseVariantName(variant.name)
      const role = findProp(props, ROLE_PROP_NAMES)
      const size = normalizeSize(findProp(props, SIZE_PROP_NAMES))
      const state = normalizeState(findProp(props, STATE_PROP_NAMES))
      if (!role || !size || state !== 'base') continue
      rows.push({ role, size, css: variant.css })
    }
    if (rows.length > 0) parsedBySet.set(set.setName.trim().toLowerCase(), rows)
  }
  if (parsedBySet.size === 0) return new Map()

  const masters = new Map<string, Record<string, string>>()
  const visit = (node: ThemableInstanceIr): void => {
    if (node.type === 'instance-ref' && node.componentSetName) {
      const rows = parsedBySet.get(node.componentSetName.trim().toLowerCase())
      if (rows) {
        const { role, size } = instanceAxisValues(node.componentProperties ?? {})
        const roles = new Set(rows.map((row) => row.role))
        const resolvedRole = role ?? (roles.size === 1 ? [...roles][0] : null)
        if (resolvedRole) {
          const match =
            rows.find((row) => row.role === resolvedRole && row.size === (size ?? 'md')) ??
            rows.find((row) => row.role === resolvedRole)
          if (match) masters.set(node.id, match.css)
        }
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  for (const node of nodes) visit(node)
  return masters
}

/** Is this background expressible through `--bs-btn-bg` (a color, not an image/gradient)?
 * Bootstrap consumes the var via `background-color:` — a gradient there is invalid and would
 * render transparent, so gradients stay on the pixel path. */
function isVarSafeBackground(value: string): boolean {
  return !/gradient\(|url\(/.test(value)
}

/** Normalizes a css value for instance↔master comparison. The instance path runs through the
 * css-emitter's `tokenOverrides` (semantic token names — `var(--background-primary, #FB5B0A)`)
 * while the collector reads the master's raw `getCSSAsync` (`var(--Base-orange-O500, #FB5B0A)`) —
 * SAME color, different alias. Compare by the resolved fallback literal, case/whitespace-folded,
 * with a uniform 4-value radius collapsed to one. Without this, every token-aliased prop showed a
 * false delta — pinning `--bs-btn-hover-bg` to the base color and freezing the hover state. */
function normalizeValue(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null
  let v = value.trim().toLowerCase().replace(/\s+/g, ' ')
  // Unwrap `var(--name, fallback)` → `fallback` (repeat for nested references).
  for (let i = 0; i < 3 && v.includes('var('); i += 1) {
    v = v.replace(/var\(--[^,()]+,\s*([^()]*(?:\([^()]*\))?[^()]*)\)/g, '$1').trim()
  }
  return v
}

function sameValue(a: string | undefined | null, b: string | undefined | null): boolean {
  return normalizeValue(a) === normalizeValue(b)
}

/** `"6px 6px 6px 6px"` ≡ `"6px"`; token aliases resolved via normalizeValue. */
function sameRadius(a: string | undefined | null, b: string | undefined | null): boolean {
  const collapse = (value: string | null): string | null => {
    if (value === null) return null
    const parts = value.split(' ')
    return parts.every((part) => part === parts[0]) ? parts[0] : value
  }
  return collapse(normalizeValue(a)) === collapse(normalizeValue(b))
}

/** Padding compared as parsed y/x pairs — `"6px 12px 6px 12px"` ≡ `"6px 12px"`. */
function samePadding(a: string | undefined | null, b: string | undefined | null): boolean {
  const pa = parsePadding(normalizeValue(a) ?? undefined)
  const pb = parsePadding(normalizeValue(b) ?? undefined)
  if (pa === null || pb === null) return pa === pb
  return pa.y === pb.y && pa.x === pb.x
}

/** Rewrites a themed button INSTANCE's declaration block in place: mapped props equal to the
 * master are dropped (the theme's `.btn`/`.btn-<role>` vars already carry them); mapped props the
 * designer overrode become `--bs-btn-*` overrides. Unmapped props (shadows, filters, gradient
 * fills…) stay pixel CSS — the escape hatch. */
export function themeButtonInstanceDecl(decl: Record<string, string>, masterCss: Record<string, string>): void {
  const master = (property: string): string | undefined => masterCss[property]

  const background = decl['background'] ?? decl['background-color']
  if (background !== undefined && isVarSafeBackground(background)) {
    delete decl['background']
    delete decl['background-color']
    if (!sameValue(background, master('background') ?? master('background-color'))) {
      // A Figma instance override persists across variant swaps — the overridden fill shows in
      // every state, so all three state vars carry it.
      decl['--bs-btn-bg'] = background
      decl['--bs-btn-hover-bg'] = background
      decl['--bs-btn-active-bg'] = background
    }
  }

  const radius = decl['border-radius']
  if (radius !== undefined) {
    delete decl['border-radius']
    if (!sameRadius(radius, master('border-radius'))) decl['--bs-btn-border-radius'] = radius
  }

  const padding = decl['padding']
  if (padding !== undefined) {
    delete decl['padding']
    if (!samePadding(padding, master('padding'))) {
      const parsed = parsePadding(padding)
      if (parsed) {
        decl['--bs-btn-padding-y'] = parsed.y
        decl['--bs-btn-padding-x'] = parsed.x
      }
    }
  }

  const border = decl['border']
  if (border !== undefined) {
    delete decl['border']
    if (!sameValue(border, master('border'))) {
      const width = border.match(/^\s*(\S+)/)?.[1]
      const color = parseBorderColor(border)
      if (width) decl['--bs-btn-border-width'] = width
      if (color) {
        decl['--bs-btn-border-color'] = color
        decl['--bs-btn-hover-border-color'] = color
        decl['--bs-btn-active-border-color'] = color
      }
    }
  }
}

/** Builds `static/css/bootstrap-theme.css` from the collected sets. Empty string when nothing
 * themable — the caller then skips the file and its base.html link entirely. */
export function buildBootstrapTheme(sets: readonly ThemableSetData[]): string {
  const rules: string[] = []
  for (const set of sets) {
    const builder = KIND_BUILDERS[set.kind]
    if (!builder) continue // kinds beyond the pilot keep their pixel-CSS path untouched
    rules.push(...builder(set))
  }
  if (rules.length === 0) return ''
  const header =
    '/* bootstrap-theme.css — GENERATED from the Figma kit masters (REFORM phase 14).\n' +
    '   Per-component Bootstrap variable sets: edit the kit masters and re-export to retheme.\n' +
    '   Loaded after bootstrap-tokens.css, before tokens/project CSS. */'
  return `${header}\n\n${rules.join('\n\n')}\n`
}
