import { checkpoint, stopReason, type StopReason } from '../utils/budget.ts'

/** The iframe refuses a response whose JSON is larger than 3 MiB. Binary envelopes grow by
 * 4/3 when base64 encoded, and the response still needs room for names, reports and JSON syntax. */
export const TRANSPORT_REPLY_CAP = 3 * 1024 * 1024
export const REPLY_ENVELOPE_RESERVE = 128 * 1024
export const MAX_REPLY_RAW_BYTES = Math.floor(((TRANSPORT_REPLY_CAP - REPLY_ENVELOPE_RESERVE) * 3) / 4)

/** A render this large is already roughly 160 MiB of RGBA working memory. Refusing it before
 * exportAsync keeps one accidental 4x page render from aborting the plugin sandbox. */
export const DEFAULT_MAX_EXPORT_PIXELS = 40_000_000
export const DEFAULT_EXPORT_RESERVE_MS = 5_000
/** The fewest bytes a raster render is assumed to need per output pixel when deciding, BEFORE
 * rendering, that it cannot fit what is left of a budget. Deliberately a floor, not a typical
 * size: flat UI art compresses far better than photographs, and refusing a render that would
 * have fitted is a worse failure than rendering one that then does not. */
export const MIN_RASTER_BYTES_PER_PIXEL = 0.05

export type ExportConstraint = { type: 'SCALE' | 'WIDTH' | 'HEIGHT'; value: number }

export interface RenderPixels {
  width: number
  height: number
  pixels: number
  scale: number
}

export function clampReplyBudget(bytes: number | undefined): number {
  if (!Number.isFinite(bytes) || (bytes as number) <= 0) return MAX_REPLY_RAW_BYTES
  return Math.min(Math.floor(bytes as number), MAX_REPLY_RAW_BYTES)
}

/** Computes the output dimensions before exportAsync for all three raster constraints. */
export function renderPixels(
  node: { width: number; height: number },
  constraint: ExportConstraint
): RenderPixels {
  const width = Math.max(0, Number(node.width) || 0)
  const height = Math.max(0, Number(node.height) || 0)
  const value = Math.max(0, Number(constraint.value) || 0)
  const scale =
    constraint.type === 'WIDTH'
      ? width > 0 ? value / width : 0
      : constraint.type === 'HEIGHT'
        ? height > 0 ? value / height : 0
        : value
  const outputWidth = Math.max(0, Math.round(width * scale))
  const outputHeight = Math.max(0, Math.round(height * scale))
  return { width: outputWidth, height: outputHeight, pixels: outputWidth * outputHeight, scale }
}

export function pixelRefusal(
  node: { width: number; height: number },
  constraint: ExportConstraint,
  maxPixels = DEFAULT_MAX_EXPORT_PIXELS
): { render: RenderPixels; error?: string } {
  const render = renderPixels(node, constraint)
  if (render.pixels <= maxPixels) return { render }
  return {
    render,
    error:
      `${render.width}×${render.height} is ${(render.pixels / 1e6).toFixed(1)} megapixels, above the ` +
      `${(maxPixels / 1e6).toFixed(1)} MP safety limit. Lower scale or use a WIDTH/HEIGHT constraint.`,
  }
}

/** Reduces a SCALE render to the largest scale that stays within maxPixels. */
export function fitScaleToPixels(
  node: { width: number; height: number },
  requestedScale: number,
  maxPixels = DEFAULT_MAX_EXPORT_PIXELS
): { scale: number; downscaled: boolean; render: RenderPixels } {
  const requested = renderPixels(node, { type: 'SCALE', value: requestedScale })
  if (requested.pixels <= maxPixels || requested.pixels === 0) {
    return { scale: requestedScale, downscaled: false, render: requested }
  }
  const scale = requestedScale * Math.sqrt(maxPixels / requested.pixels)
  const render = renderPixels(node, { type: 'SCALE', value: scale })
  return { scale, downscaled: true, render }
}

/** Keeps the caller's constraint kind while reducing its value enough to fit the pixel cap. */
export function fitConstraintToPixels(
  node: { width: number; height: number },
  constraint: ExportConstraint,
  maxPixels = DEFAULT_MAX_EXPORT_PIXELS
): { constraint: ExportConstraint; downscaled: boolean; render: RenderPixels } {
  const requested = renderPixels(node, constraint)
  if (requested.pixels <= maxPixels || requested.pixels === 0) {
    return { constraint, downscaled: false, render: requested }
  }
  const fitted: ExportConstraint = {
    type: constraint.type,
    value: constraint.value * Math.sqrt(maxPixels / requested.pixels),
  }
  return { constraint: fitted, downscaled: true, render: renderPixels(node, fitted) }
}

export type ExportStop = 'bytes' | StopReason

export interface Admission {
  include: boolean
  /** Present when this item cannot join the reply. Reusing nextOffset resumes at this item. */
  stoppedOn?: ExportStop
  nextOffset?: number
  firstItemTooLarge?: boolean
}

/** One reply's shared byte/time gate. Call before every render, then admit its bytes before
 * building a file envelope. Once it stops, callers must not render another item. */
export class ExportGuard {
  readonly budgetBytes: number
  readonly maxPixels: number
  readonly reserveMs: number
  private used = 0
  private accepted = 0
  private stopped: ExportStop | null = null

  /** `transport: false` for budgets that never travel in an agent reply (a zip the panel
   * builds); everything else is clamped below the reply cap. */
  constructor(options: { budgetBytes?: number; maxPixels?: number; reserveMs?: number; transport?: boolean } = {}) {
    this.budgetBytes =
      options.transport === false && Number.isFinite(options.budgetBytes) && (options.budgetBytes as number) > 0
        ? Math.floor(options.budgetBytes as number)
        : clampReplyBudget(options.budgetBytes)
    this.maxPixels = Number.isFinite(options.maxPixels) && (options.maxPixels as number) > 0
      ? Math.floor(options.maxPixels as number)
      : DEFAULT_MAX_EXPORT_PIXELS
    this.reserveMs = options.reserveMs ?? DEFAULT_EXPORT_RESERVE_MS
  }

  get spent(): number { return this.used }
  get count(): number { return this.accepted }
  get stop(): ExportStop | null { return this.stopped }
  get remaining(): number { return Math.max(0, this.budgetBytes - this.used) }

  async beforeRender(offset: number): Promise<Admission> {
    if (this.stopped) return { include: false, stoppedOn: this.stopped, nextOffset: offset }
    if (this.remaining === 0) {
      this.stopped = 'bytes'
      return { include: false, stoppedOn: 'bytes', nextOffset: offset }
    }
    // Check first so cancellation can return a resumable offset instead of checkpoint throwing
    // the useful partial answer away. Check again after yielding in case the run stopped there.
    const before = stopReason(this.reserveMs)
    if (before) {
      this.stopped = before
      return { include: false, stoppedOn: before, nextOffset: offset }
    }
    await checkpoint()
    const after = stopReason(this.reserveMs)
    if (after) {
      this.stopped = after
      return { include: false, stoppedOn: after, nextOffset: offset }
    }
    return { include: true }
  }

  /**
   * A pre-render admission for raster exporters: a render that could not fit what is left even
   * at {@link MIN_RASTER_BYTES_PER_PIXEL} is refused before `exportAsync`, instead of rendered
   * only to be discarded.
   */
  preflightRaster(render: RenderPixels, offset: number): Admission {
    if (this.stopped) return { include: false, stoppedOn: this.stopped, nextOffset: offset }
    if (Math.ceil(render.pixels * MIN_RASTER_BYTES_PER_PIXEL) > this.remaining) {
      this.stopped = 'bytes'
      return {
        include: false,
        stoppedOn: 'bytes',
        nextOffset: offset,
        ...(this.accepted === 0 ? { firstItemTooLarge: true } : {}),
      }
    }
    return { include: true }
  }

  admit(bytes: number, offset: number): Admission {
    const size = Math.max(0, Math.floor(bytes))
    if (this.stopped) return { include: false, stoppedOn: this.stopped, nextOffset: offset }
    if (size > this.remaining) {
      this.stopped = 'bytes'
      return {
        include: false,
        stoppedOn: 'bytes',
        nextOffset: offset,
        ...(this.accepted === 0 ? { firstItemTooLarge: true } : {}),
      }
    }
    this.used += size
    this.accepted += 1
    return { include: true }
  }
}
