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

/**
 * Every open recording, not one.
 *
 * A module command runs several plugin commands in a row, and two different questions are being
 * asked at once: the caller wants everything the whole run said, and the step needs its own
 * answer to hand to the next step. Both get their own sink and every message reaches all of
 * them — an inner recording that stole the messages from the outer one would make a module's
 * run invisible to the caller who asked for it.
 */
const recorders: unknown[][] = []

export function postToUi(message: unknown, options?: UIPostMessageOptions): void {
  for (const sink of recorders) sink.push(message)
  figma.ui.postMessage(message, options)
}

/** Opens a recording and hands back the array it fills. The array is the token: only the
 * caller holding it can close its own recording, so a stale `endRecording` from an abandoned
 * call cannot silence a live one. */
export function beginRecording(): unknown[] {
  const sink: unknown[] = []
  recorders.push(sink)
  return sink
}

export function endRecording(sink: unknown[]): void {
  const at = recorders.indexOf(sink)
  if (at >= 0) recorders.splice(at, 1)
}

export function isRecording(): boolean {
  return recorders.length > 0
}
