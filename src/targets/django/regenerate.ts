/**
 * Regeneration without overwrite (T3.3, docs/research/04-figma-to-django-templates.md §4.4
 * point 7 / §5): every emitted file is wrapped in a `{# GENERATED:BEGIN/END <node id> #}` marker
 * pair. Matching is marker-based rather than path-based on purpose — a component keeps its
 * identity across a layer rename (`component-emitter.ts`'s `partialPath` only changes its
 * readable slug, not the node-id suffix, but this module doesn't even rely on the suffix: it
 * finds the block by scanning the marker itself) so regeneration still lands in the right place.
 *
 * On re-export, `planRegeneration` only ever replaces the text *inside* a matching marker pair —
 * anything a developer added before/after it survives untouched, and a file that has no marker
 * for that node id at all (nobody ever generated it, or it predates this scheme) is left alone
 * entirely rather than silently overwritten. It also produces a line-level diff per file so a UI
 * can show what a re-export would change before the user confirms the overwrite.
 */

export function generatedBeginMarker(nodeId: string): string {
  return `{# GENERATED:BEGIN ${nodeId} — edits outside this block survive regeneration #}`
}

export function generatedEndMarker(nodeId: string): string {
  return `{# GENERATED:END ${nodeId} #}`
}

/** Wraps freshly emitted content in the marker pair `mergeGenerated`/`planRegeneration` match on. */
export function wrapGenerated(nodeId: string, content: string): string {
  return [generatedBeginMarker(nodeId), content, generatedEndMarker(nodeId)].join('\n')
}

interface MarkerSpan {
  /** Index right after the begin marker's own text. */
  readonly contentStart: number
  /** Index right before the end marker's own text. */
  readonly contentEnd: number
}

function findGeneratedSpan(fileContent: string, nodeId: string): MarkerSpan | null {
  const begin = generatedBeginMarker(nodeId)
  const end = generatedEndMarker(nodeId)
  const beginIndex = fileContent.indexOf(begin)
  if (beginIndex === -1) return null
  const contentStart = beginIndex + begin.length
  const endIndex = fileContent.indexOf(end, contentStart)
  if (endIndex === -1) return null
  return { contentStart, contentEnd: endIndex }
}

/** Merges `fresh` (already `wrapGenerated`-wrapped) into `existing`, preserving any hand-written
 * text outside the marker pair. Returns `null` when `existing` is non-null but carries no marker
 * for `nodeId` — a fully hand-authored file the generator has never touched, which `planRegeneration`
 * then leaves untouched rather than overwriting. Text a developer edits *inside* the marker pair is
 * not preserved: that region is generator-owned, matching the "generated vs. hand-edited" split
 * from the task's Definition of Done. */
export function mergeGenerated(existing: string | null, nodeId: string, fresh: string): string | null {
  if (existing === null) return fresh

  const existingSpan = findGeneratedSpan(existing, nodeId)
  if (!existingSpan) return null

  const freshSpan = findGeneratedSpan(fresh, nodeId)
  if (!freshSpan) return fresh

  const freshInner = fresh.slice(freshSpan.contentStart, freshSpan.contentEnd)
  return existing.slice(0, existingSpan.contentStart) + freshInner + existing.slice(existingSpan.contentEnd)
}

export interface DiffLine {
  readonly kind: 'equal' | 'add' | 'remove'
  readonly text: string
}

/** Line-level LCS diff between `oldText` and `newText` — good enough for template-sized files fed
 * into a UI diff preview; not meant for large-scale text. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.length === 0 ? [] : oldText.split('\n')
  const newLines = newText.length === 0 ? [] : newText.split('\n')
  const n = oldLines.length
  const m = newLines.length

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ kind: 'equal', text: oldLines[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ kind: 'remove', text: oldLines[i] })
      i++
    } else {
      result.push({ kind: 'add', text: newLines[j] })
      j++
    }
  }
  while (i < n) {
    result.push({ kind: 'remove', text: oldLines[i] })
    i++
  }
  while (j < m) {
    result.push({ kind: 'add', text: newLines[j] })
    j++
  }
  return result
}

export type RegenerationAction = 'create' | 'update' | 'unchanged' | 'skipped-hand-edited'

export interface RegenerationFilePlan {
  readonly path: string
  readonly action: RegenerationAction
  /** The content that would be written (or, for `skipped-hand-edited`, the existing content left as-is). */
  readonly content: string
  readonly diff: readonly DiffLine[]
}

export interface RegenerationPlan {
  readonly files: readonly RegenerationFilePlan[]
  readonly warnings: readonly string[]
}

export interface FreshFile {
  /** The Figma node id that produced this file's content — the key `mergeGenerated` matches on. */
  readonly nodeId: string
  /** Freshly emitted content, already `wrapGenerated`-wrapped. */
  readonly content: string
}

/** Builds a diff-preview plan for a re-export: for every fresh file, merges it against the
 * previously-exported content at the same path (if any) and diffs the result against what's
 * currently on disk. A UI can render `files[].diff` and let the user confirm before the caller
 * actually writes `files[].content` to each `files[].path`. */
export function planRegeneration(
  existingFiles: ReadonlyMap<string, string>,
  freshFiles: ReadonlyMap<string, FreshFile>
): RegenerationPlan {
  const files: RegenerationFilePlan[] = []
  const warnings: string[] = []

  for (const [path, fresh] of freshFiles) {
    const existing = existingFiles.get(path) ?? null
    const merged = mergeGenerated(existing, fresh.nodeId, fresh.content)

    if (merged === null) {
      warnings.push(`${path}: no GENERATED marker for ${fresh.nodeId} found — left untouched (fully hand-edited)`)
      files.push({ path, action: 'skipped-hand-edited', content: existing as string, diff: [] })
      continue
    }

    const action: RegenerationAction = existing === null ? 'create' : merged === existing ? 'unchanged' : 'update'
    files.push({ path, action, content: merged, diff: diffLines(existing ?? '', merged) })
  }

  return { files, warnings }
}
