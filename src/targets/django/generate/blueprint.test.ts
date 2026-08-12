import test from 'node:test'
import assert from 'node:assert/strict'
import { blueprintVariant, specKind, RENDERER_KINDS, type KitNode } from './blueprint.ts'
import { BOOTSTRAP_SPECS } from '../bootstrap/specs.ts'

const nameSlug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')

const spec = (name: string) => BOOTSTRAP_SPECS.find((s) => s.name === name)!

function walk(node: KitNode, visit: (n: KitNode) => void): void {
  visit(node)
  if (node.type === 'frame') for (const child of node.children) walk(child, visit)
}
function names(node: KitNode): string[] {
  const out: string[] = []
  walk(node, (n) => out.push(n.name))
  return out
}
function findByName(node: KitNode, name: string): KitNode | null {
  let found: KitNode | null = null
  walk(node, (n) => {
    if (!found && n.name === name) found = n
  })
  return found
}

test('button variant: default state binds the role fill to a token; padding/radius follow size', () => {
  const root = blueprintVariant(spec('Button'), { Variant: 'Danger', Size: 'lg', State: 'default' })
  assert.equal(root.name, 'Button')
  assert.equal(root.fill?.kind, 'token')
  if (root.fill?.kind === 'token') assert.equal(root.fill.role, 'Danger')
  assert.equal(root.radius, 8) // lg radius
  assert.deepEqual(root.padding, [8, 16, 8, 16]) // lg padding
})

test('button hover/active use a literal shade (not a token) so the darker value renders', () => {
  const hover = blueprintVariant(spec('Button'), { Variant: 'Primary', Size: 'md', State: 'hover' })
  assert.equal(hover.fill?.kind, 'solid')
  const disabled = blueprintVariant(spec('Button'), { Variant: 'Primary', Size: 'md', State: 'disabled' })
  assert.equal(disabled.opacity, 0.65)
})

test('link button has no fill and primary-colored text', () => {
  const link = blueprintVariant(spec('Button'), { Variant: 'Link', Size: 'md', State: 'default' })
  assert.equal(link.fill?.kind, 'none')
})

test('card blueprint exposes Header/Body/Footer layers (the recognizer part keys)', () => {
  const all = names(blueprintVariant(spec('Card'), {}))
  for (const part of ['Header', 'Body', 'Footer']) assert.ok(all.includes(part), `Card missing ${part}`)
})

test('form-field (Input) renders Label + Field + Help; invalid state colors border + help danger', () => {
  const invalid = blueprintVariant(spec('Input'), { Size: 'md', State: 'invalid' })
  assert.equal(invalid.name, 'Input')
  for (const part of ['Label', 'Field', 'Help']) assert.ok(findByName(invalid, part), `Input missing ${part}`)
  const field = findByName(invalid, 'Field')
  assert.ok(field && field.type === 'frame' && field.stroke, 'Field should carry a border')
})

test('form-check (Checkbox) checked state fills the box with the primary token', () => {
  const checked = blueprintVariant(spec('Checkbox'), { State: 'Checked' })
  const box = findByName(checked, 'Field')
  assert.ok(box && box.type === 'frame')
  if (box && box.type === 'frame') assert.equal(box.fill?.kind, 'token')
  const disabled = blueprintVariant(spec('Checkbox'), { State: 'Disabled' })
  assert.equal(disabled.opacity, 0.5)
})

test('phase 12: Table composes from TableRow instances; the TableRow item carries Th/Td cells', () => {
  const table = blueprintVariant(spec('Table'), {})
  const rows: Extract<KitNode, { type: 'instance' }>[] = []
  walk(table, (n) => {
    if (n.type === 'instance') rows.push(n)
  })
  assert.ok(rows.length >= 2, 'Table should compose from TableRow instances')
  assert.ok(rows.every((r) => r.of === 'TableRow'))
  const rowNames = names(blueprintVariant(spec('TableRow'), { Type: 'Head' }))
  assert.ok(rowNames.includes('Th'))
})

test('Modal prototype-skeleton still gets its dedicated blueprint (not the placeholder fallback)', () => {
  assert.equal(specKind(spec('Modal')), null) // not recognized — dispatched by name
  const root = blueprintVariant(spec('Modal'), {})
  assert.equal(root.name, 'Modal')
  const all = names(root)
  for (const part of ['Header', 'Title', 'Body', 'Footer']) assert.ok(all.includes(part), `Modal missing ${part}`)
})

test('every spec yields a non-empty frame blueprint rooted at its set name', () => {
  for (const s of BOOTSTRAP_SPECS) {
    const root = blueprintVariant(s, {})
    assert.equal(root.type, 'frame')
    assert.ok(root.name.length > 0)
  }
})

test('container components mark exactly one content region as a slot, with guidance text', () => {
  // After phase-12 composition, masters whose item-container is the ROOT (Accordion, ListGroup,
  // Nav, …) hold item INSTANCES directly and expose no master-level slot (the slot lives inside
  // each item). Masters with a child-frame container keep that frame as the slot.
  const expected: Record<string, string> = {
    Navbar: 'Nav',
    Card: 'Body',
    Dropdown: 'Menu',
    Toast: 'Body',
    Modal: 'Body',
    Offcanvas: 'Body',
    ButtonGroup: 'ButtonGroup',
    InputGroup: 'Text',
    Tabs: 'Content',
    Carousel: 'Inner',
  }
  for (const [name, layer] of Object.entries(expected)) {
    const root = blueprintVariant(spec(name), {})
    const slots: Extract<KitNode, { type: 'frame' }>[] = []
    walk(root, (n) => {
      if (n.type === 'frame' && n.slot) slots.push(n)
    })
    assert.equal(slots.length, 1, `${name} should declare exactly one slot`)
    assert.equal(slots[0].name, layer, `${name} slot should be on layer "${layer}"`)
    assert.ok((slots[0].slot?.description.length ?? 0) > 0, `${name} slot needs guidance text`)
  }
})

test('phase 12: container masters compose from their item-instance blueprints (edit-once hierarchy)', () => {
  const cases: Record<string, string> = {
    Accordion: 'AccordionItem',
    ListGroup: 'ListGroupItem',
    Nav: 'NavLink',
    Pills: 'NavLink',
    Pagination: 'PageItem',
    Dropdown: 'DropdownItem',
    Table: 'TableRow',
    Breadcrumb: 'BreadcrumbItem',
    Carousel: 'CarouselSlide',
  }
  for (const [master, item] of Object.entries(cases)) {
    const instances: Extract<KitNode, { type: 'instance' }>[] = []
    walk(blueprintVariant(spec(master), {}), (n) => {
      if (n.type === 'instance') instances.push(n)
    })
    assert.ok(instances.length >= 1, `${master} should compose from instances`)
    assert.ok(instances.some((i) => i.of === item), `${master} should reference ${item} instances`)
  }
  // Tabs pairs both item kinds.
  const tabsInstances: string[] = []
  walk(blueprintVariant(spec('Tabs'), {}), (n) => {
    if (n.type === 'instance') tabsInstances.push(n.of)
  })
  assert.ok(tabsInstances.includes('NavLink') && tabsInstances.includes('TabPane'))
})

test('non-container components declare no slots (fixed masters dropped INTO slots)', () => {
  for (const name of ['Button', 'Badge', 'Alert', 'Input', 'Spinner', 'Table', 'Figure', 'Pagination']) {
    const root = blueprintVariant(spec(name), {})
    let count = 0
    walk(root, (n) => {
      if (n.type === 'frame' && n.slot) count += 1
    })
    assert.equal(count, 0, `${name} should declare no slots`)
  }
})

test('Navbar/ButtonGroup slots prefer the Button component; open (not preferred-only)', () => {
  for (const name of ['Navbar', 'ButtonGroup']) {
    const root = blueprintVariant(spec(name), {})
    let slot: Extract<KitNode, { type: 'frame' }> | undefined
    walk(root, (n) => {
      if (n.type === 'frame' && n.slot && !slot) slot = n
    })
    assert.ok(slot?.slot?.preferredKinds?.includes('Button'), `${name} slot should prefer Button`)
    assert.equal(slot?.slot?.allowPreferredOnly, false, `${name} slot should stay open`)
  }
})

test('COVERAGE: every spec dispatches to a DEDICATED renderer (never the placeholder fallback)', () => {
  for (const s of BOOTSTRAP_SPECS) {
    const kind = specKind(s) ?? nameSlug(s.name)
    assert.ok(
      RENDERER_KINDS.includes(kind),
      `${s.name} → "${kind}" has no dedicated renderer — it would degrade to the labeled placeholder`
    )
  }
})
