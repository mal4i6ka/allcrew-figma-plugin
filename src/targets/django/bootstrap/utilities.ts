/**
 * REFORM phase 6 / B2 (docs/REFORM.md §4.2): Bootstrap utilities pass. Post-processes the
 * emitted project — for every node class rule, layout declarations that hit Bootstrap's
 * scales EXACTLY are removed from project.css and re-expressed as utility classes appended
 * to the node's `class` attribute in the templates. Everything off-scale stays custom CSS:
 * 1:1 fidelity is never traded for a utility (docs/1TO1-FIDELITY.md).
 *
 * Correctness guard — Bootstrap utilities are `!important`: a base declaration converted to
 * a utility would silently WIN over any later override of the same property. So before
 * extracting, every property overridden for the class anywhere else — `@media` blocks
 * (breakpoint frames), pseudo/complex selectors (`:hover` transitions in interactions.css,
 * `:not(:first-child)` paragraph spacing) — is marked protected (by property FAMILY, e.g.
 * `margin-top` protects `margin`) and left in plain CSS. Adaptive utility suffixes
 * (`flex-md-row`) are a possible future refinement; today breakpoint-touched properties
 * simply keep the `@media` path.
 *
 * Deliberately NOT mapped:
 *  - `rounded-*`/`shadow-*` — they resolve to Bootstrap theme variables our own
 *    bootstrap-tokens.css may override, so a literal-value match can't hold;
 *  - `text-align: left/right` — `text-start`/`text-end` are logical and flip under RTL
 *    locales, while the Figma design is physical. (`p*`/`m*` side utilities are logical
 *    too, but mirroring spacing under RTL is the conventionally desired behavior.)
 */

const SPACING_SUFFIX: Record<string, string> = {
  '0': '0',
  '0px': '0',
  '4px': '1',
  '8px': '2',
  '16px': '3',
  '24px': '4',
  '48px': '5',
}

const DISPLAY: Record<string, string> = {
  flex: 'd-flex',
  'inline-flex': 'd-inline-flex',
  grid: 'd-grid',
  block: 'd-block',
  'inline-block': 'd-inline-block',
  none: 'd-none',
}

const FLEX_DIRECTION: Record<string, string> = {
  row: 'flex-row',
  column: 'flex-column',
  'row-reverse': 'flex-row-reverse',
  'column-reverse': 'flex-column-reverse',
}

const FLEX_WRAP: Record<string, string> = {
  wrap: 'flex-wrap',
  nowrap: 'flex-nowrap',
  'wrap-reverse': 'flex-wrap-reverse',
}

const JUSTIFY_CONTENT: Record<string, string> = {
  'flex-start': 'justify-content-start',
  center: 'justify-content-center',
  'flex-end': 'justify-content-end',
  'space-between': 'justify-content-between',
  'space-around': 'justify-content-around',
  'space-evenly': 'justify-content-evenly',
}

const ALIGN_ITEMS: Record<string, string> = {
  'flex-start': 'align-items-start',
  center: 'align-items-center',
  'flex-end': 'align-items-end',
  stretch: 'align-items-stretch',
  baseline: 'align-items-baseline',
}

const ALIGN_SELF: Record<string, string> = {
  'flex-start': 'align-self-start',
  center: 'align-self-center',
  'flex-end': 'align-self-end',
  stretch: 'align-self-stretch',
  baseline: 'align-self-baseline',
}

const SIZE: Record<string, string> = { '25%': '25', '50%': '50', '75%': '75', '100%': '100', auto: 'auto' }

const FONT_WEIGHT: Record<string, string> = {
  '300': 'fw-light',
  '400': 'fw-normal',
  '500': 'fw-medium',
  '600': 'fw-semibold',
  '700': 'fw-bold',
  normal: 'fw-normal',
  bold: 'fw-bold',
}

const POSITION: Record<string, string> = {
  static: 'position-static',
  relative: 'position-relative',
  absolute: 'position-absolute',
  fixed: 'position-fixed',
  sticky: 'position-sticky',
}

const OVERFLOW: Record<string, string> = {
  hidden: 'overflow-hidden',
  auto: 'overflow-auto',
  scroll: 'overflow-scroll',
  visible: 'overflow-visible',
}

function spacingSuffix(value: string): string | null {
  return SPACING_SUFFIX[value] ?? null
}

/** `padding`/`margin` shorthand → side utilities. ALL sides must sit on the scale —
 * a declaration is extracted whole or not at all, never split. */
function sideUtilities(prefix: 'p' | 'm', value: string): string[] | null {
  const parts = value.trim().split(/\s+/)
  if (parts.length === 0 || parts.length > 4) return null
  if (prefix === 'm' && parts.some((part) => part.startsWith('-'))) return null // no negative-margin scale
  const suffixes = parts.map(spacingSuffix)
  if (suffixes.some((suffix) => suffix === null)) return null
  const [top, right = top, bottom = top, left = right] = suffixes as string[]
  if (top === right && top === bottom && top === left) return [`${prefix}-${top}`]
  if (top === bottom && right === left) return [`${prefix}y-${top}`, `${prefix}x-${right}`]
  return [`${prefix}t-${top}`, `${prefix}e-${right}`, `${prefix}b-${bottom}`, `${prefix}s-${left}`]
}

function gapUtilities(value: string): string[] | null {
  const parts = value.trim().split(/\s+/)
  if (parts.length === 1) {
    const suffix = spacingSuffix(parts[0])
    return suffix === null ? null : [`gap-${suffix}`]
  }
  if (parts.length === 2) {
    const [row, column] = parts.map(spacingSuffix)
    if (row === null || column === null) return null
    return row === column ? [`gap-${row}`] : [`row-gap-${row}`, `column-gap-${column}`]
  }
  return null
}

/** One CSS declaration → Bootstrap utility class(es), or null when there is no EXACT match. */
export function declarationUtilities(property: string, value: string): string[] | null {
  switch (property) {
    case 'display':
      return DISPLAY[value] ? [DISPLAY[value]] : null
    case 'flex-direction':
      return FLEX_DIRECTION[value] ? [FLEX_DIRECTION[value]] : null
    case 'flex-wrap':
      return FLEX_WRAP[value] ? [FLEX_WRAP[value]] : null
    case 'justify-content':
      return JUSTIFY_CONTENT[value] ? [JUSTIFY_CONTENT[value]] : null
    case 'align-items':
      return ALIGN_ITEMS[value] ? [ALIGN_ITEMS[value]] : null
    case 'align-self':
      return ALIGN_SELF[value] ? [ALIGN_SELF[value]] : null
    case 'flex-grow':
      return value === '0' || value === '1' ? [`flex-grow-${value}`] : null
    case 'flex-shrink':
      return value === '0' || value === '1' ? [`flex-shrink-${value}`] : null
    case 'gap':
      return gapUtilities(value)
    case 'row-gap': {
      const suffix = spacingSuffix(value)
      return suffix === null ? null : [`row-gap-${suffix}`]
    }
    case 'column-gap': {
      const suffix = spacingSuffix(value)
      return suffix === null ? null : [`column-gap-${suffix}`]
    }
    case 'padding':
      return sideUtilities('p', value)
    case 'margin':
      return sideUtilities('m', value)
    case 'width':
      return SIZE[value] ? [`w-${SIZE[value]}`] : null
    case 'height':
      return SIZE[value] ? [`h-${SIZE[value]}`] : null
    case 'text-align':
      return value === 'center' ? ['text-center'] : value === 'justify' ? ['text-justify'] : null
    case 'font-weight':
      return FONT_WEIGHT[value] ? [FONT_WEIGHT[value]] : null
    case 'position':
      return POSITION[value] ? [POSITION[value]] : null
    case 'overflow':
      return OVERFLOW[value] ? [OVERFLOW[value]] : null
    default:
      return null
  }
}

/** Protection key: overriding `margin-top` anywhere must block extracting `margin` (an
 * `!important` `m-*` would beat the override). Conservative by design. */
function propertyFamily(property: string): string {
  if (property === 'gap' || property.endsWith('-gap')) return 'gap'
  const dash = property.indexOf('-')
  return dash === -1 ? property : property.slice(0, dash)
}

/** SAME-RULE conflict key: a declaration this rule KEEPS must block extracting a shorthand
 * sibling of the same concrete property group — `overflow: hidden; overflow-y: auto` extracting
 * `.overflow-hidden` (!important) silently kills the scroll axis (the exact bug: a Figma frame
 * with clip + vertical scroll lost its scrollbar at utilities fidelity). Narrower than
 * `propertyFamily` on purpose: `flex: 1 0 0` must NOT block extracting `flex-direction` —
 * they share a family prefix but not a CSS property group. */
function conflictFamily(property: string): string {
  if (property === 'overflow' || property.startsWith('overflow-')) return 'overflow'
  if (property === 'margin' || property.startsWith('margin-')) return 'margin'
  if (property === 'padding' || property.startsWith('padding-')) return 'padding'
  if (property === 'gap' || property.endsWith('-gap')) return 'gap'
  return property
}

interface TopLevelBlock {
  selector: string
  body: string
  /** Absolute index of the selector's first character. */
  start: number
  /** Absolute index just past the closing brace. */
  end: number
}

/** Brace-depth scanner over our own well-formed emitter output (handles nested `@media`). */
function scanTopLevelBlocks(css: string): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = []
  let cursor = 0
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor)
    if (open === -1) break
    let depth = 1
    let index = open + 1
    while (index < css.length && depth > 0) {
      if (css[index] === '{') depth += 1
      else if (css[index] === '}') depth -= 1
      index += 1
    }
    const prefix = css.slice(cursor, open)
    const afterComment = prefix.lastIndexOf('*/')
    const selector = (afterComment === -1 ? prefix : prefix.slice(afterComment + 2)).trim()
    const selectorStart = selector.length > 0 ? cursor + prefix.lastIndexOf(selector) : open
    blocks.push({ selector, body: css.slice(open + 1, index - 1), start: selectorStart, end: index })
    cursor = index
  }
  return blocks
}

const DECLARATION_LINE = /^\s{2}([a-zA-Z-]+):\s(.+);$/

function collectProtections(selector: string, body: string, protectedFamilies: Map<string, Set<string>>): void {
  const classNames = [...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1])
  if (classNames.length === 0) return
  for (const line of body.split('\n')) {
    const declaration = DECLARATION_LINE.exec(line)
    if (!declaration) continue
    for (const className of classNames) {
      let families = protectedFamilies.get(className)
      if (!families) protectedFamilies.set(className, (families = new Set()))
      families.add(propertyFamily(declaration[1]))
    }
  }
}

function scanProtections(css: string, protectedFamilies: Map<string, Set<string>>, topLevelSimpleToo: boolean): void {
  for (const block of scanTopLevelBlocks(css)) {
    if (block.selector.startsWith('@')) {
      // @media/@supports: every inner rule protects its properties for its classes.
      for (const inner of scanTopLevelBlocks(block.body)) collectProtections(inner.selector, inner.body, protectedFamilies)
      continue
    }
    if (topLevelSimpleToo || !/^\.[A-Za-z0-9_-]+$/.test(block.selector)) {
      collectProtections(block.selector, block.body, protectedFamilies)
    }
  }
}

export interface BootstrapUtilitiesInput {
  css: string
  /** interactions.css — parsed for protection only (`:hover`/`:active` overrides), not rewritten. */
  interactionsCss?: string
  pages: Record<string, string>
  partials: Record<string, string>
}

export interface BootstrapUtilitiesResult {
  css: string
  pages: Record<string, string>
  partials: Record<string, string>
  /** className → utility classes, in extraction order (also the html-append order). */
  utilities: Map<string, string[]>
  stats: { extractedDeclarations: number; keptDeclarations: number }
}

function appendUtilityClasses(html: string, utilities: Map<string, string[]>): string {
  return html.replace(/class="([^"]*)"/g, (full, value: string) => {
    const tokens = value.split(/\s+/).filter(Boolean)
    const additions: string[] = []
    for (const token of tokens) {
      for (const utility of utilities.get(token) ?? []) {
        if (!tokens.includes(utility) && !additions.includes(utility)) additions.push(utility)
      }
    }
    return additions.length > 0 ? `class="${value} ${additions.join(' ')}"` : full
  })
}

export function applyBootstrapUtilities(input: BootstrapUtilitiesInput): BootstrapUtilitiesResult {
  const protectedFamilies = new Map<string, Set<string>>()
  // Complex/pseudo selectors and @media blocks in project.css protect their properties…
  scanProtections(input.css, protectedFamilies, false)
  // …and interactions.css (.cls:hover / .cls:active transitions) protects across files.
  if (input.interactionsCss) scanProtections(input.interactionsCss, protectedFamilies, true)

  const utilities = new Map<string, string[]>()
  const stats = { extractedDeclarations: 0, keptDeclarations: 0 }

  const pieces: string[] = []
  let position = 0
  for (const block of scanTopLevelBlocks(input.css)) {
    const simple = /^\.([A-Za-z0-9_-]+)$/.exec(block.selector)
    if (!simple || block.selector.startsWith('@')) continue
    const className = simple[1]
    const families = protectedFamilies.get(className)

    // Pass 1: conflict families of the declarations this rule will KEEP (no utility mapping).
    // An extraction whose !important utility would override a kept sibling longhand is skipped —
    // see `conflictFamily` (`overflow: hidden` + `overflow-y: auto` is the canonical case).
    const keptFamilies = new Set<string>()
    for (const line of block.body.split('\n')) {
      const declaration = DECLARATION_LINE.exec(line)
      if (!declaration) continue
      const [, property, value] = declaration
      const wouldMap = families?.has(propertyFamily(property)) ? null : declarationUtilities(property, value)
      if (!wouldMap) keptFamilies.add(conflictFamily(property))
    }

    const keptLines: string[] = []
    const extracted: string[] = []
    for (const line of block.body.split('\n')) {
      if (line.trim() === '') continue
      const declaration = DECLARATION_LINE.exec(line)
      if (!declaration) {
        keptLines.push(line) // in-rule comment or anything unexpected — never dropped
        continue
      }
      const [, property, value] = declaration
      const mapped =
        families?.has(propertyFamily(property)) || keptFamilies.has(conflictFamily(property))
          ? null
          : declarationUtilities(property, value)
      if (mapped) {
        extracted.push(...mapped.filter((utility) => !extracted.includes(utility)))
        stats.extractedDeclarations += 1
      } else {
        keptLines.push(line)
        stats.keptDeclarations += 1
      }
    }
    if (extracted.length === 0) continue

    const existing = utilities.get(className) ?? []
    utilities.set(className, [...existing, ...extracted.filter((utility) => !existing.includes(utility))])

    pieces.push(input.css.slice(position, block.start))
    pieces.push(keptLines.length > 0 ? `${block.selector} {\n${keptLines.join('\n')}\n}` : '')
    position = block.end
  }
  pieces.push(input.css.slice(position))
  const css = pieces.join('').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')

  const rewrite = (files: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(files).map(([path, html]) => [path, appendUtilityClasses(html, utilities)]))

  return { css, pages: rewrite(input.pages), partials: rewrite(input.partials), utilities, stats }
}
