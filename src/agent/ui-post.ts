/**
 * The one place the sandbox talks to its UI.
 *
 * `plugin.call` has to know what a command answered, and the obvious way — wrapping
 * `figma.ui.postMessage` for the duration of the call — does not work: Figma's sandbox refuses
 * both the assignment and `defineProperty`, so the wrapper never installs. Observed on
 * 2026-08-28 against the real plugin (`captured: false`), not deduced.
 *
 * So the indirection is explicit instead of clever. Every reply goes through `postToUi`, which
 * forwards to the host method and, while a recording is open, keeps a copy. Nothing depends on
 * the runtime letting its objects be patched, and the recording is exact: it sees precisely
 * what the sandbox sent, in order.
 *
 * A test asserts no production file calls `figma.ui.postMessage` directly — a reply that
 * bypasses this module is a reply the agent silently never hears about.
 */

let recorder: unknown[] | null = null

export function postToUi(message: unknown, options?: UIPostMessageOptions): void {
  if (recorder) recorder.push(message)
  figma.ui.postMessage(message, options)
}

/** Opens a recording and hands back the array it fills. The array is the token: only the
 * caller holding it can close its own recording, so a stale `endRecording` from an abandoned
 * call cannot silence a live one. */
export function beginRecording(): unknown[] {
  const sink: unknown[] = []
  recorder = sink
  return sink
}

export function endRecording(sink: unknown[]): void {
  if (recorder === sink) recorder = null
}

export function isRecording(): boolean {
  return recorder !== null
}
