/**
 * The event feed: every event Figma emits, recorded from the moment the plugin starts.
 *
 * Figma tells a plugin what happened as it happens and never again; an agent arriving a minute
 * later can only learn it if something was listening. These events are cheap and always on —
 * selection, page switches, the views of Slides and Buzz, the FigJam timer, runs (a menu launch
 * or a quick action, with its parameters), files and browser items dropped on the canvas, close,
 * codegen preference changes, a toast dismissed or its button pressed, what the text reviewer
 * flagged. Plugin-data changes, which cost a callback per edit, stay behind `data.watch`.
 *
 * The buffer and the reading are pure, so they are tested without Figma; `listenEverywhere`
 * is the one part that subscribes.
 */

export interface FeedEvent {
  seq: number
  at: string
  kind: string
  id?: string
  name?: string
  /** What the event carried — the selection, a drop, a timer, a run's parameters. */
  data?: Record<string, unknown>
}

export const EVENT_LIMIT = 1000

export class EventFeed {
  private log: FeedEvent[] = []
  private next = 0

  constructor(private readonly limit = EVENT_LIMIT, private readonly now: () => Date = () => new Date()) {}

  record(entry: Omit<FeedEvent, 'seq' | 'at'>): void {
    this.log.push({ seq: this.next++, at: this.now().toISOString(), ...entry })
    if (this.log.length > this.limit) this.log.splice(0, this.log.length - this.limit)
  }

  /** What happened since `since` (the `next` a previous read answered), newest last. */
  read(query: { since?: number; limit?: number; kinds?: readonly string[] } = {}): { events: FeedEvent[]; next: number; dropped: number } {
    const since = typeof query.since === 'number' && Number.isFinite(query.since) ? query.since : 0
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 200), 1), this.limit)
    const kinds = query.kinds && query.kinds.length > 0 ? new Set(query.kinds.map((kind) => kind.toUpperCase())) : null
    const kept = this.log.filter((entry) => entry.seq >= since && (!kinds || kinds.has(entry.kind)))
    const events = kept.slice(-limit)
    // How many matching events the limit left out — older ones, still readable with a later `since`.
    return { events, next: this.next, dropped: kept.length - events.length }
  }

  forget(): void {
    this.log = []
  }
}

export const feed = new EventFeed()

export const recordEvent = (entry: Omit<FeedEvent, 'seq' | 'at'>): void => feed.record(entry)

/**
 * Subscribes to every cheap event this editor emits. Each subscription is attempted on its own,
 * since an editor that does not know an event (a timer in Figma Design) may throw.
 */
export function listenEverywhere(): void {
  const on = (event: string, handler: (...args: never[]) => unknown) => {
    try {
      ;(figma.on as unknown as (type: string, callback: (...args: never[]) => unknown) => void)(event, handler)
    } catch {
      /* this editor has no such event */
    }
  }
  on('selectionchange', () => {
    let ids: string[] = []
    try {
      ids = figma.currentPage.selection.map((node) => node.id)
    } catch {
      /* the selection getter throws when a selected node has just been removed */
    }
    recordEvent({ kind: 'SELECTION', data: { count: ids.length, nodes: ids.slice(0, 20) } })
  })
  on('currentpagechange', () => recordEvent({ kind: 'PAGE', id: figma.currentPage.id, name: figma.currentPage.name }))
  on('close', () => recordEvent({ kind: 'CLOSE' }))
  for (const event of ['timerstart', 'timerstop', 'timerpause', 'timerresume', 'timeradjust', 'timerdone']) {
    on(event, () =>
      recordEvent({
        kind: event.toUpperCase(),
        data: figma.timer ? { state: figma.timer.state, remaining: Math.round(figma.timer.remaining), total: Math.round(figma.timer.total) } : {},
      })
    )
  }
  on('run', ((event: RunEvent) =>
    recordEvent({ kind: 'RUN', data: { command: event.command, ...(event.parameters ? { parameters: event.parameters } : {}) } })) as never)
  // Files and browser items dropped on the canvas while the plugin runs. Figma still does what it
  // would have done — `true` declines to handle the drop — so listening changes nothing.
  on('drop', ((event: DropEvent) => {
    recordEvent({
      kind: 'DROP',
      ...(event.node ? { id: event.node.id } : {}),
      data: {
        x: Math.round(event.x),
        y: Math.round(event.y),
        absoluteX: Math.round(event.absoluteX),
        absoluteY: Math.round(event.absoluteY),
        items: event.items.map((item) => ({ type: item.type, length: item.data.length })),
        files: event.files.map((file) => ({ name: file.name, type: file.type })),
        ...(event.dropMetadata !== undefined ? { metadata: event.dropMetadata } : {}),
      },
    })
    return true
  }) as never)
  on('slidesviewchange', ((event: SlidesViewChangeEvent) => recordEvent({ kind: 'SLIDES_VIEW', data: { view: event.view } })) as never)
  on('canvasviewchange', ((event: CanvasViewChangeEvent) => recordEvent({ kind: 'CANVAS_VIEW', data: { view: event.view } })) as never)
}
