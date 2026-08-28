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

/** A shadow or a blur, in the terms the panel uses rather than Figma's five-field objects. */
export type EffectSpec =
  | {
      shadow: 'drop' | 'inner'
      color?: string
      opacity?: number
      offset?: [number, number]
      radius?: number
      spread?: number
      visible?: boolean
    }
  | { blur: 'layer' | 'background'; radius: number; visible?: boolean }

export interface LayoutProps {
  mode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
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
  | { step: 'effects'; effects: Effect[]; summary: string }
  | { step: 'dashes'; dashes: number[] }
  | { step: 'runs'; runs: TextRun[] }
  | { step: 'reset' }
  | { step: 'swap'; component: string }
  | { step: 'properties'; properties: Record<string, string | boolean> }
  | { step: 'links'; reactions: Reaction[]; destinations: string[]; summary: string }
  | { step: 'data'; data: Record<string, string | null> }

export interface PropPlan {
  steps: PropStep[]
  problems: string[]
}

const BLEND_FREE_ENUMS: Readonly<Record<string, readonly string[]>> = {
  textAlign: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'],
  autoResize: ['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'],
}

const LAYOUT_MODES = ['NONE', 'HORIZONTAL', 'VERTICAL']
const PRIMARY_AXIS = ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']
const COUNTER_AXIS = ['MIN', 'CENTER', 'MAX', 'BASELINE']
const SIZING = ['FIXED', 'HUG', 'FILL']
const CONSTRAINTS = ['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE']
const STROKE_ALIGN = ['INSIDE', 'OUTSIDE', 'CENTER']
const STROKE_CAP = ['NONE', 'ROUND', 'SQUARE', 'ARROW_LINES', 'ARROW_EQUILATERAL']
const STROKE_JOIN = ['MITER', 'BEVEL', 'ROUND']
const SCALE_MODES = ['FILL', 'FIT', 'CROP', 'TILE']
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
  'fill',
  'stroke',
  'strokeWeight',
  'strokeAlign',
  'strokeCap',
  'strokeJoin',
  'strokeDashes',
  'effects',
  'blendMode',
  'fontName',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'autoResize',
  'text',
  'runs',
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
const SIMPLE_ANIMATIONS = ['INSTANT', 'DISSOLVE', 'SMART_ANIMATE', 'SCROLL_ANIMATE']
const DIRECTIONAL_ANIMATIONS = ['MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT']
const DIRECTIONS = ['LEFT', 'RIGHT', 'TOP', 'BOTTOM']

const LINK_KEYS = [
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

const DEFAULT_DURATION = 0.3
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

  const reactions: Reaction[] = []
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

    // The trigger words are camelCase, so they are matched without shouting at them.
    const asked = link.on === undefined ? 'click' : link.on
    const on =
      typeof asked === 'string'
        ? (Object.keys(TRIGGERS).find((word) => word.toLowerCase() === asked.toLowerCase()) ?? '')
        : ''
    if (on === '') {
      fail(`on must be one of: ${Object.keys(TRIGGERS).join(', ')}`)
      continue
    }
    if (typeof link.to !== 'string' || link.to.trim() === '') {
      fail('to must be a node id, "back" or "close"')
      continue
    }

    const type = TRIGGERS[on]
    // A wait on a click, key codes on a hover: Figma's trigger simply has no such field, so it
    // would be dropped without a word — which is how somebody ends up believing in a delay that
    // never existed.
    let misplaced = false
    if (link.after !== undefined && type !== 'AFTER_TIMEOUT') {
      fail(`after only applies to a timeout trigger, not to ${on}`)
      misplaced = true
    }
    if (link.delay !== undefined && !DELAYED.includes(type)) {
      fail(`delay only applies to mouseEnter, mouseLeave, mouseUp and mouseDown, not to ${on}`)
      misplaced = true
    }
    if (link.keys !== undefined && type !== 'ON_KEY_DOWN') {
      fail(`keys only applies to keyDown, not to ${on}`)
      misplaced = true
    }
    if (misplaced) continue

    const after = link.after === undefined ? DEFAULT_TIMEOUT : link.after
    if (on === 'timeout' && (typeof after !== 'number' || !Number.isFinite(after) || after <= 0)) {
      fail('after must be a number of seconds greater than 0')
      continue
    }
    const delay = link.delay === undefined ? 0 : link.delay
    if (DELAYED.includes(type) && (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0)) {
      fail('delay must be a number of seconds >= 0')
      continue
    }
    if (type === 'ON_KEY_DOWN') {
      const keys = link.keys
      if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== 'number' || !Number.isInteger(key))) {
        fail('keyDown needs keys: an array of key codes, e.g. [13] for Enter')
        continue
      }
    }

    let trigger: Trigger
    if (type === 'AFTER_TIMEOUT') {
      trigger = { type, timeout: after as number } as Trigger
    } else if (type === 'ON_KEY_DOWN') {
      trigger = { type, device: 'KEYBOARD', keyCodes: link.keys as number[] } as Trigger
    } else if (DELAYED.includes(type)) {
      // Just the delay. The typings put a `deprecatedVersion` flag on MOUSE_ENTER / MOUSE_LEAVE,
      // and sending it is refused by the runtime that ships today:
      //   Unrecognized key(s) in object: 'deprecatedVersion' at [0].trigger
      // Found by the first hover link built in Figma; the typings are ahead of the host.
      trigger = { type, delay: delay as number } as Trigger
    } else {
      trigger = { type } as Trigger
    }

    const to = link.to.trim()
    const target = to.toLowerCase()
    if (target === 'back' || target === 'close') {
      reactions.push({ trigger, actions: [{ type: target === 'back' ? 'BACK' : 'CLOSE' }] })
      continue
    }

    const navigation = link.as === undefined ? 'NAVIGATE' : link.as
    if (typeof navigation !== 'string' || !NAVIGATIONS.includes(normaliseEnum(navigation))) {
      fail(`as must be one of: ${NAVIGATIONS.join(', ')}`)
      continue
    }
    const duration = link.duration === undefined ? DEFAULT_DURATION : link.duration
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 10) {
      fail('duration must be a number of seconds between 0 and 10')
      continue
    }

    const easing = buildEasing(link, fail)
    if (easing === null) continue

    const animation = link.animation === undefined ? 'INSTANT' : link.animation
    if (typeof animation !== 'string') {
      fail('animation must be a string')
      continue
    }
    if (link.matchLayers !== undefined && typeof link.matchLayers !== 'boolean') {
      fail('matchLayers must be true or false')
      continue
    }
    const transition = buildTransition(normaliseEnum(animation), duration, easing, link.matchLayers === true)
    if (transition === undefined) {
      fail(
        `animation must be one of: ${SIMPLE_ANIMATIONS.join(', ')}, or ` +
          `${DIRECTIONAL_ANIMATIONS.join('/')} with _${DIRECTIONS.join('/_')}`
      )
      continue
    }

    let resets = true
    for (const flag of ['resetScroll', 'resetVideo', 'resetInteractive'] as const) {
      if (link[flag] !== undefined && typeof link[flag] !== 'boolean') {
        fail(`${flag} must be true or false`)
        resets = false
      }
    }
    if (!resets) continue

    destinations.push(to)
    reactions.push({
      trigger,
      actions: [
        {
          type: 'NODE',
          destinationId: to,
          navigation: normaliseEnum(navigation) as Navigation,
          transition,
          ...(typeof link.resetScroll === 'boolean' ? { resetScrollPosition: link.resetScroll } : {}),
          ...(typeof link.resetVideo === 'boolean' ? { resetVideoPosition: link.resetVideo } : {}),
          ...(typeof link.resetInteractive === 'boolean' ? { resetInteractiveComponents: link.resetInteractive } : {}),
        },
      ],
    })
  }

  // Described rather than narrated: the line a write reports and the line a read answers with
  // are the same line, because they come from the same function.
  return { step: 'links', reactions, destinations, summary: describeLinks(reactions) || 'none' }
}

/**
 * The inverse: reactions as the one line a caller could have written.
 *
 * A read that answers with Figma's own five nested objects per link is a read nobody can act on
 * — and the agent channel's digest would summarise it away long before it arrived.
 */
/** Figma keeps these as 32-bit floats, so a duration set to 0.6 reads back as
 * 0.6000000238418579 — noise in every line that quotes one. */
function seconds(value: number): string {
  return `${Math.round(value * 1000) / 1000}s`
}

export function describeLinks(reactions: readonly Reaction[]): string {
  const spelling: Record<string, string> = {}
  for (const [word, type] of Object.entries(TRIGGERS)) spelling[type] = word

  const parts: string[] = []
  for (const reaction of reactions) {
    const trigger = reaction.trigger
    let on = trigger ? spelling[trigger.type] ?? trigger.type.toLowerCase() : 'nothing'
    // The wait is the whole of what a timeout link says; a bare "timeout" hides it. Same for the
    // keys of a key trigger and the delay of a mouse one.
    if (trigger) {
      if (trigger.type === 'AFTER_TIMEOUT') on = `${on} ${seconds(trigger.timeout)}`
      else if (trigger.type === 'ON_KEY_DOWN') on = `${on} [${(trigger.keyCodes ?? []).join(',')}]`
      else if ('delay' in trigger && trigger.delay) on = `${on} ${seconds(trigger.delay)}`
    }
    const actions = reaction.actions ?? (reaction.action ? [reaction.action] : [])
    for (const action of actions) {
      if (action.type === 'BACK' || action.type === 'CLOSE') {
        parts.push(`${on} → ${action.type.toLowerCase()}`)
        continue
      }
      if (action.type !== 'NODE') {
        parts.push(`${on} → ${action.type.toLowerCase()}`)
        continue
      }
      const transition = action.transition
      const named = transition
        ? `${transition.type}${'direction' in transition ? `_${transition.direction}` : ''} ${seconds(transition.duration)}` +
          `${transition.easing.type === DEFAULT_EASING ? '' : ` ${transition.easing.type}`}` +
          `${'matchLayers' in transition && transition.matchLayers ? ' +match' : ''}`
        : 'INSTANT'
      const navigation = action.navigation === 'NAVIGATE' ? '' : ` (${action.navigation})`
      parts.push(`${on} → ${action.destinationId ?? '?'}${navigation}${named === 'INSTANT' ? '' : ` ${named}`}`)
    }
  }
  return parts.join(' · ')
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
  const summary: string[] = []

  for (const [index, entry] of raw.entries()) {
    const at = `${where}[${index}]`
    const fail = (message: string) => problems.push(`${at}: ${message}`)
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail('must be { shadow } or { blur }')
      continue
    }
    const spec = entry as Record<string, unknown>

    if (typeof spec.blur === 'string') {
      const kind = spec.blur.toLowerCase()
      if (kind !== 'layer' && kind !== 'background') {
        fail('blur must be "layer" or "background"')
        continue
      }
      const radius = spec.radius
      if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0) {
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

    const hex = spec.color === undefined ? '#000000' : spec.color
    if (typeof hex !== 'string' || !HEX.test(hex)) {
      fail(`color must be a #RRGGBB colour`)
      continue
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
    if (
      !Array.isArray(offset) ||
      offset.length !== 2 ||
      offset.some((one) => typeof one !== 'number' || !Number.isFinite(one))
    ) {
      fail('offset must be [x, y]')
      continue
    }
    const radius = spec.radius === undefined ? 8 : spec.radius
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0) {
      fail('radius must be a number >= 0')
      continue
    }
    const spread = spec.spread === undefined ? 0 : spec.spread
    if (typeof spread !== 'number' || !Number.isFinite(spread)) {
      fail('spread must be a number')
      continue
    }

    effects.push({
      type: kind === 'drop' ? 'DROP_SHADOW' : 'INNER_SHADOW',
      color: { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha },
      offset: { x: offset[0] as number, y: offset[1] as number },
      radius,
      spread,
      visible: spec.visible !== false,
      blendMode: 'NORMAL',
    } as Effect)
    summary.push(
      `${kind} shadow ${hex}${alpha === 1 ? '' : ` @${alpha}`} ${offset[0]},${offset[1]} blur ${radius}${spread ? ` spread ${spread}` : ''}`
    )
  }

  return { step: 'effects', effects, summary: summary.join(' · ') || 'none' }
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

  const entry = ref as { color?: unknown; opacity?: unknown; variable?: unknown; image?: unknown; scaleMode?: unknown }
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
