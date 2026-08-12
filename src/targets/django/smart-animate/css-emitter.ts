/**
 * CSS emitter (T5.6, docs/research/05-smart-animate-css-diff.md §2.1/§2.2/§2.5): turns a
 * `StateDiff` into a base class + modifier rule with `transition` naming only the properties
 * that actually changed (never `transition: all` — see module doc §2.1 for why). Geometry goes
 * through the independent `translate`/`scale`/`rotate` transform properties (composited, no
 * reflow) rather than `left/top/width/height`. The modifier's selector/toggle mechanism comes
 * from `triggers.ts`'s `TriggerMechanism` — `css-pseudo-class` needs no JS at all, the rest emit
 * a matching class-toggle snippet.
 */

import type { PropertyChange, StateDiff } from './diff-properties.ts'
import type { TriggerMechanism } from './triggers.ts'

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function rgbaToCss(color: { readonly r: number; readonly g: number; readonly b: number; readonly a: number }): string {
  const to255 = (channel: number) => Math.round(channel * 255)
  return `rgba(${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)}, ${round(color.a, 4)})`
}

interface PropertyDeclaration {
  readonly cssProperty: string
  readonly value: string
}

/** Merges x/y into one `translate`, width/height into one `scale` — else the modifier rule's second axis clobbers the first. */
function buildDeclarations(changes: readonly PropertyChange[]): PropertyDeclaration[] {
  const decls: PropertyDeclaration[] = []
  let dx: number | null = null
  let dy: number | null = null
  let sx: number | null = null
  let sy: number | null = null

  for (const change of changes) {
    switch (change.prop) {
      case 'x':
        dx = change.to - change.from
        break
      case 'y':
        dy = change.to - change.from
        break
      case 'width':
        sx = change.from !== 0 ? change.to / change.from : 1
        break
      case 'height':
        sy = change.from !== 0 ? change.to / change.from : 1
        break
      case 'rotation':
        decls.push({ cssProperty: 'rotate', value: `${round(change.to - change.from, 2)}deg` })
        break
      case 'opacity':
        decls.push({ cssProperty: 'opacity', value: `${round(change.to, 4)}` })
        break
      case 'fillColor':
        decls.push({ cssProperty: 'background-color', value: rgbaToCss(change.to) })
        break
      case 'cornerRadius':
        decls.push({ cssProperty: 'border-radius', value: `${round(change.to, 2)}px` })
        break
      case 'cornerRadii':
        decls.push({ cssProperty: 'border-radius', value: change.to.map((v) => `${round(v, 2)}px`).join(' ') })
        break
    }
  }

  if (dx !== null || dy !== null) {
    decls.unshift({ cssProperty: 'translate', value: `${round(dx ?? 0, 2)}px ${round(dy ?? 0, 2)}px` })
  }
  if (sx !== null || sy !== null) {
    decls.unshift({ cssProperty: 'scale', value: `${round(sx ?? 1, 4)} ${round(sy ?? 1, 4)}` })
  }

  return decls
}

function modifierSelector(baseSelector: string, mechanism: TriggerMechanism, toggleClass: string): string {
  return mechanism.kind === 'css-pseudo-class' ? `${baseSelector}:${mechanism.pseudoClass}` : `${baseSelector}.${toggleClass}`
}

function mechanismJs(baseSelector: string, mechanism: TriggerMechanism, toggleClass: string): string | undefined {
  const selectorJson = JSON.stringify(baseSelector)
  const classJson = JSON.stringify(toggleClass)
  switch (mechanism.kind) {
    case 'css-pseudo-class':
      return undefined
    case 'toggle-class':
      return `document.querySelectorAll(${selectorJson}).forEach((el) => {\n  el.addEventListener('click', () => el.classList.toggle(${classJson}))\n})`
    case 'timeout':
      return `document.querySelectorAll(${selectorJson}).forEach((el) => {\n  setTimeout(() => el.classList.add(${classJson}), ${mechanism.timeoutMs})\n})`
    case 'js-listener':
      return `document.querySelectorAll(${selectorJson}).forEach((el) => {\n  el.addEventListener(${JSON.stringify(mechanism.event)}, () => el.classList.toggle(${classJson}))\n})`
  }
}

export interface EmitTransitionCssInput {
  readonly baseSelector: string
  readonly diff: StateDiff
  /** Maps a matched/added/removed `NodePath` to the descendant-combinator suffix appended to the selector (e.g. ` .btn__badge`). */
  readonly pathToSelector: (path: string) => string
  readonly durationMs: number
  readonly timingFunction: string
  readonly mechanism: TriggerMechanism
  /** Class toggled by non-`css-pseudo-class` mechanisms. Defaults to `is-active`. */
  readonly toggleClass?: string
}

export interface EmitTransitionCssResult {
  readonly css: string
  /** `undefined` for `css-pseudo-class` mechanisms, which need no script. */
  readonly js?: string
}

/**
 * Emits one `transition:` rule per rest-state selector that receives a changed/fade
 * declaration, plus one modifier rule per changed/added/removed node. `transition` isn't
 * inherited, so a single rule scoped to `baseSelector` alone would leave every matched
 * descendant (`baseSelector + pathToSelector(path)`) and dissolve target un-transitioned —
 * each affected selector needs its own `transition` naming just the properties it changes.
 */
export function emitTransitionCss(input: EmitTransitionCssInput): EmitTransitionCssResult {
  const toggleClass = input.toggleClass ?? 'is-active'
  const modifier = modifierSelector(input.baseSelector, input.mechanism, toggleClass)
  const rules: string[] = []
  const transitionProps = new Map<string, Set<string>>()

  const trackTransition = (path: string, cssProperty: string): void => {
    const selector = `${input.baseSelector}${input.pathToSelector(path)}`
    const props = transitionProps.get(selector) ?? new Set<string>()
    props.add(cssProperty)
    transitionProps.set(selector, props)
  }

  for (const pair of input.diff.pairs) {
    const decls = buildDeclarations(pair.changes)
    if (decls.length === 0) continue
    decls.forEach((d) => trackTransition(pair.path, d.cssProperty))
    const suffix = input.pathToSelector(pair.path)
    rules.push(`${modifier}${suffix} {\n${decls.map((d) => `  ${d.cssProperty}: ${d.value};`).join('\n')}\n}`)
  }

  for (const path of input.diff.fadeIn) {
    trackTransition(path, 'opacity')
    const suffix = input.pathToSelector(path)
    rules.push(`${input.baseSelector}${suffix} { opacity: 0; }`)
    rules.push(`${modifier}${suffix} { opacity: 1; }`)
  }
  for (const path of input.diff.fadeOut) {
    trackTransition(path, 'opacity')
    rules.push(`${modifier}${input.pathToSelector(path)} { opacity: 0; }`)
  }

  const transitionRules = [...transitionProps.entries()].map(([selector, props]) => {
    const transitionList = [...props].map((prop) => `${prop} ${input.durationMs}ms ${input.timingFunction}`)
    return `${selector} {\n  transition:\n    ${transitionList.join(',\n    ')};\n}`
  })

  return { css: [...transitionRules, ...rules].join('\n\n'), js: mechanismJs(input.baseSelector, input.mechanism, toggleClass) }
}
