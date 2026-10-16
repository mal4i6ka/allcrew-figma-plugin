#!/usr/bin/env node
/**
 * Turns a fidelity run into work: Figma comments, ticket drafts, and a fix list for the CSS.
 *
 *   node agent/fidelity-deliver.mjs comments --run <dir> [--page <name>] [--width 1440] [--post]
 *   node agent/fidelity-deliver.mjs tickets  --run <dir> [--min 3] [--tokens auto|off]
 *   node agent/fidelity-deliver.mjs fixes    --run <dir> [--page <name>] [--width 1440]
 *
 * `comments` shows what it would post and posts nothing without --post. One comment per section
 * that has findings, pinned on the frame at the first of them — a comment per finding would be
 * hundreds of pins, and a designer reads a section at a time. Each carries the marker
 * FIDELITY_MARK so a later run can find and clear the previous one's.
 *
 * `tickets` writes tickets.md and tickets.json into the run: one ticket per component whose style
 * is off (the 15 most widespread; --min sets the floor of places), and one per page for what is
 * structurally off — text missing, text drawn into pictures, sections whose height is wrong.
 * A style ticket carries the design's own spec for its texts (see fidelity/spec.mjs): text style
 * per width, values, tracking in em, and — when the file is open with the plugin, unless
 * --tokens off — the token names and the colour's mode. Specs are kept in the run as
 * design-specs.json, so a second delivery reads nothing.
 *
 * `fixes` writes fixes.json: per selector, the property and the value the design asks for. It is
 * the brief for changing overrides.css, not a patch — the selector is where the text sat, and the
 * rule that sets the value may be an ancestor's.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { bridgeTarget, readSpecs, sectionLine, specSection } from './fidelity/spec.mjs'

export const FIDELITY_MARK = '[fidelity]'

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    run: { type: 'string' },
    page: { type: 'string', multiple: true },
    width: { type: 'string', multiple: true },
    min: { type: 'string', default: '3' },
    post: { type: 'boolean', default: false },
    max: { type: 'string', default: '8' },
    tokens: { type: 'string', default: 'auto' },
  },
})
const mode = positionals[0]
if (!['comments', 'tickets', 'fixes'].includes(mode) || !args.run) {
  console.log('usage: node agent/fidelity-deliver.mjs <comments|tickets|fixes> --run <dir> [--page <name>] [--width <px>] [--post]')
  process.exit(2)
}

const run = JSON.parse(await readFile(path.join(args.run, 'findings.json'), 'utf8'))
const pick = (f) =>
  (!args.page || args.page.some((p) => f.page.toLowerCase().includes(p.toLowerCase()))) &&
  (!args.width || args.width.includes(String(f.width)))
const findings = run.findings.filter(pick)
const report = path.join(args.run, 'report.html')
// Give ticket readers a reproducible command without embedding this machine's run directory.
const rerun = (page) => `Recheck: \`npm run fidelity -- --config ${run.configPath ?? '<config>'}${page ? ` --page "${page}"` : ''}\` (run ${run.startedAt.slice(0, 10)}, design modified ${run.lastModified.slice(0, 10)}).`

const KIND = { style: 'style', shift: 'height', position: 'position', wrap: 'line wrap', raster: 'text in image', missing: 'missing from page' }

function groupBy(list, key) {
  const m = new Map()
  for (const x of list) {
    const k = key(x)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(x)
  }
  return m
}

/* ------------------------------------------------------------------ comments */

function token() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN.trim()
  const file = process.env.FIGMA_TOKEN_FILE || path.join(os.homedir(), '.allcrew-channel', 'figma-token')
  const line = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').map((r) => r.trim()).find((r) => r && !r.startsWith('#') && !r.startsWith('PASTE'))
    : undefined
  if (!line) throw new Error(`no Figma token in ${file}`)
  return line
}

if (mode === 'comments') {
  const max = Number(args.max)
  const comments = []
  for (const [, list] of groupBy(findings, (f) => `${f.page}|${f.width}|${f.section?.id ?? '-'}`)) {
    const first = list[0]
    const lines = list.slice(0, max).map((f) => `• “${f.text.replace(/\s+/g, ' ').slice(0, 50)}” — ${KIND[f.kind]}: ${f.summary}`)
    if (list.length > max) lines.push(`… and ${list.length - max} more`)
    comments.push({
      page: first.page,
      width: first.width,
      section: first.section?.name ?? '—',
      count: list.length,
      // Pinned on the page frame at the first finding — frame-relative, so it moves with the frame.
      client_meta: { node_id: first.frameId, node_offset: { x: first.at.x, y: first.at.y } },
      message:
        `${FIDELITY_MARK} Comparison with ${first.url} at ${first.width}px (${run.startedAt.slice(0, 10)}): ` +
        `${list.length} ${list.length === 1 ? 'difference' : 'differences'} in section “${first.section?.name ?? '—'}”\n` +
        lines.join('\n'),
    })
  }
  if (!args.post) {
    console.log(JSON.stringify({ wouldPost: comments.length, fileKey: run.fileKey, comments }, null, 2))
    console.error(`\n${comments.length} comments, nothing posted — add --post to post them`)
  } else {
    let posted = 0
    for (const c of comments) {
      const res = await fetch(`https://api.figma.com/v1/files/${run.fileKey}/comments`, {
        method: 'POST',
        headers: { 'X-Figma-Token': token(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: c.message, client_meta: c.client_meta }),
      })
      if (!res.ok) {
        console.error(`failed on ${c.page} ${c.width} «${c.section}»: ${res.status} ${(await res.text()).slice(0, 200)}`)
        continue
      }
      c.id = (await res.json()).id
      posted++
    }
    await writeFile(path.join(args.run, 'comments.json'), JSON.stringify(comments, null, 2))
    console.log(JSON.stringify({ posted, of: comments.length, record: path.join(args.run, 'comments.json') }, null, 2))
  }
}

/* ------------------------------------------------------------------ tickets */

if (mode === 'tickets') {
  const min = Number(args.min)
  const tickets = []

  // One ticket per COMPONENT: the last two steps of the selector, minus the grid and spacing
  // utilities that differ between otherwise identical copies (the footer's two link columns are
  // col-lg-2 and col-lg-3). A place is a component + text, counted once however many pages repeat
  // it — the footer is on every page and is one defect, not fourteen.
  const component = (sel) =>
    String(sel)
      .split(' > ')
      .slice(-2)
      .map((part) => part.split('.').filter((c, i) => i === 0 || !/^(col|row-cols|g[xy]?-\d|gap-\d|[mp][xytbse]?-(sm-|md-|lg-|xl-)?\d|d-|h-100|w-100)/.test(c)).join('.'))
      .join(' > ')
  const top = Number(args.max) > 8 ? Number(args.max) : 15
  const style = findings.filter((f) => f.kind === 'style')
  const components = [...groupBy(style, (f) => component(f.selector)).entries()].map(([name, list]) => {
    const places = new Map()
    for (const f of list) places.set(`${f.selector}|${f.text}`, f)
    const props = new Map()
    for (const f of places.values()) {
      for (const p of f.props) {
        const k = `${p.property}|${p.figma}|${p.build}`
        const e = props.get(k) ?? { ...p, count: 0 }
        e.count++
        props.set(k, e)
      }
    }
    return { name, list, places: [...places.values()], props: [...props.values()].sort((a, b) => b.count - a.count) }
  })
  const chosen = components.filter((c) => c.places.length >= min).sort((a, b) => b.places.length - a.places.length).slice(0, top)
  const bridge = args.tokens === 'off' ? null : await bridgeTarget(run.fileName)
  console.error(bridge ? `tokens: through the bridge (${bridge.handle})` : 'tokens: bridge not serving this file — specs without token names')
  const specs = await readSpecs({
    fileKey: run.fileKey,
    nodeIds: chosen.flatMap((c) => c.list.map((f) => f.nodeId)),
    cacheFile: path.join(args.run, 'design-specs.json'),
    bridge,
    log: (line) => console.error(line),
  })
  const tokensRead = Object.values(specs).some((s) => s.tokens)
  for (const c of chosen) {
    const pages = [...new Set(c.list.map((f) => `${f.page} ${f.width}px`))]
    const headline = c.props.slice(0, 2).map((p) => `${p.property} ${p.build}${p.unit}→${p.figma}${p.unit}`).join(', ')
    // Named the way a designer finds it: the page(s) and the design section most of it sits in.
    const pageNames = [...new Set(c.list.map((f) => f.page))]
    const allPages = new Set(findings.map((f) => f.page)).size
    const where = pageNames.length === allPages && allPages > 2 ? 'all pages' : pageNames.slice(0, 2).join(', ') + (pageNames.length > 2 ? ` and ${pageNames.length - 2} more` : '')
    const section = [...groupBy(c.places, (f) => f.section?.name ?? '—').entries()].sort((a, b) => b[1].length - a[1].length)[0][0]
    tickets.push({
      kind: 'style',
      title: `Site · ${where} · “${section}”: ${headline} (${c.places.length} places)`,
      body: [
        `Component \`${c.name}\` differs from design “${run.fileName}” in ${c.places.length} places (${pages.length} page-width combinations).`,
        '',
        '| Property | Design | Current | Places |',
        '| --- | --- | --- | --- |',
        ...c.props.map((p) => `| ${p.property} | ${p.figma}${p.unit} | ${p.build}${p.unit} | ${p.count} |`),
        '',
        ...(() => {
          const spec = specSection(c.list, specs, { fileKey: run.fileKey, tokensRead })
          return spec.length ? [...spec, ''] : []
        })(),
        'Examples:',
        ...c.places.slice(0, 5).map((f) => `- “${f.text.replace(/\s+/g, ' ').slice(0, 50)}” (${f.page} ${f.width}px) — https://www.figma.com/design/${run.fileKey}/?node-id=${encodeURIComponent(f.nodeId.replaceAll(':', '-'))}`),
        '',
        `Pages: ${pages.join(', ')}`,
        rerun(),
      ].join('\n'),
      places: c.places.length,
    })
  }

  for (const [, list] of groupBy(findings, (f) => f.page)) {
    const missing = list.filter((f) => f.kind === 'missing')
    const raster = list.filter((f) => f.kind === 'raster')
    const shifts = list.filter((f) => f.kind === 'shift' && Math.abs(f.delta) >= 40)
    if (missing.length + raster.length + shifts.length === 0) continue
    const page = list[0].page
    // Missing texts are judged against the section's size in the design; texts in pictures are not.
    const totals = (f) => run.runs?.find((r) => r.page === f.page && r.width === f.width)?.sections?.[f.section?.id]
    const sections = (xs, judge) =>
      [...groupBy(xs, (f) => `${f.width}|${f.section?.id ?? f.section?.name ?? '—'}`).values()].map((v) =>
        sectionLine(v[0].width, v[0].section, v, judge ? totals(v[0]) : undefined, run.fileKey)
      )
    tickets.push({
      kind: 'structure',
      title: `Site, ${page}: content differs from the design (${missing.length} texts missing, ${raster.length} in images, ${shifts.length} vertical shifts)`,
      body: [
        `Page ${list[0].url} compared with the “${page}” frames in “${run.fileName}”.`,
        ...(missing.length ? ['', '**Design text is missing from the page** (content changed or the section has not been built):', ...sections(missing, true)] : []),
        ...(raster.length ? ['', '**Text is drawn into an image** (project rule: sections must use markup so they can be translated):', ...sections(raster, false)] : []),
        ...(shifts.length ? ['', '**Section heights differ** (everything below shifts):', ...shifts.map((f) => `- ${f.width}px: ${f.delta > 0 ? '+' : ''}${f.delta}px between “${f.after?.text?.slice(0, 30) ?? 'top'}” and “${f.text.slice(0, 30)}”`)] : []),
        '',
        rerun(page),
      ].join('\n'),
      places: missing.length + raster.length + shifts.length,
    })
  }

  await writeFile(path.join(args.run, 'tickets.json'), JSON.stringify(tickets, null, 2))
  await writeFile(path.join(args.run, 'tickets.md'), tickets.map((t) => `## ${t.title}\n\n${t.body}\n`).join('\n---\n\n'))
  console.log(JSON.stringify({ tickets: tickets.length, style: tickets.filter((t) => t.kind === 'style').length, structure: tickets.filter((t) => t.kind === 'structure').length, file: path.join(args.run, 'tickets.md') }, null, 2))
}

/* ------------------------------------------------------------------ fixes */

if (mode === 'fixes') {
  const bySelector = new Map()
  for (const f of findings.filter((f) => f.kind === 'style')) {
    const key = f.selector
    if (!bySelector.has(key)) bySelector.set(key, { selector: key, widths: new Set(), props: new Map(), texts: [] })
    const entry = bySelector.get(key)
    entry.widths.add(f.width)
    entry.texts.push(f.text.slice(0, 40))
    for (const p of f.props) {
      const k = `${p.property}:${p.figma}${p.unit}`
      entry.props.set(k, { property: p.property, want: `${p.figma}${p.unit}`, now: `${p.build}${p.unit}`, count: (entry.props.get(k)?.count ?? 0) + 1 })
    }
  }
  const fixes = [...bySelector.values()]
    .map((e) => ({ selector: e.selector, widths: [...e.widths].sort((a, b) => a - b), set: [...e.props.values()].sort((a, b) => b.count - a.count), examples: [...new Set(e.texts)].slice(0, 3) }))
    .sort((a, b) => b.set.reduce((n, p) => n + p.count, 0) - a.set.reduce((n, p) => n + p.count, 0))
  await writeFile(path.join(args.run, 'fixes.json'), JSON.stringify(fixes, null, 2))
  console.log(JSON.stringify({ selectors: fixes.length, file: path.join(args.run, 'fixes.json'), top: fixes.slice(0, 5) }, null, 2))
}
