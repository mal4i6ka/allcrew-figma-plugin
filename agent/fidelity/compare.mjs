/**
 * Design against build: which Figma text became which page block, and what differs.
 *
 * Pure — two lists in, findings out — so every rule here is testable without Chrome or Figma.
 *
 * Text is the join key. It is the one thing a design and a build share by construction, it
 * survives any markup the developer chose, and when it does not match that is a finding too.
 *
 * Vertical position is judged by DRIFT, not by absolute y. One section 40px too tall moves
 * everything below it 40px; reporting each of those texts as misplaced would bury the one real
 * defect under a hundred echoes. A finding is raised where the drift JUMPS, between the last text
 * that was still in step and the first one that is not — which is where the wrong height lives.
 */

export const DEFAULT_TOLERANCE = {
  fontSize: 0.5,
  lineHeight: 1,
  letterSpacing: 0.15,
  color: 4, // per channel, 0–255
  x: 4,
  drift: 8,
  window: 320,
}

export function normText(s) {
  return String(s)
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseColor(c) {
  if (!c) return null
  let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(c)
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), m[4] ? parseInt(m[4], 16) / 255 : 1]
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(c)
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
    return [Number(m[1]), Number(m[2]), Number(m[3]), a]
  }
  return null
}

export function toHex(c) {
  const p = parseColor(c)
  if (!p) return c
  const h = (v) => Math.round(v).toString(16).padStart(2, '0')
  return `#${h(p[0])}${h(p[1])}${h(p[2])}${p[3] < 0.999 ? h(p[3] * 255) : ''}`
}

const sameFamily = (a, b) => String(a ?? '').toLowerCase().replace(/\s+/g, '') === String(b ?? '').toLowerCase().replace(/\s+/g, '')

const words = (key) => new RegExp(`(^|[^\\p{L}\\p{N}])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u')

/**
 * The anchors to believe: the longest run whose page order agrees with the design order, and of
 * the equally long runs, the one whose drift changes least. A unique label the developer moved to
 * another section is the one that makes the drift lurch; a whole section missing from the page
 * moves every anchor below it by the same amount, and that run survives intact.
 */
function monotonic(anchors) {
  const n = anchors.length
  const drift = anchors.map((a) => a.build.y - a.design.y)
  const len = new Array(n).fill(1)
  const cost = drift.map((v) => Math.abs(v))
  const prev = new Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (anchors[j].build.y > anchors[i].build.y) continue
      const l = len[j] + 1
      const c = cost[j] + Math.abs(drift[i] - drift[j])
      if (l > len[i] || (l === len[i] && c < cost[i])) {
        len[i] = l
        cost[i] = c
        prev[i] = j
      }
    }
  }
  let best = -1
  for (let i = 0; i < n; i++) if (best === -1 || len[i] > len[best] || (len[i] === len[best] && cost[i] < cost[best])) best = i
  const keep = []
  while (best !== -1) {
    keep.unshift(anchors[best])
    best = prev[best]
  }
  // A lone anchor whose drift disagrees with both neighbours — who agree with each other — is a
  // coincidence that happened to fit the order.
  return keep.filter((a, i) => {
    const before = keep[i - 1]
    const after = keep[i + 1]
    if (!before || !after) return true
    const d = (x) => x.build.y - x.design.y
    return !(Math.abs(d(before) - d(after)) <= 40 && Math.abs(d(a) - d(before)) > 400)
  })
}

/**
 * Pairs design texts with build blocks, in two passes.
 *
 * ANCHORS first: texts that occur exactly once in the design and once on the page, long enough
 * not to be a coincidence. Ordered by design position, their page positions must ascend too; one
 * that does not is dropped. The anchors give the drift at every height of the page.
 *
 * Then everything else, looked for only NEAR where the drift says it should be. A short label —
 * "Open account", "Send", "1" — occurs all over a page, and pairing it with the nearest
 * occurrence in text order is how a header link ended up matched to a footer one 9,000px away.
 * Within the window a page block may also CONTAIN the design text (a developer joined two layers
 * into one paragraph); such a pair is partial and does not consume the block.
 *
 * A design text with no block near its spot, but a picture there, was drawn into the picture.
 */
export function match(design, build, { window = 320, media = [] } = {}) {
  const keyed = build.map((b, i) => ({ ...b, i, key: normText(b.text) }))
  const ds = [...design].map((d) => ({ ...d, key: normText(d.text) })).sort((a, b) => a.y - b.y || a.x - b.x)
  const count = (list) => list.reduce((m, x) => m.set(x.key, (m.get(x.key) ?? 0) + 1), new Map())
  const dCount = count(ds)
  const bCount = count(keyed)

  const candidates = ds
    .filter((d) => d.key.length >= 6 && dCount.get(d.key) === 1 && bCount.get(d.key) === 1)
    .map((d) => ({ design: d, build: keyed.find((b) => b.key === d.key), partial: false, anchor: true }))
  const anchors = monotonic(candidates)
  const anchored = new Set(anchors.map((a) => a.design.nodeId))
  const used = new Set(anchors.map((a) => a.build.i))

  const driftAt = (y) => {
    let drift = anchors.length > 0 ? anchors[0].build.y - anchors[0].design.y : 0
    for (const a of anchors) {
      if (a.design.y > y) break
      drift = a.build.y - a.design.y
    }
    return drift
  }

  const pairs = [...anchors]
  const missing = []
  const raster = []
  for (const d of ds) {
    if (anchored.has(d.nodeId)) continue
    const expectY = d.y + driftAt(d.y)
    const near = (b) => Math.abs(b.y - expectY) <= window
    const cost = (b) => Math.abs(b.y - expectY) + Math.abs(b.x - d.x) * 0.5
    const exact = keyed.filter((b) => !used.has(b.i) && b.key === d.key && near(b)).sort((a, b) => cost(a) - cost(b))[0]
    if (exact) {
      used.add(exact.i)
      pairs.push({ design: d, build: exact, partial: false, anchor: false })
      continue
    }
    const contains = d.key.length >= 2
      ? keyed
          .filter((b) => near(b) && b.key !== d.key && (
            (b.key.length > d.key.length && words(d.key).test(b.key)) ||
            (d.key.length > b.key.length && b.key.length >= 4 && b.key.length / d.key.length >= 0.6 && d.key.includes(b.key))
          ))
          .sort((a, b) => cost(a) - cost(b))[0]
      : undefined
    if (contains) {
      pairs.push({ design: d, build: contains, partial: true, anchor: false })
      continue
    }
    // One layer of several lines — a list drawn as a text block — built as one element per line.
    const rows = d.text.split('\n').map(normText).filter(Boolean)
    if (rows.length > 1) {
      const found = rows.map((row) => keyed.find((b) => b.key === row && Math.abs(b.y - expectY) <= window + d.h)).filter(Boolean)
      if (found.length >= Math.ceil(rows.length * 0.6)) {
        // Found, but which element carries the block's style is anyone's guess: no style verdict.
        pairs.push({ design: d, build: found[0], partial: true, anchor: false, rows: true })
        continue
      }
    }
    const cx = d.x + d.w / 2
    const cy = expectY + d.h / 2
    const picture = media.find((m) => cx >= m.x && cx <= m.x + m.w && cy >= m.y && cy <= m.y + m.h)
    if (picture) raster.push({ design: d, media: picture })
    else missing.push(d)
  }
  pairs.sort((a, b) => a.design.y - b.design.y || a.design.x - b.design.x)
  return { pairs, anchors, missing, raster }
}

function styleFindings(d, b, tol) {
  const out = []
  const ds = d.style
  const bs = b.style
  const r2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)
  const push = (property, figma, build, unit = '') => out.push({ property, figma: r2(figma), build: r2(build), unit })

  if (ds.fontFamily && bs.fontFamily && !sameFamily(ds.fontFamily, bs.fontFamily)) push('font-family', ds.fontFamily, bs.fontFamily)
  if (ds.fontSize && Math.abs(ds.fontSize - bs.fontSize) > tol.fontSize) push('font-size', ds.fontSize, bs.fontSize, 'px')
  // A mixed-style layer's node-level weight and colour are only its first run's — not a fair claim.
  if (!d.mixed) {
    if (ds.fontWeight && bs.fontWeight && ds.fontWeight !== bs.fontWeight) push('font-weight', ds.fontWeight, bs.fontWeight)
    const dc = parseColor(ds.color)
    const bc = parseColor(bs.color)
    if (dc && bc && (dc.slice(0, 3).some((v, i) => Math.abs(v - bc[i]) > tol.color) || Math.abs(dc[3] - bc[3]) > 0.05)) {
      push('color', toHex(ds.color), toHex(bs.color))
    }
  }
  if (ds.lineHeight && bs.lineHeight !== undefined) {
    if (bs.lineHeight === null) push('line-height', ds.lineHeight, 'normal', 'px')
    else if (Math.abs(ds.lineHeight - bs.lineHeight) > tol.lineHeight) push('line-height', ds.lineHeight, bs.lineHeight, 'px')
  }
  if (Math.abs((ds.letterSpacing ?? 0) - (bs.letterSpacing ?? 0)) > tol.letterSpacing) {
    push('letter-spacing', ds.letterSpacing ?? 0, bs.letterSpacing ?? 0, 'px')
  }
  return out
}

/** Where a text sits horizontally, measured the way its alignment anchors it. */
function anchorX(box, align) {
  if (align === 'CENTER' || align === 'center') return box.x + box.w / 2
  if (align === 'RIGHT' || align === 'right' || align === 'end') return box.x + box.w
  return box.x
}

function lines(box, lineHeight) {
  return lineHeight ? Math.max(1, Math.round(box.h / lineHeight)) : null
}

export function compare(design, build, tolerance = {}, media = []) {
  const tol = { ...DEFAULT_TOLERANCE, ...tolerance }
  const { pairs, anchors, missing, raster } = match(design, build, { window: tol.window, media })
  const findings = []
  const base = (d) => ({ nodeId: d.nodeId, section: d.section ?? null, text: d.text.slice(0, 120) })

  for (const { design: d, build: b, partial, rows } of pairs) {
    // A font size off the half-pixel grid (12.95px) is a layer inside a scaled-down illustration —
    // a phone mock-up — and the page sets that text at its real size on purpose.
    const scaled = typeof d.style.fontSize === 'number' && Math.abs(d.style.fontSize * 2 - Math.round(d.style.fontSize * 2)) > 0.02
    // A design text that is a small part of the block it was found in — "Logo" inside "…upload your
    // logo for a branded look" — was found, but that block's style is someone else's.
    const fragment = partial && normText(d.text).length < normText(b.text).length * 0.5
    const props = rows || scaled || fragment ? [] : styleFindings(d, b, tol)
    if (props.length > 0) findings.push({ kind: 'style', ...base(d), selector: b.selector, props, at: { x: d.x, y: d.y } })

    // Horizontal placement, by the edge (or centre) the alignment holds still. Partial matches
    // are a different box and say nothing about placement.
    if (!partial) {
      const dx = Math.round(anchorX(b, b.style.textAlign) - anchorX(d, d.style.textAlign))
      if (Math.abs(dx) > tol.x) findings.push({ kind: 'position', ...base(d), selector: b.selector, dx, at: { x: d.x, y: d.y } })
      const dl = lines(d, d.style.lineHeight)
      const bl = lines(b, b.style.lineHeight ?? d.style.lineHeight)
      if (dl && bl && dl !== bl) {
        findings.push({ kind: 'wrap', ...base(d), selector: b.selector, figmaLines: dl, buildLines: bl, figmaWidth: d.w, buildWidth: b.w, at: { x: d.x, y: d.y } })
      }
    }
  }

  // Drift jumps between consecutive anchors only: they are the pairs that cannot be a mistaken
  // occurrence. The first anchor counts from zero, so a constant offset is reported once, at the top.
  let prev = null
  for (const a of anchors) {
    const drift = a.build.y - a.design.y
    const before = prev ? prev.build.y - prev.design.y : 0
    if (Math.abs(drift - before) > tol.drift) {
      findings.push({
        kind: 'shift',
        ...base(a.design),
        selector: a.build.selector,
        delta: drift - before,
        after: prev ? { nodeId: prev.design.nodeId, text: prev.design.text.slice(0, 80), section: prev.design.section ?? null } : null,
        at: { x: a.design.x, y: a.design.y },
      })
    }
    prev = a
  }

  for (const { design: d, media: m } of raster) findings.push({ kind: 'raster', ...base(d), selector: m.selector, at: { x: d.x, y: d.y } })
  for (const d of missing) findings.push({ kind: 'missing', ...base(d), at: { x: d.x, y: d.y } })

  return {
    findings,
    stats: { designTexts: design.length, buildBlocks: build.length, matched: pairs.length, anchors: anchors.length, raster: raster.length, missing: missing.length },
  }
}
