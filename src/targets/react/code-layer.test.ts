import test from 'node:test'
import assert from 'node:assert/strict'
import { asCodeLayer, CODE_LAYER_EXECUTABLES } from './code-layer.ts'

const EXPORT = {
  'package.json': JSON.stringify({
    name: 'figma-export',
    scripts: { dev: 'vite', 'figma:check': 'tsc -p tsconfig.figma.json', 'figma:publish': 'figma connect publish' },
    dependencies: { react: '^18.3.1' },
    devDependencies: { '@figma/code-connect': '^2.0.2', vite: '^5.4.10' },
  }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['src'], exclude: ['src/**/*.figma.ts'] }),
  'vite.config.ts': "export default {}\n",
  'src/main.tsx':
    "import { createRoot } from 'react-dom/client'\nimport './global.css'\nimport { Settings } from './screens/Settings'\n\n" +
    "createRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <Settings />\n  </StrictMode>\n)\n",
  'src/screens/Settings.tsx': 'export function Settings() { return null }\n',
  'src/components/Button.tsx': 'export function Button() { return null }\n',
  'src/components/Button.figma.ts': '// template\n',
  'figma.config.json': '{}\n',
  'tsconfig.figma.json': '{}\n',
}

test('the export becomes a code-layer project: the four scripts, App.tsx, and no Code Connect', () => {
  const out = asCodeLayer(EXPORT)
  for (const script of CODE_LAYER_EXECUTABLES) assert.match(out[script], /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/)
  // The dev server is the process itself, on Figma's port, or the supervisor cannot stop it.
  assert.match(out['.figma/make/dev'], /^exec npx vite --port "\$PORT" --host "\$\{FIGMA_DEV_SERVER_HOST:-0\.0\.0\.0\}" --strictPort$/m)
  assert.match(out['.figma/make/deploy'], /\[\[ -d dist \]\]\nfigma make deploy --build-dir dist/)
  assert.match(out['.figma/make/deploy-preview'], /figma make deploy-preview --build-dir dist/)
  assert.equal(out['src/App.tsx'], "import { Settings } from './screens/Settings'\n\nexport default function App() {\n  return <Settings />\n}\n")
  assert.match(out['src/main.tsx'], /import App from '\.\/App'/)
  assert.match(out['src/main.tsx'], /<App \/>/)
  assert.doesNotMatch(out['src/main.tsx'], /Settings/)
  for (const gone of ['src/components/Button.figma.ts', 'figma.config.json', 'tsconfig.figma.json']) assert.equal(out[gone], undefined)
  const pkg = JSON.parse(out['package.json'])
  assert.equal(pkg.name, 'figma-make-app')
  assert.deepEqual(pkg.scripts, { dev: 'vite' })
  assert.equal(pkg.devDependencies['@figma/code-connect'], undefined)
  assert.equal(JSON.parse(out['tsconfig.json']).exclude, undefined)
  assert.match(out['vite.config.ts'], /port: figma \? Number\(process\.env\.PORT\) : 5173/)
  assert.match(out['vite.config.ts'], /FIGMA_PUBLIC_URL/)
  // The design itself is untouched.
  assert.equal(out['src/components/Button.tsx'], EXPORT['src/components/Button.tsx'])
})

test('a screen that takes props is rendered with the mock of what Figma showed', () => {
  const out = asCodeLayer({
    ...EXPORT,
    'src/main.tsx':
      "import { Settings } from './screens/Settings'\nimport { settingsMock } from './screens/Settings.mock'\n\n" +
      "createRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <Settings {...settingsMock} />\n  </StrictMode>\n)\n",
    'src/screens/Settings.mock.ts': "export const settingsMock = { title: 'Settings' }\n",
  })
  assert.equal(
    out['src/App.tsx'],
    "import { Settings } from './screens/Settings'\nimport { settingsMock } from './screens/Settings.mock'\n\n" +
      'export default function App() {\n  return <Settings {...settingsMock} />\n}\n'
  )
  assert.doesNotMatch(out['src/main.tsx'], /settingsMock|Settings/)
  assert.match(out['src/main.tsx'], /<App \/>/)
})
