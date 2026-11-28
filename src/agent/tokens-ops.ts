/**
 * Agent listener — the design system as files the target platform compiles.
 *
 * The emitters have been here all along (`src/tokens/native.ts`: asset catalogue, `values/` +
 * `values-night/`, `Tokens.swift`, `Tokens.kt`), but only one path reached them — the panel's own
 * export, behind a checkbox stored in the designer's `clientStorage`. An agent on another machine
 * asking for iOS tokens got whatever that machine's checkbox happened to be, which is the same as
 * getting nothing: the answer was a property of the laptop, not of the file.
 *
 * This op takes the platform as an argument instead. `tokens.emit platform: "ios"` returns the
 * asset catalogue and `Tokens.swift` on any machine, with any panel configuration, because it
 * builds the option set from the request rather than reading one.
 *
 * Why platform-specific files at all, when `tokens.css` exists: handed to SwiftUI or Compose, a
 * CSS custom property is worse than nothing — `var(--text-primary)` type-checks as a String and
 * resolves to a colour no iOS runtime has heard of. iOS wants a `.colorset` (the appearance
 * switch lives below the language), Android wants the `-night` qualifier, and both want lengths
 * in their own unit — `dp` for layout, `sp` for anything the system font-size setting must scale.
 */

import { emitTokenArtifacts } from '../tokens/index.ts'
import { gridSelector, parseCollectionModes, toTokensTs } from '../tokens/engine.ts'
import { FILE_CONFIG_FIELDS, MAPPING_SUPERSEDES, fileTokenSettings, normalizeFileTokenConfig, readFileTokenConfig, withMapping, writeFileTokenConfig, type FileTokenConfig } from '../tokens/file-config.ts'
import type { TokenMapping } from '../tokens/mapping.ts'
import { toAndroidColors, toColorSets, toTokensKotlin, toTokensSwift } from '../tokens/native.ts'
import { readAliasTargets, readAllVariables, readLocalVariables, settleUnreachedAliases, unreachedAliasNote } from '../variables.ts'
import { textFile } from './files.ts'
import type { OpDef } from './protocol.ts'

const PLATFORMS = ['web', 'ios', 'android'] as const

export const TOKENS_OPS: readonly OpDef[] = [
  {
    name: 'tokens.emit',
    summary: "The file's variables as token files for a named platform — CSS, an iOS asset catalogue, Android resources, Swift and Kotlin.",
    agent:
      'Ask for the platform you are building; the panel\'s own export settings are not consulted, so the answer is ' +
      'the same on every machine. `web` gives tokens.css / tokens.json / tokens.ts; `ios` gives Assets.xcassets/*.colorset ' +
      'and Tokens.swift; `android` gives values/colors.xml, values-night/colors.xml and Tokens.kt. Themes come from the ' +
      "collection's modes: the dark one becomes the `luminosity` appearance on iOS and the `-night` qualifier on Android, " +
      'and a token that does not change between themes is emitted once instead of twice. `library: true` also imports ' +
      'every enabled library variable — a minute or more on a large file; leave it off when the file owns its tokens. ' +
      'When the file pins its token settings (tokens.configure), they apply here too — roles, theme attribute, slugs — unless ' +
      'this call passes its own. For the whole configured web PACKAGE exactly as the panel exports it (one module file per ' +
      'theme, README, products), call plugin.call with command SCAN_TOKENS.',
    mutates: false,
    params: {
      platform: {
        type: 'string',
        default: 'web',
        enum: [...PLATFORMS, 'all'],
        description: 'Which platform the files are for. `all` emits every set at once.',
      },
      library: {
        type: 'boolean',
        default: false,
        description: 'Import variables from enabled libraries too (slow: one round trip per variable).',
      },
      inlinePrimitives: {
        type: 'boolean',
        description:
          'Resolve semantic tokens down to their primitive values. On for native output, where a constant ' +
          'cannot hold a reference: an unresolved alias would land in Swift as the literal `{colors.blue.500}`. ' +
          'Omitted: the file\'s token config, else on.',
      },
      themeAttribute: {
        type: 'string',
        description: 'Web only: the attribute `tokens.css` switches themes on. Omitted: the file\'s token config, else data-theme.',
      },
      fileConfig: {
        type: 'boolean',
        default: true,
        description: 'Apply the token settings this file pins (see tokens.configure). false builds from the call\'s arguments alone.',
      },
    },
    async run(params) {
      const platform = String(params.platform ?? 'web')
      const wants = (target: (typeof PLATFORMS)[number]) => platform === 'all' || platform === target
      const pinned: FileTokenConfig = params.fileConfig === false ? {} : fileTokenSettings(readFileTokenConfig() ?? {})
      const inline = typeof params.inlinePrimitives === 'boolean' ? params.inlinePrimitives : pinned.inlinePrimitives ?? true
      // Local variables come from the file's own graph; libraries are network round trips.
      const read = params.library === true ? await readAllVariables() : await readLocalVariables()
      // Aliases onto variables the read did not cover are followed by id, so a consumer file
      // never exports `var(--variableid-…)` (see readAliasTargets).
      // Bounded, and what the walk cannot reach is read off the file (settleUnreachedAliases).
      const targets = await readAliasTargets(read, { lookupMs: 3000, budgetMs: 30_000 }).catch(() => ({ collections: [], variables: [] }))
      const settled = await settleUnreachedAliases(read.variables, new Set([...read.variables.map((v) => v.id), ...targets.variables.map((v) => v.id)]))
      const snapshot = {
        collections: [...read.collections, ...targets.collections],
        variables: [...settled.variables, ...targets.variables],
      }
      const aliasNote = unreachedAliasNote(settled.settled, settled.left)
      const artifacts = emitTokenArtifacts(snapshot, {
        inlinePrimitives: inline,
        flattenAliases: typeof params.inlinePrimitives === 'boolean' ? inline : pinned.flattenAliases ?? inline,
        themeAttribute: String(params.themeAttribute ?? (pinned.themeAttribute || 'data-theme')),
        collectionRoles: pinned.collectionRoles,
        slugThemes: pinned.slugThemes,
        themeAxes: pinned.themeAxes,
        structure: pinned.mapping ? undefined : pinned.structure,
      })
      const { emitted, themes, defaultTheme } = artifacts

      const files: Record<string, string> = {}
      if (wants('web')) {
        files['tokens.css'] = artifacts.css
        files['tokens.json'] = artifacts.json
        files['tokens.ts'] = toTokensTs(emitted, themes)
      }
      if (wants('ios')) {
        Object.assign(files, toColorSets(emitted, themes, defaultTheme))
        files['Tokens.swift'] = toTokensSwift(emitted, themes)
      }
      if (wants('android')) {
        Object.assign(files, toAndroidColors(emitted, themes, defaultTheme))
        files['Tokens.kt'] = toTokensKotlin(emitted, themes)
      }

      // The bridge refuses a path in a file name (files.ts), and an asset catalogue is nothing
      // but paths: every colour is its own `…colorset/Contents.json`. So the bytes come back
      // under a flat, unique basename and `manifest` says where each one belongs — the same
      // contract `assets.export` uses. Move them, do not guess the layout.
      const manifest = Object.keys(files).map((target) => ({
        file: target.replace(/\.colorset\/Contents\.json$/, '.colorset.json').replace(/\//g, '__'),
        path: target,
      }))
      return {
        platform,
        themes,
        defaultTheme,
        manifest,
        files: manifest.map(({ file, path }) =>
          textFile(file, path.endsWith('.json') ? 'application/json' : 'text/plain', files[path])
        ),
        counts: { files: manifest.length, variables: snapshot.variables?.length ?? 0 },
        ...(artifacts.notes.length > 0 || aliasNote ? { notes: [...artifacts.notes, ...(aliasNote ? [aliasNote] : [])] } : {}),
        ...(Object.keys(pinned).length > 0 ? { fileConfig: pinned } : {}),
      }
    },
  },

  {
    name: 'tokens.configure',
    summary: "Read or set how THIS FILE ships its tokens — stored in the file, so the panel, Dev Mode and every agent build the same package.",
    agent:
      'The panel keeps its export settings per person; a file that is a design system\'s contract with code pins its token ' +
      'settings here instead, and from then on every export of the file — anyone\'s panel, Dev Mode, plugin.call SCAN_TOKENS, ' +
      'tokens.emit — uses them. Without arguments it is a read. `set` merges into the stored config (null removes a field), ' +
      '`clear` removes the whole config. The answer previews what the export would produce: the themes in order, the default ' +
      'one, and the notes on collections read at their default mode. ' +
      'How the file\'s variables become code is the MAPPING — the same words Settings → Tokens shows a person, so set it ' +
      'there or here and both see it. It declares the attributes code switches on (any names, at most two) and binds every ' +
      'value to file data: { mapping: { version: 1, attributes: [{ name: "data-product", from: "collections", shared: ["Shared"], ' +
      'values: [{ value: "one", collections: ["One"], base: true }, { value: "business", collections: ["Business"] }, { value: ' +
      '"platform", sameAs: "business" }] }, { name: "data-theme", from: "columns", nested: true, values: [{ value: "light", ' +
      'columns: ["Light"] }, { value: "dark", columns: ["Dark"] }] }], collections: { Colors: "palette", Breakpoints: ' +
      '"breakpoints", Product: "skip" } } }. from: collections (a collection per value, or several — the free plan\'s one-column ' +
      'collections; the base value is what the others start from), columns (modes; with no attribute from collections or names, ' +
      'name the one collection in the attribute\'s `collections`), names (a marker segment in the token names, `dark/bg/base`; the ' +
      'unmarked tokens are the base value). Every other collection: palette (values written into tokens), breakpoints, export, ' +
      'skip. A mapping replaces collectionRoles, themeAxes, themeAttribute, slugThemes and structure; those older fields are for ' +
      'files without one. plugin.commands TOKENS_MAPPING shows a collection as Figma does, with each token\'s name in code.',
    mutates: true,
    params: {
      set: {
        type: 'json',
        description:
          `Fields to pin: ${FILE_CONFIG_FIELDS.join(', ')}. E.g. { "mapping": { "version": 1, "attributes": [{ "name": "data-theme", "from": "columns", ` +
          '"collections": ["Theme"], "values": [{ "value": "light", "columns": ["Light"] }, { "value": "dark", "columns": ["Dark"] }] }] }, "inlinePrimitives": true }. ' +
          'A field set to null is unpinned.',
      },
      clear: { type: 'boolean', default: false, description: 'Remove the file\'s token config entirely; every export falls back to each person\'s own settings.' },
      dryRun: { type: 'boolean', default: false, description: 'Validate and preview the result without writing it.' },
    },
    async run(params) {
      const before = readFileTokenConfig()
      let next: FileTokenConfig | null = before
      if (params.clear === true) next = null
      else if (params.set !== undefined) {
        if (!params.set || typeof params.set !== 'object' || Array.isArray(params.set)) throw new Error('"set" must be an object of fields to pin')
        const raw = { ...(params.set as Record<string, unknown>) }
        const unset = Object.keys(raw).filter((key) => raw[key] === null)
        const { config, problems } = normalizeFileTokenConfig(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null)))
        if (problems.length > 0) throw new Error(`nothing was written: ${problems.join('; ')}`)
        const merged: Record<string, unknown> = { ...(before ?? {}), ...config }
        for (const key of unset) delete merged[key]
        if (merged.mapping) {
          const overruled = MAPPING_SUPERSEDES.filter((field) => field in config)
          if (overruled.length > 0) throw new Error(`nothing was written: this file's mapping decides ${overruled.join(', ')} — set it inside "mapping", or unpin the mapping with { "mapping": null }`)
        }
        next = merged.mapping ? withMapping(merged as FileTokenConfig, merged.mapping as TokenMapping) : Object.keys(merged).length > 0 ? (merged as FileTokenConfig) : null
      }

      // What an export would do with it: themes in order, the default, which collections were pinned.
      const read = await readLocalVariables()
      const effective = next ? fileTokenSettings(next) : null
      const roles = parseCollectionModes(effective?.collectionRoles)
      const artifacts = emitTokenArtifacts(read, {
        inlinePrimitives: effective?.inlinePrimitives ?? true,
        flattenAliases: effective?.flattenAliases ?? false,
        themeAttribute: effective?.themeAttribute || 'data-theme-name',
        collectionRoles: effective?.collectionRoles,
        slugThemes: effective?.slugThemes,
        themeAxes: effective?.themeAxes,
        structure: effective?.mapping ? undefined : effective?.structure,
      })
      const grid = artifacts.grid
      const preview = {
        themes: artifacts.themes,
        defaultTheme: artifacts.defaultTheme,
        selector: grid ? gridSelector(grid, artifacts.defaultTheme) : `[${effective?.themeAttribute || 'data-theme-name'}="${artifacts.defaultTheme}"]`,
        ...(grid
          ? {
              axes: {
                ...Object.fromEntries(grid.axes.map((axis) => [axis.attribute, axis.values])),
                default: Object.fromEntries(grid.axes.map((axis, n) => [axis.attribute, grid.defaults[n]])),
              },
            }
          : {}),
        notes: artifacts.notes,
        unknownCollections: [...roles.hidden, ...roles.breakpoints, ...roles.products, ...roles.themes].filter(
          (name) => !(read.collections ?? []).some((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase())
        ),
      }

      const changed = JSON.stringify(before) !== JSON.stringify(next)
      if (params.dryRun === true || !changed) return { dryRun: params.dryRun === true, changed, before, after: next, preview }
      try {
        writeFileTokenConfig(next)
      } catch (err) {
        throw new Error(`the file is read-only here (Dev Mode or view access) — an editor has to pin the config: ${String((err as Error)?.message || err)}`)
      }
      const stored = readFileTokenConfig()
      return { changed, before, after: stored, verified: JSON.stringify(stored) === JSON.stringify(next), preview }
    },
  },
]
