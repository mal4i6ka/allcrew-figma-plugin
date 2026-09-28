/**
 * Design Tokens target — wraps the token engine to produce a design-token package.
 * Ported from allcrew-channel code.js:1129-1165 (buildPackage).
 *
 * The token engine (`normalizeOptions`) reads a FLAT options object (`inlinePrimitives`,
 * `themeAttr`, `typoExtract`, …). The plugin persists the nested `ExportOptions` shape,
 * so this is the one place that translates nested → flat before handing off to the engine.
 */

import { buildPackage, extractBreakpointTokens, type RenameMap, type TokenGraph, type TokenPackage } from '../tokens/engine.ts'
import { normalizeExportOptions, resolveThemeAttribute } from '../settings.ts'
import { buildTokenAudit } from './design-md/audit.ts'
import { buildTokensDesignMd } from './design-md/tokens-target.ts'
import {
  buildComponentsMd,
  buildIconsMd,
  COMPONENTS_FILE,
  ICONS_FILE,
  isIconDoc,
  type ComponentDoc,
} from './design-md/component-docs.ts'
import { buildTokenEntries, parseCollectionRoles } from './design-md/model.ts'
import type { TargetArtifacts, TargetSummary } from './types.ts'

export function buildDesignTokens(
  graph: TokenGraph,
  options: unknown,
  generatedAt?: string,
  componentDocs: readonly ComponentDoc[] = [],
  /** Names a colour remap rewrote, so the export can keep the old keys resolving. */
  renames?: RenameMap
): TargetArtifacts {
  const opts = normalizeExportOptions(options)
  const engineOptions = {
    inlinePrimitives: opts.tokens.inlinePrimitives,
    flattenAliases: opts.tokens.flattenAliases,
    themeAttr: resolveThemeAttribute(opts),
    emitModuleFiles: opts.tokens.emitModuleFiles,
    cssModulesGlobal: opts.tokens.cssModulesGlobal,
    typoExtract: opts.tokens.typoExtract,
    typoScaleOnly: opts.tokens.typoScaleOnly,
    typoShorthand: opts.tokens.typoShorthand,
    typoNaming: opts.tokens.typoNaming,
    emitNative: opts.tokens.emitNative,
  }
  const pkg: TokenPackage = buildPackage(graph, engineOptions, renames)
  const collectionRoles = parseCollectionRoles(opts.tokens.collectionRoles)
  // Icons drown the component docs at library scale (1600+ glyphs, search-tag descriptions):
  // they ship as a compact ICONS.md table, and COMPONENTS.md keeps only real components.
  const iconDocs = componentDocs.filter((doc) => isIconDoc(doc))
  const realComponentDocs = componentDocs.filter((doc) => !isIconDoc(doc))
  // DESIGN.md documents what the package actually declares, so it reads the emitted tree (the one
  // tokens.css was written from) — not the raw graph. Nothing to document when no token shipped.
  if (pkg.summary.tokenCount > 0) {
    pkg.files['DESIGN.md'] = buildTokensDesignMd({
      fileName: pkg.summary.fileName,
      tree: pkg.emitted.tree,
      themes: pkg.emitted.themes,
      defaultTheme: pkg.emitted.defaultTheme,
      themeAttribute: pkg.options.themeAttr,
      files: [
        ...Object.keys(pkg.files),
        'DESIGN.md',
        ...(realComponentDocs.length > 0 ? [COMPONENTS_FILE] : []),
        ...(iconDocs.length > 0 ? [ICONS_FILE] : []),
        ...(componentDocs.some((doc) => doc.preview) ? ['previews/<component>.png'] : []),
      ],
      options: pkg.options,
      audit: buildTokenAudit(graph),
      breakpoints: extractBreakpointTokens(graph),
      componentDocs: realComponentDocs,
      collectionRoles,
      generatedAt,
    })
  }
  // COMPONENTS.md lives here rather than in the sandbox because resolving `Y300` in a description
  // needs the tokens that actually shipped — which only this function knows.
  if (realComponentDocs.length > 0) {
    const componentsMd = buildComponentsMd(realComponentDocs, {
      fileName: pkg.summary.fileName,
      generatedAt,
      usage:
        'These components live in Figma only — this package ships their contract, not their markup. ' +
        'Implement them with the tokens documented in `DESIGN.md`.',
      tokens: buildTokenEntries(pkg.emitted.tree, pkg.emitted.themes, pkg.emitted.defaultTheme, collectionRoles),
    })
    if (componentsMd) pkg.files[COMPONENTS_FILE] = componentsMd
  }
  if (iconDocs.length > 0) {
    const iconsMd = buildIconsMd(iconDocs, { fileName: pkg.summary.fileName, generatedAt })
    if (iconsMd) pkg.files[ICONS_FILE] = iconsMd
  }
  const summary: TargetSummary = {
    target: 'design-tokens',
    fileName: pkg.summary.fileName,
    totalVariables: pkg.summary.totalVariables,
    textStyleCount: pkg.summary.textStyleCount,
    effectStyleCount: pkg.summary.effectStyleCount,
    tokenCount: pkg.summary.tokenCount,
    themes: pkg.summary.themes,
    collections: pkg.summary.collections,
    hasTypographyVars: pkg.summary.hasTypographyVars,
    hasGeneratedTypoCollection: pkg.summary.hasGeneratedTypoCollection,
    hasBreakpointCollection: pkg.summary.hasBreakpointCollection,
    hasGeneratedBpCollection: pkg.summary.hasGeneratedBpCollection,
  }
  return { files: pkg.files, summary }
}
