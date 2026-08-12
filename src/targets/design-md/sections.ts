/**
 * Shared DESIGN.md section writers — the markdown both targets reuse.
 *
 * Every section is written for a machine reader first: short tables with one row per token,
 * explicit "apply to" columns, and rules phrased as imperatives. Nothing here reads the Figma
 * globals, so the whole file is Node-testable.
 */

import {
  ROLE_INFO,
  ROLE_ORDER,
  type ComponentBlock,
  type DesignTokenModel,
  type TokenEntry,
  type TypographyStyle,
} from './model.ts'

/** Row cap per table. Long systems point at tokens.css/tokens.json for the remainder instead of
 * burning the agent's context — the cut is always stated, never silent. */
export const MAX_ROWS = 120

export function escapeCell(value: string): string {
  return String(value).replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

export function mdTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

/** `16px` → `1rem` (16px root). Returns null for anything that isn't a plain px length. */
export function pxToRem(value: string): string | null {
  const match = /^(-?\d*\.?\d+)px$/.exec(value.trim())
  if (!match) return null
  const rem = Number(match[1]) / 16
  if (!isFinite(rem)) return null
  return `${Number(rem.toFixed(4))}rem`
}

export function withRem(value: string): string {
  const rem = pxToRem(value)
  return rem ? `${value} / ${rem}` : value
}

export function bullet(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join('\n')
}

/** Drops the sections a given export has nothing to say about, then numbers what is left — so a
 * package without, say, breakpoints doesn't ship a gap in the numbering an agent would read as a
 * missing chapter. */
export function renderSections(sections: ReadonlyArray<readonly [string, string]>): string {
  return sections
    .filter(([, content]) => content.trim().length > 0)
    .map(([title, content], index) => `## ${index}. ${title}\n\n${content}`)
    .join('\n\n')
}

/**
 * Renders rows with an explicit overflow footer rather than truncating silently. The overflow is
 * not just a count: the remaining tokens are still listed compactly (second column — the CSS
 * variable), because an agent that doesn't know a token EXISTS will invent a literal instead.
 */
function cappedTable(
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  more: string
): string {
  if (rows.length <= MAX_ROWS) return mdTable(headers, rows)
  const rest = rows.slice(MAX_ROWS)
  const names = rest.map((row) => row[1] ?? row[0]).join(', ')
  return (
    `${mdTable(headers, rows.slice(0, MAX_ROWS))}\n\n` +
    `_+${rest.length} more of this role — values in ${more}:_ ${names}`
  )
}

/* ------------------------------------------------------------------ role tables */

/** The "how do I apply this?" index: one row per role, so the agent maps intent → CSS property
 * before it ever looks at a value. */
export function roleIndexSection(model: DesignTokenModel): string {
  const rows: string[][] = []
  for (const role of ROLE_ORDER) {
    const entries = model.byRole.get(role)
    if (!entries || entries.length === 0) continue
    const info = ROLE_INFO[role]
    const sample = entries.slice(0, 3).map((entry) => `\`${entry.cssRef}\``).join(', ')
    const scoped = entries.filter((entry) => entry.roleSource === 'scope').length
    const count = scoped === entries.length ? String(entries.length) : `${entries.length} (${scoped} scoped)`
    rows.push([info.label, `\`${info.css}\``, count, sample, info.rule])
  }
  return mdTable(['Role', 'Apply to', 'Tokens', 'Examples', 'Rule'], rows)
}

function valueColumns(model: DesignTokenModel): string[] {
  return model.themes.length > 1 ? model.themes : []
}

function entryRow(entry: TokenEntry, themes: readonly string[]): string[] {
  const values = themes.length > 0
    ? themes.map((theme) => `\`${entry.themeValues[theme] ?? entry.value}\``)
    : [`\`${entry.value}\``]
  // First column is the Figma path (what a designer sees, and the key in tokens.json), not the
  // slug — the slug is already visible inside the CSS variable next to it.
  return [`\`${entry.path.join('/')}\``, `\`${entry.cssRef}\``, ...values, `\`${entry.applyTo}\``]
}

/** Full token reference, one table per role. */
export function tokenReferenceSection(model: DesignTokenModel): string {
  const themes = valueColumns(model)
  const valueHeaders = themes.length > 0 ? themes.map((theme) => `Value · ${theme}`) : ['Value']
  const headers = ['Figma token', 'CSS variable', ...valueHeaders, 'Apply to']
  const chunks: string[] = []
  for (const role of ROLE_ORDER) {
    const entries = model.byRole.get(role)
    if (!entries || entries.length === 0) continue
    const rows = entries.map((entry) => entryRow(entry, themes))
    chunks.push(
      `### ${ROLE_INFO[role].label} (${entries.length})\n\n` +
        cappedTable(headers, rows, 'the complete set is in `tokens.css` / `tokens.json`')
    )
  }
  return chunks.length > 0 ? chunks.join('\n\n') : '_No tokens in this export._'
}

/* ------------------------------------------------------------------ component blocks */

/** Components rendered as a full matrix before the rest collapse into the index table. A real
 * library has dozens of components; the matrix keeps each one to a handful of rows. */
export const COMPONENT_DETAIL_LIMIT = 60

/** Role columns per component matrix — more than this and the table stops being readable. */
const MAX_ROLE_COLUMNS = 6

function variantCell(entries: readonly TokenEntry[]): string {
  if (entries.length === 0) return '—'
  // A token scoped to several properties is shown with all of them, or the matrix would imply
  // the column's property is its only home.
  return entries
    .map((entry) => (entry.scopeRoles.length > 1 ? `\`${entry.cssRef}\` (${entry.applyTo})` : `\`${entry.cssRef}\``))
    .join(' ')
}

function stateCell(entries: readonly TokenEntry[]): string {
  if (entries.length === 0) return '—'
  return entries.map((entry) => `${entry.state} \`${entry.cssRef}\``).join(', ')
}

/**
 * One table per component: variants down the rows, roles across the columns, interaction states
 * in their own column. This is the shape that survives scale — a system with 30 components and
 * 4 variants each stays at ~120 rows instead of 120 separate sections.
 */
function componentMatrix(block: ComponentBlock): string {
  const rolesPresent = ROLE_ORDER.filter((role) =>
    block.variants.some((variant) => variant.entries.some((entry) => entry.role === role && !entry.state))
  )
  const roles = rolesPresent.slice(0, MAX_ROLE_COLUMNS)
  const hasStates = block.variants.some((variant) => variant.entries.some((entry) => entry.state))

  const headers = ['Variant', ...roles.map((role) => ROLE_INFO[role].label), ...(hasStates ? ['States'] : [])]
  const rows = block.variants.map((variant) => [
    variant.name,
    ...roles.map((role) => variantCell(variant.entries.filter((entry) => entry.role === role && !entry.state))),
    ...(hasStates ? [stateCell(variant.entries.filter((entry) => entry.state))] : []),
  ])

  const applyLine = roles.map((role) => `${ROLE_INFO[role].label} → \`${ROLE_INFO[role].css}\``).join(' · ')
  // Unscoped, role-less tokens are usable but guessy — point at the one-time fix in Figma rather
  // than leaving the agent to infer the property from a colour value.
  const unscoped = block.variants.some((variant) =>
    variant.entries.some((entry) => entry.role === 'color' && entry.roleSource === 'name')
  )
  const unscopedNote = unscoped
    ? '\n\n_These tokens carry no role in their name and no Figma scope: they are this component\'s ' +
      'own colors — apply each one where the component uses it, and do not reuse them elsewhere._'
    : ''
  const dropped = rolesPresent.length > roles.length
    ? `\n\n_${rolesPresent.length - roles.length} further role(s) on this component are listed in the token reference._`
    : ''

  return (
    `### ${block.name}\n\n` +
    `Figma group \`${block.prefix.join('/')}\` · ${block.entryCount} token(s)` +
    (applyLine ? `\n\nApply: ${applyLine}` : '') +
    `\n\n${mdTable(headers, rows)}${unscopedNote}${dropped}`
  )
}

export function componentBlocksSection(blocks: readonly ComponentBlock[], limit = COMPONENT_DETAIL_LIMIT): string {
  if (blocks.length === 0) {
    return (
      '_No component-scoped token groups found._ Tokens are grouped by type only, so pick them by ' +
      'role (previous section) and keep the choice consistent across a component.'
    )
  }
  const shown = blocks.slice(0, limit)
  const chunks = shown.map(componentMatrix)
  if (blocks.length > shown.length) {
    const rest = blocks.slice(limit)
    // Never drop a component silently: the ones past the detail budget still get name, prefix and
    // size, which is enough to find them in tokens.css.
    chunks.push(
      `### Further component groups (${rest.length})\n\n` +
        mdTable(
          ['Component', 'Figma group', 'Tokens', 'Variants'],
          rest.map((block) => [
            block.name,
            `\`${block.prefix.join('/')}\``,
            String(block.entryCount),
            block.variants.map((variant) => variant.name).slice(0, 8).join(', '),
          ])
        )
    )
  }
  return chunks.join('\n\n')
}

/* ------------------------------------------------------------------ typography */

const TYPO_COLUMNS: ReadonlyArray<{ axis: string; header: string; rem?: boolean }> = [
  { axis: 'font-size', header: 'Size (px / rem)', rem: true },
  { axis: 'font-weight', header: 'Weight' },
  { axis: 'line-height', header: 'Line height' },
  { axis: 'letter-spacing', header: 'Letter spacing' },
  { axis: 'font-family', header: 'Family' },
]

export function typographySection(styles: readonly TypographyStyle[]): string {
  if (styles.length === 0) return ''
  const rows = styles.map((style) => {
    const cells = TYPO_COLUMNS.map(({ axis, rem }) => {
      const entry = style.axes[axis]
      if (!entry) return '—'
      return rem ? withRem(entry.value) : entry.value
    })
    const prefix = style.axes['font-size']?.slug.replace(/-font-size$/, '')
    return [style.name, ...cells, prefix ? `\`--${prefix}-*\`` : '—']
  })
  const table = cappedTable(
    ['Text style', ...TYPO_COLUMNS.map((column) => column.header), 'Token prefix'],
    rows,
    'the complete set is in `tokens.css`'
  )

  const sample = styles[0]
  const axes = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing']
    .filter((axis) => sample.axes[axis])
    .map((axis) => `  ${axis}: ${sample.axes[axis].cssRef};`)
    .join('\n')
  const className = sample.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'text-style'
  const example = axes
    ? `\n\nCompose a text style by referencing its tokens — never by copying the numbers:\n\n\`\`\`css\n/* ${sample.name} */\n.${className} {\n${axes}\n}\n\`\`\``
    : ''

  return `${table}${example}`
}

/* ------------------------------------------------------------------ themes */

export function themesSection(model: DesignTokenModel, themeAttribute: string): string {
  const themed = model.entries.filter((entry) => entry.themed).length
  if (model.themes.length < 2) {
    return (
      `Single theme (\`${model.defaultTheme}\`) — every variable is declared on \`:root\`. ` +
      'No theme attribute is required.'
    )
  }
  const others = model.themes.filter((theme) => theme !== model.defaultTheme)
  return (
    `Themes: ${model.themes.map((theme) => `\`${theme}\``).join(', ')} — ` +
    `\`${model.defaultTheme}\` is the default and is declared on \`:root\`. ` +
    `${themed} token(s) change value between themes.\n\n` +
    `Switch by setting \`${themeAttribute}\` on an ancestor (usually \`<html>\`):\n\n` +
    '```html\n' +
    `<html ${themeAttribute}="${others[0]}">\n` +
    '```\n\n' +
    'Every theme block re-declares **every** variable, so a component written with `var(--…)` ' +
    'themes itself. Do NOT write theme-specific overrides in component CSS, and do NOT branch on ' +
    'the theme in JS to pick a color.'
  )
}

/* ------------------------------------------------------------------ breakpoints */

export function breakpointsSection(model: DesignTokenModel, modeWidths?: Record<string, number>): string {
  const widths = Object.keys(modeWidths ?? {}).map((name) => (modeWidths ?? {})[name])
  const rows = [...(model.byRole.get('breakpoint') ?? [])]
    // The mode rows below already carry this width — the variable and its modes are the same
    // breakpoint, and listing both reads like two independent sources.
    .filter((entry) => widths.indexOf(parseFloat(entry.value)) === -1)
    .sort((a, b) => parseFloat(a.value) - parseFloat(b.value))
    .map((entry) => [`\`${entry.slug}\``, entry.value, `\`@media (min-width: ${entry.value})\``])

  // A "modes as breakpoints" collection (Desktop/Tablet/Mobile modes on one Width variable) has no
  // per-breakpoint variable at all — without this the section would read "no breakpoints" for a
  // library that very much has them.
  const fromModes = Object.keys(modeWidths ?? {})
    .map((name) => ({ name, width: (modeWidths ?? {})[name] }))
    .filter((entry) => typeof entry.width === 'number' && isFinite(entry.width))
    .sort((a, b) => a.width - b.width)
  for (const entry of fromModes) {
    rows.push([`${entry.name} _(Figma mode)_`, `${entry.width}px`, `\`@media (min-width: ${entry.width}px)\``])
  }
  if (rows.length === 0) return ''

  return (
    `${mdTable(['Token / mode', 'Width', 'Media query'], rows)}\n\n` +
    'These are the only breakpoints. CSS custom properties do not work inside a media-query ' +
    'condition, so write the literal width above (or compile it from `tokens.json`) — never a ' +
    'different one.' +
    (fromModes.length > 0
      ? ' The widths marked _(Figma mode)_ come from a modes-as-breakpoints collection, so they ' +
        'exist as layout modes in Figma rather than as CSS variables.'
      : '')
  )
}

/* ------------------------------------------------------------------ guardrails */

/** Token-derived DO-NOTs shared by both targets (the scene-audit rules are per target). */
export function tokenGuardrails(model: DesignTokenModel): string[] {
  const rules: string[] = []
  const colors = [
    ...(model.byRole.get('surface') ?? []),
    ...(model.byRole.get('text') ?? []),
    ...(model.byRole.get('border') ?? []),
    ...(model.byRole.get('icon') ?? []),
    ...(model.byRole.get('color') ?? []),
  ]
  if (colors.length > 0) {
    rules.push(
      `**DO NOT** write raw colors (\`#fff\`, \`rgb(…)\`, \`hsl(…)\`, named colors) in CSS, inline ` +
        `styles, or SVG attributes. ${colors.length} color tokens cover this system; if none fits, ` +
        `the design is missing a token — say so instead of inventing one.`
    )
  }
  const spacing = model.byRole.get('spacing') ?? []
  if (spacing.length > 0) {
    const values = [...new Set(spacing.map((entry) => entry.value))].slice(0, 12).join(', ')
    rules.push(
      `**DO NOT** use arbitrary spacing (\`padding: 13px\`, \`gap: 7px\`). Allowed values come from ` +
        `\`--${spacing[0].slug}\`-style tokens only (${values}).`
    )
  }
  const radius = model.byRole.get('radius') ?? []
  if (radius.length > 0) {
    const values = [...new Set(radius.map((entry) => entry.value))].slice(0, 8).join(', ')
    rules.push(`**DO NOT** invent corner radii. The scale is ${values} — reference the radius tokens.`)
  }
  const weights = model.byRole.get('font-weight') ?? []
  if (weights.length > 0) {
    const values = [...new Set(weights.map((entry) => entry.value))].sort().join(', ')
    rules.push(
      `**DO NOT** use a font weight outside ${values} — other weights have no matching font face ` +
        'and the browser will synthesize (smear) them.'
    )
  }
  const shadows = model.byRole.get('shadow') ?? []
  if (shadows.length > 0) {
    rules.push(
      `**DO NOT** hand-write a \`box-shadow\` or a focus \`outline\`. ${shadows.length} shadow ` +
        'token(s) cover elevation and focus states — a custom one will not match the design and ' +
        'will not follow a theme change.'
    )
  }
  const sizes = model.byRole.get('font-size') ?? []
  if (sizes.length > 0) {
    rules.push(
      `**DO NOT** interpolate font sizes. The type scale has ${sizes.length} step(s); pick the ` +
        'closest existing one.'
    )
    // Steps closer than half a pixel make "pick the closest" a coin flip — that is a design-file
    // duplicate, not a scale, and the agent must not be the one to resolve it.
    const ordered = sizes
      .map((entry) => ({ entry, px: parseFloat(entry.value) }))
      .filter((step) => isFinite(step.px))
      .sort((a, b) => a.px - b.px)
    const nearDuplicates: string[] = []
    for (let index = 1; index < ordered.length; index++) {
      const previous = ordered[index - 1]
      const current = ordered[index]
      if (current.px - previous.px < 0.5) {
        nearDuplicates.push(
          `\`--${previous.entry.slug}\` (${previous.entry.value}) vs \`--${current.entry.slug}\` (${current.entry.value})`
        )
      }
    }
    if (nearDuplicates.length > 0) {
      rules.push(
        `**Probable duplicate type-scale steps** — less than 0.5px apart, so "pick the closest" ` +
          `cannot choose between them: ${nearDuplicates.join('; ')}. Ask the designer which step is ` +
          'canonical; do not resolve the tie yourself.'
      )
    }
  }
  if (model.duplicateColors.length > 0) {
    const sample = model.duplicateColors
      .slice(0, 3)
      .map((group) => `${group.value} → ${group.slugs.map((slug) => `\`--${slug}\``).join(' / ')}`)
      .join('; ')
    rules.push(
      `**Pick tokens by role, not by value.** Some tokens currently resolve to the same value ` +
        `(${sample}) — they are separate on purpose and will diverge.`
    )
  }
  const flagged = model.entries.filter((entry) => entry.lifecycle)
  if (flagged.length > 0) {
    const sample = flagged
      .slice(0, 8)
      .map((entry) => `\`${entry.cssRef}\` (${entry.lifecycle})`)
      .join(', ')
    rules.push(
      `**DO NOT use tokens the designer marked as not-final** — ${flagged.length} token(s) carry a ` +
        `lifecycle marker in their name: ${sample}${flagged.length > 8 ? ', …' : ''}. They can change ` +
        'or disappear without notice; pick the stable token for the same role instead.'
    )
  }
  const ambiguous = model.byRole.get('color') ?? []
  if (ambiguous.length > 0) {
    rules.push(
      `**${ambiguous.length} color token(s) carry no role keyword** (bg/text/border/icon) in their ` +
        'name. Read the token path before applying one, and prefer a role-named token when one exists.'
    )
  }
  const unclassified = model.byRole.get('other') ?? []
  // An unclassified NUMERIC scale is the project's measurement system, not an internal: when no
  // spacing/radius tokens shipped, these values are the only legal paddings and radii, and a
  // guardrail that quarantines them (while "no raw px" stands) makes the package unstylable.
  const numeric = unclassified.filter((entry) => entry.type === 'number')
  const nonNumeric = unclassified.filter((entry) => entry.type !== 'number')
  if (numeric.length > 0) {
    const collections = [...new Set(numeric.map((entry) => entry.collection).filter(Boolean))]
    const origin = collections.length > 0 ? ` (collection ${collections.map((name) => `\`${name}\``).join(', ')})` : ''
    const noSpacing = (model.byRole.get('spacing') ?? []).length === 0
    const noRadius = (model.byRole.get('radius') ?? []).length === 0
    if (noSpacing || noRadius) {
      rules.push(
        `**${numeric.length} numeric token(s)${origin} carry no role — they ARE this file's ` +
          `${[noSpacing ? 'spacing' : '', noRadius ? 'radius' : ''].filter(Boolean).join('/')} scale.** ` +
          'Use them for `padding` / `margin` / `gap` / `border-radius`; never write a raw px value ' +
          'instead. If no step fits, report the gap. _Designer: scope these variables in Figma ' +
          '(Gap, Corner radius, Width/height) or map their collection to a role in the export ' +
          'settings — the next export will then state the property exactly._'
      )
    } else {
      rules.push(
        `${numeric.length} numeric token(s)${origin} carry no role in their name or scopes — ` +
          'use them only where the path makes the intent obvious, and prefer the role-classified ' +
          'spacing/radius tokens.'
      )
    }
  }
  if (nonNumeric.length > 0) {
    rules.push(
      `${nonNumeric.length} token(s) could not be classified from their name — treat them as ` +
        'system internals unless the path makes the intent obvious.'
    )
  }
  return rules
}

/* ------------------------------------------------------------------ agent prompt */

export interface AgentPromptOptions {
  /** Role sentence, e.g. "an expert frontend engineer working in a Django project". */
  role: string
  /** Ordered steps the agent must run before emitting code. */
  steps: readonly string[]
  /** Hard stops. */
  never: readonly string[]
}

/** The block an agent loads as its system prompt for this codebase. */
export function agentPromptSection(options: AgentPromptOptions): string {
  const steps = options.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')
  const never = options.never.map((rule) => `- ${rule}`).join('\n')
  return (
    '```text\n' +
    `You are ${options.role}. The design system documented in DESIGN.md is authoritative.\n\n` +
    'Before writing or editing any UI code:\n' +
    `${steps}\n\n` +
    'Never:\n' +
    `${never}\n\n` +
    'If a required value has no token, stop and report the gap instead of inventing a value.\n' +
    '```'
  )
}

/* ------------------------------------------------------------------ header */

export interface HeaderOptions {
  fileName: string
  target: string
  generatedAt?: string
  /** One-paragraph statement of what this package is. */
  intro: string
}

export function headerSection(options: HeaderOptions): string {
  const stamp = options.generatedAt ? `\n     generated: ${options.generatedAt}` : ''
  return (
    `# DESIGN.md — ${options.fileName}\n\n` +
    `<!-- GENERATED by the Altery Design System Export Figma plugin.\n` +
    `     target: ${options.target}\n` +
    `     source of truth: Figma file "${options.fileName}"${stamp}\n` +
    `     Do not hand-edit: re-export from Figma instead. -->\n\n` +
    `${options.intro}`
  )
}
