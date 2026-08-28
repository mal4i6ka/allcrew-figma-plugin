/**
 * The plugin's whole feature set, as two ops.
 *
 * Everything the panel can do, the sandbox already does — it just does it in answer to a
 * message from the iframe. `plugin.call` sends that same message from the agent side and
 * digests whatever comes back, so the colour-token remap, the exporters, the palette
 * generator, the linter's batch fix and the standardised old/new board are all reachable
 * without an op each. `plugin.commands` is how an agent finds out what exists.
 *
 * Three properties this deliberately keeps:
 *
 * - **The designer still sees it.** Replies are recorded on their way out, not intercepted:
 *   the panel receives them exactly as if a person had clicked the button, so the table
 *   redraws and the notification fires. A channel whose actions are invisible in the window is
 *   a channel nobody can supervise.
 * - **The gate still decides.** `plugin.call` is authorised per *command*, not once for the
 *   op: only commands the source marks `@agent read` pass on the read gate, and anything
 *   unmarked counts as a write (see `ui-commands.ts`).
 * - **The channel is not reachable through itself.** `AGENT_*` commands are refused
 *   structurally — the message that sets the gates is the designer's switch, and an op able to
 *   flip it would make both gates decorative.
 */

import type { OpDef } from './protocol.ts'
import { UI_COMMANDS, type UiCommandDef } from './ui-commands.ts'
import { DEFAULT_DIGEST_BUDGET, digestReplies } from './reply-digest.ts'
import { beginRecording, endRecording } from './ui-post.ts'

export type UiMessageRunner = (message: Record<string, unknown>) => Promise<void> | void

let runner: UiMessageRunner | null = null

/** Wired by `code.ts`, which owns the handler. Injected rather than imported: the handler
 * imports this registry, so reaching back for it directly would be a cycle. */
export function setUiMessageRunner(next: UiMessageRunner | null): void {
  runner = next
}

/**
 * The user modules this build has installed, if any.
 *
 * A getter rather than a list: modules are read from storage after the plugin opens and change
 * whenever one is installed or removed, and a snapshot taken at registration time would answer
 * for a plugin that no longer exists. `run` executes one of their commands; everything else
 * about how a module works stays on the other side of this seam.
 */
export interface ModuleProvider {
  commands: () => readonly UiCommandDef[]
  run: (name: string, params: Record<string, unknown>) => Promise<unknown>
}

let modules: ModuleProvider | null = null

export function setModuleProvider(next: ModuleProvider | null): void {
  modules = next
}

const moduleCommands = (): readonly UiCommandDef[] => {
  try {
    return modules?.commands() ?? []
  } catch {
    // A registry that throws must not take the whole surface down with it: the native half is
    // still perfectly callable.
    return []
  }
}

export function commandNameOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const command = (raw as Record<string, unknown>).command
  return typeof command === 'string' ? command : null
}

/* ----------------------------------------------------------------------- capture */

interface Capture {
  replies: unknown[]
  /** True when we stopped waiting. The command is still running in the sandbox — we cannot
   * cancel it — but the channel is not held hostage by it. */
  timedOut: boolean
}

/** Under the bridge's own 180s call timeout, so a wedged command answers here first and says
 * what happened, instead of the agent reading "no answer from the plugin". */
export const DEFAULT_CALL_TIMEOUT_MS = 150_000

/**
 * Records what the sandbox posts to the UI while `run` is in flight.
 *
 * The recording lives in `ui-post.ts`, which every reply already goes through, because the
 * runtime will not have its objects patched: wrapping `figma.ui.postMessage` for the duration
 * of a call was the first design and Figma's sandbox refused it outright.
 */
async function withCapture(run: () => Promise<void>, timeoutMs: number): Promise<Capture> {
  const replies = beginRecording()

  // A command that waits on something only a human can do would otherwise hold the one-at-a-
  // time queue for the rest of the session — every later call blocked by one wedged one. So we
  // stop waiting, hand back what was said so far, and let the orphan finish on its own: its
  // messages still reach the panel, they are simply no longer recorded, or attributed to
  // whoever calls next.
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve()
    }, timeoutMs)
  })

  try {
    await Promise.race([
      run().catch((error) => {
        if (timedOut) {
          // Nobody is waiting on this any more; swallowing it here is what keeps an abandoned
          // command from surfacing as an unhandled rejection minutes later.
          console.warn('[agent] plugin command failed after it was abandoned', error)
          return
        }
        throw error
      }),
      deadline,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Closed with the array it opened, so an abandoned call cannot silence the recording of
    // whichever call the queue has moved on to.
    endRecording(replies)
  }
  return { replies, timedOut }
}

/** One call at a time. Two overlapping calls would each record the other's replies, and the
 * commands themselves share main-thread state — the remap inventory, the scan index — that was
 * only ever written by a single clicking human. */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

/* --------------------------------------------------------------------------- ops */

/**
 * Built from a registry rather than reading the module-level one, so the ops can be exercised
 * against a known command table. Production uses the default: whatever `build.mjs` extracted
 * from `code.ts` for this bundle.
 */
export function pluginOps(commands: readonly UiCommandDef[] = UI_COMMANDS): readonly OpDef[] {
  // Native first, then whatever modules are installed right now. Read on every call rather than
  // captured: a module installed a minute ago is callable a minute ago, and one removed is gone.
  // A module cannot shadow a native command — the contract namespaces its names — so the native
  // half always wins a collision anyway.
  const all = (): readonly UiCommandDef[] => [...commands, ...moduleCommands()]
  const lookup = (name: string): UiCommandDef | undefined =>
    commands.find((command) => command.name === name) ?? moduleCommands().find((command) => command.name === name)

  /** Never callable through the channel, whatever the source says. */
  const deniedReason = (command: string): string | null => {
    if (command.startsWith('AGENT_')) {
      return "the listener's own messages are not callable through the listener — the gates are the designer's switch, and AGENT_REQUEST would only recurse"
    }
    const def = lookup(command)
    if (def?.access === 'deny') return def.summary || 'this command is marked unavailable to agents'
    return null
  }

  /** A command is a read only when the source says so in as many words. Anything else — an
   * unmarked case, a command this build does not know, a malformed request — is a write, so a
   * mutation can never arrive on the read gate. */
  const mutatesWhen = (raw: unknown): boolean => {
    const command = commandNameOf(raw)
    if (!command) return true
    // The structural refusal outranks the table. A command table that mislabelled
    // `AGENT_SET_GATES` as a read would otherwise get it authorised on the read gate — refused
    // a moment later by `run`, but authorised, and one layer should not depend on the next.
    if (deniedReason(command)) return true
    return lookup(command)?.access !== 'read'
  }

  const describe = (command: UiCommandDef): Record<string, unknown> => ({
    command: command.name,
    access: deniedReason(command.name) ? 'deny' : command.access,
    ...(command.summary ? { summary: command.summary } : {}),
    // What the call costs, where that is surprising — the difference between the two paths to
    // this plugin's variables is 0.5s and 90s, and nothing else in the surface says so.
    ...(command.cost ? { cost: command.cost } : {}),
    ...(command.classified ? {} : { classified: false }),
    // Whose command this is. A caller deciding whether to trust one wants to know it came from
    // a file somebody installed rather than from the build.
    ...(command.module ? { module: command.module } : {}),
    params: command.params,
    replies: command.replies,
  })

  return [
    {
      name: 'plugin.commands',
      summary: "Every command the plugin's own panel can run, and which of them need the write gate.",
      mutates: false,
      agent:
        'The plugin is much bigger than this op list: colour-token remap, token export, palette generation, ' +
        'lint fixes, the old/new board. Call this first, then drive any of it with `plugin.call`. `params` says ' +
        'what each command accepts and which keys are required; `replies` the message types to expect back.',
      params: {
        command: {
          type: 'string',
          description: 'One command to describe, instead of the whole list.',
        },
      },
      async run(params) {
        const wanted = params.command as string | undefined
        if (wanted) {
          const def = lookup(wanted)
          if (!def) throw new Error(`unknown command "${wanted}" — call plugin.commands with no params for the list`)
          return describe(def)
        }
        const listed = all()
        const fromModules = listed.filter((command) => command.module).length
        return {
          count: listed.length,
          // Zero means the bundle was built without the extraction step — say so, rather than
          // let an agent conclude the plugin has no features.
          ...(commands.length === 0
            ? { warning: 'this build shipped without its command table — rebuild the plugin (npm run build)' }
            : {}),
          // Named separately because the two halves age differently: one ships with the build,
          // the other was installed by whoever is using it.
          ...(fromModules > 0 ? { fromModules } : {}),
          commands: listed.map(describe),
        }
      },
    },

    {
      name: 'plugin.call',
      summary: "Run one of the plugin panel's own commands — the whole feature set, not just the ops.",
      mutates: true,
      mutatesWhen,
      agent:
        'Runs a panel command as if the designer had clicked it, and returns the replies it posted. Discover ' +
        'commands with `plugin.commands`; pass that command\'s own keys in `params` (e.g. ' +
        '{"command":"REMAP_PREVIEW","params":{"source":{"kind":"paste","text":"#0EA5E9"}}}). Multi-step features ' +
        'keep state in the sandbox between calls, so follow their panel order — REMAP_SCAN before REMAP_PREVIEW ' +
        'before REMAP_APPLY. Long strings come back as files on disk rather than inline. The designer\'s panel ' +
        'receives every reply too, so it redraws, and may finish UI-side work such as building a zip.',
      params: {
        command: {
          type: 'string',
          required: true,
          description: 'The command name, e.g. REMAP_SCAN. See plugin.commands.',
        },
        params: {
          type: 'json',
          description: "The rest of the message: exactly the keys that command's `params` lists.",
        },
        keep: {
          type: 'number',
          default: DEFAULT_DIGEST_BUDGET.keep,
          min: 0,
          max: 20_000,
          description: 'Characters of a long string kept inline before it spills to a file.',
        },
        timeoutMs: {
          type: 'number',
          default: DEFAULT_CALL_TIMEOUT_MS,
          min: 1_000,
          max: 600_000,
          description: 'How long to wait for the command before answering with what it said so far.',
        },
      },
      async run(params) {
        const command = params.command as string
        if (!runner) throw new Error('the plugin has not registered its message handler — reopen the plugin')

        const denied = deniedReason(command)
        if (denied) throw new Error(`"${command}" is not available through the channel: ${denied}`)

        const def = lookup(command)
        if (!def && commands.length > 0) {
          throw new Error(`unknown command "${command}" — call plugin.commands for the list`)
        }

        const extra = (params.params ?? {}) as Record<string, unknown>
        if (Array.isArray(extra)) throw new Error('param "params" must be a JSON object, not an array')
        if ('type' in extra) throw new Error('param "params" must not carry "type" — that is what "command" is')

        const missing = def ? def.params.filter((param) => param.required && !(param.name in extra)) : []
        if (missing.length > 0) {
          // Refused rather than run: a command handed no `source` posts its own error reply,
          // and the agent then reads a digest of a failure it could have been told about.
          throw new Error(
            `"${command}" needs ${missing.map((param) => param.name + (param.type ? `: ${param.type}` : '')).join(', ')}`
          )
        }
        const ignored = def ? Object.keys(extra).filter((key) => !def.params.some((param) => param.name === key)) : []

        const started = Date.now()
        // A module command is a pipeline over these same commands, so it runs through the same
        // recording, the same one-at-a-time queue and the same timeout — the only difference is
        // who decides which messages get sent.
        let moduleReport: unknown
        const capture = await serialize(() =>
          withCapture(async () => {
            if (def?.module) moduleReport = await modules!.run(command, extra)
            else await runner!({ ...extra, type: command })
          }, params.timeoutMs as number)
        )
        // A command that declined names the precondition it wanted (`COMMAND_REFUSED`, see
        // `refuse` in code.ts). On its own that is not a result to read — it is a failed call,
        // and an agent should not have to notice a reply type to find that out.
        const refusal = capture.replies.find(
          (reply): reply is { type: string; reason?: unknown } =>
            typeof reply === 'object' && reply !== null && (reply as { type?: unknown }).type === 'COMMAND_REFUSED'
        )
        if (refusal && capture.replies.length === 1) {
          throw new Error(`"${command}" declined: ${String(refusal.reason ?? 'no reason given')}`)
        }

        const digest = digestReplies(capture.replies, { ...DEFAULT_DIGEST_BUDGET, keep: params.keep as number })

        return {
          command,
          access: def?.access ?? 'write',
          ...(def?.module ? { module: def.module } : {}),
          // The pipeline's own account of itself: which step ran, which one stopped it, and
          // whether it is waiting on a yes. The replies below are what those steps *said*; this
          // is what the module *did*.
          ...(moduleReport ? { run: moduleReport } : {}),
          ...(def && !def.classified ? { classified: false } : {}),
          ms: Date.now() - started,
          replies: digest.replies,
          ...(digest.collapsed ? { collapsed: digest.collapsed } : {}),
          ...(digest.files ? { files: digest.files } : {}),
          ...(digest.truncated ? { truncated: true } : {}),
          // A refusal alongside other replies is a partial run, not a failed call — it stays in
          // the digest and is flagged rather than thrown.
          ...(refusal ? { refused: String(refusal.reason ?? 'no reason given') } : {}),
          ...(ignored.length > 0 ? { ignoredParams: ignored } : {}),
          ...(capture.timedOut
            ? {
                stillRunning: true,
                note:
                  `stopped waiting after ${params.timeoutMs}ms — the command is still running in the plugin. Its ` +
                  'remaining replies are no longer attributed to this call: they reach the panel, and one arriving ' +
                  'mid-way through a later call can show up in that call\'s replies. Check the result with a ' +
                  'follow-up read rather than repeating this command.',
              }
            : digest.replies.length === 0
              ? { note: 'the command posted no reply — some only store a setting, and answer nothing' }
              : {}),
        }
      },
    },
  ]
}

export const PLUGIN_OPS: readonly OpDef[] = pluginOps()
