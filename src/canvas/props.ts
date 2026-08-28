/**
 * What a caller may say about a node, and in what order it has to be said.
 *
 * Every write onto the canvas in this plugin so far has been task-shaped: the palette writes
 * swatches, the remap repaints, the kit draws components, the board draws a board. That is six
 * files of node-building, each hard-coded for its own job, and nothing general — so a module,
 * which can only call the plugin's own commands, could compose nothing of its own.
 *
 * This is the vocabulary that fixes that: one flat object of named properties, the same one for
 * creating a node and for changing one. Pure — it validates and *orders*, and hands back a plan
 * a thin applier can walk without deciding anything.
 *
 * Two rules earn their place here:
 *
 * - **Order is ours, not the caller's.** Auto-layout has to be set before sizing means anything,
 *   a font has to be loaded before characters can be written, and a resize after `layoutMode`
 *   does something different from a resize before it. Honouring key order in the JSON would make
 *   a screen's appearance depend on the order somebody typed — so the plan comes out in a fixed
 *   order whatever the object looked like.
 * - **An unknown property is an error.** A silently ignored `fontWeight` is a caller who thinks
 *   they set the weight; the plan names what it did not understand, and the command refuses.
 */

import { parseHex } from '../tokens/color.ts'

/* ------------------------------------------------------------------ vocabulary */

/** A colour, a variable to bind, or a picture — and a list of them is a stack of layers. */
export type PaintRef = SinglePaint | SinglePaint[] | null

export type SinglePaint =
  | string
  | { color: string; opacity?: number }
  | { variable: string }
  | ImageRef
  | GradientRef

/**
 * A gradient, said the way a person says one: which kind, which colours, which way round.
 *
 * Figma stores none of that. It stores a 2×3 matrix that maps the layer onto the unit square the
 * gradient lives in — correct, and unwritable by hand. So the vocabulary takes an `angle` (0 is
 * left to right, 90 is top to bottom, the way the screen's y runs) or, for full control, the two
 * handles the Figma UI itself shows: `from` and `to` in the layer's own 0..1 coordinates. For a
 * radial or a diamond those are the centre and a point on the edge, which is exactly what the
 * two handles mean there.
 */
export interface GradientRef {
  gradient: 'LINEAR' | 'RADIAL' | 'ANGULAR' | 'DIAMOND'
  /** `"#FFFFFF"` shorthand spreads colours evenly; the long form places each one. */
  stops: Array<string | GradientStop>
  angle?: number
  from?: [number, number]
  to?: [number, number]
  opacity?: number
}

/**
 * A link after planning: the trigger is built, the actions are named but not yet resolved.
 *
 * Resolution has to wait, because a variable is looked up in the document and this module never
 * touches it. So the plan says "set the variable called `flags/dark`" and the applier turns that
 * into an id — the same division every other reference in this vocabulary keeps.
 */
export interface PlannedLink {
  trigger: Trigger
  actions: PlannedAction[]
}

export type PlannedAction =
  | {
      kind: 'node'
      destinationId: string
      navigation: Navigation
      transition: Transition | null
      resetScroll?: boolean
      resetVideo?: boolean
      resetInteractive?: boolean
    }
  | { kind: 'back' }
  | { kind: 'close' }
  | { kind: 'url'; url: string; newTab: boolean }
  | { kind: 'setVariable'; variable: string; value: string | number | boolean | { variable: string } }
  | { kind: 'setMode'; collection: string; mode: string }
  | { kind: 'conditional'; blocks: Array<{ condition?: PlannedCondition; actions: PlannedAction[] }> }

/** A condition after planning: the comparison is resolved, the operands are still named. */
export interface PlannedCondition {
  fn: string
  args: PlannedOperand[]
}

export type PlannedOperand =
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'variable'; name: string }
  | { kind: 'condition'; condition: PlannedCondition }

/**
 * One question about the state: two sides and a comparison.
 *
 * Either side may be a literal or `{ variable }`. Figma stores this as an expression tree of
 * `VariableData` nodes with a function name — writable, and not something anyone would write by
 * hand, so the vocabulary takes the sentence and builds the tree.
 */
export interface FlowCondition {
  left: FlowOperand
  /** `==`, `!=`, `<`, `<=`, `>`, `>=`, or `and` / `or` over two conditions. */
  is: string
  right: FlowOperand
}

export type FlowOperand = string | number | boolean | { variable: string } | FlowCondition

export interface GradientStop {
  /** 0 to 1. */
  at: number
  color: string | { variable: string }
  opacity?: number
}

/**
 * A picture: one already in this document by its hash, one to fetch, or one sent as bytes.
 *
 * `bytes` is base64 — the only way an image can cross into the sandbox, which has no filesystem
 * and no fetch of its own worth trusting.
 */
export interface ImageRef {
  image: { hash?: string; url?: string; bytes?: string }
  scaleMode?: 'FILL' | 'FIT' | 'CROP' | 'TILE'
  opacity?: number
}

/**
 * A shadow or a blur, in the terms the panel uses rather than Figma's five-field objects.
 *
 * Any of the numbers, and the colour, may name a variable instead — which is how an elevation
 * token stays a token once it is on a layer rather than becoming four loose numbers.
 */
export type EffectSpec =
  | {
      shadow: 'drop' | 'inner'
      color?: string | { variable: string }
      opacity?: number
      offset?: [number | { variable: string }, number | { variable: string }]
      radius?: number | { variable: string }
      spread?: number | { variable: string }
      visible?: boolean
    }
  | { blur: 'layer' | 'background'; radius: number | { variable: string }; visible?: boolean }

/**
 * A layout grid: columns, rows, or the square grid.
 *
 * Figma spells each as a pattern with an alignment, a gutter, a count and sometimes a width; a
 * person says "12 columns, 16 apart, 24 in from each side".
 */
export type GridSpec =
  | { columns: number; gutter?: number; margin?: number; width?: number; align?: GridAlign; color?: string; opacity?: number; visible?: boolean }
  | { rows: number; gutter?: number; margin?: number; height?: number; align?: GridAlign; color?: string; opacity?: number; visible?: boolean }
  | { square: number; color?: string; opacity?: number; visible?: boolean }

export type GridAlign = 'MIN' | 'MAX' | 'CENTER' | 'STRETCH'

/**
 * One of Figma's animation styles, applied to a node.
 *
 * The styles are Figma's own — Position, Scale, Rotation, Size, Opacity, Path — and each has its
 * own settings, which MOTION_STYLES lists with their types and defaults. So `props` is passed
 * through rather than second-guessed: this vocabulary cannot know what `wStartWithDivider` means
 * and should not pretend to. What it does insist on is that a value is something Figma can hold.
 */
export interface AnimationSpec {
  /** The styleId, which is a plain word: `Position`, `Scale`, `Opacity`, … */
  style: string
  /** Seconds. */
  duration?: number
  /** Seconds into the timeline. */
  offset?: number
  props?: Record<string, unknown>
}

/**
 * A vector as Figma actually holds one: points, the segments joining them, and the loops those
 * segments close into.
 *
 * Path data says "draw this outline"; a network says "these points exist and these are joined",
 * which is the difference between describing a shape and being able to edit one. A caller who
 * wants a triangle writes path data; a caller moving one point of an icon needs this.
 *
 * The short forms are the point of it: `[[0,0],[10,0]]` for vertices and `[[0,1]]` for segments,
 * because a network written out longhand is unreadable.
 */
export interface NetworkSpec {
  vertices: Array<[number, number] | { x: number; y: number; cap?: string; join?: string; cornerRadius?: number }>
  segments: Array<[number, number] | { start: number; end: number; curve?: [number, number, number, number] }>
  /** Each loop is a list of segment indices that closes. Without regions a network has no fill. */
  regions?: Array<{ loops: number[][]; windingRule?: 'NONZERO' | 'EVENODD' }>
}

export interface LayoutProps {
  /** `GRID` is Figma's two-dimensional auto-layout; its tracks are not authored from here yet. */
  mode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID'
  gap?: number
  /** One number for all four, or [top, right, bottom, left]. */
  padding?: number | [number, number, number, number]
  primaryAxis?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN'
  counterAxis?: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE'
  wrap?: boolean
  sizing?: { horizontal?: SizingMode; vertical?: SizingMode }
}

export type SizingMode = 'FIXED' | 'HUG' | 'FILL'

export interface NodeProps {
  name?: string
  visible?: boolean
  locked?: boolean
  opacity?: number
  x?: number
  y?: number
  width?: number
  height?: number
  rotation?: number
  clipsContent?: boolean
  cornerRadius?: number | { topLeft?: number; topRight?: number; bottomRight?: number; bottomLeft?: number }
  constraints?: { horizontal?: ConstraintKind; vertical?: ConstraintKind }
  layout?: LayoutProps
  fill?: PaintRef
  stroke?: PaintRef
  strokeWeight?: number
  strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER'
  strokeCap?: 'NONE' | 'ROUND' | 'SQUARE' | 'ARROW_LINES' | 'ARROW_EQUILATERAL'
  strokeJoin?: 'MITER' | 'BEVEL' | 'ROUND'
  /** A dash pattern: [dash, gap, …]. `[]` is a solid line. */
  strokeDashes?: number[]
  /** Shadows and blurs, in order. `[]` removes them. */
  effects?: EffectSpec[]
  /** Layout grids on a frame. `[]` removes them. */
  grid?: GridSpec[]
  /** Figma Motion animation styles on this node. `null` or `[]` removes what it has. */
  animation?: AnimationSpec | AnimationSpec[] | null
  blendMode?: string
  /** TEXT only. */
  text?: string
  fontSize?: number
  fontName?: { family: string; style: string }
  textAlign?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'
  lineHeight?: number | 'AUTO'
  letterSpacing?: number
  autoResize?: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE'
  /** INSTANCE only: component properties by their catalogue names — variants, text, booleans. */
  properties?: Record<string, string | boolean>
  /** INSTANCE only: the component to become — an id or a published key. */
  swap?: string
  /** INSTANCE only: throw away every override first. */
  reset?: boolean
  /** Prototype links out of this node. An empty array removes the ones it has. */
  links?: FlowLink[]
  /** This plugin's own notes on the node, for finding it again. A null value clears a key. */
  data?: Record<string, string | null>
  /** Variables on the fields that are not paints: sizes, spacing, radii, text, visibility. */
  bind?: Record<string, string | null>
  /** VECTOR only: the shape itself, as SVG path data. */
  path?: string
  paths?: Array<{ data: string; windingRule?: 'NONZERO' | 'EVENODD' }>
  /** VECTOR only: the shape as points and the lines between them, which is how a vector is edited. */
  network?: NetworkSpec
  /** Styles the layer follows, by name, id or published key. `null` detaches from one. */
  fillStyle?: string | null
  strokeStyle?: string | null
  textStyle?: string | null
  effectStyle?: string | null
  gridStyle?: string | null
  /** A frame that scrolls in the prototype, and how many of its children stay put while it does. */
  scroll?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'BOTH'
  fixedChildren?: number
  /** TEXT only: styling for parts of the text rather than all of it. */
  runs?: TextRun[]
  /** Where the node should live. On a create this is the parent; on a change it moves it. */
  parent?: string
  index?: number
}

export type ConstraintKind = 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE'

/**
 * One styled stretch inside a text layer.
 *
 * Figma addresses these by character index, which is no way to say "make the price bold" — the
 * index moves the moment anybody edits the sentence. So a run may name its `match` instead, and
 * every occurrence of it is styled. Naming a match that is not there is an error, not a quiet
 * no-op: a caller who thinks they emboldened a word deserves to hear that they did not.
 */
export interface TextRun {
  from?: number
  to?: number
  /** Every occurrence of this text. Either this, or from/to. */
  match?: string
  fontName?: { family: string; style: string }
  fontSize?: number
  fill?: PaintRef
  textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH'
  textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE'
  letterSpacing?: number
  lineHeight?: number | 'AUTO'
  /** A URL, or null to remove the link. */
  link?: string | null
}

/**
 * One prototype connection, in the words a person would use.
 *
 * Figma's own shape is a `Reaction` holding a `Trigger` and a list of `Action`s, with the
 * transition spelled out as a type, a direction, an easing and a duration — five nested objects
 * to say "push left". A caller building a flow says `{ on: 'click', to: '<screen>', animation:
 * 'PUSH_LEFT' }` and the plan expands it.
 */
export interface FlowLink {
  /** Default `click`. */
  on?: 'click' | 'hover' | 'press' | 'drag' | 'timeout'
  /** Seconds to wait — only for `timeout`. */
  after?: number
  /** A node id, or `back` / `close`. */
  to: string
  /** Default `NAVIGATE`. */
  as?: 'NAVIGATE' | 'SWAP' | 'OVERLAY' | 'SCROLL_TO' | 'CHANGE_TO'
  /** `INSTANT`, `DISSOLVE`, `SMART_ANIMATE`, or a direction: `PUSH_LEFT`, `MOVE_IN_TOP`, … */
  animation?: string
  /** Seconds. Default 0.3. */
  duration?: number
  /** A curve or a spring preset. Default `EASE_OUT`. */
  easing?: string
  /** A curve of your own: [x1, y1, x2, y2]. */
  bezier?: [number, number, number, number]
  /** A spring of your own. */
  spring?: { mass: number; stiffness: number; damping: number; initialVelocity?: number }
  /** Directional transitions: carry matching layers across, rather than sliding the whole frame. */
  matchLayers?: boolean
  /** Seconds to wait before a mouse trigger fires. */
  delay?: number
  /** Key codes, for `keyDown`. */
  keys?: number[]
  /** Ask a question of the state, and do different things by the answer. */
  if?: FlowCondition
  then?: FlowLink
  else?: FlowLink
  /** Set a variable when this fires: the state half of a prototype. */
  set?: { variable: string; value: string | number | boolean | { variable: string } }
  /** Switch a collection to another mode — how a theme toggle is built. */
  mode?: { collection: string; mode: string }
  /** Open a link. */
  url?: string
  newTab?: boolean
  /** Arrive fresh rather than where the destination was left. */
  resetScroll?: boolean
  resetVideo?: boolean
  resetInteractive?: boolean
}

/* ---------------------------------------------------------------------- plan */

export type PropStep =
  | { step: 'assign'; property: string; value: string | number | boolean }
  | { step: 'font'; family: string; style: string }
  | { step: 'text'; characters: string }
  | { step: 'layout'; layout: LayoutProps }
  | { step: 'resize'; width?: number; height?: number }
  | { step: 'radius'; corners: { topLeft?: number; topRight?: number; bottomRight?: number; bottomLeft?: number } }
  | { step: 'paint'; property: 'fills' | 'strokes'; ref: PaintRef }
  | { step: 'constraints'; horizontal?: ConstraintKind; vertical?: ConstraintKind }
  | { step: 'reparent'; parent: string; index?: number }
  | { step: 'lineHeight'; value: number | 'AUTO' }
  | {
      step: 'effects'
      effects: Effect[]
      summary: string
      /** Variables to bind afterwards: which effect, which field, which variable. */
      bind: Array<{ index: number; field: string; variable: string }>
    }
  | { step: 'grid'; grids: LayoutGrid[]; summary: string }
  | {
      step: 'animation'
      styles: Array<{ style: string; duration?: number; offset?: number; props: Record<string, unknown> }>
      summary: string
    }
  | { step: 'dashes'; dashes: number[] }
  | { step: 'runs'; runs: TextRun[] }
  | { step: 'sizing'; horizontal?: SizingMode; vertical?: SizingMode }
  | { step: 'bind'; bindings: Array<{ field: string; variable: string | null; wants: string }> }
  | { step: 'style'; kind: 'paint' | 'text' | 'effect' | 'grid'; slot: string; ref: string | null }
  | { step: 'paths'; paths: Array<{ data: string; windingRule: 'NONZERO' | 'EVENODD' }> }
  | { step: 'network'; network: VectorNetwork; summary: string }
  | { step: 'reset' }
  | { step: 'swap'; component: string }
  | { step: 'properties'; properties: Record<string, string | boolean> }
  | { step: 'links'; links: PlannedLink[]; destinations: string[] }
  | { step: 'data'; data: Record<string, string | null> }

export interface PropPlan {
  steps: PropStep[]
  problems: string[]
}

const BLEND_FREE_ENUMS: Readonly<Record<string, readonly string[]>> = {
  textAlign: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'],
  autoResize: ['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'],
}

const LAYOUT_MODES = ['NONE', 'HORIZONTAL', 'VERTICAL', 'GRID']
const PRIMARY_AXIS = ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']
const COUNTER_AXIS = ['MIN', 'CENTER', 'MAX', 'BASELINE']
const SIZING = ['FIXED', 'HUG', 'FILL']
const CONSTRAINTS = ['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE']
const STROKE_ALIGN = ['INSIDE', 'OUTSIDE', 'CENTER']
const STROKE_CAP = ['NONE', 'ROUND', 'SQUARE', 'ARROW_LINES', 'ARROW_EQUILATERAL']
const STROKE_JOIN = ['MITER', 'BEVEL', 'ROUND']
const SCALE_MODES = ['FILL', 'FIT', 'CROP', 'TILE']
const GRADIENTS = ['LINEAR', 'RADIAL', 'ANGULAR', 'DIAMOND']

/** Top to bottom, because that is what Figma gives a designer who clicks "Linear". */
const DEFAULT_GRADIENT_ANGLE = 90
const BLEND_MODES = [
  'PASS_THROUGH',
  'NORMAL',
  'DARKEN',
  'MULTIPLY',
  'LINEAR_BURN',
  'COLOR_BURN',
  'LIGHTEN',
  'SCREEN',
  'LINEAR_DODGE',
  'COLOR_DODGE',
  'OVERLAY',
  'SOFT_LIGHT',
  'HARD_LIGHT',
  'DIFFERENCE',
  'EXCLUSION',
  'HUE',
  'SATURATION',
  'COLOR',
  'LUMINOSITY',
]

/**
 * The order the plan comes out in.
 *
 * Not alphabetical and not the caller's: auto-layout first, because sizing and padding mean
 * nothing without a mode; then geometry, which a layout may override; then paints; then text,
 * whose font has to be loaded before characters can be written; placement last, so a node is
 * fully formed before it is put anywhere anyone can see it.
 */
const ORDER = [
  'name',
  // What the instance *is*, before anything about how it looks: a swap brings the new
  // component's own size and paints with it, and a variant is a different node underneath.
  'reset',
  'swap',
  'properties',
  'visible',
  'locked',
  'clipsContent',
  'layout',
  'constraints',
  'width',
  'height',
  'x',
  'y',
  'rotation',
  'opacity',
  'cornerRadius',
  // Before the paints: the shape decides what there is to fill.
  'path',
  'paths',
  'network',
  // Before the paints and the type: following a style sets the whole bundle, and a colour named
  // in the same breath is meant to override it, not to be overwritten by it.
  'fillStyle',
  'strokeStyle',
  'textStyle',
  'effectStyle',
  'gridStyle',
  'fill',
  'stroke',
  'strokeWeight',
  'strokeAlign',
  'strokeCap',
  'strokeJoin',
  'strokeDashes',
  'effects',
  'grid',
  'animation',
  'blendMode',
  'fontName',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'autoResize',
  'text',
  'runs',
  'bind',
  'scroll',
  'fixedChildren',
  'links',
  'data',
  'parent',
  'index',
] as const

const KNOWN = new Set<string>(ORDER)

/**
 * Steps that cannot be applied until the node has its children.
 *
 * A node is created detached and filled in before anything is appended to it — which is right for
 * almost everything, and wrong for the handful of properties that describe the children. Figma
 * refuses `numberOfFixedChildren = 1` on a frame with none, so that step waits.
 */
export function dependsOnChildren(step: PropStep): boolean {
  return step.step === 'assign' && step.property === 'numberOfFixedChildren'
}

export function planProps(raw: unknown, where = 'props'): PropPlan {
  const problems: string[] = []
  const steps: PropStep[] = []
  if (raw === undefined || raw === null) return { steps, problems }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { steps, problems: [`${where} must be an object of properties`] }
  }

  const props = raw as Record<string, unknown>
  for (const key of Object.keys(props)) {
    if (!KNOWN.has(key)) {
      problems.push(`${where}: unknown property "${key}" — accepted: ${[...KNOWN].join(', ')}`)
    }
  }

  const fail = (message: string) => problems.push(`${where}.${message}`)
  const number = (key: string, min?: number, max?: number): number | null => {
    const value = props[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(`${key} must be a number`)
      return null
    }
    if (min !== undefined && value < min) {
      fail(`${key} must be >= ${min}`)
      return null
    }
    if (max !== undefined && value > max) {
      fail(`${key} must be <= ${max}`)
      return null
    }
    return value
  }

  for (const key of ORDER) {
    if (!(key in props)) continue
    switch (key) {
      case 'name': {
        if (typeof props.name !== 'string' || props.name.trim() === '') fail('name must be a non-empty string')
        else steps.push({ step: 'assign', property: 'name', value: props.name })
        break
      }
      case 'visible':
      case 'locked':
      case 'clipsContent': {
        if (typeof props[key] !== 'boolean') fail(`${key} must be a boolean`)
        else steps.push({ step: 'assign', property: key, value: props[key] as boolean })
        break
      }
      case 'opacity': {
        const value = number('opacity', 0, 1)
        if (value !== null) steps.push({ step: 'assign', property: 'opacity', value })
        break
      }
      case 'rotation': {
        const value = number('rotation', -180, 180)
        if (value !== null) steps.push({ step: 'assign', property: 'rotation', value })
        break
      }
      case 'x':
      case 'y': {
        const value = number(key)
        if (value !== null) steps.push({ step: 'assign', property: key, value })
        break
      }
      case 'width':
      case 'height': {
        // Both go through one resize: setting width alone on a node whose height is untouched is
        // still a resize call, and two of them would fight.
        if (steps.some((step) => step.step === 'resize')) break
        // Absent reads as undefined and rejected reads as null, and neither belongs in the step
        // — a plan carrying `width: undefined` is a plan that lies about what it was told.
        const width = 'width' in props ? number('width', 0.01) : undefined
        const height = 'height' in props ? number('height', 0.01) : undefined
        const wanted = {
          ...(typeof width === 'number' ? { width } : {}),
          ...(typeof height === 'number' ? { height } : {}),
        }
        if (Object.keys(wanted).length > 0) steps.push({ step: 'resize', ...wanted })
        break
      }
      case 'strokeWeight': {
        const value = number('strokeWeight', 0)
        if (value !== null) steps.push({ step: 'assign', property: 'strokeWeight', value })
        break
      }
      case 'fontSize': {
        const value = number('fontSize', 1)
        if (value !== null) steps.push({ step: 'assign', property: 'fontSize', value })
        break
      }
      case 'letterSpacing': {
        const value = number('letterSpacing')
        if (value !== null) steps.push({ step: 'assign', property: 'letterSpacing', value })
        break
      }
      case 'lineHeight': {
        const value = props.lineHeight
        if (value === 'AUTO' || (typeof value === 'number' && Number.isFinite(value) && value > 0)) {
          steps.push({ step: 'lineHeight', value: value as number | 'AUTO' })
        } else fail('lineHeight must be a positive number or "AUTO"')
        break
      }
      case 'textAlign':
      case 'autoResize': {
        const allowed = BLEND_FREE_ENUMS[key]
        const value = props[key]
        if (typeof value !== 'string' || !allowed.includes(value)) fail(`${key} must be one of: ${allowed.join(', ')}`)
        else steps.push({ step: 'assign', property: key === 'textAlign' ? 'textAlignHorizontal' : 'textAutoResize', value })
        break
      }
      case 'text': {
        if (typeof props.text !== 'string') fail('text must be a string')
        else steps.push({ step: 'text', characters: props.text })
        break
      }
      case 'fontName': {
        const font = props.fontName
        if (
          typeof font !== 'object' ||
          font === null ||
          typeof (font as { family?: unknown }).family !== 'string' ||
          typeof (font as { style?: unknown }).style !== 'string'
        ) {
          fail('fontName must be { family, style }')
        } else {
          const named = font as { family: string; style: string }
          steps.push({ step: 'font', family: named.family, style: named.style })
        }
        break
      }
      case 'cornerRadius': {
        const value = props.cornerRadius
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          steps.push({ step: 'radius', corners: { topLeft: value, topRight: value, bottomRight: value, bottomLeft: value } })
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const corners: Record<string, number> = {}
          for (const [corner, amount] of Object.entries(value as Record<string, unknown>)) {
            if (!['topLeft', 'topRight', 'bottomRight', 'bottomLeft'].includes(corner)) {
              fail(`cornerRadius: unknown corner "${corner}"`)
              continue
            }
            if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
              fail(`cornerRadius.${corner} must be a number >= 0`)
              continue
            }
            corners[corner] = amount
          }
          if (Object.keys(corners).length > 0) steps.push({ step: 'radius', corners })
        } else fail('cornerRadius must be a number or { topLeft, topRight, bottomRight, bottomLeft }')
        break
      }
      case 'constraints': {
        const value = props.constraints
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          fail('constraints must be { horizontal, vertical }')
          break
        }
        const entry = value as { horizontal?: unknown; vertical?: unknown }
        const step: PropStep = { step: 'constraints' }
        for (const axis of ['horizontal', 'vertical'] as const) {
          const kind = entry[axis]
          if (kind === undefined) continue
          if (typeof kind !== 'string' || !CONSTRAINTS.includes(kind)) {
            fail(`constraints.${axis} must be one of: ${CONSTRAINTS.join(', ')}`)
            continue
          }
          step[axis] = kind as ConstraintKind
        }
        if (step.horizontal || step.vertical) steps.push(step)
        break
      }
      case 'layout': {
        const layout = planLayout(props.layout, `${where}.layout`, problems)
        if (layout) steps.push(layout)
        break
      }
      case 'fill':
      case 'stroke': {
        const ref = props[key] as PaintRef
        if (paintProblem(ref)) fail(`${key}: ${paintProblem(ref)}`)
        else steps.push({ step: 'paint', property: key === 'fill' ? 'fills' : 'strokes', ref })
        break
      }
      case 'runs': {
        const runs = planRuns(props.runs, `${where}.runs`, problems)
        if (runs) steps.push(runs)
        break
      }
      case 'path':
      case 'paths': {
        // Both spellings land in the same step, so a shape is a shape whichever way it was said.
        if (steps.some((step) => step.step === 'paths')) break
        const wanted = 'path' in props ? [{ data: props.path }] : props.paths
        if (!Array.isArray(wanted) || wanted.length === 0) {
          fail('paths must be a non-empty array of { data } — or use path for a single one')
          break
        }
        const paths: Array<{ data: string; windingRule: 'NONZERO' | 'EVENODD' }> = []
        for (const [index, entry] of wanted.entries()) {
          const one = entry as { data?: unknown; windingRule?: unknown }
          if (typeof one?.data !== 'string' || one.data.trim() === '') {
            fail(`paths[${index}].data must be SVG path data, e.g. "M 0 0 L 10 0 L 10 10 Z"`)
            continue
          }
          const rule = one.windingRule === undefined ? 'NONZERO' : one.windingRule
          if (rule !== 'NONZERO' && rule !== 'EVENODD') {
            fail(`paths[${index}].windingRule must be NONZERO or EVENODD`)
            continue
          }
          paths.push({ data: one.data.trim(), windingRule: rule })
        }
        if (paths.length > 0) steps.push({ step: 'paths', paths })
        break
      }
      case 'network': {
        const network = planNetwork(props.network, `${where}.network`, problems)
        if (network) steps.push(network)
        break
      }
      case 'fillStyle':
      case 'strokeStyle':
      case 'textStyle':
      case 'effectStyle':
      case 'gridStyle': {
        const value = props[key]
        if (value !== null && (typeof value !== 'string' || value.trim() === '')) {
          fail(`${key} must be a style name, id or key — or null to detach`)
          break
        }
        steps.push({
          step: 'style',
          kind: STYLE_SLOTS[key],
          slot: key,
          ref: value === null ? null : (value as string).trim(),
        })
        break
      }
      case 'bind': {
        const bind = planBindings(props.bind, `${where}.bind`, problems)
        if (bind) steps.push(bind)
        break
      }
      case 'scroll': {
        const value = typeof props.scroll === 'string' ? normaliseEnum(props.scroll) : ''
        if (!OVERFLOW.includes(value)) fail(`scroll must be one of: ${OVERFLOW.join(', ')}`)
        else steps.push({ step: 'assign', property: 'overflowDirection', value })
        break
      }
      case 'fixedChildren': {
        const value = number('fixedChildren', 0)
        if (value !== null) steps.push({ step: 'assign', property: 'numberOfFixedChildren', value })
        break
      }
      case 'links': {
        const links = planLinks(props.links, `${where}.links`, problems)
        if (links) steps.push(links)
        break
      }
      case 'data': {
        const value = props.data
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          fail('data must be an object of { key: "value" }')
          break
        }
        const data: Record<string, string | null> = {}
        for (const [name, note] of Object.entries(value as Record<string, unknown>)) {
          if (typeof note === 'string' || note === null) data[name] = note
          else fail(`data.${name} must be a string, or null to clear it`)
        }
        if (Object.keys(data).length > 0) steps.push({ step: 'data', data })
        break
      }
      case 'reset': {
        if (typeof props.reset !== 'boolean') fail('reset must be true or false')
        // `false` is not an error and not a step: it is a caller saying "keep the overrides".
        else if (props.reset) steps.push({ step: 'reset' })
        break
      }
      case 'swap': {
        if (typeof props.swap !== 'string' || props.swap.trim() === '') {
          fail('swap must be a component id or a published key')
        } else steps.push({ step: 'swap', component: props.swap.trim() })
        break
      }
      case 'properties': {
        const value = props.properties
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          fail('properties must be an object of { propertyName: value }')
          break
        }
        const wanted: Record<string, string | boolean> = {}
        for (const [name, setting] of Object.entries(value as Record<string, unknown>)) {
          // Which names exist depends on the component, so that is checked against the instance
          // at apply time; the plan only insists on a value Figma could accept at all.
          if (typeof setting === 'string' || typeof setting === 'boolean') wanted[name] = setting
          else fail(`properties.${name} must be a string or a boolean`)
        }
        if (Object.keys(wanted).length > 0) steps.push({ step: 'properties', properties: wanted })
        else if (Object.keys(value as object).length === 0) fail('properties must name at least one property')
        break
      }
      case 'strokeAlign':
      case 'strokeCap':
      case 'strokeJoin':
      case 'blendMode': {
        const allowed =
          key === 'strokeAlign'
            ? STROKE_ALIGN
            : key === 'strokeCap'
              ? STROKE_CAP
              : key === 'strokeJoin'
                ? STROKE_JOIN
                : BLEND_MODES
        const value = props[key]
        if (typeof value !== 'string' || !allowed.includes(value)) fail(`${key} must be one of: ${allowed.join(', ')}`)
        else steps.push({ step: 'assign', property: key, value })
        break
      }
      case 'strokeDashes': {
        const value = props.strokeDashes
        if (!Array.isArray(value) || value.some((one) => typeof one !== 'number' || !Number.isFinite(one) || one < 0)) {
          fail('strokeDashes must be an array of numbers >= 0 — [] is a solid line')
        } else steps.push({ step: 'dashes', dashes: value as number[] })
        break
      }
      case 'effects': {
        const effects = planEffects(props.effects, `${where}.effects`, problems)
        if (effects) steps.push(effects)
        break
      }
      case 'grid': {
        const grid = planGrids(props.grid, `${where}.grid`, problems)
        if (grid) steps.push(grid)
        break
      }
      case 'animation': {
        const animation = planAnimation(props.animation, `${where}.animation`, problems)
        if (animation) steps.push(animation)
        break
      }
      case 'parent': {
        if (typeof props.parent !== 'string' || props.parent === '') fail('parent must be a node id or "page"')
        else {
          const index = 'index' in props ? number('index', 0) : null
          steps.push({ step: 'reparent', parent: props.parent, ...(index !== null ? { index } : {}) })
        }
        break
      }
      case 'index': {
        // Carried by `reparent`; alone it is a move within the current parent.
        if (!('parent' in props)) {
          const index = number('index', 0)
          if (index !== null) steps.push({ step: 'reparent', parent: '', index })
        }
        break
      }
    }
  }

  // Sizing last, and on purpose. It has to come after the resize (which would otherwise pin the
  // axis it just freed), after the text (a hugging frame sizes to what is in it) and after the
  // reparent, because FILL means nothing until the node is inside the parent it fills.
  const laid = steps.find((step) => step.step === 'layout') as Extract<PropStep, { step: 'layout' }> | undefined
  if (laid) {
    const sizing = laid.layout.sizing ?? {}
    // A frame Figma hands out is 100×100 and FIXED, so `{ layout: { mode: 'VERTICAL' } }` alone
    // makes a box that clips whatever is put in it — which is not what anyone means by turning
    // auto-layout on. Each axis hugs unless the caller pinned it with a size or said otherwise.
    const horizontal = sizing.horizontal ?? (laid.layout.mode && laid.layout.mode !== 'NONE' && !('width' in props) ? 'HUG' : undefined)
    const vertical = sizing.vertical ?? (laid.layout.mode && laid.layout.mode !== 'NONE' && !('height' in props) ? 'HUG' : undefined)
    if (horizontal || vertical) {
      steps.push({ step: 'sizing', ...(horizontal ? { horizontal } : {}), ...(vertical ? { vertical } : {}) })
    }
    delete laid.layout.sizing
  }

  return { steps, problems }
}

const TRIGGERS: Readonly<Record<string, string>> = {
  click: 'ON_CLICK',
  hover: 'ON_HOVER',
  press: 'ON_PRESS',
  drag: 'ON_DRAG',
  timeout: 'AFTER_TIMEOUT',
  keyDown: 'ON_KEY_DOWN',
  mouseEnter: 'MOUSE_ENTER',
  mouseLeave: 'MOUSE_LEAVE',
  mouseUp: 'MOUSE_UP',
  mouseDown: 'MOUSE_DOWN',
}

/** The triggers that carry a wait of their own, in seconds. */
const DELAYED = ['MOUSE_ENTER', 'MOUSE_LEAVE', 'MOUSE_UP', 'MOUSE_DOWN']

/**
 * Figma's curves, and the four spring presets its prototype panel offers under names rather than
 * numbers. `CUSTOM_CUBIC_BEZIER` and `CUSTOM_SPRING` are not in this list because a caller does
 * not name them: they follow from passing `bezier` or `spring`.
 */
const EASINGS = [
  'EASE_IN',
  'EASE_OUT',
  'EASE_IN_AND_OUT',
  'LINEAR',
  'EASE_IN_BACK',
  'EASE_OUT_BACK',
  'EASE_IN_AND_OUT_BACK',
  'GENTLE',
  'QUICK',
  'BOUNCY',
  'SLOW',
]

const DEFAULT_EASING = 'EASE_OUT'

/** A prompt does not shout: `push-left`, `Push_Left` and `PUSH_LEFT` are the same word here. */
function normaliseEnum(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '_')
}

const NAVIGATIONS = ['NAVIGATE', 'SWAP', 'OVERLAY', 'SCROLL_TO', 'CHANGE_TO']
const OVERFLOW = ['NONE', 'HORIZONTAL', 'VERTICAL', 'BOTH']

const STYLE_SLOTS: Readonly<Record<string, 'paint' | 'text' | 'effect' | 'grid'>> = {
  fillStyle: 'paint',
  strokeStyle: 'paint',
  textStyle: 'text',
  effectStyle: 'effect',
  gridStyle: 'grid',
}
const SIMPLE_ANIMATIONS = ['INSTANT', 'DISSOLVE', 'SMART_ANIMATE', 'SCROLL_ANIMATE']
const DIRECTIONAL_ANIMATIONS = ['MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT']
const DIRECTIONS = ['LEFT', 'RIGHT', 'TOP', 'BOTTOM']

const LINK_KEYS = [
  'if',
  'then',
  'else',
  'set',
  'mode',
  'url',
  'newTab',
  'on',
  'after',
  'delay',
  'keys',
  'to',
  'as',
  'animation',
  'duration',
  'easing',
  'bezier',
  'spring',
  'matchLayers',
  'resetScroll',
  'resetVideo',
  'resetInteractive',
]

/** The words a person writes, and the function names Figma stores. */
const COMPARISONS: Readonly<Record<string, string>> = {
  '==': 'EQUALS',
  '=': 'EQUALS',
  'is': 'EQUALS',
  '!=': 'NOT_EQUAL',
  '<': 'LESS_THAN',
  '<=': 'LESS_THAN_OR_EQUAL',
  '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUAL',
  'and': 'AND',
  'or': 'OR',
}

const DEFAULT_DURATION = 0.3
/** Seconds, like everything else a caller says about time here. */
const DEFAULT_TIMEOUT = 1

/**
 * The links out of one node, expanded into Figma's `Reaction`s.
 *
 * Whole rather than merged: `setReactionsAsync` replaces the list, and a vocabulary that quietly
 * added to it would leave no way to remove one. So `links: []` is a caller emptying it, and that
 * is a legitimate thing to ask for rather than a mistake to refuse.
 */
function planLinks(raw: unknown, where: string, problems: string[]): PropStep | null {
  if (!Array.isArray(raw)) {
    problems.push(`${where} must be an array of { on, to } links — [] removes every link`)
    return null
  }

  const links: PlannedLink[] = []
  const destinations: string[] = []

  for (const [index, entry] of raw.entries()) {
    const at = `${where}[${index}]`
    const fail = (message: string) => problems.push(`${at}: ${message}`)
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail('must be { on, to, … }')
      continue
    }
    const link = entry as Record<string, unknown>
    for (const key of Object.keys(link)) {
      if (!LINK_KEYS.includes(key)) fail(`unknown key "${key}" — accepted: ${LINK_KEYS.join(', ')}`)
    }

    const trigger = planTrigger(link, fail)
    if (!trigger) continue

    const actions = planActions(link, fail, destinations)
    if (!actions) continue
    links.push({ trigger, actions })
  }

  return { step: 'links', links, destinations }
}

/**
 * What one link (or one branch of one) does.
 *
 * One interaction, several actions: a link may set a variable, switch a mode and then navigate,
 * which is exactly what Figma's own panel offers and what "go to the next screen and remember
 * that they agreed" means. `null` when something was wrong; the problem is already recorded.
 */
function planActions(
  link: Record<string, unknown>,
  fail: (message: string) => void,
  destinations: string[]
): PlannedAction[] | null {
  const actions: PlannedAction[] = []

  if (link.if !== undefined) {
  if (link.then === undefined) {
    fail('an `if` needs a `then` — what should happen when it holds')
    return null
  }
  const condition = planCondition(link.if, fail, 'if')
  if (!condition) return null
  const yes = planActions(link.then as Record<string, unknown>, fail, destinations)
  if (!yes) return null

  const blocks: Array<{ condition?: PlannedCondition; actions: PlannedAction[] }> = [{ condition, actions: yes }]
  if (link.else !== undefined) {
    // No "else if". Figma's API stores one condition and one else, and both ways of spelling a
    // chain fail differently: three sibling blocks are accepted and SILENTLY TRUNCATED to two,
    // with the middle condition dropped — the prototype then takes that branch unconditionally —
    // and a conditional nested inside the else is refused outright ("Invalid enum value.
    // Expected 'BACK' | 'CLOSE', received 'CONDITIONAL'"). Both were tried against a real file.
    // So the chain is refused here, where the reason can be given and a way round it named.
    if ((link.else as Record<string, unknown>)?.if !== undefined) {
      fail(
        'an `else` cannot ask another question — Figma stores one condition and one else. Write the ' +
          'branches as separate links on the same trigger, with conditions that cannot both hold'
      )
      return null
    }
    const otherwise = planActions(link.else as Record<string, unknown>, fail, destinations)
    if (!otherwise) return null
    blocks.push({ actions: otherwise })
  }
  actions.push({ kind: 'conditional', blocks })
  }

  if (link.set !== undefined) {
    const set = link.set as { variable?: string; value?: unknown }
    if (typeof set?.variable !== 'string' || set.variable.trim() === '') {
      fail('set.variable must name a variable')
      return null
    }
    const value = set.value
    const alias = value as { variable?: unknown } | null
    const usable =
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (typeof value === 'object' && value !== null && typeof alias?.variable === 'string')
    if (!usable) {
      fail('set.value must be a string, a number, a boolean, or { variable } to copy another one')
      return null
    }
    actions.push({
      kind: 'setVariable',
      variable: set.variable.trim(),
      value: value as string | number | boolean | { variable: string },
    })
  }

  if (link.mode !== undefined) {
    const mode = link.mode as { collection?: unknown; mode?: unknown }
    if (typeof mode?.collection !== 'string' || typeof mode?.mode !== 'string') {
      fail('mode must be { collection: "Semantic", mode: "Dark" }')
      return null
    }
    actions.push({ kind: 'setMode', collection: mode.collection.trim(), mode: mode.mode.trim() })
  }

  if (link.url !== undefined) {
    if (typeof link.url !== 'string' || link.url.trim() === '') {
      fail('url must be a link to open')
      return null
    }
    actions.push({ kind: 'url', url: link.url.trim(), newTab: link.newTab !== false })
  }

  if (link.to !== undefined) {
  const navigation = planNavigation(link, fail, destinations)
  if (!navigation) return null
  actions.push(navigation)
  }

  // Checked here rather than at the top, so an empty BRANCH is caught too: `then: {}` planned a
  // question whose answer was to do nothing — a link that silently does nothing half the time.
  if (actions.length === 0) {
  fail('a link must do something — name a `to`, a `set`, a `mode`, a `url` or an `if`')
  return null
  }
  return actions
}

/** The question itself: two sides, a comparison, and nothing resolved yet. */
function planCondition(raw: unknown, fail: (message: string) => void, where: string): PlannedCondition | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`${where} must be { left, is, right }`)
    return null
  }
  const spec = raw as { left?: unknown; is?: unknown; right?: unknown }
  const fn = typeof spec.is === 'string' ? COMPARISONS[spec.is.trim().toLowerCase()] : undefined
  if (!fn) {
    fail(`${where}.is must be one of: ${Object.keys(COMPARISONS).join(', ')}`)
    return null
  }
  const left = planOperand(spec.left, fail, `${where}.left`)
  const right = planOperand(spec.right, fail, `${where}.right`)
  if (!left || !right) return null
  return { fn, args: [left, right] }
}

function planOperand(raw: unknown, fail: (message: string) => void, where: string): PlannedOperand | null {
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return { kind: 'literal', value: raw }
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const named = raw as { variable?: unknown; is?: unknown }
    if (typeof named.variable === 'string' && named.variable.trim() !== '') {
      return { kind: 'variable', name: named.variable.trim() }
    }
    // A side that is itself a comparison: `and` and `or` are how two questions become one.
    if (named.is !== undefined) {
      const nested = planCondition(raw, fail, where)
      return nested ? { kind: 'condition', condition: nested } : null
    }
  }
  fail(`${where} must be a value, { variable }, or another { left, is, right }`)
  return null
}

/** The trigger half: which gesture, and whatever that gesture carries. */
function planTrigger(link: Record<string, unknown>, fail: (message: string) => void): Trigger | null {
  const asked = link.on === undefined ? 'click' : link.on
  const on =
    typeof asked === 'string'
      ? (Object.keys(TRIGGERS).find((word) => word.toLowerCase() === asked.toLowerCase()) ?? '')
      : ''
  if (on === '') {
    fail(`on must be one of: ${Object.keys(TRIGGERS).join(', ')}`)
    return null
  }

  const type = TRIGGERS[on]
  // A wait on a click, key codes on a hover: Figma's trigger simply has no such field, so it
  // would be dropped without a word — which is how somebody ends up believing in a delay that
  // never existed.
  if (link.after !== undefined && type !== 'AFTER_TIMEOUT') {
    fail(`after only applies to a timeout trigger, not to ${on}`)
    return null
  }
  if (link.delay !== undefined && !DELAYED.includes(type)) {
    fail(`delay only applies to mouseEnter, mouseLeave, mouseUp and mouseDown, not to ${on}`)
    return null
  }
  if (link.keys !== undefined && type !== 'ON_KEY_DOWN') {
    fail(`keys only applies to keyDown, not to ${on}`)
    return null
  }

  const after = link.after === undefined ? DEFAULT_TIMEOUT : link.after
  if (type === 'AFTER_TIMEOUT' && (typeof after !== 'number' || !Number.isFinite(after) || after <= 0)) {
    fail('after must be a number of seconds greater than 0')
    return null
  }
  const delay = link.delay === undefined ? 0 : link.delay
  if (DELAYED.includes(type) && (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0)) {
    fail('delay must be a number of seconds >= 0')
    return null
  }
  if (type === 'ON_KEY_DOWN') {
    const keys = link.keys
    if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== 'number' || !Number.isInteger(key))) {
      fail('keyDown needs keys: an array of key codes, e.g. [13] for Enter')
      return null
    }
  }

  // Seconds in, milliseconds out. Figma stores a trigger's `timeout` and `delay` in
  // milliseconds and a transition's `duration` in seconds — its own documentation says the first
  // and its own example shows the second (0.20000000298023224). A vocabulary that passed that
  // inconsistency on would have callers writing 2 for two seconds in one field and 2000 in the
  // next; here everything is seconds and the conversion happens once.
  if (type === 'AFTER_TIMEOUT') return { type, timeout: (after as number) * 1000 } as Trigger
  if (type === 'ON_KEY_DOWN') return { type, device: 'KEYBOARD', keyCodes: link.keys as number[] } as Trigger
  if (DELAYED.includes(type)) {
    // Just the delay, in milliseconds. The typings AND the documentation put a
    // `deprecatedVersion` flag on MOUSE_ENTER / MOUSE_LEAVE, and the runtime that ships today
    // refuses it outright:
    //   Unrecognized key(s) in object: 'deprecatedVersion' at [0].trigger
    // Found by the first hover link built in Figma. The docs are ahead of the host, not behind.
    return { type, delay: (delay as number) * 1000 } as Trigger
  }
  return { type } as Trigger
}

/** The going-somewhere half, including the two places that are not a node. */
function planNavigation(
  link: Record<string, unknown>,
  fail: (message: string) => void,
  destinations: string[]
): PlannedAction | null {
  if (typeof link.to !== 'string' || link.to.trim() === '') {
    fail('to must be a node id, "back" or "close"')
    return null
  }
  const to = link.to.trim()
  const target = to.toLowerCase()
  if (target === 'back') return { kind: 'back' }
  if (target === 'close') return { kind: 'close' }

  const navigation = link.as === undefined ? 'NAVIGATE' : link.as
  if (typeof navigation !== 'string' || !NAVIGATIONS.includes(normaliseEnum(navigation))) {
    fail(`as must be one of: ${NAVIGATIONS.join(', ')}`)
    return null
  }
  const duration = link.duration === undefined ? DEFAULT_DURATION : link.duration
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 10) {
    fail('duration must be a number of seconds between 0 and 10')
    return null
  }

  const easing = buildEasing(link, fail)
  if (easing === null) return null

  const animation = link.animation === undefined ? 'INSTANT' : link.animation
  if (typeof animation !== 'string') {
    fail('animation must be a string')
    return null
  }
  if (link.matchLayers !== undefined && typeof link.matchLayers !== 'boolean') {
    fail('matchLayers must be true or false')
    return null
  }
  const transition = buildTransition(normaliseEnum(animation), duration, easing, link.matchLayers === true)
  if (transition === undefined) {
    fail(
      `animation must be one of: ${SIMPLE_ANIMATIONS.join(', ')}, or ` +
        `${DIRECTIONAL_ANIMATIONS.join('/')} with _${DIRECTIONS.join('/_')}`
    )
    return null
  }

  for (const flag of ['resetScroll', 'resetVideo', 'resetInteractive'] as const) {
    if (link[flag] !== undefined && typeof link[flag] !== 'boolean') {
      fail(`${flag} must be true or false`)
      return null
    }
  }

  destinations.push(to)
  return {
    kind: 'node',
    destinationId: to,
    navigation: normaliseEnum(navigation) as Navigation,
    transition,
    ...(typeof link.resetScroll === 'boolean' ? { resetScroll: link.resetScroll } : {}),
    ...(typeof link.resetVideo === 'boolean' ? { resetVideo: link.resetVideo } : {}),
    ...(typeof link.resetInteractive === 'boolean' ? { resetInteractive: link.resetInteractive } : {}),
  }
}

/**
 * The inverse: reactions as the one line a caller could have written.
 *
 * A read that answers with Figma's own five nested objects per link is a read nobody can act on
 * — and the agent channel's digest would summarise it away long before it arrived.
 */
/**
 * The shape of a conditional, as the sentence somebody wrote.
 *
 * Figma does not keep an "else if" as a third block: it stores a two-block conditional whose
 * else contains another conditional, and reading only the top level reported three branches back
 * as two — a caller seeing less than they wrote and wondering what was dropped. So the walk
 * follows that nesting and counts the branches a person would count.
 */
async function describeBranches(
  blocks: readonly ConditionalBlock[],
  nameOf?: (id: string, withinCollection?: string) => Promise<string | null>,
  depth = 0
): Promise<string> {
  const parts: string[] = []
  for (const [index, block] of blocks.entries()) {
    const inside: string[] = []
    for (const action of block.actions) inside.push(await describeAction(action, nameOf, depth + 1))
    const label = block.condition ? (index === 0 && depth === 0 ? 'if' : 'else if') : 'else'
    parts.push(`${label} {${inside.join(' · ') || 'nothing'}}`)
  }
  return parts.join(' ')
}

/** Figma keeps these as 32-bit floats, so a duration set to 0.6 reads back as
 * 0.6000000238418579 — noise in every line that quotes one. */
function seconds(value: number): string {
  return `${Math.round(value * 1000) / 1000}s`
}

export async function describeLinks(
  reactions: readonly Reaction[],
  /** Turns an id into a name. A mode is asked for with the collection it belongs to, since its
   * id means nothing on its own. */
  nameOf?: (id: string, withinCollection?: string) => Promise<string | null>
): Promise<string> {
  const spelling: Record<string, string> = {}
  for (const [word, type] of Object.entries(TRIGGERS)) spelling[type] = word

  const parts: string[] = []
  for (const reaction of reactions) {
    const trigger = reaction.trigger
    let on = trigger ? spelling[trigger.type] ?? trigger.type.toLowerCase() : 'nothing'
    // The wait is the whole of what a timeout link says; a bare "timeout" hides it. Same for the
    // keys of a key trigger and the delay of a mouse one.
    if (trigger) {
      // Back to seconds on the way out, for the same reason they went in that way.
      if (trigger.type === 'AFTER_TIMEOUT') on = `${on} ${seconds(trigger.timeout / 1000)}`
      else if (trigger.type === 'ON_KEY_DOWN') on = `${on} [${(trigger.keyCodes ?? []).join(',')}]`
      else if ('delay' in trigger && trigger.delay) on = `${on} ${seconds(trigger.delay / 1000)}`
    }
    const actions = reaction.actions ?? (reaction.action ? [reaction.action] : [])
    for (const action of actions) parts.push(`${on} → ${await describeAction(action, nameOf)}`)
  }
  return parts.join(' · ')
}

/** One action, without the trigger in front of it — so a branch reads the same way a link does. */
async function describeAction(
  action: Action,
  nameOf?: (id: string, withinCollection?: string) => Promise<string | null>,
  depth = 0
): Promise<string> {
  if (action.type === 'BACK' || action.type === 'CLOSE') return action.type.toLowerCase()
  if (action.type === 'URL') return `open ${action.url}`

  if (action.type === 'SET_VARIABLE') {
    // The id is no use to anyone reading a report, so the caller may hand over a lookup — the
    // same trade the paints make.
    const named = action.variableId && nameOf ? await nameOf(action.variableId) : null
    const value = action.variableValue?.value
    const shown =
      value !== null && typeof value === 'object' && 'id' in (value as object)
        ? `var:${(nameOf ? await nameOf((value as { id: string }).id) : null) ?? (value as { id: string }).id}`
        : JSON.stringify(value)
    return `set ${named ?? action.variableId} = ${shown}`
  }

  if (action.type === 'SET_VARIABLE_MODE') {
    const collection = action.variableCollectionId
    const named = collection && nameOf ? await nameOf(collection) : null
    const mode = action.variableModeId && nameOf ? await nameOf(action.variableModeId, collection ?? undefined) : null
    return `mode ${named ?? collection} = ${mode ?? action.variableModeId}`
  }

  if (action.type === 'CONDITIONAL') return describeBranches(action.conditionalBlocks, nameOf, depth)
  if (action.type !== 'NODE') return action.type.toLowerCase()

  const transition = action.transition
  const named = transition
    ? `${transition.type}${'direction' in transition ? `_${transition.direction}` : ''} ${seconds(transition.duration)}` +
      `${transition.easing.type === DEFAULT_EASING ? '' : ` ${transition.easing.type}`}` +
      `${'matchLayers' in transition && transition.matchLayers ? ' +match' : ''}`
    : 'INSTANT'
  const navigation = action.navigation === 'NAVIGATE' ? '' : ` (${action.navigation})`
  return `${action.destinationId ?? '?'}${navigation}${named === 'INSTANT' ? '' : ` ${named}`}`
}

/**
 * The curve, from a name, four numbers or a spring.
 *
 * `null` when something was wrong — the problem has been recorded by then. Naming both a curve
 * and numbers is refused rather than resolved: which one the caller meant is a guess, and a
 * wrong guess here is invisible until someone plays the prototype.
 */
function buildEasing(link: Record<string, unknown>, fail: (message: string) => void): Easing | null {
  const named = link.easing === undefined ? null : normaliseEnum(String(link.easing))
  const custom = [link.bezier !== undefined ? 'bezier' : '', link.spring !== undefined ? 'spring' : ''].filter(Boolean)

  if (custom.length > 1) {
    fail('name either a bezier or a spring, not both')
    return null
  }
  if (custom.length === 1 && named && named !== `CUSTOM_${custom[0].toUpperCase()}` && named !== 'CUSTOM_CUBIC_BEZIER') {
    fail(`easing "${named}" and a ${custom[0]} say different things — pass one`)
    return null
  }

  if (link.bezier !== undefined) {
    const curve = link.bezier
    if (
      !Array.isArray(curve) ||
      curve.length !== 4 ||
      curve.some((one) => typeof one !== 'number' || !Number.isFinite(one))
    ) {
      fail('bezier must be [x1, y1, x2, y2]')
      return null
    }
    const [x1, y1, x2, y2] = curve as number[]
    return { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1, y1, x2, y2 } }
  }

  if (link.spring !== undefined) {
    const spring = link.spring
    if (typeof spring !== 'object' || spring === null || Array.isArray(spring)) {
      fail('spring must be { mass, stiffness, damping }')
      return null
    }
    const values = spring as Record<string, unknown>
    for (const field of ['mass', 'stiffness', 'damping']) {
      if (typeof values[field] !== 'number' || !Number.isFinite(values[field] as number) || (values[field] as number) <= 0) {
        fail(`spring.${field} must be a number > 0`)
        return null
      }
    }
    if (values.initialVelocity !== undefined && typeof values.initialVelocity !== 'number') {
      fail('spring.initialVelocity must be a number')
      return null
    }
    return {
      type: 'CUSTOM_SPRING',
      easingFunctionSpring: {
        mass: values.mass as number,
        stiffness: values.stiffness as number,
        damping: values.damping as number,
        initialVelocity: (values.initialVelocity as number) ?? 0,
      },
    }
  }

  if (named === null) return { type: DEFAULT_EASING as Easing['type'] }
  if (!EASINGS.includes(named)) {
    fail(`easing must be one of: ${EASINGS.join(', ')} — or pass bezier / spring`)
    return null
  }
  return { type: named as Easing['type'] }
}

/** `undefined` for a name that is not an animation at all; `null` for INSTANT, which has none. */
function buildTransition(
  animation: string,
  duration: number,
  easing: Easing,
  matchLayers: boolean
): Transition | null | undefined {
  if (animation === 'INSTANT') return null
  if (SIMPLE_ANIMATIONS.includes(animation)) {
    return { type: animation as SimpleTransition['type'], easing, duration }
  }
  const cut = animation.lastIndexOf('_')
  const base = cut === -1 ? '' : animation.slice(0, cut)
  const direction = cut === -1 ? '' : animation.slice(cut + 1)
  if (!DIRECTIONAL_ANIMATIONS.includes(base) || !DIRECTIONS.includes(direction)) return undefined
  return {
    type: base as DirectionalTransition['type'],
    direction: direction as DirectionalTransition['direction'],
    matchLayers,
    easing,
    duration,
  }
}

const DECORATIONS = ['NONE', 'UNDERLINE', 'STRIKETHROUGH']
const TEXT_CASES = ['ORIGINAL', 'UPPER', 'LOWER', 'TITLE']
const RUN_KEYS = [
  'from',
  'to',
  'match',
  'fontName',
  'fontSize',
  'fill',
  'textDecoration',
  'textCase',
  'letterSpacing',
  'lineHeight',
  'link',
]

/** Validates the shape of each run; which characters it covers is decided against the text
 * itself, at apply time, by {@link resolveRanges}. */
function planRuns(raw: unknown, where: string, problems: string[]): PropStep | null {
  if (!Array.isArray(raw)) {
    problems.push(`${where} must be an array of { from, to } or { match } runs`)
    return null
  }

  const runs: TextRun[] = []
  for (const [index, entry] of raw.entries()) {
    const at = `${where}[${index}]`
    const fail = (message: string) => problems.push(`${at}: ${message}`)
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail('must be an object')
      continue
    }
    const run = entry as Record<string, unknown>
    for (const key of Object.keys(run)) {
      if (!RUN_KEYS.includes(key)) fail(`unknown key "${key}" — accepted: ${RUN_KEYS.join(', ')}`)
    }

    const hasRange = run.from !== undefined || run.to !== undefined
    if (run.match !== undefined && hasRange) {
      fail('name either a match or a from/to range, not both')
      continue
    }
    if (run.match !== undefined) {
      if (typeof run.match !== 'string' || run.match === '') {
        fail('match must be a non-empty string')
        continue
      }
    } else {
      const from = run.from
      const to = run.to
      if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) {
        fail('from must be a whole number >= 0')
        continue
      }
      if (typeof to !== 'number' || !Number.isInteger(to) || to <= from) {
        fail('to must be a whole number greater than from')
        continue
      }
    }

    let bad = false
    const check = (key: string, ok: boolean, message: string) => {
      if (run[key] !== undefined && !ok) {
        fail(message)
        bad = true
      }
    }
    check(
      'fontName',
      typeof run.fontName === 'object' &&
        run.fontName !== null &&
        typeof (run.fontName as { family?: unknown }).family === 'string' &&
        typeof (run.fontName as { style?: unknown }).style === 'string',
      'fontName must be { family, style }'
    )
    check('fontSize', typeof run.fontSize === 'number' && run.fontSize > 0, 'fontSize must be a number > 0')
    check('letterSpacing', typeof run.letterSpacing === 'number', 'letterSpacing must be a number')
    check(
      'lineHeight',
      run.lineHeight === 'AUTO' || (typeof run.lineHeight === 'number' && run.lineHeight > 0),
      'lineHeight must be a positive number or "AUTO"'
    )
    check(
      'textDecoration',
      typeof run.textDecoration === 'string' && DECORATIONS.includes(run.textDecoration),
      `textDecoration must be one of: ${DECORATIONS.join(', ')}`
    )
    check(
      'textCase',
      typeof run.textCase === 'string' && TEXT_CASES.includes(run.textCase),
      `textCase must be one of: ${TEXT_CASES.join(', ')}`
    )
    check('link', typeof run.link === 'string' || run.link === null, 'link must be a URL, or null to remove one')
    if (run.fill !== undefined) {
      const problem = paintProblem(run.fill)
      if (problem) {
        fail(`fill: ${problem}`)
        bad = true
      }
    }
    if (bad) continue

    const styling = Object.keys(run).filter((key) => !['from', 'to', 'match'].includes(key))
    if (styling.length === 0) {
      fail('a run that sets nothing styles nothing — say what should change')
      continue
    }

    runs.push(run as TextRun)
  }

  return { step: 'runs', runs }
}

/**
 * Which characters a run covers, given the text it is applied to.
 *
 * Pure, and separate from the applier, because this is the half that can be wrong in ways nobody
 * would see: a range past the end of the string, a match that appears twice, a match that appears
 * not at all.
 */
export function resolveRanges(characters: string, run: TextRun): { ranges: Array<[number, number]>; problem?: string } {
  if (run.match !== undefined) {
    const ranges: Array<[number, number]> = []
    let at = characters.indexOf(run.match)
    while (at !== -1) {
      ranges.push([at, at + run.match.length])
      at = characters.indexOf(run.match, at + run.match.length)
    }
    if (ranges.length === 0) return { ranges: [], problem: `"${run.match}" is not in this text` }
    return { ranges }
  }

  const from = run.from as number
  const to = run.to as number
  if (from >= characters.length) {
    return { ranges: [], problem: `from ${from} is past the end of ${characters.length} character(s)` }
  }
  // A `to` past the end is clamped rather than refused: "from 8 to the end" is a reasonable thing
  // to mean, and the alternative is making every caller count characters first.
  return { ranges: [[from, Math.min(to, characters.length)]] }
}

/**
 * Shadows and blurs, expanded into Figma's `Effect`s.
 *
 * Figma spells a shadow as a colour with an alpha, a vector, a radius, a spread, a blend mode and
 * a visibility — six fields, of which a caller means two. So the defaults are the ones a designer
 * would reach for (black at a quarter, four down, eight of blur) and the rest is named only when
 * it differs. `[]` removes what a node has, for the same reason `links: []` does.
 */
function planEffects(raw: unknown, where: string, problems: string[]): PropStep | null {
  if (!Array.isArray(raw)) {
    problems.push(`${where} must be an array of shadows and blurs — [] removes them`)
    return null
  }

  const effects: Effect[] = []
  const bind: Array<{ index: number; field: string; variable: string }> = []
  const summary: string[] = []

  for (const [index, entry] of raw.entries()) {
    const at = `${where}[${index}]`
    const fail = (message: string) => problems.push(`${at}: ${message}`)
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail('must be { shadow } or { blur }')
      continue
    }
    const spec = entry as Record<string, unknown>

    /** A number, or the name of a variable to bind to that field afterwards. */
    const measure = (value: unknown, fallback: number, field: string, label: string): number | null => {
      if (value === undefined) return fallback
      if (typeof value === 'number' && Number.isFinite(value)) return value
      const named = value as { variable?: unknown }
      if (typeof named?.variable === 'string' && named.variable.trim() !== '') {
        bind.push({ index: effects.length, field, variable: named.variable.trim() })
        // Figma wants a number in the effect whatever happens; the binding replaces it.
        return fallback
      }
      fail(`${label} must be a number or { variable }`)
      return null
    }

    if (typeof spec.blur === 'string') {
      const kind = spec.blur.toLowerCase()
      if (kind !== 'layer' && kind !== 'background') {
        fail('blur must be "layer" or "background"')
        continue
      }
      const radius = measure(spec.radius, 0, 'radius', 'radius')
      if (radius === null) continue
      if (spec.radius === undefined) {
        fail('radius must be a number >= 0')
        continue
      }
      effects.push({
        type: kind === 'layer' ? 'LAYER_BLUR' : 'BACKGROUND_BLUR',
        blurType: 'NORMAL',
        radius,
        visible: spec.visible !== false,
      } as Effect)
      summary.push(`${kind} blur ${radius}`)
      continue
    }

    if (typeof spec.shadow !== 'string') {
      fail('must carry either `shadow` ("drop" / "inner") or `blur` ("layer" / "background")')
      continue
    }
    const kind = spec.shadow.toLowerCase()
    if (kind !== 'drop' && kind !== 'inner') {
      fail('shadow must be "drop" or "inner"')
      continue
    }
    for (const unknownKey of Object.keys(spec)) {
      if (!['shadow', 'color', 'opacity', 'offset', 'radius', 'spread', 'visible'].includes(unknownKey)) {
        fail(`unknown key "${unknownKey}" — accepted: shadow, color, opacity, offset, radius, spread, visible`)
      }
    }

    let hex = '#000000'
    const named = spec.color as { variable?: unknown } | undefined
    if (typeof named?.variable === 'string' && named.variable.trim() !== '') {
      bind.push({ index: effects.length, field: 'color', variable: named.variable.trim() })
    } else if (spec.color !== undefined) {
      if (typeof spec.color !== 'string' || !HEX.test(spec.color)) {
        fail('color must be a #RRGGBB colour or { variable }')
        continue
      }
      hex = spec.color
    }
    const rgb = parseHex(hex)
    if (!rgb) {
      fail(`"${hex}" is not a colour`)
      continue
    }
    const alpha = spec.opacity === undefined ? 0.25 : spec.opacity
    if (typeof alpha !== 'number' || alpha < 0 || alpha > 1) {
      fail('opacity must be between 0 and 1')
      continue
    }
    const offset = spec.offset === undefined ? [0, 4] : spec.offset
    if (!Array.isArray(offset) || offset.length !== 2) {
      fail('offset must be [x, y]')
      continue
    }
    const x = measure(offset[0], 0, 'offsetX', 'offset[0]')
    const y = measure(offset[1], 4, 'offsetY', 'offset[1]')
    const radius = measure(spec.radius, 8, 'radius', 'radius')
    const spread = measure(spec.spread, 0, 'spread', 'spread')
    if (x === null || y === null || radius === null || spread === null) continue

    effects.push({
      type: kind === 'drop' ? 'DROP_SHADOW' : 'INNER_SHADOW',
      color: { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha },
      offset: { x, y },
      radius,
      spread,
      visible: spec.visible !== false,
      blendMode: 'NORMAL',
    } as Effect)
    summary.push(
      `${kind} shadow ${hex}${alpha === 1 ? '' : ` @${alpha}`} ${x},${y} blur ${radius}${spread ? ` spread ${spread}` : ''}`
    )
  }

  return { step: 'effects', effects, bind, summary: summary.join(' · ') || 'none' }
}

/**
 * Animation styles, checked as far as they can be and no further.
 *
 * Which settings a style takes is Figma's business and it says so in MOTION_STYLES — a prop is
 * accepted if it is something Figma can hold: a string, a number, a boolean, `{ variable }` to
 * follow a token, or, for the one prop every style calls `easing`, the same curve vocabulary the
 * prototype links use.
 */
function planAnimation(raw: unknown, where: string, problems: string[]): PropStep | null {
  // `null` and `[]` both mean "take the animation off", the way they do for links and effects.
  const wanted = raw === null ? [] : Array.isArray(raw) ? raw : [raw]

  const styles: Array<{ style: string; duration?: number; offset?: number; props: Record<string, unknown> }> = []
  const summary: string[] = []

  for (const [index, entry] of wanted.entries()) {
    const at = `${where}[${index}]`
    const fail = (message: string) => problems.push(`${at}: ${message}`)
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail('must be { style, duration?, offset?, props? }')
      continue
    }
    const spec = entry as Record<string, unknown>
    for (const key of Object.keys(spec)) {
      if (!['style', 'duration', 'offset', 'props'].includes(key)) {
        fail(`unknown key "${key}" — accepted: style, duration, offset, props`)
      }
    }
    if (typeof spec.style !== 'string' || spec.style.trim() === '') {
      fail('style must name one of the styles MOTION_STYLES lists, e.g. "Position"')
      continue
    }
    let wrong = false
    for (const seconds of ['duration', 'offset'] as const) {
      const value = spec[seconds]
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        fail(`${seconds} must be a number of seconds >= 0`)
        wrong = true
      }
    }
    if (wrong) continue

    const settings: Record<string, unknown> = {}
    if (spec.props !== undefined) {
      if (typeof spec.props !== 'object' || spec.props === null || Array.isArray(spec.props)) {
        fail('props must be an object of the settings that style takes')
        continue
      }
      for (const [name, value] of Object.entries(spec.props as Record<string, unknown>)) {
        if (name === 'easing') {
          const easing = buildEasing(
            typeof value === 'string' ? { easing: value } : (value as Record<string, unknown>),
            (message) => fail(`props.easing: ${message}`)
          )
          if (!easing) {
            wrong = true
            break
          }
          settings.easing = easing
          continue
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          settings[name] = value
          continue
        }
        const named = value as { variable?: unknown }
        if (typeof named?.variable === 'string' && named.variable.trim() !== '') {
          settings[name] = { variable: named.variable.trim() }
          continue
        }
        fail(`props.${name} must be a string, a number, a boolean or { variable }`)
        wrong = true
        break
      }
    }
    if (wrong) continue

    styles.push({
      style: spec.style.trim(),
      ...(spec.duration === undefined ? {} : { duration: spec.duration as number }),
      ...(spec.offset === undefined ? {} : { offset: spec.offset as number }),
      props: settings,
    })
    const said = Object.entries(settings)
      .map(([name, value]) => `${name}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join(', ')
    summary.push(
      `${spec.style.trim()}${spec.duration === undefined ? '' : ` ${spec.duration}s`}${said ? ` (${said})` : ''}`
    )
  }

  return { step: 'animation', styles, summary: summary.join(' · ') || 'none' }
}

const STROKE_CAPS = ['NONE', 'ROUND', 'SQUARE', 'ARROW_LINES', 'ARROW_EQUILATERAL']
const JOINS = ['MITER', 'BEVEL', 'ROUND']

/**
 * Points, segments and regions, checked against each other.
 *
 * The checks are the reason this is worth writing down: a segment naming a vertex that does not
 * exist, or a region naming a segment that does not, is accepted by nobody and reported by
 * Figma as a failure with no index in it. Here the index is still in hand.
 */
function planNetwork(raw: unknown, where: string, problems: string[]): PropStep | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push(`${where} must be { vertices, segments, regions? }`)
    return null
  }
  const spec = raw as { vertices?: unknown; segments?: unknown; regions?: unknown }
  for (const key of Object.keys(spec)) {
    if (!['vertices', 'segments', 'regions'].includes(key)) {
      problems.push(`${where}: unknown key "${key}" — accepted: vertices, segments, regions`)
    }
  }
  if (!Array.isArray(spec.vertices) || spec.vertices.length < 2) {
    problems.push(`${where}.vertices must be an array of at least two points`)
    return null
  }
  if (!Array.isArray(spec.segments) || spec.segments.length < 1) {
    problems.push(`${where}.segments must be an array of at least one { start, end }`)
    return null
  }

  const vertices: VectorVertex[] = []
  for (const [index, entry] of spec.vertices.entries()) {
    const at = `${where}.vertices[${index}]`
    if (Array.isArray(entry)) {
      if (entry.length !== 2 || entry.some((one) => typeof one !== 'number' || !Number.isFinite(one))) {
        problems.push(`${at} must be [x, y]`)
        continue
      }
      vertices.push({ x: entry[0] as number, y: entry[1] as number })
      continue
    }
    if (typeof entry !== 'object' || entry === null) {
      problems.push(`${at} must be [x, y] or { x, y }`)
      continue
    }
    const point = entry as Record<string, unknown>
    if (typeof point.x !== 'number' || typeof point.y !== 'number') {
      problems.push(`${at} must carry x and y`)
      continue
    }
    if (point.cap !== undefined && (typeof point.cap !== 'string' || !STROKE_CAPS.includes(point.cap))) {
      problems.push(`${at}.cap must be one of: ${STROKE_CAPS.join(', ')}`)
      continue
    }
    if (point.join !== undefined && (typeof point.join !== 'string' || !JOINS.includes(point.join))) {
      problems.push(`${at}.join must be one of: ${JOINS.join(', ')}`)
      continue
    }
    if (point.cornerRadius !== undefined && (typeof point.cornerRadius !== 'number' || point.cornerRadius < 0)) {
      problems.push(`${at}.cornerRadius must be a number >= 0`)
      continue
    }
    vertices.push({
      x: point.x,
      y: point.y,
      ...(point.cap ? { strokeCap: point.cap as StrokeCap } : {}),
      ...(point.join ? { strokeJoin: point.join as StrokeJoin } : {}),
      ...(point.cornerRadius === undefined ? {} : { cornerRadius: point.cornerRadius }),
    })
  }

  const segments: VectorSegment[] = []
  for (const [index, entry] of spec.segments.entries()) {
    const at = `${where}.segments[${index}]`
    const pair = Array.isArray(entry) ? { start: entry[0], end: entry[1], curve: undefined } : (entry as Record<string, unknown>)
    if (typeof pair?.start !== 'number' || typeof pair?.end !== 'number') {
      problems.push(`${at} must be [start, end] or { start, end }`)
      continue
    }
    const ends = [pair.start, pair.end]
    const stray = ends.find((one) => !Number.isInteger(one) || one < 0 || one >= vertices.length)
    if (stray !== undefined) {
      problems.push(`${at}: there is no vertex ${stray} — the network has ${vertices.length}`)
      continue
    }
    if (pair.start === pair.end) {
      problems.push(`${at}: a segment cannot start and end at the same point`)
      continue
    }
    let curve: { tangentStart: Vector; tangentEnd: Vector } | null = null
    if (pair.curve !== undefined) {
      const bend = pair.curve
      if (!Array.isArray(bend) || bend.length !== 4 || bend.some((one) => typeof one !== 'number')) {
        problems.push(`${at}.curve must be [x1, y1, x2, y2] — the two tangents, each relative to its own end`)
        continue
      }
      curve = {
        tangentStart: { x: bend[0] as number, y: bend[1] as number },
        tangentEnd: { x: bend[2] as number, y: bend[3] as number },
      }
    }
    segments.push({ start: pair.start, end: pair.end, ...(curve ?? {}) })
  }

  const regions: VectorRegion[] = []
  if (spec.regions !== undefined) {
    if (!Array.isArray(spec.regions)) {
      problems.push(`${where}.regions must be an array of { loops }`)
      return null
    }
    for (const [index, entry] of spec.regions.entries()) {
      const at = `${where}.regions[${index}]`
      const region = entry as { loops?: unknown; windingRule?: unknown }
      if (!Array.isArray(region?.loops) || region.loops.length === 0) {
        problems.push(`${at}.loops must be an array of loops, each a list of segment indices`)
        continue
      }
      const rule = region.windingRule === undefined ? 'NONZERO' : region.windingRule
      if (rule !== 'NONZERO' && rule !== 'EVENODD') {
        problems.push(`${at}.windingRule must be NONZERO or EVENODD`)
        continue
      }
      let broken = false
      for (const loop of region.loops) {
        if (!Array.isArray(loop) || loop.length === 0) {
          problems.push(`${at}: every loop must be a list of segment indices`)
          broken = true
          break
        }
        const stray = loop.find((one) => typeof one !== 'number' || !Number.isInteger(one) || one < 0 || one >= segments.length)
        if (stray !== undefined) {
          problems.push(`${at}: there is no segment ${stray} — the network has ${segments.length}`)
          broken = true
          break
        }
      }
      if (broken) continue
      regions.push({ windingRule: rule, loops: region.loops as number[][] })
    }
  }

  return {
    step: 'network',
    network: { vertices, segments, ...(regions.length > 0 ? { regions } : {}) },
    summary: `${vertices.length} point(s), ${segments.length} segment(s)${regions.length ? `, ${regions.length} region(s)` : ''}`,
  }
}

const GRID_ALIGN = ['MIN', 'MAX', 'CENTER', 'STRETCH']

/**
 * Layout grids, from the sentence a designer would say.
 *
 * Figma spells a column grid as a pattern, an alignment, a gutter, a count and a section size,
 * where "24 in from each side" is an alignment of STRETCH and an offset. So `margin` sets that,
 * and naming a `width` instead pins the columns and lets the margins fall where they will.
 */
function planGrids(raw: unknown, where: string, problems: string[]): PropStep | null {
  if (!Array.isArray(raw)) {
    problems.push(`${where} must be an array of grids — [] removes them`)
    return null
  }

  const grids: LayoutGrid[] = []
  const summary: string[] = []

  for (const [index, entry] of raw.entries()) {
    const at = `${where}[${index}]`
    const fail = (message: string) => problems.push(`${at}: ${message}`)
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail('must be { columns }, { rows } or { square }')
      continue
    }
    const spec = entry as Record<string, unknown>

    const paint = (): { color?: RGBA } | null => {
      if (spec.color === undefined) return {}
      if (typeof spec.color !== 'string' || !HEX.test(spec.color)) {
        fail('color must be a #RRGGBB colour')
        return null
      }
      const rgb = parseHex(spec.color)
      if (!rgb) {
        fail(`"${spec.color}" is not a colour`)
        return null
      }
      const alpha = spec.opacity === undefined ? 0.1 : spec.opacity
      if (typeof alpha !== 'number' || alpha < 0 || alpha > 1) {
        fail('opacity must be between 0 and 1')
        return null
      }
      return { color: { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha } }
    }

    if (spec.square !== undefined) {
      const size = spec.square
      if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
        fail('square must be a cell size greater than 0')
        continue
      }
      const colour = paint()
      if (!colour) continue
      grids.push({ pattern: 'GRID', sectionSize: size, visible: spec.visible !== false, ...colour } as LayoutGrid)
      summary.push(`square ${size}`)
      continue
    }

    const vertical = spec.columns !== undefined
    const count = vertical ? spec.columns : spec.rows
    if (count === undefined) {
      fail('must be { columns }, { rows } or { square }')
      continue
    }
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
      fail(`${vertical ? 'columns' : 'rows'} must be a whole number of at least 1`)
      continue
    }
    for (const key of Object.keys(spec)) {
      if (!['columns', 'rows', 'gutter', 'margin', 'width', 'height', 'align', 'color', 'opacity', 'visible'].includes(key)) {
        fail(`unknown key "${key}" — accepted: columns/rows, gutter, margin, width/height, align, color, opacity, visible`)
      }
    }

    const gutter = spec.gutter === undefined ? 0 : spec.gutter
    if (typeof gutter !== 'number' || !Number.isFinite(gutter) || gutter < 0) {
      fail('gutter must be a number >= 0')
      continue
    }
    const size = vertical ? spec.width : spec.height
    if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size) || size <= 0)) {
      fail(`${vertical ? 'width' : 'height'} must be a number greater than 0`)
      continue
    }
    const margin = spec.margin === undefined ? 0 : spec.margin
    if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0) {
      fail('margin must be a number >= 0')
      continue
    }
    // A margin only means anything when the sections stretch to fill what is left of the frame,
    // which is what STRETCH is; naming a fixed width is the other way round.
    const align = spec.align === undefined ? (size === undefined ? 'STRETCH' : 'MIN') : spec.align
    if (typeof align !== 'string' || !GRID_ALIGN.includes(align)) {
      fail(`align must be one of: ${GRID_ALIGN.join(', ')}`)
      continue
    }
    const colour = paint()
    if (!colour) continue

    grids.push({
      pattern: vertical ? 'COLUMNS' : 'ROWS',
      alignment: align as GridAlign,
      gutterSize: gutter,
      count,
      ...(size === undefined ? {} : { sectionSize: size }),
      ...(margin === 0 ? {} : { offset: margin }),
      visible: spec.visible !== false,
      ...colour,
    } as LayoutGrid)
    summary.push(
      `${count} ${vertical ? 'column' : 'row'}(s) ${align.toLowerCase()}${gutter ? ` gutter ${gutter}` : ''}${margin ? ` margin ${margin}` : ''}${size ? ` at ${size}` : ''}`
    )
  }

  return { step: 'grid', grids, summary: summary.join(' · ') || 'none' }
}

function planLayout(raw: unknown, where: string, problems: string[]): PropStep | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push(`${where} must be an object`)
    return null
  }
  const value = raw as Record<string, unknown>
  const layout: LayoutProps = {}
  const fail = (message: string) => problems.push(`${where}.${message}`)

  for (const key of Object.keys(value)) {
    if (!['mode', 'gap', 'padding', 'primaryAxis', 'counterAxis', 'wrap', 'sizing'].includes(key)) {
      fail(`unknown key "${key}"`)
    }
  }

  if (value.mode !== undefined) {
    if (typeof value.mode !== 'string' || !LAYOUT_MODES.includes(value.mode)) fail(`mode must be one of: ${LAYOUT_MODES.join(', ')}`)
    else layout.mode = value.mode as LayoutProps['mode']
  }
  if (value.gap !== undefined) {
    if (typeof value.gap !== 'number' || !Number.isFinite(value.gap)) fail('gap must be a number')
    else layout.gap = value.gap
  }
  if (value.padding !== undefined) {
    if (typeof value.padding === 'number' && Number.isFinite(value.padding)) {
      layout.padding = [value.padding, value.padding, value.padding, value.padding]
    } else if (
      Array.isArray(value.padding) &&
      value.padding.length === 4 &&
      value.padding.every((one) => typeof one === 'number' && Number.isFinite(one))
    ) {
      layout.padding = value.padding as [number, number, number, number]
    } else fail('padding must be a number or [top, right, bottom, left]')
  }
  if (value.primaryAxis !== undefined) {
    if (typeof value.primaryAxis !== 'string' || !PRIMARY_AXIS.includes(value.primaryAxis)) {
      fail(`primaryAxis must be one of: ${PRIMARY_AXIS.join(', ')}`)
    } else layout.primaryAxis = value.primaryAxis as LayoutProps['primaryAxis']
  }
  if (value.counterAxis !== undefined) {
    if (typeof value.counterAxis !== 'string' || !COUNTER_AXIS.includes(value.counterAxis)) {
      fail(`counterAxis must be one of: ${COUNTER_AXIS.join(', ')}`)
    } else layout.counterAxis = value.counterAxis as LayoutProps['counterAxis']
  }
  if (value.wrap !== undefined) {
    if (typeof value.wrap !== 'boolean') fail('wrap must be a boolean')
    else layout.wrap = value.wrap
  }
  if (value.sizing !== undefined) {
    if (typeof value.sizing !== 'object' || value.sizing === null) fail('sizing must be { horizontal, vertical }')
    else {
      const sizing = value.sizing as { horizontal?: unknown; vertical?: unknown }
      layout.sizing = {}
      for (const axis of ['horizontal', 'vertical'] as const) {
        const mode = sizing[axis]
        if (mode === undefined) continue
        if (typeof mode !== 'string' || !SIZING.includes(mode)) fail(`sizing.${axis} must be one of: ${SIZING.join(', ')}`)
        else layout.sizing[axis] = mode as SizingMode
      }
    }
  }

  // A layout with no mode still means something — padding on an already-vertical frame — so an
  // absent mode leaves whatever the node has.
  return { step: 'layout', layout }
}

const HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/**
 * Which variable type each bindable field expects.
 *
 * Figma answers a mismatch with a message about the field, never about the variable, so the
 * check lives here where it can say "space/8 is a FLOAT and `visible` wants a BOOLEAN".
 */
const BINDABLE: Readonly<Record<string, 'FLOAT' | 'STRING' | 'BOOLEAN'>> = {
  width: 'FLOAT',
  height: 'FLOAT',
  minWidth: 'FLOAT',
  maxWidth: 'FLOAT',
  minHeight: 'FLOAT',
  maxHeight: 'FLOAT',
  itemSpacing: 'FLOAT',
  counterAxisSpacing: 'FLOAT',
  gridRowGap: 'FLOAT',
  gridColumnGap: 'FLOAT',
  paddingLeft: 'FLOAT',
  paddingRight: 'FLOAT',
  paddingTop: 'FLOAT',
  paddingBottom: 'FLOAT',
  cornerRadius: 'FLOAT',
  topLeftRadius: 'FLOAT',
  topRightRadius: 'FLOAT',
  bottomLeftRadius: 'FLOAT',
  bottomRightRadius: 'FLOAT',
  strokeWeight: 'FLOAT',
  strokeTopWeight: 'FLOAT',
  strokeRightWeight: 'FLOAT',
  strokeBottomWeight: 'FLOAT',
  strokeLeftWeight: 'FLOAT',
  opacity: 'FLOAT',
  fontSize: 'FLOAT',
  letterSpacing: 'FLOAT',
  lineHeight: 'FLOAT',
  paragraphSpacing: 'FLOAT',
  paragraphIndent: 'FLOAT',
  fontWeight: 'FLOAT',
  characters: 'STRING',
  fontFamily: 'STRING',
  fontStyle: 'STRING',
  visible: 'BOOLEAN',
}

/**
 * The words this vocabulary already uses, pointed at the fields Figma calls them.
 *
 * `padding` is one word for four fields, because a caller who binds the padding to a spacing
 * token means all of it — and having to write four lines to say so is how people stop using
 * tokens.
 */
const BIND_ALIASES: Readonly<Record<string, string[]>> = {
  text: ['characters'],
  gap: ['itemSpacing'],
  padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  radius: ['cornerRadius'],
  strokeWeights: ['strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight'],
}

/** Fields that ARE bindable, but not through here. */
const BOUND_ELSEWHERE: Readonly<Record<string, string>> = {
  fill: 'fill: { variable: "…" } paints and binds in one go',
  fills: 'fill: { variable: "…" } paints and binds in one go',
  stroke: 'stroke: { variable: "…" } paints and binds in one go',
  strokes: 'stroke: { variable: "…" } paints and binds in one go',
  effects: 'an effect variable has to be bound on the effect itself, which this vocabulary does not reach yet',
}

function planBindings(raw: unknown, where: string, problems: string[]): PropStep | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push(`${where} must be an object of { field: "variable name" } — null unbinds`)
    return null
  }

  const bindings: Array<{ field: string; variable: string | null; wants: string }> = []
  for (const [asked, value] of Object.entries(raw as Record<string, unknown>)) {
    if (BOUND_ELSEWHERE[asked]) {
      problems.push(`${where}.${asked}: ${BOUND_ELSEWHERE[asked]}`)
      continue
    }
    const fields = BIND_ALIASES[asked] ?? (BINDABLE[asked] ? [asked] : null)
    if (!fields) {
      problems.push(
        `${where}: "${asked}" is not a bindable field — accepted: ${[...Object.keys(BIND_ALIASES), ...Object.keys(BINDABLE)].join(', ')}`
      )
      continue
    }
    if (value !== null && (typeof value !== 'string' || value.trim() === '')) {
      problems.push(`${where}.${asked} must be a variable name, id or key — or null to unbind`)
      continue
    }
    for (const field of fields) bindings.push({ field, variable: value === null ? null : (value as string).trim(), wants: BINDABLE[field] })
  }

  if (bindings.length === 0 && problems.length === 0) {
    problems.push(`${where} names nothing to bind`)
    return null
  }
  return { step: 'bind', bindings }
}

/**
 * The two handles a gradient runs between, in the layer's own 0..1 space.
 *
 * They mean two different things depending on the kind, exactly as the two handles in Figma's own
 * UI do. For a linear gradient they are the ends of the line: an `angle` draws that line through
 * the middle of the layer, `angle` degrees round from horizontal, with y running down the screen
 * as it does everywhere else here — 0 is left to right, 90 top to bottom, and 90 is the default
 * because that is what Figma gives a designer who clicks "Linear".
 *
 * For a radial, a diamond or an angular gradient the first handle is the CENTRE and the second a
 * point on the edge. So the default there is the middle of the layer with a radius reaching half
 * way, and an angle only turns that radius — which is invisible on a circle and not on the other
 * two.
 */
export function gradientHandles(ref: {
  gradient?: string
  angle?: number
  from?: [number, number]
  to?: [number, number]
}): { from: [number, number]; to: [number, number] } {
  if (ref.from && ref.to) return { from: ref.from, to: ref.to }

  const centred = ref.gradient !== undefined && normaliseEnum(ref.gradient) !== 'LINEAR'
  const radians = ((ref.angle ?? (centred ? 0 : DEFAULT_GRADIENT_ANGLE)) * Math.PI) / 180
  const dx = Math.cos(radians) / 2
  const dy = Math.sin(radians) / 2
  if (centred) return { from: [0.5, 0.5], to: [0.5 + dx, 0.5 + dy] }
  return { from: [0.5 - dx, 0.5 - dy], to: [0.5 + dx, 0.5 + dy] }
}

/**
 * The matrix Figma actually stores, from the two handles.
 *
 * Figma keeps a gradient as a transform from the layer's space into the unit square the gradient
 * is defined in — the inverse of where a designer dragged the handles, which is why nobody writes
 * one by hand. Two facts pin the derivation, and both are visible in a render:
 *
 * - A LINEAR gradient reads its position off the x axis of that space, 0 at one end and 1 at the
 *   other. So the x row is the direction vector over its own squared length, translated to put
 *   `from` at zero — and the identity matrix comes out for (0,0) → (1,0), which is documented as
 *   a gradient running left to right.
 * - A RADIAL, DIAMOND or ANGULAR gradient measures from the CENTRE of that space, (0.5, 0.5),
 *   with the edge half a unit away. Using the linear form for those put the centre of every
 *   radial on the left edge — visible the moment one was rendered. So the scale is halved and the
 *   translation lands the centre in the middle, which again gives the identity for the middle of
 *   the layer with a radius reaching half way.
 *
 * The y row is the x row turned a quarter in both cases, so a circle stays a circle.
 */
export function gradientTransform(
  from: readonly [number, number],
  to: readonly [number, number],
  kind: string = 'LINEAR'
): Transform {
  const centred = normaliseEnum(kind) !== 'LINEAR'
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const squared = dx * dx + dy * dy || 1e-6
  const reach = centred ? 0.5 : 1
  const origin = centred ? 0.5 : 0
  const a = (reach * dx) / squared
  const b = (reach * dy) / squared
  // `+ 0` because negating zero gives -0, which is the same number and a different thing to read
  // in a stored matrix.
  const zeroed = (value: number) => value + 0
  return [
    [zeroed(a), zeroed(b), zeroed(origin - (a * from[0] + b * from[1]))],
    [zeroed(-b), zeroed(a), zeroed(origin - (-b * from[0] + a * from[1]))],
  ]
}

/** Null when the reference is usable, else why not. A list is a stack of layers, checked one by one. */
export function paintProblem(ref: unknown): string | null {
  if (Array.isArray(ref)) {
    for (const [index, one] of ref.entries()) {
      const problem = paintProblem(one)
      if (problem) return `[${index}] ${problem}`
    }
    return null
  }
  if (ref === null) return null
  if (typeof ref === 'string') return HEX.test(ref) ? null : `"${ref}" is not a #RRGGBB colour`
  if (typeof ref !== 'object') return 'must be "#RRGGBB", { color }, { variable }, { image }, a list of those, or null'

  const entry = ref as {
    color?: unknown
    opacity?: unknown
    variable?: unknown
    image?: unknown
    scaleMode?: unknown
    gradient?: unknown
  }
  if (entry.gradient !== undefined) return gradientProblem(ref as Record<string, unknown>)
  if (entry.image !== undefined) return imageProblem(entry)
  if (typeof entry.variable === 'string') return entry.variable === '' ? 'variable must be a name, id or library key' : null
  if (typeof entry.color === 'string') {
    if (!HEX.test(entry.color)) return `"${entry.color}" is not a #RRGGBB colour`
    if (entry.opacity !== undefined && (typeof entry.opacity !== 'number' || entry.opacity < 0 || entry.opacity > 1)) {
      return 'opacity must be between 0 and 1'
    }
    return null
  }
  return 'must carry either `color`, `variable` or `image`'
}

function gradientProblem(entry: Record<string, unknown>): string | null {
  const kind = typeof entry.gradient === 'string' ? normaliseEnum(entry.gradient) : ''
  if (!GRADIENTS.includes(kind)) return `gradient must be one of: ${GRADIENTS.join(', ')}`

  for (const key of Object.keys(entry)) {
    if (!['gradient', 'stops', 'angle', 'from', 'to', 'opacity'].includes(key)) {
      return `unknown key "${key}" — accepted: gradient, stops, angle, from, to, opacity`
    }
  }
  if (!Array.isArray(entry.stops) || entry.stops.length < 2) {
    return 'stops must be an array of at least two colours'
  }
  for (const [index, stop] of entry.stops.entries()) {
    if (typeof stop === 'string') {
      if (!HEX.test(stop)) return `stops[${index}]: "${stop}" is not a #RRGGBB colour`
      continue
    }
    if (typeof stop !== 'object' || stop === null || Array.isArray(stop)) {
      return `stops[${index}] must be "#RRGGBB" or { at, color }`
    }
    const one = stop as { at?: unknown; color?: unknown; opacity?: unknown }
    if (typeof one.at !== 'number' || one.at < 0 || one.at > 1) return `stops[${index}].at must be between 0 and 1`
    if (typeof one.color === 'object' && one.color !== null) {
      const bound = one.color as { variable?: unknown }
      if (typeof bound.variable !== 'string' || bound.variable === '') {
        return `stops[${index}].color must be "#RRGGBB" or { variable }`
      }
    } else if (typeof one.color !== 'string' || !HEX.test(one.color)) {
      return `stops[${index}].color must be "#RRGGBB" or { variable }`
    }
    if (one.opacity !== undefined && (typeof one.opacity !== 'number' || one.opacity < 0 || one.opacity > 1)) {
      return `stops[${index}].opacity must be between 0 and 1`
    }
  }

  if (entry.angle !== undefined && (typeof entry.angle !== 'number' || !Number.isFinite(entry.angle))) {
    return 'angle must be a number of degrees'
  }
  for (const end of ['from', 'to'] as const) {
    const point = entry[end]
    if (point === undefined) continue
    if (!Array.isArray(point) || point.length !== 2 || point.some((one) => typeof one !== 'number' || !Number.isFinite(one))) {
      return `${end} must be [x, y] in the layer's own 0..1 coordinates`
    }
  }
  if ((entry.from === undefined) !== (entry.to === undefined)) return 'from and to travel together'
  if (entry.angle !== undefined && entry.from !== undefined) return 'name either an angle or from/to, not both'
  if (entry.opacity !== undefined && (typeof entry.opacity !== 'number' || entry.opacity < 0 || entry.opacity > 1)) {
    return 'opacity must be between 0 and 1'
  }
  return null
}

function imageProblem(entry: { image?: unknown; scaleMode?: unknown; opacity?: unknown }): string | null {
  const image = entry.image
  if (typeof image !== 'object' || image === null || Array.isArray(image)) {
    return 'image must be { hash }, { url } or { bytes } — bytes being base64'
  }
  const source = image as { hash?: unknown; url?: unknown; bytes?: unknown }
  const named = ['hash', 'url', 'bytes'].filter((key) => source[key as 'hash'] !== undefined)
  if (named.length === 0) return 'image must name one of hash, url or bytes'
  if (named.length > 1) return `image names ${named.join(' and ')} — pick one`
  if (typeof source[named[0] as 'hash'] !== 'string' || source[named[0] as 'hash'] === '') {
    return `image.${named[0]} must be a non-empty string`
  }
  if (entry.scaleMode !== undefined && (typeof entry.scaleMode !== 'string' || !SCALE_MODES.includes(entry.scaleMode))) {
    return `scaleMode must be one of: ${SCALE_MODES.join(', ')}`
  }
  if (entry.opacity !== undefined && (typeof entry.opacity !== 'number' || entry.opacity < 0 || entry.opacity > 1)) {
    return 'opacity must be between 0 and 1'
  }
  return null
}
