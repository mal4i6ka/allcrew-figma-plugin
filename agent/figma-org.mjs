/**
 * The organisation half of the Figma REST API — activity logs, library analytics, and the
 * folder tree they both describe.
 *
 * Everything else this bridge reads is scoped to a file somebody opened. These are scoped to
 * the organisation, and that single difference drags in a second credential, a second auth
 * header, and a plan requirement, which is why they sat refused for a month rather than being
 * half-built.
 *
 * **The two credentials are not interchangeable, and the API says so in both directions.**
 * Measured against the live API rather than assumed:
 *
 *     GET /v1/activity_logs   X-Figma-Token: figd_…   → 401 "OAuth token is not passed in the
 *                                                        Bearer authorization header."
 *     GET /v1/activity_logs   Authorization: Bearer figd_…
 *                                                     → 401 "figd_ tokens must be passed via
 *                                                        X-Figma-Token header, not Authorization"
 *
 * A personal access token therefore cannot read activity logs under any header and with any
 * scopes — the catch is closed on both sides. The old refusal text said this correctly; the CLI
 * said the opposite ("needs an org admin token, not a member's") and sent people to re-mint a
 * token that was never going to work. Only a real OAuth2 grant does, which is what `oauth.mjs`
 * concerns in this same folder exist for.
 *
 * Library analytics is the opposite case and was refused for no reason at all: it takes the
 * ordinary personal token on the ordinary header, and answers
 *
 *     403 Invalid scope: [...]. This endpoint requires the library_analytics:read scope.
 *
 * — which is a token that needs re-minting with one more box ticked, not a wall. That error is
 * also the only place Figma will tell you what a token's scopes actually ARE: there is no
 * introspection endpoint, so `probeScopes` deliberately makes a call it expects to fail and
 * reads the list out of the complaint.
 *
 * **Nothing here is gated on the caller being an Enterprise org admin.** An op states what it
 * needs, tries, and when the credential falls short says which one thing would fix it and what
 * answers the same question today. `org.capabilities` is that reasoning made callable, so an
 * agent can ask once what this machine can see instead of discovering it one 403 at a time.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = () => process.env.ALLCREW_CHANNEL_HOME || os.homedir()

export const OAUTH_TOKEN_FILE = () =>
  process.env.ALLCREW_CHANNEL_FIGMA_OAUTH_FILE || path.join(HOME(), '.allcrew-channel', 'figma-oauth.json')
export const OAUTH_APP_FILE = () =>
  process.env.ALLCREW_CHANNEL_FIGMA_OAUTH_APP_FILE || path.join(HOME(), '.allcrew-channel', 'figma-oauth-app.json')

export const FIGMA_API = (process.env.ALLCREW_CHANNEL_FIGMA_API || 'https://api.figma.com').replace(/\/+$/, '')
export const FIGMA_WWW = (process.env.ALLCREW_CHANNEL_FIGMA_WWW || 'https://www.figma.com').replace(/\/+$/, '')

/** The one scope the activity log accepts. Figma rejects a token carrying anything else. */
export const ACTIVITY_SCOPE = 'org:activity_log_read'
export const ANALYTICS_SCOPE = 'library_analytics:read'
export const FOLDERS_SCOPE = 'folders:read'
export const FOLDER_METADATA_SCOPE = 'folder_metadata:read'

/* ------------------------------------------------------------------ credentials */

/**
 * The stored OAuth grant, with its age judged rather than reported.
 *
 * `expires_at` is computed at save time from `expires_in`, because a token that says "expires
 * in 7776000 seconds" is useless to anyone reading the file later. Figma's own expiry is 90
 * days; the margin exists so a long-running call does not start on a token that dies mid-flight.
 */
export function readOAuth({ now = () => Date.now(), marginMs = 5 * 60 * 1000 } = {}) {
  if (process.env.ALLCREW_CHANNEL_FIGMA_OAUTH_TOKEN) {
    return {
      state: 'env',
      accessToken: process.env.ALLCREW_CHANNEL_FIGMA_OAUTH_TOKEN.trim(),
      scopes: null,
      source: 'ALLCREW_CHANNEL_FIGMA_OAUTH_TOKEN',
    }
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(OAUTH_TOKEN_FILE(), 'utf8'))
  } catch {
    return { state: 'absent', accessToken: '', source: OAUTH_TOKEN_FILE() }
  }
  const expiresAt = Number(raw.expires_at) || 0
  const expired = expiresAt > 0 && expiresAt - marginMs <= now()
  return {
    state: expired ? 'expired' : 'fresh',
    accessToken: String(raw.access_token || ''),
    refreshToken: String(raw.refresh_token || ''),
    scopes: Array.isArray(raw.scopes) ? raw.scopes : null,
    expiresAt,
    source: OAUTH_TOKEN_FILE(),
  }
}

/** Written 0600 and never logged: this is a credential that can read an organisation's audit log. */
export function writeOAuth(grant, { now = () => Date.now() } = {}) {
  const file = OAUTH_TOKEN_FILE()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = {
    access_token: grant.access_token,
    refresh_token: grant.refresh_token,
    // Seconds from Figma, absolute milliseconds on disk — see readOAuth.
    expires_at: now() + Number(grant.expires_in || 0) * 1000,
    scopes: grant.scopes || [ACTIVITY_SCOPE],
    saved_at: new Date(now()).toISOString(),
  }
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* A filesystem that will not take a mode is not a reason to refuse the token. */
  }
  return file
}

export function readOAuthApp() {
  const fromEnv =
    process.env.ALLCREW_CHANNEL_FIGMA_OAUTH_CLIENT_ID &&
    process.env.ALLCREW_CHANNEL_FIGMA_OAUTH_CLIENT_SECRET
  if (fromEnv) {
    return {
      clientId: process.env.ALLCREW_CHANNEL_FIGMA_OAUTH_CLIENT_ID.trim(),
      clientSecret: process.env.ALLCREW_CHANNEL_FIGMA_OAUTH_CLIENT_SECRET.trim(),
      source: 'environment',
    }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(OAUTH_APP_FILE(), 'utf8'))
    return {
      clientId: String(raw.client_id || ''),
      clientSecret: String(raw.client_secret || ''),
      source: OAUTH_APP_FILE(),
    }
  } catch {
    return { clientId: '', clientSecret: '', source: OAUTH_APP_FILE() }
  }
}

export function writeOAuthApp({ clientId, clientSecret }) {
  const file = OAUTH_APP_FILE()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ client_id: clientId, client_secret: clientSecret }, null, 2) + '\n', {
    mode: 0o600,
  })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* A filesystem that will not take a mode is not a reason to refuse the app credentials. */
  }
  return file
}

/* ----------------------------------------------------------------- oauth flow */

export function authorizeUrl({ clientId, redirectUri, state, scope = ACTIVITY_SCOPE }) {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    response_type: 'code',
  })
  return `${FIGMA_WWW}/oauth?${query}`
}

/**
 * Code → grant. Figma wants the client credentials as HTTP Basic and the rest form-encoded;
 * sending the id and secret in the body (which several of its own older examples do) answers
 * 400 with a message about the grant type, which is a confusing way to say "wrong auth".
 */
export async function exchangeCode({ clientId, clientSecret, redirectUri, code, fetchImpl = fetch }) {
  return oauthPost('/v1/oauth/token', { clientId, clientSecret, fetchImpl }, {
    redirect_uri: redirectUri,
    code,
    grant_type: 'authorization_code',
  })
}

/** Refresh answers a new access token and may omit the refresh token — preserve the old one. */
export async function refreshGrant({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  const next = await oauthPost('/v1/oauth/token', { clientId, clientSecret, fetchImpl }, {
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  return { ...next, refresh_token: next.refresh_token || refreshToken }
}

async function oauthPost(route, { clientId, clientSecret, fetchImpl }, fields) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const response = await fetchImpl(`${FIGMA_API}${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    /* handled below — the status is the answer */
  }
  if (!response.ok) {
    const said = (parsed && (parsed.message || parsed.err || parsed.error)) || text.slice(0, 200)
    throw new Error(`Figma OAuth ${response.status} on ${route}${said ? ` — ${said}` : ''}`)
  }
  if (!parsed || !parsed.access_token) throw new Error(`Figma OAuth ${route} answered without an access_token`)
  return parsed
}

/* -------------------------------------------------------------------- fetching */

/**
 * One organisation-level call, with the header chosen by which credential the route takes.
 *
 * The split is not a preference: `/v1/activity_logs` refuses `X-Figma-Token` outright, and every
 * other route here refuses a Bearer `figd_`. Routing by prefix keeps that fact in one place
 * instead of in every caller.
 */
export function headerFor(route, { pat, oauth }) {
  if (route.startsWith('/v1/activity_logs') || route.startsWith('/v1/developer_logs')) {
    if (!oauth) return null
    return { Authorization: `Bearer ${oauth}` }
  }
  if (!pat) return null
  return { 'X-Figma-Token': pat }
}

export async function orgFetch(route, { pat, oauth, fetchImpl = fetch } = {}) {
  const headers = headerFor(route, { pat, oauth })
  if (!headers) throw new Error(missingCredential(route))
  const response = await fetchImpl(`${FIGMA_API}${route}`, { headers })
  const text = await response.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    /* handled below */
  }
  if (!response.ok) {
    const said = (parsed && (parsed.message || parsed.err)) || text.slice(0, 300)
    const err = new Error(`Figma REST ${response.status} on ${route}${said ? ` — ${said}` : ''}`)
    err.status = response.status
    err.figmaMessage = said
    throw err
  }
  return parsed
}

function missingCredential(route) {
  if (route.startsWith('/v1/activity_logs') || route.startsWith('/v1/developer_logs')) {
    return (
      'this needs an OAuth grant, not a personal access token. Measured both ways: a figd_ token on ' +
      'X-Figma-Token answers "OAuth token is not passed in the Bearer authorization header", and the same token ' +
      'on Authorization: Bearer answers "figd_ tokens must be passed via X-Figma-Token header". Run ' +
      '`allcrew-channel auth` once (Enterprise org admin, 2FA on, an OAuth app registered at figma.com/developers/apps). ' +
      'Until then history.versions answers "who touched this file" on any plan.'
    )
  }
  return `no Figma token — put one in ~/.allcrew-channel/figma-token or FIGMA_TOKEN`
}

/**
 * A token's real scopes, read out of a deliberate failure.
 *
 * Figma has no introspection endpoint, but a 403 from a scope-gated route lists everything the
 * token DOES carry. So the cheapest honest answer to "what may this credential do" is to ask it
 * for something it probably cannot have and read the complaint. A 200 means the scope is there
 * and the list is unknowable — which is fine, because then the answer is "yes".
 */
export function scopesFromRefusal(message) {
  const text = String(message || '')
  const match = text.match(/Invalid scope:\s*\[([^\]]*)\]/)
  if (!match) return null
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/* ------------------------------------------------------------------ the ops */

export const ORG_OPS = ['org.capabilities', 'org.activity', 'org.projects', 'org.files']
export const ANALYTICS_OPS = ['library.actions', 'library.usages']

const ASSET_KINDS = ['component', 'style', 'variable']

/** `group_by` is required by Figma and its legal values differ per endpoint, so the vocabulary
 * is stated once here rather than guessed at the call site. */
const GROUPINGS = {
  actions: { component: ['component', 'team'], style: ['style', 'team'], variable: ['variable', 'team'] },
  usages: { component: ['component', 'file'], style: ['style', 'file'], variable: ['variable', 'file'] },
}

export const ORG_MANIFEST = [
  {
    name: 'org.capabilities',
    summary: 'What this machine can actually see of the organisation, and the one thing that would widen it.',
    mutates: false,
    agent:
      'Call this FIRST, once, before any other org or library op — it is two cheap requests and it replaces ' +
      'discovering the same facts one 403 at a time. For each surface it says reachable true/false, and when ' +
      'false it names the single remedy and what answers the same question today. The two credentials are not ' +
      'interchangeable: library analytics and the folder tree take the personal token, activity logs take an ' +
      'OAuth grant and REFUSE a personal one whatever its scopes. Pass `fileKey` (any library you can open) to ' +
      'get a conclusive answer about analytics: Figma publishes no introspection endpoint, so the only place a ' +
      "token's scopes are listed is the 403 from a real file — a made-up key answers 404 before the scope is " +
      'ever checked. Without it that one surface reports "unknown" rather than guessing.',
    params: {
      fileKey: {
        type: 'string',
        description:
          'A library file key to probe the analytics scope against. Any file you can open works; nothing is written.',
      },
    },
  },
  {
    name: 'org.activity',
    summary: 'The organisation audit log — who did what, including access granted and revoked.',
    mutates: false,
    agent:
      'The ONLY place Figma records permission changes: who was given or lost access to a file, project or team ' +
      'exists nowhere else in the API, not in any file-scoped read. Enterprise plans only, organisation admins ' +
      'only, and an OAuth grant only — a personal access token is refused on both headers, so if `allcrew-channel ' +
      'auth` has not been run this op cannot work no matter whose token you supply. Events are newest-last the ' +
      'way Figma returns them; pass `events` to narrow, which is much cheaper than filtering afterwards.',
    params: {
      events: {
        type: 'string',
        description:
          'Comma-separated event types to include, e.g. "file_permission.change,user.join". Omitted means every type.',
      },
      since: { type: 'string', description: 'ISO date or datetime — only events at or after it. Omitted means Figma\'s own window.' },
      until: { type: 'string', description: 'ISO date or datetime — only events at or before it.' },
      limit: { type: 'number', default: 100, min: 1, max: 1000, description: 'Events per page. Figma caps this at 1000.' },
      all: { type: 'boolean', default: false, description: 'Follow the cursor to the end rather than returning one page. Bounded by `maxPages`.' },
      maxPages: { type: 'number', default: 10, min: 1, max: 100, description: 'Stop after this many pages when `all` is set, and say so rather than running until the bridge ceiling.' },
    },
  },
  {
    name: 'org.projects',
    summary: 'The folders in a team, including a bounded nested-folder inventory.',
    mutates: false,
    agent:
      'The released op name is retained, but Figma now calls projects folders and project ids are folder ids. ' +
      'Takes the personal token with folders:read; this scope is unavailable to public OAuth apps. `teamId` ' +
      'comes out of a team URL: figma.com/files/team/<id>/… . By default only top-level folders are returned; ' +
      'pass `recursive` or `depth` to include subfolders. Every folder has a `path` suitable for display.',
    params: {
      teamId: { type: 'string', description: 'The team id, from a figma.com/files/team/<id> URL. The legacy `team` alias is also accepted.' },
      team: { type: 'string', description: 'Legacy alias for `teamId`.' },
      recursive: { type: 'boolean', default: false, description: 'Traverse nested folders. Defaults to depth 5 unless `depth` is supplied.' },
      depth: { type: 'number', default: 1, min: 1, max: 5, description: 'Folder levels to return, including the top level.' },
      maxPages: { type: 'number', default: 100, min: 1, max: 500, description: 'Ceiling for folder-list requests, including any cursor pages.' },
      maxNodes: { type: 'number', default: 1000, min: 1, max: 10000, description: 'Maximum folders returned before `truncated` is set.' },
      timeoutMs: { type: 'number', default: 5000, min: 100, max: 30000, description: 'Traversal time budget before `truncated` is set.' },
    },
  },
  {
    name: 'org.files',
    summary: 'The files in a folder, optionally including files from nested folders.',
    mutates: false,
    agent:
      'The released `projectId` parameter still works because Figma renamed projects to folders without changing ' +
      'their ids; `folderId` is the current spelling. The result keeps the stalest-first summary. By default it ' +
      'lists direct files only; pass `recursive` or `depth` to walk subfolders within bounded request, node, and time budgets.',
    params: {
      folderId: { type: 'string', description: 'The folder id, from org.projects. `projectId` and `project` remain accepted.' },
      projectId: { type: 'string', description: 'Backwards-compatible alias for `folderId`.' },
      project: { type: 'string', description: 'Legacy alias for `folderId`.' },
      branches: { type: 'boolean', default: false, description: 'Include branch metadata for main files with branches.' },
      recursive: { type: 'boolean', default: false, description: 'Include files in nested folders. Defaults to depth 5 unless `depth` is supplied.' },
      depth: { type: 'number', default: 1, min: 1, max: 5, description: 'Folder levels whose files are returned, including the requested folder.' },
      maxPages: { type: 'number', default: 100, min: 1, max: 500, description: 'Ceiling for file/folder-list requests, including cursor pages.' },
      maxNodes: { type: 'number', default: 1000, min: 1, max: 10000, description: 'Maximum files returned before `truncated` is set.' },
      timeoutMs: { type: 'number', default: 5000, min: 100, max: 30000, description: 'Traversal time budget before `truncated` is set.' },
    },
  },
]

export const ANALYTICS_MANIFEST = [
  {
    name: 'library.actions',
    summary: 'Weekly insertions and detachments of a library\'s components, styles or variables.',
    mutates: false,
    agent:
      'What people DID with the design system, week by week — the behaviour question. `groupBy: "team"` answers ' +
      '"which teams are adopting this" and is usually what somebody means; `groupBy: "component"` (or "style" / ' +
      '"variable") answers "which pieces are used and which are ignored". Detachments are the number worth ' +
      'reading: a component inserted often and detached often is one that nearly fits and is being fought with. ' +
      'Needs library_analytics:read on the personal token — a scope chosen when the token is minted, so a 403 ' +
      'here means re-mint, not a different plan. `summary` aggregates the weekly rows so the answer is a finding ' +
      'rather than a spreadsheet; the rows are still there under `rows`.',
    params: {
      fileKey: { type: 'string', description: 'The LIBRARY file key — the file that publishes the assets, not a file that consumes them.' },
      asset: { type: 'string', default: 'component', description: `What to count: ${ASSET_KINDS.join(', ')}.` },
      groupBy: { type: 'string', description: 'For actions: the asset kind itself, or "team". Defaults to the asset kind.' },
      since: { type: 'string', description: 'ISO date (YYYY-MM-DD). Omitted means Figma returns the prior year.' },
      until: { type: 'string', description: 'ISO date (YYYY-MM-DD). Omitted means up to the last full week.' },
      all: { type: 'boolean', default: false, description: 'Follow the cursor to the end rather than returning one page.' },
      maxPages: { type: 'number', default: 10, min: 1, max: 100, description: 'Page ceiling when `all` is set.' },
    },
  },
  {
    name: 'library.usages',
    summary: 'Where a library\'s assets are in use right now — by asset, or by the file consuming them.',
    mutates: false,
    agent:
      'The standing-stock question, against library.actions\' flow question: not "who inserted this last month" ' +
      'but "what is live today". `groupBy: "file"` lists the consuming files with their team and workspace, which ' +
      'is the closest thing this API has to "who depends on us". `groupBy: "component"` ranks the library by ' +
      'reach, and a published asset with zero usages is the cheapest deprecation candidate there is. Same scope ' +
      'and same plan rule as library.actions.',
    params: {
      fileKey: { type: 'string', description: 'The LIBRARY file key.' },
      asset: { type: 'string', default: 'component', description: `What to count: ${ASSET_KINDS.join(', ')}.` },
      groupBy: { type: 'string', description: 'For usages: the asset kind itself, or "file". Defaults to the asset kind.' },
      all: { type: 'boolean', default: false, description: 'Follow the cursor to the end rather than returning one page.' },
      maxPages: { type: 'number', default: 10, min: 1, max: 100, description: 'Page ceiling when `all` is set.' },
    },
  },
]

/* --------------------------------------------------------------- the runners */

/** Pages a cursor-paginated endpoint, and says when it stopped early rather than implying the end. */
async function pageThrough(route, { all, maxPages, get }) {
  const rows = []
  let cursor = null
  let pages = 0
  let more = false
  do {
    const url = cursor ? `${route}${route.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : route
    const answer = await get(url)
    pages += 1
    if (Array.isArray(answer?.rows)) rows.push(...answer.rows)
    else if (Array.isArray(answer?.activity_logs)) rows.push(...answer.activity_logs)
    else if (Array.isArray(answer?.meta?.activity_logs)) rows.push(...answer.meta.activity_logs)
    cursor = answer?.cursor || answer?.next_page_cursor || answer?.pagination?.next_page || null
    more = Boolean(answer?.next_page) && Boolean(cursor)
    if (!all) break
  } while (more && pages < maxPages)
  return { rows, pages, truncated: more && pages >= maxPages, cursor: more ? cursor : null }
}

/**
 * Weekly rows → a sentence. The raw payload is one row per asset per week, which for a real
 * library is thousands of rows nobody reads; the totals and the five busiest names are the part
 * that answers the question that was asked.
 */
export function summariseActions(rows) {
  const byName = new Map()
  const weeks = new Set()
  let insertions = 0
  let detachments = 0
  for (const row of rows) {
    const name =
      row.component_name || row.style_name || row.variable_name || row.team_name || row.workspace_name || '—'
    const entry = byName.get(name) || { name, insertions: 0, detachments: 0 }
    entry.insertions += Number(row.insertions) || 0
    entry.detachments += Number(row.detachments) || 0
    byName.set(name, entry)
    insertions += Number(row.insertions) || 0
    detachments += Number(row.detachments) || 0
    if (row.week) weeks.add(row.week)
  }
  const ranked = [...byName.values()].sort((a, b) => b.insertions - a.insertions)
  const sortedWeeks = [...weeks].sort()
  return {
    insertions,
    detachments,
    /* The ratio is the finding. A component detached as often as it is inserted is not adopted,
     * it is endured, and that does not show in either raw count on its own. */
    detachRate: insertions > 0 ? Number((detachments / insertions).toFixed(3)) : null,
    weeks: sortedWeeks.length,
    from: sortedWeeks[0] || null,
    to: sortedWeeks[sortedWeeks.length - 1] || null,
    distinct: byName.size,
    busiest: ranked.slice(0, 5),
    mostDetached: [...byName.values()]
      .filter((entry) => entry.detachments > 0)
      .sort((a, b) => b.detachments - a.detachments)
      .slice(0, 5),
  }
}

export function summariseUsages(rows) {
  let usages = 0
  for (const row of rows) usages += Number(row.usages) || 0
  const ranked = [...rows].sort((a, b) => (Number(b.usages) || 0) - (Number(a.usages) || 0))
  const named = (row) => row.component_name || row.style_name || row.variable_name || row.file_name || '—'
  return {
    usages,
    rows: rows.length,
    /* Zero-usage assets are the whole reason to look at usages rather than actions: nothing else
     * in Figma will tell you what you are maintaining for nobody. */
    unused: rows.filter((row) => (Number(row.usages) || 0) === 0).map(named),
    top: ranked.slice(0, 5).map((row) => ({ name: named(row), usages: Number(row.usages) || 0 })),
  }
}

/**
 * Runs one org or analytics op. `get` is injected so every path here is testable without a
 * network, which matters more than usual: the interesting behaviour of these ops IS their
 * failure handling, and a test that cannot produce a 403 cannot check it.
 */
export async function runOrgOp(op, params = {}, { pat, oauth, get, now = () => Date.now() } = {}) {
  const fetchJson = get || ((route) => orgFetch(route, { pat, oauth }))

  if (op === 'org.capabilities') return capabilities({ pat, oauth, fetchJson, now, fileKey: params.fileKey })

  if (op === 'org.activity') {
    if (!oauth) throw new Error(missingCredential('/v1/activity_logs'))
    const query = new URLSearchParams()
    if (params.events) query.set('events', String(params.events))
    const since = stamp(params.since)
    const until = stamp(params.until)
    if (since) query.set('start_time', String(since))
    if (until) query.set('end_time', String(until))
    query.set('limit', String(clamp(params.limit, 1, 1000, 100)))
    const paged = await pageThrough(`/v1/activity_logs?${query}`, {
      all: params.all === true,
      maxPages: clamp(params.maxPages, 1, 100, 10),
      get: fetchJson,
    })
    return {
      events: paged.rows,
      count: paged.rows.length,
      pages: paged.pages,
      truncated: paged.truncated,
      cursor: paged.cursor,
      ...(paged.truncated
        ? { note: `stopped at ${paged.pages} pages — pass a larger maxPages, or narrow with events/since.` }
        : {}),
    }
  }

  if (op === 'org.projects') {
    const teamId = String(params.teamId || params.team || '').trim()
    if (!teamId) throw new Error('org.projects needs teamId (or team) — take it from a figma.com/files/team/<id> URL')
    const depth = folderDepth(params)
    const budget = folderBudget(params, now, fetchJson)
    try {
      const first = await collectFolderPages(
        `/v2/teams/${encodeURIComponent(teamId)}/folders`,
        'folders',
        budget
      )
      const folders = []
      const queue = first.rows.map((folder) => ({ folder, level: 1, path: String(folder.name || '') }))
      let teamName = first.name
      while (queue.length) {
        if (timeBudgetExceeded(budget)) break
        const current = queue.shift()
        folders.push({ ...current.folder, path: current.path, depth: current.level })
        budget.nodes += 1
        if (budget.nodes >= budget.maxNodes) {
          if (queue.length || current.level < depth) budget.truncated = true
          break
        }
        if (current.level >= depth) continue
        const childPage = await collectFolderPages(
          `/v2/folders/${encodeURIComponent(current.folder.id)}/folders`,
          'folders',
          budget
        )
        for (const child of childPage.rows) {
          queue.push({
            folder: child,
            level: current.level + 1,
            path: `${current.path}/${String(child.name || '')}`,
          })
        }
      }
      return {
        teamId,
        name: teamName || null,
        projects: folders,
        folders,
        count: folders.length,
        depth,
        pages: budget.pages,
        truncated: budget.truncated,
        ...(budget.truncated ? { note: folderTruncationNote(budget) } : {}),
      }
    } catch (err) {
      throw decorateFolderScopeError(err)
    }
  }

  if (op === 'org.files') {
    const folderId = String(params.folderId || params.projectId || params.project || '').trim()
    if (!folderId) throw new Error('org.files needs folderId (projectId still works) — call org.projects first')
    const depth = folderDepth(params)
    const budget = folderBudget(params, now, fetchJson)
    const branchQuery = params.branches === true ? '?branch_data=true' : ''
    const files = []
    const folders = [{ id: folderId, path: null, level: 1 }]
    let rootName = null
    try {
      while (folders.length) {
        if (timeBudgetExceeded(budget)) break
        const current = folders.shift()
        const page = await collectFolderPages(
          `/v2/folders/${encodeURIComponent(current.id)}/files${branchQuery}`,
          'files',
          budget
        )
        const folderName = page.name || current.id
        const folderPath = current.path || folderName
        if (current.level === 1) rootName = page.name || null
        for (const file of page.rows) {
          if (timeBudgetExceeded(budget) || budget.nodes >= budget.maxNodes) {
            budget.truncated = true
            break
          }
          files.push({ ...file, folder_id: current.id, folder_path: folderPath })
          budget.nodes += 1
        }
        if (budget.truncated || current.level >= depth) continue
        const childPage = await collectFolderPages(
          `/v2/folders/${encodeURIComponent(current.id)}/folders`,
          'folders',
          budget
        )
        for (const child of childPage.rows) {
          folders.push({ id: child.id, path: `${folderPath}/${String(child.name || '')}`, level: current.level + 1 })
        }
      }
    } catch (err) {
      throw decorateFolderScopeError(err)
    }
    return {
      folderId,
      projectId: folderId,
      name: rootName,
      count: files.length,
      files,
      depth,
      pages: budget.pages,
      truncated: budget.truncated,
      ...(budget.truncated ? { note: folderTruncationNote(budget) } : {}),
      /* The question behind "what is there" is almost always "what is stale", and the payload
       * already carries the answer — sorting it here saves the caller a second pass. */
      stalest: [...files]
        .sort((a, b) => String(a.last_modified || '').localeCompare(String(b.last_modified || '')))
        .slice(0, 5)
        .map((file) => ({ key: file.key, name: file.name, last_modified: file.last_modified })),
    }
  }

  if (ANALYTICS_OPS.includes(op)) return analytics(op, params, { fetchJson })

  throw new Error(`"${op}" is not an organisation op`)
}

function folderDepth(params) {
  if (params.depth !== undefined) return clamp(params.depth, 1, 5, 1)
  return params.recursive === true ? 5 : 1
}

function folderBudget(params, now, get) {
  const startedAt = now()
  return {
    now,
    get,
    startedAt,
    timeoutMs: clamp(params.timeoutMs, 100, 30000, 5000),
    maxPages: clamp(params.maxPages, 1, 500, 100),
    maxNodes: clamp(params.maxNodes, 1, 10000, 1000),
    pages: 0,
    nodes: 0,
    truncated: false,
    reason: null,
  }
}

function timeBudgetExceeded(budget) {
  if (budget.now() - budget.startedAt < budget.timeoutMs) return false
  budget.truncated = true
  budget.reason = 'time budget'
  return true
}

function budgetExceeded(budget) {
  if (budget.pages >= budget.maxPages) {
    budget.truncated = true
    budget.reason = 'page ceiling'
    return true
  }
  if (budget.now() - budget.startedAt >= budget.timeoutMs) {
    budget.truncated = true
    budget.reason = 'time budget'
    return true
  }
  return false
}

/** Folder endpoints are currently single-page, but cursor handling keeps the bounded contract
 * honest if the service pages a large team in the future. */
async function collectFolderPages(route, key, budget) {
  const rows = []
  let cursor = null
  let name = null
  do {
    if (budgetExceeded(budget)) break
    const url = cursor ? `${route}${route.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : route
    const answer = await budget.get(url)
    budget.pages += 1
    if (name === null && answer?.name) name = answer.name
    if (Array.isArray(answer?.[key])) rows.push(...answer[key])
    const next = answer?.cursor || answer?.next_page_cursor || answer?.pagination?.next_page || null
    const more = Boolean(answer?.next_page) && Boolean(next)
    if (!more) break
    cursor = next
    if (budget.pages >= budget.maxPages) {
      budget.truncated = true
      budget.reason = 'page ceiling'
      break
    }
  } while (true)
  return { rows, name }
}

function folderTruncationNote(budget) {
  return `folder traversal stopped at its ${budget.reason || 'node budget'} (${budget.pages} requests, ${budget.nodes} results)`
}

function decorateFolderScopeError(err) {
  const scopes = scopesFromRefusal(err && (err.figmaMessage || err.message))
  if (!scopes || scopes.includes(FOLDERS_SCOPE)) return err
  const next = new Error(
    `${err.message}\n\nThe token is valid but cannot enumerate folders without "${FOLDERS_SCOPE}". ` +
      `Re-mint the personal access token with "${FOLDERS_SCOPE}" ticked; "${FOLDER_METADATA_SCOPE}" only permits ` +
      `GET /v2/folders/:id/meta and cannot list folders or files. Public OAuth apps cannot use ${FOLDERS_SCOPE}. ` +
      `Present scopes: ${scopes.join(', ')}.`
  )
  next.status = err.status
  next.scopes = scopes
  return next
}
async function analytics(op, params, { fetchJson }) {
  const kind = op === 'library.actions' ? 'actions' : 'usages'
  const asset = String(params.asset || 'component')
  if (!ASSET_KINDS.includes(asset)) {
    throw new Error(`asset must be one of ${ASSET_KINDS.join(', ')} — got "${asset}"`)
  }
  const allowed = GROUPINGS[kind][asset]
  const groupBy = String(params.groupBy || asset)
  if (!allowed.includes(groupBy)) {
    throw new Error(`groupBy for ${op} on ${asset} must be one of ${allowed.join(' or ')} — got "${groupBy}"`)
  }
  const key = String(params.fileKey || '').trim()
  if (!key) throw new Error('library analytics needs the LIBRARY file key — the file that publishes the assets')

  const query = new URLSearchParams({ group_by: groupBy })
  if (kind === 'actions') {
    if (params.since) query.set('start_date', isoDate(params.since))
    if (params.until) query.set('end_date', isoDate(params.until))
  }
  const route = `/v1/analytics/libraries/${encodeURIComponent(key)}/${asset}/${kind}?${query}`

  let paged
  try {
    paged = await pageThrough(route, {
      all: params.all === true,
      maxPages: clamp(params.maxPages, 1, 100, 10),
      get: fetchJson,
    })
  } catch (err) {
    throw decorateScopeError(err)
  }

  return {
    fileKey: key,
    asset,
    groupBy,
    rows: paged.rows,
    pages: paged.pages,
    truncated: paged.truncated,
    cursor: paged.cursor,
    summary: kind === 'actions' ? summariseActions(paged.rows) : summariseUsages(paged.rows),
  }
}

/** A scope 403 is a re-mint, not a wall, and the difference is worth spelling out every time. */
function decorateScopeError(err) {
  const scopes = scopesFromRefusal(err && (err.figmaMessage || err.message))
  if (!scopes) return err
  const next = new Error(
    `${err.message}\n\nThe token is valid and carries ${scopes.length} scopes, but not ${ANALYTICS_SCOPE}. ` +
      'Scopes are fixed when a personal access token is created, so this is fixed by minting a new one with ' +
      `"${ANALYTICS_SCOPE}" ticked (figma.com/developers/api#access-tokens) and replacing ~/.allcrew-channel/figma-token. ` +
      `Present scopes: ${scopes.join(', ')}.`
  )
  next.status = err.status
  next.scopes = scopes
  return next
}

/**
 * The honest map of what this machine can see. `reachable` is a tri-state: true, false, or
 * `'unknown'` where nothing short of a real call would settle it, which is not the same as no.
 *
 * The scope probe needs a REAL file key and there is no way around that. Figma resolves the file
 * before it checks the scope, so a placeholder key answers `404 Not found` and teaches nothing —
 * the first version of this function used one and reported "no scopes" for a token that may well
 * have had them. Without a key the surface says so instead.
 */
async function capabilities({ pat, oauth, fetchJson, now, fileKey }) {
  const grant = readOAuth({ now })
  const surfaces = []

  surfaces.push({
    surface: 'file history',
    ops: ['history.versions', 'history.diff', 'history.blame'],
    reachable: Boolean(pat),
    needs: 'personal access token with file_versions:read',
    remedy: pat ? null : 'put a token in ~/.allcrew-channel/figma-token',
    answers: 'who touched a given file and when, on any plan',
  })

  let scopes = null
  let analyticsReachable = 'unknown'
  if (pat && fileKey) {
    /* Asks for something the token probably cannot have: the refusal is the only place Figma
     * lists a token's scopes. A 200 is equally informative — it means yes. */
    try {
      await fetchJson(
        `/v1/analytics/libraries/${encodeURIComponent(fileKey)}/component/usages?group_by=component`
      )
      analyticsReachable = true
    } catch (err) {
      scopes = scopesFromRefusal(err && (err.figmaMessage || err.message))
      /* Only a scope refusal is conclusive. A 404 means the key is wrong or invisible to this
       * token, which says nothing either way about analytics. */
      if (scopes) analyticsReachable = scopes.includes(ANALYTICS_SCOPE)
    }
  }

  surfaces.push({
    surface: 'library analytics',
    ops: ANALYTICS_OPS,
    reachable: pat ? analyticsReachable : false,
    needs: `personal access token with ${ANALYTICS_SCOPE}`,
    remedy:
      analyticsReachable === true
        ? null
        : analyticsReachable === 'unknown'
          ? pat
            ? 'pass fileKey (any library you can open) to settle this — a scope cannot be read without a real file'
            : 'put a token in ~/.allcrew-channel/figma-token'
          : `re-mint the personal token with "${ANALYTICS_SCOPE}" ticked — the header is already right`,
    answers: 'which teams and files use the design system, and what they detach',
  })

  surfaces.push({
    surface: 'organisation audit log',
    ops: ['org.activity'],
    reachable: grant.state === 'fresh' || grant.state === 'env',
    needs: `OAuth grant with ${ACTIVITY_SCOPE} (Enterprise plan, org admin, 2FA)`,
    remedy:
      grant.state === 'fresh' || grant.state === 'env'
        ? null
        : grant.state === 'expired'
          ? 'the stored grant has expired — run `allcrew-channel auth --refresh`'
          : 'run `allcrew-channel auth` once; a personal access token cannot do this under any header',
    answers: 'who was granted or lost access, and every other organisation event',
    /* Said plainly because it is the single most expensive misunderstanding in this area. */
    note: 'a personal access token is refused on BOTH headers here, whatever its scopes',
  })

  /* Once the probe has handed us the real scope list, every remaining surface is answerable from
   * it rather than from "a token exists" — which is an assumption, and was wrong often enough
   * elsewhere in this file to be worth not repeating. */
  const scopedFor = (scope) => (Array.isArray(scopes) ? scopes.includes(scope) : pat ? 'unknown' : false)

  surfaces.push({
    surface: 'folder tree',
    ops: ['org.projects', 'org.files'],
    reachable: scopedFor(FOLDERS_SCOPE),
    needs: `personal access token with ${FOLDERS_SCOPE}`,
    remedy: pat
      ? Array.isArray(scopes) && !scopes.includes(FOLDERS_SCOPE)
        ? `re-mint the personal token with "${FOLDERS_SCOPE}" ticked`
        : null
      : 'put a token in ~/.allcrew-channel/figma-token',
    metadataReachable: scopedFor(FOLDER_METADATA_SCOPE),
    metadataNeeds: `${FOLDER_METADATA_SCOPE} only covers lightweight /v2/folders/:id/meta reads`,
    answers: 'what folders and files exist, and when each file was last modified',
  })

  return {
    credentials: {
      personalToken: Boolean(pat),
      scopes: Array.isArray(scopes) ? scopes : null,
      ...(pat && !fileKey
        ? { scopesNote: 'pass fileKey to read them — Figma lists a token\'s scopes only in a 403 from a real file' }
        : {}),
      oauthGrant: grant.state,
      oauthExpiresAt: grant.expiresAt ? new Date(grant.expiresAt).toISOString() : null,
    },
    surfaces,
    /* The one question that has no answer anywhere in the API, said once so nobody goes looking. */
    unanswerable: [
      'who currently HAS access to a file, project or team — Figma publishes no permissions read; ' +
        'only the moment access changed, in the activity log',
    ],
  }
}

/* -------------------------------------------------------------------- helpers */

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Figma's activity log takes unix SECONDS; everything a human types is a date string. */
function stamp(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Date.parse(String(value))
  if (Number.isNaN(parsed)) throw new Error(`"${value}" is not a date — use 2026-09-01 or an ISO datetime`)
  return Math.floor(parsed / 1000)
}

/** Analytics takes YYYY-MM-DD and rejects a full ISO datetime, which is an easy thing to send by accident. */
function isoDate(value) {
  const parsed = Date.parse(String(value))
  if (Number.isNaN(parsed)) throw new Error(`"${value}" is not a date — use YYYY-MM-DD`)
  return new Date(parsed).toISOString().slice(0, 10)
}
