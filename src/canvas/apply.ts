/**
 * Walking a property plan onto a real node.
 *
 * Deliberately dumb: `props.ts` decided what to do and in what order, so everything here is one
 * `switch` and a lot of care about what Figma refuses. Each step is applied on its own and
 * reported on its own — a node that took nine properties and refused the tenth says exactly
 * that, rather than failing whole or claiming success.
 *
 * `before` is read per property rather than up front: reading the whole node costs more than the
 * write does, and a caller wants to know what THIS write displaced, not what the node used to
 * look like in general.
 */

import { parseHex } from '../tokens/color.ts'
import { resolveCollection, resolveModes, resolveVariableRef } from '../agent/values.ts'
import { componentFor, humanPropertyName, resolveProperties } from './components.ts'
import { describeLinks, gradientHandles, gradientTransform, resolveRanges } from './props.ts'
import { styleFor } from './styles.ts'
import type {
  GradientRef,
  ImageRef,
  PaintRef,
  PlannedAction,
  PlannedCondition,
  PlannedOperand,
  PropStep,
  TextRun,
} from './props.ts'

export interface AppliedProp {
  property: string
  before?: unknown
  after?: unknown
  /** Present when this one property could not be applied — the rest still were. */
  error?: string
}

export interface ApplyReport {
  applied: AppliedProp[]
  failed: number
}

/**
 * @param dry report what each step would do, touching nothing. The `before` is real; the `after`
 *            is what the caller asked for.
 */
export async function applyProps(node: SceneNode, steps: readonly PropStep[], dry = false): Promise<ApplyReport> {
  const applied: AppliedProp[] = []
  let failed = 0

  for (const step of steps) {
    try {
      // A step can also fail in part — `properties` sets four of five and names the fifth — so
      // the report is what decides, not only whether something was thrown.
      const result = await applyStep(node, step, dry)
      if (result.error) failed++
      applied.push(result)
    } catch (error) {
      failed++
      applied.push({ property: propertyOf(step), error: String((error as Error)?.message || error) })
    }
  }
  return { applied, failed }
}

const propertyOf = (step: PropStep): string => {
  switch (step.step) {
    case 'assign':
    case 'paint':
      return step.property
    case 'font':
      return 'fontName'
    case 'text':
      return 'characters'
    case 'resize':
      return 'size'
    case 'radius':
      return 'cornerRadius'
    case 'reparent':
      return 'parent'
    // A refusal should name the slot the caller wrote, the way a success does — "style" tells
    // them nothing about which of the five they got wrong.
    case 'style':
      return step.slot
    // `layout`, `constraints` and `lineHeight` are named after themselves.
    default:
      return step.step
  }
}

async function applyStep(node: SceneNode, step: PropStep, dry: boolean): Promise<AppliedProp> {
  const bag = node as unknown as Record<string, unknown>

  switch (step.step) {
    case 'assign': {
      if (!(step.property in bag)) throw new Error(`a ${node.type} has no ${step.property}`)
      const before = bag[step.property]
      // Text properties refuse to move until the font is loaded, whatever they are — a size
      // change on a text node whose font is unavailable throws the same way characters do.
      if (node.type === 'TEXT' && TEXT_PROPERTIES.includes(step.property)) await loadNodeFont(node)
      if (!dry) bag[step.property] = step.value
      return { property: step.property, before, after: step.value }
    }

    case 'font': {
      if (node.type !== 'TEXT') throw new Error(`only a TEXT node has a font, not a ${node.type}`)
      const before = describeFont(node.fontName)
      const font: FontName = { family: step.family, style: step.style }
      // Loaded even on a dry run: "that font is not available" is exactly the answer a dry run
      // exists to give, and finding out at apply time would be too late.
      await figma.loadFontAsync(font)
      if (!dry) node.fontName = font
      return { property: 'fontName', before, after: `${step.family} ${step.style}` }
    }

    case 'text': {
      if (node.type !== 'TEXT') throw new Error(`only a TEXT node has characters, not a ${node.type}`)
      await loadNodeFont(node)
      const before = node.characters
      if (!dry) node.characters = step.characters
      return { property: 'characters', before, after: step.characters }
    }

    case 'lineHeight': {
      if (node.type !== 'TEXT') throw new Error(`only a TEXT node has a line height, not a ${node.type}`)
      await loadNodeFont(node)
      const before = node.lineHeight
      const after: LineHeight = step.value === 'AUTO' ? { unit: 'AUTO' } : { value: step.value, unit: 'PIXELS' }
      if (!dry) node.lineHeight = after
      return { property: 'lineHeight', before, after }
    }

    case 'resize': {
      if (typeof (node as unknown as { resize?: unknown }).resize !== 'function') {
        throw new Error(`a ${node.type} cannot be resized`)
      }
      const before = { width: round(node.width), height: round(node.height) }
      const width = step.width ?? node.width
      const height = step.height ?? node.height
      // resizeWithoutConstraints, not resize: a caller asking for a size means that size, not
      // that size plus whatever the children's constraints do to it.
      if (!dry) (node as FrameNode).resizeWithoutConstraints(width, height)
      // Read back, because an auto-layout frame is not obliged to keep it: asking a hugging
      // frame for 260 leaves it at 157, and a report that said 260 would be a report of the
      // request rather than of the result.
      const after = dry
        ? { width: round(width), height: round(height) }
        : { width: round(node.width), height: round(node.height) }
      return { property: 'size', before, after }
    }

    case 'radius': {
      if (!('cornerRadius' in bag)) throw new Error(`a ${node.type} has no corners`)
      const corners = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const
      const before: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}
      for (const corner of corners) {
        const amount = step.corners[corner]
        if (amount === undefined) continue
        const property = `${corner}Radius`
        before[property] = bag[property]
        after[property] = amount
        if (!dry) bag[property] = amount
      }
      return { property: 'cornerRadius', before, after }
    }

    case 'constraints': {
      if (!('constraints' in bag)) throw new Error(`a ${node.type} has no constraints`)
      const before = bag.constraints
      const current = (before ?? { horizontal: 'MIN', vertical: 'MIN' }) as Constraints
      const after: Constraints = {
        horizontal: (step.horizontal ?? current.horizontal) as Constraints['horizontal'],
        vertical: (step.vertical ?? current.vertical) as Constraints['vertical'],
      }
      if (!dry) bag.constraints = after
      return { property: 'constraints', before, after }
    }

    case 'layout': {
      if (!('layoutMode' in bag)) throw new Error(`a ${node.type} has no auto-layout`)
      const frame = node as FrameNode
      const before = {
        mode: frame.layoutMode,
        gap: frame.itemSpacing,
        padding: [frame.paddingTop, frame.paddingRight, frame.paddingBottom, frame.paddingLeft],
      }
      const layout = step.layout
      if (!dry) {
        // Mode first: on a frame with no auto-layout, everything below is ignored until it has
        // one, and Figma reports no error about it.
        if (layout.mode) frame.layoutMode = layout.mode
        if (layout.gap !== undefined) frame.itemSpacing = layout.gap
        if (layout.padding) {
          const [top, right, bottom, left] = layout.padding as [number, number, number, number]
          frame.paddingTop = top
          frame.paddingRight = right
          frame.paddingBottom = bottom
          frame.paddingLeft = left
        }
        if (layout.primaryAxis) frame.primaryAxisAlignItems = layout.primaryAxis
        if (layout.counterAxis) frame.counterAxisAlignItems = layout.counterAxis
        if (layout.wrap !== undefined) frame.layoutWrap = layout.wrap ? 'WRAP' : 'NO_WRAP'
      }
      return { property: 'layout', before, after: layout }
    }

    case 'paint': {
      if (!(step.property in bag)) throw new Error(`a ${node.type} has no ${step.property}`)
      const before = await describePaints(bag[step.property])
      const paints = await buildPaints(step.ref)
      if (!dry) bag[step.property] = paints
      return { property: step.property, before, after: await describePaints(paints) }
    }

    case 'reset': {
      const instance = asInstance(node, 'overrides to reset')
      let before: string | null = null
      try {
        before = `${instance.overrides.length} override(s)`
      } catch {
        /* the count is a courtesy; not being able to read it must not stop the reset */
      }
      // `removeOverrides` is the current spelling; `resetOverrides` is the deprecated one that
      // older hosts still answer to.
      const bag = instance as unknown as Record<string, unknown>
      if (!dry) {
        if (typeof bag.removeOverrides === 'function') instance.removeOverrides()
        else instance.resetOverrides()
      }
      return { property: 'reset', before, after: 'whatever the main component says' }
    }

    case 'swap': {
      const instance = asInstance(node, 'a component to swap')
      const target = await componentFor(step.component)
      const before = componentName(await instance.getMainComponentAsync())
      if (!dry) instance.swapComponent(target)
      return { property: 'swap', before, after: componentName(target) }
    }

    case 'properties': {
      const instance = asInstance(node, 'component properties')
      const defined = instance.componentProperties as unknown as Record<string, { type: string; value?: unknown }>
      const { resolved, problems } = resolveProperties(step.properties, defined)

      const before: Record<string, unknown> = {}
      for (const key of Object.keys(resolved)) before[humanPropertyName(key)] = defined[key]?.value

      if (!dry && Object.keys(resolved).length > 0) {
        try {
          instance.setProperties(resolved)
        } catch {
          // One at a time, so the caller learns WHICH property Figma refused instead of losing
          // the four that were fine. A sparse variant set is the usual reason: not every
          // combination of axes exists.
          for (const [key, value] of Object.entries(resolved)) {
            try {
              instance.setProperties({ [key]: value })
            } catch (one) {
              problems.push(`${humanPropertyName(key)}: ${String((one as Error)?.message || one)}`)
            }
          }
        }
      }

      // Read back rather than echoed: on a sparse set Figma may land on a neighbouring variant,
      // and the report should say where the instance actually ended up. By name and not by key,
      // because setting a VARIANT changes the main component underneath — and with it the `#id`
      // suffix every other property is keyed by.
      const now: Record<string, unknown> | null = dry ? null : byHumanName(instance.componentProperties)
      const after: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(resolved)) {
        const name = humanPropertyName(key)
        after[name] = now && name in now ? now[name] : value
      }

      return {
        property: 'properties',
        before,
        after,
        ...(problems.length > 0 ? { error: problems.join(' · ') } : {}),
      }
    }

    case 'links': {
      const holder = node as SceneNode & {
        setReactionsAsync?: (reactions: Reaction[]) => Promise<void>
        reactions?: readonly Reaction[]
      }
      if (typeof holder.setReactionsAsync !== 'function') {
        throw new Error(`a ${node.type} cannot carry prototype links`)
      }

      // A destination that does not exist makes a link Figma accepts and the prototype ignores —
      // a broken flow that looks built. Cheaper to find here than in a demo.
      for (const id of step.destinations) {
        const target = await figma.getNodeByIdAsync(id).catch(() => null)
        if (!target) throw new Error(`no node with id ${id} to link to`)
      }

      const reactions: Reaction[] = []
      for (const link of step.links) {
        const actions: Action[] = []
        for (const action of link.actions) actions.push(await buildAction(action))
        reactions.push({ trigger: link.trigger, actions })
      }

      // `reactions` is the property; there is no `getReactionsAsync` — only `setReactionsAsync`,
      // which is what "read-only under dynamic-page" means here.
      const had = Array.isArray(holder.reactions) ? holder.reactions.length : 0
      if (!dry) await holder.setReactionsAsync(reactions)
      // Read back rather than echoed, because Figma normalises what it is given — an "else if"
      // comes back as a nested conditional — and a report of the request would disagree with
      // the next read of the same node.
      const stored = !dry && Array.isArray(holder.reactions) ? holder.reactions : reactions
      return { property: 'links', before: `${had} link(s)`, after: await describeLinks(stored, variableName) }
    }

    case 'data': {
      const before: Record<string, unknown> = {}
      for (const key of Object.keys(step.data)) {
        const held = node.getPluginData(key)
        if (held !== '') before[key] = held
      }
      // Figma stores no key for an empty string, which is exactly what clearing one means.
      if (!dry) for (const [key, value] of Object.entries(step.data)) node.setPluginData(key, value ?? '')
      return { property: 'data', before, after: step.data }
    }

    case 'effects': {
      if (!('effects' in bag)) throw new Error(`a ${node.type} takes no effects`)
      const before = await describeEffects(bag.effects)

      // A bound field is bound on the effect object, not on the node: `setBoundVariableForEffect`
      // hands back a NEW effect, so each binding is folded into the list before the list is set.
      let effects = step.effects
      const failures: string[] = []
      for (const binding of step.bind) {
        try {
          const variable = await resolveVariableRef(binding.variable)
          const wants = binding.field === 'color' ? 'COLOR' : 'FLOAT'
          if (variable.resolvedType !== wants) {
            throw new Error(`"${variable.name}" is a ${variable.resolvedType}, and ${binding.field} wants a ${wants}`)
          }
          const bound = figma.variables.setBoundVariableForEffect(
            effects[binding.index],
            binding.field as VariableBindableEffectField,
            variable
          )
          effects = effects.map((effect, index) => (index === binding.index ? bound : effect))
        } catch (error) {
          failures.push(`${binding.field}: ${String((error as Error)?.message || error)}`)
        }
      }

      if (!dry) bag.effects = effects
      return {
        property: 'effects',
        before,
        after: step.summary,
        ...(failures.length > 0 ? { error: failures.join(' · ') } : {}),
      }
    }

    case 'animation': {
      const holder = node as SceneNode & {
        animationStyles?: ReadonlyArray<{ id: string; styleId: string }>
        applyAnimationStyle?: (styleId: string, data?: AnimationStyleConfiguration) => string
        removeAnimationStyle?: (id: string) => void
      }
      if (typeof holder.applyAnimationStyle !== 'function') {
        throw new Error(`a ${node.type} takes no animation styles`)
      }
      const held = holder.animationStyles ?? []
      const before = held.map((one) => one.styleId).join(', ') || 'none'

      // Checked against the styles Figma actually has BEFORE anything is removed. The list is
      // replaced whole, so a typo used to take the node's existing animation with it — and the
      // catalogue that would have caught it was one call away.
      const available = figma.motion.figmaAnimationStyles().map((style) => style.styleId)
      const unknown = step.styles.map((one) => one.style).filter((name) => !available.includes(name))
      if (unknown.length > 0) {
        throw new Error(`no animation style called ${unknown.join(', ')} — Figma has ${available.join(', ')}`)
      }

      const failures: string[] = []
      if (!dry) {
        // Replaced whole, like links and effects: the list is what the node has, and there is no
        // way to say "remove that one" in a vocabulary that only describes the end state.
        for (const applied of [...held]) holder.removeAnimationStyle?.(applied.id)
        for (const one of step.styles) {
          try {
            const settings: Record<string, unknown> = {}
            for (const [name, value] of Object.entries(one.props)) {
              const named = value as { variable?: string }
              if (named && typeof named === 'object' && typeof named.variable === 'string') {
                const variable = await resolveVariableRef(named.variable)
                settings[name] = { type: 'VARIABLE_ALIAS', id: variable.id }
                continue
              }
              settings[name] = value
            }
            holder.applyAnimationStyle(one.style, {
              ...(one.duration === undefined ? {} : { duration: one.duration }),
              ...(one.offset === undefined ? {} : { timelineOffset: one.offset }),
              ...(Object.keys(settings).length > 0 ? { props: settings as AnimationStyleConfiguration['props'] } : {}),
            })
          } catch (error) {
            failures.push(`${one.style}: ${String((error as Error)?.message || error)}`)
          }
        }
      }

      return {
        property: 'animation',
        before,
        after: step.summary,
        ...(failures.length > 0 ? { error: failures.join(' · ') } : {}),
      }
    }

    case 'grid': {
      if (!('layoutGrids' in bag)) throw new Error(`a ${node.type} takes no layout grids`)
      const before = Array.isArray(bag.layoutGrids) ? `${(bag.layoutGrids as unknown[]).length} grid(s)` : 'none'
      if (!dry) bag.layoutGrids = step.grids
      return { property: 'grid', before, after: step.summary }
    }

    case 'dashes': {
      if (!('dashPattern' in bag)) throw new Error(`a ${node.type} has no stroke to dash`)
      const before = bag.dashPattern
      if (!dry) bag.dashPattern = step.dashes
      return { property: 'strokeDashes', before, after: step.dashes }
    }

    case 'runs': {
      if (node.type !== 'TEXT') throw new Error(`only a TEXT node has runs, not a ${node.type}`)
      await loadNodeFont(node)

      const applied: string[] = []
      const problems: string[] = []
      for (const run of step.runs) {
        const { ranges, problem } = resolveRanges(node.characters, run)
        if (problem) {
          problems.push(problem)
          continue
        }
        // The font of a run has to be in memory before the run can be written, exactly as for the
        // whole node — and it is a different font from the one already loaded, or there would be
        // no point setting it.
        if (run.fontName) await figma.loadFontAsync(run.fontName)
        const paints = run.fill === undefined ? null : await buildPaints(run.fill)

        for (const [from, to] of ranges) {
          if (dry) continue
          if (run.fontName) node.setRangeFontName(from, to, run.fontName)
          if (run.fontSize !== undefined) node.setRangeFontSize(from, to, run.fontSize)
          if (paints) node.setRangeFills(from, to, paints)
          if (run.textDecoration) node.setRangeTextDecoration(from, to, run.textDecoration)
          if (run.textCase) node.setRangeTextCase(from, to, run.textCase)
          if (run.letterSpacing !== undefined) {
            node.setRangeLetterSpacing(from, to, { value: run.letterSpacing, unit: 'PIXELS' })
          }
          if (run.lineHeight !== undefined) {
            node.setRangeLineHeight(from, to, run.lineHeight === 'AUTO' ? { unit: 'AUTO' } : { value: run.lineHeight, unit: 'PIXELS' })
          }
          if (run.link !== undefined) {
            node.setRangeHyperlink(from, to, run.link === null ? null : { type: 'URL', value: run.link })
          }
        }
        // What was styled, in the words of the text rather than in indices.
        for (const [from, to] of ranges) applied.push(`"${node.characters.slice(from, to)}" ${describeRun(run)}`)
      }

      return {
        property: 'runs',
        before: `${node.characters.length} character(s)`,
        after: applied.join(' · ') || 'nothing',
        ...(problems.length > 0 ? { error: problems.join(' · ') } : {}),
      }
    }

    case 'sizing': {
      if (!('layoutSizingHorizontal' in bag)) throw new Error(`a ${node.type} has no sizing to set`)
      const before = { horizontal: bag.layoutSizingHorizontal, vertical: bag.layoutSizingVertical }
      const failures: string[] = []
      for (const axis of ['horizontal', 'vertical'] as const) {
        const mode = step[axis]
        if (!mode) continue
        try {
          if (!dry) applySizing(node as FrameNode, axis, mode)
        } catch (error) {
          // FILL on a node whose parent lays nothing out, HUG on a node with no children: Figma
          // refuses each on its own, and one refusal must not lose the other axis.
          failures.push(`${axis}: ${String((error as Error)?.message || error)}`)
        }
      }
      return {
        property: 'sizing',
        before,
        after: { horizontal: step.horizontal, vertical: step.vertical },
        ...(failures.length > 0 ? { error: failures.join(' · ') } : {}),
      }
    }

    case 'bind': {
      const holder = node as SceneNode & {
        setBoundVariable?: (field: string, variable: Variable | null) => void
      }
      if (typeof holder.setBoundVariable !== 'function') throw new Error(`a ${node.type} binds no variables`)

      const before: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}
      const failures: string[] = []
      const bound = (node as unknown as { boundVariables?: Record<string, { id?: string }> }).boundVariables ?? {}

      for (const entry of step.bindings) {
        try {
          const held = bound[entry.field]?.id
          if (held) {
            const was = await figma.variables.getVariableByIdAsync(held).catch(() => null)
            before[entry.field] = `var:${was?.name ?? held}`
          }
          if (entry.variable === null) {
            if (!dry) holder.setBoundVariable(entry.field, null)
            after[entry.field] = 'unbound'
            continue
          }
          const variable = await resolveVariableRef(entry.variable)
          // Figma answers a type mismatch by naming the field, never the variable, so the
          // sentence that would actually help is written here.
          if (variable.resolvedType !== entry.wants) {
            throw new Error(`"${variable.name}" is a ${variable.resolvedType}, and ${entry.field} wants a ${entry.wants}`)
          }
          if (!dry) holder.setBoundVariable(entry.field, variable)
          after[entry.field] = `var:${variable.name}`
        } catch (error) {
          failures.push(`${entry.field}: ${String((error as Error)?.message || error)}`)
        }
      }

      return {
        property: 'bind',
        before,
        after,
        ...(failures.length > 0 ? { error: failures.join(' · ') } : {}),
      }
    }

    case 'style': {
      const setter = STYLE_SETTERS[step.slot]
      const holder = node as unknown as Record<string, unknown>
      if (typeof holder[setter] !== 'function') {
        throw new Error(`a ${node.type} takes no ${step.slot}`)
      }
      // Readable as a plain property, writable only through the async setter — that asymmetry
      // is what `documentAccess: "dynamic-page"` means for styles, and there is no
      // `getFillStyleIdAsync` to pair with `setFillStyleIdAsync`.
      const held = holder[`${step.slot}Id`]
      const was =
        typeof held === 'string' && held !== '' ? await figma.getStyleByIdAsync(held).catch(() => null) : null

      if (step.ref === null) {
        if (!dry) await (holder[setter] as (id: string) => Promise<void>)('')
        return { property: step.slot, before: was?.name ?? null, after: 'detached' }
      }
      const style = await styleFor(step.ref, step.kind)
      if (!dry) await (holder[setter] as (id: string) => Promise<void>)(style.id)
      return { property: step.slot, before: was?.name ?? null, after: style.name }
    }

    case 'network': {
      const holder = node as SceneNode & { setVectorNetworkAsync?: (network: VectorNetwork) => Promise<void> }
      if (typeof holder.setVectorNetworkAsync !== 'function') {
        throw new Error(`a ${node.type} has no vector network — only a vector does`)
      }
      const before = (node as unknown as { vectorNetwork?: VectorNetwork }).vectorNetwork
      // Asynchronous, like everything else that writes structure under dynamic-page; the plain
      // property is readable and does not accept a write.
      if (!dry) await holder.setVectorNetworkAsync(step.network)
      return {
        property: 'network',
        before: before ? `${before.vertices.length} point(s), ${before.segments.length} segment(s)` : 'none',
        after: step.summary,
      }
    }

    case 'paths': {
      if (!('vectorPaths' in bag)) throw new Error(`a ${node.type} has no paths — only a vector does`)
      const before = (bag.vectorPaths as VectorPaths | undefined)?.length ?? 0
      if (!dry) bag.vectorPaths = step.paths
      return {
        property: 'paths',
        before: `${before} path(s)`,
        after: step.paths.map((path) => `${path.windingRule} ${path.data}`).join(' · '),
      }
    }

    case 'reparent': {
      const before = node.parent ? { id: node.parent.id, name: node.parent.name } : null
      const parent = step.parent === '' ? node.parent : await resolveParent(step.parent)
      if (!parent) throw new Error('the node has no parent to move within')
      if (!('appendChild' in parent)) throw new Error(`a ${parent.type} cannot hold children`)
      if (!dry) {
        const container = parent as BaseNode & ChildrenMixin
        if (step.index === undefined) container.appendChild(node)
        else container.insertChild(Math.min(step.index, container.children.length), node)
      }
      return { property: 'parent', before, after: { id: parent.id, name: parent.name, index: step.index } }
    }
  }
}

/** A variant's own name is its axis values ("Type=Primary, Size=L"), which names nothing anyone
 * can look up. The set that owns it is what the catalogue calls it. */
function componentName(component: ComponentNode | null): string | null {
  if (!component) return null
  try {
    return component.parent?.type === 'COMPONENT_SET' ? component.parent.name : component.name
  } catch {
    return component.name
  }
}

/** One planned action, with its names turned into the ids Figma stores. */
async function buildAction(action: PlannedAction): Promise<Action> {
  switch (action.kind) {
    case 'back':
      return { type: 'BACK' }
    case 'close':
      return { type: 'CLOSE' }
    case 'url':
      return { type: 'URL', url: action.url, openInNewTab: action.newTab }
    case 'setVariable': {
      const variable = await resolveVariableRef(action.variable)
      const value = action.value
      if (typeof value === 'object' && value !== null) {
        const other = await resolveVariableRef(value.variable)
        if (other.resolvedType !== variable.resolvedType) {
          throw new Error(`"${other.name}" is a ${other.resolvedType} and "${variable.name}" holds a ${variable.resolvedType}`)
        }
        return {
          type: 'SET_VARIABLE',
          variableId: variable.id,
          variableValue: { type: 'VARIABLE_ALIAS', resolvedType: variable.resolvedType, value: { type: 'VARIABLE_ALIAS', id: other.id } },
        }
      }
      // The type is checked here because Figma stores whatever it is given and the prototype
      // simply does nothing at run time, which is the worst way to find out.
      const held = typeof value === 'boolean' ? 'BOOLEAN' : typeof value === 'number' ? 'FLOAT' : 'STRING'
      if (held !== variable.resolvedType) {
        throw new Error(`"${variable.name}" is a ${variable.resolvedType}, and ${JSON.stringify(value)} is a ${held}`)
      }
      return {
        type: 'SET_VARIABLE',
        variableId: variable.id,
        variableValue: { type: held, resolvedType: variable.resolvedType, value },
      }
    }
    case 'setMode': {
      const collection = await resolveCollection(action.collection)
      const modes = resolveModes(collection, action.mode)
      if (modes.length !== 1) throw new Error(`"${action.mode}" must name exactly one mode of ${collection.name}`)
      return { type: 'SET_VARIABLE_MODE', variableCollectionId: collection.id, variableModeId: modes[0].modeId }
    }
    case 'conditional': {
      const blocks: ConditionalBlock[] = []
      for (const block of action.blocks) {
        const actions: Action[] = []
        for (const one of block.actions) actions.push(await buildAction(one))
        blocks.push({ ...(block.condition ? { condition: await buildCondition(block.condition) } : {}), actions })
      }
      return { type: 'CONDITIONAL', conditionalBlocks: blocks }
    }
    default:
      return {
        type: 'NODE',
        destinationId: action.destinationId,
        navigation: action.navigation,
        transition: action.transition,
        ...(action.resetScroll === undefined ? {} : { resetScrollPosition: action.resetScroll }),
        ...(action.resetVideo === undefined ? {} : { resetVideoPosition: action.resetVideo }),
        ...(action.resetInteractive === undefined ? {} : { resetInteractiveComponents: action.resetInteractive }),
      }
  }
}

/**
 * One question, as the expression tree Figma stores.
 *
 * Each side becomes a `VariableData`: a literal carries its own type, a variable carries an
 * alias, and a nested comparison carries another expression. The resolved type of the whole is
 * BOOLEAN, because that is what a condition answers.
 */
async function buildCondition(condition: PlannedCondition): Promise<VariableData> {
  const args: VariableData[] = []
  for (const operand of condition.args) args.push(await buildOperand(operand))
  return {
    type: 'EXPRESSION',
    resolvedType: 'BOOLEAN',
    value: { expressionFunction: condition.fn as ExpressionFunction, expressionArguments: args },
  }
}

async function buildOperand(operand: PlannedOperand): Promise<VariableData> {
  if (operand.kind === 'condition') return buildCondition(operand.condition)
  if (operand.kind === 'variable') {
    const variable = await resolveVariableRef(operand.name)
    return {
      type: 'VARIABLE_ALIAS',
      resolvedType: variable.resolvedType,
      value: { type: 'VARIABLE_ALIAS', id: variable.id },
    }
  }
  const value = operand.value
  const type = typeof value === 'boolean' ? 'BOOLEAN' : typeof value === 'number' ? 'FLOAT' : 'STRING'
  return { type, resolvedType: type, value }
}

/**
 * The lookup `describeLinks` needs to print a name where Figma stores an id.
 *
 * Three kinds of id arrive here and each is looked up differently: a mode's id means nothing
 * without the collection that owns it, so that is asked for alongside.
 */
export async function variableName(id: string, withinCollection?: string): Promise<string | null> {
  if (withinCollection) {
    const collection = await figma.variables.getVariableCollectionByIdAsync(withinCollection).catch(() => null)
    return collection?.modes.find((mode) => mode.modeId === id)?.name ?? null
  }
  if (id.startsWith('VariableCollectionId:')) {
    return (await figma.variables.getVariableCollectionByIdAsync(id).catch(() => null))?.name ?? null
  }
  return (await figma.variables.getVariableByIdAsync(id).catch(() => null))?.name ?? null
}

function byHumanName(properties: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(properties as Record<string, { value?: unknown }>)) {
    out[humanPropertyName(key)] = entry?.value
  }
  return out
}

/** What one run does, short enough to sit beside the text it did it to. */
function describeRun(run: TextRun): string {
  const parts: string[] = []
  if (run.fontName) parts.push(`${run.fontName.family} ${run.fontName.style}`)
  if (run.fontSize !== undefined) parts.push(`${run.fontSize}px`)
  if (run.fill !== undefined) parts.push(typeof run.fill === 'string' ? run.fill : 'fill')
  if (run.textDecoration) parts.push(run.textDecoration.toLowerCase())
  if (run.textCase) parts.push(run.textCase.toLowerCase())
  if (run.letterSpacing !== undefined) parts.push(`tracking ${run.letterSpacing}`)
  if (run.lineHeight !== undefined) parts.push(`leading ${run.lineHeight}`)
  if (run.link !== undefined) parts.push(run.link === null ? 'unlinked' : 'linked')
  return parts.join(' ')
}

const STYLE_SETTERS: Readonly<Record<string, string>> = {
  fillStyle: 'setFillStyleIdAsync',
  strokeStyle: 'setStrokeStyleIdAsync',
  textStyle: 'setTextStyleIdAsync',
  effectStyle: 'setEffectStyleIdAsync',
  gridStyle: 'setGridStyleIdAsync',
}

/** Instance-only vocabulary refuses by naming the type it was given, like everything else here. */
function asInstance(node: SceneNode, wanted: string): InstanceNode {
  if (node.type !== 'INSTANCE') throw new Error(`only an INSTANCE has ${wanted}, not a ${node.type}`)
  return node
}

/** The properties that a TEXT node will not let go of until its font is in memory. */
const TEXT_PROPERTIES = [
  'fontSize',
  'letterSpacing',
  'textAlignHorizontal',
  'textAlignVertical',
  'textAutoResize',
  'textCase',
  'textDecoration',
  'paragraphSpacing',
]

/**
 * Loads whatever the node is already using, mixed runs included.
 *
 * A text node with several styled runs has `fontName: figma.mixed`, and writing anything at all
 * needs every one of those fonts loaded — so a mixed node is asked for its runs rather than
 * refused.
 */
async function loadNodeFont(node: TextNode): Promise<void> {
  if (node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName as FontName)
    return
  }
  const fonts = new Set<string>()
  const wanted: FontName[] = []
  for (let index = 0; index < node.characters.length; index++) {
    const font = node.getRangeFontName(index, index + 1)
    if (font === figma.mixed) continue
    const key = `${(font as FontName).family}|${(font as FontName).style}`
    if (fonts.has(key)) continue
    fonts.add(key)
    wanted.push(font as FontName)
  }
  await Promise.all(wanted.map((font) => figma.loadFontAsync(font)))
}

function applySizing(frame: FrameNode, axis: 'horizontal' | 'vertical', mode: 'FIXED' | 'HUG' | 'FILL'): void {
  // HUG and FILL are the same property in Figma's API with different names depending on whether
  // the node is the container or the child — `layoutSizing*` covers both, and it is the one that
  // refuses honestly when the node is not in an auto-layout parent.
  const property = axis === 'horizontal' ? 'layoutSizingHorizontal' : 'layoutSizingVertical'
  ;(frame as unknown as Record<string, unknown>)[property] = mode
}

async function buildPaints(ref: PaintRef): Promise<Paint[]> {
  if (ref === null) return []
  // A list is a stack of layers, bottom-up the way Figma holds them.
  if (Array.isArray(ref)) {
    const stack: Paint[] = []
    for (const one of ref) stack.push(...(await buildPaints(one)))
    return stack
  }

  if (typeof ref === 'string') return [solid(ref)]
  if ('gradient' in ref) return [await buildGradient(ref)]
  if ('image' in ref) return [await buildImage(ref)]
  if ('variable' in ref) {
    const variable = await resolveVariableRef(ref.variable)
    if (variable.resolvedType !== 'COLOR') {
      throw new Error(`"${variable.name}" is a ${variable.resolvedType} variable, not a colour`)
    }
    // Bound rather than painted: the point of naming a variable is that the layer follows it.
    const base: SolidPaint = { type: 'SOLID', color: { r: 0, g: 0, b: 0 } }
    return [figma.variables.setBoundVariableForPaint(base, 'color', variable)]
  }
  return [solid(ref.color, ref.opacity)]
}

/**
 * A gradient, from the handles and the stops.
 *
 * A stop may name a variable rather than a colour — which is how a gradient token stays a token
 * once it is on a layer. There is no `setBoundVariableForPaint` for a stop, so the binding is
 * written into the stop itself, which is what Figma reads.
 */
async function buildGradient(ref: GradientRef): Promise<GradientPaint> {
  const { from, to } = gradientHandles(ref)
  const spread = ref.stops.length - 1

  const stops: ColorStop[] = []
  for (const [index, entry] of ref.stops.entries()) {
    const stop = typeof entry === 'string' ? { at: spread === 0 ? 0 : index / spread, color: entry } : entry
    const alpha = stop.opacity ?? 1

    if (typeof stop.color === 'object') {
      const variable = await resolveVariableRef(stop.color.variable)
      if (variable.resolvedType !== 'COLOR') {
        throw new Error(`"${variable.name}" is a ${variable.resolvedType} variable, not a colour`)
      }
      stops.push({
        position: stop.at,
        color: { r: 0, g: 0, b: 0, a: alpha },
        boundVariables: { color: { type: 'VARIABLE_ALIAS', id: variable.id } },
      })
      continue
    }
    const rgb = parseHex(stop.color)
    if (!rgb) throw new Error(`"${stop.color}" is not a colour`)
    stops.push({ position: stop.at, color: { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha } })
  }

  // Figma reads the stops in order; a caller listing them out of order means the same gradient.
  stops.sort((left, right) => left.position - right.position)

  return {
    type: `GRADIENT_${ref.gradient.toUpperCase()}` as GradientPaint['type'],
    gradientTransform: gradientTransform(from, to, ref.gradient),
    gradientStops: stops,
    ...(ref.opacity === undefined ? {} : { opacity: ref.opacity }),
  }
}

/**
 * A picture, from the three places one can come from.
 *
 * `hash` is one the document already holds — the cheapest, and what a read hands back, so a fill
 * can be copied from one node to another without the bytes ever leaving Figma. `url` is fetched
 * by Figma itself. `bytes` is base64, which is the only way an image crosses into a sandbox that
 * has no filesystem.
 */
async function buildImage(ref: ImageRef): Promise<ImagePaint> {
  const { hash, url, bytes } = ref.image
  let imageHash: string
  if (hash) {
    imageHash = hash
  } else if (url) {
    const image = await figma.createImageAsync(url)
    imageHash = image.hash
  } else {
    const image = figma.createImage(figma.base64Decode(bytes as string))
    imageHash = image.hash
  }
  return {
    type: 'IMAGE',
    scaleMode: ref.scaleMode ?? 'FILL',
    imageHash,
    ...(ref.opacity === undefined ? {} : { opacity: ref.opacity }),
  }
}

function solid(hex: string, opacity?: number): SolidPaint {
  const rgb = parseHex(hex)
  if (!rgb) throw new Error(`"${hex}" is not a colour`)
  return {
    type: 'SOLID',
    color: { r: rgb.r, g: rgb.g, b: rgb.b },
    ...(opacity === undefined ? {} : { opacity }),
  }
}

async function resolveParent(id: string): Promise<BaseNode | null> {
  if (id === 'page') return figma.currentPage
  const node = await figma.getNodeByIdAsync(id)
  if (!node) throw new Error(`no node with id ${id}`)
  return node
}

/**
 * Paints as one readable line: the token's NAME if there is one, the colour otherwise.
 *
 * A string, not a structure, and deliberately. This lands in a report five levels down —
 * `replies[].nodes[].applied[].before` — where the agent channel's digest summarises anything
 * nested into "nested too deep to quote", so a shape here is a shape nobody downstream can read.
 * The id a bound paint carries is no use to a human either; the name costs one lookup per paint
 * and is the thing worth reporting.
 */
export async function describePaints(value: unknown): Promise<string | null> {
  if (value === figma.mixed) return 'mixed'
  if (!Array.isArray(value)) return value === undefined ? null : String(value)
  if (value.length === 0) return 'none'

  const parts: string[] = []
  for (const paint of value) {
    if (typeof paint !== 'object' || paint === null) {
      parts.push(String(paint))
      continue
    }
    const entry = paint as Paint & { boundVariables?: Record<string, { id?: string }> }
    const bound = entry.boundVariables?.color?.id
    if (bound) {
      const named = await figma.variables.getVariableByIdAsync(bound).catch(() => null)
      parts.push(`var:${named?.name ?? bound}`)
      continue
    }
    if (entry.type === 'IMAGE') {
      // The hash, because it is what puts the same picture on another node.
      const picture = paint as ImagePaint
      parts.push(`image:${picture.imageHash ?? '?'} ${picture.scaleMode}`)
      continue
    }
    if (entry.type.startsWith('GRADIENT')) {
      const gradient = paint as GradientPaint
      const colours: string[] = []
      for (const stop of gradient.gradientStops) {
        const bound = stop.boundVariables?.color?.id
        if (bound) {
          const named = await figma.variables.getVariableByIdAsync(bound).catch(() => null)
          colours.push(`var:${named?.name ?? bound}`)
          continue
        }
        colours.push(hexOf(stop.color))
      }
      parts.push(`${entry.type.replace('GRADIENT_', 'gradient:').toLowerCase()} ${colours.join(' → ')}`)
      continue
    }
    if (entry.type !== 'SOLID') {
      parts.push(entry.type)
      continue
    }
    const flat = entry as SolidPaint
    const hex = `#${[flat.color.r, flat.color.g, flat.color.b]
      .map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()}`
    parts.push(flat.opacity !== undefined && flat.opacity < 1 ? `${hex} @${flat.opacity}` : hex)
  }
  return parts.join(' + ')
}

function hexOf(color: { r: number; g: number; b: number; a?: number }): string {
  const hex = `#${[color.r, color.g, color.b]
    .map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
  return color.a !== undefined && color.a < 1 ? `${hex} @${round(color.a)}` : hex
}

/** Applied animation styles as one line, in the words the vocabulary takes them in. */
export function describeAnimation(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return 'none'
  return (value as AppliedAnimationStyle[])
    .map((style) => {
      // Figma answers with every setting the style has, defaults and all — eleven of them for
      // Position — which turned one line into a file. The first few are the ones a caller set or
      // would recognise; the rest are counted.
      const entries = Object.entries(style.props ?? {})
      const shown = entries
        .slice(0, MAX_ANIMATION_PROPS)
        .map(([name, held]) => `${name}=${typeof held === 'object' ? JSON.stringify(held) : held}`)
        .join(', ')
      const rest = entries.length > MAX_ANIMATION_PROPS ? `, +${entries.length - MAX_ANIMATION_PROPS} more` : ''
      // An applied style carries a per-instance CodeComponentId and a localisation key
      // (`motion.preset_name.position`) — neither is the word a caller writes. The catalogue has
      // both halves, so it is asked for the word.
      const called = animationStyleWord(style.name) ?? animationStyleWord(style.styleId) ?? style.name ?? style.styleId
      const seconds = style.duration === undefined ? '' : ` ${Math.round(style.duration * 1000) / 1000}s`
      return `${called}${seconds}${shown ? ` (${shown}${rest})` : ''}`
    })
    .join(' · ')
}

const MAX_ANIMATION_PROPS = 5

/**
 * The word the catalogue calls a style, from either of the two names an applied one carries.
 *
 * Read once: the list is Figma's own six presets and does not change while a plugin runs.
 */
let styleWords: Map<string, string> | null = null

function animationStyleWord(key: string | undefined): string | null {
  if (!key) return null
  if (!styleWords) {
    styleWords = new Map()
    try {
      for (const style of figma.motion.figmaAnimationStyles()) {
        styleWords.set(style.styleId, style.styleId)
        if (style.name) styleWords.set(style.name, style.styleId)
      }
    } catch {
      /* an older host without Motion — the raw name is all there is */
    }
  }
  return styleWords.get(key) ?? null
}

/** Layout grids as one line, in the words the vocabulary takes them in. */
export function describeGrids(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return 'none'
  const parts: string[] = []
  for (const grid of value as LayoutGrid[]) {
    if (grid.pattern === 'GRID') {
      parts.push(`square ${grid.sectionSize}`)
      continue
    }
    const rows = grid as RowsColsLayoutGrid
    const kind = rows.pattern === 'COLUMNS' ? 'column' : 'row'
    parts.push(
      `${rows.count} ${kind}(s) ${rows.alignment.toLowerCase()}` +
        `${rows.gutterSize ? ` gutter ${rows.gutterSize}` : ''}` +
        `${rows.offset ? ` margin ${rows.offset}` : ''}` +
        `${rows.sectionSize ? ` at ${rows.sectionSize}` : ''}`
    )
  }
  return parts.join(' · ')
}

/** Effects as one readable line, for the same reason paints are: this lands deep in a report. */
export async function describeEffects(value: unknown): Promise<string> {
  if (!Array.isArray(value)) return value === figma.mixed ? 'mixed' : 'none'
  if (value.length === 0) return 'none'

  const parts: string[] = []
  for (const effect of value as Effect[]) {
    // A bound field is bound on the effect, not on the node, so it does not show up in the
    // node's `boundVariables` and a read that ignored it reported a token-driven elevation as
    // four loose numbers.
    const bound = (effect as { boundVariables?: Record<string, { id?: string }> }).boundVariables ?? {}
    const named = async (field: string, fallback: string | number): Promise<string> => {
      const id = bound[field]?.id
      if (!id) return String(fallback)
      const variable = await figma.variables.getVariableByIdAsync(id).catch(() => null)
      return `var:${variable?.name ?? id}`
    }

    if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
      parts.push(`${effect.type === 'LAYER_BLUR' ? 'layer' : 'background'} blur ${await named('radius', effect.radius)}`)
      continue
    }
    if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
      const { r, g, b, a } = effect.color
      const hex = `#${[r, g, b].map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`
      const colour = await named('color', `${hex}${a === 1 ? '' : ` @${round(a)}`}`)
      const kind = effect.type === 'DROP_SHADOW' ? 'drop' : 'inner'
      const spread = effect.spread || bound.spread ? ` spread ${await named('spread', effect.spread ?? 0)}` : ''
      const x = await named('offsetX', effect.offset.x)
      const y = await named('offsetY', effect.offset.y)
      parts.push(`${kind} shadow ${colour} ${x},${y} blur ${await named('radius', effect.radius)}${spread}`)
      continue
    }
    parts.push(String((effect as { type: string }).type).toLowerCase())
  }
  return parts.join(' · ')
}

const describeFont = (font: FontName | typeof figma.mixed): string =>
  font === figma.mixed ? 'mixed' : `${(font as FontName).family} ${(font as FontName).style}`

const round = (value: number): number => Math.round(value * 100) / 100
