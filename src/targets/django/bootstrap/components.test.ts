import test from 'node:test'
import assert from 'node:assert/strict'
import {
  injectTriggerAttributes,
  isBootstrapComponentName,
  matchBootstrapComponent,
  partForName,
  wantsVariantProp,
} from './components.ts'
import { buildComponentRegistry, emitComponentPartial } from '../../django/component-emitter.ts'
import { emitInteractions } from '../../django/interactions.ts'
import { lintScope } from '../lint/index.ts'
import type { IrComponentDef, IrContainerNode, IrInstanceRefNode, IrOverlay } from '../../ir.ts'
import type { DjangoNodeSource } from '../../django/css-emitter.ts'

const toVar = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')

function buttonDef(): IrComponentDef {
  return {
    key: 'component-button',
    setName: 'Button',
    properties: [
      { name: 'variant', type: 'VARIANT', defaultValue: 'Primary', variantOptions: ['Primary', 'Secondary'] },
      { name: 'size', type: 'VARIANT', defaultValue: 'md', variantOptions: ['sm', 'md', 'lg'] },
    ],
  }
}

test('matchBootstrapComponent: Button set → native <button> with templated variant and size classes', () => {
  const match = matchBootstrapComponent('Button', buttonDef(), toVar)!
  assert.equal(match.tag, 'button')
  assert.equal(match.attributes, ' type="button"')
  assert.deepEqual(match.classes, [
    'btn',
    "btn-{{ variant|default:'primary'|lower }}",
    "btn-{{ size|default:'md'|lower }}",
  ])
})

test('matchBootstrapComponent: matching is case-insensitive on the LAST path segment; props by synonym', () => {
  const def: IrComponentDef = {
    key: 'k',
    properties: [{ name: 'Style', type: 'VARIANT', defaultValue: 'Danger', variantOptions: ['Danger'] }],
  }
  const alert = matchBootstrapComponent('UI/Alert', def, toVar)!
  assert.equal(alert.tag, 'div')
  assert.equal(alert.attributes, ' role="alert"')
  assert.deepEqual(alert.classes, ['alert', "alert-{{ style|default:'danger'|lower }}"])

  const badge = matchBootstrapComponent('BADGE', def, toVar)!
  assert.deepEqual(badge.classes, ['badge', "text-bg-{{ style|default:'danger'|lower }}"])

  const card = matchBootstrapComponent('Card', { key: 'k', properties: [] }, toVar)!
  assert.deepEqual(card.classes, ['card'])

  assert.equal(matchBootstrapComponent('Hero', def, toVar), null)
})

test('name helpers back the lint rule: cards need no variant prop, buttons do', () => {
  assert.equal(isBootstrapComponentName('UI/Button'), true)
  assert.equal(isBootstrapComponentName('Hero'), false)
  assert.equal(wantsVariantProp('Card'), false)
  assert.equal(wantsVariantProp('Button'), true)
})

test('injectTriggerAttributes hits only the FIRST element carrying the class', () => {
  const html = '<div class="wrap">\n  <button class="n1-2 btn">Open</button>\n  <span class="n1-2"></span>\n</div>'
  const out = injectTriggerAttributes(html, new Map([['n1-2', ' data-bs-toggle="modal" data-bs-target="#m1"']]))
  assert.match(out, /<button class="n1-2 btn" data-bs-toggle="modal" data-bs-target="#m1">/)
  assert.match(out, /<span class="n1-2"><\/span>/) // second occurrence untouched
})

// --- partial rendering at components fidelity -------------------------------------------

function makeBase() {
  return {
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'hug' as const }, height: { mode: 'hug' as const } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
  }
}

function buttonComponentNode(): IrContainerNode {
  return {
    ...makeBase(),
    id: '50:1',
    name: 'variant=Primary, size=md', // the variant node's own name — setName carries "Button"
    type: 'container',
    layout: { kind: 'absolute' },
    component: buttonDef(),
    children: [],
  }
}

test('emitComponentPartial at components fidelity renders native Bootstrap markup, keeping custom classes', () => {
  const component = buttonComponentNode()
  const registry = buildComponentRegistry([component])

  const bootstrap = emitComponentPartial(component, new Map(), registry, new Set(), new Map(), true)
  assert.match(bootstrap, /<button class="n50-1 n50-1--\{\{ variant\|default:'Primary' \}\} n50-1--\{\{ size\|default:'md' \}\} btn btn-\{\{ variant\|default:'primary'\|lower \}\} btn-\{\{ size\|default:'md'\|lower \}\}" type="button"><\/button>/)

  const plain = emitComponentPartial(component, new Map(), registry, new Set(), new Map(), false)
  assert.match(plain, /<div class="n50-1 /)
  assert.doesNotMatch(plain, /btn/)
})

// --- overlays become native Bootstrap modals ---------------------------------------------

function overlayNode(id: string, overlay: Partial<IrOverlay> = {}): IrContainerNode {
  return {
    ...makeBase(),
    id,
    name: `Node ${id}`,
    type: 'container',
    layout: { kind: 'absolute' },
    component: null,
    children: [],
    overlays: [
      {
        trigger: 'ON_CLICK',
        destinationId: 'overlay:1',
        relativePosition: null,
        positionType: 'CENTER',
        background: { type: 'NONE' },
        closeInteraction: 'CLOSE_ON_CLICK_OUTSIDE',
        ...overlay,
      },
    ],
  } as IrContainerNode
}

const scene = (): Map<string, DjangoNodeSource> =>
  new Map([
    ['trigger:1', { getCSSAsync: async () => ({}) }],
    ['overlay:1', { getCSSAsync: async () => ({}) }],
  ])

test('bootstrapModals: a click overlay becomes a native modal + data-API trigger, with NO generated JS', async () => {
  const result = await emitInteractions([overlayNode('trigger:1')], scene(), { bootstrapModals: true })

  const markup = result.overlayDialogs.get('trigger:1')![0]
  assert.match(markup, /class="modal fade"/)
  assert.match(markup, /modal-dialog/)
  assert.doesNotMatch(markup, /data-bs-backdrop/) // close-on-outside-click = Bootstrap default
  assert.equal(result.js, '')
  assert.match(result.triggerAttributes.get('ntrigger-1')!, /data-bs-toggle="modal" data-bs-target="#ntrigger-1--overlay-overlay-1"/)
})

test('bootstrapModals: no close-on-outside-click → data-bs-backdrop="static"', async () => {
  const result = await emitInteractions([overlayNode('trigger:1', { closeInteraction: 'NONE' })], scene(), {
    bootstrapModals: true,
  })
  assert.match(result.overlayDialogs.get('trigger:1')![0], /data-bs-backdrop="static"/)
})

test('bootstrapModals: non-click triggers keep the <dialog> + JS fallback (no data-API equivalent)', async () => {
  const result = await emitInteractions([overlayNode('trigger:1', { trigger: 'ON_HOVER' })], scene(), {
    bootstrapModals: true,
  })
  assert.match(result.overlayDialogs.get('trigger:1')![0], /<dialog/)
  assert.match(result.js, /showModal/)
  assert.equal(result.triggerAttributes.size, 0)
})

// --- lint: near-miss components ----------------------------------------------------------

function mockComponentSet(name: string, variantPropNames: string[]): unknown {
  return {
    id: 'set:1',
    name,
    type: 'COMPONENT_SET',
    parent: null,
    componentPropertyDefinitions: Object.fromEntries(
      variantPropNames.map((prop) => [`${prop}#1:0`, { type: 'VARIANT', defaultValue: 'a', variantOptions: ['a'] }])
    ),
  }
}

test('lint flags a Button set whose variant prop has an unrecognizable name', () => {
  const findings = lintScope([mockComponentSet('Button', ['appearance']) as never])
  const mismatch = findings.filter((finding) => finding.rule === 'bootstrap-component-mismatch')
  assert.equal(mismatch.length, 1)
  assert.match(mismatch[0].message, /variant/)
})

test('lint stays quiet for a recognizable Button set, a Card (no variant needed), and unrelated names', () => {
  const ok = lintScope([mockComponentSet('Button', ['variant']) as never])
  assert.equal(ok.filter((f) => f.rule === 'bootstrap-component-mismatch').length, 0)
  const card = lintScope([mockComponentSet('Card', []) as never])
  assert.equal(card.filter((f) => f.rule === 'bootstrap-component-mismatch').length, 0)
  const hero = lintScope([mockComponentSet('Hero', []) as never])
  assert.equal(hero.filter((f) => f.rule === 'bootstrap-component-mismatch').length, 0)
})

// --- wave 2: roots ------------------------------------------------------------------------

const bare = (name: string): IrComponentDef => ({ key: 'k', properties: [], setName: name })

test('wave 2 root matchers: structural components map without variant props', () => {
  assert.deepEqual(matchBootstrapComponent('ButtonGroup', bare('ButtonGroup'), toVar), {
    kind: 'button-group', tag: 'div', attributes: ' role="group"', classes: ['btn-group'],
  })
  const close = matchBootstrapComponent('CloseButton', bare('CloseButton'), toVar)!
  assert.equal(close.tag, 'button')
  assert.match(close.attributes, /aria-label="Close"/)
  assert.deepEqual(matchBootstrapComponent('Placeholder', bare('Placeholder'), toVar)!.classes, ['placeholder'])
  const toast = matchBootstrapComponent('Toast', bare('Toast'), toVar)!
  assert.match(toast.attributes, /aria-live="assertive"/)
  assert.deepEqual(Object.keys(toast.parts!), ['header', 'body'])
})

test('spinner: type prop picks the animation class, variant colors via text-*', () => {
  const def: IrComponentDef = {
    key: 'k',
    setName: 'Spinner',
    properties: [
      { name: 'type', type: 'VARIANT', defaultValue: 'grow', variantOptions: ['border', 'grow'] },
      { name: 'variant', type: 'VARIANT', defaultValue: 'Primary', variantOptions: ['Primary'] },
    ],
  }
  const match = matchBootstrapComponent('Spinner', def, toVar)!
  assert.deepEqual(match.classes, ["spinner-{{ type|default:'grow'|lower }}", "text-{{ variant|default:'primary'|lower }}"])
  assert.deepEqual(matchBootstrapComponent('Spinner', bare('Spinner'), toVar)!.classes, ['spinner-border'])
})

test('nav strip family: Nav → nav-tabs default, Pills → nav-pills, explicit variant wins', () => {
  // `Nav`/`Pills` are the nav STRIP only; the full tabbed widget is `Tabs` (wave 3f, below).
  assert.ok(matchBootstrapComponent('Nav', bare('Nav'), toVar)!.classes.includes('nav-tabs'))
  assert.ok(matchBootstrapComponent('Pills', bare('Pills'), toVar)!.classes.includes('nav-pills'))
  const def: IrComponentDef = {
    key: 'k',
    setName: 'Nav',
    properties: [{ name: 'variant', type: 'VARIANT', defaultValue: 'underline', variantOptions: ['underline'] }],
  }
  assert.ok(matchBootstrapComponent('Nav', def, toVar)!.classes.includes("nav-{{ variant|default:'underline'|lower }}"))
})

test('navbar: expand prop templated, lg default; semantic <nav>/<ol>/<ul> roots for the list-likes', () => {
  assert.ok(matchBootstrapComponent('Navbar', bare('Navbar'), toVar)!.classes.includes('navbar-expand-lg'))
  assert.equal(matchBootstrapComponent('Navbar', bare('Navbar'), toVar)!.tag, 'nav')
  assert.equal(matchBootstrapComponent('Breadcrumb', bare('Breadcrumb'), toVar)!.tag, 'ol')
  assert.equal(matchBootstrapComponent('ListGroup', bare('ListGroup'), toVar)!.tag, 'ul')
  assert.equal(matchBootstrapComponent('Pagination', bare('Pagination'), toVar)!.tag, 'ul')
})

test('dropdown: toggle part carries the data API — behavior without generated JS', () => {
  const dropdown = matchBootstrapComponent('Dropdown', bare('Dropdown'), toVar)!
  assert.match(dropdown.parts!.toggle.attributes!, /data-bs-toggle="dropdown"/)
  assert.equal(dropdown.parts!.menu.tag, 'ul')
})

test('partForName: last path segment, slugged, exact key', () => {
  const card = matchBootstrapComponent('Card', bare('Card'), toVar)!
  assert.deepEqual(partForName(card.parts, 'Header')!.classes, ['card-header'])
  assert.deepEqual(partForName(card.parts, 'UI/Body')!.classes, ['card-body'])
  assert.equal(partForName(card.parts, 'Title Text'), null) // no such part key
  assert.equal(partForName(undefined, 'Header'), null)
})

test('wave 2 lint scope: structural sets without variant props stay quiet', () => {
  assert.equal(wantsVariantProp('ListGroup'), false)
  assert.equal(wantsVariantProp('Dropdown'), false)
  assert.equal(wantsVariantProp('Badge'), true)
  const quiet = lintScope([mockComponentSet('ListGroup', []) as never])
  assert.equal(quiet.filter((f) => f.rule === 'bootstrap-component-mismatch').length, 0)
})

// --- wave 2: parts through the real partial emitter ---------------------------------------

function containerChild(id: string, name: string, children: IrContainerNode['children'] = []): IrContainerNode {
  return {
    ...makeBase(),
    id,
    name,
    type: 'container',
    component: null,
    layout: { kind: 'absolute' },
    children,
  } as IrContainerNode
}

test('emitComponentPartial renders named parts at any depth with their tag/classes/attributes', () => {
  const toggle = containerChild('60:2', 'Toggle')
  const item = containerChild('60:5', 'Item')
  const menu = containerChild('60:3', 'Menu', [item])
  const wrapper = containerChild('60:4', 'Content Wrapper', [menu])
  const dropdown: IrContainerNode = {
    ...makeBase(),
    id: '60:1',
    name: 'Dropdown',
    type: 'container',
    layout: { kind: 'absolute' },
    component: bare('Dropdown'),
    children: [toggle, wrapper],
  } as IrContainerNode
  const registry = buildComponentRegistry([dropdown])

  const html = emitComponentPartial(dropdown, new Map(), registry, new Set(), new Map(), true)

  assert.match(html, /<div class="n60-1 dropdown">/)
  assert.match(html, /<button class="n60-2 dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false"><\/button>/)
  assert.match(html, /<ul class="n60-3 dropdown-menu">/) // found through the unnamed wrapper
  assert.match(html, /<li class="n60-5 dropdown-item"><\/li>/)
  assert.match(html, /<div class="n60-4">/) // the wrapper itself is not a part

  const plain = emitComponentPartial(dropdown, new Map(), registry, new Set(), new Map(), false)
  assert.doesNotMatch(plain, /dropdown-toggle/) // parts only at components fidelity
})

// --- wave 3: forms -----------------------------------------------------------------------

test('form field: Input → wrapper div with label/field(input)/help parts; size on the CONTROL', () => {
  const def: IrComponentDef = {
    key: 'k',
    setName: 'Input',
    properties: [{ name: 'size', type: 'VARIANT', defaultValue: 'md', variantOptions: ['sm', 'md', 'lg'] }],
  }
  const match = matchBootstrapComponent('Input', def, toVar)!
  assert.equal(match.tag, 'div')
  assert.deepEqual(match.classes, []) // wrapper carries no Bootstrap class of its own
  assert.deepEqual(partForName(match.parts, 'Label')!.classes, ['form-label'])
  const field = partForName(match.parts, 'Field')!
  assert.equal(field.tag, 'input')
  assert.equal(field.void, true)
  assert.deepEqual(field.classes, ['form-control', "form-control-{{ size|default:'md'|lower }}"])
  assert.deepEqual(partForName(match.parts, 'Help')!.classes, ['form-text'])
})

test('form field: state prop threads is-valid/is-invalid onto the control', () => {
  const def: IrComponentDef = {
    key: 'k',
    setName: 'Input',
    properties: [{ name: 'state', type: 'VARIANT', defaultValue: 'invalid', variantOptions: ['valid', 'invalid'] }],
  }
  const field = partForName(matchBootstrapComponent('Input', def, toVar)!.parts, 'Field')!
  assert.deepEqual(field.classes, ['form-control', "is-{{ state|default:'invalid'|lower }}"])
})

test('form field: Textarea/Select swap the control tag (non-void), Select uses form-select', () => {
  const textarea = partForName(matchBootstrapComponent('Textarea', bare('Textarea'), toVar)!.parts, 'Field')!
  assert.equal(textarea.tag, 'textarea')
  assert.ok(!textarea.void)
  assert.deepEqual(textarea.classes, ['form-control'])
  const select = partForName(matchBootstrapComponent('Select', bare('Select'), toVar)!.parts, 'Field')!
  assert.equal(select.tag, 'select')
  assert.ok(!select.void)
  assert.deepEqual(select.classes, ['form-select'])
})

test('form check: Checkbox/Radio/Switch root form-check(+form-switch), field input type set', () => {
  const checkbox = matchBootstrapComponent('Checkbox', bare('Checkbox'), toVar)!
  assert.deepEqual(checkbox.classes, ['form-check'])
  const cbField = partForName(checkbox.parts, 'Field')!
  assert.match(cbField.attributes!, /type="checkbox"/)
  assert.equal(cbField.void, true)
  assert.deepEqual(partForName(checkbox.parts, 'Label')!.classes, ['form-check-label'])
  assert.match(partForName(matchBootstrapComponent('Radio', bare('Radio'), toVar)!.parts, 'Field')!.attributes!, /type="radio"/)
  assert.deepEqual(matchBootstrapComponent('Switch', bare('Switch'), toVar)!.classes, ['form-check', 'form-switch'])
})

test('Range root IS the void range input; InputGroup groups text + field, size on the group', () => {
  const range = matchBootstrapComponent('Range', bare('Range'), toVar)!
  assert.equal(range.tag, 'input')
  assert.equal(range.void, true)
  assert.match(range.attributes, /type="range"/)
  assert.deepEqual(range.classes, ['form-range'])

  const def: IrComponentDef = {
    key: 'k',
    setName: 'InputGroup',
    properties: [{ name: 'size', type: 'VARIANT', defaultValue: 'md', variantOptions: ['sm', 'md', 'lg'] }],
  }
  const group = matchBootstrapComponent('InputGroup', def, toVar)!
  assert.deepEqual(group.classes, ['input-group', "input-group-{{ size|default:'md'|lower }}"])
  assert.deepEqual(partForName(group.parts, 'Text')!.classes, ['input-group-text'])
  assert.equal(partForName(group.parts, 'Field')!.void, true)
})

test('forms are structural — the lint mismatch rule stays quiet for them', () => {
  for (const nm of ['Input', 'Textarea', 'Select', 'Checkbox', 'Range', 'InputGroup']) {
    assert.equal(wantsVariantProp(nm), false, `${nm} needs no variant prop`)
  }
  assert.equal(isBootstrapComponentName('Forms/Input'), true)
})

test('emitComponentPartial renders a void <input> field with no closing tag', () => {
  const label = containerChild('70:2', 'Label')
  const field = containerChild('70:3', 'Field')
  const input: IrContainerNode = {
    ...makeBase(),
    id: '70:1',
    name: 'Input',
    type: 'container',
    layout: { kind: 'absolute' },
    component: bare('Input'),
    children: [label, field],
  } as IrContainerNode
  const registry = buildComponentRegistry([input])

  const html = emitComponentPartial(input, new Map(), registry, new Set(), new Map(), true)
  assert.match(html, /<label class="n70-2 form-label"><\/label>/)
  assert.match(html, /<input class="n70-3 form-control">/)
  assert.doesNotMatch(html, /<\/input>/) // void: no closing tag
})

// --- wave 3: offcanvas -------------------------------------------------------------------

test('offcanvas root: .offcanvas + placement variant, Header/Body/Title parts', () => {
  const def: IrComponentDef = {
    key: 'k',
    setName: 'Offcanvas',
    properties: [{ name: 'placement', type: 'VARIANT', defaultValue: 'end', variantOptions: ['start', 'end', 'top', 'bottom'] }],
  }
  const match = matchBootstrapComponent('Offcanvas', def, toVar)!
  assert.equal(match.tag, 'div')
  assert.match(match.attributes, /tabindex="-1"/)
  assert.deepEqual(match.classes, ['offcanvas', "offcanvas-{{ placement|default:'end'|lower }}"])
  assert.deepEqual(partForName(match.parts, 'Header')!.classes, ['offcanvas-header'])
  assert.deepEqual(partForName(match.parts, 'Body')!.classes, ['offcanvas-body'])
  // No placement prop → offcanvas-start default.
  assert.deepEqual(matchBootstrapComponent('Offcanvas', bare('Offcanvas'), toVar)!.classes, ['offcanvas', 'offcanvas-start'])
})

function offcanvasPanel(id: string, placement?: string): IrContainerNode {
  return {
    ...makeBase(),
    id,
    name: 'Offcanvas',
    type: 'container',
    layout: { kind: 'absolute' },
    component: {
      key: 'k',
      setName: 'Offcanvas',
      properties: placement
        ? [{ name: 'placement', type: 'VARIANT', defaultValue: placement, variantOptions: ['start', 'end', 'top', 'bottom'] }]
        : [],
    },
    children: [],
  } as IrContainerNode
}

test('bootstrapModals: a click overlay whose destination is an Offcanvas → data-bs-toggle="offcanvas"', async () => {
  const trigger = overlayNode('trigger:1', { destinationId: 'oc:1' })
  const panel = offcanvasPanel('oc:1', 'end')
  const sceneNodes = new Map<string, DjangoNodeSource>([
    ['trigger:1', { getCSSAsync: async () => ({}) }],
    ['oc:1', { getCSSAsync: async () => ({}) }],
  ])

  const result = await emitInteractions([trigger, panel], sceneNodes, { bootstrapModals: true })

  const markup = result.overlayDialogs.get('trigger:1')![0]
  assert.match(markup, /class="offcanvas offcanvas-end"/)
  assert.doesNotMatch(markup, /class="modal/)
  assert.equal(result.js, '')
  assert.match(result.triggerAttributes.get('ntrigger-1')!, /data-bs-toggle="offcanvas" data-bs-target="#ntrigger-1--overlay-oc-1"/)
})

test('bootstrapModals: a click overlay to a non-offcanvas destination stays a modal', async () => {
  const trigger = overlayNode('trigger:1', { destinationId: 'plain:1' })
  const plain = containerChild('plain:1', 'Some Frame')
  const sceneNodes = new Map<string, DjangoNodeSource>([
    ['trigger:1', { getCSSAsync: async () => ({}) }],
    ['plain:1', { getCSSAsync: async () => ({}) }],
  ])
  const result = await emitInteractions([trigger, plain], sceneNodes, { bootstrapModals: true })
  assert.match(result.overlayDialogs.get('trigger:1')![0], /class="modal fade"/)
  assert.match(result.triggerAttributes.get('ntrigger-1')!, /data-bs-toggle="modal"/)
})

// --- wave 3c: collapse family (intra-component id-wiring) --------------------------------

test('collapse: Toggle gets data-bs-target at the Content, which gets a matching id + .collapse', () => {
  const toggle = containerChild('80:2', 'Toggle')
  const content = containerChild('80:3', 'Content')
  const collapse: IrContainerNode = {
    ...makeBase(),
    id: '80:1',
    name: 'Collapse',
    type: 'container',
    layout: { kind: 'absolute' },
    component: bare('Collapse'),
    children: [toggle, content],
  } as IrContainerNode
  const registry = buildComponentRegistry([collapse])

  const html = emitComponentPartial(collapse, new Map(), registry, new Set(), new Map(), true)
  assert.match(html, /<button class="n80-2" type="button" data-bs-toggle="collapse" data-bs-target="#n80-3-collapse" aria-expanded="false" aria-controls="n80-3-collapse">/)
  assert.match(html, /<div class="n80-3 collapse" id="n80-3-collapse">/)
})

test('accordion: each Item pairs its OWN Header→Body (unique id per item, no cross-wiring)', () => {
  const mkItem = (itemId: string, headerId: string, bodyId: string): IrContainerNode =>
    containerChild(itemId, 'Item', [containerChild(headerId, 'Header'), containerChild(bodyId, 'Body')])
  const accordion: IrContainerNode = {
    ...makeBase(),
    id: '81:1',
    name: 'Accordion',
    type: 'container',
    layout: { kind: 'absolute' },
    component: bare('Accordion'),
    children: [mkItem('81:2', '81:3', '81:4'), mkItem('81:5', '81:6', '81:7')],
  } as IrContainerNode
  const registry = buildComponentRegistry([accordion])

  const html = emitComponentPartial(accordion, new Map(), registry, new Set(), new Map(), true)
  // Item 1: header 81:3 → body 81:4
  assert.match(html, /class="n81-3 accordion-header" data-bs-toggle="collapse" data-bs-target="#n81-4-collapse"/)
  assert.match(html, /<div class="n81-4 accordion-body accordion-collapse collapse" id="n81-4-collapse">/)
  // Item 2: header 81:6 → body 81:7 (paired within its own item, not to item 1's body)
  assert.match(html, /class="n81-6 accordion-header" data-bs-toggle="collapse" data-bs-target="#n81-7-collapse"/)
  assert.match(html, /<div class="n81-7 accordion-body accordion-collapse collapse" id="n81-7-collapse">/)
  assert.doesNotMatch(html, /data-bs-target="#n81-4-collapse"[\s\S]*data-bs-target="#n81-4-collapse"/) // no duplicate target
})

test('collapse wiring is inert below components fidelity', () => {
  const collapse: IrContainerNode = {
    ...makeBase(),
    id: '82:1',
    name: 'Collapse',
    type: 'container',
    layout: { kind: 'absolute' },
    component: bare('Collapse'),
    children: [containerChild('82:2', 'Toggle'), containerChild('82:3', 'Content')],
  } as IrContainerNode
  const registry = buildComponentRegistry([collapse])
  const plain = emitComponentPartial(collapse, new Map(), registry, new Set(), new Map(), false)
  assert.doesNotMatch(plain, /data-bs-toggle="collapse"/)
})

// --- wave 3d: navbar toggler + alert dismissible ----------------------------------------

test('navbar toggler collapses the nav via the shared collapse mechanism', () => {
  const brand = containerChild('90:2', 'Brand')
  const toggler = containerChild('90:3', 'Toggler')
  const item = containerChild('90:5', 'Item')
  const nav = containerChild('90:4', 'Nav', [item])
  const navbar: IrContainerNode = {
    ...makeBase(),
    id: '90:1',
    name: 'Navbar',
    type: 'container',
    layout: { kind: 'absolute' },
    component: bare('Navbar'),
    children: [brand, toggler, nav],
  } as IrContainerNode
  const registry = buildComponentRegistry([navbar])

  const html = emitComponentPartial(navbar, new Map(), registry, new Set(), new Map(), true)
  assert.match(html, /<button class="n90-3 navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#n90-4-collapse"/)
  assert.match(html, /<ul class="n90-4 navbar-nav collapse navbar-collapse" id="n90-4-collapse">/)
  assert.match(html, /<li class="n90-5 nav-item">/) // parts still applied inside the collapsed nav
})

test('alert: a dismissible bool prop adds alert-dismissible + a data-bs-dismiss close button', () => {
  const def: IrComponentDef = {
    key: 'k',
    setName: 'Alert',
    properties: [
      { name: 'variant', type: 'VARIANT', defaultValue: 'Warning', variantOptions: ['Warning'] },
      { name: 'dismissible', type: 'BOOLEAN', defaultValue: true, variantOptions: null },
    ],
  }
  const match = matchBootstrapComponent('Alert', def, toVar)!
  assert.ok(match.classes.includes('alert-dismissible'))
  assert.match(match.appendHtml!, /class="btn-close" data-bs-dismiss="alert"/)

  const alert: IrContainerNode = {
    ...makeBase(), id: '91:1', name: 'Alert', type: 'container', layout: { kind: 'absolute' },
    component: def, children: [containerChild('91:2', 'Text')],
  } as IrContainerNode
  const html = emitComponentPartial(alert, new Map(), buildComponentRegistry([alert]), new Set(), new Map(), true)
  assert.match(html, /class="[^"]*alert-dismissible[^"]*" role="alert"/)
  assert.match(html, /<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"><\/button>/)
  // The close button sits INSIDE the alert, after its content.
  assert.ok(html.indexOf('n91-2') < html.indexOf('btn-close'))
})

test('alert without a dismissible prop stays plain (no close button)', () => {
  const plain = matchBootstrapComponent('Alert', bare('Alert'), toVar)!
  assert.ok(!plain.classes.includes('alert-dismissible'))
  assert.equal(plain.appendHtml, undefined)
})

// --- wave 3e: tooltip / popover (overlay destination + JS init) --------------------------

function textChild(id: string, characters: string): IrContainerNode {
  return { ...makeBase(), id, name: 'Text', type: 'text', characters } as unknown as IrContainerNode
}

function popupPanel(id: string, setName: string, text: string): IrContainerNode {
  return {
    ...makeBase(), id, name: setName, type: 'container', layout: { kind: 'absolute' },
    component: bare(setName), children: [textChild(`${id}-t`, text)],
  } as IrContainerNode
}

test('a hover overlay whose destination is a Tooltip → data-bs-toggle="tooltip" + title from text + init', async () => {
  const trigger = overlayNode('trigger:1', { trigger: 'ON_HOVER', destinationId: 'tip:1' })
  const tip = popupPanel('tip:1', 'Tooltip', 'Copy to clipboard')
  const sceneNodes = new Map<string, DjangoNodeSource>([
    ['trigger:1', { getCSSAsync: async () => ({}) }],
    ['tip:1', { getCSSAsync: async () => ({}) }],
  ])
  const result = await emitInteractions([trigger, tip], sceneNodes, { bootstrapModals: true })

  assert.match(result.triggerAttributes.get('ntrigger-1')!, /data-bs-toggle="tooltip" data-bs-title="Copy to clipboard"/)
  assert.match(result.js, /new bootstrap\.Tooltip\(el\)/)
  assert.equal(result.overlayDialogs.has('trigger:1'), false) // no <dialog> fallback
})

test('a Popover destination → data-bs-content + popover init; text is HTML-escaped', async () => {
  const trigger = overlayNode('trigger:1', { trigger: 'ON_HOVER', destinationId: 'pop:1' })
  const pop = popupPanel('pop:1', 'Popover', 'Tom & Jerry <3')
  const sceneNodes = new Map<string, DjangoNodeSource>([
    ['trigger:1', { getCSSAsync: async () => ({}) }],
    ['pop:1', { getCSSAsync: async () => ({}) }],
  ])
  const result = await emitInteractions([trigger, pop], sceneNodes, { bootstrapModals: true })

  assert.match(result.triggerAttributes.get('ntrigger-1')!, /data-bs-toggle="popover" data-bs-content="Tom &amp; Jerry &lt;3"/)
  assert.match(result.js, /new bootstrap\.Popover\(el\)/)
})

// --- wave 3f: tabs widget + carousel ----------------------------------------------------

test('tabs widget: order-pairs each Tab (nav-link) with its Pane; first is active', () => {
  const tab1 = containerChild('a0:2', 'Tab')
  const tab2 = containerChild('a0:3', 'Tab')
  const nav = containerChild('a0:4', 'Nav', [tab1, tab2])
  const pane1 = containerChild('a0:5', 'Pane')
  const pane2 = containerChild('a0:6', 'Pane')
  const content = containerChild('a0:7', 'Content', [pane1, pane2])
  const tabs: IrContainerNode = {
    ...makeBase(), id: 'a0:1', name: 'Tabs', type: 'container', layout: { kind: 'absolute' },
    component: bare('Tabs'), children: [nav, content],
  } as IrContainerNode
  const html = emitComponentPartial(tabs, new Map(), buildComponentRegistry([tabs]), new Set(), new Map(), true)

  // Tab 1 ↔ Pane 1 (active), Tab 2 ↔ Pane 2.
  assert.match(html, /<button class="na0-2 nav-link active" type="button" role="tab" data-bs-toggle="tab" data-bs-target="#na0-5-pane" aria-controls="na0-5-pane" aria-selected="true">/)
  assert.match(html, /<button class="na0-3 nav-link" type="button" role="tab" data-bs-toggle="tab" data-bs-target="#na0-6-pane" aria-controls="na0-6-pane" aria-selected="false">/)
  assert.match(html, /<div class="na0-5 tab-pane show active" role="tabpanel" id="na0-5-pane">/)
  assert.match(html, /<div class="na0-6 tab-pane" role="tabpanel" id="na0-6-pane">/)
})

test('carousel: root gets an id, first Slide is active, prev/next controls target the root', () => {
  const slide1 = containerChild('b0:3', 'Slide')
  const slide2 = containerChild('b0:4', 'Slide')
  const inner = containerChild('b0:2', 'Inner', [slide1, slide2])
  const prev = containerChild('b0:5', 'Prev')
  const next = containerChild('b0:6', 'Next')
  const carousel: IrContainerNode = {
    ...makeBase(), id: 'b0:1', name: 'Carousel', type: 'container', layout: { kind: 'absolute' },
    component: bare('Carousel'), children: [inner, prev, next],
  } as IrContainerNode
  const html = emitComponentPartial(carousel, new Map(), buildComponentRegistry([carousel]), new Set(), new Map(), true)

  assert.match(html, /<div class="nb0-1 carousel slide" data-bs-ride="carousel" id="nb0-1-carousel">/)
  assert.match(html, /<div class="nb0-3 carousel-item active">/)
  assert.match(html, /<div class="nb0-4 carousel-item">/) // second slide not active
  assert.match(html, /<button class="nb0-5 carousel-control-prev" type="button" data-bs-slide="prev" data-bs-target="#nb0-1-carousel">/)
  assert.match(html, /<button class="nb0-6 carousel-control-next" type="button" data-bs-slide="next" data-bs-target="#nb0-1-carousel">/)
})

test('tabs/carousel are structural — lint stays quiet, recognized by name', () => {
  assert.equal(wantsVariantProp('Tabs'), false)
  assert.equal(wantsVariantProp('Carousel'), false)
  assert.equal(isBootstrapComponentName('Carousel'), true)
})

// ---- phase 11: content elements (Table / Figure) --------------------------------------

test('phase 11: Table maps to <table class="table"> with tr/th/td/caption parts', () => {
  const table = matchBootstrapComponent('Content/Table', bare('Content/Table'), toVar)!
  assert.equal(table.kind, 'table')
  assert.equal(table.tag, 'table')
  assert.deepEqual(table.classes, ['table'])
  assert.equal(table.parts?.row.tag, 'tr')
  assert.equal(table.parts?.th.tag, 'th')
  assert.equal(table.parts?.th.attributes, ' scope="col"')
  assert.equal(table.parts?.td.tag, 'td')
  assert.equal(table.parts?.caption.tag, 'caption')
  assert.equal(isBootstrapComponentName('Table'), true)
})

test('phase 11: Figure maps to <figure class="figure"> with a void figure-img and figcaption', () => {
  const figure = matchBootstrapComponent('Figure', bare('Figure'), toVar)!
  assert.equal(figure.kind, 'figure')
  assert.equal(figure.tag, 'figure')
  assert.equal(figure.parts?.image.void, true)
  assert.ok(figure.parts?.image.classes.includes('figure-img'))
  assert.ok(figure.parts?.image.classes.includes('img-fluid'))
  assert.equal(figure.parts?.caption.tag, 'figcaption')
})

// ---- phase 12: item sub-components + master composition from instances -----------------

function itemMain(id: string, setName: string, key: string, props: IrComponentDef['properties'] = [], children: IrContainerNode['children'] = []): IrContainerNode {
  return {
    ...makeBase(), id, name: setName, type: 'container', layout: { kind: 'absolute' },
    component: { key, properties: props, setName }, children,
  } as IrContainerNode
}
function instanceRef(id: string, main: IrContainerNode): IrInstanceRefNode {
  return {
    ...makeBase(), id, name: 'instance', type: 'instance-ref', layout: { kind: 'absolute' },
    componentId: main.id, componentKey: main.component!.key, componentProperties: {}, children: [],
  } as unknown as IrInstanceRefNode
}

test('phase 12: AccordionItem partial carries .accordion-item + collapse wiring via {{ collapse_id }} param', () => {
  const item = itemMain('ai:root', 'AccordionItem', 'aikey', [], [
    containerChild('ai:hdr', 'Header', [containerChild('ai:btn', 'Button')]),
    containerChild('ai:col', 'Collapse', [containerChild('ai:body', 'Body')]),
  ])
  const html = emitComponentPartial(item, new Map(), buildComponentRegistry([item]), new Set(), new Map(), true)
  assert.match(html, /<div class="[^"]*accordion-item/)
  assert.match(html, /<h2 class="[^"]*accordion-header">/)
  assert.match(html, /<button class="[^"]*accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#\{\{ collapse_id \}\}"/)
  assert.match(html, /id="\{\{ collapse_id \}\}"/)
  assert.match(html, /\{% if accordion_id %\} data-bs-parent="#\{\{ accordion_id \}\}"\{% endif %\}/)
  assert.match(html, /<div class="[^"]*accordion-body">/)
  // No baked node-id collapse id — the id must be the param so reused instances stay unique.
  assert.doesNotMatch(html, /id="n[^"]*-collapse"/)
})

test('phase 12: an Accordion of AccordionItem INSTANCES mints unique collapse_id + shared accordion_id', () => {
  const itemMainNode = itemMain('ai:main', 'AccordionItem', 'aikey', [], [
    containerChild('ai:h', 'Header', [containerChild('ai:b', 'Button')]),
    containerChild('ai:c', 'Collapse', [containerChild('ai:bd', 'Body')]),
  ])
  const accordion: IrContainerNode = {
    ...makeBase(), id: 'acc:1', name: 'Accordion', type: 'container', layout: { kind: 'absolute' },
    component: { key: 'acckey', properties: [], setName: 'Accordion' },
    children: [instanceRef('inst:1', itemMainNode), instanceRef('inst:2', itemMainNode)],
  } as IrContainerNode
  const registry = buildComponentRegistry([itemMainNode, accordion])
  const html = emitComponentPartial(accordion, new Map(), registry, new Set(), new Map(), true)
  assert.match(html, /<div class="[^"]*accordion" id="[^"]*-accordion">/) // root stamped with parent id
  assert.match(html, /collapse_id="ninst-1-collapse"/)
  assert.match(html, /collapse_id="ninst-2-collapse"/) // distinct per instance
  assert.match(html, /accordion_id="nacc-1-accordion"/) // shared parent id (both includes)
  assert.equal((html.match(/accordion_id="nacc-1-accordion"/g) || []).length, 2)
})

test('phase 12: ListGroupItem → li.list-group-item, no id (safe to reuse across rows)', () => {
  const item = itemMain('lgi:1', 'ListGroupItem', 'lgikey', [
    { name: 'State', type: 'VARIANT', defaultValue: 'Active', variantOptions: ['Default', 'Active', 'Disabled'] },
  ], [containerChild('lgi:c', 'Content', [textChild('lgi:t', 'An item')])])
  const html = emitComponentPartial(item, new Map(), buildComponentRegistry([item]), new Set(), new Map(), true)
  assert.match(html, /<li class="[^"]*list-group-item/)
  assert.doesNotMatch(html, /\sid=/)
})

test('phase 12: NavLink is param-driven — tab attrs gated on {% if tab_id %}, else a plain href link', () => {
  const nl = matchBootstrapComponent('NavLink', bare('NavLink'), toVar)!
  assert.equal(nl.kind, 'navlink')
  assert.equal(nl.tag, 'li')
  assert.deepEqual(nl.classes, ['nav-item'])
  const link = nl.parts!.link
  assert.equal(link.tag, 'a')
  assert.ok(link.classes.includes('nav-link'))
  assert.match(link.attributes!, /\{% if tab_id %\} id="\{\{ tab_id \}\}-tab" data-bs-toggle="tab" data-bs-target="#\{\{ tab_id \}\}"/)
  assert.match(link.attributes!, /\{% else %\} href="\{\{ href\|default:'#' \}\}"/)
})

test('phase 12: Tabs of NavLink + TabPane INSTANCES pair by order with a shared pane_id', () => {
  const navMain = itemMain('nl:main', 'NavLink', 'nlkey')
  const paneMain = itemMain('tp:main', 'TabPane', 'tpkey')
  const nav = containerChild('tabs:nav', 'Nav', [instanceRef('nl:1', navMain), instanceRef('nl:2', navMain)])
  const content = containerChild('tabs:content', 'Content', [instanceRef('tp:1', paneMain), instanceRef('tp:2', paneMain)])
  const tabs: IrContainerNode = {
    ...makeBase(), id: 'tabs:1', name: 'Tabs', type: 'container', layout: { kind: 'absolute' },
    component: { key: 'tabskey', properties: [], setName: 'Tabs' }, children: [nav, content],
  } as IrContainerNode
  const registry = buildComponentRegistry([navMain, paneMain, tabs])
  const html = emitComponentPartial(tabs, new Map(), registry, new Set(), new Map(), true)
  assert.match(html, /tab_id="ntp-1-pane"/) // NavLink[0] targets pane[0]
  assert.match(html, /pane_id="ntp-1-pane"/) // TabPane[0] carries the same id
  assert.match(html, /tab_id="ntp-2-pane"/)
  assert.match(html, /pane_id="ntp-2-pane"/)
})

test('phase 12: content items recognize with native classes (Page/Dropdown/Table/Breadcrumb/Carousel/TabPane)', () => {
  assert.deepEqual(matchBootstrapComponent('PageItem', bare('PageItem'), toVar)!.classes.slice(0, 1), ['page-item'])
  assert.equal(matchBootstrapComponent('PageItem', bare('PageItem'), toVar)!.parts!.link.classes[0], 'page-link')
  const dd = matchBootstrapComponent('DropdownItem', bare('DropdownItem'), toVar)!
  assert.equal(dd.parts!.link.classes[0], 'dropdown-item')
  assert.equal(dd.parts!.divider.tag, 'hr')
  const tr = matchBootstrapComponent('TableRow', bare('TableRow'), toVar)!
  assert.equal(tr.tag, 'tr')
  assert.equal(tr.parts!.th.attributes, ' scope="col"')
  assert.deepEqual(matchBootstrapComponent('BreadcrumbItem', bare('BreadcrumbItem'), toVar)!.classes.slice(0, 1), ['breadcrumb-item'])
  const slide = matchBootstrapComponent('CarouselSlide', bare('CarouselSlide'), toVar)!
  assert.equal(slide.classes[0], 'carousel-item')
  assert.equal(slide.parts!.image.void, true)
  const pane = matchBootstrapComponent('TabPane', bare('TabPane'), toVar)!
  assert.ok(pane.classes.includes('tab-pane'))
  assert.match(pane.attributes, /id="\{\{ pane_id \}\}"/)
})

test('phase 11: FloatingLabels maps to .form-floating with a void field + label (field-before-label)', () => {
  const fl = matchBootstrapComponent('FloatingLabels', bare('FloatingLabels'), toVar)!
  assert.equal(fl.kind, 'floating-label')
  assert.deepEqual(fl.classes, ['form-floating'])
  assert.equal(fl.parts?.field.tag, 'input')
  assert.equal(fl.parts?.field.void, true)
  assert.equal(fl.parts?.label.tag, 'label')
  assert.equal(isBootstrapComponentName('form-floating'), true)
})

test('phase 11: a Table IR renders native rows/cells through the generic emitter', () => {
  const th = containerChild('t:2', 'Th', [textChild('t:3', '#')])
  const head = containerChild('t:1', 'Row', [th])
  const td = containerChild('t:5', 'Td', [textChild('t:6', 'Mark')])
  const body = containerChild('t:4', 'Row', [td])
  const table: IrContainerNode = {
    ...makeBase(), id: 't:0', name: 'Table', type: 'container', layout: { kind: 'absolute' },
    component: bare('Table'), children: [head, body],
  } as IrContainerNode
  const html = emitComponentPartial(table, new Map(), buildComponentRegistry([table]), new Set(), new Map(), true)
  assert.match(html, /<table class="[^"]*table">/)
  assert.match(html, /<tr class="[^"]*">/)
  assert.match(html, /<th class="[^"]*" scope="col">/)
  assert.match(html, /<td class="[^"]*">/)
})

/* ---- patterns a real corporate library ships that Bootstrap composes from primitives ---- */

test('Segmented renders as the btn-group Bootstrap builds segmented controls from', () => {
  const match = matchBootstrapComponent('Controls/Segmented', { key: 'k', properties: [] }, (n) => n)
  assert.equal(match?.kind, 'button-group')
  assert.deepEqual(match?.classes, ['btn-group'])
  assert.equal(match?.attributes, ' role="group"')
})

test('Upload renders as a form-control file input', () => {
  const match = matchBootstrapComponent('Forms/Upload', { key: 'k', properties: [] }, (n) => n)
  assert.equal(match?.kind, 'form-field')
  assert.equal(match?.parts?.field.tag, 'input')
  assert.equal(match?.parts?.field.attributes, ' type="file"')
  assert.deepEqual(match?.parts?.field.classes, ['form-control'])
})

test('patterns with no Bootstrap counterpart stay custom partials', () => {
  // Stepper / Timeline / Rates / OTP have no Bootstrap component — inventing markup for them
  // would be worse than the honest fallback.
  for (const name of ['Stepper', 'Timeline', 'Rates', 'OTP codes']) {
    assert.equal(matchBootstrapComponent(name, { key: 'k', properties: [] }, (n) => n), null, name)
  }
})
