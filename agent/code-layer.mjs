#!/usr/bin/env node
/**
 * A React export, archived the way Figma imports a code layer.
 *
 *   node agent/code-layer.mjs <files.json> <project-dir> <archive>
 *
 * `files.json` is what `EMIT_REACT` answers with — the `{ path: contents }` map the bridge spills
 * to a file — with or without `codeLayer: true`: an export that was not packed for a code layer is
 * packed here, by the same `asCodeLayer`, so a plugin build that predates the flag still works.
 *
 * The project is written to a NEW directory, the four `.figma/make` scripts are made executable
 * (the importer refuses them otherwise, and a JSON map cannot carry a file mode), and the archive
 * is a gzip tar of the directory's contents — dotfiles and modes kept, no links — at the path
 * Figma's `send_code_to_figma` handed out. Uploading and importing stay with whoever holds the
 * Figma MCP session: this script writes nothing anywhere else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { asCodeLayer, CODE_LAYER_EXECUTABLES } from '../src/targets/react/code-layer.ts'

export function writeCodeLayerProject(files, dir) {
  const packed = files['.figma/make/install'] ? files : asCodeLayer(files)
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) throw new Error(`${dir} is not empty — the project needs a fresh directory`)
  const root = path.resolve(dir)
  for (const [relative, contents] of Object.entries(packed)) {
    const target = path.resolve(root, relative)
    // A path out of the project would be written outside it — and then archived from there.
    if (!target.startsWith(root + path.sep)) throw new Error(`${relative} points outside the project`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents)
  }
  for (const script of CODE_LAYER_EXECUTABLES) fs.chmodSync(path.join(root, script), 0o755)
  return Object.keys(packed).length
}

export function archiveCodeLayer(dir, archive) {
  const root = path.resolve(dir)
  if (path.resolve(archive).startsWith(root + path.sep)) throw new Error('the archive must be written outside the project')
  // `-C dir .` archives the contents at the root, dotfiles included, rather than a glob that
  // would leave `.figma` behind.
  // COPYFILE_DISABLE: macOS tar otherwise adds `._*` metadata files beside every file.
  execFileSync('tar', ['-czf', path.resolve(archive), '-C', root, '.'], {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  const listing = execFileSync('tar', ['-tvzf', path.resolve(archive)], { encoding: 'utf8' })
  const links = listing.split('\n').filter((line) => /^[lh]/.test(line))
  if (links.length > 0) throw new Error(`the archive holds links, which the importer refuses:\n${links.join('\n')}`)
  const scripts = listing.split('\n').filter((line) => line.includes('.figma/make/'))
  const notExecutable = scripts.filter((line) => line.startsWith('-') && !line.startsWith('-rwx'))
  if (notExecutable.length > 0) throw new Error(`scripts lost their executable bit:\n${notExecutable.join('\n')}`)
  return fs.statSync(archive).size
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [filesJson, dir, archive] = process.argv.slice(2)
  if (!filesJson || !dir || !archive) {
    console.error('usage: node agent/code-layer.mjs <files.json> <project-dir> <archive>')
    process.exit(2)
  }
  const files = JSON.parse(fs.readFileSync(filesJson, 'utf8'))
  const count = writeCodeLayerProject(files, dir)
  const bytes = archiveCodeLayer(dir, archive)
  console.log(`${count} files → ${dir}\narchive ${archive} (${bytes} bytes)`)
}
