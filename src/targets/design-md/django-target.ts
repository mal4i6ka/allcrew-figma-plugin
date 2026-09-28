/**
 * DESIGN.md for the **django** target — the spec that ships inside the exported project zip.
 *
 * Same contract as the design-tokens variant, plus everything an agent must know to edit a
 * generated Django project without losing work: which files are generator-owned, how the
 * `{# GENERATED #}` markers work, the template/partial layout, the Bootstrap fidelity in force,
 * i18n rules, and the canvas-lint findings turned into hard DO-NOTs.
 *
 * Pure — `src/code.ts` collects the facts from the Figma sandbox and passes them in.
 */

import type { TokenTree } from '../../tokens/engine.ts'
import type { LintRule } from '../django/lint/index.ts'
import { buildTokenModel, type DesignTokenModel } from './model.ts'
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
import { componentDocsSection, type ComponentDoc } from './component-docs.ts'

export interface DjangoDesignMdTokens {
  tree: TokenTree
  themes: readonly string[]
  defaultTheme: string
  themeAttribute: string
  audit: TokenAudit
  /** `tokens.json` shipped at the zip root. */
  emitJson: boolean
  /** Widths of a modes-as-breakpoints collection (`extractBreakpointTokens`). */
  breakpoints?: Record<string, number>
}

export interface DjangoDesignMdBootstrap {
  fidelity: 'tokens' | 'utilities' | 'components' | 'theme'
  source: 'assume' | 'cdn' | 'vendored'
  version: string
  /** `--bs-*` variable ← token slug pairs the adapter resolved. */
  matched: ReadonlyArray<{ bsVar: string; slug: string }>
  /** `--bs-*` variables no token satisfied — they keep Bootstrap's stock value. */
  unmatched: readonly string[]
  /** `static/css/bootstrap-theme.css` shipped (theme fidelity with themable kit sets). */
  themeCss: boolean
}

export interface DjangoDesignMdPackage {
  /** `templates/`-relative page paths, e.g. `pages/home--1-23.html`. */
  pages: readonly string[]
  /** `templates/`-relative partial paths, e.g. `components/button--4-56.html`. */
  partials: readonly string[]
  /** `static`-relative project stylesheet path, e.g. `css/project.css`. */
  cssFile: string
  interactionsCss: boolean
  interactionsJs: boolean
  animationsCss: boolean
  animationsJs: boolean
  assetCount: number
  /** Asset paths the Figma API could not export — they must be dropped in by hand. */
  manualAssets: readonly string[]
}

export interface DjangoDesignMdInput {
  fileName: string
  generatedAt?: string
  scope: { mode: 'page' | 'selection' | 'frame'; frameId?: string }
  modules: { tokens: boolean; templates: boolean; i18n: boolean; animation: boolean }
  package: DjangoDesignMdPackage
  /** Absent when the tokens module is off — the project then has no `tokens.css`. */
  tokens?: DjangoDesignMdTokens
  /** Absent when the export runs without a framework. */
  bootstrap?: DjangoDesignMdBootstrap
  /** Component configuration for the components that shipped as partials. */
  componentDocs?: readonly ComponentDoc[]
  i18n: { entryCount: number; sourceLanguage: string; wrapTranslate: boolean }
  /** Canvas-lint result for the exported scope; `null` when the audit did not run. */
  lint: { counts: Partial<Record<LintRule, number>>; total: number; nodeCount: number } | null
}

/* ------------------------------------------------------------------ lint → guardrails */

const LINT_RULE_TEXT: Record<LintRule, (count: number) => string> = {
  'unbound-fill': (n) =>
    `**${n} layer(s) ship a solid fill that is NOT bound to a color variable.** Their literal colors ` +
    `were written into \`project.css\`. Those hex values are not design tokens — never copy one into ` +
    `new code; use a token from the reference below, or report the gap.`,
  'unbound-stroke': (n) =>
    `**${n} layer(s) ship an unbound stroke color** — same rule as fills: the literal border colors in ` +
    `\`project.css\` are not tokens.`,
  'text-without-style': (n) =>
    `**${n} text node(s) have no Figma text style**, so their font declarations are one-off literals ` +
    `in \`project.css\` rather than the type scale. Do not treat them as a typographic decision, and ` +
    `do not imitate them in new components.`,
  'missing-auto-layout': (n) =>
    `**${n} frame(s) have no Auto Layout**, so their children exported with absolute positioning. That ` +
    `is a Figma artifact, not a layout choice — when you touch such a block, re-express it with ` +
    `flex/grid instead of extending the absolute coordinates.`,
  'excessive-nesting': (n) =>
    `**${n} node(s) exceed the nesting threshold** — the generated markup carries wrapper \`<div>\`s ` +
    `with no semantic meaning. Flatten them when you edit; do not add more.`,
  'bootstrap-component-mismatch': (n) =>
    `**${n} component(s) are named like Bootstrap components but exported as custom partials** (no ` +
    `recognizable variant prop). Do not assume \`.btn\`/\`.card\` markup or Bootstrap JS behaviour ` +
    `exists for them — read the partial before wiring anything to it.`,
}

function lintGuardrails(lint: DjangoDesignMdInput['lint']): string[] {
  if (!lint) return []
  if (lint.total === 0) {
    return [
      `The Figma audit of the exported scope (${lint.nodeCount} layer(s)) found no issues — every fill ` +
        'is bound to a variable, every text node carries a style. Keep the generated code that way.',
    ]
  }
  const rules: string[] = []
  for (const rule of Object.keys(LINT_RULE_TEXT) as LintRule[]) {
    const count = lint.counts[rule] ?? 0
    if (count > 0) rules.push(LINT_RULE_TEXT[rule](count))
  }
  return rules
}

/* ------------------------------------------------------------------ package layout */

const OWNERSHIP_ROWS: ReadonlyArray<readonly string[]> = [
  ['`templates/base.html`', 'generated (marker-wrapped)', 'Skeleton every page extends. Edit only OUTSIDE the `{# GENERATED #}` markers, or override a block in a child template.'],
  ['`templates/pages/*.html`', 'generated (marker-wrapped)', 'One file per exported top-level frame. `{% extends "base.html" %}` + `{% block content %}`.'],
  ['`templates/components/*.html`', 'generated (marker-wrapped)', 'One partial per Figma component, pulled in with `{% include "components/…" with … only %}`.'],
  ['`static/css/tokens.css`', 'generated — never edit', 'Design tokens as CSS custom properties, one block per theme.'],
  ['`static/css/*.css` (project)', 'generated — never edit', 'Layout/appearance compiled from the Figma nodes. Regenerated wholesale on every export.'],
  ['`locale/figma.po`', 'generated', 'Source strings extracted from the design. Merge into your catalog; never translate in place.'],
  ['`export-report.json`', 'generated', 'Audit trail: who exported, which scope, which modules.'],
  ['`COMPONENTS.md`', 'generated', "Per-component behaviour contracts from Figma's Component configuration, with previews."],
  ['`previews/*.png`', 'generated', 'Component master screenshots referenced by COMPONENTS.md.'],
  ['`DESIGN.md`', 'generated', 'This file — the contract for coding agents.'],
]

function packageSection(input: DjangoDesignMdInput): string {
  const pkg = input.package
  const table = mdTable(['Path', 'Ownership', 'What it is'], OWNERSHIP_ROWS)
  const counts = bullet([
    `${pkg.pages.length} page template(s), ${pkg.partials.length} component partial(s).`,
    `Project stylesheet: \`static/${pkg.cssFile}\`.`,
    `${pkg.assetCount} exported asset(s) under \`static/img/\`.` +
      (pkg.manualAssets.length > 0
        ? ` **${pkg.manualAssets.length} asset(s) could not be exported by the Figma API** and must be dropped in by hand at: ${pkg.manualAssets.map((path) => `\`static/${path}\``).join(', ')}.`
        : ''),
    `Export scope: \`${input.scope.mode}\`${input.scope.frameId ? ` (frame \`${input.scope.frameId}\`)` : ''}. ` +
      'Anything outside that scope is not in this package.',
  ])
  const pageList =
    pkg.pages.length > 0
      ? `\n\n**Pages**\n\n${pkg.pages.slice(0, 40).map((path) => `- \`templates/${path}\``).join('\n')}` +
        (pkg.pages.length > 40 ? `\n- _+${pkg.pages.length - 40} more_` : '')
      : ''
  return `${table}\n\n${counts}${pageList}`
}

function templateSection(input: DjangoDesignMdInput): string {
  return (
    '```\n' +
    '{# GENERATED:BEGIN <figma node id> — edits outside this block survive regeneration #}\n' +
    '…generator-owned markup…\n' +
    '{# GENERATED:END <figma node id> #}\n' +
    '```\n\n' +
    bullet([
      '**Everything between the markers is overwritten on the next export.** Put hand-written markup ' +
        'before or after the pair, or in a template that `{% extends %}` the generated one.',
      'A template with no marker at all is never touched by a re-export — that is the escape hatch for ' +
        'a page you have taken over completely.',
      'Every template carries its own `{% load i18n %}` / `{% load static %}`: `{% load %}` does not ' +
        'propagate across `{% extends %}` or `{% include %}`. Add them to any new template you write.',
      'Pages are `{% extends "base.html" %}` + `{% block content %}`. `base.html` also exposes ' +
        '`{% block framework_css %}` / `{% block framework_js %}`.',
      'Components are included with `{% include "components/<name>--<node id>.html" with … only %}`. ' +
        'The `--<node id>` suffix is the stable identity — a rename in Figma changes the readable slug, ' +
        'not the file\'s identity. Do not rename these files.',
      'Reference every asset through `{% static %}` — never a hardcoded `/static/…` path.',
    ])
  )
}

/* ------------------------------------------------------------------ bootstrap */

/** A readable slice of `BOOTSTRAP_COMPONENT_NAMES` — enough for the agent to recognize the
 * convention without pasting the whole matcher table into every export. */
const BOOTSTRAP_RECOGNIZED_SAMPLE =
  'Button, Badge, Card, Alert, Toast, Navbar, Nav, Tabs, Dropdown, Accordion, Pagination, ' +
  'Breadcrumb, ListGroup, Progress, Spinner, Table, Input, Select, Textarea, Checkbox, Radio, ' +
  'Switch, Range, Upload, Segmented, InputGroup, Offcanvas, Carousel, Collapse'

const FIDELITY_TEXT: Record<DjangoDesignMdBootstrap['fidelity'], string> = {
  tokens:
    'Only `--bs-*` variable overrides are emitted. Bootstrap components are NOT used by the generated ' +
    'markup — layout comes from the project stylesheet.',
  utilities:
    'Exact-scale layout declarations moved from the stylesheet onto Bootstrap utility classes ' +
    '(`.d-flex`, `.gap-*`, …) in the templates. When you edit layout, prefer the same utilities over ' +
    'new CSS; do not fight an `!important` utility with a custom rule.',
  components:
    'Recognized Figma components render as native Bootstrap markup (`.btn`, `.card`, modals via the ' +
    'data API). Use Bootstrap\'s own classes and data attributes for behaviour instead of writing JS.',
  theme:
    'The Figma kit masters ARE the theme: per-component `--bs-*` sets ship in ' +
    '`static/css/bootstrap-theme.css`. Restyle a component by changing its Bootstrap variables, never ' +
    'by overriding `.btn-primary` in project CSS.',
}

function bootstrapSection(bootstrap: DjangoDesignMdBootstrap): string {
  const rows = bootstrap.matched.map((entry) => [`\`--${entry.slug}\``, `\`${entry.bsVar}\``])
  const table =
    rows.length > 0
      ? mdTable(['Design token', 'Bootstrap variable'], rows)
      : '_No design token matched a Bootstrap variable — Bootstrap keeps its stock values._'
  const unmatched =
    bootstrap.unmatched.length > 0
      ? `\n\nNot covered by a token (stock Bootstrap values, do not assume they are on-brand): ` +
        `${bootstrap.unmatched.map((name) => `\`${name}\``).join(', ')}.`
      : ''
  const recognition =
    bootstrap.fidelity === 'components' || bootstrap.fidelity === 'theme'
      ? '\n\nOnly components whose Figma name matches a Bootstrap pattern render as native markup ' +
        `(${BOOTSTRAP_RECOGNIZED_SAMPLE}). Everything else — steppers, timelines, rating widgets, ` +
        'OTP inputs and any other pattern Bootstrap has no component for — exports as a custom ' +
        'partial with the design\'s own CSS. Read the partial before assuming a Bootstrap class or ' +
        'a `data-bs-*` behaviour exists on it.'
      : ''
  return (
    `Bootstrap ${bootstrap.version}, source \`${bootstrap.source}\`, fidelity **\`${bootstrap.fidelity}\`**.\n\n` +
    `${FIDELITY_TEXT[bootstrap.fidelity]}${recognition}\n\n` +
    `${table}${unmatched}\n\n` +
    bullet([
      'Bootstrap loads inside a CSS cascade layer, so un-layered project CSS wins over Bootstrap ' +
        'declarations regardless of specificity. Do not add `!important` to beat Bootstrap.',
      'Change brand values through `bootstrap.map.json` + `tokens.json` (`allcrew-channel tokens`) or in ' +
        'Figma — never by editing `bootstrap-tokens.css`.',
    ])
  )
}

/* ------------------------------------------------------------------ i18n & motion */

function i18nSection(input: DjangoDesignMdInput): string {
  if (!input.modules.i18n) {
    return (
      'The i18n module was OFF for this export: template text is literal. If the project is ' +
      'translated, wrap new strings in `{% translate %}` yourself and re-export with i18n enabled.'
    )
  }
  return bullet([
    `${input.i18n.entryCount} source string(s) extracted to \`locale/figma.po\` (source language ` +
      `\`${input.i18n.sourceLanguage}\`).`,
    'Generated text is already wrapped in `{% translate %}` / `{% blocktranslate %}`. **Every new ' +
      'user-visible string you write must be wrapped too.**',
    'Do not translate inside `figma.po` — merge it into the project catalog ' +
      '(`allcrew-channel po merge`), then translate there. `figma.po` is regenerated on every export.',
    'Translated text is usually longer than the Figma source: never rely on a fixed width or a ' +
      'single-line assumption for a translatable string.',
  ])
}

function motionSection(input: DjangoDesignMdInput): string {
  const pkg = input.package
  const parts: string[] = []
  if (pkg.interactionsCss || pkg.interactionsJs) {
    parts.push(
      'Prototype reactions exported as ' +
        [pkg.interactionsCss ? '`static/css/interactions.css` (hover/press transitions)' : '', pkg.interactionsJs ? '`static/js/interactions.js` (overlay dialogs)' : '']
          .filter(Boolean)
          .join(' and ') +
        ' — generated, so add your own behaviour in a separate file.'
    )
  }
  if (pkg.animationsCss || pkg.animationsJs) {
    parts.push(
      'Motion timelines exported as ' +
        [pkg.animationsCss ? '`static/css/animations.css`' : '', pkg.animationsJs ? '`static/js/animations.js`' : '']
          .filter(Boolean)
          .join(' and ') +
        '. Re-time an animation in Figma, not in the generated file.'
    )
  }
  if (input.modules.animation) {
    parts.push('`static/js/motion-tokens.js` exports duration/easing tokens for JS-driven animation.')
  }
  return parts.length > 0 ? bullet(parts) : ''
}

/* ------------------------------------------------------------------ workflow */

const WORKFLOW = bullet([
  'The design source of truth is Figma. To change a generated value, change it in Figma and re-export — ' +
    'do not patch the generated file.',
  'Apply a fresh export over the project with `allcrew-channel apply export.zip`, or `allcrew-channel rebuild ' +
    'export.zip --diff` to merge it while preserving edits outside the `{# GENERATED #}` markers.',
  'Rebuild derived stylesheets from `tokens.json` without a Figma round-trip: `allcrew-channel tokens ' +
    '--format all`.',
  'Verify a project after an apply: `allcrew-channel check` (Django system check + a smoke render of every ' +
    'template + `msgfmt` over the locales).',
])

/* ------------------------------------------------------------------ document */

export function buildDjangoDesignMd(input: DjangoDesignMdInput): string {
  const model: DesignTokenModel | null = input.tokens
    ? buildTokenModel(input.tokens.tree, input.tokens.themes, input.tokens.defaultTheme)
    : null

  const contract = bullet([
    'This project is **generated from Figma**. Files inside `{# GENERATED #}` markers and everything ' +
      'under `static/css/` are regenerated on every export — edits there are lost.',
    input.modules.tokens
      ? 'Style with `var(--token)` from `static/css/tokens.css`. A literal color, spacing, radius, or ' +
        'font value in hand-written code is a bug.'
      : 'The tokens module was OFF for this export: there is no `tokens.css`. Take values from the ' +
        'generated project stylesheet and do not invent new ones.',
    'Pick a value by **role** and by **component context**, not by which number looks closest.',
    'If something you need has no token and no generated rule, **stop and report the gap**.',
    'Keep new markup inside the template system: extend `base.html`, include the existing partials, ' +
      'and use `{% static %}` / `{% translate %}`.',
  ])

  // The Django token pass reads Figma VARIABLES only (no text styles), so a project whose type
  // scale lives in text styles ships no typography tokens at all — say so rather than letting an
  // agent conclude the type scale is free-form.
  const typographyTokenised = model !== null && (model.byRole.get('font-size')?.length ?? 0) > 0
  const guardrails = [
    ...lintGuardrails(input.lint),
    ...(input.tokens ? auditGuardrails(input.tokens.audit) : []),
    ...(model ? tokenGuardrails(model) : []),
    ...(model && !typographyTokenised
      ? [
          'Typography is **not tokenized** in this export: font family/size/weight come from the ' +
            'generated project stylesheet, not from `tokens.css`. Reuse an existing generated class ' +
            'instead of inventing font values, and bind the text styles to Figma variables if you ' +
            'want them tokenized.',
        ]
      : []),
    'Never edit `static/css/tokens.css` or the generated project stylesheet — write your own ' +
      'stylesheet, link it after them, and keep it token-only.',
    'Never hardcode a template path or asset URL: use `{% include %}` / `{% static %}`.',
  ]

  const agentPrompt = agentPromptSection({
    role: 'an expert Django + frontend engineer working in a project generated from Figma by the AllCrew Figma Workspace exporter',
    steps: [
      'Locate the generated template that owns the UI you are changing (`templates/pages/…` or `templates/components/…`) and read its `{# GENERATED #}` markers before editing anything.',
      'Identify every visual requirement — surface, text, border, spacing, radius, type, motion — and map each to a token from the "Token → CSS property" table.',
      input.bootstrap
        ? `Respect the Bootstrap fidelity in force (\`${input.bootstrap.fidelity}\`): use the framework's own classes/attributes instead of writing parallel CSS or JS.`
        : 'Express layout with flex/grid in your own stylesheet; do not extend the generated absolute positioning.',
      'Wrap every new user-visible string in `{% translate %}` and every asset reference in `{% static %}`.',
      'Put hand-written changes OUTSIDE the generated markers (or in your own template/stylesheet), then state which tokens you used and which files you touched.',
    ],
    never: [
      'Never edit inside a `{# GENERATED:BEGIN … #}` / `{# GENERATED:END … #}` block, or any file under `static/css/` that the exporter owns.',
      'Never write a raw hex/rgb/hsl color or a px value that has no matching token.',
      'Never introduce a breakpoint, font weight, or type size that is not listed in DESIGN.md.',
      'Never rename a `components/<name>--<node id>.html` partial — the node-id suffix is its identity.',
    ],
  })

  const sections: Array<[string, string]> = [
    ['The contract', contract],
    ['Package layout & ownership', packageSection(input)],
    ['Template system & regeneration', templateSection(input)],
    ['Token → CSS property (how to apply anything)', model ? roleIndexSection(model) : ''],
    ['Tokens by component / context', model ? componentBlocksSection(model.components) : ''],
    ['Token reference', model ? tokenReferenceSection(model) : ''],
    ['Typography', model ? typographySection(model.typography) : ''],
    ['Themes', model && input.tokens ? themesSection(model, input.tokens.themeAttribute) : ''],
    ['Breakpoints & responsive', model ? breakpointsSection(model, input.tokens?.breakpoints) : ''],
    ['Bootstrap', input.bootstrap ? bootstrapSection(input.bootstrap) : ''],
    ['Component behaviour contracts', componentDocsSection(input.componentDocs ?? [])],
    ['Internationalization', i18nSection(input)],
    ['Motion & interactions', motionSection(input)],
    ['Strict guardrails (generated from a Figma audit)', bullet(guardrails)],
    ['Working with this project', WORKFLOW],
    ['Agent prompt', agentPrompt],
  ]

  const intro =
    '**Read this file before writing or changing any code in this project.** It is the machine-readable ' +
    'contract for a Django project generated from Figma: what is generated (and therefore off-limits), ' +
    'which design tokens exist and where they apply, and what the design audit found.'

  return (
    `${headerSection({ fileName: input.fileName, target: 'django', generatedAt: input.generatedAt, intro })}\n\n` +
    `${renderSections(sections)}\n`
  )
}
