import test from 'node:test'
import assert from 'node:assert/strict'

/* The stub stands in for the panel: `postToUi` forwards to it, so a test can assert the
 * designer still sees everything the agent triggered. */
const panel: unknown[] = []
;(globalThis as { figma?: unknown }).figma = {
  ui: {
    postMessage(message: unknown) {
      panel.push(message)
    },
  },
}

const { pluginOps, setUiMessageRunner, setModuleProvider, commandNameOf } = await import('./plugin-ops.ts')
const { postToUi, isRecording } = await import('./ui-post.ts')
const { authorize } = await import('./protocol.ts')
import type { UiCommandDef } from './ui-commands.ts'

const REGISTRY: UiCommandDef[] = [
  {
    name: 'PURE_READ',
    access: 'read',
    classified: true,
    summary: 'answers without writing',
    params: [{ name: 'depth', required: false, type: 'string' }],
    replies: ['PURE_ANSWER'],
  },
  {
    name: 'REAL_WRITE',
    access: 'write',
    classified: true,
    summary: 'writes the document',
    params: [{ name: 'source', required: true, type: 'Source' }],
    replies: ['WRITE_DONE'],
  },
  {
    name: 'UNMARKED',
    access: 'write',
    classified: false,
    params: [],
    replies: [],
  },
  {
    name: 'FORBIDDEN',
    access: 'deny',
    classified: true,
    summary: 'never through the channel',
    params: [],
    replies: [],
  },
]

const OPS = pluginOps(REGISTRY)
const call = OPS.find((op) => op.name === 'plugin.call')!
const list = OPS.find((op) => op.name === 'plugin.commands')!

function runner(handled: Array<Record<string, unknown>>, replies: unknown[] = []) {
  return async (message: Record<string, unknown>) => {
    handled.push(message)
    for (const reply of replies) postToUi(reply)
  }
}

test.beforeEach(() => {
  panel.length = 0
  setUiMessageRunner(null)
})

/* ------------------------------------------------------------------- discovery */

test('plugin.commands lists the whole panel surface, deny included', () => {
  const result = list.run({}) as unknown as Promise<{ count: number; commands: Array<Record<string, unknown>> }>
  return result.then((value) => {
    assert.equal(value.count, 4)
    assert.deepEqual(
      value.commands.map((command) => [command.command, command.access]),
      [
        ['PURE_READ', 'read'],
        ['REAL_WRITE', 'write'],
        ['UNMARKED', 'write'],
        ['FORBIDDEN', 'deny'],
      ]
    )
    // An assumed classification is reported as one.
    assert.equal(value.commands[2].classified, false)
    assert.equal(value.commands[0].classified, undefined)
  })
})

test('plugin.commands describes one command, and refuses a name it does not have', async () => {
  const one = (await list.run({ command: 'REAL_WRITE' })) as Record<string, unknown>
  assert.equal(one.summary, 'writes the document')
  await assert.rejects(() => list.run({ command: 'NOPE' }), /unknown command "NOPE"/)
})

test('what a command costs reaches the caller', async () => {
  // Assembled field by field, so a field nobody passes through is a field nobody sees — this
  // shipped once with the cost extracted, stored, and dropped on the way out.
  const priced = pluginOps([
    { name: 'SLOW', access: 'read', classified: true, summary: 'reads', cost: '80-90s on a large file', params: [], replies: [] },
  ])
  const one = (await priced.find((op) => op.name === 'plugin.commands')!.run({ command: 'SLOW' })) as Record<string, unknown>
  assert.equal(one.cost, '80-90s on a large file')
})

test('a build with no command table says so instead of reporting no features', async () => {
  const empty = (await pluginOps([]).find((op) => op.name === 'plugin.commands')!.run({})) as Record<string, unknown>
  assert.equal(empty.count, 0)
  assert.match(String(empty.warning), /rebuild the plugin/)
})

/* ----------------------------------------------------------------------- gating */

test('the gate is decided per command, not once for the op', () => {
  const offline = { read: true, write: false }
  // A read passes on the read gate...
  assert.deepEqual(authorize(call, offline, { command: 'PURE_READ' }), { ok: true })
  // ...and everything else does not.
  assert.equal(authorize(call, offline, { command: 'REAL_WRITE' }).ok, false)
  assert.equal(authorize(call, offline, { command: 'UNMARKED' }).ok, false)
  assert.equal(authorize(call, offline, { command: 'NOT_IN_THIS_BUILD' }).ok, false)
  assert.equal(authorize(call, offline, {}).ok, false)
  assert.equal(authorize(call, offline, 'not even an object').ok, false)

  assert.deepEqual(authorize(call, { read: true, write: true }, { command: 'REAL_WRITE' }), { ok: true })
})

test('with both gates off even a read is refused', () => {
  assert.equal(authorize(call, { read: false, write: false }, { command: 'PURE_READ' }).ok, false)
})

test('the op still declares itself mutating, so a broadcast write cannot ride on it', () => {
  // The bridge refuses to fan a mutating op out to every open file; `plugin.call` must look
  // like what it can do at its most dangerous.
  assert.equal(call.mutates, true)
  assert.equal(list.mutates, false)
})

test('commandNameOf only trusts a string', () => {
  assert.equal(commandNameOf({ command: 'X' }), 'X')
  assert.equal(commandNameOf({ command: 7 }), null)
  assert.equal(commandNameOf(null), null)
})

/* ------------------------------------------------------------------- refusals */

test("the channel's own messages are refused whatever a registry claims", async () => {
  setUiMessageRunner(runner([]))
  const rogue = pluginOps([
    { name: 'AGENT_SET_GATES', access: 'read', classified: true, summary: 'lies', params: [], replies: [] },
  ]).find((op) => op.name === 'plugin.call')!

  await assert.rejects(() => rogue.run({ command: 'AGENT_SET_GATES', keep: 400 }), /not available through the channel/)
  // And it is a write as far as the gate is concerned, so the read gate never reaches it.
  assert.equal(authorize(rogue, { read: true, write: false }, { command: 'AGENT_SET_GATES' }).ok, false)
})

test('a command marked deny is refused with its reason', async () => {
  setUiMessageRunner(runner([]))
  await assert.rejects(() => call.run({ command: 'FORBIDDEN', keep: 400 }), /never through the channel/)
})

test('an unknown command is refused when the build knows its own surface', async () => {
  setUiMessageRunner(runner([]))
  await assert.rejects(() => call.run({ command: 'INVENTED', keep: 400 }), /unknown command "INVENTED"/)
})

test('a missing required param is refused before the command runs', async () => {
  const handled: Array<Record<string, unknown>> = []
  setUiMessageRunner(runner(handled))
  await assert.rejects(() => call.run({ command: 'REAL_WRITE', keep: 400 }), /needs source: Source/)
  assert.deepEqual(handled, [], 'the command must not have run')
})

test('params may not smuggle a type of their own', async () => {
  setUiMessageRunner(runner([]))
  await assert.rejects(
    () => call.run({ command: 'PURE_READ', params: { type: 'REAL_WRITE' }, keep: 400 }),
    /must not carry "type"/
  )
})

test('an array where an object belongs is refused', async () => {
  setUiMessageRunner(runner([]))
  await assert.rejects(() => call.run({ command: 'PURE_READ', params: [1, 2], keep: 400 }), /must be a JSON object/)
})

test('with no handler registered the op says what to do about it', async () => {
  await assert.rejects(() => call.run({ command: 'PURE_READ', keep: 400 }), /reopen the plugin/)
})

/* --------------------------------------------------------------------- calling */

test('the command runs with exactly the message a click would have sent', async () => {
  const handled: Array<Record<string, unknown>> = []
  setUiMessageRunner(runner(handled, [{ type: 'PURE_ANSWER', value: 42 }]))

  const result = (await call.run({ command: 'PURE_READ', params: { depth: 'page' }, keep: 400 })) as Record<string, unknown>

  assert.deepEqual(handled, [{ depth: 'page', type: 'PURE_READ' }])
  assert.deepEqual(result.replies, [{ type: 'PURE_ANSWER', value: 42 }])
  assert.equal(result.command, 'PURE_READ')
  assert.equal(result.access, 'read')
})

test('the designer sees every reply the agent caused', async () => {
  setUiMessageRunner(runner([], [{ type: 'PURE_ANSWER', value: 1 }, { type: 'PURE_ANSWER', value: 2 }]))
  await call.run({ command: 'PURE_READ', keep: 400 })

  // Recorded on the way out, not intercepted: a channel the panel cannot show is a channel
  // nobody can supervise.
  assert.deepEqual(panel, [{ type: 'PURE_ANSWER', value: 1 }, { type: 'PURE_ANSWER', value: 2 }])
})

test('the host method is never touched — the runtime refuses to have it patched', async () => {
  // The first design wrapped `figma.ui.postMessage` for the duration of a call. Figma's
  // sandbox refused both the assignment and defineProperty, so the recording moved into
  // `ui-post.ts`, which every reply already goes through.
  const before = figma.ui.postMessage
  setUiMessageRunner(runner([], [{ type: 'PURE_ANSWER' }]))
  await call.run({ command: 'PURE_READ', keep: 400 })
  assert.equal(figma.ui.postMessage, before)
})

test('the recording is closed even when the command throws', async () => {
  setUiMessageRunner(async () => {
    throw new Error('the command blew up')
  })
  await assert.rejects(() => call.run({ command: 'PURE_READ', keep: 400 }), /the command blew up/)
  // Left open, every later reply in the session would pile into a dead array.
  assert.equal(isRecording(), false)
})

test('a reply the command posts after it throws is not attributed to the next call', async () => {
  setUiMessageRunner(async () => {
    throw new Error('boom')
  })
  await assert.rejects(() => call.run({ command: 'PURE_READ', keep: 400 }))

  const handled: Array<Record<string, unknown>> = []
  setUiMessageRunner(runner(handled, [{ type: 'PURE_ANSWER', value: 'mine' }]))
  const result = (await call.run({ command: 'PURE_READ', keep: 400 })) as { replies: unknown[] }
  assert.deepEqual(result.replies, [{ type: 'PURE_ANSWER', value: 'mine' }])
})

test('a command that answers nothing is reported as such, not as an empty success', async () => {
  setUiMessageRunner(runner([]))
  const result = (await call.run({ command: 'PURE_READ', keep: 400 })) as Record<string, unknown>
  assert.deepEqual(result.replies, [])
  assert.match(String(result.note), /posted no reply/)
})

test('a param the command does not read is named rather than silently dropped', async () => {
  setUiMessageRunner(runner([]))
  const result = (await call.run({ command: 'PURE_READ', params: { nonsense: 1 }, keep: 400 })) as Record<string, unknown>
  assert.deepEqual(result.ignoredParams, ['nonsense'])
})

test('an unclassified command reports that its write classification was assumed', async () => {
  setUiMessageRunner(runner([]))
  const result = (await call.run({ command: 'UNMARKED', keep: 400 })) as Record<string, unknown>
  assert.equal(result.classified, false)
})

test('two calls do not record each other — one runs at a time', async () => {
  let release: (() => void) | null = null
  const started: string[] = []
  setUiMessageRunner(async (message) => {
    started.push(String(message.type))
    if (message.type === 'PURE_READ' && !release) {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    postToUi({ type: 'PURE_ANSWER', from: message.type })
  })

  const first = call.run({ command: 'PURE_READ', keep: 400 }) as Promise<{ replies: unknown[] }>
  const second = call.run({ command: 'UNMARKED', keep: 400 }) as Promise<{ replies: unknown[] }>
  // The second call has not begun while the first is parked.
  await Promise.resolve()
  assert.deepEqual(started, ['PURE_READ'])
  release!()

  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a.replies, [{ type: 'PURE_ANSWER', from: 'PURE_READ' }])
  assert.deepEqual(b.replies, [{ type: 'PURE_ANSWER', from: 'UNMARKED' }])
})

test('a long reply crosses as a file, and the count says how many', async () => {
  setUiMessageRunner(runner([], [{ type: 'PURE_ANSWER', css: 'a'.repeat(2000) }]))
  const result = (await call.run({ command: 'PURE_READ', keep: 400 })) as Record<string, unknown>
  assert.equal(result.files, 1)
})

/* ------------------------------------------------------------- user modules */

const MODULE_COMMAND: UiCommandDef = {
  name: 'acme.pipe.run',
  access: 'write',
  classified: true,
  summary: 'a pipeline somebody installed',
  module: 'acme.pipe',
  params: [{ name: 'key', required: false }],
  replies: [],
}

test('a module command joins the same list, marked as whose it is', async () => {
  setModuleProvider({ commands: () => [MODULE_COMMAND], run: async () => ({ ok: true }) })
  try {
    const listed = (await list.run({})) as { count: number; fromModules?: number; commands: Array<Record<string, unknown>> }
    assert.equal(listed.count, 5)
    assert.equal(listed.fromModules, 1)
    assert.equal(listed.commands.at(-1)!.module, 'acme.pipe')
  } finally {
    setModuleProvider(null)
  }
})

test('a module command is gated by what it derives, not by being a module', () => {
  setModuleProvider({ commands: () => [MODULE_COMMAND], run: async () => ({ ok: true }) })
  try {
    // It wraps a write, so the read gate does not reach it — exactly as for the native write.
    assert.equal(authorize(call, { read: true, write: false }, { command: 'acme.pipe.run' }).ok, false)
    assert.deepEqual(authorize(call, { read: true, write: true }, { command: 'acme.pipe.run' }), { ok: true })

    setModuleProvider({
      commands: () => [{ ...MODULE_COMMAND, name: 'acme.pipe.look', access: 'read' }],
      run: async () => ({ ok: true }),
    })
    assert.deepEqual(authorize(call, { read: true, write: false }, { command: 'acme.pipe.look' }), { ok: true })
  } finally {
    setModuleProvider(null)
  }
})

test('calling a module command runs the module, not the message handler', async () => {
  const handled: Array<Record<string, unknown>> = []
  setUiMessageRunner(runner(handled))
  const asked: Array<[string, Record<string, unknown>]> = []
  setModuleProvider({
    commands: () => [MODULE_COMMAND],
    run: async (name, params) => {
      asked.push([name, params])
      // What a module's steps post reaches the caller's recording like anything else.
      postToUi({ type: 'SCANNED', sites: 3 })
      return { ok: true, steps: [{ step: 0, call: 'SCAN', ok: true }] }
    },
  })
  try {
    const result = (await call.run({ command: 'acme.pipe.run', params: { key: 'k' }, keep: 400 })) as Record<string, unknown>

    assert.deepEqual(asked, [['acme.pipe.run', { key: 'k' }]])
    assert.deepEqual(handled, [], 'a module command is not a message the handler ever sees')
    assert.equal(result.module, 'acme.pipe')
    // Two different accounts of one call: what the steps said, and what the pipeline did.
    assert.deepEqual(result.replies, [{ type: 'SCANNED', sites: 3 }])
    assert.deepEqual(result.run, { ok: true, steps: [{ step: 0, call: 'SCAN', ok: true }] })
  } finally {
    setModuleProvider(null)
  }
})

test('a registry that throws leaves the native surface callable', async () => {
  setUiMessageRunner(runner([], [{ type: 'PURE_ANSWER' }]))
  setModuleProvider({
    commands: () => {
      throw new Error('storage is confused')
    },
    run: async () => ({}),
  })
  try {
    const result = (await call.run({ command: 'PURE_READ', keep: 400 })) as Record<string, unknown>
    assert.deepEqual(result.replies, [{ type: 'PURE_ANSWER' }])
  } finally {
    setModuleProvider(null)
  }
})

/* ---------------------------------------------------------------- refusals out */

test('a command that declines comes back as a failed call, with its reason', async () => {
  setUiMessageRunner(async () => {
    postToUi({ type: 'COMMAND_REFUSED', command: 'PURE_READ', reason: 'node 1:2 is not in the last scan' })
  })
  // Not a result to be read past: an agent should not have to notice a reply type to learn the
  // command did nothing.
  await assert.rejects(
    () => call.run({ command: 'PURE_READ', keep: 400 }),
    /"PURE_READ" declined: node 1:2 is not in the last scan/
  )
})

test('a refusal beside real replies is a partial run, not a failed call', async () => {
  setUiMessageRunner(async () => {
    postToUi({ type: 'PURE_ANSWER', value: 1 })
    postToUi({ type: 'COMMAND_REFUSED', command: 'PURE_READ', reason: 'row 2 had no target' })
  })
  const result = (await call.run({ command: 'PURE_READ', keep: 400 })) as Record<string, unknown>
  assert.equal(result.refused, 'row 2 had no target')
  assert.equal((result.replies as unknown[]).length, 2)
})

/* ------------------------------------------------------------------ wedged */

test('a command that never finishes answers anyway, and does not keep the channel', async () => {
  let stuck: (() => void) | null = null
  setUiMessageRunner(async () => {
    postToUi({ type: 'PURE_ANSWER', stage: 'started' })
    await new Promise<void>((resolve) => {
      stuck = resolve
    })
    postToUi({ type: 'PURE_ANSWER', stage: 'far too late' })
  })

  const wedged = (await call.run({ command: 'PURE_READ', keep: 400, timeoutMs: 1000 })) as Record<string, unknown>
  assert.equal(wedged.stillRunning, true)
  assert.deepEqual(wedged.replies, [{ type: 'PURE_ANSWER', stage: 'started' }])
  assert.match(String(wedged.note), /still running in the plugin/)

  // The queue moved on: a later call is not held by the abandoned one.
  const handled: Array<Record<string, unknown>> = []
  setUiMessageRunner(runner(handled, [{ type: 'PURE_ANSWER', stage: 'next call' }]))
  const after = (await call.run({ command: 'PURE_READ', keep: 400 })) as { replies: unknown[] }
  assert.deepEqual(after.replies, [{ type: 'PURE_ANSWER', stage: 'next call' }])

  // What the orphan says when it finally wakes is not recorded against the call that abandoned
  // it — with no call in flight it reaches the panel and nothing else. (Waking *during* a later
  // call is the one case that cannot be told apart, which is what the note warns about.)
  panel.length = 0
  stuck!()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(panel, [{ type: 'PURE_ANSWER', stage: 'far too late' }])
})

test('an abandoned command that later throws does not crash the plugin', async () => {
  let fail: ((error: Error) => void) | null = null
  setUiMessageRunner(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject
      })
  )
  const wedged = (await call.run({ command: 'PURE_READ', keep: 400, timeoutMs: 1000 })) as Record<string, unknown>
  assert.equal(wedged.stillRunning, true)

  // Rejecting after everyone stopped waiting must be swallowed, not surface as an unhandled
  // rejection minutes after the call it belonged to.
  fail!(new Error('too late to matter'))
  await new Promise((resolve) => setTimeout(resolve, 10))
})
