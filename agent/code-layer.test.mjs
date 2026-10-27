import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { archiveCodeLayer, writeCodeLayerProject } from './code-layer.mjs'

const EXPORT = {
  'package.json': JSON.stringify({ name: 'figma-export', scripts: { dev: 'vite' }, devDependencies: { vite: '^5.4.10' } }),
  'src/main.tsx': "import { Home } from './screens/Home'\n\nrender(<Home />)\n",
  'src/screens/Home.tsx': 'export function Home() { return null }\n',
  '.gitignore': 'node_modules\n',
}

test('an export becomes an archive Figma accepts: contents at the root, dotfiles kept, scripts executable', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'code-layer-'))
  try {
    const dir = path.join(work, 'project')
    const archive = path.join(work, 'project.archive')
    const count = writeCodeLayerProject(EXPORT, dir)
    assert.ok(count > Object.keys(EXPORT).length)
    archiveCodeLayer(dir, archive)
    const listing = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' })
    for (const script of ['install', 'dev', 'deploy-preview', 'deploy']) {
      assert.match(listing, new RegExp(`^-rwxr-xr-x.* \\./\\.figma/make/${script}$`, 'm'))
    }
    assert.match(listing, / \.\/\.gitignore$/m)
    assert.match(listing, / \.\/src\/App\.tsx$/m)
    assert.doesNotMatch(listing, /\/\._/)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('a project is never written over another, nor a path outside itself', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'code-layer-'))
  try {
    fs.writeFileSync(path.join(work, 'keep.txt'), 'mine')
    assert.throws(() => writeCodeLayerProject(EXPORT, work), /not empty/)
    assert.throws(() => writeCodeLayerProject({ ...EXPORT, '../escape.txt': 'x' }, path.join(work, 'p')), /outside the project/)
    assert.throws(() => archiveCodeLayer(work, path.join(work, 'inside.archive')), /outside the project/)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})
