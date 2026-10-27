/**
 * The nodes that only exist outside Figma Design — FigJam's stickies, shapes, connectors, code
 * blocks and tables, Slides' slides, Buzz's assets — in the same vocabulary as everything else.
 *
 * The manifest used to name `figma` and `dev` only, so none of this could even be reached; once it
 * can, the promise is the one the rest of the vocabulary keeps: what a read prints, a write takes.
 * A sticky reads as `{ text, fill, wide }` and is made from exactly that; a connector reads as the
 * two things it joins and is redrawn between them; a slide carries its transition and whether the
 * presentation skips it.
 *
 * Which editor a node or a feature belongs to is said here too, once: a FigJam constructor called
 * in Figma Design throws "not a function", which tells nobody that the file is simply the wrong
 * kind. The refusal names the editor instead.
 */

export type EditorType = 'figma' | 'figjam' | 'dev' | 'slides' | 'buzz'

const EDITOR_NAMES: Readonly<Record<EditorType, string>> = {
  figma: 'Figma Design',
  figjam: 'FigJam',
  dev: 'Dev Mode',
  slides: 'Figma Slides',
  buzz: 'Figma Buzz',
}

/**
 * What each editor can do, by the name this plugin gives the capability. Read from the
 * "only available in" notes of `@figma/plugin-typings` 1.142 — a capability missing from an
 * editor here is one the API itself refuses there, not one this plugin chose to leave out.
 */
export const EDITOR_FEATURES: Readonly<Record<string, readonly EditorType[]>> = {
  // Components and local styles are authored in Design; Slides and Buzz can use them from a
  // library but not make them.
  'components.create': ['figma'],
  'styles.create': ['figma'],
  'stickies': ['figjam'],
  'connectors': ['figjam'],
  'shapesWithText': ['figjam'],
  'codeBlocks': ['figjam'],
  'tables': ['figjam'],
  'linkPreviews': ['figjam'],
  'gifs': ['figjam'],
  'stuckNodes': ['figjam'],
  'activeUsers': ['figjam'],
  'timer': ['figjam'],
  'slides': ['slides'],
  'slideGrid': ['slides'],
  'canvasGrid': ['slides', 'buzz'],
  'focusedNode': ['slides', 'buzz', 'dev'],
  'buzz': ['buzz'],
  'measurements': ['dev'],
  'codegen': ['dev'],
}

/** "sticky needs FigJam — this file is open in Figma Design", or null when it is fine here. */
export function editorProblem(feature: string, editor: string | undefined, what = feature): string | null {
  const allowed = EDITOR_FEATURES[feature]
  // A runtime that does not say which editor it is (a test double, an older host) is not refused.
  if (!editor) return null
  if (!allowed || allowed.includes(editor as EditorType)) return null
  const names = allowed.map((one) => EDITOR_NAMES[one]).join(' or ')
  const here = EDITOR_NAMES[editor as EditorType] ?? editor
  return `${what} needs ${names} — this file is open in ${here}`
}

/** Every feature, and whether this editor has it — what `editor.capabilities` answers. */
export function editorFeatures(editor: string): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [feature, allowed] of Object.entries(EDITOR_FEATURES)) out[feature] = allowed.includes(editor as EditorType)
  return out
}

import { keyframeColour } from './keyframe-fields.ts'
import { colourFrom, solidColourOf } from './props.ts'

/** The page a node lies on, by id — undefined for a node not on one. */
export function pageIdOf(node: { type: string; id: string; parent: unknown } | null): string | undefined {
  let at = node
  while (at && at.type !== 'PAGE') at = at.parent as typeof at
  return at?.id
}

/** The path segment a link to this kind of file takes — a FigJam board is not at /design/. */
export function fileUrlPath(editor: string): string {
  return editor === 'figjam' ? 'board' : editor === 'slides' ? 'slides' : editor === 'buzz' ? 'buzz' : 'design'
}

/* ------------------------------------------------------------------ FigJam */

export const SHAPE_TYPES = [
  'SQUARE', 'ELLIPSE', 'ROUNDED_RECTANGLE', 'DIAMOND', 'TRIANGLE_UP', 'TRIANGLE_DOWN',
  'PARALLELOGRAM_RIGHT', 'PARALLELOGRAM_LEFT', 'ENG_DATABASE', 'ENG_QUEUE', 'ENG_FILE', 'ENG_FOLDER',
  'TRAPEZOID', 'PREDEFINED_PROCESS', 'SHIELD', 'DOCUMENT_SINGLE', 'DOCUMENT_MULTIPLE', 'MANUAL_INPUT',
  'HEXAGON', 'CHEVRON', 'PENTAGON', 'OCTAGON', 'STAR', 'PLUS', 'ARROW_LEFT', 'ARROW_RIGHT',
  'SUMMING_JUNCTION', 'OR', 'SPEECH_BUBBLE', 'INTERNAL_STORAGE',
] as const

/** The enum grows without a major version, so an unknown word is passed on rather than refused
 * when it is spelled like one — Figma is the one that knows. */
export const CODE_LANGUAGES = [
  'TYPESCRIPT', 'CPP', 'RUBY', 'CSS', 'JAVASCRIPT', 'HTML', 'JSON', 'GRAPHQL', 'PYTHON', 'GO', 'SQL',
  'SWIFT', 'KOTLIN', 'RUST', 'BASH', 'PLAINTEXT', 'DART',
] as const

export const CONNECTOR_LINES = ['ELBOWED', 'STRAIGHT', 'CURVED'] as const
export const CONNECTOR_CAPS = [
  'NONE', 'ARROW_EQUILATERAL', 'ARROW_LINES', 'TRIANGLE_FILLED', 'DIAMOND_FILLED', 'CIRCLE_FILLED',
] as const
export const MAGNETS = ['NONE', 'AUTO', 'TOP', 'LEFT', 'BOTTOM', 'RIGHT', 'CENTER'] as const

/**
 * One end of a connector, as a person names it: the node it is attached to (`"12:34"`), the node
 * and a side (`{ node, magnet: "TOP" }`), the node and a point on it (`{ node, at: [0.5, 1] }`), or
 * a free point on the canvas (`[x, y]`).
 */
export type EndpointSpec = string | [number, number] | { node: string; magnet?: string } | { node: string; at: [number, number] }

export interface ConnectorSpec {
  start?: EndpointSpec
  end?: EndpointSpec
  line?: (typeof CONNECTOR_LINES)[number]
  startCap?: (typeof CONNECTOR_CAPS)[number]
  endCap?: (typeof CONNECTOR_CAPS)[number]
  /** The colour behind the connector's words — `"#FFF3C4"`, `"#000000 @0.5"`; `"none"` takes it away. */
  label?: string
}

type Endpoint =
  | { position: { x: number; y: number } }
  | { endpointNodeId: string; magnet: (typeof MAGNETS)[number] }
  | { endpointNodeId: string; position: { x: number; y: number } }

export interface ConnectorValues {
  connectorStart?: Endpoint
  connectorEnd?: Endpoint
  connectorLineType?: string
  connectorStartStrokeCap?: string
  connectorEndStrokeCap?: string
  /** Not a property of the connector itself but of its label sublayer: `textBackground.fills`. */
  labelFills?: SolidPaint[]
}

const isPoint = (raw: unknown): raw is [number, number] =>
  Array.isArray(raw) && raw.length === 2 && raw.every((n) => typeof n === 'number' && Number.isFinite(n))

function endpoint(raw: unknown): Endpoint | null {
  if (typeof raw === 'string' && raw.trim() !== '') return { endpointNodeId: raw, magnet: 'AUTO' }
  if (isPoint(raw)) return { position: { x: raw[0], y: raw[1] } }
  if (typeof raw !== 'object' || raw === null) return null
  const one = raw as Record<string, unknown>
  if (typeof one.node !== 'string' || one.node === '') return null
  const extra = Object.keys(one).filter((key) => !['node', 'magnet', 'at'].includes(key))
  if (extra.length > 0 || (one.at !== undefined && one.magnet !== undefined)) return null
  if (one.at !== undefined) {
    if (!isPoint(one.at)) return null
    return { endpointNodeId: one.node, position: { x: one.at[0], y: one.at[1] } }
  }
  const magnet = one.magnet === undefined ? 'AUTO' : String(one.magnet).toUpperCase()
  if (!(MAGNETS as readonly string[]).includes(magnet)) return null
  return { endpointNodeId: one.node, magnet: magnet as (typeof MAGNETS)[number] }
}

export function planConnector(raw: unknown): { values: ConnectorValues } | { problem: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problem: 'must be { start, end, line, startCap, endCap }' }
  }
  const spec = raw as Record<string, unknown>
  const known = ['start', 'end', 'line', 'startCap', 'endCap', 'label']
  const extra = Object.keys(spec).filter((key) => !known.includes(key))
  if (extra.length > 0) return { problem: `takes ${known.join(', ')} — not ${extra.join(', ')}` }
  const values: ConnectorValues = {}
  if (spec.label !== undefined) {
    if (spec.label === 'none') values.labelFills = []
    else {
      const colour = keyframeColour(spec.label, colourFrom)
      if (!colour) return { problem: 'label must be a colour like "#FFFFFF" or "#000000 @0.5", or "none"' }
      values.labelFills = [
        { type: 'SOLID', color: solidColourOf(colour), ...(colour.a < 1 ? { opacity: colour.a } : {}) } as SolidPaint,
      ]
    }
  }
  for (const [key, property] of [['start', 'connectorStart'], ['end', 'connectorEnd']] as const) {
    if (spec[key] === undefined) continue
    const end = endpoint(spec[key])
    if (!end) {
      return {
        problem: `${key} must be a node id, { node, magnet: ${MAGNETS.join('|')} }, { node, at: [x, y] } or a canvas point [x, y]`,
      }
    }
    values[property] = end
  }
  if (spec.line !== undefined) {
    const line = String(spec.line).toUpperCase()
    if (!(CONNECTOR_LINES as readonly string[]).includes(line)) return { problem: `line must be one of: ${CONNECTOR_LINES.join(', ')}` }
    values.connectorLineType = line
  }
  for (const [key, property] of [['startCap', 'connectorStartStrokeCap'], ['endCap', 'connectorEndStrokeCap']] as const) {
    if (spec[key] === undefined) continue
    const cap = String(spec[key]).toUpperCase()
    if (!(CONNECTOR_CAPS as readonly string[]).includes(cap)) return { problem: `${key} must be one of: ${CONNECTOR_CAPS.join(', ')}` }
    values[property] = cap
  }
  if (Object.keys(values).length === 0) return { problem: 'names nothing to change' }
  return { values }
}

const round = (value: number) => Math.round(value * 100) / 100

function endpointWords(raw: unknown, pageId?: string): EndpointSpec | null {
  if (typeof raw !== 'object' || raw === null) return null
  const one = raw as { endpointNodeId?: string; magnet?: string; position?: { x: number; y: number } }
  // A free end is reported as attached to the page it lies on: that is a point, not a node.
  if (typeof one.endpointNodeId === 'string' && one.endpointNodeId !== '' && one.endpointNodeId !== pageId) {
    if (one.position) return { node: one.endpointNodeId, at: [round(one.position.x), round(one.position.y)] }
    return !one.magnet || one.magnet === 'AUTO' ? one.endpointNodeId : { node: one.endpointNodeId, magnet: one.magnet }
  }
  return one.position ? [round(one.position.x), round(one.position.y)] : null
}

/** A connector, in the words `planConnector` takes. Defaults (an elbowed line, no caps) are left
 * out. `pageId` is the page the connector is on, which is what Figma names as a free end's node. */
export function connectorWords(bag: Record<string, unknown>, pageId?: string): ConnectorSpec {
  const out: ConnectorSpec = {}
  const start = endpointWords(bag.connectorStart, pageId)
  const end = endpointWords(bag.connectorEnd, pageId)
  if (start !== null) out.start = start
  if (end !== null) out.end = end
  if (typeof bag.connectorLineType === 'string' && bag.connectorLineType !== 'ELBOWED') out.line = bag.connectorLineType as ConnectorSpec['line']
  if (typeof bag.connectorStartStrokeCap === 'string' && bag.connectorStartStrokeCap !== 'NONE') {
    out.startCap = bag.connectorStartStrokeCap as ConnectorSpec['startCap']
  }
  if (typeof bag.connectorEndStrokeCap === 'string' && bag.connectorEndStrokeCap !== 'NONE') {
    out.endCap = bag.connectorEndStrokeCap as ConnectorSpec['endCap']
  }
  const label = (bag.textBackground as { fills?: unknown } | undefined)?.fills
  if (Array.isArray(label)) {
    // A new connector's words sit on nothing — measured live — so only a background is news.
    const solid = label.find((paint) => paint?.type === 'SOLID' && paint.visible !== false) as SolidPaint | undefined
    if (solid) {
      const alpha = typeof solid.opacity === 'number' && solid.opacity < 1 ? Math.round(solid.opacity * 1000) / 1000 : undefined
      const hex = `#${[solid.color.r, solid.color.g, solid.color.b].map((n) => Math.round(n * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`
      out.label = alpha === undefined ? hex : `${hex} @${alpha}`
    }
  }
  return out
}

/**
 * A FigJam table: its shape, what each cell says, and how wide and tall the tracks are. `null` in
 * `cells` leaves that cell alone, so a write can change one cell without retyping the rest.
 */
export interface TableSpec {
  rows?: number
  columns?: number
  cells?: Array<Array<string | null>>
  columnWidths?: number[]
  rowHeights?: number[]
  /** `[from, to]` pairs applied in order, before the cells are written: the row at `from` is put
   * before the one at `to`. */
  moveRows?: Array<[number, number]>
  moveColumns?: Array<[number, number]>
}

export function planTable(raw: unknown): { value: TableSpec } | { problem: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problem: 'must be { rows, columns, cells, columnWidths, rowHeights }' }
  }
  const spec = raw as Record<string, unknown>
  const known = ['rows', 'columns', 'cells', 'columnWidths', 'rowHeights', 'moveRows', 'moveColumns']
  const extra = Object.keys(spec).filter((key) => !known.includes(key))
  if (extra.length > 0) return { problem: `takes ${known.join(', ')} — not ${extra.join(', ')}` }
  if (Object.keys(spec).length === 0) return { problem: 'names nothing to change' }
  for (const key of ['rows', 'columns'] as const) {
    const n = spec[key]
    if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 100)) {
      return { problem: `${key} must be a whole number from 1 to 100` }
    }
  }
  if (spec.cells !== undefined) {
    const ok =
      Array.isArray(spec.cells) &&
      spec.cells.every((row) => Array.isArray(row) && row.every((cell) => cell === null || typeof cell === 'string'))
    if (!ok) return { problem: 'cells must be rows of strings — null leaves a cell as it is' }
    const cells = spec.cells as unknown[][]
    if (typeof spec.rows === 'number' && cells.length > spec.rows) return { problem: `cells has ${cells.length} rows and the table ${spec.rows}` }
    const widest = Math.max(0, ...cells.map((row) => row.length))
    if (typeof spec.columns === 'number' && widest > spec.columns) {
      return { problem: `cells has a row of ${widest} and the table ${spec.columns} columns` }
    }
  }
  for (const key of ['columnWidths', 'rowHeights'] as const) {
    const list = spec[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || !list.every((n) => n === null || (typeof n === 'number' && n >= 0.01))) {
      return { problem: `${key} must be a list of sizes (>= 0.01), null to leave one as it is` }
    }
  }
  for (const key of ['moveRows', 'moveColumns'] as const) {
    const list = spec[key]
    if (list === undefined) continue
    const ok = Array.isArray(list) && list.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((n) => Number.isInteger(n) && n >= 0))
    if (!ok) return { problem: `${key} must be a list of [from, to] index pairs` }
  }
  return { value: spec as TableSpec }
}

/** What a table holds, in the words `planTable` takes. */
export function tableWords(table: {
  numRows: number
  numColumns: number
  cellAt(row: number, column: number): { text: { characters: string }; width: number; height: number }
}): TableSpec {
  const cells: string[][] = []
  for (let row = 0; row < table.numRows; row++) {
    const line: string[] = []
    for (let column = 0; column < table.numColumns; column++) line.push(table.cellAt(row, column).text.characters)
    cells.push(line)
  }
  const columnWidths = Array.from({ length: table.numColumns }, (_, column) => round(table.cellAt(0, column).width))
  const rowHeights = Array.from({ length: table.numRows }, (_, row) => round(table.cellAt(row, 0).height))
  return { rows: table.numRows, columns: table.numColumns, cells, columnWidths, rowHeights }
}

/* ------------------------------------------------------------------ Slides */

export const TRANSITION_STYLES = [
  'NONE', 'DISSOLVE', 'SLIDE_FROM_LEFT', 'SLIDE_FROM_RIGHT', 'SLIDE_FROM_BOTTOM', 'SLIDE_FROM_TOP',
  'PUSH_FROM_LEFT', 'PUSH_FROM_RIGHT', 'PUSH_FROM_BOTTOM', 'PUSH_FROM_TOP', 'MOVE_FROM_LEFT',
  'MOVE_FROM_RIGHT', 'MOVE_FROM_TOP', 'MOVE_FROM_BOTTOM', 'SLIDE_OUT_TO_LEFT', 'SLIDE_OUT_TO_RIGHT',
  'SLIDE_OUT_TO_TOP', 'SLIDE_OUT_TO_BOTTOM', 'MOVE_OUT_TO_LEFT', 'MOVE_OUT_TO_RIGHT', 'MOVE_OUT_TO_TOP',
  'MOVE_OUT_TO_BOTTOM', 'SMART_ANIMATE',
] as const
export const TRANSITION_CURVES = ['EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR', 'GENTLE', 'QUICK', 'BOUNCY', 'SLOW'] as const

/**
 * How a slide arrives: `"DISSOLVE"` alone, or `{ style, duration, curve, after }` — `after` the
 * seconds to wait before advancing on its own; without it the slide waits for a click.
 */
export type TransitionSpec =
  | (typeof TRANSITION_STYLES)[number]
  | { style: (typeof TRANSITION_STYLES)[number]; duration?: number; curve?: (typeof TRANSITION_CURVES)[number]; after?: number }

export interface SlideTransitionValue {
  style: string
  duration: number
  curve: string
  timing: { type: 'ON_CLICK' | 'AFTER_DELAY'; delay?: number }
}

export function planTransition(raw: unknown): { value: SlideTransitionValue } | { problem: string } {
  const spec = typeof raw === 'string' ? { style: raw } : raw
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    return { problem: 'must be a style word or { style, duration, curve, after }' }
  }
  const one = spec as Record<string, unknown>
  const extra = Object.keys(one).filter((key) => !['style', 'duration', 'curve', 'after'].includes(key))
  if (extra.length > 0) return { problem: `takes style, duration, curve, after — not ${extra.join(', ')}` }
  const style = String(one.style ?? '').toUpperCase()
  if (!(TRANSITION_STYLES as readonly string[]).includes(style)) return { problem: `style must be one of: ${TRANSITION_STYLES.join(', ')}` }
  const duration = one.duration ?? 0.3
  if (typeof duration !== 'number' || duration < 0 || duration > 10) return { problem: 'duration must be seconds, 0 to 10' }
  const curve = String(one.curve ?? 'EASE_OUT').toUpperCase()
  if (!(TRANSITION_CURVES as readonly string[]).includes(curve)) return { problem: `curve must be one of: ${TRANSITION_CURVES.join(', ')}` }
  if (one.after !== undefined && (typeof one.after !== 'number' || one.after < 0)) return { problem: 'after must be seconds, 0 or more' }
  return {
    value: {
      style,
      duration,
      curve,
      timing: typeof one.after === 'number' ? { type: 'AFTER_DELAY', delay: one.after } : { type: 'ON_CLICK' },
    },
  }
}

/** A slide's transition in the words `planTransition` takes — just the style when the rest is default. */
export function transitionWords(value: SlideTransitionValue | null | undefined): TransitionSpec | null {
  if (!value || value.style === 'NONE') return null
  const after = value.timing?.type === 'AFTER_DELAY' ? value.timing.delay ?? 0 : undefined
  const plain = value.duration === 0.3 && value.curve === 'EASE_OUT' && after === undefined
  if (plain) return value.style as TransitionSpec
  return {
    style: value.style as (typeof TRANSITION_STYLES)[number],
    ...(value.duration !== 0.3 ? { duration: round(value.duration) } : {}),
    ...(value.curve !== 'EASE_OUT' ? { curve: value.curve as (typeof TRANSITION_CURVES)[number] } : {}),
    ...(after !== undefined ? { after: round(after) } : {}),
  }
}

/* -------------------------------------------------------------------- Buzz */

export const BUZZ_ASSET_TYPES = [
  'CUSTOM', 'TWITTER_POST', 'LINKEDIN_POST', 'INSTA_POST_SQUARE', 'INSTA_POST_PORTRAIT', 'INSTA_STORY',
  'INSTA_AD', 'FACEBOOK_POST', 'FACEBOOK_COVER_PHOTO', 'FACEBOOK_EVENT_COVER', 'FACEBOOK_AD_PORTRAIT',
  'FACEBOOK_AD_SQUARE', 'PINTEREST_AD_PIN', 'TWITTER_BANNER', 'LINKEDIN_POST_SQUARE', 'LINKEDIN_POST_PORTRAIT',
  'LINKEDIN_POST_LANDSCAPE', 'LINKEDIN_PROFILE_BANNER', 'LINKEDIN_ARTICLE_BANNER', 'LINKEDIN_AD_LANDSCAPE',
  'LINKEDIN_AD_SQUARE', 'LINKEDIN_AD_VERTICAL', 'YOUTUBE_THUMBNAIL', 'YOUTUBE_BANNER', 'YOUTUBE_AD',
  'TWITCH_BANNER', 'GOOGLE_LEADERBOARD_AD', 'GOOGLE_LARGE_AD', 'GOOGLE_MED_AD', 'GOOGLE_MOBILE_BANNER_AD',
  'GOOGLE_SKYSCRAPER_AD', 'CARD_HORIZONTAL', 'CARD_VERTICAL', 'PRINT_US_LETTER', 'POSTER', 'BANNER_STANDARD',
  'BANNER_WIDE', 'BANNER_ULTRAWIDE', 'NAME_TAG_PORTRAIT', 'NAME_TAG_LANDSCAPE', 'INSTA_REEL_COVER', 'ZOOM_BACKGROUND',
] as const

/** A grid position `[row, column]` — where Slides and Buzz put things, rather than at x and y. */
export function gridPlace(raw: unknown): { row: number; column?: number } | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return { row: raw }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) return null
  if (!raw.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)) return null
  return raw.length === 2 ? { row: raw[0], column: raw[1] } : { row: raw[0] }
}
