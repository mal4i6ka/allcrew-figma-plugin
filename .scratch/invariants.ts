import { readFileSync } from 'node:fs'
import { parseTokenName } from '../src/tokens/remap/token-name.ts'
import { parseHex, rgbToOklch } from '../src/tokens/color.ts'
import { buildRemapPlan, type ColorSite } from '../src/tokens/remap/plan.ts'
import type { ParsedSwatch } from '../src/tokens/remap/input.ts'
import { toHex } from '../src/tokens/remap/color-literal.ts'

type Pair = { name: string; hex: string }
function flatten(node: any, path: string[] = [], out: Pair[] = []): Pair[] {
  for (const [key, value] of Object.entries(node)) {
    if (value === null || typeof value !== 'object') continue
    const v = value as any
    if ('$value' in v) {
      if (v.$type === 'color' && typeof v.$value === 'string' && v.$value.startsWith('#'))
        out.push({ name: [...path, key].join('/'), hex: v.$value })
      continue
    }
    flatten(v, [...path, key], out)
  }
  return out
}
const rgba = (hex: string) => ({ ...parseHex(hex)!, a: 1 })
const home = '/Users/alexanderlugachev/Downloads/'
const A = flatten(JSON.parse(readFileSync(home + 'A-tokens.json', 'utf8')))
const B = flatten(JSON.parse(readFileSync(home + 'B-tokens.json', 'utf8')))
B.push(
  { name: 'colour/white', hex: '#ffffff' },
  { name: 'colour/grey/10', hex: '#f4f4f4' }, { name: 'colour/grey/50', hex: '#e4e4e4' },
  { name: 'colour/grey/700', hex: '#646464' }, { name: 'colour/grey/800', hex: '#4c4c4c' },
  { name: 'colour/grey/900', hex: '#353535' }, { name: 'colour/grey/950', hex: '#1d1d1d' },
  { name: 'colour/neutral/100', hex: '#d0e2e4' }, { name: 'colour/neutral/900', hex: '#314245' },
)

const swatches: ParsedSwatch[] = A.map((p) => {
  const parsed = parseTokenName(p.name)
  return { hex: p.hex.toUpperCase(), alpha: 1, rgba: rgba(p.hex), name: p.name, family: parsed.family, step: parsed.step }
})
const paletteSteps = new Map<string, Set<number>>()
const paletteHexes = new Set(swatches.map((s) => s.hex))
for (const s of swatches) {
  if (s.family === null || s.step === null) continue
  const key = s.family.toLowerCase()
  if (!paletteSteps.has(key)) paletteSteps.set(key, new Set())
  paletteSteps.get(key)!.add(s.step)
}
const sites: ColorSite[] = B.map((p, index) => ({
  id: `v${index}`, groupId: `v${index}`, kind: 'variable' as const, name: p.name,
  modeId: null, modeName: null, rgba: rgba(p.hex), usage: 1, editable: true, primitive: true,
}))
const plan = buildRemapPlan({ sites, palette: swatches })

let bad = 0
const fail = (message: string) => { bad++; console.log('  FAIL', message) }

// 1. identity: any old color the palette holds byte-for-byte must not change
for (const e of plan.entries) {
  if (paletteHexes.has(toHex(e.from)) && toHex(e.from) !== toHex(e.to))
    fail(`identity: ${e.site.name} ${toHex(e.from)} moved to ${toHex(e.to)} (via ${e.via})`)
}
// 2. anchors: a numbered old rung whose number exists in its landing family keeps that number
for (const e of plan.entries) {
  if (e.via === 'exact' || e.fromStep === null || e.toFamily === null) continue
  const steps = paletteSteps.get(e.toFamily.toLowerCase())
  if (steps?.has(e.fromStep) && e.toStep !== e.fromStep)
    fail(`anchor: ${e.site.name} step ${e.fromStep} landed on ${e.toStep} in ${e.toFamily}`)
}
// 3. order: within one source family, landings by rising step never get lighter
const byFamily = new Map<string, typeof plan.entries[number][]>()
for (const e of plan.entries) {
  if (e.fromStep === null || e.fromFamily === null || e.via === 'exact') continue
  if (!byFamily.has(e.fromFamily)) byFamily.set(e.fromFamily, [])
  byFamily.get(e.fromFamily)!.push(e)
}
for (const [family, group] of byFamily) {
  const sorted = [...group].sort((a, b) => a.fromStep! - b.fromStep!)
  for (let i = 1; i < sorted.length; i++) {
    const prev = rgbToOklch(sorted[i - 1].to).l
    const here = rgbToOklch(sorted[i].to).l
    if (here > prev + 1e-9)
      fail(`order: ${family} ${sorted[i - 1].fromStep}->${sorted[i - 1].toStep} then ${sorted[i].fromStep}->${sorted[i].toStep} gets lighter`)
  }
}
// 4. nothing off the shared ladder when both numbers exist... report where landings use steps absent from the SOURCE family
const usedOff = new Map<string, Set<number>>()
for (const e of plan.entries) {
  if (e.via === 'exact' || e.toStep === null || e.toFamily === null || e.fromFamily === null) continue
  const sourceSteps = new Set(plan.entries.filter((x) => x.fromFamily === e.fromFamily && x.fromStep !== null).map((x) => x.fromStep!))
  if (!sourceSteps.has(e.toStep) && e.fromStep !== null) {
    if (!usedOff.has(e.fromFamily)) usedOff.set(e.fromFamily, new Set())
    usedOff.get(e.fromFamily)!.add(e.toStep)
  }
}
for (const [family, steps] of usedOff) console.log(`  note: ${family} uses new-only steps: ${[...steps].join(',')}`)

console.log(bad === 0 ? 'ALL INVARIANTS HOLD' : `${bad} violations`)
console.log('entries:', plan.entries.length, ' exact:', plan.entries.filter((e) => e.via === 'exact').length)
