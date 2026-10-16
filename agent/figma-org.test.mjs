/**
 * The organisation half: activity logs, library analytics, and the credential rules that decide
 * which of them can answer at all.
 *
 * The interesting behaviour of these ops is their FAILURE, so most of this file produces errors
 * on purpose. Three facts are pinned because each one cost a wrong assumption to learn, and each
 * would silently come back:
 *
 *  - a personal access token cannot read activity logs under either header. Not "needs more
 *    scopes" — refused both ways, which is why the op must not try and must not advise re-minting.
 *  - library analytics is the opposite: right header, one missing scope, and the 403 body is the
 *    only place Figma will list what a token actually carries.
 *  - `group_by` is required and its legal values differ per endpoint, so a plausible-looking call
 *    has to be rejected here rather than by Figma after a round trip.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVITY_SCOPE,
  ANALYTICS_SCOPE,
  authorizeUrl,
  exchangeCode,
  headerFor,
  refreshGrant,
  runOrgOp,
  scopesFromRefusal,
  summariseActions,
  summariseUsages,
} from './figma-org.mjs'

const PAT = 'figd_pretend'
const OAUTH = 'oauth_pretend'

/** The 403 Figma actually sends, trimmed to the shape that matters. */
const SCOPE_REFUSAL =
  'Figma REST 403 on /v1/analytics/... — Invalid scope: ["current_user:read", "file_content:read", ' +
  '"library_assets:read", "webhooks:read"]. This endpoint requires the library_analytics:read scope.'

/* ------------------------------------------------------- the credential rule */

test('activity logs take the Bearer header and nothing else; every other route takes the personal one', () => {
  assert.deepEqual(headerFor('/v1/activity_logs?limit=1', { pat: PAT, oauth: OAUTH }), {
    Authorization: `Bearer ${OAUTH}`,
  })
  assert.deepEqual(headerFor('/v1/projects/9/files', { pat: PAT, oauth: OAUTH }), { 'X-Figma-Token': PAT })
})

test('a personal token alone cannot reach the activity log — the header is withheld rather than tried', () => {
  // The catch is closed on both sides: X-Figma-Token answers "pass it as Bearer", and Bearer
  // answers "figd_ tokens must use X-Figma-Token". Offering either is a wasted round trip and a
  // misleading error, so the route refuses locally.
  assert.equal(headerFor('/v1/activity_logs', { pat: PAT, oauth: '' }), null)
})

test('org.activity refuses before the network, and says the one thing that would fix it', async () => {
  await assert.rejects(
    () => runOrgOp('org.activity', {}, { pat: PAT, oauth: '', get: () => assert.fail('must not call out') }),
    (err) => {
      assert.match(err.message, /OAuth grant, not a personal access token/)
      assert.match(err.message, /allcrew-channel auth/)
      // The fallback that works today is part of the refusal, not a thing to go and discover.
      assert.match(err.message, /history\.versions/)
      return true
    }
  )
})

test("a token's scopes are read out of the refusal, because Figma publishes no introspection", () => {
  assert.deepEqual(scopesFromRefusal(SCOPE_REFUSAL), [
    'current_user:read',
    'file_content:read',
    'library_assets:read',
    'webhooks:read',
  ])
  assert.equal(scopesFromRefusal('Figma REST 500 — something else entirely'), null)
})

test('a scope 403 is reported as a re-mint, with the scopes the token does carry', async () => {
  await assert.rejects(
    () =>
      runOrgOp(
        'library.usages',
        { fileKey: 'K', asset: 'component', groupBy: 'file' },
        {
          pat: PAT,
          get: () => {
            const err = new Error(SCOPE_REFUSAL)
            err.status = 403
            err.figmaMessage = SCOPE_REFUSAL
            throw err
          },
        }
      ),
    (err) => {
      assert.match(err.message, new RegExp(ANALYTICS_SCOPE))
      assert.match(err.message, /minting a new one/)
      assert.match(err.message, /Present scopes: current_user:read/)
      return true
    }
  )
})

/* ----------------------------------------------------------- the vocabulary */

test('group_by is checked here, because Figma rejects the wrong one only after a round trip', async () => {
  await assert.rejects(
    () => runOrgOp('library.actions', { fileKey: 'K', asset: 'component', groupBy: 'file' }, { pat: PAT, get: () => ({}) }),
    /groupBy for library\.actions on component must be one of component or team/
  )
  await assert.rejects(
    () => runOrgOp('library.usages', { fileKey: 'K', asset: 'nonsense' }, { pat: PAT, get: () => ({}) }),
    /asset must be one of component, style, variable/
  )
})

test('the asset kind is the default grouping, so the common call needs no groupBy', async () => {
  let seen = ''
  await runOrgOp(
    'library.usages',
    { fileKey: 'LIB' },
    {
      pat: PAT,
      get: (route) => {
        seen = route
        return { rows: [], next_page: false }
      },
    }
  )
  assert.match(seen, /\/v1\/analytics\/libraries\/LIB\/component\/usages\?group_by=component/)
})

test('a datetime sent where Figma wants a date is converted rather than refused', async () => {
  let seen = ''
  await runOrgOp(
    'library.actions',
    { fileKey: 'LIB', since: '2026-09-01T10:30:00Z' },
    {
      pat: PAT,
      get: (route) => {
        seen = route
        return { rows: [], next_page: false }
      },
    }
  )
  assert.match(seen, /start_date=2026-09-01/)
  assert.doesNotMatch(seen, /T10%3A30/)
})

/* ------------------------------------------------------------- the findings */

test('weekly rows collapse into the ratio that is the actual finding', () => {
  const summary = summariseActions([
    { component_name: 'Button', week: '2026-09-07', insertions: 100, detachments: 2 },
    { component_name: 'Button', week: '2026-09-14', insertions: 60, detachments: 1 },
    // Inserted far less, but almost always torn apart afterwards: the thing worth reporting.
    { component_name: 'Amount field', week: '2026-09-07', insertions: 20, detachments: 18 },
  ])
  assert.equal(summary.insertions, 180)
  assert.equal(summary.detachments, 21)
  assert.equal(summary.weeks, 2)
  assert.equal(summary.from, '2026-09-07')
  assert.equal(summary.busiest[0].name, 'Button')
  assert.equal(summary.mostDetached[0].name, 'Amount field')
})

test('usages name what nobody uses, which is the only place that answer exists', () => {
  const summary = summariseUsages([
    { component_name: 'Button', usages: 412 },
    { component_name: 'Legacy chip', usages: 0 },
    { component_name: 'Toolbar', usages: 7 },
  ])
  assert.equal(summary.usages, 419)
  assert.deepEqual(summary.unused, ['Legacy chip'])
  assert.equal(summary.top[0].name, 'Button')
})

/* ------------------------------------------------------------- pagination */

test('following the cursor stops at the ceiling and SAYS it stopped, rather than implying the end', async () => {
  let calls = 0
  const result = await runOrgOp(
    'library.usages',
    { fileKey: 'LIB', all: true, maxPages: 3 },
    {
      pat: PAT,
      get: () => {
        calls += 1
        return { rows: [{ component_name: `c${calls}`, usages: 1 }], cursor: `cur${calls}`, next_page: true }
      },
    }
  )
  assert.equal(calls, 3)
  assert.equal(result.truncated, true)
  assert.equal(result.rows.length, 3)
  assert.ok(result.cursor, 'a truncated answer hands back the cursor it stopped on')
})

test('without `all` exactly one page is fetched, however much more there is', async () => {
  let calls = 0
  const result = await runOrgOp(
    'library.usages',
    { fileKey: 'LIB' },
    {
      pat: PAT,
      get: () => {
        calls += 1
        return { rows: [{ usages: 1 }], cursor: 'more', next_page: true }
      },
    }
  )
  assert.equal(calls, 1)
  assert.equal(result.pages, 1)
})

/* -------------------------------------------------------------- the inventory */

test('org.files sorts the stalest to the top, because that is the question behind the question', async () => {
  const result = await runOrgOp(
    'org.files',
    { projectId: '77' },
    {
      pat: PAT,
      get: () => ({
        name: 'Design System',
        files: [
          { key: 'a', name: 'Fresh', last_modified: '2026-09-30T10:00:00Z' },
          { key: 'b', name: 'Forgotten', last_modified: '2024-02-01T10:00:00Z' },
          { key: 'c', name: 'Middling', last_modified: '2026-01-15T10:00:00Z' },
        ],
      }),
    }
  )
  assert.equal(result.count, 3)
  assert.equal(result.stalest[0].name, 'Forgotten')
  assert.equal(result.stalest[2].name, 'Fresh')
})

/* ------------------------------------------------------------ capabilities */

test('without a file key the scope is reported unknown, which is not the same as no', async () => {
  // Figma resolves the file BEFORE it checks the scope, so a placeholder key answers 404 and
  // teaches nothing. An earlier version probed one anyway and reported "no scopes" for tokens
  // that may well have had them — the kind of wrong answer that gets believed.
  const result = await runOrgOp(
    'org.capabilities',
    {},
    { pat: PAT, oauth: '', get: () => assert.fail('nothing to probe without a key') }
  )
  const analytics = result.surfaces.find((s) => s.surface === 'library analytics')
  assert.equal(analytics.reachable, 'unknown')
  assert.match(analytics.remedy, /pass fileKey/)
  assert.match(result.credentials.scopesNote, /only in a 403 from a real file/)
})

test('a 404 from the probe stays inconclusive, because it is about the key and not the scope', async () => {
  const result = await runOrgOp(
    'org.capabilities',
    { fileKey: 'WRONGKEY' },
    {
      pat: PAT,
      oauth: '',
      get: () => {
        const err = new Error('Figma REST 404 on /v1/analytics/... — Not found')
        err.status = 404
        err.figmaMessage = 'Not found'
        throw err
      },
    }
  )
  assert.equal(result.surfaces.find((s) => s.surface === 'library analytics').reachable, 'unknown')
})

test('capabilities reports each surface with its remedy, and names what nothing can answer', async () => {
  const result = await runOrgOp(
    'org.capabilities',
    { fileKey: 'REALKEY' },
    {
      pat: PAT,
      oauth: '',
      get: () => {
        const err = new Error(SCOPE_REFUSAL)
        err.figmaMessage = SCOPE_REFUSAL
        throw err
      },
    }
  )
  const analytics = result.surfaces.find((s) => s.surface === 'library analytics')
  assert.equal(analytics.reachable, false)
  assert.match(analytics.remedy, /re-mint/)
  assert.match(analytics.remedy, /header is already right/)
  assert.ok(result.credentials.scopes.includes('file_content:read'))

  const audit = result.surfaces.find((s) => s.surface === 'organisation audit log')
  assert.equal(audit.reachable, false)
  assert.match(audit.note, /refused on BOTH headers/)

  // The folder tree is judged from the scope list the probe just handed back, not from "a token
  // exists" — this token's list has no folders:read in it, so the honest answer is no.
  const folders = result.surfaces.find((s) => s.surface === 'folder tree')
  assert.equal(folders.reachable, false)
  assert.match(folders.remedy, /folders:read/)
  assert.equal(result.surfaces.find((s) => s.surface === 'file history').reachable, true)

  // Permissions are the one thing no credential and no plan will ever answer; saying so is the
  // point, so that nobody builds a feature on the assumption that a scope would unlock it.
  assert.match(result.unanswerable[0], /no permissions read/)
})

/* -------------------------------------------------------------- the oauth flow */

test('the authorize URL carries the one scope the activity log accepts', () => {
  const url = new URL(authorizeUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:7777/cb', state: 'xyz' }))
  assert.equal(url.searchParams.get('scope'), ACTIVITY_SCOPE)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('state'), 'xyz')
})

test('client credentials go as HTTP Basic, not in the body — the other way answers a confusing 400', async () => {
  let seen = null
  await exchangeCode({
    clientId: 'cid',
    clientSecret: 'sec',
    redirectUri: 'http://127.0.0.1:7777/cb',
    code: 'abc',
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'T', expires_in: 7776000 }) }
    },
  })
  assert.match(seen.url, /\/v1\/oauth\/token$/)
  assert.equal(seen.init.headers.Authorization, `Basic ${Buffer.from('cid:sec').toString('base64')}`)
  assert.equal(seen.init.headers['Content-Type'], 'application/x-www-form-urlencoded')
  assert.match(seen.init.body, /grant_type=authorization_code/)
  assert.doesNotMatch(seen.init.body, /client_secret/)
})

test('a refresh keeps the refresh token, which Figma does not send back', async () => {
  const grant = await refreshGrant({
    clientId: 'cid',
    clientSecret: 'sec',
    refreshToken: 'R',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'T2', expires_in: 7776000 }),
    }),
  })
  assert.equal(grant.access_token, 'T2')
  assert.equal(grant.refresh_token, 'R')
})

test('an OAuth failure carries Figma\'s own words, not just the status', async () => {
  await assert.rejects(
    () =>
      exchangeCode({
        clientId: 'cid',
        clientSecret: 'bad',
        redirectUri: 'http://127.0.0.1:7777/cb',
        code: 'abc',
        fetchImpl: async () => ({
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ message: 'Invalid client credentials' }),
        }),
      }),
    /Figma OAuth 400 .* Invalid client credentials/
  )
})
