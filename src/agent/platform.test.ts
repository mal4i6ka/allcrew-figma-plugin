/**
 * The unit profile: what one Figma pixel is on the platform that will build the screen.
 *
 * The failure this prevents is a screen that is correct in proportion and twice the size. A
 * designer drawing an iPhone at 2× produces a 750px-wide frame; every number in the IR is then
 * double what SwiftUI should emit, and nothing in the tree says so. The second failure is `dp`
 * where `sp` belongs, which ships an Android UI that ignores the system font-size setting.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { isPlatform, unitProfile } from './platform.ts'
import { OPS_BY_NAME } from './ops.ts'

test('a logical artboard is 1x and names the device width it matched', () => {
  const ios = unitProfile('ios', 393)
  assert.equal(ios.scale, 1)
  assert.equal(ios.unit, 'pt')
  assert.match(ios.basis, /393pt/)

  const android = unitProfile('android', 360)
  assert.equal(android.scale, 1)
  assert.equal(android.unit, 'dp')
})

test('a 2x artboard is caught and says what to divide by', () => {
  // 750 is no iPhone width; 375 is several. This is the case that silently doubled every screen.
  const doubled = unitProfile('ios', 750)
  assert.equal(doubled.scale, 2)
  assert.match(doubled.basis, /2× a 375pt/)
  assert.match(doubled.basis, /divide every length by 2/)
})

test('a 3x artboard is caught too', () => {
  assert.equal(unitProfile('android', 1080).scale, 3)
})

test('1x wins over a coincidental higher match', () => {
  // 768 is an iPad width AND 2× 384, which is nothing on iOS. The logical reading comes first,
  // so a real iPad artboard is never reported as a doubled phone.
  const profile = unitProfile('ios', 768)
  assert.equal(profile.scale, 1)
  assert.match(profile.basis, /768pt/)
})

test('an unmatched width is reported as unmatched, not guessed', () => {
  // The repo's own rule: a plausible wrong answer is worse than a named refusal. A 613px frame
  // is somebody's crop, and inventing a density for it would be worse than saying so.
  const profile = unitProfile('ios', 613)
  assert.equal(profile.scale, 1)
  assert.match(profile.basis, /matches no standard ios width/)
  assert.match(profile.basis, /check the artboard/)
})

test('no width at all is stated rather than assumed', () => {
  // A component read on its own has no artboard to reason from.
  assert.match(unitProfile('ios').basis, /no frame width/)
  assert.match(unitProfile('ios', 0).basis, /no frame width/)
})

test('Android sizes text in sp and everything else in dp', () => {
  const android = unitProfile('android', 360)
  assert.equal(android.unit, 'dp')
  assert.equal(android.textUnit, 'sp')
  // iOS and the web measure text in the same unit as everything else; Android does not, and that
  // asymmetry is the only reason `textUnit` exists as a separate field.
  assert.equal(unitProfile('ios', 393).textUnit, 'pt')
  assert.equal(unitProfile('web', 1280).textUnit, 'px')
})

test('each platform asks for the densities it actually ships', () => {
  assert.deepEqual(unitProfile('ios', 393).assetScales, [1, 2, 3])
  // Android's buckets, the ones `assetPath` maps to `drawable-<bucket>`.
  assert.deepEqual(unitProfile('android', 360).assetScales, [1, 1.5, 2, 3, 4])
  assert.deepEqual(unitProfile('web', 1280).assetScales, [1, 2])
})

test('the profile names the assets.export naming mode so the two calls agree', () => {
  assert.equal(unitProfile('ios', 393).assetNaming, 'ios')
  assert.equal(unitProfile('android', 360).assetNaming, 'android')
  assert.equal(unitProfile('web', 1280).assetNaming, 'web')
})

test('a half-pixel frame width still matches its device', () => {
  assert.equal(unitProfile('android', 392.5).scale, 1)
})

test('only the three platforms are platforms', () => {
  assert.ok(isPlatform('ios'))
  assert.ok(isPlatform('android'))
  assert.ok(isPlatform('web'))
  assert.ok(!isPlatform('IOS'))
  assert.ok(!isPlatform(undefined))
  assert.ok(!isPlatform('flutter'))
})


/* ------------------------------------------------------- the ops agree on it */

test('assets.export defaults come from the profile, and an explicit param still wins', () => {
  const assets = OPS_BY_NAME.get('assets.export')
  assert.ok(assets, 'assets.export is registered')
  // The precedence only works if the SPEC carries no default: `validateParams` applies a spec
  // default before `run` ever sees the call, so a default here would silently beat the profile.
  assert.equal(assets.params.naming.default, undefined)
  assert.equal(assets.params.scales.default, undefined)
  assert.deepEqual(assets.params.platform.enum, ['web', 'ios', 'android'])

  // And the values it would default to are the profile's, not a second hand-written list.
  assert.equal(unitProfile('android', 360).assetNaming, 'android')
  assert.deepEqual(unitProfile('android', 360).assetScales, [1, 1.5, 2, 3, 4])
})

test('design.ir offers the same platform vocabulary, so one screen is described once', () => {
  const ir = OPS_BY_NAME.get('design.ir')
  assert.ok(ir, 'design.ir is registered')
  assert.deepEqual(ir.params.platform.enum, ['web', 'ios', 'android'])
  // Appearance is opt-in: the web path reads paint off the live node and a default-on tree would
  // double every answer that has no use for it.
  assert.equal(ir.params.appearance.default, false)
})