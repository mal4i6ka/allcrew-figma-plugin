/**
 * Variable NAMES for an export, without paying for every variable in every enabled library.
 *
 * An emitter needs one thing from the variable graph: the name behind each id a layer in the scope
 * is bound to, so a bound fill can be written `var(--content-base, #101010)`. `readAllVariables`
 * answers that by importing the whole team library one variable at a time — 60 to 90 seconds on a
 * real file, paid on every export, and the agent bridge cuts a call off at 180. Measured against
 * `design.context`, which resolves the same names off the local graph in 39 ms, that wait was
 * almost the entire cost of an export that emitted nothing else.
 *
 * This resolves only the ids the scope actually uses: the local snapshot answers most of them for
 * free, and each remaining id costs one `getVariableByIdAsync` — a handful of calls instead of
 * thousands. Token ARTIFACTS (tokens.css and friends) still need the full snapshot, because they
 * describe every variable rather than the ones one screen happens to touch; this is for the
 * emitters, which only ever look names up.
 */

import { readLocalVariables } from '../../variables.ts'

/** The subset of a scene node the resolver reads — kept structural so tests need no Figma. */
export interface BoundVariableSource {
  readonly boundVariables?: Record<string, unknown>
}

function collectAliasIds(nodes: Iterable<BoundVariableSource>): Set<string> {
  const ids = new Set<string>()
  for (const node of nodes) {
    const bound = node.boundVariables
    if (!bound) continue
    for (const entry of Object.values(bound)) {
      // A field is either one alias (`fills` on a shape) or an array of them (`fills` on a
      // multi-paint node); a text node's `characters` alias has the same shape again.
      for (const alias of Array.isArray(entry) ? entry : [entry]) {
        const id = (alias as { type?: string; id?: string } | null)?.id
        if (typeof id === 'string') ids.add(id)
      }
    }
  }
  return ids
}

/**
 * `id → name` for every variable the given nodes bind. `lookup` exists so the resolver can be
 * tested without the Figma sandbox; in the plugin it is `figma.variables.getVariableByIdAsync`.
 */
export async function resolveBoundVariableNames(
  nodes: Iterable<BoundVariableSource>,
  lookup: (id: string) => Promise<{ name: string } | null>,
  localNames?: ReadonlyMap<string, string>
): Promise<Map<string, string>> {
  const names = new Map(localNames ?? new Map<string, string>())
  for (const id of collectAliasIds(nodes)) {
    if (names.has(id)) continue
    try {
      const variable = await lookup(id)
      // An id that resolves to nothing is a variable this file can see a binding to but not the
      // variable itself (a library that was unsubscribed). The emitter then writes the literal
      // value, which is what it did before this resolver existed — silently, and for every token.
      if (variable) names.set(id, variable.name)
    } catch {
      /* unreadable id: same degradation as above, and never fatal to the export */
    }
  }
  return names
}

/** The plugin-side wiring: local snapshot for the bulk, one lookup per remaining bound id. */
export async function variableNamesForScope(nodes: Iterable<BoundVariableSource>): Promise<Map<string, string>> {
  const local = await readLocalVariables()
  const localNames = new Map(local.variables.map((variable) => [variable.id, variable.name]))
  return resolveBoundVariableNames(nodes, (id) => figma.variables.getVariableByIdAsync(id), localNames)
}
