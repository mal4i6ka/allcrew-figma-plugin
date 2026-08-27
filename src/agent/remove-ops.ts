/**
 * Agent listener — deleting nodes.
 *
 * Lives apart from the rest of the write registry for one reason: this is the only op whose
 * mistake cannot be read back afterwards. Everything else in `write-ops.ts` reports `before`,
 * so a wrong write is visible and reversible from its own report; a removed node reports
 * nothing, because there is nothing left to ask. The safeguards below are therefore refusals
 * rather than warnings.
 */

import type { OpDef } from './protocol.ts'

function asIds(value: unknown, param: string): string[] {
  const list = Array.isArray(value) ? (value as unknown[]) : []
  const ids = list.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  if (ids.length === 0) throw new Error(`"${param}" must be a non-empty array of node ids`)
  return ids
}

/** The whole refusal policy, as a pure function: a destructive op earns tests that do not
 * need a document, and every branch here exists because the alternative is a deletion nobody
 * can inspect afterwards. Throws with the message the report will carry. */
export function screenRemoval(node: { type: string; name?: string }, force: boolean): void {
  if (node.type === 'PAGE' || node.type === 'DOCUMENT') {
    throw new Error(`${node.type} cannot be deleted through this channel`)
  }
  if ((node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && !force) {
    throw new Error(
      `${node.name ?? node.type} is a ${node.type} — its instances elsewhere would break; pass force: true if that is intended`
    )
  }
}

const pageOf = (node: BaseNode): string | null => {
  let walk: BaseNode | null = node.parent
  while (walk && walk.type !== 'PAGE') walk = walk.parent
  return walk ? (walk as PageNode).name : null
}

export const REMOVE_OPS: readonly OpDef[] = [
  {
    name: 'node.remove',
    summary: 'Delete nodes. Refuses a main component, and reports what each deletion actually was.',
    agent:
      'The one write whose mistake cannot be read back — there is no `before` on a node that no longer exists, so read the nodes first (node.get) and delete by id, never by a name you assumed. A COMPONENT or COMPONENT_SET is refused without force: true, because its instances live elsewhere in the file and would break where nobody is looking. Deleting a page is never allowed. One call is one undo step.',
    mutates: true,
    params: {
      nodes: { type: 'string[]', required: true, description: 'Node ids to delete.' },
      force: {
        type: 'boolean',
        default: false,
        description:
          'Allow deleting a COMPONENT or COMPONENT_SET. Off by default: instances of it may sit on ' +
          'pages this call never looked at, and they break silently.',
      },
      dryRun: {
        type: 'boolean',
        default: false,
        description: 'Report exactly what would be deleted — name, type and page — without deleting anything.',
      },
    },
    async run(params) {
      const ids = asIds(params.nodes, 'nodes')
      const dryRun = params.dryRun === true
      const force = params.force === true

      /* Everything is resolved and screened BEFORE the first removal: a batch that discovers a
       * refusal halfway through has already destroyed the nodes ahead of it, and unlike every
       * other op here that half-state cannot be inspected afterwards. */
      const planned: Array<{ node: SceneNode; row: Record<string, unknown> }> = []
      const results: Array<Record<string, unknown>> = []
      for (const id of ids) {
        try {
          const found = await figma.getNodeByIdAsync(id)
          if (!found) throw new Error(`no node with id ${id}`)
          screenRemoval(found, force)
          const scene = found as SceneNode
          planned.push({
            node: scene,
            row: { node: id, name: scene.name, type: scene.type, page: pageOf(scene) },
          })
        } catch (err) {
          results.push({ node: id, ok: false, removed: false, error: String((err as Error)?.message || err) })
        }
      }

      if (dryRun) {
        for (const entry of planned) results.push({ ...entry.row, ok: true, removed: false })
        return { dryRun, total: ids.length, removed: 0, failed: results.filter((row) => !row.ok).length, results }
      }

      if (planned.length > 0) figma.commitUndo()
      for (const entry of planned) {
        try {
          entry.node.remove()
          /* `removed` is read back off the node rather than assumed from a call that did not
           * throw: this is the one op with no other way to tell success from silence. */
          results.push({ ...entry.row, ok: entry.node.removed === true, removed: entry.node.removed === true })
        } catch (err) {
          results.push({ ...entry.row, ok: false, removed: false, error: String((err as Error)?.message || err) })
        }
      }

      return {
        dryRun,
        total: ids.length,
        removed: results.filter((row) => row.removed === true).length,
        failed: results.filter((row) => !row.ok).length,
        results,
      }
    },
  },
]
