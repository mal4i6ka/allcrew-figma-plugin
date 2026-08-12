/**
 * M12 + REFORM phase 1 (docs/REFORM.md §2.2, §2.4): export options persisted across plugin
 * sessions via `figma.clientStorage` (2 MB/key limit — this object is a few dozen scalars, nowhere
 * near it). Everything here is kept free of the `figma` global so it can validate whatever
 * `clientStorage.getAsync` returns — `undefined` on first run, or a stale shape from a previous
 * plugin version — without a live sandbox.
 *
 * Presets are DERIVED, never stored: `derivePresetId` compares the package-forming groups
 * (`modules`/`target`/`tokens`/`i18n` — everything except `scopeMode`, which is a workflow choice,
 * not package content) against the built-in definitions on every sync. No stored preset id means
 * no "selector says X, values say Y" drift, even across plugin updates that change a definition.
 */

export interface ExportModulesOptions {
  tokens: boolean
  templates: boolean
  i18n: boolean
  animation: boolean
}

export type ExportPlatform = 'django'
export type ExportFramework = 'none' | 'bootstrap'
/** Bootstrap adaptation ladder (docs/REFORM.md §4): each level includes the previous one. */
/** The fidelity ladder — each rung implies the ones below. `theme` (REFORM phase 14) additionally
 * extracts per-component Bootstrap variable sets from the kit masters (bootstrap-theme.css). */
export type BootstrapFidelity = 'tokens' | 'utilities' | 'components' | 'theme'
/** How base.html links Bootstrap itself (docs/REFORM.md §5.2). */
export type BootstrapSource = 'assume' | 'cdn' | 'vendored'

export interface ExportTargetOptions {
  platform: ExportPlatform
  framework: ExportFramework
  bootstrapFidelity: BootstrapFidelity
  bootstrapSource: BootstrapSource
  /** Version pin for the cdn/vendored sources, e.g. "5.3". */
  bootstrapVersion: string
}

export interface ExportTokensOptions {
  /** Resolve alias→primitive to a literal per theme (port of altery-figma-ds "Inline primitives"). */
  inlinePrimitives: boolean
  /** Also flatten semantic→semantic references; only meaningful with `inlinePrimitives` on. */
  flattenAliases: boolean
  /** CSS attribute selecting the theme; '' = auto, see `resolveThemeAttribute`. */
  themeAttribute: string
  /** Ship the lossless DTCG tokens.json in the package. */
  emitJson: boolean
  /** Also emit _tokens.scss for projects with an SCSS build. */
  emitScss: boolean
}

export interface ExportI18nOptions {
  /** Wrap text in {% translate %}/{% blocktranslate %}; off = plain text in templates. */
  wrapTranslate: boolean
  /** Language of the msgids, recorded in the PO header. */
  sourceLanguage: string
}

/** Linter knobs. Like `delivery`, NOT package-forming: a team's depth policy shouldn't flip the
 * preset selector to "Custom" or be overwritten by choosing a preset. */
export interface ExportLintOptions {
  /** `excessive-nesting` threshold — max node depth inside one exported template file. */
  maxNestingDepth: number
}

/** REFORM phase 8: where the built zip is POSTed after an export (`altery-dj receive`). */
export interface ExportDeliveryOptions {
  /** Receiver URL, e.g. `http://localhost:8765`; '' = delivery not configured. */
  endpoint: string
  /** Shared secret, sent as `X-Altery-Secret`; the receiver compares it timing-safe. */
  secret: string
  /** POST the zip to the endpoint after every successful export. */
  onExport: boolean
}

export interface ExportOptions {
  scopeMode: 'page' | 'selection' | 'frame'
  modules: ExportModulesOptions
  target: ExportTargetOptions
  tokens: ExportTokensOptions
  i18n: ExportI18nOptions
  delivery: ExportDeliveryOptions
  lint: ExportLintOptions
}

/** The groups a preset owns — everything that shapes the package's content. `scopeMode`,
 * `delivery` and `lint` stay out: a preset must not change which part of the canvas is exported,
 * where the machine-specific delivery points, or the team's linting policy. */
export type PackageFormingOptions = Omit<ExportOptions, 'scopeMode' | 'delivery' | 'lint'>

export type ExportPresetId = 'django-bootstrap' | 'design-tokens' | 'bootstrap-tokens'

export interface ExportPreset {
  id: ExportPresetId
  label: string
  values: PackageFormingOptions
}

/** REFORM §2.4, backlog → wired: a user-saved preset. Same shape as a built-in, but the id
 * is `user-<label-slug>` and the list lives under its own clientStorage key (`userPresets`),
 * so a plugin update can never clobber it. Participates in the same derive comparison. */
export interface UserPreset {
  id: string
  label: string
  values: PackageFormingOptions
}

/** "Django × Bootstrap" is both the default preset and the source of every normalizer fallback.
 * The other presets deviate only in the fields that define them and keep these values everywhere
 * else — including fields their configuration makes irrelevant (e.g. `bootstrapFidelity` under
 * framework "none") — so hand-toggling between preset configurations never strands the selector
 * on "Custom" over a field nobody sees. */
const DJANGO_BOOTSTRAP_VALUES: PackageFormingOptions = {
  modules: { tokens: true, templates: true, i18n: true, animation: true },
  target: {
    platform: 'django',
    framework: 'bootstrap',
    bootstrapFidelity: 'components',
    // 'vendored' (not 'assume'): at utilities/components fidelity the markup is unusable
    // without Bootstrap's CSS, and 'assume' ships a base.html whose framework blocks are
    // empty comments — every fresh stand renders broken until someone wires the framework.
    // `altery-dj bootstrap vendor` / `altery-dj demo up` provide the vendored files.
    bootstrapSource: 'vendored',
    bootstrapVersion: '5.3',
  },
  tokens: { inlinePrimitives: true, flattenAliases: false, themeAttribute: '', emitJson: true, emitScss: false },
  i18n: { wrapTranslate: true, sourceLanguage: 'en' },
}

/** Preset values share unchanged group objects with `DJANGO_BOOTSTRAP_VALUES` — every consumer
 * that hands options out (`applyPreset`, `DEFAULT_EXPORT_OPTIONS`, the normalizers) clones, so
 * the definitions themselves are never exposed to mutation. */
export const EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: 'django-bootstrap', label: 'Django × Bootstrap', values: DJANGO_BOOTSTRAP_VALUES },
  {
    id: 'design-tokens',
    label: 'Design tokens only',
    values: {
      ...DJANGO_BOOTSTRAP_VALUES,
      modules: { tokens: true, templates: false, i18n: false, animation: false },
      target: { ...DJANGO_BOOTSTRAP_VALUES.target, framework: 'none' },
    },
  },
  {
    id: 'bootstrap-tokens',
    label: 'Bootstrap tokens only',
    values: {
      ...DJANGO_BOOTSTRAP_VALUES,
      modules: { tokens: true, templates: false, i18n: false, animation: false },
      target: { ...DJANGO_BOOTSTRAP_VALUES.target, bootstrapFidelity: 'tokens' },
    },
  },
]

function clonePackage(values: PackageFormingOptions): PackageFormingOptions {
  return {
    modules: { ...values.modules },
    target: { ...values.target },
    tokens: { ...values.tokens },
    i18n: { ...values.i18n },
  }
}

const DEFAULT_DELIVERY: ExportDeliveryOptions = { endpoint: '', secret: '', onExport: false }
export const DEFAULT_LINT: ExportLintOptions = { maxNestingDepth: 8 }

/** First run shows the default preset, not "Custom": the defaults ARE "Django × Bootstrap". */
export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  scopeMode: 'page',
  delivery: { ...DEFAULT_DELIVERY },
  lint: { ...DEFAULT_LINT },
  ...clonePackage(DJANGO_BOOTSTRAP_VALUES),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isScopeMode(value: unknown): value is ExportOptions['scopeMode'] {
  return value === 'page' || value === 'selection' || value === 'frame'
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

function normalizeTarget(raw: unknown): ExportTargetOptions {
  const defaults = DJANGO_BOOTSTRAP_VALUES.target
  if (!isRecord(raw)) return { ...defaults }
  return {
    platform: raw.platform === 'django' ? raw.platform : defaults.platform,
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
  }
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

function normalizeDelivery(raw: unknown): ExportDeliveryOptions {
  if (!isRecord(raw)) return { ...DEFAULT_DELIVERY }
  return {
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint.trim() : DEFAULT_DELIVERY.endpoint,
    secret: typeof raw.secret === 'string' ? raw.secret : DEFAULT_DELIVERY.secret,
    onExport: typeof raw.onExport === 'boolean' ? raw.onExport : DEFAULT_DELIVERY.onExport,
  }
}

/** Validates `clientStorage.getAsync('exportOptions')`'s return value, falling back field-by-field
 * to the defaults for anything missing or malformed — a pre-REFORM `{scopeMode, modules}` shape
 * from an older plugin version reads cleanly with the new groups defaulted. */
export function normalizeExportOptions(raw: unknown): ExportOptions {
  const candidate = isRecord(raw) ? raw : {}
  return {
    scopeMode: isScopeMode(candidate.scopeMode) ? candidate.scopeMode : DEFAULT_EXPORT_OPTIONS.scopeMode,
    modules: normalizeModules(candidate.modules),
    target: normalizeTarget(candidate.target),
    tokens: normalizeTokens(candidate.tokens),
    i18n: normalizeI18n(candidate.i18n),
    delivery: normalizeDelivery(candidate.delivery),
    lint: normalizeLint(candidate.lint),
  }
}

/** Merges a (possibly partial) UI payload onto the stored value, group-wise: a group present in
 * `incoming` replaces the stored group wholesale, an absent group survives. The pre-REFORM UI
 * sends only `{scopeMode, modules}` — without this merge every save would reset the new groups. */
export function mergeExportOptions(stored: unknown, incoming: unknown): ExportOptions {
  const base = isRecord(stored) ? stored : {}
  const patch = isRecord(incoming) ? incoming : {}
  return normalizeExportOptions({ ...base, ...patch })
}

/** Both arguments always come out of the normalizers/definitions above, so they carry identical
 * flat key sets — a one-directional strict-equality sweep is a full comparison. */
function sameRecord<T extends object>(a: T, b: T): boolean {
  for (const key of Object.keys(a) as (keyof T)[]) {
    if (a[key] !== b[key]) return false
  }
  return true
}

function matchesPreset(options: ExportOptions, values: PackageFormingOptions): boolean {
  return (
    sameRecord(options.modules, values.modules) &&
    sameRecord(options.target, values.target) &&
    sameRecord(options.tokens, values.tokens) &&
    sameRecord(options.i18n, values.i18n)
  )
}

/** Which preset the current values correspond to — 'custom' when none matches exactly.
 * Recomputed on every sync instead of stored (§2.4's "derived, not stored"). Built-ins are
 * checked first, so a user preset that duplicates one can never shadow it. */
export function derivePresetId(options: ExportOptions, userPresets: readonly UserPreset[] = []): string {
  for (const preset of [...EXPORT_PRESETS, ...userPresets]) {
    if (matchesPreset(options, preset.values)) return preset.id
  }
  return 'custom'
}

/** Overwrites the package-forming groups with `presetId`'s definition, keeping `scopeMode`
 * and `delivery`. Returns fresh objects — mutating the result can never corrupt the preset
 * definitions. */
export function applyPreset(
  options: ExportOptions,
  presetId: string,
  userPresets: readonly UserPreset[] = []
): ExportOptions {
  const preset = [...EXPORT_PRESETS, ...userPresets].find((candidate) => candidate.id === presetId)
  if (!preset) return normalizeExportOptions(options) // the untyped UI can hand us anything
  return {
    scopeMode: options.scopeMode,
    delivery: { ...options.delivery },
    lint: { ...options.lint },
    ...clonePackage(preset.values),
  }
}

/* ------------------------------------------------------------------ user presets */

const BUILT_IN_IDS = new Set<string>([...EXPORT_PRESETS.map((preset) => preset.id), 'custom'])

function presetIdForLabel(label: string): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `user-${slug || 'preset'}`
}

function normalizePackageForming(raw: unknown): PackageFormingOptions {
  const candidate = isRecord(raw) ? raw : {}
  return {
    modules: normalizeModules(candidate.modules),
    target: normalizeTarget(candidate.target),
    tokens: normalizeTokens(candidate.tokens),
    i18n: normalizeI18n(candidate.i18n),
  }
}

/** Validates `clientStorage.getAsync('userPresets')` — entries with no usable label, or an id
 * colliding with a built-in (possible if a future plugin version claims the slug), are dropped;
 * duplicate ids keep the first entry. */
export function normalizeUserPresets(raw: unknown): UserPreset[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const presets: UserPreset[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.label !== 'string' || entry.label.trim() === '') continue
    const label = entry.label.trim()
    const id = typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id : presetIdForLabel(label)
    if (BUILT_IN_IDS.has(id) || seen.has(id)) continue
    seen.add(id)
    presets.push({ id, label, values: normalizePackageForming(entry.values) })
  }
  return presets
}

/** Saves the given package-forming values under `label`. The id derives from the label, so
 * saving under an existing name REPLACES that preset (update-in-place is the intuitive
 * semantics for "save current as…"). Returns a new array. */
export function upsertUserPreset(
  presets: readonly UserPreset[],
  label: string,
  values: unknown
): UserPreset[] {
  const trimmed = label.trim()
  const id = presetIdForLabel(trimmed)
  const next: UserPreset = { id, label: trimmed, values: normalizePackageForming(values) }
  const existing = presets.findIndex((preset) => preset.id === id)
  if (existing === -1) return [...presets, next]
  return presets.map((preset, index) => (index === existing ? next : preset))
}

/** '' in `tokens.themeAttribute` means auto: Bootstrap's native color-mode attribute when the
 * bootstrap adapter is on (its dark mode is `[data-bs-theme="dark"]`), neutral `data-theme`
 * otherwise. */
export function resolveThemeAttribute(options: ExportOptions): string {
  if (options.tokens.themeAttribute !== '') return options.tokens.themeAttribute
  return options.target.framework === 'bootstrap' ? 'data-bs-theme' : 'data-theme'
}
