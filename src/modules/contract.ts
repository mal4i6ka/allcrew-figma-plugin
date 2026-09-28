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
import { isRecord } from '../utils/type-guards.ts'

export const MODULE_FORMAT = 'allcrew-channel.module/1'

/* ------------------------------------------------------------------ the shape */

export type StateType = 'string' | 'number' | 'boolean'
export type ModuleScalar = string | number | boolean

export interface ModuleStateField {
  type: StateType
  default: ModuleScalar
  label?: string
  /** Password input in the panel. Only a `set` flag crosses the sandbox boundary; the value is
   * never returned by module inspection, screen reads, run reports or exports. */
  secret?: boolean
  /** Numeric constraints enforced on UI and agent writes. */
  min?: number
  max?: number
}

/** Tiny, pure condition language. Exactly one comparison is accepted; no code, loops or I/O. */
export type ModuleCondition =
  | { from: string; equals: ModuleScalar }
  | { from: string; notEquals: ModuleScalar }
  | { from: string; oneOf: ModuleScalar[] }
  | { from: string; truthy: boolean }
  | { from: string; exists: boolean }

interface Conditional {
  when?: ModuleCondition
}

interface Interactive extends Conditional {
  disabledWhen?: ModuleCondition
}

export type ModuleStep =
  | ({ call: string; params?: Record<string, unknown>; as?: string } & Conditional)
  | ({ set: string; from: string } & Conditional)
  | ({ confirm: string } & Conditional)

export type ModuleIcon =
  | 'module'
  | 'palette'
  | 'terminal'
  | 'settings'
  | 'database'
  | 'document'
  | 'code'
  | 'play'
  | 'check'
  | 'warning'

export type ModuleBlock =
  | ({ block: 'heading'; text: string; icon?: ModuleIcon; hint?: string } & Conditional)
  | ({ block: 'text'; text: string } & Conditional)
  | ({ block: 'callout'; text: string; tone?: 'info' | 'warn' | 'error' | 'success' } & Conditional)
  | ({
      block: 'field'
      bind: string
      label?: string
      placeholder?: string
      multiline?: boolean
      rows?: number
    } & Interactive)
  /** A value to read, not to edit. */
  | ({ block: 'value'; bind: string; label?: string; hint?: string } & Conditional)
  | ({
      block: 'select'
      bind: string
      label?: string
      options: Array<{ value: string; label?: string }>
    } & Interactive)
  | ({ block: 'toggle'; bind: string; label?: string } & Interactive)
  | ({
      block: 'button'
      label: string
      look?: 'primary' | 'secondary' | 'danger'
      steps: ModuleStep[]
    } & Interactive)
  | ({ block: 'table'; from: string; label?: string; columns?: string[]; limit?: number } & Conditional)
  | ({ block: 'code'; from?: string; text?: string; label?: string; language?: string } & Conditional)
  | ({ block: 'list'; from: string; label?: string; limit?: number } & Conditional)

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

/**
 * The whole vocabulary. No `spacer`: spacing is the panel's business, not the author's — a
 * screen is laid out by the rules in the renderer, and a block whose only job is to push
 * things apart would be an invitation to fight them.
 */
const BLOCK_TYPES = ['heading', 'text', 'callout', 'field', 'value', 'select', 'toggle', 'button', 'table', 'code', 'list'] as const
const STATE_TYPES: StateType[] = ['string', 'number', 'boolean']
export const MODULE_ICON_TYPES: readonly ModuleIcon[] = ['module', 'palette', 'terminal', 'settings', 'database', 'document', 'code', 'play', 'check', 'warning']
export const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/
export const MODULE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
export const MODULE_SAFE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/
export const MODULE_REFERENCE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/
export const MODULE_COMMAND_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/

export const MODULE_LIMITS = {
  stateFields: 64,
  blocksPerScreen: 120,
  commands: 64,
  stepsPerPipeline: 64,
  textLength: 4_000,
  nameLength: 120,
  tableRows: 200,
} as const

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
    return { module: null, problems }
  }
  rejectUnknown(
    value,
    ['$schema', 'module', 'id', 'name', 'summary', 'version', 'author', 'state', 'screens', 'commands'],
    '',
    fail
  )

  const id = text(value.id, 'id', fail, MODULE_LIMITS.nameLength)
  const wellFormedId = id !== null && MODULE_ID_PATTERN.test(id) && !dangerousKey(id)
  if (id !== null && !wellFormedId) {
    fail('id', 'must be lowercase letters, digits, dots and dashes, starting with a letter or digit')
  }
  const name = text(value.name, 'name', fail, MODULE_LIMITS.nameLength)
  const summary = text(value.summary, 'summary', fail, MODULE_LIMITS.textLength)
  const version = text(value.version, 'version', fail, 40)
  if (version !== null && !MODULE_VERSION_PATTERN.test(version)) fail('version', 'must be valid SemVer, such as 1.0.0 or 1.1.0-beta.1')
  if (value.author !== undefined) {
    if (typeof value.author !== 'string') fail('author', 'must be a string')
    else if (value.author.length > MODULE_LIMITS.nameLength) fail('author', `must be <= ${MODULE_LIMITS.nameLength} characters`)
  }

  const state = parseState(value.state, fail)
  const commandsByName = new Map(known.map((command) => [command.name, command]))
  const context = { state, known: commandsByName, fail }

  const screens = parseScreens(value.screens, context)
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
  const state: Record<string, ModuleStateField> = Object.create(null) as Record<string, ModuleStateField>
  if (raw === undefined) return state
  if (!isRecord(raw)) {
    fail('state', 'must be an object of field declarations')
    return state
  }
  const entries = Object.entries(raw)
  if (entries.length > MODULE_LIMITS.stateFields) {
    fail('state', `has ${entries.length} fields; limit is ${MODULE_LIMITS.stateFields}`)
  }

  for (const [key, entry] of entries.slice(0, MODULE_LIMITS.stateFields)) {
    const path = `state.${key}`
    if (!MODULE_SAFE_NAME_PATTERN.test(key) || dangerousKey(key)) {
      fail(path, 'field name must start with a letter and contain only letters, digits, dashes or underscores')
      continue
    }
    if (!isRecord(entry)) {
      fail(path, 'must be { type, default }')
      continue
    }
    rejectUnknown(entry, ['type', 'default', 'label', 'secret', 'min', 'max'], path, fail)
    const type = entry.type as StateType
    if (!STATE_TYPES.includes(type)) {
      fail(`${path}.type`, `must be one of: ${STATE_TYPES.join(', ')}`)
      continue
    }
    if (typeof entry.default !== type) {
      fail(`${path}.default`, `must be a ${type}, so a screen has something to show before anything runs`)
      continue
    }
    if (type === 'number' && typeof entry.default === 'number' && !Number.isFinite(entry.default)) {
      fail(`${path}.default`, 'must be a finite number')
      continue
    }
    if (entry.label !== undefined && typeof entry.label !== 'string') fail(`${path}.label`, 'must be a string')
    if (entry.secret !== undefined && typeof entry.secret !== 'boolean') fail(`${path}.secret`, 'must be a boolean')
    if (entry.secret === true && type !== 'string') fail(`${path}.secret`, 'is only valid for string fields')
    if (entry.secret === true && entry.default !== '') {
      fail(`${path}.default`, 'must be empty for a secret field; portable module files cannot contain credentials')
    }
    const min = entry.min
    const max = entry.max
    if ((min !== undefined || max !== undefined) && type !== 'number') fail(path, 'min/max are only valid for number fields')
    if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) fail(`${path}.min`, 'must be a finite number')
    if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) fail(`${path}.max`, 'must be a finite number')
    if (typeof min === 'number' && typeof max === 'number' && min > max) fail(path, 'min must be <= max')
    if (type === 'number' && typeof entry.default === 'number') {
      if (typeof min === 'number' && entry.default < min) fail(`${path}.default`, `must be >= ${min}`)
      if (typeof max === 'number' && entry.default > max) fail(`${path}.default`, `must be <= ${max}`)
    }
    state[key] = {
      type,
      default: entry.default as ModuleScalar,
      ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
      ...(entry.secret === true ? { secret: true } : {}),
      ...(typeof min === 'number' ? { min } : {}),
      ...(typeof max === 'number' ? { max } : {}),
    }
  }
  return state
}

function parseScreens(raw: unknown, context: Context): UserModule['screens'] | null {
  if (!isRecord(raw)) {
    context.fail('screens', 'must be an object with at least a `main` screen')
    return null
  }
  rejectUnknown(raw, ['main', 'settings'], 'screens', context.fail)
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
  rejectUnknown(raw, ['blocks'], path, context.fail)
  if (raw.blocks.length > MODULE_LIMITS.blocksPerScreen) {
    context.fail(`${path}.blocks`, `has ${raw.blocks.length} blocks; limit is ${MODULE_LIMITS.blocksPerScreen}`)
  }
  const blocks: ModuleBlock[] = []
  for (const [index, entry] of raw.blocks.slice(0, MODULE_LIMITS.blocksPerScreen).entries()) {
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
  if (typeof kind !== 'string' || !BLOCK_TYPES.includes(kind as typeof BLOCK_TYPES[number])) {
    context.fail(`${path}.block`, `unknown block ${JSON.stringify(kind)} — one of: ${BLOCK_TYPES.join(', ')}`)
    return null
  }
  const hasWhen = raw.when !== undefined
  const when = parseCondition(raw.when, `${path}.when`, new Set(Object.keys(context.state)), context)
  if (hasWhen && !when) return null
  const conditional = when ? { when } : {}
  for (const key of ['label', 'hint', 'placeholder', 'language'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') context.fail(`${path}.${key}`, 'must be a string')
  }

  const bound = (expected?: StateType | StateType[]): string | null => {
    const bind = raw.bind
    if (typeof bind !== 'string' || !(bind in context.state)) {
      context.fail(`${path}.bind`, `must name a declared state field${knownFields(context)}`)
      return null
    }
    const allowed = expected === undefined ? undefined : Array.isArray(expected) ? expected : [expected]
    if (allowed && !allowed.includes(context.state[bind].type)) {
      context.fail(`${path}.bind`, `must name ${allowed.join(' or ')} state, but "${bind}" is ${context.state[bind].type}`)
      return null
    }
    return bind
  }
  const disabledWhen = (): { disabledWhen?: ModuleCondition } | null => {
    const hasCondition = raw.disabledWhen !== undefined
    const condition = parseCondition(raw.disabledWhen, `${path}.disabledWhen`, new Set(Object.keys(context.state)), context)
    return hasCondition && !condition ? null : condition ? { disabledWhen: condition } : {}
  }

  switch (kind) {
    case 'heading': {
      rejectUnknown(raw, ['block', 'text', 'icon', 'hint', 'when'], path, context.fail)
      const value = text(raw.text, `${path}.text`, context.fail, MODULE_LIMITS.textLength)
      const icon = raw.icon
      if (icon !== undefined && (typeof icon !== 'string' || !MODULE_ICON_TYPES.includes(icon as ModuleIcon))) {
        context.fail(`${path}.icon`, `must be one of: ${MODULE_ICON_TYPES.join(', ')}`)
        return null
      }
      return value === null ? null : {
        block: 'heading',
        text: value,
        ...(icon ? { icon: icon as ModuleIcon } : {}),
        ...(typeof raw.hint === 'string' ? { hint: raw.hint } : {}),
        ...conditional,
      }
    }
    case 'text': {
      rejectUnknown(raw, ['block', 'text', 'when'], path, context.fail)
      const value = text(raw.text, `${path}.text`, context.fail, MODULE_LIMITS.textLength)
      return value === null ? null : { block: 'text', text: value, ...conditional }
    }
    case 'callout': {
      rejectUnknown(raw, ['block', 'text', 'tone', 'when'], path, context.fail)
      const value = text(raw.text, `${path}.text`, context.fail, MODULE_LIMITS.textLength)
      const tone = raw.tone
      if (tone !== undefined && tone !== 'info' && tone !== 'warn' && tone !== 'error' && tone !== 'success') {
        context.fail(`${path}.tone`, 'must be "info", "warn", "error" or "success"')
        return null
      }
      return value === null ? null : { block: 'callout', text: value, ...(tone ? { tone } : {}), ...conditional }
    }
    case 'field': {
      rejectUnknown(raw, ['block', 'bind', 'label', 'placeholder', 'multiline', 'rows', 'when', 'disabledWhen'], path, context.fail)
      const bind = bound(['string', 'number'])
      const disabled = disabledWhen()
      if (bind === null || disabled === null) return null
      if (raw.placeholder !== undefined && typeof raw.placeholder !== 'string') context.fail(`${path}.placeholder`, 'must be a string')
      if (raw.multiline !== undefined && typeof raw.multiline !== 'boolean') context.fail(`${path}.multiline`, 'must be a boolean')
      if (raw.rows !== undefined && (!Number.isInteger(raw.rows) || Number(raw.rows) < 2 || Number(raw.rows) > 20)) {
        context.fail(`${path}.rows`, 'must be an integer from 2 to 20')
      }
      if (raw.multiline === true && context.state[bind].type !== 'string') context.fail(`${path}.multiline`, 'is only valid for string fields')
      return {
        block: 'field',
        bind,
        ...optionalLabel(raw),
        ...(typeof raw.placeholder === 'string' ? { placeholder: raw.placeholder } : {}),
        ...(raw.multiline === true ? { multiline: true } : {}),
        ...(Number.isInteger(raw.rows) ? { rows: Number(raw.rows) } : {}),
        ...conditional,
        ...disabled,
      }
    }
    case 'toggle': {
      rejectUnknown(raw, ['block', 'bind', 'label', 'when', 'disabledWhen'], path, context.fail)
      const bind = bound('boolean')
      const disabled = disabledWhen()
      return bind === null || disabled === null ? null : { block: 'toggle', bind, ...optionalLabel(raw), ...conditional, ...disabled }
    }
    case 'value': {
      rejectUnknown(raw, ['block', 'bind', 'label', 'hint', 'when'], path, context.fail)
      const bind = bound()
      if (bind !== null && context.state[bind].secret) {
        context.fail(`${path}.bind`, 'secret fields can only be edited; they cannot be displayed by a value block')
        return null
      }
      return bind === null ? null : {
        block: 'value',
        bind,
        ...optionalLabel(raw),
        ...(typeof raw.hint === 'string' ? { hint: raw.hint } : {}),
        ...conditional,
      }
    }
    case 'select': {
      rejectUnknown(raw, ['block', 'bind', 'label', 'options', 'when', 'disabledWhen'], path, context.fail)
      const bind = bound('string')
      const disabled = disabledWhen()
      if (bind === null || disabled === null) return null
      if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > 200) {
        context.fail(`${path}.options`, 'must be a non-empty array of at most 200 { value, label? } entries')
        return null
      }
      const options: Array<{ value: string; label?: string }> = []
      const values = new Set<string>()
      for (const [index, option] of raw.options.entries()) {
        const at = `${path}.options[${index}]`
        if (!isRecord(option) || typeof option.value !== 'string') {
          context.fail(at, 'must be { value, label? } with a string value')
          continue
        }
        rejectUnknown(option, ['value', 'label'], at, context.fail)
        if (values.has(option.value)) context.fail(`${at}.value`, 'must be unique within this select')
        values.add(option.value)
        options.push({ value: option.value, ...(typeof option.label === 'string' ? { label: option.label } : {}) })
      }
      return { block: 'select', bind, options, ...optionalLabel(raw), ...conditional, ...disabled }
    }
    case 'button': {
      rejectUnknown(raw, ['block', 'label', 'look', 'steps', 'when', 'disabledWhen'], path, context.fail)
      const label = text(raw.label, `${path}.label`, context.fail, MODULE_LIMITS.nameLength)
      const look = raw.look
      if (look !== undefined && look !== 'primary' && look !== 'secondary' && look !== 'danger') {
        context.fail(`${path}.look`, 'must be "primary", "secondary" or "danger"')
        return null
      }
      const steps = parseSteps(raw.steps, `${path}.steps`, context)
      const disabled = disabledWhen()
      return label === null || steps === null || disabled === null ? null : {
        block: 'button',
        label,
        ...(look ? { look } : {}),
        steps,
        ...conditional,
        ...disabled,
      }
    }
    case 'table': {
      rejectUnknown(raw, ['block', 'from', 'label', 'columns', 'limit', 'when'], path, context.fail)
      const from = text(raw.from, `${path}.from`, context.fail, MODULE_LIMITS.nameLength)
      const columns = parseStringArray(raw.columns, `${path}.columns`, context.fail, 32)
      const limit = parseLimit(raw.limit, `${path}.limit`, context.fail)
      return from === null ? null : { block: 'table', from, ...optionalLabel(raw), ...(columns ? { columns } : {}), ...(limit ? { limit } : {}), ...conditional }
    }
    case 'code': {
      rejectUnknown(raw, ['block', 'from', 'text', 'label', 'language', 'when'], path, context.fail)
      if ((typeof raw.from === 'string') === (typeof raw.text === 'string')) {
        context.fail(path, 'code must have exactly one of `from` or `text`')
        return null
      }
      return {
        block: 'code',
        ...(typeof raw.from === 'string' ? { from: raw.from } : { text: raw.text as string }),
        ...optionalLabel(raw),
        ...(typeof raw.language === 'string' ? { language: raw.language } : {}),
        ...conditional,
      }
    }
    case 'list': {
      rejectUnknown(raw, ['block', 'from', 'label', 'limit', 'when'], path, context.fail)
      const from = text(raw.from, `${path}.from`, context.fail, MODULE_LIMITS.nameLength)
      const limit = parseLimit(raw.limit, `${path}.limit`, context.fail)
      return from === null ? null : { block: 'list', from, ...optionalLabel(raw), ...(limit ? { limit } : {}), ...conditional }
    }
    default:
      context.fail(`${path}.block`, `no renderer for block "${kind}"`)
      return null
  }
}

function parseCondition(
  raw: unknown,
  path: string,
  available: ReadonlySet<string>,
  context: Context,
): ModuleCondition | null {
  if (raw === undefined) return null
  if (!isRecord(raw)) {
    context.fail(path, 'must be a condition object')
    return null
  }
  rejectUnknown(raw, ['from', 'equals', 'notEquals', 'oneOf', 'truthy', 'exists'], path, context.fail)
  if (typeof raw.from !== 'string' || !isReachable(raw.from, available)) {
    context.fail(`${path}.from`, 'must read a declared state field or an earlier step result')
    return null
  }
  const operators = ['equals', 'notEquals', 'oneOf', 'truthy', 'exists'].filter((key) => raw[key] !== undefined)
  if (operators.length !== 1) {
    context.fail(path, 'must declare exactly one of equals, notEquals, oneOf, truthy or exists')
    return null
  }
  const operator = operators[0]
  const expectedType = context.state[raw.from]?.type
  if (operator === 'oneOf') {
    if (!Array.isArray(raw.oneOf) || raw.oneOf.length === 0 || raw.oneOf.length > 100 ||
        raw.oneOf.some((value) => !isScalar(value))) {
      context.fail(`${path}.oneOf`, 'must be a non-empty array of at most 100 strings, numbers or booleans')
      return null
    }
    if (expectedType && raw.oneOf.some((value) => typeof value !== expectedType)) {
      context.fail(`${path}.oneOf`, `values must be ${expectedType} to match "${raw.from}"`)
      return null
    }
    return { from: raw.from, oneOf: raw.oneOf as ModuleScalar[] }
  }
  if (operator === 'truthy' || operator === 'exists') {
    const value = raw[operator]
    if (typeof value !== 'boolean') {
      context.fail(`${path}.${operator}`, 'must be a boolean')
      return null
    }
    return operator === 'truthy' ? { from: raw.from, truthy: value } : { from: raw.from, exists: value }
  }
  const value = raw[operator]
  if (!isScalar(value)) {
    context.fail(`${path}.${operator}`, 'must be a string, number or boolean')
    return null
  }
  if (expectedType && typeof value !== expectedType) {
    context.fail(`${path}.${operator}`, `must be ${expectedType} to match "${raw.from}"`)
    return null
  }
  return operator === 'equals' ? { from: raw.from, equals: value } : { from: raw.from, notEquals: value }
}

function parseStringArray(
  raw: unknown,
  path: string,
  fail: Context['fail'],
  max: number,
): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max || raw.some((value) => typeof value !== 'string' || value === '')) {
    fail(path, `must be a non-empty array of at most ${max} non-empty strings`)
    return undefined
  }
  if (new Set(raw).size !== raw.length) fail(path, 'must not contain duplicate values')
  return raw as string[]
}

function parseLimit(raw: unknown, path: string, fail: Context['fail']): number | undefined {
  if (raw === undefined) return undefined
  if (!Number.isInteger(raw) || Number(raw) < 1 || Number(raw) > MODULE_LIMITS.tableRows) {
    fail(path, `must be an integer from 1 to ${MODULE_LIMITS.tableRows}`)
    return undefined
  }
  return Number(raw)
}

/* --------------------------------------------------------------------- steps */

function parseSteps(
  raw: unknown,
  path: string,
  context: Context,
  availableNames: readonly string[] = [],
): ModuleStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    context.fail(path, 'must be a non-empty array of steps')
    return null
  }
  if (raw.length > MODULE_LIMITS.stepsPerPipeline) {
    context.fail(path, `has ${raw.length} steps; limit is ${MODULE_LIMITS.stepsPerPipeline}`)
    return null
  }

  const steps: ModuleStep[] = []
  const available = new Set([...Object.keys(context.state), ...availableNames])
  let failed = false

  for (const [index, entry] of raw.entries()) {
    const at = `${path}[${index}]`
    if (!isRecord(entry)) {
      context.fail(at, 'must be an object')
      failed = true
      continue
    }
    const hasWhen = entry.when !== undefined
    const when = parseCondition(entry.when, `${at}.when`, available, context)
    if (hasWhen && !when) failed = true
    const conditional = when ? { when } : {}

    if (typeof entry.call === 'string') {
      rejectUnknown(entry, ['call', 'params', 'as', 'when'], at, context.fail)
      const command = context.known.get(entry.call)
      if (!command) {
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
        if (dangerousKey(key)) {
          context.fail(`${at}.params.${key}`, 'unsafe object key')
          failed = true
          continue
        }
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
        if (typeof entry.as !== 'string' || !MODULE_SAFE_NAME_PATTERN.test(entry.as) || dangerousKey(entry.as)) {
          context.fail(`${at}.as`, 'must start with a letter and contain only letters, digits, dashes or underscores')
          failed = true
          continue
        }
        if (available.has(entry.as)) {
          context.fail(`${at}.as`, `"${entry.as}" is already a state field, parameter or earlier result`)
          failed = true
          continue
        }
        available.add(entry.as)
      }
      steps.push({ call: entry.call, params, ...(typeof entry.as === 'string' ? { as: entry.as } : {}), ...conditional })
      continue
    }

    if (typeof entry.set === 'string') {
      rejectUnknown(entry, ['set', 'from', 'when'], at, context.fail)
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
      steps.push({ set: entry.set, from: entry.from, ...conditional })
      continue
    }

    if (typeof entry.confirm === 'string') {
      rejectUnknown(entry, ['confirm', 'when'], at, context.fail)
      const confirm = text(entry.confirm, `${at}.confirm`, context.fail, MODULE_LIMITS.textLength)
      if (confirm !== null) steps.push({ confirm, ...conditional })
      else failed = true
      continue
    }

    context.fail(at, 'must be one of { call }, { set, from } or { confirm }')
    failed = true
  }

  return failed ? null : steps
}

/**
 * A param value is a literal, unless it is `{ from: "<path>" }` — at any depth.
 *
 * The commands worth composing take objects (`source` is `{ kind, key }`), and a module's state
 * holds scalars, so a reference has to be able to sit inside one. Checked as deep as it is
 * substituted, or the validator would pass a file the runner then fails on.
 */
function checkReference(value: unknown, path: string, available: ReadonlySet<string>, context: Context): boolean {
  if (Array.isArray(value)) {
    return value.every((entry, index) => checkReference(entry, `${path}[${index}]`, available, context))
  }
  if (!isRecord(value)) return true
  if (typeof value.from === 'string') {
    rejectUnknown(value, ['from'], path, context.fail)
    if (!isReachable(value.from, available)) {
      context.fail(`${path}.from`, `nothing named "${value.from.split('.')[0]}" is available here`)
      return false
    }
    return true
  }
  return Object.entries(value).every(([key, entry]) => {
    if (dangerousKey(key)) {
      context.fail(`${path}.${key}`, 'unsafe object key')
      return false
    }
    return checkReference(entry, `${path}.${key}`, available, context)
  })
}

const isReachable = (reference: string, available: ReadonlySet<string>): boolean => {
  const parts = reference.split('.')
  return MODULE_REFERENCE_PATTERN.test(reference) &&
    parts.every((part) => !dangerousKey(part)) &&
    available.has(parts[0] ?? '')
}

/* ---------------------------------------------------------------- commands */

function parseCommands(raw: unknown, id: string | null, context: Context): ModuleCommand[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    context.fail('commands', 'must be an array')
    return []
  }
  if (raw.length > MODULE_LIMITS.commands) {
    context.fail('commands', `has ${raw.length} commands; limit is ${MODULE_LIMITS.commands}`)
  }

  const commands: ModuleCommand[] = []
  const seen = new Set<string>()
  for (const [index, entry] of raw.slice(0, MODULE_LIMITS.commands).entries()) {
    const at = `commands[${index}]`
    if (!isRecord(entry)) {
      context.fail(at, 'must be an object')
      continue
    }
    rejectUnknown(entry, ['name', 'summary', 'params', 'steps', 'access'], at, context.fail)
    if (entry.access !== undefined) {
      context.fail(`${at}.access`, 'not yours to declare — it is derived from the commands your steps call')
    }
    const name = text(entry.name, `${at}.name`, context.fail, MODULE_LIMITS.nameLength)
    if (name !== null) {
      if (id !== null && !name.startsWith(`${id}.`)) {
        context.fail(`${at}.name`, `must start with "${id}." so it cannot collide with a plugin command`)
      }
      if (!MODULE_COMMAND_NAME_PATTERN.test(name)) {
        context.fail(`${at}.name`, 'must be lowercase dotted/kebab names with no spaces')
      }
      if (/[A-Z]/.test(name)) context.fail(`${at}.name`, 'must be lowercase — SCREAMING_CASE names belong to the plugin')
      if (seen.has(name)) context.fail(`${at}.name`, `duplicated: "${name}"`)
      seen.add(name)
    }
    const summary = text(entry.summary, `${at}.summary`, context.fail, MODULE_LIMITS.textLength)
    const params = parseParams(entry.params, `${at}.params`, context)
    const steps = parseSteps(entry.steps, `${at}.steps`, context, params.map((param) => param.name))
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
  if (!Array.isArray(raw) || raw.length > MODULE_LIMITS.stateFields) {
    context.fail(path, `must be an array of at most ${MODULE_LIMITS.stateFields} parameter declarations`)
    return []
  }
  const params: UiCommandParam[] = []
  const seen = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const at = `${path}[${index}]`
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      context.fail(at, 'must be an object with a string name')
      continue
    }
    rejectUnknown(entry, ['name', 'required', 'type', 'shape', 'note', 'nested'], at, context.fail)
    if (!MODULE_SAFE_NAME_PATTERN.test(entry.name) || dangerousKey(entry.name)) {
      context.fail(`${at}.name`, 'must be a safe identifier')
      continue
    }
    if (seen.has(entry.name)) context.fail(`${at}.name`, `duplicated: "${entry.name}"`)
    seen.add(entry.name)
    if (entry.required !== undefined && typeof entry.required !== 'boolean') context.fail(`${at}.required`, 'must be a boolean')
    if (entry.nested !== undefined && typeof entry.nested !== 'boolean') context.fail(`${at}.nested`, 'must be a boolean')
    for (const key of ['type', 'shape', 'note'] as const) {
      if (entry[key] !== undefined && typeof entry[key] !== 'string') context.fail(`${at}.${key}`, 'must be a string')
    }
    params.push({
      name: entry.name,
      required: entry.required === true,
      ...(typeof entry.type === 'string' ? { type: entry.type } : {}),
      ...(typeof entry.shape === 'string' ? { shape: entry.shape } : {}),
      ...(typeof entry.note === 'string' ? { note: entry.note } : {}),
      ...(entry.nested === true ? { nested: true } : {}),
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

export function moduleStateValueError(field: ModuleStateField, value: unknown): string | null {
  if (typeof value !== field.type) return `must be ${field.type}`
  if (field.type === 'number' && typeof value === 'number') {
    if (!Number.isFinite(value)) return 'must be a finite number'
    if (field.min !== undefined && value < field.min) return `must be >= ${field.min}`
    if (field.max !== undefined && value > field.max) return `must be <= ${field.max}`
  }
  return null
}

export function conditionMatches(condition: ModuleCondition | undefined, scope: Record<string, unknown>): boolean {
  if (!condition) return true
  let value: unknown = scope
  for (const part of condition.from.split('.')) {
    if (dangerousKey(part) || !isRecord(value) || !Object.prototype.hasOwnProperty.call(value, part)) {
      value = undefined
      break
    }
    value = value[part]
  }
  if ('equals' in condition) return Object.is(value, condition.equals)
  if ('notEquals' in condition) return !Object.is(value, condition.notEquals)
  if ('oneOf' in condition) return condition.oneOf.some((candidate) => Object.is(value, candidate))
  if ('truthy' in condition) return Boolean(value) === condition.truthy
  return (value !== undefined) === condition.exists
}

/* ----------------------------------------------------------------- helpers */


const isScalar = (value: unknown): value is ModuleScalar =>
  typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean'

const UNSAFE_KEYS: Readonly<Record<string, boolean>> = {
  ['__proto__']: true,
  ['constructor']: true,
  ['prototype']: true,
}

function dangerousKey(key: string): boolean {
  return UNSAFE_KEYS[key] === true
}

function rejectUnknown(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  fail: Context['fail'],
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key) || dangerousKey(key)) {
      fail(path ? `${path}.${key}` : key, dangerousKey(key) ? 'unsafe object key' : 'unknown property')
    }
  }
}

function text(value: unknown, path: string, fail: Context['fail'], max: number = MODULE_LIMITS.textLength): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(path, 'must be a non-empty string')
    return null
  }
  if (value.length > max) {
    fail(path, `must be at most ${max} characters`)
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
