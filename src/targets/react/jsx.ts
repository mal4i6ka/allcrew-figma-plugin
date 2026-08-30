/**
 * The IR tree as JSX.
 *
 * Three streams leave here, never mixed, because a developer has to be able to replace one
 * without touching the others:
 *
 *   PROPS   text bound to a component's TEXT property, and anything a variable drives. This is
 *           data — it comes from an API — and it arrives as a prop with a mock beside it.
 *   COPY    every other string. This is interface copy — it comes from a locale file — and it
 *           leaves as `t('key')` with the string collected for the translator.
 *   MARKUP  everything else.
 *
 * Conflating the first two is the thing that makes a generated screen useless: `mock.button_label`
 * is neither data nor copy, and the developer has to pull them apart by hand before they can wire
 * anything up.
 *
 * What cannot be translated is a comment AT THE LINE, naming the node — never a note in a report
 * somebody has to go and find. The failure this whole target exists to avoid is the one where
 * ninety per cent is right and the missing tenth is invisible.
 */

import type { IrNode } from '../django/ir.ts'
import { toClassName } from '../django/css-emitter.ts'

/**
 * What a prop IS, which is not the same question as what it is called.
 *
 * A component can hold a text layer named `subtitle` AND a boolean property named `Subtitle` that
 * hides it — one name, two meanings. The screen passed `subtitle={false}` to a component that had
 * declared `subtitle?: string`, and the export stopped compiling on a collision nobody designed.
 */
export type PropKind = 'text' | 'boolean' | 'variant'

export interface JsxContext {
  /**
   * True while emitting a component's own body.
   *
   * Inside a component every text is its interface, whether or not Figma calls it a TEXT
   * property: the five rows of a payment tile differ by nothing else, and a component that took
   * no text rendered five identical rows saying "Title". Outside a component a bare string is
   * copy, which is a different stream entirely.
   */
  insideComponent?: boolean
  /**
   * The node whose element carries the caller's `className` as well as its own.
   *
   * A component's root class holds what the component looks like; the class the screen passes
   * holds where it sits — its width in the row, its order in the stack. Dropping the second made
   * a component that typed perfectly and laid out wrongly.
   */
  rootId?: string
  /** The props of the component being emitted right now, by what each of them is. */
  own?: ReadonlyMap<string, PropKind>
  /**
   * Master node id → the component emitted from it.
   *
   * Two different masters can be called the same thing — this file holds two
   * `list-Item-InTheMiddle-Contents` — and keying components by name made the second overwrite the
   * first's file while instances of both rendered whichever survived. The rows of the payment tile
   * came out in the other one's font, at the other one's fixed width, wrapping a line early.
   */
  namesById?: ReadonlyMap<string, string>
  /**
   * Base class name → how many styled runs its text has, read off the stylesheet.
   *
   * Every font, size, weight and colour a text has lives in a `--segment-N` rule, and the markup
   * that did not wear that class rendered the whole screen in the browser's default 16px. The
   * stylesheet is emitted before the markup, so it can simply be asked.
   */
  segments?: ReadonlyMap<string, number>
  /** Interface copy, keyed by the key that replaces it: `{ 'pay.button': 'Оплатить' }`. */
  copy: Record<string, string>
  /** Props this subtree needs, with the value the mock should carry. */
  props: Map<string, string>
  /** Components this subtree instantiates, by the name they are imported under. */
  used: Set<string>
  /**
   * The nodes rendered as a component rather than as markup.
   *
   * Their element wears two classes — the component's own root and the one the caller passes —
   * and at equal specificity the later stylesheet wins, which is whichever CSS module the bundler
   * happened to put last. The master's own "fill my frame" then beat the caller's "hug", and the
   * balance line was laid on top of the label it sits beside.
   */
  instanceRoots: Set<string>
  /** What could not be translated, in the words the comment uses. */
  gaps: string[]
  /** True when the component has variant classes, so its root also carries the variant one. */
  hasVariants?: boolean
  /**
   * Which variants hold each layer, when they do not all hold all of them.
   *
   * A layer only some variants have is wrapped in a condition rather than drawn always or left
   * out: `Icon=Trailing` has an icon and `Icon=None` does not, and a button that always drew the
   * icon would be as wrong as one that never did.
   */
  membership?: ReadonlyMap<string, ReadonlySet<string>>
  /** Every variant key, so a layer that belongs to all of them needs no condition at all. */
  allVariants?: ReadonlySet<string>
  /**
   * What each component declares, by name.
   *
   * A call site fills a component's text props from the layer names of the instance IT holds, and
   * a library component takes its props from the variant IT was built from. Mostly the same
   * names; where they were not, the screen passed a prop that did not exist and the export stopped
   * compiling. Only what the component declares is passed.
   */
  declares?: ReadonlyMap<string, ReadonlyMap<string, PropKind>>
  /** Each vector's exported file, by node id — see `EmitReactOptions.assetsByNodeId`. */
  assets?: ReadonlyMap<string, { filename: string; svg: string }>
  /** A prefix for copy keys, so two screens do not collide on `title`. */
  scope: string
}

export function newContext(scope: string): JsxContext {
  return { copy: {}, props: new Map(), used: new Set(), instanceRoots: new Set(), gaps: [], scope }
}

const INDENT = '  '

/** A React component name from a Figma one: `Cards List Status` → `CardsListStatus`. */
export function componentName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]+/g, ' ').trim()
  const camel = cleaned
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
  // A component whose name began with a digit — `3-rd party` — would not be a valid identifier.
  return /^[A-Za-z]/.test(camel) ? camel : `C${camel}`
}

/** A prop name from a Figma property name: `Label text` → `labelText`. */
export function propName(name: string): string {
  const words = name.replace(/#.*$/, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ')
  const camel = words
    .map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join('')
  // Designers name a layer after what it says, and "373,00" is a perfectly good layer name and a
  // syntax error as a prop. A leading digit gets a word in front of it rather than being dropped:
  // `value37300` still says which layer it came from.
  if (camel === '') return 'value'
  return /^[A-Za-z_]/.test(camel) ? camel : `value${camel.charAt(0).toUpperCase()}${camel.slice(1)}`
}

/** A copy key from the text itself: short, stable, and readable in a locale file. */
function copyKey(scope: string, text: string, taken: Record<string, string>): string {
  const slug =
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'text'
  let key = `${scope}.${slug}`
  for (let n = 2; key in taken && taken[key] !== text; n++) key = `${scope}.${slug}_${n}`
  return key
}

/** Every text under an instance, by the layer that holds it — the overrides a screen is made of. */
function textsInside(node: IrNode): Array<[string, string]> {
  const found: Array<[string, string]> = []
  const walk = (one: IrNode) => {
    if (one.type === 'text') found.push([one.name, one.characters])
    // Not into a nested instance: its text is its own component's prop, filled in where that
    // component is rendered. Collecting it here offered the outer component a prop it never
    // declared — `AmountSection title="Списать с"`, where the title belongs to a List-Items-Title
    // one level down — and the export stopped compiling on it.
    if (one.type === 'instance-ref') return
    for (const child of (one as { children?: IrNode[] }).children ?? []) walk(child)
  }
  for (const child of (node as { children?: IrNode[] }).children ?? []) walk(child)
  // Two layers of the same name inside one instance would fight over the prop; the first wins and
  // the rest are the component's own business.
  const seen = new Set<string>()
  return found.filter(([layer]) => !seen.has(layer) && seen.add(layer))
}

export function emitJsx(node: IrNode, context: JsxContext, depth = 1): string {
  const drawn = emitElement(node, context, depth)
  const only = optionalIn(node, context)
  const shown = shownBy(node, context)
  if (!only && !shown) return drawn
  // The condition goes around the whole element, indented where the element was, so the markup
  // reads as the design does: this layer, when the variant has it.
  const pad = INDENT.repeat(depth)
  const tests = [
    only ? `HAS[${JSON.stringify(only)}]?.has(key)` : null,
    // `!== false` rather than the prop itself: a boolean the caller did not mention keeps the
    // default the component was drawn with, which is what Figma shows when nobody touches it.
    shown ? `${shown} !== false` : null,
  ].filter(Boolean)
  return `${pad}{${tests.join(' && ')} && (\n${drawn}\n${pad})}`
}

/**
 * The boolean prop that decides whether this layer is drawn at all.
 *
 * Figma binds a layer's `visible` to a BOOLEAN property, and the component that declared the
 * property and drew the layer regardless was the worst of both: the prop existed, the screen set
 * it, and nothing happened.
 */
function shownBy(node: IrNode, context: JsxContext): string | null {
  if (!context.insideComponent) return null
  const bound = node.componentPropertyReferences?.visible
  if (!bound) return null
  const prop = propName(bound)
  return context.own?.get(prop) === 'boolean' ? prop : null
}

/** A text prop's name, moved aside when a boolean or a variant already answers to it. */
export function textProp(prop: string, known: ReadonlyMap<string, PropKind> | undefined): string {
  const kind = known?.get(prop)
  return kind === 'boolean' || kind === 'variant' ? `${prop}Text` : prop
}

/** The layer's own membership name when it is not in every variant — otherwise nothing. */
function optionalIn(node: IrNode, context: JsxContext): string | null {
  const held = context.membership?.get(node.id)
  if (!held || !context.allVariants) return null
  return held.size === context.allVariants.size ? null : node.id
}

function emitElement(node: IrNode, context: JsxContext, depth: number): string {
  const pad = INDENT.repeat(depth)
  // `styles['n1-2']`, never `styles.n1-2`: a Figma id has a colon in it, `toClassName` turns that
  // into a hyphen, and a hyphen in a property access is a subtraction. Every line of the first
  // generated screen was a syntax error.
  const own = `styles[${JSON.stringify(toClassName(node.id))}]`
  const className =
    node.id === context.rootId
      ? `[${own}${context.hasVariants ? ', variant' : ''}, className].filter(Boolean).join(' ')`
      : own

  for (const warning of node.warnings ?? []) context.gaps.push(`${node.name}: ${warning}`)

  if (node.type === 'instance-ref' && node.restyled) {
    // Written out where it sits, because that is the only place its own font, size and colour
    // exist. The component it came from is named so a developer can decide whether the design
    // meant a new variant of it.
    const of =
      (node.componentId ? context.namesById?.get(node.componentId) : undefined) ??
      componentName(node.componentSetName || node.name)
    context.gaps.push(
      `${node.name}: restyled where it sits — written out as markup rather than rendered as <${of} />`
    )
  }

  if (node.type === 'text') {
    const bound = node.componentPropertyReferences?.characters ?? (context.insideComponent ? node.name : null)
    let body: string
    if (bound) {
      // Data: the component says this text is a property, so it is one here too.
      const prop = textProp(propName(bound), context.own)
      context.props.set(prop, JSON.stringify(node.characters))
      body = `{${prop}}`
    } else {
      const key = copyKey(context.scope, node.characters, context.copy)
      context.copy[key] = node.characters
      body = `{t('${key}')}`
    }
    const base = toClassName(node.id)
    const runs = context.segments?.get(base)
    if (runs !== undefined && runs > 1) {
      // One prop, one string, one style: the runs cannot survive being replaced by a value the
      // screen passes in. Which one was kept is worth saying at the line it happened.
      context.gaps.push(
        `${node.name}: ${runs} differently-styled runs in one text — all of it rendered in the first one's style`
      )
    }
    const typography = runs === undefined ? '' : ` + ' ' + styles[${JSON.stringify(`${base}--segment-0`)}]`
    const worn = typography === '' ? `{${className}}` : `{${className}${typography}}`
    return `${pad}<span className=${worn}>${body}</span>`
  }

  if (node.type === 'instance-ref' && !node.restyled) {
    // By what it IS an instance of, and only then by what it is called.
    const name =
      (node.componentId ? context.namesById?.get(node.componentId) : undefined) ??
      componentName(node.componentSetName || node.name)
    context.used.add(name)
    context.instanceRoots.add(node.id)
    const props: string[] = []
    // What this instance says, as against what its component says by default. The component's
    // body turns each of its texts into a prop; here is where each instance fills them in.
    const declared = context.declares?.get(name)
    for (const [layer, text] of textsInside(node)) {
      // The same rename the component made when the name was taken — asked of the same map, so
      // the two sides cannot drift apart.
      const prop = textProp(propName(layer), declared)
      if (declared && declared.get(prop) !== 'text') {
        // Dropped, and said so: a prop that quietly does not arrive is the screen rendering the
        // component's default text and nobody being told which line to look at.
        context.gaps.push(`${node.name}: ${name} takes no ${prop} text — "${text}" stayed in the component`)
        continue
      }
      props.push(`${prop}=${JSON.stringify(text)}`)
    }
    for (const [raw, value] of Object.entries(node.componentProperties ?? {})) {
      const prop = propName(raw)
      // The same gate as the texts: a component built from one variant has the axes THAT variant
      // has, and an instance carrying `Property 1` against a component that never declared it is
      // the export failing to compile over a name.
      const kind = declared?.get(prop)
      if (declared && value.type !== 'INSTANCE_SWAP') {
        // Not just "does it know the name" but "does it mean the same thing by it": a boolean sent
        // where a string was declared compiles no better than a name that was never declared.
        const wanted = value.type === 'BOOLEAN' ? 'boolean' : value.type === 'VARIANT' ? 'variant' : 'text'
        if (kind !== wanted) {
          context.gaps.push(
            `${node.name}: ${name} was set ${propName(raw)}=${String(value.value)} in Figma and declares ` +
              `${kind ? `a ${kind} of that name` : 'no such prop'} — the value was not passed`
          )
          continue
        }
      }
      if (value.type === 'BOOLEAN') props.push(value.value ? prop : `${prop}={false}`)
      else if (value.type === 'INSTANCE_SWAP') {
        // What was swapped in is a node, not a value: React takes children, and saying so beats
        // passing an id nobody downstream can resolve.
        context.gaps.push(`${node.name}: the ${raw} slot holds a swapped component — pass it as a child`)
      } else props.push(`${prop}="${String(value.value).replace(/"/g, '&quot;')}"`)
    }
    const attributes = props.length > 0 ? ` ${props.join(' ')}` : ''
    return `${pad}<${name} className={${className}}${attributes} />`
  }

  if (node.type === 'image') {
    const src = (node as { assetSrc?: string }).assetSrc
    if (!src) context.gaps.push(`${node.name}: an image with no exported file — export it and set the src`)
    return `${pad}<img className={${className}} src="${src ?? ''}" alt="" />`
  }

  if (node.type === 'vector') {
    // Small enough to inline is the icon in the markup; anything larger is a file beside it.
    const svg = (node as { inlineSvg?: string }).inlineSvg
    if (svg) return `${pad}<span className={${className}} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(svg)} }} />`
    const asset = context.assets?.get(node.id)
    if (asset) return `${pad}<img className={${className}} src="/assets/${asset.filename}" alt="" />`
    context.gaps.push(`${node.name}: a vector that would not export — draw it by hand`)
    return `${pad}<span className={${className}} />`
  }

  const children = (node as { children?: IrNode[] }).children ?? []
  const inner = children.map((child) => emitJsx(child, context, depth + 1)).join('\n')
  const tag = node.navigate ? 'a' : 'div'
  const href = node.navigate ? ` href={${JSON.stringify(`#${node.navigate.destinationId}`)}}` : ''
  if (node.navigate) {
    context.gaps.push(`${node.name}: goes to ${node.navigate.destinationId} — wire it to your router`)
  }
  if (children.length === 0) return `${pad}<${tag} className={${className}}${href} />`
  return `${pad}<${tag} className={${className}}${href}>\n${inner}\n${pad}</${tag}>`
}
