/**
 * The archive a designer installs.
 *
 * It used to be assembled by hand, and it showed: the zip in `build/` carried a bundle five
 * weeks older than the repository, so everything added in between existed only for people with
 * a checkout. A build that is not scripted drifts by default, so this is the script - it always
 * rebuilds first, and it refuses to write an archive whose contents it cannot verify.
 *
 *   node package.mjs        # build, then write build/altery-figma-ds-plugin.zip
 *
 * The layout is the one `manifest.json` promises: the manifest beside a `dist/` directory, with
 * the install notes next to them. Figma resolves `main`/`ui` relative to the manifest, so that
 * relative shape is the contract - not a convenience.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const OUT_DIR = join(ROOT, 'build')
const ARCHIVE = join(OUT_DIR, 'altery-figma-ds-plugin.zip')
/** Everything the plugin needs at runtime, and nothing else: no sources, no tests, no node_modules. */
const MEMBERS = ['manifest.json', 'dist/code.js', 'dist/ui.html', 'README.md']

/** A bundle older than its sources is the exact failure this script exists to prevent. */
function assertFresh() {
  const bundle = statSync(join(ROOT, 'dist/code.js')).mtimeMs
  const sources = execFileSync('git', ['ls-files', 'src', 'agent', 'ui.html', 'manifest.json'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  for (const file of sources) {
    let changed
    try {
      changed = statSync(join(ROOT, file)).mtimeMs
    } catch {
      continue // deleted but still tracked — not this script's problem
    }
    if (changed > bundle) throw new Error(`${file} is newer than dist/code.js — the build did not run`)
  }
}

console.log('building…')
execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' })
assertFresh()

// The install notes ship INSIDE the archive, taken from `build/README.md` so they are written
// once rather than maintained in two places.
mkdirSync(join(OUT_DIR, 'staging', 'dist'), { recursive: true })
const staging = join(OUT_DIR, 'staging')
for (const member of MEMBERS) {
  const from = member === 'README.md' ? join(OUT_DIR, 'README.md') : join(ROOT, member)
  writeFileSync(join(staging, member), readFileSync(from))
}

rmSync(ARCHIVE, { force: true })
// `zip` rather than a JS zip writer: it is on every machine this repo is built on, and the
// archive has to be readable by Figma's importer, not by us.
execFileSync('zip', ['-q', '-r', ARCHIVE, ...MEMBERS], { cwd: staging })
rmSync(staging, { recursive: true, force: true })

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const size = statSync(ARCHIVE).size
console.log(`\n${ARCHIVE}`)
console.log(`  version ${version} · ${(size / 1024).toFixed(0)} KB · ${MEMBERS.join(', ')}`)
