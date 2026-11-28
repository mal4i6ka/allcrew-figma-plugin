import { test } from 'node:test'
import assert from 'node:assert/strict'
import { themesSection } from '../targets/design-md/sections.ts'
import { buildTokenModel } from '../targets/design-md/model.ts'
import { previewThemeAxes } from './index.ts'
import { detectThemeAxes } from './theme-axes.ts'
import {
  buildPackage,
  parseThemeAxes,
  themeGridOf,
  splitThemeGrid,
  toAxesCss,
  type ThemeGrid,
  type TokenGraph,
  type TokenTree,
} from './engine.ts'

/* ------------------------------------------------------------- a tiny cascade */

/**
 * Just enough CSS to check the selectors `toAxesCss` writes: attribute selectors, `:root`,
 * `:not([attr])`, compounds and the descendant combinator, ranked by specificity then source
 * order, with custom properties inheriting. A selector claim is only as good as the browser
 * that agrees with it, and this is the part of the browser that decides.
 */
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
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
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

function matchesCompound(el: El, compound: Simple[]): boolean {
  return compound.every((s) =>
    s.kind === 'root' ? el.parent === undefined : s.kind === 'is' ? el.attrs[s.attr] === s.value : !(s.attr in el.attrs)
  )
}

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

/* ------------------------------------------------------------- random inputs */

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const pick = <T,>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)]

/** A token tree over every outer × inner theme, with values drawn from a tiny alphabet so that
 * every kind of equality — constant, one axis, both, one product equal to another — turns up. */
function randomTree(r: () => number, outer: string[], inner: string[], count: number): TokenTree {
  const tree: TokenTree = {}
  for (let n = 0; n < count; n++) {
    const modes: Record<string, string> = {}
    for (const o of outer) for (const i of inner) modes[`${o}-${i}`] = pick(r, ['a', 'b', 'c'])
    tree[`t${n}`] = { $type: 'string', $value: modes[`${outer[0]}-${inner[0]}`], $extensions: { modes } }
  }
  return tree
}

/** A page: the outer attribute at most once on any path, the inner one anywhere — on the same
 * element, below, nested in itself — and above the outer one at most once. */
function randomPage(r: () => number, outer: string[], inner: string[]): El[] {
  const all: El[] = []
  const grow = (parent: El | undefined, depth: number, outerAbove: boolean, innerAbove: number): El => {
    const el: El = { attrs: {}, parent, children: [] }
    all.push(el)
    let hasOuter = outerAbove
    let inners = innerAbove
    if (!outerAbove && innerAbove <= 1 && r() < 0.35) {
      el.attrs['data-product'] = pick(r, outer)
      hasOuter = true
    }
    if (r() < 0.45) {
      el.attrs['data-theme'] = pick(r, inner)
      inners++
    }
    const kids = depth >= 4 ? 0 : Math.floor(r() * 3)
    for (let k = 0; k < kids; k++) el.children.push(grow(el, depth + 1, hasOuter, inners))
    return el
  }
  grow(undefined, 0, false, 0)
  return all
}

function nearest(el: El, attr: string): string | undefined {
  for (let at: El | undefined = el; at; at = at.parent) if (attr in at.attrs) return at.attrs[attr]
  return undefined
}

function gridOf(outer: string[], inner: string[]): ThemeGrid {
  return {
    axes: [{ attribute: 'data-product', values: outer }, { attribute: 'data-theme', values: inner }],
    theme: (c) => `${c[0]}-${c[1]}`,
    defaults: [outer[0], inner[0]],
    nested: true,
  }
}

test('every element reads the value of its nearest product and nearest theme, however the page nests them', () => {
  const shapes: Array<[string[], string[]]> = [
    [['one', 'business', 'platform'], ['light', 'dark']],
    [['one', 'business'], ['light', 'dark', 'contrast']],
  ]
  let checked = 0
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed)
    const [outer, inner] = shapes[seed % shapes.length]
    const tree = randomTree(r, outer, inner, 12)
    const rules = parseCss(toAxesCss(tree, gridOf(outer, inner)))
    for (const el of randomPage(r, outer, inner)) {
      const o = nearest(el, 'data-product') ?? outer[0]
      const i = nearest(el, 'data-theme') ?? inner[0]
      for (const name of Object.keys(tree)) {
        const want = ((tree[name] as { $extensions: { modes: Record<string, string> } }).$extensions.modes)[`${o}-${i}`]
        const attrsOnPath: string[] = []
        for (let at: El | undefined = el; at; at = at.parent) attrsOnPath.unshift(JSON.stringify(at.attrs))
        assert.equal(computed(el, rules, `--${name}`), want, `seed ${seed} ${name} at ${attrsOnPath.join(' > ')}`)
        checked++
      }
    }
  }
  assert.ok(checked > 10000, `${checked} checks`)
})

test('with nothing nested, an element carrying the attributes reads its own cell, through compound selectors only', () => {
  const shapes: Array<[string[], string[]]> = [
    [['one', 'business', 'platform'], ['light', 'dark']],
    [['one', 'business'], ['light', 'dark', 'contrast']],
  ]
  let checked = 0
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed)
    const [outer, inner] = shapes[seed % shapes.length]
    const tree = randomTree(r, outer, inner, 12)
    const css = toAxesCss(tree, { ...gridOf(outer, inner), nested: false })
    assert.doesNotMatch(css, /:not|\] \[/, `seed ${seed}: a selector beyond one element`)
    const rules = parseCss(css)
    const cells: Array<[Record<string, string>, string, string]> = [[{}, outer[0], inner[0]]]
    for (const o of outer) {
      cells.push([{ 'data-product': o }, o, inner[0]])
      for (const i of inner) cells.push([{ 'data-product': o, 'data-theme': i }, o, i])
    }
    for (const i of inner) cells.push([{ 'data-theme': i }, outer[0], i])
    for (const [attrs, o, i] of cells) {
      const el: El = { attrs, children: [] }
      for (const name of Object.keys(tree)) {
        const want = ((tree[name] as { $extensions: { modes: Record<string, string> } }).$extensions.modes)[`${o}-${i}`]
        assert.equal(computed(el, rules, `--${name}`), want, `seed ${seed} ${name} at ${JSON.stringify(attrs)}`)
        checked++
      }
    }
  }
  assert.ok(checked > 10000, `${checked} checks`)
})

/* ------------------------------------------------------------- the setting */

test('theme axes read as attribute: values, in the order they nest', () => {
  assert.deepEqual(parseThemeAxes('data-product: One, Business, Platform; data-theme: Light, Dark'), [
    { attribute: 'data-product', values: ['One', 'Business', 'Platform'] },
    { attribute: 'data-theme', values: ['Light', 'Dark'] },
  ])
  assert.deepEqual(parseThemeAxes('data-product = One\ndata-theme = Light, Dark,'), [
    { attribute: 'data-product', values: ['One'] },
    { attribute: 'data-theme', values: ['Light', 'Dark'] },
  ])
  assert.deepEqual(parseThemeAxes(''), [])
})

test('mode names split into one value per axis, or the reason they do not', () => {
  const axes = parseThemeAxes('data-product: One, Business; data-theme: Light, Dark')
  const ordered = ['one-light', 'one-dark', 'business-light', 'business-dark']
  const split = splitThemeGrid(ordered, 'one-light', axes)
  assert.ok('grid' in split)
  assert.equal(split.grid.theme(['business', 'dark']), 'business-dark')
  assert.deepEqual(split.grid.defaults, ['one', 'light'])
  // The mode names as Figma spells them work as well as the slugs.
  assert.ok('grid' in splitThemeGrid(['One Light', 'One Dark', 'Business Light', 'Business Dark'], 'One Light', axes))

  const hole = splitThemeGrid(['one-light', 'one-dark', 'business-light'], 'one-light', axes)
  assert.ok('problem' in hole && /business × dark/.test(hole.problem))
  const stray = splitThemeGrid([...ordered, 'one-light-contrast'], 'one-light', axes)
  assert.ok('problem' in stray && /no attribute accounts for/.test(stray.problem))
  const three = splitThemeGrid(ordered, 'one-light', [...axes, { attribute: 'data-density', values: ['Compact'] }])
  assert.ok('problem' in three && /one or two/.test(three.problem))
  // One attribute is the plain theme switch: the outer axis is a placeholder with no attribute.
  const single = splitThemeGrid(['light', 'dark'], 'light', [{ attribute: 'data-theme', values: ['Light', 'Dark'] }])
  assert.ok('grid' in single)
  assert.equal(single.grid.axes.length, 1)
  assert.equal(single.grid.theme(['dark']), 'dark')
})

/* ------------------------------------------------------------- the package */

/** A two-product design system in miniature: one Product collection whose six modes are product × theme. */
function productFile(): TokenGraph {
  const modes = ['One Light', 'One Dark', 'Business Light', 'Business Dark', 'Platform Light', 'Platform Dark']
  const id = (name: string) => `m-${name.toLowerCase().replace(' ', '-')}`
  const rgb = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a: 1 })
  const byMode = (values: string[]) => Object.fromEntries(modes.map((m, k) => [id(m), rgb(values[k])]))
  return {
    collections: [{ id: 'c-product', name: 'Product', defaultModeId: id('One Light'), modes: modes.map((name) => ({ modeId: id(name), name })) }],
    variables: [
      // The same everywhere.
      { id: 'v-brand', name: 'brand', collectionId: 'c-product', resolvedType: 'COLOR', valuesByMode: byMode(['#fb5b0a', '#fb5b0a', '#fb5b0a', '#fb5b0a', '#fb5b0a', '#fb5b0a']) },
      // Light or dark, whatever the product.
      { id: 'v-text', name: 'content/primary', collectionId: 'c-product', resolvedType: 'COLOR', valuesByMode: byMode(['#111111', '#ffffff', '#111111', '#ffffff', '#111111', '#ffffff']) },
      // Both: Business and Platform share a palette One does not.
      { id: 'v-bg', name: 'background/base', collectionId: 'c-product', resolvedType: 'COLOR', valuesByMode: byMode(['#ffffff', '#000000', '#f4f4f4', '#101010', '#f4f4f4', '#101010']) },
    ],
  } as TokenGraph
}

const axesSettings = {
  inlinePrimitives: true,
  flattenAliases: true,
  collectionRoles: 'Product: themes',
  slugThemes: true,
  themeAxes: 'data-product: One, Business, Platform; data-theme: Light, Dark',
}

test('a product × theme file ships two attributes in layers: the same everywhere, each theme, what a product changes', () => {
  const pkg = buildPackage(productFile(), axesSettings)
  const css = pkg.files['tokens.css']

  const layers = [
    '/* base — the same in every theme */\n:root {\n  --color-brand: #fb5b0a;\n}',
    '/* light — [data-theme="light"], the default */\n:root,\n[data-theme="light"] {\n  --content-primary: #111111;\n  --background-base: #ffffff;\n}',
    '/* dark — [data-theme="dark"] */\n[data-theme="dark"] {\n  --content-primary: #ffffff;\n  --background-base: #000000;\n}',
  ]
  assert.equal(
    css,
    [
      ...layers,
      // Platform equals Business, so the two share one layer. The string form nests the theme, so
      // each block also reaches a subtree.
      '/* business, platform — what data-product changes */\n' +
        '[data-product="business"],\n[data-product="business"] [data-theme="light"],\n[data-product="platform"],\n[data-product="platform"] [data-theme="light"] {\n  --background-base: #f4f4f4;\n}\n\n' +
        '[data-product="business"][data-theme="dark"],\n[data-product="business"] [data-theme="dark"],\n[data-theme="dark"] [data-product="business"]:not([data-theme]),\n' +
        '[data-product="platform"][data-theme="dark"],\n[data-product="platform"] [data-theme="dark"],\n[data-theme="dark"] [data-product="platform"]:not([data-theme]) {\n  --background-base: #101010;\n}',
    ].join('\n\n') + '\n'
  )
  assert.doesNotMatch(css, /data-theme-name/)
  assert.equal(pkg.summary.notes, undefined)

  // Nothing nested: both attributes on one element, and nothing but compound selectors.
  const plain = buildPackage(productFile(), {
    ...axesSettings,
    themeAxes: { axes: [{ attribute: 'data-product', values: [{ label: 'One' }, { label: 'Business' }, { label: 'Platform' }] }, { attribute: 'data-theme', values: [{ label: 'Light' }, { label: 'Dark' }] }] },
  })
  assert.equal(
    plain.files['tokens.css'],
    [
      ...layers,
      '/* business, platform — what data-product changes */\n[data-product="business"],\n[data-product="platform"] {\n  --background-base: #f4f4f4;\n}\n\n' +
        '[data-product="business"][data-theme="dark"],\n[data-product="platform"][data-theme="dark"] {\n  --background-base: #101010;\n}',
    ].join('\n\n') + '\n'
  )
  assert.match(plain.files['README.md'], /Set both on the same element/)
})

test('axes the mode names do not spell fall back to one block per mode, and the export says why', () => {
  const pkg = buildPackage(productFile(), { ...axesSettings, themeAxes: 'data-product: One, Business; data-theme: Light, Dark' })

  assert.match(pkg.files['tokens.css'], /\[data-theme-name="platform-dark"\]/)
  assert.ok(pkg.summary.notes?.some((note) => /Theme axes not used — the mode "platform-light" names no value of data-product/.test(note)), String(pkg.summary.notes))
})

test('the README, the module files and DESIGN.md describe the attributes tokens.css uses', () => {
  const pkg = buildPackage(productFile(), { ...axesSettings, emitModuleFiles: true, cssModulesGlobal: false })

  assert.match(pkg.files['README.md'], /<html data-product="business" data-theme="dark">/)
  assert.match(pkg.files['README.md'], /theme axes `data-product` × `data-theme`/)
  assert.doesNotMatch(pkg.files['README.md'], /data-theme-name/)
  // A module file is one layer of tokens.css, and together they are tokens.css.
  const modules = Object.keys(pkg.files).filter((name) => name.endsWith('.module.css'))
  assert.deepEqual(modules, ['base.module.css', 'light.module.css', 'dark.module.css', 'business.module.css'])
  assert.equal(modules.map((name) => pkg.files[name]).join('\n'), pkg.files['tokens.css'])
  assert.match(pkg.files['business.module.css'], /^\[data-product="business"\]\[data-theme="dark"\],$/m)
  assert.match(pkg.files['README.md'], /`base\.module\.css`, `light\.module\.css`, `dark\.module\.css`, `business\.module\.css`/)

  const grid = themeGridOf(pkg.emitted.themes, axesSettings.themeAxes, pkg.emitted.defaultTheme)
  assert.ok(grid)
  const model = buildTokenModel(pkg.emitted.tree, pkg.emitted.themes, pkg.emitted.defaultTheme)
  const section = themesSection(model, 'data-theme-name', grid)
  assert.match(section, /<html data-product="business" data-theme="dark">/)
  assert.doesNotMatch(section, /data-theme-name/)
})

/* ------------------------------------------------------------- the picker's spec */

/** What a page reads, element by element, from a stylesheet — the cascade above, asked for every
 * token at every pair and layout that `toAxesCss` promises to get right. */
function readsEverywhere(css: string, outer: string[], inner: string[], want: (o: string, i: string, token: string) => string | undefined, tokens: string[]): string[] {
  const rules = parseCss(css)
  const mk = (attrs: Record<string, string>, parent?: El): El => {
    const el: El = { attrs, parent, children: [] }
    parent?.children.push(el)
    return el
  }
  const wrong: string[] = []
  const check = (el: El, o: string, i: string, label: string) => {
    for (const token of tokens) {
      const expected = want(o, i, token)
      const got = computed(el, rules, `--${token}`)
      if (got !== expected) wrong.push(`${label} ${o} × ${i} --${token}: ${got} ≠ ${expected}`)
    }
  }
  check(mk({}), outer[0], inner[0], 'nothing set')
  for (const o of outer) {
    for (const i of inner) {
      const other = inner.find((x) => x !== i) ?? i
      const productAttrs = outer.length > 1 ? { 'data-product': o } : {}
      const html = mk({ ...productAttrs, 'data-theme': i })
      check(html, o, i, 'same element')
      const card = mk({ 'data-theme': other }, mk({}, html))
      check(card, o, other, 'subtree')
      check(mk({ 'data-theme': i }, card), o, i, 'nested back')
      if (outer.length > 1) check(mk({ 'data-product': o }, mk({ 'data-theme': i })), o, i, 'product on body')
    }
  }
  return wrong
}

const valueOf = (pkg: ReturnType<typeof buildPackage>, theme: string, token: string): string | undefined => {
  const leaf = (pkg.emitted.tree as Record<string, any>)
  const path = token.split('-')
  let node: any = leaf
  for (const seg of path) node = node?.[seg]
  return node?.$extensions?.modes?.[theme]
}

test('names that do not spell their cell are placed by hand, and a cell no mode fills shows another', () => {
  // A file named its modes for people, not for a parser: the default product has no word at all,
  // and Platform has no Dark yet.
  const modes = ['Light', 'Dark', 'Business – Light mode', 'Business – Dark mode', 'CaaS light']
  const id = (n: number) => `m${n}`
  const graph = {
    collections: [{ id: 'c', name: 'Theme', defaultModeId: id(0), modes: modes.map((name, n) => ({ modeId: id(n), name })) }],
    variables: [
      { id: 'v', name: 'surface/base', collectionId: 'c', resolvedType: 'STRING', valuesByMode: Object.fromEntries(modes.map((m, n) => [id(n), `s${n}`])) },
    ],
  } as TokenGraph
  const spec = {
    axes: [
      { attribute: 'data-product', values: [{ label: 'One' }, { label: 'Business' }, { label: 'CaaS', value: 'platform' }] },
      { attribute: 'data-theme', nested: true, values: [{ label: 'Light' }, { label: 'Dark' }] },
    ],
    cells: { 'One|Light': 'Light', 'One|Dark': 'Dark', 'Business|Light': 'Business – Light mode', 'Business|Dark': 'Business – Dark mode', 'CaaS|Light': 'CaaS light' },
    sameAs: { 'CaaS|Dark': 'Business|Dark' },
  }
  const pkg = buildPackage(graph, { collectionRoles: 'Theme: themes', slugThemes: true, themeAxes: spec })
  assert.equal(pkg.summary.notes, undefined, String(pkg.summary.notes))
  const grid = pkg.emitted.grid!
  assert.deepEqual(grid.axes[0].values, ['one', 'business', 'platform'])
  assert.equal(grid.theme(['platform', 'dark']), grid.theme(['business', 'dark']))
  const want = (o: string, i: string) => ({ 'one|light': 's0', 'one|dark': 's1', 'business|light': 's2', 'business|dark': 's3', 'platform|light': 's4', 'platform|dark': 's3' })[`${o}|${i}`]
  assert.deepEqual(readsEverywhere(pkg.files['tokens.css'], grid.axes[0].values, grid.axes[1].values, want, ['surface-base']), [])
  assert.match(pkg.files['tokens.css'], /\[data-product="platform"\]/)

  // Without the hole filled, the export says which cell is missing instead of guessing.
  const holed = buildPackage(graph, { collectionRoles: 'Theme: themes', slugThemes: true, themeAxes: { ...spec, sameAs: undefined } })
  assert.ok(holed.summary.notes?.some((n) => /no mode is caas × dark/.test(n)), String(holed.summary.notes))
})

test('one attribute is the plain theme switch, right on a subtree too', () => {
  const graph = {
    collections: [{ id: 'c', name: 'Theme', defaultModeId: 'l', modes: [{ modeId: 'l', name: 'Light' }, { modeId: 'd', name: 'Dark' }, { modeId: 'h', name: 'High contrast' }] }],
    variables: [
      { id: 'a', name: 'text/primary', collectionId: 'c', resolvedType: 'STRING', valuesByMode: { l: 'ink', d: 'paper', h: 'ink' } },
      { id: 'b', name: 'border/default', collectionId: 'c', resolvedType: 'STRING', valuesByMode: { l: 'grey', d: 'grey', h: 'black' } },
    ],
  } as TokenGraph
  const pkg = buildPackage(graph, { themeAxes: { axes: [{ attribute: 'data-theme', values: [{ label: 'Light' }, { label: 'Dark' }, { label: 'High contrast', value: 'contrast' }] }] } })
  const css = pkg.files['tokens.css']
  assert.match(css, /^\/\* light — \[data-theme="light"\], the default \*\/\n:root,\n\[data-theme="light"\] \{/)
  assert.match(css, /\[data-theme="contrast"\] \{/)
  assert.doesNotMatch(css, /data-theme-name|\[="/)
  const modes = { light: 'Light', dark: 'Dark', contrast: 'High contrast' } as Record<string, string>
  const want = (_o: string, i: string, token: string) => valueOf(pkg, modes[i], token)
  // A high-contrast card inside a dark page: the flat stylesheet left --text-primary dark there.
  assert.deepEqual(readsEverywhere(css, ['_'], ['light', 'dark', 'contrast'], want, ['text-primary', 'border-default']), [])
  assert.match(pkg.files['README.md'], /Themes are one attribute, `data-theme`/)
})

/** A two-product design system as the designers keep it: One, a product per collection with Light/Dark; Business
 * holding only what it changes plus two tokens of its own; Shared for every product; and the old
 * merged Product collection, which the fold makes redundant. */
function productsAsCollections(): TokenGraph {
  const c = (id: string, name: string, modes: string[]) => ({ id, name, defaultModeId: `${id}:${modes[0]}`, modes: modes.map((m) => ({ modeId: `${id}:${m}`, name: m })) })
  const v = (id: string, collection: string, name: string, values: Record<string, unknown>) => ({
    id,
    name,
    collectionId: collection,
    resolvedType: 'STRING',
    valuesByMode: Object.fromEntries(Object.entries(values).map(([mode, value]) => [`${collection}:${mode}`, value])),
  })
  const alias = (id: string) => ({ type: 'VARIABLE_ALIAS', id })
  return {
    collections: [c('one', 'One', ['Light', 'Dark']), c('bus', 'Business', ['Light', 'Dark']), c('sh', 'Shared', ['Light', 'Dark']), c('prod', 'Product', ['One Light', 'One Dark'])],
    variables: [
      v('o-bg', 'one', 'background/base', { Light: 'white', Dark: 'black' }),
      v('o-text', 'one', 'content/primary', { Light: 'ink', Dark: 'paper' }),
      // Business does not override the card, but the card is the background: it must follow
      // Business's background in Business, as the merged collection re-aims the alias.
      v('o-card', 'one', 'surface/card', { Light: alias('o-bg'), Dark: alias('o-bg') }),
      v('b-bg', 'bus', 'background/base', { Light: 'mist', Dark: 'night' }),
      v('b-accent', 'bus', 'action/accent-secondary', { Light: 'teal', Dark: 'teal-dim' }),
      v('s-logo', 'sh', 'component/logo', { Light: 'logo-dark', Dark: 'logo-light' }),
      v('p-stale', 'prod', 'background/base', { 'One Light': 'stale', 'One Dark': 'stale' }),
    ],
  } as TokenGraph
}

const productsSpec = {
  axes: [
    {
      attribute: 'data-product',
      source: 'collections',
      values: [{ label: 'One', base: true }, { label: 'Business' }, { label: 'Platform', sameAs: 'Business' }],
      shared: ['Shared'],
    },
    { attribute: 'data-theme', nested: true, values: [{ label: 'Light' }, { label: 'Dark' }] },
  ],
}

test('products kept as collections are merged at export time: inherited, shared, and a product copying another', () => {
  const pkg = buildPackage(productsAsCollections(), {
    collectionRoles: 'Product: themes',
    slugThemes: true,
    inlinePrimitives: true,
    flattenAliases: true,
    themeAxes: productsSpec,
  })
  const css = pkg.files['tokens.css']
  const expected: Record<string, Record<string, string>> = {
    'one|light': { 'background-base': 'white', 'content-primary': 'ink', 'surface-card': 'white', 'action-accent-secondary': 'teal', 'component-logo': 'logo-dark' },
    'one|dark': { 'background-base': 'black', 'content-primary': 'paper', 'surface-card': 'black', 'action-accent-secondary': 'teal-dim', 'component-logo': 'logo-light' },
    'business|light': { 'background-base': 'mist', 'content-primary': 'ink', 'surface-card': 'mist', 'action-accent-secondary': 'teal', 'component-logo': 'logo-dark' },
    'business|dark': { 'background-base': 'night', 'content-primary': 'paper', 'surface-card': 'night', 'action-accent-secondary': 'teal-dim', 'component-logo': 'logo-light' },
  }
  expected['platform|light'] = expected['business|light']
  expected['platform|dark'] = expected['business|dark']
  const tokens = Object.keys(expected['one|light'])
  assert.deepEqual(readsEverywhere(css, ['one', 'business', 'platform'], ['light', 'dark'], (o, i, t) => expected[`${o}|${i}`][t], tokens), [])
  // The merged copy is left out, and the export says where the themes came from.
  assert.doesNotMatch(css, /stale/)
  assert.ok(pkg.summary.notes?.some((n) => /Themes read from One, Business, Shared/.test(n)), String(pkg.summary.notes))
  assert.ok(pkg.summary.notes?.some((n) => /Product left out/.test(n)), String(pkg.summary.notes))
  assert.deepEqual(pkg.summary.themes, ['one-light', 'one-dark', 'business-light', 'business-dark', 'platform-light', 'platform-dark'])
})

test('a product collection the file does not have refuses the axes and says so', () => {
  const spec = { ...productsSpec, axes: [{ ...productsSpec.axes[0], values: [{ label: 'One' }, { label: 'Corporate' }] }, productsSpec.axes[1]] }
  const pkg = buildPackage(productsAsCollections(), { collectionRoles: 'Product: themes', slugThemes: true, themeAxes: spec })
  assert.ok(pkg.summary.notes?.some((n) => /Theme axes not used — no collection's name contains "Corporate"/.test(n)), String(pkg.summary.notes))
})

/* ------------------------------------------------------------- what the picker starts from */

test('the picker starts from what the file has: product collections, a grid of mode names, or one attribute', () => {
  const coll = (name: string, modes: string[], variables = 10) => ({ name, modes, variables })
  // Products kept as collections win, the biggest as the base, Shared for every product.
  const ds3 = detectThemeAxes(
    [coll('Colors', ['Value'], 120), coll('One', ['Light', 'Dark'], 149), coll('Business', ['Light', 'Dark'], 40), coll('Shared', ['Light', 'Dark'], 1), coll('Product', ['One Light', 'One Dark', 'Business Light', 'Business Dark'], 159)],
    'Product'
  )
  assert.deepEqual(ds3?.spec.axes[0], {
    attribute: 'data-product',
    source: 'collections',
    values: [{ label: 'One', base: true }, { label: 'Business' }],
    shared: ['Shared'],
  })
  // Suggested attributes sit on one element; nesting the theme is something a person asks for.
  assert.equal(ds3?.spec.axes[1].nested, undefined)
  // One collection of combined modes: the theme words go to the last, inner attribute, whichever comes first.
  const grid = detectThemeAxes([coll('Theme', ['Light One', 'Dark One', 'Light Business', 'Dark Business'])])
  assert.deepEqual(grid?.spec.axes.map((a) => [a.attribute, a.values.map((v) => v.label), !!a.nested]), [
    ['data-product', ['One', 'Business'], false],
    ['data-theme', ['Light', 'Dark'], false],
  ])
  // Plain light/dark: one attribute.
  const plain = detectThemeAxes([coll('Theme', ['Light', 'Dark', 'High contrast']), coll('Breakpoints', ['Desktop', 'Mobile'])])
  assert.deepEqual(plain?.spec.axes.map((a) => a.attribute), ['data-theme'])
  assert.equal(detectThemeAxes([coll('Sizes', ['Mode 1'])]), null)
})

test('the preview is the export: every cell and how it was filled, the html to set, the blocks that ship', () => {
  const pv = previewThemeAxes(productsAsCollections() as never, {
    inlinePrimitives: true,
    flattenAliases: true,
    themeAttribute: 'data-theme-name',
    slugThemes: true,
    collectionRoles: 'Product: themes',
    themeAxes: productsSpec,
  })
  assert.deepEqual(pv.problems, [])
  assert.equal(pv.html, '<html data-product="business" data-theme="dark">')
  assert.deepEqual(
    pv.grid?.cells.map((c) => `${c.outer}×${c.inner}=${c.theme}:${c.how}`),
    ['One×Light=one-light:fixed', 'One×Dark=one-dark:fixed', 'Business×Light=business-light:fixed', 'Business×Dark=business-dark:fixed', 'Platform×Light=platform-light:fixed', 'Platform×Dark=platform-dark:fixed']
  )
  assert.equal(pv.blocks[0].selector, ':root, [data-theme="light"]')
  assert.ok(pv.notes.some((n) => /merged at export time/.test(n)))
  // A cell nobody fills is a problem the picker can point at, not a silent fallback.
  const holed = previewThemeAxes(productsAsCollections() as never, {
    inlinePrimitives: true,
    flattenAliases: true,
    themeAttribute: 'data-theme-name',
    slugThemes: true,
    collectionRoles: 'Product: themes',
    themeAxes: { axes: [productsSpec.axes[0], { ...productsSpec.axes[1], values: [{ label: 'Light' }, { label: 'Dark' }, { label: 'Dim' }] }] },
  })
  assert.ok(holed.problems.some((p) => /no mode's name contains "Dim"/.test(p)), String(holed.problems))
})

/* ------------------------------------------------------------- one mode per collection */

/** A free-plan file: every collection has one mode, so a theme or a product lives in a collection
 * of its own or in the variable names. */
function freePlan(collections: Record<string, Record<string, string>>): TokenGraph {
  const ids = Object.keys(collections)
  return {
    collections: ids.map((name, n) => ({ id: `c${n}`, name, defaultModeId: `m${n}`, modes: [{ modeId: `m${n}`, name: 'Mode 1' }] })),
    variables: ids.flatMap((name, n) =>
      Object.entries(collections[name]).map(([variable, value], k) => ({ id: `v${n}-${k}`, name: variable, collectionId: `c${n}`, resolvedType: 'STRING', valuesByMode: { [`m${n}`]: value } }))
    ),
  } as TokenGraph
}

const theme = (values: string[], extra: object = {}) => ({ attribute: 'data-theme', nested: true, ...extra, values: values.map((label) => ({ label })) })

test('free plan: a theme per collection, the dark one holding only what it changes', () => {
  const graph = freePlan({ Colors: { 'bg/base': 'white', 'text/primary': 'ink', 'brand/accent': 'orange' }, 'Colors Dark': { 'bg/base': 'black', 'text/primary': 'paper' } })
  const spec = { axes: [{ ...theme(['Light', 'Dark'], { source: 'collections' }), values: [{ label: 'Light', collections: ['Colors'] }, { label: 'Dark' }] }] }
  const pkg = buildPackage(graph, { slugThemes: true, themeAxes: spec })
  const want = (_o: string, i: string, t: string) => ({ light: { 'bg-base': 'white', 'text-primary': 'ink', 'brand-accent': 'orange' }, dark: { 'bg-base': 'black', 'text-primary': 'paper', 'brand-accent': 'orange' } } as Record<string, Record<string, string>>)[i][t]
  assert.deepEqual(readsEverywhere(pkg.files['tokens.css'], ['_'], ['light', 'dark'], want, ['bg-base', 'text-primary', 'brand-accent']), [])
  assert.doesNotMatch(pkg.files['tokens.css'], /data-theme-name/)
})

test('free plan: product × theme as four collections named for their cell', () => {
  const graph = freePlan({
    'One Light': { 'bg/base': 'white', 'text/primary': 'ink' },
    'One Dark': { 'bg/base': 'black', 'text/primary': 'paper' },
    'Business Light': { 'bg/base': 'mist' },
    'Business Dark': { 'bg/base': 'night' },
  })
  const spec = { axes: [{ attribute: 'data-product', source: 'collections', values: [{ label: 'One' }, { label: 'Business' }] }, theme(['Light', 'Dark'], { source: 'collections' })] }
  const pkg = buildPackage(graph, { slugThemes: true, themeAxes: spec })
  assert.equal(pkg.summary.notes?.some((n) => /Theme axes not used/.test(n)), false, String(pkg.summary.notes))
  const table: Record<string, Record<string, string>> = {
    'one|light': { 'bg-base': 'white', 'text-primary': 'ink' },
    'one|dark': { 'bg-base': 'black', 'text-primary': 'paper' },
    'business|light': { 'bg-base': 'mist', 'text-primary': 'ink' },
    'business|dark': { 'bg-base': 'night', 'text-primary': 'paper' },
  }
  assert.deepEqual(readsEverywhere(pkg.files['tokens.css'], ['one', 'business'], ['light', 'dark'], (o, i, t) => table[`${o}|${i}`][t], ['bg-base', 'text-primary']), [])
})

test('one collection, themes as a marker in the variable names', () => {
  const graph = freePlan({ Tokens: { 'light/bg/base': 'white', 'dark/bg/base': 'black', 'text/light/primary': 'ink', 'text/dark/primary': 'paper', 'radius/card': '12' } })
  const pkg = buildPackage(graph, { slugThemes: true, themeAxes: { axes: [theme(['Light', 'Dark'], { source: 'names' })] } })
  const table: Record<string, Record<string, string>> = {
    light: { 'bg-base': 'white', 'text-primary': 'ink', 'radius-card': '12' },
    dark: { 'bg-base': 'black', 'text-primary': 'paper', 'radius-card': '12' },
  }
  const css = pkg.files['tokens.css']
  assert.deepEqual(readsEverywhere(css, ['_'], ['light', 'dark'], (_o, i, t) => table[i][t], ['bg-base', 'text-primary', 'radius-card']), [])
  // The marker is gone from the names: one --bg-base, not --light-bg-base and --dark-bg-base.
  assert.doesNotMatch(css, /--(light|dark)-|--text-(light|dark)-/)
})

test('products as collections, the theme as a marker inside each, unmarked meaning the base theme', () => {
  const graph = freePlan({
    One: { 'bg/base': 'white', 'dark/bg/base': 'black', 'radius/card': '12' },
    Business: { 'bg/base': 'mist', 'dark/bg/base': 'night' },
  })
  const spec = { axes: [{ attribute: 'data-product', source: 'collections', values: [{ label: 'One' }, { label: 'Business' }] }, { attribute: 'data-theme', nested: true, source: 'names', values: [{ label: 'Light' }, { label: 'Dark' }] }] }
  // Light is never marked: the unmarked variables are the base theme's, the usual one-mode layout.
  const pkg = buildPackage(graph, { slugThemes: true, themeAxes: spec })
  assert.equal(pkg.summary.notes?.some((n) => /Theme axes not used/.test(n)), false, String(pkg.summary.notes))
  const table: Record<string, Record<string, string>> = {
    'one|light': { 'bg-base': 'white', 'radius-card': '12' },
    'one|dark': { 'bg-base': 'black', 'radius-card': '12' },
    'business|light': { 'bg-base': 'mist', 'radius-card': '12' },
    'business|dark': { 'bg-base': 'night', 'radius-card': '12' },
  }
  assert.deepEqual(readsEverywhere(pkg.files['tokens.css'], ['one', 'business'], ['light', 'dark'], (o, i, t) => table[`${o}|${i}`][t], ['bg-base', 'radius-card']), [])
  // A theme other than the base with no marker anywhere is refused, not shown as a copy of Light.
  const dim = { ...spec, axes: [spec.axes[0], { ...spec.axes[1], values: [{ label: 'Light' }, { label: 'Dark' }, { label: 'Dim' }] }] }
  assert.ok(buildPackage(graph, { slugThemes: true, themeAxes: dim }).summary.notes?.some((n) => /no variable's name has "Dim"/.test(n)))
})

test('on a one-mode file the picker starts from collection names or markers, whichever the file uses', () => {
  const coll = (name: string, names: string[] = []) => ({ name, modes: ['Mode 1'], variables: names.length || 3, names })
  const cells = detectThemeAxes([coll('One Light'), coll('One Dark'), coll('Business Light'), coll('Business Dark')])
  assert.deepEqual(cells?.spec.axes.map((a) => [a.attribute, a.source, a.values.map((v) => v.label)]), [
    ['data-product', 'collections', ['One', 'Business']],
    ['data-theme', 'collections', ['Light', 'Dark']],
  ])
  const pair = detectThemeAxes([coll('Colors'), coll('Colors Dark'), coll('Typography')])
  assert.deepEqual(pair?.spec.axes[0].values, [{ label: 'Light', collections: ['Colors'], base: true }, { label: 'Dark' }])
  const marked = detectThemeAxes([coll('Tokens', ['bg/base', 'dark/bg/base', 'text/primary', 'dark/text/primary'])])
  assert.deepEqual(marked?.spec, {
    collections: ['Tokens'],
    axes: [{ attribute: 'data-theme', source: 'names', values: [{ label: 'Light', base: true }, { label: 'Dark' }] }],
  })
})
