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
import { findAllWithCriteria, yieldToHost } from './utils/tree'
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
import { buildDjangoDesignMd, buildTokenAudit, type DjangoDesignMdInput } from './targets/design-md/index'
import { buildComponentsMd, COMPONENTS_FILE, type ComponentDoc, type ComponentProperty } from './targets/design-md/component-docs'
import { buildTokenEntries } from './targets/design-md/model'
import { deliverPackage } from './delivery'
import { agentManifest, handleAgentRequest, setGates } from './agent/listener.ts'

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
  // Agent listener messages (see src/agent/, agent/README.md)
  | { type: 'AGENT_SET_GATES'; read: boolean; write: boolean }
  | { type: 'AGENT_REQUEST'; id: string; op: string; params?: unknown }

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
      figma.ui.postMessage({ type: 'COMPONENT_PREVIEW_PROGRESS', done: docs.length, total: targets.length })
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
  // The bridge URL and secret are setup and worth persisting; so is the answer a designer has
  // already given about this file. Re-asking on every open does not strengthen consent — it
  // trains the reflex to click through it — and the switches stay in the panel either way.
  const options = normalizeExportOptions(storedOptions)
  const remembered = await gatesFor()
  // Writes cannot outlive reads, the same rule the panel enforces, applied to what was stored
  // in case the two ever drift apart.
  options.agent = { ...options.agent, read: remembered.read, write: remembered.read && remembered.write }
  figma.ui.postMessage({
    type: 'EXPORT_OPTIONS',
    options,
    presets: EXPORT_PRESETS,
    userPresets: normalizeUserPresets(storedPresets),
  })
  const paletteSettings = normalizePaletteSettings(storedPalette)
  figma.ui.postMessage({
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
  figma.ui.postMessage({
    type: 'SELECTION_CHANGED',
    nodeId: node.id,
    isText: node.type === 'TEXT',
    topLevelFrameId: top.type === 'FRAME' ? top.id : null,
  })
}

figma.on('selectionchange', postSelectionToUi)

/* ------------------------------------------------------------------ message handler */

figma.ui.onmessage = async (msg: PluginMessage) => {
  switch (msg.type) {
    /* ---- design-tokens target ---- */
    case 'SCAN_TOKENS': {
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
        const artifacts = buildDesignTokens(graph, options, undefined, componentDocs.docs)
        for (const path of Object.keys(componentDocs.files)) artifacts.files[path] = componentDocs.files[path]
        artifacts.summary.componentCount = componentDocs.docs.length
        artifacts.summary.previewCount = Object.keys(componentDocs.files).length
        // Previews asked for but none produced is a silent failure otherwise — surface the reason.
        if (docsOptions.componentPreviews && Object.keys(componentDocs.files).length === 0) {
          const reason = componentDocs.docs.find((doc) => doc.previewError)?.previewError
          artifacts.summary.previewError = reason ?? 'no components found to capture'
        }
        figma.ui.postMessage({ type: 'TOKENS_RESULT', summary: artifacts.summary, files: artifacts.files, options })
      } catch (err) {
        figma.ui.postMessage({ type: 'TOKENS_ERROR', message: String((err as Error)?.message || err) })
      }
      break
    }
    case 'DELIVER': {
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
        figma.ui.postMessage({ type: 'DELIVERY_RESULT', ...result })
      } catch (err) {
        figma.ui.postMessage({ type: 'DELIVERY_ERROR', message: String((err as Error)?.message || err) })
      }
      break
    }
    case 'GENERATE_TYPOGRAPHY': {
      try {
        const stored = await figma.clientStorage.getAsync('exportOptions')
        const report = await generateTypographyVariables(normalizeExportOptions(stored))
        figma.notify(`Created ${report.created} variables · bound ${report.bound} field(s)` + (report.failed ? ` · ${report.failed} failed` : ''))
        figma.ui.postMessage({ type: 'TYPOGRAPHY_GENERATED', report })
      } catch (err) {
        const message = String((err as Error)?.message || err)
        figma.notify('Generate failed: ' + message)
        figma.ui.postMessage({ type: 'TYPOGRAPHY_ERROR', message })
      }
      break
    }

    /* ---- DS Tools target ---- */
    case 'PREVIEW_PALETTE': {
      // Pure math, so it answers immediately — the UI redraws its preview on every edit.
      const settings = normalizePaletteSettings(msg.settings)
      figma.ui.postMessage({ type: 'PALETTE_PREVIEW', palette: generatePalette(settings), settings })
      break
    }
    case 'SUGGEST_SPECTRUM': {
      const settings = normalizePaletteSettings(msg.settings)
      figma.ui.postMessage({ type: 'SPECTRUM_SUGGESTED', spectrum: suggestHarmoniousSpectrum(settings) })
      break
    }
    case 'FIX_PALETTE': {
      const fix = normalizePaletteFix(msg.fix)
      if (!fix) break
      const settings = applyPaletteFix(normalizePaletteSettings(msg.settings), fix)
      await figma.clientStorage.setAsync('paletteSettings', settings)
      // Unlike a preview, this one carries settings the UI must adopt — the fix changed them.
      figma.ui.postMessage({ type: 'PALETTE_FIXED', palette: generatePalette(settings), settings })
      break
    }
    case 'SAVE_PALETTE_SETTINGS': {
      await figma.clientStorage.setAsync('paletteSettings', normalizePaletteSettings(msg.settings))
      break
    }
    case 'APPLY_PALETTE': {
      try {
        const settings = normalizePaletteSettings(msg.settings)
        const options: PaletteApplyOptions = { ...DEFAULT_APPLY_OPTIONS, ...(msg.applyOptions ?? {}) }
        const report = await applyPalette(generatePalette(settings), options)
        await figma.clientStorage.setAsync('paletteSettings', settings)
        const parts: string[] = []
        if (options.variables) parts.push(`${report.created} new · ${report.updated} updated variables`)
        if (report.themeRoles) parts.push(`${report.themeRoles} theme roles`)
        if (report.swatches) parts.push(`${report.swatches} swatches`)
        figma.notify(parts.join(' · ') || 'Nothing selected to generate')
        figma.ui.postMessage({ type: 'PALETTE_APPLIED', report })
      } catch (err) {
        const message = String((err as Error)?.message || err)
        figma.notify('Palette failed: ' + message)
        figma.ui.postMessage({ type: 'PALETTE_ERROR', message })
      }
      break
    }

    /* ---- shared ---- */
    case 'READ_VARIABLES': {
      const data = await readAllVariables()
      figma.ui.postMessage({ type: 'VARIABLES_SNAPSHOT', data })
      break
    }
    case 'EMIT_TOKENS': {
      const [snapshot, stored] = await Promise.all([
        readAllVariables(),
        figma.clientStorage.getAsync('exportOptions'),
      ])
      const css = emitTokenArtifacts(snapshot, tokenEmitOptionsFrom(normalizeExportOptions(stored))).css
      figma.ui.postMessage({ type: 'TOKENS_CSS', css })
      break
    }
    case 'SYNC_BREAKPOINT_FRAMES': {
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
      figma.ui.postMessage({ type: 'BREAKPOINT_FRAMES_SYNCED', resized, tokens: Object.fromEntries(breakpointTokens) })
      break
    }
    case 'GENERATE_BREAKPOINT_COLLECTION': {
      try {
        const result = await generateBreakpointCollection(msg.breakpoints)
        figma.ui.postMessage({ type: 'BREAKPOINT_COLLECTION_GENERATED', ...result })
      } catch (err) {
        figma.ui.postMessage({
          type: 'BREAKPOINT_COLLECTION_ERROR',
          message: err instanceof Error ? err.message : String(err),
        })
      }
      break
    }

    /* ---- django target ---- */
    case 'EMIT_DJANGO': {
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
      figma.ui.postMessage({ type: 'DJANGO_TEMPLATE', html, css })
      break
    }
    case 'EMIT_DJANGO_PROJECT': {
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
        const tokenEmitOptions = tokenEmitOptionsFrom(previewOptions)
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

      figma.ui.postMessage({ type: 'DJANGO_PROJECT_PLAN', css, cssFile: msg.cssFile, plan, staticFiles })
      break
    }
    case 'SCAN': {
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

      figma.ui.postMessage({ type: 'SCAN_RESULT', frames, textNodes, lint, nodeCount: index.size, videoAssets })
      postSelectionToUi()
      break
    }
    case 'SCAN_TOP': {
      const frames = figma.currentPage.children
        .filter((node): node is FrameNode => node.type === 'FRAME')
        .map((node) => ({ id: node.id, name: node.name }))
      figma.ui.postMessage({
        type: 'SCAN_TOP_RESULT',
        frames,
        topLevelCount: figma.currentPage.children.length,
        relaunch: isRelaunch,
      })
      postSelectionToUi()
      break
    }
    case 'SCROLL_INTO_VIEW': {
      const node = lastScanIndex.get(msg.nodeId) ?? (await figma.getNodeByIdAsync(msg.nodeId))
      if (node && 'visible' in node) {
        const target = node as SceneNode
        figma.viewport.scrollAndZoomIntoView([target])
        try { figma.currentPage.selection = [target] } catch { /* stale */ }
      }
      break
    }
    case 'FIX_LINT': {
      figma.commitUndo()
      const total = msg.findings.length
      const results: LintFixResult[] = []
      const progress = (label?: string) =>
        figma.ui.postMessage({ type: 'LINT_FIX_PROGRESS', done: results.length, total, label })
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
        figma.ui.postMessage({ type: 'LINT_FIX_RESULT', results })
      }
      break
    }
    case 'LOAD_ANNOTATION_PANEL': {
      const node = lastScanIndex.get(msg.nodeId)
      if (!node || node.type !== 'TEXT') break
      const resolved = await resolveKey(node)
      const form = loadAnnotationForm(node)
      const html = renderAnnotationPanel(form, {
        boundVariableName: resolved.source === 'variable' ? resolved.variableName : undefined,
      })
      figma.ui.postMessage({ type: 'ANNOTATION_PANEL', nodeId: msg.nodeId, html })
      break
    }
    case 'SET_ANNOTATION': {
      const node = lastScanIndex.get(msg.nodeId)
      if (!node || node.type !== 'TEXT') break
      try {
        applyAnnotationForm(node, msg.form)
        figma.ui.postMessage({ type: 'ANNOTATION_SAVED', nodeId: msg.nodeId })
      } catch (error) {
        figma.ui.postMessage({
          type: 'ANNOTATION_ERROR',
          nodeId: msg.nodeId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      break
    }
    case 'AGENT_SET_GATES': {
      const gates = setGates({ read: msg.read, write: msg.write })
      // Remembered on the way through rather than on a separate save: the gates the sandbox
      // actually holds are the only ones worth persisting.
      await rememberGates(gates)
      figma.ui.postMessage({ type: 'AGENT_GATES', ...gates, ops: agentManifest(), file: figma.root.name, fileKey: figma.fileKey ?? null })
      break
    }
    case 'AGENT_REQUEST': {
      // Never throws: a rejected or failed op comes back as `{ ok: false, error }` so the
      // bridge can answer the waiting CLI instead of leaving it on a timeout.
      const response = await handleAgentRequest({ id: msg.id, op: msg.op, params: msg.params })
      figma.ui.postMessage({ type: 'AGENT_RESPONSE', ...response })
      break
    }
    case 'SAVE_EXPORT_OPTIONS': {
      const stored = await figma.clientStorage.getAsync('exportOptions')
      await figma.clientStorage.setAsync('exportOptions', mergeExportOptions(stored, msg.options))
      break
    }
    case 'SAVE_USER_PRESET': {
      const stored = normalizeUserPresets(await figma.clientStorage.getAsync('userPresets'))
      const updated = upsertUserPreset(stored, msg.label, msg.values)
      await figma.clientStorage.setAsync('userPresets', updated)
      figma.ui.postMessage({ type: 'USER_PRESETS', userPresets: updated })
      break
    }
    case 'DELETE_USER_PRESET': {
      const stored = normalizeUserPresets(await figma.clientStorage.getAsync('userPresets'))
      const updated = stored.filter((preset) => preset.id !== msg.id)
      await figma.clientStorage.setAsync('userPresets', updated)
      figma.ui.postMessage({ type: 'USER_PRESETS', userPresets: updated })
      break
    }
    case 'GENERATE_KIT': {
      try {
        const snapshot = await readAllVariables()
        const colorVariables = snapshot.variables
          .filter((variable) => variable.resolvedType === 'COLOR')
          .map((variable) => ({ id: variable.id, name: variable.name }))
        const report = await generateDesignKit(colorVariables)
        figma.ui.postMessage({ type: 'KIT_GENERATED', report })
        figma.notify(
          `Kit: ${report.components} components, ${report.variants} variants` +
            (report.slots > 0 ? `, ${report.slots} slots` : '') +
            (report.bound > 0 ? ` — ${report.bound} bound to tokens` : ' — no matching tokens, using defaults')
        )
      } catch (error) {
        figma.ui.postMessage({ type: 'KIT_ERROR', message: error instanceof Error ? error.message : String(error) })
      }
      break
    }
    case 'IMPORT_TRANSLATIONS': {
      try {
        const roots = rootsForScope(msg.scope)
        const index = await indexSceneNodes(roots)
        const textNodes: TextNode[] = []
        for (const node of index.values()) if (node.type === 'TEXT') textNodes.push(node)
        const result = await importTranslations(msg.content, msg.format, textNodes)
        figma.ui.postMessage({
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
        figma.ui.postMessage({
          type: 'IMPORT_TRANSLATIONS_ERROR',
          message: error instanceof Error ? error.message : String(error),
        })
      }
      break
    }
    case 'CONFIRM_EXPORT': {
      const { scope, modules, cssFile } = msg
      const roots = rootsForScope(scope)
      let stage = 'scan'
      try {
        figma.ui.postMessage({ type: 'EXPORT_PROGRESS', stage: 'scan', percent: 10 })
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
        figma.ui.postMessage({ type: 'EXPORT_PROGRESS', stage: 'i18n', percent: 30 })
        const entries = modules.i18n ? await extractAllStrings(roots) : []

        stage = 'templates'
        figma.ui.postMessage({ type: 'EXPORT_PROGRESS', stage: 'templates', percent: 55 })
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
        figma.ui.postMessage({ type: 'EXPORT_PROGRESS', stage: 'assets', percent: 80 })
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
          tokenArtifacts = emitTokenArtifacts(snapshot, tokenEmitOptionsFrom(exportOptions))
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

        figma.ui.postMessage({ type: 'EXPORT_PROGRESS', stage: 'done', percent: 100 })
        figma.ui.postMessage({ type: 'FILES_READY', files, manualAssets })
      } catch (error) {
        console.error(`[export] failed during "${stage}"`, error)
        figma.ui.postMessage({
          type: 'EXPORT_ERROR',
          stage,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      break
    }
  }
}
