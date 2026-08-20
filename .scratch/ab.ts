import { readFileSync } from 'node:fs'
import { parseTokenName } from '../src/tokens/remap/token-name.ts'
import { parseHex } from '../src/tokens/color.ts'
import { buildRemapPlan, type ColorSite } from '../src/tokens/remap/plan.ts'
import type { ParsedSwatch } from '../src/tokens/remap/input.ts'
import { toHex } from '../src/tokens/remap/color-literal.ts'

type Pair = { name: string; hex: string; alpha?: number }
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
const rgba = (hex: string, a = 1) => ({ ...parseHex(hex)!, a })
const home = '/Users/alexanderlugachev/Downloads/'
const A = flatten(JSON.parse(readFileSync(home + 'A-tokens.json', 'utf8')))
const B = flatten(JSON.parse(readFileSync(home + 'B-tokens.json', 'utf8')))

// Strays that exist in the live mobile file but not in the export — names taken off the board.
B.push(
  { name: 'colour/white', hex: '#ffffff' },
  { name: 'colour/grey/10', hex: '#f4f4f4' },
  { name: 'colour/grey/50', hex: '#e4e4e4' },
  { name: 'colour/grey/700', hex: '#646464' },
  { name: 'colour/grey/800', hex: '#4c4c4c' },
  { name: 'colour/grey/900', hex: '#353535' },
  { name: 'colour/grey/950', hex: '#1d1d1d' },
  { name: 'colour/neutral/100', hex: '#d0e2e4' },
  { name: 'colour/neutral/900', hex: '#314245' },
  { name: 'Rectangle 41', hex: '#fcfcfc' },
  { name: 'colors/brand/cultured', hex: '#f3f8f9' },
  { name: 'colors/brand/isabelline', hex: '#f9f6f2' },
  { name: 'Frame 77', hex: '#faf5f1' },
)

const swatches: ParsedSwatch[] = A.map((p) => {
  const parsed = parseTokenName(p.name)
  return { hex: p.hex.toUpperCase(), alpha: 1, rgba: rgba(p.hex), name: p.name, family: parsed.family, step: parsed.step }
})
const sites: ColorSite[] = B.map((p, index) => ({
  id: `v${index}`, groupId: `v${index}`, kind: 'variable' as const, name: p.name,
  modeId: null, modeName: null, rgba: rgba(p.hex), usage: 1, editable: true, primitive: true,
}))

const plan = buildRemapPlan({ sites, palette: swatches })
const show = (needle: string) => {
  console.log(`--- ${needle}`)
  for (const e of plan.entries) {
    const hay = `${e.site.name} ${e.fromFamily ?? ''}`.toLowerCase()
    if (!hay.includes(needle.toLowerCase())) continue
    console.log(`  ${(e.fromFamily ?? '—').padEnd(18)} ${e.site.name.padEnd(28)} ${toHex(e.from)} ${String(e.fromStep).padStart(4)} -> ${toHex(e.to)} ${String(e.toStep).padStart(4)}  ${(e.toName ?? '').padEnd(12)} ${e.via} ${e.flags.join(',')}`)
  }
}
for (const needle of process.argv.slice(2)) show(needle)
