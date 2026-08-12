/**
 * REFORM phase 11 / B4+: the pure, pixel-accurate VISUAL blueprint for each generated master
 * component. Given a spec + one variant's values, a renderer returns a `KitNode` tree describing
 * exactly how that variant should look (Bootstrap 5.3 metrics from metrics.ts) — the Figma glue
 * (kit.ts) walks the tree into real nodes and binds role fills to tokens.
 *
 * Dispatch is keyed by the RECOGNIZER's `kind` (matchBootstrapComponent), so the visual we draw
 * and the markup the exporter reads back stay described by one source of truth: every named
 * child frame here uses the same layer name the recognizer's part table keys off (Header, Body,
 * Field, Item…), so a generated kit round-trips through the B3 exporter unchanged.
 *
 * `figma`-free and fully Node-testable; the raw createFrame/createText calls live in kit.ts.
 */

import {
  COLOR,
  CONTROL_HEIGHT,
  CONTROL_PAD,
  FONT,
  RADIUS,
  SPACE,
  alertColors,
  roleColor,
  roleTextColor,
  shade,
  tint,
  type Rgb,
} from './metrics.ts'
import { planComponent } from './plan.ts'
import { matchBootstrapComponent } from '../bootstrap/components.ts'
import type { ComponentSpec } from '../bootstrap/specs.ts'

// ---- KitNode: the pure node tree the interpreter builds ---------------------------------

/** A fill instruction. `token` binds to the role's design token when the file has one, else
 * falls back to the literal `fallback`; `solid` is always literal; `none` clears fills. */
export type Fill =
  | { kind: 'token'; role: string; fallback: Rgb }
  | { kind: 'solid'; color: Rgb }
  | { kind: 'none' }

export interface Stroke {
  color: Rgb
  weight: number
  /** Which edges carry the stroke — `all` (default) or a single side (dividers). */
  side?: 'all' | 'bottom' | 'top' | 'left' | 'right'
}

/** Marks a frame as a Figma SLOT — the editable/extensible content region of a container
 * component. The builder creates it via `component.createSlot()` and wires description +
 * preferred inserts + min/max so a designer sees exactly what to drop and how far to extend
 * (docs/BOOTSTRAP-CATALOG.md). Everything NOT marked as a slot is fixed structure. */
export interface SlotSpec {
  /** Guidance shown on the slot property (e.g. "Drop nav links or buttons here"). */
  description: string
  /** Preferred insert components, referenced by spec/set NAME (resolved to Figma keys at build). */
  preferredKinds?: string[]
  minChildren?: number | null
  maxChildren?: number | null
  /** When true, only preferred components may be inserted; default false (guided but open). */
  allowPreferredOnly?: boolean
  stretchOnInsert?: boolean
}

export interface KitText {
  type: 'text'
  name: string
  text: string
  fontSize: number
  color: Fill
  bold?: boolean
  align?: 'left' | 'center' | 'right'
  /** Grow to fill the main axis of an auto-layout parent (layoutGrow). */
  grow?: boolean
  /** Muted secondary text (help, captions). */
  muted?: boolean
  /** Absolute offset inside a `direction: 'none'` parent. */
  x?: number
  y?: number
}

export type SizeMode = number | 'hug' | 'fill'

export interface KitFrame {
  type: 'frame'
  name: string
  /** Auto-layout direction; `none` → free frame sized by width/height. */
  direction?: 'horizontal' | 'vertical' | 'none'
  gap?: number
  /** `[top, right, bottom, left]` or a single number for all sides. */
  padding?: [number, number, number, number] | number
  primaryAlign?: 'min' | 'center' | 'max' | 'space-between'
  counterAlign?: 'min' | 'center' | 'max'
  width?: SizeMode
  height?: SizeMode
  fill?: Fill
  stroke?: Stroke
  radius?: number
  clip?: boolean
  opacity?: number
  /** Grow to fill the main axis of an auto-layout parent. */
  grow?: boolean
  /** Absolute offset inside a `direction: 'none'` parent. */
  x?: number
  y?: number
  /** Build this frame as a Figma SLOT (container's editable content region). */
  slot?: SlotSpec
  children: KitNode[]
}

/** REFORM phase 12: a reference to an INSTANCE of another generated item sub-component set
 * (`of` = its spec name). The Figma interpreter creates a real instance of the built item set with
 * `values` selecting its variant; if instances aren't available it falls back to rendering the
 * item's blueprint inline. `text` overrides named text layers per instance (e.g. page numbers). */
export interface KitInstance {
  type: 'instance'
  of: string
  values?: Record<string, string>
  text?: Record<string, string>
  width?: SizeMode
  height?: SizeMode
  grow?: boolean
  x?: number
  y?: number
}

export type KitNode = KitFrame | KitText | KitInstance

// ---- terse constructors -----------------------------------------------------------------

const solid = (color: Rgb): Fill => ({ kind: 'solid', color })
const token = (role: string): Fill => ({ kind: 'token', role, fallback: roleColor(role) })
const NONE: Fill = { kind: 'none' }

/** A guided-but-open slot: suggests `preferredKinds` and shows `description`, but a designer may
 * drop anything and add/remove freely (allowPreferredOnly=false, no hard min/max). */
const openSlot = (description: string, preferredKinds: string[] = []): SlotSpec => ({
  description,
  preferredKinds,
  allowPreferredOnly: false,
  stretchOnInsert: true,
  minChildren: 0,
  maxChildren: null,
})

/** Reference an instance of an item sub-component set (phase 12 composition). */
function inst(of: string, values?: Record<string, string>, opts: Partial<KitInstance> = {}): KitInstance {
  return { type: 'instance', of, values, ...opts }
}

interface TextOpts {
  fontSize?: number
  color?: Fill
  bold?: boolean
  align?: 'left' | 'center' | 'right'
  grow?: boolean
  muted?: boolean
  /** Absolute offset inside a `direction: 'none'` parent. */
  x?: number
  y?: number
}
function txt(name: string, text: string, opts: TextOpts = {}): KitText {
  return {
    type: 'text',
    name,
    text,
    fontSize: opts.fontSize ?? FONT.base,
    color: opts.color ?? (opts.muted ? solid(COLOR.secondaryText) : solid(COLOR.bodyText)),
    bold: opts.bold,
    align: opts.align,
    grow: opts.grow,
    muted: opts.muted,
    x: opts.x,
    y: opts.y,
  }
}
function frame(name: string, opts: Partial<KitFrame> & { children?: KitNode[] } = {}): KitFrame {
  return { type: 'frame', name, children: opts.children ?? [], ...opts }
}

// ---- shared derivations -----------------------------------------------------------------

/** First text placeholder declared on the spec, or a fallback. */
function labelText(spec: ComponentSpec, fallback: string): string {
  return spec.parts?.find((p) => p.text != null)?.text ?? fallback
}
function sizeRadius(size: string): number {
  return size === 'sm' ? RADIUS.sm : size === 'lg' ? RADIUS.lg : RADIUS.base
}
function sizeFont(size: string): number {
  return size === 'sm' ? FONT.sm : size === 'lg' ? FONT.lg : FONT.base
}

/** A role-colored control's fill for an interactive state: default/focus bind to the token;
 * hover/active use Bootstrap's darker shade (can't bind — the value differs from the token). */
function stateFill(role: string, state: string): Fill {
  const base = roleColor(role)
  if (state === 'hover') return solid(shade(base, 0.1))
  if (state === 'active') return solid(shade(base, 0.2))
  return token(role)
}

// ---- renderers, keyed by recognizer kind ------------------------------------------------

type Vals = Record<string, string>
type Renderer = (spec: ComponentSpec, v: Vals) => KitFrame

const button: Renderer = (spec, v) => {
  const raw = v.Variant ?? 'Primary'
  const size = v.Size ?? 'md'
  const state = v.State ?? 'default'
  const [padV, padH] = CONTROL_PAD[size] ?? CONTROL_PAD.md
  const lower = raw.trim().toLowerCase()
  const isLink = lower === 'link'
  const isOutline = lower.startsWith('outline')
  const role = isOutline ? raw.replace(/^outline-?/i, '') : raw
  let fill: Fill = NONE
  let stroke: Stroke | undefined
  let text: Fill
  if (isLink) {
    text = solid(roleColor('primary'))
  } else if (isOutline) {
    stroke = { color: roleColor(role), weight: 1 }
    // Outline inverts on hover/active: the role fill flows in, text becomes the contrast color.
    if (state === 'hover' || state === 'active') {
      fill = stateFill(role, state)
      text = solid(roleTextColor(role))
    } else {
      text = solid(roleColor(role))
    }
  } else {
    fill = stateFill(role, state)
    text = solid(roleTextColor(role))
  }
  return frame('Button', {
    direction: 'horizontal',
    padding: [padV, padH, padV, padH],
    gap: 6,
    primaryAlign: 'center',
    counterAlign: 'center',
    width: 'hug',
    height: 'hug',
    fill,
    stroke,
    radius: sizeRadius(size),
    opacity: state === 'disabled' ? 0.65 : 1,
    children: [txt('Label', labelText(spec, 'Button'), { fontSize: sizeFont(size), color: text })],
  })
}

const badge: Renderer = (spec, v) => {
  const role = v.Variant ?? 'Primary'
  const pill = (v.Shape ?? '').trim().toLowerCase() === 'pill'
  return frame('Badge', {
    direction: 'horizontal',
    padding: [SPACE.badge.padV, SPACE.badge.padH, SPACE.badge.padV, SPACE.badge.padH],
    primaryAlign: 'center',
    counterAlign: 'center',
    width: 'hug',
    height: 'hug',
    fill: token(role),
    radius: pill ? RADIUS.pill : SPACE.badge.radius,
    children: [txt('Label', labelText(spec, 'Badge'), { fontSize: SPACE.badge.font, bold: true, color: solid(roleTextColor(role)) })],
  })
}

const alert: Renderer = (spec, v) => {
  const role = v.Variant ?? 'Primary'
  const c = alertColors(role)
  return frame('Alert', {
    direction: 'horizontal',
    padding: [SPACE.alert.padV, SPACE.alert.padH, SPACE.alert.padV, SPACE.alert.padH],
    counterAlign: 'center',
    width: 320,
    height: 'hug',
    fill: solid(c.bg),
    stroke: { color: c.border, weight: 1 },
    radius: SPACE.alert.radius,
    children: [txt('Text', labelText(spec, 'A short alert message.'), { color: solid(c.text), grow: true })],
  })
}

const card: Renderer = (spec) => {
  const has = (name: string) => spec.parts?.some((p) => p.name.toLowerCase() === name)
  const children: KitNode[] = []
  if (has('header')) {
    children.push(
      frame('Header', {
        direction: 'horizontal',
        padding: [SPACE.card.headerPadV, SPACE.card.headerPadH, SPACE.card.headerPadV, SPACE.card.headerPadH],
        width: 'fill',
        fill: solid(COLOR.headerBg),
        stroke: { color: COLOR.border, weight: 1, side: 'bottom' },
        children: [txt('HeaderText', 'Card header', { bold: true })],
      })
    )
  }
  children.push(
    frame('Body', {
      direction: 'vertical',
      padding: SPACE.card.bodyPad,
      gap: 8,
      width: 'fill',
      slot: openSlot('Card content — title, text, images, buttons'),
      children: [txt('Title', 'Card title', { fontSize: FONT.heading, bold: true }), txt('Text', 'Card body text goes here.', {})],
    })
  )
  if (has('footer')) {
    children.push(
      frame('Footer', {
        direction: 'horizontal',
        padding: [SPACE.card.headerPadV, SPACE.card.headerPadH, SPACE.card.headerPadV, SPACE.card.headerPadH],
        width: 'fill',
        fill: solid(COLOR.headerBg),
        stroke: { color: COLOR.border, weight: 1, side: 'top' },
        children: [txt('FooterText', 'Card footer', { muted: true, fontSize: FONT.sm })],
      })
    )
  }
  return frame('Card', {
    direction: 'vertical',
    width: 320,
    height: 'hug',
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    radius: SPACE.card.radius,
    clip: true,
    children,
  })
}

const spinner: Renderer = (_spec, v) => {
  const role = v.Variant ?? 'Primary'
  const isGrow = (v.Type ?? 'border').toLowerCase() === 'grow'
  const size = SPACE.spinner.size
  return frame('Spinner', {
    direction: 'none',
    width: size,
    height: size,
    fill: isGrow ? token(role) : NONE,
    stroke: isGrow ? undefined : { color: roleColor(role), weight: SPACE.spinner.border },
    radius: RADIUS.pill,
    opacity: isGrow ? 0.4 : 1,
    children: [],
  })
}

const closeButton: Renderer = (_spec, v) => {
  // Dark theme is meant for dark backgrounds, so we draw it on a dark swatch (else the near-white
  // glyph would be invisible on the light sheet); Light is a plain muted ×.
  const dark = (v.Theme ?? 'Light').trim().toLowerCase() === 'dark'
  return frame('CloseButton', {
    direction: 'horizontal',
    primaryAlign: 'center',
    counterAlign: 'center',
    width: 24,
    height: 24,
    radius: RADIUS.base,
    fill: dark ? solid(COLOR.bodyText) : NONE,
    children: [txt('X', '×', { fontSize: 14, color: dark ? solid(COLOR.surface) : solid(COLOR.secondaryText) })],
  })
}

const placeholder: Renderer = (_spec, v) => {
  const size = (v.Size ?? 'md').trim().toLowerCase()
  const h = size === 'xs' ? 8 : size === 'sm' ? 10 : size === 'lg' ? 16 : 12
  return frame('Placeholder', { direction: 'none', width: 160, height: h, fill: solid(COLOR.placeholder), radius: RADIUS.sm, opacity: 0.5, children: [] })
}

const listGroup: Renderer = () =>
  frame('ListGroup', {
    direction: 'vertical',
    width: 280,
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    radius: RADIUS.base,
    clip: true,
    children: [
      inst('ListGroupItem', { State: 'Active' }, { width: 'fill' }),
      inst('ListGroupItem', { State: 'Default' }, { width: 'fill', text: { ItemText: 'A second item' } }),
      inst('ListGroupItem', { State: 'Default' }, { width: 'fill', text: { ItemText: 'A third item' } }),
    ],
  })

const pagination: Renderer = () =>
  frame('Pagination', {
    direction: 'horizontal',
    gap: 0,
    width: 'hug',
    children: [
      inst('PageItem', { State: 'Prev' }),
      inst('PageItem', { State: 'Default' }, { text: { PageText: '1' } }),
      inst('PageItem', { State: 'Active' }, { text: { PageText: '2' } }),
      inst('PageItem', { State: 'Default' }, { text: { PageText: '3' } }),
      inst('PageItem', { State: 'Next' }),
    ],
  })

const progress: Renderer = (_spec, v) => {
  const role = v.Variant ?? 'Primary'
  return frame('Progress', {
    direction: 'horizontal',
    width: 280,
    height: SPACE.progress.height,
    fill: solid(COLOR.trackBg),
    radius: SPACE.progress.radius,
    clip: true,
    children: [frame('Bar', { direction: 'none', width: 140, height: SPACE.progress.height, fill: token(role), children: [] })],
  })
}

const navbar: Renderer = (_spec, v) => {
  const dark = (v.Theme ?? 'Light').trim().toLowerCase() === 'dark'
  const bg = dark ? roleColor('dark') : COLOR.subtleBg
  const brandColor = dark ? COLOR.surface : COLOR.bodyText
  const activeColor = dark ? COLOR.surface : roleColor('primary')
  const mutedColor: Rgb = dark ? { r: 0.73, g: 0.75, b: 0.78 } : COLOR.secondaryText
  const navPad: [number, number, number, number] = [SPACE.navLink.padV, SPACE.navLink.padH, SPACE.navLink.padV, SPACE.navLink.padH]
  const link = (text: string, active: boolean): KitFrame =>
    frame('Item', { direction: 'horizontal', padding: navPad, width: 'hug', children: [txt('ItemText', text, { color: solid(active ? activeColor : mutedColor) })] })
  return frame('Navbar', {
    direction: 'horizontal',
    padding: [SPACE.navbar.padV, SPACE.navbar.padH, SPACE.navbar.padV, SPACE.navbar.padH],
    gap: 16,
    counterAlign: 'center',
    primaryAlign: 'space-between',
    width: 480,
    fill: solid(bg),
    children: [
      txt('Brand', 'Navbar', { bold: true, fontSize: FONT.lg, color: solid(brandColor) }),
      frame('Nav', { direction: 'horizontal', gap: 8, width: 'hug', slot: openSlot('Nav links or buttons — drop items here', ['Button']), children: [link('Home', true), link('Features', false), link('Pricing', false)] }),
    ],
  })
}

const breadcrumb: Renderer = () =>
  frame('Breadcrumb', {
    direction: 'horizontal',
    gap: SPACE.breadcrumb.gap,
    counterAlign: 'center',
    width: 'hug',
    children: [
      inst('BreadcrumbItem', { State: 'Link' }, { text: { Label: 'Home' } }),
      inst('BreadcrumbItem', { State: 'Link' }, { text: { Label: 'Library' } }),
      inst('BreadcrumbItem', { State: 'Active' }, { text: { Label: 'Data' } }),
    ],
  })

const navStrip: Renderer = (spec) =>
  frame(spec.name, {
    direction: 'horizontal',
    gap: 4,
    counterAlign: 'center',
    width: 'hug',
    stroke: spec.name.trim().toLowerCase() === 'pills' ? undefined : { color: COLOR.border, weight: 1, side: 'bottom' },
    children: [
      inst('NavLink', { State: 'Active' }, { text: { Label: 'Active' } }),
      inst('NavLink', { State: 'Default' }, { text: { Label: 'Link' } }),
      inst('NavLink', { State: 'Default' }, { text: { Label: 'Link' } }),
    ],
  })

const tabs: Renderer = () =>
  frame('Tabs', {
    direction: 'vertical',
    width: 360,
    children: [
      frame('Nav', {
        direction: 'horizontal',
        gap: 4,
        stroke: { color: COLOR.border, weight: 1, side: 'bottom' },
        width: 'fill',
        children: [inst('NavLink', { State: 'Active' }, { text: { Label: 'Tab one' } }), inst('NavLink', { State: 'Default' }, { text: { Label: 'Tab two' } })],
      }),
      frame('Content', {
        direction: 'vertical',
        width: 'fill',
        slot: openSlot('Tab panels — drop TabPane instances', ['TabPane']),
        children: [inst('TabPane', { State: 'Active' }, { width: 'fill' }), inst('TabPane', { State: 'Inactive' }, { width: 'fill', text: { PaneText: 'Second tab panel content.' } })],
      }),
    ],
  })

const carousel: Renderer = () =>
  frame('Carousel', {
    direction: 'none',
    width: 360,
    height: 200,
    fill: solid(COLOR.trackBg),
    radius: RADIUS.base,
    clip: true,
    children: [
      frame('Inner', {
        direction: 'none',
        width: 360,
        height: 200,
        x: 0,
        y: 0,
        clip: true,
        slot: openSlot('Slides — drop CarouselSlide instances', ['CarouselSlide']),
        children: [inst('CarouselSlide', { State: 'Active' }, { x: 0, y: 0 })],
      }),
      frame('Prev', { direction: 'horizontal', primaryAlign: 'center', counterAlign: 'center', width: 40, height: 200, x: 0, y: 0, children: [txt('PrevIcon', '‹', { fontSize: 24 })] }),
      frame('Next', { direction: 'horizontal', primaryAlign: 'center', counterAlign: 'center', width: 40, height: 200, x: 320, y: 0, children: [txt('NextIcon', '›', { fontSize: 24 })] }),
    ],
  })

const dropdown: Renderer = () =>
  frame('Dropdown', {
    direction: 'vertical',
    gap: 4,
    width: 'hug',
    children: [
      frame('Toggle', {
        direction: 'horizontal',
        gap: 6,
        padding: [CONTROL_PAD.md[0], CONTROL_PAD.md[1], CONTROL_PAD.md[0], CONTROL_PAD.md[1]],
        counterAlign: 'center',
        width: 'hug',
        fill: token('Primary'),
        radius: RADIUS.base,
        children: [txt('ToggleText', 'Dropdown', { color: solid(roleTextColor('Primary')) }), txt('Caret', '▾', { color: solid(roleTextColor('Primary')) })],
      }),
      frame('Menu', {
        direction: 'vertical',
        padding: [SPACE.dropdown.padV, 0, SPACE.dropdown.padV, 0],
        slot: openSlot('Menu items — drop DropdownItem instances', ['DropdownItem']),
        width: SPACE.dropdown.minWidth,
        fill: solid(COLOR.surface),
        stroke: { color: COLOR.border, weight: 1 },
        radius: SPACE.dropdown.radius,
        children: [
          inst('DropdownItem', { Variant: 'Default' }, { width: 'fill' }),
          inst('DropdownItem', { Variant: 'Active' }, { width: 'fill', text: { LinkText: 'Active link' } }),
          inst('DropdownItem', { Variant: 'Divider' }, { width: 'fill' }),
          inst('DropdownItem', { Variant: 'Default' }, { width: 'fill', text: { LinkText: 'Another action' } }),
        ],
      }),
    ],
  })

const accordion: Renderer = () =>
  frame('Accordion', {
    direction: 'vertical',
    width: 360,
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    radius: RADIUS.base,
    clip: true,
    children: [
      inst('AccordionItem', { State: 'Open' }, { width: 'fill', text: { Title: 'Accordion Item #1' } }),
      inst('AccordionItem', { State: 'Closed' }, { width: 'fill', text: { Title: 'Accordion Item #2' } }),
    ],
  })

const collapse: Renderer = (_spec, v) => {
  const expanded = (v.State ?? 'Expanded').trim().toLowerCase() === 'expanded'
  const children: KitNode[] = [
    frame('Toggle', { direction: 'horizontal', padding: [CONTROL_PAD.md[0], CONTROL_PAD.md[1], CONTROL_PAD.md[0], CONTROL_PAD.md[1]], width: 'hug', fill: token('Primary'), radius: RADIUS.base, children: [txt('ToggleText', 'Toggle content', { color: solid(roleTextColor('Primary')) })] }),
  ]
  if (expanded) {
    children.push(frame('Content', { direction: 'vertical', padding: 16, width: 300, fill: solid(COLOR.surface), stroke: { color: COLOR.border, weight: 1 }, radius: RADIUS.base, children: [txt('ContentText', 'Collapsible content revealed on toggle.', {})] }))
  }
  return frame('Collapse', { direction: 'vertical', gap: 8, width: 'hug', children })
}

const toast: Renderer = (_spec, v) => {
  const simple = (v.Layout ?? 'WithHeader').trim().toLowerCase() === 'simple'
  const children: KitNode[] = []
  if (!simple) {
    children.push(
      frame('Header', {
        direction: 'horizontal',
        gap: 8,
        counterAlign: 'center',
        primaryAlign: 'space-between',
        padding: [SPACE.toast.headerPadV, SPACE.toast.headerPadH, SPACE.toast.headerPadV, SPACE.toast.headerPadH],
        width: 'fill',
        stroke: { color: COLOR.border, weight: 1, side: 'bottom' },
        children: [txt('HeaderText', 'Notification', { bold: true }), txt('Time', 'just now', { muted: true, fontSize: FONT.sm })],
      })
    )
  }
  children.push(frame('Body', { direction: 'horizontal', primaryAlign: 'space-between', counterAlign: 'center', padding: SPACE.toast.bodyPad, width: 'fill', slot: openSlot('Toast content'), children: [txt('BodyText', 'Hello, this is a toast message.', { grow: true }), ...(simple ? [txt('Close', '×', { muted: true })] : [])] }))
  return frame('Toast', {
    direction: 'vertical',
    width: SPACE.toast.width,
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    radius: SPACE.toast.radius,
    clip: true,
    children,
  })
}

const offcanvas: Renderer = (_spec, v) => {
  const placement = (v.Placement ?? 'Start').trim().toLowerCase()
  const horizontal = placement === 'start' || placement === 'end'
  return frame('Offcanvas', {
    direction: 'vertical',
    width: horizontal ? SPACE.offcanvas.width : 520,
    height: horizontal ? 320 : 200,
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    children: [
      frame('Header', {
        direction: 'horizontal',
        primaryAlign: 'space-between',
        counterAlign: 'center',
        padding: SPACE.offcanvas.pad,
        width: 'fill',
        stroke: { color: COLOR.border, weight: 1, side: 'bottom' },
        children: [txt('Title', 'Offcanvas', { bold: true, fontSize: FONT.lg }), txt('Close', '×', { muted: true })],
      }),
      frame('Body', { direction: 'vertical', padding: SPACE.offcanvas.pad, gap: 8, width: 'fill', grow: true, slot: openSlot('Offcanvas content'), children: [txt('BodyText', 'Offcanvas panel body content.', {})] }),
    ],
  })
}

const modal: Renderer = () =>
  frame('Modal', {
    direction: 'vertical',
    width: SPACE.modal.width,
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    radius: SPACE.modal.radius,
    clip: true,
    children: [
      frame('Header', {
        direction: 'horizontal',
        primaryAlign: 'space-between',
        counterAlign: 'center',
        padding: SPACE.modal.pad,
        width: 'fill',
        stroke: { color: COLOR.border, weight: 1, side: 'bottom' },
        children: [txt('Title', 'Modal title', { bold: true, fontSize: FONT.lg }), txt('Close', '×', { muted: true })],
      }),
      frame('Body', { direction: 'vertical', padding: SPACE.modal.pad, gap: 8, width: 'fill', slot: openSlot('Modal content'), children: [txt('BodyText', 'Modal body content goes here.', {})] }),
      frame('Footer', {
        direction: 'horizontal',
        gap: 8,
        primaryAlign: 'max',
        padding: SPACE.modal.pad,
        width: 'fill',
        stroke: { color: COLOR.border, weight: 1, side: 'top' },
        children: [
          frame('CancelBtn', { direction: 'horizontal', padding: [6, 12, 6, 12], width: 'hug', fill: token('Secondary'), radius: RADIUS.base, children: [txt('CancelText', 'Close', { color: solid(roleTextColor('Secondary')) })] }),
          frame('SaveBtn', { direction: 'horizontal', padding: [6, 12, 6, 12], width: 'hug', fill: token('Primary'), radius: RADIUS.base, children: [txt('SaveText', 'Save changes', { color: solid(roleTextColor('Primary')) })] }),
        ],
      }),
    ],
  })

/** Form field wrapper: Label + control + Help. Control kind (input/textarea/select) comes from
 * the spec name; size/state drive the control's height/border. */
const formField: Renderer = (spec, v) => {
  const size = v.Size ?? 'md'
  const state = (v.State ?? 'default').toLowerCase()
  const kind = spec.name.trim().toLowerCase()
  const isTextarea = kind === 'textarea'
  const isSelect = kind === 'select'
  const disabled = state === 'disabled'
  const h = isTextarea ? 72 : CONTROL_HEIGHT[size] ?? CONTROL_HEIGHT.md
  const [padV, padH] = CONTROL_PAD[size] ?? CONTROL_PAD.md
  const borderColor = state === 'valid' ? roleColor('success') : state === 'invalid' ? roleColor('danger') : COLOR.inputBorder
  const fieldChildren: KitNode[] = isSelect
    ? [txt('FieldText', 'Choose…', { muted: true, fontSize: sizeFont(size), grow: true }), txt('Caret', '▾', { muted: true })]
    : [txt('FieldText', isTextarea ? 'Textarea' : 'Input text', { muted: true, fontSize: sizeFont(size), grow: true })]
  const children: KitNode[] = [txt('Label', 'Label', { bold: false })]
  children.push(
    frame('Field', {
      direction: 'horizontal',
      counterAlign: isTextarea ? 'min' : 'center',
      padding: [padV, padH, padV, padH],
      width: 'fill',
      height: h,
      fill: solid(disabled ? COLOR.trackBg : COLOR.surface),
      stroke: { color: borderColor, weight: 1 },
      radius: sizeRadius(size),
      children: fieldChildren,
    })
  )
  const helpColor = state === 'valid' ? solid(roleColor('success')) : state === 'invalid' ? solid(roleColor('danger')) : solid(COLOR.secondaryText)
  const helpText = state === 'valid' ? 'Looks good!' : state === 'invalid' ? 'Please fix this field.' : 'Help text'
  children.push(txt('Help', helpText, { fontSize: FONT.sm, color: helpColor }))
  return frame(spec.name, { direction: 'vertical', gap: 4, width: 240, children })
}

const formCheck: Renderer = (spec, v) => {
  const kind = spec.name.trim().toLowerCase()
  const isSwitch = kind === 'switch'
  const isRadio = kind === 'radio'
  const state = (v.State ?? 'Checked').toLowerCase()
  const checked = state === 'checked'
  const disabled = state === 'disabled'
  const boxChildren: KitNode[] = checked && !isSwitch ? [txt('Glyph', isRadio ? '●' : '✓', { fontSize: 10, color: solid(roleTextColor('Primary')) })] : []
  const box = frame('Field', {
    direction: 'horizontal',
    primaryAlign: isSwitch ? 'max' : 'center',
    counterAlign: 'center',
    padding: isSwitch ? 2 : 0,
    width: isSwitch ? SPACE.formCheck.switchWidth : SPACE.formCheck.size,
    height: SPACE.formCheck.size,
    fill: checked ? token('Primary') : solid(COLOR.surface),
    stroke: { color: checked ? roleColor('primary') : COLOR.inputBorder, weight: 1 },
    radius: isSwitch || isRadio ? RADIUS.pill : RADIUS.sm,
    children: isSwitch ? [frame('Knob', { direction: 'none', width: 12, height: 12, fill: solid(COLOR.surface), radius: RADIUS.pill, children: [] })] : boxChildren,
  })
  return frame(spec.name, {
    direction: 'horizontal',
    gap: SPACE.formCheck.gap,
    counterAlign: 'center',
    width: 'hug',
    opacity: disabled ? 0.5 : 1,
    children: [box, txt('Label', `${spec.name} label`, {})],
  })
}

const range: Renderer = () => {
  const mid = (SPACE.range.thumb - SPACE.range.trackH) / 2
  return frame('Range', {
    direction: 'none',
    width: 240,
    height: SPACE.range.thumb,
    children: [
      frame('Track', { direction: 'none', width: 240, height: SPACE.range.trackH, x: 0, y: mid, fill: solid(COLOR.trackBg), radius: RADIUS.pill, children: [] }),
      frame('Thumb', { direction: 'none', width: SPACE.range.thumb, height: SPACE.range.thumb, x: 112, y: 0, fill: token('Primary'), radius: RADIUS.pill, children: [] }),
    ],
  })
}

const inputGroup: Renderer = () =>
  frame('InputGroup', {
    direction: 'horizontal',
    counterAlign: 'center',
    width: 300,
    height: CONTROL_HEIGHT.md,
    children: [
      frame('Text', { direction: 'horizontal', primaryAlign: 'center', counterAlign: 'center', padding: [SPACE.inputGroup.addonPadV, SPACE.inputGroup.addonPadH, SPACE.inputGroup.addonPadV, SPACE.inputGroup.addonPadH], height: 'fill', fill: solid(COLOR.trackBg), stroke: { color: COLOR.inputBorder, weight: 1 }, slot: openSlot('Add-on — text or button', ['Button']), children: [txt('AddonText', '@', { muted: true })] }),
      frame('Field', { direction: 'horizontal', counterAlign: 'center', padding: [CONTROL_PAD.md[0], CONTROL_PAD.md[1], CONTROL_PAD.md[0], CONTROL_PAD.md[1]], grow: true, height: 'fill', fill: solid(COLOR.surface), stroke: { color: COLOR.inputBorder, weight: 1 }, children: [txt('FieldText', 'Username', { muted: true, grow: true })] }),
    ],
  })

const buttonGroup: Renderer = (_spec, v) => {
  const size = v.Size ?? 'md'
  const [padV, padH] = CONTROL_PAD[size] ?? CONTROL_PAD.md
  const font = sizeFont(size)
  const seg = (text: string, active = false): KitFrame =>
    frame('Button', {
      direction: 'horizontal',
      primaryAlign: 'center',
      counterAlign: 'center',
      padding: [padV, padH, padV, padH],
      width: 'hug',
      fill: active ? token('Primary') : NONE,
      stroke: { color: roleColor('primary'), weight: 1 },
      children: [txt('Label', text, { fontSize: font, color: active ? solid(roleTextColor('Primary')) : solid(roleColor('primary')) })],
    })
  return frame('ButtonGroup', { direction: 'horizontal', gap: 0, width: 'hug', slot: openSlot('Buttons — drop Button instances', ['Button']), children: [seg('Left', true), seg('Middle'), seg('Right')] })
}

const table: Renderer = () =>
  frame('Table', {
    direction: 'vertical',
    width: 360,
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    radius: RADIUS.sm,
    clip: true,
    children: [
      inst('TableRow', { Type: 'Head' }, { width: 'fill' }),
      inst('TableRow', { Type: 'Body' }, { width: 'fill' }),
      inst('TableRow', { Type: 'Body' }, { width: 'fill' }),
      inst('TableRow', { Type: 'Body' }, { width: 'fill' }),
    ],
  })

const figure: Renderer = () =>
  frame('Figure', {
    direction: 'vertical',
    gap: 8,
    width: 280,
    children: [
      frame('Image', { direction: 'horizontal', primaryAlign: 'center', counterAlign: 'center', width: 280, height: 160, fill: solid(COLOR.trackBg), radius: RADIUS.base, children: [txt('ImagePlaceholder', 'Image', { muted: true })] }),
      txt('Caption', 'A caption for the above image.', { muted: true, fontSize: FONT.sm }),
    ],
  })

const floatingLabel: Renderer = (spec, v) => {
  const control = (v.Control ?? 'Input').trim().toLowerCase()
  const isTextarea = control === 'textarea'
  const h = isTextarea ? 88 : 58
  const value = control === 'select' ? 'Open this select menu' : control === 'textarea' ? 'Comments' : 'name@example.com'
  return frame(spec.name, {
    direction: 'none',
    width: 260,
    height: h,
    children: [
      frame('Field', {
        direction: 'none',
        x: 0,
        y: 0,
        width: 260,
        height: h,
        fill: solid(COLOR.surface),
        stroke: { color: COLOR.inputBorder, weight: 1 },
        radius: RADIUS.base,
        children: [txt('FieldText', value, { x: 12, y: h - 26, muted: true })],
      }),
      // The floated (resting-small) label — sits at the top-left, mapped to <label> on export.
      txt('Label', 'Email address', { x: 12, y: 6, fontSize: 12, muted: true }),
    ],
  })
}

const tooltip: Renderer = (spec) =>
  frame(spec.name, {
    direction: 'horizontal',
    primaryAlign: 'center',
    counterAlign: 'center',
    padding: [4, 8, 4, 8],
    width: 'hug',
    height: 'hug',
    fill: solid({ r: 0, g: 0, b: 0 }),
    radius: RADIUS.base,
    opacity: 0.9,
    children: [txt('Inner', labelText(spec, 'Tooltip text'), { fontSize: 14, color: solid(COLOR.surface) })],
  })

const popover: Renderer = () =>
  frame('Popover', {
    direction: 'vertical',
    width: 260,
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    radius: RADIUS.base,
    clip: true,
    children: [
      frame('Header', {
        direction: 'horizontal',
        padding: [8, 16, 8, 16],
        width: 'fill',
        fill: solid(COLOR.trackBg),
        stroke: { color: COLOR.border, weight: 1, side: 'bottom' },
        children: [txt('HeaderText', 'Popover title', { bold: true })],
      }),
      frame('Body', { direction: 'vertical', padding: 16, width: 'fill', children: [txt('BodyText', 'And here is some popover content.', {})] }),
    ],
  })

// ---- item sub-components (phase 12): standalone masters the containers compose from ----------

const accordionItem: Renderer = (spec, v) => {
  const state = (v.State ?? 'Closed').trim().toLowerCase()
  const open = state === 'open'
  const disabled = state === 'disabled'
  return frame('AccordionItem', {
    direction: 'vertical',
    width: 360,
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    radius: RADIUS.base,
    clip: true,
    opacity: disabled ? 0.65 : 1,
    children: [
      frame('Header', {
        direction: 'horizontal',
        padding: [SPACE.accordion.btnPadV, SPACE.accordion.btnPadH, SPACE.accordion.btnPadV, SPACE.accordion.btnPadH],
        width: 'fill',
        fill: open ? solid(tint(roleColor('primary'), 0.8)) : solid(COLOR.surface),
        stroke: { color: COLOR.border, weight: 1, side: 'bottom' },
        children: [
          frame('Button', {
            direction: 'horizontal',
            primaryAlign: 'space-between',
            counterAlign: 'center',
            width: 'fill',
            grow: true,
            children: [
              txt('Title', labelText(spec, 'Accordion Item'), { color: open ? solid(shade(roleColor('primary'), 0.2)) : solid(COLOR.bodyText) }),
              txt('Chevron', open ? '▾' : '▸', { muted: true }),
            ],
          }),
        ],
      }),
      frame('Collapse', {
        direction: 'vertical',
        width: 'fill',
        children: [
          frame('Body', {
            direction: 'vertical',
            padding: [SPACE.accordion.bodyPadV, SPACE.accordion.bodyPadH, SPACE.accordion.bodyPadV, SPACE.accordion.bodyPadH],
            width: 'fill',
            slot: openSlot('Accordion panel content', ['Button']),
            children: [txt('BodyText', 'Accordion body — expanded content.', {})],
          }),
        ],
      }),
    ],
  })
}

const listGroupItem: Renderer = (_spec, v) => {
  const state = (v.State ?? 'Default').trim().toLowerCase()
  const active = state === 'active'
  const disabled = state === 'disabled'
  return frame('ListGroupItem', {
    direction: 'horizontal',
    counterAlign: 'center',
    padding: [SPACE.listGroupItem.padV, SPACE.listGroupItem.padH, SPACE.listGroupItem.padV, SPACE.listGroupItem.padH],
    width: 280,
    fill: active ? token('Primary') : solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    opacity: disabled ? 0.65 : 1,
    children: [
      frame('Content', {
        direction: 'horizontal',
        counterAlign: 'center',
        width: 'fill',
        grow: true,
        slot: openSlot('Item content — text, badge, or a form control', ['Badge']),
        children: [txt('ItemText', 'An item', { color: active ? solid(roleTextColor('Primary')) : solid(COLOR.bodyText) })],
      }),
    ],
  })
}

const navLink: Renderer = (_spec, v) => {
  const state = (v.State ?? 'Default').trim().toLowerCase()
  const active = state === 'active'
  const disabled = state === 'disabled'
  return frame('NavLink', {
    direction: 'horizontal',
    width: 'hug',
    children: [
      frame('Link', {
        direction: 'horizontal',
        padding: [SPACE.navLink.padV, SPACE.navLink.padH, SPACE.navLink.padV, SPACE.navLink.padH],
        width: 'hug',
        fill: active ? token('Primary') : NONE,
        radius: active ? RADIUS.base : 0,
        opacity: disabled ? 0.65 : 1,
        children: [txt('Label', 'Link', { color: active ? solid(roleTextColor('Primary')) : solid(roleColor('primary')) })],
      }),
    ],
  })
}

const pageItem: Renderer = (_spec, v) => {
  const state = (v.State ?? 'Default').trim().toLowerCase()
  const active = state === 'active'
  const disabled = state === 'disabled'
  const label = state === 'prev' ? '«' : state === 'next' ? '»' : state === 'ellipsis' ? '…' : '1'
  return frame('PageItem', {
    direction: 'horizontal',
    width: 'hug',
    children: [
      frame('Link', {
        direction: 'horizontal',
        primaryAlign: 'center',
        counterAlign: 'center',
        padding: [SPACE.pageLink.padV, SPACE.pageLink.padH, SPACE.pageLink.padV, SPACE.pageLink.padH],
        fill: active ? token('Primary') : solid(COLOR.surface),
        stroke: { color: COLOR.border, weight: 1 },
        opacity: disabled ? 0.65 : 1,
        children: [txt('PageText', label, { color: active ? solid(roleTextColor('Primary')) : solid(roleColor('primary')) })],
      }),
    ],
  })
}

const dropdownItem: Renderer = (_spec, v) => {
  const variant = (v.Variant ?? 'Default').trim().toLowerCase()
  if (variant === 'divider') {
    return frame('DropdownItem', { direction: 'vertical', width: 200, padding: [SPACE.dropdown.padV, 0, SPACE.dropdown.padV, 0], children: [frame('Divider', { direction: 'none', width: 'fill', height: 1, fill: solid(COLOR.border), children: [] })] })
  }
  if (variant === 'header') {
    return frame('DropdownItem', { direction: 'vertical', width: 200, children: [frame('Header', { direction: 'horizontal', padding: [SPACE.dropdown.itemPadV, SPACE.dropdown.itemPadH, SPACE.dropdown.itemPadV, SPACE.dropdown.itemPadH], width: 'fill', children: [txt('HeaderText', 'Dropdown header', { muted: true, bold: true, fontSize: FONT.sm })] })] })
  }
  const active = variant === 'active'
  const disabled = variant === 'disabled'
  return frame('DropdownItem', {
    direction: 'vertical',
    width: 200,
    children: [
      frame('Link', {
        direction: 'horizontal',
        padding: [SPACE.dropdown.itemPadV, SPACE.dropdown.itemPadH, SPACE.dropdown.itemPadV, SPACE.dropdown.itemPadH],
        width: 'fill',
        fill: active ? token('Primary') : NONE,
        opacity: disabled ? 0.65 : 1,
        children: [txt('LinkText', 'Action', { color: active ? solid(roleTextColor('Primary')) : solid(COLOR.bodyText) })],
      }),
    ],
  })
}

const tableRow: Renderer = (_spec, v) => {
  const head = (v.Type ?? 'Head').trim().toLowerCase() === 'head'
  const cells = head ? ['#', 'Name', 'Role'] : ['1', 'Alice', 'Admin']
  return frame('TableRow', {
    direction: 'horizontal',
    width: 360,
    fill: head ? solid(COLOR.subtleBg) : solid(COLOR.surface),
    children: cells.map((c) =>
      frame(head ? 'Th' : 'Td', {
        direction: 'horizontal',
        grow: true,
        counterAlign: 'center',
        padding: [SPACE.tableCell.padV, SPACE.tableCell.padH, SPACE.tableCell.padV, SPACE.tableCell.padH],
        stroke: { color: COLOR.border, weight: 1, side: 'bottom' },
        children: [txt('CellText', c, { bold: head })],
      })
    ),
  })
}

const breadcrumbItem: Renderer = (_spec, v) => {
  const active = (v.State ?? 'Link').trim().toLowerCase() === 'active'
  return frame('BreadcrumbItem', {
    direction: 'horizontal',
    width: 'hug',
    children: [txt('Label', active ? 'Data' : 'Home', { color: active ? solid(COLOR.secondaryText) : solid(roleColor('primary')) })],
  })
}

const tabPane: Renderer = () =>
  frame('TabPane', {
    direction: 'vertical',
    padding: 16,
    width: 360,
    fill: solid(COLOR.surface),
    slot: openSlot('Tab panel content'),
    children: [txt('PaneText', 'Active tab panel content.', {})],
  })

const carouselSlide: Renderer = () =>
  frame('CarouselSlide', {
    direction: 'none',
    width: 360,
    height: 200,
    fill: solid(COLOR.trackBg),
    radius: RADIUS.base,
    clip: true,
    children: [
      frame('Image', { direction: 'horizontal', primaryAlign: 'center', counterAlign: 'center', x: 0, y: 0, width: 360, height: 200, children: [txt('ImgText', 'Slide', { muted: true })] }),
      frame('Caption', { direction: 'vertical', x: 110, y: 150, width: 140, slot: openSlot('Slide caption', ['Button']), children: [txt('CaptionText', 'Slide caption', { color: solid(COLOR.surface) })] }),
    ],
  })

const RENDERERS: Record<string, Renderer> = {
  button,
  badge,
  alert,
  card,
  spinner,
  'close-button': closeButton,
  placeholder,
  'list-group': listGroup,
  pagination,
  progress,
  navbar,
  breadcrumb,
  nav: navStrip,
  tabs,
  carousel,
  dropdown,
  accordion,
  collapse,
  toast,
  offcanvas,
  modal,
  'form-field': formField,
  'form-check': formCheck,
  range,
  'input-group': inputGroup,
  'button-group': buttonGroup,
  table,
  figure,
  'floating-label': floatingLabel,
  tooltip,
  popover,
  'accordion-item': accordionItem,
  'list-group-item': listGroupItem,
  navlink: navLink,
  'page-item': pageItem,
  'dropdown-item': dropdownItem,
  'table-row': tableRow,
  'breadcrumb-item': breadcrumbItem,
  'tab-pane': tabPane,
  'carousel-slide': carouselSlide,
}

/** The recognizer kinds (+ name-slugs for prototype skeletons) that have a dedicated renderer.
 * A test asserts every spec resolves into this set, so no generated component silently degrades
 * to the labeled-placeholder fallback. */
export const RENDERER_KINDS: readonly string[] = Object.keys(RENDERERS)

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')

/** The recognizer kind a spec resolves to (single source of truth for dispatch + reporting). */
export function specKind(spec: ComponentSpec): string | null {
  const def = { key: `gen-${spec.name}`, setName: spec.name, properties: planComponent(spec).componentDef.properties }
  return matchBootstrapComponent(spec.name, def, slug)?.kind ?? null
}

/** A labeled-placeholder fallback for a spec whose kind has no dedicated renderer: a titled box
 * with one sub-frame per declared part, so the blank is still self-describing. */
function fallbackRenderer(spec: ComponentSpec): KitFrame {
  const parts = spec.parts ?? []
  const children: KitNode[] = parts.length
    ? parts.map((p) =>
        p.text != null
          ? txt(p.name, p.text, {})
          : frame(p.name, { direction: 'horizontal', counterAlign: 'center', padding: 8, width: 'fill', height: 32, fill: solid(COLOR.subtleBg), stroke: { color: COLOR.border, weight: 1 }, radius: RADIUS.sm, children: [txt(`${p.name}Label`, p.name, { muted: true, fontSize: FONT.sm })] })
      )
    : [txt('Label', spec.name, { muted: true })]
  return frame(spec.name, { direction: 'vertical', gap: 8, padding: 12, width: 240, fill: solid(COLOR.surface), stroke: { color: COLOR.border, weight: 1 }, radius: RADIUS.base, children })
}

/** Build the pixel-accurate blueprint for ONE variant of a spec. Dispatch prefers the recognizer
 * kind; specs the exporter doesn't recognize (Modal — built as a static skeleton the designer
 * later wires as a prototype overlay, §6.3) fall back to a name-slug renderer, then to a labeled
 * placeholder. */
export function blueprintVariant(spec: ComponentSpec, values: Vals): KitFrame {
  const kind = specKind(spec) ?? slug(spec.name)
  const renderer = RENDERERS[kind]
  return renderer ? renderer(spec, values) : fallbackRenderer(spec)
}
