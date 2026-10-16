/**
 * What a ticket has to hand a developer besides "22px, not 24px": which text style the design
 * uses for each text, at which widths, on which tokens, and in which colour mode.
 *
 * The first fidelity tickets (ASD-43875..95) carried only the differing values. Checked against
 * the live file, every value was right — and still not enough to act on: eleven of fifteen
 * tickets put two to four text styles under one selector, the colours were Dark-mode values
 * given as bare hex (#818181 is `Text/Secondary` in Dark, #767676 in Light), and a heading's
 * tracking arrived as three px numbers (−0.64, −0.52, −0.42) for what is one rule, −0.02em.
 *
 * Two sources, because they know different things:
 * - REST (always available, needs only the token): the text style's name, the stored font,
 *   size, line height, tracking, case and fill, and WHICH properties are bound to variables.
 * - the plugin bridge (only while the file is open with the AllCrew plugin): the variables'
 *   names and the mode each colour resolves in. REST returns variable ids only — their names
 *   are an Enterprise endpoint.
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { API, get, hex } from './figma.mjs'

const TYPOGRAPHY = ['fontFamily', 'fontSize', 'lineHeight', 'fontWeight']
const CASE = { UPPER: 'UPPERCASE', LOWER: 'lowercase', TITLE: 'Title Case', SMALL_CAPS: 'small caps', SMALL_CAPS_FORCED: 'small caps' }

const round = (v, step) => Math.round(v / step) * step
const fmt = (v) => String(Number(v.toFixed(3)))

/** One text node as REST stores it, reduced to what a developer reproduces. `styles` is the
 * response's own id → style map, which is where the text style's NAME lives. */
export function specFromRest(document, styles = {}) {
  const s = document.style ?? {}
  const fill = (document.fills ?? []).find((p) => p.type === 'SOLID' && p.visible !== false)
  const styleId = document.styles?.text
  const textStyle = (styleId && styles[styleId]?.name) || null
  const bound = Object.keys(document.boundVariables ?? {})
  const letterSpacing = s.letterSpacing ? round(s.letterSpacing, 0.01) : 0
  const offSystem = []
  if (!textStyle) offSystem.push('no text style')
  const loose = TYPOGRAPHY.filter((k) => !bound.includes(k))
  if (loose.length === TYPOGRAPHY.length) offSystem.push('typography is not bound to tokens')
  return {
    textStyle,
    fontFamily: s.fontFamily ?? null,
    fontWeight: s.fontWeight ?? null,
    fontSize: s.fontSize ?? null,
    lineHeight: s.lineHeightPx ? round(s.lineHeightPx, 0.01) : null,
    letterSpacing,
    // Tracking is set in Figma as a percentage of the size; a px value is that rule evaluated
    // for one size. em is the form that survives a breakpoint changing the size.
    letterSpacingEm: letterSpacing && s.fontSize ? round(letterSpacing / s.fontSize, 0.001) : 0,
    textCase: CASE[s.textCase] ?? null,
    color: fill ? hex(fill) : null,
    bound,
    offSystem,
  }
}

/** The bridge's `node.get` of the same node: variable names per property, and the mode the
 * colour resolves in — the frames of a dark site resolve `Text/Secondary` to its Dark value. */
export function specFromBridge(node) {
  const b = node?.bindings ?? {}
  const tokens = {}
  for (const [key, row] of Object.entries(b)) if (row?.token) tokens[key === 'fills' ? 'color' : key] = row.token
  let colorMode = null
  const collection = b.fills?.collection
  if (collection) {
    const mode = (node.modes?.resolved ?? []).find((m) => m.collection === collection)?.mode
    // A single-mode collection says nothing a developer can act on.
    if (mode && !/^(mode \d+|default|value)$/i.test(mode)) colorMode = mode
  }
  return { tokens, colorMode }
}

/* ---------------------------------------------------------------- reading */

/** The bridge handle serving the file a run was made against, or null — the bridge is optional. */
export async function bridgeTarget(fileName, { url = process.env.ALLCREW_CHANNEL_AGENT_URL || 'http://127.0.0.1:8788' } = {}) {
  try {
    const secretFile = process.env.ALLCREW_CHANNEL_AGENT_SECRET_FILE || path.join(os.homedir(), '.allcrew-channel', 'agent-secret')
    const secret = process.env.ALLCREW_CHANNEL_AGENT_SECRET || (await readFile(secretFile, 'utf8')).trim()
    const base = url.replace(/\/+$/, '')
    const res = await fetch(`${base}/status`, { headers: { 'x-allcrew-channel-secret': secret }, signal: AbortSignal.timeout(5000) })
    const status = await res.json()
    const file = (status.files ?? []).find((f) => f.online && f.file === fileName)
    if (!file) return null
    return {
      handle: file.handle,
      async nodeGet(nodeId) {
        const r = await fetch(`${base}/call`, {
          method: 'POST',
          headers: { 'x-allcrew-channel-secret': secret, 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'node.get', target: file.handle, params: { nodeId, depth: 0 } }),
          signal: AbortSignal.timeout(60000),
        })
        const body = await r.json()
        if (!body.ok) throw new Error(body.error ?? 'bridge refused')
        return body.result
      },
    }
  } catch {
    return null
  }
}

async function pool(items, size, work) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await work(items[next++])
    })
  )
}

/**
 * Specs for `nodeIds`, kept in `cacheFile` so delivering the same run again reads nothing.
 * REST answers in batches; the bridge, one node per call, only fills in what REST cannot name.
 */
export async function readSpecs({ fileKey, nodeIds, cacheFile, bridge = null, log = () => {} }) {
  const specs = existsSync(cacheFile) ? JSON.parse(await readFile(cacheFile, 'utf8')) : {}
  const ids = [...new Set(nodeIds)]

  const needRest = ids.filter((id) => !specs[id])
  for (let i = 0; i < needRest.length; i += 40) {
    const batch = needRest.slice(i, i + 40)
    const body = await (await get(`${API}/files/${fileKey}/nodes?ids=${encodeURIComponent(batch.join(','))}`)).json()
    for (const id of batch) {
      const entry = body.nodes?.[id]
      specs[id] = entry?.document ? specFromRest(entry.document, entry.styles) : { missing: true }
    }
    log(`REST ${Math.min(i + 40, needRest.length)}/${needRest.length}`)
  }

  if (bridge) {
    const needTokens = ids.filter((id) => specs[id] && !specs[id].missing && !specs[id].tokens)
    let done = 0
    await pool(needTokens, 4, async (id) => {
      try {
        Object.assign(specs[id], specFromBridge(await bridge.nodeGet(id)))
      } catch {
        // One unreadable node leaves its row without token names; it does not stop the rest.
      }
      if (++done % 50 === 0) log(`bridge ${done}/${needTokens.length}`)
    })
  }

  await writeFile(cacheFile, JSON.stringify(specs, null, 2))
  return specs
}

/* -------------------------------------------------------------- rendering */

const quote = (t) => `«${t.replace(/\s+/g, ' ').trim().slice(0, 30)}»`
const link = (fileKey, nodeId) => `https://www.figma.com/design/${fileKey}/?node-id=${encodeURIComponent(nodeId.replaceAll(':', '-'))}`
const sortNum = (xs) => [...xs].sort((a, b) => a - b)

function signature(spec) {
  return JSON.stringify([spec.textStyle, spec.fontFamily, spec.fontWeight, spec.fontSize, spec.lineHeight, spec.letterSpacingEm, spec.textCase, spec.color, spec.tokens ?? null, spec.colorMode ?? null])
}

function tracking(spec) {
  if (!spec.letterSpacing) return '0'
  return `${fmt(spec.letterSpacingEm)}em (${fmt(spec.letterSpacing)}px at ${spec.fontSize}px)`.replace(/-/g, '−')
}

/** Widths that share one style, in order: "375 — Header/H5; 768, 1440 — Header/H4". */
function widthRule(byWidth) {
  const runs = []
  for (const w of sortNum(byWidth.keys())) {
    const style = [...byWidth.get(w)][0]
    if (runs.length && runs.at(-1).style === style) runs.at(-1).widths.push(w)
    else runs.push({ style, widths: [w] })
  }
  return runs.map((r) => `${r.widths.join(', ')}px — ${r.style}`).join('; ')
}

/**
 * The "Design specification" section of a style ticket. `list` is every finding of the
 * component, all pages and widths — the widths column is only true if none is left out.
 */
export function specSection(list, specs, { fileKey, tokensRead }) {
  const rows = new Map()
  const byWidth = new Map()
  const textsByWidthStyle = new Map()
  const off = new Map()
  for (const f of list) {
    const spec = specs[f.nodeId]
    if (!spec || spec.missing) continue
    const key = signature(spec)
    const row = rows.get(key) ?? { spec, widths: new Set(), texts: new Set() }
    row.widths.add(f.width)
    row.texts.add(f.text.replace(/\s+/g, ' ').trim())
    rows.set(key, row)
    const style = spec.textStyle ?? 'no style'
    if (!byWidth.has(f.width)) byWidth.set(f.width, new Set())
    byWidth.get(f.width).add(style)
    const k = `${f.width}|${style}`
    if (!textsByWidthStyle.has(k)) textsByWidthStyle.set(k, new Set())
    textsByWidthStyle.get(k).add(f.text)
    if (spec.offSystem.length) off.set(`${f.page}|${f.width}|${f.text}`, { f, spec })
  }
  if (rows.size === 0) return []

  const ordered = [...rows.values()].sort((a, b) => Math.min(...a.widths) - Math.min(...b.widths) || (b.spec.fontSize ?? 0) - (a.spec.fontSize ?? 0))
  const lines = [
    '**Design specification** — values to use, by style:',
    '',
    '| Style | Widths | Font | Size / line height | Tracking | Colour | Text |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const { spec, widths, texts } of ordered) {
    const font = [`${spec.fontFamily} ${spec.fontWeight}`, spec.textCase].filter(Boolean).join(', ')
    const color = [spec.color, spec.colorMode ? `(${spec.colorMode})` : null].filter(Boolean).join(' ')
    const sample = [...texts].slice(0, 3).map(quote).join(', ') + (texts.size > 3 ? ` +${texts.size - 3}` : '')
    lines.push(`| ${spec.textStyle ?? '— no style —'} | ${sortNum(widths).join(', ')} | ${font} | ${spec.fontSize} / ${spec.lineHeight} | ${tracking(spec)} | ${color} | ${sample} |`)
  }

  const tokenLines = ordered
    .filter(({ spec }) => spec.tokens && Object.keys(spec.tokens).length)
    .map(({ spec }) => {
      const t = spec.tokens
      const type = ['fontFamily', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing'].filter((k) => t[k]).map((k) => `\`${t[k]}\``)
      const color = t.color ? `colour \`${t.color}\`${spec.colorMode ? ` (${spec.colorMode} mode)` : ''}` : null
      return `- ${spec.textStyle ?? 'no style'}: ${[...type, color].filter(Boolean).join(', ')}`
    })
  // Same style, same tokens on every row — say it once.
  const uniqueTokenLines = [...new Set(tokenLines)]
  if (uniqueTokenLines.length) lines.push('', 'Tokens:', ...uniqueTokenLines)
  else if (!tokensRead) lines.push('', '_Token names and the colour mode were not read because the file was not open in Figma with the AllCrew plugin during delivery. Run delivery again while the file is open._')

  const styles = new Set([...byWidth.values()].flatMap((s) => [...s]))
  const mixedWidths = [...byWidth.entries()].filter(([, s]) => s.size > 1)
  if (styles.size > 1 && mixedWidths.length === 0) {
    lines.push('', `By width: ${widthRule(byWidth)}.`)
  }
  for (const [w, set] of mixedWidths.sort((a, b) => a[0] - b[0])) {
    const parts = [...set].map((style) => `${style} (${[...textsByWidthStyle.get(`${w}|${style}`)].slice(0, 2).map(quote).join(', ')})`)
    lines.push('', `At ${w}px this selector contains multiple styles: ${parts.join('; ')} — the table above shows which text uses each style.`)
  }

  if (off.size) {
    lines.push('', '**Outside the design system** (check with a designer first; do not copy these values to the site as-is):')
    for (const { f, spec } of [...off.values()].slice(0, 8)) {
      lines.push(`- ${quote(f.text)} (${f.page} ${f.width}px): ${spec.fontFamily} ${spec.fontSize}/${spec.lineHeight}, ${spec.offSystem.join(', ')} — ${link(fileKey, f.nodeId)}`)
    }
    if (off.size > 8) lines.push(`- and ${off.size - 8} more`)
  }
  return lines
}

/** A structure ticket's line for one width × section: a link to the section, and whether the
 * page lost a few texts (content changed) or all of them (not built, or built from other
 * content — a header with different links looks the same from here, so the line states the
 * count and leaves the cause to whoever reads it). `total` is how many texts the design section
 * has; runs made before it was recorded leave it undefined. */
export function sectionLine(width, section, items, total, fileKey) {
  const name = section?.name ?? '—'
  const sample = items.slice(0, 4).map((f) => quote(f.text)).join(', ')
  const verdict = total === undefined || total === null ? '' : items.length >= total ? ' — **none of the section text is present**' : ` — ${items.length} of ${total} section texts`
  const where = section?.id ? ` ([design](${link(fileKey, section.id)}))` : ''
  return `- ${width}px «${name}»${where}: ${items.length}${verdict} — ${sample}`
}
