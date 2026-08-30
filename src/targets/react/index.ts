/**
 * A screen as a React repository, not as a picture of one.
 *
 * The deliverable this target exists for: a developer opens what comes out, runs it, sees the
 * screen, replaces the mock with a real call and ships. That means the output is not one file of
 * markup — it is a component per Figma component, a screen that uses them, tokens as CSS
 * variables, a mock beside the data and the copy in a locale, each replaceable on its own.
 *
 * Components come from the instances on the screen, one file per component SET: the variants a
 * screen actually uses become the union type of its props, so `<Button type="primary" size="L">`
 * type-checks against exactly what the design system has. The first instance of a component
 * supplies its markup; a variant whose markup genuinely differs is named as a gap rather than
 * silently taking the first one's shape.
 *
 * Everything the emitter cannot translate leaves a comment at the line it happened on, naming the
 * Figma node. A report in the root would be a report nobody opens.
 */

import type { IrNode } from '../django/ir.ts'
import { emitCss, toClassName } from '../django/css-emitter.ts'
import type { DjangoNodeSource } from '../django/css-emitter.ts'
import { componentName, emitJsx, newContext, propName, type JsxContext, type PropKind } from './jsx.ts'

/** A Figma property type in the words the props are typed by. */
const kindOfProp = (type: string | undefined): PropKind =>
  type === 'BOOLEAN' ? 'boolean' : type === 'VARIANT' ? 'variant' : 'text'
import { alignVariants, axesOf, orderRules, pairOrExplain, scopeVariantCss, variantClass, variantKey, variantKeyFromName } from './variants.ts'
import { emitInteractions } from '../django/interactions.ts'
import { emitNodeAnimationCss } from '../django/motion/css-emitter.ts'
import type { MotionSnapshot } from '../django/motion/types.ts'
import { toClassName as className } from '../django/css-emitter.ts'

export interface ReactOutput {
  /** path → contents, ready to be written into a repository. */
  files: Record<string, string>
  /** Master node id (a set and each of its variants) → the component emitted from it. */
  names: Map<string, string>
  /** What could not be translated, gathered for the reply — the same lines are also in the code. */
  gaps: string[]
  /**
   * The props each emitted component declares.
   *
   * A screen fills a component's text props from the layer names of the instance IT holds; a
   * library component takes its props from the layers of the variant IT was built from. Mostly
   * the same names, and where they were not, the screen passed a prop the component had never
   * heard of and the whole thing stopped compiling. Passing the declarations along is how the two
   * halves agree.
   */
  props: Map<string, ReadonlyMap<string, PropKind>>
}

export interface EmitReactOptions {
  /** What the screen component is called. Defaults to the root node's name. */
  name?: string
  /**
   * Each node's timeline, by node id.
   *
   * Read by the caller rather than here: `sceneNodesById` carries what the CSS emitter needs —
   * a `getCSSAsync` and little else — and asking it for `manualKeyframeTracks` returned nothing
   * at all, silently, for every animated node on the screen.
   */
  motionByNodeId?: ReadonlyMap<string, MotionSnapshot>
  /**
   * Each vector's exported SVG, by node id.
   *
   * Exported by the caller for the same reason the timelines are: it needs the live node, and a
   * target that reached for one would be a target that only runs inside the plugin.
   */
  assetsByNodeId?: ReadonlyMap<string, { filename: string; svg: string }>
  /**
   * Components another export already emitted, by name.
   *
   * A screen holds one instance of a Button and could build a Button out of it — one variant, no
   * states, the right shape and a quarter of the truth. When the real one is there, the screen
   * imports it and builds nothing.
   */
  fromLibrary?: ReadonlySet<string>
  /** What those library components declare, so a screen never passes one a prop it has not got. */
  libraryProps?: ReadonlyMap<string, ReadonlyMap<string, PropKind>>
  /**
   * The file's variables as a stylesheet.
   *
   * Every colour in the emitted CSS is `var(--token, literal)`, and without the table the literal
   * is all there is — the checkbox came out a black square because the fallback said `#101010`
   * where the design system says `--content-inverse: #ffffff`.
   */
  tokensCss?: string
  /** What earlier runs already emitted, by master id — so an instance finds its own component. */
  componentNamesById?: ReadonlyMap<string, string>
}

/** A component as the screens use it: its markup, and every property value they ask for. */
interface CollectedComponent {
  name: string
  /** The master this came from, when the instance names one — the identity behind the name. */
  masterId?: string
  body: IrNode | null
  /** property name → the values seen across every instance. */
  values: Map<string, Set<string>>
  types: Map<string, string>
  /** One instance per variant — the second and later ones are what the variant CSS is built from. */
  variants: Map<string, IrNode>
  /** prop name → the Figma property name it came from, which is what the variant key is built of. */
  rawNames: Map<string, string>
}

/**
 * The design system itself, not a screen that uses it.
 *
 * A component page holds variant SETS, and a set's children ARE the variants — there are no
 * instances to read them off. Everything else is the same machinery: the first variant supplies
 * the markup, the rest supply the stylesheets that get renamed onto it and scoped to a class.
 *
 * This is also how the states that a screen export cannot reach arrive. A pressed state is a
 * variant, and a variant is in the library, so a library export has it — a screen then references
 * a component that already knows how to be pressed.
 */
export async function emitLibrary(
  roots: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string>,
  options: EmitReactOptions = {}
): Promise<ReactOutput> {
  const files: Record<string, string> = {}
  const gaps: string[] = []
  // Seeded with what the caller already emitted: a library run that follows another one renders
  // its instances too, and it has to know what those answer to.
  const props = new Map<string, ReadonlyMap<string, PropKind>>(options.libraryProps ?? [])
  const names = new Map<string, string>(options.componentNamesById ?? [])
  const taken = new Set<string>(names.values())

  for (const [, asset] of options.assetsByNodeId ?? []) files[`public/assets/${asset.filename}`] = asset.svg

  for (const root of roots) {
    // A component set has no definition of its own — its variants do — so the def is what tells
    // the two apart. Taking the children either way emitted a plain component as its own first
    // layer: `ListItemInTheMiddleContents` came out as the frame inside it, and everything that
    // frame did not hold was quietly not there.
    const variants = (root as { component?: unknown }).component ? [root] : (root as { children?: IrNode[] }).children ?? []
    // A set with one child is a component with one variant; a root with none is not a set at all.
    if (variants.length === 0) continue
    // Two masters of one name are two components, not one file written twice. The second keeps
    // the name it was given and a number, so both survive and every instance finds its own.
    const wanted = componentName(root.name)
    let name = names.get(root.id) ?? wanted
    if (!names.has(root.id)) {
      for (let n = 2; taken.has(name); n++) name = `${wanted}${n}`
      if (name !== wanted) {
        gaps.push(
          `${wanted} is the name of two different components in this design — this one was emitted as ${name}`
        )
      }
    }
    taken.add(name)
    names.set(root.id, name)
    for (const variant of variants) names.set(variant.id, name)

    const collected: CollectedComponent = {
      name,
      body: variants[0],
      values: new Map(),
      types: new Map(),
      variants: new Map(),
      rawNames: new Map(),
    }
    for (const variant of variants) collected.variants.set(variantKeyFromName(variant.name), variant)

    // And the rest of the interface, which the axes do not carry: the booleans that show a layer
    // and the texts that fill one. Read off the component itself — Figma's own answer to what
    // this component takes. Reading only the axes gave `ListItemInTheMiddleContents` a
    // `subtitle?: string` named after a layer, while every screen was sending it the BOOLEAN of
    // the same name that hides that layer.
    for (const definition of (variants[0] as { component?: { properties?: Array<{ name: string; type: string; defaultValue: string | boolean }> } }).component?.properties ?? []) {
      if (definition.type === 'VARIANT' || definition.type === 'INSTANCE_SWAP') continue
      const prop = propName(definition.name)
      collected.values.set(prop, new Set([String(definition.defaultValue)]))
      collected.types.set(prop, definition.type)
      collected.rawNames.set(prop, definition.name)
    }

    // The props come from the axes Figma named the variants by, which is the whole truth about
    // this component rather than the part one screen happened to use.
    for (const [axis, values] of axesOf(variants.map((one) => one.name))) {
      const prop = propName(axis)
      collected.values.set(prop, values)
      collected.types.set(prop, 'VARIANT')
      collected.rawNames.set(prop, axis)
    }

    const built = await componentFile(
      collected,
      sceneNodesById,
      variableNamesById,
      options.motionByNodeId ?? new Map(),
      options.assetsByNodeId,
      props
    )
    files[`src/components/${name}.tsx`] = built.tsx
    if (built.css.trim() !== '') files[`src/components/${name}.module.css`] = built.css
    gaps.push(...built.gaps)
    props.set(name, built.props)
  }

  if (Object.values(files).some((one) => one.includes("from '../copy'"))) files['src/copy.tsx'] = COPY_FILE
  if (options.tokensCss) files['src/tokens.css'] = options.tokensCss
  Object.assign(files, projectFiles(null, Boolean(options.tokensCss), fontsIn(files)))
  // The same sentence once. A component set says a thing per variant, and a 144-variant button
  // said one dropped prop 144 times — a report nobody reads, and megabytes of it to serialize.
  return { files, names, gaps: [...new Set(gaps)], props }
}

/**
 * Components the emitted files import and nobody emitted.
 *
 * A Button holds an arrow, the arrow is a component of its own, and a Buttons-page export does
 * not reach the Icons page. The import is right and the file is not there — which TypeScript
 * would say, eventually, in a language the designer who ran the export cannot act on.
 *
 * Asked ONCE, of everything that was emitted. Asked per emitter it said the screen was missing a
 * Button that the library right beside it had just written — and a gap that is not true costs the
 * whole list its credit.
 */
export function missingImports(files: Record<string, string>, remote: ReadonlySet<string> = new Set()): string[] {
  const emitted = new Set(
    Object.keys(files)
      .filter((path) => path.startsWith('src/components/') && path.endsWith('.tsx'))
      .map((path) => path.slice('src/components/'.length, -'.tsx'.length))
  )
  const missing = new Map<string, Set<string>>()
  for (const [path, contents] of Object.entries(files)) {
    for (const match of contents.matchAll(/import \{ (\w+) \} from '\.{1,2}\/(?:components\/)?\1'/g)) {
      const name = match[1]
      if (emitted.has(name)) continue
      const from = missing.get(name) ?? new Set<string>()
      from.add(path.split('/').pop() ?? path)
      missing.set(name, from)
    }
  }
  return [...missing].map(([name, from]) =>
    remote.has(name)
      ? // Not a page anyone can name: it is in the library FILE, and no export of this one will
        // ever contain it. Telling a developer to add a page they cannot find is worse than
        // telling them nothing.
        `${name} is used by ${[...from].join(', ')} and comes from the design-system library — ` +
        `import it from your component package, or run this export against that file`
      : `${name} is used by ${[...from].join(', ')} and is not in this export — emit the page it lives on`
  )
}

export async function emitReact(
  roots: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string>,
  options: EmitReactOptions = {}
): Promise<ReactOutput> {
  const files: Record<string, string> = {}
  const gaps: string[] = []
  const props = new Map<string, ReadonlyMap<string, PropKind>>(options.libraryProps ?? [])
  const names = new Map<string, string>(options.componentNamesById ?? [])
  const components = new Map<string, CollectedComponent>()

  for (const root of roots) collectComponents(root, components)

  // Every component gets its name before a line of markup is written, so an instance in a screen
  // resolves to the component built from ITS master rather than to whoever claimed the name first.
  const taken = new Set<string>(names.values())
  for (const component of components.values()) {
    const known = component.masterId ? names.get(component.masterId) : undefined
    if (known) {
      component.name = known
      continue
    }
    let name = component.name
    for (let n = 2; taken.has(name); n++) name = `${component.name}${n}`
    if (name !== component.name) {
      gaps.push(`${component.name} is the name of two different components in this design — this one was emitted as ${name}`)
      component.name = name
    }
    taken.add(name)
    if (component.masterId) names.set(component.masterId, name)
  }

  // The assets themselves, once, under a path a bundler serves as-is.
  for (const [, asset] of options.assetsByNodeId ?? []) files[`public/assets/${asset.filename}`] = asset.svg

  for (const component of components.values()) {
    // From the library only when it is the SAME master — a shared name is not a shared component.
    if (component.masterId && options.fromLibrary?.has(component.masterId)) continue
    if (!component.masterId && options.fromLibrary?.has(component.name)) continue
    const built = await componentFile(
      component,
      sceneNodesById,
      variableNamesById,
      options.motionByNodeId ?? new Map(),
      options.assetsByNodeId,
      props
    )
    files[`src/components/${component.name}.tsx`] = built.tsx
    if (built.css.trim() !== '') files[`src/components/${component.name}.module.css`] = built.css
    gaps.push(...built.gaps)
    props.set(component.name, built.props)
  }

  // The same sentence once. A component set says a thing per variant, and a 144-variant button
  // said one dropped prop 144 times — a report nobody reads, and megabytes of it to serialize.

  let firstScreen: string | null = null
  for (const root of roots) {
    const name = componentName(options.name ?? root.name)
    firstScreen ??= name
    const context = newContext(name.toLowerCase())
    context.assets = options.assetsByNodeId
    context.declares = props
    context.namesById = names
    // The stylesheet first: the markup asks it which classes carry the typography.
    const css = await emitCss([root], sceneNodesById, variableNamesById, { preamble: false })
    context.segments = segmentsIn(css)
    const markup = emitJsx(root, context, 2)

    files[`src/screens/${name}.tsx`] = screenFile(name, markup, context)
    // The motion rules live in the same module as the node they animate. A CSS module hashes its
    // class names, so a global `motion.css` naming `.n15607-95548` would match nothing at all —
    // the rule and the element have to be scoped together or the animation silently never runs.
    const motion = await emitMotion([root], sceneNodesById, options.motionByNodeId ?? new Map())
    files[`src/screens/${name}.module.css`] =
      raiseInstanceRoots(css, context.instanceRoots) + (motion.css.trim() === '' ? '' : `\n\n${motion.css}`)
    gaps.push(...motion.gaps)
    if (Object.keys(context.copy).length > 0) {
      files[`src/locales/${name.toLowerCase()}.json`] = `${JSON.stringify(context.copy, null, 2)}\n`
    }
    if (context.props.size > 0) files[`src/screens/${name}.mock.ts`] = mockFile(name, context)
    gaps.push(...context.gaps)
  }

  if (options.tokensCss) files['src/tokens.css'] = options.tokensCss
  Object.assign(files, projectFiles(firstScreen, Boolean(options.tokensCss), fontsIn(files)))

  // The screens import it, so it is emitted: a scaffold that does not compile because the
  // generator referred to a file it never wrote is a scaffold nobody runs.
  if (Object.values(files).some((one) => one.includes("from '../copy'"))) files['src/copy.tsx'] = COPY_FILE


  return { files, names, gaps: [...new Set(gaps)], props }
}

/* ----------------------------------------------------------------------- motion */

/**
 * The three places Figma keeps movement, in the one place CSS keeps it.
 *
 * `emitInteractions` already turns ON_HOVER/ON_PRESS CHANGE_TO reactions into `:hover`/`:active`
 * rules that name only the properties that actually change — the Django target has done this for
 * a year, and a second implementation would be a second set of bugs. What is added here is the
 * timeline half: a node with manual keyframes becomes `@keyframes` plus an `animation`, with the
 * reduced-motion guard the emitter already writes.
 *
 * Transitions BETWEEN screens are not CSS: they belong to whatever router the team uses, so each
 * one leaves a gap naming the destination and the animation it asked for. Inventing a router
 * would be inventing the half of the app that is not the design.
 */
async function emitMotion(
  roots: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  motionByNodeId: ReadonlyMap<string, MotionSnapshot>
): Promise<{ css: string; js: string; gaps: string[] }> {
  const gaps: string[] = []
  const parts: string[] = []

  const interactions = await emitInteractions(roots, sceneNodesById)
  if (interactions.css.trim() !== '') parts.push(interactions.css)

  // A timeline is per node, and the node's own class is what addresses it.
  for (const root of roots) {
    for (const node of walk(root)) {
      const snapshot = motionByNodeId.get(node.id)
      if (!snapshot || snapshot.tracks.length === 0) continue
      parts.push(emitNodeAnimationCss({ selector: `.${className(node.id)}`, tracks: snapshot.tracks }))
    }
  }

  // A state that could not be diffed is a state nobody will notice is missing.
  //
  // `emitInteractions` builds a `:hover`/`:active` rule by comparing the node's CSS against its
  // destination variant's. When that variant lives outside the exported scope — which is the
  // normal case, since it is a variant of a component on another page — there is nothing to
  // compare and the emitter writes nothing at all. Silence is exactly the failure mode this
  // whole target is built against, so it is named here instead.
  for (const root of roots) {
    for (const node of walk(root)) {
      for (const interaction of node.interactions ?? []) {
        if (sceneNodesById.has(interaction.destinationId)) continue
        const state = interaction.trigger === 'ON_HOVER' ? 'hover' : interaction.trigger === 'ON_PRESS' ? 'pressed' : 'click'
        gaps.push(
          `${node.name}: its ${state} state is the variant ${interaction.destinationId}, which is outside this export — ` +
            `include the component to get the CSS, or write the state by hand`
        )
      }
    }
  }

  for (const root of roots) {
    for (const node of walk(root)) {
      if (!node.navigate) continue
      const asked = node.navigate.transition
      // The animation the designer chose travels with the gap: a router can honour
      // `SLIDE_IN LEFT over 300ms` and cannot honour "there was a transition here".
      const animation = asked
        ? ` — ${asked.style}${asked.direction ? ` ${asked.direction}` : ''} over ${asked.durationMs}ms, ${asked.timingFunction}`
        : ''
      gaps.push(`${node.name}: goes to ${node.navigate.destinationId}${animation}. A screen transition is your router's, not CSS's`)
    }
  }

  return { css: parts.join('\n\n'), js: interactions.js, gaps }
}

function* walk(node: IrNode): Generator<IrNode> {
  yield node
  for (const child of (node as { children?: IrNode[] }).children ?? []) yield* walk(child)
}

/* ------------------------------------------------------------------- components */

function collectComponents(node: IrNode, into: Map<string, CollectedComponent>): void {
  if (node.type === 'instance-ref') {
    const name = componentName(node.componentSetName || node.name)
    // Keyed by the master, not by the name: this file holds two components called
    // `list-Item-InTheMiddle-Contents`, and collecting them under one key rendered every instance
    // of both from whichever the walk reached first.
    const key = node.componentId ?? name
    const held = into.get(key) ?? {
      name,
      masterId: node.componentId ?? undefined,
      body: null,
      values: new Map(),
      types: new Map(),
      variants: new Map(),
      rawNames: new Map(),
    }
    // The first instance supplies the markup. A later one whose shape differs is a real
    // difference and is reported rather than reconciled.
    if (!held.body) held.body = node
    const variant = variantKey(node.componentProperties as never)
    if (!held.variants.has(variant)) held.variants.set(variant, node)
    for (const [raw, value] of Object.entries(node.componentProperties ?? {})) {
      const prop = propName(raw)
      const seen = held.values.get(prop) ?? new Set<string>()
      seen.add(String(value.value))
      held.values.set(prop, seen)
      held.types.set(prop, value.type)
      held.rawNames.set(prop, raw.replace(/#.*$/, ''))
    }
    into.set(key, held)
    // An instance rendered as its component draws its own children, so they are none of the
    // caller's business. One written out as markup is the opposite: the instances inside it are
    // the screen's own now, and a nested icon whose master nobody collected fell back to matching
    // by NAME — the payment card came out Visa where the design says Mastercard.
    if (!node.restyled) return
  }
  for (const child of (node as { children?: IrNode[] }).children ?? []) collectComponents(child, into)
}

async function componentFile(
  component: CollectedComponent,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string>,
  motionByNodeId: ReadonlyMap<string, MotionSnapshot>,
  assetsByNodeId: ReadonlyMap<string, { filename: string; svg: string }> | undefined,
  /** What every component known so far declares. A component body renders instances too, and
   * handing one a prop it never declared fails to compile exactly the way a screen's would. */
  declares: ReadonlyMap<string, ReadonlyMap<string, PropKind>> | undefined
): Promise<{ tsx: string; css: string; gaps: string[]; props: Map<string, PropKind> }> {
  const context: JsxContext = {
    ...newContext(component.name.toLowerCase()),
    insideComponent: true,
    rootId: component.body?.id,
    assets: assetsByNodeId,
    declares,
  }
  // Every variant laid over every other: the markup is their union, and a layer only some of them
  // hold is drawn under a condition. Taking the first variant's layers alone is what made a
  // trailing-icon button come out with no icon at all.
  const laid =
    component.body && component.variants.size > 1
      ? alignVariants([...component.variants].map(([key, node]) => ({ key, node })))
      : null
  const bodyNode = laid ? laid.union : component.body
  const asContainer = bodyNode ? ({ ...(bodyNode as IrNode), type: 'container' } as IrNode) : null
  const motion = asContainer ? await emitMotion([asContainer], sceneNodesById, motionByNodeId) : { css: '', js: '', gaps: [] }
  const baseCss = asContainer
    ? await emitCss([asContainer], sceneNodesById, variableNamesById, { preamble: false })
    : ''
  const variantGaps: string[] = []
  const variantClasses: string[] = []
  let variantCss = ''

  // Every variant after the first: its own stylesheet, renamed onto the first's layers and put
  // behind a class. Without this a secondary button was drawn in the primary's colours and looked
  // like a screen the whole way through.
  if (component.body) {
    const first = [...component.variants.keys()][0]
    for (const [key, instance] of component.variants) {
      if (key === first || key === '') continue
      // The alignment already worked out which of this variant's layers is which; without it —
      // a component with a single variant — fall back to pairing by position.
      const pairs = laid ? laid.maps.get(key) : pairOrExplain(component.body, instance).pairs
      if (!pairs) {
        const { why } = pairOrExplain(component.body, instance)
        variantGaps.push(`${component.name} ${key}: ${why ?? 'built differently'} — this one needs its own markup`)
        continue
      }
      const own = await emitCss([{ ...instance, type: 'container' } as IrNode], sceneNodesById, variableNamesById, {
        preamble: false,
      })
      const scope = variantClass(key)
      variantClasses.push(`${JSON.stringify(key)}: styles[${JSON.stringify(scope)}]`)
      const order = laid && bodyNode ? orderRules(bodyNode, instance, pairs, scope) : ''
      variantCss += `\n\n/* ${key} */\n${scopeVariantCss(own, pairs, scope, baseCss)}${
        order === '' ? '' : `\n\n${order}`
      }`
    }
  }

  // The markup is emitted after the variants are known: its root carries the variant class, and
  // asking for that class before working out whether there is one would emit a reference to
  // nothing.
  // What this component answers to, before a word of its body is written: the text branch asks
  // this to know whether `subtitle` is already a boolean's name and must step aside.
  const own = new Map<string, PropKind>()
  for (const prop of component.values.keys()) own.set(prop, kindOfProp(component.types.get(prop)))
  context.own = own
  context.segments = segmentsIn(baseCss)
  context.hasVariants = variantClasses.length > 0
  context.membership = laid?.membership
  context.allVariants = laid ? new Set(component.variants.keys()) : undefined
  const body = asContainer ? emitJsx(asContainer, context, 2) : '    <div />'

  // Only the layers that are not in every variant need a set; a component whose variants differ
  // by colour alone carries none of this.
  const optional: string[] = []
  if (laid) {
    for (const [id, held] of laid.membership) {
      if (held.size === component.variants.size) continue
      optional.push(`  ${JSON.stringify(id)}: new Set([${[...held].map((one) => JSON.stringify(one)).join(', ')}]),`)
    }
  }
  const hasBlock =
    optional.length > 0 ? `\nconst HAS: Record<string, ReadonlySet<string>> = {\n${optional.join('\n')}\n}\n` : ''

  const css = asContainer
    ? raiseInstanceRoots(baseCss, context.instanceRoots) +
      (motion.css.trim() === '' ? '' : `\n\n${motion.css}`) +
      variantCss
    : ''

  const fields: string[] = []
  for (const [prop, seen] of component.values) {
    const type = component.types.get(prop)
    if (type === 'BOOLEAN') fields.push(`  ${prop}?: boolean`)
    else if (type === 'VARIANT') {
      // The union is what this file's screens actually use — narrower than the component set, and
      // true. A value the design system has and nobody used is not in the type, and adding it
      // would be a promise about markup this emitter has never seen.
      fields.push(`  ${prop}?: ${[...seen].map((one) => JSON.stringify(one)).join(' | ')}`)
    } else fields.push(`  ${prop}?: string`)
  }
  for (const prop of context.props.keys()) if (!component.values.has(prop)) fields.push(`  ${prop}?: string`)

  const props = fields.length > 0 ? `\n${fields.join('\n')}\n` : '\n'
  const imports = [...context.used].filter((one) => one !== component.name)

  // The component works out its own variant the way the emitter did: the same key, built from the
  // props it was handed. A map rather than a chain of conditions — a component set with three axes
  // has more combinations than anyone wants to read.
  const variantProps = [...component.types.entries()].filter(([, type]) => type === 'VARIANT').map(([prop]) => prop)
  // What the component is when nobody says: the variant its body was drawn from. Without this a
  // caller that omits the axis built a key matching no variant, every layer that is not in ALL of
  // them failed its condition, and the component rendered an empty box — the payment card icon
  // was there in the markup and nothing was on the screen.
  const defaults = new Map<string, string>()
  for (const part of ([...component.variants.keys()][0] ?? '').split(',')) {
    const [axis, value] = part.split('=').map((one) => one.trim())
    if (!axis || value === undefined) continue
    const prop = propName(axis)
    if (component.types.get(prop) === 'VARIANT') defaults.set(prop, value)
  }
  const keyExpression =
    variantProps.length > 0
      ? `[${variantProps
          .map((prop) => `\`${component.rawNames.get(prop) ?? prop}=\${${prop}}\``)
          .join(', ')}].sort().join(',')`
      : null
  const variantBlock =
    variantClasses.length > 0 && keyExpression
      ? `\nconst VARIANTS: Record<string, string | undefined> = {\n  ${variantClasses.join(',\n  ')},\n}\n`
      : ''

  const tsx = `${header(component.name)}
import styles from './${component.name}.module.css'
${imports.map((one) => `import { ${one} } from './${one}'`).join('\n')}${imports.length > 0 ? '\n' : ''}${
    Object.keys(context.copy).length > 0 ? "import { useCopy } from '../copy'\n" : ''
  }
export interface ${component.name}Props {${props}  className?: string
}

${variantBlock}${hasBlock}
export function ${component.name}({ ${[...component.values.keys(), ...context.props.keys()]
    .filter((one, index, all) => all.indexOf(one) === index)
    .map((one) => (defaults.has(one) ? `${one} = ${JSON.stringify(defaults.get(one))}` : one))
    .join(', ')}${component.values.size + context.props.size > 0 ? ', ' : ''}className }: ${component.name}Props) {
${Object.keys(context.copy).length > 0 ? '  const t = useCopy()\n' : ''}${
    keyExpression && (variantBlock || hasBlock) ? `  const key = ${keyExpression}\n` : ''
  }${variantBlock ? '  const variant = VARIANTS[key]\n' : ''}  return (
${body}
  )
}
`
  const declared = new Map<string, PropKind>()
  for (const prop of component.values.keys()) declared.set(prop, kindOfProp(component.types.get(prop)))
  for (const prop of context.props.keys()) if (!declared.has(prop)) declared.set(prop, 'text')
  return { tsx, css, gaps: [...context.gaps, ...variantGaps], props: declared }
}

/* ----------------------------------------------------------------------- files */

function screenFile(name: string, markup: string, context: JsxContext): string {
  const locale = `../locales/${name.toLowerCase()}.json`
  const imports = [...context.used].map((one) => `import { ${one} } from '../components/${one}'`).join('\n')
  const props = [...context.props.keys()]
  const signature = props.length > 0 ? `{ ${props.join(', ')} }: ${name}Props` : ''
  const declaration =
    props.length > 0
      ? `export interface ${name}Props {\n${props.map((one) => `  ${one}: string`).join('\n')}\n}\n\n`
      : ''

  return `${header(name)}
import styles from './${name}.module.css'
${imports}${imports ? '\n' : ''}${
    Object.keys(context.copy).length > 0
      ? `import { useCopy } from '../copy'\nimport strings from '${locale}'\n`
      : ''
  }
${declaration}export function ${name}(${signature}) {
${Object.keys(context.copy).length > 0 ? '  const t = useCopy(strings)\n' : ''}  return (
${markup}
  )
}
`
}

function mockFile(name: string, context: JsxContext): string {
  const rows = [...context.props.entries()].map(([prop, value]) => `  ${prop}: ${value},`).join('\n')
  return `${header(name)}
/**
 * What the screen showed in Figma. Replace the object, not the screen: every field here is a
 * prop the component takes, so wiring a real call is one substitution.
 */
export const ${name.charAt(0).toLowerCase()}${name.slice(1)}Mock = {
${rows}
}
`
}

/**
 * The smallest thing that makes `t('key')` work, and the seam where a real i18n library goes.
 *
 * Deliberately not a dependency: the scaffold has to run on `npm install react` alone, and a
 * team that already has i18next replaces this one file rather than unpicking calls from markup.
 */
const COPY_FILE = `/* Generated from Figma. Replace this file with your own i18n — the screens only need \`t\`. */
import { createContext, useContext } from 'react'

export type Copy = Record<string, string>

const CopyContext = createContext<Copy>({})

export const CopyProvider = CopyContext.Provider

export function useCopy(fallback: Copy = {}): (key: string) => string {
  const copy = useContext(CopyContext)
  // The screen's own locale file when no provider is mounted. Without it a fresh clone rendered
  // \`payment.к_оплате\` where the design says "К оплате" — every string on the screen a key,
  // which reads as broken rather than as untranslated.
  // The key itself when nothing answers to it: a missing translation should be findable on the
  // screen, not an empty box.
  return (key: string) => copy[key] ?? fallback[key] ?? key
}
`

/**
 * The repository around the screens: what turns a folder of components into something a developer
 * clones and runs.
 *
 * The first export shipped 98 files that no tool could open — no package.json, no tsconfig, no
 * entry point. It type-checked only because the person running it wrote those three by hand.
 */
function projectFiles(screen: string | null, tokens: boolean, fonts: readonly string[]): Record<string, string> {
  const files: Record<string, string> = {
    // The browser's own 8px body margin made a 390-wide screen render at 374, and every row in it
    // wrapped a line early. A scaffold that needs a reset the developer has to guess is not one.
    'src/global.css':
      `/* The only opinions here are the ones a Figma frame assumes: no page margin, and sizes
` +
      ` * that mean what they say. Everything else the design brings itself. */
` +
      `*,
*::before,
*::after {
  box-sizing: border-box;
}

` +
      `body {
  margin: 0;
}
` +
      (fonts.length > 0
        ? `
/* The design is set in ${fonts.join(', ')} — install ${
            fonts.length > 1 ? 'them' : 'it'
          } (a webfont, or your own @font-face)
 * or the screens fall back to the system sans and every line measures differently. */
`
        : ''),
    'package.json': `${JSON.stringify(
      {
        name: 'figma-export',
        private: true,
        type: 'module',
        scripts: {
          dev: 'vite',
          build: 'tsc --noEmit && vite build',
          preview: 'vite preview',
          typecheck: 'tsc --noEmit',
        },
        dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
        devDependencies: {
          '@types/react': '^18.3.12',
          '@types/react-dom': '^18.3.1',
          '@vitejs/plugin-react': '^4.3.3',
          typescript: '^5.6.3',
          vite: '^5.4.10',
        },
      },
      null,
      2
    )}\n`,
    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          lib: ['ES2020', 'DOM', 'DOM.Iterable'],
          jsx: 'react-jsx',
          module: 'ESNext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['src'],
      },
      null,
      2
    )}\n`,
    'vite.config.ts': `import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\n\nexport default defineConfig({ plugins: [react()] })\n`,
    '.gitignore': 'node_modules\ndist\n',
    // Figma class names are node ids, so the modules cannot be typed field by field; this is what
    // makes `styles["n15595-92556"]` a string rather than an error.
    'src/css-modules.d.ts': `declare module '*.module.css' {\n  const classes: Record<string, string>\n  export default classes\n}\n`,
  }
  if (screen) {
    files['index.html'] =
      `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n` +
      `    <meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
      `    <title>${screen}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n` +
      `    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`
    files['src/main.tsx'] =
      `import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\n` +
      `import './global.css'\n` +
      (tokens ? `import './tokens.css'\n` : '') +
      `import { ${screen} } from './screens/${screen}'\n\n` +
      `createRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <${screen} />\n  </StrictMode>\n)\n`
  }
  return files
}

/**
 * Which classes have typography rules, and how many runs each text holds.
 *
 * Read off the stylesheet the CSS emitter just produced rather than asked of Figma again: the two
 * cannot then disagree about which class the markup should wear.
 */
function segmentsIn(css: string): Map<string, number> {
  const found = new Map<string, number>()
  for (const match of css.matchAll(/\.([A-Za-z0-9_-]+)--segment-(\d+)/g)) {
    const [, base, index] = match
    found.set(base, Math.max(found.get(base) ?? 0, Number(index) + 1))
  }
  return found
}

/** The font families the emitted stylesheets name — what a developer has to install. */
function fontsIn(files: Record<string, string>): string[] {
  const found = new Set<string>()
  for (const [path, contents] of Object.entries(files)) {
    if (!path.endsWith('.css')) continue
    for (const match of contents.matchAll(/font-family:\s*"([^"]+)"/g)) found.add(match[1])
  }
  return [...found]
}

/**
 * The caller's class, said twice, so it outranks the component's own root rule.
 *
 * `.n15595-92774.n15595-92774` is the same element as `.n15595-92774` and one specificity step
 * above it — the smallest change that makes "where this instance sits" beat "how this component
 * is built", without touching the component's stylesheet or depending on which module a bundler
 * emits last.
 */
function raiseInstanceRoots(css: string, ids: ReadonlySet<string>): string {
  let raised = css
  for (const id of ids) {
    const one = toClassName(id)
    raised = raised.split(`\n.${one} {`).join(`\n.${one}.${one} {`)
    if (raised.startsWith(`.${one} {`)) raised = `.${one}.${one} {${raised.slice(`.${one} {`.length)}`
  }
  return raised
}

const header = (name: string): string =>
  `/* Generated from Figma — ${name}. Regenerating replaces this file; edits outside it survive. */`

export { toClassName }
