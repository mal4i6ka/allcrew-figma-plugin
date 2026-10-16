#!/usr/bin/env node
/**
 * Design fidelity: compare a project's Figma frames with the pages they became.
 *
 *   node agent/fidelity.mjs --config fidelity/example.json [--base production|<url>]
 *                           [--page "Home"]... [--width 1440]... [--out <dir>]
 *
 * For every page × width in the config: the frame's text from Figma REST, the page as headless
 * Chrome renders it at that width, and the differences — style, horizontal placement, line wrap,
 * where the page starts drifting vertically, and text the page does not have. Writes
 * findings.json (the machine half: comments, tickets and fixes are made from it) and
 * report.html (the half a person reads) into the run directory, and prints a summary.
 *
 * Needs a Figma token (~/.allcrew-channel/figma-token or FIGMA_TOKEN) and the system Chrome. The Figma
 * side is cached per file version, so a rerun after a CSS fix only re-renders the pages.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileVersion, frameImage, frameTexts, frameTree } from './fidelity/figma.mjs'
import { capture, launch } from './fidelity/browser.mjs'
import { compare } from './fidelity/compare.mjs'
import { describe, renderReport } from './fidelity/report.mjs'

const { values: args } = parseArgs({
  options: {
    config: { type: 'string' },
    base: { type: 'string' },
    page: { type: 'string', multiple: true },
    width: { type: 'string', multiple: true },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (args.help || !args.config) {
  console.log('usage: node agent/fidelity.mjs --config <file> [--base <name|url>] [--page <name>]... [--width <px>]... [--out <dir>]')
  process.exit(args.help ? 0 : 2)
}

const config = JSON.parse(await readFile(args.config, 'utf8'))
const baseName = args.base ?? config.defaultBase
const base = (config.bases?.[baseName] ?? baseName).replace(/\/$/, '')
const pages = config.pages.filter((p) => !args.page || args.page.some((q) => p.name.toLowerCase().includes(q.toLowerCase())))
if (pages.length === 0) {
  console.error(`no page matches ${args.page?.join(', ')} — the config has: ${config.pages.map((p) => p.name).join(', ')}`)
  process.exit(2)
}

const startedAt = new Date()
const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = path.resolve(args.out ?? path.join(os.homedir(), '.allcrew-channel', 'fidelity', config.project.replace(/[^\w.-]+/g, '-'), stamp))
await mkdir(outDir, { recursive: true })

const version = await fileVersion(config.fileKey)
const cacheDir = path.join(os.homedir(), '.allcrew-channel', 'fidelity-cache', config.fileKey, version.lastModified.replace(/[:.]/g, '-'))

const drv = await launch()
const runs = []
try {
  for (const page of pages) {
    for (const [width, frameId] of Object.entries(page.frames)) {
      if (args.width && !args.width.includes(width)) continue
      const url = base + page.url
      const slug = `${page.name}-${width}`.toLowerCase().replace(/[^\w]+/g, '-')
      process.stderr.write(`${page.name} @ ${width} … `)
      try {
        const tree = await frameTree(config.fileKey, frameId, cacheDir)
        const design = frameTexts(tree, { skip: config.skipLayers ?? [] })
        const designPng = `${slug}.figma.png`
        await copyFile(await frameImage(config.fileKey, frameId, cacheDir), path.join(outDir, designPng))
        const buildPng = `${slug}.page.png`
        const probe = await capture(drv, { url, width: Number(width), hide: config.hide ?? [], setup: page.setup, outPng: path.join(outDir, buildPng) })
        const result = compare(design, probe.blocks, config.tolerance, probe.media)
        // How many texts each design section has: a structure ticket tells "the section was never
        // built" (all of them missing) from "its content changed" (some) only against this.
        const sections = {}
        for (const t of design) if (t.section) sections[t.section.id] = (sections[t.section.id] ?? 0) + 1
        runs.push({ page: page.name, width: Number(width), url, frameId, frameName: tree.name, designPng, buildPng, sections, ...result })
        process.stderr.write(`${result.findings.length} findings (${result.stats.matched}/${result.stats.designTexts} matched)\n`)
      } catch (error) {
        runs.push({ page: page.name, width: Number(width), url, frameId, error: String(error?.message ?? error) })
        process.stderr.write(`failed: ${error?.message ?? error}\n`)
      }
    }
  }
} finally {
  await drv.close()
}

const meta = { project: config.project, configPath: args.config, fileKey: config.fileKey, fileName: version.name, lastModified: version.lastModified, base, startedAt: startedAt.toISOString() }
// Every finding carries what a comment, a ticket or a fix needs without the report beside it.
const findings = runs.flatMap((r) =>
  (r.findings ?? []).map((f) => ({ page: r.page, width: r.width, url: r.url, frameId: r.frameId, summary: describe(f), ...f }))
)
await writeFile(path.join(outDir, 'findings.json'), JSON.stringify({ ...meta, findings, runs: runs.map(({ pairs, ...r }) => ({ ...r, findings: undefined, count: r.findings?.length })) }, null, 2))
await writeFile(path.join(outDir, 'report.html'), renderReport({ ...meta, runs }))

const byKind = findings.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {})
console.log(JSON.stringify({ outDir, report: path.join(outDir, 'report.html'), total: findings.length, byKind, failed: runs.filter((r) => r.error).length }, null, 2))
