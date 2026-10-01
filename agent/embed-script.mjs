import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import { localImports, sourceSetFingerprint } from './source-set.mjs'

export async function embeddedScript(entry) {
  const source = readFileSync(entry.file, 'utf8')
  const imports = localImports(source)
  if (!entry.bundle) {
    if (imports.length > 0) {
      throw new Error(
        `${entry.file} imports local module(s) ${imports.join(', ')} but its embed is not bundled — ` +
        `a downloaded one-file script would fail with ERR_MODULE_NOT_FOUND`
      )
    }
    return { source, fingerprint: null }
  }
  const fingerprint = sourceSetFingerprint(entry.file)
  const result = await esbuild.build({
    entryPoints: [entry.file],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'silent',
    define: { __ALLCREW_BRIDGE_FINGERPRINT__: JSON.stringify(fingerprint) },
  })
  const bundled = result.outputFiles[0]?.text ?? ''
  const left = localImports(bundled)
  if (left.length > 0) throw new Error(`${entry.file} bundle still contains local import(s): ${left.join(', ')}`)
  return { source: bundled, fingerprint }
}
