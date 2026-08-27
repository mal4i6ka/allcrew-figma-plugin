import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHex } from '../color.ts'
import { auditContrast, describeContrast, type AdjacencyPair } from './audit.ts'
import { parsePaletteInput } from './input.ts'
import { buildRemapPlan, type ColorSite } from './plan.ts'

const rgba = (hex: string) => ({ ...parseHex(hex)!, a: 1 })

const site = (id: string, name: string, hex: string): ColorSite => ({
  id,
  kind: 'variable',
  name,
  modeId: 'light',
  modeName: 'Light',
  rgba: rgba(hex),
  usage: 1,
  editable: true,
  primitive: true,
})

/** A palette that keeps the surface light and drags the text colour up to mid-gray. */
const palette = parsePaletteInput(
  ['Gray/50, #F8FAFC', 'Gray/100, #F1F5F9', 'Gray/400, #94A3B8', 'Gray/500, #64748B', 'Gray/900, #0F172A'].join('\n')
).swatches

const pair = (a: string, b: string, text: boolean): AdjacencyPair => ({ a, b, text })

test('a text pair that stops passing is reported as broken', () => {
  const sites = [
    site('text', 'text/primary', '#0F172A'),
    site('bg', 'surface/default', '#F8FAFC'),
  ]
  const plan = buildRemapPlan({ sites, palette })
  // Force the regression the way an override would: near-black text becomes mid-gray.
  const text = plan.entries.find((entry) => entry.site.id === 'text')!
  text.to = rgba('#94A3B8')

  const audit = auditContrast(plan, [pair('text', 'bg', true)])
  assert.equal(audit.checked, 1)
  assert.equal(audit.findings.length, 1)
  assert.equal(audit.findings[0].verdict, 'broken')
  assert.ok(audit.findings[0].before > 4.5)
  assert.ok(audit.findings[0].after < 4.5)
  assert.match(describeContrast(audit.findings[0]), /text\/primary on surface\/default \(Light\)/)
})

test('a boundary pair is judged against 3, not 4.5', () => {
  const sites = [site('a', 'border/default', '#64748B'), site('b', 'surface/default', '#F1F5F9')]
  const plan = buildRemapPlan({ sites, palette })
  const border = plan.entries.find((entry) => entry.site.id === 'a')!
  border.to = rgba('#94A3B8')

  // ~2.4:1 after the change — under 3 for a boundary, and would also be under 4.5 for text.
  const asBoundary = auditContrast(plan, [pair('a', 'b', false)])
  assert.equal(asBoundary.findings.length, 1)
  assert.equal(asBoundary.findings[0].text, false)

  const stillPassing = auditContrast(plan, [pair('a', 'b', false)])
  assert.equal(stillPassing.findings[0].after < 3, true)
})

test('a pair that was already failing and got worse is weakened, not broken', () => {
  const sites = [site('a', 'text/muted', '#94A3B8'), site('b', 'surface/default', '#F1F5F9')]
  const plan = buildRemapPlan({ sites, palette })
  const text = plan.entries.find((entry) => entry.site.id === 'a')!
  text.to = rgba('#F8FAFC')

  const audit = auditContrast(plan, [pair('a', 'b', true)])
  assert.equal(audit.findings[0].verdict, 'weakened')
})

test('an improvement is counted, never reported as something to fix', () => {
  const sites = [site('a', 'text/muted', '#94A3B8'), site('b', 'surface/default', '#F1F5F9')]
  const plan = buildRemapPlan({ sites, palette })
  const text = plan.entries.find((entry) => entry.site.id === 'a')!
  text.to = rgba('#0F172A')

  const audit = auditContrast(plan, [pair('a', 'b', true)])
  assert.deepEqual(audit.findings, [])
  assert.equal(audit.improved, 1)
})

test('a pair that still passes after the change is not a finding', () => {
  const sites = [site('a', 'text/primary', '#0F172A'), site('b', 'surface/default', '#F8FAFC')]
  const plan = buildRemapPlan({ sites, palette })
  const text = plan.entries.find((entry) => entry.site.id === 'a')!
  text.to = rgba('#64748B')

  const audit = auditContrast(plan, [pair('a', 'b', true)])
  assert.equal(audit.checked, 1)
  assert.deepEqual(audit.findings, [])
})

test('the same pair reported twice is measured once', () => {
  const sites = [site('a', 'text/primary', '#0F172A'), site('b', 'surface/default', '#F8FAFC')]
  const plan = buildRemapPlan({ sites, palette })
  plan.entries.find((entry) => entry.site.id === 'a')!.to = rgba('#94A3B8')

  const audit = auditContrast(plan, [pair('a', 'b', true), pair('b', 'a', true)])
  assert.equal(audit.checked, 1)
  assert.equal(audit.findings.length, 1)
})

test('regressions this remap caused sort above problems it merely deepened', () => {
  const sites = [
    site('t1', 'text/primary', '#0F172A'),
    site('t2', 'text/muted', '#94A3B8'),
    site('bg', 'surface/default', '#F8FAFC'),
  ]
  const plan = buildRemapPlan({ sites, palette })
  plan.entries.find((entry) => entry.site.id === 't1')!.to = rgba('#64748B')
  plan.entries.find((entry) => entry.site.id === 't1')!.to = rgba('#94A3B8')
  plan.entries.find((entry) => entry.site.id === 't2')!.to = rgba('#CBD5E1')

  const audit = auditContrast(plan, [pair('t1', 'bg', true), pair('t2', 'bg', true)])
  assert.equal(audit.findings.length, 2)
  assert.equal(audit.findings[0].verdict, 'broken')
  assert.equal(audit.findings[1].verdict, 'weakened')
})

test('a pair naming a site the plan never touched is skipped', () => {
  const sites = [site('a', 'text/primary', '#0F172A')]
  const plan = buildRemapPlan({ sites, palette })
  const audit = auditContrast(plan, [pair('a', 'missing', true)])
  assert.equal(audit.checked, 0)
  assert.deepEqual(audit.findings, [])
})
