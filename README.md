# Altery Design System Export

A self-contained Figma plugin that exports the current file's **local variables**
as a design-token package — mode-aware CSS, JSON and TypeScript — ready to drop
into a frontend.

It reads variables **in-editor via the Figma Plugin API**, so it works on **any
Figma plan** (no Enterprise Variables REST access, no server, no network).

---

## Install (development plugin)

1. In Figma desktop: **Menu → Plugins → Development → Import plugin from manifest…**
2. Pick `manifest.json` from this folder.
3. The plugin now shows under **Plugins → Development → Altery Design System Export**.

No build step — `code.js` and `ui.html` are ready to run as-is.

## Use

1. Open the Figma file that holds your design-system variables & collections.
2. Run the plugin. It scans automatically and shows a summary:
   collections, modes (themes) and variable counts.
3. Click **⚙Settings** (top-right) to open the settings page and tune the
   output (see below). Choices persist per-user via `figma.clientStorage` and
   re-apply on every run.
4. **Download package (.zip)** — or grab any single file. **Rescan** after you
   edit variables.

## What you get

| File | Contents |
|------|----------|
| `tokens.css` | CSS custom properties. **One self-contained block per theme.** The merged single file. |
| `<theme>.module.css` | The same blocks split **one CSS Module per theme** (`light.module.css`, `dark.module.css`, …), wrapped in `:global(…)`. Merged by your bundler (which strips `:global`), they're equivalent to `tokens.css`. |
| `tokens.json` | Canonical W3C token tree — every mode under `$extensions.modes`, source collection under `$extensions.figma`. For diffing / re-import. |
| `tokens.ts` | Typed `tokens` object (values are `var(--…)` refs) + a `themes` list and `Theme` type. |
| `README.md` | Auto-generated usage notes for that specific export. |

##Settings

The **Export Settings** page (open it from the gear in the header) isolates the
opinionated parts of the output so different consumers can keep their own
preferences (the choices persist per-user):

| Setting | Default | What it does |
|---------|---------|--------------|
| **Inline primitives** | on | Resolves aliases that point at a *primitive* (raw, single-mode value) into the literal, and drops the primitive layer. Aliases **between semantic tokens** stay as `var(--…)`. |
| **Flatten all aliases** | off | With Inline primitives on, also resolves the *semantic→semantic* `var(--…)` refs into literals, so **no** references remain in the output. Off keeps the readable, themeable semantic layer. |
| **Theme attribute** | `data-theme-name` | The attribute the theme blocks key off (`[<attr>="Dark"]`). Set it to `data-theme` to match the Altery board, or anything else. |
| **Per-theme `.module.css`** | on | Whether to emit the per-theme module files alongside `tokens.css`. |
| **CSS Modules `:global()`** | on | Wrap module-file selectors in `:global(…)` (valid CSS Modules) or leave them plain. |

### tokens.css shape

Every **mode** becomes one self-contained block declaring **all** variables for
that theme. The default theme also occupies `:root`, so an un-themed page still
renders.

With **Inline primitives** on (the default), the raw scale is collapsed into the
tokens that use it — no primitive variables in the output:

```css
:root,
[data-theme-name="Light"] {
  /* Tokens */
  --colors-action-default: #002780;
  --spacing-md: 8px;
}

/* add a "Dark" mode to the collection in Figma → a second full block appears */
[data-theme-name="Dark"] {
  /* …all variables again, dark values… */
}
```

Turn it **off** to keep the primitive layer and reference it via aliases instead
(byte-identical to the Altery board, modulo the attribute name):

```css
:root,
[data-theme-name="Light"] {
  /* Primitives */
  --colors-b-800: #002780;
  --sizes-1: 8px;
  /* Tokens */
  --colors-action-default: var(--colors-b-800);
  --spacing-md: var(--sizes-1);
}
```

> A primitive used **directly in code** (not via an alias) can't be detected by the
> plugin — it will be inlined away. Turn Inline primitives off if you rely on the
> raw scale at call sites.

Switch theme by setting the attribute on any ancestor:

```html
<html data-theme-name="Dark">
```

### Per-theme `<theme>.module.css`

The same theme blocks are also emitted one file per theme, named after the mode
(`light.module.css`, `dark.module.css`, … — slugified), wrapped in `:global(…)`
so they're valid in a CSS-Modules project (Next.js, etc.):

```css
/* light.module.css */
:global(:root),
:global([data-theme-name="Light"]) {
  --colors-action-default: var(--colors-b-800);
  --spacing-md: var(--sizes-1);
}
```

The default theme also lands on `:global(:root)`. Concatenating every
`*.module.css` (or letting your bundler merge the ones you import) reproduces
`tokens.css` — that's the "merged single file". For **runtime** theme-switching,
keep every theme present (use `tokens.css`, or import all `*.module.css`) and
toggle `data-theme-name`.

## Notes

- **Themes = the modes of your semantic (alias-bearing) collection.** A raw
  primitives collection with a single placeholder mode (e.g. `Mode 1`) is *not*
  treated as a theme; its values fold into every theme block.
- **Offline / private:** `manifest.json` declares no network access. Fonts
  (Museo Sans, Geist Mono) are embedded in `ui.html`.
- **Editors & plan:** runs in both **Figma Design** and **Dev Mode**
  (`editorType: ["figma", "dev"]`, `capabilities: ["inspect"]`). It reads variables
  through the in-editor Plugin API, so **no Enterprise / Variables REST API is
  required — it works on any plan**, including Organization. Dev Mode itself is gated
  by Figma to a **Dev or Full seat** (no manifest setting bypasses that); anyone with
  a normal editor seat can still run it in **Design mode** with no extra cost.
- **Selector:** defaults to `[data-theme-name="…"]` (per spec) but is configurable
  in **Export settings** — set it to `data-theme` to match the Altery board.
- **`tokens.json` is always the full, un-inlined tree** regardless of the Inline
  primitives setting, so it stays lossless for diffing / re-import.

## Maintenance

The transform in `code.js` is a dependency-free port of the Altery board's
`src/lib/figma.ts` (`variablesToW3CMultiMode`) + `src/lib/design-system/tokens-transform.ts`.
With **Inline primitives off** and the **theme attribute** set to `data-theme`, the
output is byte-identical to the board. The export options layer on top of that core
transform; keep the core in sync with the board if the token format changes.

Files:

```
manifest.json   plugin manifest (Figma)
code.js         sandbox: reads variables → builds the token package
ui.html         the panel UI (styles, fonts, preview, zip download — all inlined)
```
