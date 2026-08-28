/**
 * The design system, as something a caller can ask about.
 *
 * `NODE_CREATE` can already instantiate a component — if you happen to know its id or its
 * published key. Nothing in the plugin could tell you what those were, which made the primitive
 * useless to the caller it was built for: an agent asked to "build the onboarding out of our
 * components" knows the intent and not a single key.
 *
 * The shape of the catalogue is dictated by what Figma will and will not tell a plugin. Local
 * components enumerate cleanly. A *library's* contents do not: there is no API that lists what a
 * published library holds — only `importComponentByKeyAsync`, which wants the key you were trying
 * to find. What is discoverable is what the document already uses, reached through the main
 * component behind each instance in it. That is a real limitation, and the catalogue reports it
 * rather than presenting a partial list as if it were the whole library.
 *
 * The agent channel has had a `components.list` op for a while, and this is not it. That one is
 * an op: an agent can call it and a user module cannot, since a module may only call the
 * plugin's own commands. It also lists local components only, and answers with Figma's raw
 * `componentPropertyDefinitions`, which the reply digest flattens away exactly when a caller
 * needs the variant values. Both stay: the op for an agent that wants the whole structure and
 * the publish status, this for anyone who wants to know what they can build with.
 */

/* ------------------------------------------------------------------ properties */

export interface PropertyDefinition {
  type: string
  variantOptions?: readonly string[]
  defaultValue?: unknown
}

/** What an instance says it carries: the same names, with a value each. */
export interface PropertyOnInstance {
  type: string
  value?: unknown
}

/**
 * Figma suffixes every non-variant property with `#<id>` (`Label#12:34`) so that two components
 * can both have a `Label`. The designer never sees that part and neither should a caller.
 */
export function humanPropertyName(raw: string): string {
  const hash = raw.indexOf('#')
  return (hash === -1 ? raw : raw.slice(0, hash)).trim()
}

const MAX_OPTIONS = 8
const MAX_DEFAULT_TEXT = 24

/**
 * A component's properties as one line: `Size: S|M|L (=M) · Label: text (="Continue")`.
 *
 * A string rather than a structure, for the same reason paints are: this lands inside an array of
 * entries in a reply, where the agent channel's digest summarises anything nested away. A caller
 * choosing between two buttons needs the variant options in front of them, not a shape to go
 * fetch.
 */
export function describeProperties(definitions: Record<string, PropertyDefinition>): string {
  const parts: string[] = []
  for (const [raw, definition] of Object.entries(definitions)) {
    const name = humanPropertyName(raw)
    const options = definition.variantOptions
    const fallback = describeDefault(definition.defaultValue)
    if (options && options.length > 0) {
      const shown = options.slice(0, MAX_OPTIONS).join('|')
      const rest = options.length > MAX_OPTIONS ? `|…+${options.length - MAX_OPTIONS}` : ''
      parts.push(`${name}: ${shown}${rest}${fallback}`)
    } else {
      parts.push(`${name}: ${definition.type.toLowerCase()}${fallback}`)
    }
  }
  return parts.join(' · ')
}

function describeDefault(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  const text = String(value)
  const short = text.length > MAX_DEFAULT_TEXT ? `${text.slice(0, MAX_DEFAULT_TEXT)}…` : text
  return ` (=${short})`
}

export interface ResolvedProperties {
  /** Keyed the way `setProperties` wants them — suffixes and all. */
  resolved: Record<string, string | boolean>
  problems: string[]
}

/**
 * Turns what a caller asked for into what `setProperties` accepts.
 *
 * The catalogue prints `Label`, the API demands `Label#12:34`, and a caller who copied the name
 * off the catalogue would otherwise get Figma's `Property not found` with no way to work out what
 * it wanted. So a bare name is matched against the instance's own property keys, and the two ways
 * that can go wrong — nothing matched, several matched — are named as such.
 *
 * The type is checked here too: `setProperties({ Disabled: 'true' })` throws deep inside Figma
 * with a message about the property, not about the string.
 */
export function resolveProperties(
  wanted: Record<string, unknown>,
  defined: Record<string, PropertyOnInstance>
): ResolvedProperties {
  const resolved: Record<string, string | boolean> = {}
  const problems: string[] = []
  const keys = Object.keys(defined)

  for (const [asked, value] of Object.entries(wanted)) {
    const exact = keys.includes(asked) ? [asked] : []
    const byName = exact.length > 0 ? exact : keys.filter((key) => humanPropertyName(key) === asked)
    const matches =
      byName.length > 0 ? byName : keys.filter((key) => humanPropertyName(key).toLowerCase() === asked.toLowerCase())

    if (matches.length === 0) {
      const available = keys.map(humanPropertyName).join(', ')
      problems.push(`"${asked}" is not a property here — this instance has: ${available || '(none)'}`)
      continue
    }
    if (matches.length > 1) {
      problems.push(`"${asked}" matches ${matches.length} properties (${matches.join(', ')}) — name one in full`)
      continue
    }

    const key = matches[0]
    const type = defined[key].type
    if (type === 'BOOLEAN') {
      if (typeof value !== 'boolean') {
        problems.push(`${humanPropertyName(key)} is a boolean property, and ${JSON.stringify(value)} is not a boolean`)
        continue
      }
    } else if (typeof value !== 'string') {
      problems.push(`${humanPropertyName(key)} is a ${type.toLowerCase()} property, so its value must be a string`)
      continue
    }
    resolved[key] = value as string | boolean
  }

  return { resolved, problems }
}

/* ------------------------------------------------------------------- lookup */

/**
 * A component from an id or a published key — the one place that turns either into something
 * `createInstance` and `swapComponent` will take.
 *
 * A key can name a component *set*, which is what the catalogue hands out (the set is the
 * documentable unit and the thing a designer names), and importing a set key as a component
 * fails. So both imports are tried, and a set answers with the variant Figma itself would show.
 */
export async function componentFor(ref: string): Promise<ComponentNode> {
  const byId = await figma.getNodeByIdAsync(ref).catch(() => null)
  if (byId) {
    if (byId.type === 'COMPONENT') return byId
    if (byId.type === 'COMPONENT_SET') {
      if (!byId.defaultVariant) throw new Error(`"${byId.name}" has no default variant to instantiate`)
      return byId.defaultVariant
    }
    throw new Error(`${ref} is a ${byId.type}, not a component`)
  }

  try {
    return await figma.importComponentByKeyAsync(ref)
  } catch (error) {
    const set = await figma.importComponentSetByKeyAsync(ref).catch(() => null)
    if (set?.defaultVariant) return set.defaultVariant
    // The component error, not the set one: a bad key is far likelier than a set without a
    // default variant, and its message is the one that names the key.
    throw error
  }
}

/* ------------------------------------------------------------------ catalogue */

export interface CatalogEntry {
  id: string
  key: string
  name: string
  /** Local components only — a library component has no page in this document. */
  page?: string
  source: 'local' | 'library'
  /** How many instances of it this document holds. */
  used?: number
  variants?: number
  properties?: string
  description?: string
}

export interface CatalogOptions {
  query?: string
  source?: 'local' | 'library' | 'all'
  /** Default `page`. `document` loads every page first, which is the expensive half. */
  scope?: 'page' | 'document'
  /** False skips the instance census: faster, and then no library component can be found at all. */
  usage?: boolean
  limit?: number
}

export interface Catalog {
  components: CatalogEntry[]
  total: number
  truncated: boolean
  scope: 'page' | 'document'
  instances: number
  /** True when the census stopped at the cap, so `used` counts are a floor rather than a total. */
  sampled: boolean
  note: string
}

/** Past this the census costs more than the counts are worth; the entries are still complete. */
const INSTANCE_CAP = 4000
const DESCRIPTION_CAP = 300

/** The documentable unit is the SET — it owns the name, the description and the variant axes. */
function isDocumentable(node: SceneNode): node is ComponentSetNode | ComponentNode {
  if (node.type === 'COMPONENT_SET') return true
  return node.type === 'COMPONENT' && node.parent?.type !== 'COMPONENT_SET'
}

export async function collectComponents(options: CatalogOptions = {}): Promise<Catalog> {
  const source = options.source ?? 'all'
  const scope = options.scope === 'document' ? 'document' : 'page'
  const census = options.usage !== false
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
  const query = (options.query ?? '').trim().toLowerCase()

  // The page unless asked otherwise. `components.list` over a whole document times out at 180s
  // on the file this was built against: loading every page is the expensive half, and a caller
  // building a flow is working on one page. `document` stays available and says what it costs.
  let root: DocumentNode | PageNode = figma.currentPage
  if (scope === 'document') {
    try {
      await figma.loadAllPagesAsync()
      root = figma.root
    } catch {
      /* older host, or already loaded */
      root = figma.root
    }
  }

  // Figma's own indexed search rather than a walk of our own, and without the mirrors of every
  // hidden layer inside every instance.
  const wasSkipping = figma.skipInvisibleInstanceChildren
  figma.skipInvisibleInstanceChildren = true

  const entries = new Map<string, CatalogEntry>()
  let read = 0
  let sampled = false
  try {
    if (source !== 'library') {
      for (const node of root.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })) {
        if (isDocumentable(node)) entries.set(node.id, entryFor(node, 'local'))
      }
    }

    if (census) {
      const instances = root.findAllWithCriteria({ types: ['INSTANCE'] })
      sampled = instances.length > INSTANCE_CAP
      for (const instance of instances.slice(0, INSTANCE_CAP)) {
        read++
        const main = await instance.getMainComponentAsync().catch(() => null)
        if (!main) continue
        const owner = ownerOf(main)
        const known = entries.get(owner.id)
        if (known) {
          known.used = (known.used ?? 0) + 1
          continue
        }
        // Not local, so this is a library component — and an instance of it is the only evidence
        // this file has that it exists.
        if (source === 'local') continue
        entries.set(owner.id, { ...entryFor(owner, owner.remote ? 'library' : 'local'), used: 1 })
      }
    }
  } finally {
    figma.skipInvisibleInstanceChildren = wasSkipping
  }

  const all = [...entries.values()].filter((entry) => query === '' || entry.name.toLowerCase().includes(query))
  // Most-used first: in a file with three buttons, the one used two hundred times is the one the
  // designer means.
  all.sort((left, right) => (right.used ?? 0) - (left.used ?? 0) || left.name.localeCompare(right.name))

  const where = scope === 'document' ? 'this document' : `the page "${figma.currentPage.name}"`
  return {
    components: all.slice(0, limit),
    total: all.length,
    truncated: all.length > limit,
    scope,
    instances: read,
    sampled,
    note: census
      ? `Everything found in ${where}. Library components are the ones it already uses — Figma offers plugins no way to list a library’s full contents.`
      : `Local components in ${where}: without the instance census (usage: false) a library component cannot be discovered at all.`,
  }
}

function ownerOf(main: ComponentNode): ComponentSetNode | ComponentNode {
  try {
    return main.parent?.type === 'COMPONENT_SET' ? (main.parent as ComponentSetNode) : main
  } catch {
    // A main component in an unloaded library does not always have a reachable parent.
    return main
  }
}

function entryFor(node: ComponentSetNode | ComponentNode, source: 'local' | 'library'): CatalogEntry {
  let definitions: Record<string, PropertyDefinition> = {}
  try {
    definitions = (node.componentPropertyDefinitions ?? {}) as Record<string, PropertyDefinition>
  } catch {
    /* a variant child throws rather than answering — keep the component, lose the properties */
  }
  const properties = describeProperties(definitions)

  let description = ''
  try {
    description = (node.descriptionMarkdown || node.description || '').trim()
  } catch {
    /* unreadable — keep the component, lose the prose */
  }

  return {
    id: node.id,
    key: node.key,
    name: node.name,
    ...(source === 'local' ? { page: pageOf(node) } : {}),
    source,
    ...(node.type === 'COMPONENT_SET' ? { variants: node.children.length } : {}),
    ...(properties ? { properties } : {}),
    // The catalogue is an index, not the documentation: COMPONENTS.md ships the whole text.
    ...(description
      ? { description: description.length > DESCRIPTION_CAP ? `${description.slice(0, DESCRIPTION_CAP)}…` : description }
      : {}),
  }
}

function pageOf(node: BaseNode): string | undefined {
  let current: BaseNode | null = node
  while (current && current.type !== 'PAGE') current = current.parent
  return current?.type === 'PAGE' ? current.name : undefined
}

/* ------------------------------------------------------------------ authoring */

export const PROPERTY_TYPES = ['BOOLEAN', 'TEXT', 'INSTANCE_SWAP', 'VARIANT'] as const

export type PropertyType = (typeof PROPERTY_TYPES)[number]

/**
 * Which field of a layer a property of this type drives.
 *
 * This is the half everyone forgets. `addComponentProperty` puts a row in the panel and changes
 * nothing on the canvas: a property does something only once some layer's
 * `componentPropertyReferences` points at it. So the vocabulary takes the layers to bind and
 * works out the field from the type, rather than asking a caller to know that a boolean drives
 * `visible` and a text property drives `characters`.
 *
 * A VARIANT has no field: its values come from the names of the components in the set.
 */
export function bindingField(type: PropertyType): 'visible' | 'characters' | 'mainComponent' | null {
  switch (type) {
    case 'BOOLEAN':
      return 'visible'
    case 'TEXT':
      return 'characters'
    case 'INSTANCE_SWAP':
      return 'mainComponent'
    default:
      return null
  }
}

export interface PropertyAdd {
  name: string
  type: PropertyType
  default: string | boolean
  /** INSTANCE_SWAP only: components offered first in the swap menu, by id or published key. */
  preferred?: string[]
  /** Layers this property should drive. */
  bind?: string[]
}

export interface PropertyEdit {
  name: string
  rename?: string
  default?: string | boolean
  preferred?: string[]
}

export interface PropertyPlan {
  add: PropertyAdd[]
  edit: PropertyEdit[]
  remove: string[]
  bind: Array<{ node: string; property: string }>
  problems: string[]
}

/** Validates a property request without touching the document. */
export function planComponentProperties(raw: unknown): PropertyPlan {
  const plan: PropertyPlan = { add: [], edit: [], remove: [], bind: [], problems: [] }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    plan.problems.push('the request must be an object of add / edit / remove / bind')
    return plan
  }
  const spec = raw as Record<string, unknown>

  const list = (key: string): unknown[] | null => {
    const value = spec[key]
    if (value === undefined) return null
    if (!Array.isArray(value)) {
      plan.problems.push(`${key} must be an array`)
      return null
    }
    return value
  }

  for (const [index, entry] of (list('add') ?? []).entries()) {
    const at = `add[${index}]`
    const one = entry as Record<string, unknown>
    if (typeof one?.name !== 'string' || one.name.trim() === '') {
      plan.problems.push(`${at}.name must be a non-empty string`)
      continue
    }
    const type = typeof one.type === 'string' ? one.type.trim().toUpperCase() : ''
    if (!PROPERTY_TYPES.includes(type as PropertyType)) {
      plan.problems.push(`${at}.type must be one of: ${PROPERTY_TYPES.join(', ')}`)
      continue
    }
    const fallback = one.default
    if (type === 'BOOLEAN' ? typeof fallback !== 'boolean' : typeof fallback !== 'string') {
      plan.problems.push(
        `${at}.default must be ${type === 'BOOLEAN' ? 'true or false' : 'a string'} for a ${type} property`
      )
      continue
    }
    if (one.bind !== undefined && (!Array.isArray(one.bind) || one.bind.some((id) => typeof id !== 'string'))) {
      plan.problems.push(`${at}.bind must be an array of node ids`)
      continue
    }
    if (one.bind !== undefined && bindingField(type as PropertyType) === null) {
      plan.problems.push(`${at}: a VARIANT property is not bound to layers — its values are the components' names`)
      continue
    }
    if (one.preferred !== undefined && (!Array.isArray(one.preferred) || one.preferred.some((k) => typeof k !== 'string'))) {
      plan.problems.push(`${at}.preferred must be an array of component ids or keys`)
      continue
    }
    plan.add.push({
      name: one.name.trim(),
      type: type as PropertyType,
      default: fallback as string | boolean,
      ...(one.preferred ? { preferred: one.preferred as string[] } : {}),
      ...(one.bind ? { bind: one.bind as string[] } : {}),
    })
  }

  for (const [index, entry] of (list('edit') ?? []).entries()) {
    const at = `edit[${index}]`
    const one = entry as Record<string, unknown>
    if (typeof one?.name !== 'string' || one.name.trim() === '') {
      plan.problems.push(`${at}.name must name the property to change`)
      continue
    }
    if (one.rename !== undefined && (typeof one.rename !== 'string' || one.rename.trim() === '')) {
      plan.problems.push(`${at}.rename must be a non-empty string`)
      continue
    }
    if (one.default !== undefined && typeof one.default !== 'string' && typeof one.default !== 'boolean') {
      plan.problems.push(`${at}.default must be a string or a boolean`)
      continue
    }
    if (one.rename === undefined && one.default === undefined && one.preferred === undefined) {
      plan.problems.push(`${at} changes nothing — give a rename, a default or preferred values`)
      continue
    }
    plan.edit.push({
      name: one.name.trim(),
      ...(one.rename ? { rename: (one.rename as string).trim() } : {}),
      ...(one.default === undefined ? {} : { default: one.default as string | boolean }),
      ...(one.preferred ? { preferred: one.preferred as string[] } : {}),
    })
  }

  for (const [index, entry] of (list('remove') ?? []).entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      plan.problems.push(`remove[${index}] must be a property name`)
      continue
    }
    plan.remove.push(entry.trim())
  }

  for (const [index, entry] of (list('bind') ?? []).entries()) {
    const one = entry as Record<string, unknown>
    if (typeof one?.node !== 'string' || typeof one?.property !== 'string') {
      plan.problems.push(`bind[${index}] must be { node: "<layer id>", property: "<property name>" }`)
      continue
    }
    plan.bind.push({ node: one.node, property: one.property })
  }

  if (plan.add.length + plan.edit.length + plan.remove.length + plan.bind.length === 0 && plan.problems.length === 0) {
    plan.problems.push('nothing to do — give add, edit, remove or bind')
  }
  return plan
}
