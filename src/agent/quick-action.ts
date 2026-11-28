/**
 * Quick actions: any panel command from Figma's own command bar, without opening the panel.
 *
 * The manifest declares two parameters — the command, and its message as JSON — with
 * `parameterOnly: false`, so a menu launch still opens the panel exactly as before and only a Tab
 * in quick actions asks for them. While the designer types, Figma runs the plugin in query mode:
 * it may read, and may neither change the document nor show anything. These two functions are
 * what query mode does, and they are pure.
 */

import type { UiCommandDef } from './ui-commands.ts'

export interface Suggestion {
  name: string
  data: string
}

/** Commands whose name or summary holds every word typed, the closest names first. Denied ones
 * are not offered: a quick action is a person at the keyboard, but the same table rules both. */
export function suggestCommands(commands: readonly UiCommandDef[], query: string, limit = 30): Suggestion[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const scored = commands
    .filter((command) => command.access !== 'deny')
    .map((command) => {
      const name = command.name.toLowerCase().replace(/_/g, ' ')
      const text = `${name} ${(command.summary ?? '').toLowerCase()}`
      if (!words.every((word) => text.includes(word))) return null
      const score = words.reduce((sum, word) => sum + (name.includes(word) ? 2 : 1), 0) - name.length / 100
      return { command, score }
    })
    .filter((entry): entry is { command: UiCommandDef; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(({ command }) => ({
    name: `${command.name}${command.summary ? ` — ${command.summary.slice(0, 80)}` : ''}`,
    data: command.name,
  }))
}

/** The JSON a quick action carries for its command, refused by name when it is not an object. */
export function parseQuickParams(raw: unknown): { params: Record<string, unknown> } | { problem: string } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { params: {} }
  if (typeof raw !== 'string') return { problem: 'parameters must be JSON text' }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { problem: 'parameters must be a JSON object, like {"name": "Card"}' }
    if ('type' in parsed) return { problem: '"type" is the command itself — leave it out of the parameters' }
    return { params: parsed as Record<string, unknown> }
  } catch (error) {
    return { problem: `not JSON: ${String((error as Error).message)}` }
  }
}
