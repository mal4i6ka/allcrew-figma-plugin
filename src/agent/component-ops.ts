import { componentFor } from '../canvas/components.ts'
import { findAllByTypes, loadAllPagesAsync } from '../utils/tree.ts'
import type { OpDef } from './protocol.ts'

interface NodeRef {
  id: string
  name: string
  type: string
}

interface OverrideSnapshot {
  path: number[]
  name: string
  type: string
  fields: Record<string, unknown>
  unsupported: string[]
}

const OVERRIDE_FIELDS = [
  'characters', 'fills', 'strokes', 'fillStyleId', 'strokeStyleId', 'textStyleId', 'effectStyleId',
  'effects', 'visible', 'opacity', 'blendMode', 'locked', 'constraints', 'width', 'height', 'minWidth',
  'maxWidth', 'minHeight', 'maxHeight', 'x', 'y', 'rotation', 'cornerRadius', 'cornerSmoothing',
  'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'strokeWeight',
  'strokeAlign', 'dashPattern', 'layoutMode', 'layoutWrap', 'paddingLeft', 'paddingTop', 'paddingRight',
  'paddingBottom', 'itemSpacing', 'counterAxisSpacing', 'layoutAlign', 'layoutGrow', 'layoutPositioning',
  'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems',
  'clipsContent', 'exportSettings', 'reactions',
] as const

function nodeRef(node: BaseNode): NodeRef {
  return { id: node.id, name: 'name' in node ? String(node.name) : '', type: node.type }
}

function pageOf(node: BaseNode): PageNode | null {
  let cursor: BaseNode | null = node
  while (cursor && cursor.type !== 'PAGE') cursor = cursor.parent
  return cursor?.type === 'PAGE' ? cursor : null
}

function containingFrame(node: BaseNode): SceneNode | null {
  let cursor = node.parent
  while (cursor && cursor.type !== 'PAGE') {
    if (
      cursor.type === 'FRAME' ||
      cursor.type === 'SECTION' ||
      cursor.type === 'COMPONENT' ||
      cursor.type === 'COMPONENT_SET'
    ) return cursor
    cursor = cursor.parent
  }
  return null
}

function deepLink(node: BaseNode): string | null {
  const suffix = `?node-id=${node.id.replace(':', '-')}`
  return figma.fileKey ? `https://www.figma.com/design/${figma.fileKey}/${suffix}` : suffix
}

function hasChildren(node: BaseNode): node is BaseNode & ChildrenMixin {
  return 'children' in node
}

function childAtPath(root: BaseNode, path: readonly number[]): SceneNode | null {
  let cursor: BaseNode = root
  for (const index of path) {
    if (!hasChildren(cursor) || !cursor.children[index]) return null
    cursor = cursor.children[index]
  }
  return 'x' in cursor ? (cursor as SceneNode) : null
}

function pathIndex(root: BaseNode): Map<string, { node: SceneNode; path: number[] }> {
  const found = new Map<string, { node: SceneNode; path: number[] }>()
  const stack: Array<{ node: BaseNode; path: number[] }> = [{ node: root, path: [] }]
  while (stack.length) {
    const current = stack.pop()!
    if ('x' in current.node) found.set(current.node.id, { node: current.node as SceneNode, path: current.path })
    if (!hasChildren(current.node)) continue
    for (let index = current.node.children.length - 1; index >= 0; index--) {
      stack.push({ node: current.node.children[index], path: [...current.path, index] })
    }
  }
  return found
}

function cloneValue(value: unknown): unknown {
  if (value === figma.mixed) return undefined
  if (value === null || typeof value !== 'object') return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

function snapshotOverrides(instance: InstanceNode): OverrideSnapshot[] {
  const indexed = pathIndex(instance)
  const snapshots: OverrideSnapshot[] = []
  for (const override of instance.overrides ?? []) {
    const hit = indexed.get(override.id)
    if (!hit) continue
    const raw = hit.node as unknown as Record<string, unknown>
    const fields: Record<string, unknown> = {}
    const unsupported: string[] = []
    for (const field of override.overriddenFields) {
      if (!(OVERRIDE_FIELDS as readonly string[]).includes(field)) {
        unsupported.push(field)
        continue
      }
      try {
        const value = cloneValue(raw[field])
        if (value === undefined) unsupported.push(field)
        else fields[field] = value
      } catch {
        unsupported.push(field)
      }
    }
    snapshots.push({ path: hit.path, name: hit.node.name, type: hit.node.type, fields, unsupported })
  }
  return snapshots
}

function propertyValues(instance: InstanceNode): Record<string, string | boolean | VariableAlias> {
  const values: Record<string, string | boolean | VariableAlias> = {}
  for (const [key, entry] of Object.entries(instance.componentProperties ?? {})) {
    if (entry.type === 'SLOT' || entry.value === undefined) continue
    if (typeof entry.value === 'string' || typeof entry.value === 'boolean') values[key] = entry.value
  }
  return values
}

async function setNodeField(node: SceneNode, field: string, value: unknown): Promise<void> {
  const target = node as unknown as Record<string, unknown>
  if (field === 'reactions' && 'setReactionsAsync' in node) {
    await (node as unknown as { setReactionsAsync(value: Reaction[]): Promise<void> }).setReactionsAsync(value as Reaction[])
    return
  }
  if (field === 'characters' && node.type === 'TEXT') {
    const fonts = node.getRangeAllFontNames(0, node.characters.length)
    for (const font of fonts) await figma.loadFontAsync(font)
  }
  if ((field === 'width' || field === 'height') && 'resize' in node) {
    const width = field === 'width' ? Number(value) : node.width
    const height = field === 'height' ? Number(value) : node.height
    node.resize(width, height)
    return
  }
  target[field] = value
}

async function restoreOverrides(instance: InstanceNode, snapshots: readonly OverrideSnapshot[]) {
  const kept: Array<{ layer: string; field: string }> = []
  const restored: Array<{ layer: string; field: string }> = []
  const lost: Array<{ layer: string; field: string; reason: string }> = []
  const unsupported: Array<{ layer: string; field: string }> = []
  const indexed = [...pathIndex(instance).values()].map((entry) => entry.node)

  for (const snapshot of snapshots) {
    const positional = childAtPath(instance, snapshot.path)
    const target = positional?.type === snapshot.type
      ? positional
      : indexed.find((node) => node.type === snapshot.type && node.name === snapshot.name) ?? null
    for (const field of snapshot.unsupported) unsupported.push({ layer: snapshot.name, field })
    for (const [field, value] of Object.entries(snapshot.fields)) {
      if (!target) {
        lost.push({ layer: snapshot.name, field, reason: 'no matching layer after swap' })
        continue
      }
      const current = cloneValue((target as unknown as Record<string, unknown>)[field])
      if (JSON.stringify(current) === JSON.stringify(value)) {
        kept.push({ layer: target.name, field })
        continue
      }
      try {
        await setNodeField(target, field, value)
        const after = cloneValue((target as unknown as Record<string, unknown>)[field])
        if (JSON.stringify(after) === JSON.stringify(value)) restored.push({ layer: target.name, field })
        else lost.push({ layer: target.name, field, reason: 'field read back differently' })
      } catch (error) {
        lost.push({ layer: target.name, field, reason: String((error as Error)?.message || error) })
      }
    }
  }
  return { kept, restored, lost, unsupported }
}

async function componentTarget(raw: unknown): Promise<ComponentNode> {
  if (typeof raw === 'string' && raw) return componentFor(raw)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('"to" must be an id/key string or { set, variant }')
  const target = raw as Record<string, unknown>
  if (typeof target.set !== 'string' || !target.set) throw new Error('"to.set" must be a component-set id or key')
  const base = await componentFor(target.set)
  const set = base.parent?.type === 'COMPONENT_SET' ? base.parent : null
  if (!set) throw new Error(`"${base.name}" is not in a component set`)
  if (target.variant === undefined) return set.defaultVariant ?? base
  if (!target.variant || typeof target.variant !== 'object' || Array.isArray(target.variant)) {
    throw new Error('"to.variant" must be an object of variant property names to values')
  }
  const wanted = target.variant as Record<string, unknown>
  const variants = set.children.filter((candidate): candidate is ComponentNode => candidate.type === 'COMPONENT')
  const match = variants.find((candidate) => {
    const values = candidate.variantProperties ?? {}
    return Object.entries(wanted).every(([name, value]) => values[name] === value)
  })
  if (!match) throw new Error(`no variant in "${set.name}" matches ${JSON.stringify(wanted)}`)
  return match
}

function pluginData(node: SceneNode): Record<string, string> {
  const values: Record<string, string> = {}
  for (const key of node.getPluginDataKeys()) values[key] = node.getPluginData(key)
  return values
}

function applyPluginData(node: SceneNode, values: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(values)) node.setPluginData(key, value)
}

async function rebuildInstance(instance: InstanceNode, target: ComponentNode): Promise<{ instance: InstanceNode; fellBackBecause?: string }> {
  const parent = instance.parent
  if (!parent || !('insertChild' in parent)) throw new Error('instance parent cannot accept a replacement')
  const index = parent.children.indexOf(instance)
  const before = {
    x: instance.x, y: instance.y, rotation: instance.rotation, visible: instance.visible, locked: instance.locked,
    opacity: instance.opacity, blendMode: instance.blendMode, constraints: cloneValue(instance.constraints),
    layoutAlign: instance.layoutAlign, layoutGrow: instance.layoutGrow, layoutPositioning: instance.layoutPositioning,
    layoutSizingHorizontal: instance.layoutSizingHorizontal, layoutSizingVertical: instance.layoutSizingVertical,
    minWidth: instance.minWidth, maxWidth: instance.maxWidth, minHeight: instance.minHeight, maxHeight: instance.maxHeight,
    pluginData: pluginData(instance), reactions: cloneValue(instance.reactions), width: instance.width, height: instance.height,
  }
  const replacement = target.createInstance()
  parent.insertChild(index, replacement)
  try {
    const autoLayoutParent = 'layoutMode' in parent && parent.layoutMode !== 'NONE'
    replacement.layoutSizingHorizontal = 'FIXED'
    replacement.layoutSizingVertical = 'FIXED'
    replacement.resize(before.width, before.height)
    replacement.layoutPositioning = before.layoutPositioning
    if (!autoLayoutParent || before.layoutPositioning === 'ABSOLUTE') {
      replacement.x = before.x
      replacement.y = before.y
      replacement.constraints = before.constraints as Constraints
    }
    replacement.rotation = before.rotation
    replacement.visible = before.visible
    replacement.locked = before.locked
    replacement.opacity = before.opacity
    replacement.blendMode = before.blendMode
    replacement.layoutAlign = before.layoutAlign
    replacement.layoutGrow = before.layoutGrow
    replacement.minWidth = before.minWidth
    replacement.maxWidth = before.maxWidth
    replacement.minHeight = before.minHeight
    replacement.maxHeight = before.maxHeight
    replacement.layoutSizingHorizontal = before.layoutSizingHorizontal
    replacement.layoutSizingVertical = before.layoutSizingVertical
    applyPluginData(replacement, before.pluginData)
    if (before.reactions) await replacement.setReactionsAsync(before.reactions as Reaction[])
  } catch (error) {
    replacement.remove()
    throw error
  }
  instance.remove()
  return { instance: replacement }
}

async function orphanGroups() {
  await loadAllPagesAsync()
  const instances = await findAllByTypes<InstanceNode>(figma.root, ['INSTANCE'])
  const groups = new Map<string, { status: 'deleted' | 'missing'; name: string; restoreFrom: NodeRef[]; instances: InstanceNode[] }>()
  for (const instance of instances) {
    let main: ComponentNode | null = null
    try { main = await instance.getMainComponentAsync() } catch { main = null }
    if (main && !main.removed) continue
    const status: 'deleted' | 'missing' = main?.removed ? 'deleted' : 'missing'
    const name = main?.name || instance.name
    const key = `${status}:${main?.id ?? name}`
    const group = groups.get(key) ?? { status, name, restoreFrom: [], instances: [] }
    group.instances.push(instance)
    group.restoreFrom.push(nodeRef(instance))
    groups.set(key, group)
  }
  return [...groups.entries()].map(([group, value]) => ({ group, ...value }))
    .sort((a, b) => b.instances.length - a.instances.length || a.name.localeCompare(b.name))
}

export const COMPONENT_READ_OPS: readonly OpDef[] = [
  {
    name: 'component.instances',
    summary: 'Document-wide component inventory: every copy, its page/frame, nesting and jump link, plus unused locals.',
    agent: 'Use this before component cleanup or migration. Counts are complete across loaded pages; unused means a local component has no instances in this file.',
    mutates: false,
    params: {
      limit: { type: 'number', default: 500, min: 1, max: 5000, description: 'Maximum instance rows returned; counts remain complete.' },
    },
    async run(params) {
      await loadAllPagesAsync()
      const [instances, components] = await Promise.all([
        findAllByTypes<InstanceNode>(figma.root, ['INSTANCE']),
        findAllByTypes<ComponentNode>(figma.root, ['COMPONENT']),
      ])
      const byComponent = new Map<string, { component: NodeRef & { key: string }; copies: Array<Record<string, unknown>> }>()
      for (const component of components) {
        byComponent.set(component.id, { component: { ...nodeRef(component), key: component.key }, copies: [] })
      }
      const unresolved: Array<Record<string, unknown>> = []
      for (const instance of instances) {
        let main: ComponentNode | null = null
        try { main = await instance.getMainComponentAsync() } catch { main = null }
        const page = pageOf(instance)
        const frame = containingFrame(instance)
        const nested = instance.parent?.type === 'INSTANCE' || (() => {
          let parent: BaseNode | null = instance.parent
          while (parent && parent.type !== 'PAGE') {
            if (parent.type === 'INSTANCE') return true
            parent = parent.parent
          }
          return false
        })()
        const row = {
          ...nodeRef(instance),
          page: page ? nodeRef(page) : null,
          frame: frame ? nodeRef(frame) : null,
          nested,
          link: deepLink(instance),
        }
        if (!main || main.removed) unresolved.push(row)
        else {
          const entry = byComponent.get(main.id) ?? { component: { ...nodeRef(main), key: main.key }, copies: [] }
          entry.copies.push(row)
          byComponent.set(main.id, entry)
        }
      }
      const all = [...byComponent.values()].sort((a, b) => b.copies.length - a.copies.length || a.component.name.localeCompare(b.component.name))
      const limit = params.limit as number
      let remaining = limit
      const inventory = all.map((entry) => {
        const copies = entry.copies.slice(0, Math.max(0, remaining))
        remaining -= copies.length
        return { component: entry.component, count: entry.copies.length, unused: entry.copies.length === 0, copies }
      })
      return { components: inventory.length, instances: instances.length, unused: inventory.filter((row) => row.unused).length, unresolved: unresolved.length, truncated: instances.length > limit, inventory, orphanInstances: unresolved.slice(0, Math.max(0, remaining)) }
    },
  },
  {
    name: 'component.orphans',
    summary: 'Orphan instances grouped by dead master: deleted locals versus missing masters, ranked by impact.',
    agent: 'Each group includes restoreFrom candidates. Start component.restore with the cleanest representative from the largest group.',
    mutates: false,
    params: {},
    async run() {
      const groups = await orphanGroups()
      return { groups: groups.length, instances: groups.reduce((sum, group) => sum + group.instances.length, 0), orphans: groups.map(({ instances, ...group }) => ({ ...group, count: instances.length })) }
    },
  },
]

export const COMPONENT_WRITE_OPS: readonly OpDef[] = [
  {
    name: 'component.restore',
    summary: 'Rebuild one dead master from an orphan and reassign every orphan in that group with override recovery.',
    agent: 'Pass restoreFrom from component.orphans. The source is cloned before detach; every matching orphan is swapped and the report names kept, restored and lost overrides.',
    mutates: true,
    params: {
      restoreFrom: { type: 'string', required: true, description: 'Orphan instance id to clone into the new master.' },
      dryRun: { type: 'boolean', default: false, description: 'Report the group and source without changing the document.' },
    },
    async run(params) {
      const source = await figma.getNodeByIdAsync(params.restoreFrom as string)
      if (!source || source.type !== 'INSTANCE') throw new Error('restoreFrom must identify an INSTANCE')
      const groups = await orphanGroups()
      const group = groups.find((candidate) => candidate.instances.some((instance) => instance.id === source.id))
      if (!group) throw new Error(`instance ${source.id} is not orphaned`)
      if (params.dryRun === true) return { dryRun: true, group: group.group, name: group.name, count: group.instances.length, restoreFrom: nodeRef(source) }
      figma.commitUndo()
      const clone = source.clone()
      const detached = clone.detachInstance()
      const master = figma.createComponentFromNode(detached)
      master.name = group.name
      const page = pageOf(source)
      if (page) page.appendChild(master)
      master.x = source.x + source.width + 80
      master.y = source.y
      const results = []
      for (const orphan of group.instances) {
        const snapshots = snapshotOverrides(orphan)
        const properties = propertyValues(orphan)
        try {
          orphan.swapComponent(master)
          try { orphan.setProperties(properties) } catch { /* detailed layer report still follows */ }
          const overrides = await restoreOverrides(orphan, snapshots)
          results.push({ node: orphan.id, ok: overrides.lost.length === 0, ...overrides })
        } catch (error) {
          results.push({ node: orphan.id, ok: false, kept: [], restored: [], lost: [{ layer: orphan.name, field: 'master', reason: String((error as Error)?.message || error) }] })
        }
      }
      return { dryRun: false, group: group.group, master: { ...nodeRef(master), link: deepLink(master) }, total: results.length, restored: results.filter((row) => row.ok).length, results }
    },
  },
  {
    name: 'instance.swap',
    summary: 'Swap or rebuild instances to an id, library key, or set variant, preserving and reporting overrides.',
    agent: 'strategy:auto tries native swap first and rebuilds only when Figma refuses; swap never silently falls back. The per-field report separates kept, restored, lost and unsupported overrides, and rebuild returns a newId.',
    mutates: true,
    params: {
      nodes: { type: 'string[]', required: true, description: 'Instance node ids.' },
      to: { type: 'string', description: 'Component id or 40-character library key.' },
      set: { type: 'string', description: 'Component-set id or key when selecting a variant.' },
      variant: { type: 'json', description: 'With set: an object of exact variant property names to values.' },
      strategy: { type: 'string', enum: ['auto', 'swap', 'rebuild'], default: 'auto', description: 'Native swap, structural rebuild, or swap with rebuild fallback.' },
      dryRun: { type: 'boolean', default: false, description: 'Resolve targets and report without changing nodes.' },
    },
    async run(params) {
      const ids = Array.isArray(params.nodes) ? (params.nodes as unknown[]).filter((id): id is string => typeof id === 'string' && id !== '') : []
      if (!ids.length) throw new Error('"nodes" must be a non-empty array of instance ids')
      const target = await componentTarget(
        typeof params.to === 'string' && params.to !== ''
          ? params.to
          : { set: params.set, ...(params.variant === undefined ? {} : { variant: params.variant }) }
      )
      const strategy = params.strategy as 'auto' | 'swap' | 'rebuild'
      const dryRun = params.dryRun === true
      if (!dryRun) figma.commitUndo()
      const results = []
      for (const id of ids) {
        const found = await figma.getNodeByIdAsync(id)
        if (!found || found.type !== 'INSTANCE') {
          results.push({ node: id, ok: false, error: `${found?.type ?? 'nothing'} — need an INSTANCE` })
          continue
        }
        const before = await found.getMainComponentAsync().catch(() => null)
        if (dryRun) {
          results.push({ node: id, ok: true, strategy, before: before ? nodeRef(before) : null, to: nodeRef(target) })
          continue
        }
        const snapshots = snapshotOverrides(found)
        const properties = propertyValues(found)
        let instance = found
        let used: 'swap' | 'rebuild' = strategy === 'rebuild' ? 'rebuild' : 'swap'
        let fellBackBecause: string | undefined
        try {
          if (strategy === 'rebuild') {
            instance = (await rebuildInstance(found, target)).instance
          } else {
            try {
              found.swapComponent(target)
            } catch (error) {
              if (strategy === 'swap') throw error
              fellBackBecause = String((error as Error)?.message || error)
              instance = (await rebuildInstance(found, target)).instance
              used = 'rebuild'
            }
          }
          try { instance.setProperties(properties) } catch { /* field-level report remains authoritative */ }
          const overrides = await restoreOverrides(instance, snapshots)
          results.push({ node: id, newId: instance.id === id ? undefined : instance.id, ok: overrides.lost.length === 0, strategy: used, fellBackBecause, before: before ? nodeRef(before) : null, after: nodeRef(target), ...overrides })
        } catch (error) {
          results.push({ node: id, ok: false, strategy: used, fellBackBecause, error: String((error as Error)?.message || error) })
        }
      }
      return { dryRun, target: nodeRef(target), total: results.length, succeeded: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok).length, results }
    },
  },
]
