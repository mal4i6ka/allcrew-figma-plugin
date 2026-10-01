import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function figmaSettingsPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (env.ALLCREW_CHANNEL_FIGMA_SETTINGS) return env.ALLCREW_CHANNEL_FIGMA_SETTINGS
  if (env.ALTERY_FIGMA_SETTINGS) return env.ALTERY_FIGMA_SETTINGS
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Figma', 'settings.json')
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'Figma', 'settings.json')
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Figma', 'settings.json')
}

export function keyFromTabPath(value) {
  const text = String(value || '')
  const branch = /(?:^|\/)branch\/([A-Za-z0-9]{10,})/.exec(text)
  if (branch) return { key: branch[1], isBranch: true }
  const file = /(?:^|\/)(?:file|design|board|slides|site|buzz|rev|weave|spec|make|proto|deck|presenter|export)\/([A-Za-z0-9]{10,})/.exec(text)
  return file ? { key: file[1], isBranch: false } : null
}

function tab(entry, open) {
  if (!entry || typeof entry !== 'object') return null
  const parsed = keyFromTabPath(entry.path || entry.url)
  if (!parsed) return null
  const title = typeof entry.title === 'string' ? entry.title.trim() : ''
  const edited = Number(entry.editedAt) || Date.parse(entry.dateClosed || '') || Number(entry.lastViewedAt) || 0
  return {
    key: parsed.key,
    title,
    editorType: typeof entry.editorType === 'string' ? entry.editorType : null,
    path: String(entry.path || entry.url || ''),
    isBranch: entry.isBranch === true || parsed.isBranch,
    editedAt: Number.isFinite(edited) ? edited : 0,
    open,
  }
}

export function parseDesktopTabs(raw) {
  const settings = raw && typeof raw === 'object' ? raw : {}
  const open = []
  for (const window of Array.isArray(settings.windows) ? settings.windows : []) {
    for (const entry of Array.isArray(window?.tabs) ? window.tabs : []) {
      const parsed = tab(entry, true)
      if (parsed) open.push(parsed)
    }
  }
  const recent = []
  for (const entry of Array.isArray(settings.sharedTabHistory) ? settings.sharedTabHistory : []) {
    const parsed = tab(entry, false)
    if (parsed) recent.push(parsed)
  }
  const dedupe = (rows) => {
    const byKey = new Map()
    for (const row of rows.sort((a, b) => b.editedAt - a.editedAt)) if (!byKey.has(row.key)) byKey.set(row.key, row)
    return [...byKey.values()]
  }
  return { open: dedupe(open), recent: dedupe(recent) }
}

export function readDesktopTabs(options = {}) {
  const file = options.file || figmaSettingsPath(options.platform, options.env, options.home)
  try {
    return { file, found: true, ...parseDesktopTabs(JSON.parse(fs.readFileSync(file, 'utf8'))) }
  } catch (error) {
    return { file, found: false, open: [], recent: [], error: String(error?.message || error) }
  }
}

function pageSignature(pages) {
  return JSON.stringify(
    (Array.isArray(pages) ? pages : [])
      .filter((page) => page && typeof page.id === 'string' && typeof page.name === 'string')
      .map((page) => [page.id, page.name])
      .sort((a, b) => a[0].localeCompare(b[0]))
  )
}

/** Never guesses between same-titled files: page identity must make one candidate unique. */
export async function matchTab({ title, pages }, tabs, fetchPages) {
  const candidates = (Array.isArray(tabs) ? tabs : []).filter((entry) => entry.title === title)
  if (candidates.length === 0) return { key: null, via: null, candidates: [] }
  if (candidates.length === 1) return { key: candidates[0].key, via: 'desktop-title', candidates }
  const wanted = pageSignature(pages)
  if (!wanted || wanted === '[]' || typeof fetchPages !== 'function') {
    return { key: null, via: null, ambiguous: true, candidates }
  }
  const matched = []
  for (const candidate of candidates) {
    try {
      if (pageSignature(await fetchPages(candidate.key)) === wanted) matched.push(candidate)
    } catch {
      // Unreadable candidate stays a candidate, never a negative match worth guessing past.
    }
  }
  return matched.length === 1
    ? { key: matched[0].key, via: 'desktop-pages', candidates }
    : { key: null, via: null, ambiguous: true, candidates }
}

export async function runRecentHistory(params, { tabs, listVersions, fileMeta, now = () => Date.now() }) {
  const current = now()
  const midnight = new Date(current)
  midnight.setHours(0, 0, 0, 0)
  const since = params.since === undefined ? midnight.getTime() : Date.parse(String(params.since))
  if (!Number.isFinite(since)) throw new Error('since must be an ISO date or date-time')
  const budgetMs = Math.min(170_000, Math.max(1_000, Number(params.budgetMs) || 120_000))
  const perFileLimit = Math.min(50, Math.max(1, Number(params.limit) || 50))
  const candidates = []
  const seen = new Set()
  for (const entry of [...(tabs.open || []), ...(tabs.recent || [])]) {
    if (seen.has(entry.key)) continue
    seen.add(entry.key)
    candidates.push(entry)
  }
  const touched = []
  const quiet = []
  const unavailable = []
  let next = 0
  let timedOut = false
  const authors = new Map()
  const worker = async () => {
    while (next < candidates.length) {
      if (now() - current >= budgetMs) { timedOut = true; return }
      const candidate = candidates[next++]
      try {
        const [versions, meta] = await Promise.all([
          listVersions(candidate.key, { limit: perFileLimit }),
          fileMeta(candidate.key).catch(() => null),
        ])
        const items = (Array.isArray(versions) ? versions : []).filter((version) => Date.parse(version.created_at || '') >= since)
        const name = meta?.name || candidate.title || candidate.key
        if (items.length === 0) {
          quiet.push({ fileKey: candidate.key, name, open: candidate.open })
          continue
        }
        const byAuthor = new Map()
        for (const version of items) {
          const author = version.user?.handle || null
          byAuthor.set(author, (byAuthor.get(author) || 0) + 1)
          authors.set(author, (authors.get(author) || 0) + 1)
        }
        touched.push({
          fileKey: candidate.key,
          name,
          open: candidate.open,
          checkpoints: items.length,
          named: items.filter((version) => Boolean(version.label)).length,
          authors: [...byAuthor.entries()].map(([author, checkpoints]) => ({ author, checkpoints })),
          latest: items[0]?.created_at || null,
        })
      } catch (error) {
        unavailable.push({ fileKey: candidate.key, name: candidate.title || candidate.key, error: String(error?.message || error) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => worker()))
  return {
    since: new Date(since).toISOString(),
    scanned: touched.length + quiet.length + unavailable.length,
    totalCandidates: candidates.length,
    timedOut,
    touched: touched.sort((a, b) => String(b.latest).localeCompare(String(a.latest))),
    quiet,
    unavailable,
    authors: [...authors.entries()]
      .map(([author, checkpoints]) => ({ author, checkpoints }))
      .sort((a, b) => b.checkpoints - a.checkpoints),
    ms: now() - current,
  }
}
