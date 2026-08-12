import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTokenModel, classifyRole, detectComponentBlocks, buildTokenEntries } from './model.ts'
import type { TokenTree, TokenValue, W3CToken } from '../../tokens/engine.ts'

function token(value: TokenValue, type: string, modes: Record<string, TokenValue> = {}): W3CToken {
  return { $type: type, $value: value, $extensions: { modes, figma: { collection: 'Colors', defaultMode: 'Light' } } }
}

test('classifyRole maps name keywords onto the CSS property that owns them', () => {
  assert.equal(classifyRole('color-surface-card', 'color'), 'surface')
  assert.equal(classifyRole('color-text-primary', 'color'), 'text')
  assert.equal(classifyRole('color-border-subtle', 'color'), 'border')
  assert.equal(classifyRole('color-icon-muted', 'color'), 'icon')
  assert.equal(classifyRole('spacing-md', 'number'), 'spacing')
  assert.equal(classifyRole('radius-lg', 'number'), 'radius')
  assert.equal(classifyRole('breakpoints-desktop', 'number'), 'breakpoint')
})

test('classifyRole reads a typography axis before the generic buckets', () => {
  // "text-size" must not read as a text COLOR, and "font-weight" not as a size.
  assert.equal(classifyRole('text-size-lg', 'number'), 'font-size')
  assert.equal(classifyRole('typography-body-md-font-weight', 'number'), 'font-weight')
  assert.equal(classifyRole('typography-body-md-line-height', 'number'), 'line-height')
})

test('classifyRole falls back to the resolved type when the name carries no role', () => {
  assert.equal(classifyRole('brand-blue-500', 'color'), 'color')
  assert.equal(classifyRole('feature-flag-x', 'boolean'), 'flag')
  assert.equal(classifyRole('mystery', 'string'), 'other')
})

test('buildTokenEntries emits the CSS var, the tokens.ts accessor and per-theme values', () => {
  const tree: TokenTree = {
    color: {
      surface: {
        card: token('#ffffff', 'color', { Light: '#ffffff', Dark: '#101010' }),
      },
      'brand color': {
        primary: token('#3b82f6', 'color', { Light: '#3b82f6', Dark: '#3b82f6' }),
      },
    },
  }

  const entries = buildTokenEntries(tree, ['Light', 'Dark'], 'Light')
  const card = entries.find((entry) => entry.slug === 'color-surface-card')!
  assert.equal(card.cssRef, 'var(--color-surface-card)')
  assert.equal(card.tsAccessor, 'tokens.color.surface.card')
  assert.equal(card.value, '#ffffff')
  assert.deepEqual(card.themeValues, { Light: '#ffffff', Dark: '#101010' })
  assert.equal(card.themed, true)

  // A segment that isn't a JS identifier must use bracket access, or the snippet won't compile.
  const brand = entries.find((entry) => entry.slug === 'color-brand-color-primary')!
  assert.equal(brand.tsAccessor, 'tokens.color["brand color"].primary')
  assert.equal(brand.themed, false)
})

test('detectComponentBlocks groups tokens by context when a prefix covers several roles', () => {
  const tree: TokenTree = {
    color: {
      button: {
        primary: {
          bg: token('#3b82f6', 'color'),
          text: token('#ffffff', 'color'),
          border: token('#2563eb', 'color'),
        },
      },
      palette: {
        blue: { 500: token('#3b82f6', 'color'), 600: token('#2563eb', 'color') },
      },
    },
  }

  const blocks = detectComponentBlocks(buildTokenEntries(tree, ['Light'], 'Light'))
  const button = blocks.find((block) => block.prefix.join('/') === 'color/button')
  assert.ok(button, 'the button group is a component block')
  assert.equal(button!.name, 'Button')
  // Variants roll up under the component instead of becoming their own top-level blocks.
  assert.deepEqual(button!.variants.map((variant) => variant.name), ['Primary'])
  assert.equal(button!.entryCount, 3)
  // A same-role ramp is not a component — grouping it would be noise, not context.
  assert.equal(blocks.some((block) => block.prefix.join('/') === 'color/palette/blue'), false)
})

test('buildTokenModel reports duplicate color values so tokens get picked by role', () => {
  const tree: TokenTree = {
    color: {
      text: { primary: token('#111111', 'color') },
      icon: { default: token('#111111', 'color') },
    },
  }
  const model = buildTokenModel(tree, ['Light'], 'Light')
  assert.deepEqual(model.duplicateColors, [{ value: '#111111', slugs: ['color-text-primary', 'color-icon-default'] }])
})
