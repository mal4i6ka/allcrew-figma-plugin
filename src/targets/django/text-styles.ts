/**
 * Maps a Figma `getStyledTextSegments` run into CSS declarations (T3.1,
 * docs/research/04-figma-to-django-templates.md): each distinct style range becomes its
 * own rule, addressed as `.<baseClassName>--segment-N` so the HTML emitter can wrap the
 * matching characters in a `<span>` with the same class.
 */

import { rgbaToCss } from './tokens.ts'

/** A value/unit pair shared by the text-decoration-offset/-thickness longhands — `AUTO` means
 * "browser default", so it maps to nothing rather than an explicit CSS value. */
type DecorationMetric = { readonly value: number; readonly unit: 'PIXELS' | 'PERCENT' } | { readonly unit: 'AUTO' }

export interface TextStyleSegment {
  readonly characters: string
  readonly fontName: { readonly family: string; readonly style: string }
  readonly fontSize: number
  readonly fontWeight: number
  readonly lineHeight: { readonly value: number; readonly unit: 'PIXELS' | 'PERCENT' } | { readonly unit: 'AUTO' }
  readonly letterSpacing: { readonly value: number; readonly unit: 'PIXELS' | 'PERCENT' }
  readonly textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS' | 'SMALL_CAPS_FORCED'
  readonly textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH'
  /** Decoration longhands — Figma reports these as `null` whenever `textDecoration` is `NONE`. */
  readonly textDecorationStyle?: 'SOLID' | 'WAVY' | 'DOTTED' | null
  readonly textDecorationOffset?: DecorationMetric | null
  readonly textDecorationThickness?: DecorationMetric | null
  /** `{value: 'AUTO'}` inherits the text color (no override); otherwise a `SolidPaint`-shaped
   * value (`color` + optional `opacity`), matching Figma's `TextDecorationColor` data type. */
  readonly textDecorationColor?: { readonly value: { readonly color: { readonly r: number; readonly g: number; readonly b: number }; readonly opacity?: number } | 'AUTO' } | null
  readonly textDecorationSkipInk?: boolean | null
  /** Only the OpenType tags that diverge from the font's own defaults (`{ CALT: false }` =
   * explicitly disabled) — Figma never reports tags that already match the font's baked-in set. */
  readonly openTypeFeatures?: { readonly [tag: string]: boolean }
  /** `null`/`'URL'` (external link) or `'NODE'` (internal Figma link — has no Django URL to
   * resolve to, so the HTML emitter renders it as plain text, same as `extract.ts`'s po markup). */
  readonly hyperlink?: { readonly type: 'URL' | 'NODE'; readonly value: string } | null
  readonly listOptions?: { readonly type: 'ORDERED' | 'UNORDERED' | 'NONE' }
  /** Nested-list depth (`getRangeIndentation`), 0 for a non-nested item. */
  readonly indentation?: number
}

export const TEXT_SEGMENT_FIELDS = [
  'fontName',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'textCase',
  'textDecoration',
  'textDecorationStyle',
  'textDecorationOffset',
  'textDecorationThickness',
  'textDecorationColor',
  'textDecorationSkipInk',
  'openTypeFeatures',
  'hyperlink',
  'listOptions',
  'indentation',
] as const

/** Node-level properties (not per-range, so not part of `TEXT_SEGMENT_FIELDS`) folded into every
 * segment's own rule — same precedent as `color` below, since Figma has no per-range equivalent. */
export interface TextBoxOverrides {
  readonly color?: string
  readonly leadingTrim?: 'CAP_HEIGHT'
  readonly hangingPunctuation?: boolean
  readonly hangingList?: boolean
}

export function segmentClassName(baseClassName: string, index: number): string {
  return `${baseClassName}--segment-${index}`
}

function lineHeightToCss(lineHeight: TextStyleSegment['lineHeight']): string {
  if (lineHeight.unit === 'AUTO') return 'normal'
  if (lineHeight.unit === 'PERCENT') return `${lineHeight.value}%`
  return `${lineHeight.value}px`
}

/** A `PERCENT` letter-spacing is relative to the font size, i.e. CSS `em` (100% = 1em). */
function letterSpacingToCss(letterSpacing: TextStyleSegment['letterSpacing']): string {
  if (letterSpacing.unit === 'PERCENT') return `${letterSpacing.value / 100}em`
  return `${letterSpacing.value}px`
}

function isItalic(style: string): boolean {
  return /italic/i.test(style)
}

/** `textCase` → declarations: UPPER/LOWER/TITLE map to `text-transform`; SMALL_CAPS uses the
 * `font-variant` OpenType feature (FORCED also uppercases first). ORIGINAL/unset add nothing. */
function textCaseDeclarations(textCase: TextStyleSegment['textCase']): string[] {
  switch (textCase) {
    case 'UPPER':
      return ['text-transform: uppercase;']
    case 'LOWER':
      return ['text-transform: lowercase;']
    case 'TITLE':
      return ['text-transform: capitalize;']
    case 'SMALL_CAPS':
      return ['font-variant: small-caps;']
    case 'SMALL_CAPS_FORCED':
      return ['font-variant: small-caps;', 'text-transform: uppercase;']
    default:
      return []
  }
}

function textDecorationCss(decoration: TextStyleSegment['textDecoration']): string | null {
  if (decoration === 'UNDERLINE') return 'underline'
  if (decoration === 'STRIKETHROUGH') return 'line-through'
  return null
}

const DECORATION_STYLE_CSS: Record<string, string> = { SOLID: 'solid', WAVY: 'wavy', DOTTED: 'dotted' }

/** `text-underline-offset`/`text-decoration-thickness` share this shape — `AUTO` is the CSS
 * default, so it maps to nothing rather than restating the browser's own value. */
function decorationMetricCss(metric: DecorationMetric | null | undefined): string | null {
  if (!metric || metric.unit === 'AUTO') return null
  return metric.unit === 'PERCENT' ? `${metric.value}%` : `${metric.value}px`
}

function decorationColorCss(decorationColor: TextStyleSegment['textDecorationColor']): string | null {
  if (!decorationColor || decorationColor.value === 'AUTO') return null
  const { color, opacity } = decorationColor.value
  return rgbaToCss(opacity === undefined ? color : { ...color, a: opacity })
}

/** `openTypeFeatures` carries only the tags that diverge from the font's own defaults (research
 * doc note) — emit exactly those, lowercased and sorted for stable output, as
 * `font-feature-settings` values. */
function openTypeFeatureSettingsCss(features: TextStyleSegment['openTypeFeatures']): string | null {
  if (!features) return null
  const tags = Object.keys(features).sort()
  if (tags.length === 0) return null
  return tags.map((tag) => `"${tag.toLowerCase()}" ${features[tag] ? 1 : 0}`).join(', ')
}

/** Generic CSS family a Figma font degrades to when it isn't installed on the viewing machine —
 * font binaries can't be exported through the Plugin API, so the fallback keeps metrics in the
 * right ballpark (mono stays mono, serifs stay serifs) instead of the browser default. */
function genericFamilyFor(family: string): 'monospace' | 'serif' | 'sans-serif' {
  if (/mono|code|courier/i.test(family)) return 'monospace'
  if (/serif(?!\s*sans)|georgia|garamond|times/i.test(family) && !/sans/i.test(family)) return 'serif'
  return 'sans-serif'
}

/** `overrides.color` is the text node's own fill (T1.4 boundVariables) — resolved once by the
 * caller and applied to every segment rule, since Figma has no per-segment bound color to vary it
 * by. `leadingTrim`/`hangingPunctuation`/`hangingList` are the same kind of node-level value,
 * folded in for the same reason. */
export function segmentToDeclarations(segment: TextStyleSegment, overrides: TextBoxOverrides = {}): string[] {
  const declarations = [
    `font-family: "${segment.fontName.family}", ${genericFamilyFor(segment.fontName.family)};`,
    `font-weight: ${segment.fontWeight};`,
    `font-style: ${isItalic(segment.fontName.style) ? 'italic' : 'normal'};`,
    `font-size: ${segment.fontSize}px;`,
    `line-height: ${lineHeightToCss(segment.lineHeight)};`,
    `letter-spacing: ${letterSpacingToCss(segment.letterSpacing)};`,
    ...textCaseDeclarations(segment.textCase),
  ]
  const decoration = textDecorationCss(segment.textDecoration)
  if (decoration) {
    declarations.push(`text-decoration: ${decoration};`)
    const style = segment.textDecorationStyle && DECORATION_STYLE_CSS[segment.textDecorationStyle]
    if (style) declarations.push(`text-decoration-style: ${style};`)
    const decorationColor = decorationColorCss(segment.textDecorationColor)
    if (decorationColor) declarations.push(`text-decoration-color: ${decorationColor};`)
    const offset = decorationMetricCss(segment.textDecorationOffset)
    if (offset) declarations.push(`text-underline-offset: ${offset};`)
    const thickness = decorationMetricCss(segment.textDecorationThickness)
    if (thickness) declarations.push(`text-decoration-thickness: ${thickness};`)
    if (segment.textDecorationSkipInk === true) declarations.push('text-decoration-skip-ink: auto;')
    else if (segment.textDecorationSkipInk === false) declarations.push('text-decoration-skip-ink: none;')
  }
  const featureSettings = openTypeFeatureSettingsCss(segment.openTypeFeatures)
  if (featureSettings) declarations.push(`font-feature-settings: ${featureSettings};`)
  // `text-box-trim`/`text-box-edge` (2025 CSS baseline) and `hanging-punctuation` (Safari only)
  // are silently ignored by browsers without support — no separate fallback CSS needed.
  if (overrides.leadingTrim === 'CAP_HEIGHT') {
    declarations.push('text-box-trim: trim-both;', 'text-box-edge: cap alphabetic;')
  }
  if (overrides.hangingPunctuation || overrides.hangingList) {
    declarations.push('hanging-punctuation: first last;')
  }
  if (overrides.color) declarations.push(`color: ${overrides.color};`)
  return declarations
}

/** Returns one full CSS rule string per distinct style range in `segments`. */
export function segmentsToCss(baseClassName: string, segments: readonly TextStyleSegment[], overrides: TextBoxOverrides = {}): string[] {
  return segments.map((segment, index) => {
    const body = segmentToDeclarations(segment, overrides)
      .map((declaration) => `  ${declaration}`)
      .join('\n')
    return `.${segmentClassName(baseClassName, index)} {\n${body}\n}`
  })
}

/** A minimal segment shape the paragraph/list splitter needs — a subset of `TextStyleSegment`
 * so both the CSS emitter (which only fetches `TEXT_SEGMENT_FIELDS`) and any plain-text fallback
 * (`[{ characters }]`, no `listOptions`/`indentation`) can share it. */
export interface ParagraphSegmentLike {
  readonly characters: string
  readonly listOptions?: { readonly type: 'ORDERED' | 'UNORDERED' | 'NONE' }
  readonly indentation?: number
}

/** One `\n`-delimited paragraph (or list item): its style-run slice, tagged with the original
 * index into the full `segments` array so `.<class>--segment-N` CSS rules (keyed by that same
 * index) keep matching after the text is split. */
export interface TextParagraph<T> {
  readonly runs: { readonly segment: T; readonly index: number }[]
  readonly listType: 'ORDERED' | 'UNORDERED' | 'NONE'
  readonly listDepth: number
}

/** Splits a node's style runs into paragraphs on `\n` boundaries, carrying each run's original
 * segment index (for CSS/HTML class alignment) and the paragraph's list type/nesting depth (the
 * last run in a paragraph wins, matching how Figma applies list formatting per line). */
export function splitTextParagraphs<T extends ParagraphSegmentLike>(segments: readonly T[]): TextParagraph<T>[] {
  const paragraphs: { runs: { segment: T; index: number }[]; listType: 'ORDERED' | 'UNORDERED' | 'NONE'; listDepth: number }[] = [
    { runs: [], listType: 'NONE', listDepth: 0 },
  ]
  segments.forEach((segment, index) => {
    const parts = segment.characters.split('\n')
    parts.forEach((part, partIndex) => {
      if (partIndex > 0) paragraphs.push({ runs: [], listType: 'NONE', listDepth: 0 })
      if (part.length === 0) return
      const current = paragraphs[paragraphs.length - 1]
      current.listType = segment.listOptions?.type ?? 'NONE'
      current.listDepth = segment.indentation ?? 0
      current.runs.push({ segment: { ...segment, characters: part }, index })
    })
  })
  return paragraphs
}

/** Whether this text renders as more than one block-level element (multiple `<p>`s and/or any
 * list item) — the cutoff for switching from a single classed leaf to a positioning wrapper
 * around several children (see html-emitter.ts's `renderTextBlock`). */
export function isMultiBlockText(paragraphs: readonly TextParagraph<unknown>[]): boolean {
  return paragraphs.length > 1 || paragraphs.some((paragraph) => paragraph.listType !== 'NONE')
}
