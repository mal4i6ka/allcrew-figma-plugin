/**
 * Component documentation — the layer of a design system that lives ONLY in the designer's head
 * (and in Figma's "Component configuration" dialog): what a component does, when its appearance
 * changes, which prop drives what.
 *
 * A progress bar whose description says "100–50% fill L300, 25–49% Y300, 0–24% R500" carries logic
 * no token dump, no CSS and no screenshot can convey. Without it an agent implements a bar that
 * never changes color. This module turns those descriptions, documentation links, property
 * definitions and preview images into `COMPONENTS.md` — and the icon library, whose descriptions
 * are search keywords rather than behaviour, into a compact `ICONS.md`.
 *
 * Pure — the sandbox collects the data, this renders it.
 */

import { mdTable } from './sections.ts'
import { buildMentionIndex, findTokenMentions, type MentionIndex, type TokenMentions } from './token-mentions.ts'
import type { TokenEntry } from './model.ts'

export interface ComponentProperty {
  /** Property name as the designer typed it (without Figma's `#id` suffix). */
  name: string
  /** VARIANT | BOOLEAN | TEXT | INSTANCE_SWAP */
  type: string
  /** VARIANT options, in Figma's order. */
  options?: string[]
  defaultValue?: string
}

export interface ComponentDoc {
  /** Figma node id — the stable identity partial file names carry too. */
  id: string
  /** Full Figma name, e.g. `Data/Progress bar`. */
  name: string
  /** Page the component lives on, when known. */
  page?: string
  /** Markdown description from the Component configuration dialog. */
  description: string
  /** "Link to documentation" URIs. */
  links: string[]
  properties: ComponentProperty[]
  /** Variants in the set (absent for a lone component). */
  variantCount?: number
  /** Package-relative path of the captured preview image. */
  preview?: string
  /** Set when a preview was wanted but could not be produced (with the reason). */
  previewError?: string
}

export const COMPONENTS_FILE = 'COMPONENTS.md'
export const ICONS_FILE = 'ICONS.md'

/* ------------------------------------------------------------- description classification */

/**
 * What a Figma description actually is. Treating every non-empty description as a "behaviour
 * contract — implement this" turns an icon library's search keywords ("lock, privacy, security,
 * key…") into 15 fake contracts per file; agents that trust them implement garbage, agents that
 * learn to ignore them also skip the one real contract.
 */
export type DescriptionKind = 'contract' | 'notes' | 'tags'

/** A search-tag segment: a short bare-word phrase, no sentence punctuation, no markdown syntax. */
const TAG_SEGMENT = /^[A-Za-z][A-Za-z0-9 '’&/-]{0,40}$/

/** Conditional/state language — the fingerprint of real behaviour rules. */
const BEHAVIOUR_LANGUAGE =
  /\b(if|when|while|unless|until|then|must|should|never|always|only|hover(ed)?|press(ed)?|focus(ed)?|disabled|active|selected|checked|loading|error|invalid|state|states|min|max|fill|chang(e|es|ing)|switch(es)?|toggle(s)?|show(s)?|hide(s)?|limit(s)?)\b|%|\d+\s*px/i

/**
 * Classifies a description before it is promoted to a contract:
 * - a comma/line-separated list of bare words with no sentence structure → `tags` (icon search
 *   keywords — metadata, not behaviour);
 * - text with conditional/state language, a resolved token mention, or a reference to one of the
 *   component's own props → `contract`;
 * - everything else → `notes` (real prose, but nothing an agent must implement).
 */
export function classifyDescription(
  description: string,
  properties: readonly ComponentProperty[] = [],
  resolvedMentionCount = 0
): DescriptionKind {
  const text = description.trim()
  if (!text) return 'notes'
  const segments = text.split(/[,;\n]+/).map((segment) => segment.trim()).filter(Boolean)
  const tagLike = segments.filter(
    (segment) => TAG_SEGMENT.test(segment) && segment.split(/\s+/).length <= 3
  )
  if (segments.length >= 3 && tagLike.length >= segments.length * 0.8) return 'tags'
  if (resolvedMentionCount > 0) return 'contract'
  if (BEHAVIOUR_LANGUAGE.test(text)) return 'contract'
  const lower = text.toLowerCase()
  if (properties.some((property) => property.name && lower.indexOf(property.name.toLowerCase()) !== -1))
    return 'contract'
  return 'notes'
}

/**
 * Icon-shaped component: its description is a search-tag list, or it is a bare shape (no props,
 * no prose) living under an icon-named page/path. These entries move to `ICONS.md` so that
 * COMPONENTS.md stays readable at icon-library scale (1600 components, 574 KB otherwise).
 */
export function isIconDoc(doc: ComponentDoc): boolean {
  const description = doc.description.trim()
  if (description) return classifyDescription(description, doc.properties) === 'tags'
  return doc.properties.length === 0 && /\bicons?\b/i.test(`${doc.page ?? ''} ${doc.name}`)
}

/* ------------------------------------------------------------------ shared rendering */

function anchorSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Unique markdown anchor per entry: duplicate names (`Arrows / Arrow` ×4) get the node id as a
 * suffix (`arrows-arrow--16-11919`), so the index's own links stop being ambiguous. */
function buildAnchors(docs: readonly ComponentDoc[]): Map<string, string> {
  const nameCounts = new Map<string, number>()
  for (const doc of docs) {
    const base = anchorSlug(doc.name)
    nameCounts.set(base, (nameCounts.get(base) ?? 0) + 1)
  }
  const anchors = new Map<string, string>()
  for (const doc of docs) {
    const base = anchorSlug(doc.name)
    anchors.set(doc.id, (nameCounts.get(base) ?? 0) > 1 ? `${base}--${anchorSlug(doc.id)}` : base)
  }
  return anchors
}

function propertyTable(properties: readonly ComponentProperty[]): string {
  if (properties.length === 0) return ''
  const rows = properties.map((property) => [
    `\`${property.name}\``,
    property.type.toLowerCase().replace('_', ' '),
    property.options && property.options.length > 0 ? property.options.map((option) => `\`${option}\``).join(', ') : '—',
    property.defaultValue !== undefined && property.defaultValue !== '' ? `\`${property.defaultValue}\`` : '—',
  ])
  return `\n\n${mdTable(['Property', 'Type', 'Options', 'Default'], rows)}`
}

/** Indents the designer's markdown into a blockquote so it can never break the page structure
 * (a `##` heading inside a description would otherwise hijack the document outline). */
function quoteDescription(description: string): string {
  return description
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n')
}

export interface ComponentsMdOptions {
  fileName: string
  generatedAt?: string
  /** How the components reach code in this target — one line, target-specific. */
  usage: string
  /** Tokens that shipped, so `Y300` / `glyph/tetriary` in a description resolve to a real
   * `var(--…)` instead of leaving the agent to guess a value. */
  tokens?: readonly TokenEntry[]
}

/** Resolution table for the tokens a description names, plus a drift warning for the ones that
 * match nothing — a rule pointing at a deleted token is worse than no rule. */
function mentionsBlock(mentions: TokenMentions | null): string {
  if (!mentions) return ''
  const { resolved, unresolved } = mentions
  const parts: string[] = []
  if (resolved.length > 0) {
    parts.push(
      `**Tokens named above**\n\n` +
        mdTable(
          ['In the text', 'Token', 'Use', 'Value'],
          resolved.map((mention) => [
            `\`${mention.text}\``,
            `\`${mention.entry.path.join('/')}\``,
            `\`${mention.entry.cssRef}\``,
            `\`${mention.entry.value}\``,
          ])
        )
    )
  }
  if (unresolved.length > 0) {
    parts.push(
      `**Stale references:** ${unresolved.map((text) => `\`${text}\``).join(', ')} — written like a ` +
        'variable name but matching nothing in this file (renamed, removed, or ambiguous between ' +
        'several variables). Do NOT invent a value: ask the designer which variable is meant.'
    )
  }
  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : ''
}

interface AnalyzedDoc {
  doc: ComponentDoc
  description: string
  kind: DescriptionKind | null
  mentions: TokenMentions | null
}

function analyzeDocs(
  docs: readonly ComponentDoc[],
  tokens: readonly TokenEntry[]
): AnalyzedDoc[] {
  const index: MentionIndex | undefined = tokens.length > 0 ? buildMentionIndex(tokens) : undefined
  return docs.map((doc) => {
    const description = doc.description.trim()
    const mentions = description && index ? findTokenMentions(description, tokens, index) : null
    const kind = description
      ? classifyDescription(description, doc.properties, mentions?.resolved.length ?? 0)
      : null
    return { doc, description, kind, mentions }
  })
}

/** Contracts first, then notes, then the rest — a description is the whole point of the file. */
function byDocumentation(a: AnalyzedDoc, b: AnalyzedDoc): number {
  const weight = (entry: AnalyzedDoc) => (entry.kind === 'contract' ? 0 : entry.kind === 'notes' ? 1 : 2)
  return weight(a) - weight(b) || a.doc.name.localeCompare(b.doc.name)
}

const KIND_LABEL: Record<DescriptionKind, string> = {
  contract: 'yes — behaviour contract',
  notes: 'notes',
  tags: 'search tags',
}

export function buildComponentsMd(docs: readonly ComponentDoc[], options: ComponentsMdOptions): string {
  if (docs.length === 0) return ''
  const analyzed = analyzeDocs(docs, options.tokens ?? []).sort(byDocumentation)
  const contracts = analyzed.filter((entry) => entry.kind === 'contract')
  const anchors = buildAnchors(analyzed.map((entry) => entry.doc))

  const previewNote = analyzed.some((entry) => entry.doc.preview)
    ? ''
    : analyzed.some((entry) => entry.doc.previewError)
      ? `\n\n_No previews in this package: ${analyzed.find((entry) => entry.doc.previewError)!.doc.previewError}._`
      : '\n\n_No previews in this package — enable Settings → Documentation → Component previews and re-scan._'

  const index = mdTable(
    ['Component', 'Behaviour documented', 'Props', 'Preview'],
    analyzed.map(({ doc, kind }) => [
      `[${doc.name}](#${anchors.get(doc.id)})`,
      kind ? KIND_LABEL[kind] : '—',
      doc.properties.length > 0 ? doc.properties.map((property) => `\`${property.name}\``).join(', ') : '—',
      doc.preview ? 'yes' : '—',
    ])
  )

  const sections = analyzed.map(({ doc, description, kind, mentions }) => {
    const uniqueAnchor = anchors.get(doc.id)!
    const parts: string[] = []
    // GFM derives the default anchor from the heading text; a duplicated name needs an explicit
    // one so the index link lands on THIS entry and not on whichever duplicate comes first.
    if (uniqueAnchor !== anchorSlug(doc.name)) parts.push(`<a id="${uniqueAnchor}"></a>`)
    parts.push(`## ${doc.name}`)
    const meta = [doc.page ? `Page: ${doc.page}` : '', `Figma node \`${doc.id}\``]
      .filter(Boolean)
      .join(' · ')
    parts.push(meta)
    if (doc.preview) parts.push(`![${doc.name}](${doc.preview})`)
    else if (doc.previewError) parts.push(`_No preview: ${doc.previewError}._`)
    if (kind === 'contract') {
      parts.push(
        `**Behaviour contract — implement this:**\n\n${quoteDescription(description)}` + mentionsBlock(mentions)
      )
    } else if (kind === 'notes') {
      parts.push(
        `**Designer notes** — written in Figma, but not phrased as a behaviour rule; treat as ` +
          `context, not as a spec:\n\n${quoteDescription(description)}` + mentionsBlock(mentions)
      )
    } else if (kind === 'tags') {
      // Search keywords are metadata: shown so nothing is lost, never framed as behaviour.
      parts.push(`**Search tags:** ${description.replace(/\s*\n\s*/g, ', ')}`)
    } else {
      parts.push(
        '_No description in Figma._ Implement it from the tokens and the preview, and do not invent ' +
          'behaviour the design does not show.'
      )
    }
    const properties = propertyTable(doc.properties)
    if (properties) parts.push(`**Properties**${properties}`)
    if (doc.links.length > 0) {
      parts.push(`**Documentation:** ${doc.links.map((link) => `<${link}>`).join(', ')}`)
    }
    return parts.join('\n\n')
  })

  const stamp = options.generatedAt ? `\n     generated: ${options.generatedAt}` : ''
  return (
    `# Components — ${options.fileName}\n\n` +
    `<!-- GENERATED by the Altery Design System Export Figma plugin.\n` +
    `     source of truth: the Component configuration of each Figma component${stamp}\n` +
    `     Do not hand-edit: re-export from Figma instead. -->\n\n` +
    `**Read the entry for a component before implementing or changing it.** ${contracts.length} of ` +
    `${analyzed.length} component(s) carry a behaviour contract written by the designer — conditional ` +
    `colors, state rules, content limits. None of that is visible in the tokens or the generated CSS, ` +
    `so skipping it produces a component that merely looks right.\n\n` +
    `${options.usage}\n\n` +
    `> **For designers:** a colour or size named in a description is resolved by looking it up in\n` +
    `> this file's variable table, so write the variable's real name — \`Yellow/Y300\`, \`bg/surface\`,\n` +
    `> \`number/Base\`. Any spelling the panel shows works (\`Yellow/Y300\`, \`Yellow.Y300\`, \`Y300\`),\n` +
    `> and a shorter form is fine while it is unambiguous. A name that matches nothing is reported\n` +
    `> as a stale reference instead of being silently dropped.\n\n` +
    `## Index\n\n${index}${previewNote}\n\n${sections.join('\n\n')}\n`
  )
}

/* ------------------------------------------------------------------ ICONS.md */

export interface IconsMdOptions {
  fileName: string
  generatedAt?: string
}

/** The icon library as a lookup table — name, node id, search tags, preview. One row per icon
 * instead of a five-paragraph COMPONENTS.md entry per glyph. */
export function buildIconsMd(docs: readonly ComponentDoc[], options: IconsMdOptions): string {
  if (docs.length === 0) return ''
  const sorted = [...docs].sort((a, b) => a.name.localeCompare(b.name))
  const table = mdTable(
    ['Icon', 'Figma node', 'Search tags', 'Preview'],
    sorted.map((doc) => [
      doc.name,
      `\`${doc.id}\``,
      doc.description.trim() ? doc.description.trim().replace(/\s*\n\s*/g, ', ') : '—',
      doc.preview ? `![${doc.name}](${doc.preview})` : '—',
    ])
  )
  const stamp = options.generatedAt ? `\n     generated: ${options.generatedAt}` : ''
  return (
    `# Icons — ${options.fileName}\n\n` +
    `<!-- GENERATED by the Altery Design System Export Figma plugin.${stamp}\n` +
    `     Do not hand-edit: re-export from Figma instead. -->\n\n` +
    `${sorted.length} icon component(s). Descriptions on icons are **search keywords**, not ` +
    `behaviour contracts — use this table to find the right glyph, and color it with an \`icon\` ` +
    `role token (see DESIGN.md).\n\n${table}\n`
  )
}

/* ------------------------------------------------------------------ DESIGN.md pointer */

/** The DESIGN.md pointer: agents load DESIGN.md, so it must say the contracts exist. Counts only
 * REAL contracts — 15 icon tag-lists presented as contracts teach the agent to ignore the one
 * that matters. */
export function componentDocsSection(docs: readonly ComponentDoc[], tokens: readonly TokenEntry[] = []): string {
  if (docs.length === 0) return ''
  const analyzed = analyzeDocs(docs, tokens)
  const contracts = analyzed.filter((entry) => entry.kind === 'contract')
  const notes = analyzed.filter((entry) => entry.kind === 'notes')
  if (contracts.length === 0) {
    return (
      `${docs.length} component(s) were exported, but none carries a behaviour contract in Figma` +
      (notes.length > 0 ? ` (${notes.length} carry designer notes)` : '') +
      `. See \`${COMPONENTS_FILE}\` for their properties, notes and previews.`
    )
  }
  const rows = contracts
    .slice(0, 40)
    .map(({ doc, description }) => [
      `\`${doc.name}\``,
      description.split('\n')[0].replace(/^#+\s*/, '').slice(0, 110),
      doc.preview ? `[preview](${doc.preview})` : '—',
    ])
  const more = contracts.length > rows.length ? `\n\n_+${contracts.length - rows.length} more in \`${COMPONENTS_FILE}\`._` : ''
  const notesLine = notes.length > 0
    ? `\n\n_${notes.length} further component(s) carry designer notes (context, not contracts) in \`${COMPONENTS_FILE}\`._`
    : ''
  return (
    `**${contracts.length} component(s) carry a behaviour contract** the designer wrote in Figma — ` +
    `conditional colors, state rules, content limits. They are NOT expressible in tokens or CSS, and ` +
    `an implementation that ignores them is wrong even when it looks correct.\n\n` +
    `Full text, properties and previews: \`${COMPONENTS_FILE}\`. **Read the entry for a component ` +
    `before you implement or change it.**\n\n` +
    `${mdTable(['Component', 'Contract (first line)', 'Preview'], rows)}${more}${notesLine}`
  )
}
