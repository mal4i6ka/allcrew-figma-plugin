/**
 * View Transitions emitter (T5.6, docs/research/05-smart-animate-css-diff.md §2.4): for
 * screen-to-screen transitions and add/remove-node-mixed-with-movement diffs, `startViewTransition`
 * gives matching+morph+cross-fade for free — the same semantics as Smart Animate's own matching
 * (by `view-transition-name`, analogous to Figma's name+path key). Baseline Newly Available since
 * October 2025 (Chrome/Edge 111+, Safari 18+, Firefox 144+), so callers must still feature-detect:
 * `document.startViewTransition` is undefined on unsupported browsers, and the wrapper below
 * falls back to applying the state change with no transition rather than throwing.
 */

import type { NodePath } from './types.ts'

/** Converts a `NodePath` (`"Icon Wrap/Icon#0"`) into a valid, unique CSS `<custom-ident>`. */
export function pathToViewTransitionName(path: NodePath): string {
  const sanitized = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized.length > 0 ? sanitized : 'node'
}

export interface ViewTransitionNodeName {
  readonly path: NodePath
  readonly name: string
}

/** Builds one `{path, name}` entry per path, auto-naming with `pathToViewTransitionName`. */
export function namesForPaths(paths: readonly NodePath[]): ViewTransitionNodeName[] {
  return paths.map((path) => ({ path, name: pathToViewTransitionName(path) }))
}

export interface EmitViewTransitionInput {
  readonly pathToSelector: (path: NodePath) => string
  readonly names: readonly ViewTransitionNodeName[]
  readonly durationMs: number
  readonly timingFunction: string
  /** Element(s) whose click starts the transition. */
  readonly toggleSelector: string
  readonly toggleClass: string
}

export interface EmitViewTransitionResult {
  readonly css: string
  readonly js: string
}

/** Emits `view-transition-name` assignments + timing, and a `startViewTransition` click wrapper with a no-VT fallback. */
export function emitViewTransition(input: EmitViewTransitionInput): EmitViewTransitionResult {
  const nameRules = input.names.map((entry) => `${input.pathToSelector(entry.path)} { view-transition-name: ${entry.name}; }`)
  const groupRules = input.names.map(
    (entry) =>
      `::view-transition-group(${entry.name}) {\n  animation-duration: ${input.durationMs}ms;\n  animation-timing-function: ${input.timingFunction};\n}`
  )
  const css = [...nameRules, ...groupRules].join('\n\n')

  const js = `document.querySelectorAll(${JSON.stringify(input.toggleSelector)}).forEach((el) => {
  el.addEventListener('click', () => {
    var applyState = function () { el.classList.toggle(${JSON.stringify(input.toggleClass)}) }
    if (!document.startViewTransition) { applyState(); return }
    document.startViewTransition(applyState)
  })
})`

  return { css, js }
}
