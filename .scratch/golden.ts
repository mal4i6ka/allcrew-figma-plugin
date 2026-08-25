import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseMappingFile } from '../src/tokens/remap/contract.ts'
import { rewriteColors } from '../src/tokens/remap/rewrite.ts'

const fixtures = fileURLToPath(new URL('../tests/fixtures/remap/', import.meta.url))
const read = (relative: string): string => readFileSync(fixtures + relative, 'utf8')
const shared = parseMappingFile(read('mapping.json'))
const report: string[] = []
for (const name of readdirSync(fixtures + 'input').sort()) {
  const result = rewriteColors(read(`input/${name}`), shared, { snap: 2, byName: true })
  writeFileSync(fixtures + `expected/${name}`, result.text)
  for (const entry of result.replacements) {
    report.push(
      `${name}:${entry.line}:${entry.column} ${entry.from} -> ${entry.to}` +
        (entry.snapped ? ' [snapped]' : '') + (entry.via === 'name' ? ' [by name]' : '')
    )
  }
  report.push(`${name}: ${result.replacements.length} replaced, ${result.untouched} untouched`)
}
writeFileSync(fixtures + 'expected/report.txt', report.join('\n') + '\n')
console.log(report.join('\n'))
