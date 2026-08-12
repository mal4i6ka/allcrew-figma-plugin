/**
 * REFORM phase 4 / B1 (docs/REFORM.md §4): Bootstrap tokens adapter. Maps design tokens
 * onto Bootstrap 5.3 CSS variables and emits:
 *
 *  - `static/css/bootstrap-tokens.css` — per-theme `--bs-*` overrides (linked AFTER
 *    bootstrap.css). Color overrides get the `-rgb` companion Bootstrap's `*-opacity`
 *    utilities require. Dark mode rides Bootstrap's native `[data-bs-theme="dark"]`.
 *  - `bootstrap.map.json` — the resolved token→variable mapping, editable by hand;
 *    `altery-dj tokens` (phase 5) rebuilds bootstrap-tokens.css from it + tokens.json
 *    without a Figma re-export.
 *  - `static/scss/_tokens.scss` — the same overrides as `$variables` for projects that
 *    compile Bootstrap from SCSS (optional, Settings → _tokens.scss).
 *
 * Matching is SCHEME-TOLERANT (docs/DESIGN-CONVENTIONS.md): every Bootstrap variable has a
 * candidate list of token slugs, compared against `varName(path)` — so `Color/Primary`,
 * `colors/primary` and `brand.primary` all match `--bs-primary`. Case, separators and
 * pluralized top groups don't matter. Escape hatch: a token under `bs/*` maps DIRECTLY to
 * the same-named variable (`bs/primary` → `--bs-primary`) and wins over any candidate match.
 */

import {
  inlinePrimitivesTree,
  leaves,
  themeSlug,
  valueForTheme,
  varName,
  cssValue,
  type TokenLeaf,
  type TokenTree,
} from '../../../tokens/engine.ts'

interface BootstrapMapEntry {
  /** Bootstrap CSS variable to override, e.g. `--bs-primary`. */
  bsVar: string
  /** Also emit the `-rgb` companion (Bootstrap derives `rgba(var(--bs-x-rgb), opacity)`). */
  rgb?: boolean
  /** SCSS variable for _tokens.scss; defaults to the `--bs-` prefix stripped. */
  scssVar?: string
  /** Token slugs that satisfy this variable, in priority order (matched via `varName`). */
  candidates: string[]
}

/** Default candidate table — Bootstrap 5.3 root variables. Kept intentionally wide so
 * different token schemes map without renaming (see docs/DESIGN-CONVENTIONS.md §3). */
export const DEFAULT_BOOTSTRAP_MAP: readonly BootstrapMapEntry[] = [
  { bsVar: '--bs-primary', rgb: true, candidates: ['color-primary', 'colors-primary', 'brand-primary', 'color-brand-primary', 'primary', 'color-accent', 'accent'] },
  { bsVar: '--bs-secondary', rgb: true, candidates: ['color-secondary', 'colors-secondary', 'brand-secondary', 'secondary'] },
  { bsVar: '--bs-success', rgb: true, candidates: ['color-success', 'colors-success', 'success', 'color-positive', 'positive'] },
  { bsVar: '--bs-danger', rgb: true, candidates: ['color-danger', 'colors-danger', 'danger', 'color-error', 'error', 'color-negative', 'negative'] },
  { bsVar: '--bs-warning', rgb: true, candidates: ['color-warning', 'colors-warning', 'warning', 'color-caution', 'caution'] },
  { bsVar: '--bs-info', rgb: true, candidates: ['color-info', 'colors-info', 'info'] },
  { bsVar: '--bs-light', rgb: true, candidates: ['color-light', 'colors-light'] },
  { bsVar: '--bs-dark', rgb: true, candidates: ['color-dark', 'colors-dark'] },
  { bsVar: '--bs-body-bg', rgb: true, candidates: ['color-bg', 'color-background', 'background', 'color-bg-body', 'body-bg', 'color-surface', 'surface', 'color-bg-primary'] },
  { bsVar: '--bs-body-color', rgb: true, candidates: ['color-text', 'text-primary', 'color-text-primary', 'color-fg', 'foreground', 'body-color', 'text-body', 'color-body'] },
  { bsVar: '--bs-secondary-color', scssVar: 'body-secondary-color', candidates: ['color-text-secondary', 'text-secondary', 'color-fg-secondary', 'color-muted', 'text-muted'] },
  { bsVar: '--bs-border-color', candidates: ['color-border', 'border-color', 'border', 'color-stroke', 'stroke', 'color-divider', 'divider'] },
  { bsVar: '--bs-link-color', candidates: ['color-link', 'link-color', 'link', 'color-text-link'] },
  { bsVar: '--bs-link-hover-color', candidates: ['color-link-hover', 'link-hover-color', 'link-hover'] },
  { bsVar: '--bs-body-font-family', scssVar: 'font-family-base', candidates: ['font-family-base', 'font-family-body', 'typography-font-family-base', 'typography-font-family-body', 'font-body', 'font-family'] },
  { bsVar: '--bs-body-font-size', scssVar: 'font-size-base', candidates: ['font-size-base', 'font-size-body', 'typography-font-size-base', 'typography-font-size-body', 'text-size-base'] },
  { bsVar: '--bs-border-radius', candidates: ['radius-md', 'radius-base', 'radius-default', 'radius', 'border-radius', 'corner-radius-md', 'corner-radius'] },
  { bsVar: '--bs-border-radius-sm', candidates: ['radius-sm', 'radius-small', 'corner-radius-sm', 'border-radius-sm'] },
  { bsVar: '--bs-border-radius-lg', candidates: ['radius-lg', 'radius-large', 'corner-radius-lg', 'border-radius-lg'] },
  { bsVar: '--bs-border-radius-xl', candidates: ['radius-xl', 'corner-radius-xl', 'border-radius-xl'] },
]

export interface BootstrapMatch {
  bsVar: string
  scssVar: string
  rgb: boolean
  leaf: TokenLeaf
}

export interface BootstrapArtifacts {
  css: string
  mapJson: string
  scss: string
  matched: BootstrapMatch[]
  /** Bootstrap variables no token satisfied — recorded in bootstrap.map.json for the CLI. */
  unmatched: string[]
}

/** `#rrggbb` / `rgb(r g b / a)` → `"r, g, b"` for the `-rgb` companion; undefined when the
 * resolved value isn't a parseable color (gradient, var-reference, string keyword). */
export function cssColorToRgbTriplet(value: string): string | undefined {
  const hex = value.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
  }
  const rgb = value.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  if (rgb) return `${rgb[1]}, ${rgb[2]}, ${rgb[3]}`
  return undefined
}

function defaultScssVar(bsVar: string): string {
  return bsVar.replace(/^--bs-/, '')
}

/** Resolves the mapping against a fully-flattened leaf set. Direct `bs/*` tokens win over
 * the candidate table; within the table the first candidate that exists wins. */
export function matchBootstrapMap(flatLeaves: readonly TokenLeaf[]): { matched: BootstrapMatch[]; unmatched: string[] } {
  const bySlug = new Map<string, TokenLeaf>()
  for (const leaf of flatLeaves) {
    const slug = varName(leaf.path)
    if (!bySlug.has(slug)) bySlug.set(slug, leaf)
  }

  const matched = new Map<string, BootstrapMatch>()
  for (const entry of DEFAULT_BOOTSTRAP_MAP) {
    for (const candidate of entry.candidates) {
      const leaf = bySlug.get(candidate)
      if (!leaf) continue
      matched.set(entry.bsVar, {
        bsVar: entry.bsVar,
        scssVar: entry.scssVar ?? defaultScssVar(entry.bsVar),
        rgb: entry.rgb === true,
        leaf,
      })
      break
    }
  }

  // Escape hatch: tokens under `bs/*` override the same-named Bootstrap variable directly.
  for (const leaf of flatLeaves) {
    const slug = varName(leaf.path)
    if (!slug.startsWith('bs-')) continue
    const bsVar = `--${slug}`
    matched.set(bsVar, {
      bsVar,
      scssVar: defaultScssVar(bsVar),
      rgb: leaf.token.$type === 'color',
      leaf,
    })
  }

  const matchedList = [...matched.values()]
  const unmatched = DEFAULT_BOOTSTRAP_MAP.filter((entry) => !matched.has(entry.bsVar)).map((entry) => entry.bsVar)
  return { matched: matchedList, unmatched }
}

function themeBlockDeclarations(matched: readonly BootstrapMatch[], theme: string): string[] {
  const lines: string[] = []
  for (const match of matched) {
    const value = cssValue(valueForTheme(match.leaf.token, theme), match.leaf.path)
    lines.push(`  ${match.bsVar}: ${value};`)
    if (match.rgb) {
      const triplet = typeof value === 'string' ? cssColorToRgbTriplet(value) : undefined
      if (triplet) lines.push(`  ${match.bsVar}-rgb: ${triplet};`)
    }
  }
  return lines
}

/**
 * The three Bootstrap outputs from the SOURCE token tree (engine `variablesToW3CMultiMode`).
 * Aliases are fully flattened first — `--bs-*` overrides must be literals so the `-rgb`
 * companions can be computed and so they hold regardless of tokens.css load order.
 */
export function emitBootstrapArtifacts(
  source: TokenTree,
  themes: { ordered: readonly string[]; defaultTheme: string },
  options: { themeAttribute: string }
): BootstrapArtifacts {
  const flat = leaves(inlinePrimitivesTree(source, true))
  const { matched, unmatched } = matchBootstrapMap(flat)
  const attr = options.themeAttribute || 'data-bs-theme'

  const blocks = themes.ordered.map((theme) => {
    const selector =
      theme === themes.defaultTheme
        ? `:root,\n[${attr}="${themeSlug(theme)}"]`
        : `[${attr}="${themeSlug(theme)}"]`
    return `${selector} {\n${themeBlockDeclarations(matched, theme).join('\n')}\n}`
  })
  const css =
    matched.length === 0
      ? ''
      : `/* Bootstrap variable overrides generated from design tokens — link AFTER bootstrap.css.\n` +
        `   Mapping: bootstrap.map.json (edit + \`altery-dj tokens\` to rebuild without Figma). */\n` +
        blocks.join('\n\n') +
        '\n'

  const mapJson =
    JSON.stringify(
      {
        $comment:
          'Bootstrap variable → design-token mapping (paths are dotted keys into tokens.json). ' +
          'Edit and run `altery-dj tokens` to rebuild bootstrap-tokens.css / _tokens.scss without a Figma re-export.',
        map: Object.fromEntries(matched.map((match) => [match.bsVar, match.leaf.path.join('.')])),
        unmatched,
      },
      null,
      2
    ) + '\n'

  const scssLines = matched.map((match) => {
    const value = cssValue(valueForTheme(match.leaf.token, themes.defaultTheme), match.leaf.path)
    return `$${match.scssVar}: ${value};`
  })
  const scss =
    matched.length === 0
      ? ''
      : `// Design-token overrides for Bootstrap's _variables.scss — @import BEFORE bootstrap.\n` +
        `// Values are the "${themes.defaultTheme}" theme; runtime theming uses bootstrap-tokens.css.\n` +
        scssLines.join('\n') +
        '\n'

  return { css, mapJson, scss, matched, unmatched }
}
