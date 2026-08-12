/**
 * REFORM phase 7 / B3 (docs/REFORM.md §4.3): Bootstrap component recognition. A Figma
 * component whose (set) name matches a Bootstrap pattern renders with NATIVE Bootstrap
 * markup — semantic tag, `btn`/`badge`/`card`/`alert` classes with the variant/size prop
 * threaded in as a Django template expression — while KEEPING its custom class: our CSS
 * still carries the exact Figma look on top of Bootstrap's base (loaded after
 * bootstrap.css), so recognition never risks 1:1 fidelity. Interactive behavior comes from
 * Bootstrap's data API (`data-bs-*`), not from generated JS.
 *
 * Matching is convention-based (docs/DESIGN-CONVENTIONS.md §6): the LAST `/`-segment of
 * the component-set name, case-insensitive; the variant prop may be named
 * variant/style/type/color/kind, the size prop `size`. An unrecognized component degrades
 * to the regular custom partial — recognition is an upgrade, never a requirement.
 */

import type { IrComponentDef } from '../ir.ts'

/** Prop names accepted as the Bootstrap variant (btn-primary, alert-danger, …). */
export const VARIANT_PROP_NAMES = ['variant', 'style', 'type', 'color', 'kind']
/** Prop names accepted as the Bootstrap size (btn-sm / btn-lg). */
export const SIZE_PROP_NAMES = ['size']

/** Component-set names (last `/`-segment, lowercased) the matcher recognizes. */
export const BOOTSTRAP_COMPONENT_NAMES = [
  'button', 'btn', 'badge', 'card', 'alert',
  // wave 2:
  'buttongroup', 'button-group', 'closebutton', 'close-button', 'spinner', 'placeholder',
  'toast', 'navbar', 'breadcrumb', 'nav', 'tabs', 'pills', 'listgroup', 'list-group',
  'pagination', 'progress', 'dropdown', 'accordion',
  // wave 3 — forms:
  'input', 'textfield', 'text-field', 'textarea', 'select', 'checkbox', 'radio', 'switch',
  'range', 'inputgroup', 'input-group',
  // patterns a real library names differently but Bootstrap builds from existing primitives:
  // a segmented control is a `.btn-group` of `.btn-check`s, an upload is a `type="file"` control.
  'segmented', 'segmentedcontrol', 'segmented-control',
  'upload', 'fileupload', 'file-upload', 'fileinput', 'file-input',
  // wave 3 — offcanvas panel (the overlay trigger is wired in interactions.ts):
  'offcanvas',
  // wave 3c — collapse family:
  'collapse',
  // wave 3f — tabs widget + carousel:
  'carousel',
  // phase 11 — content elements (generation-driven; exported as native table/figure markup):
  'table', 'figure',
  // phase 11 wider — floating-label form wrapper:
  'floatinglabels', 'floating-labels', 'floatinglabel', 'floating-label', 'form-floating',
  // phase 12 — item sub-components (masters compose from instances of these):
  'accordionitem', 'accordion-item', 'listgroupitem', 'list-group-item', 'navlink', 'nav-link',
  'pageitem', 'page-item', 'dropdownitem', 'dropdown-item', 'tablerow', 'table-row',
  'breadcrumbitem', 'breadcrumb-item', 'tabpane', 'tab-pane', 'carouselslide', 'carousel-slide',
] as const

/** REFORM wave 2: a named PART inside a recognized component — a layer called `Header`,
 * `Item`, `Menu`… (docs/DESIGN-CONVENTIONS.md §6.2, «Части») gets its own tag/classes at
 * ANY depth of the component subtree. Applies to container layers only: an INSTANCE part
 * renders its own partial (whose component may match on its own), text parts stay custom. */
export interface BootstrapPartSpec {
  tag?: string
  classes: string[]
  /** Extra attributes, already leading-spaced. */
  attributes?: string
  /** Void element (`<input>` / `<input type="range">`) — no children, no closing tag. */
  void?: boolean
}

/** REFORM wave 3c: intra-component collapse wiring — the emitter generates a unique id, tags
 * the `target` part with it + `targetClass`, and points the `toggle` part's `data-bs-target`
 * at it. `scope` (a part key) bounds the pairing per-instance (Accordion: one pair per `item`);
 * absent → one pair for the whole component (Collapse). Behavior via Bootstrap's data API — no
 * generated JS. */
export interface BootstrapCollapseSpec {
  toggle: string
  target: string
  targetClass: string
  scope?: string
  /** REFORM phase 12: when set, the collapse id is NOT a baked node id but this `{% include with %}`
   * PARAM (`id="{{ collapse_id }}"`, toggle → `data-bs-target="#{{ collapse_id }}"`). Lets N reused
   * item partials (AccordionItem instances) each get a unique id minted by the parent. */
  idParam?: string
  /** Param for the parent container id (`data-bs-parent="#{{ accordion_id }}"`, guarded by `{% if %}`). */
  parentParam?: string
  /** Class stamped on the toggle for the initial collapsed look (`collapsed`). */
  toggleCollapsedClass?: string
}

/** REFORM phase 12: a parent master (Accordion/Tabs) declares that its recognized-item INSTANCE
 * children each need parent-minted unique ids passed as `{% include with %}` params (the wiring
 * pre-passes can't reach across an instance-ref boundary, so the parent hands the id in). */
export interface BootstrapItemIdParams {
  /** The recognized kind of the item instances to pair (`accordion-item`). */
  childKind: string
  /** Param name for each item's own unique id (`collapse_id`). */
  idParam: string
  /** Param name for the shared parent id, also stamped on the parent root (`accordion_id`). */
  parentParam?: string
}

export interface BootstrapComponentMatch {
  /** Which Bootstrap component matched — 'button' | 'card' | 'dropdown' | … */
  kind: string
  tag: string
  /** Extra attributes, already leading-spaced (e.g. ` type="button"`). */
  attributes: string
  /** Class fragments appended AFTER the custom classes; may contain Django expressions. */
  classes: string[]
  /** Void element (e.g. a `Range` whose root IS the `<input type="range">`). */
  void?: boolean
  /** Named parts, keyed by the layer-name slug (`partForName`). */
  parts?: Record<string, BootstrapPartSpec>
  /** Collapse toggle→target wiring (Collapse, Accordion, responsive Navbar). */
  collapse?: BootstrapCollapseSpec
  /** Tabs wiring (REFORM wave 3f): order-pair the i-th `toggle` part (nav-link) with the i-th
   * `pane` part (tab-pane); first is active. */
  tabs?: { toggle: string; pane: string }
  /** Carousel wiring (REFORM wave 3f): root gets a unique id, first `slide` is active, `prev`/
   * `next` controls target the root. */
  carousel?: { slide: string; prev?: string; next?: string }
  /** REFORM phase 12: this parent composes from recognized-item INSTANCES that need parent-minted
   * unique collapse ids (Accordion ← AccordionItem). */
  itemInstanceIdParams?: BootstrapItemIdParams
  /** REFORM phase 12: this parent (Tabs) pairs i-th `toggle`-kind item instance with i-th `pane`-kind
   * item instance, minting a shared `pane_id` per pair (the instance counterpart of `tabs`). */
  tabItems?: { toggle: string; pane: string }
  /** Static markup appended inside the element before its closing tag — e.g. an Alert's
   * dismiss `btn-close` button. Not applied to void elements. */
  appendHtml?: string
}

function findProp(component: IrComponentDef, names: readonly string[]) {
  return component.properties.find(
    (prop) => prop.type === 'VARIANT' && names.includes(prop.name.trim().toLowerCase())
  )
}

/** `btn-{{ variant|default:'primary'|lower }}` — the include param stays dynamic, `|lower`
 * folds Figma's capitalized variant options ("Primary") onto Bootstrap's class slugs. */
function variantClassExpr(
  prefix: string,
  component: IrComponentDef,
  names: readonly string[],
  toVar: (name: string) => string
): string | null {
  const prop = findProp(component, names)
  if (!prop) return null
  const fallback = String(prop.defaultValue).toLowerCase()
  return `${prefix}-{{ ${toVar(prop.name)}|default:'${fallback}'|lower }}`
}

function normalizedName(componentName: string): string {
  const last = componentName.split('/').pop() ?? componentName
  return last.trim().toLowerCase()
}

/**
 * Matches a component (set) name + prop definitions against the Bootstrap starter set.
 * `toVar` is the emitter's prop-name→template-var mapping (passed in to avoid a
 * django ↔ frameworks import cycle). Returns null when nothing matches.
 */
export function matchBootstrapComponent(
  componentName: string,
  component: IrComponentDef,
  toVar: (name: string) => string
): BootstrapComponentMatch | null {
  const name = normalizedName(componentName)

  if (name === 'button' || name === 'btn') {
    const classes = ['btn']
    const variant = variantClassExpr('btn', component, VARIANT_PROP_NAMES, toVar)
    if (variant) classes.push(variant)
    const size = variantClassExpr('btn', component, SIZE_PROP_NAMES, toVar)
    if (size) classes.push(size) // btn-md is not a Bootstrap class — harmlessly inert for the default size
    return { kind: 'button', tag: 'button', attributes: ' type="button"', classes }
  }

  if (name === 'badge') {
    const classes = ['badge']
    const variant = variantClassExpr('text-bg', component, VARIANT_PROP_NAMES, toVar)
    if (variant) classes.push(variant)
    return { kind: 'badge', tag: 'span', attributes: '', classes }
  }

  if (name === 'card') {
    return {
      kind: 'card',
      tag: 'div',
      attributes: '',
      classes: ['card'],
      parts: {
        header: { classes: ['card-header'] },
        body: { classes: ['card-body'] },
        footer: { classes: ['card-footer'] },
        image: { classes: ['card-img-top'] },
      },
    }
  }

  if (name === 'alert') {
    const classes = ['alert']
    const variant = variantClassExpr('alert', component, VARIANT_PROP_NAMES, toVar)
    if (variant) classes.push(variant)
    // A `dismissible` BOOLEAN prop adds the close button + data-bs-dismiss (data API, no JS).
    const dismissible = component.properties.some(
      (prop) => prop.type === 'BOOLEAN' && prop.name.trim().toLowerCase() === 'dismissible'
    )
    if (dismissible) {
      classes.push('alert-dismissible')
      return {
        kind: 'alert',
        tag: 'div',
        attributes: ' role="alert"',
        classes,
        appendHtml: '<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>',
      }
    }
    return { kind: 'alert', tag: 'div', attributes: ' role="alert"', classes }
  }

  // ---- wave 2 -------------------------------------------------------------------------

  // A segmented control has no component of its own in Bootstrap — the framework builds it out of
  // a `.btn-group` of `.btn-check` radios, which is exactly what this container is. Recognizing the
  // name gets the right wrapper (and keyboard/ARIA grouping); the segments inside stay whatever
  // the design made them.
  if (name === 'buttongroup' || name === 'button-group' || name === 'segmented' || name === 'segmentedcontrol' || name === 'segmented-control') {
    const classes = ['btn-group']
    const size = variantClassExpr('btn-group', component, SIZE_PROP_NAMES, toVar)
    if (size) classes.push(size) // btn-group-md is inert for the default size, like btn-md
    return { kind: 'button-group', tag: 'div', attributes: ' role="group"', classes }
  }

  if (name === 'closebutton' || name === 'close-button') {
    return { kind: 'close-button', tag: 'button', attributes: ' type="button" aria-label="Close"', classes: ['btn-close'] }
  }

  if (name === 'spinner') {
    // `type = border | grow` picks the animation; the variant colors it via text-*.
    const typeProp = component.properties.find(
      (prop) => prop.type === 'VARIANT' && prop.name.trim().toLowerCase() === 'type'
    )
    const spinner = typeProp
      ? `spinner-{{ ${toVar(typeProp.name)}|default:'${String(typeProp.defaultValue).toLowerCase()}'|lower }}`
      : 'spinner-border'
    const classes = [spinner]
    const variant = variantClassExpr('text', component, ['variant', 'color', 'kind'], toVar)
    if (variant) classes.push(variant)
    return { kind: 'spinner', tag: 'div', attributes: ' role="status"', classes }
  }

  if (name === 'placeholder') {
    return { kind: 'placeholder', tag: 'span', attributes: '', classes: ['placeholder'] }
  }

  if (name === 'toast') {
    return {
      kind: 'toast',
      tag: 'div',
      attributes: ' role="alert" aria-live="assertive" aria-atomic="true"',
      classes: ['toast'],
      parts: {
        header: { classes: ['toast-header'] },
        body: { classes: ['toast-body'] },
      },
    }
  }

  if (name === 'navbar') {
    const classes = ['navbar']
    const expand = variantClassExpr('navbar-expand', component, ['expand'], toVar)
    classes.push(expand ?? 'navbar-expand-lg')
    return {
      kind: 'navbar',
      tag: 'nav',
      attributes: '',
      classes,
      // Responsive toggle: the Toggler shows/hides the Nav below the expand breakpoint. The
      // collapse class lands on the Nav list (functionally toggles; our CSS keeps the look).
      collapse: { toggle: 'toggler', target: 'nav', targetClass: 'collapse navbar-collapse' },
      parts: {
        brand: { classes: ['navbar-brand'] },
        toggler: { tag: 'button', classes: ['navbar-toggler'], attributes: ' type="button"' },
        nav: { tag: 'ul', classes: ['navbar-nav'] },
        item: { tag: 'li', classes: ['nav-item'] },
      },
    }
  }

  if (name === 'breadcrumb') {
    return {
      kind: 'breadcrumb',
      tag: 'ol',
      attributes: '',
      classes: ['breadcrumb'],
      parts: { item: { tag: 'li', classes: ['breadcrumb-item'] } },
    }
  }

  if (name === 'nav' || name === 'pills') {
    // The nav-STRIP only (a `<ul class="nav">`). The full tabbed widget (strip + panes) is `Tabs`.
    const classes = ['nav']
    const variant = variantClassExpr('nav', component, VARIANT_PROP_NAMES, toVar)
    classes.push(variant ?? (name === 'nav' ? 'nav-tabs' : 'nav-pills'))
    return {
      kind: 'nav',
      tag: 'ul',
      attributes: '',
      classes,
      parts: { item: { tag: 'li', classes: ['nav-item'] } },
    }
  }

  if (name === 'tabs') {
    // The full interactive widget: a nav strip (`Nav`/`Tab` parts) + panels (`Pane` parts).
    // Bootstrap allows `<nav class="nav">` with `.nav-link` children directly (no `<li>`), so a
    // `Tab` layer maps straight to the clickable nav-link. Wiring order-pairs tab↔pane (§B4).
    return {
      kind: 'tabs',
      tag: 'div',
      attributes: '',
      classes: [],
      tabs: { toggle: 'tab', pane: 'pane' },
      // phase 12: when composed of NavLink + TabPane INSTANCES, pair them by order and mint a
      // shared pane_id per pair (the inline `tabs` path above still handles non-instance tabs).
      tabItems: { toggle: 'navlink', pane: 'tab-pane' },
      parts: {
        nav: { tag: 'nav', classes: ['nav', 'nav-tabs'], attributes: ' role="tablist"' },
        tab: { tag: 'button', classes: ['nav-link'], attributes: ' type="button" role="tab"' },
        content: { classes: ['tab-content'] },
        pane: { classes: ['tab-pane'], attributes: ' role="tabpanel"' },
      },
    }
  }

  if (name === 'carousel') {
    return {
      kind: 'carousel',
      tag: 'div',
      attributes: ' data-bs-ride="carousel"',
      classes: ['carousel', 'slide'],
      carousel: { slide: 'slide', prev: 'prev', next: 'next' },
      parts: {
        inner: { classes: ['carousel-inner'] },
        slide: { classes: ['carousel-item'] },
        caption: { classes: ['carousel-caption'] },
        prev: { tag: 'button', classes: ['carousel-control-prev'], attributes: ' type="button" data-bs-slide="prev"' },
        next: { tag: 'button', classes: ['carousel-control-next'], attributes: ' type="button" data-bs-slide="next"' },
      },
    }
  }

  if (name === 'listgroup' || name === 'list-group') {
    return {
      kind: 'list-group',
      tag: 'ul',
      attributes: '',
      classes: ['list-group'],
      parts: { item: { tag: 'li', classes: ['list-group-item'] } },
    }
  }

  if (name === 'pagination') {
    const classes = ['pagination']
    const size = variantClassExpr('pagination', component, SIZE_PROP_NAMES, toVar)
    if (size) classes.push(size)
    return {
      kind: 'pagination',
      tag: 'ul',
      attributes: '',
      classes,
      parts: { item: { tag: 'li', classes: ['page-item'] } },
    }
  }

  if (name === 'progress') {
    return {
      kind: 'progress',
      tag: 'div',
      attributes: '',
      classes: ['progress'],
      parts: { bar: { classes: ['progress-bar'], attributes: ' role="progressbar"' } },
    }
  }

  if (name === 'dropdown') {
    return {
      kind: 'dropdown',
      tag: 'div',
      attributes: '',
      classes: ['dropdown'],
      parts: {
        // Bootstrap's data API drives the open/close — no generated JS, same as modals.
        toggle: {
          tag: 'button',
          classes: ['dropdown-toggle'],
          attributes: ' type="button" data-bs-toggle="dropdown" aria-expanded="false"',
        },
        menu: { tag: 'ul', classes: ['dropdown-menu'] },
        item: { tag: 'li', classes: ['dropdown-item'] },
      },
    }
  }

  if (name === 'accordion') {
    return {
      kind: 'accordion',
      tag: 'div',
      attributes: '',
      classes: ['accordion'],
      // Per-item collapse wiring: each Item's Header toggles its own Body (unique id per item).
      collapse: { toggle: 'header', target: 'body', targetClass: 'accordion-collapse collapse', scope: 'item' },
      // phase 12: when composed of AccordionItem INSTANCES, the parent mints a unique collapse_id
      // per item + a shared accordion_id (data-bs-parent) and passes them as include params.
      itemInstanceIdParams: { childKind: 'accordion-item', idParam: 'collapse_id', parentParam: 'accordion_id' },
      parts: {
        item: { classes: ['accordion-item'] },
        header: { classes: ['accordion-header'] },
        body: { classes: ['accordion-body'] },
      },
    }
  }

  if (name === 'collapse') {
    // No Bootstrap wrapper class of its own — just a Toggle that shows/hides Content.
    return {
      kind: 'collapse',
      tag: 'div',
      attributes: '',
      classes: [],
      collapse: { toggle: 'toggle', target: 'content', targetClass: 'collapse' },
      parts: {
        toggle: { tag: 'button', classes: [], attributes: ' type="button"' },
        content: { classes: [] },
      },
    }
  }

  // ---- wave 3: forms -------------------------------------------------------------------
  // Form fields group a Label + a control + optional Help text. The size/validity variants
  // live on the CONTROL (`form-control-sm`, `is-invalid`), not the wrapper — and since parts
  // are rebuilt on every match() call (which sees the props), the field part can carry those
  // component-derived dynamic classes even though part specs are otherwise static.

  if (
    name === 'input' || name === 'textfield' || name === 'text-field' || name === 'textarea' ||
    name === 'select' || name === 'upload' || name === 'fileupload' || name === 'file-upload' || name === 'fileinput' || name === 'file-input'
  ) {
    const isTextarea = name === 'textarea'
    const isSelect = name === 'select'
    // Bootstrap's file input IS `.form-control` with `type="file"` — no separate component, no JS.
    const isFile = name === 'upload' || name === 'fileupload' || name === 'file-upload' || name === 'fileinput' || name === 'file-input'
    const controlClass = isSelect ? 'form-select' : 'form-control'
    const sizeCls = variantClassExpr(controlClass, component, SIZE_PROP_NAMES, toVar)
    const stateCls = variantClassExpr('is', component, ['state', 'validity'], toVar) // is-valid / is-invalid
    const fieldClasses = [controlClass, ...(sizeCls ? [sizeCls] : []), ...(stateCls ? [stateCls] : [])]
    return {
      kind: 'form-field',
      tag: 'div',
      attributes: '',
      classes: [],
      parts: {
        label: { tag: 'label', classes: ['form-label'] },
        field: isTextarea
          ? { tag: 'textarea', classes: fieldClasses }
          : isSelect
            ? { tag: 'select', classes: fieldClasses }
            : { tag: 'input', classes: fieldClasses, attributes: isFile ? ' type="file"' : undefined, void: true },
        help: { classes: ['form-text'] },
      },
    }
  }

  if (name === 'floatinglabels' || name === 'floating-labels' || name === 'floatinglabel' || name === 'floating-label' || name === 'form-floating') {
    // `.form-floating` wraps a control + a label; the label floats up on focus/fill (pure CSS).
    // Bootstrap needs the control BEFORE the label in the DOM — the generator emits parts in that
    // order (`Field` then `Label`).
    return {
      kind: 'floating-label',
      tag: 'div',
      attributes: '',
      classes: ['form-floating'],
      parts: {
        field: { tag: 'input', classes: ['form-control'], void: true },
        label: { tag: 'label', classes: [] },
      },
    }
  }

  if (name === 'checkbox' || name === 'radio' || name === 'switch') {
    const inputType = name === 'radio' ? 'radio' : 'checkbox'
    const rootClasses = name === 'switch' ? ['form-check', 'form-switch'] : ['form-check']
    return {
      kind: 'form-check',
      tag: 'div',
      attributes: '',
      classes: rootClasses,
      parts: {
        field: { tag: 'input', classes: ['form-check-input'], attributes: ` type="${inputType}"`, void: true },
        label: { tag: 'label', classes: ['form-check-label'] },
      },
    }
  }

  if (name === 'range') {
    return { kind: 'range', tag: 'input', attributes: ' type="range"', classes: ['form-range'], void: true }
  }

  if (name === 'offcanvas') {
    // The panel itself. Its overlay trigger gets data-bs-toggle="offcanvas" in interactions.ts.
    const classes = ['offcanvas']
    const placement = variantClassExpr('offcanvas', component, ['placement'], toVar)
    classes.push(placement ?? 'offcanvas-start')
    return {
      kind: 'offcanvas',
      tag: 'div',
      attributes: ' tabindex="-1"',
      classes,
      parts: {
        header: { classes: ['offcanvas-header'] },
        body: { classes: ['offcanvas-body'] },
        title: { tag: 'h5', classes: ['offcanvas-title'] },
      },
    }
  }

  // ---- phase 11: content elements -----------------------------------------------------
  // Table/Figure are semantic content, not overlay behavior, so they generate + recognize
  // cleanly (unlike Modal/Tooltip/Popover, which stay prototype-built — DESIGN-CONVENTIONS §6.3).

  if (name === 'table') {
    // A `Row` layer → `<tr>`; cells named `Th`/`Td` get the semantic cell tag. Browsers wrap
    // bare rows in an implicit `<tbody>`, so a flat Table > Row > Th/Td tree stays valid.
    return {
      kind: 'table',
      tag: 'table',
      attributes: '',
      classes: ['table'],
      parts: {
        head: { tag: 'thead', classes: [] },
        body: { tag: 'tbody', classes: [] },
        row: { tag: 'tr', classes: [] },
        th: { tag: 'th', classes: [], attributes: ' scope="col"' },
        td: { tag: 'td', classes: [] },
        caption: { tag: 'caption', classes: [] },
      },
    }
  }

  if (name === 'figure') {
    return {
      kind: 'figure',
      tag: 'figure',
      attributes: '',
      classes: ['figure'],
      parts: {
        image: { tag: 'img', classes: ['figure-img', 'img-fluid', 'rounded'], void: true },
        caption: { tag: 'figcaption', classes: ['figure-caption'] },
      },
    }
  }

  if (name === 'inputgroup' || name === 'input-group') {
    const classes = ['input-group']
    const size = variantClassExpr('input-group', component, SIZE_PROP_NAMES, toVar)
    if (size) classes.push(size)
    return {
      kind: 'input-group',
      tag: 'div',
      attributes: '',
      classes,
      parts: {
        text: { tag: 'span', classes: ['input-group-text'] },
        field: { tag: 'input', classes: ['form-control'], void: true },
      },
    }
  }

  // ---- phase 12: item sub-components -----------------------------------------------------
  // A master (Accordion/ListGroup/Nav/Tabs/Pagination/Dropdown/Table/Breadcrumb/Carousel) composes
  // from INSTANCES of these. Parts and the collapse/tabs/carousel wiring pre-passes never cross an
  // instance-ref, so each item's OWN partial must carry its Bootstrap class + parts + (for wiring
  // items) param-driven ids that the parent mints per instance.

  if (name === 'accordionitem' || name === 'accordion-item') {
    return {
      kind: 'accordion-item',
      tag: 'div',
      attributes: '',
      classes: ['accordion-item'],
      // collapse id is an {% include with %} PARAM (not a baked node id), so N reused item partials
      // each get a unique id + a shared data-bs-parent from the parent Accordion.
      collapse: {
        toggle: 'button',
        target: 'collapse',
        targetClass: 'accordion-collapse collapse',
        idParam: 'collapse_id',
        parentParam: 'accordion_id',
        toggleCollapsedClass: 'collapsed',
      },
      parts: {
        header: { tag: 'h2', classes: ['accordion-header'] },
        button: { tag: 'button', classes: ['accordion-button'], attributes: ' type="button"' },
        collapse: { classes: [] }, // `.accordion-collapse collapse` arrive via targetClass wiring
        body: { classes: ['accordion-body'] },
      },
    }
  }

  if (name === 'listgroupitem' || name === 'list-group-item') {
    const classes = ['list-group-item']
    const color = variantClassExpr('list-group-item', component, ['color', 'variant', 'contextual'], toVar)
    if (color) classes.push(color)
    const action = variantClassExpr('list-group-item', component, ['itemtype', 'action'], toVar)
    if (action) classes.push(action)
    const stateProp = component.properties.find((p) => p.type === 'VARIANT' && p.name.trim().toLowerCase() === 'state')
    if (stateProp) classes.push(`{{ ${toVar(stateProp.name)}|default:'${String(stateProp.defaultValue).toLowerCase()}'|lower }}`)
    return { kind: 'list-group-item', tag: 'li', attributes: '', classes }
  }

  if (name === 'navlink' || name === 'nav-link') {
    // The nav-strip link; a `tab_id` include param (minted by a Tabs parent) switches it into tab
    // mode, else it stays a plain href link. active/disabled are bare tokens on .nav-link.
    const stateProp = component.properties.find(
      (p) => p.type === 'VARIANT' && ['state', 'variant'].includes(p.name.trim().toLowerCase())
    )
    const st = `${stateProp ? toVar(stateProp.name) : 'state'}|default:'${stateProp ? String(stateProp.defaultValue) : 'Default'}'`
    const stateClass = `{% if ${st} == 'Active' %}active{% elif ${st} == 'Disabled' %}disabled{% endif %}`
    const linkAttrs =
      `{% if tab_id %} id="{{ tab_id }}-tab" data-bs-toggle="tab" data-bs-target="#{{ tab_id }}"` +
      ` role="tab" aria-controls="{{ tab_id }}"` +
      ` aria-selected="{% if ${st} == 'Active' %}true{% else %}false{% endif %}"` +
      `{% else %} href="{{ href|default:'#' }}"` +
      `{% if ${st} == 'Active' %} aria-current="page"{% endif %}{% endif %}` +
      `{% if ${st} == 'Disabled' %} aria-disabled="true" tabindex="-1"{% endif %}`
    return {
      kind: 'navlink',
      tag: 'li',
      attributes: `{% if tab_id %} role="presentation"{% endif %}`,
      classes: ['nav-item'],
      parts: { link: { tag: 'a', classes: ['nav-link', stateClass], attributes: linkAttrs } },
    }
  }

  if (name === 'pageitem' || name === 'page-item') {
    const classes = ['page-item']
    const state = findProp(component, ['state', ...VARIANT_PROP_NAMES])
    if (state) classes.push(`{{ ${toVar(state.name)}|default:'${String(state.defaultValue).toLowerCase()}'|lower }}`)
    return {
      kind: 'page-item',
      tag: 'li',
      attributes: '',
      classes,
      parts: { link: { tag: 'a', classes: ['page-link'], attributes: ' href="#"' } },
    }
  }

  if (name === 'dropdownitem' || name === 'dropdown-item') {
    const variantProp = findProp(component, VARIANT_PROP_NAMES)
    const stateExpr = variantProp
      ? `{{ ${toVar(variantProp.name)}|default:'${String(variantProp.defaultValue).toLowerCase()}'|lower }}`
      : null
    return {
      kind: 'dropdown-item',
      tag: 'li',
      attributes: '',
      classes: [],
      parts: {
        link: { tag: 'a', classes: ['dropdown-item', ...(stateExpr ? [stateExpr] : [])], attributes: ' href="#"' },
        header: { tag: 'h6', classes: ['dropdown-header'] },
        divider: { tag: 'hr', classes: ['dropdown-divider'], void: true },
      },
    }
  }

  if (name === 'tablerow' || name === 'table-row') {
    // `Type=Head|Body` is STRUCTURAL (drives the cell tag via Th/Td parts + parent section), never a
    // table-* class. Optional contextual highlight → table-active / table-primary…
    const classes: string[] = []
    const contextual = variantClassExpr('table', component, ['state', 'color'], toVar)
    if (contextual) classes.push(contextual)
    return {
      kind: 'table-row',
      tag: 'tr',
      attributes: '',
      classes,
      parts: { th: { tag: 'th', classes: [], attributes: ' scope="col"' }, td: { tag: 'td', classes: [] } },
    }
  }

  if (name === 'breadcrumbitem' || name === 'breadcrumb-item') {
    const stateProp = component.properties.find(
      (p) => p.type === 'VARIANT' && ['state', 'variant', 'type'].includes(p.name.trim().toLowerCase())
    )
    const classes = ['breadcrumb-item']
    let attributes = ''
    if (stateProp) {
      const s = toVar(stateProp.name)
      classes.push(`{% if ${s}|lower == 'active' %}active{% endif %}`)
      attributes = `{% if ${s}|lower == 'active' %} aria-current="page"{% endif %}`
    }
    return { kind: 'breadcrumb-item', tag: 'li', attributes, classes }
  }

  if (name === 'tabpane' || name === 'tab-pane') {
    // `pane_id` is the parent-minted tab-id-param; `state=Active` (first pane) → `show active`.
    const showActive = `{% if state|default:'inactive'|lower == 'active' %}show active{% endif %}`
    return {
      kind: 'tab-pane',
      tag: 'div',
      attributes: ' role="tabpanel" id="{{ pane_id }}"',
      classes: ['tab-pane', 'fade', showActive],
    }
  }

  if (name === 'carouselslide' || name === 'carousel-slide') {
    const classes = ['carousel-item']
    const stateProp = findProp(component, ['state'])
    if (stateProp) {
      classes.push(`{% if ${toVar(stateProp.name)}|default:'${String(stateProp.defaultValue).toLowerCase()}'|lower == 'active' %}active{% endif %}`)
    }
    return {
      kind: 'carousel-slide',
      tag: 'div',
      attributes: '',
      classes,
      parts: { image: { tag: 'img', classes: ['d-block', 'w-100'], void: true }, caption: { classes: ['carousel-caption'] } },
    }
  }

  return null
}

/** A layer name's part key: the last `/`-segment, lowercased and slugged. `partForName` and the
 * collapse-wiring pre-pass both key parts by this, so they agree on what a layer "is". */
export function partKeyForName(nodeName: string): string {
  return normalizedName(nodeName).replace(/[^a-z0-9]+/g, '-')
}

/** Resolves the part spec for a layer inside a matched component: the layer name's part key
 * must equal a declared part key exactly. */
export function partForName(
  parts: Record<string, BootstrapPartSpec> | undefined,
  nodeName: string
): BootstrapPartSpec | null {
  if (!parts) return null
  return parts[partKeyForName(nodeName)] ?? null
}

/** True when the name LOOKS like a Bootstrap component the matcher knows. Used by the lint
 * rule to flag near-misses (right name, unrecognizable props). */
export function isBootstrapComponentName(componentName: string): boolean {
  return (BOOTSTRAP_COMPONENT_NAMES as readonly string[]).includes(normalizedName(componentName))
}

/** Whether this recognized name needs a variant prop for its Bootstrap classes to carry
 * meaning — only the role-colored components do (button/badge/alert); structural ones
 * (card, list-group, dropdown, …) work without one, and nav falls back to its set name. */
export function wantsVariantProp(componentName: string): boolean {
  const name = normalizedName(componentName)
  return name === 'button' || name === 'btn' || name === 'badge' || name === 'alert'
}

/**
 * Injects trigger attributes (`data-bs-toggle="modal" …`) into the FIRST element whose
 * class attribute carries `className`. The trigger markup is emitted by the html/partial
 * emitters, which know nothing about overlays — this post-pass bridges the two, same
 * technique as the utilities pass.
 */
export function injectTriggerAttributes(html: string, attributesByClass: ReadonlyMap<string, string>): string {
  let out = html
  for (const [className, attributes] of attributesByClass) {
    const pattern = new RegExp(`(<[a-zA-Z0-9-]+\\s[^>]*class="[^"]*\\b${className}\\b[^"]*")`)
    out = out.replace(pattern, `$1${attributes}`)
  }
  return out
}
