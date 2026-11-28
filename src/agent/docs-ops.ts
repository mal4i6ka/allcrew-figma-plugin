/**
 * Agent listener — the instructions a file carries about itself.
 *
 * `document.info` is where every agent starts, and it now says when the file holds guidelines;
 * these ops read and write them, and pin how the file's documentation is exported. All of it
 * lives in the document (shared plugin data on the root, see `docs/file-docs.ts`), so it is the
 * same for every person, every machine and every agent that opens the file.
 */

import {
  DOCS_CONFIG_FIELDS,
  applyGuidelines,
  filePins,
  guidelinesSummary,
  normalizeFileDocsConfig,
  planGuidelines,
  readFileDocsConfig,
  readGuidelines,
  writeFileDocsConfig,
  type FileDocsConfig,
  type GuidelinesChange,
  type SharedDataHost,
} from '../docs/file-docs.ts'
import { textFile } from './files.ts'
import { postToUi } from './ui-post.ts'
import type { OpDef } from './protocol.ts'

const root = (): SharedDataHost => figma.root as unknown as SharedDataHost

/** A dry run proves the call writes nothing, so it needs only the read gate. */
const writesUnlessDry = (keys: readonly string[]) => (raw: unknown): boolean => {
  const params = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  if (params.dryRun === true) return false
  return keys.some((key) => params[key] !== undefined && params[key] !== false)
}

const MIME: Record<string, string> = { md: 'text/markdown', markdown: 'text/markdown', json: 'application/json', css: 'text/css', html: 'text/html', svg: 'image/svg+xml', js: 'text/javascript', mjs: 'text/javascript', yaml: 'text/yaml', yml: 'text/yaml' }
const mimeOf = (path: string) => MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'text/plain'
/** The bridge writes flat basenames; the manifest keeps the real path beside each file. */
const flatName = (path: string) => path.split('/').join('__')

/** The panel locks the switches the file decides — tell it when that changed. */
function notifyPanel() {
  try {
    postToUi({ type: 'FILE_PINS', filePins: filePins(root()) })
  } catch { /* no panel (headless, tests) — nothing to update */ }
}

/** Dev Mode and viewers cannot write the document — say so instead of failing inside Figma. */
function assertEditable() {
  if (figma.editorType === 'dev') throw new Error('Dev Mode cannot change the document — open the file in Design mode with edit access')
}

export const DOCS_OPS: readonly OpDef[] = [
  {
    name: 'docs.read',
    summary: "The guidelines this file carries — its owners' DESIGN.md, skill and rules, stored in the file — and its pinned documentation settings.",
    agent:
      'Call this right after `document.info` reports `guidelines`: they are the file\'s own instructions (brand rules, a ' +
      'creative skill, a DESIGN.md written by its owners) and every person and agent opening the file gets the same ones. ' +
      'Files come back as paths on disk, each with its place in the set (`path`); `entry` names the one to read first. ' +
      'Follow them over general habits; token VALUES still come from the variables (tokens.emit / SCAN_TOKENS). `docs` is ' +
      'what the file pins for its documentation export (null = each person\'s own panel settings). A Figma Spec on the ' +
      'canvas (Markdown people see) is beyond this plugin — its runtime has no `figma.spec` (sandbox.capabilities says so), ' +
      'Figma\'s official remote MCP has — so read or write a Spec there (`create_session`, `figma-spec` skill, `use_figma`; ' +
      'the `figma.mcp` desktop relay is read-only). These guidelines are the source, the Spec the copy, updated after them. ' +
      'DOCS_TO_CANVAS lays the exported package\'s Markdown out as ordinary layers instead.',
    mutates: false,
    params: {
      paths: { type: 'string[]', description: 'Only these files (by `path`). Omitted: all of them.' },
      text: { type: 'boolean', default: true, description: 'false returns the manifest only, without the files.' },
    },
    async run(params) {
      const only = Array.isArray(params.paths) && params.paths.length > 0 ? (params.paths as string[]) : undefined
      const read = readGuidelines(root(), only)
      const docs = readFileDocsConfig(root())
      if (!read.manifest) {
        return {
          guidelines: null,
          docs,
          note: 'This file stores no guidelines. Its owners can add them with docs.write (brand rules, a DESIGN.md, a skill).',
        }
      }
      const missing = only ? only.filter((p) => !read.files.some((f) => f.path === p)) : []
      return {
        guidelines: guidelinesSummary(read.manifest),
        ...(params.text === false
          ? {}
          : { files: read.files.map((f) => ({ path: f.path, file: textFile(flatName(f.path), mimeOf(f.path), f.text) })) }),
        ...(read.damaged.length > 0 ? { damaged: read.damaged, damagedNote: 'stored text is shorter or longer than the manifest says — ask the owners to write the set again' } : {}),
        ...(missing.length > 0 ? { missing } : {}),
        docs,
      }
    },
  },

  {
    name: 'docs.write',
    summary: "Store guideline files IN the Figma file — DESIGN.md, a skill, brand rules — so everyone who opens it reads the same instructions.",
    agent:
      'For a file\'s OWNERS: what you write here is what every person and agent opening the file is told to follow, so ' +
      'write the agreed text, not a draft. `files` maps a relative path (`DESIGN.md`, `skill/SKILL.md`, `rules/brand-rules.json`) ' +
      'to its text; null removes that path. By default the call merges into the stored set; `replace: true` makes the set ' +
      'exactly `files`; `clear: true` removes all of it. `name` (required the first time) and `entry` (the file to read first) ' +
      'are what `document.info` shows. Text formats only (md, json, yaml, css, js, html, svg, txt), 512 KB a file, 2 MB in all. ' +
      'Always `dryRun: true` first and show the report: it names what is added, replaced and removed. One call is one undo step.',
    mutates: true,
    mutatesWhen: (raw) => !(raw && typeof raw === 'object' && (raw as Record<string, unknown>).dryRun === true),
    params: {
      files: { type: 'json', description: '{ "DESIGN.md": "…markdown…", "old.md": null } — text per relative path; null removes it.' },
      name: { type: 'string', description: 'What the set is, e.g. "Acme brand kit". Required when the file has none yet.' },
      entry: { type: 'string', description: 'The path to read first, e.g. "SKILL.md". Empty string unsets it.' },
      description: { type: 'string', description: 'One line: who the guidelines are for and what they cover. Empty string unsets it.' },
      replace: { type: 'boolean', default: false, description: 'The stored set becomes exactly `files` (paths not listed are removed).' },
      clear: { type: 'boolean', default: false, description: 'Remove every guideline file and the manifest.' },
      dryRun: { type: 'boolean', default: false, description: 'Validate and report the change without writing it.' },
    },
    async run(params) {
      const change: GuidelinesChange = {
        files: (params.files as Record<string, string | null> | undefined) ?? {},
        replace: params.replace === true,
        clear: params.clear === true,
        ...(typeof params.name === 'string' ? { name: params.name } : {}),
        ...(typeof params.entry === 'string' ? { entry: params.entry === '' ? null : params.entry } : {}),
        ...(typeof params.description === 'string' ? { description: params.description === '' ? null : params.description } : {}),
      }
      const plan = planGuidelines(root(), change)
      const dry = params.dryRun === true
      const meta = (m: typeof plan.before) => JSON.stringify(m ? { name: m.name, entry: m.entry, description: m.description } : null)
      const changed = plan.added.length + plan.replaced.length + plan.removed.length > 0 || meta(plan.before) !== meta(plan.after)
      if (!dry && changed) {
        assertEditable()
        applyGuidelines(root(), plan)
        figma.commitUndo()
        notifyPanel()
        // Read back rather than echo: a write this API accepts is not yet a write the file kept.
        const check = readGuidelines(root())
        const kept = check.manifest?.gen === plan.after?.gen && check.damaged.length === 0
        if (plan.after && !kept) throw new Error('the file did not keep the guidelines as written — nothing to rely on; try again or write fewer files')
      }
      return {
        dryRun: dry,
        changed,
        before: guidelinesSummary(plan.before),
        after: guidelinesSummary(plan.after),
        added: plan.added,
        replaced: plan.replaced,
        removed: plan.removed,
        unchanged: plan.unchanged,
        totalBytes: plan.totalBytes,
        entries: plan.writes.filter((w) => w.value !== '').length,
        ...(!dry && changed ? { verified: true } : {}),
      }
    },
  },

  {
    name: 'docs.configure',
    summary: 'Read or pin how THIS FILE exports its documentation (COMPONENTS.md, previews) — the same for everyone who exports it.',
    agent:
      'The documentation half of the export (component pages, previews, their size budget) used to come from each person\'s ' +
      'panel, so the same file shipped a DESIGN.md with COMPONENTS.md on one machine and without it on another. Pinned ' +
      `here, the file decides. Without arguments it is a read. \`set\` merges (${DOCS_CONFIG_FIELDS.join(', ')}; null unpins ` +
      'one), `clear` removes the pin. Token settings are pinned separately with tokens.configure.',
    mutates: true,
    mutatesWhen: writesUnlessDry(['set', 'clear']),
    params: {
      set: { type: 'json', description: '{ "componentDocs": true, "componentPreviews": false, "previewBudgetMb": 8 } — null unpins a field.' },
      clear: { type: 'boolean', default: false, description: 'Remove the pin; each person\'s panel settings apply again.' },
      dryRun: { type: 'boolean', default: false, description: 'Validate and report without writing.' },
    },
    async run(params) {
      const before = readFileDocsConfig(root())
      let next: FileDocsConfig | null = before
      if (params.clear === true) next = null
      else if (params.set !== undefined) {
        if (!params.set || typeof params.set !== 'object' || Array.isArray(params.set)) throw new Error('"set" must be an object of fields to pin')
        const raw = { ...(params.set as Record<string, unknown>) }
        const unset = Object.keys(raw).filter((key) => raw[key] === null)
        const { config, problems } = normalizeFileDocsConfig(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null)))
        if (problems.length > 0) throw new Error(`nothing was written: ${problems.join('; ')}`)
        const merged: Record<string, unknown> = { ...(before ?? {}), ...config }
        for (const key of unset) delete merged[key]
        next = Object.keys(merged).length > 0 ? (merged as FileDocsConfig) : null
      }
      const changed = JSON.stringify(before) !== JSON.stringify(next)
      const dry = params.dryRun === true
      if (changed && !dry) {
        assertEditable()
        writeFileDocsConfig(next, root())
        figma.commitUndo()
        notifyPanel()
      }
      return { dryRun: dry, changed, before, after: next, ...(changed && !dry ? { verified: JSON.stringify(readFileDocsConfig(root())) === JSON.stringify(next) } : {}) }
    },
  },
]
