/**
 * DESIGN.md for the **design-tokens** target — the spec that ships next to `tokens.css`.
 *
 * README.md explains the package to a human; DESIGN.md is the contract for a coding agent:
 * role→CSS-property mapping, context-grouped tokens, hard guardrails derived from a Figma audit,
 * and an agent prompt. Pure: everything comes from the token tree + normalized options.
 */

import type { NormalizedOptions, TokenTree } from '../../tokens/engine.ts'
import { buildTokenModel, type TokenRole } from './model.ts'
import {
  agentPromptSection,
  breakpointsSection,
  bullet,
  componentBlocksSection,
  headerSection,
  mdTable,
  renderSections,
  roleIndexSection,
  themesSection,
  tokenGuardrails,
  tokenReferenceSection,
  typographySection,
} from './sections.ts'
import { auditGuardrails, type TokenAudit } from './audit.ts'
import { componentDocsSection, COMPONENTS_FILE, ICONS_FILE, type ComponentDoc } from './component-docs.ts'

export interface TokensDesignMdInput {
  fileName: string
  /** The same tree `buildPackage` emitted CSS/JSON from (post typography handling). */
  tree: TokenTree
  themes: readonly string[]
  defaultTheme: string
  themeAttribute: string
  /** Paths actually present in the package — the file table only lists what shipped. */
  files: readonly string[]
  options: NormalizedOptions
  audit: TokenAudit
  /** Widths of a modes-as-breakpoints collection (`extractBreakpointTokens`) — they have no
   * variable of their own, so the section can only report them if the caller passes them in. */
  breakpoints?: Record<string, number>
  /** Component configuration read from Figma — rendered as a pointer at `COMPONENTS.md`. */
  componentDocs?: readonly ComponentDoc[]
  /** Collection→role export setting (`Mesure` → spacing) for files that don't scope variables. */
  collectionRoles?: Readonly<Record<string, TokenRole>>
  /** ISO timestamp; omitted in tests so output stays deterministic. */
  generatedAt?: string
}

const FILE_DOCS: ReadonlyArray<{ match: (path: string) => boolean; what: string; use: string }> = [
  {
    match: (path) => path === 'tokens.css',
    what: 'Every token as a CSS custom property, one self-contained block per theme.',
    use: 'Import once, globally. This is the only stylesheet that may declare `--*` design tokens.',
  },
  {
    match: (path) => path === 'tokens.json',
    what: 'Canonical W3C/DTCG tree — all modes under `$extensions.modes`, source collection under `$extensions.figma`.',
    use: 'Read it programmatically (build scripts, codegen, diffing). Do not ship it to the browser.',
  },
  {
    match: (path) => path === 'tokens.ts',
    what: 'Typed `tokens` object whose values are `var(--…)` refs, plus `themes` / `Theme`.',
    use: 'Reference tokens from TS/JS (CSS-in-JS, inline styles) with autocomplete instead of string literals.',
  },
  {
    match: (path) => path.endsWith('.module.css'),
    what: 'The same declarations, one file per theme (CSS Modules).',
    use: 'Import a single theme at build time, or all of them for runtime switching.',
  },
  {
    match: (path) => path === 'README.md',
    what: 'Human-facing description of the package.',
    use: 'Onboarding. DESIGN.md (this file) is the machine-facing contract.',
  },
  {
    match: (path) => path === COMPONENTS_FILE,
    what: "Per-component behaviour contracts: the designer's description, properties, documentation links and previews.",
    use: 'Read the entry for a component BEFORE implementing or changing it.',
  },
  {
    match: (path) => path === ICONS_FILE,
    what: 'The icon library as a lookup table: name, node id, search tags, preview.',
    use: 'Find the right glyph by its search tags; icon descriptions are keywords, not contracts.',
  },
  {
    match: (path) => path.startsWith('previews/'),
    what: 'PNG of a component master, captured from Figma.',
    use: 'Visual reference for the contract in COMPONENTS.md.',
  },
  {
    match: (path) => path === 'DESIGN.md',
    what: 'This file — the design contract for coding agents.',
    use: 'Load it into context before writing UI code.',
  },
]

function filesTable(files: readonly string[]): string {
  const rows = files
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const doc = FILE_DOCS.find((entry) => entry.match(path))
      return [`\`${path}\``, doc?.what ?? 'Generated artifact.', doc?.use ?? '—']
    })
  return mdTable(['File', 'What it is', 'Use it for'], rows)
}

function optionRules(options: NormalizedOptions): string[] {
  const rules: string[] = []
  if (options.inlinePrimitives && !options.flattenAliases) {
    rules.push(
      '**Primitive tokens are inlined**: raw single-mode values (palette ramps, base scales) are ' +
        'NOT emitted as their own variables — their values sit inside the semantic tokens. A Figma ' +
        'variable name you remember may not exist in CSS. Only use names that appear in `tokens.css`.'
    )
  }
  if (options.inlinePrimitives && options.flattenAliases) {
    rules.push(
      '**All aliases are flattened**: no `var(--…)` cross-references remain in `tokens.css`; every ' +
        'token holds a literal. Never re-point one token at another by hand — change it in Figma and ' +
        're-export. (`tokens.json` keeps the un-flattened tree.)'
    )
  }
  if (!options.inlinePrimitives) {
    rules.push(
      'Primitives are emitted as their own variables and semantic tokens reference them with ' +
        '`var(--…)`. **Always style with the semantic token**, never with the primitive it resolves to — ' +
        'the primitive is not theme-aware.'
    )
  }
  if (options.typoExtract && options.typoScaleOnly) {
    rules.push(
      'Typography is emitted as a **shared scale only** (`--font-size-*`, `--font-weight-*`, …). ' +
        'Compose each text style in your own CSS from those primitives; do not expect a per-style ' +
        'shorthand token.'
    )
  }
  if (options.emitModuleFiles) {
    rules.push(
      'Per-theme CSS Modules ship alongside `tokens.css`' +
        (options.cssModulesGlobal ? ' wrapped in `:global(…)`' : '') +
        '. Import **either** `tokens.css` **or** the module files — never both, or the declarations double.'
    )
  }
  return rules
}

export function buildTokensDesignMd(input: TokensDesignMdInput): string {
  const model = buildTokenModel(input.tree, input.themes, input.defaultTheme, input.collectionRoles ?? {})
  const breakpoints = breakpointsSection(model, input.breakpoints)
  const typography = typographySection(model.typography)

  const contract = bullet([
    'This package **is** the design system. Every visual value you need already exists here.',
    'Style with `var(--…)` references. A literal color, spacing, radius, or font value in ' +
      'application code is a bug, not a shortcut.',
    'Pick a token by **role** (§2) and by **context** (§3) — not by which value looks closest.',
    'If a value you need has no token, **stop and report the gap**. Do not approximate it.',
    'Never edit the files in this package by hand: they are regenerated on every export from Figma.',
  ])

  const guardrails = [...auditGuardrails(input.audit), ...tokenGuardrails(model), ...optionRules(input.options)]

  // The example is built EXCLUSIVELY from tokens that shipped — a plausible-looking fallback like
  // `var(--radius-md)` would violate this file's own "every `--…` name must exist" rule the moment
  // the file has no radius role. A missing role is a stated gap, not an invented variable.
  const recipeLines: string[] = []
  const recipeGaps: string[] = []
  const surface = model.byRole.get('surface')?.[0] ?? model.byRole.get('color')?.[0]
  const text = model.byRole.get('text')?.[0]
  const border = model.byRole.get('border')?.[0]
  const radius = model.byRole.get('radius')?.[0]
  const spacing = model.byRole.get('spacing')?.[0]
  if (surface) recipeLines.push(`  background: ${surface.cssRef};`)
  if (text) recipeLines.push(`  color: ${text.cssRef};`)
  if (border) recipeLines.push(`  border: 1px solid ${border.cssRef};`)
  if (radius) recipeLines.push(`  border-radius: ${radius.cssRef};`)
  else recipeGaps.push('radius')
  if (spacing) recipeLines.push(`  padding: ${spacing.cssRef};`)
  else recipeGaps.push('spacing')
  const cardExample = recipeLines.length > 0
    ? 'Then compose components exclusively from variables:\n\n' +
      `\`\`\`css\n.card {\n${recipeLines.join('\n')}\n}\n\`\`\`\n\n`
    : ''
  const gapNote = recipeGaps.length > 0
    ? `_No ${recipeGaps.join(' or ')} tokens are role-classified in this export, so those lines are ` +
      'omitted above. Do not invent values: use the numeric scale documented under Unclassified in ' +
      'the guardrails (if one shipped) or report the gap to the designer._\n\n'
    : ''

  const recipes =
    'Import the stylesheet once, at the app entry point:\n\n' +
    '```css\n@import "./tokens.css";\n```\n\n' +
    cardExample +
    gapNote +
    'From TypeScript, reference `tokens.ts` instead of writing the variable name as a string:\n\n' +
    '```ts\nimport { tokens } from "./tokens"\n\n' +
    `const style = { background: ${model.entries[0]?.tsAccessor ?? 'tokens'} }\n\`\`\`\n\n` +
    '**Verify before you commit:** every `--…` name you wrote must appear in `tokens.css`.\n\n' +
    '```bash\ngrep -o -- "--[a-z0-9-]*" src/**/*.css | sort -u | while read v; do grep -q -- "$v:" tokens.css || echo "NOT A TOKEN: $v"; done\n```'

  const agentPrompt = agentPromptSection({
    role: 'an expert frontend engineer',
    steps: [
      'Identify every visual requirement of the UI you are about to write: surfaces, text, borders, icons, spacing, radii, type, motion.',
      'Map each one to a token from the "Token → CSS property" table — by role first, then by the component group that matches the element.',
      'Resolve theming through the token layer only: write one rule set with `var(--…)`; never branch on the active theme.',
      'Write the code, then re-read it and confirm no literal color, spacing, radius, or font value survived.',
      'State the tokens you used (and any gap you found) before presenting the code.',
    ],
    never: [
      'Never write a raw hex/rgb/hsl color, or a px value that has no matching token.',
      'Never edit `tokens.css`, `tokens.json`, `tokens.ts`, or the `*.module.css` files — they are generated from Figma.',
      'Never re-declare a design token under a new name in application CSS.',
      'Never introduce a breakpoint, font weight, or type size that is not listed in DESIGN.md.',
    ],
  })

  const sections: Array<[string, string]> = [
    ['The contract', contract],
    ['What ships in this package', filesTable(input.files)],
    ['Token → CSS property (how to apply anything)', roleIndexSection(model)],
    ['Tokens by component / context', componentBlocksSection(model.components)],
    ['Token reference', tokenReferenceSection(model)],
    ['Component behaviour contracts', componentDocsSection(input.componentDocs ?? [], model.entries)],
    ['Typography', typography],
    ['Themes', themesSection(model, input.themeAttribute)],
    ['Breakpoints', breakpoints],
    [
      'Strict guardrails (generated from a Figma audit)',
      guardrails.length > 0 ? bullet(guardrails) : '_No issues found in the Figma file — keep it that way._',
    ],
    ['Recipes', recipes],
    ['Agent prompt', agentPrompt],
  ]

  const intro =
    `**Read this file before writing or changing any UI code.** It is the machine-readable contract ` +
    `for the design system exported from Figma: ${model.entries.length} token(s)` +
    (model.themes.length > 1 ? `, ${model.themes.length} themes` : '') +
    (model.typography.length > 0 ? `, ${model.typography.length} text style(s)` : '') +
    '. It tells you which value to use, where to apply it, and what is forbidden.'

  const body = renderSections(sections)

  return `${headerSection({ fileName: input.fileName, target: 'design-tokens', generatedAt: input.generatedAt, intro })}\n\n${body}\n`
}
