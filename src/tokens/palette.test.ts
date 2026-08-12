import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hexToOklch } from './color.ts'
import {
  DEFAULT_PALETTE_SETTINGS,
  DEFAULT_STEPS,
  applyPaletteFix,
  autoHueTorsion,
  derivePrefixes,
  generatePalette,
  hueName,
  suggestHarmoniousSpectrum,
  themeRoles,
  type PaletteFix,
  type PaletteSettings,
  type SpectrumSpec,
} from './palette.ts'

const settings = (over: Partial<PaletteSettings> = {}): PaletteSettings => ({
  ...DEFAULT_PALETTE_SETTINGS,
  ...over,
})

const spectrum = (over: Partial<SpectrumSpec> = {}): SpectrumSpec => ({
  id: 'orange',
  label: 'Orange',
  prefix: 'O',
  keyHex: '#FB5B0A',
  anchorStep: 500,
  ...over,
})

const only = (spec: SpectrumSpec, over: Partial<PaletteSettings> = {}) =>
  generatePalette(settings({ ...over, spectra: [spec] })).spectra[0]

test('the key color survives generation untouched at its anchor step', () => {
  for (const anchorStep of [50, 300, 500, 900]) {
    const ramp = only(spectrum({ anchorStep }))
    const main = ramp.swatches.find((s) => s.isMain)!
    assert.equal(main.step, anchorStep)
    assert.equal(main.hex, '#FB5B0A', `key drifted when anchored at ${anchorStep}`)
  }
})

test('the key survives in mix mode too', () => {
  const ramp = only(spectrum({ anchorStep: 600 }), { formula: 'mix' })
  assert.equal(ramp.swatches.find((s) => s.isMain)!.hex, '#FB5B0A')
})

test('lightness falls monotonically across the ramp', () => {
  for (const formula of ['oklch', 'mix'] as const) {
    const ramp = only(spectrum(), { formula })
    const lightness = ramp.swatches.map((s) => hexToOklch(s.hex)!.l)
    for (let i = 1; i < lightness.length; i++) {
      assert.ok(lightness[i] < lightness[i - 1], `${formula}: step ${ramp.swatches[i].name} was not darker`)
    }
  }
})

test('spectra share the ladder endpoints, so ramps of different hues stay interchangeable', () => {
  const palette = generatePalette(
    settings({
      spectra: [
        spectrum({ id: 'orange', label: 'Orange', keyHex: '#FB5B0A', anchorStep: 500 }),
        spectrum({ id: 'blue', label: 'Blue', prefix: 'B', keyHex: '#2364AA', anchorStep: 500 }),
      ],
    })
  )
  const [orange, blue] = palette.spectra
  const lightnessOf = (hex: string) => hexToOklch(hex)!.l
  assert.ok(Math.abs(lightnessOf(orange.swatches[0].hex) - lightnessOf(blue.swatches[0].hex)) < 0.01)
  const last = orange.swatches.length - 1
  assert.ok(Math.abs(lightnessOf(orange.swatches[last].hex) - lightnessOf(blue.swatches[last].hex)) < 0.01)
})

test('two keys that already sit on the ladder produce step-for-step matched lightness', () => {
  // Both keys are near the ladder's L at step 500, so no warping should be needed and every
  // step should line up — the property a light/dark theme swap depends on.
  const palette = generatePalette(
    settings({
      spectra: [
        spectrum({ id: 'a', label: 'Aqua', keyHex: '#00807A', anchorStep: 500 }),
        spectrum({ id: 'b', label: 'Blue', prefix: 'B', keyHex: '#2364AA', anchorStep: 500 }),
      ],
    })
  )
  const [a, b] = palette.spectra
  for (let i = 0; i < a.swatches.length; i++) {
    const delta = Math.abs(hexToOklch(a.swatches[i].hex)!.l - hexToOklch(b.swatches[i].hex)!.l)
    assert.ok(delta < 0.06, `step ${a.swatches[i].step} drifted by ${delta}`)
  }
})

test('a neutral ramp runs from pure white to pure black', () => {
  const ramp = only(spectrum({ id: 'n', label: 'Neutral', prefix: 'N', keyHex: '#8A8A8A', neutral: true }))
  assert.equal(ramp.swatches.length, 12)
  assert.equal(ramp.swatches[0].name, 'N0')
  assert.equal(ramp.swatches[0].hex, '#FFFFFF')
  assert.equal(ramp.swatches[11].name, 'N1000')
  assert.equal(ramp.swatches[11].hex, '#000000')
})

test('neutral endpoints stay pure in mix mode as well', () => {
  const ramp = only(
    spectrum({ id: 'n', label: 'Neutral', prefix: 'N', keyHex: '#8A8A8A', neutral: true }),
    { formula: 'mix' }
  )
  assert.equal(ramp.swatches[0].hex, '#FFFFFF')
  assert.equal(ramp.swatches[ramp.swatches.length - 1].hex, '#000000')
})

test('Light and Dark land two steps out from Main, matching the reference board', () => {
  const ramp = only(spectrum({ anchorStep: 500 }))
  assert.equal(ramp.swatches.find((s) => s.isLight)!.step, 300)
  assert.equal(ramp.swatches.find((s) => s.isMain)!.step, 500)
  assert.equal(ramp.swatches.find((s) => s.isDark)!.step, 700)
})

test('a mark that runs off the end is dropped, not clamped onto Main', () => {
  const ramp = only(spectrum({ id: 'n', label: 'Neutral', prefix: 'N', neutral: true, keyHex: '#000000', anchorStep: 1000 }))
  assert.equal(ramp.swatches.find((s) => s.isMain)!.step, 1000)
  assert.equal(ramp.swatches.find((s) => s.isLight)!.step, 800)
  assert.equal(ramp.swatches.find((s) => s.isDark), undefined)
})

test('explicit Light and Dark steps win over the defaults', () => {
  const ramp = only(spectrum({ lightStep: 100, darkStep: 900 }))
  assert.equal(ramp.swatches.find((s) => s.isLight)!.step, 100)
  assert.equal(ramp.swatches.find((s) => s.isDark)!.step, 900)
})

test('prefixes widen until they stop colliding', () => {
  assert.deepEqual(derivePrefixes(['Orange', 'Neutral', 'Blue']), ['O', 'N', 'B'])
  assert.deepEqual(derivePrefixes(['Blue', 'Black', 'Brown']), ['B', 'BL', 'BR'])
  assert.deepEqual(derivePrefixes(['Blue', 'Blue']), ['B', 'BL'])
})

test('hue torsion turns the right way for each hue family', () => {
  assert.ok(autoHueTorsion(60) < 0, 'warm hues darken toward red')
  assert.ok(autoHueTorsion(260) > 0, 'blues darken toward purple')
  assert.ok(autoHueTorsion(150) > 0)
  assert.ok(autoHueTorsion(330) < 0)
})

test('torsion actually rotates hue across the ramp and can be switched off', () => {
  const withTorsion = only(spectrum(), { hueTorsion: 'auto' })
  const flat = only(spectrum(), { hueTorsion: 0 })
  const hueSpan = (hexes: string[]) => {
    const hues = hexes.map((hex) => hexToOklch(hex)!.h)
    return Math.abs(hues[hues.length - 1] - hues[0])
  }
  assert.ok(hueSpan(flat.swatches.slice(1, -1).map((s) => s.hex)) < 3)
  assert.ok(hueSpan(withTorsion.swatches.slice(1, -1).map((s) => s.hex)) > 3)
})

test('the ladder curve holds the light half open so a vivid key fits at 500', () => {
  // An evenly-spaced ladder puts step 500 near the midpoint between white and near-black —
  // far darker than where a brand color actually sits, so anchoring one at 500 would warp the
  // ramp. suggestedAnchorStep reads the unwarped ladder, so it shows the shape directly.
  const vivid = spectrum({ keyHex: '#FB5B0A', anchorStep: 500 })
  assert.equal(only(vivid, { lightnessCurve: 1.55 }).suggestedAnchorStep, 500)
  assert.ok(
    only(vivid, { lightnessCurve: 1 }).suggestedAnchorStep < 500,
    'an evenly-spaced ladder should want the key higher up the scale'
  )

  // And the ladder really is lighter mid-ramp — measured away from the anchor, which is
  // pinned to the key under either curve.
  const stepLightness = (curve: number, index: number) =>
    hexToOklch(only(spectrum({ keyHex: '#808080', anchorStep: 900 }), { lightnessCurve: curve }).swatches[index].hex)!.l
  assert.ok(stepLightness(1.55, 4) > stepLightness(1, 4))
})

test('the default spectra generate without a harmony warning when the key fits its step', () => {
  const palette = generatePalette(DEFAULT_PALETTE_SETTINGS)
  const orange = palette.spectra.find((s) => s.label === 'Orange')!
  const neutral = palette.spectra.find((s) => s.label === 'Neutral')!
  assert.deepEqual(orange.warnings, [])
  assert.deepEqual(neutral.warnings, [])
  assert.equal(orange.suggestedAnchorStep, 500)
})

test('chroma peaks mid-ramp and falls off at the ends', () => {
  const ramp = only(spectrum())
  const chroma = ramp.swatches.map((s) => hexToOklch(s.hex)!.c)
  const peak = chroma.indexOf(Math.max(...chroma))
  assert.ok(peak > 0 && peak < chroma.length - 1, `chroma peaked at an end (index ${peak})`)
  assert.ok(chroma[0] < chroma[peak])
  assert.ok(chroma[chroma.length - 1] < chroma[peak])
})

test('an off-ladder key is reproduced anyway, with a warning naming a better anchor', () => {
  const ramp = only(spectrum({ keyHex: '#FFE8D5', anchorStep: 900 }))
  assert.equal(ramp.swatches.find((s) => s.isMain)!.hex, '#FFE8D5')
  assert.ok(
    ramp.warnings.some((w) => w.message.includes('stretched')),
    ramp.warnings.map((w) => w.message).join(' | ')
  )
  assert.ok(ramp.suggestedAnchorStep < 900)
})

test('a bad hex degrades to gray with a warning instead of throwing', () => {
  const ramp = only(spectrum({ keyHex: 'not-a-color' }))
  assert.equal(ramp.swatches.length, 10)
  assert.ok(ramp.warnings.some((w) => w.message.includes('not a valid hex')))
})

test('an anchor missing from the scale falls back to the nearest step', () => {
  const ramp = only(spectrum({ anchorStep: 550 }))
  assert.equal(ramp.anchorStep, 500)
  assert.ok(ramp.warnings.some((w) => w.message.includes('not in the scale')))
})

test('theme roles mirror the neutral ramp and lift accents for the dark mode', () => {
  const palette = generatePalette(DEFAULT_PALETTE_SETTINGS)
  const roles = themeRoles(palette)
  const canvas = roles.find((r) => r.name === 'bg/canvas')!
  assert.equal(canvas.light, 'Neutral/N0')
  assert.equal(canvas.dark, 'Neutral/N1000')

  const text = roles.find((r) => r.name === 'text/primary')!
  assert.equal(text.light, 'Neutral/N900')
  assert.equal(text.dark, 'Neutral/N50')

  // Dark mode must reach for a lighter accent than light mode, or it loses contrast.
  const accent = roles.find((r) => r.name === 'accent/orange/base')!
  assert.equal(accent.light, 'Orange/O500')
  assert.equal(accent.dark, 'Orange/O300')
})

/* ---------------------------------------------------------------- warning fixes */

const fixOf = (spectrum: { warnings: Array<{ fix?: unknown }> }, needle: string) => {
  const warning = spectrum.warnings.find((w) => (w as { message: string }).message.includes(needle))
  assert.ok(warning, `no warning matching "${needle}"`)
  assert.ok(warning.fix, `warning "${needle}" carries no fix`)
  return warning.fix as PaletteFix
}

test('the stretched-ramp warning carries the very move it advises', () => {
  const base = settings({ spectra: [spectrum({ id: 'blue', label: 'Blue', keyHex: '#2364AA', anchorStep: 500 })] })
  const before = generatePalette(base).spectra[0]
  const fix = fixOf(before, 'stretched')
  assert.deepEqual(fix, { kind: 'anchor-step', spectrumId: 'blue', step: before.suggestedAnchorStep })

  const after = generatePalette(applyPaletteFix(base, fix)).spectra[0]
  assert.equal(after.anchorStep, before.suggestedAnchorStep)
  assert.deepEqual(after.warnings, [], 'applying the advice must clear the warning it came from')
  // The key itself is untouched — only which step it anchors to changed.
  assert.equal(after.swatches.find((s) => s.isMain)!.hex, '#2364AA')
})

test('moving Main carries explicit Light and Dark along by the same offset', () => {
  const base = settings({
    spectra: [spectrum({ id: 'o', anchorStep: 500, lightStep: 300, darkStep: 700 })],
  })
  const moved = applyPaletteFix(base, { kind: 'anchor-step', spectrumId: 'o', step: 700 })
  const spec = moved.spectra[0]
  // 500 → 700 is two steps down the scale, so 300 → 500 and 700 → 900.
  assert.equal(spec.anchorStep, 700)
  assert.equal(spec.lightStep, 500)
  assert.equal(spec.darkStep, 900)

  const ramp = generatePalette(moved).spectra[0]
  assert.equal(ramp.swatches.find((s) => s.isLight)!.step, 500)
  assert.equal(ramp.swatches.find((s) => s.isMain)!.step, 700)
  assert.equal(ramp.swatches.find((s) => s.isDark)!.step, 900)
})

test('a mark shoved off the end of the scale falls back to auto', () => {
  const base = settings({ spectra: [spectrum({ id: 'o', anchorStep: 500, lightStep: 300, darkStep: 800 })] })
  const moved = applyPaletteFix(base, { kind: 'anchor-step', spectrumId: 'o', step: 800 })
  assert.equal(moved.spectra[0].darkStep, undefined, 'no step exists three rungs past 800')
  assert.equal(moved.spectra[0].lightStep, 600)
})

test('marks left on auto stay on auto and re-derive around the new Main', () => {
  const base = settings({ spectra: [spectrum({ id: 'o', anchorStep: 500 })] })
  const moved = applyPaletteFix(base, { kind: 'anchor-step', spectrumId: 'o', step: 400 })
  assert.equal(moved.spectra[0].lightStep, undefined)
  assert.equal(moved.spectra[0].darkStep, undefined)

  const ramp = generatePalette(moved).spectra[0]
  assert.equal(ramp.swatches.find((s) => s.isLight)!.step, 200)
  assert.equal(ramp.swatches.find((s) => s.isDark)!.step, 600)
})

test('a fix only touches the spectrum it names', () => {
  const base = settings({
    spectra: [spectrum({ id: 'o', anchorStep: 500 }), spectrum({ id: 'b', label: 'Blue', anchorStep: 500 })],
  })
  const moved = applyPaletteFix(base, { kind: 'anchor-step', spectrumId: 'b', step: 700 })
  assert.equal(moved.spectra[0].anchorStep, 500)
  assert.equal(moved.spectra[1].anchorStep, 700)
})

test('an anchor outside the scale is offered — and fixed — as the nearest real step', () => {
  const base = settings({ spectra: [spectrum({ id: 'o', anchorStep: 550 })] })
  const fix = fixOf(generatePalette(base).spectra[0], 'not in the scale')
  const after = generatePalette(applyPaletteFix(base, fix)).spectra[0]
  assert.equal(after.anchorStep, 500)
  assert.deepEqual(after.warnings, [])
})

test('the duplicate-name warning renames the later copies, leaving the first alone', () => {
  const base = settings({ spectra: [spectrum({ id: 'a' }), spectrum({ id: 'b' }), spectrum({ id: 'c' })] })
  const palette = generatePalette(base)
  const fix = palette.warnings.find((w) => w.message.includes('Duplicate'))!.fix!

  const after = applyPaletteFix(base, fix)
  assert.deepEqual(after.spectra.map((s) => s.label), ['Orange', 'Orange 2', 'Orange 3'])
  assert.deepEqual(generatePalette(after).warnings, [])
})

test('an emptied scale can be restored from the warning it raised', () => {
  const base = settings({ spectra: [spectrum({ id: 'o', steps: [] })] })
  const fix = fixOf(generatePalette(base).spectra[0], 'Step list was empty')
  assert.deepEqual(fix, { kind: 'reset-steps', neutral: false })
  assert.deepEqual(applyPaletteFix(base, fix).steps, DEFAULT_STEPS)
})

test('a bad hex is reported without a fix — only the designer knows the intended color', () => {
  const ramp = only(spectrum({ keyHex: 'not-a-color' }))
  const warning = ramp.warnings.find((w) => w.message.includes('not a valid hex'))!
  assert.equal(warning.fix, undefined)
  assert.equal(warning.fixLabel, undefined)
})

test('applying a fix never mutates the settings it was handed', () => {
  const base = settings({ spectra: [spectrum({ id: 'o', anchorStep: 500, lightStep: 300 })] })
  const snapshot = JSON.stringify(base)
  applyPaletteFix(base, { kind: 'anchor-step', spectrumId: 'o', step: 800 })
  applyPaletteFix(base, { kind: 'rename-duplicates' })
  applyPaletteFix(base, { kind: 'reset-steps', neutral: true })
  assert.equal(JSON.stringify(base), snapshot)
})

test('a fix naming a spectrum that is gone is a no-op, not a crash', () => {
  const base = settings({ spectra: [spectrum({ id: 'o', anchorStep: 500 })] })
  const after = applyPaletteFix(base, { kind: 'anchor-step', spectrumId: 'deleted', step: 900 })
  assert.equal(after.spectra[0].anchorStep, 500)
})

/* ---------------------------------------------------------------- harmonious suggestion */

// A fixed sequence stands in for Math.random so the picks are reproducible.
const rolls = (...values: number[]) => {
  let i = 0
  return () => values[i++ % values.length]
}

const hueOf = (hex: string) => hexToOklch(hex)!.h
const gap = (a: number, b: number) => {
  const diff = Math.abs((((a - b) % 360) + 360) % 360)
  return diff > 180 ? 360 - diff : diff
}

test('a suggested hue lands on a classic harmony interval from the existing key', () => {
  const base = settings({ spectra: [spectrum({ keyHex: '#FB5B0A', anchorStep: 500 })] })
  const intervals = [180, 150, 210, 120, 240, 90, 270, 30, 330].map((offset) =>
    Math.min(offset, 360 - offset)
  )
  for (let i = 0; i < 9; i++) {
    const suggested = suggestHarmoniousSpectrum(base, rolls(i / 9))
    const distance = gap(hueOf(suggested.keyHex), hueOf('#FB5B0A'))
    assert.ok(
      intervals.some((interval) => Math.abs(distance - interval) < 2),
      `hue ${hueOf(suggested.keyHex).toFixed(0)}° is ${distance.toFixed(0)}° away — not a harmony interval`
    )
  }
})

test('a suggestion carries the weight of the existing keys, so it shares their rung', () => {
  const orange = hexToOklch('#FB5B0A')!
  const suggested = suggestHarmoniousSpectrum(
    settings({ spectra: [spectrum({ keyHex: '#FB5B0A' })] }),
    rolls(0)
  )
  const picked = hexToOklch(suggested.keyHex)!
  assert.ok(Math.abs(picked.l - orange.l) < 0.02, `lightness drifted: ${picked.l} vs ${orange.l}`)
  assert.ok(picked.c > 0.05, 'a key color needs real chroma')
})

test('a suggestion keeps clear of every hue already in use', () => {
  const crowded = settings({
    spectra: [
      spectrum({ id: 'o', label: 'Orange', keyHex: '#FB5B0A' }),
      spectrum({ id: 'b', label: 'Blue', keyHex: '#2364AA' }),
      spectrum({ id: 'g', label: 'Green', keyHex: '#30A46C' }),
      spectrum({ id: 'n', label: 'Neutral', keyHex: '#8A8A8A', neutral: true }),
    ],
  })
  for (let i = 0; i < 9; i++) {
    const hue = hueOf(suggestHarmoniousSpectrum(crowded, rolls(i / 9)).keyHex)
    for (const taken of ['#FB5B0A', '#2364AA', '#30A46C']) {
      assert.ok(gap(hue, hueOf(taken)) >= 24, `${hue.toFixed(0)}° collides with ${taken}`)
    }
  }
})

test('the neutral spectrum is ignored when judging harmony', () => {
  // A gray has no meaningful hue; letting it into the reference set would skew every pick.
  const withNeutral = settings({
    spectra: [
      spectrum({ id: 'n', label: 'Neutral', keyHex: '#8A8A8A', neutral: true }),
      spectrum({ id: 'o', label: 'Orange', keyHex: '#FB5B0A' }),
    ],
  })
  const suggested = suggestHarmoniousSpectrum(withNeutral, rolls(0))
  assert.ok(Math.abs(hexToOklch(suggested.keyHex)!.l - hexToOklch('#FB5B0A')!.l) < 0.02)
})

test('the very first spectrum is suggested from an empty wheel', () => {
  const empty = settings({ spectra: [] })
  const suggested = suggestHarmoniousSpectrum(empty, rolls(0.5))
  assert.ok(/^#[0-9A-F]{6}$/.test(suggested.keyHex))
  assert.ok(suggested.label.length > 0)
  assert.equal(only(suggested).swatches.find((s) => s.isMain)!.hex, suggested.keyHex)
})

test('a suggestion is named for its hue, and never reuses a taken name', () => {
  assert.equal(hueName(40), 'Orange')
  assert.equal(hueName(253), 'Blue')
  assert.equal(hueName(158), 'Green')
  assert.equal(hueName(0), 'Rose')

  // Force a repeat: with Orange present, the complement is Cyan-ish — claim that name too.
  const taken = settings({
    spectra: [spectrum({ keyHex: '#FB5B0A' }), spectrum({ id: 'x', label: 'Cyan', keyHex: '#06B6D4' })],
  })
  const suggested = suggestHarmoniousSpectrum(taken, rolls(0))
  const labels = taken.spectra.map((s) => s.label.toLowerCase())
  assert.ok(!labels.includes(suggested.label.toLowerCase()), `"${suggested.label}" is already taken`)
})

test('a suggested spectrum generates a clean ramp anchored where its siblings are', () => {
  const base = settings({ spectra: [spectrum({ keyHex: '#FB5B0A', anchorStep: 500 })] })
  const suggested = suggestHarmoniousSpectrum(base, rolls(0.3))
  assert.equal(suggested.anchorStep, 500)
  const ramp = only(suggested)
  assert.equal(ramp.swatches.find((s) => s.isMain)!.step, 500)
  assert.deepEqual(ramp.warnings, [])
})

test('a suggestion follows a sibling that sits off the ladder rather than correcting it', () => {
  // The brand color is the reference, not the ladder. If the existing key is stretched at its
  // step, matching it is what keeps the two ramps consistent with each other — both then carry
  // the same advisory rather than one quietly landing at a different weight.
  const off = settings({ spectra: [spectrum({ keyHex: '#FB5B0A', anchorStep: 800 })] })
  const suggested = suggestHarmoniousSpectrum(off, rolls(0.3))
  assert.equal(suggested.anchorStep, 800)

  const sibling = only(spectrum({ keyHex: '#FB5B0A', anchorStep: 800 }))
  const ramp = only(suggested)
  const mainL = (s: typeof ramp) => hexToOklch(s.swatches.find((x) => x.isMain)!.hex)!.l
  assert.ok(Math.abs(mainL(ramp) - mainL(sibling)) < 0.02, 'the pair must share a rung')
  assert.ok(ramp.warnings.length > 0 && sibling.warnings.length > 0, 'both should be flagged, not just one')
})

test('duplicate spectrum names are reported before they silently merge groups', () => {
  const palette = generatePalette(
    settings({ spectra: [spectrum({ id: 'a' }), spectrum({ id: 'b', prefix: 'O2' })] })
  )
  assert.ok(palette.warnings.some((w) => w.message.includes('Duplicate')))
})
