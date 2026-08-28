/**
 * Running a module's steps.
 *
 * A module command is a short pipeline over commands the plugin already has: call one, keep its
 * answer, move a value, stop and ask. That is the whole of v1 — see `TASK-user-modules.md` for
 * why it composes rather than computes.
 *
 * Nothing here touches Figma. The caller injects `call`, which is how the plugin's own message
 * handler gets invoked, and `record`, which hands back what that call posted. Both are one
 * function each, so the interesting part — what happens when a step fails, what a later step is
 * allowed to read, when a confirmation is required — is testable without a document.
 *
 * Two rules the pipeline enforces that a caller should not have to:
 *
 * - **A failed step stops the run.** A command answering `*_ERROR` or `COMMAND_REFUSED` is a
 *   failure, and continuing would run the *next* step against a result that never arrived.
 * - **A confirmation is a stop, not a warning.** The steps after it do not run until the caller
 *   comes back having said yes, and the report says exactly where it stopped.
 */

import type { ModuleCommand, ModuleStep, UserModule } from './contract.ts'

export interface ModuleRunContext {
  /** Sends one message into the plugin's own handler and resolves when it has been served. */
  call: (message: Record<string, unknown>) => Promise<void>
  /** Records what a single call posted back. The runner reads the last reply as the answer. */
  record: (work: () => Promise<void>) => Promise<unknown[]>
  /** Whether the caller has already agreed to whatever the steps warn about. */
  confirmed?: boolean
  /**
   * What the module has kept from earlier runs, if the caller has it.
   *
   * Omitted, every run starts from the declared defaults — which is right for a fresh install
   * and wrong for a module whose whole point is remembering the key somebody typed once. A
   * stored value of the wrong type is ignored in favour of the default rather than trusted.
   */
  state?: Record<string, unknown>
}

export interface ModuleStepReport {
  step: number
  call?: string
  ok: boolean
  error?: string
}

export interface ModuleRunReport {
  command: string
  module: string
  ok: boolean
  steps: ModuleStepReport[]
  /** The declared state as the run left it — the caller decides whether to persist it. */
  state: Record<string, unknown>
  /**
   * What each step kept under its `as` name.
   *
   * Not persisted, and deliberately separate from `state`: this is what a screen renders a
   * table from — hundreds of rows of it — while state is the handful of scalars a module is
   * allowed to remember. Keeping the two apart is what stops a plan ending up in storage.
   */
  view: Record<string, unknown>
  /** Set when a `confirm` step stopped the run. Re-run with `confirmed` to get past it. */
  needsConfirmation?: string
  error?: string
}

/** A reply that means the command did not do what was asked. */
const isFailure = (reply: unknown): reply is Record<string, unknown> => {
  if (typeof reply !== 'object' || reply === null) return false
  const type = (reply as { type?: unknown }).type
  return typeof type === 'string' && (type.endsWith('_ERROR') || type === 'COMMAND_REFUSED')
}

const messageOf = (reply: Record<string, unknown>): string =>
  String(reply.reason ?? reply.message ?? JSON.stringify(reply).slice(0, 200))

export async function runModuleCommand(
  module: UserModule,
  command: ModuleCommand,
  params: Record<string, unknown>,
  context: ModuleRunContext
): Promise<ModuleRunReport> {
  // State first, then this call's params on top: a param named like a state field is that
  // field for the length of the run, and nothing a step writes escapes into the next call
  // unless the caller persists what the report hands back.
  const scope: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(module.state)) {
    const kept = context.state?.[name]
    scope[name] = typeof kept === field.type ? kept : field.default
  }
  Object.assign(scope, params)

  const report: ModuleRunReport = { command: command.name, module: module.id, ok: true, steps: [], state: {}, view: {} }

  for (const [index, step] of command.steps.entries()) {
    if ('confirm' in step) {
      if (context.confirmed) {
        // Recorded rather than passed over: "this run went through a confirmation" is part of
        // what happened, and a report with a step missing from it is a report with a gap.
        report.steps.push({ step: index, ok: true })
        continue
      }
      report.ok = false
      report.needsConfirmation = step.confirm
      report.steps.push({ step: index, ok: false, error: 'stopped for confirmation' })
      return finish(report, module, scope)
    }

    if ('set' in step) {
      const value = resolve(step.from, scope)
      if (value === MISSING) {
        return fail(report, module, scope, index, undefined, `nothing to read at "${step.from}"`)
      }
      // The declared type is a promise to whoever renders the field and to whoever reads the
      // storage next time. A path that turns out to hold something else is an authoring
      // mistake — `plan.rows` is the rows, `plan.total` is how many — and storing it anyway
      // would put a 560-entry array in a field declared as a number, and then keep it.
      const declared = module.state[step.set]
      if (declared && typeof value !== declared.type) {
        return fail(
          report,
          module,
          scope,
          index,
          undefined,
          `"${step.set}" is declared ${declared.type}, but "${step.from}" holds ${describeValue(value)}`
        )
      }
      scope[step.set] = value
      report.steps.push({ step: index, ok: true })
      continue
    }

    const resolved = resolveParams(step, scope)
    if ('error' in resolved) {
      return fail(report, module, scope, index, step.call, resolved.error)
    }

    let replies: unknown[]
    try {
      replies = await context.record(() => context.call({ ...resolved.params, type: step.call }))
    } catch (error) {
      return fail(report, module, scope, index, step.call, String((error as Error)?.message || error))
    }

    const failure = replies.find(isFailure)
    if (failure) {
      return fail(report, module, scope, index, step.call, messageOf(failure))
    }

    // The answer is the last thing the command said: these post progress first and their result
    // last, so a step that keeps "the reply" keeps the one worth reading.
    if (step.as) {
      scope[step.as] = replies.length > 0 ? replies[replies.length - 1] : null
      report.view[step.as] = scope[step.as]
    }
    report.steps.push({ step: index, call: step.call, ok: true })
  }

  return finish(report, module, scope)
}

function finish(report: ModuleRunReport, module: UserModule, scope: Record<string, unknown>): ModuleRunReport {
  // Only declared fields come back: a step's `as` name is scratch space for the run, not
  // something the module gets to keep in storage.
  for (const name of Object.keys(module.state)) report.state[name] = scope[name]
  return report
}

function fail(
  report: ModuleRunReport,
  module: UserModule,
  scope: Record<string, unknown>,
  step: number,
  call: string | undefined,
  error: string
): ModuleRunReport {
  report.ok = false
  report.error = `step ${step}${call ? ` (${call})` : ''}: ${error}`
  report.steps.push({ step, ...(call ? { call } : {}), ok: false, error })
  return finish(report, module, scope)
}

/* -------------------------------------------------------------- references */

/** Distinct from `undefined`, which is a value a reply can legitimately hold. */
const MISSING = Symbol('missing')

/** Enough of what arrived to see the mistake without printing the whole reply back. */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `an array of ${value.length}`
  if (value === null) return 'null'
  if (typeof value === 'object') return `an object with ${Object.keys(value).length} key(s)`
  return `${typeof value} ${JSON.stringify(value)?.slice(0, 40)}`
}

function resolveParams(
  step: Extract<ModuleStep, { call: string }>,
  scope: Record<string, unknown>
): { params: Record<string, unknown> } | { error: string } {
  const params: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(step.params ?? {})) {
    const resolved = resolveValue(value, scope)
    if (typeof resolved === 'object' && resolved !== null && MISSING_PATH in resolved) {
      return { error: `nothing to read at "${(resolved as { [MISSING_PATH]: string })[MISSING_PATH]}" for ${key}` }
    }
    params[key] = resolved
  }
  return { params }
}

/**
 * A value with its references filled in, at any depth.
 *
 * Nested on purpose: the params these commands take are objects — `source` is
 * `{ kind: 'library', key: … }` — and a module's state holds scalars, so the only way a form
 * field can reach the inside of one is for the substitution to go all the way down. Resolving
 * only the top level made every object-shaped param a literal baked into the file.
 */
function resolveValue(value: unknown, scope: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const resolved = resolveValue(entry, scope)
      if (typeof resolved === 'object' && resolved !== null && MISSING_PATH in resolved) return resolved
      value = Object.assign([...(value as unknown[])], { [index]: resolved })
    }
    return value
  }
  if (typeof value !== 'object' || value === null) return value

  const record = value as Record<string, unknown>
  if (typeof record.from === 'string') {
    const found = resolve(record.from, scope)
    return found === MISSING ? { [MISSING_PATH]: record.from } : found
  }

  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    const resolved = resolveValue(entry, scope)
    if (typeof resolved === 'object' && resolved !== null && MISSING_PATH in resolved) return resolved
    out[key] = resolved
  }
  return out
}

/** Carries an unresolvable path back up without throwing through the recursion. */
const MISSING_PATH = Symbol('missing-path')

/** A dotted path into the scope. No indices, no expressions — see the contract. */
function resolve(path: string, scope: Record<string, unknown>): unknown | typeof MISSING {
  let current: unknown = scope
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(part in (current as Record<string, unknown>))) {
      return MISSING
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
