/**
 * Agent listener — the plugin data a file carries, and how a change to it reaches another client.
 *
 * Plugin data is the one store that lives in the file itself: every node, the document root,
 * styles and variables carry string entries that sync to every open client like any other edit.
 * `data.get` / `data.set` read and write it; `data.watch` / `data.events` record how somebody
 * else's write arrives here — which is the question a file-borne message channel between
 * colleagues' agents stands or falls on. Under `documentAccess: dynamic-page` a document-wide
 * `documentchange` needs every page loaded first, a page's `nodechange` covers that page only,
 * and the root is no page's node — so the watch tries all three and says which ones fired.
 */

import type { OpDef } from './protocol.ts'

type Carrier = BaseNode & PluginDataMixin

async function carrierOf(raw: unknown): Promise<Carrier> {
  const id = String(raw ?? '')
  if (id === '' || id === 'root' || id === figma.root.id) return figma.root
  const node = await figma.getNodeByIdAsync(id)
  if (!node) throw new Error(`no such node: ${id}`)
  return node as Carrier
}

function namespaceOf(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  const namespace = String(raw)
  if (!/^[A-Za-z0-9_.-]{3,}$/.test(namespace)) throw new Error('namespace must be at least 3 letters, digits, dots, dashes or underscores')
  return namespace
}

function entriesOf(node: Carrier, namespace: string | null): Record<string, string> {
  const entries: Record<string, string> = {}
  const keys = namespace ? node.getSharedPluginDataKeys(namespace) : node.getPluginDataKeys()
  for (const key of keys) entries[key] = namespace ? node.getSharedPluginData(namespace, key) : node.getPluginData(key)
  return entries
}

/* ------------------------------------------------------------------ watch */

interface Seen {
  at: number
  via: 'documentchange' | 'nodechange' | 'poll'
  origin?: string
  nodeId: string
  properties?: string[]
  key?: string
  value?: string
}

const SEEN_LIMIT = 500
const seen: Seen[] = []
let watching: { stop: () => void; via: Record<string, string> } | null = null

function record(entry: Seen): void {
  seen.push(entry)
  if (seen.length > SEEN_LIMIT) seen.splice(0, seen.length - SEEN_LIMIT)
}

function pluginDataChanges(changes: ReadonlyArray<DocumentChange | NodeChange>, via: Seen['via']): void {
  const at = Date.now()
  for (const change of changes) {
    if (change.type !== 'PROPERTY_CHANGE') continue
    const properties = change.properties as readonly string[]
    if (!properties.some((property) => /pluginData/i.test(property))) continue
    record({ at, via, origin: change.origin, nodeId: change.id, properties: [...properties] })
  }
}

async function startWatch(pageId: string | null, pollMs: number): Promise<Record<string, string>> {
  const via: Record<string, string> = {}
  const stops: Array<() => void> = []

  // Document-wide: refused under dynamic-page unless every page was loaded — which is the point
  // of asking, not something to work around here by loading the whole file.
  try {
    const onDocument = (event: DocumentChangeEvent) => pluginDataChanges(event.documentChanges, 'documentchange')
    figma.on('documentchange', onDocument)
    stops.push(() => figma.off('documentchange', onDocument))
    via.documentchange = 'listening'
  } catch (error) {
    via.documentchange = `refused: ${String((error as Error)?.message || error)}`
  }

  const page = pageId ? await figma.getNodeByIdAsync(pageId) : figma.currentPage
  if (page && page.type === 'PAGE') {
    await page.loadAsync()
    const onNode = (event: NodeChangeEvent) => pluginDataChanges(event.nodeChanges, 'nodechange')
    page.on('nodechange', onNode)
    stops.push(() => page.off('nodechange', onNode))
    via.nodechange = `listening on "${page.name}" (${page.id})`
  } else via.nodechange = `no such page: ${pageId}`

  // The root belongs to no page: what a page cannot report, a look at its keys every so often can.
  let last = entriesOf(figma.root, null)
  const timer = setInterval(() => {
    const now = entriesOf(figma.root, null)
    for (const key of new Set([...Object.keys(last), ...Object.keys(now)])) {
      if (last[key] !== now[key]) record({ at: Date.now(), via: 'poll', nodeId: figma.root.id, key, value: (now[key] ?? '').slice(0, 2000) })
    }
    last = now
  }, pollMs)
  stops.push(() => clearInterval(timer))
  via.poll = `root every ${pollMs} ms`

  watching = { stop: () => stops.forEach((stop) => stop()), via }
  return via
}

export const DATA_OPS: readonly OpDef[] = [
  {
    name: 'data.get',
    summary: 'The plugin data a node, or the file itself, carries — this plugin’s own or a shared namespace.',
    mutates: false,
    params: {
      nodeId: { type: 'string', description: 'The node to read; omitted or `root` reads the document itself.' },
      namespace: { type: 'string', description: 'A shared namespace to read instead of this plugin’s private data.' },
    },
    async run(params) {
      const node = await carrierOf(params.nodeId)
      const namespace = namespaceOf(params.namespace)
      return { nodeId: node.id, ...(namespace ? { namespace } : {}), entries: entriesOf(node, namespace) }
    },
  },
  {
    name: 'data.set',
    summary: 'Write one plugin-data entry on a node or the file; an empty value removes it.',
    agent:
      'Plugin data travels with the file: every collaborator’s client receives it, it enters version history and undo, ' +
      'and anyone who can edit the file can read it back — never store a secret. One entry is at most 100 kB. ' +
      'Without `namespace` only this plugin can read the entry; with one, any plugin can.',
    mutates: true,
    params: {
      nodeId: { type: 'string', description: 'The node to write on; omitted or `root` writes on the document itself.' },
      key: { type: 'string', required: true, description: 'The entry’s key.' },
      value: { type: 'string', required: true, description: 'The text to store — JSON for anything structured. Empty removes the entry.' },
      namespace: { type: 'string', description: 'Write into this shared namespace instead of this plugin’s private data.' },
    },
    async run(params) {
      const node = await carrierOf(params.nodeId)
      const namespace = namespaceOf(params.namespace)
      const key = String(params.key)
      const value = String(params.value)
      if (namespace) node.setSharedPluginData(namespace, key, value)
      else node.setPluginData(key, value)
      return { nodeId: node.id, key, ...(namespace ? { namespace } : {}), bytes: value.length, removed: value === '' }
    },
  },
  {
    name: 'data.watch',
    summary: 'Start (or restart) recording plugin-data changes that reach this client, and which way each one arrived.',
    mutates: false,
    params: {
      pageId: { type: 'string', description: 'The page whose nodes to watch; omitted, the current page.' },
      pollMs: { type: 'number', description: 'How often to look at the document root’s own entries (default 500 ms).' },
      stop: { type: 'boolean', description: 'Stop recording instead.' },
    },
    async run(params) {
      watching?.stop()
      watching = null
      if (params.stop === true) return { watching: false }
      const pollMs = Math.min(10_000, Math.max(100, Number(params.pollMs) || 500))
      return { watching: true, via: await startWatch(params.pageId ? String(params.pageId) : null, pollMs) }
    },
  },
  {
    name: 'data.events',
    summary: 'The plugin-data changes recorded since `data.watch`, newest last.',
    mutates: false,
    params: { since: { type: 'number', description: 'Only events after this time (ms since epoch).' } },
    async run(params) {
      const since = Number(params.since) || 0
      return { watching: watching?.via ?? false, now: Date.now(), events: seen.filter((entry) => entry.at > since) }
    },
  },
]
