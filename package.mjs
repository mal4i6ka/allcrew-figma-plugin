import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = process.cwd()
const OUT_DIR = join(ROOT, 'build')
const STAGING = join(OUT_DIR, 'staging')
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSIONED_NAME = `allcrew-channel-plugin-v${version}.zip`
const VERSIONED_ARCHIVE = join(OUT_DIR, VERSIONED_NAME)
const LATEST_ARCHIVE = join(OUT_DIR, 'allcrew-channel-plugin.zip')
const CHECKSUMS = join(OUT_DIR, 'SHA256SUMS')

/** Runtime files plus the local tools users otherwise download from the plugin UI. */
const ENTRIES = [
  { source: 'manifest.json', target: 'manifest.json' },
  { source: 'dist/code.js', target: 'dist/code.js' },
  { source: 'dist/ui.html', target: 'dist/ui.html' },
  { source: 'build/README.md', target: 'README.md' },
  { source: 'LICENSE', target: 'LICENSE' },
  { source: 'agent/bridge.mjs', target: 'tools/bridge.mjs' },
  { source: 'agent/mcp.mjs', target: 'tools/mcp.mjs' },
  { source: 'server/receiver.mjs', target: 'tools/receiver.mjs' },
  { source: 'PRIVACY.md', target: 'PRIVACY.md' },
  { source: 'SECURITY.md', target: 'SECURITY.md' },
  { source: 'CHANGELOG.md', target: 'CHANGELOG.md' },
]
function assertFresh() {
  const bundle = statSync(join(ROOT, 'dist/code.js')).mtimeMs
  const sources = execFileSync('git', ['ls-files', 'src', 'agent', 'server', 'ui.html', 'manifest.json'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
  for (const file of sources) {
    try {
      if (statSync(join(ROOT, file)).mtimeMs > bundle) {
        throw new Error(`${file} is newer than dist/code.js — the build did not run`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('newer than')) throw error
      // A tracked deletion is irrelevant to archive freshness.
    }
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

console.log('building…')
execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' })
assertFresh()

rmSync(STAGING, { recursive: true, force: true })
for (const entry of ENTRIES) {
  const target = join(STAGING, entry.target)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(ROOT, entry.source), target)
}

mkdirSync(OUT_DIR, { recursive: true })
for (const file of readdirSync(OUT_DIR)) {
  if (/^allcrew-channel-plugin-v.*\.zip$/.test(file)) rmSync(join(OUT_DIR, file), { force: true })
}
rmSync(LATEST_ARCHIVE, { force: true })
execFileSync('zip', ['-X', '-q', '-r', VERSIONED_ARCHIVE, ...ENTRIES.map((entry) => entry.target)], { cwd: STAGING })
copyFileSync(VERSIONED_ARCHIVE, LATEST_ARCHIVE)
rmSync(STAGING, { recursive: true, force: true })

writeFileSync(CHECKSUMS, `${sha256(VERSIONED_ARCHIVE)}  ${VERSIONED_NAME}\n`)

const members = execFileSync('unzip', ['-Z1', VERSIONED_ARCHIVE], { encoding: 'utf8' }).trim().split('\n')
for (const entry of ENTRIES) {
  if (!members.includes(entry.target)) throw new Error(`archive is missing ${entry.target}`)
}

const size = statSync(VERSIONED_ARCHIVE).size
console.log(`\n${VERSIONED_ARCHIVE}`)
console.log(`  version ${version} · ${(size / 1024).toFixed(0)} KB · ${ENTRIES.length} files`)
console.log(`${CHECKSUMS}\n  ${sha256(VERSIONED_ARCHIVE)}`)
