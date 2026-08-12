/**
 * Token orchestrator — bridges VariableSnapshot → token engine.
 * Ported from altery-figma-django src/tokens/index.ts, adapted for the ds engine.
 */

import type { VariableSnapshot } from '../variables'
import type { TokenGraph, TokenTree } from './engine.ts'
import {
  inlinePrimitivesTree,
  leaves,
  orderedThemes,
  toTokensCss,
  toTokensJson,
  variablesToW3CMultiMode,
} from './engine.ts'
import type { ExportOptions } from '../settings.ts'
import { resolveThemeAttribute } from '../settings.ts'

export interface TokenEmitOptions {
  inlinePrimitives: boolean
  flattenAliases: boolean
  themeAttribute: string
}

export interface TokenArtifacts {
  css: string
  json: string
  themes: string[]
  defaultTheme: string
  source: TokenTree
  /** The tree `css` was emitted from (primitives inlined per options) — the exact variable set
   * the stylesheet declares. `source` keeps the un-inlined tree for JSON/re-import. */
  emitted: TokenTree
}

export function tokenEmitOptionsFrom(options: ExportOptions): TokenEmitOptions {
  return {
    inlinePrimitives: options.tokens.inlinePrimitives,
    flattenAliases: options.tokens.flattenAliases,
    themeAttribute: resolveThemeAttribute(options),
  }
}

export function emitTokenArtifacts(snapshot: VariableSnapshot, options: TokenEmitOptions): TokenArtifacts {
  const source = variablesToW3CMultiMode(snapshot as unknown as TokenGraph)
  const { ordered, defaultTheme } = orderedThemes(leaves(source))
  const cssTree = options.inlinePrimitives ? inlinePrimitivesTree(source, options.flattenAliases) : source
  return {
    css: toTokensCss(cssTree, ordered, defaultTheme, options.themeAttribute),
    json: toTokensJson(source),
    themes: ordered,
    defaultTheme,
    source,
    emitted: cssTree,
  }
}
