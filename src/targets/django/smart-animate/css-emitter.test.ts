import test from 'node:test'
import assert from 'node:assert/strict'
import { emitTransitionCss } from './css-emitter.ts'
import type { StateDiff } from './diff-properties.ts'

function pathToSelector(path: string): string {
  return path === '' ? '' : ` [data-path="${path}"]`
}

test('emitTransitionCss lists only the properties that changed on the base transition (never "all")', () => {
  const diff: StateDiff = {
    pairs: [{ path: 'root', changes: [{ prop: 'opacity', from: 1, to: 0.5 }] }],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.btn',
    diff,
    pathToSelector,
    durationMs: 300,
    timingFunction: 'ease-out',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.match(result.css, /transition:\s*\n\s*opacity 300ms ease-out;/)
  assert.ok(!result.css.includes('transition: all'))
  assert.equal(result.js, undefined)
})

test('emitTransitionCss merges x and y changes into one translate declaration (not two clobbering ones)', () => {
  const diff: StateDiff = {
    pairs: [
      {
        path: 'root',
        changes: [
          { prop: 'x', from: 0, to: 10 },
          { prop: 'y', from: 0, to: -5 },
        ],
      },
    ],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.btn',
    diff,
    pathToSelector,
    durationMs: 300,
    timingFunction: 'ease-out',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  const translateDeclarations = result.css.match(/translate: [^;]+;/g) ?? []
  assert.equal(translateDeclarations.length, 1)
  assert.equal(translateDeclarations[0], 'translate: 10px -5px;')
})

test('emitTransitionCss uses a :hover selector with no JS for a css-pseudo-class mechanism', () => {
  const diff: StateDiff = { pairs: [{ path: 'root', changes: [{ prop: 'opacity', from: 1, to: 0.8 }] }], fadeOut: [], fadeIn: [] }

  const result = emitTransitionCss({
    baseSelector: '.btn',
    diff,
    pathToSelector,
    durationMs: 200,
    timingFunction: 'linear',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.ok(result.css.includes('.btn:hover'))
  assert.equal(result.js, undefined)
})

test('emitTransitionCss emits a click-toggle class selector + JS for a toggle-class mechanism', () => {
  const diff: StateDiff = { pairs: [{ path: 'root', changes: [{ prop: 'opacity', from: 1, to: 0.8 }] }], fadeOut: [], fadeIn: [] }

  const result = emitTransitionCss({
    baseSelector: '.btn',
    diff,
    pathToSelector,
    durationMs: 200,
    timingFunction: 'linear',
    mechanism: { kind: 'toggle-class', event: 'click' },
  })

  assert.ok(result.css.includes('.btn.is-active'))
  assert.ok(result.js?.includes("addEventListener('click'"))
  assert.ok(result.js?.includes('classList.toggle'))
})

test('emitTransitionCss emits a setTimeout snippet for a timeout mechanism', () => {
  const diff: StateDiff = { pairs: [{ path: 'root', changes: [{ prop: 'opacity', from: 0, to: 1 }] }], fadeOut: [], fadeIn: [] }

  const result = emitTransitionCss({
    baseSelector: '.toast',
    diff,
    pathToSelector,
    durationMs: 300,
    timingFunction: 'ease',
    mechanism: { kind: 'timeout', timeoutMs: 1500 },
  })

  assert.ok(result.js?.includes('setTimeout'))
  assert.ok(result.js?.includes('1500'))
})

test('emitTransitionCss scopes each transition declaration to the selector that actually changes (descendants included, not just baseSelector)', () => {
  const diff: StateDiff = {
    pairs: [
      { path: 'Icon#0', changes: [{ prop: 'opacity', from: 1, to: 0.5 }] },
      { path: 'Label#0', changes: [{ prop: 'x', from: 0, to: 8 }] },
    ],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.card',
    diff,
    pathToSelector,
    durationMs: 300,
    timingFunction: 'ease-out',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.match(result.css, /\.card \[data-path="Icon#0"\] \{\s*\n\s*transition:\s*\n\s*opacity 300ms ease-out;\s*\n\}/)
  assert.match(result.css, /\.card \[data-path="Label#0"\] \{\s*\n\s*transition:\s*\n\s*translate 300ms ease-out;\s*\n\}/)
  assert.ok(!result.css.includes('.card {\n  transition:'))
})

test('emitTransitionCss emits fade-in (0 -> 1) and fade-out (-> 0) opacity rules for added/removed nodes', () => {
  const diff: StateDiff = { pairs: [], fadeOut: ['Badge#0'], fadeIn: ['Spinner#0'] }

  const result = emitTransitionCss({
    baseSelector: '.card',
    diff,
    pathToSelector,
    durationMs: 250,
    timingFunction: 'ease',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.ok(result.css.includes('.card:hover [data-path="Badge#0"] { opacity: 0; }'))
  assert.ok(result.css.includes('.card [data-path="Spinner#0"] { opacity: 0; }'))
  assert.ok(result.css.includes('.card:hover [data-path="Spinner#0"] { opacity: 1; }'))
  assert.match(result.css, /transition:\s*\n\s*opacity 250ms ease;/)
})

test('emitTransitionCss emits border-color/border-width for a stroke change, in both the rule and the transition list', () => {
  const diff: StateDiff = {
    pairs: [
      {
        path: 'root',
        changes: [
          { prop: 'strokeColor', from: { r: 0, g: 0, b: 0, a: 1 }, to: { r: 1, g: 1, b: 1, a: 1 } },
          { prop: 'strokeWeight', from: 1, to: 3 },
        ],
      },
    ],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.btn',
    diff,
    pathToSelector,
    durationMs: 200,
    timingFunction: 'ease',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.ok(result.css.includes('border-color: rgba(255, 255, 255, 1);'))
  assert.ok(result.css.includes('border-width: 3px;'))
  assert.match(result.css, /transition:\s*\n\s*border-color 200ms ease,\n\s*border-width 200ms ease;/)
})

test('emitTransitionCss renders a gradient background as a real linear-gradient, excluded from the transition list', () => {
  const diff: StateDiff = {
    pairs: [
      {
        path: 'root',
        changes: [
          {
            prop: 'background',
            from: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
            to: [
              {
                type: 'GRADIENT_LINEAR',
                gradientStops: [
                  { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
                  { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
                ],
                gradientTransform: [[1, 0, 0], [0, 1, 0]],
              },
            ],
            interpolable: false,
          },
        ],
      },
    ],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.card',
    diff,
    pathToSelector,
    durationMs: 200,
    timingFunction: 'ease',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.ok(result.css.includes('background-image: linear-gradient(90deg, rgba(255, 0, 0, 1) 0%, rgba(0, 0, 255, 1) 100%);'))
  assert.ok(!/transition:[^;]*background-image/.test(result.css))
})

test('emitTransitionCss builds an ::after cross-fade overlay for an image-fill swap when a resolver is given, sized per scaleMode', () => {
  const diff: StateDiff = {
    pairs: [
      {
        path: 'root',
        changes: [
          {
            prop: 'background',
            from: [{ type: 'IMAGE', imageHash: 'old-fill', scaleMode: 'FILL' }],
            to: [{ type: 'IMAGE', imageHash: 'hash-fill', scaleMode: 'FILL' }],
            interpolable: false,
            images: [{ imageHash: 'hash-fill', scaleMode: 'FILL' }],
          },
        ],
      },
      {
        path: 'Photo#0',
        changes: [
          {
            prop: 'background',
            from: [{ type: 'IMAGE', imageHash: 'old-fit', scaleMode: 'FIT' }],
            to: [{ type: 'IMAGE', imageHash: 'hash-fit', scaleMode: 'FIT' }],
            interpolable: false,
            images: [{ imageHash: 'hash-fit', scaleMode: 'FIT' }],
          },
        ],
      },
    ],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.card',
    diff,
    pathToSelector,
    durationMs: 400,
    timingFunction: 'ease-in-out',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
    imageUrlFor: (hash) => `${hash}.jpg`,
  })

  assert.match(result.css, /\.card \[data-path="root"\]::after \{/)
  assert.ok(result.css.includes('background-image: url(hash-fill.jpg);'))
  assert.ok(result.css.includes('background-size: cover;'))
  assert.ok(result.css.includes('transition: opacity 400ms ease-in-out;'))
  assert.ok(result.css.includes('.card:hover [data-path="root"]::after {\n  opacity: 1;\n}'))

  assert.match(result.css, /\.card \[data-path="Photo#0"\]::after \{/)
  assert.ok(result.css.includes('background-image: url(hash-fit.jpg);'))
  assert.ok(result.css.includes('background-size: contain;'))
  assert.ok(result.css.includes('.card:hover [data-path="Photo#0"]::after {\n  opacity: 1;\n}'))

  // The overlay's own inline `transition:` must not also land in the host element's
  // consolidated `transition:` list — `background` produces no interpolable declaration.
  assert.ok(!result.css.includes('.card [data-path="root"] {\n  transition:'))
})

test('emitTransitionCss emits no ::after overlay and no url() for an image-fill swap without a resolver', () => {
  const diff: StateDiff = {
    pairs: [
      {
        path: 'root',
        changes: [
          {
            prop: 'background',
            from: [{ type: 'IMAGE', imageHash: 'old-fill', scaleMode: 'FILL' }],
            to: [{ type: 'IMAGE', imageHash: 'hash-fill', scaleMode: 'FILL' }],
            interpolable: false,
            images: [{ imageHash: 'hash-fill', scaleMode: 'FILL' }],
          },
        ],
      },
    ],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.card',
    diff,
    pathToSelector,
    durationMs: 400,
    timingFunction: 'ease-in-out',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.ok(!result.css.includes('::after'))
  assert.ok(!result.css.includes('url('))
  assert.equal(result.css, '')
})

test('emitTransitionCss keeps the non-interpolable linear-gradient path (no ::after overlay) even when a resolver is supplied', () => {
  const diff: StateDiff = {
    pairs: [
      {
        path: 'root',
        changes: [
          {
            prop: 'background',
            from: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
            to: [
              {
                type: 'GRADIENT_LINEAR',
                gradientStops: [
                  { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
                  { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
                ],
                gradientTransform: [[1, 0, 0], [0, 1, 0]],
              },
            ],
            interpolable: false,
            images: [],
          },
        ],
      },
    ],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.card',
    diff,
    pathToSelector,
    durationMs: 200,
    timingFunction: 'ease',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
    imageUrlFor: (hash) => `${hash}.jpg`,
  })

  assert.ok(result.css.includes('background-image: linear-gradient(90deg, rgba(255, 0, 0, 1) 0%, rgba(0, 0, 255, 1) 100%);'))
  assert.ok(!result.css.includes('::after'))
})

test('emitTransitionCss emits box-shadow for a composed drop shadow change', () => {
  const diff: StateDiff = {
    pairs: [
      {
        path: 'root',
        changes: [
          {
            prop: 'boxShadow',
            from: [],
            to: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.5 }, offsetX: 0, offsetY: 4, radius: 8, spread: 0 }],
          },
        ],
      },
    ],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.card',
    diff,
    pathToSelector,
    durationMs: 200,
    timingFunction: 'ease',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.ok(result.css.includes('box-shadow: 0px 4px 8px 0px rgba(0, 0, 0, 0.5);'))
  assert.match(result.css, /transition:\s*\n\s*box-shadow 200ms ease;/)
})

test('emitTransitionCss emits filter: blur() for a layer blur change', () => {
  const diff: StateDiff = { pairs: [{ path: 'root', changes: [{ prop: 'layerBlur', from: [0], to: [12] }] }], fadeOut: [], fadeIn: [] }

  const result = emitTransitionCss({
    baseSelector: '.card',
    diff,
    pathToSelector,
    durationMs: 200,
    timingFunction: 'ease',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.ok(result.css.includes('filter: blur(12px);'))
})

test('emitTransitionCss emits font-size and color for a text style change', () => {
  const diff: StateDiff = {
    pairs: [
      {
        path: 'root',
        changes: [
          { prop: 'fontSize', from: 14, to: 20 },
          { prop: 'textColor', from: { r: 0, g: 0, b: 0, a: 1 }, to: { r: 1, g: 1, b: 1, a: 1 } },
        ],
      },
    ],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.label',
    diff,
    pathToSelector,
    durationMs: 200,
    timingFunction: 'ease',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.ok(result.css.includes('font-size: 20px;'))
  assert.ok(result.css.includes('color: rgba(255, 255, 255, 1);'))
})

test('emitTransitionCss emits padding and gap for an auto-layout spacing change', () => {
  const diff: StateDiff = {
    pairs: [
      {
        path: 'root',
        changes: [
          { prop: 'padding', from: [8, 8, 8, 8], to: [16, 16, 16, 16] },
          { prop: 'gap', from: 4, to: 12 },
        ],
      },
    ],
    fadeOut: [],
    fadeIn: [],
  }

  const result = emitTransitionCss({
    baseSelector: '.stack',
    diff,
    pathToSelector,
    durationMs: 200,
    timingFunction: 'ease',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.ok(result.css.includes('padding: 16px 16px 16px 16px;'))
  assert.ok(result.css.includes('gap: 12px;'))
})

test('emitTransitionCss fades a hidden layer via visibility/opacity/pointer-events, pairing visibility with allow-discrete', () => {
  const diff: StateDiff = { pairs: [{ path: 'root', changes: [{ prop: 'visible', from: true, to: false }] }], fadeOut: [], fadeIn: [] }

  const result = emitTransitionCss({
    baseSelector: '.tooltip',
    diff,
    pathToSelector,
    durationMs: 200,
    timingFunction: 'ease',
    mechanism: { kind: 'css-pseudo-class', pseudoClass: 'hover' },
  })

  assert.ok(result.css.includes('visibility: hidden;'))
  assert.ok(result.css.includes('opacity: 0;'))
  assert.ok(result.css.includes('pointer-events: none;'))
  assert.match(result.css, /transition:\s*\n\s*visibility 200ms ease allow-discrete,\n\s*opacity 200ms ease;/)
})
