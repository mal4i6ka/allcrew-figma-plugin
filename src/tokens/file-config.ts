/**
 * How a FILE ships its tokens — stored in the file, not in one person's plugin settings.
 *
 * The panel's export settings live in `figma.clientStorage`: per user, per machine. That is right
 * for a designer's own preferences and wrong for a design system's contract with code. A developer
 * restyling two apps from one design system's tokens needs the roles that make that export right
 * (`Product: themes`, `One: hidden`, …); kept in the designer's clientStorage, the developer's
 * panel — and the developer's agent, which runs the same build — produced something else entirely. A token
 * config written into the document is read by everyone who opens the file, in the editor or in
 * Dev Mode, and by every agent that asks for the package.
 *
 * Only the settings that decide WHAT the tokens are live here. Where the package goes (delivery),
 * which libraries to pull and other per-person choices stay in clientStorage.
 */

import type { ExportOptions, ExportTokensOptions } from '../settings.ts'
import { normalizeThemeAxesSpec } from './theme-axes.ts'
import { normalizeStructure } from './structure.ts'
import { mappingToSettings, normalizeMapping, type TokenMapping } from './mapping.ts'

export const FILE_CONFIG_NAMESPACE = 'allcrewChannel'
export const FILE_CONFIG_KEY = 'tokenExport'

/** The token settings a file may pin. */
export const FILE_CONFIG_FIELDS = [
  'mapping',
  'collectionRoles',
  'themeAttribute',
  'slugThemes',
  'themeAxes',
  'structure',
  'inlinePrimitives',
  'flattenAliases',
  'typoScaleOnly',
  'typoExtract',
  'typoNaming',
  'emitModuleFiles',
  'cssModulesGlobal',
] as const

export type FileTokenField = (typeof FILE_CONFIG_FIELDS)[number]
export type FileTokenConfig = Partial<Pick<ExportTokensOptions, FileTokenField>>

/** What a mapping decides by itself — pinned beside one, these would be a second answer to the
 * same question, so a file with a mapping keeps none of them. */
export const MAPPING_SUPERSEDES: readonly FileTokenField[] = ['collectionRoles', 'themeAxes', 'themeAttribute', 'slugThemes', 'structure']

const BOOLEAN_FIELDS: readonly FileTokenField[] = ['slugThemes', 'inlinePrimitives', 'flattenAliases', 'typoScaleOnly', 'typoExtract', 'emitModuleFiles', 'cssModulesGlobal']

/** Validates a config from any source — the document, an agent's call. Unknown keys and wrong
 * types are reported, never silently kept: a typo in a contract is worse than no contract. */
export function normalizeFileTokenConfig(raw: unknown): { config: FileTokenConfig; problems: string[] } {
  const config: FileTokenConfig = {}
  const problems: string[] = []
  if (raw === null || raw === undefined) return { config, problems }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { config, problems: ['the token config must be an object'] }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(FILE_CONFIG_FIELDS as readonly string[]).includes(key)) {
      problems.push(`unknown setting "${key}" — the file can pin: ${FILE_CONFIG_FIELDS.join(', ')}`)
      continue
    }
    const field = key as FileTokenField
    if (BOOLEAN_FIELDS.includes(field)) {
      if (typeof value !== 'boolean') problems.push(`"${key}" must be true or false`)
      else (config as Record<string, unknown>)[field] = value
    } else if (field === 'themeAxes') {
      // The picker writes an object, a person may type the string form: both are the same spec,
      // checked the same way.
      if (typeof value !== 'string' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
        problems.push('"themeAxes" must be a string or an object')
        continue
      }
      const checked = normalizeThemeAxesSpec(value)
      if (checked.problems.length > 0) problems.push(...checked.problems.map((p) => `"themeAxes": ${p}`))
      else config.themeAxes = typeof value === 'string' ? value.trim() : checked.spec!
    } else if (field === 'mapping') {
      const checked = normalizeMapping(value)
      if (checked.problems.length > 0) problems.push(...checked.problems.map((p) => `"mapping": ${p}`))
      else if (checked.mapping) config.mapping = checked.mapping
    } else if (field === 'structure') {
      const checked = normalizeStructure(value)
      if (checked.problems.length > 0) problems.push(...checked.problems.map((p) => `"structure": ${p}`))
      else if (checked.structure) config.structure = checked.structure
    } else if (field === 'typoNaming') {
      if (value !== 'tshirt' && value !== 'value') problems.push('"typoNaming" must be "tshirt" or "value"')
      else config.typoNaming = value
    } else if (typeof value !== 'string') {
      problems.push(`"${key}" must be a string`)
    } else {
      ;(config as Record<string, unknown>)[field] = value.trim()
    }
  }
  return { config, problems }
}

/** The file's config over the person's own settings: for what the tokens ARE, the file wins. */
export function applyFileTokenConfig<T extends ExportOptions>(options: T, config: FileTokenConfig | null): T {
  if (!config || Object.keys(config).length === 0) return options
  const tokens = { ...options.tokens, ...fileTokenSettings(config) }
  if (config.mapping) delete tokens.structure
  return { ...options, tokens }
}

/** The token settings a file's config amounts to: a mapping read as the collection roles and
 * theme axes the engine understands (and nothing it supersedes), the rest as pinned. */
export function fileTokenSettings(config: FileTokenConfig): FileTokenConfig {
  if (!config.mapping) return config
  const rest: FileTokenConfig = { ...config }
  for (const field of MAPPING_SUPERSEDES) delete rest[field]
  return { ...rest, ...mappingToSettings(config.mapping), mapping: config.mapping }
}

/**
 * A config with this mapping pinned: the mapping, and beside it the settings it stands for. A
 * plugin build older than the mapping reads only collection roles and theme axes — with them it
 * still exports the same package; and a build that drops the unknown `mapping` key while saving
 * its own settings leaves them behind, so the screen reads the same mapping back from them.
 */
export function withMapping(config: FileTokenConfig | null, mapping: TokenMapping): FileTokenConfig {
  const next: FileTokenConfig = { ...(config ?? {}) }
  delete next.structure
  return { ...next, ...mappingToSettings(mapping), mapping }
}

/** The pinned fields of a full token options object — what a panel save writes back to a file
 * that already has a config, so editing in the panel edits the file's contract. */
export function pickFileTokenConfig(tokens: ExportTokensOptions, fields: readonly FileTokenField[] = FILE_CONFIG_FIELDS): FileTokenConfig {
  const out: FileTokenConfig = {}
  for (const field of fields) (out as Record<string, unknown>)[field] = tokens[field]
  return out
}

interface PluginDataHost {
  getSharedPluginData(namespace: string, key: string): string
  setSharedPluginData(namespace: string, key: string, value: string): void
}

/** The config stored in the document, or null when the file pins nothing. A stored value that no
 * longer validates is read as far as it does — the rest is dropped, not trusted. */
export function readFileTokenConfig(root: PluginDataHost = figma.root): FileTokenConfig | null {
  let raw = ''
  try {
    raw = root.getSharedPluginData(FILE_CONFIG_NAMESPACE, FILE_CONFIG_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const { config } = normalizeFileTokenConfig(JSON.parse(raw))
    return Object.keys(config).length > 0 ? config : null
  } catch {
    return null
  }
}

/** Writes (or with null, removes) the document's config. Throws where the file is read-only —
 * Dev Mode, a viewer — and the caller says so rather than pretending it saved. */
export function writeFileTokenConfig(config: FileTokenConfig | null, root: PluginDataHost = figma.root): void {
  root.setSharedPluginData(FILE_CONFIG_NAMESPACE, FILE_CONFIG_KEY, config && Object.keys(config).length > 0 ? JSON.stringify(config) : '')
}
