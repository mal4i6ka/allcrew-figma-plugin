/* Altery Design System Export — plugin sandbox (main thread).
 *
 * Reads the file's LOCAL variables + collections via the Figma Plugin API
 * (any plan, in-editor — no Enterprise REST, no server) and builds a design-token
 * package: tokens.css (self-contained per-theme [data-theme-name] blocks), tokens.json
 * (canonical W3C tree), tokens.ts (typed var refs + theme list) and a README.
 *
 * The transform below is a faithful, DEPENDENCY-FREE port of the board's
 * src/lib/figma.ts (variablesToW3CMultiMode) + src/lib/design-system/
 * tokens-transform.ts. Output matches the board EXACTLY except the theme
 * selector: this plugin emits `[data-theme-name="…"]` (Sergey's spec) where the
 * board emits `[data-theme="…"]`. Keep the rest in sync. Pure functions are
 * top-level (Node-verifiable); the Figma glue is guarded by `typeof figma`.
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

function themeModesOf(allLeaves, hint) {
  const themes = [];
  for (const entry of allLeaves) {
    const modes = modesOf(entry.token);
    const names = Object.keys(modes);
    const participates =
      names.length >= 2 || isAliasValue(entry.token.$value) || names.some((n) => isAliasValue(modes[n]));
    if (!participates) continue;
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

function toTokensCss(tree, defaultModeName) {
  const allLeaves = leaves(tree);
  if (allLeaves.length === 0) return "";
  const themes = themeModesOf(allLeaves, defaultModeName);
  const defaultTheme = pickDefaultTheme(allLeaves, themes, defaultModeName);
  const ordered = [defaultTheme].concat(themes.filter((t) => t !== defaultTheme));
  const blocks = ordered.map((theme) => {
    const selector = theme === defaultTheme ? `:root,\n[data-theme-name="${theme}"]` : `[data-theme-name="${theme}"]`;
    return `${selector} {\n${themeDeclarations(allLeaves, theme).join("\n")}\n}`;
  });
  return blocks.join("\n\n") + "\n";
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

function buildReadme(summary) {
  const themeList = summary.themes.map((t) => `\`${t}\``).join(", ");
  const collLines = summary.collections
    .map((c) => `- **${c.name}** — ${c.variableCount} variables, modes: ${c.modes.map((m) => `\`${m}\``).join(", ")}`)
    .join("\n");
  const defaultTheme = summary.themes[0] || "Light";
  const others = summary.themes.filter((t) => t !== defaultTheme);
  const switchExample = others.length
    ? `\n\nSwitch theme by setting the attribute on any ancestor (e.g. \`<html>\`):\n\n\`\`\`html\n<html data-theme-name="${others[0]}">\n\`\`\``
    : "";
  return `# Altery Design Tokens

Generated by the **Altery Design System Export** Figma plugin from **${summary.fileName}**.

- ${summary.totalVariables} variables across ${summary.collections.length} collection(s)
- Themes (modes): ${themeList || "`default`"}

## Files

| File | What it is |
|------|------------|
| \`tokens.css\` | CSS custom properties. One self-contained block per theme. |
| \`tokens.json\` | Canonical W3C token tree (every mode under \`$extensions.modes\`, source collection under \`$extensions.figma\`). For diffing / re-import. |
| \`tokens.ts\` | Typed \`tokens\` object (values are \`var(--…)\` refs) + \`themes\` / \`Theme\`. |

## Collections

${collLines}

## Using the tokens

Import the stylesheet once:

\`\`\`css
@import "./tokens.css";
\`\`\`

The default theme (\`${defaultTheme}\`) is applied on \`:root\`, so it works with no attribute set.${switchExample}

Each \`[data-theme-name="…"]\` block re-declares **every** variable for that theme, so toggling
the attribute swaps the whole set and \`var(--…)\` aliases always resolve.

\`\`\`css
.button {
  background: var(--colors-action-default);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
}
\`\`\`
`;
}

/* --------------------------------------------------------------- Figma glue */

if (typeof figma !== "undefined") {
  figma.showUI(__html__, { width: 408, height: 660, themeColors: false });

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

  async function scan() {
    try {
      const graph = await readGraph();
      const tree = variablesToW3CMultiMode(graph);
      const summary = buildSummary(graph, tree);
      const files = {};
      if (summary.tokenCount > 0) {
        files["tokens.css"] = toTokensCss(tree, primaryDefaultMode(graph));
        files["tokens.json"] = toTokensJson(tree);
        files["tokens.ts"] = toTokensTs(tree);
        files["README.md"] = buildReadme(summary);
      }
      figma.ui.postMessage({ type: "result", summary: summary, files: files });
    } catch (err) {
      figma.ui.postMessage({ type: "error", message: String((err && err.message) || err) });
    }
  }

  figma.ui.onmessage = (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "scan") scan();
    else if (msg.type === "notify") figma.notify(String(msg.message || ""));
    else if (msg.type === "resize" && msg.height) {
      figma.ui.resize(408, Math.max(420, Math.min(900, Math.round(msg.height))));
    } else if (msg.type === "close") figma.closePlugin();
  };

  scan();
}
