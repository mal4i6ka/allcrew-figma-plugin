import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseTokenName } from '../src/tokens/remap/token-name.ts'
import { parseHex } from '../src/tokens/color.ts'
import { buildRemapPlan, type ColorSite } from '../src/tokens/remap/plan.ts'
import type { ParsedSwatch } from '../src/tokens/remap/input.ts'
import { buildMappingFile, colorReplacements } from '../src/tokens/remap/contract.ts'
import { rewriteColors } from '../src/tokens/remap/rewrite.ts'

type Pair = { name: string; hex: string; alpha?: number }
function flatten(node: any, path: string[] = [], out: Pair[] = []): Pair[] {
  for (const [key, value] of Object.entries(node)) {
    if (value === null || typeof value !== 'object') continue
    const v = value as any
    if ('$value' in v) {
      if (v.$type === 'color' && typeof v.$value === 'string') {
        if (v.$value.startsWith('#')) out.push({ name: [...path, key].join('/'), hex: v.$value })
        else {
          const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(v.$value)
          if (m) out.push({
            name: [...path, key].join('/'),
            hex: '#' + [m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, '0')).join(''),
            alpha: Number(m[4]),
          })
        }
      }
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

const swatches: ParsedSwatch[] = A.map((p) => {
  const parsed = parseTokenName(p.name)
  const alpha = p.alpha ?? 1
  return { hex: p.hex.toUpperCase(), alpha, rgba: { ...rgba(p.hex), a: alpha }, name: p.name, family: parsed.family, step: parsed.step }
})
const sites: ColorSite[] = B.map((p, index) => ({
  id: `v${index}`, groupId: `v${index}`, kind: 'variable' as const, name: p.name,
  modeId: null, modeName: null, rgba: rgba(p.hex, p.alpha ?? 1), usage: 1, editable: true, primitive: true,
}))
const plan = buildRemapPlan({ sites, palette: swatches })
const mapping = buildMappingFile(plan, { file: 'Altery Mobile DS', palette: 'Altery Design System 3.0 · Colors' })

const dir = '/Users/alexanderlugachev/Downloads/dev-test-files'
writeFileSync(join(dir, 'mapping.json'), JSON.stringify(mapping, null, 2))

const { replacements, conflicts } = colorReplacements(mapping)
console.log(`mapping: ${mapping.records.length} records, ${replacements.size} literal replacements, ${conflicts.length} conflicts\n`)

for (const file of readdirSync(dir)) {
  if (file === 'mapping.json' || file === 'README.md' || file.startsWith('expected')) continue
  const text = readFileSync(join(dir, file), 'utf8')
  const result = rewriteColors(text, mapping, {})
  console.log(`== ${file}: ${result.replacements.length} edit(s), untouched ${result.untouched}`)
  for (const r of result.replacements.slice(0, 30)) console.log(`   ${JSON.stringify(r)}`)
  writeFileSync(join(dir, 'expected-' + file), result.text)
}
