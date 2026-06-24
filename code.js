/* Altery Design System Export — plugin sandbox (main thread).
 *
 * Reads the file's LOCAL variables + collections via the Figma Plugin API
 * (any plan, in-editor — no Enterprise REST, no server) and builds a design-token
 * package: tokens.css (self-contained per-theme blocks), one <theme>.module.css per
 * theme (CSS Modules), tokens.json (canonical W3C tree), tokens.ts (typed var refs +
 * theme list) and a README.
 *
 * The output is shaped by an isolated, user-persisted options object (see
 * DEFAULT_OPTIONS / buildPackage): inlinePrimitives (resolve alias→primitive to a
 * literal and drop the primitive layer), themeAttr (theme-switch attribute name),
 * emitModuleFiles, and cssModulesGlobal (`:global(…)` wrapping). tokens.json is always
 * the full, un-inlined tree.
 *
 * The core transform is a DEPENDENCY-FREE port of the board's src/lib/figma.ts
 * (variablesToW3CMultiMode) + src/lib/design-system/tokens-transform.ts. With
 * `inlinePrimitives: false` + `themeAttr: "data-theme"` the output matches the board
 * EXACTLY; the options layer on top. Keep the core in sync if the token format
 * changes. Pure functions are top-level (Node-verifiable); the Figma glue is guarded
 * by `typeof figma`.
 */

/* ------------------------------------------------------------------ helpers */

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function slugSegments(name) {
  return String(name)
    .trim()
    .replace(/^--/, "")
    .split(/[/.\s_-]+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function groupSegments(name) {
  return String(name)
    .trim()
    .replace(/^--/, "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
}

function figmaColorToCss(value) {
  const r = value.r, g = value.g, b = value.b;
  if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") return value;
  const a = typeof value.a === "number" ? value.a : 1;
  const toByte = (n) => Math.max(0, Math.min(255, Math.round(n * 255)));
  const hex = [toByte(r), toByte(g), toByte(b)].map((n) => n.toString(16).padStart(2, "0")).join("");
  if (a >= 1) return "#" + hex;
  return `rgba(${toByte(r)}, ${toByte(g)}, ${toByte(b)}, ${Number(a.toFixed(3))})`;
}

function figmaTypeToW3C(type, value) {
  const n = typeof type === "string" ? type.toUpperCase() : "";
  if (n === "COLOR") return "color";
  if (n === "FLOAT" || n === "NUMBER") return "number";
  if (n === "BOOLEAN") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string" && /^#|rgb\(|hsl\(/i.test(value.trim())) return "color";
  return "string";
}

function normalizeVariableValue(value, idToName) {
  if (isRecord(value) && "type" in value && value.type === "VARIABLE_ALIAS") {
    const id = typeof value.id === "string" ? value.id : "";
    const name = idToName ? idToName.get(id) : undefined;
    return name ? `{${name}}` : `{${id}}`;
  }
  if (isRecord(value) && "r" in value && "g" in value && "b" in value) return figmaColorToCss(value);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return isRecord(value) ? value : String(value != null ? value : "");
}

function setToken(root, path, token) {
  let cursor = root;
  for (const segment of path.slice(0, -1)) {
    const existing = cursor[segment];
    if (!isRecord(existing) || "$value" in existing) cursor[segment] = {};
    cursor = cursor[segment];
  }
  const leaf = path[path.length - 1];
  if (leaf) cursor[leaf] = token;
}

/** Collision-guarded canonical W3C path per variable (sorted by collection→name→id). */
function resolveCanonicalPaths(variables, collectionById) {
  const SEP = "\u0000";
  const natural = (v) => {
    const segs = groupSegments(v.name);
    if (segs.length === 0) return null;
    return segs.length > 1 ? segs : [figmaTypeToW3C(v.resolvedType, undefined), segs[0]];
  };
  const ordered = variables
    .filter((v) => v && typeof v.id === "string" && typeof v.name === "string" && v.name.trim() !== "")
    .map((v) => ({ v, path: natural(v) }))
    .filter((x) => x.path !== null)
    .sort((a, b) => {
      const ca = (collectionById.get(a.v.collectionId) || {}).name || "";
      const cb = (collectionById.get(b.v.collectionId) || {}).name || "";
      return ca.localeCompare(cb) || a.v.name.localeCompare(b.v.name) || a.v.id.localeCompare(b.v.id);
    });
  const claimed = new Set();
  const paths = new Map();
  for (const entry of ordered) {
    const path = entry.path;
    let candidate = path;
    let key = candidate.join(SEP);
    if (claimed.has(key)) {
      const base = path.slice(0, -1);
      const leaf = path[path.length - 1];
      let n = 2;
      do {
        candidate = base.concat([`${leaf}-${n}`]);
        key = candidate.join(SEP);
        n++;
      } while (claimed.has(key));
    }
    claimed.add(key);
    paths.set(entry.v.id, candidate);
  }
  return paths;
}

/** Figma variable graph → W3C token tree preserving every mode + collection identity. */
function variablesToW3CMultiMode(graph) {
  const out = {};
  const collections = Array.isArray(graph && graph.collections) ? graph.collections : [];
  const variables = Array.isArray(graph && graph.variables) ? graph.variables : [];
  const collectionById = new Map();
  for (const c of collections) if (c && typeof c.id === "string") collectionById.set(c.id, c);

  const canonicalPaths = resolveCanonicalPaths(variables, collectionById);
  const idToName = new Map();
  for (const pair of canonicalPaths) idToName.set(pair[0], pair[1].join("."));

  for (const variable of variables) {
    const path = canonicalPaths.get(variable.id);
    if (!path) continue;
    const valuesByMode = isRecord(variable.valuesByMode) ? variable.valuesByMode : {};
    const collection = collectionById.get(variable.collectionId);
    const modes =
      collection && Array.isArray(collection.modes) && collection.modes.length > 0
        ? collection.modes
        : Object.keys(valuesByMode).map((modeId) => ({ modeId, name: modeId }));
    if (modes.length === 0) continue;

    const byMode = {};
    for (const mode of modes) {
      if (!(mode.modeId in valuesByMode)) continue;
      byMode[mode.name] = normalizeVariableValue(valuesByMode[mode.modeId], idToName);
    }

    const defaultModeId =
      collection && typeof collection.defaultModeId === "string" ? collection.defaultModeId : modes[0].modeId;
    const defaultMode = modes.find((m) => m.modeId === defaultModeId) || modes[0];
    const defaultValue = defaultMode.name in byMode ? byMode[defaultMode.name] : Object.values(byMode)[0];
    if (defaultValue === undefined) continue;

    const explicitType = figmaTypeToW3C(variable.resolvedType, defaultValue);
    const collectionName = collection && typeof collection.name === "string" ? collection.name : undefined;
    const $extensions = { modes: byMode };
    if (collectionName) $extensions.figma = { collection: collectionName, defaultMode: defaultMode.name };
    setToken(out, path, { $type: explicitType, $value: defaultValue, $extensions: $extensions });
  }
  return out;
}

/* ---------------------------------------------------- token emitters (CSS/TS/JSON) */

function isTokenLeaf(value) {
  return isRecord(value) && "$value" in value;
}

function leaves(tree, prefix) {
  prefix = prefix || [];
  const out = [];
  for (const key of Object.keys(tree)) {
    const value = tree[key];
    const path = prefix.concat([key]);
    if (isTokenLeaf(value)) out.push({ path: path, token: value });
    else if (isRecord(value)) out.push.apply(out, leaves(value, path));
  }
  return out;
}

function varName(segments) {
  return segments
    .reduce((acc, segment) => acc.concat(slugSegments(segment)), [])
    .map((segment) => segment.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("-");
}

function aliasTarget(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^\{(.+)\}$/);
  if (!match) return null;
  return match[1].split(".").map((p) => p.trim()).filter(Boolean);
}

var UNITLESS_TOKEN = /(^|[-_])(opacity|z-?index|font-?weight|weight|line-?height|lineheight|flex|order|aspect|ratio|scale|count|columns?)([-_]|$)/i;

function cssValue(value, path) {
  const alias = aliasTarget(value);
  if (alias) return `var(--${varName(alias)})`;
  if (typeof value === "number") {
    const unitless = value === 0 || (path ? path.some((seg) => UNITLESS_TOKEN.test(seg)) : false);
    return unitless ? String(value) : `${value}px`;
  }
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return value;
  return String(value != null ? value : "");
}

function isAliasValue(value) {
  return typeof value === "string" && /^\{.+\}$/.test(value);
}

function modesOf(token) {
  const modes = token.$extensions && token.$extensions.modes;
  return isRecord(modes) ? modes : {};
}

function collectionOf(token) {
  const figma = token.$extensions && token.$extensions.figma;
  if (isRecord(figma) && typeof figma.collection === "string") return figma.collection;
  return undefined;
}

function collectionDefaultModeOf(token) {
  const figma = token.$extensions && token.$extensions.figma;
  if (isRecord(figma) && typeof figma.defaultMode === "string") return figma.defaultMode;
  return undefined;
}

function pickDefaultTheme(allLeaves, themes, hint) {
  if (themes.indexOf(hint) !== -1) return hint;
  for (const entry of allLeaves) {
    const def = collectionDefaultModeOf(entry.token);
    if (def && themes.indexOf(def) !== -1) return def;
  }
  return themes[0];
}

/** A token "participates in theming" if it has ≥2 modes or carries an alias in any
 *  mode. The inverse — single-mode, all-literal — is a raw *primitive* (the layer the
 *  "Inline primitives" setting collapses). */
function participatesInTheming(token) {
  const modes = modesOf(token);
  const names = Object.keys(modes);
  return names.length >= 2 || isAliasValue(token.$value) || names.some((n) => isAliasValue(modes[n]));
}

function themeModesOf(allLeaves, hint) {
  const themes = [];
  for (const entry of allLeaves) {
    if (!participatesInTheming(entry.token)) continue;
    const names = Object.keys(modesOf(entry.token));
    for (const name of names) if (themes.indexOf(name) === -1) themes.push(name);
  }
  if (themes.length === 0) {
    const firstModes = allLeaves.length ? Object.keys(modesOf(allLeaves[0].token)) : [];
    themes.push((hint && hint.trim()) || firstModes[0] || "default");
  }
  return themes;
}

function valueForTheme(token, theme) {
  const modes = modesOf(token);
  return theme in modes ? modes[theme] : token.$value;
}

/**
 * "Inline primitives" transform. Returns a NEW token tree where every alias that
 * points at a *primitive* (single-mode, all-literal building block) is replaced by
 * that primitive's literal value, per theme — and the primitive itself is dropped
 * once it has been inlined. Alias references between *semantic* tokens are kept as
 * `{…}` so the semantic layer stays DRY and themeable.
 *
 * A primitive is only dropped if something actually referenced it (so it got
 * inlined somewhere). An *unreferenced* primitive is kept verbatim — it can only be
 * consumed directly, so removing it would lose data. (Caveat: a primitive used
 * directly in code *and* via an alias still gets dropped — the plugin can't see code
 * usage. Turn the setting off if you rely on the raw scale.)
 */
function inlinePrimitivesTree(tree, flattenAll) {
  const all = leaves(tree);
  const byName = new Map(); // canonical dotted path → { path, token }
  for (const e of all) byName.set(e.path.join("."), e);

  const primitive = new Set();
  for (const e of all) if (!participatesInTheming(e.token)) primitive.add(e.path.join("."));

  const referenced = new Set();
  const noteRef = (value) => {
    if (!isAliasValue(value)) return;
    const target = aliasTarget(value).join(".");
    if (primitive.has(target)) referenced.add(target);
  };
  for (const e of all) {
    noteRef(e.token.$value);
    const modes = modesOf(e.token);
    for (const k of Object.keys(modes)) noteRef(modes[k]);
  }

  // Resolve an alias to a literal, per theme. By default only *primitive* targets are
  // inlined (semantic→semantic refs stay as `var(--…)`); with `flattenAll` EVERY alias
  // is resolved so no reference survives. `originPath` is the path the literal was
  // resolved FROM, so numbers are rendered with that path's unit rule — unit-less tokens
  // (line-height, font-weight, opacity…) keep e.g. `1.2`, not `1.2px`. The resulting tree
  // is CSS-facing only (tokens.json uses the source tree; tokens.ts emits var() refs).
  const inline = (value, theme, seen, originPath) => {
    if (!isAliasValue(value)) {
      return originPath && typeof value === "number" ? cssValue(value, originPath) : value;
    }
    const target = aliasTarget(value).join(".");
    if (!byName.has(target) || seen.has(target)) return value; // dangling / cycle
    if (!flattenAll && !primitive.has(target)) return value; // keep semantic→semantic unless flattening
    const entry = byName.get(target);
    const next = new Set(seen);
    next.add(target);
    return inline(valueForTheme(entry.token, theme), theme, next, entry.path);
  };

  const out = {};
  for (const e of all) {
    const name = e.path.join(".");
    if (primitive.has(name)) {
      if (referenced.has(name)) continue; // inlined away
      setToken(out, e.path, e.token); // unreferenced primitive — keep verbatim
      continue;
    }
    const token = e.token;
    const modes = modesOf(token);
    const newModes = {};
    for (const k of Object.keys(modes)) newModes[k] = inline(modes[k], k, new Set());
    const defMode = collectionDefaultModeOf(token);
    const themeForDefault = defMode && defMode in modes ? defMode : Object.keys(modes)[0];
    const newDefault = inline(token.$value, themeForDefault, new Set());
    const $extensions = Object.assign({}, token.$extensions, { modes: newModes });
    setToken(out, e.path, { $type: token.$type, $value: newDefault, $extensions: $extensions });
  }
  return out;
}

function themeDeclarations(allLeaves, theme) {
  const order = [];
  const groups = new Map();
  for (const leaf of allLeaves) {
    const col = collectionOf(leaf.token) || "";
    if (!groups.has(col)) {
      groups.set(col, []);
      order.push(col);
    }
    groups.get(col).push(leaf);
  }
  const labeled = order.some((c) => c !== "");
  const lines = [];
  for (const col of order) {
    if (labeled && col) lines.push(`  /* ${col} */`);
    for (const entry of groups.get(col)) {
      lines.push(`  --${varName(entry.path)}: ${cssValue(valueForTheme(entry.token, theme), entry.path)};`);
    }
  }
  return lines;
}

function orderedThemes(allLeaves, defaultModeName) {
  const themes = themeModesOf(allLeaves, defaultModeName);
  const defaultTheme = pickDefaultTheme(allLeaves, themes, defaultModeName);
  const ordered = [defaultTheme].concat(themes.filter((t) => t !== defaultTheme));
  return { defaultTheme, ordered };
}

function themeBlock(allLeaves, theme, selector) {
  return `${selector} {\n${themeDeclarations(allLeaves, theme).join("\n")}\n}`;
}

/** Escape a theme/mode name for use inside a double-quoted CSS attribute selector
 *  (`[attr="…"]`). Figma mode names may contain `"` or `\`, which would otherwise
 *  terminate or corrupt the selector. */
function cssAttrValue(value) {
  return String(value).replace(/[\\"]/g, "\\$&");
}

/** Combined stylesheet: one plain-CSS block per theme (default also on `:root`).
 *  `attr` is the theme-switch attribute name (e.g. `data-theme-name`). */
function toTokensCss(tree, defaultModeName, attr) {
  const a = attr || "data-theme-name";
  const allLeaves = leaves(tree);
  if (allLeaves.length === 0) return "";
  const { defaultTheme, ordered } = orderedThemes(allLeaves, defaultModeName);
  const blocks = ordered.map((theme) => {
    const themeSel = `[${a}="${cssAttrValue(theme)}"]`;
    const selector = theme === defaultTheme ? `:root,\n${themeSel}` : themeSel;
    return themeBlock(allLeaves, theme, selector);
  });
  return blocks.join("\n\n") + "\n";
}

/** One CSS file per theme. With `useGlobal` the selectors are wrapped in `:global(…)`
 *  (valid CSS Modules); otherwise they're plain. Concatenated, they are `tokens.css`. */
function toThemeModuleCssFiles(tree, defaultModeName, attr, useGlobal) {
  const a = attr || "data-theme-name";
  const wrap = useGlobal ? (sel) => `:global(${sel})` : (sel) => sel;
  const allLeaves = leaves(tree);
  const files = {};
  if (allLeaves.length === 0) return files;
  const { defaultTheme, ordered } = orderedThemes(allLeaves, defaultModeName);
  const used = new Set();
  for (const theme of ordered) {
    const themeSel = wrap(`[${a}="${cssAttrValue(theme)}"]`);
    const selector = theme === defaultTheme ? `${wrap(":root")},\n${themeSel}` : themeSel;
    const base = varName([theme]) || "theme";
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base}-${n++}`;
    used.add(name);
    files[`${name}.module.css`] = themeBlock(allLeaves, theme, selector) + "\n";
  }
  return files;
}

function buildTsTree(allLeaves) {
  const root = {};
  for (const entry of allLeaves) {
    const path = entry.path;
    let cursor = root;
    for (const segment of path.slice(0, -1)) {
      const next = cursor[segment];
      if (typeof next === "string" || next === undefined) cursor[segment] = {};
      cursor = cursor[segment];
    }
    const leaf = path[path.length - 1];
    cursor[leaf] = `var(--${varName(path)})`;
  }
  return root;
}

function renderTsTree(tree, indent) {
  const inner = indent + "  ";
  const entries = Object.keys(tree).map((key) => {
    const value = tree[key];
    const renderedKey = JSON.stringify(key);
    if (typeof value === "string") return `${inner}${renderedKey}: ${JSON.stringify(value)},`;
    return `${inner}${renderedKey}: ${renderTsTree(value, inner)},`;
  });
  return `{\n${entries.join("\n")}\n${indent}}`;
}

function toTokensTs(tree) {
  const allLeaves = leaves(tree);
  const tsTree = buildTsTree(allLeaves);
  const themes = themeModesOf(allLeaves);
  return (
    `export const tokens = ${renderTsTree(tsTree, "")} as const;\n` +
    `export type Tokens = typeof tokens;\n\n` +
    `export const themes = ${JSON.stringify(themes)} as const;\n` +
    `export type Theme = (typeof themes)[number];\n`
  );
}

function toTokensJson(tree) {
  return JSON.stringify(tree, null, 2) + "\n";
}

/* ------------------------------------------------------------- export options */

var DEFAULT_OPTIONS = {
  inlinePrimitives: true, // resolve alias→primitive to a literal, drop the primitive layer
  flattenAliases: false, // (with inlinePrimitives) also resolve semantic→semantic refs — no var() left
  themeAttr: "data-theme-name", // theme-switch attribute (Sergey's spec; board uses `data-theme`)
  emitModuleFiles: true, // emit per-theme `<theme>.module.css`
  cssModulesGlobal: true, // wrap module selectors in `:global(…)` (CSS Modules)
};

function sanitizeAttr(value) {
  const cleaned = typeof value === "string" ? value.trim().replace(/[^A-Za-z0-9_-]/g, "") : "";
  return cleaned || DEFAULT_OPTIONS.themeAttr;
}

function normalizeOptions(o) {
  o = isRecord(o) ? o : {};
  const pick = (key) => (o[key] === undefined ? DEFAULT_OPTIONS[key] : !!o[key]);
  return {
    inlinePrimitives: pick("inlinePrimitives"),
    flattenAliases: pick("flattenAliases"),
    emitModuleFiles: pick("emitModuleFiles"),
    cssModulesGlobal: pick("cssModulesGlobal"),
    themeAttr: sanitizeAttr(o.themeAttr),
  };
}

/** Graph + options → the full token-export package. Pure (Node-verifiable). */
function buildPackage(graph, options) {
  const opts = normalizeOptions(options);
  const sourceTree = variablesToW3CMultiMode(graph);
  const summary = buildSummary(graph, sourceTree);
  const files = {};
  if (summary.tokenCount > 0) {
    const defaultMode = primaryDefaultMode(graph);
    const cssTree = opts.inlinePrimitives ? inlinePrimitivesTree(sourceTree, opts.flattenAliases) : sourceTree;
    files["tokens.css"] = toTokensCss(cssTree, defaultMode, opts.themeAttr);
    if (opts.emitModuleFiles) {
      const themeFiles = toThemeModuleCssFiles(cssTree, defaultMode, opts.themeAttr, opts.cssModulesGlobal);
      for (const name of Object.keys(themeFiles)) files[name] = themeFiles[name];
    }
    files["tokens.json"] = toTokensJson(sourceTree); // always the full, un-inlined tree (lossless)
    files["tokens.ts"] = toTokensTs(cssTree);
    files["README.md"] = buildReadme(summary, opts);
  }
  return { summary: summary, files: files, options: opts };
}

/* ------------------------------------------------------ summary + README (export) */

/** Default-mode name of the first collection that declares one (drives `:root`). */
function primaryDefaultMode(graph) {
  const collections = (graph && graph.collections) || [];
  for (const c of collections) {
    const modes = c.modes || [];
    const mode = modes.find((m) => m.modeId === c.defaultModeId) || modes[0];
    if (mode && mode.name) return mode.name;
  }
  return "default";
}

function buildSummary(graph, tree) {
  const all = leaves(tree);
  const collections = (graph.collections || []).map((c) => ({
    name: c.name,
    modes: (c.modes || []).map((m) => m.name),
    variableCount: (graph.variables || []).filter((v) => v.collectionId === c.id).length,
  }));
  return {
    fileName: graph.fileName || "Untitled",
    collections: collections,
    totalVariables: (graph.variables || []).length,
    tokenCount: all.length,
    themes: themeModesOf(all),
  };
}

function buildReadme(summary, options) {
  const opts = normalizeOptions(options);
  const attr = opts.themeAttr;
  const themeList = summary.themes.map((t) => `\`${t}\``).join(", ");
  const moduleList = summary.themes.map((t) => `\`${varName([t])}.module.css\``).join(", ");
  const collLines = summary.collections
    .map((c) => `- **${c.name}** — ${c.variableCount} variables, modes: ${c.modes.map((m) => `\`${m}\``).join(", ")}`)
    .join("\n");
  const defaultTheme = summary.themes[0] || "Light";
  const others = summary.themes.filter((t) => t !== defaultTheme);
  const switchExample = others.length
    ? `\n\nSwitch theme by setting the attribute on any ancestor (e.g. \`<html>\`):\n\n\`\`\`html\n<html ${attr}="${others[0]}">\n\`\`\``
    : "";

  const rootSel = opts.cssModulesGlobal ? ":global(:root)" : ":root";
  const moduleSel = opts.cssModulesGlobal ? `:global([${attr}="…"])` : `[${attr}="…"]`;
  const moduleRow = opts.emitModuleFiles
    ? `\n| \`<theme>.module.css\` | The same blocks, one file per theme (${moduleList}). Every variable under \`${moduleSel}\` — the default theme also on \`${rootSel}\`. Concatenated, they reproduce \`tokens.css\`. |`
    : "";

  const inlineNote = !opts.inlinePrimitives
    ? "Primitives are emitted as their own variables; semantic tokens reference them with `var(--…)`."
    : opts.flattenAliases
    ? "**Every** alias is resolved to a literal — no `var(--…)` references remain anywhere. `tokens.json` keeps the full, un-inlined tree for re-import."
    : "Primitive (raw, single-mode) values are **inlined** into the semantic tokens that use them, so the primitive layer doesn't appear as its own variables. References between semantic tokens stay as `var(--…)`. `tokens.json` keeps the full, un-inlined tree for re-import.";

  const settingsLine = [
    `inline primitives \`${opts.inlinePrimitives ? "on" : "off"}\``,
    opts.inlinePrimitives ? `flatten all \`${opts.flattenAliases ? "on" : "off"}\`` : null,
    `theme attribute \`${attr}\``,
    `per-theme modules \`${opts.emitModuleFiles ? "on" : "off"}\``,
    opts.emitModuleFiles ? `\`:global()\` \`${opts.cssModulesGlobal ? "on" : "off"}\`` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const moduleSection = opts.emitModuleFiles
    ? `\n\n## Per-theme CSS Modules

The same blocks are also emitted one file per theme — ${moduleList}${
        opts.cssModulesGlobal ? " — wrapped in `:global(…)` for CSS-Modules projects (Next.js, etc.)" : ""
      }. Concatenated (or merged by your bundler), they reproduce \`tokens.css\`.

\`\`\`ts
// build-time: pick one theme, the bundler inlines it
import "./${varName([defaultTheme])}.module.css";
\`\`\`

For **runtime** switching keep every theme present (use \`tokens.css\`, or import
all \`*.module.css\`) and toggle \`${attr}\` on an ancestor.`
    : "";

  return `# Altery Design Tokens

Generated by the **Altery Design System Export** Figma plugin from **${summary.fileName}**.

- ${summary.totalVariables} variables across ${summary.collections.length} collection(s)
- Themes (modes): ${themeList || "`default`"}
-Settings: ${settingsLine}

## Files

| File | What it is |
|------|------------|
| \`tokens.css\` | CSS custom properties. One self-contained block per theme. The merged single file. |${moduleRow}
| \`tokens.json\` | Canonical W3C token tree (every mode under \`$extensions.modes\`, source collection under \`$extensions.figma\`). For diffing / re-import. |
| \`tokens.ts\` | Typed \`tokens\` object (values are \`var(--…)\` refs) + \`themes\` / \`Theme\`. |

${inlineNote}

## Collections

${collLines}

## Using the tokens

Import the stylesheet once:

\`\`\`css
@import "./tokens.css";
\`\`\`

The default theme (\`${defaultTheme}\`) is applied on \`:root\`, so it works with no attribute set.${switchExample}

Each \`[${attr}="…"]\` block re-declares **every** variable for that theme, so toggling
the attribute swaps the whole set.

\`\`\`css
.button {
  background: var(--colors-action-default);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
}
\`\`\`${moduleSection}
`;
}

/* --------------------------------------------------------------- Figma glue */

if (typeof figma !== "undefined") {
  figma.showUI(__html__, { width: 408, height: 660, themeColors: false });

  var SETTINGS_KEY = "altery-export-settings";

  async function loadSettings() {
    try {
      return normalizeOptions(await figma.clientStorage.getAsync(SETTINGS_KEY));
    } catch (e) {
      return normalizeOptions(null);
    }
  }

  async function saveSettings(options) {
    try {
      await figma.clientStorage.setAsync(SETTINGS_KEY, normalizeOptions(options));
    } catch (e) {}
  }

  async function readGraph() {
    const [collections, variables] = await Promise.all([
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync(),
    ]);
    return {
      fileName: figma.root.name,
      collections: collections.map((c) => ({
        id: c.id,
        name: c.name,
        defaultModeId: c.defaultModeId,
        modes: (c.modes || []).map((m) => ({ modeId: m.modeId, name: m.name })),
      })),
      variables: variables.map((v) => ({
        id: v.id,
        name: v.name,
        collectionId: v.variableCollectionId,
        resolvedType: v.resolvedType,
        valuesByMode: v.valuesByMode,
      })),
    };
  }

  async function scan(options) {
    try {
      const graph = await readGraph();
      const pkg = buildPackage(graph, options);
      figma.ui.postMessage({ type: "result", summary: pkg.summary, files: pkg.files, options: pkg.options });
    } catch (err) {
      figma.ui.postMessage({ type: "error", message: String((err && err.message) || err) });
    }
  }

  figma.ui.onmessage = (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "scan") {
      const options = normalizeOptions(msg.options);
      saveSettings(options);
      scan(options);
    } else if (msg.type === "notify") figma.notify(String(msg.message || ""));
    else if (msg.type === "resize" && msg.height) {
      figma.ui.resize(408, Math.max(420, Math.min(900, Math.round(msg.height))));
    } else if (msg.type === "close") figma.closePlugin();
  };

  (async function start() {
    const options = await loadSettings();
    figma.ui.postMessage({ type: "settings", options: options });
    scan(options);
  })();
}
