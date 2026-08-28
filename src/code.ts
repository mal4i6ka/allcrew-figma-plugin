/**
 * Altery Design System Export — unified plugin sandbox (main thread).
 *
 * Reads the file's LOCAL variables + collections + text styles via the Figma Plugin API
 * and builds either a design-token package or a Django project, depending on the
 * selected target (`options.target`).
 *
 * The core token engine is in src/tokens/engine.ts — a dependency-free port of the
 * original code.js pure functions. The Figma glue is guarded by `typeof figma`.
 */

import { readAllVariables } from './variables'
import { emitMotionTokensJs } from './targets/django/tokens'
import { emitTokenArtifacts, tokenEmitOptionsFrom } from './tokens/index'
import { emitBootstrapArtifacts } from './targets/django/bootstrap/map'
import { generateDesignKit } from './targets/django/generate/kit'
import type { BaseHtmlFrameworkLinks } from './targets/django/index'
import { serializeNode, type IrContainerNode, type IrNode } from './targets/django/ir'
import { emitDjango, emitDjangoProject, planRegeneration, type FreshFile } from './targets/django/index'
import { extractBreakpointTokens, generateBreakpointCollection, parseBreakpointName } from './targets/django/breakpoint-frames'
import { collectReactionDestinationIds } from './targets/django/interactions'
import { matchBootstrapComponent } from './targets/django/bootstrap/components'
import { scaleBorderRadius } from './targets/django/css-emitter'
import type { ThemableSetData, ThemableVariantData } from './targets/django/bootstrap/theme'
import { findAllWithCriteria, walkSceneNodes, yieldToHost } from './utils/tree'
import { extractStrings, type ExtractedEntry } from './targets/django/i18n/extract'
import { translationKey } from './targets/django/i18n/normalize'
import { emitPo } from './targets/django/i18n/po'
import { resolveKey } from './targets/django/i18n/keys'
import { importTranslations, type ImportFormat } from './targets/django/i18n/index'
import { annotateVectorLeaves, annotateVideoFills, collectExportAssets, collectManualAssets, type AssetSourceNode } from './targets/django/export/assets'
import { videoFilename } from './targets/django/assets'
import { buildExportTree, buildRegenStaticFiles, type ExportFileContent } from './targets/django/export/file-tree'
import {
  EXPORT_PRESETS,
  mergeExportOptions,
  normalizeExportOptions,
  normalizeUserPresets,
  upsertUserPreset,
  type ExportOptions,
} from './settings'
import { buildExportReport } from './targets/django/export/report'
import { lintScopeAsync, type LintFinding } from './targets/django/lint/index'
import { annotateUnfixableFindings, applyLintFix, buildFixContext, type LintFixRequest, type LintFixResult } from './targets/django/lint/fix'
import { loadAnnotationForm, applyAnnotationForm, renderAnnotationPanel, type AnnotationFormState } from './targets/django/ui/annotation-panel'
import { readMotionData } from './targets/django/motion/beta-adapter'
import {
  EMPTY_MOTION_EXPORT_ARTIFACTS,
  emitMotionExportArtifacts,
  type MotionExportArtifacts,
  type MotionExportNode,
} from './targets/django/motion/export-assets'
import { planTypographyVariables, normalizeOptions as normalizeTokenOptions, varName, type TokenGraph, type TypographyPlan } from './tokens/engine'
import { buildDesignTokens } from './targets/design-tokens'
import { buildTauriExportTree } from './targets/tauri/index'
import { applyPaletteFix, generatePalette, suggestHarmoniousSpectrum, type PaletteSettings } from './tokens/palette'
import { normalizePaletteFix, normalizePaletteSettings } from './tokens/palette-settings'
import { foldSplitThemeCollections } from './tokens/split-theme'
import { applyPalette, DEFAULT_APPLY_OPTIONS, type PaletteApplyOptions } from './targets/ds-tools/palette-apply'
import { readRemapInventory, type RemapInventory, type ScanDepth } from './targets/ds-tools/remap-inventory'
import {
  applyRemap,
  DEFAULT_REMAP_APPLY_OPTIONS,
  hasRemapSnapshot,
  readRenameMap,
  revertRemap,
  unparkLegacyNames,
  type RemapApplyOptions,
  type RemapScope,
} from './targets/ds-tools/remap-apply'
import { drawRemapBoard } from './targets/ds-tools/remap-board'
import { applyRebind, hasRebindSnapshot, previewRebind, revertRebind } from './targets/ds-tools/remap-rebind'
import { auditContrast, describeContrast } from './tokens/remap/audit'
import { parsePaletteInput } from './tokens/remap/input'
import { buildRemapPlan, type RemapOptions, type RemapPlan } from './tokens/remap/plan'
import { buildMappingFile, parseMappingFile, planFromMappingFile, toCsv } from './tokens/remap/contract'
import { rewriteColors } from './tokens/remap/rewrite'
import { swatchesFromPalette } from './tokens/remap/sources'
import { listLibraryCollections, swatchesFromLibrary, swatchesFromSelection } from './targets/ds-tools/remap-sources'
import { parseColorLiteral, toHex } from './tokens/remap/color-literal'
import { deltaE } from './tokens/remap/match'
import { rgbToOklch } from './tokens/color'
import { buildDjangoDesignMd, buildTokenAudit, type DjangoDesignMdInput } from './targets/design-md/index'
import { buildComponentsMd, COMPONENTS_FILE, type ComponentDoc, type ComponentProperty } from './targets/design-md/component-docs'
import { buildTokenEntries } from './targets/design-md/model'
import { deliverPackage } from './delivery'
import { agentManifest, handleAgentRequest, setGates } from './agent/listener.ts'
import { postToUi } from './agent/ui-post.ts'
import { setModuleProvider, setUiMessageRunner } from './agent/plugin-ops.ts'
import { UI_COMMANDS } from './agent/ui-commands.ts'
import {
  describeModules,
  findModuleCommand,
  moduleCommandDefs,
  registerModules,
  MODULE_SIZE_LIMIT,
  type RegisteredModule,
  type StoredModule,
} from './modules/registry.ts'
import { moduleCapabilities, parseUserModule } from './modules/contract.ts'
import { describeLinks, planProps } from './canvas/props.ts'
import {
  applyProps,
  describeAnimation,
  describeBrush,
  describeShaderPaints,
  describeEffects,
  describeGrids,
  describePaints,
  variableName,
} from './canvas/apply.ts'
import { createNode, planCreate, type CreatePlan } from './canvas/create.ts'
import {
  bindingField,
  collectComponents,
  componentFor,
  describeProperties as describePropertyDefinitions,
  humanPropertyName,
  planComponentProperties,
  type PropertyType,
} from './canvas/components.ts'
import { binaryFile, slugify, textFile } from './agent/files.ts'
import { describeStyle, localStyles, styleFor, STYLE_KINDS, type StyleKind } from './canvas/styles.ts'
import { runModuleCommand } from './modules/run.ts'
import { beginRecording, endRecording } from './agent/ui-post.ts'

/* ------------------------------------------------------------------ types */

export type ExportScope = { mode: 'page' } | { mode: 'selection' } | { mode: 'frame'; frameId: string }

export interface ExportModules {
  tokens: boolean
  templates: boolean
  i18n: boolean
  animation: boolean
}

type PluginMessage =
  | { type: 'READ_VARIABLES' }
  | { type: 'EMIT_TOKENS' }
  | { type: 'EMIT_DJANGO'; cssFile: string; scope?: ExportScope }
  | { type: 'EMIT_DJANGO_PROJECT'; cssFile: string; scope?: ExportScope; existingFiles?: Record<string, string> }
  | { type: 'SCAN'; scope: ExportScope; lintMaxDepth?: number }
  | { type: 'SCAN_TOP' }
  | { type: 'SCROLL_INTO_VIEW'; nodeId: string }
  | { type: 'FIX_LINT'; findings: LintFixRequest[] }
  | { type: 'LOAD_ANNOTATION_PANEL'; nodeId: string }
  | { type: 'SET_ANNOTATION'; nodeId: string; form: AnnotationFormState }
  | { type: 'IMPORT_TRANSLATIONS'; content: string; format: ImportFormat; scope: ExportScope }
  | { type: 'CONFIRM_EXPORT'; scope: ExportScope; modules: ExportModules; cssFile: string; existingFiles?: Record<string, string> }
  | { type: 'SAVE_EXPORT_OPTIONS'; options: Partial<ExportOptions> }
  | { type: 'SYNC_BREAKPOINT_FRAMES' }
  | { type: 'SAVE_USER_PRESET'; label: string; values: unknown }
  | { type: 'DELETE_USER_PRESET'; id: string }
  | { type: 'GENERATE_BREAKPOINT_COLLECTION'; breakpoints?: Record<string, number> }
  | { type: 'GENERATE_KIT' }
  // The generic canvas primitives — see src/canvas/
  | { type: 'NODE_CREATE'; nodes: unknown; parent?: string; dryRun?: boolean }
  | { type: 'NODE_SET'; nodes: unknown; dryRun?: boolean }
  | {
      type: 'NODE_QUERY'
      name?: string
      types?: string[]
      nodeId?: string
      within?: string
      pageId?: string
      data?: Record<string, string>
      limit?: number
      props?: boolean
    }
  | {
      type: 'COMPONENT_CATALOG'
      query?: string
      source?: 'local' | 'library' | 'all'
      scope?: 'page' | 'document'
      usage?: boolean
      limit?: number
    }
  | { type: 'NODE_CLONE'; nodes: unknown; dryRun?: boolean }
  | { type: 'NODE_GROUP'; nodes: unknown; as?: string; props?: unknown; repeat?: unknown }
  | { type: 'COMPONENT_MAKE'; nodes: unknown; as?: string; name?: string; description?: string; props?: unknown }
  | {
      type: 'COMPONENT_PROPERTY'
      component: string
      add?: unknown
      edit?: unknown
      remove?: unknown
      bind?: unknown
    }
  | {
      type: 'NODE_EXPORT'
      nodes: unknown
      format?: string
      scale?: number
      width?: number
      height?: number
      outlineText?: boolean
      fps?: number
      quality?: string
      loop?: number
    }
  | { type: 'MOTION_STYLES' }
  | { type: 'SHADER_LIST'; kind?: string }
  | { type: 'STYLE_LIST'; kind?: string; query?: string; limit?: number }
  | {
      type: 'STYLE_MAKE'
      as: string
      name: string
      description?: string
      from?: string
      paints?: unknown
      effects?: unknown
      text?: unknown
      grid?: unknown
    }
  | { type: 'STYLE_REMOVE'; kind: string; name: string }
  | { type: 'PAGE_LIST' }
  | { type: 'FLOW_LIST'; pageId?: string }
  | { type: 'FLOW_SET'; flows: unknown; pageId?: string }
  | { type: 'PAGE_CREATE'; name: string; activate?: boolean }
  // User modules (see TASK-user-modules.md)
  | { type: 'MODULES_LIST' }
  | { type: 'MODULE_INSPECT'; file: unknown }
  | { type: 'MODULE_INSTALL'; file: unknown; replace?: boolean }
  | { type: 'MODULE_REMOVE'; id: string }
  | { type: 'MODULE_ENABLE'; id: string; enabled: boolean }
  | { type: 'MODULE_EXPORT'; id: string }
  | { type: 'MODULE_VIEW'; id: string; screen?: 'main' | 'settings' }
  | { type: 'MODULE_STATE_SET'; id: string; field: string; value: unknown }
  | { type: 'MODULE_RUN'; id: string; screen: 'main' | 'settings'; block: number; confirm?: boolean }
  // Design-tokens target messages
  | { type: 'SCAN_TOKENS'; docs?: { componentDocs?: boolean; componentPreviews?: boolean; previewBudgetMb?: number } }
  | { type: 'GENERATE_TYPOGRAPHY' }
  | { type: 'DELIVER'; zipBase64: string }
  // DS Tools target messages
  | { type: 'PREVIEW_PALETTE'; settings: unknown }
  | { type: 'SUGGEST_SPECTRUM'; settings: unknown }
  | { type: 'FIX_PALETTE'; settings: unknown; fix: unknown }
  | { type: 'APPLY_PALETTE'; settings: unknown; applyOptions?: Partial<PaletteApplyOptions> }
  | { type: 'SAVE_PALETTE_SETTINGS'; settings: unknown }
  | { type: 'REMAP_SCAN'; depth?: ScanDepth }
  | { type: 'REMAP_LIST_LIBRARIES' }
  | { type: 'REMAP_PREVIEW'; source: RemapSource; options?: Partial<RemapOptions>; overrides?: Record<string, string>; excluded?: string[] }
  | {
      type: 'REMAP_APPLY'
      source: RemapSource
      options?: Partial<RemapOptions>
      applyOptions?: Partial<RemapApplyOptions>
      overrides?: Record<string, string>
      excluded?: string[]
    }
  | { type: 'REMAP_REVERT' }
  | {
      type: 'REMAP_BOARD'
      /** Where the new palette comes from, when the plugin is to work the mapping out itself. */
      source?: RemapSource
      /** A `mapping.json` document instead: the board draws the correspondence it carries,
       * whoever computed it. Exactly one of `source` and `mapping` belongs in a call. */
      mapping?: unknown
      /** Names the section and identifies it, so boards of different kinds coexist. */
      title?: string
      options?: Partial<RemapOptions>
      overrides?: Record<string, string>
      excluded?: string[]
    }
  | { type: 'REMAP_UNPARK' }
  | { type: 'REMAP_REBIND_PREVIEW'; source: RemapSource; options?: Partial<RemapOptions>; overrides?: Record<string, string>; excluded?: string[]; scope?: RemapScope }
  | { type: 'REMAP_REBIND_APPLY'; source: RemapSource; options?: Partial<RemapOptions>; overrides?: Record<string, string>; excluded?: string[]; scope?: RemapScope }
  | { type: 'REMAP_REBIND_REVERT' }
  | { type: 'REMAP_EXPORT_MAPPING'; source: RemapSource; options?: Partial<RemapOptions>; format: 'json' | 'csv'; overrides?: Record<string, string>; excluded?: string[] }
  | {
      type: 'REMAP_REWRITE_FILES'
      source: RemapSource
      options?: Partial<RemapOptions>
      overrides?: Record<string, string>
      excluded?: string[]
      files: Array<{ name: string; text: string }>
      snap?: number
      byName?: boolean
      mode?: string | null
    }
  // Agent listener messages (see src/agent/, agent/README.md)
  | { type: 'AGENT_SET_GATES'; read: boolean; write: boolean }
  | { type: 'AGENT_REQUEST'; id: string; op: string; params?: unknown }

/* ------------------------------------------------------------------ remap */

/**
 * The document reading is kept between messages: the walk is the expensive part, and the
 * table re-plans on every edit. Any write invalidates it.
 */
let remapInventory: RemapInventory | null = null
/** How deep the last reading went, so an implicit rescan does not silently widen it. */
let remapDepth: ScanDepth = 'document'
/** When that reading was taken — see `inventoryStamp`. */
let remapInventoryAt = 0

/**
 * Which reading a plan was built on, reported with every plan-shaped answer.
 *
 * The inventory outlives the scan that produced it: it is reused by every preview until a write
 * invalidates it, and a preview with no inventory quietly takes one. That is fine for a person
 * who just pressed Scan themselves and can see the file, and a trap for an agent — a plan can
 * be perfectly self-consistent about a document that has since moved on, and nothing in the
 * answer said so. Only explicit writes clear it; a designer dragging layers does not.
 *
 * So the answer carries its own provenance and the caller decides whether to trust it. Cheap to
 * produce, and it turns an invisible assumption into a checkable fact.
 */
function inventoryStamp(): { scannedAt: string; ageMs: number; depth: ScanDepth; sites: number } | null {
  if (!remapInventory) return null
  return {
    scannedAt: new Date(remapInventoryAt).toISOString(),
    ageMs: Date.now() - remapInventoryAt,
    depth: remapDepth,
    sites: remapInventory.sites.length,
  }
}

/** The one place the inventory is read, so its stamp can never disagree with it. */
async function readInventory(depth: ScanDepth): Promise<RemapInventory> {
  const inventory = await readRemapInventory((label) => postToUi({ type: 'REMAP_PROGRESS', label }), depth)
  remapInventory = inventory
  remapDepth = depth
  remapInventoryAt = Date.now()
  return inventory
}

/** A row the human overrode in the approval table: site id → forced `#RRGGBB`. */
function applyRemapOverrides(plan: RemapPlan, overrides: Record<string, string> | undefined): RemapPlan {
  if (!overrides) return plan
  for (const entry of plan.entries) {
    const forced = overrides[entry.site.id]
    if (!forced) continue
    const literal = parseColorLiteral(forced)
    if (!literal) continue
    entry.to = { r: literal.rgba.r, g: literal.rgba.g, b: literal.rgba.b, a: entry.from.a }
    entry.deltaE = deltaE(entry.from, entry.to)
    entry.toName = null
    entry.via = 'nearest'
    entry.flags = entry.flags.filter((flag) => flag !== 'unchanged')
    if (!entry.flags.includes('manual')) entry.flags.push('manual')
  }
  return plan
}

/**
 * Where the new palette comes from. A paste always works and is the fallback; the others know
 * more — the generator knows its own families and steps exactly, a library knows the names a
 * team already agreed on — and that structure is worth more than anything inferred from bare
 * hexes.
 */
export type RemapSource =
  | { kind: 'paste'; text: string }
  | { kind: 'generator'; settings: unknown }
  | { kind: 'selection' }
  | { kind: 'library'; key: string; mode?: string | null }

type ResolvedPalette = { swatches: ReturnType<typeof parsePaletteInput>['swatches']; warnings: string[] }

/**
 * The last palette read, kept against the source that produced it.
 *
 * The table rebuilds on every edit — an override, a toggle — and each rebuild used to re-read
 * the source from scratch. For a library that is a hundred-odd round-trips per keystroke,
 * which is most of the time a preview takes. Everything but a canvas selection is a pure
 * function of the descriptor, so the same descriptor gives the same answer — and a selection,
 * which is not, is never cached.
 */
let remapPalette: { key: string; palette: ResolvedPalette } | null = null

async function resolveRemapSource(source: RemapSource): Promise<ResolvedPalette> {
  // A selection is the one source whose input is not in its descriptor: `{kind:'selection'}`
  // says nothing about what is selected, so the same key would hand back a palette read from a
  // different set of layers.
  if (source.kind === 'selection') return readRemapSource(source)

  const key = JSON.stringify(source)
  if (remapPalette && remapPalette.key === key) return remapPalette.palette
  const palette = await readRemapSource(source)
  remapPalette = { key, palette }
  return palette
}

async function readRemapSource(source: RemapSource): Promise<ResolvedPalette> {
  switch (source.kind) {
    case 'generator': {
      const settings = normalizePaletteSettings(source.settings)
      return { swatches: swatchesFromPalette(generatePalette(settings)), warnings: [] }
    }
    case 'selection': {
      postToUi({ type: 'REMAP_PROGRESS', label: 'reading the selection…' })
      const result = await swatchesFromSelection()
      return { swatches: result.swatches, warnings: result.warnings }
    }
    case 'library': {
      const result = await swatchesFromLibrary(source.key, source.mode ?? null, (label) =>
        postToUi({ type: 'REMAP_PROGRESS', label })
      )
      return { swatches: result.swatches, warnings: result.warnings }
    }
    default: {
      const parsed = parsePaletteInput(source.text)
      return { swatches: parsed.swatches, warnings: parsed.warnings }
    }
  }
}

async function planRemap(
  source: RemapSource,
  options: Partial<RemapOptions> | undefined,
  overrides: Record<string, string> | undefined,
  excluded?: readonly string[]
): Promise<{ plan: RemapPlan; palette: ReturnType<typeof parsePaletteInput>['swatches'] }> {
  const inventory = remapInventory ?? (await readInventory(remapDepth))
  const resolved = await resolveRemapSource(source)
  postToUi({ type: 'REMAP_PROGRESS', label: `matching ${resolved.swatches.length} new colors…` })
  const plan = buildRemapPlan({
    sites: inventory.sites,
    palette: resolved.swatches,
    primaryModeId: inventory.primaryModeId,
    // The plan only needs the pair; the text/boundary distinction belongs to the audit.
    adjacency: inventory.adjacency.map((pair) => [pair.a, pair.b] as [string, string]),
    excluded,
    options,
  })
  plan.warnings.push(...resolved.warnings)
  return { plan: applyRemapOverrides(plan, overrides), palette: resolved.swatches }
}

/** The plan as the table renders it — colors as hex, one row per site. */
function remapPlanView(plan: RemapPlan) {
  const renamedById = new Map(plan.renames.map((rename) => [rename.siteId, rename]))
  // Every row, in the order a human would work through them: named things first, what moves
  // before what does not, most used first. Recolouring the file *is* the task — a list that
  // withheld part of it would be hiding the work rather than helping with it, and the filter
  // above the table is what makes a long one usable.
  const rank = (entry: (typeof plan.entries)[number]): number => (entry.site.kind === 'detached' ? 1 : 0)
  const ranked = [...plan.entries].sort((a, b) => {
    const kind = rank(a) - rank(b)
    if (kind !== 0) return kind
    const moved = Number(a.flags.includes('unchanged')) - Number(b.flags.includes('unchanged'))
    return moved !== 0 ? moved : b.site.usage - a.site.usage
  })

  return {
    total: plan.entries.length,
    withheld: 0,
    rows: ranked.map((entry) => ({
      id: entry.site.id,
      kind: entry.site.kind,
      name: entry.site.name,
      newName: renamedById.get(entry.site.id)?.to ?? null,
      mode: entry.site.modeName,
      usage: entry.site.usage,
      from: toHex(entry.from),
      fromAlpha: entry.from.a,
      to: toHex(entry.to),
      toAlpha: entry.to.a,
      fromFamily: entry.fromFamily,
      fromStep: entry.fromStep,
      // The panel sorts each family the way the board draws it, and needs the same lightness
      // to do it — the UI has no colour maths of its own.
      fromL: Math.round(rgbToOklch(entry.from).l * 1000),
      toFamily: entry.toFamily,
      toStep: entry.toStep,
      via: entry.via,
      deltaE: Math.round(entry.deltaE * 10) / 10,
      flags: entry.flags,
    })),
    families: plan.families,
    // The count beside the list. A caller that wants the number should not have to hold the
    // whole array to get it — a module's state holds scalars, and the digest replaces a long
    // array with a summary before anyone downstream could count it either.
    familyCount: plan.families.length,
    renames: plan.renames,
    unusedFamilies: plan.unusedFamilies,
    warnings: plan.warnings,
  }
}

/* ------------------------------------------------------------------ helpers */

function frameworkLinksFrom(options: ExportOptions, tokensOn: boolean): BaseHtmlFrameworkLinks | null {
  if (options.targetOptions.framework !== 'bootstrap') return null
  return {
    source: options.targetOptions.bootstrapSource,
    version: options.targetOptions.bootstrapVersion,
    bootstrapTokensCssFile: tokensOn ? 'css/bootstrap-tokens.css' : null,
    fidelity: options.targetOptions.bootstrapFidelity,
  }
}

function defaultRoots(): readonly SceneNode[] {
  return figma.currentPage.selection.length > 0 ? figma.currentPage.selection : figma.currentPage.children
}

function rootsForScope(scope: ExportScope | undefined): readonly SceneNode[] {
  if (!scope) return defaultRoots()
  switch (scope.mode) {
    case 'selection': return figma.currentPage.selection
    case 'frame': return figma.currentPage.children.filter((node) => node.id === scope.frameId)
    case 'page': return figma.currentPage.children
  }
}

async function indexSceneNodes(roots: readonly SceneNode[]): Promise<Map<string, SceneNode>> {
  const index = new Map<string, SceneNode>()
  for (const root of roots) {
    index.set(root.id, root)
    const descendants = await findAllWithCriteria(root, (node): node is SceneNode => true)
    for (const node of descendants) index.set(node.id, node)
  }
  return index
}

async function addReactionDestinationsToScene(
  pageRoots: readonly IrNode[],
  sceneNodesById: Map<string, SceneNode>
): Promise<void> {
  const missing = [...collectReactionDestinationIds(pageRoots)].filter((id) => !sceneNodesById.has(id))
  await Promise.all(
    missing.map(async (id) => {
      const node = await figma.getNodeByIdAsync(id)
      if (node && 'getCSSAsync' in node) sceneNodesById.set(id, node as SceneNode)
    })
  )
}

async function collectThemableSets(sceneNodesById: ReadonlyMap<string, SceneNode>): Promise<ThemableSetData[]> {
  const setsById = new Map<string, ComponentSetNode>()
  for (const node of sceneNodesById.values()) {
    if (node.type !== 'INSTANCE') continue
    try {
      const main = await node.getMainComponentAsync()
      const parent = main?.parent
      if (parent?.type === 'COMPONENT_SET' && !setsById.has(parent.id)) setsById.set(parent.id, parent)
    } catch { /* skip */ }
  }
  const sets: ThemableSetData[] = []
  for (const set of setsById.values()) {
    try {
      const kind = matchBootstrapComponent(set.name, { key: set.key, properties: [] }, (name) => name)?.kind
      if (kind !== 'button') continue
      const variants: ThemableVariantData[] = []
      for (const child of set.children) {
        if (child.type !== 'COMPONENT') continue
        const css = await child.getCSSAsync()
        const smoothing = (child as { cornerSmoothing?: number }).cornerSmoothing ?? 0
        if (smoothing > 0 && css['border-radius']) css['border-radius'] = scaleBorderRadius(css['border-radius'], smoothing)
        const label = child.findOne((descendant) => descendant.type === 'TEXT')
        const labelCss = label ? await label.getCSSAsync() : null
        variants.push({ name: child.name, css, labelCss })
      }
      if (variants.length > 0) sets.push({ kind, setName: set.name, variants })
    } catch { /* skip */ }
  }
  return sets
}

function hasFigmaMotionApi(): boolean {
  return Boolean((figma as unknown as { motion?: unknown }).motion)
}

function collectMotionExportNodes(sceneNodesById: ReadonlyMap<string, SceneNode>): MotionExportNode[] {
  const nodes: MotionExportNode[] = []
  for (const node of sceneNodesById.values()) {
    const snapshot = readMotionData(node)
    if (snapshot && snapshot.tracks.length > 0) nodes.push({ nodeId: node.id, snapshot })
  }
  return nodes
}

function buildMotionExport(
  sceneNodesById: ReadonlyMap<string, SceneNode>,
  modules: ExportModules
): MotionExportArtifacts {
  if (!modules.animation || !hasFigmaMotionApi()) return EMPTY_MOTION_EXPORT_ARTIFACTS
  return emitMotionExportArtifacts(collectMotionExportNodes(sceneNodesById))
}

async function extractAllStrings(roots: readonly SceneNode[]): Promise<ExtractedEntry[]> {
  const catalog = new Map<string, ExtractedEntry>()
  for (const root of roots) {
    for (const entry of await extractStrings(root)) {
      const key = translationKey(entry.msgctxt, entry.msgid)
      const existing = catalog.get(key)
      if (existing) {
        existing.references.push(...entry.references)
        existing.nodeIds.push(...entry.nodeIds)
        if (!existing.comment.includes(entry.comment)) existing.comment += `; ${entry.comment}`
        continue
      }
      catalog.set(key, entry)
    }
  }
  return [...catalog.values()]
}

let lastScanIndex = new Map<string, SceneNode>()

/* ------------------------------------------------------------------ graph reading (design-tokens target) */

function serializeBoundVars(bv: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof bv !== 'object' || bv === null) return out
  const fields = ['fontFamily', 'fontStyle', 'fontWeight', 'fontSize', 'letterSpacing', 'lineHeight', 'paragraphSpacing', 'paragraphIndent']
  for (const field of fields) {
    const raw = (bv as Record<string, unknown>)[field]
    const b = Array.isArray(raw) ? raw[0] : raw
    if (typeof b === 'object' && b !== null && typeof (b as Record<string, unknown>).id === 'string') {
      out[field] = (b as Record<string, string>).id
    }
  }
  return out
}

const fontKey = (f: FontName): string => `${f.family} ${f.style}`

interface FontFacts { weight: number; italic: boolean }

/**
 * Figma exposes no weight on TextStyle — only `fontName.style`, a display string
 * ("Bold", "Book", "Md", "700", a variable-font instance name…). Guessing the number
 * from that string silently mislabels faces, and a wrong number written back through
 * `setBoundVariable('fontWeight', …)` re-resolves the style to a *different* face.
 * So probe the real face: apply each font to a throwaway text node and read what
 * Figma itself reports. Anything we can't probe falls back to the name heuristic.
 */
async function probeFontFacts(styles: readonly TextStyle[]): Promise<Map<string, FontFacts>> {
  const facts = new Map<string, FontFacts>()
  const fonts = new Map<string, FontName>()
  for (const s of styles) {
    if (!s.fontName || typeof s.fontName.family !== 'string') continue
    fonts.set(fontKey(s.fontName), { family: s.fontName.family, style: s.fontName.style })
  }
  if (fonts.size === 0 || figma.editorType === 'dev') return facts

  let probe: TextNode | null = null
  try {
    probe = figma.createText()
    probe.name = '[altery] font probe'
    probe.visible = false
    for (const [key, fontName] of fonts) {
      try {
        await figma.loadFontAsync(fontName)
        probe.fontName = fontName
        probe.characters = 'A'
        const segment = probe.getStyledTextSegments(['fontWeight', 'fontStyle'])[0]
        const weight = segment ? segment.fontWeight : probe.fontWeight
        if (typeof weight === 'number' && isFinite(weight) && weight > 0) {
          facts.set(key, { weight, italic: segment ? segment.fontStyle === 'ITALIC' : false })
        }
      } catch { /* missing or unloadable font — heuristic fallback */ }
    }
  } catch { /* node creation unavailable — heuristic fallback */ }
  finally { if (probe) { try { probe.remove() } catch { /* ignore */ } } }
  return facts
}

async function readGraph(): Promise<TokenGraph> {
  const [collections, variables, textStyles, effectStyles] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
    typeof figma.getLocalTextStylesAsync === 'function' ? figma.getLocalTextStylesAsync() : Promise.resolve([]),
    typeof figma.getLocalEffectStylesAsync === 'function' ? figma.getLocalEffectStylesAsync() : Promise.resolve([]),
  ])
  const fontFacts = await probeFontFacts(textStyles)
  // A theme split across `theme` + `theme-dark` (Figma's free plan caps a collection at one
  // mode) is folded back into one two-mode collection here, so every target downstream builds
  // the same package it would from a paid-plan file.
  const graph = foldSplitThemeCollections({
    fileName: figma.root.name,
    collections: collections.map((c) => {
      let generated = false
      try { generated = c.getPluginData('altery-typo-collection') === '1' } catch { /* ignore */ }
      return {
        id: c.id,
        name: c.name,
        defaultModeId: c.defaultModeId,
        modes: (c.modes || []).map((m) => ({ modeId: m.modeId, name: m.name })),
        generated,
      }
    }),
    variables: variables.map((v) => ({
      id: v.id,
      name: v.name,
      collectionId: v.variableCollectionId,
      resolvedType: v.resolvedType,
      valuesByMode: v.valuesByMode,
      // Scopes are the designer's own "where may this be applied" — DESIGN.md prefers them over
      // guessing the role from the token name.
      scopes: v.scopes,
    })),
    textStyles: textStyles.map((t) => ({
      id: t.id,
      name: t.name,
      fontName: t.fontName ? { family: t.fontName.family, style: t.fontName.style } : null,
      fontWeight: t.fontName ? fontFacts.get(fontKey(t.fontName))?.weight : undefined,
      italic: t.fontName ? fontFacts.get(fontKey(t.fontName))?.italic : undefined,
      fontSize: t.fontSize,
      lineHeight: t.lineHeight,
      letterSpacing: t.letterSpacing,
      paragraphSpacing: t.paragraphSpacing,
      paragraphIndent: t.paragraphIndent,
      boundVariables: serializeBoundVars(t.boundVariables),
    })),
    // Shadows/blurs live in effect styles, not variables — without this pass a focus ring or an
    // elevation scale never reaches the token package at all.
    effectStyles: effectStyles.map((style) => ({
      id: style.id,
      name: style.name,
      effects: (style.effects || []).map((effect) => {
        const shadow = effect as Partial<DropShadowEffect>
        return {
          type: effect.type,
          color: shadow.color ? { r: shadow.color.r, g: shadow.color.g, b: shadow.color.b, a: shadow.color.a } : null,
          offset: shadow.offset ? { x: shadow.offset.x, y: shadow.offset.y } : null,
          radius: (effect as { radius?: number }).radius,
          spread: shadow.spread,
          visible: (effect as { visible?: boolean }).visible,
        }
      }),
    })),
  })
  return graph
}

/* ------------------------------------------------------------------ component documentation */

/** Widest a preview may get. A 32-variant button sheet is downscaled to fit; anything narrower is
 * left alone rather than blown up to this width. */
const PREVIEW_MAX_WIDTH = 1600
/** Upper bound on upscaling: a 16px icon is worth 2x (crisp on a HiDPI screen), not 100x. */
const PREVIEW_MAX_SCALE = 2
/** Ceiling on preview bytes per export (Settings → Documentation → Preview budget) — beyond it the
 * remaining components ship without an image (and say so) rather than producing a package nobody
 * can open. Deliberately the ONLY cap: the count is whatever the file has, since the user opted
 * into the capture and a component without a picture is exactly what they asked to avoid. Capture
 * order is document order, so which components fall past the budget is stable across re-exports
 * instead of churning the diff. */

/**
 * Export scale for one node. A fixed `WIDTH` constraint would upscale every small component to that
 * width (a 24px icon shipped as an 800px PNG) and there is no point paying for those pixels — so
 * the scale is derived from the node's own width and clamped at both ends.
 */
function previewScale(width: number): number {
  if (!isFinite(width) || width <= 0) return 1
  return Math.max(0.25, Math.min(PREVIEW_MAX_SCALE, PREVIEW_MAX_WIDTH / width))
}

function previewPath(name: string, id: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `previews/${slug || 'component'}--${id.replace(/[^a-zA-Z0-9]+/g, '-')}.png`
}

function componentPropertiesOf(node: ComponentSetNode | ComponentNode): ComponentProperty[] {
  let definitions: ComponentPropertyDefinitions = {}
  try {
    // Throws on a variant CHILD (never on a set or a lone component) — stay defensive anyway.
    definitions = node.componentPropertyDefinitions ?? {}
  } catch {
    return []
  }
  return Object.keys(definitions).map((rawName) => {
    const definition = definitions[rawName]
    return {
      // Figma suffixes non-variant props with `#<id>`; the designer never sees that part.
      name: rawName.split('#')[0].trim(),
      type: definition.type,
      options: definition.variantOptions ? [...definition.variantOptions] : undefined,
      defaultValue: definition.defaultValue === undefined ? undefined : String(definition.defaultValue),
    }
  })
}

/** The documentable unit is the SET (it owns the description); a component outside a set is its own. */
function isDocumentableComponent(node: SceneNode): node is ComponentSetNode | ComponentNode {
  if (node.type === 'COMPONENT_SET') return true
  return node.type === 'COMPONENT' && node.parent?.type !== 'COMPONENT_SET'
}

interface ComponentDocsResult {
  docs: ComponentDoc[]
  /** `previews/*.png` bytes to ship alongside `COMPONENTS.md`. */
  files: Record<string, Uint8Array>
}

/**
 * Reads every local component's "Component configuration": the markdown description, the
 * documentation link and the property definitions — plus, optionally, a PNG of the master so the
 * text has something to point at.
 *
 * `nodes` limits the collection to a known set (the Django export documents what it actually
 * shipped); omitted, the whole file is scanned, which is what a token/library export wants.
 */
async function collectComponentDocs(
  withPreviews: boolean,
  budgetMb: number,
  nodes?: readonly (ComponentSetNode | ComponentNode)[]
): Promise<ComponentDocsResult> {
  const budgetBytes = Math.max(1, budgetMb) * 1024 * 1024
  const files: Record<string, Uint8Array> = {}
  let targets: (ComponentSetNode | ComponentNode)[]
  if (nodes) {
    targets = [...nodes]
  } else {
    try {
      await figma.loadAllPagesAsync()
    } catch { /* older host, or already loaded */ }
    targets = figma.root
      .findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })
      .filter(isDocumentableComponent)
  }

  const pageNameById = new Map<string, string>()
  const pageOf = (node: BaseNode): string | undefined => {
    let current: BaseNode | null = node
    while (current && current.type !== 'PAGE') current = current.parent
    if (!current) return undefined
    if (!pageNameById.has(current.id)) pageNameById.set(current.id, current.name)
    return pageNameById.get(current.id)
  }

  let previewBytes = 0
  let previewCount = 0
  const docs: ComponentDoc[] = []
  for (const node of targets) {
    let description = ''
    let links: string[] = []
    try {
      // `descriptionMarkdown` is what the rich-text Component configuration editor writes; the
      // plain `description` is the legacy field and stays as the fallback.
      description = (node.descriptionMarkdown || node.description || '').trim()
      links = (node.documentationLinks ?? []).map((link) => link.uri).filter(Boolean)
    } catch { /* unreadable — keep the component, lose the prose */ }

    const doc: ComponentDoc = {
      id: node.id,
      name: node.name,
      page: pageOf(node),
      description,
      links,
      properties: componentPropertiesOf(node),
      variantCount: node.type === 'COMPONENT_SET' ? node.children.length : undefined,
    }

    if (withPreviews) {
      if (previewBytes >= budgetBytes) {
        doc.previewError = `the ${budgetMb} MB preview budget for this export was already spent — raise it in Settings → Documentation`
      } else {
        try {
          const bytes = await node.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: previewScale(node.width) },
          })
          const path = previewPath(node.name, node.id)
          files[path] = bytes
          previewBytes += bytes.length
          previewCount++
          doc.preview = path
        } catch (error) {
          doc.previewError = error instanceof Error ? error.message : String(error)
        }
      }
    }

    docs.push(doc)
    if (withPreviews) {
      postToUi({ type: 'COMPONENT_PREVIEW_PROGRESS', done: docs.length, total: targets.length })
    }
    if (docs.length % 10 === 0) await yieldToHost()
  }
  return { docs, files }
}

/* ------------------------------------------------------------------ sandbox entry */

const TYPO_COLLECTION_PLUGIN_KEY = 'altery-typo-collection'

export interface TypographyGenReport {
  collection: string
  created: number
  bound: number
  failed: number
  failures: string[]
  replaced: number
}

function createTypographyVariable(name: string, collection: VariableCollection, type: VariableResolvedDataType): Variable {
  try {
    return figma.variables.createVariable(name, collection, type)
  } catch {
    return figma.variables.createVariable(name, collection.id, type)
  }
}

async function generateTypographyVariables(options: unknown): Promise<TypographyGenReport> {
  if (figma.editorType === 'dev') throw new Error("Switch to Design mode — Dev Mode can't create variables.")
  const graph = await readGraph()
  const opts = normalizeExportOptions(options)
  const plan: TypographyPlan = planTypographyVariables(graph, { typoNaming: opts.tokens.typoNaming })
  if (plan.variables.length === 0) throw new Error('No text styles with bindable values found.')

  let replaced = 0
  for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
    let mine = false
    try { mine = c.getPluginData(TYPO_COLLECTION_PLUGIN_KEY) === '1' } catch { /* ignore */ }
    if (mine) { try { c.remove(); replaced++ } catch { /* ignore */ } }
  }

  const collection = figma.variables.createVariableCollection(plan.collectionName)
  try { collection.setPluginData(TYPO_COLLECTION_PLUGIN_KEY, '1') } catch { /* ignore */ }
  const modeId = collection.modes[0].modeId
  const byName: Record<string, Variable> = {}
  for (const spec of plan.variables) {
    const v = createTypographyVariable(spec.name, collection, spec.type as VariableResolvedDataType)
    v.setValueForMode(modeId, spec.value as VariableValue)
    try { v.scopes = spec.scopes } catch { /* ignore */ }
    byName[spec.name] = v
  }

  const styleById: Record<string, TextStyle> = {}
  const localStyles = await figma.getLocalTextStylesAsync()
  for (const s of localStyles) styleById[s.id] = s
  // Font-field bindings re-resolve the face, which needs the font loaded first.
  for (const s of localStyles) {
    if (!s.fontName) continue
    try { await figma.loadFontAsync(s.fontName) } catch { /* missing font — the bind below will report it */ }
  }

  let bound = 0, failed = 0
  const failures: string[] = []
  for (const b of plan.bindings) {
    const style = styleById[b.styleId], variable = byName[b.varName]
    if (!style || !variable) { failed++; continue }
    const field = b.field as VariableBindableTextField
    const before = style.fontName ? { family: style.fontName.family, style: style.fontName.style } : null
    try {
      style.setBoundVariable(field, variable)
      // Binding a font field can silently swap the face to one Figma likes better.
      // The style must keep the face the designer chose — otherwise roll the bind back.
      const after = style.fontName
      if (before && after && (after.family !== before.family || after.style !== before.style)) {
        style.setBoundVariable(field, null)
        try { style.fontName = before } catch { /* ignore */ }
        failed++
        if (failures.length < 8) failures.push(`${b.styleName} · ${b.field}: would change ${before.family} ${before.style} → ${after.family} ${after.style}`)
        continue
      }
      bound++
    } catch (e) { failed++; if (failures.length < 8) failures.push(`${b.styleName} · ${b.field}: ${String((e as Error)?.message || e)}`) }
  }
  return { collection: plan.collectionName, created: plan.variables.length, bound, failed, failures, replaced }
}

figma.showUI(__html__, { width: 420, height: 660, themeColors: true })

/**
 * Remembered gates, keyed by file. `figma.fileKey` is the real identity and is what a private
 * plugin on an Organization plan gets; everywhere else it reads null and the file *name* has to
 * stand in, which means two files called the same thing share one answer. Preferring the key
 * when it exists costs nothing and quietly removes that collision on publish — and the name is
 * still read as a fallback so nobody's existing grant is forgotten in the move.
 *
 * Both halves are remembered. Writes were session-only at first, on the reasoning that the half
 * which changes the document deserves a deliberate arming — but re-arming it eight times in one
 * afternoon is not deliberation either. The switches stay in the panel and revoking is one
 * click; that, not the re-asking, is what keeps the grant real.
 */
const GATES_KEY = 'agentGates'

interface StoredGates {
  read: boolean
  write: boolean
}

/** The key first, the name second — see `gatesFor` for why both are read. */
function gateKeys(): string[] {
  const key = figma.fileKey
  return key ? [key, figma.root.name] : [figma.root.name]
}

function readStoredGates(entry: unknown): StoredGates | null {
  if (entry && typeof entry === 'object') {
    const record = entry as Record<string, unknown>
    return { read: record.read === true, write: record.write === true }
  }
  // The first shape stored a bare `true` for the read gate; honour it rather than silently
  // locking out anyone who granted before this changed.
  if (entry === true) return { read: true, write: false }
  return null
}

async function gatesFor(): Promise<StoredGates> {
  try {
    const stored = await figma.clientStorage.getAsync(GATES_KEY)
    if (!stored || typeof stored !== 'object') return { read: false, write: false }
    const all = stored as Record<string, unknown>
    for (const key of gateKeys()) {
      const gates = readStoredGates(all[key])
      if (gates) return gates
    }
  } catch {
    /* fall through to closed */
  }
  return { read: false, write: false }
}

async function rememberGates(gates: StoredGates): Promise<void> {
  try {
    const stored = await figma.clientStorage.getAsync(GATES_KEY)
    const all: Record<string, unknown> = stored && typeof stored === 'object' ? { ...(stored as Record<string, unknown>) } : {}
    // Written under the best key available, and the weaker one is dropped so a rename cannot
    // resurrect a grant the designer already revoked.
    const [primary, ...rest] = gateKeys()
    if (gates.read || gates.write) all[primary] = { read: gates.read, write: gates.write }
    else delete all[primary]
    for (const stale of rest) delete all[stale]
    await figma.clientStorage.setAsync(GATES_KEY, all)
  } catch {
    /* a listener that works but forgets is better than one that fails to open */
  }
}

const isRelaunch = figma.command === 'reexport'

Promise.all([
  figma.clientStorage.getAsync('exportOptions'),
  figma.clientStorage.getAsync('userPresets'),
  figma.clientStorage.getAsync('paletteSettings'),
]).then(async ([storedOptions, storedPresets, storedPalette]) => {
  // Before anything answers: a module command has to be callable from the first request, and
  // the channel's command list is assembled per call from whatever this holds.
  await loadUserModules()
  // The bridge URL and secret are setup and worth persisting; so is the answer a designer has
  // already given about this file. Re-asking on every open does not strengthen consent — it
  // trains the reflex to click through it — and the switches stay in the panel either way.
  const options = normalizeExportOptions(storedOptions)
  const remembered = await gatesFor()
  // Writes cannot outlive reads, the same rule the panel enforces, applied to what was stored
  // in case the two ever drift apart.
  options.agent = { ...options.agent, read: remembered.read, write: remembered.read && remembered.write }
  postToUi({
    type: 'EXPORT_OPTIONS',
    options,
    presets: EXPORT_PRESETS,
    userPresets: normalizeUserPresets(storedPresets),
  })
  const paletteSettings = normalizePaletteSettings(storedPalette)
  postToUi({
    type: 'PALETTE_PREVIEW',
    palette: generatePalette(paletteSettings),
    settings: paletteSettings,
  })
})

function topLevelAncestorOf(node: SceneNode): SceneNode {
  let current: SceneNode = node
  while (current.parent && current.parent.type !== 'PAGE') current = current.parent as SceneNode
  return current
}

function postSelectionToUi(): void {
  const selection = figma.currentPage.selection
  if (selection.length === 0) return
  const node = selection[0]
  const top = topLevelAncestorOf(node)
  postToUi({
    type: 'SELECTION_CHANGED',
    nodeId: node.id,
    isText: node.type === 'TEXT',
    topLevelFrameId: top.type === 'FRAME' ? top.id : null,
  })
}

figma.on('selectionchange', postSelectionToUi)

/**
 * Which variables a node's fields follow, as one line.
 *
 * Paints are left out: `fill` and `stroke` already report `var:<name>` themselves, and repeating
 * them here would say the same thing twice in a reply that is read by eye.
 */
async function describeBindings(value: unknown): Promise<{ bind?: string }> {
  if (typeof value !== 'object' || value === null) return {}
  const parts: string[] = []
  for (const [field, alias] of Object.entries(value as Record<string, unknown>)) {
    if (['fills', 'strokes', 'effects', 'componentProperties'].includes(field)) continue
    // A text field is bound per range, so Figma keeps a list even when the whole layer follows
    // one variable — and reading only the single form left a binding that had plainly worked
    // reported as absent.
    const aliases = Array.isArray(alias) ? alias : [alias]
    const seen = new Set<string>()
    for (const one of aliases as Array<{ id?: string }>) {
      const id = one?.id
      if (!id || seen.has(id)) continue
      seen.add(id)
      const variable = await figma.variables.getVariableByIdAsync(id).catch(() => null)
      parts.push(`${field}=var:${variable?.name ?? id}`)
    }
  }
  return parts.length > 0 ? { bind: parts.join(' · ') } : {}
}

/**
 * Paints and effects for a style, built by the vocabulary rather than by a second parser.
 *
 * `applyProps` knows how to turn `{ gradient }` or `{ shadow: 'drop' }` into what Figma wants,
 * and it needs a node to do it on. So a rectangle is made, written to, read back and removed —
 * cheaper than a duplicate of that logic, and it cannot drift from it.
 */
async function applyToScratch(
  spec: unknown,
  as: 'paints' | 'effects' | 'grid'
): Promise<{ fills: Paint[]; effects: Effect[]; grids: LayoutGrid[] }> {
  const plan = planProps(
    as === 'paints' ? { fill: spec } : as === 'effects' ? { effects: spec } : { grid: spec },
    as
  )
  if (plan.problems.length > 0) throw new Error(plan.problems.join(' · '))

  // A frame rather than a rectangle when grids are wanted: only a frame has layoutGrids.
  const scratch = as === 'grid' ? figma.createFrame() : figma.createRectangle()
  try {
    const report = await applyProps(scratch, plan.steps, false)
    const failed = report.applied.filter((one) => one.error)
    if (failed.length > 0) throw new Error(failed.map((one) => `${one.property}: ${one.error}`).join(' · '))
    return {
      fills: scratch.fills as Paint[],
      effects: scratch.effects as Effect[],
      grids: (scratch as unknown as { layoutGrids?: LayoutGrid[] }).layoutGrids ?? [],
    }
  } finally {
    scratch.remove()
  }
}

/** A component's own property definitions, or nothing — a variant child throws rather than
 * answering, and that must not take the whole command down. */
function definitionsOf(node: ComponentNode | ComponentSetNode): ComponentPropertyDefinitions {
  try {
    return node.componentPropertyDefinitions ?? {}
  } catch {
    return {}
  }
}

/** The one-line form the catalogue prints, for a node in hand. */
function describeProperties(node: ComponentNode | ComponentSetNode): string {
  return describePropertyDefinitions(definitionsOf(node) as Record<string, { type: string; variantOptions?: readonly string[]; defaultValue?: unknown }>)
}

const GROUPINGS = ['group', 'ungroup', 'union', 'subtract', 'intersect', 'exclude', 'flatten', 'outline', 'repeat']

const EXPORT_FORMATS = ['PNG', 'JPG', 'SVG', 'PDF', 'MP4', 'GIF', 'WEBM']

/** The three that render time rather than a moment: a frame's animation, not its appearance. */
const VIDEO_FORMATS = ['MP4', 'GIF', 'WEBM']

/** Video export takes a scale from a fixed set rather than any number. */
const VIDEO_SCALES = [0.5, 0.75, 1, 1.5, 2, 3, 4]

const VIDEO_FPS: Readonly<Record<string, number[]>> = {
  MP4: [12, 24, 30, 60],
  WEBM: [12, 24, 30, 60],
  GIF: [8, 12, 15, 24, 30],
}

const EXPORT_MIME: Readonly<Record<string, string>> = {
  PNG: 'image/png',
  JPG: 'image/jpeg',
  PDF: 'application/pdf',
  SVG: 'image/svg+xml',
  MP4: 'video/mp4',
  GIF: 'image/gif',
  WEBM: 'video/webm',
}

/** Past this a call is handing back more than anyone asked to read; what did not fit is named. */
const EXPORT_BUDGET = 12 * 1024 * 1024

/** A file name from a layer name, kept unique within one call — two layers may share a name, and
 * the second must not overwrite the first on the way out. */
function exportName(layer: string, extension: string, taken: Set<string>): string {
  const stem = slugify(layer, 'node')
  let candidate = `${stem}.${extension}`
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem}-${n}.${extension}`
  taken.add(candidate)
  return candidate
}

/** How far a copy is stepped aside from what it was copied from, when nobody said where to put
 * it. Wide enough that two screens do not touch, and the same 64 the copy op has always used. */
const CLONE_GAP = 64

/* ------------------------------------------------------------------ canvas reads */

/**
 * A node as a caller can act on it: the ids and names to aim at, and — asked for — the same
 * property vocabulary `NODE_SET` accepts, so a read can be edited and sent back.
 */
async function describeNode(node: SceneNode, withProps: boolean): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
    ...(node.parent ? { parent: { id: node.parent.id, name: node.parent.name } } : {}),
    ...('children' in node ? { childCount: node.children.length } : {}),
  }
  if (!withProps) return base

  const bag = node as unknown as Record<string, unknown>
  const round = (value: unknown) => (typeof value === 'number' ? Math.round(value * 100) / 100 : value)
  const props: Record<string, unknown> = {
    x: round(bag.x),
    y: round(bag.y),
    width: round(bag.width),
    height: round(bag.height),
    ...(bag.visible === false ? { visible: false } : {}),
    ...(typeof bag.opacity === 'number' && bag.opacity < 1 ? { opacity: round(bag.opacity) } : {}),
    ...('fills' in bag ? { fill: await describePaints(bag.fills) } : {}),
    // Beside the line, the settings themselves: what a read hands over is what a write takes,
    // which is the only way to put the same shader on another layer.
    ...(describeShaderPaints(bag.fills).length > 0 ? { shader: describeShaderPaints(bag.fills) } : {}),
    ...('strokes' in bag && Array.isArray(bag.strokes) && bag.strokes.length > 0
      ? {
          stroke: await describePaints(bag.strokes),
          strokeWeight: round(bag.strokeWeight),
          // The rest of the stroke, when it is not the default — a read that omits the dashes
          // cannot be edited and sent back, which is the whole promise of this shape.
          ...(bag.strokeAlign !== 'INSIDE' ? { strokeAlign: bag.strokeAlign } : {}),
          ...(Array.isArray(bag.dashPattern) && bag.dashPattern.length > 0 ? { strokeDashes: bag.dashPattern } : {}),
          ...(bag.complexStrokeProperties && (bag.complexStrokeProperties as { type?: string }).type !== 'BASIC'
            ? { brush: describeBrush(bag.complexStrokeProperties) }
            : {}),
          ...(typeof bag.strokeCap === 'string' && bag.strokeCap !== 'NONE' ? { strokeCap: bag.strokeCap } : {}),
          ...(typeof bag.strokeJoin === 'string' && bag.strokeJoin !== 'MITER' ? { strokeJoin: bag.strokeJoin } : {}),
        }
      : {}),
    ...(typeof bag.cornerRadius === 'number' ? { cornerRadius: round(bag.cornerRadius) } : {}),
    ...(Array.isArray(bag.effects) && bag.effects.length > 0 ? { effects: await describeEffects(bag.effects) } : {}),
    ...(Array.isArray(bag.layoutGrids) && bag.layoutGrids.length > 0 ? { grid: describeGrids(bag.layoutGrids) } : {}),
    ...(Array.isArray(bag.animationStyles) && bag.animationStyles.length > 0
      ? { animation: await describeAnimation(bag.animationStyles) }
      : {}),
    ...(Array.isArray(bag.timelines) && bag.timelines.length > 0
      ? { timelines: (bag.timelines as Timeline[]).map((one) => `${one.id} ${one.duration}s`).join(' · ') }
      : {}),
    ...(await describeBindings(bag.boundVariables)),
    ...(typeof bag.overflowDirection === 'string' && bag.overflowDirection !== 'NONE'
      ? { scroll: bag.overflowDirection }
      : {}),
    ...(typeof bag.numberOfFixedChildren === 'number' && bag.numberOfFixedChildren > 0
      ? { fixedChildren: bag.numberOfFixedChildren }
      : {}),
    ...(typeof bag.blendMode === 'string' && bag.blendMode !== 'PASS_THROUGH' && bag.blendMode !== 'NORMAL'
      ? { blendMode: bag.blendMode }
      : {}),
  }
  if ('layoutMode' in bag && bag.layoutMode !== 'NONE') {
    props.layout = {
      mode: bag.layoutMode,
      gap: round(bag.itemSpacing),
      padding: [bag.paddingTop, bag.paddingRight, bag.paddingBottom, bag.paddingLeft].map(round),
      primaryAxis: bag.primaryAxisAlignItems,
      counterAxis: bag.counterAxisAlignItems,
    }
  }
  const keys = node.getPluginDataKeys()
  if (keys.length > 0) {
    const data: Record<string, string> = {}
    for (const key of keys) data[key] = node.getPluginData(key)
    props.data = data
  }
  // `reactions`, not a `getReactionsAsync` — that method does not exist, which is why this read
  // answered `undefined` for a node whose links had just been set.
  const linked = node as SceneNode & { reactions?: readonly Reaction[] }
  if (Array.isArray(linked.reactions)) {
    const links = await describeLinks(linked.reactions, variableName)
    if (links) props.links = links
  }
  const shape = bag.vectorNetwork as VectorNetwork | undefined
  if (shape && Array.isArray(shape.vertices) && shape.vertices.length > 0) {
    props.network = `${shape.vertices.length} point(s), ${shape.segments.length} segment(s)${
      shape.regions?.length ? `, ${shape.regions.length} region(s)` : ''
    }`
  }
  if (node.type === 'INSTANCE') {
    // What an instance IS, in the words the catalogue uses — the question anyone asks of a screen
    // they are about to build another one like.
    const main = await node.getMainComponentAsync().catch(() => null)
    // The SET's name when there is one: that is what the catalogue calls it, and a variant's own
    // name is the axis values ("Size=Large, State=Default"), which nobody can instantiate from.
    const owner = main && main.parent?.type === 'COMPONENT_SET' ? main.parent : main
    props.component = owner?.name ?? '(unavailable)'
    const settings = Object.entries(node.componentProperties as unknown as Record<string, { value?: unknown }>)
      .map(([key, entry]) => `${humanPropertyName(key)}=${String(entry?.value)}`)
    if (settings.length > 0) props.properties = settings.join(' · ')
  }
  // A TEXT_PATH is text too — Figma Draw gives it every text property and a different type.
  if (node.type === 'TEXT' || node.type === 'TEXT_PATH') {
    props.text = node.characters
    props.fontSize = node.fontSize === figma.mixed ? 'mixed' : round(node.fontSize)
    props.fontName = node.fontName === figma.mixed ? 'mixed' : `${node.fontName.family} ${node.fontName.style}`
    props.textAlign = node.textAlignHorizontal
    // A read that omits how the lines break cannot be sent back, which is the promise this shape
    // makes everywhere else.
    const wrap = (node as unknown as { textWrapStyle?: unknown }).textWrapStyle
    if (typeof wrap === 'string' && wrap !== 'AUTO') props.textWrap = wrap
  }
  return { ...base, props }
}

/* ------------------------------------------------------------------ user modules */

/**
 * Modules a designer installed, held in memory and backed by `clientStorage`.
 *
 * They are read once when the plugin opens and rewritten whenever one is installed or removed,
 * so the list the channel answers from is the list on disk. Everything about whether a module
 * is *usable* — whether it parses, what it may call, whether one of its steps names a command
 * this build does not have — is decided in `src/modules/`, which knows nothing about Figma.
 */
const MODULES_KEY = 'userModules'

let userModules: RegisteredModule[] = []

async function readStoredModules(): Promise<Record<string, StoredModule>> {
  const stored = await figma.clientStorage.getAsync(MODULES_KEY)
  return stored && typeof stored === 'object' ? (stored as Record<string, StoredModule>) : {}
}

async function loadUserModules(): Promise<void> {
  try {
    userModules = registerModules(await readStoredModules(), UI_COMMANDS)
  } catch (error) {
    // A plugin that opens without its modules is workable; one that refuses to open is not.
    console.warn('[modules] could not be read', error)
    userModules = []
  }
}

/** The version of what is stored, for telling an upgrade from a reinstall. Read off the file
 * rather than a stored field: the file is the thing that carries a version. */
function versionOf(entry: StoredModule | undefined): string | null {
  const file = entry?.file
  const version = file && typeof file === 'object' ? (file as { version?: unknown }).version : null
  return typeof version === 'string' ? version : null
}

/** Declared defaults with whatever the module has kept laid over them — what a field shows, and
 * what a run starts from. A stored value for a field the module no longer declares is dropped
 * rather than carried forward by an upgrade. */
function moduleStateOf(entry: RegisteredModule): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(entry.module?.state ?? {})) {
    const kept = entry.stored?.state?.[name]
    state[name] = typeof kept === field.type ? kept : field.default
  }
  return state
}

async function writeStoredModules(next: Record<string, StoredModule>): Promise<void> {
  await figma.clientStorage.setAsync(MODULES_KEY, next)
  userModules = registerModules(next, UI_COMMANDS)
}

/**
 * The agent side of a module.
 *
 * Registered as a provider rather than imported by the channel: the list changes while the
 * plugin runs, and `plugin.call` should dispatch against what is installed now. The steps go
 * back through `handleUiMessage` — a module command is a pipeline over the plugin's own
 * commands, and it gets no way to reach anything the panel could not.
 */
setModuleProvider({
  commands: () => moduleCommandDefs(userModules),
  unavailable: (name) => {
    const found = findModuleCommand(userModules, name)
    return found && 'error' in found ? found.error : null
  },
  async run(name, params) {
    const found = findModuleCommand(userModules, name)
    if (!found) throw new Error(`unknown module command "${name}"`)
    if ('error' in found) throw new Error(found.error)

    const { confirm, ...rest } = params as Record<string, unknown>
    const report = await runModuleCommand(found.module, found.command, rest, {
      call: (message) => handleUiMessage(message as PluginMessage),
      // Each step gets its own recording inside whatever the caller already opened, so a step
      // can read its own answer without hiding it from the run as a whole.
      record: async (work) => {
        const sink = beginRecording()
        try {
          await work()
        } finally {
          endRecording(sink)
        }
        return sink
      },
      confirmed: confirm === true,
      state: moduleStateOf(found.entry),
    })

    // What the run kept is written back under the module's own id, and only the fields it
    // declared — see `runModuleCommand`.
    if (report.ok) {
      const stored = await readStoredModules()
      const entry = stored[found.entry.id]
      if (entry) await writeStoredModules({ ...stored, [found.entry.id]: { ...entry, state: report.state } })
    }
    return report
  },
})

/* ------------------------------------------------------------------ message handler */

/**
 * A command declining to run, out loud.
 *
 * Several cases used to guard a precondition and `break` — no reply, no notice, nothing. For
 * the panel that is invisible and harmless: the operator picked the node from a list this
 * plugin built, so the precondition held by construction. For anything driving the same
 * commands from outside it is a dead end, and three different failures — node absent, wrong
 * type, no scan yet — arrive as the identical empty answer.
 *
 * One reply type for all of them, rather than an area-specific `*_ERROR` each: a refusal is a
 * refusal, and the caller should have exactly one thing to look for. The panel ignores it, as
 * it ignored the silence, so nothing the designer sees changes.
 */
function refuse(command: PluginMessage['type'], reason: string): void {
  postToUi({ type: 'COMMAND_REFUSED', command, reason })
}

/**
 * One switch, and every feature this plugin has hangs off it.
 *
 * A named function rather than an inline arrow because it has two callers now: the panel, and
 * the agent channel — `plugin.call` runs a command by handing this the very message a click
 * would have sent, which is what stops the listener from being a permanent subset of the
 * plugin (see `agent/plugin-ops.ts`).
 *
 * Each case carries an `@agent read|write|deny:` marker. It is the one line to write when
 * adding a command: `build.mjs` extracts it into the table the channel authorises against, and
 * a case that ships without one is treated as a write.
 */
async function handleUiMessage(msg: PluginMessage): Promise<void> {
  switch (msg.type) {
    /* ---- design-tokens target ---- */
    case 'SCAN_TOKENS': {
      // @agent read: build the design-token package (tokens, DESIGN.md, component docs) and hand back the files
      try {
        const graph = await readGraph()
        const stored = await figma.clientStorage.getAsync('exportOptions')
        const options = normalizeExportOptions(stored)
        // Component configuration (description + doc link + props) is design intent that exists
        // nowhere in the token tree — collect it BEFORE building the package so DESIGN.md can
        // point at it, then ship COMPONENTS.md and the previews alongside the tokens.
        // The UI sends its live values so a package built right after a toggle reflects it —
        // stored options can still be one save behind.
        const docsOptions = { ...options.docs, ...(msg.docs ?? {}) }
        const componentDocs = docsOptions.componentDocs
          ? await collectComponentDocs(docsOptions.componentPreviews, docsOptions.previewBudgetMb)
          : { docs: [], files: {} }
        // `buildDesignTokens` writes COMPONENTS.md (it owns the token model the descriptions
        // resolve against); the previews are binary and travel separately.
        const artifacts = buildDesignTokens(graph, options, undefined, componentDocs.docs, readRenameMap())
        for (const path of Object.keys(componentDocs.files)) artifacts.files[path] = componentDocs.files[path]
        artifacts.summary.componentCount = componentDocs.docs.length
        artifacts.summary.previewCount = Object.keys(componentDocs.files).length
        // Previews asked for but none produced is a silent failure otherwise — surface the reason.
        if (docsOptions.componentPreviews && Object.keys(componentDocs.files).length === 0) {
          const reason = componentDocs.docs.find((doc) => doc.previewError)?.previewError
          artifacts.summary.previewError = reason ?? 'no components found to capture'
        }
        postToUi({ type: 'TOKENS_RESULT', summary: artifacts.summary, files: artifacts.files, options })
      } catch (err) {
        postToUi({ type: 'TOKENS_ERROR', message: String((err as Error)?.message || err) })
      }
      break
    }
    case 'DELIVER': {
      // @agent write: POST a built package to the configured delivery endpoint — it leaves this machine
      try {
        const stored = await figma.clientStorage.getAsync('exportOptions')
        const options = normalizeExportOptions(stored)
        const zipBytes = figma.base64Decode(msg.zipBase64)
        const result = await deliverPackage(zipBytes, {
          endpoint: options.delivery.endpoint,
          secret: options.delivery.secret,
          target: 'folder',
          route: { repo: '', branch: '', path: '', package: '' },
          onChange: false,
          onOpen: false,
        })
        postToUi({ type: 'DELIVERY_RESULT', ...result })
      } catch (err) {
        postToUi({ type: 'DELIVERY_ERROR', message: String((err as Error)?.message || err) })
      }
      break
    }
    case 'GENERATE_TYPOGRAPHY': {
      // @agent write: create typography variables and bind text styles to them
      try {
        const stored = await figma.clientStorage.getAsync('exportOptions')
        const report = await generateTypographyVariables(normalizeExportOptions(stored))
        figma.notify(`Created ${report.created} variables · bound ${report.bound} field(s)` + (report.failed ? ` · ${report.failed} failed` : ''))
        postToUi({ type: 'TYPOGRAPHY_GENERATED', report })
      } catch (err) {
        const message = String((err as Error)?.message || err)
        figma.notify('Generate failed: ' + message)
        postToUi({ type: 'TYPOGRAPHY_ERROR', message })
      }
      break
    }

    /* ---- DS Tools target ---- */
    case 'PREVIEW_PALETTE': {
      // @agent read: recompute a palette from settings — pure maths, nothing is written
      // @agent param settings: PaletteSettings — anything unrecognised is REPLACED BY DEFAULTS, silently: send {} and you get the plugin's own palette back, not an error
      // Pure math, so it answers immediately — the UI redraws its preview on every edit.
      const settings = normalizePaletteSettings(msg.settings)
      postToUi({ type: 'PALETTE_PREVIEW', palette: generatePalette(settings), settings })
      break
    }
    case 'SUGGEST_SPECTRUM': {
      // @agent read: suggest a harmonious spectrum for the current settings
      // @agent param settings: PaletteSettings — unrecognised input is replaced by defaults rather than refused
      const settings = normalizePaletteSettings(msg.settings)
      postToUi({ type: 'SPECTRUM_SUGGESTED', spectrum: suggestHarmoniousSpectrum(settings) })
      break
    }
    case 'FIX_PALETTE': {
      // @agent write: apply one palette fix and store the corrected settings
      // @agent param settings: PaletteSettings — unrecognised input is replaced by defaults rather than refused
      const fix = normalizePaletteFix(msg.fix)
      if (!fix) {
        refuse(
          'FIX_PALETTE',
          'fix must be { kind: "anchor-step", spectrumId, step } or { kind: "reset-steps" | "rename-duplicates" | "split-dark-theme" }'
        )
        break
      }
      const settings = applyPaletteFix(normalizePaletteSettings(msg.settings), fix)
      await figma.clientStorage.setAsync('paletteSettings', settings)
      // Unlike a preview, this one carries settings the UI must adopt — the fix changed them.
      postToUi({ type: 'PALETTE_FIXED', palette: generatePalette(settings), settings })
      break
    }
    case 'SAVE_PALETTE_SETTINGS': {
      // @agent write: store palette settings in clientStorage
      // @agent param settings: PaletteSettings — unrecognised input is replaced by defaults rather than refused
      await figma.clientStorage.setAsync('paletteSettings', normalizePaletteSettings(msg.settings))
      break
    }
    case 'APPLY_PALETTE': {
      // @agent write: write a generated palette into the document as variables, theme roles and swatches
      // @agent param settings: PaletteSettings — unrecognised input is replaced by defaults rather than refused; check what PREVIEW_PALETTE answers before writing
      try {
        const settings = normalizePaletteSettings(msg.settings)
        if (settings.spectra.length === 0) {
          throw new Error('the palette is empty — add at least one color before generating')
        }
        const options: PaletteApplyOptions = { ...DEFAULT_APPLY_OPTIONS, ...(msg.applyOptions ?? {}) }
        const report = await applyPalette(generatePalette(settings), options)
        await figma.clientStorage.setAsync('paletteSettings', settings)
        const parts: string[] = []
        if (options.variables) parts.push(`${report.created} new · ${report.updated} updated variables`)
        if (report.themeRoles) parts.push(`${report.themeRoles} theme roles`)
        if (report.swatches) parts.push(`${report.swatches} swatches`)
        figma.notify(parts.join(' · ') || 'Nothing selected to generate')
        postToUi({ type: 'PALETTE_APPLIED', report })
      } catch (err) {
        const message = String((err as Error)?.message || err)
        figma.notify('Palette failed: ' + message)
        postToUi({ type: 'PALETTE_ERROR', message })
      }
      break
    }

    /* ---- DS Tools: color token remapping ---- */
    case 'REMAP_SCAN': {
      // @agent read: inventory every colour in the document — variables, styles, gradient stops, loose paints
      // @agent cost: one walk of the whole document — 12s over 200k nodes. The reading is then reused by every preview until a write invalidates it.
      try {
        const inventory = await readInventory(msg.depth ?? 'document')
        postToUi({
          type: 'REMAP_INVENTORY',
          stats: inventory.stats,
          modes: inventory.modes,
          sites: inventory.sites.length,
          adjacency: inventory.adjacency.length,
          warnings: inventory.warnings,
          canRevert: hasRemapSnapshot(),
          canRevertRebind: hasRebindSnapshot(),
          inventory: inventoryStamp(),
        })
      } catch (err) {
        postToUi({ type: 'REMAP_ERROR', message: String((err as Error)?.message || err) })
      }
      break
    }
    case 'REMAP_LIST_LIBRARIES': {
      // @agent read: list the published library collections a new palette could be read from
      const result = await listLibraryCollections()
      postToUi({ type: 'REMAP_LIBRARIES', collections: result.collections, warnings: result.warnings })
      break
    }
    case 'REMAP_PREVIEW': {
      // @agent read: build the old-to-new colour mapping and return the table, structurally matched
      try {
        const { plan, palette } = await planRemap(msg.source, msg.options, msg.overrides, msg.excluded)
        postToUi({
          type: 'REMAP_PLAN',
          ...remapPlanView(plan),
          paletteSize: palette.length,
          inventory: inventoryStamp(),
        })
      } catch (err) {
        postToUi({ type: 'REMAP_ERROR', message: String((err as Error)?.message || err) })
      }
      break
    }
    case 'REMAP_APPLY': {
      // @agent write: write the mapping into the document (values, renames, styles, canvas paints) behind an undo snapshot
      try {
        const { plan } = await planRemap(msg.source, msg.options, msg.overrides, msg.excluded)
        const options: RemapApplyOptions = { ...DEFAULT_REMAP_APPLY_OPTIONS, ...(msg.applyOptions ?? {}) }
        // Measured before the write, from the plan and the pairs the walk already found —
        // afterwards the old colors are gone and there is nothing left to compare against.
        const audit = remapInventory ? auditContrast(plan, remapInventory.adjacency) : { findings: [], checked: 0, improved: 0 }
        const report = await applyRemap(plan, options, (label) =>
          postToUi({ type: 'REMAP_PROGRESS', label })
        )
        // The document moved under the cached reading: usage counts and adjacency still hold,
        // but every value did not, so the next preview must scan again. A palette read off the
        // canvas is stale for the same reason; one read from a library or a paste is not.
        remapInventory = null
        figma.notify(
          [
            report.values ? `${report.values} values` : '',
            report.renamed ? `${report.renamed} renamed` : '',
            report.legacy ? `${report.legacy} parked in legacy/` : '',
          ]
            .filter(Boolean)
            .join(' · ') || 'Nothing to write'
        )
        postToUi({
          type: 'REMAP_APPLIED',
          report,
          audit: {
            checked: audit.checked,
            improved: audit.improved,
            findings: audit.findings.slice(0, 30).map(describeContrast),
            total: audit.findings.length,
          },
          canRevert: hasRemapSnapshot(),
        })
      } catch (err) {
        const message = String((err as Error)?.message || err)
        figma.notify('Remap failed: ' + message, { error: true })
        postToUi({ type: 'REMAP_ERROR', message })
      }
      break
    }
    case 'REMAP_REVERT': {
      // @agent write: restore the values, names and paints the last remap replaced
      try {
        const report = await revertRemap((label) => postToUi({ type: 'REMAP_PROGRESS', label }))
        remapInventory = null
        figma.notify(`Reverted ${report.values} values` + (report.names ? ` and ${report.names} names` : ''))
        postToUi({ type: 'REMAP_REVERTED', report, canRevert: hasRemapSnapshot() })
      } catch (err) {
        postToUi({ type: 'REMAP_ERROR', message: String((err as Error)?.message || err) })
      }
      break
    }
    case 'REMAP_REBIND_PREVIEW':
      // A fall-through label has no body of its own, so its marker sits between the two, which
      // is exactly the span the extractor reads for it. The shared block below is the other's.
      // @agent read: count what a rebind onto the reference library would move — writes nothing
    case 'REMAP_REBIND_APPLY': {
      // @agent write: move the file's colour pointers onto the reference library
      try {
        if (msg.source.kind !== 'library') {
          throw new Error('rebinding needs the new palette read from a library — its variable keys are the destination')
        }
        const { plan } = await planRemap(msg.source, msg.options, msg.overrides, msg.excluded)
        const progress = (label: string) => postToUi({ type: 'REMAP_PROGRESS', label })
        const rebindOptions = { scope: msg.scope ?? 'document' }
        const report =
          msg.type === 'REMAP_REBIND_APPLY'
            ? await applyRebind(plan, rebindOptions, progress)
            : await previewRebind(plan, rebindOptions, progress)
        if (msg.type === 'REMAP_REBIND_APPLY') {
          // Bindings changed under the inventory's feet; the next Read starts clean.
          remapInventory = null
          figma.notify(`Rebound: ${report.summary}`)
        }
        postToUi({
          type: msg.type === 'REMAP_REBIND_APPLY' ? 'REMAP_REBOUND' : 'REMAP_REBIND_PLAN',
          counts: report.counts,
          summary: report.summary,
          warnings: report.warnings,
          canRevertRebind: hasRebindSnapshot(),
        })
      } catch (err) {
        postToUi({ type: 'REMAP_ERROR', message: String((err as Error)?.message || err) })
      }
      break
    }
    case 'REMAP_REBIND_REVERT': {
      // @agent write: undo the last rebind
      try {
        const report = await revertRebind((label) => postToUi({ type: 'REMAP_PROGRESS', label }))
        remapInventory = null
        figma.notify(`Rebind reverted: ${report.summary}`)
        postToUi({
          type: 'REMAP_REBIND_REVERTED',
          counts: report.counts,
          summary: report.summary,
          warnings: report.warnings,
          canRevertRebind: hasRebindSnapshot(),
        })
      } catch (err) {
        postToUi({ type: 'REMAP_ERROR', message: String((err as Error)?.message || err) })
      }
      break
    }
    case 'REMAP_BOARD': {
      // @agent write: draw the standardised old/new swatch board — from a palette, or from any mapping.json you supply
      // @agent param mapping: MappingFile — the mapping.json document REMAP_EXPORT_MAPPING writes; pass it instead of source to draw a correspondence computed anywhere
      try {
        // Two ways in, and they are not interchangeable: a palette makes the plugin compute the
        // correspondence with its own structural matcher, a mapping means somebody else already
        // did — an agent, a spreadsheet, a person — and the board is only the renderer. Naming
        // both would silently pick one.
        if ((msg.source === undefined) === (msg.mapping === undefined)) {
          throw new Error('pass either source (a palette to match against) or mapping (a mapping.json to draw), not both')
        }
        const fromMapping = msg.mapping !== undefined
        const plan = fromMapping
          ? planFromMappingFile(parseMappingFile(msg.mapping))
          : (await planRemap(msg.source!, msg.options, msg.overrides, msg.excluded)).plan
        postToUi({ type: 'REMAP_PROGRESS', label: 'drawing the board…' })
        const report = await drawRemapBoard(plan, { title: msg.title })
        figma.notify(report.rows ? `${report.section}: ${report.rows} pairs on this page` : `${report.section}: nothing moves`)
        postToUi({
          type: 'REMAP_BOARD_DRAWN',
          report,
          // A mapping-drawn board owes nothing to the inventory, and stamping it with a
          // leftover scan would be the exact confusion the stamp exists to prevent.
          ...(fromMapping ? { drawnFrom: 'mapping' } : { drawnFrom: 'palette', inventory: inventoryStamp() }),
        })
      } catch (err) {
        postToUi({ type: 'REMAP_ERROR', message: String((err as Error)?.message || err) })
      }
      break
    }
    case 'REMAP_UNPARK': {
      // @agent write: give back the names this plugin parked under legacy/
      try {
        const report = await unparkLegacyNames()
        remapInventory = null
        figma.notify(
          report.restored ? `Restored ${report.restored} name(s) from legacy/` : 'Nothing of this plugin’s to restore'
        )
        postToUi({ type: 'REMAP_UNPARKED', report })
      } catch (err) {
        postToUi({ type: 'REMAP_ERROR', message: String((err as Error)?.message || err) })
      }
      break
    }
    case 'REMAP_EXPORT_MAPPING': {
      // @agent read: serialise the mapping as mapping.json or .csv for the repository side
      try {
        const { plan } = await planRemap(msg.source, msg.options, msg.overrides, msg.excluded)
        const mapping = buildMappingFile(plan, { file: figma.root.name, palette: msg.source.kind })
        postToUi({
          type: 'REMAP_MAPPING',
          format: msg.format,
          name: msg.format === 'csv' ? 'mapping.csv' : 'mapping.json',
          content: msg.format === 'csv' ? toCsv(mapping) : JSON.stringify(mapping, null, 2),
        })
      } catch (err) {
        postToUi({ type: 'REMAP_ERROR', message: String((err as Error)?.message || err) })
      }
      break
    }

    case 'REMAP_REWRITE_FILES': {
      // @agent read: rewrite colours in supplied file contents off the same mapping — a pure transform
      // @agent param mode: names the theme when the mapping has several. WITHOUT IT a multi-theme mapping replaces nothing and says so only in warnings.
      try {
        const { plan } = await planRemap(msg.source, msg.options, msg.overrides, msg.excluded)
        const mapping = buildMappingFile(plan, { file: figma.root.name, palette: msg.source.kind })
        const settings = { snap: msg.snap ?? 2, byName: msg.byName ?? false, mode: msg.mode ?? null }

        let replaced = 0
        let untouched = 0
        const warnings = new Set<string>()
        const files = msg.files.map((file) => {
          const result = rewriteColors(file.text, mapping, settings)
          replaced += result.replacements.length
          untouched += result.untouched
          for (const warning of result.warnings) warnings.add(warning)
          return {
            name: file.name,
            text: result.text,
            changed: result.replacements.length,
            // Enough for a report a human reads, not the whole edit list for a big file.
            lines: result.replacements
              .slice(0, 40)
              .map((entry) => `${file.name}:${entry.line}:${entry.column}  ${entry.from} → ${entry.to}` +
                (entry.snapped ? '  [snapped]' : '') + (entry.via === 'name' ? '  [by name]' : '')),
          }
        })

        postToUi({
          type: 'REMAP_REWRITTEN',
          files,
          replaced,
          untouched,
          warnings: [...warnings],
        })
      } catch (err) {
        postToUi({ type: 'REMAP_ERROR', message: String((err as Error)?.message || err) })
      }
      break
    }

    /* ---- shared ---- */
    case 'READ_VARIABLES': {
      // @agent read: the raw variable snapshot: collections, modes, values, aliases
      // @agent cost: imports every variable of every enabled library one at a time — 80-90s on a large file. SCAN_TOKENS answers from the local graph in under a second.
      const data = await readAllVariables()
      postToUi({ type: 'VARIABLES_SNAPSHOT', data })
      break
    }
    case 'EMIT_TOKENS': {
      // @agent read: emit tokens.json / tokens.css / _tokens.scss from the current variables
      // @agent cost: same library import as READ_VARIABLES — 80-90s on a large file
      const [snapshot, stored] = await Promise.all([
        readAllVariables(),
        figma.clientStorage.getAsync('exportOptions'),
      ])
      const css = emitTokenArtifacts(snapshot, tokenEmitOptionsFrom(normalizeExportOptions(stored), readRenameMap())).css
      postToUi({ type: 'TOKENS_CSS', css })
      break
    }
    case 'SYNC_BREAKPOINT_FRAMES': {
      // @agent write: resize page frames whose names carry a breakpoint to that breakpoint width
      const snapshot = await readAllVariables()
      const breakpointTokens = extractBreakpointTokens(snapshot)
      const namedWidths = { desktop: 1280, tablet: 768, mobile: 375, ...Object.fromEntries(breakpointTokens) }
      let resized = 0
      for (const node of figma.currentPage.children) {
        if (node.type !== 'FRAME') continue
        const parsed = parseBreakpointName(node.name, namedWidths)
        if (!parsed) continue
        if (parsed.width !== node.width) {
          node.resize(parsed.width, node.height)
          resized++
        }
      }
      postToUi({ type: 'BREAKPOINT_FRAMES_SYNCED', resized, tokens: Object.fromEntries(breakpointTokens) })
      break
    }
    case 'GENERATE_BREAKPOINT_COLLECTION': {
      // @agent write: create the breakpoint variable collection
      try {
        const result = await generateBreakpointCollection(msg.breakpoints)
        postToUi({ type: 'BREAKPOINT_COLLECTION_GENERATED', ...result })
      } catch (err) {
        postToUi({
          type: 'BREAKPOINT_COLLECTION_ERROR',
          message: err instanceof Error ? err.message : String(err),
        })
      }
      break
    }

    /* ---- django target ---- */
    case 'EMIT_DJANGO': {
      // @agent read: render the scope as one Django template plus its CSS
      // @agent cost: reads the scope and every variable — 80s on a large file; narrow the scope to a frame
      const roots = rootsForScope(msg.scope)
      const [irNodes, sceneNodesById, snapshot] = await Promise.all([
        Promise.all(roots.map((root) => serializeNode(root))),
        indexSceneNodes(roots),
        readAllVariables(),
      ])
      const nodes = irNodes.filter((node): node is IrNode => node !== null)
      const variableNamesById = new Map(snapshot.variables.map((variable) => [variable.id, variable.name]))
      await annotateVectorLeaves(nodes, sceneNodesById as unknown as ReadonlyMap<string, AssetSourceNode>)
      const { html, css } = await emitDjango(nodes, sceneNodesById, variableNamesById, { cssFile: msg.cssFile })
      postToUi({ type: 'DJANGO_TEMPLATE', html, css })
      break
    }
    case 'EMIT_DJANGO_PROJECT': {
      // @agent read: render the scope as a multi-page Django project and plan the regeneration
      // @agent cost: reads the scope and every variable — 80s on a large file; narrow the scope to a frame
      const roots = rootsForScope(msg.scope)
      const [irNodes, sceneNodesById, snapshot] = await Promise.all([
        Promise.all(roots.map((root) => serializeNode(root))),
        indexSceneNodes(roots),
        readAllVariables(),
      ])
      const pageRoots = irNodes.filter((node): node is IrContainerNode => node !== null && node.type === 'container')
      const variableNamesById = new Map(snapshot.variables.map((variable) => [variable.id, variable.name]))
      await annotateVectorLeaves(pageRoots, sceneNodesById as unknown as ReadonlyMap<string, AssetSourceNode>)
      await addReactionDestinationsToScene(pageRoots, sceneNodesById)

      const previewOptions = normalizeExportOptions(await figma.clientStorage.getAsync('exportOptions'))
      const tokensOn = previewOptions.modules.tokens
      const previewThemeSets =
        previewOptions.targetOptions.framework === 'bootstrap' && previewOptions.targetOptions.bootstrapFidelity === 'theme'
          ? await collectThemableSets(sceneNodesById)
          : undefined
      const previewBreakpointTokens = extractBreakpointTokens(snapshot)
      const { baseHtml, pages, partials, css, interactionsCss, interactionsJs, themeCss, fileNodeIds } = await emitDjangoProject(
        pageRoots, sceneNodesById, variableNamesById,
        {
          cssFile: msg.cssFile,
          tokensCssFile: tokensOn ? 'css/tokens.css' : null,
          framework: frameworkLinksFrom(previewOptions, tokensOn),
          themeSets: previewThemeSets,
          breakpointTokens: previewBreakpointTokens,
        }
      )

      const freshFiles = new Map<string, FreshFile>(
        Object.entries({ 'base.html': baseHtml, ...pages, ...partials }).map(([path, content]) => [
          path, { nodeId: fileNodeIds[path], content },
        ])
      )
      const existingFiles = new Map(Object.entries(msg.existingFiles ?? {}))
      const plan = planRegeneration(existingFiles, freshFiles)

      let tokensCss: string | undefined
      let bootstrapTokensCss: string | undefined
      if (tokensOn) {
        const tokenEmitOptions = tokenEmitOptionsFrom(previewOptions, readRenameMap())
        const tokenArtifacts = emitTokenArtifacts(snapshot, tokenEmitOptions)
        tokensCss = tokenArtifacts.css
        if (previewOptions.targetOptions.framework === 'bootstrap') {
          const bootstrap = emitBootstrapArtifacts(
            tokenArtifacts.source,
            { ordered: tokenArtifacts.themes, defaultTheme: tokenArtifacts.defaultTheme },
            { themeAttribute: tokenEmitOptions.themeAttribute }
          )
          if (bootstrap.css) bootstrapTokensCss = bootstrap.css
        }
      }
      const staticFiles = buildRegenStaticFiles({ interactionsCss, interactionsJs, tokensCss, bootstrapTokensCss, themeCss })

      postToUi({ type: 'DJANGO_PROJECT_PLAN', css, cssFile: msg.cssFile, plan, staticFiles })
      break
    }
    case 'SCAN': {
      // @agent read: index the scope: frames, text nodes, lint findings, video assets
      const roots = rootsForScope(msg.scope)
      const index = await indexSceneNodes(roots)
      lastScanIndex = index

      const frames = figma.currentPage.children
        .filter((node): node is FrameNode => node.type === 'FRAME')
        .map((node) => ({ id: node.id, name: node.name }))
      const textNodes: Array<{ id: string; name: string; characters: string }> = []
      for (const node of index.values()) {
        if (node.type !== 'TEXT') continue
        textNodes.push({ id: node.id, name: node.name, characters: node.characters })
        if (textNodes.length % 200 === 0) await yieldToHost()
      }
      // The UI sends its live value to dodge the save/scan message race; stored options cover
      // scans triggered before the UI's options arrive (e.g. the relaunch path).
      const lintMaxDepth =
        typeof msg.lintMaxDepth === 'number'
          ? msg.lintMaxDepth
          : normalizeExportOptions(await figma.clientStorage.getAsync('exportOptions')).lint.maxNestingDepth
      const lint: LintFinding[] = await lintScopeAsync(roots, { maxNestingDepth: lintMaxDepth })
      await annotateUnfixableFindings(lint, index)

      const videoAssets: Array<{ nodeId: string; name: string; assetSrc: string }> = []
      for (const node of index.values()) {
        const fills = 'fills' in node ? node.fills : undefined
        if (Array.isArray(fills) && fills.some((f) => f.type === 'VIDEO' && f.visible !== false)) {
          videoAssets.push({ nodeId: node.id, name: node.name, assetSrc: `img/${videoFilename(node.id, node.name)}` })
        }
      }

      postToUi({ type: 'SCAN_RESULT', frames, textNodes, lint, nodeCount: index.size, videoAssets })
      postSelectionToUi()
      break
    }
    case 'SCAN_TOP': {
      // @agent read: the page top-level frames, cheaply
      const frames = figma.currentPage.children
        .filter((node): node is FrameNode => node.type === 'FRAME')
        .map((node) => ({ id: node.id, name: node.name }))
      postToUi({
        type: 'SCAN_TOP_RESULT',
        frames,
        topLevelCount: figma.currentPage.children.length,
        relaunch: isRelaunch,
      })
      postSelectionToUi()
      break
    }
    case 'SCROLL_INTO_VIEW': {
      // @agent read: scroll the designer to a node — viewport only, the document is untouched
      const node = lastScanIndex.get(msg.nodeId) ?? (await figma.getNodeByIdAsync(msg.nodeId))
      if (!node || !('visible' in node)) {
        refuse('SCROLL_INTO_VIEW', `no scene node with id ${msg.nodeId} — it may have been removed, or live on a page this session has not loaded`)
        break
      }
      const target = node as SceneNode
      figma.viewport.scrollAndZoomIntoView([target])
      try { figma.currentPage.selection = [target] } catch { /* stale */ }
      // Answers now: "the viewport moved" and "there was something to move to" are different
      // facts, and only one of them used to be observable — by looking at the screen.
      postToUi({ type: 'FOCUSED', nodeId: target.id, name: target.name, nodeType: target.type })
      break
    }
    case 'FIX_LINT': {
      // @agent write: apply the linter fixes named in findings
      figma.commitUndo()
      const total = msg.findings.length
      const results: LintFixResult[] = []
      const progress = (label?: string) =>
        postToUi({ type: 'LINT_FIX_PROGRESS', done: results.length, total, label })
      const ctx = await buildFixContext(progress)
      // The UI stays on "Fixing…" until LINT_FIX_RESULT arrives — post it no matter what, or a
      // single unexpected throw leaves the plugin visibly stuck forever.
      try {
        for (const request of msg.findings) {
          // An earlier fix in this batch may have removed the cached node (detachInstance mints
          // new ids; unwrap deletes wrappers) — a removed node throws on every property access.
          const cached = lastScanIndex.get(request.nodeId)
          const node =
            cached && !cached.removed
              ? cached
              : ((await figma.getNodeByIdAsync(request.nodeId).catch(() => null)) as SceneNode | null)
          if (!node || node.removed) {
            results.push({
              nodeId: request.nodeId,
              nodeName: request.nodeId,
              rule: request.rule,
              status: 'failed',
              detail: 'node no longer exists (an earlier fix may have replaced it) — re-scan the scope',
            })
          } else {
            results.push(await applyLintFix(node, request.rule, ctx))
          }
          progress()
          if (results.length % 10 === 0) await yieldToHost()
        }
      } finally {
        figma.commitUndo()
        postToUi({ type: 'LINT_FIX_RESULT', results })
      }
      break
    }
    case 'LOAD_ANNOTATION_PANEL': {
      // @agent read: read the annotation form state for one node
      // @agent param nodeId: a TEXT node, and one the last SCAN indexed — the index is per scan, not per document
      const node = lastScanIndex.get(msg.nodeId)
      // The index is built by SCAN, so this is the same "which reading am I on" question the
      // remap inventory answers — here the dependency was not even visible.
      if (!node) {
        refuse('LOAD_ANNOTATION_PANEL', `node ${msg.nodeId} is not in the last scan — run SCAN over the page that holds it first`)
        break
      }
      if (node.type !== 'TEXT') {
        refuse('LOAD_ANNOTATION_PANEL', `node ${msg.nodeId} is a ${node.type} — annotations live on TEXT nodes`)
        break
      }
      const resolved = await resolveKey(node)
      const form = loadAnnotationForm(node)
      const html = renderAnnotationPanel(form, {
        boundVariableName: resolved.source === 'variable' ? resolved.variableName : undefined,
      })
      postToUi({ type: 'ANNOTATION_PANEL', nodeId: msg.nodeId, html })
      break
    }
    case 'SET_ANNOTATION': {
      // @agent write: write a node's annotation: export settings, docs, interaction notes
      // @agent param nodeId: a TEXT node, and one the last SCAN indexed — the index is per scan, not per document
      const node = lastScanIndex.get(msg.nodeId)
      // A write that answers nothing is the worst of the three: silence here was
      // indistinguishable from a write that landed.
      if (!node) {
        refuse('SET_ANNOTATION', `node ${msg.nodeId} is not in the last scan — run SCAN over the page that holds it first; nothing was written`)
        break
      }
      if (node.type !== 'TEXT') {
        refuse('SET_ANNOTATION', `node ${msg.nodeId} is a ${node.type} — annotations live on TEXT nodes; nothing was written`)
        break
      }
      try {
        applyAnnotationForm(node, msg.form)
        postToUi({ type: 'ANNOTATION_SAVED', nodeId: msg.nodeId })
      } catch (error) {
        postToUi({
          type: 'ANNOTATION_ERROR',
          nodeId: msg.nodeId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      break
    }
    case 'AGENT_SET_GATES': {
      // @agent deny: the gates are the designer's switch — an agent must never set its own permissions
      const gates = setGates({ read: msg.read, write: msg.write })
      // Remembered on the way through rather than on a separate save: the gates the sandbox
      // actually holds are the only ones worth persisting.
      await rememberGates(gates)
      // The command table rides along with the op manifest: the skill is rendered in the UI,
      // and a channel that can drive the whole panel should say so in the document it hands
      // the agent rather than make it discover that by asking.
      postToUi({
        type: 'AGENT_GATES',
        ...gates,
        ops: agentManifest(),
        commands: UI_COMMANDS,
        file: figma.root.name,
        fileKey: figma.fileKey ?? null,
      })
      break
    }
    case 'AGENT_REQUEST': {
      // @agent deny: this is the channel itself; routing it through itself only recurses
      // Never throws: a rejected or failed op comes back as `{ ok: false, error }` so the
      // bridge can answer the waiting CLI instead of leaving it on a timeout.
      const response = await handleAgentRequest({ id: msg.id, op: msg.op, params: msg.params })
      postToUi({ type: 'AGENT_RESPONSE', ...response })
      break
    }
    case 'SAVE_EXPORT_OPTIONS': {
      // @agent write: store export options in clientStorage
      const stored = await figma.clientStorage.getAsync('exportOptions')
      await figma.clientStorage.setAsync('exportOptions', mergeExportOptions(stored, msg.options))
      break
    }
    case 'SAVE_USER_PRESET': {
      // @agent write: store a user preset in clientStorage
      const stored = normalizeUserPresets(await figma.clientStorage.getAsync('userPresets'))
      const updated = upsertUserPreset(stored, msg.label, msg.values)
      await figma.clientStorage.setAsync('userPresets', updated)
      postToUi({ type: 'USER_PRESETS', userPresets: updated })
      break
    }
    case 'DELETE_USER_PRESET': {
      // @agent write: delete a stored user preset
      const stored = normalizeUserPresets(await figma.clientStorage.getAsync('userPresets'))
      const updated = stored.filter((preset) => preset.id !== msg.id)
      await figma.clientStorage.setAsync('userPresets', updated)
      postToUi({ type: 'USER_PRESETS', userPresets: updated })
      break
    }
    /* ---- the generic canvas primitives ---- */
    case 'NODE_CREATE': {
      // @agent write: make nodes from a description — frames, text, shapes, sections, components, instances — nested
      // @agent param nodes: an array of { kind, of?, props?, children? }; kind is frame|text|rectangle|ellipse|line|section|component|instance|vector|svg|star|polygon
      // @agent param of: for kind "svg", the markup itself — Figma parses it and hands back a frame of real vector layers, which is how an icon arrives without anyone writing path data by hand
      // @agent param props: the same property vocabulary NODE_SET takes — name, geometry, layout, fill/stroke (a colour or {variable}), text, cornerRadius, constraints; on an instance also properties/swap/reset
      // @agent param of: for kind "instance", the component to make — the id or key COMPONENT_CATALOG gives you; a component SET answers with its default variant, which props.properties then configures
      // @agent cost: proportional to what you ask for; one call is one undo step for the designer
      try {
        const specs = Array.isArray(msg.nodes) ? msg.nodes : [msg.nodes]
        const problems: string[] = []
        const plans: CreatePlan[] = []
        for (const [index, spec] of specs.entries()) {
          const plan = planCreate(spec, `nodes[${index}]`, problems)
          if (plan) plans.push(plan)
        }
        // Read whole before anything is made: one bad grandchild should not leave half a card on
        // the canvas for someone to find later.
        if (problems.length > 0) {
          refuse('NODE_CREATE', `${problems.length} problem(s): ${problems.slice(0, 4).join(' · ')}`)
          break
        }

        const parent = msg.parent && msg.parent !== 'page' ? await figma.getNodeByIdAsync(msg.parent) : figma.currentPage
        if (!parent || !('appendChild' in parent)) {
          refuse('NODE_CREATE', `parent ${msg.parent ?? '(page)'} is not a container`)
          break
        }
        const dry = msg.dryRun === true
        const made = []
        const refused: Array<{ kind: string; error: string }> = []
        for (const plan of plans) {
          try {
            made.push(await createNode(plan, parent as BaseNode & ChildrenMixin, dry))
          } catch (error) {
            // The plan was read whole, but making can still fail — a component that will not
            // import, a font that is not there. Whatever was made before it is already on the
            // canvas, so the answer has to name both halves rather than throwing them away.
            refused.push({ kind: plan.kind, error: String((error as Error)?.message || error) })
          }
        }
        if (!dry) figma.commitUndo()

        const failed = made.reduce((total, node) => total + node.failed, 0) + refused.length
        figma.notify(dry ? `Would create ${made.length} node(s)` : `Created ${made.length} node(s)`)
        postToUi({
          type: 'NODES_CREATED',
          dryRun: dry,
          created: made.length,
          failed,
          nodes: made,
          ...(refused.length > 0 ? { refused } : {}),
        })
      } catch (error) {
        const message = String((error as Error)?.message || error)
        figma.notify('Create failed: ' + message, { error: true })
        postToUi({ type: 'CANVAS_ERROR', command: 'NODE_CREATE', message })
      }
      break
    }
    case 'NODE_SET': {
      // @agent write: set properties on existing nodes, in batch, with per-property before/after
      // @agent param nodes: an array of { node: "<id>", props: {…} } — the same vocabulary NODE_CREATE takes
      // @agent param props: the node vocabulary — geometry, layout, paints (colour, {variable}, {gradient}, {image}, {shader}, or a list of them), strokes and brushes, effects, text and its runs, styles, variable bindings, prototype links, grids, animation, paths. The whole list with a sentence on each is `plugin.vocabulary`, read out of the source so it cannot go stale
      // @agent param props: on an INSTANCE, properties: { Size: "Large", Label: "Continue" } sets component properties by their catalogue names, swap: "<id|key>" changes which component it is, reset: true drops every override first
      // @agent param props: links take on: click|hover|press|drag|timeout|keyDown|mouseEnter|mouseLeave|mouseUp|mouseDown, to: "<id>"|"back"|"close", as: NAVIGATE|SWAP|OVERLAY|SCROLL_TO|CHANGE_TO, animation: INSTANT|DISSOLVE|SMART_ANIMATE|PUSH_LEFT|MOVE_IN_TOP|…, easing: EASE_OUT|GENTLE|QUICK|BOUNCY|SLOW|… or bezier: [x1,y1,x2,y2] / spring: {mass,stiffness,damping}. Overlay position and background are read-only in Figma's API and cannot be set from here.
      // @agent param props: one link may also carry set: { variable, value } (a literal or { variable } to copy another), mode: { collection, mode } to switch a theme, and url — they run in that order before the navigation, so "remember they agreed and go on" is one interaction
      try {
        const rows = Array.isArray(msg.nodes) ? msg.nodes : [msg.nodes]
        const problems: string[] = []
        const planned: Array<{ id: string; steps: ReturnType<typeof planProps>['steps'] }> = []
        for (const [index, row] of rows.entries()) {
          if (typeof row !== 'object' || row === null) {
            problems.push(`nodes[${index}] must be { node, props }`)
            continue
          }
          const entry = row as { node?: unknown; props?: unknown }
          if (typeof entry.node !== 'string' || entry.node === '') {
            problems.push(`nodes[${index}].node must be a node id`)
            continue
          }
          const plan = planProps(entry.props, `nodes[${index}].props`)
          problems.push(...plan.problems)
          if (plan.steps.length === 0) problems.push(`nodes[${index}].props sets nothing`)
          planned.push({ id: entry.node, steps: plan.steps })
        }
        if (problems.length > 0) {
          refuse('NODE_SET', `${problems.length} problem(s): ${problems.slice(0, 4).join(' · ')}`)
          break
        }

        const dry = msg.dryRun === true
        const reports = []
        for (const entry of planned) {
          const node = await figma.getNodeByIdAsync(entry.id)
          if (!node || !('type' in node) || node.type === 'PAGE' || node.type === 'DOCUMENT') {
            reports.push({ node: entry.id, ok: false, error: 'no such scene node' })
            continue
          }
          const report = await applyProps(node as SceneNode, entry.steps, dry)
          reports.push({
            node: entry.id,
            name: (node as SceneNode).name,
            ok: report.failed === 0,
            applied: report.applied,
          })
        }
        if (!dry) figma.commitUndo()

        const failed = reports.filter((report) => !report.ok).length
        figma.notify(dry ? `Would change ${reports.length} node(s)` : `Changed ${reports.length - failed} node(s)`)
        postToUi({ type: 'NODES_SET', dryRun: dry, changed: reports.length - failed, failed, nodes: reports })
      } catch (error) {
        const message = String((error as Error)?.message || error)
        figma.notify('Change failed: ' + message, { error: true })
        postToUi({ type: 'CANVAS_ERROR', command: 'NODE_SET', message })
      }
      break
    }
    case 'NODE_QUERY': {
      // @agent read: find nodes by name and type, read one by id, or list what is inside another
      // @agent param types: Figma node types to keep, e.g. ["FRAME","TEXT"]; omitted means any
      // @agent param within: search inside this node's subtree instead of the whole page — how you reach the children of something you just made
      // @agent param props: true adds each node's readable properties — geometry, layout, paints, text, prototype links, this plugin's own data, and what an instance is
      // @agent param data: keep only nodes carrying this plugin data, e.g. { flow: "onboarding" } — how you find what an earlier call stamped
      try {
        const wantProps = msg.props === true
        const limit = Math.min(Math.max(msg.limit ?? 50, 1), 500)

        if (msg.nodeId) {
          const node = await figma.getNodeByIdAsync(msg.nodeId)
          if (!node || !('type' in node)) {
            refuse('NODE_QUERY', `no node with id ${msg.nodeId}`)
            break
          }
          postToUi({ type: 'NODES_FOUND', total: 1, nodes: [await describeNode(node as SceneNode, wantProps)] })
          break
        }

        // Inside one node, or across a page. Without the first, a caller could not reach the
        // children of a node it had just created — which is most of what a second call is for.
        let root: BaseNode
        if (msg.within) {
          const holder = await figma.getNodeByIdAsync(msg.within)
          if (!holder || !('children' in holder)) {
            refuse('NODE_QUERY', `no node with id ${msg.within}, or it cannot hold children`)
            break
          }
          root = holder
        } else {
          const page = msg.pageId ? await figma.getNodeByIdAsync(msg.pageId) : figma.currentPage
          if (!page || page.type !== 'PAGE') {
            refuse('NODE_QUERY', `no page with id ${msg.pageId}`)
            break
          }
          await (page as PageNode).loadAsync()
          root = page
        }
        const types = Array.isArray(msg.types) ? msg.types : null
        const wanted = typeof msg.name === 'string' ? msg.name.toLowerCase() : null
        // How a caller finds what it built last time: the stamp it left, not a name a designer
        // may since have changed.
        const stamped =
          msg.data && typeof msg.data === 'object' ? Object.entries(msg.data as Record<string, string>) : null
        const found: SceneNode[] = []
        await walkSceneNodes(root, (node) => {
          if (found.length >= limit) return
          if (types && !types.includes(node.type)) return
          if (wanted && !node.name.toLowerCase().includes(wanted)) return
          if (stamped && !stamped.every(([key, value]) => node.getPluginData(key) === value)) return
          found.push(node)
        })
        postToUi({
          type: 'NODES_FOUND',
          total: found.length,
          truncated: found.length >= limit,
          nodes: await Promise.all(found.map((node) => describeNode(node, wantProps))),
        })
      } catch (error) {
        postToUi({ type: 'CANVAS_ERROR', command: 'NODE_QUERY', message: String((error as Error)?.message || error) })
      }
      break
    }

    case 'COMPONENT_CATALOG': {
      // @agent read: what this file can build with — every local component and every library one it already uses — with variant options, descriptions and how often each is used
      // @agent param query: a name substring; omitted means everything
      // @agent param source: local, library or all (default all)
      // @agent param scope: page (default) or document — the page is what a caller building a flow is working on, and loading every page is the expensive half
      // @agent param usage: false skips the instance census — quicker, but then NO library component can be found, since Figma gives plugins no way to list a library's contents
      // @agent cost: the current page is quick; scope "document" loads every page first and can take a minute or more on a large file — the older components.list op times out at 180s doing that on Altery Mobile DS
      try {
        const catalog = await collectComponents({
          query: typeof msg.query === 'string' ? msg.query : undefined,
          source: msg.source,
          scope: msg.scope,
          usage: msg.usage,
          limit: msg.limit,
        })
        postToUi({ type: 'COMPONENTS_FOUND', ...catalog })
      } catch (error) {
        postToUi({
          type: 'CANVAS_ERROR',
          command: 'COMPONENT_CATALOG',
          message: String((error as Error)?.message || error),
        })
      }
      break
    }

    case 'NODE_CLONE': {
      // @agent write: copy nodes, and change the copies in the same call — the quickest way to a consistent screen is another screen
      // @agent param nodes: an array of { node: "<id>", props?: {…} }; the copy is made first and the props are applied to it, so props.name renames the copy and props.parent places it
      // @agent cost: a copy of everything inside the node; one call is one undo step
      try {
        const rows = Array.isArray(msg.nodes) ? msg.nodes : [msg.nodes]
        const problems: string[] = []
        const planned: Array<{ id: string; steps: ReturnType<typeof planProps>['steps'] }> = []
        for (const [index, row] of rows.entries()) {
          if (typeof row !== 'object' || row === null) {
            problems.push(`nodes[${index}] must be { node, props? }`)
            continue
          }
          const entry = row as { node?: unknown; props?: unknown }
          if (typeof entry.node !== 'string' || entry.node === '') {
            problems.push(`nodes[${index}].node must be a node id`)
            continue
          }
          const plan = planProps(entry.props, `nodes[${index}].props`)
          problems.push(...plan.problems)
          planned.push({ id: entry.node, steps: plan.steps })
        }
        if (problems.length > 0) {
          refuse('NODE_CLONE', `${problems.length} problem(s): ${problems.slice(0, 4).join(' · ')}`)
          break
        }

        const dry = msg.dryRun === true
        const reports = []
        for (const entry of planned) {
          const node = await figma.getNodeByIdAsync(entry.id)
          if (!node || !('type' in node) || node.type === 'PAGE' || node.type === 'DOCUMENT') {
            reports.push({ source: entry.id, ok: false, error: 'no such scene node' })
            continue
          }
          const source = node as SceneNode
          if (dry) {
            reports.push({ source: entry.id, name: source.name, type: source.type, ok: true, dryRun: true })
            continue
          }

          let copy: SceneNode
          try {
            copy = source.clone()
          } catch (error) {
            // A node inside an instance cannot be copied, among other refusals — one of them must
            // not cost the caller the copies that did work.
            reports.push({ source: entry.id, name: source.name, ok: false, error: String((error as Error)?.message || error) })
            continue
          }
          // `clone()` documents a parent of its own and does not always agree with where the
          // original lives, so the copy is placed explicitly: beside its source unless the caller
          // said otherwise, and stepped aside so it is not hidden exactly on top of it.
          const placedByCaller = entry.steps.some((step) => step.step === 'reparent' && step.parent !== '')
          const home = source.parent
          if (!placedByCaller && home && 'appendChild' in home) (home as BaseNode & ChildrenMixin).appendChild(copy)
          const movedByCaller = entry.steps.some(
            (step) => step.step === 'assign' && (step.property === 'x' || step.property === 'y')
          )
          const laidOut = copy.parent !== null && 'layoutMode' in copy.parent && copy.parent.layoutMode !== 'NONE'
          if (!placedByCaller && !movedByCaller && !laidOut) {
            copy.x = source.x + source.width + CLONE_GAP
            copy.y = source.y
          }

          const report = await applyProps(copy, entry.steps, false)
          reports.push({
            source: entry.id,
            node: copy.id,
            name: copy.name,
            parent: copy.parent ? { id: copy.parent.id, name: copy.parent.name } : null,
            ok: report.failed === 0,
            applied: report.applied,
          })
        }
        if (!dry) figma.commitUndo()

        const failed = reports.filter((report) => !report.ok).length
        figma.notify(dry ? `Would copy ${reports.length} node(s)` : `Copied ${reports.length - failed} node(s)`)
        postToUi({ type: 'NODES_CLONED', dryRun: dry, copied: reports.length - failed, failed, nodes: reports })
      } catch (error) {
        const message = String((error as Error)?.message || error)
        figma.notify('Copy failed: ' + message, { error: true })
        postToUi({ type: 'CANVAS_ERROR', command: 'NODE_CLONE', message })
      }
      break
    }
    case 'NODE_GROUP': {
      // @agent write: group, ungroup, or combine nodes with a boolean operation
      // @agent param nodes: the ids to combine — they must share one parent; for "ungroup", the single group to release
      // @agent param as: group (default), ungroup, union, subtract, intersect, exclude, flatten, outline — or repeat, which is Figma Draw's transform group
      // @agent param repeat: for as "repeat" — { type: LINEAR|RADIAL, count, offset, unit: RELATIVE|PIXELS, axis: HORIZONTAL|VERTICAL }. `offset` is a DISTANCE, not an angle: a radial repeat spaces its copies around the circle by itself and the offset pushes them out from the centre
      // @agent param props: applied to what comes out — the same vocabulary NODE_SET takes, so one call can group and name
      try {
        const ids = (Array.isArray(msg.nodes) ? msg.nodes : [msg.nodes]).map((id) => String(id))
        const as = typeof msg.as === 'string' ? msg.as.trim().toLowerCase() : 'group'
        if (!GROUPINGS.includes(as)) {
          refuse('NODE_GROUP', `as must be one of: ${GROUPINGS.join(', ')}`)
          break
        }
        const plan = planProps(msg.props, 'props')
        if (plan.problems.length > 0) {
          refuse('NODE_GROUP', plan.problems.join(' · '))
          break
        }

        const nodes: SceneNode[] = []
        let missing = ''
        for (const id of ids) {
          const node = await figma.getNodeByIdAsync(id)
          if (!node || !('parent' in node) || node.type === 'PAGE' || node.type === 'DOCUMENT') {
            missing = id
            break
          }
          nodes.push(node as SceneNode)
        }
        if (missing) {
          refuse('NODE_GROUP', `no such scene node: ${missing}`)
          break
        }
        if (nodes.length === 0) {
          refuse('NODE_GROUP', 'name at least one node')
          break
        }

        if (as === 'repeat') {
          // Figma Draw's transform group: one modifier per node, so a repeat is described once
          // and applied to each of them.
          const spec = (msg.repeat ?? {}) as Record<string, unknown>
          const radial = String(spec.type ?? 'LINEAR').toUpperCase() === 'RADIAL'
          const count = typeof spec.count === 'number' ? spec.count : 3
          if (!Number.isInteger(count) || count < 2) {
            refuse('NODE_GROUP', 'repeat.count must be a whole number of at least 2')
            break
          }
          // `offset` is a DISTANCE, for both kinds — a radial repeat spaces its copies around the
          // circle by itself, and the offset pushes them outward from the centre. Defaulting it
          // to 360/count read as "degrees" and flung eight petals across four thousand pixels.
          const offset = typeof spec.offset === 'number' ? spec.offset : radial ? 0 : 1
          const unit = String(spec.unit ?? (radial ? 'RELATIVE' : 'RELATIVE')).toUpperCase()
          if (unit !== 'RELATIVE' && unit !== 'PIXELS') {
            refuse('NODE_GROUP', 'repeat.unit must be RELATIVE or PIXELS')
            break
          }
          const axis = String(spec.axis ?? 'HORIZONTAL').toUpperCase()
          if (!radial && axis !== 'HORIZONTAL' && axis !== 'VERTICAL') {
            refuse('NODE_GROUP', 'repeat.axis must be HORIZONTAL or VERTICAL')
            break
          }
          const home = nodes[0].parent
          if (!home || !('appendChild' in home)) {
            refuse('NODE_GROUP', 'the nodes have nowhere to be grouped into')
            break
          }
          const modifier = radial
            ? { type: 'REPEAT' as const, repeatType: 'RADIAL' as const, count, unitType: unit, offset }
            : {
                type: 'REPEAT' as const,
                repeatType: 'LINEAR' as const,
                count,
                unitType: unit,
                offset,
                axis: axis as 'HORIZONTAL' | 'VERTICAL',
              }
          const group = figma.transformGroup(
            nodes,
            home as BaseNode & ChildrenMixin,
            (home as BaseNode & ChildrenMixin).children.length,
            nodes.map(() => modifier as TransformModifier)
          )
          const report = await applyProps(group, plan.steps, false)
          figma.commitUndo()
          figma.notify(`${radial ? 'Radial' : 'Linear'} repeat ×${count}`)
          postToUi({
            type: 'NODES_GROUPED',
            as,
            from: ids,
            node: { id: group.id, name: group.name, type: group.type },
            repeat: `${radial ? 'radial' : axis.toLowerCase()} ×${count} offset ${offset} ${unit.toLowerCase()}`,
            applied: report.applied,
            failed: report.failed,
          })
          break
        }

        if (as === 'outline') {
          // Per node, not a combine: a stroke becomes a filled shape of its own, which is what
          // an icon needs before anyone can recolour it as a fill.
          const outlined: Array<Record<string, unknown>> = []
          for (const node of nodes) {
            const holder = node as SceneNode & { outlineStroke?: () => VectorNode | null }
            if (typeof holder.outlineStroke !== 'function') {
              outlined.push({ node: node.id, ok: false, error: `a ${node.type} has no stroke to outline` })
              continue
            }
            const vector = holder.outlineStroke()
            if (!vector) {
              outlined.push({ node: node.id, name: node.name, ok: false, error: 'nothing to outline — the node has no stroke' })
              continue
            }
            if (plan.steps.length > 0) await applyProps(vector, plan.steps, false)
            outlined.push({ node: node.id, name: node.name, ok: true, outlined: vector.id })
          }
          figma.commitUndo()
          const wrong = outlined.filter((one) => one.ok === false).length
          figma.notify(wrong > 0 ? `${wrong} could not be outlined` : `Outlined ${outlined.length}`)
          postToUi({ type: 'NODES_GROUPED', as, failed: wrong, nodes: outlined })
          break
        }

        if (as === 'ungroup') {
          if (nodes.length !== 1) {
            refuse('NODE_GROUP', 'ungroup releases one group at a time')
            break
          }
          const released = figma.ungroup(nodes[0] as GroupNode)
          figma.commitUndo()
          figma.notify(`Released ${released.length} node(s)`)
          postToUi({
            type: 'NODES_GROUPED',
            as,
            released: released.map((node) => ({ id: node.id, name: node.name, type: node.type })),
          })
          break
        }

        // Figma will not combine nodes from two parents, and the error it gives says nothing
        // about which ones — so the check is here, where the ids are still in hand.
        const parent = nodes[0].parent
        if (!parent || nodes.some((node) => node.parent !== parent)) {
          refuse('NODE_GROUP', 'every node must sit in the same parent')
          break
        }
        const home = parent as BaseNode & ChildrenMixin

        let made: SceneNode
        switch (as) {
          case 'group':
            made = figma.group(nodes, home)
            break
          case 'flatten':
            made = figma.flatten(nodes, home)
            break
          case 'union':
            made = figma.union(nodes, home)
            break
          case 'subtract':
            made = figma.subtract(nodes, home)
            break
          case 'intersect':
            made = figma.intersect(nodes, home)
            break
          default:
            made = figma.exclude(nodes, home)
        }

        const report = await applyProps(made, plan.steps, false)
        figma.commitUndo()
        figma.notify(`${as[0].toUpperCase()}${as.slice(1)}: ${made.name}`)
        postToUi({
          type: 'NODES_GROUPED',
          as,
          from: ids,
          node: { id: made.id, name: made.name, type: made.type },
          applied: report.applied,
          failed: report.failed,
        })
      } catch (error) {
        const message = String((error as Error)?.message || error)
        figma.notify('Group failed: ' + message, { error: true })
        postToUi({ type: 'CANVAS_ERROR', command: 'NODE_GROUP', message })
      }
      break
    }
    case 'COMPONENT_MAKE': {
      // @agent write: turn nodes into components, or combine components into a variant set
      // @agent param nodes: ids, or { node: "<id>", name: "Size=L" } to name each one on the way — a variant set's axes ARE the components' names, so "Size=L, State=Default" is what makes Size and State
      // @agent param as: component (default — each node becomes its own component) or set (they are combined as variants, converting any that are not components yet)
      // @agent param props: applied to what comes out, the same vocabulary NODE_SET takes
      try {
        const rows = Array.isArray(msg.nodes) ? msg.nodes : [msg.nodes]
        const as = typeof msg.as === 'string' ? msg.as.trim().toLowerCase() : 'component'
        if (as !== 'component' && as !== 'set') {
          refuse('COMPONENT_MAKE', 'as must be "component" or "set"')
          break
        }
        const plan = planProps(msg.props, 'props')
        if (plan.problems.length > 0) {
          refuse('COMPONENT_MAKE', plan.problems.join(' · '))
          break
        }

        const wanted: Array<{ id: string; name?: string }> = []
        for (const [index, row] of rows.entries()) {
          if (typeof row === 'string') {
            wanted.push({ id: row })
            continue
          }
          const entry = row as { node?: unknown; name?: unknown }
          if (typeof entry?.node !== 'string') {
            refuse('COMPONENT_MAKE', `nodes[${index}] must be an id or { node, name }`)
            wanted.length = 0
            break
          }
          wanted.push({ id: entry.node, ...(typeof entry.name === 'string' ? { name: entry.name } : {}) })
        }
        if (wanted.length === 0) break

        const made: ComponentNode[] = []
        const reports: Array<Record<string, unknown>> = []
        for (const entry of wanted) {
          const node = await figma.getNodeByIdAsync(entry.id)
          if (!node || !('type' in node) || node.type === 'PAGE' || node.type === 'DOCUMENT') {
            reports.push({ source: entry.id, ok: false, error: 'no such scene node' })
            continue
          }
          try {
            // Already a component: taken as it is, so "combine these three" works whether they
            // were components already or three frames a moment ago.
            const component =
              node.type === 'COMPONENT' ? node : figma.createComponentFromNode(node as SceneNode)
            if (entry.name) component.name = entry.name
            made.push(component)
            reports.push({ source: entry.id, node: component.id, name: component.name, ok: true })
          } catch (error) {
            reports.push({ source: entry.id, ok: false, error: String((error as Error)?.message || error) })
          }
        }

        let set: ComponentSetNode | null = null
        if (as === 'set') {
          if (made.length < 2) {
            refuse('COMPONENT_MAKE', 'a variant set needs at least two components')
            break
          }
          const home = made[0].parent
          if (!home || !('appendChild' in home)) {
            refuse('COMPONENT_MAKE', 'the components have nowhere to be combined into')
            break
          }
          set = figma.combineAsVariants(made, home as BaseNode & ChildrenMixin)
        }

        const result = set ?? made[0]
        if (result) {
          if (typeof msg.name === 'string' && msg.name.trim() !== '') result.name = msg.name.trim()
          if (typeof msg.description === 'string') result.description = msg.description
        }
        const applied = result && plan.steps.length > 0 ? await applyProps(result, plan.steps, false) : null
        figma.commitUndo()

        const failed = reports.filter((report) => !report.ok).length
        figma.notify(set ? `Variant set: ${set.name}` : `${made.length} component(s)`)
        postToUi({
          type: 'COMPONENTS_MADE',
          as,
          made: made.length,
          failed,
          ...(set
            ? {
                set: {
                  id: set.id,
                  name: set.name,
                  key: set.key,
                  properties: describeProperties(set),
                  variants: set.children.map((child) => child.name),
                },
              }
            : {}),
          nodes: reports,
          ...(applied ? { applied: applied.applied } : {}),
        })
      } catch (error) {
        const message = String((error as Error)?.message || error)
        figma.notify('Component failed: ' + message, { error: true })
        postToUi({ type: 'CANVAS_ERROR', command: 'COMPONENT_MAKE', message })
      }
      break
    }
    case 'COMPONENT_PROPERTY': {
      // @agent write: add, rename, retype or remove a component's properties — and bind them to the layers they drive
      // @agent param component: the COMPONENT or COMPONENT_SET to change
      // @agent param add: [{ name, type: BOOLEAN|TEXT|INSTANCE_SWAP|VARIANT|SLOT, default, bind?: ["<layer id>"], preferred?: ["<component id or key>"] }]
      // @agent param add: a SLOT takes no default and needs no binding — Figma creates its node and its property together, and settings: { minChildren, maxChildren, stretchChildOnInsert, displayEmptyByDefault, allowPreferredValuesOnly } configures what may go in it
      // @agent param bind: [{ node, property }] — pointing an existing property at another layer. WITHOUT a binding a property shows in the panel and changes nothing on the canvas, which is the usual reason one "does not work"
      try {
        const holder = await figma.getNodeByIdAsync(msg.component)
        if (!holder || (holder.type !== 'COMPONENT' && holder.type !== 'COMPONENT_SET')) {
          refuse('COMPONENT_PROPERTY', `${msg.component} is not a component or a component set`)
          break
        }
        const owner = holder as ComponentNode | ComponentSetNode
        const plan = planComponentProperties({ add: msg.add, edit: msg.edit, remove: msg.remove, bind: msg.bind })
        if (plan.problems.length > 0) {
          refuse('COMPONENT_PROPERTY', plan.problems.join(' · '))
          break
        }

        const done: Array<Record<string, unknown>> = []
        const bindings: Array<{ node: string; property: string; type: PropertyType }> = []

        for (const entry of plan.add) {
          try {
            let preferred: InstanceSwapPreferredValue[] | undefined
            if (entry.preferred) {
              preferred = []
              for (const ref of entry.preferred) {
                const component = await componentFor(ref)
                const parent = component.parent
                preferred.push(
                  parent?.type === 'COMPONENT_SET'
                    ? { type: 'COMPONENT_SET', key: (parent as ComponentSetNode).key }
                    : { type: 'COMPONENT', key: component.key }
                )
              }
            }
            let full: string
            if (entry.type === 'SLOT') {
              // A slot is not just a property: `createSlot` makes the node AND the property that
              // drives it, which is why there is nothing to bind afterwards. Only a component can
              // hold one — a set holds variants, and each of them has its own slots.
              if (owner.type !== 'COMPONENT') {
                throw new Error('a slot belongs to a component, not to a component set — add it to a variant')
              }
              const before = Object.keys(definitionsOf(owner))
              const slot = (owner as ComponentNode).createSlot()
              const made = Object.keys(definitionsOf(owner)).find((key) => !before.includes(key))
              if (!made) throw new Error('the slot was created but Figma reported no property for it')
              // Renamed rather than named, because `createSlot` chooses the name itself.
              full = owner.editComponentProperty(made, {
                name: entry.name,
                ...(entry.settings ? { slotSettings: entry.settings as SlotSettings } : {}),
                ...(preferred ? { preferredValues: preferred } : {}),
              })
              done.push({ added: full, type: entry.type, node: slot.id })
              continue
            }
            full = owner.addComponentProperty(
              entry.name,
              entry.type,
              entry.default as string | boolean,
              preferred ? { preferredValues: preferred } : undefined
            )
            done.push({ added: full, type: entry.type })
            for (const node of entry.bind ?? []) bindings.push({ node, property: full, type: entry.type })
          } catch (error) {
            done.push({ added: entry.name, ok: false, error: String((error as Error)?.message || error) })
          }
        }

        for (const entry of plan.edit) {
          try {
            const full = owner.editComponentProperty(entry.name, {
              ...(entry.rename ? { name: entry.rename } : {}),
              ...(entry.default === undefined ? {} : { defaultValue: entry.default }),
            })
            done.push({ edited: full })
          } catch (error) {
            done.push({ edited: entry.name, ok: false, error: String((error as Error)?.message || error) })
          }
        }

        for (const name of plan.remove) {
          try {
            owner.deleteComponentProperty(name)
            done.push({ removed: name })
          } catch (error) {
            done.push({ removed: name, ok: false, error: String((error as Error)?.message || error) })
          }
        }

        // Bindings named on their own carry no type, so the field comes from the definition.
        for (const entry of plan.bind) {
          const definitions = definitionsOf(owner)
          const key = Object.keys(definitions).find(
            (candidate) => candidate === entry.property || humanPropertyName(candidate) === entry.property
          )
          if (!key) {
            done.push({ bound: entry.property, ok: false, error: `no such property on ${owner.name}` })
            continue
          }
          bindings.push({ node: entry.node, property: key, type: definitions[key].type as PropertyType })
        }

        for (const entry of bindings) {
          const field = bindingField(entry.type)
          const node = await figma.getNodeByIdAsync(entry.node)
          if (!field) {
            done.push({ bound: entry.property, ok: false, error: 'a VARIANT property is not bound to a layer' })
            continue
          }
          if (!node || !('componentPropertyReferences' in node)) {
            done.push({ bound: entry.property, ok: false, error: `no such layer ${entry.node}` })
            continue
          }
          try {
            const layer = node as SceneNode
            layer.componentPropertyReferences = { ...(layer.componentPropertyReferences ?? {}), [field]: entry.property }
            done.push({ bound: entry.property, to: layer.name, drives: field })
          } catch (error) {
            done.push({ bound: entry.property, ok: false, error: String((error as Error)?.message || error) })
          }
        }

        figma.commitUndo()
        const failed = done.filter((one) => one.ok === false).length
        figma.notify(failed > 0 ? `${failed} of ${done.length} failed` : `${done.length} change(s)`)
        postToUi({
          type: 'COMPONENT_PROPERTIES',
          component: { id: owner.id, name: owner.name },
          failed,
          done,
          properties: describeProperties(owner),
        })
      } catch (error) {
        const message = String((error as Error)?.message || error)
        figma.notify('Property failed: ' + message, { error: true })
        postToUi({ type: 'CANVAS_ERROR', command: 'COMPONENT_PROPERTY', message })
      }
      break
    }
    case 'NODE_EXPORT': {
      // @agent read: render nodes to PNG, JPG, SVG or PDF and hand the files back — nothing in the document changes
      // @agent param nodes: the ids to render
      // @agent param format: PNG (default), JPG, SVG, PDF — or MP4, GIF, WEBM, which render the frame's ANIMATION rather than its appearance
      // @agent param scale: 1 by default; or give width or height instead and the other follows. A video takes a scale from 0.5, 0.75, 1, 1.5, 2, 3, 4 and nothing between
      // @agent param fps: video only — MP4 and WEBM take 12, 24, 30 or 60; GIF takes 8, 12, 15, 24 or 30
      // @agent param quality: MP4 and WEBM only — LOW, MEDIUM or HIGH
      // @agent param loop: GIF only — how many times it repeats; 0 is forever
      // @agent cost: one render each, and a large frame at 4x is megabytes — the call stops at 12 MB and says what it did not render. A video costs far more than a picture: it renders every frame of the animation
      try {
        const ids = (Array.isArray(msg.nodes) ? msg.nodes : [msg.nodes]).map((id) => String(id))
        const format = (typeof msg.format === 'string' ? msg.format : 'PNG').trim().toUpperCase()
        if (!EXPORT_FORMATS.includes(format)) {
          refuse('NODE_EXPORT', `format must be one of: ${EXPORT_FORMATS.join(', ')}`)
          break
        }

        const scale = typeof msg.scale === 'number' ? msg.scale : 1
        const video = VIDEO_FORMATS.includes(format)
        if (video && typeof msg.width !== 'number' && typeof msg.height !== 'number' && !VIDEO_SCALES.includes(scale)) {
          refuse('NODE_EXPORT', `a ${format} takes a scale of ${VIDEO_SCALES.join(', ')} — ${scale} is not one of them`)
          break
        }
        const fps = msg.fps
        if (fps !== undefined && (!video || !VIDEO_FPS[format].includes(fps))) {
          refuse(
            'NODE_EXPORT',
            video ? `${format} takes ${VIDEO_FPS[format].join(', ')} frames a second` : 'fps belongs to a video format'
          )
          break
        }
        const quality = msg.quality
        if (quality !== undefined && (format === 'GIF' || !video || !['LOW', 'MEDIUM', 'HIGH'].includes(quality))) {
          refuse('NODE_EXPORT', 'quality is LOW, MEDIUM or HIGH, and belongs to MP4 or WEBM')
          break
        }
        if (msg.loop !== undefined && format !== 'GIF') {
          refuse('NODE_EXPORT', 'loop belongs to a GIF')
          break
        }

        const constraint: ExportSettingsConstraints =
          typeof msg.width === 'number'
            ? { type: 'WIDTH', value: msg.width }
            : typeof msg.height === 'number'
              ? { type: 'HEIGHT', value: msg.height }
              : { type: 'SCALE', value: scale }

        const files: unknown[] = []
        const reports: Array<Record<string, unknown>> = []
        const taken = new Set<string>()
        let spent = 0

        for (const id of ids) {
          const node = await figma.getNodeByIdAsync(id)
          if (!node || !('exportAsync' in node)) {
            reports.push({ node: id, ok: false, error: 'no such exportable node' })
            continue
          }
          const scene = node as SceneNode
          try {
            if (format === 'SVG') {
              const svg = await scene.exportAsync({ format: 'SVG_STRING', svgOutlineText: msg.outlineText !== false })
              spent += svg.length
              if (spent > EXPORT_BUDGET) {
                reports.push({ node: id, name: scene.name, ok: false, error: 'the 12 MB budget for this call was already spent' })
                continue
              }
              const name = exportName(scene.name, 'svg', taken)
              files.push(textFile(name, 'image/svg+xml', svg))
              reports.push({ node: id, name: scene.name, ok: true, file: name, bytes: svg.length })
              continue
            }
            // Each shape of settings goes to its own overload; TypeScript will not take a union
            // across them, and the alternative is one cast that hides all three.
            let bytes: Uint8Array
            if (video) {
              bytes = await scene.exportAsync({
                format,
                constraint,
                ...(fps === undefined ? {} : { fps }),
                ...(quality === undefined ? {} : { quality }),
                ...(msg.loop === undefined ? {} : { loopCount: msg.loop }),
              } as ExportSettingsMP4 | ExportSettingsGIF | ExportSettingsWEBM)
            } else if (format === 'PDF') {
              bytes = await scene.exportAsync({ format: 'PDF' })
            } else {
              bytes = await scene.exportAsync({ format: format as 'PNG' | 'JPG', constraint })
            }
            spent += bytes.length
            if (spent > EXPORT_BUDGET) {
              reports.push({ node: id, name: scene.name, ok: false, error: 'the 12 MB budget for this call was already spent' })
              continue
            }
            const ext = format.toLowerCase()
            const name = exportName(scene.name, ext, taken)
            files.push(binaryFile(name, EXPORT_MIME[format], bytes))
            reports.push({ node: id, name: scene.name, ok: true, file: name, bytes: bytes.length })
          } catch (error) {
            reports.push({ node: id, name: scene.name, ok: false, error: String((error as Error)?.message || error) })
          }
        }

        postToUi({ type: 'NODES_EXPORTED', format, files, nodes: reports })
      } catch (error) {
        postToUi({ type: 'CANVAS_ERROR', command: 'NODE_EXPORT', message: String((error as Error)?.message || error) })
      }
      break
    }
    case 'MOTION_STYLES': {
      // @agent read: the animation styles Figma offers, with the settings each one takes — what you have to know before applying one
      try {
        const styles = figma.motion.figmaAnimationStyles().map((style) => ({
          styleId: style.styleId,
          name: style.name,
          ...(style.description ? { description: style.description } : {}),
          ...(style.props ? { props: style.props } : {}),
        }))
        postToUi({ type: 'MOTION_STYLES', total: styles.length, styles })
      } catch (error) {
        postToUi({ type: 'CANVAS_ERROR', command: 'MOTION_STYLES', message: String((error as Error)?.message || error) })
      }
      break
    }
    case 'SHADER_LIST': {
      // @agent read: the shaders this file can use — their ids, whether they paint or filter, and the settings each one takes
      // @agent param kind: fill or effect; omitted means both
      try {
        const kind = typeof msg.kind === 'string' ? msg.kind.trim().toLowerCase() : ''
        if (kind !== '' && kind !== 'fill' && kind !== 'effect') {
          refuse('SHADER_LIST', 'kind must be fill or effect')
          break
        }
        const shaders = (await figma.listAvailableShaders())
          .filter((shader) => kind === '' || shader.type === kind)
          .map((shader) => ({
            id: shader.id,
            name: shader.name,
            kind: shader.type,
            imported: shader.imported,
            // One line, like every other catalogue here: a property's own name, its type and
            // whatever it defaults to.
            properties: Object.entries(shader.propertyDefinitions ?? {})
              .map(([defId, definition]) => {
                const fallback =
                  definition.defaultValue === undefined
                    ? ''
                    : ` (=${typeof definition.defaultValue === 'object' ? JSON.stringify(definition.defaultValue) : definition.defaultValue})`
                return `${defId}: ${definition.type.toLowerCase()}${fallback}`
              })
              .join(' · '),
          }))
        postToUi({ type: 'SHADERS', total: shaders.length, shaders })
      } catch (error) {
        postToUi({ type: 'CANVAS_ERROR', command: 'SHADER_LIST', message: String((error as Error)?.message || error) })
      }
      break
    }
    case 'STYLE_LIST': {
      // @agent read: the file's own styles — paint, text, effect and grid — with what each one holds
      // @agent param kind: paint, text, effect or grid; omitted means all four
      // @agent param query: a name substring
      try {
        const kinds = typeof msg.kind === 'string' ? [msg.kind.trim().toLowerCase() as StyleKind] : [...STYLE_KINDS]
        const unknown = kinds.filter((kind) => !STYLE_KINDS.includes(kind))
        if (unknown.length > 0) {
          refuse('STYLE_LIST', `kind must be one of: ${STYLE_KINDS.join(', ')}`)
          break
        }
        const query = typeof msg.query === 'string' ? msg.query.trim().toLowerCase() : ''
        const limit = Math.min(Math.max(msg.limit ?? 100, 1), 500)

        const styles: Array<Record<string, unknown>> = []
        for (const kind of kinds) {
          for (const style of await localStyles(kind)) {
            if (query !== '' && !style.name.toLowerCase().includes(query)) continue
            styles.push({
              id: style.id,
              key: style.key,
              name: style.name,
              kind,
              holds: await describeStyle(style, describePaints, describeEffects, describeGrids),
              ...(style.description ? { description: style.description } : {}),
            })
          }
        }
        postToUi({
          type: 'STYLES',
          total: styles.length,
          truncated: styles.length > limit,
          styles: styles.slice(0, limit),
        })
      } catch (error) {
        postToUi({ type: 'CANVAS_ERROR', command: 'STYLE_LIST', message: String((error as Error)?.message || error) })
      }
      break
    }
    case 'STYLE_MAKE': {
      // @agent write: create a style, or update one of the same name
      // @agent param as: paint, text, effect or grid
      // @agent param from: read what the style should hold off this node — the usual way one is made, since the layer is already right
      // @agent param paints: for a paint style, the same fill vocabulary NODE_SET takes: "#RRGGBB", { variable }, { gradient }, { image }, or a list
      // @agent param text: for a text style, { fontName: { family, style }, fontSize, lineHeight?, letterSpacing?, textCase?, textDecoration? }
      // @agent param effects: for an effect style, the same effects vocabulary NODE_SET takes
      // @agent param grid: for a grid style, the same grid vocabulary NODE_SET takes — [{ columns: 12, gutter: 16, margin: 24 }]
      try {
          const kind = typeof msg.as === 'string' ? (msg.as.trim().toLowerCase() as StyleKind) : ('' as StyleKind)
        if (!STYLE_KINDS.includes(kind)) {
          refuse('STYLE_MAKE', `as must be one of: ${STYLE_KINDS.join(', ')}`)
          break
        }
        const name = typeof msg.name === 'string' ? msg.name.trim() : ''
        if (name === '') {
          refuse('STYLE_MAKE', 'name must be a non-empty string')
          break
        }

        // What the style should hold: from a node, or from the vocabulary.
        let source: SceneNode | null = null
        if (typeof msg.from === 'string') {
          const node = await figma.getNodeByIdAsync(msg.from)
          if (!node || !('type' in node)) {
            refuse('STYLE_MAKE', `no node with id ${msg.from}`)
            break
          }
          source = node as SceneNode
        }

        const existing = (await localStyles(kind)).find((style) => style.name === name) ?? null
        const style =
          existing ??
          (kind === 'paint'
            ? figma.createPaintStyle()
            : kind === 'text'
              ? figma.createTextStyle()
              : kind === 'effect'
                ? figma.createEffectStyle()
                : figma.createGridStyle())
        style.name = name
        if (typeof msg.description === 'string') style.description = msg.description

        if (kind === 'paint') {
          const paints = source
            ? ((source as unknown as { fills?: Paint[] }).fills ?? [])
            : (await applyToScratch(msg.paints, 'paints')).fills
          ;(style as PaintStyle).paints = paints as Paint[]
        } else if (kind === 'effect') {
          const effects = source
            ? ((source as unknown as { effects?: Effect[] }).effects ?? [])
            : (await applyToScratch(msg.effects, 'effects')).effects
          ;(style as EffectStyle).effects = effects as Effect[]
        } else if (kind === 'grid') {
          const grids = source
            ? ((source as unknown as { layoutGrids?: LayoutGrid[] }).layoutGrids ?? [])
            : (await applyToScratch(msg.grid, 'grid')).grids
          ;(style as GridStyle).layoutGrids = grids as LayoutGrid[]
        } else {
          const from = source?.type === 'TEXT' ? source : null
          if (!from && msg.text === undefined) {
            refuse('STYLE_MAKE', 'a text style needs `from` naming a TEXT node, or `text` describing it')
            break
          }
          const text = style as TextStyle
          if (from) {
            if (from.fontName === figma.mixed) {
              refuse('STYLE_MAKE', `${from.name} has more than one font — a style cannot hold mixed text`)
              break
            }
            await figma.loadFontAsync(from.fontName as FontName)
            text.fontName = from.fontName as FontName
            text.fontSize = from.fontSize as number
            text.lineHeight = from.lineHeight as LineHeight
            text.letterSpacing = from.letterSpacing as LetterSpacing
            text.textCase = from.textCase as TextCase
            text.textDecoration = from.textDecoration as TextDecoration
            // Mixed paragraph settings are possible on a node and impossible in a style, so
            // only a single value is carried over.
            if (typeof from.paragraphSpacing === 'number') text.paragraphSpacing = from.paragraphSpacing
            if (typeof from.paragraphIndent === 'number') text.paragraphIndent = from.paragraphIndent
          } else {
            const wanted = msg.text as Record<string, unknown>
            const font = wanted.fontName as FontName | undefined
            if (!font || typeof font.family !== 'string' || typeof font.style !== 'string') {
              refuse('STYLE_MAKE', 'text.fontName must be { family, style }')
              break
            }
            await figma.loadFontAsync(font)
            text.fontName = font
            if (typeof wanted.fontSize === 'number') text.fontSize = wanted.fontSize
            if (wanted.lineHeight !== undefined) {
              text.lineHeight =
                wanted.lineHeight === 'AUTO' ? { unit: 'AUTO' } : { value: wanted.lineHeight as number, unit: 'PIXELS' }
            }
            if (typeof wanted.letterSpacing === 'number') {
              text.letterSpacing = { value: wanted.letterSpacing, unit: 'PIXELS' }
            }
            if (typeof wanted.textCase === 'string') text.textCase = wanted.textCase as TextCase
            if (typeof wanted.textDecoration === 'string') text.textDecoration = wanted.textDecoration as TextDecoration
          }
        }

        figma.commitUndo()
        figma.notify(`${existing ? 'Updated' : 'Created'} style "${style.name}"`)
        postToUi({
          type: 'STYLE_MADE',
          updated: existing !== null,
          style: {
            id: style.id,
            key: style.key,
            name: style.name,
            kind,
            holds: await describeStyle(style, describePaints, describeEffects, describeGrids),
          },
        })
      } catch (error) {
        const message = String((error as Error)?.message || error)
        figma.notify('Style failed: ' + message, { error: true })
        postToUi({ type: 'CANVAS_ERROR', command: 'STYLE_MAKE', message })
      }
      break
    }
    case 'STYLE_REMOVE': {
      // @agent write: delete a local style. Layers that followed it keep the values it gave them
      // @agent param name: its name, id or key — the same way every other style is named here
      try {
        const kind = typeof msg.kind === 'string' ? (msg.kind.trim().toLowerCase() as StyleKind) : ('' as StyleKind)
        if (!STYLE_KINDS.includes(kind)) {
          refuse('STYLE_REMOVE', `kind must be one of: ${STYLE_KINDS.join(', ')}`)
          break
        }
        const style = await styleFor(String(msg.name), kind)
        if (style.remote) {
          refuse('STYLE_REMOVE', `"${style.name}" belongs to a library — it can only be removed where it is published`)
          break
        }
        const name = style.name
        style.remove()
        figma.commitUndo()
        figma.notify(`Removed style "${name}"`)
        postToUi({ type: 'STYLE_REMOVED', name, kind })
      } catch (error) {
        const message = String((error as Error)?.message || error)
        postToUi({ type: 'CANVAS_ERROR', command: 'STYLE_REMOVE', message })
      }
      break
    }
    case 'FLOW_LIST': {
      // @agent read: the prototype's starting points on a page — the named flows a designer sees in the Prototype panel
      try {
        const page = msg.pageId ? await figma.getNodeByIdAsync(msg.pageId) : figma.currentPage
        if (!page || page.type !== 'PAGE') {
          refuse('FLOW_LIST', `no page with id ${msg.pageId}`)
          break
        }
        await (page as PageNode).loadAsync()
        const flows = []
        for (const point of (page as PageNode).flowStartingPoints) {
          const node = await figma.getNodeByIdAsync(point.nodeId).catch(() => null)
          flows.push({ name: point.name, node: point.nodeId, frame: node?.name ?? '(missing)' })
        }
        postToUi({ type: 'FLOWS', page: { id: page.id, name: page.name }, flows })
      } catch (error) {
        postToUi({ type: 'CANVAS_ERROR', command: 'FLOW_LIST', message: String((error as Error)?.message || error) })
      }
      break
    }
    case 'FLOW_SET': {
      // @agent write: name the prototype's starting points on a page — this is what makes a set of frames read as "Onboarding" in the Prototype panel
      // @agent param flows: an array of { node: "<frame id>", name: "Onboarding" }, in order; the first is the one the play button opens. [] removes them all
      try {
        const rows = Array.isArray(msg.flows) ? msg.flows : null
        if (!rows) {
          refuse('FLOW_SET', 'flows must be an array of { node, name } — [] removes every starting point')
          break
        }
        const page = msg.pageId ? await figma.getNodeByIdAsync(msg.pageId) : figma.currentPage
        if (!page || page.type !== 'PAGE') {
          refuse('FLOW_SET', `no page with id ${msg.pageId}`)
          break
        }
        await (page as PageNode).loadAsync()

        const points: Array<{ nodeId: string; name: string }> = []
        const problems: string[] = []
        for (const [index, row] of rows.entries()) {
          const entry = row as { node?: unknown; name?: unknown }
          if (typeof entry?.node !== 'string' || typeof entry?.name !== 'string' || entry.name.trim() === '') {
            problems.push(`flows[${index}] must be { node: "<id>", name: "<flow name>" }`)
            continue
          }
          const node = await figma.getNodeByIdAsync(entry.node).catch(() => null)
          // Figma takes a starting point on anything and shows it on nothing: only a top-level
          // frame is a screen a prototype can open.
          if (!node || node.type !== 'FRAME' || node.parent?.type !== 'PAGE') {
            problems.push(`flows[${index}]: ${entry.node} is not a top-level frame on this page`)
            continue
          }
          points.push({ nodeId: entry.node, name: entry.name.trim() })
        }
        if (problems.length > 0) {
          refuse('FLOW_SET', problems.join(' · '))
          break
        }

        const before = (page as PageNode).flowStartingPoints.map((point) => point.name)
        ;(page as PageNode).flowStartingPoints = points
        figma.commitUndo()
        figma.notify(points.length === 0 ? 'Starting points cleared' : `${points.length} starting point(s)`)
        postToUi({
          type: 'FLOWS',
          page: { id: page.id, name: page.name },
          before,
          flows: points.map((point) => ({ name: point.name, node: point.nodeId })),
        })
      } catch (error) {
        postToUi({ type: 'CANVAS_ERROR', command: 'FLOW_SET', message: String((error as Error)?.message || error) })
      }
      break
    }
    case 'PAGE_LIST': {
      // @agent read: the pages of this file, and which one is open
      postToUi({
        type: 'PAGES',
        current: figma.currentPage.id,
        pages: figma.root.children.map((page) => ({
          id: page.id,
          name: page.name,
          current: page.id === figma.currentPage.id,
        })),
      })
      break
    }
    case 'PAGE_CREATE': {
      // @agent write: add a page — where a new flow goes
      // @agent param activate: true also opens it; left out, the designer's view does not move and NODE_CREATE reaches the new page through parent: "<id>"
      const name = typeof msg.name === 'string' ? msg.name.trim() : ''
      if (name === '') {
        refuse('PAGE_CREATE', 'name must be a non-empty string')
        break
      }
      const page = figma.createPage()
      page.name = name
      if (msg.activate === true) await figma.setCurrentPageAsync(page)
      figma.commitUndo()
      figma.notify(`Page "${page.name}" created`)
      postToUi({ type: 'PAGE_CREATED', page: { id: page.id, name: page.name }, current: figma.currentPage.id })
      break
    }

    /* ---- user modules ---- */
    case 'MODULES_LIST': {
      // @agent read: the installed user modules, what each may run, and why any of them is unusable
      postToUi({ type: 'MODULES', modules: describeModules(userModules), limitBytes: MODULE_SIZE_LIMIT })
      break
    }
    case 'MODULE_INSPECT': {
      // @agent read: what a module file would be and what it would be allowed to run — installs nothing
      // @agent param file: the module document, object or JSON text; nothing is stored either way
      const { module: parsed, problems } = parseUserModule(msg.file, UI_COMMANDS)
      if (!parsed) {
        postToUi({ type: 'MODULE_REJECTED', problems })
        break
      }
      const stored = await readStoredModules()
      postToUi({
        type: 'MODULE_INSPECTED',
        id: parsed.id,
        name: parsed.name,
        summary: parsed.summary,
        version: parsed.version,
        ...(parsed.author ? { author: parsed.author } : {}),
        screens: Object.keys(parsed.screens),
        commands: parsed.commands.map((command) => ({
          name: command.name,
          access: command.access,
          summary: command.summary,
          confirms: command.confirms,
        })),
        // Derived from the steps, so consent is given against what the module can actually do
        // rather than against what it says about itself.
        capabilities: moduleCapabilities(parsed, UI_COMMANDS),
        installed: parsed.id in stored,
        ...(stored[parsed.id] ? { installedVersion: versionOf(stored[parsed.id]) } : {}),
      })
      break
    }
    case 'MODULE_INSTALL': {
      // @agent write: validate a module file and install it — refused whole if anything in it does not check out
      // @agent param file: the module document itself (see TASK-user-modules.md), object or JSON text
      try {
        const size = JSON.stringify(msg.file ?? null).length
        if (size > MODULE_SIZE_LIMIT) {
          throw new Error(`the module is ${size} bytes; the limit is ${MODULE_SIZE_LIMIT}`)
        }
        // Validated on its own terms: which key it will be stored under is decided *by* the id
        // in the file, so checking the two against each other here — as the registry does for
        // what is already stored — would refuse every install.
        const { module: parsed, problems } = parseUserModule(msg.file, UI_COMMANDS)
        if (!parsed) {
          postToUi({ type: 'MODULE_REJECTED', problems })
          figma.notify(`Module refused: ${problems.length} problem(s)`, { error: true })
          break
        }

        const stored = await readStoredModules()
        const existing = stored[parsed.id]
        if (existing && msg.replace !== true) {
          // Replacing carries away whatever the old one kept, so it is asked for rather than
          // assumed — the version that is already there may be the one somebody is using.
          refuse('MODULE_INSTALL', `"${parsed.id}" is already installed — pass replace: true to overwrite it`)
          break
        }
        await writeStoredModules({
          ...stored,
          [parsed.id]: {
            file: msg.file,
            // An upgrade keeps what the old version stored; the module decides what to make of
            // fields it no longer declares.
            ...(existing?.state ? { state: existing.state } : {}),
            installedAt: new Date().toISOString(),
          },
        })
        figma.notify(`Installed "${parsed.name}"`)
        postToUi({
          type: 'MODULE_INSTALLED',
          id: parsed.id,
          replaced: Boolean(existing),
          capabilities: moduleCapabilities(parsed, UI_COMMANDS),
          modules: describeModules(userModules),
        })
      } catch (error) {
        const message = String((error as Error)?.message || error)
        figma.notify('Install failed: ' + message, { error: true })
        postToUi({ type: 'MODULE_ERROR', message })
      }
      break
    }
    case 'MODULE_REMOVE': {
      // @agent write: uninstall a module, and forget what it stored
      const stored = await readStoredModules()
      if (!(msg.id in stored)) {
        refuse('MODULE_REMOVE', `no module "${msg.id}" is installed`)
        break
      }
      const { [msg.id]: gone, ...rest } = stored
      await writeStoredModules(rest)
      figma.notify(`Removed "${msg.id}"`)
      postToUi({ type: 'MODULE_REMOVED', id: msg.id, modules: describeModules(userModules) })
      break
    }
    case 'MODULE_ENABLE': {
      // @agent write: switch a module on or off without uninstalling it
      const stored = await readStoredModules()
      const entry = stored[msg.id]
      if (!entry) {
        refuse('MODULE_ENABLE', `no module "${msg.id}" is installed`)
        break
      }
      await writeStoredModules({ ...stored, [msg.id]: { ...entry, disabled: msg.enabled === false } })
      postToUi({ type: 'MODULES', modules: describeModules(userModules), limitBytes: MODULE_SIZE_LIMIT })
      break
    }
    case 'MODULE_VIEW': {
      // @agent read: a module's screens as declared, with the values its fields currently hold
      const entry = userModules.find((candidate) => candidate.id === msg.id)
      if (!entry?.module) {
        refuse('MODULE_VIEW', `no usable module "${msg.id}" — MODULES_LIST says why`)
        break
      }
      // Both screens in one answer. A module's `settings` screen belongs in the panel's own
      // Settings sub-page — the same place every other target keeps its options — so the panel
      // needs both at once, and fetching them separately only invented an ordering problem.
      postToUi({
        type: 'MODULE_SCREEN',
        id: entry.id,
        name: entry.module.name,
        summary: entry.module.summary,
        screens: {
          main: entry.module.screens.main.blocks,
          ...(entry.module.screens.settings ? { settings: entry.module.screens.settings.blocks } : {}),
        },
        // Declared defaults, overlaid with whatever it has kept — what a field should show.
        state: moduleStateOf(entry),
      })
      break
    }
    case 'MODULE_STATE_SET': {
      // @agent write: set one field of a module's own state, checked against the type it declared
      const entry = userModules.find((candidate) => candidate.id === msg.id)
      const declared = entry?.module?.state[msg.field]
      if (!entry?.module || !declared) {
        refuse('MODULE_STATE_SET', `module "${msg.id}" declares no field "${msg.field}"`)
        break
      }
      if (typeof msg.value !== declared.type) {
        // The same rule the runner enforces on `set`: a declared type is a promise to whoever
        // renders the field and to whoever reads the storage next time.
        refuse('MODULE_STATE_SET', `"${msg.field}" is declared ${declared.type}, not ${typeof msg.value}`)
        break
      }
      const stored = await readStoredModules()
      const held = stored[msg.id]
      if (!held) {
        refuse('MODULE_STATE_SET', `module "${msg.id}" is not installed`)
        break
      }
      const state = { ...moduleStateOf(entry), [msg.field]: msg.value }
      await writeStoredModules({ ...stored, [msg.id]: { ...held, state } })
      postToUi({ type: 'MODULE_STATE', id: msg.id, state })
      break
    }
    case 'MODULE_RUN': {
      // @agent write: run one button of a module's screen — write-gated because the button may be
      // @agent param block: the index of the button in that screen's blocks, as MODULE_VIEW numbers them
      const entry = userModules.find((candidate) => candidate.id === msg.id)
      const screen = entry?.module?.screens[msg.screen]
      const block = screen?.blocks[msg.block]
      if (!entry?.module || !block) {
        refuse('MODULE_RUN', `no block ${msg.block} on the ${msg.screen} screen of "${msg.id}"`)
        break
      }
      if (block.block !== 'button') {
        refuse('MODULE_RUN', `block ${msg.block} is a ${block.block}, not a button`)
        break
      }
      try {
        // The steps are read from what is stored, never taken from the caller: the panel names
        // which button was pressed, and the sandbox decides what that means.
        const report = await runModuleCommand(
          entry.module,
          { name: `${entry.id}#${msg.screen}[${msg.block}]`, summary: block.label, params: [], steps: block.steps, access: 'write', confirms: block.steps.some((step) => 'confirm' in step) },
          {},
          {
            call: (message) => handleUiMessage(message as PluginMessage),
            record: async (work) => {
              const sink = beginRecording()
              try {
                await work()
              } finally {
                endRecording(sink)
              }
              return sink
            },
            confirmed: msg.confirm === true,
            state: moduleStateOf(entry),
          }
        )
        if (report.ok) {
          const stored = await readStoredModules()
          const held = stored[msg.id]
          if (held) await writeStoredModules({ ...stored, [msg.id]: { ...held, state: report.state } })
        }
        postToUi({ type: 'MODULE_RUN_REPORT', id: msg.id, screen: msg.screen, block: msg.block, report })
        if (report.error) figma.notify(`${block.label}: ${report.error}`, { error: true })
      } catch (error) {
        const message = String((error as Error)?.message || error)
        figma.notify(`${block.label} failed: ${message}`, { error: true })
        postToUi({ type: 'MODULE_ERROR', message })
      }
      break
    }
    case 'MODULE_EXPORT': {
      // @agent read: hand back a module's file exactly as it was installed, to save or pass on
      const stored = await readStoredModules()
      const entry = stored[msg.id]
      if (!entry) {
        refuse('MODULE_EXPORT', `no module "${msg.id}" is installed`)
        break
      }
      postToUi({
        type: 'MODULE_FILE',
        id: msg.id,
        // The object is for the panel, which receives this message whole and builds a download
        // from it. The text is for everyone else: a module is deeply nested by nature — steps
        // inside buttons inside screens — and the agent channel digests a reply structurally,
        // so an object handed over that way arrives with its steps summarised into
        // "nested too deep to quote" and cannot be installed anywhere. A long string does not
        // get summarised, it gets written to disk verbatim. Observed, not guessed: the first
        // export read back through the bridge would not re-validate.
        file: entry.file,
        json: JSON.stringify(entry.file, null, 1),
        state: entry.state ?? null,
      })
      break
    }

    case 'GENERATE_KIT': {
      // @agent write: draw the starter component kit onto the canvas
      try {
        const snapshot = await readAllVariables()
        const colorVariables = snapshot.variables
          .filter((variable) => variable.resolvedType === 'COLOR')
          .map((variable) => ({ id: variable.id, name: variable.name }))
        const report = await generateDesignKit(colorVariables)
        postToUi({ type: 'KIT_GENERATED', report })
        figma.notify(
          `Kit: ${report.components} components, ${report.variants} variants` +
            (report.slots > 0 ? `, ${report.slots} slots` : '') +
            (report.bound > 0 ? ` — ${report.bound} bound to tokens` : ' — no matching tokens, using defaults')
        )
      } catch (error) {
        postToUi({ type: 'KIT_ERROR', message: error instanceof Error ? error.message : String(error) })
      }
      break
    }
    case 'IMPORT_TRANSLATIONS': {
      // @agent write: write translated strings back into the text layers
      try {
        const roots = rootsForScope(msg.scope)
        const index = await indexSceneNodes(roots)
        const textNodes: TextNode[] = []
        for (const node of index.values()) if (node.type === 'TEXT') textNodes.push(node)
        const result = await importTranslations(msg.content, msg.format, textNodes)
        postToUi({
          type: 'IMPORT_TRANSLATIONS_RESULT',
          applied: result.applied.length,
          skipped: result.skipped.map((skip) => ({ reason: skip.reason, msgid: skip.entry.msgid })),
          overflows: result.overflows.map(({ nodeId, nodeName, expected, actual }) => ({ nodeId, nodeName, expected, actual })),
        })
        figma.notify(
          `Translations: ${result.applied.length} applied, ${result.skipped.length} skipped` +
            (result.overflows.length > 0 ? `, ${result.overflows.length} overflow(s)` : '')
        )
      } catch (error) {
        postToUi({
          type: 'IMPORT_TRANSLATIONS_ERROR',
          message: error instanceof Error ? error.message : String(error),
        })
      }
      break
    }
    case 'CONFIRM_EXPORT': {
      // @agent write: run the full export: builds every file, saves version history and relaunch data
      const { scope, modules, cssFile } = msg
      const roots = rootsForScope(scope)
      let stage = 'scan'
      try {
        postToUi({ type: 'EXPORT_PROGRESS', stage: 'scan', percent: 10 })
        const exportOptions = normalizeExportOptions(await figma.clientStorage.getAsync('exportOptions'))
        const [irNodes, sceneNodesById, snapshot] = await Promise.all([
          Promise.all(roots.map((root) => serializeNode(root))),
          indexSceneNodes(roots),
          readAllVariables(),
        ])
        const nodes = irNodes.filter((node): node is IrNode => node !== null)
        const pageRoots = nodes.filter((node): node is IrContainerNode => node.type === 'container')
        const variableNamesById = new Map(snapshot.variables.map((variable) => [variable.id, variable.name]))
        const motionExport = buildMotionExport(sceneNodesById, modules)
        if (modules.templates) await addReactionDestinationsToScene(pageRoots, sceneNodesById)

        stage = 'i18n'
        postToUi({ type: 'EXPORT_PROGRESS', stage: 'i18n', percent: 30 })
        const entries = modules.i18n ? await extractAllStrings(roots) : []

        stage = 'templates'
        postToUi({ type: 'EXPORT_PROGRESS', stage: 'templates', percent: 55 })
        const assetSourcesById = sceneNodesById as unknown as ReadonlyMap<string, AssetSourceNode>
        if (modules.templates) await annotateVectorLeaves(nodes, assetSourcesById)
        const videoBytesById = modules.templates ? await annotateVideoFills(nodes, assetSourcesById) : undefined
        const manualAssets = modules.templates ? collectManualAssets(nodes) : []
        if (manualAssets.length > 0) {
          figma.notify(
            `${manualAssets.length} video(s): Figma API can't export them — attach in the plugin panel, or Dev Mode (Shift+D) → Assets → Download`,
            { timeout: 8000 }
          )
        }
        const themeSets =
          modules.templates &&
          exportOptions.targetOptions.framework === 'bootstrap' &&
          exportOptions.targetOptions.bootstrapFidelity === 'theme'
            ? await collectThemableSets(sceneNodesById)
            : undefined
        const breakpointTokens = extractBreakpointTokens(snapshot)
        const [project, assets] = await Promise.all([
          modules.templates
            ? emitDjangoProject(pageRoots, sceneNodesById, variableNamesById, {
                cssFile,
                tokensCssFile: modules.tokens ? 'css/tokens.css' : null,
                animationLinks: motionExport.animationLinks,
                framework: frameworkLinksFrom(exportOptions, modules.tokens),
                themeSets,
                breakpointTokens,
              })
            : undefined,
          modules.templates ? collectExportAssets(nodes, assetSourcesById, (hash) => figma.getImageByHash(hash), videoBytesById) : [],
        ])

        stage = 'assets'
        postToUi({ type: 'EXPORT_PROGRESS', stage: 'assets', percent: 80 })
        const po = modules.i18n && entries.length > 0 ? emitPo(entries) : undefined

        const files: Record<string, ExportFileContent> = project
          ? buildExportTree({ project, tokensCss: '', cssFile, po, assets, animation: motionExport.animation })
          : {}
        if (!project) {
          for (const asset of assets) files[`static/img/${asset.filename}`] = asset.content
          if (po) files['locale/figma.po'] = po
        }
        delete files['static/css/tokens.css']
        // Kept in scope past the emit: DESIGN.md documents the variables that actually shipped
        // (and, for bootstrap, which `--bs-*` a token satisfied) — it must read the same artifacts.
        let tokenArtifacts: ReturnType<typeof emitTokenArtifacts> | undefined
        let bootstrapArtifacts: ReturnType<typeof emitBootstrapArtifacts> | undefined
        if (modules.tokens) {
          tokenArtifacts = emitTokenArtifacts(snapshot, tokenEmitOptionsFrom(exportOptions, readRenameMap()))
          files['static/css/tokens.css'] = tokenArtifacts.css
          if (exportOptions.tokens.emitJson) files['tokens.json'] = tokenArtifacts.json
          if (exportOptions.targetOptions.framework === 'bootstrap') {
            bootstrapArtifacts = emitBootstrapArtifacts(
              tokenArtifacts.source,
              { ordered: tokenArtifacts.themes, defaultTheme: tokenArtifacts.defaultTheme },
              { themeAttribute: tokenEmitOptionsFrom(exportOptions).themeAttribute }
            )
            if (bootstrapArtifacts.css) files['static/css/bootstrap-tokens.css'] = bootstrapArtifacts.css
            files['bootstrap.map.json'] = bootstrapArtifacts.mapJson
            if (exportOptions.tokens.emitScss && bootstrapArtifacts.scss) files['static/scss/_tokens.scss'] = bootstrapArtifacts.scss
          }
        }
        if (modules.animation) files['static/js/motion-tokens.js'] = emitMotionTokensJs(snapshot)
        if (!project && motionExport.animation.css) files['static/css/animations.css'] = motionExport.animation.css
        if (!project && motionExport.animation.js) files['static/js/animations.js'] = motionExport.animation.js

        // Tauri platform: the django emit above is the platform-neutral heavy lifting; here its
        // template subset renders to static HTML and the tree re-roots into the Tauri v2 vanilla
        // shape (src/ = frontendDist, src-tauri/ scaffold). Root docs (tokens.json, DESIGN.md
        // below, …) stay; the django-layout templates/ + static/ entries are replaced wholesale.
        let tauriPageHrefs: Record<string, string> | undefined
        if (exportOptions.targetOptions.platform === 'tauri' && project) {
          let startPageId: string | undefined
          try {
            startPageId = figma.currentPage.flowStartingPoints[0]?.nodeId
          } catch { /* older API surface */ }
          const startRootId =
            startPageId && pageRoots.some((root) => root.id === startPageId) ? startPageId : pageRoots[0]?.id
          const startScene = startRootId ? sceneNodesById.get(startRootId) : undefined
          const windowSize =
            startScene && 'width' in startScene
              ? { width: startScene.width, height: startScene.height }
              : { width: 1024, height: 768 }

          const bootstrapTokensCss = files['static/css/bootstrap-tokens.css']
          for (const key of Object.keys(files)) {
            if (key.startsWith('templates/') || key.startsWith('static/')) delete files[key]
          }
          const tauri = buildTauriExportTree({
            project,
            pageRoots,
            cssFile,
            tokensCss: modules.tokens && tokenArtifacts ? tokenArtifacts.css : null,
            animation: motionExport.animation,
            motionTokensJs: modules.animation ? emitMotionTokensJs(snapshot) : null,
            assets,
            productName: figma.root.name,
            startPageId,
            window: windowSize,
            bootstrapVersion:
              exportOptions.targetOptions.framework === 'bootstrap'
                ? exportOptions.targetOptions.bootstrapVersion
                : undefined,
            manualAssetNotes: manualAssets.map((asset) => asset.assetSrc),
          })
          Object.assign(files, tauri.files)
          tauriPageHrefs = tauri.pageHrefs
          if (typeof bootstrapTokensCss === 'string' && bootstrapTokensCss) {
            files['src/assets/css/bootstrap-tokens.css'] = bootstrapTokensCss
          }
        }

        const exportedAt = new Date().toISOString()

        // Component configuration (the designer's behaviour contract) for the components this
        // export actually shipped as partials. A description lives on the SET, so a variant child
        // resolves up to its parent — and duplicates collapse to one entry.
        let componentDocs: ComponentDoc[] = []
        if (exportOptions.docs.componentDocs && project) {
          const documentable = new Map<string, ComponentSetNode | ComponentNode>()
          for (const path of Object.keys(project.partials)) {
            const nodeId = project.fileNodeIds[path]
            const node = sceneNodesById.get(nodeId) ?? ((await figma.getNodeByIdAsync(nodeId).catch(() => null)) as SceneNode | null)
            if (!node) continue
            const owner =
              node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET'
                ? (node.parent as ComponentSetNode)
                : node.type === 'COMPONENT' || node.type === 'COMPONENT_SET'
                  ? (node as ComponentSetNode | ComponentNode)
                  : null
            if (owner && !documentable.has(owner.id)) documentable.set(owner.id, owner)
          }
          const collected = await collectComponentDocs(
            exportOptions.docs.componentPreviews,
            exportOptions.docs.previewBudgetMb,
            [...documentable.values()]
          )
          componentDocs = collected.docs
          for (const path of Object.keys(collected.files)) files[path] = collected.files[path]
          const componentsMd = buildComponentsMd(componentDocs, {
            fileName: figma.root.name,
            generatedAt: exportedAt,
            usage:
              exportOptions.targetOptions.platform === 'tauri'
                ? 'Each component below is rendered inline into the static `src/*.html` pages. ' +
                  'The markup is generated; the behaviour written here is NOT — implement it in your JS.'
                : 'Each component below ships as a `templates/components/…` partial. The markup is ' +
                  'generated; the behaviour written here is NOT — implement it in your view/JS.',
            // Resolve `Y300`/`glyph/tetriary` in the prose against the tokens this export shipped.
            tokens: tokenArtifacts
              ? buildTokenEntries(tokenArtifacts.emitted, tokenArtifacts.themes, tokenArtifacts.defaultTheme)
              : [],
          })
          if (componentsMd) files[COMPONENTS_FILE] = componentsMd
        }

        // DESIGN.md — the agent-facing contract for this package (docs the Django target ships).
        // Its guardrails come from a canvas audit; a lint failure must never sink the export, so
        // the section degrades to "audit unavailable" instead of throwing.
        let lintAudit: DjangoDesignMdInput['lint'] = null
        try {
          const findings = await lintScopeAsync(roots, { maxNestingDepth: exportOptions.lint.maxNestingDepth })
          const counts: Partial<Record<LintFinding['rule'], number>> = {}
          for (const finding of findings) counts[finding.rule] = (counts[finding.rule] ?? 0) + 1
          lintAudit = { counts, total: findings.length, nodeCount: sceneNodesById.size }
        } catch (error) {
          console.warn('[export] DESIGN.md canvas audit skipped', error)
        }

        files['DESIGN.md'] = buildDjangoDesignMd({
          fileName: figma.root.name,
          generatedAt: exportedAt,
          scope: scope.mode === 'frame' ? { mode: 'frame', frameId: scope.frameId } : { mode: scope.mode },
          modules,
          package: {
            // Tauri re-roots the tree: pages render to static src/*.html and partials inline
            // into them — DESIGN.md must describe the files that actually shipped.
            pages: tauriPageHrefs
              ? Object.values(tauriPageHrefs).map((href) => `src/${href}`)
              : project
                ? Object.keys(project.pages)
                : [],
            partials: project && !tauriPageHrefs ? Object.keys(project.partials) : [],
            cssFile: tauriPageHrefs ? `assets/${cssFile}` : cssFile,
            interactionsCss: Boolean(project?.interactionsCss),
            interactionsJs: Boolean(project?.interactionsJs),
            animationsCss: Boolean(motionExport.animation.css),
            animationsJs: Boolean(motionExport.animation.js),
            assetCount: assets.length,
            manualAssets: manualAssets.map((asset) => asset.assetSrc),
          },
          tokens: tokenArtifacts
            ? {
                tree: tokenArtifacts.emitted,
                themes: tokenArtifacts.themes,
                defaultTheme: tokenArtifacts.defaultTheme,
                themeAttribute: tokenEmitOptionsFrom(exportOptions).themeAttribute,
                audit: buildTokenAudit(snapshot as unknown as TokenGraph),
                emitJson: exportOptions.tokens.emitJson,
              }
            : undefined,
          bootstrap: bootstrapArtifacts
            ? {
                fidelity: exportOptions.targetOptions.bootstrapFidelity,
                source: exportOptions.targetOptions.bootstrapSource,
                version: exportOptions.targetOptions.bootstrapVersion,
                matched: bootstrapArtifacts.matched.map((match) => ({ bsVar: match.bsVar, slug: varName(match.leaf.path) })),
                unmatched: bootstrapArtifacts.unmatched,
                themeCss: Boolean(project?.themeCss),
              }
            : undefined,
          componentDocs,
          i18n: {
            entryCount: entries.length,
            sourceLanguage: exportOptions.i18n.sourceLanguage,
            wrapTranslate: exportOptions.i18n.wrapTranslate,
          },
          lint: lintAudit,
        })

        let exportedBy = 'unknown'
        let activeUserCount = 0
        try {
          exportedBy = figma.currentUser?.name ?? 'unknown'
          activeUserCount = figma.activeUsers.length
        } catch { /* permission not granted */ }
        files['export-report.json'] = buildExportReport({
          exportedAt,
          exportedBy,
          activeUserCount,
          scope,
          modules,
          fileCount: Object.keys(files).length,
          manualAssets: manualAssets.length > 0 ? manualAssets.map((a) => a.assetSrc) : undefined,
        })

        try { for (const root of roots) root.setRelaunchData({ reexport: '' }) } catch { /* dev build */ }
        try {
          await figma.saveVersionHistoryAsync(
            `${exportOptions.targetOptions.platform === 'tauri' ? 'Tauri' : 'Django'} export — ${new Date().toISOString()}`,
            `${Object.keys(files).length} file(s), scope: ${scope.mode}`
          )
        } catch (error) { console.warn('[export] saveVersionHistoryAsync skipped', error) }

        postToUi({ type: 'EXPORT_PROGRESS', stage: 'done', percent: 100 })
        postToUi({ type: 'FILES_READY', files, manualAssets })
      } catch (error) {
        console.error(`[export] failed during "${stage}"`, error)
        postToUi({
          type: 'EXPORT_ERROR',
          stage,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      break
    }
  }
}

figma.ui.onmessage = handleUiMessage

// The agent side of the same door. Registered from here rather than imported over there: the
// handler already imports the op registry, so the registry reaching back for the handler would
// be a cycle — and this way the channel can only run commands this build actually has.
setUiMessageRunner((message) => handleUiMessage(message as PluginMessage))
