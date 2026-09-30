/**
 * Shared settings/options — persisted across plugin sessions via figma.clientStorage.
 * Ported from allcrew-channel-django src/export/options.ts, extended with `target` field.
 */

/**
 * `ds-tools` and `agent` are pages rather than export targets — one generates variables and
 * canvas content instead of a package, the other is the agent listener's console. They ride
 * the same picker (and the same persisted field) so the plugin reopens on whichever page was
 * last used.
 */
import { isRecord } from './utils/type-guards.ts'

export type TargetId = 'design-tokens' | 'django' | 'ds-tools' | 'agent'

export interface ExportModulesOptions {
  tokens: boolean
  templates: boolean
  i18n: boolean
  animation: boolean
}

export type ExportPlatform = 'django' | 'tauri'
export type ExportFramework = 'none' | 'bootstrap'
export type BootstrapFidelity = 'tokens' | 'utilities' | 'components' | 'theme'
export type BootstrapSource = 'assume' | 'cdn' | 'vendored'

export interface ExportTargetOptions {
  platform: ExportPlatform
  framework: ExportFramework
  bootstrapFidelity: BootstrapFidelity
  bootstrapSource: BootstrapSource
  bootstrapVersion: string
  /** Ship the Django project itself (`manage.py`, settings/urls/views, the page registry and the
   * `navMap` context processor) alongside the templates, so the zip runs as an application instead
   * of waiting for someone to hand-write a URLconf. Off when the package is laid onto a project
   * that already has its own — `allcrew-channel apply` merges templates and static either way. */
  djangoScaffold: boolean
}

export interface ExportTokensOptions {
  inlinePrimitives: boolean
  flattenAliases: boolean
  themeAttribute: string
  emitJson: boolean
  emitScss: boolean
  emitModuleFiles: boolean
  cssModulesGlobal: boolean
  typoExtract: boolean
  typoScaleOnly: boolean
  typoShorthand: boolean
  typoNaming: 'tshirt' | 'value'
  /** Also emit the iOS asset catalogue, `res/values-night/colors.xml`, `Tokens.swift` and
   * `Tokens.kt` (see `tokens/native.ts`). Off by default: a palette becomes one colorset
   * directory per token, which is noise in a package a web project unzips. */
  emitNative: boolean
  /** Read the variables of every enabled LIBRARY as well as the local ones. Off by default
   * because it is a network call to Figma's team-library service - measured at 48 s on a file
   * with 213 library variables - and a file that owns its tokens needs none of it. On, it is the
   * only way a package contains a theme the file merely CONSUMES. */
  includeLibraries: boolean
  /** `Collection: role` pairs (`Mesure: spacing, Radii: radius`) — classifies a whole collection
   * for files where scoping the variables in Figma isn't practical. Parsed by
   * `parseCollectionRoles` (design-md/model.ts); unknown roles are ignored. */
  collectionRoles: string
}

export interface ExportI18nOptions {
  wrapTranslate: boolean
  sourceLanguage: string
  /** Target locales the site is built for, comma-separated (`ru, tr, es`) — the source language is
   * implied and never listed. Each one gets `locale/<code>/LC_MESSAGES/django.po` and a row in the
   * generated `LANGUAGES`; empty means a single-language site (no `i18n_patterns`, no switcher). */
  languages: string
}

export interface ExportDeliveryOptions {
  endpoint: string
  secret: string
  onExport: boolean
}

/** Agent listener — the plugin's inbound channel for CLI agents (see agent/README.md).
 * Like `delivery`, NOT package-forming: whether a designer is currently letting an agent read
 * the file is a session choice, not part of the design package's identity.
 *
 * Neither gate is ever persisted as on by a preset: a shared preset must not carry someone
 * else's permission. Remembering them per file in `clientStorage` is a different thing — that
 * is this designer's own answer about this file, not a setting that travels. */
export interface ExportAgentOptions {
  /** Bridge base URL, e.g. `http://127.0.0.1:8788`. Empty = listener unavailable. */
  endpoint: string
  /** Shared secret, must match the bridge's `ALLCREW_CHANNEL_AGENT_SECRET`. */
  secret: string
  /** Answer read-only ops (`document.info`, `page.frames`, `node.get`, ...). Remembered per
   * file: re-granting the same permission on every open teaches the reflex to click through
   * it, which is the opposite of consent. */
  read: boolean
  /** Answer mutating ops (`variables.set`, `node.bind`, `board.render`, ...). Remembered per
   * file like `read`, and never implied by it — reads off still forces writes off. */
  write: boolean
}

export interface UpdatePreferences {
  /** Automatic GitHub release discovery. Off by default: enabling it creates an outbound request. */
  automatic: boolean
  /** Successful check time, used to limit automatic discovery to once per 24 hours. */
  lastCheckedAt: number
  latestVersion: string
  releaseUrl: string
  downloadUrl: string
}

/** Linter knobs. Like `delivery`, NOT package-forming: a team's depth policy shouldn't flip the
 * preset selector to "Custom" or be overwritten by choosing a preset. */
export interface ExportLintOptions {
  /** `excessive-nesting` threshold — max node depth inside one exported template file. */
  maxNestingDepth: number
}

/** Component-documentation knobs. Like `lint`, NOT package-forming: whether a team wants preview
 * images is a workflow choice, not part of the design package's identity. */
export interface ExportDocsOptions {
  /** Ship `COMPONENTS.md` — descriptions, props and doc links from Component configuration. */
  componentDocs: boolean
  /** Also capture a PNG of every component master. Costs an `exportAsync` per component. */
  componentPreviews: boolean
  /** Megabytes of preview images one export may ship. `previews/` lands in the repository next to
   * DESIGN.md, so the ceiling is a repo-hygiene decision, not a technical one — hence a knob. */
  previewBudgetMb: number
}

export interface ThemeMergeModeOptions {
  collection: string
  name: string
}

export interface ThemeMergeGroupOptions {
  name: string
  modes: ThemeMergeModeOptions[]
}

/** Per-file interpretation of single-mode collections. Not package-forming: choosing a preset
 * must not forget how this Figma file stores its themes. */
export interface ExportThemeMergesOptions {
  groups: ThemeMergeGroupOptions[]
}

export interface ExportOptions {
  target: TargetId
  scopeMode: 'page' | 'selection' | 'frame'
  modules: ExportModulesOptions
  targetOptions: ExportTargetOptions
  tokens: ExportTokensOptions
  i18n: ExportI18nOptions
  delivery: ExportDeliveryOptions
  agent: ExportAgentOptions
  lint: ExportLintOptions
  docs: ExportDocsOptions
  themeMerges: ExportThemeMergesOptions
}

export type PackageFormingOptions = Omit<
  ExportOptions,
  'scopeMode' | 'delivery' | 'agent' | 'lint' | 'docs' | 'themeMerges'
>

export type ExportPresetId = 'django-bootstrap' | 'design-tokens' | 'bootstrap-tokens' | 'tauri-app'

export interface ExportPreset {
  id: ExportPresetId
  label: string
  values: PackageFormingOptions
}

export interface UserPreset {
  id: string
  label: string
  values: PackageFormingOptions
}

const DJANGO_BOOTSTRAP_VALUES: PackageFormingOptions = {
  target: 'django',
  modules: { tokens: true, templates: true, i18n: true, animation: true },
  targetOptions: {
    platform: 'django',
    framework: 'bootstrap',
    bootstrapFidelity: 'components',
    bootstrapSource: 'vendored',
    bootstrapVersion: '5.3',
    djangoScaffold: true,
  },
  tokens: { inlinePrimitives: true, flattenAliases: false, themeAttribute: '', emitJson: true, emitScss: false, emitModuleFiles: true, cssModulesGlobal: true, typoExtract: true, typoScaleOnly: true, typoShorthand: false, typoNaming: 'tshirt', emitNative: false, includeLibraries: false, collectionRoles: '' },
  i18n: { wrapTranslate: true, sourceLanguage: 'en', languages: '' },
}

const DESIGN_TOKENS_VALUES: PackageFormingOptions = {
  target: 'design-tokens',
  modules: { tokens: true, templates: false, i18n: false, animation: false },
  targetOptions: {
    platform: 'django',
    framework: 'none',
    bootstrapFidelity: 'tokens',
    bootstrapSource: 'vendored',
    bootstrapVersion: '5.3',
    djangoScaffold: false,
  },
  tokens: { inlinePrimitives: true, flattenAliases: false, themeAttribute: 'data-theme-name', emitJson: true, emitScss: false, emitModuleFiles: true, cssModulesGlobal: true, typoExtract: true, typoScaleOnly: true, typoShorthand: false, typoNaming: 'tshirt', emitNative: false, includeLibraries: false, collectionRoles: '' },
  i18n: { wrapTranslate: true, sourceLanguage: 'en', languages: '' },
}

/** Tauri v2 desktop app (vanilla-template shape: static `src/` frontend, `src-tauri/` scaffold).
 * The Django emitters still produce the project; the tauri module renders their template subset
 * to plain HTML. i18n is off (no gettext runtime in a static webview); animation is on — the
 * whole point of the target is carrying prototype motion (view transitions, interactions,
 * Motion timelines) into the app shell. */
const TAURI_APP_VALUES: PackageFormingOptions = {
  target: 'django',
  modules: { tokens: true, templates: true, i18n: false, animation: true },
  targetOptions: {
    platform: 'tauri',
    framework: 'none',
    bootstrapFidelity: 'tokens',
    bootstrapSource: 'cdn',
    bootstrapVersion: '5.3',
    djangoScaffold: false,
  },
  tokens: { inlinePrimitives: true, flattenAliases: false, themeAttribute: '', emitJson: true, emitScss: false, emitModuleFiles: true, cssModulesGlobal: true, typoExtract: true, typoScaleOnly: true, typoShorthand: false, typoNaming: 'tshirt', emitNative: false, includeLibraries: false, collectionRoles: '' },
  i18n: { wrapTranslate: true, sourceLanguage: 'en', languages: '' },
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: 'django-bootstrap', label: 'Django × Bootstrap', values: DJANGO_BOOTSTRAP_VALUES },
  { id: 'tauri-app', label: 'Tauri app', values: TAURI_APP_VALUES },
  { id: 'design-tokens', label: 'Design tokens only', values: DESIGN_TOKENS_VALUES },
  {
    id: 'bootstrap-tokens',
    label: 'Bootstrap tokens only',
    values: {
      ...DJANGO_BOOTSTRAP_VALUES,
      modules: { tokens: true, templates: false, i18n: false, animation: false },
      targetOptions: { ...DJANGO_BOOTSTRAP_VALUES.targetOptions, bootstrapFidelity: 'tokens' as BootstrapFidelity },
    },
  },
]

function clonePackage(values: PackageFormingOptions): PackageFormingOptions {
  return {
    target: values.target,
    modules: { ...values.modules },
    targetOptions: { ...values.targetOptions },
    tokens: { ...values.tokens },
    i18n: { ...values.i18n },
  }
}

const DEFAULT_DELIVERY: ExportDeliveryOptions = { endpoint: '', secret: '', onExport: false }
const DEFAULT_AGENT: ExportAgentOptions = {
  endpoint: 'http://127.0.0.1:8788',
  secret: '',
  read: false,
  write: false,
}
export const DEFAULT_LINT: ExportLintOptions = { maxNestingDepth: 8 }
/** Descriptions are cheap to read, so they are on; previews cost an export per component, so the
 * team opts in. */
export const DEFAULT_DOCS: ExportDocsOptions = { componentDocs: true, componentPreviews: false, previewBudgetMb: 8 }
export const DEFAULT_THEME_MERGES: ExportThemeMergesOptions = { groups: [] }
export const DEFAULT_UPDATES: UpdatePreferences = {
  automatic: false,
  lastCheckedAt: 0,
  latestVersion: '',
  releaseUrl: '',
  downloadUrl: '',
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  scopeMode: 'page',
  delivery: { ...DEFAULT_DELIVERY },
  agent: { ...DEFAULT_AGENT },
  lint: { ...DEFAULT_LINT },
  docs: { ...DEFAULT_DOCS },
  themeMerges: { groups: [] },
  ...clonePackage(DJANGO_BOOTSTRAP_VALUES),
  target: 'agent',
}

function isScopeMode(value: unknown): value is ExportOptions['scopeMode'] {
  return value === 'page' || value === 'selection' || value === 'frame'
}

function isTargetId(value: unknown): value is TargetId {
  return value === 'design-tokens' || value === 'django' || value === 'ds-tools' || value === 'agent'
}

function normalizeModules(raw: unknown): ExportModulesOptions {
  const defaults = DJANGO_BOOTSTRAP_VALUES.modules
  if (!isRecord(raw)) return { ...defaults }
  return {
    tokens: typeof raw.tokens === 'boolean' ? raw.tokens : defaults.tokens,
    templates: typeof raw.templates === 'boolean' ? raw.templates : defaults.templates,
    i18n: typeof raw.i18n === 'boolean' ? raw.i18n : defaults.i18n,
    animation: typeof raw.animation === 'boolean' ? raw.animation : defaults.animation,
  }
}

function normalizeTargetOptions(raw: unknown): ExportTargetOptions {
  const defaults = DJANGO_BOOTSTRAP_VALUES.targetOptions
  if (!isRecord(raw)) return { ...defaults }
  return {
    platform: raw.platform === 'django' || raw.platform === 'tauri' ? raw.platform : defaults.platform,
    framework: raw.framework === 'none' || raw.framework === 'bootstrap' ? raw.framework : defaults.framework,
    bootstrapFidelity:
      raw.bootstrapFidelity === 'tokens' ||
      raw.bootstrapFidelity === 'utilities' ||
      raw.bootstrapFidelity === 'components' ||
      raw.bootstrapFidelity === 'theme'
        ? raw.bootstrapFidelity
        : defaults.bootstrapFidelity,
    bootstrapSource:
      raw.bootstrapSource === 'assume' || raw.bootstrapSource === 'cdn' || raw.bootstrapSource === 'vendored'
        ? raw.bootstrapSource
        : defaults.bootstrapSource,
    bootstrapVersion:
      typeof raw.bootstrapVersion === 'string' && raw.bootstrapVersion.trim() !== ''
        ? raw.bootstrapVersion.trim()
        : defaults.bootstrapVersion,
    djangoScaffold: typeof raw.djangoScaffold === 'boolean' ? raw.djangoScaffold : defaults.djangoScaffold,
  }
}

function normalizeTokens(raw: unknown): ExportTokensOptions {
  const defaults = DJANGO_BOOTSTRAP_VALUES.tokens
  if (!isRecord(raw)) return { ...defaults }
  return {
    inlinePrimitives: typeof raw.inlinePrimitives === 'boolean' ? raw.inlinePrimitives : defaults.inlinePrimitives,
    flattenAliases: typeof raw.flattenAliases === 'boolean' ? raw.flattenAliases : defaults.flattenAliases,
    themeAttribute: typeof raw.themeAttribute === 'string' ? raw.themeAttribute.trim() : defaults.themeAttribute,
    emitJson: typeof raw.emitJson === 'boolean' ? raw.emitJson : defaults.emitJson,
    emitScss: typeof raw.emitScss === 'boolean' ? raw.emitScss : defaults.emitScss,
    emitModuleFiles: typeof raw.emitModuleFiles === 'boolean' ? raw.emitModuleFiles : defaults.emitModuleFiles,
    cssModulesGlobal: typeof raw.cssModulesGlobal === 'boolean' ? raw.cssModulesGlobal : defaults.cssModulesGlobal,
    typoExtract: typeof raw.typoExtract === 'boolean' ? raw.typoExtract : defaults.typoExtract,
    typoScaleOnly: typeof raw.typoScaleOnly === 'boolean' ? raw.typoScaleOnly : defaults.typoScaleOnly,
    typoShorthand: typeof raw.typoShorthand === 'boolean' ? raw.typoShorthand : defaults.typoShorthand,
    typoNaming: raw.typoNaming === 'value' ? 'value' : 'tshirt',
    emitNative: typeof raw.emitNative === 'boolean' ? raw.emitNative : defaults.emitNative,
    includeLibraries: typeof raw.includeLibraries === 'boolean' ? raw.includeLibraries : defaults.includeLibraries,
    collectionRoles: typeof raw.collectionRoles === 'string' ? raw.collectionRoles.trim() : defaults.collectionRoles,
  }
}

function normalizeThemeMerges(raw: unknown, legacyTokens: unknown): ExportThemeMergesOptions {
  const groups: ThemeMergeGroupOptions[] = []
  if (isRecord(raw) && Array.isArray(raw.groups)) {
    for (const entry of raw.groups) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || !Array.isArray(entry.modes)) continue
      const name = entry.name.trim()
      const modes: ThemeMergeModeOptions[] = []
      for (const mode of entry.modes) {
        if (!isRecord(mode) || typeof mode.collection !== 'string' || typeof mode.name !== 'string') continue
        const collection = mode.collection.trim()
        const modeName = mode.name.trim()
        if (collection && modeName) modes.push({ collection, name: modeName })
      }
      if (name && modes.length > 0) groups.push({ name, modes })
    }
  }
  if (groups.length > 0) return { groups }

  // Migration from the one-line pair field shipped before the table editor.
  if (isRecord(legacyTokens) && typeof legacyTokens.collectionMerges === 'string') {
    for (const row of legacyTokens.collectionMerges.split(/[;\n]+/)) {
      const match = /^\s*(.+?)\s*=\s*(.+?)\s*\+\s*(.+?)\s*$/.exec(row)
      if (!match) continue
      groups.push({
        name: match[1].trim(),
        modes: [
          { collection: match[2].trim(), name: 'Light' },
          { collection: match[3].trim(), name: 'Dark' },
        ],
      })
    }
  }
  return { groups }
}

function normalizeI18n(raw: unknown): ExportI18nOptions {
  const defaults = DJANGO_BOOTSTRAP_VALUES.i18n
  if (!isRecord(raw)) return { ...defaults }
  return {
    wrapTranslate: typeof raw.wrapTranslate === 'boolean' ? raw.wrapTranslate : defaults.wrapTranslate,
    sourceLanguage:
      typeof raw.sourceLanguage === 'string' && raw.sourceLanguage.trim() !== ''
        ? raw.sourceLanguage.trim()
        : defaults.sourceLanguage,
    // Stored verbatim (minus surrounding blanks) so the settings field shows what was typed;
    // `parseLanguages` is the single place that decides what a valid locale code is.
    languages: typeof raw.languages === 'string' ? raw.languages.trim() : defaults.languages,
  }
}

/** Splits the comma-separated `i18n.languages` field into locale codes Django will accept in
 * `LANGUAGES`/`LOCALE_PATHS`: lowercased, region kept (`pt-BR` → `pt-br`, the form Django's
 * `LANGUAGE_CODE` uses), deduped, and with the source language removed — a catalog translating
 * a language into itself is what makes `makemessages` emit an empty file nobody notices. */
export function parseLanguages(languages: string, sourceLanguage: string): string[] {
  const source = sourceLanguage.trim().toLowerCase()
  const seen = new Set<string>()
  const codes: string[] = []
  for (const raw of languages.split(',')) {
    const code = raw.trim().toLowerCase().replace(/_/g, '-')
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code)) continue
    if (code === source || seen.has(code)) continue
    seen.add(code)
    codes.push(code)
  }
  return codes
}

function normalizeDelivery(raw: unknown): ExportDeliveryOptions {
  if (!isRecord(raw)) return { ...DEFAULT_DELIVERY }
  return {
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint.trim() : DEFAULT_DELIVERY.endpoint,
    secret: typeof raw.secret === 'string' ? raw.secret : DEFAULT_DELIVERY.secret,
    onExport: typeof raw.onExport === 'boolean' ? raw.onExport : DEFAULT_DELIVERY.onExport,
  }
}

function normalizeAgent(raw: unknown): ExportAgentOptions {
  if (!isRecord(raw)) return { ...DEFAULT_AGENT }
  return {
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint.trim() : DEFAULT_AGENT.endpoint,
    secret: typeof raw.secret === 'string' ? raw.secret : DEFAULT_AGENT.secret,
    read: raw.read === true,
    write: raw.write === true,
  }
}

function normalizeDocs(raw: unknown): ExportDocsOptions {
  if (!isRecord(raw)) return { ...DEFAULT_DOCS }
  return {
    componentDocs: typeof raw.componentDocs === 'boolean' ? raw.componentDocs : DEFAULT_DOCS.componentDocs,
    componentPreviews:
      typeof raw.componentPreviews === 'boolean' ? raw.componentPreviews : DEFAULT_DOCS.componentPreviews,
    previewBudgetMb:
      typeof raw.previewBudgetMb === 'number' && Number.isFinite(raw.previewBudgetMb)
        ? Math.min(512, Math.max(1, Math.round(raw.previewBudgetMb)))
        : DEFAULT_DOCS.previewBudgetMb,
  }
}

function normalizeLint(raw: unknown): ExportLintOptions {
  if (!isRecord(raw)) return { ...DEFAULT_LINT }
  const depth = raw.maxNestingDepth
  return {
    maxNestingDepth:
      typeof depth === 'number' && Number.isFinite(depth)
        ? Math.min(32, Math.max(1, Math.round(depth)))
        : DEFAULT_LINT.maxNestingDepth,
  }
}

export function normalizeUpdatePreferences(raw: unknown): UpdatePreferences {
  if (!isRecord(raw)) return { ...DEFAULT_UPDATES }
  return {
    automatic: raw.automatic === true,
    lastCheckedAt:
      typeof raw.lastCheckedAt === 'number' && Number.isFinite(raw.lastCheckedAt) && raw.lastCheckedAt > 0
        ? Math.round(raw.lastCheckedAt)
        : 0,
    latestVersion: typeof raw.latestVersion === 'string' ? raw.latestVersion : '',
    releaseUrl: typeof raw.releaseUrl === 'string' ? raw.releaseUrl : '',
    downloadUrl: typeof raw.downloadUrl === 'string' ? raw.downloadUrl : '',
  }
}

export function normalizeExportOptions(raw: unknown): ExportOptions {
  const candidate = isRecord(raw) ? raw : {}
  return {
    target: isTargetId(candidate.target) ? candidate.target : DEFAULT_EXPORT_OPTIONS.target,
    scopeMode: isScopeMode(candidate.scopeMode) ? candidate.scopeMode : DEFAULT_EXPORT_OPTIONS.scopeMode,
    modules: normalizeModules(candidate.modules),
    targetOptions: normalizeTargetOptions(candidate.targetOptions),
    tokens: normalizeTokens(candidate.tokens),
    themeMerges: normalizeThemeMerges(candidate.themeMerges, candidate.tokens),
    i18n: normalizeI18n(candidate.i18n),
    delivery: normalizeDelivery(candidate.delivery),
    agent: normalizeAgent(candidate.agent),
    lint: normalizeLint(candidate.lint),
    docs: normalizeDocs(candidate.docs),
  }
}

export function mergeExportOptions(stored: unknown, incoming: unknown): ExportOptions {
  const base = isRecord(stored) ? stored : {}
  const patch = isRecord(incoming) ? incoming : {}
  return normalizeExportOptions({ ...base, ...patch })
}

function sameRecord<T extends object>(a: T, b: T): boolean {
  for (const key of Object.keys(a) as (keyof T)[]) {
    if (a[key] !== b[key]) return false
  }
  return true
}

function matchesPreset(options: ExportOptions, values: PackageFormingOptions): boolean {
  return (
    options.target === values.target &&
    sameRecord(options.modules, values.modules) &&
    sameRecord(options.targetOptions, values.targetOptions) &&
    sameRecord(options.tokens, values.tokens) &&
    sameRecord(options.i18n, values.i18n)
  )
}

export function derivePresetId(options: ExportOptions, userPresets: readonly UserPreset[] = []): string {
  for (const preset of [...EXPORT_PRESETS, ...userPresets]) {
    if (matchesPreset(options, preset.values)) return preset.id
  }
  return 'custom'
}

export function applyPreset(
  options: ExportOptions,
  presetId: string,
  userPresets: readonly UserPreset[] = []
): ExportOptions {
  const preset = [...EXPORT_PRESETS, ...userPresets].find((p) => p.id === presetId)
  if (!preset) return options
  return {
    ...clonePackage(preset.values),
    scopeMode: options.scopeMode,
    delivery: { ...options.delivery },
    agent: { ...options.agent },
    lint: { ...options.lint },
    docs: { ...options.docs },
    themeMerges: { groups: options.themeMerges.groups.map((group) => ({ name: group.name, modes: group.modes.map((mode) => ({ ...mode })) })) },
  }
}

const BUILT_IN_IDS = new Set<string>([...EXPORT_PRESETS.map((preset) => preset.id), 'custom'])

function presetIdForLabel(label: string): string {
  return 'user-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function normalizePackageForming(raw: unknown): PackageFormingOptions {
  if (!isRecord(raw)) return clonePackage(DJANGO_BOOTSTRAP_VALUES)
  return {
    target: isTargetId(raw.target) ? raw.target : DJANGO_BOOTSTRAP_VALUES.target,
    modules: normalizeModules(raw.modules),
    targetOptions: normalizeTargetOptions(raw.targetOptions),
    tokens: normalizeTokens(raw.tokens),
    i18n: normalizeI18n(raw.i18n),
  }
}

export function normalizeUserPresets(raw: unknown): UserPreset[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: UserPreset[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    if (!label) continue
    const id = presetIdForLabel(label)
    if (BUILT_IN_IDS.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label, values: normalizePackageForming(entry.values) })
  }
  return out
}

export function upsertUserPreset(
  presets: readonly UserPreset[],
  label: string,
  values: unknown
): UserPreset[] {
  const id = presetIdForLabel(label)
  const filtered = presets.filter((p) => p.id !== id)
  return [...filtered, { id, label, values: normalizePackageForming(values) }]
}

export function resolveThemeAttribute(options: ExportOptions): string {
  if (options.tokens.themeAttribute) return options.tokens.themeAttribute
  if (options.targetOptions.framework === 'bootstrap') return 'data-bs-theme'
  return 'data-theme'
}
