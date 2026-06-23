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
3. **Download package (.zip)** — or grab any single file. **Rescan** after you
   edit variables.

## What you get

| File | Contents |
|------|----------|
| `tokens.css` | CSS custom properties. **One self-contained block per theme.** |
| `tokens.json` | Canonical W3C token tree — every mode under `$extensions.modes`, source collection under `$extensions.figma`. For diffing / re-import. |
| `tokens.ts` | Typed `tokens` object (values are `var(--…)` refs) + a `themes` list and `Theme` type. |
| `README.md` | Auto-generated usage notes for that specific export. |

### tokens.css shape

Every **mode** becomes one self-contained block declaring **all** variables for
that theme — primitives (constant) folded in alongside the semantic tokens, so
`var(--…)` aliases always resolve. The default theme also occupies `:root`, so an
un-themed page still renders.

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

/* add a "Dark" mode to the collection in Figma → a second full block appears */
[data-theme-name="Dark"] {
  /* …all variables again, dark values… */
}
```

Switch theme by setting the attribute on any ancestor:

```html
<html data-theme-name="Dark">
```

## Notes

- **Themes = the modes of your semantic (alias-bearing) collection.** A raw
  primitives collection with a single placeholder mode (e.g. `Mode 1`) is *not*
  treated as a theme; its values fold into every theme block.
- **Offline / private:** `manifest.json` declares no network access. Fonts
  (Museo Sans, Geist Mono) are embedded in `ui.html`.
- **Selector:** this plugin emits `[data-theme-name="…"]` (per spec). The Altery
  board emits `[data-theme="…"]`; the token values are otherwise identical.

## Maintenance

The transform in `code.js` is a dependency-free port of the Altery board's
`src/lib/figma.ts` (`variablesToW3CMultiMode`) + `src/lib/design-system/tokens-transform.ts`.
Output is byte-identical to the board **except** the theme-selector attribute
(`data-theme-name` here vs `data-theme` on the board). Keep the two in sync if the
token format changes.

Files:

```
manifest.json   plugin manifest (Figma)
code.js         sandbox: reads variables → builds the token package
ui.html         the panel UI (styles, fonts, preview, zip download — all inlined)
```
