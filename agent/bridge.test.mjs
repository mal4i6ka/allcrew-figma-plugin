/*
 * Bridge — the pure halves of the REST fallback.
 *
 * The network parts are Figma's; what is ours is the decision of WHEN to go to REST, which
 * file it is about, and what a REST answer looks like next to the plugin's. Those are the
 * parts that can lie silently: a call that quietly goes to REST and comes back without token
 * names looks like an answer and is half of one.
 *
 * Importing the bridge must not start a server — the running bridge owns that port.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.ALLCREW_CHANNEL_AGENT_SECRET = process.env.ALLCREW_CHANNEL_AGENT_SECRET || 'test-secret'

const { fileKeyOf, wantsRest, restNodeSummary, restWalk, REST_OPS, REST_REFUSALS } = await import('./bridge.mjs')

test('a file key is taken from whatever the caller typed', () => {
  assert.equal(fileKeyOf('SVXDZrXVVyh7PtEicpsbVD'), 'SVXDZrXVVyh7PtEicpsbVD')
  assert.equal(fileKeyOf('rest:SVXDZrXVVyh7PtEicpsbVD'), 'SVXDZrXVVyh7PtEicpsbVD')
  assert.equal(
    fileKeyOf('https://www.figma.com/design/SVXDZrXVVyh7PtEicpsbVD/New-Website?node-id=1-2'),
    'SVXDZrXVVyh7PtEicpsbVD'
  )
  assert.equal(fileKeyOf('new-website-django'), '', 'a plugin handle is not a file key')
  assert.equal(fileKeyOf(''), '')
})

test('REST is for when the caller asked for it, or when nothing is open', () => {
  assert.equal(wantsRest({ fileKey: 'SVXDZrXVVyh7PtEicpsbVD' }, true), true, 'an explicit key wins over an open plugin')
  assert.equal(
    wantsRest({ params: { fileKey: 'SVXDZrXVVyh7PtEicpsbVD' } }, true),
    true,
    'an op-level fileKey follows the same REST rule as an envelope-level one'
  )
  assert.equal(wantsRest({ target: 'rest:SVXDZrXVVyh7PtEicpsbVD' }, true), true)
  assert.equal(wantsRest({ target: 'new-website-django' }, true), false, 'an open plugin answers for its own file')
  // With nothing open and no default key configured there is nothing to fall back to — the
  // caller gets the roster error, which says to open the plugin.
  assert.equal(wantsRest({}, false), false)
})

test('every op REST answers is a read, and every refusal says what it needs instead', () => {
  for (const name of REST_OPS) assert.ok(!REST_REFUSALS[name], `${name} is both offered and refused`)
  for (const [name, reason] of Object.entries(REST_REFUSALS)) {
    assert.ok(reason.length > 20, `${name} is refused without a reason worth reading`)
  }
  // The three that matter most: tokens, the neutral tree and the panel's own commands. A
  // future refactor that quietly drops one of these from the refusals would leave an agent
  // believing REST can do it.
  for (const name of ['variables.get', 'design.ir', 'plugin.call']) {
    assert.ok(REST_REFUSALS[name], `${name} must be refused by name, not by an empty answer`)
  }
})

test('a REST node reads like the plugin’s node.get, minus what REST does not carry', () => {
  const summary = restNodeSummary({
    id: '1:2',
    name: 'Card',
    type: 'FRAME',
    absoluteBoundingBox: { width: 416.4, height: 240 },
    layoutMode: 'VERTICAL',
    itemSpacing: 16,
    paddingTop: 24,
    paddingRight: 24,
    paddingBottom: 24,
    paddingLeft: 24,
    primaryAxisAlignItems: 'MIN',
    counterAxisAlignItems: 'CENTER',
    children: [{ id: '1:3', name: 'Title', type: 'TEXT' }],
  })

  assert.deepEqual(summary, {
    id: '1:2',
    name: 'Card',
    type: 'FRAME',
    width: 416,
    height: 240,
    layout: {
      mode: 'VERTICAL',
      itemSpacing: 16,
      padding: [24, 24, 24, 24],
      primaryAxisAlign: 'MIN',
      counterAxisAlign: 'CENTER',
    },
    childCount: 1,
    children: [{ id: '1:3', name: 'Title', type: 'TEXT' }],
  })
  assert.ok(!('bindings' in summary), 'REST has no variable bindings — the absence is the point')
})

test('a node without auto-layout does not pretend to have one', () => {
  const summary = restNodeSummary({ id: '1:9', name: 'Vector', type: 'VECTOR', layoutMode: 'NONE' })

  assert.equal(summary.layout, undefined)
  assert.equal(summary.childCount, 0)
})

test('the walk visits the whole tree REST hands over at once', () => {
  const seen = []
  restWalk(
    { id: '0:1', name: 'Page', children: [{ id: '1:1', name: 'A', children: [{ id: '1:2', name: 'B' }] }] },
    (node) => seen.push(node.name)
  )

  assert.deepEqual(seen, ['Page', 'A', 'B'])
})

/* ------------------------------------------------------------ REST derivations */

const { REST_BEZIER_PRESETS, restCurve, restTransition, restEdges, restTextRuns, restVariantValues, restComponentSignature } =
  await import('./bridge.mjs')
const { BEZIER_PRESETS } = await import('../src/targets/django/easing/index.ts')

test('the bridge’s preset table is the plugin’s, not a fork of it', () => {
  // `bridge.mjs` ships alone and cannot import the plugin's source, so the table is copied —
  // this is the assertion that keeps a copy from drifting into a second opinion.
  assert.deepEqual(REST_BEZIER_PRESETS, BEZIER_PRESETS)
})

test('an easing REST can name comes back as numbers; a spring says it cannot', () => {
  assert.deepEqual(restCurve({ type: 'EASE_OUT' }), { kind: 'bezier', x1: 0, y1: 0, x2: 0.58, y2: 1, preset: 'EASE_OUT' })
  assert.deepEqual(restCurve({ type: 'LINEAR' }), { kind: 'linear' })
  assert.deepEqual(
    restCurve({ type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 } }),
    { kind: 'bezier', x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 }
  )
  // Handing back `linear` for a spring would be a wrong answer wearing the right shape.
  assert.equal(restCurve({ type: 'GENTLE' }), null)
  const spring = restTransition({ type: 'SMART_ANIMATE', duration: 0.3, easing: { type: 'GENTLE' } })
  assert.equal(spring.curve, undefined)
  assert.match(spring.curveUnavailable, /plugin solves it/)
})

test('a REST prototype edge carries what the plugin’s does: kind, timing, curve', () => {
  const page = {
    id: '0:1',
    name: 'Page 1',
    children: [
      { id: '2:1', name: 'Sheet', type: 'FRAME', children: [] },
      {
        id: '1:9',
        name: 'Open sheet',
        type: 'INSTANCE',
        children: [],
        interactions: [
          {
            trigger: { type: 'ON_CLICK' },
            actions: [
              {
                type: 'NODE',
                destinationId: '2:1',
                navigation: 'NAVIGATE',
                transition: { type: 'PUSH', direction: 'RIGHT', duration: 0.3, easing: { type: 'EASE_OUT' } },
              },
            ],
          },
        ],
      },
    ],
  }

  assert.deepEqual(restEdges(page), [
    {
      from: '1:9',
      fromName: 'Open sheet',
      to: '2:1',
      toName: 'Sheet',
      trigger: 'ON_CLICK',
      action: 'NODE',
      navigation: 'NAVIGATE',
      transition: {
        type: 'PUSH_RIGHT',
        duration: 0.3,
        easing: 'EASE_OUT',
        curve: { kind: 'bezier', x1: 0, y1: 0, x2: 0.58, y2: 1, preset: 'EASE_OUT' },
      },
    },
  ])
})

test('a file written by an older editor still has a graph', () => {
  // Figma keeps filling the legacy triple in beside `interactions`; a file that has only it
  // used to read as a prototype with no edges at all.
  const page = {
    id: '0:1',
    name: 'Page 1',
    children: [
      { id: '2:1', name: 'Next', type: 'FRAME', children: [] },
      { id: '1:9', name: 'Button', type: 'FRAME', children: [], transitionNodeID: '2:1', transitionDuration: 300, transitionEasing: 'EASE_IN' },
    ],
  }
  const edges = restEdges(page)

  assert.equal(edges.length, 1)
  assert.equal(edges[0].to, '2:1')
  // Milliseconds there, seconds in the modern field — reporting 300 seconds would be absurd and
  // is exactly what a naive read does.
  assert.equal(edges[0].transition.duration, 0.3)
})

test('styled runs are rebuilt from the per-character table REST splits them into', () => {
  const node = {
    characters: 'Pay now',
    // 0 is the node's own style; 3 is an override that starts at "now".
    characterStyleOverrides: [0, 0, 0, 0, 3, 3, 3],
    styleOverrideTable: { 3: { fontWeight: 700 } },
  }

  assert.deepEqual(restTextRuns(node), [
    { start: 0, end: 4, characters: 'Pay ' },
    { start: 4, end: 7, characters: 'now', style: { fontWeight: 700 } },
  ])
})

test('a uniform text node is one run, not one per character', () => {
  assert.deepEqual(restTextRuns({ characters: 'Prev', characterStyleOverrides: [], styleOverrideTable: {} }), [
    { start: 0, end: 4, characters: 'Prev' },
  ])
  assert.deepEqual(restTextRuns({ characters: '' }), [])
})

test('a variant member name splits into its axis values', () => {
  // The Button set's default member, node 819:95512's first child (819:95513) - the only shape
  // REST's node payload puts the combination in, since it never carries `variantProperties`.
  assert.deepEqual(restVariantValues('Type=Primary, Size=Large, State=Standart'), {
    Type: 'Primary',
    Size: 'Large',
    State: 'Standart',
  })
  // A name with no `=` names no axis - dropped rather than guessed at.
  assert.deepEqual(restVariantValues('Icon'), {})
  assert.deepEqual(restVariantValues(''), {})
})

test('the REST signature isolates each option the way the plugin does, minus changes and targets', () => {
  // A trimmed copy of the Button set's own componentPropertyDefinitions (node 819:95512,
  // verified live) and enough of its 27 members to isolate every option on every axis.
  const definitions = {
    Type: { type: 'VARIANT', defaultValue: 'Primary', variantOptions: ['Primary', 'Secondary', 'Tertiary'] },
    Size: { type: 'VARIANT', defaultValue: 'Large', variantOptions: ['Large', 'Meduim', 'Small'] },
    'Right Icon#198:4': { type: 'BOOLEAN', defaultValue: true },
    'Button-lable#1956:6': { type: 'TEXT', defaultValue: 'Button' },
  }
  const names = {
    '819:95513': 'Type=Primary, Size=Large',
    '819:95517': 'Type=Secondary, Size=Large',
    '819:95540': 'Type=Tertiary, Size=Large',
    '819:95563': 'Type=Primary, Size=Meduim',
    '819:95613': 'Type=Primary, Size=Small',
  }
  const members = Object.entries(names).map(([id, name]) => ({ id, name, values: restVariantValues(name) }))

  const signature = restComponentSignature(members, definitions)

  assert.deepEqual(signature.defaultVariant, { id: '819:95513', name: 'Type=Primary, Size=Large' })
  assert.deepEqual(signature.axes[0], {
    name: 'Type',
    default: 'Primary',
    options: [
      { value: 'Primary', isDefault: true, variantId: '819:95513', variantName: 'Type=Primary, Size=Large' },
      { value: 'Secondary', variantId: '819:95517', variantName: 'Type=Secondary, Size=Large' },
      { value: 'Tertiary', variantId: '819:95540', variantName: 'Type=Tertiary, Size=Large' },
    ],
  })
  // Neither option carries `changes` - that needs getCSSAsync, which REST cannot run.
  assert.ok(signature.axes.every((axis) => axis.options.every((option) => !('changes' in option))))
  // Both properties are declared, but neither carries `targets` - REST has no
  // componentPropertyReferences to read the wiring off.
  assert.deepEqual(signature.properties, [
    { name: 'Right Icon#198:4', type: 'BOOLEAN', defaultValue: true },
    { name: 'Button-lable#1956:6', type: 'TEXT', defaultValue: 'Button' },
  ])
  assert.equal(
    signature.note,
    'REST gives the declared signature, not the behaviour: no option carries `changes`, the CSS delta against ' +
      'the default variant — that needs getCSSAsync, which only runs inside the plugin; no property carries ' +
      '`targets` — REST never serves componentPropertyReferences, the map from a property to the layer it ' +
      'drives. Open the plugin for those.'
  )
})

test('a set with no componentPropertyDefinitions in the REST payload falls back to names, with no default', () => {
  const members = ['Color=Red, Density=Compact', 'Color=Blue, Density=Compact', 'Color=Red, Density=Roomy'].map(
    (name, index) => ({ id: `9:${index}`, name, values: restVariantValues(name) })
  )

  const signature = restComponentSignature(members, null)

  const colorAxis = signature.axes.find((axis) => axis.name === 'Color')
  // No `default` key at all - a set genuinely without a known default over REST must not answer
  // `default: ''`, which would read as a real (empty-string) default value.
  assert.ok(!('default' in colorAxis))
  assert.deepEqual(
    colorAxis.options.map((option) => option.value),
    ['Red', 'Blue']
  )
  // No option isolates a variant id either - isolating one needs knowing every OTHER axis's
  // default, which is exactly what is missing here.
  assert.ok(colorAxis.options.every((option) => !('isDefault' in option) && !('variantId' in option)))
  assert.equal(signature.defaultVariant, undefined)
  assert.match(signature.note, /componentPropertyDefinitions in the REST payload/)
})

test('a node with no component properties over REST says so plainly', () => {
  const signature = restComponentSignature([], {})
  assert.deepEqual(signature.axes, [])
  assert.deepEqual(signature.properties, [])
  assert.equal(signature.note, 'this node declares no component properties over REST.')
})

test('the bridge does not promise a window its own clients cannot wait', async () => {
  // Node's fetch drops a request after five minutes with a bare "fetch failed"; a ceiling past
  // that is a promise nobody can collect on, and a token sync spent twenty minutes proving it.
  const { CLIENT_CEILING_MS } = await import('./bridge.mjs')
  assert.equal(CLIENT_CEILING_MS, 300_000)
})
