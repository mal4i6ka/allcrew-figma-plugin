/**
 * Agent listener — failures an agent can act on without reading English.
 *
 * Every way this channel can refuse used to arrive as `HTTP 400 { ok: false, error: "<prose>" }`.
 * The prose is good — it names the switch to flip, the roster to choose from, the environment
 * variable to raise — but it is the wrong shape for the one consumer that matters most here: a
 * generating agent deciding what to do next. "reads are off" means *ask a human and retry*;
 * "unknown op" means *never retry, pick a different op*; "no answer within 180s" means *retry as
 * is*; "writes are off — enable Allow changes" means *stop, the document is read-only*. Telling
 * those apart by regexing the message is not a policy, it is a guess that breaks the first time
 * someone improves the wording.
 *
 * So the code travels beside the prose, never instead of it. `retryable` is the one derived bit
 * worth precomputing, because it is the question every caller actually asks.
 *
 * `agent/bridge.mjs` carries the same table for the failures it raises itself — it is a
 * standalone, dependency-free script whose source is also inlined into `ui.html`, so it cannot
 * import this file. `errors.test.ts` asserts the two agree, which is the same trick the rest of
 * this channel uses to keep a hand-written table from drifting.
 */

export type AgentErrorCode =
  /* ---- the caller asked for something that does not exist or is malformed (never retry) ---- */
  /** No `op` in the request body. */
  | 'bad_request'
  /** The op name is not in the registry. A different op, or a newer plugin build. */
  | 'unknown_op'
  /** Params failed the op's own spec — missing, wrong type, out of range, unknown key. */
  | 'param_invalid'
  /** More than one file is connected and the call named none, or named one that is not there.
   * The answer carries the roster; choose from it. */
  | 'ambiguous_target'
  /** No route at that path on the bridge. */
  | 'no_route'
  /** A write addressed to every connected file at once. Refused by design. */
  | 'broadcast_write_refused'
  /** The answer was too big to survive the sandbox→UI hop or the bridge's body cap. Retrying
   * the same call produces the same size — narrow it (a budget, a page, a smaller subtree). */
  | 'payload_too_large'
  /** This op needs the plugin open and only the REST fallback was available. */
  | 'rest_unavailable'
  /* ------------ the caller is fine, the world is not (retry may well work) ------------ */
  /** Bad or missing shared secret. Retryable in the sense that fixing the secret fixes it. */
  | 'unauthorized'
  /** A gate the designer controls is off. A human flips it and the same call works. */
  | 'gate_closed'
  /** No plugin window is connected at all. */
  | 'no_plugin'
  /** The op ran and Figma (or the op) threw. Sometimes transient, sometimes not — the message
   * is the only thing that can tell, which is exactly why this code does not pretend to. */
  | 'figma_threw'
  /** The bridge stopped waiting. The op may still be running, and may already have committed:
   * a write that timed out has no safe automatic retry. */
  | 'timeout'
  /** The plugin window went away mid-call. */
  | 'disconnected'
  /** The plugin re-handshook mid-call — a gate toggle does this. */
  | 'reconnected'
  /** The designer switched the listener off. */
  | 'listener_off'
  /** The bridge could not write the files an op returned. */
  | 'file_write_failed'
  /** Something the bridge did not anticipate. */
  | 'internal'

/**
 * Whether issuing the SAME call again could plausibly succeed.
 *
 * Deliberately not "is this the caller's fault": `unauthorized` and `gate_closed` are both
 * retryable here because the retry is the correct next move once a human has acted, and an agent
 * that treats them as terminal gives up on a channel that is one click from working.
 *
 * `timeout` is retryable and that is a trap worth stating: the op may have committed. A caller
 * retrying a WRITE on a timeout must check the document first — nothing in the transport can
 * tell it whether the write landed.
 */
const RETRYABLE: ReadonlySet<AgentErrorCode> = new Set<AgentErrorCode>([
  'unauthorized',
  'gate_closed',
  'no_plugin',
  'figma_threw',
  'timeout',
  'disconnected',
  'reconnected',
  'listener_off',
  'file_write_failed',
  'internal',
])

export function isRetryable(code: AgentErrorCode): boolean {
  return RETRYABLE.has(code)
}

/** Every code, for the drift test and for anything that wants to enumerate them. */
export const AGENT_ERROR_CODES: readonly AgentErrorCode[] = [
  'bad_request',
  'unknown_op',
  'param_invalid',
  'ambiguous_target',
  'no_route',
  'broadcast_write_refused',
  'payload_too_large',
  'rest_unavailable',
  'unauthorized',
  'gate_closed',
  'no_plugin',
  'figma_threw',
  'timeout',
  'disconnected',
  'reconnected',
  'listener_off',
  'file_write_failed',
  'internal',
]

export interface AgentFailure {
  error: string
  code: AgentErrorCode
  retryable: boolean
}

/** A refusal in the shape every layer of this channel reports one. */
export function failure(code: AgentErrorCode, error: string): AgentFailure {
  return { error, code, retryable: isRetryable(code) }
}
