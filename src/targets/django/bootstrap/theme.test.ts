import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBootstrapTheme,
  collectThemedInstanceMasters,
  parseVariantName,
  themeButtonInstanceDecl,
  type ThemableSetData,
  type ThemableVariantData,
} from './theme.ts'

function v(name: string, css: Record<string, string>, labelCss: Record<string, string> | null = null): ThemableVariantData {
  return { name, css, labelCss }
}

/** A kit-shaped Button set: Primary md across the state chain + lg size + an outline role. */
function kitButtonSet(): ThemableSetData {
  return {
    kind: 'button',
    setName: 'Button',
    variants: [
      v(
        'Variant=Primary, Size=md, State=default',
        { background: 'var(--Base-orange-O500, #FB5B0A)', 'border-radius': '8px', padding: '6px 12px 6px 12px' },
        { color: '#FFFFFF', 'font-size': '16px', 'font-weight': '500' }
      ),
      v('Variant=Primary, Size=md, State=hover', { background: 'var(--Base-orange-O400, #FB6B23)', 'border-radius': '8px' }, { color: '#FFFFFF' }),
      v('Variant=Primary, Size=md, State=press', { background: 'var(--Base-orange-O600, #E54E04)', 'border-radius': '8px' }, { color: '#FFFFFF' }),
      v(
        'Variant=Primary, Size=lg, State=default',
        { background: 'var(--Base-orange-O500, #FB5B0A)', 'border-radius': '10px', padding: '12px 20px 12px 20px' },
        { color: '#FFFFFF', 'font-size': '20px' }
      ),
      v(
        'Variant=Outline-Light, Size=md, State=default',
        { border: '1px solid #F8F9FA', 'border-radius': '8px', padding: '6px 12px 6px 12px' },
        { color: '#F8F9FA' }
      ),
    ],
  }
}

test('parseVariantName splits "Variant=Primary, Size=md, State=default" into a lower-cased prop map', () => {
  const props = parseVariantName('Variant=Primary, Size=md, State=default')
  assert.equal(props.get('variant'), 'primary')
  assert.equal(props.get('size'), 'md')
  assert.equal(props.get('state'), 'default')
})

test('parseVariantName treats a bare single-axis value as the role', () => {
  assert.equal(parseVariantName('Primary').get('variant'), 'primary')
})

test('theme B: role variants become .btn-<role> var sets with hover/active from the State axis', () => {
  const css = buildBootstrapTheme([kitButtonSet()])

  assert.match(css, /\.btn-primary \{/)
  assert.match(css, /--bs-btn-bg: var\(--Base-orange-O500, #FB5B0A\);/) // token reference flows through
  assert.match(css, /--bs-btn-hover-bg: var\(--Base-orange-O400, #FB6B23\);/)
  assert.match(css, /--bs-btn-active-bg: var\(--Base-orange-O600, #E54E04\);/)
  assert.match(css, /--bs-btn-color: #FFFFFF;/)
  // Outline value encodes the Bootstrap outline variant directly.
  assert.match(css, /\.btn-outline-light \{/)
  assert.match(css, /--bs-btn-border-color: #F8F9FA;/)
})

test('theme B: sizes theme .btn (md) and .btn-lg with padding/font/radius vars, .btn first', () => {
  const css = buildBootstrapTheme([kitButtonSet()])

  assert.match(css, /\.btn \{[^}]*--bs-btn-padding-y: 6px;[^}]*--bs-btn-padding-x: 12px;/s)
  assert.match(css, /\.btn \{[^}]*--bs-btn-font-size: 16px;[^}]*--bs-btn-border-radius: 8px;/s)
  assert.match(css, /\.btn-lg \{[^}]*--bs-btn-padding-y: 12px;[^}]*--bs-btn-padding-x: 20px;/s)
  assert.ok(css.indexOf('.btn {') < css.indexOf('.btn-lg {'), '.btn base precedes size classes so the size class wins in document order')
})

test('theme B: a role with NO hover/press variants falls back to base values — no stock-Bootstrap state leaks', () => {
  const set: ThemableSetData = {
    kind: 'button',
    setName: 'Button',
    variants: [
      v('Variant=Secondary, Size=md, State=default', { background: '#FAF3ED', 'border-radius': '40px' }, { color: '#1D1D1F' }),
    ],
  }

  const css = buildBootstrapTheme([set])

  assert.match(css, /--bs-btn-hover-bg: #FAF3ED;/) // hover = base, not Bootstrap's darkened default
  assert.match(css, /--bs-btn-active-bg: #FAF3ED;/)
  assert.match(css, /--bs-btn-active-border-color: transparent;/) // stroke-less button never flashes a border
})

test("theme B: tolerant prop/state/size aliases — a custom set's Type=/Standart/Large rows are themable", () => {
  const set: ThemableSetData = {
    kind: 'button',
    setName: 'Button',
    variants: [
      v('Type=Secondary, Size=Large, State=Standart', { background: '#FAF3ED', padding: '20px 32px 20px 32px' }, { color: '#1D1D1F' }),
      v('Type=Secondary, Size=Large, State=Hover', { background: '#F1E4D8' }, { color: '#1D1D1F' }),
      v('Type=Secondary, Size=Large, State=Press', { background: '#E8D5C4' }, { color: '#1D1D1F' }),
    ],
  }

  const css = buildBootstrapTheme([set])

  assert.match(css, /\.btn-secondary \{/)
  assert.match(css, /--bs-btn-hover-bg: #F1E4D8;/) // State variants theme hover WITHOUT prototype reactions
  assert.match(css, /--bs-btn-active-bg: #E8D5C4;/)
  assert.match(css, /\.btn-lg \{[^}]*--bs-btn-padding-y: 20px;/s)
})

test('theme B: unknown kinds and empty sets yield an empty theme (file + link skipped)', () => {
  const alien: ThemableSetData = { kind: 'carousel', setName: 'Carousel', variants: [v('Variant=Dark', {})] }
  assert.equal(buildBootstrapTheme([alien]), '')
  assert.equal(buildBootstrapTheme([]), '')
})

// ---- phase C: per-instance deltas as var overrides -------------------------------------------

test('theme C: themeButtonInstanceDecl drops theme-carried props and turns deltas into --bs-btn-* overrides', () => {
  const master = { background: '#FB5B0A', 'border-radius': '8px', padding: '6px 12px 6px 12px' }
  const decl: Record<string, string> = {
    width: '200px', // unmapped — stays
    background: '#FB5B0A', // equal to master — dropped, theme carries it
    'border-radius': '40px', // designer override — var delta
    padding: '6px 12px 6px 12px', // equal — dropped
    'box-shadow': '0 4px 8px rgba(0,0,0,0.2)', // unmapped paint — stays (escape hatch)
  }

  themeButtonInstanceDecl(decl, master)

  assert.deepEqual(decl, {
    width: '200px',
    'box-shadow': '0 4px 8px rgba(0,0,0,0.2)',
    '--bs-btn-border-radius': '40px',
  })
})

test('theme C: an overridden background maps to base+hover+active vars — the override persists across states like Figma', () => {
  const decl: Record<string, string> = { background: 'var(--Brand-blue, #0055FF)' }

  themeButtonInstanceDecl(decl, { background: '#FB5B0A' })

  assert.equal(decl['--bs-btn-bg'], 'var(--Brand-blue, #0055FF)')
  assert.equal(decl['--bs-btn-hover-bg'], 'var(--Brand-blue, #0055FF)')
  assert.equal(decl['--bs-btn-active-bg'], 'var(--Brand-blue, #0055FF)')
  assert.ok(!('background' in decl))
})

test('theme C: a gradient background stays on the pixel path — background-color: var() cannot hold it', () => {
  const decl: Record<string, string> = { background: 'linear-gradient(180deg, #fff 0%, #000 100%)' }

  themeButtonInstanceDecl(decl, { background: '#FB5B0A' })

  assert.equal(decl['background'], 'linear-gradient(180deg, #fff 0%, #000 100%)')
  assert.ok(!('--bs-btn-bg' in decl))
})

test('theme C: padding and border deltas map to their var pairs', () => {
  const decl: Record<string, string> = { padding: '10px 24px 10px 24px', border: '2px solid #1D1D1F' }

  themeButtonInstanceDecl(decl, { padding: '6px 12px 6px 12px', border: '1px solid transparent' })

  assert.equal(decl['--bs-btn-padding-y'], '10px')
  assert.equal(decl['--bs-btn-padding-x'], '24px')
  assert.equal(decl['--bs-btn-border-width'], '2px')
  assert.equal(decl['--bs-btn-border-color'], '#1D1D1F')
  assert.equal(decl['--bs-btn-active-border-color'], '#1D1D1F')
  assert.ok(!('padding' in decl) && !('border' in decl))
})

test('theme C: collectThemedInstanceMasters matches instances to their BASE variant by set name + role + size', () => {
  const sets: ThemableSetData[] = [{
    kind: 'button',
    setName: 'Button',
    variants: [
      v('Variant=Primary, Size=md, State=default', { background: '#FB5B0A', 'border-radius': '8px' }),
      v('Variant=Primary, Size=md, State=hover', { background: '#FB6B23' }),
      v('Variant=Primary, Size=lg, State=default', { background: '#FB5B0A', 'border-radius': '10px' }),
    ],
  }]
  const tree = [{
    id: 'page:1', type: 'container',
    children: [
      { id: 'btn:1', type: 'instance-ref', componentSetName: 'Button',
        componentProperties: { Variant: { type: 'VARIANT', value: 'Primary' }, Size: { type: 'VARIANT', value: 'lg' } }, children: [] },
      { id: 'div:1', type: 'container', children: [] }, // not an instance — ignored
      { id: 'card:1', type: 'instance-ref', componentSetName: 'Card', componentProperties: {}, children: [] }, // unknown set — ignored
    ],
  }]

  const masters = collectThemedInstanceMasters(tree, sets)

  assert.deepEqual([...masters.keys()], ['btn:1'])
  assert.equal(masters.get('btn:1')!['border-radius'], '10px', 'the lg BASE variant is the diff master')
})

test('theme C: an instance with no role prop matches a single-role set, and is skipped for a multi-role one', () => {
  const single: ThemableSetData = { kind: 'button', setName: 'CTA', variants: [v('Variant=Brand, Size=md, State=default', { background: '#000' })] }
  const multi: ThemableSetData = {
    kind: 'button', setName: 'Button',
    variants: [v('Variant=Primary, State=default', { background: '#111' }), v('Variant=Secondary, State=default', { background: '#222' })],
  }
  const tree = [
    { id: 'a:1', type: 'instance-ref', componentSetName: 'CTA', componentProperties: {}, children: [] },
    { id: 'b:1', type: 'instance-ref', componentSetName: 'Button', componentProperties: {}, children: [] },
  ]

  const masters = collectThemedInstanceMasters(tree, [single, multi])

  assert.ok(masters.has('a:1'), 'single-role set covers a prop-less instance')
  assert.ok(!masters.has('b:1'), 'ambiguous role — pixel path keeps it safe')
})

// ---- regressions from the live re-export (post-C) ---------------------------------------------

test('regression: the theme emits an UN-LAYERED border-radius consumer so btn-group corner-zeroing cannot cut the design', () => {
  const css = buildBootstrapTheme([kitButtonSet()])

  assert.match(css, /\.btn \{\n  border-radius: var\(--bs-btn-border-radius\);\n\}/)
})

test('regression: token-ALIASED values are not deltas — instance semantic token vs master raw token, same color', () => {
  // The instance path runs tokenOverrides (semantic names), the collector reads raw getCSSAsync —
  // string-unequal but SAME resolved color. A false bg delta pinned hover/active to the base color.
  const decl: Record<string, string> = {
    background: 'var(--background-primary, #FB5B0A)',
    'border-radius': '6px 6px 6px 6px',
    padding: '6px 12px 6px 12px',
  }

  themeButtonInstanceDecl(decl, { background: 'var(--Base-orange-O500, #FB5B0A)', 'border-radius': '6px', padding: '6px 12px' })

  assert.deepEqual(decl, {}, 'aliased/reformatted values are theme-carried — no false var overrides, hover stays alive')
})

test('regression: a genuinely different color still produces the delta after normalization', () => {
  const decl: Record<string, string> = { background: 'var(--Brand-blue, #0055FF)' }

  themeButtonInstanceDecl(decl, { background: 'var(--Base-orange-O500, #FB5B0A)' })

  assert.equal(decl['--bs-btn-bg'], 'var(--Brand-blue, #0055FF)', 'the instance keeps ITS token reference in the override')
})
