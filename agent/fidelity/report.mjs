/**
 * The run as a page a person reads: per page and width, the design beside the build, every
 * finding pinned where it is on the design, and the list grouped by section.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const KIND = {
  style: 'Style',
  shift: 'Vertical shift',
  position: 'Position',
  wrap: 'Line wrapping',
  raster: 'Text in image',
  missing: 'Missing from page',
}

export function describe(f) {
  switch (f.kind) {
    case 'style':
      return f.props.map((p) => `${p.property}: design ${p.figma}${p.unit}, page ${p.build}${p.unit}`).join('; ')
    case 'shift':
      return `${Math.abs(f.delta)}px ${f.delta > 0 ? 'below' : 'above'} the design${f.after ? ` — divergence starts after “${f.after.text}”` : ' from the top'}`
    case 'position':
      return `${Math.abs(f.dx)}px to the ${f.dx > 0 ? 'right' : 'left'}`
    case 'wrap':
      return `${f.figmaLines} lines in the design, ${f.buildLines} on the page (width ${f.figmaWidth}px versus ${f.buildWidth}px)`
    case 'raster':
      return 'text in the design is drawn into an image on the page, so it cannot be translated or edited'
    case 'missing':
      return 'design text is missing from the page'
    default:
      return ''
  }
}

function findingRows(findings) {
  const bySection = new Map()
  for (const [i, f] of findings.entries()) {
    const key = f.section?.name ?? '—'
    if (!bySection.has(key)) bySection.set(key, [])
    bySection.get(key).push({ f, i })
  }
  return [...bySection.entries()]
    .map(
      ([section, rows]) => `
      <h4>${esc(section)} <span class="muted">${rows.length}</span></h4>
      <ol class="findings">${rows
        .map(
          ({ f, i }) => `<li value="${i + 1}" data-i="${i}"><span class="kind k-${f.kind}">${KIND[f.kind]}</span>
            <q>${esc(f.text)}</q> — ${esc(describe(f))}
            ${f.selector ? `<code>${esc(f.selector)}</code>` : ''}</li>`
        )
        .join('')}</ol>`
    )
    .join('')
}

function pins(findings) {
  return findings
    .map((f, i) => `<a class="pin k-${f.kind}" style="left:${f.at.x}px;top:${f.at.y}px" href="#" data-i="${i}" title="${esc(KIND[f.kind] + ': ' + describe(f))}">${i + 1}</a>`)
    .join('')
}

/**
 * The same style difference across many texts is one defect in one CSS rule, not thirty: grouped
 * by property and value pair, most widespread first. This is also the unit a ticket is made of.
 */
export function systemic(runs) {
  const groups = new Map()
  for (const r of runs) {
    for (const f of r.findings ?? []) {
      if (f.kind !== 'style') continue
      for (const p of f.props) {
        const key = `${p.property}|${p.figma}|${p.build}`
        if (!groups.has(key)) groups.set(key, { property: p.property, figma: p.figma, build: p.build, unit: p.unit, places: [] })
        groups.get(key).places.push({ page: r.page, width: r.width, text: f.text, nodeId: f.nodeId, selector: f.selector })
      }
    }
  }
  return [...groups.values()].sort((a, b) => b.places.length - a.places.length)
}

export function renderReport({ project, base, fileName, lastModified, startedAt, runs }) {
  const total = runs.reduce((n, r) => n + (r.findings?.length ?? 0), 0)
  const groups = systemic(runs).filter((g) => g.places.length > 1)
  const summary = groups.length === 0 ? '' : `
    <section class="run"><h2>Systemic style differences</h2>
    <p class="muted">The same difference in several places is probably one CSS rule.</p>
    <table><thead><tr><th>Property</th><th>Design</th><th>Page</th><th>Places</th><th>Examples</th></tr></thead><tbody>
    ${groups.slice(0, 25).map((g) => `<tr><td><code>${esc(g.property)}</code></td><td>${esc(g.figma)}${esc(g.unit)}</td><td>${esc(g.build)}${esc(g.unit)}</td><td>${g.places.length}</td><td>${g.places.slice(0, 3).map((p) => `“${esc(p.text.slice(0, 40))}” <span class="muted">${p.width}px</span>`).join(', ')}</td></tr>`).join('')}
    </tbody></table></section>`
  const sections = runs
    .map((r, ri) => {
      if (r.error) return `<section class="run"><h2>${esc(r.page)} · ${r.width}px</h2><p class="error">${esc(r.error)}</p></section>`
      const counts = Object.entries(
        r.findings.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {})
      )
        .map(([k, n]) => `<span class="kind k-${k}">${KIND[k]} ${n}</span>`)
        .join(' ')
      return `
    <section class="run" id="run-${ri}">
      <h2>${esc(r.page)} · ${r.width}px</h2>
      <p class="meta"><a href="${esc(r.url)}">${esc(r.url)}</a> · frame <code>${esc(r.frameId)}</code> “${esc(r.frameName)}” ·
        matched ${r.stats.matched} of ${r.stats.designTexts} texts</p>
      <p>${counts || '<span class="ok">No differences found</span>'}</p>
      <div class="split">
        <div class="list">${findingRows(r.findings)}</div>
        <div class="stage" style="--w:${r.width}px">
          <div class="controls">
            <label><input type="radio" name="m${ri}" value="side" checked> side by side</label>
            <label><input type="radio" name="m${ri}" value="overlay"> overlay</label>
            <input type="range" min="0" max="100" value="50" aria-label="Page opacity">
            <select aria-label="Scale">${[0.25, 0.5, 0.75, 1].map((z) => `<option value="${z}"${z === (r.width >= 1200 ? 0.5 : r.width >= 700 ? 0.75 : 1) ? ' selected' : ''}>${z * 100}%</option>`).join('')}</select>
          </div>
          <div class="canvas side" style="zoom:${r.width >= 1200 ? 0.5 : r.width >= 700 ? 0.75 : 1}">
            <figure><figcaption>Design</figcaption><div class="frame"><img src="${esc(r.designPng)}" alt="">${pins(r.findings)}</div></figure>
            <figure><figcaption>Page</figcaption><div class="frame"><img src="${esc(r.buildPng)}" alt=""></div></figure>
          </div>
        </div>
      </div>
    </section>`
    })
    .join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design fidelity report</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--text:#1d1d1f;--muted:#6e6e73;--line:#e3e1dc;--style:#c2410c;--shift:#7c3aed;--position:#0369a1;--wrap:#b45309;--missing:#be123c;--raster:#4d7c0f}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121214;--card:#1c1c1f;--text:#f2f2f2;--muted:#9a9aa0;--line:#2c2c30}}
:root[data-theme="dark"]{--bg:#121214;--card:#1c1c1f;--text:#f2f2f2;--muted:#9a9aa0;--line:#2c2c30}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,system-ui,sans-serif}
header{padding:24px 16px;max-width:1600px;margin:auto}h1{margin:0 0 4px;font-size:22px}
.muted,.meta{color:var(--muted)}main{max-width:1600px;margin:auto;padding:0 16px 48px}
.run{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
.run h2{margin:0;font-size:18px}.error{color:var(--missing)}.ok{color:#15803d}
.split{display:grid;grid-template-columns:minmax(280px,420px) 1fr;gap:16px;align-items:start}
@media (max-width:900px){.split{grid-template-columns:1fr}}
.list{max-height:80vh;overflow:auto}.list h4{margin:12px 0 4px}
.findings{margin:0;padding-left:22px}.findings li{margin:4px 0;cursor:pointer}.findings li.on{background:color-mix(in srgb,var(--style) 12%,transparent)}
.findings code{display:block;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.kind{display:inline-block;font-size:11px;padding:1px 6px;border-radius:99px;color:#fff;background:var(--muted)}
.k-style{background:var(--style)}.k-shift{background:var(--shift)}.k-position{background:var(--position)}.k-wrap{background:var(--wrap)}.k-missing{background:var(--missing)}.k-raster{background:var(--raster)}
.stage{overflow:auto;max-height:80vh;border:1px solid var(--line);border-radius:8px}
.controls{position:sticky;top:0;z-index:3;background:var(--card);padding:6px 8px;display:flex;gap:12px;align-items:center;border-bottom:1px solid var(--line)}
.canvas{display:flex;gap:16px;padding:8px}.canvas figure{margin:0}.canvas figcaption{font-size:12px;color:var(--muted)}
.frame{position:relative;width:var(--w)}.frame img{display:block;width:var(--w)}
.canvas.overlay{display:grid}.canvas.overlay figure{grid-area:1/1}.canvas.overlay figure+figure{opacity:var(--o,.5)}
.canvas.overlay figcaption{display:none}
.pin{position:absolute;transform:translate(-50%,-50%);min-width:20px;height:20px;border-radius:10px;color:#fff;font-size:11px;line-height:20px;text-align:center;text-decoration:none;z-index:2}
.pin.on{outline:3px solid var(--text)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}
</style></head><body>
<header><h1>Design fidelity: ${esc(project)}</h1>
<p class="muted">Design “${esc(fileName)}” (modified ${esc(lastModified)}) · page ${esc(base)} · run ${esc(startedAt)} · ${total} differences total</p></header>
<main>${summary}${sections}</main>
<script>
document.querySelectorAll('.run').forEach(run => {
  const canvas = run.querySelector('.canvas');
  if (!canvas) return;
  run.querySelectorAll('input[type=radio]').forEach(r => r.addEventListener('change', () => { canvas.classList.toggle('overlay', r.value === 'overlay' && r.checked); canvas.classList.toggle('side', !(r.value === 'overlay' && r.checked)); }));
  run.querySelector('input[type=range]').addEventListener('input', e => canvas.style.setProperty('--o', e.target.value / 100));
  run.querySelector('select').addEventListener('change', e => { canvas.style.zoom = e.target.value; });
  const select = i => {
    run.querySelectorAll('.on').forEach(e => e.classList.remove('on'));
    run.querySelectorAll('[data-i="' + i + '"]').forEach(e => e.classList.add('on'));
    const pin = run.querySelector('.pin[data-i="' + i + '"]');
    if (pin) pin.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  };
  run.querySelectorAll('.findings li').forEach(li => li.addEventListener('click', () => select(li.dataset.i)));
  run.querySelectorAll('.pin').forEach(p => p.addEventListener('click', e => { e.preventDefault(); select(p.dataset.i); const li = run.querySelector('li[data-i="' + p.dataset.i + '"]'); if (li) li.scrollIntoView({ block: 'nearest' }); }));
});
</script></body></html>`
}
