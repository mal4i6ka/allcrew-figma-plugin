/**
 * Agent listener — main-thread dispatcher.
 *
 * The UI iframe owns the transport (it long-polls the bridge; the sandbox has `fetch` but no
 * socket, and keeping the poll out here also keeps the main thread free). Everything that
 * decides *whether* a request runs lives here instead, so the gate can't be talked around by
 * anything running in the iframe.
 */

import { authorize, toManifest, validateParams, type AgentGates, type OpManifestEntry } from './protocol.ts'
import { ALL_OPS, OPS_BY_NAME } from './ops.ts'
import { postToUi } from './ui-post.ts'
import { takeLoading } from './loading.ts'

export interface AgentRequest {
  id: string
  op: string
  params?: unknown
}

export interface AgentResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
  /** Pages this call had to wait for Figma to load, and how long each took. Absent when
   * nothing was cold - see `loading.ts` for why a wait needs saying out loud. */
  loading?: Array<{ page: string; ms: number }>
}

/** Both off until the designer says otherwise, every time the plugin opens. Gate state is
 * persisted in export options for convenience, but the dispatcher only ever trusts what the
 * UI has explicitly pushed into `setGates` this session. */
let gates: AgentGates = { read: false, write: false }

export function setGates(next: Partial<AgentGates>): AgentGates {
  gates = { read: next.read === true, write: next.write === true }
  return gates
}

export function currentGates(): AgentGates {
  return gates
}

/** Everything the channel can do, reads and writes alike. The manifest is a description, not
 * a permission: `authorize` still refuses a mutating op while the write gate is off, so an
 * agent can see what exists and be told plainly why it is unavailable. */
export function agentManifest(): OpManifestEntry[] {
  return toManifest(ALL_OPS)
}

export async function handleAgentRequest(request: AgentRequest): Promise<AgentResponse> {
  const started = Date.now()
  const op = OPS_BY_NAME.get(request.op)

  // The raw params, not the validated ones: an op like `plugin.call` is a read or a write
  // depending on what it was asked to run, and that has to be decided before anything runs.
  const permitted = authorize(op, gates, request.params)
  if (!permitted.ok) {
    report(request.op, false, Date.now() - started, permitted.error)
    return { id: request.id, ok: false, error: permitted.error }
  }

  try {
    const params = validateParams(op!.params, request.params)
    const result = await op!.run(params)
    report(request.op, true, Date.now() - started)
    /* A call that spent half a minute waiting for Figma to load a page looks, from the other
     * side of the bridge, exactly like a call that hung. It is not, and the difference decides
     * what the caller does next: wait, or go looking for a broken channel. */
    const loading = takeLoading()
    return {
      id: request.id,
      ok: true,
      result: loading && result && typeof result === 'object' && !Array.isArray(result)
        ? { ...(result as Record<string, unknown>), loading }
        : result,
      ...(loading ? { loading } : {}),
    }
  } catch (err) {
    const message = String((err as Error)?.message || err)
    report(request.op, false, Date.now() - started, message)
    const loading = takeLoading()
    return { id: request.id, ok: false, error: message, ...(loading ? { loading } : {}) }
  }
}

/** Every agent call shows up in the plugin window. A channel a designer can't watch is a
 * channel they can't sensibly consent to. */
function report(op: string, ok: boolean, ms: number, error?: string): void {
  postToUi({ type: 'AGENT_ACTIVITY', op, ok, ms, error })
}
