/**
 * Agent listener — the mutating op registry.
 *
 * Reads let an agent describe a file; these let it change one. The surface stays deliberately
 * narrow: an agent can write *variable values*, *bind a layer to a variable*, and draw a
 * *board*, and that is all. A recolor is exactly those things — repoint the tokens, attach the
 * layers a token never reached, and put the before/after somewhere a designer can look at it —
 * so the surface stays auditable while still being enough to do the job end to end.
 *
 * Three rules hold for everything here:
 *   - `figma.commitUndo()` first, so a batch is one ⌘Z for the designer, not two hundred.
 *   - every batch reports per entry; one bad row never takes the other ninety-nine with it.
 *   - `dryRun` returns the identical report without touching the document, so an agent can
 *     show its work before it does it.
 */

import type { OpDef } from './protocol.ts'
import { renderBoard } from './board.ts'
import { resolveEditableTarget } from '../targets/django/lint/fix.ts'
import {
  coerceVariableValue,
  describeValue,
  resolveCollection,
  resolveModes,
  resolveVariable,
  resolveVariableRef,
} from './values.ts'

/* ------------------------------------------------------------------ report */

interface UpdateResult {
  variable: string
  name: string
  mode: string
  before: string
  after: string
  ok: boolean
  changed?: boolean
  error?: string
}

function asArray(value: unknown, param: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`param "${param}" must be an array`)
  return value
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be an object`)
  }
  return value as Record<string, unknown>
}

const RESOLVED_TYPES = ['COLOR', 'FLOAT', 'BOOLEAN', 'STRING'] as const

/* ---------------------------------------------------------------- bindings */

/** Scalar fields `setBoundVariable` accepts, and the variable type each one takes. Kept as a
 * table rather than handed to the API blind: a FLOAT aimed at `characters` fails deep inside
 * Figma with a message that names neither the node nor the field. */
const SCALAR_FIELDS: Readonly<Record<string, 'FLOAT' | 'STRING' | 'BOOLEAN'>> = {
  width: 'FLOAT',
  height: 'FLOAT',
  minWidth: 'FLOAT',
  maxWidth: 'FLOAT',
  minHeight: 'FLOAT',
  maxHeight: 'FLOAT',
  topLeftRadius: 'FLOAT',
  topRightRadius: 'FLOAT',
  bottomLeftRadius: 'FLOAT',
  bottomRightRadius: 'FLOAT',
  itemSpacing: 'FLOAT',
  counterAxisSpacing: 'FLOAT',
  paddingLeft: 'FLOAT',
  paddingRight: 'FLOAT',
  paddingTop: 'FLOAT',
  paddingBottom: 'FLOAT',
  strokeWeight: 'FLOAT',
  opacity: 'FLOAT',
  characters: 'STRING',
  visible: 'BOOLEAN',
}

/** One name a designer would say, several fields the API actually takes. */
const FIELD_GROUPS: Readonly<Record<string, readonly string[]>> = {
  cornerRadius: ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'],
  padding: ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'],
}

const PAINT_FIELDS: Readonly<Record<string, 'fills' | 'strokes'>> = { fill: 'fills', stroke: 'strokes' }

/** `cornerRadius` → four corners; anything else stands for itself. */
export function expandBindField(field: string): readonly string[] {
  return FIELD_GROUPS[field] ?? [field]
}

/** The variable type a field demands, or `null` when the field is not bindable at all. */
export function bindFieldType(field: string): 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN' | null {
  if (field in PAINT_FIELDS) return 'COLOR'
  return SCALAR_FIELDS[field] ?? null
}

export const BINDABLE_FIELDS: readonly string[] = [
  ...Object.keys(PAINT_FIELDS),
  ...Object.keys(FIELD_GROUPS),
  ...Object.keys(SCALAR_FIELDS),
]

interface BindResult {
  node: string
  name: string
  field: string
  variable: string | null
  ok: boolean
  /** Where the binding actually landed — an agent needs to know it hit the main component. */
  target?: 'node' | 'main component' | 'instance override'
  detail?: string
  error?: string
}

/** A bound STRING rewrites the text, and Figma refuses to touch glyphs whose font is not loaded. */
async function loadTextFonts(text: TextNode): Promise<void> {
  const fonts =
    text.characters.length > 0
      ? text.getRangeAllFontNames(0, text.characters.length)
      : text.fontName === figma.mixed
        ? []
        : [text.fontName]
  await Promise.all(fonts.map((font) => figma.loadFontAsync(font)))
}

async function bindPaints(
  node: SceneNode,
  prop: 'fills' | 'strokes',
  variable: Variable | null,
  paintIndex: number | undefined,
  dryRun: boolean
): Promise<string> {
  const styleId = (node as unknown as Record<string, unknown>)[prop === 'fills' ? 'fillStyleId' : 'strokeStyleId']
  // Binding a variable on top of a paint style silently breaks the style link. The linter skips
  // these for the same reason — refusing is more useful than quietly unlinking someone's style.
  if (typeof styleId === 'string' && styleId !== '') {
    throw new Error(`${prop} come from a paint style — unlink it first, or the binding would break the style`)
  }
  const paints = (node as unknown as Record<string, unknown>)[prop]
  if (!Array.isArray(paints)) throw new Error(`${prop} are unreadable on this node`)

  const next = (paints as Paint[]).slice()
  const touched: number[] = []
  for (let i = 0; i < next.length; i++) {
    if (paintIndex !== undefined && i !== paintIndex) continue
    if (next[i].type !== 'SOLID') continue
    next[i] = figma.variables.setBoundVariableForPaint(next[i] as SolidPaint, 'color', variable)
    touched.push(i)
  }
  if (touched.length === 0) {
    throw new Error(paintIndex === undefined ? `no solid paint in ${prop}` : `${prop}[${paintIndex}] is not a solid paint`)
  }
  // Figma hands out paint arrays readonly — the clone above is the only way to write one back.
  if (!dryRun) (node as unknown as Record<string, unknown>)[prop] = next
  return touched.length === next.length ? prop : `${prop}[${touched.join(',')}]`
}

/* --------------------------------------------------------------------- ops */

export const WRITE_OPS: readonly OpDef[] = [
  {
    name: 'variables.set',
    summary: 'Set variable values or aliases, in batch — the one op a recolor actually needs.',
    mutates: true,
    params: {
      updates: {
        type: 'json',
        required: true,
        description:
          'Array of { variable, mode?, value }. `variable` is an id or a name ("Colors/orange/500"). ' +
          '`mode` is a mode name, a mode id, or "*" for every mode; omitted means the collection default. ' +
          '`value` is "#RRGGBB" / "#RRGGBBAA" / "#RRGGBB 40%" / a number / a boolean / { "alias": … }. ' +
          'An alias takes a local name or id, or a *library* variable key (40 hex chars) — that is how ' +
          'one library inherits another\'s tokens.',
      },
      dryRun: {
        type: 'boolean',
        default: false,
        description: 'Report what would change without writing anything.',
      },
    },
    async run(params) {
      const updates = asArray(params.updates, 'updates')
      const dryRun = params.dryRun === true
      if (!dryRun) figma.commitUndo()

      const results: UpdateResult[] = []
      for (const [index, raw] of updates.entries()) {
        let label = `#${index}`
        try {
          const entry = record(raw, `updates[${index}]`)
          label = String(entry.variable ?? label)
          const variable = await resolveVariable(entry.variable)
          const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId)
          if (!collection) throw new Error(`"${variable.name}" has no readable collection`)
          if (variable.remote) throw new Error(`"${variable.name}" is a library variable — it can only change in its own file`)

          const value = await coerceVariableValue(variable, entry.value)
          for (const mode of resolveModes(collection, entry.mode)) {
            const before = await describeValue(variable.valuesByMode[mode.modeId])
            if (!dryRun) variable.setValueForMode(mode.modeId, value)
            const after = await describeValue(value)
            results.push({
              variable: variable.id,
              name: `${collection.name}/${variable.name}`,
              mode: mode.name,
              before,
              after,
              ok: true,
              changed: before !== after,
            })
          }
        } catch (err) {
          results.push({
            variable: label,
            name: label,
            mode: '—',
            before: '—',
            after: '—',
            ok: false,
            error: String((err as Error)?.message || err),
          })
        }
      }

      const failed = results.filter((entry) => !entry.ok)
      const changed = results.filter((entry) => entry.ok && entry.changed)
      if (!dryRun && changed.length > 0) {
        figma.notify(`Agent: ${changed.length} variable value${changed.length === 1 ? '' : 's'} updated`)
      }
      return {
        dryRun,
        total: results.length,
        changed: changed.length,
        unchanged: results.filter((entry) => entry.ok && !entry.changed).length,
        failed: failed.length,
        results,
      }
    },
  },

  {
    name: 'variables.create',
    summary: 'Create variables in a collection — the rungs a new palette adds that the old one lacked.',
    mutates: true,
    params: {
      collection: {
        type: 'string',
        required: true,
        description: 'Target collection name or id. Created when missing and `createCollection` is true.',
      },
      variables: {
        type: 'json',
        required: true,
        description:
          'Array of { name, type?, values?, scopes?, description? }. `type` defaults to COLOR. ' +
          '`values` maps mode name (or id, or "*") to a value in the same forms `variables.set` takes.',
      },
      createCollection: {
        type: 'boolean',
        default: false,
        description: 'Create the collection when no local one matches.',
      },
      updateExisting: {
        type: 'boolean',
        default: false,
        description: 'When a variable of that name already exists, write the given values into it instead of skipping.',
      },
      dryRun: { type: 'boolean', default: false, description: 'Report without writing.' },
    },
    async run(params) {
      const requested = asArray(params.variables, 'variables')
      const dryRun = params.dryRun === true
      if (!dryRun) figma.commitUndo()

      let collection: VariableCollection | null = null
      try {
        collection = await resolveCollection(params.collection)
      } catch (err) {
        if (params.createCollection !== true || dryRun) {
          if (params.createCollection !== true) throw err
        } else {
          collection = figma.variables.createVariableCollection(String(params.collection))
        }
      }
      if (!collection) throw new Error(`collection "${params.collection}" does not exist yet — dry run cannot create it`)

      const existing = (await figma.variables.getLocalVariablesAsync()).filter(
        (variable) => variable.variableCollectionId === collection!.id
      )
      const byName = new Map(existing.map((variable) => [variable.name, variable]))

      const results: Array<Record<string, unknown>> = []
      for (const [index, raw] of requested.entries()) {
        try {
          const entry = record(raw, `variables[${index}]`)
          const name = String(entry.name ?? '').trim()
          if (!name) throw new Error(`variables[${index}] has no name`)

          const type = String(entry.type ?? 'COLOR').toUpperCase() as VariableResolvedDataType
          if (!RESOLVED_TYPES.includes(type as (typeof RESOLVED_TYPES)[number])) {
            throw new Error(`"${name}" has unknown type ${type} — one of ${RESOLVED_TYPES.join(', ')}`)
          }

          const already = byName.get(name)
          if (already && params.updateExisting !== true) {
            results.push({ name, ok: true, created: false, skipped: 'already exists', variable: already.id })
            continue
          }

          const variable =
            already ??
            (dryRun ? null : figma.variables.createVariable(name, collection, type))
          if (!dryRun && !variable) throw new Error(`could not create "${name}"`)

          const values = entry.values === undefined ? {} : record(entry.values, `variables[${index}].values`)
          const written: Record<string, string> = {}
          for (const [modeRef, rawValue] of Object.entries(values)) {
            for (const mode of resolveModes(collection, modeRef)) {
              if (variable) {
                const value = await coerceVariableValue(variable, rawValue)
                if (!dryRun) variable.setValueForMode(mode.modeId, value)
                written[mode.name] = await describeValue(value)
              } else {
                written[mode.name] = String(rawValue)
              }
            }
          }
          if (variable && !dryRun) {
            if (typeof entry.description === 'string') variable.description = entry.description
            if (Array.isArray(entry.scopes)) variable.scopes = entry.scopes as VariableScope[]
          }
          results.push({ name, ok: true, created: !already, variable: variable?.id ?? null, values: written })
        } catch (err) {
          results.push({ name: String((raw as any)?.name ?? index), ok: false, error: String((err as Error)?.message || err) })
        }
      }

      return {
        dryRun,
        collection: { id: collection.id, name: collection.name, modes: collection.modes },
        created: results.filter((entry) => entry.ok && entry.created).length,
        updated: results.filter((entry) => entry.ok && entry.created === false && !entry.skipped).length,
        failed: results.filter((entry) => !entry.ok).length,
        results,
      }
    },
  },

  {
    name: 'board.render',
    summary: 'Draw a documentation board — headings, callouts, swatch grids, before/after rows — on a page.',
    mutates: true,
    params: {
      spec: {
        type: 'json',
        required: true,
        description:
          'Board spec: { page?, name, theme?, x?, y?, width?, blocks: [...] }. Block types: heading, text, ' +
          'callout, swatches, diff, table, group, spacer. A swatch takes either `color` ("#RRGGBB") or ' +
          '`variable` (bound live, so the board repaints with the file). A group may carry ' +
          '`modes: { "One": "Dark" }` to render its bound swatches in that mode.',
      },
      replace: {
        type: 'boolean',
        default: true,
        description: 'Delete an existing top-level frame of the same name on that page first, so re-rendering is idempotent.',
      },
      focus: {
        type: 'boolean',
        default: true,
        description: 'Move the designer to the board once it is drawn.',
      },
    },
    async run(params) {
      figma.commitUndo()
      return renderBoard(record(params.spec, 'spec'), {
        replace: params.replace !== false,
        focus: params.focus !== false,
      })
    },
  },
  {
    name: 'node.bind',
    summary: 'Bind layer properties to variables — the op that turns a lint finding into a fix.',
    mutates: true,
    params: {
      bindings: {
        type: 'json',
        required: true,
        description:
          'Array of { node, field, variable, paintIndex? }. `node` is a layer id, as returned by ' +
          '`lint.colors` or `node.find`. `field` is "fill" / "stroke", a group name ("cornerRadius", ' +
          '"padding"), or a scalar field (width, height, topLeftRadius, itemSpacing, paddingLeft, ' +
          'strokeWeight, opacity, visible, characters, …). `variable` is an id, a name ' +
          '("Colors/orange/500") or a library key from `library.variables`; null unbinds. ' +
          '`paintIndex` narrows a fill/stroke binding to one paint — omitted binds every solid paint.',
      },
      dryRun: {
        type: 'boolean',
        default: false,
        description: 'Report what would change without writing anything.',
      },
    },
    async run(params) {
      const bindings = asArray(params.bindings, 'bindings')
      const dryRun = params.dryRun === true
      if (!dryRun) figma.commitUndo()

      const results: BindResult[] = []
      for (const [index, raw] of bindings.entries()) {
        let nodeId = `#${index}`
        let nodeName = nodeId
        const field = (() => {
          try {
            return String(record(raw, `bindings[${index}]`).field ?? '')
          } catch {
            return ''
          }
        })()

        try {
          const entry = record(raw, `bindings[${index}]`)
          nodeId = String(entry.node ?? '')
          if (!nodeId) throw new Error('missing "node"')
          // Until the lookup succeeds the id is the only name there is — reporting "#4" for a
          // node that was never found tells the agent nothing about which row to fix.
          nodeName = nodeId
          if (!field) throw new Error('missing "field"')

          const found = await figma.getNodeByIdAsync(nodeId)
          if (!found || found.type === 'PAGE' || found.type === 'DOCUMENT') {
            throw new Error(`no layer with id ${nodeId}`)
          }
          const node = found as SceneNode
          nodeName = node.name

          const variable =
            entry.variable === null || entry.variable === undefined ? null : await resolveVariableRef(entry.variable)
          const paintIndex = entry.paintIndex === undefined ? undefined : Number(entry.paintIndex)
          if (paintIndex !== undefined && !Number.isInteger(paintIndex)) {
            throw new Error('"paintIndex" must be a whole number')
          }

          // A fix on an instance sublayer belongs on the main component — one edit reaches every
          // instance, and the binding is not reverted by the next scan. Inside a *library*
          // instance there is no editable source here, so a paint lands as a per-instance
          // override and everything structural is refused rather than silently skipped.
          const target = await resolveEditableTarget(node)
          const where: BindResult['target'] =
            target.kind === 'library' ? 'instance override' : target.onMainComponent ? 'main component' : 'node'

          for (const one of expandBindField(field)) {
            try {
              const wants = bindFieldType(one)
              if (!wants) throw new Error(`"${one}" is not bindable — try: ${BINDABLE_FIELDS.join(', ')}`)
              if (variable && variable.resolvedType !== wants) {
                throw new Error(`"${one}" takes a ${wants} variable, but "${variable.name}" is ${variable.resolvedType}`)
              }

              let detail: string
              if (one in PAINT_FIELDS) {
                const applyTo = target.kind === 'library' ? node : target.node
                detail = await bindPaints(applyTo, PAINT_FIELDS[one], variable, paintIndex, dryRun)
              } else {
                if (target.kind === 'library') {
                  throw new Error(`inside a library instance — "${one}" cannot be overridden on a sublayer`)
                }
                const applyTo = target.node
                if (!(one in applyTo)) throw new Error(`a ${applyTo.type} has no "${one}"`)
                if (one === 'characters' && applyTo.type === 'TEXT') await loadTextFonts(applyTo)
                if (!dryRun) {
                  ;(applyTo as unknown as { setBoundVariable: (f: string, v: Variable | null) => void }).setBoundVariable(
                    one,
                    variable
                  )
                }
                detail = one
              }

              results.push({
                node: nodeId,
                name: nodeName,
                field: one,
                variable: variable ? variable.name : null,
                ok: true,
                target: where,
                detail,
              })
            } catch (err) {
              results.push({
                node: nodeId,
                name: nodeName,
                field: one,
                variable: null,
                ok: false,
                error: String((err as Error)?.message || err),
              })
            }
          }
        } catch (err) {
          results.push({
            node: nodeId,
            name: nodeName,
            field: field || '—',
            variable: null,
            ok: false,
            error: String((err as Error)?.message || err),
          })
        }
      }

      const bound = results.filter((entry) => entry.ok)
      if (!dryRun && bound.length > 0) {
        figma.notify(`Agent: ${bound.length} binding${bound.length === 1 ? '' : 's'} applied`)
      }
      return {
        dryRun,
        total: results.length,
        bound: bound.length,
        failed: results.length - bound.length,
        results,
      }
    },
  },
]
