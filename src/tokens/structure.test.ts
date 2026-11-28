import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPackage, gridCoords, toAxesCss, varName, type ThemeGrid, type TokenGraph, type TokenTree } from './engine.ts'
import { deriveLegacy, materializeStructure, migrateStructure, normalizeStructure, type ExportStructure } from './structure.ts'

/* ------------------------------------------------------------- a tiny cascade */

/** Enough CSS to check the selectors `toAxesCss` writes: attribute selectors, `:root`,
 * `:not([attr])`, compounds and the descendant combinator, ranked by specificity then source
 * order, with custom properties inheriting. The same cascade theme-axes.test.ts uses. */
interface El {
  attrs: Record<string, string>
  parent?: El
  children: El[]
}
type Simple = { kind: 'root' } | { kind: 'is'; attr: string; value: string } | { kind: 'not'; attr: string }
interface Rule {
  selectors: Simple[][][]
  decls: Map<string, string>
  order: number
}
function parseCss(css: string): Rule[] {
  const rules: Rule[] = []
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = match[1].split(',').map((selector) =>
      selector
        .trim()
        .split(/\s+/)
        .map((compound) => {
          const simples: Simple[] = []
          for (const part of compound.matchAll(/:root|:not\(\[([\w-]+)\]\)|\[([\w-]+)="([^"]*)"\]/g)) {
            if (part[0] === ':root') simples.push({ kind: 'root' })
            else if (part[1]) simples.push({ kind: 'not', attr: part[1] })
            else simples.push({ kind: 'is', attr: part[2], value: part[3] })
          }
          return simples
        })
    )
    const decls = new Map<string, string>()
    for (const d of match[2].matchAll(/(--[\w-]+):\s*([^;]+);/g)) decls.set(d[1], d[2].trim())
    rules.push({ selectors, decls, order: rules.length })
  }
  return rules
}
const matchesCompound = (el: El, compound: Simple[]) =>
  compound.every((s) => (s.kind === 'root' ? el.parent === undefined : s.kind === 'is' ? el.attrs[s.attr] === s.value : !(s.attr in el.attrs)))
function matchesSelector(el: El, compounds: Simple[][], at = compounds.length - 1): boolean {
  if (!matchesCompound(el, compounds[at])) return false
  if (at === 0) return true
  for (let up = el.parent; up; up = up.parent) if (matchesSelector(up, compounds, at - 1)) return true
  return false
}
function computed(el: El, rules: Rule[], prop: string): string | undefined {
  let best: { spec: number; order: number; value: string } | undefined
  for (const rule of rules) {
    const value = rule.decls.get(prop)
    if (value === undefined) continue
    for (const compounds of rule.selectors) {
      if (!matchesSelector(el, compounds)) continue
      const spec = compounds.reduce((n, c) => n + c.length, 0)
      if (!best || spec > best.spec || (spec === best.spec && rule.order > best.order)) best = { spec, order: rule.order, value }
    }
  }
  return best ? best.value : el.parent ? computed(el.parent, rules, prop) : undefined
}
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
const pick = <T,>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]
const nearest = (el: El, attr: string): string | undefined => {
  for (let at: El | undefined = el; at; at = at.parent) if (attr in at.attrs) return at.attrs[attr]
  return undefined
}

test('three attributes: every element reads its nearest value on each, the outer two always on one element', () => {
  // product × density × theme: density is a second outer axis. Outer values sit together on one
  // element (the layout selectors can express); the theme nests anywhere.
  const axes = [
    { attribute: 'data-product', values: ['one', 'business'] },
    { attribute: 'data-density', values: ['cozy', 'compact'] },
    { attribute: 'data-theme', values: ['light', 'dark'] },
  ]
  const grid: ThemeGrid = { axes, theme: (c) => c.join('-'), defaults: axes.map((a) => a.values[0]), nested: true }
  let checked = 0
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed)
    const tree: TokenTree = {}
    const modes = (): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const p of axes[0].values) for (const d of axes[1].values) for (const t of axes[2].values) out[`${p}-${d}-${t}`] = pick(r, ['a', 'b', 'c'])
      return out
    }
    for (let n = 0; n < 8; n++) {
      const m = modes()
      tree[`t${n}`] = { $type: 'string', $value: m['one-cozy-light'], $extensions: { modes: m } }
    }
    const rules = parseCss(toAxesCss(tree, grid))
    const all: El[] = []
    // The layouts the selectors support: outer values together on one element, at most one
    // themed ancestor above that element, the theme switched anywhere below it.
    const grow = (parent: El | undefined, depth: number, outerAbove: boolean, innersAbove: number): El => {
      const el: El = { attrs: {}, parent, children: [] }
      all.push(el)
      let hasOuter = outerAbove
      if (!outerAbove && innersAbove <= 1 && r() < 0.4) {
        if (r() < 0.7) el.attrs['data-product'] = pick(r, axes[0].values)
        if (r() < 0.7) el.attrs['data-density'] = pick(r, axes[1].values)
        hasOuter = 'data-product' in el.attrs || 'data-density' in el.attrs
      }
      let inners = innersAbove
      if (r() < 0.45) {
        el.attrs['data-theme'] = pick(r, axes[2].values)
        inners++
      }
      const kids = depth >= 4 ? 0 : Math.floor(r() * 3)
      for (let k = 0; k < kids; k++) el.children.push(grow(el, depth + 1, hasOuter, inners))
      return el
    }
    grow(undefined, 0, false, 0)
    for (const el of all) {
      const coords = axes.map((a) => nearest(el, a.attribute) ?? a.values[0])
      for (const name of Object.keys(tree)) {
        const want = (tree[name] as { $extensions: { modes: Record<string, string> } }).$extensions.modes[coords.join('-')]
        assert.equal(computed(el, rules, `--${name}`), want, `seed ${seed} ${name} at ${coords.join('/')}`)
        checked++
      }
    }
  }
  assert.ok(checked > 5000, `${checked} checks`)
})

/* ------------------------------------------------------------- fixtures */

const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id })
/** A file as a table: collection → modes → variable → value. */
function file(spec: Record<string, { modes: string[]; vars: Record<string, unknown[]> }>): TokenGraph {
  const collections: TokenGraph['collections'] = []
  const variables: TokenGraph['variables'][number][] = []
  for (const [name, c] of Object.entries(spec)) {
    const id = name.replace(/\W+/g, '_').toLowerCase()
    collections.push({ id, name, defaultModeId: `${id}:${c.modes[0]}`, modes: c.modes.map((m) => ({ modeId: `${id}:${m}`, name: m })) })
    for (const [vname, values] of Object.entries(c.vars)) {
      variables.push({ id: `${id}/${vname}`, name: vname, collectionId: id, resolvedType: typeof values[0] === 'number' ? 'FLOAT' : 'STRING', valuesByMode: Object.fromEntries(c.modes.map((m, n) => [`${id}:${m}`, values[n] ?? values[0]])) })
    }
  }
  return { collections, variables } as TokenGraph
}

/** Values every theme cell of the package shows: the cascade of `tokens.css` on one element
 * carrying the cell's attributes. */
function cellValues(pkg: ReturnType<typeof buildPackage>): Record<string, Record<string, string>> {
  const css = pkg.files['tokens.css']
  const grid = pkg.emitted.grid
  assert.ok(grid, 'the package has theme attributes')
  const rules = parseCss(css)
  const names = [...new Set([...css.matchAll(/(--[\w-]+):/g)].map((m) => m[1]))]
  const out: Record<string, Record<string, string>> = {}
  for (const coords of gridCoords(grid)) {
    const el: El = { attrs: Object.fromEntries(grid.axes.map((axis, k) => [axis.attribute, coords[k]])), children: [] }
    out[varName([grid.theme(coords)])] = Object.fromEntries(names.map((name) => [name, computed(el, rules, name)!]))
  }
  return out
}

const base = { slugThemes: true, inlinePrimitives: true, flattenAliases: true, emitModuleFiles: true }

/* ------------------------------------------------------------- the structure */

test('the structure is checked, not trusted', () => {
  assert.deepEqual(normalizeStructure(undefined), { structure: null, problems: [] })
  assert.match(normalizeStructure({ collections: [{ name: 'A', sources: [] }, { name: 'a', sources: [] }] }).problems[0], /two output collections are named "a"/)
  assert.match(normalizeStructure({ collections: [{ name: 'A', as: 'csv', sources: [] }] }).problems[0], /must be tokens, hidden, files or breakpoints/)
  assert.match(
    normalizeStructure({ collections: [{ name: 'A', axes: [{ attribute: 'data-theme', nested: true, values: ['L'] }], sources: [] }, { name: 'B', axes: [{ attribute: 'data-product', nested: true, values: ['X'] }], sources: [] }] }).problems[0],
    /only one attribute can be switched inside the page/
  )
  assert.match(
    normalizeStructure({ collections: [{ name: 'A', axes: [{ attribute: 'data-theme', values: ['Light', 'Dark'] }], sources: [] }, { name: 'B', axes: [{ attribute: 'data-theme', values: ['Day'] }], sources: [] }] }).problems[0],
    /data-theme has different values/
  )
})

test('a group becomes a mode: dark/ overrides on a one-mode file, prefix stripped', () => {
  const graph = file({ Tokens: { modes: ['Mode 1'], vars: { 'bg/base': ['white'], 'dark/bg/base': ['black'], 'text/primary': ['ink'], 'dark/text/primary': ['paper'], 'radius/card': ['12'] } } })
  const structure: ExportStructure = {
    version: 1,
    collections: [
      {
        name: 'Tokens',
        axes: [{ attribute: 'data-theme', nested: true, values: [{ label: 'Light', base: true }, { label: 'Dark' }] }],
        sources: [{ collection: 'Tokens' }, { collection: 'Tokens', group: 'dark', to: '', at: { 'data-theme': 'Dark' } }],
      },
    ],
  }
  const pkg = buildPackage(graph, { ...base, structure })
  assert.deepEqual(cellValues(pkg), {
    light: { '--bg-base': 'white', '--text-primary': 'ink', '--radius-card': '12' },
    dark: { '--bg-base': 'black', '--text-primary': 'paper', '--radius-card': '12' },
  })
  assert.doesNotMatch(pkg.files['tokens.css'], /--dark-/)
  const made = materializeStructure(graph, structure)
  assert.equal(made.placement.groups['Tokens / dark'], '→ Tokens / (root) @ Dark')
})

test('regrouping: a group moved to the root, another hidden, an alias following the move', () => {
  const graph = file({
    Typography: { modes: ['Mode 1'], vars: { 'font-size/lg': [24], 'font/size/md': [16], 'font/family/sans': ['Inter'], '_old/size': [13] } },
    Text: { modes: ['Mode 1'], vars: { 'heading/size': [alias('typography/font/size/md')] } },
  })
  const structure: ExportStructure = {
    version: 1,
    collections: [
      { name: 'Typography', sources: [{ collection: 'Typography' }, { collection: 'Typography', group: 'font', to: '' }, { collection: 'Typography', group: 'font/family', hidden: true }] },
      { name: 'Text', sources: [{ collection: 'Text' }] },
    ],
  }
  const pkg = buildPackage(graph, { ...base, inlinePrimitives: false, flattenAliases: false, structure })
  const css = pkg.files['tokens.css']
  assert.match(css, /--size-md: 16px;/)
  assert.match(css, /--font-size-lg: 24px;/)
  assert.doesNotMatch(css, /--font-size-md|family|sans/)
  // The alias in Text was re-aimed at the moved variable, so it resolves to 16px, not to nothing.
  assert.match(css, /--heading-size: var\(--size-md\);/)
  assert.equal(materializeStructure(graph, structure).placement.groups['Typography / font/family'], 'hidden')
})

test('products as collections, the theme from their modes: inheritance, a product copying another, a shared collection', () => {
  const graph = file({
    One: { modes: ['Light', 'Dark'], vars: { 'bg/base': ['white', 'black'], 'text/primary': ['ink', 'paper'], 'surface/card': [alias('one/bg/base'), alias('one/bg/base')] } },
    Business: { modes: ['Light', 'Dark'], vars: { 'bg/base': ['mist', 'night'], 'action/accent': ['teal', 'teal-dim'] } },
    Shared: { modes: ['Light', 'Dark'], vars: { 'logo/mark': ['logo-dark', 'logo-light'] } },
    Colors: { modes: ['Value'], vars: { 'neutral/0': ['#fff'] } },
  })
  const structure: ExportStructure = {
    version: 1,
    collections: [
      {
        name: 'Product',
        axes: [
          { attribute: 'data-product', values: [{ label: 'One', base: true }, { label: 'Business' }, { label: 'Platform', sameAs: 'Business' }] },
          { attribute: 'data-theme', nested: true, values: [{ label: 'Light', base: true }, { label: 'Dark' }] },
        ],
        sources: [{ collection: 'One', at: { 'data-product': 'One' } }, { collection: 'Business', at: { 'data-product': 'Business' } }, { collection: 'Shared' }],
      },
      { name: 'Colors', as: 'hidden', sources: [{ collection: 'Colors' }] },
    ],
  }
  const pkg = buildPackage(graph, { ...base, structure })
  const cells = cellValues(pkg)
  assert.deepEqual(Object.keys(cells).sort(), ['business-dark', 'business-light', 'one-dark', 'one-light', 'platform-dark', 'platform-light'])
  assert.equal(cells['one-light']['--bg-base'], 'white')
  assert.equal(cells['business-dark']['--bg-base'], 'night')
  // Business has no text/primary: it takes One's, per theme.
  assert.equal(cells['business-dark']['--text-primary'], 'paper')
  // One has no action/accent: it takes it from the product that has one.
  assert.equal(cells['one-light']['--action-accent'], 'teal')
  // The card aliases the background and follows the product it is read in.
  assert.equal(cells['business-light']['--surface-card'], 'mist')
  // Shared goes to every product; Platform shows Business.
  assert.equal(cells['platform-dark']['--logo-mark'], 'logo-light')
  assert.deepEqual(cells['platform-light'], cells['business-light'])
  assert.doesNotMatch(pkg.files['tokens.css'], /neutral-0|data-theme-name/)
  assert.match(pkg.files['tokens.css'], /\[data-product="business"\]\[data-theme="dark"\]/)
})

test('separate files per product, the theme as modes inside each', () => {
  const graph = file({
    One: { modes: ['Light', 'Dark'], vars: { 'bg/base': ['white', 'black'] } },
    Business: { modes: ['Light', 'Dark'], vars: { 'bg/base': ['mist', 'night'] } },
  })
  const structure: ExportStructure = {
    version: 1,
    collections: [
      {
        name: 'Products',
        as: 'files',
        filesBy: 'data-product',
        axes: [{ attribute: 'data-product', values: [{ label: 'One' }, { label: 'Business' }] }, { attribute: 'data-theme', nested: true, values: [{ label: 'Light' }, { label: 'Dark' }] }],
        sources: [{ collection: 'One', at: { 'data-product': 'One' } }, { collection: 'Business', at: { 'data-product': 'Business' } }],
      },
    ],
  }
  const pkg = buildPackage(graph, { ...base, structure })
  assert.ok(pkg.files['one.css'] && pkg.files['business.css'], Object.keys(pkg.files).join(','))
  assert.match(pkg.files['one.css'], /--bg-base: white;/)
  assert.match(pkg.files['business.css'], /\[data-theme="dark"\] \{[^}]*--bg-base: night;/)
  assert.deepEqual(pkg.summary.products?.map((p) => p.name), ['One', 'Business'])
})

test('a collection the structure never names ships as it is, and the export says so', () => {
  const graph = file({ Tokens: { modes: ['Light', 'Dark'], vars: { 'bg/base': ['white', 'black'] } }, New: { modes: ['Mode 1'], vars: { 'radius/md': [8] } } })
  const structure: ExportStructure = { version: 1, collections: [{ name: 'Tokens', axes: [{ attribute: 'data-theme', nested: true, values: [{ label: 'Light', base: true }, { label: 'Dark' }] }], sources: [{ collection: 'Tokens' }] }] }
  const pkg = buildPackage(graph, { ...base, structure })
  assert.match(pkg.files['tokens.css'], /--radius-md: 8px;/)
  assert.deepEqual(materializeStructure(graph, structure).placement.collections.New, ['unplaced'])
})

test('a mode the names do not place is left out and named; placed by hand, it lands', () => {
  const graph = file({ Theme: { modes: ['Light', 'Dark', 'Contrast mode'], vars: { 'bg/base': ['white', 'black', 'yellow'] } } })
  const structure: ExportStructure = { version: 1, collections: [{ name: 'Theme', axes: [{ attribute: 'data-theme', nested: true, values: [{ label: 'Light', base: true }, { label: 'Dark' }, { label: 'High contrast' }] }], sources: [{ collection: 'Theme' }] }] }
  const made = materializeStructure(graph, structure)
  assert.deepEqual(made.placement.modes['Theme / Contrast mode'], [])
  assert.ok(made.notes.some((n) => /Contrast mode maps to no cell/.test(n)))
  const placed = { ...structure, collections: [{ ...structure.collections[0], sources: [{ collection: 'Theme', modes: { 'Contrast mode': { 'data-theme': 'High contrast' } } }] }] }
  const pkg = buildPackage(graph, { ...base, structure: placed })
  assert.equal(cellValues(pkg)['high-contrast']['--bg-base'], 'yellow')
})

/* ------------------------------------------------------------- migration */

/** the two-product file in miniature, with the settings pinned in the real file. */
function ds3(): TokenGraph {
  return file({
    Colors: { modes: ['Value'], vars: { 'neutral/0': ['#fff'], 'neutral/900': ['#111'] } },
    One: { modes: ['Light', 'Dark'], vars: { 'bg/base': [alias('colors/neutral/0'), alias('colors/neutral/900')] } },
    Business: { modes: ['Light', 'Dark'], vars: { 'bg/base': ['#f4f4f4', '#101010'] } },
    Product: { modes: ['One Light', 'One Dark', 'Business Light', 'Business Dark'], vars: { 'bg/base': [alias('colors/neutral/0'), alias('colors/neutral/900'), '#f4f4f4', '#101010'], 'content/primary': ['#111', '#fff', '#111', '#fff'] } },
    Typography: { modes: ['Mode 1'], vars: { 'font-size/lg': [24] } },
    Breakpoints: { modes: ['Value'], vars: { 'breakpoint/sm': [576], 'breakpoint/md': [768] } },
  })
}
const ds3Settings = {
  collectionRoles: 'Product: themes, One: hidden, Business: hidden, Colors: hidden, Breakpoints: breakpoints',
  slugThemes: true,
  themeAttribute: 'data-theme-name',
  themeAxes: 'data-product: One, Business; data-theme: Light, Dark',
}

test('the four old settings migrate into a structure that builds the same package', () => {
  const graph = ds3()
  const structure = migrateStructure(graph, ds3Settings)
  const legacy = buildPackage(graph, { ...base, ...ds3Settings })
  const migrated = buildPackage(graph, { ...base, structure })
  assert.deepEqual(Object.keys(migrated.files).filter((name) => name.endsWith('.module.css')), ['base.module.css', 'light.module.css', 'dark.module.css', 'business.module.css'])
  for (const name of ['tokens.css', 'base.module.css', 'light.module.css', 'dark.module.css', 'business.module.css', 'tokens.json']) assert.equal(migrated.files[name], legacy.files[name], name)
  assert.deepEqual(structure.collections.map((c) => [c.name, c.as ?? 'tokens']), [
    ['Product', 'tokens'],
    ['Colors', 'hidden'],
    ['One', 'hidden'],
    ['Business', 'hidden'],
    ['Typography', 'tokens'],
    ['Breakpoints', 'breakpoints'],
  ])
  assert.deepEqual(deriveLegacy(structure), { collectionRoles: 'Colors: hidden, One: hidden, Business: hidden, Breakpoints: breakpoints', themeAttribute: 'data-theme' })
})

test('the theme-collections table migrates to one collection per theme', () => {
  const graph = file({ 'Colors Light': { modes: ['Mode 1'], vars: { 'bg/base': ['white'] } }, 'Colors Dark': { modes: ['Mode 1'], vars: { 'bg/base': ['black'] } } })
  const settings = { themeAttribute: 'data-theme', themeMerges: { groups: [{ name: 'Colors', modes: [{ collection: 'Colors Light', name: 'Light' }, { collection: 'Colors Dark', name: 'Dark' }] }] } }
  const structure = migrateStructure(graph, settings)
  assert.deepEqual(structure.collections[0].sources, [{ collection: 'Colors Light', at: { 'data-theme': 'Light' } }, { collection: 'Colors Dark', at: { 'data-theme': 'Dark' } }])
  const pkg = buildPackage(graph, { ...base, structure })
  assert.deepEqual(cellValues(pkg), { light: { '--bg-base': 'white' }, dark: { '--bg-base': 'black' } })
})
