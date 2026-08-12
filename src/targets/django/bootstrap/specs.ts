/**
 * REFORM phase 10–11 / B4 (docs/REFORM.md §4/B4): generation spec registry — the code→design half
 * of the framework adapter. Each spec describes a Bootstrap component as a Figma master
 * component set: its variant/boolean props (with options), interactive states, and named parts.
 *
 * This is the generation-side descriptor. The recognition-side truth is `matchBootstrapComponent`
 * (components.ts); the pixel-accurate VISUALS are `generate/blueprint.ts`. The three are kept
 * SYMMETRIC by the round-trip test (generate/plan.test.ts): every spec, planned into a synthetic
 * `IrComponentDef` and fed back through the matcher, is recognized as a Bootstrap component — so a
 * generated kit round-trips through the B3 exporter unchanged. (The lone exception, `Modal`, is a
 * static skeleton the designer wires as a prototype overlay per DESIGN-CONVENTIONS §6.3; it is
 * deliberately NOT recognized and exports as a custom partial.)
 *
 * Keep set names / prop names / parts here in step with the matcher, DESIGN-CONVENTIONS §6.2, and
 * the designer catalog docs/BOOTSTRAP-CATALOG.md.
 */

/** A variant or boolean property to put on the generated component set. */
export interface SpecProp {
  /** Figma property name (matcher lowercases it): `Variant`, `Size`, `State`, `Dismissible`… */
  name: string
  type: 'VARIANT' | 'BOOLEAN'
  /** VARIANT option values, in order; the first is the default. */
  options?: string[]
  /** BOOLEAN default. */
  boolDefault?: boolean
}

/** A named child layer created inside every variant — matches a matcher part key (§6.2). */
export interface SpecPart {
  name: string
  /** Placeholder text for a text part (Label/Title…); absent → a container part. */
  text?: string
}

export interface ComponentSpec {
  /** Component-set name = the Bootstrap pattern (matcher keys off the last `/`-segment). */
  name: string
  props: SpecProp[]
  /** Interactive states → a `State` variant (default/hover/active/disabled snapshots). */
  states?: string[]
  parts?: SpecPart[]
}

/** The eight Bootstrap role colors, in canonical order (first = default). */
const ROLES = ['Primary', 'Secondary', 'Success', 'Danger', 'Warning', 'Info', 'Light', 'Dark']
const SIZES = ['sm', 'md', 'lg']

const variant = (name: string, options: string[]): SpecProp => ({ name, type: 'VARIANT', options })
const bool = (name: string, boolDefault = false): SpecProp => ({ name, type: 'BOOLEAN', boolDefault })

/**
 * The default Bootstrap kit — every component the exporter recognizes (DESIGN-CONVENTIONS §6.2),
 * plus the content elements Table/Figure and a static Modal skeleton. Variant matrices are kept
 * meaningful: role×size×state where it reads (Button, forms), a single filled frame for
 * structural widgets. The planner handles any matrix size, so this is freely tunable.
 */
export const BOOTSTRAP_SPECS: readonly ComponentSpec[] = [
  // ---- Components ----------------------------------------------------------------------
  {
    // Variant carries both solid roles and Outline-* (so the exporter's `btn-{{variant|lower}}`
    // yields `btn-outline-primary` natively) plus Link.
    name: 'Button',
    props: [variant('Variant', [...ROLES, ...ROLES.map((r) => `Outline-${r}`), 'Link']), variant('Size', SIZES)],
    states: ['default', 'hover', 'active', 'disabled'],
    parts: [{ name: 'Label', text: 'Button' }],
  },
  {
    name: 'Badge',
    props: [variant('Variant', ROLES), variant('Shape', ['Default', 'Pill'])],
    parts: [{ name: 'Label', text: 'Badge' }],
  },
  {
    name: 'Alert',
    props: [variant('Variant', ROLES), bool('Dismissible')],
    parts: [{ name: 'Text', text: 'A short alert message.' }],
  },
  {
    name: 'Card',
    props: [],
    parts: [
      { name: 'Header', text: 'Card header' },
      { name: 'Body', text: 'Card body text.' },
      { name: 'Footer', text: 'Card footer' },
    ],
  },
  {
    name: 'Accordion',
    props: [], // container → lone master + content slot (see blueprint)
    parts: [
      { name: 'Item' },
      { name: 'Header', text: 'Accordion item' },
      { name: 'Body', text: 'Accordion body content.' },
    ],
  },
  {
    name: 'Breadcrumb',
    props: [], // composed from BreadcrumbItem instances (divider is CSS on the parent)
    parts: [{ name: 'Item', text: 'Home' }],
  },
  {
    name: 'ButtonGroup',
    props: [], // container → lone master + slot for Button instances
    parts: [{ name: 'Button', text: 'Left' }],
  },
  {
    name: 'CloseButton',
    props: [variant('Theme', ['Light', 'Dark'])],
    parts: [],
  },
  {
    name: 'Collapse',
    props: [variant('State', ['Collapsed', 'Expanded'])],
    parts: [
      { name: 'Toggle', text: 'Toggle content' },
      { name: 'Content', text: 'Collapsible content.' },
    ],
  },
  {
    name: 'Dropdown',
    props: [], // container → lone master + Menu slot
    parts: [
      { name: 'Toggle', text: 'Dropdown' },
      { name: 'Menu' },
      { name: 'Item', text: 'Action' },
    ],
  },
  {
    name: 'ListGroup',
    props: [], // container → lone master + items slot
    parts: [{ name: 'Item', text: 'An item' }],
  },
  {
    name: 'Navbar',
    props: [], // container → lone master + Nav slot
    parts: [
      { name: 'Brand', text: 'Navbar' },
      { name: 'Nav' },
      { name: 'Item', text: 'Home' },
    ],
  },
  {
    name: 'Nav',
    props: [],
    parts: [{ name: 'Item', text: 'Active' }],
  },
  {
    name: 'Pills',
    props: [],
    parts: [{ name: 'Item', text: 'Active' }],
  },
  {
    name: 'Pagination',
    props: [], // composed from PageItem instances
    parts: [{ name: 'Item', text: '1' }],
  },
  {
    name: 'Progress',
    props: [variant('Variant', ROLES)],
    parts: [{ name: 'Bar' }],
  },
  {
    name: 'Spinner',
    props: [variant('Variant', ROLES), variant('Type', ['border', 'grow'])],
  },
  {
    name: 'Toast',
    props: [], // container → lone master + Body slot
    parts: [
      { name: 'Header', text: 'Notification' },
      { name: 'Body', text: 'Hello, this is a toast message.' },
    ],
  },
  {
    name: 'Offcanvas',
    props: [], // container → lone master + Body slot
    parts: [
      { name: 'Header' },
      { name: 'Title', text: 'Offcanvas' },
      { name: 'Body', text: 'Offcanvas body content.' },
    ],
  },
  {
    // The full tabbed widget: a Nav strip of Tab links + a Content area of Panes. The generator
    // seeds two tabs/panes; the exporter order-pairs Tab[i]↔Pane[i] (wave 3f).
    name: 'Tabs',
    props: [],
    parts: [
      { name: 'Nav' },
      { name: 'Tab', text: 'Tab one' },
      { name: 'Tab', text: 'Tab two' },
      { name: 'Content' },
      { name: 'Pane', text: 'Panel one' },
      { name: 'Pane', text: 'Panel two' },
    ],
  },
  {
    name: 'Carousel',
    props: [],
    parts: [
      { name: 'Inner' },
      { name: 'Slide' },
      { name: 'Prev', text: 'Previous' },
      { name: 'Next', text: 'Next' },
      { name: 'Caption', text: 'Slide one' },
    ],
  },
  {
    name: 'Placeholder',
    props: [variant('Size', ['xs', 'sm', 'md', 'lg'])],
    parts: [],
  },

  // ---- Forms ---------------------------------------------------------------------------
  {
    name: 'Input',
    props: [variant('Size', SIZES), variant('State', ['default', 'valid', 'invalid', 'disabled'])],
    parts: [{ name: 'Label', text: 'Label' }, { name: 'Field' }, { name: 'Help', text: 'Help text' }],
  },
  {
    name: 'Textarea',
    props: [variant('Size', SIZES), variant('State', ['default', 'valid', 'invalid'])],
    parts: [{ name: 'Label', text: 'Label' }, { name: 'Field' }, { name: 'Help', text: 'Help text' }],
  },
  {
    name: 'Select',
    props: [variant('Size', SIZES), variant('State', ['default', 'valid', 'invalid', 'disabled'])],
    parts: [{ name: 'Label', text: 'Label' }, { name: 'Field' }, { name: 'Help', text: 'Help text' }],
  },
  {
    name: 'Checkbox',
    props: [variant('State', ['Checked', 'Unchecked', 'Disabled'])],
    parts: [{ name: 'Field' }, { name: 'Label', text: 'Checkbox label' }],
  },
  {
    name: 'Radio',
    props: [variant('State', ['Checked', 'Unchecked', 'Disabled'])],
    parts: [{ name: 'Field' }, { name: 'Label', text: 'Radio label' }],
  },
  {
    name: 'Switch',
    props: [variant('State', ['Checked', 'Unchecked', 'Disabled'])],
    parts: [{ name: 'Field' }, { name: 'Label', text: 'Switch label' }],
  },
  {
    name: 'Range',
    props: [],
    parts: [],
  },
  {
    name: 'InputGroup',
    props: [],
    parts: [{ name: 'Text', text: '@' }, { name: 'Field', text: 'Username' }],
  },
  {
    // `.form-floating` — the label rests as a placeholder, then floats up on focus/fill.
    name: 'FloatingLabels',
    props: [variant('Control', ['Input', 'Textarea', 'Select'])],
    parts: [{ name: 'Field' }, { name: 'Label', text: 'Email address' }],
  },

  // ---- Content -------------------------------------------------------------------------
  {
    name: 'Table',
    props: [], // composed from TableRow instances
    parts: [{ name: 'Row' }, { name: 'Th', text: '#' }, { name: 'Td', text: 'Cell' }, { name: 'Caption', text: 'Table caption' }],
  },
  {
    name: 'Figure',
    props: [],
    parts: [{ name: 'Image' }, { name: 'Caption', text: 'A caption for the above image.' }],
  },
  // ---- Prototype skeletons (built as overlays per §6.3 — NOT recognized, generated as
  // starting-point blanks only). Dispatched in blueprint.ts by name.
  {
    name: 'Modal',
    props: [],
    parts: [
      { name: 'Header' },
      { name: 'Title', text: 'Modal title' },
      { name: 'Body', text: 'Modal body content.' },
      { name: 'Footer' },
    ],
  },
  {
    name: 'Tooltip',
    props: [],
    parts: [{ name: 'Inner', text: 'Tooltip text' }],
  },
  {
    name: 'Popover',
    props: [],
    parts: [
      { name: 'Header', text: 'Popover title' },
      { name: 'Body', text: 'And here is some popover content.' },
    ],
  },

  // ---- Item sub-components (phase 12) --------------------------------------------------
  // Standalone recognized masters (variants + slots) that the container masters compose from as
  // INSTANCES. Each round-trips on its own: its partial carries the Bootstrap class + parts, and
  // wiring items (AccordionItem, TabPane) take a parent-minted unique id as an include param.
  {
    name: 'AccordionItem',
    props: [variant('State', ['Closed', 'Open', 'Disabled'])],
    parts: [{ name: 'Header' }, { name: 'Button', text: 'Accordion Item' }, { name: 'Collapse' }, { name: 'Body', text: 'Accordion body content.' }],
  },
  {
    name: 'ListGroupItem',
    props: [variant('State', ['Default', 'Active', 'Disabled'])],
    parts: [{ name: 'Content', text: 'An item' }],
  },
  {
    name: 'NavLink',
    props: [variant('State', ['Default', 'Active', 'Disabled'])],
    parts: [{ name: 'Label', text: 'Link' }],
  },
  {
    name: 'PageItem',
    props: [variant('State', ['Default', 'Active', 'Disabled', 'Prev', 'Next', 'Ellipsis'])],
    parts: [{ name: 'Link', text: '1' }],
  },
  {
    name: 'DropdownItem',
    props: [variant('Variant', ['Default', 'Active', 'Disabled', 'Header', 'Divider'])],
    parts: [{ name: 'Link', text: 'Action' }],
  },
  {
    name: 'TableRow',
    props: [variant('Type', ['Head', 'Body'])],
    parts: [{ name: 'Th', text: '#' }, { name: 'Td', text: 'Cell' }],
  },
  {
    name: 'BreadcrumbItem',
    props: [variant('State', ['Link', 'Active'])],
    parts: [{ name: 'Label', text: 'Home' }],
  },
  {
    name: 'TabPane',
    props: [variant('State', ['Active', 'Inactive'])],
    parts: [{ name: 'Content', text: 'Tab panel content.' }],
  },
  {
    name: 'CarouselSlide',
    props: [variant('State', ['Active', 'Inactive'])],
    parts: [{ name: 'Image' }, { name: 'Caption', text: 'Slide caption' }],
  },
]
