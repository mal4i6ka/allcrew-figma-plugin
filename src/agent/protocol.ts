/**
 * Agent listener — wire protocol and gating. Pure: no `figma`, no I/O, so the rules that
 * decide what an agent is allowed to do are unit-testable on their own.
 *
 * The channel is deliberately *not* MCP. A CLI agent talks plain HTTP to a local bridge
 * (agent/bridge.js); the bridge hands requests to whichever plugin instance is polling it.
 * Shape of one exchange:
 *
 *     { id, op: 'page.frames', params: { pageId } }   →  plugin
 *     { id, ok: true, result: [...] }                 ←  plugin
 *
 * `op` names are namespaced `subject.verb` so the manifest reads like an API surface rather
 * than the flat SCREAMING_CASE the UI↔sandbox channel uses.
 */

/* ------------------------------------------------------------------ params */

export type ParamType = 'string' | 'number' | 'boolean' | 'string[]' | 'json'

export interface ParamSpec {
  type: ParamType
  description: string
  /** Missing/undefined is an error when true. Otherwise `default` (or `undefined`) is used. */
  required?: boolean
  default?: unknown
  /** For `string` params: the only accepted values. Surfaced in the manifest so an agent can
   * pick without guessing. */
  enum?: readonly string[]
  /** For `number` params. */
  min?: number
  max?: number
}

export type ParamSpecs = Readonly<Record<string, ParamSpec>>

/* --------------------------------------------------------------------- ops */

export interface OpDef {
  /** `subject.verb`, e.g. `node.get`. */
  name: string
  /** One line, shown by `altery-figma ops`. This is what an agent reads to choose an op. */
  summary: string
  /** True when the op writes to the document. Gated separately from reads — see `authorize`. */
  mutates: boolean
  /** One or two sentences of usage guidance for the paste-once skill. Lives ON the op so the
   * "Teach the agent" text regenerates whole: an op that ships without its own documentation
   * is an op the agent will misuse — write ops are REQUIRED to carry this (enforced by test). */
  agent?: string
  params: ParamSpecs
  run: (params: Record<string, unknown>) => Promise<unknown>
}

/** The `run`-less projection served over the wire as the ops manifest. */
export interface OpManifestEntry {
  name: string
  summary: string
  mutates: boolean
  agent?: string
  params: Record<string, ParamSpec>
}

export function toManifest(ops: readonly OpDef[]): OpManifestEntry[] {
  return ops.map((op) => ({
    name: op.name,
    summary: op.summary,
    ...(op.agent ? { agent: op.agent } : {}),
    mutates: op.mutates,
    params: { ...op.params },
  }))
}

/* ------------------------------------------------------------------- gates */

/** What the designer has switched on in Settings → Agent listener, for THIS file. */
export interface AgentGates {
  read: boolean
  write: boolean
}

export type Authorization = { ok: true } | { ok: false; error: string }

/**
 * Both gates are opt-in and independent of each other: reading a file is already a
 * disclosure, so `read` is a real switch rather than an always-on default, and `write` never
 * rides along with it.
 */
export function authorize(op: OpDef | undefined, gates: AgentGates): Authorization {
  if (!op) return { ok: false, error: 'unknown op' }
  if (op.mutates) {
    if (!gates.write) return { ok: false, error: 'writes are off — enable "Allow changes" in the plugin' }
    return { ok: true }
  }
  if (!gates.read) return { ok: false, error: 'reads are off — enable "Allow reads" in the plugin' }
  return { ok: true }
}

/* -------------------------------------------------------------- validation */

export class ParamError extends Error {}

/**
 * Coerces and checks one call's params against a spec. Agents send JSON typed by hand, so
 * this is the only thing between a typo and a confusing failure deep inside an op — the
 * message names the param and what it expected.
 */
export function validateParams(
  specs: ParamSpecs,
  raw: unknown
): Record<string, unknown> {
  const input: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

  for (const key of Object.keys(input)) {
    if (!(key in specs)) {
      throw new ParamError(`unknown param "${key}" — accepted: ${Object.keys(specs).join(', ') || '(none)'}`)
    }
  }

  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(specs)) {
    const value = input[key]
    if (value === undefined || value === null) {
      if (spec.required) throw new ParamError(`missing required param "${key}" (${spec.type})`)
      if (spec.default !== undefined) out[key] = spec.default
      continue
    }
    out[key] = coerce(key, spec, value)
  }
  return out
}

function coerce(key: string, spec: ParamSpec, value: unknown): unknown {
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') throw new ParamError(`param "${key}" must be a string`)
      if (spec.enum && !spec.enum.includes(value)) {
        throw new ParamError(`param "${key}" must be one of: ${spec.enum.join(', ')}`)
      }
      return value
    }
    case 'number': {
      const num = typeof value === 'string' ? Number(value) : value
      if (typeof num !== 'number' || !Number.isFinite(num)) {
        throw new ParamError(`param "${key}" must be a number`)
      }
      if (spec.min !== undefined && num < spec.min) throw new ParamError(`param "${key}" must be >= ${spec.min}`)
      if (spec.max !== undefined && num > spec.max) throw new ParamError(`param "${key}" must be <= ${spec.max}`)
      return num
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value
      if (value === 'true') return true
      if (value === 'false') return false
      throw new ParamError(`param "${key}" must be a boolean`)
    }
    case 'string[]': {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new ParamError(`param "${key}" must be an array of strings`)
      }
      return value as string[]
    }
    // Batch writes and board specs are trees, not scalars. Nothing to coerce — the op that
    // asked for the tree is the only thing that knows its shape, so it does its own checking
    // and reports failures per entry instead of losing the whole batch to one bad row.
    case 'json': {
      if (typeof value !== 'object') throw new ParamError(`param "${key}" must be a JSON object or array`)
      return value
    }
  }
}
