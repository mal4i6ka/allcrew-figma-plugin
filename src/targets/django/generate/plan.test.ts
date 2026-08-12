import test from 'node:test'
import assert from 'node:assert/strict'
import { planComponent, planKit, countVariants } from './plan.ts'
import { BOOTSTRAP_SPECS } from '../bootstrap/specs.ts'
import { matchBootstrapComponent } from '../bootstrap/components.ts'
import type { ComponentSpec } from '../bootstrap/specs.ts'

const toVar = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')

test('planComponent: variant matrix is the cartesian product, named Figma-style', () => {
  const spec: ComponentSpec = {
    name: 'Button',
    props: [
      { name: 'Variant', type: 'VARIANT', options: ['Primary', 'Secondary'] },
      { name: 'Size', type: 'VARIANT', options: ['sm', 'lg'] },
    ],
    states: ['default', 'hover'],
  }
  const plan = planComponent(spec)
  assert.equal(plan.isSet, true)
  assert.equal(plan.variants.length, 2 * 2 * 2) // variant × size × state
  assert.equal(plan.variants[0].name, 'Variant=Primary, Size=sm, State=default')
  assert.deepEqual(plan.variants[0].values, { Variant: 'Primary', Size: 'sm', State: 'default' })
  assert.ok(plan.variants.some((v) => v.name === 'Variant=Secondary, Size=lg, State=hover'))
})

test('planComponent: no variant props → a lone component, not a set', () => {
  const plan = planComponent({ name: 'Card', props: [], parts: [{ name: 'Body', text: 'x' }] })
  assert.equal(plan.isSet, false)
  assert.equal(plan.variants.length, 1)
  assert.equal(plan.variants[0].name, 'Card')
  assert.deepEqual(plan.variants[0].values, {})
})

test('planComponent: componentDef carries the props the matcher reads (variant options, booleans, State)', () => {
  const plan = planComponent(BOOTSTRAP_SPECS.find((s) => s.name === 'Alert')!)
  const props = plan.componentDef.properties
  const variant = props.find((p) => p.name === 'Variant')!
  assert.equal(variant.type, 'VARIANT')
  assert.deepEqual(variant.variantOptions, ['Primary', 'Secondary', 'Success', 'Danger', 'Warning', 'Info', 'Light', 'Dark'])
  assert.equal(variant.defaultValue, 'Primary') // first option is the default
  const dismissible = props.find((p) => p.name === 'Dismissible')!
  assert.equal(dismissible.type, 'BOOLEAN')
  assert.equal(dismissible.variantOptions, null)
})

test('planComponent: a states list synthesizes a State variant prop in the componentDef', () => {
  const plan = planComponent(BOOTSTRAP_SPECS.find((s) => s.name === 'Button')!)
  const state = plan.componentDef.properties.find((p) => p.name === 'State')!
  assert.equal(state.type, 'VARIANT')
  assert.deepEqual(state.variantOptions, ['default', 'hover', 'active', 'disabled'])
})

// --- the linchpin: round-trip parity between generation and recognition ------------------

// Specs generated as STATIC skeletons the designer later wires as a prototype overlay
// (DESIGN-CONVENTIONS §6.3): intentionally NOT recognized by the exporter.
const PROTOTYPE_SKELETONS = new Set(['Modal', 'Tooltip', 'Popover'])

// The kind every spec must round-trip to. Doubles as a coverage checklist (test below).
const EXPECTED_KIND: Record<string, string> = {
  Button: 'button',
  Badge: 'badge',
  Alert: 'alert',
  Card: 'card',
  Spinner: 'spinner',
  Input: 'form-field',
  Select: 'form-field',
  Textarea: 'form-field',
  Checkbox: 'form-check',
  Radio: 'form-check',
  Switch: 'form-check',
  Tabs: 'tabs',
  Carousel: 'carousel',
  Accordion: 'accordion',
  Dropdown: 'dropdown',
  Navbar: 'navbar',
  ListGroup: 'list-group',
  Pagination: 'pagination',
  Progress: 'progress',
  Toast: 'toast',
  Offcanvas: 'offcanvas',
  Collapse: 'collapse',
  Breadcrumb: 'breadcrumb',
  Nav: 'nav',
  Pills: 'nav',
  ButtonGroup: 'button-group',
  CloseButton: 'close-button',
  Placeholder: 'placeholder',
  Range: 'range',
  InputGroup: 'input-group',
  FloatingLabels: 'floating-label',
  Table: 'table',
  Figure: 'figure',
  // phase 12 item sub-components:
  AccordionItem: 'accordion-item',
  ListGroupItem: 'list-group-item',
  NavLink: 'navlink',
  PageItem: 'page-item',
  DropdownItem: 'dropdown-item',
  TableRow: 'table-row',
  BreadcrumbItem: 'breadcrumb-item',
  TabPane: 'tab-pane',
  CarouselSlide: 'carousel-slide',
}

test('ROUND-TRIP: every non-skeleton spec is recognized as its expected kind', () => {
  for (const spec of BOOTSTRAP_SPECS) {
    const plan = planComponent(spec)
    const def = { key: `gen-${spec.name}`, setName: plan.componentDef.setName, properties: plan.componentDef.properties }
    const match = matchBootstrapComponent(plan.name, def, toVar)
    if (PROTOTYPE_SKELETONS.has(spec.name)) {
      assert.equal(match, null, `${spec.name} is a prototype skeleton — must NOT be recognized`)
      continue
    }
    assert.ok(match, `generated ${spec.name} must be recognized`)
    const expected = EXPECTED_KIND[spec.name]
    if (expected) assert.equal(match!.kind, expected, `generated ${spec.name} → kind ${expected}`)
  }
})

test('every spec is classified (has an expected kind or is a known skeleton)', () => {
  for (const spec of BOOTSTRAP_SPECS) {
    assert.ok(
      EXPECTED_KIND[spec.name] != null || PROTOTYPE_SKELETONS.has(spec.name),
      `add ${spec.name} to EXPECTED_KIND or PROTOTYPE_SKELETONS`
    )
  }
})

test('ROUND-TRIP: the generated variant/size classes match what the recognizer would emit', () => {
  const plan = planComponent(BOOTSTRAP_SPECS.find((s) => s.name === 'Button')!)
  const def = { key: 'gen-Button', setName: 'Button', properties: plan.componentDef.properties }
  const match = matchBootstrapComponent(plan.name, def, toVar)!
  assert.ok(match.classes.includes("btn-{{ variant|default:'primary'|lower }}"))
  assert.ok(match.classes.includes("btn-{{ size|default:'sm'|lower }}")) // first size option is the default
})

test('planKit + countVariants over the real registry', () => {
  const plans = planKit(BOOTSTRAP_SPECS)
  assert.equal(plans.length, BOOTSTRAP_SPECS.length)
  // Button alone: (8 solid + 8 outline + Link = 17) × 3 sizes × 4 states = 204.
  assert.equal(plans.find((p) => p.name === 'Button')!.variants.length, 204)
  assert.ok(countVariants(plans) > 204)
})
