/**
 * Shared delivery — POSTs the generated package to a user-configured receiver endpoint.
 *
 * One wire format only: JSON in, JSON out. The legacy zip-bytes-plus-route-headers dialect
 * this file used to speak was a third version of a contract the receiver never implemented, and
 * it could not have worked anyway: a zip carries no per-file answer back, so a dry run had
 * nowhere to return its plan. Text files travel as strings, bytes as `{ base64 }` — that is the
 * whole vocabulary, and it survives `JSON.stringify` in a Figma sandbox with no zip step.
 */

import { isRecord } from './utils/type-guards.ts'

/** A file value on the wire: UTF-8 text, or bytes as base64. Nothing else. */
export type DeliveryFile = string | { base64: string }
export type DeliveryFiles = Record<string, DeliveryFile>

export type DeliveryTarget = 'folder' | 'git' | 'pr' | 'mr' | 'npm'

export interface DeliveryRoute {
  /** Clone URL — `git`, `pr`, `mr`. */
  repo: string
  /** Working branch the receiver creates or updates. */
  branch: string
  /** PR/MR target branch; empty means the remote's HEAD branch. */
  base: string
  /** Subdirectory inside the repository or folder. */
  path: string
  /** `npm` only. */
  package: string
  /** GitLab project path or numeric id — `mr` only. */
  project: string
  title?: string
  description?: string
}

export interface DeliveryConfig {
  endpoint: string
  secret: string
  target: DeliveryTarget
  route: DeliveryRoute
  /** Ask the receiver to compute the plan and change nothing. */
  dryRun?: boolean
  onChange: boolean
  onOpen: boolean
}

export interface DeliveryPlanFile {
  path: string
  /** `skipped-hand-edited` is `planRegeneration`'s verdict on a file a human changed outside the
   * generated markers: real, reported, and deliberately not written. */
  action: 'create' | 'update' | 'unchanged' | 'skipped-hand-edited'
  added: number
  removed: number
  binary: boolean
}

export interface DeliveryPlan {
  files: DeliveryPlanFile[]
  /** Unified diff text; may be truncated, in which case `truncated` says so. */
  diff?: string
  truncated?: boolean
}

export interface DeliveryResult {
  ok: boolean
  status?: number
  /** Transport-level failure, or a reply the receiver did not phrase as JSON. */
  message?: string
  /** The receiver's own one-liner. */
  detail?: string
  dryRun?: boolean
  plan?: DeliveryPlan
  /** Present after a real `mr`/`pr` run. */
  url?: string
}

/** The receiver's word for what it would do, kept to the four this side knows. */
const PLAN_ACTIONS: Record<string, DeliveryPlanFile['action']> = {
  create: 'create',
  update: 'update',
  unchanged: 'unchanged',
  'skipped-hand-edited': 'skipped-hand-edited',
}

function planFrom(raw: unknown): DeliveryPlan | undefined {
  if (!isRecord(raw)) return undefined
  const files = Array.isArray(raw.files)
    ? raw.files.filter(isRecord).map((file) => ({
        path: String(file.path ?? ''),
        action: (typeof file.action === 'string' && PLAN_ACTIONS[file.action]) || 'unchanged',
        added: typeof file.added === 'number' ? file.added : 0,
        removed: typeof file.removed === 'number' ? file.removed : 0,
        binary: file.binary === true,
      }))
    : []
  return {
    files,
    diff: typeof raw.diff === 'string' ? raw.diff : undefined,
    truncated: raw.truncated === true,
  }
}

export async function deliverPackage(
  files: DeliveryFiles,
  config: DeliveryConfig
): Promise<DeliveryResult> {
  if (!config.endpoint) {
    return { ok: false, message: 'No delivery endpoint configured.' }
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-allcrew-channel-secret': config.secret,
      },
      body: JSON.stringify({
        target: config.target,
        dryRun: config.dryRun === true,
        route: config.route,
        files,
      }),
    })

    const text = await response.text().catch(() => '')
    let body: unknown = undefined
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      // A receiver behind a proxy answers HTML, and a crashed one answers a stack trace. Both are
      // still an answer worth showing, so they degrade to `message` rather than throwing here.
      body = undefined
    }
    const parsed = isRecord(body) ? body : undefined

    if (!response.ok) {
      const error = parsed && typeof parsed.error === 'string' ? parsed.error : ''
      return { ok: false, status: response.status, message: error || text || response.statusText }
    }

    if (!parsed) {
      return { ok: true, status: response.status, message: text || undefined }
    }

    return {
      ok: parsed.ok !== false,
      status: response.status,
      detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
      dryRun: parsed.dryRun === true,
      plan: planFrom(parsed.plan),
      url: typeof parsed.url === 'string' ? parsed.url : undefined,
      message: typeof parsed.error === 'string' ? parsed.error : undefined,
    }
  } catch (err) {
    return { ok: false, message: String((err as Error)?.message || err) }
  }
}
