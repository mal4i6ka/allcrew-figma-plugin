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
import { loadAllPagesAsync, walkSceneNodes } from '../utils/tree.ts'
import { REMOVE_OPS } from './remove-ops.ts'

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

/** EASING and TIMING joined the four in 2026: a curve and a duration, held as tokens. */
const RESOLVED_TYPES = ['COLOR', 'FLOAT', 'BOOLEAN', 'STRING', 'EASING', 'TIMING'] as const

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
  /** What the field held before this row ran. Without it the report is a receipt — it says a
   * write happened and not what it displaced, so it cannot be reviewed or reversed from itself.
   * Written for a dry run too: that is the whole point of previewing one. */
  before?: string
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

/** A paint as it stands right now, for the `before` half of a bind report: the token it carries,
 * or the raw colour it carries instead. `boundVariables.color` on the paint — not the node — is
 * the binding an instance sublayer inherits, and is the one this write is about to replace. */
async function describePriorPaint(paint: SolidPaint): Promise<string> {
  const aliasId = (paint as { boundVariables?: { color?: { id?: string } } }).boundVariables?.color?.id
  if (aliasId) {
    // Async lookup, not the sync one: this plugin runs under `documentAccess: "dynamic-page"`,
    // where `getVariableById` throws. It only ever reaches here for an already-bound paint, so
    // the sync call survived every unbound test case and failed on the first real rebind.
    const known = await figma.variables.getVariableByIdAsync(aliasId)
    return known ? known.name : aliasId
  }
  const channel = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0')
  const hex = `#${channel(paint.color.r)}${channel(paint.color.g)}${channel(paint.color.b)}`
  return paint.opacity !== undefined && paint.opacity < 1 ? `${hex} ${Math.round(paint.opacity * 100)}%` : hex
}

async function bindPaints(
  node: SceneNode,
  prop: 'fills' | 'strokes',
  variable: Variable | null,
  paintIndex: number | undefined,
  dryRun: boolean
): Promise<{ detail: string; before: string }> {
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
  const was: string[] = []
  for (let i = 0; i < next.length; i++) {
    if (paintIndex !== undefined && i !== paintIndex) continue
    if (next[i].type !== 'SOLID') continue
    // Read before the clone is overwritten: an already-bound paint names its token, a raw one
    // names the colour it is about to stop being.
    was.push(`${prop}[${i}]=${await describePriorPaint(next[i] as SolidPaint)}`)
    next[i] = figma.variables.setBoundVariableForPaint(next[i] as SolidPaint, 'color', variable)
    touched.push(i)
  }
  if (touched.length === 0) {
    throw new Error(paintIndex === undefined ? `no solid paint in ${prop}` : `${prop}[${paintIndex}] is not a solid paint`)
  }
  // Figma hands out paint arrays readonly — the clone above is the only way to write one back.
  if (!dryRun) (node as unknown as Record<string, unknown>)[prop] = next
  return {
    detail: touched.length === next.length ? prop : `${prop}[${touched.join(',')}]`,
    before: was.join(' '),
  }
}

/* -------------------------------------------------------------- component docs */

/** What Figma's rich-text fields actually render, taken from the Plugin API's own table rather
 * than from what a Markdown parser would accept. Anything outside this list survives as literal
 * characters, so a description written in full CommonMark quietly ships its own syntax as text.
 *
 * The demotion of `#` is the trap worth knowing: a description authored as a document with one
 * title comes back a level flatter than it went in, and `##` is therefore the only heading
 * there is. `figma.util.normalizeMarkdown` is the authority — Figma applies it on assignment
 * anyway, and this op runs it first so the report can show what will render before it does. */
export const MARKDOWN_SUPPORTED: readonly string[] = [
  'paragraphs (blank line)',
  'unordered list (- or *)',
  'ordered list (1.)',
  'heading (## only — # is demoted to ##)',
  'bold (** or __)',
  'italic (* or _)',
  'strikethrough (~~)',
  'link ([text](url))',
  'inline code (`code`)',
  'code block (``` — no formatting inside, leading spaces stripped)',
]

export const MARKDOWN_UNSUPPORTED: readonly string[] = ['tables', 'images', 'first-level headings']

/**
 * Traps that survive `normalizeMarkdown` — it canonicalizes (`_i_` becomes `*i*`), it does not
 * strip what Figma cannot render, so unsupported syntax reaches the panel as literal characters.
 *
 * The code-block one is not cosmetic and was found by running the normalizer, not by reading the
 * docs: text placed after a closing fence is glued onto the fence line and a stray fence is
 * appended, so the prose after a code sample is swallowed by the sample. Warned about rather
 * than rewritten — this op writes what the caller wrote.
 */
export function markdownWarnings(md: string): string[] {
  const warnings: string[] = []
  const fences = (md.match(/^\s*```/gm) ?? []).length
  if (fences >= 2) {
    const closed = md.slice(md.lastIndexOf('```') + 3)
    if (closed.trim() !== '') {
      warnings.push('text after a code block is absorbed into it — put code blocks last')
    }
  }
  if (/^\s*\|.*\|\s*$/m.test(md)) warnings.push('tables are not supported — this renders as literal characters')
  if (/!\[[^\]]*\]\(/.test(md)) warnings.push('images are not supported — this renders as literal characters')
  if (/^#[^#]/m.test(md)) warnings.push('a first-level heading is demoted to ##')
  return warnings
}

/** One row of `component.describe`, checked before anything is touched. */
export interface DescribePlan {
  /** Plain text to write, `''` to clear. Mutually exclusive with `markdown`. */
  description?: string
  /** Rich text to write, `''` to clear. */
  markdown?: string
  /** Documentation links to write; `[]` clears. Figma keeps ONE — the report says what stuck. */
  links?: string[]
  /** Write a variant's own (UI-invisible) description on purpose. */
  variant: boolean
}

/**
 * Turns one request row into a plan, or explains why it is not one.
 *
 * `description` and `markdown` are refused together rather than merged: they are two views of a
 * single field, so a row carrying both is a row whose author expects two outcomes and will get
 * one of them silently.
 */
export function planDescribe(entry: Record<string, unknown>, where: string): DescribePlan {
  const text = (value: unknown, key: string): string => {
    if (value === null) return ''
    if (typeof value !== 'string') throw new Error(`${where}.${key} must be a string (null or "" clears it)`)
    return value
  }

  const hasDescription = entry.description !== undefined
  const hasMarkdown = entry.markdown !== undefined
  if (hasDescription && hasMarkdown) {
    throw new Error(`${where}: "description" and "markdown" write the same field — send one of them`)
  }

  let links: string[] | undefined
  if (entry.documentationLinks !== undefined) {
    const raw = entry.documentationLinks
    if (raw === null) links = []
    else if (typeof raw === 'string') links = raw === '' ? [] : [raw]
    else if (Array.isArray(raw)) {
      links = raw.map((uri, index) => {
        if (typeof uri !== 'string' || uri === '') {
          throw new Error(`${where}.documentationLinks[${index}] must be a non-empty URL string`)
        }
        return uri
      })
    } else throw new Error(`${where}.documentationLinks must be a URL, an array of URLs, or null`)
    /* Checked BEFORE anything is written, because the API throws on a longer list rather than
     * keeping the first — observed against a live file. Left to the write, the throw lands
     * AFTER the description has already been assigned, and the row reports a failure over a
     * document that did change. A refusal here is the only way the batch stays all-or-nothing
     * per row. */
    if (links.length > 1) {
      throw new Error(
        `${where}.documentationLinks: Figma stores at most one link, and refuses a longer list — ` +
          `got ${links.length}`
      )
    }
  }

  if (!hasDescription && !hasMarkdown && links === undefined) {
    throw new Error(`${where}: nothing to write — send "description", "markdown" or "documentationLinks"`)
  }

  return {
    ...(hasDescription ? { description: text(entry.description, 'description') } : {}),
    ...(hasMarkdown ? { markdown: text(entry.markdown, 'markdown') } : {}),
    ...(links === undefined ? {} : { links }),
    variant: entry.variant === true,
  }
}

/* --------------------------------------------------------------------- ops */

/**
 * Does a sublayer's binding belong to the instance, or is it the main's showing through?
 * `mainAliasId` is what the corresponding node inside the main component binds for the same
 * field. Equal means inherited — writing there would mint an override, so the caller must not.
 * Absent means the main binds nothing while the sublayer does, which is an override too.
 */
export function isOwnOverride(mirrorAliasId: string, mainAliasId: string | undefined): boolean {
  if (mirrorAliasId === '') return false
  return mainAliasId !== mirrorAliasId
}

/** One binding a sublayer inside an instance carries on a mapped source, queued for the
 * main-comparison pass. `prop`/`index` locate a paint-level colour alias; otherwise `field` is a
 * key of `boundVariables`. */
export interface OverrideJob {
  node: SceneNode
  at: number
  aliasId: string
  field: string
  prop?: 'fills' | 'strokes'
  index?: number
}

/** The two lookups `resolveMainSide` needs, injectable so the comparison can be exercised
 * without a document — and so the op can cache both across the thousands of jobs one page
 * produces. */
export interface MainSideLookups {
  byId: (id: string) => Promise<BaseNode | null>
  mainOf: (instance: InstanceNode) => Promise<ComponentNode | null>
}

/**
 * The node a sublayer's binding is compared against: the one standing at the same place inside
 * the enclosing instance's main.
 *
 * `I<instance>;<path…>` names a sublayer seen through an instance, and the segments after the
 * first are ids in the file the MAIN lives in. For a local component that is this file, and the
 * mirrored id (`<path…>`, re-prefixed with `I` when the sublayer sits in a nested instance)
 * resolves directly. For a library component it is the source file: `I1836:22376;4518:286745`
 * on this page mirrors a node that is 12164:75019 in the local copy of the main, and looking up
 * 4518:286745 here finds nothing — which an id-only lookup takes for "the main binds nothing"
 * and so calls every such binding an own override. So the main is reached through the instance
 * instead (`getMainComponentAsync` hands back the local copy for a remote component) and the
 * mirrored node is found by position: an instance cannot add, drop or reorder children, so the
 * child-index path from the instance down to the sublayer is the same path inside the main.
 * The same node type at the end of the path is the sanity check; a nested instance swapped for
 * another component fails it and falls through to the id lookup.
 *
 * "Enclosing instance" is the OUTERMOST one — the node whose id has no `;` — not the nearest:
 * what instance A inherits for a layer inside its nested B is whatever A's main shows there,
 * A's own override on B included. Comparing against B's main would miss that and mint an
 * override on A.
 */
export async function resolveMainSide(
  node: SceneNode,
  lookups: MainSideLookups
): Promise<Record<string, unknown> | null> {
  const segments = node.id.split(';')
  if (segments.length < 2) return null
  const outerId = segments[0].startsWith('I') ? segments[0].slice(1) : segments[0]

  const path: number[] = []
  let outer: InstanceNode | null = null
  let cursor: BaseNode = node
  while (cursor.parent) {
    const parent: BaseNode = cursor.parent
    const siblings = (parent as unknown as { children?: readonly BaseNode[] }).children
    const index = Array.isArray(siblings) ? siblings.findIndex((one) => one.id === cursor.id) : -1
    if (index < 0) break
    path.unshift(index)
    if (parent.type === 'INSTANCE' && parent.id === outerId) {
      outer = parent as InstanceNode
      break
    }
    cursor = parent
  }

  if (outer) {
    let found: BaseNode | null = null
    try {
      found = await lookups.mainOf(outer)
    } catch {
      found = null
    }
    for (const index of path) {
      const children: readonly BaseNode[] | undefined = (found as unknown as { children?: readonly BaseNode[] } | null)
        ?.children
      found = Array.isArray(children) && index < children.length ? children[index] : null
      if (!found) break
    }
    if (found && found.type === node.type) return found as unknown as Record<string, unknown>
  }

  const mirrored = segments.length > 2 ? `I${segments.slice(1).join(';')}` : segments[1]
  try {
    return ((await lookups.byId(mirrored)) as unknown as Record<string, unknown> | null) ?? null
  } catch {
    return null
  }
}

/** What the main-side node binds for the field a job is about — the other half of
 * `isOwnOverride`. Absent when there is no main to read, or the main binds nothing there. */
export function mainAliasFor(main: Record<string, unknown> | null, job: OverrideJob): string | undefined {
  if (!main) return undefined
  if (job.prop !== undefined && job.index !== undefined) {
    const paints = main[job.prop]
    const paint = Array.isArray(paints) ? (paints as Paint[])[job.index] : undefined
    return (paint as { boundVariables?: { color?: { id?: string } } } | undefined)?.boundVariables?.color?.id
  }
  const bound = main.boundVariables as Record<string, { id?: string }> | undefined
  return bound?.[job.field]?.id
}

export const WRITE_OPS: readonly OpDef[] = [
  {
    name: 'variables.set',
    summary: 'Set variable values or aliases, in batch — the one op a recolor actually needs.',
    agent:
      "Given a 40-character library key it aliases onto that library variable — how one file inherits another's tokens.",
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
    agent:
      'modes: ["Light","Dark"] makes the collection offer those modes first — a fresh collection is single-mode. Values may then key by mode name.',
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
      modes: {
        type: 'string[]',
        description:
          'Mode names the collection must offer before values are written, e.g. ["Light", "Dark"]. ' +
          'A missing mode is added (a freshly created collection has one default mode, which is ' +
          'renamed to the first name given rather than left as "Mode 1"). Existing modes are never ' +
          'removed or reordered. Mode count is plan-limited — the runtime error names the limit.',
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

      if (Array.isArray(params.modes)) {
        const wanted = (params.modes as unknown[]).filter(
          (entry): entry is string => typeof entry === 'string' && entry !== ''
        )
        const have = () => collection!.modes.map((mode) => mode.name.toLowerCase())
        for (const name of wanted) {
          if (have().includes(name.toLowerCase())) continue
          if (dryRun) continue
          /* A fresh collection arrives with a single default mode nobody asked for. Renaming it
           * to the first missing name keeps the collection at exactly the modes the caller
           * listed, instead of a "Mode 1" fossil next to them. */
          const fossil =
            collection.modes.length === 1 && !wanted.some((w) => w.toLowerCase() === collection!.modes[0].name.toLowerCase())
              ? collection.modes[0]
              : null
          if (fossil) collection.renameMode(fossil.modeId, name)
          else collection.addMode(name)
        }
      }

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
    agent:
      'replace: true redraws the same board in place — the idempotent way to keep documentation boards current.',
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
    agent:
      "variable takes an id, a local name or a library key; null unbinds — a row WITHOUT the key is an error, never a silent unbind. The report's before names what each write displaced.",
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

          // Absent and null are NOT the same thing here. `null` is a request to unbind and is
          // honoured; a row with no `variable` key at all is a caller that meant to name one —
          // a misspelled key, a field left off a generated row — and answering "unbound, ok"
          // makes a batch that wrote nothing report `bound: 150, failed: 0`. That is the one
          // outcome an agent cannot detect from the response, so it has to fail loudly instead.
          if (!Object.prototype.hasOwnProperty.call(entry, 'variable')) {
            throw new Error('missing "variable" — pass null explicitly to unbind')
          }
          const variable = entry.variable === null ? null : await resolveVariableRef(entry.variable)
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
              let before: string
              if (one in PAINT_FIELDS) {
                const applyTo = target.kind === 'library' ? node : target.node
                const done = await bindPaints(applyTo, PAINT_FIELDS[one], variable, paintIndex, dryRun)
                detail = done.detail
                before = done.before
              } else {
                if (target.kind === 'library') {
                  throw new Error(`inside a library instance — "${one}" cannot be overridden on a sublayer`)
                }
                const applyTo = target.node
                if (!(one in applyTo)) throw new Error(`a ${applyTo.type} has no "${one}"`)
                const priorAlias = (applyTo as unknown as { boundVariables?: Record<string, { id?: string }> })
                  .boundVariables?.[one]?.id
                before = priorAlias
                  ? ((await figma.variables.getVariableByIdAsync(priorAlias))?.name ?? priorAlias)
                  : 'unbound'
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
                before,
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
  {
    name: 'style.bind',
    summary: 'Bind a paint style — solid paint, or one gradient stop — to a variable, and verify it stuck.',
    agent:
      'stop is the position in percent — the same number a pNN token name carries. Gradient-stop binding is undocumented API, so the op re-reads the style and reports verified.',
    mutates: true,
    params: {
      bindings: {
        type: 'json',
        required: true,
        description:
          'Array of { style, paint?, stop?, variable }. `style` is a style id, key or name from ' +
          '`styles.list`. `paint` is the index in the style (default 0). `stop` is a gradient stop ' +
          'POSITION IN PERCENT — the same number a `pNN` token name carries — omitted for a solid ' +
          'paint. `variable` is an id, a name ("Colors/orange/500") or a library key; null unbinds.',
      },
      dryRun: { type: 'boolean', default: false, description: 'Report what would change without writing anything.' },
    },
    async run(params) {
      const rows = params.bindings
      if (!Array.isArray(rows)) throw new Error('"bindings" must be an array')
      const dryRun = params.dryRun === true
      if (!dryRun) figma.commitUndo()

      const local = await figma.getLocalPaintStylesAsync()
      const findStyle = async (ref: unknown): Promise<PaintStyle> => {
        if (typeof ref !== 'string' || ref === '') throw new Error('missing "style"')
        const byId = local.find((style) => style.id === ref || style.key === ref)
        if (byId) return byId
        const named = local.filter((style) => style.name.toLowerCase() === ref.toLowerCase())
        if (named.length === 1) return named[0]
        if (named.length > 1) throw new Error(`"${ref}" names ${named.length} styles — pass an id instead`)
        throw new Error(`no local paint style "${ref}"`)
      }

      const stopOf = (paint: GradientPaint, percent: number): number => {
        const hits = paint.gradientStops
          .map((stop, index) => ({ index, at: Math.round(stop.position * 100) }))
          .filter((candidate) => candidate.at === percent)
        if (hits.length === 0) {
          throw new Error(
            `no stop at ${percent}% — this paint has ${paint.gradientStops
              .map((stop) => `p${Math.round(stop.position * 100)}`)
              .join(', ')}`
          )
        }
        if (hits.length > 1) throw new Error(`${hits.length} stops sit at ${percent}% — cannot say which`)
        return hits[0].index
      }

      const nameOf = async (id: string | undefined) =>
        id ? ((await figma.variables.getVariableByIdAsync(id))?.name ?? id) : null

      const results = []
      for (const [index, raw] of rows.entries()) {
        const label = `bindings[${index}]`
        try {
          const entry = record(raw, label)
          if (!Object.prototype.hasOwnProperty.call(entry, 'variable')) {
            throw new Error('missing "variable" — pass null explicitly to unbind')
          }
          const style = await findStyle(entry.style)
          const paintIndex = entry.paint === undefined ? 0 : Number(entry.paint)
          if (!Number.isInteger(paintIndex)) throw new Error('"paint" must be a whole number')
          const paints = style.paints.slice()
          const target = paints[paintIndex]
          if (!target) throw new Error(`this style has ${paints.length} paint(s), no index ${paintIndex}`)
          const variable = entry.variable === null ? null : await resolveVariableRef(entry.variable)
          if (variable && variable.resolvedType !== 'COLOR') {
            throw new Error(`"${variable.name}" is ${variable.resolvedType}, not COLOR`)
          }
          const alias = variable ? { type: 'VARIABLE_ALIAS' as const, id: variable.id } : undefined

          let before: string | null
          if (target.type === 'SOLID') {
            if (entry.stop !== undefined) throw new Error(`paint ${paintIndex} is solid — drop "stop"`)
            before = await nameOf(
              (target as unknown as { boundVariables?: { color?: { id?: string } } }).boundVariables?.color?.id
            )
            paints[paintIndex] = figma.variables.setBoundVariableForPaint(target, 'color', variable)
          } else {
            const gradient = target as GradientPaint
            if (!Array.isArray(gradient.gradientStops)) throw new Error(`paint ${paintIndex} has no gradient stops`)
            if (entry.stop === undefined) throw new Error(`paint ${paintIndex} is a gradient — pass "stop" as a percent`)
            const at = stopOf(gradient, Number(entry.stop))
            before = await nameOf(gradient.gradientStops[at].boundVariables?.color?.id)
            /* There is no `setBoundVariableForPaint` for a gradient stop — the API offers helpers
             * for solid paints, effects and layout grids only, and `ColorStop.boundVariables` is
             * declared readonly. Writing a fresh stop object with the alias in place is the only
             * route, and it is undocumented: it may simply be dropped. Which is why this op reads
             * the style back below instead of trusting that the assignment took. */
            const stops = gradient.gradientStops.map((stop, at2) =>
              at2 !== at
                ? stop
                : { position: stop.position, color: stop.color, ...(alias ? { boundVariables: { color: alias } } : {}) }
            )
            paints[paintIndex] = { ...gradient, gradientStops: stops } as GradientPaint
          }

          if (dryRun) {
            results.push({
              style: style.name,
              paint: paintIndex,
              ...(entry.stop === undefined ? {} : { stop: Number(entry.stop) }),
              before,
              variable: variable ? variable.name : null,
              ok: true,
              verified: null,
            })
            continue
          }

          style.paints = paints

          /* Read it back. An undocumented write that is silently ignored would otherwise report
           * exactly like one that worked — the failure this whole op is shaped around. */
          const written = (await figma.getStyleByIdAsync(style.id)) as PaintStyle | null
          const check = written?.paints?.[paintIndex]
          const landed =
            check?.type === 'SOLID'
              ? ((check as unknown as { boundVariables?: { color?: { id?: string } } }).boundVariables?.color?.id ??
                null)
              : ((check as GradientPaint | undefined)?.gradientStops?.[stopOf(check as GradientPaint, Number(entry.stop))]
                  ?.boundVariables?.color?.id ?? null)
          const verified = variable ? landed === variable.id : landed === null

          results.push({
            style: style.name,
            paint: paintIndex,
            ...(entry.stop === undefined ? {} : { stop: Number(entry.stop) }),
            before,
            variable: variable ? variable.name : null,
            ok: verified,
            verified,
            ...(verified
              ? {}
              : {
                  error:
                    'the runtime accepted the write but the binding did not persist — ' +
                    'gradient-stop binding is not part of the documented Plugin API',
                }),
          })
        } catch (err) {
          results.push({ style: String((raw as { style?: unknown })?.style ?? label), ok: false, verified: false, error: String((err as Error)?.message || err) })
        }
      }

      const bound = results.filter((row) => row.ok)
      return { dryRun, total: results.length, bound: bound.length, failed: results.length - bound.length, results }
    },
  },
  {
    name: 'node.style',
    summary: 'Apply a style to layers — or detach them — and verify it took. Re-attaches what drifted.',
    agent:
      'Applying a style replaces what the layer renders — the report names the displaced paints. null detaches, keeping pixels.',
    mutates: true,
    params: {
      assignments: {
        type: 'json',
        required: true,
        description:
          'Array of { node, field, style }. `field` is "fill", "stroke", "text", "effect" or "grid". ' +
          '`style` is a style id, key or name from `styles.list`; null detaches, leaving the layer ' +
          'with whatever it currently renders.',
      },
      dryRun: { type: 'boolean', default: false, description: 'Report what would change without writing anything.' },
    },
    async run(params) {
      const rows = params.assignments
      if (!Array.isArray(rows)) throw new Error('"assignments" must be an array')
      const dryRun = params.dryRun === true
      if (!dryRun) figma.commitUndo()

      const FIELDS = {
        fill: { prop: 'fillStyleId', setter: 'setFillStyleIdAsync', kind: 'PAINT' },
        stroke: { prop: 'strokeStyleId', setter: 'setStrokeStyleIdAsync', kind: 'PAINT' },
        text: { prop: 'textStyleId', setter: 'setTextStyleIdAsync', kind: 'TEXT' },
        effect: { prop: 'effectStyleId', setter: 'setEffectStyleIdAsync', kind: 'EFFECT' },
        grid: { prop: 'gridStyleId', setter: 'setGridStyleIdAsync', kind: 'GRID' },
      } as const

      const localOf = async (kind: string) => {
        if (kind === 'PAINT') return figma.getLocalPaintStylesAsync()
        if (kind === 'TEXT') return figma.getLocalTextStylesAsync()
        if (kind === 'EFFECT') return figma.getLocalEffectStylesAsync()
        return figma.getLocalGridStylesAsync()
      }

      const nameOfStyle = async (id: unknown) => {
        if (id === figma.mixed) return 'mixed'
        if (typeof id !== 'string' || id === '') return null
        const style = await figma.getStyleByIdAsync(id)
        return style ? style.name : id
      }

      const results = []
      for (const [index, raw] of rows.entries()) {
        const label = `assignments[${index}]`
        let nodeId = label
        try {
          const entry = record(raw, label)
          nodeId = String(entry.node ?? '')
          if (!nodeId) throw new Error('missing "node"')
          const fieldName = String(entry.field ?? '')
          const field = (FIELDS as Record<string, { prop: string; setter: string; kind: string } | undefined>)[fieldName]
          if (!field) throw new Error(`"${fieldName}" is not a style field — try: ${Object.keys(FIELDS).join(', ')}`)
          if (!Object.prototype.hasOwnProperty.call(entry, 'style')) {
            throw new Error('missing "style" — pass null explicitly to detach')
          }

          const found = await figma.getNodeByIdAsync(nodeId)
          if (!found || found.type === 'PAGE' || found.type === 'DOCUMENT') {
            throw new Error(`no layer with id ${nodeId}`)
          }
          const node = found as SceneNode
          const holder = node as unknown as Record<string, unknown>
          if (!(field.prop in holder)) throw new Error(`a ${node.type} has no "${fieldName}" style`)

          let styleId = ''
          let styleName: string | null = null
          if (entry.style !== null) {
            const ref = entry.style
            if (typeof ref !== 'string' || ref === '') throw new Error('"style" must be a non-empty string, or null')
            const pool = await localOf(field.kind)
            const direct = pool.find((one) => one.id === ref || one.key === ref)
            const named = direct ? [direct] : pool.filter((one) => one.name.toLowerCase() === ref.toLowerCase())
            if (named.length === 0) throw new Error(`no local ${field.kind.toLowerCase()} style "${ref}"`)
            if (named.length > 1) throw new Error(`"${ref}" names ${named.length} styles — pass an id instead`)
            styleId = named[0].id
            styleName = named[0].name
          }

          const before = await nameOfStyle(holder[field.prop])

          /* Applying a style REPLACES what the layer renders. On a detached layer that is the
           * whole point — but it also discards the local paints, and on a layer someone hand-bound
           * stop by stop that is real work being thrown away. So the report says what is being
           * displaced, and a dry run says it before anything happens. */
          const displaced = Array.isArray(holder.fills)
            ? `${(holder.fills as unknown[]).length} local paint(s)`
            : undefined

          if (dryRun) {
            results.push({
              node: nodeId,
              name: node.name,
              field: fieldName,
              before: before ?? 'detached',
              style: styleName,
              ...(before === null && displaced ? { displaced } : {}),
              ok: true,
              verified: null,
            })
            continue
          }

          await (holder[field.setter] as (id: string) => Promise<void>).call(node, styleId)

          /* Read it back. `setFillStyleIdAsync` resolves without complaint on a node that cannot
           * take the style, and a silent no-op is the one outcome a caller cannot see. */
          const after = await nameOfStyle((node as unknown as Record<string, unknown>)[field.prop])
          const verified = styleName === null ? after === null : after === styleName
          results.push({
            node: nodeId,
            name: node.name,
            field: fieldName,
            before: before ?? 'detached',
            style: styleName,
            ...(before === null && displaced ? { displaced } : {}),
            ok: verified,
            verified,
            ...(verified ? {} : { error: `the write was accepted but the field now reads "${after}"` }),
          })
        } catch (err) {
          results.push({ node: nodeId, ok: false, verified: false, error: String((err as Error)?.message || err) })
        }
      }

      const done = results.filter((row) => row.ok)
      return { dryRun, total: results.length, applied: done.length, failed: results.length - done.length, results }
    },
  },
  {
    name: 'style.remove',
    summary: 'Delete styles nothing uses. Refuses while a consumer exists; reports publish status first.',
    agent:
      'Refuses while consumers exist. publishStatus in the report is the half this file cannot see: CURRENT means other files may consume it through the library.',
    mutates: true,
    params: {
      styles: {
        type: 'string[]',
        required: true,
        description: 'Styles to delete, each an id, a key or an exact name from `styles.list`.',
      },
      dryRun: {
        type: 'boolean',
        default: false,
        description:
          'Report what would be deleted, with consumer count and publish status, and touch nothing. ' +
          'Worth running first here more than anywhere else: this is the one op whose result no ' +
          'later call can undo.',
      },
      force: {
        type: 'boolean',
        default: false,
        description:
          'Delete even when the style still has consumers in THIS file. Off by default and rarely ' +
          'right: those layers keep the paints they render and quietly stop following anything.',
      },
    },
    async run(params) {
      const refs = (Array.isArray(params.styles) ? (params.styles as unknown[]) : []).filter(
        (entry): entry is string => typeof entry === 'string' && entry !== ''
      )
      if (refs.length === 0) throw new Error('"styles" must be a non-empty array of ids, keys or names')
      const dryRun = params.dryRun === true
      if (!dryRun) figma.commitUndo()

      const pools = await Promise.all([
        figma.getLocalPaintStylesAsync(),
        figma.getLocalTextStylesAsync(),
        figma.getLocalEffectStylesAsync(),
        figma.getLocalGridStylesAsync(),
      ])
      const all = pools.flat()

      const results = []
      for (const ref of refs) {
        try {
          const direct = all.find((one) => one.id === ref || one.key === ref)
          const named = direct ? [direct] : all.filter((one) => one.name === ref)
          if (named.length === 0) throw new Error(`no local style "${ref}"`)
          if (named.length > 1) throw new Error(`"${ref}" names ${named.length} styles — pass an id instead`)
          const style = named[0]

          const consumers = await style.getStyleConsumersAsync()
          /* Publish status is the half of the question this file cannot answer. A style consumed
           * only by other files reports zero consumers here and deleting it breaks them silently
           * — so the status is reported next to the count rather than left for the caller to
           * remember to check. */
          const published = await style.getPublishStatusAsync()

          const row = {
            style: style.name,
            key: style.key,
            type: style.type,
            consumers: consumers.length,
            publishStatus: published,
          }

          if (consumers.length > 0 && params.force !== true) {
            results.push({
              ...row,
              ok: false,
              error: `still used by ${consumers.length} layer(s) — reattach them first, or pass force`,
              nodes: consumers.slice(0, 5).map((one) => ({ id: one.node.id, name: one.node.name })),
            })
            continue
          }

          if (dryRun) {
            results.push({ ...row, ok: true, deleted: false })
            continue
          }

          const id = style.id
          style.remove()
          /* Read it back. Deletion is the one write with no way back, so "it reported success"
           * is not good enough — the id must actually be gone. */
          const stillThere = await figma.getStyleByIdAsync(id)
          results.push({
            ...row,
            ok: stillThere === null,
            deleted: stillThere === null,
            ...(stillThere === null ? {} : { error: 'remove() returned but the style is still resolvable by id' }),
          })
        } catch (err) {
          results.push({ style: ref, ok: false, deleted: false, error: String((err as Error)?.message || err) })
        }
      }

      const gone = results.filter((row) => row.ok)
      return {
        dryRun,
        total: results.length,
        deleted: dryRun ? 0 : gone.length,
        refused: results.length - gone.length,
        results,
      }
    },
  },
  {
    name: 'variables.rebind',
    summary: 'Repoint every binding of one variable onto another, document-wide — the migration op.',
    agent:
      'The migration op. Build the map from a FRESH variables.external — once nothing references a remote variable Figma garbage-collects it and stale from-ids refuse the whole map. Mains are enough: instance mirrors follow. Preview an overrides pass with dryRun first: the report splits instance matches into overrides (would be repointed) and inherited (left alone).',
    mutates: true,
    params: {
      map: {
        type: 'json',
        required: true,
        description:
          'Array of { from, to }. `from` is the variable being migrated away from — its id ' +
          '("VariableID:…") or 40-char key, both reported by `variables.external`; a bare name ' +
          'resolves against LOCAL variables only. `to` is the local replacement — name or id. ' +
          'Types must match: a COLOR cannot take over a FLOAT binding.',
      },
      scope: { type: 'string', default: 'document', enum: ['page', 'document'], description: 'Where to walk.' },
      pageId: { type: 'string', description: 'Which page to walk — giving it implies scope: "page". Defaults to the current page when scope is "page".' },
      nodeId: { type: 'string', description: 'Walk just this subtree. Overrides scope and pageId.' },
      styles: { type: 'boolean', default: true, description: 'Also migrate bindings inside local paint styles.' },
      overrides: {
        type: 'boolean',
        default: false,
        description:
          'Also repoint bindings that a layer INSIDE an instance overrides for itself. Off by ' +
          'default and deliberately so: the walk then descends into every instance, which is the ' +
          'expensive direction on a big file — pair it with pageId. It never CREATES an override; ' +
          'a sublayer whose binding merely mirrors its main is left alone and counted as `inherited`. ' +
          'Which side a binding is on is read off the main, reached through the instance itself, so ' +
          'sublayers of LIBRARY components compare against the local copy of their main — their ' +
          'ids name nodes in the source file, which this file cannot look up.',
      },
      dryRun: {
        type: 'boolean',
        default: false,
        description:
          'Count and report every match without writing anything. With overrides: true the main ' +
          'comparison still runs, so `overrides` (would be repointed) and `inherited` (would be ' +
          'left alone) preview the split; `rebound` stays 0.',
      },
    },
    async run(params) {
      const rows = asArray(params.map, 'map')
      const dryRun = params.dryRun === true
      const wantOverrides = params.overrides === true

      /* The whole map resolves before anything is touched: a migration that discovers a bad row
       * halfway through leaves the file half-moved, which is worse than either end state. */
      const pairs: Array<{
        from: Variable
        to: Variable
        matched: number
        rebound: number
        failed: number
        overrides: number
        inherited: number
        errors: string[]
      }> = []
      const pairByFromId = new Map<string, number>()
      for (const [index, raw] of rows.entries()) {
        const entry = record(raw, `map[${index}]`)
        const from = await resolveVariableRef(entry.from)
        const to = await resolveVariableRef(entry.to)
        if (from.resolvedType !== to.resolvedType) {
          throw new Error(`map[${index}]: "${from.name}" is ${from.resolvedType} but "${to.name}" is ${to.resolvedType}`)
        }
        if (from.id === to.id) throw new Error(`map[${index}]: "${from.name}" maps to itself`)
        if (pairByFromId.has(from.id)) throw new Error(`map[${index}]: "${from.name}" appears twice as a source`)
        pairByFromId.set(from.id, pairs.length)
        pairs.push({ from, to, matched: 0, rebound: 0, failed: 0, overrides: 0, inherited: 0, errors: [] })
      }

      if (!dryRun) figma.commitUndo()

      /* Scope resolution is duplicated from the read registry on purpose: importing ops.ts here
       * would make the write registry depend on the read one, and the cycle costs more than
       * twenty lines ever will. */
      let roots: BaseNode[]
      let labels: string[]
      if (typeof params.nodeId === 'string' && params.nodeId !== '') {
        const found = await figma.getNodeByIdAsync(params.nodeId)
        if (!found || found.type === 'DOCUMENT') throw new Error(`no node with id ${params.nodeId}`)
        if (found.type === 'PAGE') {
          await (found as PageNode).loadAsync()
        } else {
          let page: BaseNode | null = found.parent
          while (page && page.type !== 'PAGE') page = page.parent
          if (page) await (page as PageNode).loadAsync()
        }
        roots = [found]
        labels = [found.type === 'PAGE' ? found.name : `${found.name} (subtree)`]
      } else if (params.scope === 'page' || (typeof params.pageId === 'string' && params.pageId !== '')) {
        // Mirrors resolveWalkRoots: an explicit pageId IS the scope — never a silent document walk.
        let page: PageNode
        if (typeof params.pageId === 'string' && params.pageId !== '') {
          const found = await figma.getNodeByIdAsync(params.pageId)
          if (!found || found.type !== 'PAGE') throw new Error(`no page with id ${params.pageId}`)
          page = found as PageNode
        } else {
          page = figma.currentPage
        }
        await page.loadAsync()
        roots = [page]
        labels = [page.name]
      } else {
        await loadAllPagesAsync()
        roots = figma.root.children.slice()
        labels = roots.map((one) => one.name)
      }

      const aliasTo = (to: Variable) => ({ type: 'VARIABLE_ALIAS' as const, id: to.id })
      /* Text rebinds are collected during the walk and executed after it: the range calls need
       * the node's fonts loaded, which is async, and the walk visitor is deliberately sync. */
      const textJobs: Array<{ node: SceneNode; field: string }> = []
      const textFillJobs: SceneNode[] = []
      /* Fills that come from a paint style are the style's paints seen through the node —
       * assigning them back would silently break the style link, and the style itself is
       * migrated in the styles pass below. */
      const styled = (value: unknown) => value !== undefined && value !== ''
      const writeErrors: string[] = []

      /* A sublayer inside an instance reports the binding it EFFECTIVELY has, whether that came
       * from its main or from an override on this instance. The two must not be treated alike:
       * repointing an override edits something that already exists, while writing over an
       * inherited binding mints a fresh override that the next component update will fight —
       * the very thing the walk avoids by skipping instance children. The main's own alias for
       * the same field is what tells them apart, and it is the only reliable signal: after the
       * mains have moved, an inherited binding already reads as the NEW variable, so anything
       * still reading the old one is an override by construction.
       *
       * Jobs are collected in a dry run too: the split into own overrides and inherited IS what
       * a dry run of this mode is asked to preview, and only the main comparison can draw it. */
      const overrideJobs: OverrideJob[] = []

      const collectOverrides = (node: SceneNode) => {
        const holder = node as unknown as Record<string, unknown>
        const bound = holder.boundVariables as Record<string, unknown> | undefined
        if (bound) {
          for (const [field, value] of Object.entries(bound)) {
            if (field === 'fills' || field === 'strokes' || field === 'effects' || field === 'layoutGrids') continue
            if (Array.isArray(value)) continue // per-segment text bindings: not an override story
            const aliasId = (value as { id?: string })?.id ?? ''
            const at = pairByFromId.get(aliasId)
            if (at === undefined) continue
            pairs[at].matched += 1
            overrideJobs.push({ node, at, aliasId, field })
          }
        }
        for (const prop of ['fills', 'strokes'] as const) {
          const paints = holder[prop]
          if (!Array.isArray(paints)) continue
          ;(paints as Paint[]).forEach((paint, index) => {
            if (paint.type !== 'SOLID') return
            const aliasId =
              (paint as { boundVariables?: { color?: { id?: string } } }).boundVariables?.color?.id ?? ''
            const at = pairByFromId.get(aliasId)
            if (at === undefined) return
            pairs[at].matched += 1
            overrideJobs.push({ node, at, aliasId, field: `${prop}[${index}]`, prop, index })
          })
        }
      }

      const migrateNode = (node: SceneNode) => {
        /* `I<instance path>;<main node id>` is how Figma names a sublayer seen through an
         * instance. Those go to the override collector instead: the write needs the main for
         * comparison, and reading it is async while this visitor is deliberately not. */
        if (node.id.includes(';')) {
          if (wantOverrides) collectOverrides(node)
          return
        }
        const holder = node as unknown as Record<string, unknown>

        const bound = holder.boundVariables as Record<string, unknown> | undefined
        if (bound) {
          for (const [field, value] of Object.entries(bound)) {
            if (field === 'fills' || field === 'strokes') {
              /* The paint pass below owns paint arrays — except on TEXT with per-segment fills,
               * where node.fills is figma.mixed and the paint pass is blind. Those go to the
               * segment executor, which rewrites each run via setRangeFills. */
              if (node.type === 'TEXT' && Array.isArray(value)) {
                let hits = 0
                for (const entry of value) {
                  const at = pairByFromId.get((entry as { id?: string })?.id ?? '')
                  if (at !== undefined) {
                    pairs[at].matched += 1
                    hits += 1
                  }
                }
                if (hits > 0 && !dryRun) textFillJobs.push(node)
              }
              continue
            }
            if (field === 'layoutGrids') continue // grids carry their own per-field aliases — handled below
            if (field === 'effects') continue // so do effects — handled below, for the same reason
            if (Array.isArray(value)) {
              /* Typography arrives as one alias per styled segment — an array even when the whole
               * text uses a single variable. History of this branch: skipping arrays exempted
               * every font binding; `setBoundVariable` flipped only part of the segments,
               * silently; a full-range write destroyed deliberate mixes. Per-segment
               * `setRangeBoundVariable` in the executor is the version that handles all three —
               * each binding run gets exactly its own replacement, untouched runs stay. */
              let hits = 0
              for (const entry of value) {
                const at = pairByFromId.get((entry as { id?: string })?.id ?? '')
                if (at !== undefined) {
                  pairs[at].matched += 1
                  hits += 1
                }
              }
              if (hits === 0) continue
              if (dryRun) continue
              if (node.type === 'TEXT') {
                textJobs.push({ node, field })
              } else {
                const at = pairByFromId.get((value[0] as { id?: string })?.id ?? '') as number
                try {
                  ;(node as unknown as { setBoundVariable: (f: string, v: Variable) => void }).setBoundVariable(
                    field,
                    pairs[at].to
                  )
                  pairs[at].rebound += hits
                } catch (err) {
                  pairs[at].failed += hits
                  const message = `${field}: ${String((err as Error)?.message || err)}`
                  if (pairs[at].errors.length < 3 && !pairs[at].errors.includes(message)) pairs[at].errors.push(message)
                }
              }
              continue
            }
            const at = pairByFromId.get((value as { id?: string })?.id ?? '')
            if (at === undefined) continue
            const pair = pairs[at]
            pair.matched += 1
            if (dryRun) continue
            try {
              ;(node as unknown as { setBoundVariable: (f: string, v: Variable) => void }).setBoundVariable(
                field,
                pair.to
              )
              pair.rebound += 1
            } catch (err) {
              pair.failed += 1
              const message = `${field}: ${String((err as Error)?.message || err)}`
              if (pair.errors.length < 3 && !pair.errors.includes(message)) pair.errors.push(message)
            }
          }
        }

        for (const prop of ['fills', 'strokes'] as const) {
          if (styled(holder[prop === 'fills' ? 'fillStyleId' : 'strokeStyleId'])) continue
          const paints = holder[prop]
          if (!Array.isArray(paints)) continue
          let next: Paint[] | null = null
          ;(paints as Paint[]).forEach((paint, index) => {
            const paintAt = pairByFromId.get(
              (paint as { boundVariables?: { color?: { id?: string } } }).boundVariables?.color?.id ?? ''
            )
            if (paintAt !== undefined && paint.type === 'SOLID') {
              pairs[paintAt].matched += 1
              if (!dryRun) {
                next = next ?? (paints as Paint[]).slice()
                next[index] = figma.variables.setBoundVariableForPaint(next[index] as SolidPaint, 'color', pairs[paintAt].to)
                pairs[paintAt].rebound += 1
              }
            }
            const stops = (paint as GradientPaint).gradientStops
            if (Array.isArray(stops)) {
              let newStops: ColorStop[] | null = null
              stops.forEach((stop, stopIndex) => {
                const stopAt = pairByFromId.get(stop.boundVariables?.color?.id ?? '')
                if (stopAt === undefined) return
                pairs[stopAt].matched += 1
                if (dryRun) return
                newStops = newStops ?? stops.slice()
                ;(newStops as ColorStop[])[stopIndex] = {
                  position: stop.position,
                  color: stop.color,
                  boundVariables: { color: aliasTo(pairs[stopAt].to) },
                } as ColorStop
                pairs[stopAt].rebound += 1
              })
              if (newStops) {
                next = next ?? (paints as Paint[]).slice()
                next[index] = { ...(paint as GradientPaint), gradientStops: newStops } as GradientPaint
              }
            }
          })
          if (next && !dryRun) {
            try {
              ;(holder as Record<string, unknown>)[prop] = next
            } catch (err) {
              const message = `${node.name} (${node.id}) ${prop}: ${String((err as Error)?.message || err)}`
              if (writeErrors.length < 5) writeErrors.push(message)
            }
          }
        }

        /* Layout grids bind per grid FIELD (gutterSize, offset, count, sectionSize) on the grid
         * object itself — setBoundVariable cannot reach them, which is how two Onboarding pages
         * kept a foreign spacing token through every earlier pass. */
        if (Array.isArray(holder.layoutGrids)) {
          const grids = holder.layoutGrids as LayoutGrid[]
          let nextGrids: LayoutGrid[] | null = null
          grids.forEach((grid, index) => {
            const gridBound = (grid as { boundVariables?: Record<string, { id?: string }> }).boundVariables
            if (!gridBound) return
            for (const [gridField, alias] of Object.entries(gridBound)) {
              const at = pairByFromId.get(alias?.id ?? '')
              if (at === undefined) continue
              pairs[at].matched += 1
              if (dryRun) continue
              try {
                nextGrids = nextGrids ?? grids.slice()
                nextGrids[index] = figma.variables.setBoundVariableForLayoutGrid(
                  nextGrids[index],
                  gridField as VariableBindableLayoutGridField,
                  pairs[at].to
                )
                pairs[at].rebound += 1
              } catch (err) {
                pairs[at].failed += 1
                const message = `layoutGrids.${gridField}: ${String((err as Error)?.message || err)}`
                if (pairs[at].errors.length < 3 && !pairs[at].errors.includes(message)) pairs[at].errors.push(message)
              }
            }
          })
          if (nextGrids && !dryRun) {
            try {
              ;(holder as Record<string, unknown>).layoutGrids = nextGrids
            } catch (err) {
              const message = `${node.name} (${node.id}) layoutGrids: ${String((err as Error)?.message || err)}`
              if (writeErrors.length < 5) writeErrors.push(message)
            }
          }
        }

        /* Effects bind per effect FIELD (color, radius, spread, offsetX, offsetY) on the effect
         * object, exactly like grids — and `setBoundVariable('effects', …)` is rejected outright
         * by the API, so the node-level pass could only ever count these, never move them. That
         * is how 59 shadow-colour bindings across two component pages survived a migration whose
         * report said zero failures on every other page: the walk saw them, the write could not
         * reach them, and the count of matched-but-not-rebound was the only trace. */
        if (Array.isArray(holder.effects)) {
          const effects = holder.effects as Effect[]
          let nextEffects: Effect[] | null = null
          effects.forEach((effect, index) => {
            const effectBound = (effect as { boundVariables?: Record<string, { id?: string }> }).boundVariables
            if (!effectBound) return
            for (const [effectField, alias] of Object.entries(effectBound)) {
              const at = pairByFromId.get(alias?.id ?? '')
              if (at === undefined) continue
              pairs[at].matched += 1
              if (dryRun) continue
              try {
                nextEffects = nextEffects ?? effects.slice()
                nextEffects[index] = figma.variables.setBoundVariableForEffect(
                  nextEffects[index],
                  effectField as VariableBindableEffectField,
                  pairs[at].to
                )
                pairs[at].rebound += 1
              } catch (err) {
                pairs[at].failed += 1
                const message = `effects.${effectField}: ${String((err as Error)?.message || err)}`
                if (pairs[at].errors.length < 3 && !pairs[at].errors.includes(message)) pairs[at].errors.push(message)
              }
            }
          })
          if (nextEffects && !dryRun) {
            try {
              ;(holder as Record<string, unknown>).effects = nextEffects
            } catch (err) {
              const message = `${node.name} (${node.id}) effects: ${String((err as Error)?.message || err)}`
              if (writeErrors.length < 5) writeErrors.push(message)
            }
          }
        }
      }

      /* Mains are enough. An instance mirrors its main component, so migrating the main moves
       * every instance in one write — touching instance sublayers directly would mint an
       * override per instance, and the next component update would fight each one. Overrides
       * that bind the old variable straight on a sublayer stay behind by design; the re-audit
       * after a migration names them. */
      const tWalk = Date.now()
      let visited = 0
      for (const root of roots) {
        const walked = await walkSceneNodes(root, migrateNode, { skipInstanceChildren: !wantOverrides })
        visited += walked.visited
      }
      const walkMs = Date.now() - tWalk

      /* Overrides are classified after the walk, in one async pass: each job needs the main's
       * alias for the same field, and one main serves many instances, so the lookups are cached —
       * the main per instance, the mirrored node per sublayer (a fill and a stroke on one layer
       * are two jobs on one node). A job whose main agrees is INHERITED — reported as such and
       * left alone, because the write that would "fix" it is exactly the override-minting this
       * op refuses to do. A dry run classifies exactly as a live run does and then stops short of
       * the write: `overrides` is what WOULD be repointed, and `rebound` stays at zero. */
      const mainByInstance = new Map<string, Promise<ComponentNode | null>>()
      const lookups: MainSideLookups = {
        byId: (id) => figma.getNodeByIdAsync(id),
        mainOf: (instance) => {
          let main = mainByInstance.get(instance.id)
          if (!main) {
            main = instance.getMainComponentAsync()
            mainByInstance.set(instance.id, main)
          }
          return main
        },
      }
      const mainSideByNode = new Map<string, Record<string, unknown> | null>()
      for (const job of overrideJobs) {
        let main = mainSideByNode.get(job.node.id)
        if (main === undefined) {
          main = await resolveMainSide(job.node, lookups)
          mainSideByNode.set(job.node.id, main)
        }
        if (!isOwnOverride(job.aliasId, mainAliasFor(main, job))) {
          pairs[job.at].inherited += 1
          continue
        }
        pairs[job.at].overrides += 1
        if (dryRun) continue
        try {
          if (job.prop !== undefined && job.index !== undefined) {
            const holder = job.node as unknown as Record<string, unknown>
            const paints = holder[job.prop]
            if (!Array.isArray(paints)) throw new Error(`${job.prop} is not an array any more`)
            const next = (paints as Paint[]).slice()
            next[job.index] = figma.variables.setBoundVariableForPaint(
              next[job.index] as SolidPaint,
              'color',
              pairs[job.at].to
            )
            holder[job.prop] = next
          } else {
            ;(job.node as unknown as { setBoundVariable: (f: string, v: Variable) => void }).setBoundVariable(
              job.field,
              pairs[job.at].to
            )
          }
          pairs[job.at].rebound += 1
        } catch (err) {
          pairs[job.at].failed += 1
          const message = `override ${job.field}: ${String((err as Error)?.message || err)}`
          if (pairs[job.at].errors.length < 3 && !pairs[job.at].errors.includes(message)) {
            pairs[job.at].errors.push(message)
          }
        }
      }

      for (const job of textJobs) {
        try {
          const text = job.node as TextNode
          await loadTextFonts(text)
          const segments = text.getStyledTextSegments(['boundVariables']) as unknown as Array<{
            start: number
            end: number
            boundVariables?: Record<string, { id?: string }>
          }>
          for (const segment of segments) {
            const at = pairByFromId.get(segment.boundVariables?.[job.field]?.id ?? '')
            if (at === undefined) continue
            text.setRangeBoundVariable(segment.start, segment.end, job.field as VariableBindableTextField, pairs[at].to)
            pairs[at].rebound += 1
          }
          /* Read back — this exact write path lied twice already. Any segment still on a mapped
           * source means the range write did not take. */
          const after = (text as unknown as { boundVariables?: Record<string, unknown> }).boundVariables?.[job.field]
          const leftover = Array.isArray(after)
            ? after.filter((entry) => pairByFromId.has((entry as { id?: string })?.id ?? '')).length
            : pairByFromId.has((after as { id?: string } | undefined)?.id ?? '')
              ? 1
              : 0
          if (leftover > 0) {
            /* One run resists the per-segment write — in practice the paragraph-mark run, which
             * range writes do not own. When the field's intent is uniform (every mapped source
             * points at one target, everything else already carries it), coarser writes are
             * exact, so escalate: full-range first, whole-node second, re-reading after each. */
            const entries = Array.isArray(after) ? (after as Array<{ id?: string }>) : []
            const targets = new Set(
              entries.map((entry) => {
                const at = pairByFromId.get(entry?.id ?? '')
                return at !== undefined ? pairs[at].to.id : entry?.id
              })
            )
            const uniform = targets.size === 1
            let cleared = false
            if (uniform) {
              const at = entries.map((entry) => pairByFromId.get(entry?.id ?? '')).find((found) => found !== undefined)
              if (at !== undefined) {
                const target = pairs[at].to
                for (const attempt of ['range', 'node'] as const) {
                  if (attempt === 'range') {
                    text.setRangeBoundVariable(0, text.characters.length, job.field as VariableBindableTextField, target)
                  } else {
                    ;(text as unknown as { setBoundVariable: (f: string, v: Variable) => void }).setBoundVariable(
                      job.field,
                      target
                    )
                  }
                  const recheck = (text as unknown as { boundVariables?: Record<string, unknown> }).boundVariables?.[
                    job.field
                  ]
                  const still = Array.isArray(recheck)
                    ? recheck.filter((entry) => pairByFromId.has((entry as { id?: string })?.id ?? '')).length
                    : pairByFromId.has((recheck as { id?: string } | undefined)?.id ?? '')
                      ? 1
                      : 0
                  if (still === 0) {
                    pairs[at].rebound += leftover
                    cleared = true
                    break
                  }
                }
              }
            }
            if (!cleared && writeErrors.length < 5) {
              writeErrors.push(`${text.name} (${text.id}) ${job.field}: ${leftover} segment(s) still on the old variable`)
            }
          }
        } catch (err) {
          if (writeErrors.length < 5) {
            writeErrors.push(`${job.node.name} (${job.node.id}) ${job.field}: ${String((err as Error)?.message || err)}`)
          }
        }
      }

      for (const node of textFillJobs) {
        try {
          const text = node as TextNode
          await loadTextFonts(text)
          const segments = text.getStyledTextSegments(['fills']) as unknown as Array<{
            start: number
            end: number
            fills: Paint[]
          }>
          for (const segment of segments) {
            let next: Paint[] | null = null
            segment.fills.forEach((paint, index) => {
              const at = pairByFromId.get(
                (paint as { boundVariables?: { color?: { id?: string } } }).boundVariables?.color?.id ?? ''
              )
              if (at !== undefined && paint.type === 'SOLID') {
                next = next ?? segment.fills.slice()
                next[index] = figma.variables.setBoundVariableForPaint(next[index] as SolidPaint, 'color', pairs[at].to)
                pairs[at].rebound += 1
              }
            })
            if (next) text.setRangeFills(segment.start, segment.end, next)
          }
        } catch (err) {
          if (writeErrors.length < 5) {
            writeErrors.push(`${node.name} (${node.id}) segment fills: ${String((err as Error)?.message || err)}`)
          }
        }
      }

      let stylesScanned = 0
      if (params.styles !== false) {
        const paintStyles = await figma.getLocalPaintStylesAsync()
        stylesScanned = paintStyles.length
        for (const style of paintStyles) {
          const paints = style.paints
          let next: Paint[] | null = null
          paints.forEach((paint, index) => {
            const paintAt = pairByFromId.get(
              (paint as { boundVariables?: { color?: { id?: string } } }).boundVariables?.color?.id ?? ''
            )
            if (paintAt !== undefined && paint.type === 'SOLID') {
              pairs[paintAt].matched += 1
              if (!dryRun) {
                next = next ?? paints.slice()
                next[index] = figma.variables.setBoundVariableForPaint(next[index] as SolidPaint, 'color', pairs[paintAt].to)
                pairs[paintAt].rebound += 1
              }
            }
            const stops = (paint as GradientPaint).gradientStops
            if (Array.isArray(stops)) {
              let newStops: ColorStop[] | null = null
              stops.forEach((stop, stopIndex) => {
                const stopAt = pairByFromId.get(stop.boundVariables?.color?.id ?? '')
                if (stopAt === undefined) return
                pairs[stopAt].matched += 1
                if (dryRun) return
                newStops = newStops ?? stops.slice()
                ;(newStops as ColorStop[])[stopIndex] = {
                  position: stop.position,
                  color: stop.color,
                  boundVariables: { color: aliasTo(pairs[stopAt].to) },
                } as ColorStop
                pairs[stopAt].rebound += 1
              })
              if (newStops) {
                next = next ?? paints.slice()
                next[index] = { ...(paint as GradientPaint), gradientStops: newStops } as GradientPaint
              }
            }
          })
          if (next && !dryRun) {
            try {
              style.paints = next
            } catch (err) {
              const message = `style "${style.name}": ${String((err as Error)?.message || err)}`
              if (writeErrors.length < 5) writeErrors.push(message)
            }
          }
        }
      }

      return {
        dryRun,
        walked: { pages: labels, nodes: visited, styles: stylesScanned },
        ms: { walk: walkMs },
        pairs: pairs.map((pair) => ({
          from: pair.from.name,
          to: pair.to.name,
          type: pair.from.resolvedType,
          matched: pair.matched,
          rebound: pair.rebound,
          failed: pair.failed,
          /* Reported separately because they answer different questions: `overrides` is what this
           * run found the instances owning and repointed — or, in a dry run, would repoint —
           * `inherited` is what it deliberately left for the main. */
          ...(pair.overrides > 0 ? { overrides: pair.overrides } : {}),
          ...(pair.inherited > 0 ? { inherited: pair.inherited } : {}),
          ...(pair.errors.length > 0 ? { errors: pair.errors } : {}),
        })),
        totalMatched: pairs.reduce((sum, pair) => sum + pair.matched, 0),
        totalRebound: pairs.reduce((sum, pair) => sum + pair.rebound, 0),
        ...(wantOverrides
          ? {
              totalOverrides: pairs.reduce((sum, pair) => sum + pair.overrides, 0),
              totalInherited: pairs.reduce((sum, pair) => sum + pair.inherited, 0),
            }
          : {}),
        ...(writeErrors.length > 0 ? { writeErrors } : {}),
      }
    },
  },

  {
    name: 'node.copy',
    summary: 'Copy nodes onto a page — how an agent builds a side-by-side comparison out of real screens.',
    agent:
      'A COMPONENT copies as an INSTANCE unless you ask for "clone": cloning a component would put a second main in the library, which is a worse defect than the question the copy was meant to answer. modes pins a collection to one mode on the copy, so the same screen can stand twice in Light and Dark. To make a copy show different tokens, follow with variables.rebind scoped by nodeId — the copy is a normal subtree.',
    mutates: true,
    params: {
      nodes: {
        type: 'json',
        required: true,
        description:
          'Array of { node, page, x, y, name, as, modes }. `node` is the id to copy — required. ' +
          '`page` is an id or a page name, created when no page has that name; defaults to the ' +
          "source's own page. `x`/`y` place the copy; omitted, it lands one width to the right of " +
          'the source so it never covers it. `name` renames the copy. `as` is "instance" or ' +
          '"clone" — the default is "instance" for a COMPONENT or COMPONENT_SET and "clone" for ' +
          'everything else. `modes` is { collectionNameOrId: modeName }, pinned on the copy.',
      },
      dryRun: { type: 'boolean', default: false, description: 'Report every copy without creating anything.' },
    },
    async run(params) {
      const rows = asArray(params.nodes, 'nodes')
      const dryRun = params.dryRun === true
      if (!dryRun) figma.commitUndo()

      /* Page resolution is local rather than imported from board.ts: the board owns its own
       * "create the page if the name is new" rule and the two are free to diverge. */
      const resolvePage = async (ref: unknown, fallback: PageNode): Promise<PageNode> => {
        if (typeof ref !== 'string' || ref === '') return fallback
        if (/^\d+:\d+$/.test(ref)) {
          const found = await figma.getNodeByIdAsync(ref)
          if (!found || found.type !== 'PAGE') throw new Error(`no page with id ${ref}`)
          await (found as PageNode).loadAsync()
          return found as PageNode
        }
        const existing = figma.root.children.find((page) => page.name === ref)
        if (existing) {
          await existing.loadAsync()
          return existing
        }
        const page = figma.createPage()
        page.name = ref
        return page
      }

      const pageOf = (node: BaseNode): PageNode | null => {
        let walk: BaseNode | null = node.parent
        while (walk && walk.type !== 'PAGE') walk = walk.parent
        return (walk as PageNode) ?? null
      }

      const results = []
      for (const [index, raw] of rows.entries()) {
        const entry = record(raw, `nodes[${index}]`)
        const id = typeof entry.node === 'string' ? entry.node : ''
        try {
          if (id === '') throw new Error('"node" must be a node id')
          const source = await figma.getNodeByIdAsync(id)
          if (!source) throw new Error(`no node with id ${id}`)
          if (source.type === 'PAGE' || source.type === 'DOCUMENT') throw new Error(`${source.type} cannot be copied`)
          const scene = source as SceneNode
          const home = pageOf(scene)
          if (home) await home.loadAsync()

          const wantAs = typeof entry.as === 'string' ? entry.as : null
          if (wantAs !== null && wantAs !== 'instance' && wantAs !== 'clone') {
            throw new Error(`"as" must be "instance" or "clone", got ${JSON.stringify(entry.as)}`)
          }
          const componentish = scene.type === 'COMPONENT' || scene.type === 'COMPONENT_SET'
          const as = wantAs ?? (componentish ? 'instance' : 'clone')
          if (as === 'instance' && !componentish && scene.type !== 'INSTANCE') {
            throw new Error(`${scene.type} has no instances — use as: "clone"`)
          }

          const target = await resolvePage(entry.page, home ?? figma.currentPage)
          const x = typeof entry.x === 'number' ? entry.x : scene.x + scene.width + 64
          const y = typeof entry.y === 'number' ? entry.y : scene.y

          if (dryRun) {
            results.push({
              node: id,
              name: scene.name,
              type: scene.type,
              as,
              page: target.name,
              x,
              y,
              ok: true,
              copied: false,
            })
            continue
          }

          let copy: SceneNode
          if (as === 'instance' && scene.type === 'COMPONENT_SET') {
            const variant = (scene as ComponentSetNode).defaultVariant
            if (!variant) throw new Error('component set has no default variant to instantiate')
            copy = variant.createInstance()
          } else if (as === 'instance' && scene.type === 'COMPONENT') {
            copy = (scene as ComponentNode).createInstance()
          } else if (as === 'instance') {
            copy = (scene as InstanceNode).clone()
          } else {
            copy = scene.clone()
          }

          /* appendChild reparents whatever clone() or createInstance() chose for us — both
           * document a parent of their own and the two do not agree, so the copy is placed
           * explicitly instead of trusting either. */
          target.appendChild(copy)
          copy.x = x
          copy.y = y
          if (typeof entry.name === 'string' && entry.name !== '') copy.name = entry.name

          const pinned: string[] = []
          const modeWarnings: string[] = []
          if (entry.modes !== undefined) {
            const wanted = record(entry.modes, `nodes[${index}].modes`)
            for (const [collectionRef, modeRef] of Object.entries(wanted)) {
              try {
                const collection = await resolveCollection(collectionRef)
                const modes = resolveModes(collection, modeRef)
                if (modes.length !== 1) throw new Error(`"${String(modeRef)}" must name exactly one mode`)
                const holder = copy as SceneNode & {
                  setExplicitVariableModeForCollection?: (collection: unknown, modeId: string) => void
                }
                if (typeof holder.setExplicitVariableModeForCollection !== 'function') {
                  throw new Error(`${copy.type} cannot hold explicit modes`)
                }
                try {
                  holder.setExplicitVariableModeForCollection(collection, modes[0].modeId)
                } catch {
                  // Older typings took the collection id; a plugin can meet either at runtime.
                  holder.setExplicitVariableModeForCollection(collection.id, modes[0].modeId)
                }
                pinned.push(`${collection.name} → ${modes[0].name}`)
              } catch (err) {
                modeWarnings.push(`${collectionRef}: ${String((err as Error)?.message || err)}`)
              }
            }
          }

          results.push({
            node: id,
            name: scene.name,
            type: scene.type,
            as,
            copy: copy.id,
            copyName: copy.name,
            page: target.name,
            x: copy.x,
            y: copy.y,
            ...(pinned.length > 0 ? { modes: pinned } : {}),
            ...(modeWarnings.length > 0 ? { modeWarnings } : {}),
            ok: true,
            copied: true,
          })
        } catch (err) {
          results.push({ node: id, ok: false, copied: false, error: String((err as Error)?.message || err) })
        }
      }

      const done = results.filter((row) => row.ok)
      return {
        dryRun,
        total: results.length,
        copied: dryRun ? 0 : done.filter((row) => row.copied).length,
        failed: results.length - done.length,
        results,
      }
    },
  },

  {
    name: 'instance.detach',
    summary: 'Detach instances from their main components. Bindings stay — plan a rebind after.',
    agent:
      'Bindings survive a detach — the dependency turns class A for variables.rebind to reach. Nested foreign instances surface as new top-level ones: expect onion rounds.',
    mutates: true,
    params: {
      nodes: { type: 'string[]', required: true, description: 'Instance node ids to detach.' },
      dryRun: { type: 'boolean', default: false, description: 'Report what would be detached without touching anything.' },
    },
    async run(params) {
      const ids = (Array.isArray(params.nodes) ? (params.nodes as unknown[]) : []).filter(
        (entry): entry is string => typeof entry === 'string' && entry !== ''
      )
      if (ids.length === 0) throw new Error('"nodes" must be a non-empty array of instance ids')
      const dryRun = params.dryRun === true
      if (!dryRun) figma.commitUndo()

      const results = []
      for (const id of ids) {
        try {
          const node = await figma.getNodeByIdAsync(id)
          if (!node) throw new Error(`no node with id ${id}`)
          if (node.type !== 'INSTANCE') throw new Error(`${node.type} — only an INSTANCE can be detached`)
          let main: string | null = null
          try {
            main = (await (node as InstanceNode).getMainComponentAsync())?.name ?? null
          } catch {
            main = null
          }
          if (dryRun) {
            results.push({ node: id, name: node.name, main, ok: true, detached: false })
            continue
          }
          /* Detaching does NOT remove external variable references — the sublayers keep every
           * binding they had; they merely stop being an instance. That turns a class-B
           * dependency into a class-A one, which `variables.rebind` can then reach. This op is
           * step one of two, and the report says so rather than letting "detached" read as
           * "clean". */
          const frame = (node as InstanceNode).detachInstance()
          results.push({
            node: id,
            name: frame.name,
            main,
            newId: frame.id,
            ok: frame.type === 'FRAME',
            detached: frame.type === 'FRAME',
            note: 'bindings kept — run variables.rebind to migrate them',
          })
        } catch (err) {
          results.push({ node: id, ok: false, detached: false, error: String((err as Error)?.message || err) })
        }
      }
      const done = results.filter((row) => row.ok)
      return {
        dryRun,
        total: results.length,
        detached: dryRun ? 0 : done.filter((row) => row.detached).length,
        failed: results.length - done.length,
        results,
      }
    },
  },
  {
    name: 'variables.remove',
    summary: 'Delete variables nothing references. Refuses while a binding or alias still points at one.',
    agent:
      "Refuses while anything references the variable — a binding, a gradient stop, a style paint or another variable's alias. Zero references here still says nothing about other files.",
    mutates: true,
    params: {
      variables: {
        type: 'string[]',
        required: true,
        description: 'Variables to delete — ids ("VariableID:…") or exact names. Names resolve against local variables only.',
      },
      dryRun: { type: 'boolean', default: false, description: 'Report reference counts and touch nothing.' },
      force: {
        type: 'boolean',
        default: false,
        description:
          'Delete even when references exist in THIS file. Rarely right: every such binding keeps ' +
          'rendering its last value and quietly stops following anything. It also SKIPS the ' +
          'reference walk, which loads every page and reads every node — on a large file that ' +
          'walk alone can exhaust the plugin and abort its runtime, so `force` is how to remove a ' +
          'variable you already know is unused.',
      },
    },
    async run(params) {
      const refs = (Array.isArray(params.variables) ? (params.variables as unknown[]) : []).filter(
        (entry): entry is string => typeof entry === 'string' && entry !== ''
      )
      if (refs.length === 0) throw new Error('"variables" must be a non-empty array of ids or names')
      const dryRun = params.dryRun === true
      if (!dryRun) figma.commitUndo()

      const targets = new Map<string, Variable>()
      for (const ref of refs) {
        const variable = await resolveVariableRef(ref)
        if (variable.remote) throw new Error(`"${variable.name}" is a library variable — it cannot be deleted from here`)
        targets.set(variable.id, variable)
      }

      /* There is no consumer API for variables (styles have one, variables do not), so the guard
       * IS the walk: canvas bindings, paint stops, style paints, and aliases inside other local
       * variables. Zero here still says nothing about OTHER files — that caveat never goes away. */
      const used = new Map<string, number>()
      const note = (id: unknown) => {
        if (typeof id === 'string' && targets.has(id)) used.set(id, (used.get(id) ?? 0) + 1)
      }
      const scanPaints = (paints: unknown) => {
        if (!Array.isArray(paints)) return
        for (const paint of paints as any[]) {
          note(paint?.boundVariables?.color?.id)
          if (Array.isArray(paint?.gradientStops)) for (const stop of paint.gradientStops) note(stop?.boundVariables?.color?.id)
        }
      }
      /* Skipped entirely under `force`, and that is not an optimisation. The walk loads every
       * page and reads `boundVariables`, fills and strokes off every node in the document; on a
       * file the size of a real design system it exhausts the plugin's heap and Figma aborts the
       * runtime — "Plugin runtime aborted", the leak counter in the console, and from the outside
       * a plugin that keeps reconnecting with a new session id. `force` already means "delete
       * without asking what points at it", so counting first was work whose answer was thrown
       * away. Measured on Altery Mobile DS: the counting call killed the plugin every time, a
       * single attempt was enough, and there was nothing to report when it did. */
      const counting = params.force !== true
      if (counting) await loadAllPagesAsync()
      for (const page of counting ? figma.root.children : []) {
        await walkSceneNodes(page, (node) => {
          const holder = node as unknown as Record<string, unknown>
          const bound = holder.boundVariables as Record<string, unknown> | undefined
          if (bound) {
            for (const [field, value] of Object.entries(bound)) {
              if (field === 'fills' || field === 'strokes') continue
              if (Array.isArray(value)) value.forEach((entry) => note((entry as { id?: string })?.id))
              else note((value as { id?: string })?.id)
            }
          }
          scanPaints(holder.fills)
          scanPaints(holder.strokes)
        })
      }
      if (counting) {
        for (const style of await figma.getLocalPaintStylesAsync()) scanPaints(style.paints)
        for (const variable of await figma.variables.getLocalVariablesAsync()) {
          for (const value of Object.values(variable.valuesByMode ?? {})) {
            const alias = value as { type?: string; id?: string }
            if (alias?.type === 'VARIABLE_ALIAS') note(alias.id)
          }
        }
      }

      const results = []
      for (const variable of targets.values()) {
        // Under `force` nothing was counted, so the report says so rather than claiming zero.
        const references = counting ? (used.get(variable.id) ?? 0) : null
        if (references !== null && references > 0 && params.force !== true) {
          results.push({ variable: variable.name, references, ok: false, deleted: false, error: 'still referenced — rebind first, or pass force' })
          continue
        }
        if (dryRun) {
          results.push({ variable: variable.name, references, ok: true, deleted: false })
          continue
        }
        const id = variable.id
        variable.remove()
        /* getVariableByIdAsync resolves a just-removed variable (a zombie, same as removed
         * nodes) — verifying with it reported deleted:false on 41 successful deletions. The
         * honest check is the roster: a deleted variable stops being listed. */
        const roster = await figma.variables.getLocalVariablesAsync()
        const gone = !roster.some((candidate) => candidate.id === id)
        results.push({
          variable: variable.name,
          references,
          ok: gone,
          deleted: gone,
          ...(gone ? {} : { error: 'remove() returned but the variable is still listed' }),
        })
      }
      const gone = results.filter((row) => row.ok)
      return { dryRun, total: results.length, deleted: dryRun ? 0 : gone.filter((r) => r.deleted).length, refused: results.length - gone.length, results }
    },
  },
  {
    name: 'text.normalize',
    summary: 'Rewrite the invisible end-of-text run so orphan variable references die — surgery, verified.',
    agent:
      'Last resort for orphan run-table entries. Verified per node — and some runs are beyond the public API; the report says which rather than claiming success.',
    mutates: true,
    params: {
      nodes: { type: 'string[]', required: true, description: 'TEXT node ids to normalize.' },
      dryRun: { type: 'boolean', default: false, description: 'Count orphan references per node and touch nothing.' },
    },
    async run(params) {
      const ids = (Array.isArray(params.nodes) ? (params.nodes as unknown[]) : []).filter(
        (entry): entry is string => typeof entry === 'string' && entry !== ''
      )
      if (ids.length === 0) throw new Error('"nodes" must be a non-empty array of TEXT ids')
      const dryRun = params.dryRun === true
      if (!dryRun) figma.commitUndo()

      /* Orphans: alias entries in the node-level boundVariables arrays that NO character-owned
       * segment carries. They are unwritable by every range API (verified the hard way — five
       * strategies, each read back unchanged), because there are no characters to address. The
       * one thing that rewrites the end-of-text ghost run is typing there: insert one invisible
       * character inheriting the style of the character BEFORE it (local by now), then delete
       * it. Content is unchanged; the ghost is re-recorded from a local run. */
      const orphanCount = (text: TextNode): number => {
        const owned = new Set<string>()
        const segments = text.getStyledTextSegments(['boundVariables', 'fills']) as unknown as Array<{
          boundVariables?: Record<string, unknown>
          fills?: Paint[]
        }>
        for (const segment of segments) {
          for (const value of Object.values(segment.boundVariables ?? {})) {
            const entries = Array.isArray(value) ? value : [value]
            for (const entry of entries) {
              const id = (entry as { id?: string })?.id
              if (id) owned.add(id)
            }
          }
          for (const paint of segment.fills ?? []) {
            const id = (paint as { boundVariables?: { color?: { id?: string } } }).boundVariables?.color?.id
            if (id) owned.add(id)
          }
        }
        let orphans = 0
        for (const value of Object.values(
          (text as unknown as { boundVariables?: Record<string, unknown> }).boundVariables ?? {}
        )) {
          const entries = Array.isArray(value) ? value : [value]
          for (const entry of entries) {
            const id = (entry as { id?: string })?.id
            if (id && !owned.has(id)) orphans += 1
          }
        }
        return orphans
      }

      const results = []
      for (const id of ids) {
        try {
          const found = await figma.getNodeByIdAsync(id)
          if (!found || found.type !== 'TEXT') throw new Error(`${found ? found.type : 'nothing'} — need a TEXT node`)
          const text = found as TextNode
          const before = orphanCount(text)
          if (dryRun || before === 0) {
            results.push({ node: id, name: text.name, orphansBefore: before, orphansAfter: before, ok: true, changed: false })
            continue
          }
          await loadTextFonts(text)
          const length = text.characters.length
          text.insertCharacters(length, '\u200B', 'BEFORE')
          text.deleteCharacters(length, length + 1)
          const after = orphanCount(text)
          results.push({
            node: id,
            name: text.name,
            orphansBefore: before,
            orphansAfter: after,
            ok: after === 0,
            changed: after !== before,
            ...(after === 0 ? {} : { error: 'the ghost run survived the rewrite' }),
          })
        } catch (err) {
          results.push({ node: id, ok: false, error: String((err as Error)?.message || err) })
        }
      }
      const clean = results.filter((row) => row.ok)
      return { dryRun, total: results.length, cleaned: clean.filter((r) => (r as { changed?: boolean }).changed).length, stillDirty: results.length - clean.length, results }
    },
  },

  {
    name: 'component.describe',
    summary: 'Write component descriptions and their documentation link — the field COMPONENTS.md reads.',
    agent:
      'Rich text goes in "markdown", plain text in "description" — one field, two views, so a row sends one of them. Figma renders only ## headings (# is demoted), bold, italic, strikethrough, lists, links, inline code and code blocks; tables and images are not supported and survive as literal characters. A dry run returns the normalized text — the canonical form Figma stores — plus that support list and a per-row warning for every trap it found. Normalization does NOT strip what Figma cannot render: a table reaches the panel as literal pipes, and prose written after a code block is swallowed by the block, so put code samples last. documentationLinks takes one URL — a longer list is refused before anything is written, not truncated. Addressing a variant is refused: the UI shows the SET\'s description, so a write to a variant lands where nobody looks.',
    mutates: true,
    params: {
      components: {
        type: 'json',
        required: true,
        description:
          'Array of { node, description | markdown, documentationLinks, variant }. `node` is a ' +
          'COMPONENT or COMPONENT_SET id — required. `description` is plain text, `markdown` is ' +
          'rich text; send one, not both, and null or "" clears the field. `documentationLinks` ' +
          'is a URL, a one-element array or null to clear — Figma refuses a longer list. ' +
          '`variant: true` ' +
          "writes a variant's own description even though the UI shows its set's.",
      },
      dryRun: {
        type: 'boolean',
        default: false,
        description:
          'Report the normalized text and what each row would replace, without touching anything.',
      },
    },
    async run(params) {
      const rows = asArray(params.components, 'components')
      const dryRun = params.dryRun === true
      if (!dryRun) figma.commitUndo()

      /* Figma normalizes on assignment regardless; running it here first is what lets the report
       * show the rendered form BEFORE the write, and lets a dry run answer "what will this look
       * like" without a round trip through the document. Older runtimes lack `figma.util`, so a
       * missing helper degrades to the input rather than failing the batch. */
      const util = (figma as unknown as { util?: { normalizeMarkdown?: (md: string) => string } }).util
      const normalizeMarkdown = (md: string): string => {
        if (md === '' || typeof util?.normalizeMarkdown !== 'function') return md
        try {
          return util.normalizeMarkdown(md)
        } catch {
          return md
        }
      }

      type Doc = { description: string; markdown?: string; links: string[] }
      const readDoc = (node: ComponentNode | ComponentSetNode): Doc => {
        const holder = node as unknown as { descriptionMarkdown?: string }
        return {
          description: node.description ?? '',
          ...(typeof holder.descriptionMarkdown === 'string' ? { markdown: holder.descriptionMarkdown } : {}),
          links: (node.documentationLinks ?? []).map((link) => link.uri),
        }
      }

      const results = []
      for (const [index, raw] of rows.entries()) {
        const entry = record(raw, `components[${index}]`)
        const id = typeof entry.node === 'string' ? entry.node : ''
        try {
          if (id === '') throw new Error('"node" must be a component or component-set id')
          const plan = planDescribe(entry, `components[${index}]`)
          const found = await figma.getNodeByIdAsync(id)
          if (!found) throw new Error(`no node with id ${id}`)
          if (found.type !== 'COMPONENT' && found.type !== 'COMPONENT_SET') {
            throw new Error(`${found.type} has no description — only a COMPONENT or COMPONENT_SET does`)
          }
          const node = found as ComponentNode | ComponentSetNode
          /* A variant carries a description field of its own, and Figma shows the SET's in the
           * component panel and in Assets. Writing one addressed by variant id therefore looks
           * like it worked and is visible to nobody — so it takes an explicit opt-in. */
          const set = node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET' ? node.parent : null
          if (set && !plan.variant) {
            throw new Error(
              `"${node.name}" is a variant of "${set.name}" (${set.id}) — Figma shows the SET's ` +
                'description; address the set, or pass variant: true to write this one anyway'
            )
          }

          const before = readDoc(node)
          const markdown = plan.markdown === undefined ? undefined : normalizeMarkdown(plan.markdown)
          const supportsMarkdown = before.markdown !== undefined
          if (markdown !== undefined && !supportsMarkdown) {
            throw new Error('this Figma build has no descriptionMarkdown — send "description" as plain text')
          }

          const row: Record<string, unknown> = {
            node: id,
            name: node.name,
            type: node.type,
            before,
            ...(set ? { variantOf: set.name } : {}),
            /* The normalized text IS what `intended`/`after` carry, so the ORIGINAL is the half
             * that would otherwise be unrecoverable from the report — without it a rewrite is
             * invisible unless the caller still has what it sent. */
            ...(markdown !== undefined && markdown !== plan.markdown ? { normalizedFrom: plan.markdown } : {}),
            /* Warned about what the CALLER wrote, not about the normalized form: normalization
             * is where the code-block trap springs — it glues the following prose onto the
             * fence — so by then the evidence of the mistake is gone. */
            ...(plan.markdown === undefined || markdownWarnings(plan.markdown).length === 0
              ? {}
              : { warnings: markdownWarnings(plan.markdown) }),
          }

          if (dryRun) {
            results.push({
              ...row,
              intended: {
                ...(plan.description === undefined ? {} : { description: plan.description }),
                ...(markdown === undefined ? {} : { markdown }),
                ...(plan.links === undefined ? {} : { links: plan.links }),
              },
              ok: true,
              written: false,
            })
            continue
          }

          if (markdown !== undefined) (node as unknown as { descriptionMarkdown: string }).descriptionMarkdown = markdown
          if (plan.description !== undefined) node.description = plan.description
          if (plan.links !== undefined) node.documentationLinks = plan.links.map((uri) => ({ uri }))

          /* Read back rather than trust the assignment. `documentationLinks` is the reason this
           * is not ceremony: the API keeps ONE link however many are handed to it, and drops the
           * rest without a word. The report says what the node holds now, never what was sent. */
          const after = readDoc(node)
          const wantMarkdown = markdown === undefined || after.markdown === markdown
          const wantDescription = plan.description === undefined || after.description === plan.description
          const wantLinks = plan.links === undefined || after.links.join('\n') === plan.links.join('\n')

          results.push({
            ...row,
            after,
            ok: wantMarkdown && wantDescription && wantLinks,
            written: true,
            changed:
              after.description !== before.description ||
              after.markdown !== before.markdown ||
              after.links.join('\n') !== before.links.join('\n'),
            ...(wantMarkdown && wantDescription
              ? {}
              : { error: 'the field read back different from what was written' }),
          })
        } catch (err) {
          results.push({ node: id, ok: false, written: false, error: String((err as Error)?.message || err) })
        }
      }

      const good = results.filter((row) => row.ok)
      return {
        dryRun,
        total: results.length,
        written: results.filter((row) => (row as { written?: boolean }).written && row.ok).length,
        failed: results.length - good.length,
        /* The one place an agent reliably looks before writing prose is the preview it asked
         * for, so the support list rides along with it instead of living only in the skill. */
        ...(dryRun ? { markdown: { supported: MARKDOWN_SUPPORTED, unsupported: MARKDOWN_UNSUPPORTED } } : {}),
        results,
      }
    },
  },
  ...REMOVE_OPS,
]
