/* Altery Design System Export — plugin sandbox (main thread).
 *
 * Reads the file's LOCAL variables + collections + text styles via the Figma Plugin API
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

/* ---------------------------------------------------------------- text styles */

/* Figma text styles are a SEPARATE primitive from variables (COLOR/FLOAT/STRING/
 * BOOLEAN) — they bundle font family/size/weight/line-height/letter-spacing under one
 * name. There is no `typography` variable type, so we explode each style into scalar
 * sub-tokens (`typography/<style>/font-size`, …) that flow through the existing scalar
 * emitters unchanged: cssValue already keeps `font-weight`/`line-height` unit-less and
 * appends `px` to sizes. A field bound to a variable becomes a `{…}` alias (→ var(--…)),
 * so typography stays DRY and themeable. */

var TEXT_STYLE_COLLECTION = "Text Styles";
var TEXT_STYLE_BOUND_FIELDS = [
  "fontFamily", "fontStyle", "fontWeight", "fontSize", "letterSpacing", "lineHeight",
];

/** Figma stores weight in the style string ("Regular"/"SemiBold Italic"). Map it to a
 *  numeric CSS font-weight. Order matters: compound names (Extra/Semi/Ultra) are matched
 *  before the plain "light"/"bold" they contain. */
function styleToFontWeight(style) {
  var s = String(style || "").toLowerCase();
  if (/thin|hairline/.test(s)) return 100;
  if (/extra[\s-]?light|ultra[\s-]?light/.test(s)) return 200;
  if (/semi[\s-]?bold|demi[\s-]?bold/.test(s)) return 600;
  if (/extra[\s-]?bold|ultra[\s-]?bold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/medium/.test(s)) return 500;
  if (/light/.test(s)) return 300;
  if (/bold/.test(s)) return 700;
  return 400; // regular / normal / book / anything else
}

function isItalicStyle(style) {
  return /italic|oblique/.test(String(style || "").toLowerCase());
}

/** Figma LineHeight → { value, type } (or null). AUTO→`normal`; PERCENT→unit-less ratio
 *  (1.4); PIXELS→`24px` string (bypasses the unit-less rule so it keeps its unit). */
function lineHeightValue(lh) {
  if (!isRecord(lh)) return null;
  if (lh.unit === "AUTO") return { value: "normal", type: "string" };
  if (typeof lh.value !== "number") return null;
  if (lh.unit === "PERCENT") return { value: Number((lh.value / 100).toFixed(4)), type: "number" };
  return { value: `${Number(lh.value.toFixed(3))}px`, type: "string" };
}

/** Figma LetterSpacing → { value, type } (or null). PERCENT→`em` string (percent of font
 *  size); PIXELS→number (cssValue appends `px`); 0→0. */
function letterSpacingValue(ls) {
  if (!isRecord(ls) || typeof ls.value !== "number") return null;
  if (ls.value === 0) return { value: 0, type: "number" };
  if (ls.unit === "PERCENT") return { value: `${Number((ls.value / 100).toFixed(4))}em`, type: "string" };
  return { value: Number(ls.value.toFixed(3)), type: "number" };
}

/** A text-style field bound to a variable → `{canonical.name}` alias, else undefined. */
function boundAlias(boundVariables, field, idToName) {
  if (!isRecord(boundVariables)) return undefined;
  var id = boundVariables[field];
  if (typeof id !== "string" || !id) return undefined;
  var name = idToName ? idToName.get(id) : undefined;
  return name ? `{${name}}` : undefined; // unknown target → fall back to the literal below
}

/** One text style → its scalar sub-token leaves ([{ prop, token }]). */
function textStyleLeaves(ts, idToName) {
  var bv = ts.boundVariables;
  var out = [];
  var push = function (prop, value, type) {
    if (value === undefined || value === null) return;
    out.push({ prop: prop, token: { $type: type, $value: value, $extensions: { modes: {}, figma: { collection: TEXT_STYLE_COLLECTION } } } });
  };

  var family = boundAlias(bv, "fontFamily", idToName);
  if (family === undefined && ts.fontName && typeof ts.fontName.family === "string") family = ts.fontName.family;
  push("font-family", family, "string");

  var size = boundAlias(bv, "fontSize", idToName);
  if (size === undefined && typeof ts.fontSize === "number") size = ts.fontSize;
  push("font-size", size, "number");

  var weight = boundAlias(bv, "fontWeight", idToName);
  if (weight === undefined) weight = styleToFontWeight(ts.fontName && ts.fontName.style);
  push("font-weight", weight, "number");

  if (isItalicStyle(ts.fontName && ts.fontName.style)) push("font-style", "italic", "string");

  var lhAlias = boundAlias(bv, "lineHeight", idToName);
  if (lhAlias !== undefined) push("line-height", lhAlias, "number");
  else { var lh = lineHeightValue(ts.lineHeight); if (lh) push("line-height", lh.value, lh.type); }

  var lsAlias = boundAlias(bv, "letterSpacing", idToName);
  if (lsAlias !== undefined) push("letter-spacing", lsAlias, "number");
  else { var ls = letterSpacingValue(ts.letterSpacing); if (ls) push("letter-spacing", ls.value, ls.type); }

  return out;
}

/** Merge text styles into the token tree under `typography/<style>/…`, collision-guarded
 *  the same way variable paths are (suffix `-2`, `-3`, … on the leaf group). */
function addTextStyleTokens(out, textStyles, idToName) {
  var SEP = " ";
  var list = (Array.isArray(textStyles) ? textStyles : [])
    .filter(function (t) { return t && typeof t.name === "string" && t.name.trim() !== ""; })
    .slice()
    .sort(function (a, b) { return a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)); });
  var claimed = new Set();
  for (var i = 0; i < list.length; i++) {
    var ts = list[i];
    var base = ["typography"].concat(groupSegments(ts.name));
    var key = base.join(SEP);
    if (claimed.has(key)) {
      var stem = base.slice(0, -1);
      var last = base[base.length - 1];
      var n = 2;
      do { base = stem.concat([`${last}-${n}`]); key = base.join(SEP); n++; } while (claimed.has(key));
    }
    claimed.add(key);
    var leavesArr = textStyleLeaves(ts, idToName);
    for (var j = 0; j < leavesArr.length; j++) setToken(out, base.concat([leavesArr[j].prop]), leavesArr[j].token);
  }
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
  addTextStyleTokens(out, graph && graph.textStyles, idToName);
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
  // Typography-scale primitives are kept as their own vars (semantic tokens reference them
  // with var(--…)); they are NOT collapsed even though they look like raw primitives.
  for (const e of all) if (!participatesInTheming(e.token) && !isScaleToken(e.token)) primitive.add(e.path.join("."));

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

/* -------------------------------------------------- typography scale extraction */

/* Text styles bake their values in (Figma can't bind most fields to variables), so the
 * plugin gets a full literal set per style. This transform is the INVERSE of inlining:
 * it dedupes those literals into a shared primitive scale (`font-size/lg`, `font-weight/
 * semibold`, …) and rewrites each style's field to a `{…}` alias, dropping the noisy
 * `typography/` prefix from the semantic layer (`headings/h1/font-size` → var refs). The
 * scale primitives carry `$extensions.figma.scale` so inlinePrimitivesTree keeps them
 * instead of collapsing them straight back. tokens.json stays lossless (aliases resolve).*/

var WEIGHT_NAMES = { 100: "thin", 200: "extralight", 300: "light", 400: "regular", 500: "medium", 600: "semibold", 700: "bold", 800: "extrabold", 900: "black" };
var TSHIRT_LADDER = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl"];
var TSHIRT_AXES = { "font-size": true, "line-height": true };

function isScaleToken(token) {
  var f = token && token.$extensions && token.$extensions.figma;
  return isRecord(f) && f.scale === true;
}

function typoAxisOf(prop) {
  if (prop === "font-family" || prop === "font-size" || prop === "font-weight" || prop === "line-height" || prop === "letter-spacing") return prop;
  return null; // font-style etc. stay literal
}

/** Sort key for a stored typography value (number | "24px" | "-0.02em" | "normal"). */
function numericKey(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") { var m = v.match(/-?\d*\.?\d+/); if (m) return parseFloat(m[0]); }
  return Infinity;
}

/** Deterministic, name-safe token for a value: 32→"32", -2→"n2", 0.5→"0-5", "1.4"→"1-4". */
function valueNameToken(v) {
  var s = typeof v === "number" ? String(v) : String(v).replace(/px|r?em/gi, "").trim();
  return s.replace(/^-/, "n").replace(/\./g, "-") || "0";
}

function scaleToken(value, type) {
  return { $type: type, $value: value, $extensions: { modes: {}, figma: { collection: "Typography Scale", scale: true } } };
}

/** Quote a multi-word font-family so it is valid both as `font-family` and inside the
 *  CSS `font` shorthand (`font: 600 16px "Museo Sans"`). Single-word families are left
 *  bare; already-quoted values are untouched. */
function quoteFamily(v) {
  v = String(v);
  return /\s/.test(v) && !/^["']/.test(v) ? '"' + v.replace(/"/g, '\\"') + '"' : v;
}

function extractTypographyScale(tree, options) {
  var naming = options && options.typoNaming === "value" ? "value" : "tshirt";
  var shorthand = !!(options && options.typoShorthand);
  var all = leaves(tree);
  var isTypo = function (path) { return path.length > 1 && path[0] === "typography"; };
  if (!all.some(function (e) { return isTypo(e.path); })) return tree; // no text styles → unchanged

  var keyOf = function (v) { return typeof v + ":" + String(v); };

  // 1) collect distinct literal values per axis (skip already-aliased fields + `normal`)
  var axisValues = {};
  all.forEach(function (e) {
    if (!isTypo(e.path)) return;
    var axis = typoAxisOf(e.path[e.path.length - 1]);
    if (!axis) return;
    var val = e.token.$value;
    if (isAliasValue(val)) return;
    if (axis === "line-height" && val === "normal") return;
    if (!axisValues[axis]) axisValues[axis] = new Map();
    if (!axisValues[axis].has(keyOf(val))) axisValues[axis].set(keyOf(val), { value: val, type: e.token.$type });
  });

  // 2) name each distinct value, build the primitive scale
  var out = {};
  var pathByValue = {}; // axis → Map(valueKey → primitive path)
  Object.keys(axisValues).forEach(function (axis) {
    var entries = Array.from(axisValues[axis].values());
    // Order primitives ascending (numeric) / alphabetical (family) so the CSS scale lists
    // in the same order as the generated Figma collection.
    if (axis === "font-family") entries.sort(function (a, b) { return String(a.value).localeCompare(String(b.value)); });
    else entries.sort(function (a, b) { return numericKey(a.value) - numericKey(b.value); });
    if (axis === "font-weight") {
      entries.forEach(function (en) { en.name = WEIGHT_NAMES[en.value] || valueNameToken(en.value); });
    } else if (axis === "font-family") {
      entries.forEach(function (en) { en.name = varName([String(en.value)]) || "base"; });
    } else if (naming === "tshirt" && TSHIRT_AXES[axis]) {
      entries.forEach(function (en, i) { en.name = TSHIRT_LADDER[i] || valueNameToken(en.value); });
    } else {
      entries.forEach(function (en) { en.name = valueNameToken(en.value); });
    }
    pathByValue[axis] = new Map();
    var used = {};
    entries.forEach(function (en) {
      var name = en.name;
      while (used[name]) name = name + "-2"; // guard rare name collisions
      used[name] = true;
      var path = [axis, name];
      pathByValue[axis].set(keyOf(en.value), path);
      setToken(out, path, scaleToken(axis === "font-family" ? quoteFamily(en.value) : en.value, en.type));
    });
  });

  // 3) semantic layer: drop the `typography/` prefix, point each field at its primitive
  var styles = new Map(); // styleKey → { prefix, props: { prop: {value,type} } }
  all.forEach(function (e) {
    if (!isTypo(e.path)) { setToken(out, e.path, e.token); return; }
    var prop = e.path[e.path.length - 1];
    var semanticPath = e.path.slice(1); // drop "typography"
    var axis = typoAxisOf(prop);
    var val = e.token.$value;
    if (axis && !isAliasValue(val) && pathByValue[axis] && pathByValue[axis].has(keyOf(val))) {
      val = "{" + pathByValue[axis].get(keyOf(val)).join(".") + "}";
    }
    setToken(out, semanticPath, { $type: e.token.$type, $value: val, $extensions: e.token.$extensions });
    if (shorthand) {
      var prefix = semanticPath.slice(0, -1);
      var sk = prefix.join(".");
      if (!styles.has(sk)) styles.set(sk, { prefix: prefix, props: {} });
      styles.get(sk).props[prop] = true;
    }
  });

  // 4) optional CSS `font` shorthand token per style (`--<style>-font`). It composes the
  //    style's OWN longhand vars (not the primitives) so it never dangles regardless of
  //    inlining, and picks up whatever those longhands resolve to.
  if (shorthand) {
    styles.forEach(function (s) {
      var p = s.props, prefix = s.prefix;
      if (!p["font-size"] || !p["font-family"]) return; // `font` shorthand needs both
      var ref = function (prop) { return "var(--" + varName(prefix.concat([prop])) + ")"; };
      var parts = [];
      if (p["font-style"]) parts.push("italic"); // only emitted when the style is italic
      if (p["font-weight"]) parts.push(ref("font-weight"));
      var sizePiece = ref("font-size");
      if (p["line-height"]) sizePiece += "/" + ref("line-height");
      parts.push(sizePiece);
      parts.push(ref("font-family"));
      setToken(out, prefix.concat(["font"]), { $type: "string", $value: parts.join(" "), $extensions: { modes: {}, figma: { collection: "Typography Scale" } } });
    });
  }
  return out;
}

/* ------------------------------------------ generate Figma variables from styles */

/* The INVERSE-of-export write path: build a real, correctly-scoped variable collection
 * out of the values baked into the used text styles, so the designer no longer has to
 * hand-create them (and so Figma's contextual bind pickers actually appear — they only
 * show up when a variable carries the matching scope). Pure planner here; the Figma glue
 * (createVariable/setBoundVariable) consumes the plan. Fields Figma can't hold as
 * variables (line-height / letter-spacing in %) are skipped, not faked. */

var TYPO_AXIS_SCOPE = {
  "font-size": ["FONT_SIZE"], "line-height": ["LINE_HEIGHT"], "letter-spacing": ["LETTER_SPACING"],
  "font-family": ["FONT_FAMILY"], "font-style": ["FONT_STYLE"],
};

/** True if the file already has variables that look like a typography scale (so we don't
 *  nag / offer to generate). Detected by the axis group prefix in the variable name. */
function hasTypographyVars(graph) {
  var axes = { "font-size": 1, "font-family": 1, "font-weight": 1, "font-style": 1, "line-height": 1, "letter-spacing": 1 };
  return (graph && graph.variables ? graph.variables : []).some(function (v) {
    var segs = groupSegments(v && v.name);
    return segs.length > 1 && axes[segs[0].toLowerCase()];
  });
}

/** Plan a "Typography" variable collection + per-style bindings from the raw text styles.
 *  Returns { collectionName, variables:[{name,type,value,scopes}], bindings:[{styleId,
 *  styleName,field,varName}] }. Deterministic; unit-aware (% values are dropped). */
function planTypographyVariables(graph, options) {
  var naming = options && options.typoNaming === "value" ? "value" : "tshirt";
  var styles = (Array.isArray(graph && graph.textStyles) ? graph.textStyles : [])
    .filter(function (t) { return t && typeof t.name === "string" && t.name.trim() !== ""; })
    .slice()
    .sort(function (a, b) { return a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)); });

  // axis → how to pull a bindable value out of a raw text style (undefined = not bindable)
  var axes = {
    "font-size": { type: "FLOAT", field: "fontSize", get: function (t) { return typeof t.fontSize === "number" ? t.fontSize : undefined; } },
    "font-family": { type: "STRING", field: "fontFamily", get: function (t) { return t.fontName && typeof t.fontName.family === "string" ? t.fontName.family : undefined; } },
    "font-style": { type: "STRING", field: "fontStyle", get: function (t) { return t.fontName && typeof t.fontName.style === "string" ? t.fontName.style : undefined; } },
    "line-height": { type: "FLOAT", field: "lineHeight", get: function (t) { return isRecord(t.lineHeight) && t.lineHeight.unit === "PIXELS" && typeof t.lineHeight.value === "number" ? t.lineHeight.value : undefined; } },
    "letter-spacing": { type: "FLOAT", field: "letterSpacing", get: function (t) { return isRecord(t.letterSpacing) && t.letterSpacing.unit === "PIXELS" && typeof t.letterSpacing.value === "number" ? t.letterSpacing.value : undefined; } },
  };
  var order = ["font-size", "font-family", "font-style", "line-height", "letter-spacing"];
  var keyOf = function (v) { return typeof v + ":" + String(v); };

  var variables = [];
  var nameByAxisValue = {}; // axis → Map(valueKey → variable name)
  order.forEach(function (axis) {
    var ax = axes[axis];
    var distinct = new Map();
    styles.forEach(function (t) { var v = ax.get(t); if (v === undefined || v === null) return; if (!distinct.has(keyOf(v))) distinct.set(keyOf(v), v); });
    if (distinct.size === 0) return;
    // Sort up front so variables land in the collection in a sensible order (ascending for
    // numeric axes, alphabetical for family/style) regardless of the naming scheme.
    var entries = Array.from(distinct.values());
    if (axis === "font-family" || axis === "font-style") {
      entries.sort(function (a, b) { return String(a).localeCompare(String(b)); });
    } else {
      entries.sort(function (a, b) { return numericKey(a) - numericKey(b); });
    }
    var nameFor;
    if (axis === "font-family" || axis === "font-style") {
      nameFor = function (v) { return varName([String(v)]) || "default"; };
    } else if (naming === "tshirt" && (axis === "font-size" || axis === "line-height")) {
      var idx = new Map();
      entries.forEach(function (v, i) { idx.set(keyOf(v), TSHIRT_LADDER[i] || valueNameToken(v)); });
      nameFor = function (v) { return idx.get(keyOf(v)); };
    } else {
      nameFor = function (v) { return valueNameToken(v); };
    }
    nameByAxisValue[axis] = new Map();
    var used = {};
    entries.forEach(function (v) {
      var leaf = nameFor(v);
      while (used[leaf]) leaf = leaf + "-2";
      used[leaf] = true;
      var name = axis + "/" + leaf;
      nameByAxisValue[axis].set(keyOf(v), name);
      variables.push({ name: name, type: ax.type, value: v, scopes: TYPO_AXIS_SCOPE[axis] });
    });
  });

  var bindings = [];
  styles.forEach(function (t) {
    order.forEach(function (axis) {
      var v = axes[axis].get(t);
      if (v === undefined || v === null) return;
      bindings.push({ styleId: t.id, styleName: t.name, field: axes[axis].field, varName: nameByAxisValue[axis].get(keyOf(v)) });
    });
  });

  return { collectionName: "Typography", variables: variables, bindings: bindings };
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
 *  `attr` is the theme-switch attribute name (e.g. `data-theme-name`). `ordered` /
 *  `defaultTheme` are the canonical themes derived from the SOURCE tree, so the set
 *  and naming never shift with the inline/flatten settings. */
function toTokensCss(tree, ordered, defaultTheme, attr) {
  const a = attr || "data-theme-name";
  const allLeaves = leaves(tree);
  if (allLeaves.length === 0) return "";
  const blocks = ordered.map((theme) => {
    const themeSel = `[${a}="${cssAttrValue(theme)}"]`;
    const selector = theme === defaultTheme ? `:root,\n${themeSel}` : themeSel;
    return themeBlock(allLeaves, theme, selector);
  });
  return blocks.join("\n\n") + "\n";
}

/** One CSS file per theme. With `useGlobal` the selectors are wrapped in `:global(…)`
 *  (valid CSS Modules); otherwise they're plain. Concatenated, they are `tokens.css`.
 *  `ordered` / `defaultTheme` come from the SOURCE tree so file names (e.g.
 *  `light.module.css`) are stable across the inline/flatten settings. */
function toThemeModuleCssFiles(tree, ordered, defaultTheme, attr, useGlobal) {
  const a = attr || "data-theme-name";
  const wrap = useGlobal ? (sel) => `:global(${sel})` : (sel) => sel;
  const allLeaves = leaves(tree);
  const files = {};
  if (allLeaves.length === 0) return files;
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

function toTokensTs(tree, themes) {
  const allLeaves = leaves(tree);
  const tsTree = buildTsTree(allLeaves);
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
  // Typography scale extraction — factor the literal values baked into text styles into a
  // shared primitive scale (`--font-size-lg`) + per-style var() refs, instead of a full
  // literal set per style. Figma can't bind most text-style fields to variables (and never
  // % line-height/letter-spacing), so the scale is synthesised from the literals here.
  typoExtract: false, // off (default) = faithful literal per-style tokens; on = tiered scale + var() refs
  typoNaming: "tshirt", // "tshirt" (--font-size-lg) | "value" (--font-size-32) — primitive names
  typoShorthand: false, // also emit a CSS `font` shorthand token per style (`--<style>-font`)
};

function sanitizeAttr(value) {
  const cleaned = typeof value === "string" ? value.trim().replace(/[^A-Za-z0-9_-]/g, "") : "";
  return cleaned || DEFAULT_OPTIONS.themeAttr;
}

/** Delivery config: where/how the UI ships the package. Secrets here are the shared
 *  receiver secret only — git/npm credentials live on the receiver, never in the plugin. */
function normalizeDelivery(d) {
  d = isRecord(d) ? d : {};
  const s = (v) => (typeof v === "string" ? v : "");
  const route = isRecord(d.route) ? d.route : {};
  const targets = ["folder", "git", "pr", "npm"];
  return {
    endpoint: s(d.endpoint).trim(),
    secret: s(d.secret),
    target: targets.indexOf(d.target) !== -1 ? d.target : "folder",
    route: {
      repo: s(route.repo).trim(),
      branch: s(route.branch).trim(),
      path: s(route.path).trim(),
      package: s(route.package).trim(),
    },
    onChange: !!d.onChange, // auto-deliver on change (poll while open)
    onOpen: !!d.onOpen, // deliver once on plugin open
  };
}

function normalizeOptions(o) {
  o = isRecord(o) ? o : {};
  const pick = (key) => (o[key] === undefined ? DEFAULT_OPTIONS[key] : !!o[key]);
  return {
    inlinePrimitives: pick("inlinePrimitives"),
    flattenAliases: pick("flattenAliases"),
    emitModuleFiles: pick("emitModuleFiles"),
    cssModulesGlobal: pick("cssModulesGlobal"),
    typoExtract: pick("typoExtract"),
    typoNaming: o.typoNaming === "value" ? "value" : "tshirt",
    typoShorthand: pick("typoShorthand"),
    themeAttr: sanitizeAttr(o.themeAttr),
    delivery: normalizeDelivery(o.delivery),
  };
}

/** Graph + options → the full token-export package. Pure (Node-verifiable). */
function buildPackage(graph, options) {
  const opts = normalizeOptions(options);
  const rawTree = variablesToW3CMultiMode(graph);
  // Typography scale extraction is layered on top of the board-exact core, like inlining.
  const sourceTree = opts.typoExtract ? extractTypographyScale(rawTree, opts) : rawTree;
  const summary = buildSummary(graph, sourceTree);
  const files = {};
  if (summary.tokenCount > 0) {
    const defaultMode = primaryDefaultMode(graph);
    // Theme identity is a property of the design's Figma modes, NOT of the
    // CSS-rendering settings. Derive the canonical theme set + order ONCE from the
    // SOURCE tree so inlining/flattening can never rename a mode (e.g. "light" →
    // "mode-1"). The inlined tree is read only for per-theme *values* (its mode keys
    // are preserved through inlining, so valueForTheme stays correct).
    const { defaultTheme, ordered } = orderedThemes(leaves(sourceTree), defaultMode);
    const cssTree = opts.inlinePrimitives ? inlinePrimitivesTree(sourceTree, opts.flattenAliases) : sourceTree;
    files["tokens.css"] = toTokensCss(cssTree, ordered, defaultTheme, opts.themeAttr);
    if (opts.emitModuleFiles) {
      const themeFiles = toThemeModuleCssFiles(cssTree, ordered, defaultTheme, opts.themeAttr, opts.cssModulesGlobal);
      for (const name of Object.keys(themeFiles)) files[name] = themeFiles[name];
    }
    files["tokens.json"] = toTokensJson(sourceTree); // always the full, un-inlined tree (lossless)
    files["tokens.ts"] = toTokensTs(cssTree, ordered);
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
  const textStyleCount = (graph.textStyles || []).length;
  // Surface text styles as a mode-less pseudo-collection so they show in the UI list and
  // the README alongside variable collections.
  if (textStyleCount > 0) collections.push({ name: TEXT_STYLE_COLLECTION, modes: [], variableCount: textStyleCount });
  return {
    fileName: graph.fileName || "Untitled",
    collections: collections,
    totalVariables: (graph.variables || []).length,
    textStyleCount: textStyleCount,
    hasTypographyVars: hasTypographyVars(graph),
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
    .map((c) =>
      c.modes.length
        ? `- **${c.name}** — ${c.variableCount} variables, modes: ${c.modes.map((m) => `\`${m}\``).join(", ")}`
        : `- **${c.name}** — ${c.variableCount} text styles → \`typography/…\` tokens`
    )
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
    `typography scale \`${opts.typoExtract ? "on" : "off"}\``,
    opts.typoExtract ? `scale names \`${opts.typoNaming === "value" ? "by value" : "t-shirt"}\`` : null,
    opts.typoExtract ? `font shorthand \`${opts.typoShorthand ? "on" : "off"}\`` : null,
    `theme attribute \`${attr}\``,
    `per-theme modules \`${opts.emitModuleFiles ? "on" : "off"}\``,
    opts.emitModuleFiles ? `\`:global()\` \`${opts.cssModulesGlobal ? "on" : "off"}\`` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const typoNote = opts.typoExtract && summary.textStyleCount
    ? "\n\nText-style values are factored into a shared typography scale (`--font-size-…`, `--font-weight-…`, …); each style references the scale with `var(--…)`" +
      (opts.typoShorthand ? ", plus a CSS `font` shorthand token per style (`--<style>-font`)" : "") +
      "."
    : "";

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

- ${summary.totalVariables} variables across ${summary.collections.length} collection(s)${
    summary.textStyleCount ? `\n- ${summary.textStyleCount} text styles → \`typography/…\` tokens` : ""
  }
- Themes (modes): ${themeList || "`default`"}
- Settings: ${settingsLine}

## Files

| File | What it is |
|------|------------|
| \`tokens.css\` | CSS custom properties. One self-contained block per theme. The merged single file. |${moduleRow}
| \`tokens.json\` | Canonical W3C token tree (every mode under \`$extensions.modes\`, source collection under \`$extensions.figma\`). For diffing / re-import. |
| \`tokens.ts\` | Typed \`tokens\` object (values are \`var(--…)\` refs) + \`themes\` / \`Theme\`. |

${inlineNote}${typoNote}

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

  function serializeBoundVars(bv) {
    const out = {};
    if (!isRecord(bv)) return out;
    for (const field of TEXT_STYLE_BOUND_FIELDS) {
      // A bound field is a VariableAlias `{ id }` on a text style, but the text APIs can
      // also hand back an array of aliases (per-character ranges) — take the first.
      const raw = bv[field];
      const b = Array.isArray(raw) ? raw[0] : raw;
      if (isRecord(b) && typeof b.id === "string") out[field] = b.id;
    }
    return out;
  }

  async function readGraph() {
    const [collections, variables, textStyles] = await Promise.all([
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync(),
      typeof figma.getLocalTextStylesAsync === "function" ? figma.getLocalTextStylesAsync() : Promise.resolve([]),
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
      textStyles: textStyles.map((t) => ({
        id: t.id,
        name: t.name,
        fontName: t.fontName ? { family: t.fontName.family, style: t.fontName.style } : null,
        fontSize: t.fontSize,
        lineHeight: t.lineHeight,
        letterSpacing: t.letterSpacing,
        boundVariables: serializeBoundVars(t.boundVariables),
      })),
    };
  }

  async function scan(options) {
    try {
      const graph = await readGraph();
      const pkg = buildPackage(graph, options);
      figma.ui.postMessage({ type: "result", summary: pkg.summary, files: pkg.files, options: pkg.options, editor: figma.editorType });
    } catch (err) {
      figma.ui.postMessage({ type: "error", message: String((err && err.message) || err) });
    }
  }

  function createTypographyVariable(name, collection, type) {
    // createVariable's signature took a collectionId string in older API versions and the
    // collection object in newer ones — try the current shape first, fall back to the id.
    try {
      return figma.variables.createVariable(name, collection, type);
    } catch (e) {
      return figma.variables.createVariable(name, collection.id, type);
    }
  }

  // Write path: build a scoped "Typography" variable collection from the text styles and
  // bind each style's fields to it. Design-mode only (Dev Mode is read-only). Non-destructive
  // — only creates; Figma's native undo reverts the whole batch.
  async function generateTypographyVariables(options) {
    if (figma.editorType === "dev") throw new Error("Switch to Design mode — Dev Mode can't create variables.");
    const graph = await readGraph();
    const plan = planTypographyVariables(graph, normalizeOptions(options));
    if (plan.variables.length === 0) throw new Error("No text styles with bindable values found.");

    const collection = figma.variables.createVariableCollection(plan.collectionName);
    const modeId = collection.modes[0].modeId;
    const byName = {};
    for (const spec of plan.variables) {
      const v = createTypographyVariable(spec.name, collection, spec.type);
      v.setValueForMode(modeId, spec.value);
      try { v.scopes = spec.scopes; } catch (e) {} // scopes make Figma's bind pickers appear
      byName[spec.name] = v;
    }

    const styleById = {};
    for (const s of await figma.getLocalTextStylesAsync()) styleById[s.id] = s;
    let bound = 0, failed = 0;
    const failures = [];
    for (const b of plan.bindings) {
      const style = styleById[b.styleId], variable = byName[b.varName];
      if (!style || !variable) { failed++; continue; }
      try { style.setBoundVariable(b.field, variable); bound++; }
      catch (e) { failed++; if (failures.length < 8) failures.push(`${b.styleName} · ${b.field}: ${String((e && e.message) || e)}`); }
    }
    return { collection: plan.collectionName, created: plan.variables.length, bound: bound, failed: failed, failures: failures };
  }

  figma.ui.onmessage = (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "scan") {
      const options = normalizeOptions(msg.options);
      saveSettings(options);
      scan(options);
    } else if (msg.type === "genTypographyVars") {
      const options = normalizeOptions(msg.options);
      generateTypographyVariables(options)
        .then((report) => {
          figma.notify(`Created ${report.created} variables · bound ${report.bound} field(s)` + (report.failed ? ` · ${report.failed} failed` : ""));
          figma.ui.postMessage({ type: "genResult", report: report });
          scan(options); // reflect the new collection in the summary/preview
        })
        .catch((err) => {
          const message = String((err && err.message) || err);
          figma.notify("Generate failed: " + message);
          figma.ui.postMessage({ type: "genError", message: message });
        });
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
