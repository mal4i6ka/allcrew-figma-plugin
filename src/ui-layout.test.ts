import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

const chrome = CHROME_CANDIDATES.find(existsSync)
const SOURCE = readFileSync(resolve('ui.html'), 'utf8')

const options = {
  target: 'agent',
  scopeMode: 'page',
  modules: { tokens: true, templates: true, i18n: true, animation: true },
  targetOptions: {
    platform: 'django',
    framework: 'bootstrap',
    bootstrapFidelity: 'tokens',
    bootstrapSource: 'assume',
    bootstrapVersion: '5.3',
    djangoScaffold: true,
  },
  tokens: {
    inlinePrimitives: true,
    flattenAliases: false,
    themeAttribute: 'data-theme-name',
    emitJson: true,
    emitScss: false,
    emitModuleFiles: true,
    cssModulesGlobal: true,
    typoExtract: true,
    typoScaleOnly: true,
    typoShorthand: false,
    typoNaming: 'tshirt',
    emitNative: false,
    includeLibraries: false,
    collectionRoles: '',
  },
  i18n: { wrapTranslate: true, sourceLanguage: 'en', languages: '' },
  delivery: { endpoint: '', secret: '', onExport: false },
  agent: { endpoint: '', secret: '', read: false, write: false },
  lint: { maxNestingDepth: 8 },
  docs: { componentDocs: true, componentPreviews: false, previewBudgetMb: 8 },
  themeMerges: { groups: [] },
}

interface LayoutResult {
  target: string
  errors: string[]
  viewWidth: number
  footerHeight: number
}

function injectedUi(width: number, height: number): string {
  const injection = `<script>
+  (function () {
+    var TEST_OPTIONS = ${JSON.stringify(options)}
+    var TARGETS = ['django', 'tauri', 'design-tokens', 'ds-tools', 'agent', 'modules', 'module', 'module-settings', 'sdk-builder', 'settings']
+    function visible(el) {
+      if (!el) return false
+      var style = getComputedStyle(el)
+      var rect = el.getBoundingClientRect()
+      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
+    }
+    function rectOf(el) {
+      var r = el.getBoundingClientRect()
+      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
+    }
+    function intersects(a, b) {
+      return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
+        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
+    }
+    function fail(errors, condition, message) { if (!condition) errors.push(message) }
+    function topCards(view) {
+      return Array.prototype.filter.call(view.querySelectorAll('.card'), function (card) {
+        return visible(card) && !card.parentElement.closest('.card')
+      })
+    }
+    function switchTarget(target) {
+      var close = document.getElementById('close-settings')
+      if (visible(close)) close.click()
+      if (target === 'module' || target === 'module-settings') {
+        PAGE_TARGET = null
+        MODULE_TARGET = 'smoke'
+        modHandleMessage({
+          type: 'MODULE_SCREEN',
+          id: 'smoke',
+          name: 'Responsive module',
+          summary: 'Synthetic module screen for layout coverage.',
+          fields: {},
+          state: {
+            rows: [{ name: 'Alpha', status: 'ready' }, { name: 'Beta', status: 'blocked' }],
+            code: Array(20).fill('const responsive = true').join('\\n'),
+          },
+          screens: {
+            main: [
+              { block: 'heading', text: 'Overview', icon: 'module' },
+              { block: 'text', text: 'A module card with prose and data.' },
+              { block: 'table', from: 'rows', columns: ['name', 'status'] },
+              { block: 'heading', text: 'Logs', icon: 'terminal' },
+              { block: 'code', from: 'code' },
+              { block: 'button', label: 'Run module' },
+            ],
+            settings: [
+              { block: 'heading', text: 'Preferences', icon: 'settings' },
+              { block: 'text', text: 'Module settings remain inside the shared settings layout.' },
+              { block: 'value', bind: 'code', label: 'Current code' },
+            ],
+          },
+        })
+        show(target === 'module-settings' ? 'settings' : 'main')
+        return
+      }
+      if (target === 'settings') {
+        MODULE_TARGET = null
+        PAGE_TARGET = null
+        document.getElementById('open-settings').click()
+        document.getElementById('update-banner').classList.remove('hidden')
+        return
+      }
+      var select = document.getElementById('target-select')
+      select.value = target
+      select.dispatchEvent(new Event('change', { bubbles: true }))
+      if (target === 'django' || target === 'tauri') document.getElementById('video-attach-panel').style.display = 'flex'
+      if (target === 'ds-tools') {
+        document.getElementById('dt-genTypoCard').classList.add('hidden')
+        document.getElementById('dt-genBpCard').classList.remove('hidden')
+      }
+      if (target === 'agent') {
+        document.getElementById('agent-skill').textContent = Array(80).fill('skill line with a command and context').join('\\n')
+      }
+    }
+    function inspect(target) {
+      var errors = []
+      var view = document.querySelector('.view:not(.hidden)')
+      var main = document.querySelector('main')
+      var footer = document.querySelector('footer')
+      fail(errors, !!view, 'no visible view')
+      if (!view) return { target: target, errors: errors, viewWidth: 0, footerHeight: 0 }
+      var vr = rectOf(view)
+      var mr = rectOf(main)
+      fail(errors, vr.left >= mr.left - 1 && vr.right <= mr.right + 1, 'view escapes main horizontally')
+      fail(errors, vr.width <= Math.min(1200, innerWidth) + 1, 'workspace exceeds 1200 px cap')
+      fail(errors, document.documentElement.scrollWidth <= innerWidth + 1, 'document has horizontal overflow')
+      fail(errors, main.scrollWidth <= main.clientWidth + 1, 'main has horizontal overflow')
+
+      var cards = topCards(view)
+      cards.forEach(function (card, index) {
+        var r = rectOf(card)
+        fail(errors, r.left >= vr.left - 1 && r.right <= vr.right + 1, 'card ' + index + ' escapes view')
+        fail(errors, r.width > 0 && r.height > 0, 'card ' + index + ' has no size')
+      })
+      for (var i = 0; i < cards.length; i++) for (var j = i + 1; j < cards.length; j++) {
+        fail(errors, !intersects(rectOf(cards[i]), rectOf(cards[j])), 'cards ' + i + ' and ' + j + ' overlap')
+      }
+
+      Array.prototype.forEach.call(document.querySelectorAll('button, input, select, textarea'), function (control) {
+        if (!visible(control) || control.type === 'file') return
+        var r = rectOf(control)
+        fail(errors, r.left >= -1 && r.right <= innerWidth + 1, (control.id || control.tagName) + ' escapes viewport')
+      })
+
+      var handle = document.getElementById('ui-resize')
+      var hr = rectOf(handle)
+      var fr = rectOf(footer)
+      fail(errors, Math.abs(hr.width - 24) < 1 && Math.abs(hr.height - 24) < 1, 'resize handle is not 24 px')
+      fail(errors, hr.left >= fr.left - 1 && hr.right <= fr.right + 1 && hr.bottom <= fr.bottom + 1, 'resize handle escapes footer')
+
+      var expectedFooter = target === 'django' || target === 'tauri' || target === 'design-tokens' ? 119 : target === 'ds-tools' ? 71 : 24
+      fail(errors, Math.abs(fr.height - expectedFooter) < 1.5, 'wrong footer height: ' + fr.height + ' expected ' + expectedFooter)
+
+      if (target === 'agent') {
+        var status = rectOf(document.querySelector('.agent-status-card'))
+        var bridge = rectOf(document.querySelector('.agent-bridge-card'))
+        var skill = rectOf(document.querySelector('.agent-skill-card'))
+        fail(errors, bridge.top >= status.bottom - 1 && bridge.top - status.bottom <= 22, 'Agent setup lane contains a vertical hole')
+        if (innerWidth >= 720) {
+          fail(errors, status.left === bridge.left, 'Agent setup cards are not in one lane')
+          fail(errors, skill.left > status.left + 20, 'Agent skill did not move to the second lane')
+          fail(errors, Math.abs(skill.top - status.top) < 2, 'Agent lanes do not start together')
+        } else {
+          fail(errors, skill.top >= bridge.bottom - 1, 'compact Agent view is not stacked')
+        }
+        fail(errors, document.querySelector('.agent-skill-content').getBoundingClientRect().height <= 521, 'Agent skill pane exceeds cap')
+      }
+
+      if (target === 'ds-tools') {
+        var generator = rectOf(document.getElementById('dt-genBpCard'))
+        if (innerWidth >= 720) fail(errors, generator.width <= 561, 'single DS generator exceeds 560 px cap')
+        fail(errors, rectOf(document.getElementById('pal-card')).width <= vr.width + 1, 'palette card escapes workspace')
+      }
+
+      if (target === 'django' || target === 'tauri') {
+        var scope = rectOf(document.getElementById('scope-panel'))
+        var regeneration = rectOf(document.getElementById('regeneration-panel'))
+        var lint = rectOf(document.getElementById('lint-report'))
+        var i18n = rectOf(document.getElementById('i18n-panel-wrapper'))
+        if (innerWidth < 720) {
+          fail(errors, Math.abs(scope.left - lint.left) < 2 && Math.abs(lint.left - i18n.left) < 2 && Math.abs(i18n.left - regeneration.left) < 2, 'stack mode has multiple columns')
+        } else {
+          fail(errors, lint.left > scope.right + 10, 'export lanes overlap or did not split')
+          fail(errors, Math.abs(scope.left - regeneration.left) < 2, 'setup cards are not in one lane')
+          fail(errors, regeneration.top >= scope.bottom - 1 && regeneration.top - scope.bottom <= 18, 'setup lane contains a vertical hole')
+          fail(errors, Math.abs(lint.left - i18n.left) < 2, 'review cards are not in one lane')
+          fail(errors, i18n.top >= lint.bottom - 1 && i18n.top - lint.bottom <= 18, 'review lane contains a vertical hole')
+          fail(errors, Math.abs(scope.width - lint.width) < 2, 'export lanes have unequal widths')
+        }
+      }
+
+      return { target: target, errors: errors, viewWidth: vr.width, footerHeight: fr.height }
+    }
+    ;(function () {
+      var results = []
+      try {
+        onmessage({ data: { pluginMessage: { type: 'EXPORT_OPTIONS', options: TEST_OPTIONS, presets: [], userPresets: [] } } })
+        onmessage({ data: { pluginMessage: { type: 'UPDATE_PREFERENCES', preferences: { automatic: false, lastCheckedAt: 0, latestVersion: '', releaseUrl: '', downloadUrl: '' } } } })
+        for (var i = 0; i < TARGETS.length; i++) {
+          switchTarget(TARGETS[i])
+          results.push(inspect(TARGETS[i]))
+        }
+        document.documentElement.classList.add('browser-mirror')
+        if (visible(document.getElementById('ui-resize'))) results.push({ target: 'browser-mirror', errors: ['resize handle visible in browser mirror'], viewWidth: 0, footerHeight: 0 })
+      } catch (error) {
+        results.push({ target: 'runner', errors: [String(error && error.stack ? error.stack : error)], viewWidth: 0, footerHeight: 0 })
+      }
+      document.documentElement.setAttribute('data-layout-results', encodeURIComponent(JSON.stringify(results)))
+    })()
+  })()
+  </script>`
  return SOURCE.replace('</body>', injection.replace(/^\+/gm, '') + '\n</body>')
}

function runLayout(width: number, height: number): LayoutResult[] {
  assert.ok(chrome)
  const dir = mkdtempSync(join(tmpdir(), 'allcrew-ui-layout-'))
  const file = join(dir, 'ui.html')
  writeFileSync(file, injectedUi(width, height))
  try {
    const linuxSandboxArgs = process.platform === 'linux'
      ? ['--no-sandbox', '--disable-dev-shm-usage']
      : []
    const browser = spawnSync(chrome, [
      '--headless=new',
      ...linuxSandboxArgs,
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--force-device-scale-factor=1',
      `--window-size=${width},${height}`,
      '--dump-dom',
      `file://${file}`,
    ], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
    if (browser.error) throw browser.error
    const html = browser.stdout
    const match = /data-layout-results="([^"]+)"/.exec(html)
    assert.ok(match, `Chromium produced no layout results at ${width}×${height} (exit ${browser.status})\n${browser.stderr.slice(-2000)}\n${html.slice(-2000)}`)
    return JSON.parse(decodeURIComponent(match[1])) as LayoutResult[]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const VIEWPORTS = [
  [340, 660],
  [719, 900],
  [720, 900],
  [1079, 900],
  [1080, 900],
  [1240, 1200],
] as const

test('every plugin screen stays inside stack and split viewports', { skip: !chrome }, () => {
  const failures: string[] = []
  for (const [width, height] of VIEWPORTS) {
    for (const result of runLayout(width, height)) {
      for (const error of result.errors) failures.push(`${width}×${height} ${result.target}: ${error}`)
    }
  }
  assert.deepEqual(failures, [])
})
