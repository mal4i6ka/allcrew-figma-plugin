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

/* ------------------------------------------------------------------ vocabulary */

/** A colour, or a variable to bind — the two things a paint can be told to be. */
export type PaintRef =
  | string
  | { color: string; opacity?: number }
  | { variable: string }
  | null

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
  /** Where the node should live. On a create this is the parent; on a change it moves it. */
  parent?: string
  index?: number
}

export type ConstraintKind = 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE'

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
  | { step: 'reset' }
  | { step: 'swap'; component: string }
  | { step: 'properties'; properties: Record<string, string | boolean> }

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
  'fontName',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'autoResize',
  'text',
  'parent',
  'index',
] as const

const KNOWN = new Set<string>(ORDER)

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

/** Null when the reference is usable, else why not. */
export function paintProblem(ref: unknown): string | null {
  if (ref === null) return null
  if (typeof ref === 'string') return HEX.test(ref) ? null : `"${ref}" is not a #RRGGBB colour`
  if (typeof ref !== 'object' || Array.isArray(ref)) return 'must be "#RRGGBB", { color }, { variable } or null'

  const entry = ref as { color?: unknown; opacity?: unknown; variable?: unknown }
  if (typeof entry.variable === 'string') return entry.variable === '' ? 'variable must be a name, id or library key' : null
  if (typeof entry.color === 'string') {
    if (!HEX.test(entry.color)) return `"${entry.color}" is not a #RRGGBB colour`
    if (entry.opacity !== undefined && (typeof entry.opacity !== 'number' || entry.opacity < 0 || entry.opacity > 1)) {
      return 'opacity must be between 0 and 1'
    }
    return null
  }
  return 'must carry either `color` or `variable`'
}
