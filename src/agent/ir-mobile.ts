/**
 * The three things a mobile build asks for that a layout tree alone does not answer.
 *
 * **Type.** The IR carries layout, paint and text *content*, but the type itself — family,
 * size, weight, leading, tracking — lives on the Figma node and never entered the tree: the
 * CSS emitter reads it off the live node on its way out. A web target gets away with that
 * because the emitter is right there; an agent writing SwiftUI does not. So the type comes
 * back as a table of the distinct styles a screen uses, with the token behind each value where
 * one is bound, and where each style is used.
 *
 * **The screen.** A phone screen is not a page: something is pinned to the top, something to
 * the bottom, the middle scrolls, and the edges belong to the system. Figma has no safe-area
 * concept at all — a status bar in a frame is a layer like any other — so this reports what is
 * actually there (what sits in the top and bottom bands, what is pinned, whether the frame
 * scrolls) and leaves the decision to the build. Naming the layers beats inventing an inset.
 *
 * **The asset catalogue.** iOS does not take loose files: an imageset is a directory plus a
 * `Contents.json` that maps each file to its scale. Emitting that file is the difference
 * between "here are three PNGs" and an asset catalogue that compiles.
 *
 * Everything here is pure — it takes plain records, not `figma` — so the rules are testable
 * without a document.
 */

import type { IrNode, IrSize } from '../targets/django/ir.ts'

/* ----------------------------------------------------------------- type */

/** One distinct way text is set on this screen. Values are what Figma reports; `tokens` names
 * the variable behind a value when the designer bound one — build from those. */
export interface TypeStyle {
  family: string
  /** Figma's own style name: "Semi Bold", "Italic" — the face, not a CSS weight. */
  face: string
  size: number
  weight?: number
  /** `24px`, `150%`, or `auto` — Figma's three ways of saying leading. */
  lineHeight: string
  letterSpacing: string
  case?: string
  decoration?: string
  /** Variable names by property: `{ fontSize: "font-size/md" }`. */
  tokens?: Record<string, string>
}

export interface TypeStyleUse extends TypeStyle {
  uses: number
  /** First few layers set this way — enough to find them, not enough to bury the answer. */
  nodes: Array<{ id: string; name: string }>
  sample: string
}

/** Figma reports a mixed property as a symbol. Anything else is a real value. */
function single<T>(value: unknown): T | undefined {
  return typeof value === 'symbol' || value === undefined || value === null ? undefined : (value as T)
}

/** `{ unit: 'PIXELS', value: 24 }` → `24px`; `PERCENT` → `150%`; `AUTO` → `auto`. */
export function measureText(value: unknown): string {
  const measure = single<{ unit?: string; value?: number }>(value)
  if (!measure || !measure.unit) return 'mixed'
  if (measure.unit === 'AUTO') return 'auto'
  if (measure.unit === 'PERCENT') return `${Math.round((measure.value ?? 0) * 100) / 100}%`
  return `${Math.round((measure.value ?? 0) * 100) / 100}px`
}

/** The properties a text node carries, in the shape this module reads them. Loose on purpose:
 * the caller hands over a Figma node, and asserting a full `TextNode` here would make the rules
 * untestable without a document. */
export interface TextNodeFacts {
  id: string
  name: string
  characters?: unknown
  fontName?: unknown
  fontSize?: unknown
  fontWeight?: unknown
  lineHeight?: unknown
  letterSpacing?: unknown
  textCase?: unknown
  textDecoration?: unknown
  boundVariables?: Record<string, unknown>
}

/** Which text properties can carry a variable. Figma keys them exactly this way. */
const TYPE_BINDINGS = ['fontFamily', 'fontStyle', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'] as const

export function typeStyleOf(node: TextNodeFacts, tokenNames: ReadonlyMap<string, string>): TypeStyle {
  const font = single<{ family?: string; style?: string }>(node.fontName)
  const tokens: Record<string, string> = {}
  for (const field of TYPE_BINDINGS) {
    const alias = node.boundVariables?.[field]
    const id = single<{ id?: string }>(Array.isArray(alias) ? alias[0] : alias)?.id
    const name = id ? tokenNames.get(id) : undefined
    if (name) tokens[field] = name
  }
  const textCase = single<string>(node.textCase)
  const decoration = single<string>(node.textDecoration)
  return {
    family: font?.family ?? 'mixed',
    face: font?.style ?? 'mixed',
    size: single<number>(node.fontSize) ?? 0,
    ...(single<number>(node.fontWeight) !== undefined ? { weight: single<number>(node.fontWeight) } : {}),
    lineHeight: measureText(node.lineHeight),
    letterSpacing: measureText(node.letterSpacing),
    ...(textCase && textCase !== 'ORIGINAL' ? { case: textCase } : {}),
    ...(decoration && decoration !== 'NONE' ? { decoration } : {}),
    ...(Object.keys(tokens).length > 0 ? { tokens } : {}),
  }
}

/** How many layers of one style are named before the list stops being useful. */
const NODES_PER_STYLE = 3

/**
 * The distinct styles, most used first. Grouping is the point: a screen with ninety-four text
 * layers has about eight ways of setting type, and eight is a table a build can implement.
 */
export function groupTypeStyles(entries: ReadonlyArray<{ node: TextNodeFacts; style: TypeStyle }>): TypeStyleUse[] {
  const byShape = new Map<string, TypeStyleUse>()
  for (const entry of entries) {
    const key = JSON.stringify(entry.style)
    const known = byShape.get(key)
    const sample = String(single<string>(entry.node.characters) ?? '').slice(0, 48)
    if (known) {
      known.uses += 1
      if (known.nodes.length < NODES_PER_STYLE) known.nodes.push({ id: entry.node.id, name: entry.node.name })
      continue
    }
    byShape.set(key, {
      ...entry.style,
      uses: 1,
      nodes: [{ id: entry.node.id, name: entry.node.name }],
      sample,
    })
  }
  return [...byShape.values()].sort((a, b) => b.uses - a.uses)
}

/* --------------------------------------------------------------- screen */

export interface ScreenSummary {
  width: number
  height: number
  /** What this size usually is — a hint for choosing a target, never a claim about the design. */
  kind: 'phone' | 'tablet' | 'desktop' | 'other'
  /** The frame scrolls on this axis (`clipsContent` + `overflowDirection`). */
  scroll?: 'x' | 'y' | 'both'
  /** Direct children overlapping the top and bottom system bands. Figma has no safe area; these
   * are the layers a build must decide about — keep, inset around, or drop for the real one. */
  systemBands: { top: Array<{ id: string; name: string }>; bottom: Array<{ id: string; name: string }> }
  /** Layers the designer pinned while the rest scrolls — a nav bar, a tab bar, a floating button. */
  pinned: Array<{ id: string; name: string; behavior: string }>
  /** Children placed by coordinates rather than by a stack. Zero means the whole screen is
   * auto-layout and maps onto stacks without a single absolute offset. */
  absolute: number
}

/** iOS status bar is 44–59pt, Android's 24–48dp; 64 covers both without reaching into content.
 * The bottom band is the home indicator / gesture bar plus a tab bar's own height. */
const TOP_BAND = 64
const BOTTOM_BAND = 96

function screenKind(width: number, height: number): ScreenSummary['kind'] {
  if (width >= 1280) return 'desktop'
  if (width >= 700) return 'tablet'
  if (width <= 500 && height > width) return 'phone'
  return 'other'
}

/** A fixed size in pixels; `hug`/`fill` have no number of their own — the frame around them
 * does, and a screen root is always fixed. */
function pixels(size: IrSize | undefined): number {
  return size && size.mode === 'fixed' ? Math.round(size.value) : 0
}

/**
 * `box` is the node's own rendered size, and it is not redundant: a frame that HUGS or FILLS
 * carries no number of its own in the tree, and a screen whose height reads 0 makes every band
 * test meaningless. The measured box is the truth about how big the screen is; the sizing mode
 * is the truth about how it got that way.
 */
export function screenSummary(root: IrNode, box?: { width: number; height: number }): ScreenSummary {
  const width = pixels(root.sizing?.width) || Math.round(box?.width ?? 0)
  const height = pixels(root.sizing?.height) || Math.round(box?.height ?? 0)
  const children = root.type === 'container' || root.type === 'instance-ref' ? root.children : []

  const top: Array<{ id: string; name: string }> = []
  const bottom: Array<{ id: string; name: string }> = []
  const pinned: Array<{ id: string; name: string; behavior: string }> = []
  let absolute = 0

  for (const child of children) {
    const y = child.position?.y ?? 0
    const childHeight = pixels(child.sizing?.height)
    // Sitting IN the band, not merely reaching into it: a content column that starts at y=60
    // is below the status bar, not part of it, and listing it would make the report useless on
    // every screen. So the top band wants a layer that both starts and ends inside it, and the
    // bottom band a layer that starts inside it.
    if (y < TOP_BAND && y + childHeight <= TOP_BAND) top.push({ id: child.id, name: child.name })
    if (height > 0 && y >= height - BOTTOM_BAND) bottom.push({ id: child.id, name: child.name })
    if (child.absoluteInLayout) absolute += 1
    if (child.scrollBehavior) pinned.push({ id: child.id, name: child.name, behavior: child.scrollBehavior })
  }

  const layout = root.type === 'container' ? root.layout : null
  const overflow = layout && 'overflow' in layout ? layout.overflow : undefined

  return {
    width,
    height,
    kind: screenKind(width, height),
    ...(overflow ? { scroll: overflow } : {}),
    systemBands: { top, bottom },
    pinned,
    absolute,
  }
}

/* ------------------------------------------------------- asset catalogue */

/**
 * The `Contents.json` of one imageset. Xcode will not read loose files: the directory is the
 * asset, and this file is what says which PNG is which density. Written beside the images so
 * the folder can be dropped into `Assets.xcassets` as it stands.
 *
 * A vector is a different kind of entry, not a 1x one. SVG and PDF go in as a single file with
 * no scale at all plus `preserves-vector-representation`, which is what lets Xcode rasterise
 * it at whatever size the layout asks for; calling it `1x` would pin it to the density it
 * happened to be exported at and waste the reason for shipping a vector.
 */
export function iosContents(files: ReadonlyArray<{ scale: number; file: string }>, format = 'PNG'): string {
  const vector = format.toUpperCase() === 'SVG' || format.toUpperCase() === 'PDF'
  return JSON.stringify(
    {
      images: files.map((entry) =>
        vector
          ? { idiom: 'universal', filename: entry.file }
          : { idiom: 'universal', filename: entry.file, scale: `${entry.scale}x` }
      ),
      info: { author: 'altery-figma', version: 1 },
      ...(vector ? { properties: { 'preserves-vector-representation': true } } : {}),
    },
    null,
    2
  )
}
