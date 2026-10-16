/**
 * The design side of a fidelity run: a frame's text, as Figma's REST API stores it, and a
 * rendering of the frame to put beside the page.
 *
 * REST rather than the plugin bridge: a run should not depend on a designer having the file open,
 * and the stored text — content, box, font, fill — is exactly what the page has to match. What
 * only the plugin knows (Figma's own CSS per layer, via design.measure) is a later refinement.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TOKEN_FILE = process.env.FIGMA_TOKEN_FILE || path.join(os.homedir(), '.allcrew-channel', 'figma-token')
export const API = 'https://api.figma.com/v1'

/** The same token, read the same way, as the bridge and the Code Connect CLI: the file's comment
 * lines are skipped. */
function token() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN.trim()
  const line = existsSync(TOKEN_FILE)
    ? readFileSync(TOKEN_FILE, 'utf8').split('\n').map((row) => row.trim()).find((row) => row && !row.startsWith('#') && !row.startsWith('PASTE'))
    : undefined
  if (!line) throw new Error(`no Figma token — put one in ${TOKEN_FILE} or FIGMA_TOKEN`)
  return line
}

export async function get(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'X-Figma-Token': token() } })
    // The images endpoint rate-limits in bursts; a short wait clears it.
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      continue
    }
    if (!res.ok) throw new Error(`Figma ${res.status} for ${url.replace(API, '')}: ${(await res.text()).slice(0, 200)}`)
    return res
  }
}

/** A cache keyed by the file's lastModified, so a rerun against an unchanged file costs nothing. */
async function cached(dir, name, produce) {
  const file = path.join(dir, name)
  if (existsSync(file)) return file
  await mkdir(dir, { recursive: true })
  await writeFile(file, await produce())
  return file
}

export async function fileVersion(fileKey) {
  const res = await get(`${API}/files/${fileKey}?depth=1`)
  const body = await res.json()
  return { name: body.name, lastModified: body.lastModified }
}

/** The frame's full node tree. */
export async function frameTree(fileKey, nodeId, cacheDir) {
  const file = await cached(cacheDir, `${nodeId.replace(/:/g, '-')}.json`, async () => {
    const res = await get(`${API}/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`)
    const body = await res.json()
    const doc = body.nodes?.[nodeId]?.document
    if (!doc) throw new Error(`node ${nodeId} not found in ${fileKey}`)
    return JSON.stringify(doc)
  })
  return JSON.parse(await readFile(file, 'utf8'))
}

/** The frame rendered to PNG at 1x — the picture the report puts beside the page. */
export async function frameImage(fileKey, nodeId, cacheDir) {
  return cached(cacheDir, `${nodeId.replace(/:/g, '-')}.png`, async () => {
    const res = await get(`${API}/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=1`)
    const url = (await res.json()).images?.[nodeId]
    if (!url) throw new Error(`Figma rendered nothing for ${nodeId}`)
    return Buffer.from(await (await fetch(url)).arrayBuffer())
  })
}

export function hex(paint) {
  const c = paint.color
  const to = (v) => Math.round(v * 255).toString(16).padStart(2, '0')
  const alpha = (paint.opacity ?? 1) * (c.a ?? 1)
  return `#${to(c.r)}${to(c.g)}${to(c.b)}${alpha < 0.999 ? to(alpha) : ''}`
}

const visible = (n) => n.visible !== false

/**
 * Every visible text layer of a frame, with its box relative to the frame and the style a browser
 * would have to reproduce.
 *
 * `skip` names layers (and their subtrees) that are not part of the page — a mobile frame's iOS
 * status bar is drawn into the design but never into the site.
 */
export function frameTexts(frame, { skip = [] } = {}) {
  const origin = frame.absoluteBoundingBox
  const out = []
  const walk = (node, clip, section) => {
    if (!visible(node) || skip.includes(node.name)) return
    const box = node.absoluteBoundingBox
    // A frame that clips its content hides what lies outside it; the page will not show that text.
    const nextClip = node.clipsContent && box ? box : clip
    if (node.type === 'TEXT' && box && node.characters?.trim()) {
      const inside = !clip || (box.y < clip.y + clip.height && box.y + box.height > clip.y && box.x < clip.x + clip.width && box.x + box.width > clip.x)
      if (inside) {
        const s = node.style ?? {}
        const fill = (node.fills ?? []).find((p) => p.type === 'SOLID' && p.visible !== false)
        out.push({
          nodeId: node.id,
          name: node.name,
          section,
          text: node.characters,
          x: Math.round(box.x - origin.x),
          y: Math.round(box.y - origin.y),
          w: Math.round(box.width),
          h: Math.round(box.height),
          style: {
            fontFamily: s.fontFamily,
            fontWeight: s.fontWeight,
            fontSize: s.fontSize,
            lineHeight: s.lineHeightPx ? Math.round(s.lineHeightPx * 100) / 100 : undefined,
            letterSpacing: s.letterSpacing ? Math.round(s.letterSpacing * 100) / 100 : 0,
            textCase: s.textCase,
            textAlign: s.textAlignHorizontal,
            color: fill ? hex(fill) : undefined,
          },
          // Text with more than one style run: the node-level style is only its first run's.
          mixed: Array.isArray(node.characterStyleOverrides) && node.characterStyleOverrides.some((v) => v !== 0),
        })
      }
    }
    for (const child of node.children ?? []) {
      // The frame's direct children are its sections — the unit a finding is reported against.
      walk(child, nextClip, node === frame ? { id: child.id, name: child.name } : section)
    }
  }
  walk(frame, null, null)
  // Designers leave most sections called "Container". A finding filed against "Container" is
  // unfindable, so a generically named section is labelled by its topmost text — its heading.
  const GENERIC = /^(container|main_container|.*_container|frame( \d+)?|group( \d+)?|section|content|wrapper|block|rectangle( \d+)?)$/i
  const firstText = new Map()
  for (const t of out) {
    if (!t.section) continue
    const seen = firstText.get(t.section.id)
    if (!seen || t.y < seen.y || (t.y === seen.y && t.x < seen.x)) firstText.set(t.section.id, t)
  }
  for (const t of out) {
    if (t.section && GENERIC.test(t.section.name.trim())) {
      const head = firstText.get(t.section.id).text.replace(/\s+/g, ' ').trim()
      t.section = { ...t.section, name: head.length > 40 ? head.slice(0, 39) + '…' : head }
    }
  }
  return out
}
