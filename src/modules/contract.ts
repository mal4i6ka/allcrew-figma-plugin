/**
 * A module somebody else wrote — the contract, and the thing that refuses a bad one.
 *
 * Adding a capability to this plugin means editing its source. A module is the version of that
 * a designer can do: a file with a form, a few steps over commands the plugin already has, and
 * a name in the picker. See `TASK-user-modules.md` for the whole shape and why it is that shape.
 *
 * Three rules do the load-bearing work here, and all three are enforced below rather than
 * documented and hoped for:
 *
 * - **A module does not declare its permissions.** `access` is derived from the commands its
 *   steps actually call: one write anywhere makes the whole thing a write. A file that tries to
 *   say what it is gets that field refused.
 * - **Nothing runs that cannot be named.** A step naming a command this build does not have is
 *   an error, not a line to skip — so the capability list shown at install is the truth about
 *   what the module can do, derived from the file rather than claimed by it.
 * - **Every problem is reported with the path that caused it.** A parser that throws on the
 *   first mistake tells an author one thing per run; this one tells them everything.
 *
 * Pure: no Figma APIs, no storage, no I/O. The plugin decides where modules come from; this
 * decides whether one is a module at all.
 */

import type { UiCommandAccess, UiCommandDef, UiCommandParam } from '../agent/ui-commands.ts'

export const MODULE_FORMAT = 'altery.module/1'

/* ------------------------------------------------------------------ the shape */

export type StateType = 'string' | 'number' | 'boolean'

export interface ModuleStateField {
  type: StateType
  default: string | number | boolean
  label?: string
}

export type ModuleStep =
  | { call: string; params?: Record<string, unknown>; as?: string }
  | { set: string; from: string }
  | { confirm: string }

export type ModuleBlock =
  | { block: 'heading' | 'text'; text: string }
  | { block: 'callout'; text: string; tone?: 'info' | 'warn' }
  | { block: 'field'; bind: string; label?: string; placeholder?: string }
  | { block: 'select'; bind: string; label?: string; options: Array<{ value: string; label?: string }> }
  | { block: 'toggle'; bind: string; label?: string }
  | { block: 'button'; label: string; steps: ModuleStep[] }
  | { block: 'table'; from: string; label?: string }
  | { block: 'spacer' }

export interface ModuleScreen {
  blocks: ModuleBlock[]
}

export interface ModuleCommand {
  name: string
  summary: string
  params: UiCommandParam[]
  steps: ModuleStep[]
  /** Derived, never read from the file: a write if any step calls one. */
  access: UiCommandAccess
  /** Derived: whether any step stops to ask. */
  confirms: boolean
}

export interface UserModule {
  id: string
  name: string
  summary: string
  version: string
  author?: string
  state: Record<string, ModuleStateField>
  screens: { main: ModuleScreen; settings?: ModuleScreen }
  commands: ModuleCommand[]
}

export interface ModuleProblem {
  /** Where it is, in the file's own terms — `commands[0].steps[2].call`. */
  path: string
  message: string
}

export interface ParsedModule {
  module: UserModule | null
  problems: ModuleProblem[]
}

/** What the module may do, derived from its steps — the list an install screen shows. */
export interface ModuleCapability {
  command: string
  access: UiCommandAccess
  /** How many steps across the module call it. */
  uses: number
  cost?: string
}

const BLOCK_TYPES = ['heading', 'text', 'callout', 'field', 'select', 'toggle', 'button', 'table', 'spacer']
const STATE_TYPES: StateType[] = ['string', 'number', 'boolean']
const ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/* ------------------------------------------------------------------- parsing */

/**
 * Reads a module file against the commands this build actually has.
 *
 * `known` is the native surface (`UI_COMMANDS`). Passing it is what turns "this module says it
 * scans the document" into "this module calls REMAP_SCAN, which is a read in this build" — and
 * what makes a module written against a newer plugin fail loudly here instead of at the first
 * click.
 */
export function parseUserModule(raw: unknown, known: readonly UiCommandDef[]): ParsedModule {
  const problems: ModuleProblem[] = []
  const fail = (path: string, message: string) => problems.push({ path, message })

  const value = typeof raw === 'string' ? tryJson(raw, fail) : raw
  if (!isRecord(value)) {
    if (problems.length === 0) fail('', 'not an object')
    return { module: null, problems }
  }

  if (value.module !== MODULE_FORMAT) {
    fail('module', `expected "${MODULE_FORMAT}", got ${JSON.stringify(value.module)}`)
    // Everything below reads fields whose meaning is defined by the format, so there is nothing
    // honest left to check.
    return { module: null, problems }
  }

  const id = text(value.id, 'id', fail)
  const wellFormedId = id !== null && ID_PATTERN.test(id)
  if (id !== null && !wellFormedId) {
    fail('id', 'must be lowercase letters, digits, dots and dashes, starting with a letter or digit')
  }
  const name = text(value.name, 'name', fail)
  const summary = text(value.summary, 'summary', fail)
  const version = text(value.version, 'version', fail)
  if (version !== null && !VERSION_PATTERN.test(version)) fail('version', 'must look like 1.0.0')
  if (value.author !== undefined && typeof value.author !== 'string') fail('author', 'must be a string')

  const state = parseState(value.state, fail)
  const commandsByName = new Map(known.map((command) => [command.name, command]))
  const context = { state, known: commandsByName, fail }

  const screens = parseScreens(value.screens, context)
  // A malformed id is reported once. Passing it on would make every command name fail against
  // it too, burying the one line the author has to fix under its own echo.
  const commands = parseCommands(value.commands, wellFormedId ? id : null, context)

  if (problems.length > 0 || id === null || name === null || summary === null || version === null || !screens) {
    return { module: null, problems }
  }
  return {
    module: {
      id,
      name,
      summary,
      version,
      ...(typeof value.author === 'string' ? { author: value.author } : {}),
      state,
      screens,
      commands,
    },
    problems,
  }
}

interface Context {
  state: Record<string, ModuleStateField>
  known: ReadonlyMap<string, UiCommandDef>
  fail: (path: string, message: string) => void
}

function parseState(raw: unknown, fail: Context['fail']): Record<string, ModuleStateField> {
  const state: Record<string, ModuleStateField> = {}
  if (raw === undefined) return state
  if (!isRecord(raw)) {
    fail('state', 'must be an object of field declarations')
    return state
  }

  for (const [key, entry] of Object.entries(raw)) {
    const path = `state.${key}`
    if (!isRecord(entry)) {
      fail(path, 'must be { type, default }')
      continue
    }
    const type = entry.type as StateType
    if (!STATE_TYPES.includes(type)) {
      fail(`${path}.type`, `must be one of: ${STATE_TYPES.join(', ')}`)
      continue
    }
    if (typeof entry.default !== type) {
      fail(`${path}.default`, `must be a ${type}, so a screen has something to show before anything runs`)
      continue
    }
    state[key] = {
      type,
      default: entry.default as string | number | boolean,
      ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
    }
  }
  return state
}

function parseScreens(raw: unknown, context: Context): UserModule['screens'] | null {
  if (!isRecord(raw)) {
    context.fail('screens', 'must be an object with at least a `main` screen')
    return null
  }
  const main = parseScreen(raw.main, 'screens.main', context)
  if (!main) return null
  const settings = raw.settings === undefined ? undefined : parseScreen(raw.settings, 'screens.settings', context)
  return { main, ...(settings ? { settings } : {}) }
}

function parseScreen(raw: unknown, path: string, context: Context): ModuleScreen | null {
  if (!isRecord(raw) || !Array.isArray(raw.blocks)) {
    context.fail(path, 'must be { blocks: [...] }')
    return null
  }
  const blocks: ModuleBlock[] = []
  for (const [index, entry] of raw.blocks.entries()) {
    const block = parseBlock(entry, `${path}.blocks[${index}]`, context)
    if (block) blocks.push(block)
  }
  return { blocks }
}

function parseBlock(raw: unknown, path: string, context: Context): ModuleBlock | null {
  if (!isRecord(raw)) {
    context.fail(path, 'must be an object')
    return null
  }
  const kind = raw.block
  if (typeof kind !== 'string' || !BLOCK_TYPES.includes(kind)) {
    // Named rather than ignored: a block the plugin skips is a screen that silently renders
    // something other than what its author drew.
    context.fail(`${path}.block`, `unknown block ${JSON.stringify(kind)} — one of: ${BLOCK_TYPES.join(', ')}`)
    return null
  }

  const bound = (): string | null => {
    const bind = raw.bind
    if (typeof bind !== 'string' || !(bind in context.state)) {
      context.fail(`${path}.bind`, `must name a declared state field${knownFields(context)}`)
      return null
    }
    return bind
  }

  switch (kind) {
    case 'heading':
    case 'text': {
      const value = text(raw.text, `${path}.text`, context.fail)
      return value === null ? null : { block: kind, text: value }
    }
    case 'callout': {
      const value = text(raw.text, `${path}.text`, context.fail)
      const tone = raw.tone
      if (tone !== undefined && tone !== 'info' && tone !== 'warn') {
        context.fail(`${path}.tone`, 'must be "info" or "warn"')
        return null
      }
      return value === null ? null : { block: 'callout', text: value, ...(tone ? { tone } : {}) }
    }
    case 'field':
    case 'toggle': {
      const bind = bound()
      return bind === null ? null : { block: kind, bind, ...optionalLabel(raw) }
    }
    case 'select': {
      const bind = bound()
      if (bind === null) return null
      if (!Array.isArray(raw.options) || raw.options.length === 0) {
        context.fail(`${path}.options`, 'must be a non-empty array of { value, label }')
        return null
      }
      const options: Array<{ value: string; label?: string }> = []
      for (const [index, option] of raw.options.entries()) {
        if (!isRecord(option) || typeof option.value !== 'string') {
          context.fail(`${path}.options[${index}]`, 'must be { value, label? } with a string value')
          continue
        }
        options.push({ value: option.value, ...(typeof option.label === 'string' ? { label: option.label } : {}) })
      }
      return { block: 'select', bind, options, ...optionalLabel(raw) }
    }
    case 'button': {
      const label = text(raw.label, `${path}.label`, context.fail)
      const steps = parseSteps(raw.steps, `${path}.steps`, context)
      return label === null || steps === null ? null : { block: 'button', label, steps }
    }
    case 'table': {
      const from = text(raw.from, `${path}.from`, context.fail)
      return from === null ? null : { block: 'table', from, ...optionalLabel(raw) }
    }
    default:
      return { block: 'spacer' }
  }
}

/* --------------------------------------------------------------------- steps */

function parseSteps(raw: unknown, path: string, context: Context): ModuleStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    context.fail(path, 'must be a non-empty array of steps')
    return null
  }

  const steps: ModuleStep[] = []
  // What a later step is allowed to read: state fields, and the results earlier steps kept.
  const available = new Set(Object.keys(context.state))
  let failed = false

  for (const [index, entry] of raw.entries()) {
    const at = `${path}[${index}]`
    if (!isRecord(entry)) {
      context.fail(at, 'must be an object')
      failed = true
      continue
    }

    if (typeof entry.call === 'string') {
      const command = context.known.get(entry.call)
      if (!command) {
        // The whole capability list depends on this: a step naming something unknown would make
        // the install screen a guess.
        context.fail(`${at}.call`, `no command "${entry.call}" in this build — the module needs a newer plugin, or a typo fixed`)
        failed = true
        continue
      }
      if (command.access === 'deny') {
        context.fail(`${at}.call`, `"${entry.call}" is never callable from outside the panel`)
        failed = true
        continue
      }
      if (entry.params !== undefined && !isRecord(entry.params)) {
        context.fail(`${at}.params`, 'must be an object')
        failed = true
        continue
      }
      const params = (entry.params ?? {}) as Record<string, unknown>
      for (const [key, value] of Object.entries(params)) {
        if (!command.params.some((param) => param.name === key)) {
          context.fail(`${at}.params.${key}`, `"${entry.call}" does not read ${key}`)
          failed = true
        }
        if (!checkReference(value, `${at}.params.${key}`, available, context)) failed = true
      }
      for (const param of command.params) {
        if (param.required && !(param.name in params)) {
          context.fail(`${at}.params.${param.name}`, `"${entry.call}" requires ${param.name}`)
          failed = true
        }
      }
      if (entry.as !== undefined) {
        if (typeof entry.as !== 'string' || entry.as === '') {
          context.fail(`${at}.as`, 'must be a name later steps can read')
          failed = true
          continue
        }
        available.add(entry.as)
      }
      steps.push({ call: entry.call, params, ...(typeof entry.as === 'string' ? { as: entry.as } : {}) })
      continue
    }

    if (typeof entry.set === 'string') {
      if (!(entry.set in context.state)) {
        context.fail(`${at}.set`, `must name a declared state field${knownFields(context)}`)
        failed = true
        continue
      }
      if (typeof entry.from !== 'string' || !isReachable(entry.from, available)) {
        context.fail(`${at}.from`, 'must read a state field or an earlier step\'s `as` name')
        failed = true
        continue
      }
      steps.push({ set: entry.set, from: entry.from })
      continue
    }

    if (typeof entry.confirm === 'string') {
      steps.push({ confirm: entry.confirm })
      continue
    }

    context.fail(at, 'must be one of { call }, { set, from } or { confirm }')
    failed = true
  }

  return failed ? null : steps
}

/** A param value is a literal, unless it is `{ from: "<path>" }`. */
function checkReference(value: unknown, path: string, available: ReadonlySet<string>, context: Context): boolean {
  if (!isRecord(value)) return true
  if (typeof value.from !== 'string') return true
  if (!isReachable(value.from, available)) {
    context.fail(`${path}.from`, `nothing named "${value.from.split('.')[0]}" is available here`)
    return false
  }
  return true
}

const isReachable = (reference: string, available: ReadonlySet<string>): boolean =>
  available.has(reference.split('.')[0] ?? '')

/* ---------------------------------------------------------------- commands */

function parseCommands(raw: unknown, id: string | null, context: Context): ModuleCommand[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    context.fail('commands', 'must be an array')
    return []
  }

  const commands: ModuleCommand[] = []
  const seen = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const at = `commands[${index}]`
    if (!isRecord(entry)) {
      context.fail(at, 'must be an object')
      continue
    }
    const name = text(entry.name, `${at}.name`, context.fail)
    if (name !== null) {
      // Namespaced under the module id, so no module can answer to `REMAP_APPLY` — or to
      // anything a future version of the plugin might call its own.
      if (id !== null && !name.startsWith(`${id}.`)) {
        context.fail(`${at}.name`, `must start with "${id}." so it cannot collide with a plugin command`)
      }
      if (/[A-Z]/.test(name)) context.fail(`${at}.name`, 'must be lowercase — SCREAMING_CASE names belong to the plugin')
      if (seen.has(name)) context.fail(`${at}.name`, `duplicated: "${name}"`)
      seen.add(name)
    }
    if (entry.access !== undefined) {
      context.fail(`${at}.access`, 'not yours to declare — it is derived from the commands your steps call')
    }
    const summary = text(entry.summary, `${at}.summary`, context.fail)
    const params = parseParams(entry.params, `${at}.params`, context)
    const steps = parseSteps(entry.steps, `${at}.steps`, context)
    if (name === null || summary === null || steps === null) continue

    commands.push({
      name,
      summary,
      params,
      steps,
      access: accessOf(steps, context.known),
      confirms: steps.some((step) => 'confirm' in step),
    })
  }
  return commands
}

function parseParams(raw: unknown, path: string, context: Context): UiCommandParam[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    context.fail(path, 'must be an array of { name, required?, type?, note? }')
    return []
  }
  const params: UiCommandParam[] = []
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      context.fail(`${path}[${index}]`, 'must be an object with a string name')
      continue
    }
    params.push({
      name: entry.name,
      required: entry.required === true,
      ...(typeof entry.type === 'string' ? { type: entry.type } : {}),
      ...(typeof entry.note === 'string' ? { note: entry.note } : {}),
    })
  }
  return params
}

/* --------------------------------------------------------------- derivation */

/** One write anywhere and the whole thing is a write. Nothing else is safe to assume. */
export function accessOf(steps: readonly ModuleStep[], known: ReadonlyMap<string, UiCommandDef>): UiCommandAccess {
  for (const step of steps) {
    if (!('call' in step)) continue
    if (known.get(step.call)?.access !== 'read') return 'write'
  }
  return 'read'
}

/**
 * Everything the module can run, with what each of those costs and whether it writes.
 *
 * This is what an install screen shows, and it is computed from the file rather than read out
 * of it — which is the only version of that list worth showing anyone.
 */
export function moduleCapabilities(module: UserModule, known: readonly UiCommandDef[]): ModuleCapability[] {
  const byName = new Map(known.map((command) => [command.name, command]))
  const uses = new Map<string, number>()

  const count = (steps: readonly ModuleStep[]) => {
    for (const step of steps) if ('call' in step) uses.set(step.call, (uses.get(step.call) ?? 0) + 1)
  }
  for (const command of module.commands) count(command.steps)
  for (const screen of [module.screens.main, module.screens.settings]) {
    for (const block of screen?.blocks ?? []) if (block.block === 'button') count(block.steps)
  }

  return [...uses.entries()]
    .map(([command, times]) => {
      const known = byName.get(command)
      return {
        command,
        access: known?.access ?? 'write',
        uses: times,
        ...(known?.cost ? { cost: known.cost } : {}),
      }
    })
    .sort((a, b) => (a.access === b.access ? a.command.localeCompare(b.command) : a.access === 'write' ? -1 : 1))
}

/* ----------------------------------------------------------------- helpers */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function text(value: unknown, path: string, fail: Context['fail']): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(path, 'must be a non-empty string')
    return null
  }
  return value
}

function optionalLabel(raw: Record<string, unknown>): { label?: string } {
  return typeof raw.label === 'string' ? { label: raw.label } : {}
}

function knownFields(context: Context): string {
  const fields = Object.keys(context.state)
  return fields.length === 0 ? ' (this module declares none)' : ` — declared: ${fields.join(', ')}`
}

function tryJson(raw: string, fail: Context['fail']): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    fail('', `not JSON: ${String((error as Error).message)}`)
    return null
  }
}
