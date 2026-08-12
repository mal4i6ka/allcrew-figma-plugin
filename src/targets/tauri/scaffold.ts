/**
 * Tauri v2 project scaffold — the `src-tauri/` shell around the static frontend the renderer
 * produced. Mirrors the `create-tauri-app` vanilla template shape (research: tauri.app
 * /start/create-project/, /reference/config/, Aug 2026): static `src/` served straight from
 * `frontendDist` with `withGlobalTauri`, no bundler, no dev server.
 */

export interface TauriScaffoldOptions {
  /** Product name — the Figma file name, verbatim. */
  productName: string
  /** Path-safe slug of the product name (crate/package naming). */
  slug: string
  /** Initial window size — the flow-start page's frame dimensions. */
  window: { width: number; height: number }
  /** Written into README: assets the Figma API could not export (videos attached manually). */
  manualAssetNotes?: readonly string[]
  /** Written into README: whether animations.js links GSAP from CDN. */
  usesGsapCdn?: boolean
}

/** Reverse-domain identifier; `.app` TLD-style suffix collisions don't matter for local builds. */
function identifierFor(slug: string): string {
  return `com.figma-export.${slug || 'app'}`
}

/** Crate names must be [a-z0-9_-]; keep it simple and lowercase. */
function crateNameFor(slug: string): string {
  const name = slug.replace(/-/g, '_').replace(/[^a-z0-9_]/g, '')
  return name || 'app'
}

function tauriConfJson(opts: TauriScaffoldOptions): string {
  const conf = {
    $schema: 'https://schema.tauri.app/config/2',
    productName: opts.productName,
    version: '0.1.0',
    identifier: identifierFor(opts.slug),
    build: {
      // The static frontend the renderer emitted — no dev server, no beforeDevCommand.
      frontendDist: '../src',
    },
    app: {
      // window.__TAURI__ without an npm bundler — the vanilla-template shape.
      withGlobalTauri: true,
      windows: [
        {
          label: 'main',
          title: opts.productName,
          width: Math.max(200, Math.round(opts.window.width)),
          height: Math.max(200, Math.round(opts.window.height)),
          resizable: true,
        },
      ],
      security: {
        // Fonts come from Google Fonts, GSAP (when Motion timelines exported) from jsdelivr —
        // both remote. Everything else is app-origin. Tighten to taste.
        csp: null as string | null,
      },
    },
    bundle: {
      active: true,
      targets: 'all',
      icon: ['icons/32x32.png', 'icons/128x128.png', 'icons/128x128@2x.png', 'icons/icon.icns', 'icons/icon.ico'],
    },
  }
  return JSON.stringify(conf, null, 2) + '\n'
}

function cargoToml(opts: TauriScaffoldOptions): string {
  const crate = crateNameFor(opts.slug)
  return `[package]
name = "${crate}"
version = "0.1.0"
description = "${opts.productName.replace(/"/g, '\\"')} — exported from Figma"
edition = "2021"

[lib]
name = "${crate}_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
`
}

function libRs(): string {
  return `#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`
}

function mainRs(opts: TauriScaffoldOptions): string {
  return `// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ${crateNameFor(opts.slug)}_lib::run()
}
`
}

function capabilitiesJson(): string {
  return (
    JSON.stringify(
      {
        $schema: '../gen/schemas/desktop-schema.json',
        identifier: 'default',
        description: 'Default capability for the main window.',
        windows: ['main'],
        permissions: ['core:default'],
      },
      null,
      2
    ) + '\n'
  )
}

function packageJson(opts: TauriScaffoldOptions): string {
  return (
    JSON.stringify(
      {
        name: opts.slug || 'figma-export',
        private: true,
        version: '0.1.0',
        scripts: { tauri: 'tauri', dev: 'tauri dev', build: 'tauri build' },
        devDependencies: { '@tauri-apps/cli': '^2' },
      },
      null,
      2
    ) + '\n'
  )
}

function gitignore(): string {
  return `node_modules/
src-tauri/target/
src-tauri/gen/schemas/
`
}

function readme(opts: TauriScaffoldOptions): string {
  const manualAssets =
    opts.manualAssetNotes && opts.manualAssetNotes.length > 0
      ? `\n## Manual assets\n\nThe Figma API refused to export these video files — drop them at the listed paths (the markup already references them):\n\n${opts.manualAssetNotes.map((path) => `- \`src/${path}\``).join('\n')}\n`
      : ''
  const gsap = opts.usesGsapCdn
    ? '\n- Motion timelines exported as GSAP animations load the GSAP runtime from the jsdelivr CDN (see `src/*.html`). For a fully offline app, download the files into `src/assets/vendor/gsap/` and update the script tags.\n'
    : ''
  return `# ${opts.productName}

A Tauri v2 desktop app exported from Figma. The frontend in \`src/\` is plain static
HTML/CSS/JS — no bundler, no framework — served straight from \`frontendDist\`.

## Run

\`\`\`
npm install
npm run dev
\`\`\`

(or \`cargo tauri dev\` with [tauri-cli](https://tauri.app/reference/cli/) installed.)

Prerequisites: Rust + the Tauri v2 system deps — https://tauri.app/start/prerequisites/

## Build

\`\`\`
npm run tauri icon path/to/app-icon.png   # generate src-tauri/icons/ (1024×1024 PNG in)
npm run build
\`\`\`

## Notes

- Pages map 1:1 to exported Figma frames; prototype NAVIGATE reactions are real links between
  them. Animated transitions use the cross-document View Transitions API where the WebView
  supports it (WebView2 always; WKWebView on macOS 15+) and fall back to instant navigation.
- Hover/press variant interactions ship as CSS in \`src/assets/css/interactions.css\`; overlay
  frames are \`<dialog>\` elements wired by \`src/assets/js/interactions.js\`.
- Fonts are linked from Google Fonts (font binaries cannot leave Figma through the Plugin API).
  For a fully offline app, self-host the WOFF2 files in \`src/assets/fonts/\` and swap the links.
${gsap}${manualAssets}`
}

/** Builds every scaffold file, keyed by its path in the export tree. */
export function buildTauriScaffold(opts: TauriScaffoldOptions): Record<string, string> {
  return {
    'src-tauri/tauri.conf.json': tauriConfJson(opts),
    'src-tauri/Cargo.toml': cargoToml(opts),
    'src-tauri/build.rs': 'fn main() {\n    tauri_build::build()\n}\n',
    'src-tauri/src/lib.rs': libRs(),
    'src-tauri/src/main.rs': mainRs(opts),
    'src-tauri/capabilities/default.json': capabilitiesJson(),
    'package.json': packageJson(opts),
    '.gitignore': gitignore(),
    'README.md': readme(opts),
  }
}
