/**
 * The React export, packed the way Figma's code layers take a project.
 *
 * A code layer (open beta, October 2026) is a Figma Make project on a Design canvas, and Figma's
 * MCP imports one from a local project archive (`send_code_to_figma`). Its contract for anything
 * with a package.json is four executable scripts under `.figma/make/` — install, dev,
 * deploy-preview, deploy — and a dev server that answers on `$PORT`. The export is already a Vite
 * project; what it lacks is those scripts, a server that obeys Figma's port, and the `src/App.tsx`
 * every Make project starts from. So the code a code layer runs is the code the design system
 * exports — the tokens as variables, the components as components — rather than whatever Figma's
 * agent would generate from a picture of the frame.
 *
 * The scripts are text here. Their executable bit is set where the files reach a disk — see
 * `CODE_LAYER_EXECUTABLES` and `agent/code-layer.mjs`.
 */

/** The files that must be executable for the importer to accept the archive. */
export const CODE_LAYER_EXECUTABLES = [
  '.figma/make/install',
  '.figma/make/dev',
  '.figma/make/deploy-preview',
  '.figma/make/deploy',
] as const

const SHEBANG = '#!/usr/bin/env bash\nset -euo pipefail\n'

/** Which screen the project opens on: the one `src/main.tsx` renders, else the first one. */
function screenOf(files: Readonly<Record<string, string>>): string | null {
  const rendered = /import \{ (\w+) \} from '\.\/screens\/\1'/.exec(files['src/main.tsx'] ?? '')
  if (rendered) return rendered[1]
  const first = Object.keys(files)
    .filter((path) => /^src\/screens\/\w+\.tsx$/.test(path))
    .sort()[0]
  return first ? first.slice('src/screens/'.length, -'.tsx'.length) : null
}

export function asCodeLayer(files: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [path, contents] of Object.entries(files)) {
    // Code Connect is a publishing step for a repository, not something a canvas prototype runs:
    // its templates import a module only that CLI declares, and the layer would fail to build.
    if (path.endsWith('.figma.ts') || path === 'figma.config.json' || path === 'tsconfig.figma.json') continue
    out[path] = contents
  }

  if (out['package.json']) {
    const pkg = JSON.parse(out['package.json']) as { name?: string; scripts?: Record<string, string>; devDependencies?: Record<string, string> }
    pkg.name = 'figma-make-app'
    if (pkg.scripts) {
      for (const key of Object.keys(pkg.scripts)) if (key.startsWith('figma:')) delete pkg.scripts[key]
    }
    if (pkg.devDependencies) delete pkg.devDependencies['@figma/code-connect']
    out['package.json'] = `${JSON.stringify(pkg, null, 2)}\n`
  }
  if (out['tsconfig.json']) {
    const tsconfig = JSON.parse(out['tsconfig.json']) as { exclude?: string[] }
    delete tsconfig.exclude
    out['tsconfig.json'] = `${JSON.stringify(tsconfig, null, 2)}\n`
  }

  // Figma's runtime hands the port, the host and the public base; outside Figma the project
  // behaves exactly as the export always did.
  out['vite.config.ts'] =
    `import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\n\n` +
    `const figma = Boolean(process.env.FIGMA)\n\n` +
    `export default defineConfig({\n` +
    `  plugins: [react()],\n` +
    `  base: process.env.FIGMA_PUBLIC_URL ? \`\${process.env.FIGMA_PUBLIC_URL}/\` : '/',\n` +
    `  server: {\n` +
    `    port: figma ? Number(process.env.PORT) : 5173,\n` +
    `    host: figma ? process.env.FIGMA_DEV_SERVER_HOST || '0.0.0.0' : undefined,\n` +
    `    strictPort: figma,\n` +
    `  },\n` +
    `})\n`

  // Every Make project starts at App.tsx — it is where Figma's own reader of a code layer says to
  // begin — so the screen is rendered from there and main.tsx renders App.
  const screen = screenOf(out)
  if (screen && out['src/main.tsx']) {
    // The screen with what Figma showed, when it takes props — the mock is where that lives.
    const mock = `${screen.charAt(0).toLowerCase()}${screen.slice(1)}Mock`
    const hasMock = `src/screens/${screen}.mock.ts` in out
    out['src/App.tsx'] =
      `import { ${screen} } from './screens/${screen}'\n` +
      (hasMock ? `import { ${mock} } from './screens/${screen}.mock'\n` : '') +
      `\nexport default function App() {\n  return <${screen}${hasMock ? ` {...${mock}}` : ''} />\n}\n`
    out['src/main.tsx'] = out['src/main.tsx']
      .replace(`import { ${screen} } from './screens/${screen}'\n`, `import App from './App'\n`)
      .replace(`import { ${mock} } from './screens/${screen}.mock'\n`, '')
      .replace(/<\w+(?: \{\.\.\.\w+\})? \/>/, '<App />')
  }

  // No lockfile travels with an export, so the install cannot be `npm ci`.
  out['.figma/make/install'] = `${SHEBANG}npm install --no-audit --no-fund\n`
  out['.figma/make/dev'] =
    `${SHEBANG}exec npx vite --port "$PORT" --host "\${FIGMA_DEV_SERVER_HOST:-0.0.0.0}" --strictPort\n`
  out['.figma/make/deploy-preview'] =
    `${SHEBANG}npx vite build --mode development\n[[ -d dist ]]\nfigma make deploy-preview --build-dir dist\n`
  out['.figma/make/deploy'] = `${SHEBANG}npx vite build\n[[ -d dist ]]\nfigma make deploy --build-dir dist\n`
  return out
}
