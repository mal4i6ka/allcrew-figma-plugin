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
import { toTokensTs } from '../tokens/engine.ts'
import { toAndroidColors, toColorSets, toTokensKotlin, toTokensSwift } from '../tokens/native.ts'
import { readAllVariables, readLocalVariables } from '../variables.ts'
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
      'every enabled library variable — a minute or more on a large file; leave it off when the file owns its tokens.',
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
        default: true,
        description:
          'Resolve semantic tokens down to their primitive values. On for native output, where a constant ' +
          'cannot hold a reference: an unresolved alias would land in Swift as the literal `{colors.blue.500}`.',
      },
      themeAttribute: {
        type: 'string',
        default: 'data-theme',
        description: 'Web only: the attribute `tokens.css` switches themes on.',
      },
    },
    async run(params) {
      const platform = String(params.platform ?? 'web')
      const wants = (target: (typeof PLATFORMS)[number]) => platform === 'all' || platform === target
      const inline = params.inlinePrimitives !== false
      // Local variables come from the file's own graph; libraries are network round trips.
      const snapshot = params.library === true ? await readAllVariables() : await readLocalVariables()
      const artifacts = emitTokenArtifacts(snapshot, {
        inlinePrimitives: inline,
        flattenAliases: inline,
        themeAttribute: String(params.themeAttribute ?? 'data-theme'),
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
      }
    },
  },
]
