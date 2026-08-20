"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));

  // src/tokens/split-theme.ts
  var DARK_COMPANION = /^(.+?)[ _-]dark$/i;
  var GENERIC_MODE_NAMES = ["mode 1", "mode", "value", "default"];
  var normalize = (name) => name.trim().toLowerCase();
  function darkModeNameOf(collection) {
    var _a, _b, _c;
    const mode = (_a = collection.modes.find((m) => m.modeId === collection.defaultModeId)) != null ? _a : collection.modes[0];
    const name = (_c = (_b = mode == null ? void 0 : mode.name) == null ? void 0 : _b.trim()) != null ? _c : "";
    return name === "" || GENERIC_MODE_NAMES.indexOf(name.toLowerCase()) !== -1 ? "Dark" : name;
  }
  function pairCompanions(snapshot) {
    const byName = /* @__PURE__ */ new Map();
    for (const collection of snapshot.collections) byName.set(normalize(collection.name), collection);
    const namesByCollection = /* @__PURE__ */ new Map();
    for (const variable of snapshot.variables) {
      let names = namesByCollection.get(variable.collectionId);
      if (!names) {
        names = /* @__PURE__ */ new Set();
        namesByCollection.set(variable.collectionId, names);
      }
      names.add(variable.name);
    }
    const pairs = /* @__PURE__ */ new Map();
    for (const companion of snapshot.collections) {
      const match = DARK_COMPANION.exec(companion.name.trim());
      if (!match) continue;
      const base = byName.get(normalize(match[1]));
      if (!base || base.id === companion.id) continue;
      const baseNames = namesByCollection.get(base.id);
      const companionNames = namesByCollection.get(companion.id);
      if (!baseNames || !companionNames) continue;
      let overlaps = false;
      for (const name of companionNames) {
        if (baseNames.has(name)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) pairs.set(companion.id, base);
    }
    return pairs;
  }
  function foldSplitThemeCollections(snapshot) {
    var _a, _b;
    const pairs = pairCompanions(snapshot);
    if (pairs.size === 0) return snapshot;
    const darkModeByBase = /* @__PURE__ */ new Map();
    for (const companion of snapshot.collections) {
      const base = pairs.get(companion.id);
      if (!base) continue;
      const modeId = companion.defaultModeId || ((_a = companion.modes[0]) == null ? void 0 : _a.modeId);
      if (modeId) darkModeByBase.set(base.id, { modeId, name: darkModeNameOf(companion) });
    }
    const darkValues = /* @__PURE__ */ new Map();
    for (const variable of snapshot.variables) {
      const base = pairs.get(variable.collectionId);
      if (!base) continue;
      const dark = darkModeByBase.get(base.id);
      if (!dark) continue;
      const value = (_b = variable.valuesByMode[dark.modeId]) != null ? _b : Object.values(variable.valuesByMode)[0];
      if (value !== void 0) darkValues.set(`${base.id}\0${variable.name}`, value);
    }
    const collections = snapshot.collections.filter((collection) => !pairs.has(collection.id)).map((collection) => {
      const dark = darkModeByBase.get(collection.id);
      if (!dark || collection.modes.some((mode) => mode.modeId === dark.modeId)) return collection;
      return __spreadProps(__spreadValues({}, collection), { modes: [...collection.modes, dark] });
    });
    const variables = snapshot.variables.filter((variable) => !pairs.has(variable.collectionId)).map((variable) => {
      const dark = darkModeByBase.get(variable.collectionId);
      if (!dark) return variable;
      const value = darkValues.get(`${variable.collectionId}\0${variable.name}`);
      if (value === void 0) return variable;
      return __spreadProps(__spreadValues({}, variable), { valuesByMode: __spreadProps(__spreadValues({}, variable.valuesByMode), { [dark.modeId]: value }) });
    });
    return __spreadProps(__spreadValues({}, snapshot), { collections, variables });
  }
  var darkCompanionName = (themeCollectionName) => `${themeCollectionName.trim()}-dark`;

  // src/variables.ts
  function toCollectionEntry(collection) {
    return {
      id: collection.id,
      name: collection.name,
      defaultModeId: collection.defaultModeId,
      modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name }))
    };
  }
  function toVariableEntry(variable) {
    return {
      id: variable.id,
      key: variable.key,
      name: variable.name,
      collectionId: variable.variableCollectionId,
      scopes: variable.scopes,
      resolvedType: variable.resolvedType,
      valuesByMode: variable.valuesByMode
    };
  }
  async function readLocalVariables() {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync();
    return {
      collections: collections.map(toCollectionEntry),
      variables: variables.map(toVariableEntry)
    };
  }
  async function readLibraryVariables() {
    const collections = [];
    const variables = [];
    let libraryCollections;
    try {
      libraryCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    } catch (e) {
      return { collections, variables };
    }
    for (const libraryCollection of libraryCollections) {
      try {
        const libraryVariables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(
          libraryCollection.key
        );
        const importedVariables = [];
        for (const libraryVariable of libraryVariables) {
          importedVariables.push(await figma.variables.importVariableByKeyAsync(libraryVariable.key));
        }
        if (importedVariables.length === 0) continue;
        const collectionId = importedVariables[0].variableCollectionId;
        const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
        collections.push(
          collection ? toCollectionEntry(collection) : { id: collectionId, name: libraryCollection.name, defaultModeId: "", modes: [] }
        );
        variables.push(...importedVariables.map(toVariableEntry));
      } catch (error) {
        console.error(`Failed to read library collection "${libraryCollection.name}"`, error);
      }
    }
    return { collections, variables };
  }
  function mergeSnapshots(a, b) {
    const collectionsById = /* @__PURE__ */ new Map();
    for (const collection of [...a.collections, ...b.collections]) {
      collectionsById.set(collection.id, collection);
    }
    const variablesById = /* @__PURE__ */ new Map();
    for (const variable of [...a.variables, ...b.variables]) {
      variablesById.set(variable.id, variable);
    }
    return {
      collections: [...collectionsById.values()],
      variables: [...variablesById.values()]
    };
  }
  async function readAllVariables() {
    const [local, library] = await Promise.all([readLocalVariables(), readLibraryVariables()]);
    return foldSplitThemeCollections(mergeSnapshots(local, library));
  }
  function isVariableAlias(value) {
    return typeof value === "object" && value !== null && "type" in value && value.type === "VARIABLE_ALIAS";
  }
  async function resolveVariableValue(variable, modeId, visited = /* @__PURE__ */ new Set()) {
    if (visited.has(variable.id)) {
      throw new Error(`Circular variable alias detected at "${variable.name}" (${variable.id})`);
    }
    visited.add(variable.id);
    let value = variable.valuesByMode[modeId];
    if (value === void 0) {
      const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
      if (!collection) {
        throw new Error(`Variable collection not found for "${variable.name}" (${variable.variableCollectionId})`);
      }
      value = variable.valuesByMode[collection.defaultModeId];
    }
    if (isVariableAlias(value)) {
      const target = await figma.variables.getVariableByIdAsync(value.id);
      if (!target) throw new Error(`Broken alias: ${value.id}`);
      return resolveVariableValue(target, modeId, visited);
    }
    return { value, resolvedType: variable.resolvedType };
  }

  // src/targets/django/tokens.ts
  function isVariableAlias2(value) {
    return typeof value === "object" && value !== null && "type" in value && value.type === "VARIABLE_ALIAS";
  }
  function isRgbColor(value) {
    return typeof value === "object" && value !== null && "r" in value && "g" in value && "b" in value;
  }
  function kebabSegment(segment) {
    return segment.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
  }
  function toCssVarName(figmaName) {
    return "--" + figmaName.split("/").map(kebabSegment).join("-");
  }
  function toDtcgPath(figmaName) {
    return figmaName.split("/").map(kebabSegment);
  }
  function channelToHex(channel) {
    return Math.round(channel * 255).toString(16).padStart(2, "0");
  }
  function rgbaToCss(color) {
    const alpha = "a" in color ? color.a : 1;
    if (alpha === 1) {
      return `#${channelToHex(color.r)}${channelToHex(color.g)}${channelToHex(color.b)}`;
    }
    const to255 = (channel) => Math.round(channel * 255);
    return `rgb(${to255(color.r)} ${to255(color.g)} ${to255(color.b)} / ${+alpha.toFixed(4)})`;
  }
  var MOTION_DURATION_PREFIX = "motion/duration/";
  var MOTION_EASING_PREFIX = "motion/easing/";
  function literalValue(variable, value) {
    if (variable.resolvedType === "COLOR" && isRgbColor(value)) return rgbaToCss(value);
    return value;
  }
  function toCamelCaseName(figmaName) {
    return toDtcgPath(figmaName).join("-").replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
  }
  function resolveLiteralValue(variable, modeId, variablesById, visited = /* @__PURE__ */ new Set()) {
    if (visited.has(variable.id)) throw new Error(`Circular variable alias detected at "${variable.name}"`);
    visited.add(variable.id);
    const value = variable.valuesByMode[modeId];
    if (value === void 0) throw new Error(`Missing value for mode "${modeId}" on "${variable.name}"`);
    if (isVariableAlias2(value)) {
      const target = variablesById.get(value.id);
      if (!target) throw new Error(`Broken alias: ${value.id}`);
      return resolveLiteralValue(target, modeId, variablesById, visited);
    }
    return literalValue(variable, value);
  }
  function emitMotionTokensJs(snapshot) {
    var _a;
    const variablesById = new Map(snapshot.variables.map((variable) => [variable.id, variable]));
    const lines = [];
    for (const collection of snapshot.collections) {
      const modeId = (_a = collection.modes[0]) == null ? void 0 : _a.modeId;
      if (!modeId) continue;
      for (const variable of snapshot.variables.filter((v) => v.collectionId === collection.id)) {
        if (variable.valuesByMode[modeId] === void 0) continue;
        if (variable.resolvedType === "FLOAT" && variable.name.startsWith(MOTION_DURATION_PREFIX)) {
          const ms = resolveLiteralValue(variable, modeId, variablesById);
          lines.push(`export const ${toCamelCaseName(variable.name)} = ${ms / 1e3};`);
        } else if (variable.resolvedType === "STRING" && variable.name.startsWith(MOTION_EASING_PREFIX)) {
          const css = resolveLiteralValue(variable, modeId, variablesById);
          lines.push(`export const ${toCamelCaseName(variable.name)} = ${JSON.stringify(css)};`);
        }
      }
    }
    return lines.join("\n");
  }

  // src/tokens/engine.ts
  function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function slugSegments(name) {
    return String(name).trim().replace(/^--/, "").split(/[/.\s_-]+/).map((p) => p.trim()).filter(Boolean);
  }
  function groupSegments(name) {
    return String(name).trim().replace(/^--/, "").split("/").map((p) => p.trim()).filter(Boolean);
  }
  function figmaColorToCss(value) {
    const r = value.r, g = value.g, b = value.b;
    if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") return String(value);
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
      const name = idToName.get(id);
      return name ? `{${name}}` : `{${id}}`;
    }
    if (isRecord(value) && "r" in value && "g" in value && "b" in value) return figmaColorToCss(value);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    return isRecord(value) ? value : String(value != null ? value : "");
  }
  function setToken(root, path, token2) {
    let cursor = root;
    for (const segment of path.slice(0, -1)) {
      const existing = cursor[segment];
      if (!isRecord(existing) || "$value" in existing) cursor[segment] = {};
      cursor = cursor[segment];
    }
    const leaf = path[path.length - 1];
    if (leaf) cursor[leaf] = token2;
  }
  function resolveCanonicalPaths(variables, collectionById) {
    const SEP = "\0";
    const natural = (v) => {
      const segs = groupSegments(v.name);
      if (segs.length === 0) return null;
      return segs.length > 1 ? segs : [figmaTypeToW3C(v.resolvedType, void 0), segs[0]];
    };
    const ordered = variables.filter((v) => v && typeof v.id === "string" && typeof v.name === "string" && v.name.trim() !== "").map((v) => ({ v, path: natural(v) })).filter((x) => x.path !== null).sort((a, b) => {
      var _a, _b, _c, _d;
      const ca = (_b = (_a = collectionById.get(a.v.collectionId)) == null ? void 0 : _a.name) != null ? _b : "";
      const cb = (_d = (_c = collectionById.get(b.v.collectionId)) == null ? void 0 : _c.name) != null ? _d : "";
      return ca.localeCompare(cb) || a.v.name.localeCompare(b.v.name) || a.v.id.localeCompare(b.v.id);
    });
    const claimed = /* @__PURE__ */ new Set();
    const paths = /* @__PURE__ */ new Map();
    for (const entry of ordered) {
      let candidate = entry.path;
      let key = candidate.join(SEP);
      if (claimed.has(key)) {
        const base = entry.path.slice(0, -1);
        const leaf = entry.path[entry.path.length - 1];
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
  var TEXT_STYLE_COLLECTION = "Text Styles";
  function styleToFontWeight(style) {
    const s = String(style || "").toLowerCase();
    const numeric = s.match(/(?:^|[^0-9])([1-9]00|1000)(?:[^0-9]|$)/);
    if (numeric) return Number(numeric[1]);
    if (/thin|hairline/.test(s)) return 100;
    if (/extra[\s-]?light|ultra[\s-]?light/.test(s)) return 200;
    if (/semi[\s-]?bold|demi[\s-]?bold|\bdemi\b|\bsemi\b/.test(s)) return 600;
    if (/extra[\s-]?bold|ultra[\s-]?bold/.test(s)) return 800;
    if (/black|heavy|ultra|fat|poster/.test(s)) return 900;
    if (/medium\b|\bmed\b/.test(s)) return 500;
    if (/light/.test(s)) return 300;
    if (/bold/.test(s)) return 700;
    return 400;
  }
  function fontWeightOf(ts) {
    if (typeof ts.fontWeight === "number" && isFinite(ts.fontWeight) && ts.fontWeight > 0) return ts.fontWeight;
    if (!ts.fontName || typeof ts.fontName.style !== "string") return void 0;
    return styleToFontWeight(ts.fontName.style);
  }
  function isItalicStyle(style) {
    return /italic|oblique/.test(String(style || "").toLowerCase());
  }
  function isItalicOf(ts) {
    var _a, _b;
    if (typeof ts.italic === "boolean") return ts.italic;
    return isItalicStyle((_b = (_a = ts.fontName) == null ? void 0 : _a.style) != null ? _b : "");
  }
  function lineHeightValue(lh) {
    if (!isRecord(lh)) return null;
    if (lh.unit === "AUTO") return { value: "normal", type: "string" };
    if (typeof lh.value !== "number") return null;
    if (lh.unit === "PERCENT") return { value: Number((lh.value / 100).toFixed(4)), type: "number" };
    return { value: `${Number(lh.value.toFixed(3))}px`, type: "string" };
  }
  function letterSpacingValue(ls) {
    if (!isRecord(ls) || typeof ls.value !== "number") return null;
    if (ls.value === 0) return { value: 0, type: "number" };
    if (ls.unit === "PERCENT") return { value: `${Number((ls.value / 100).toFixed(4))}em`, type: "string" };
    return { value: Number(ls.value.toFixed(3)), type: "number" };
  }
  function boundAlias(boundVariables, field, idToName) {
    if (!isRecord(boundVariables)) return void 0;
    const id = boundVariables[field];
    if (typeof id !== "string" || !id) return void 0;
    const name = idToName.get(id);
    return name ? `{${name}}` : void 0;
  }
  function textStyleLeaves(ts, idToName) {
    const bv = ts.boundVariables;
    const out = [];
    const push = (prop, value, type) => {
      if (value === void 0 || value === null) return;
      out.push({ prop, token: { $type: type, $value: value, $extensions: { modes: {}, figma: { collection: TEXT_STYLE_COLLECTION, defaultMode: "" } } } });
    };
    let family = boundAlias(bv, "fontFamily", idToName);
    if (family === void 0 && ts.fontName && typeof ts.fontName.family === "string") family = ts.fontName.family;
    push("font-family", family, "string");
    let size = boundAlias(bv, "fontSize", idToName);
    if (size === void 0 && typeof ts.fontSize === "number") size = ts.fontSize;
    push("font-size", size, "number");
    let weight = boundAlias(bv, "fontWeight", idToName);
    if (weight === void 0) weight = fontWeightOf(ts);
    push("font-weight", weight, "number");
    if (isItalicOf(ts)) push("font-style", "italic", "string");
    const lhAlias = boundAlias(bv, "lineHeight", idToName);
    if (lhAlias !== void 0) push("line-height", lhAlias, "number");
    else {
      const lh = lineHeightValue(ts.lineHeight);
      if (lh) push("line-height", lh.value, lh.type);
    }
    const lsAlias = boundAlias(bv, "letterSpacing", idToName);
    if (lsAlias !== void 0) push("letter-spacing", lsAlias, "number");
    else {
      const ls = letterSpacingValue(ts.letterSpacing);
      if (ls) push("letter-spacing", ls.value, ls.type);
    }
    const psAlias = boundAlias(bv, "paragraphSpacing", idToName);
    if (psAlias !== void 0) push("paragraph-spacing", psAlias, "number");
    else if (typeof ts.paragraphSpacing === "number" && ts.paragraphSpacing > 0) push("paragraph-spacing", ts.paragraphSpacing, "number");
    const piAlias = boundAlias(bv, "paragraphIndent", idToName);
    if (piAlias !== void 0) push("paragraph-indent", piAlias, "number");
    else if (typeof ts.paragraphIndent === "number" && ts.paragraphIndent > 0) push("paragraph-indent", ts.paragraphIndent, "number");
    return out;
  }
  function addTextStyleTokens(out, textStyles, idToName) {
    const SEP = "";
    const list = (Array.isArray(textStyles) ? textStyles : []).filter((t) => t && typeof t.name === "string" && t.name.trim() !== "").slice().sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)));
    const claimed = /* @__PURE__ */ new Set();
    for (const ts of list) {
      let base = ["typography"].concat(groupSegments(ts.name));
      let key = base.join(SEP);
      if (claimed.has(key)) {
        const stem = base.slice(0, -1);
        const last = base[base.length - 1];
        let n = 2;
        do {
          base = stem.concat([`${last}-${n}`]);
          key = base.join(SEP);
          n++;
        } while (claimed.has(key));
      }
      claimed.add(key);
      const leavesArr = textStyleLeaves(ts, idToName);
      for (const leaf of leavesArr) setToken(out, base.concat([leaf.prop]), leaf.token);
    }
  }
  var EFFECT_STYLE_COLLECTION = "Effect Styles";
  var SHADOW_ROOT = "shadow";
  var BLUR_ROOT = "blur";
  function round(value) {
    return Number(Number(value).toFixed(3));
  }
  function stripLeadingGroup(segments, groups) {
    if (segments.length > 1 && groups.indexOf(segments[0].trim().toLowerCase()) !== -1) return segments.slice(1);
    return segments.slice();
  }
  function shadowEffectToCss(effect) {
    var _a, _b;
    if (effect.type !== "DROP_SHADOW" && effect.type !== "INNER_SHADOW") return null;
    const offset = (_a = effect.offset) != null ? _a : { x: 0, y: 0 };
    const parts = [
      `${round(offset.x)}px`,
      `${round(offset.y)}px`,
      `${round((_b = effect.radius) != null ? _b : 0)}px`
    ];
    if (effect.spread) parts.push(`${round(effect.spread)}px`);
    const color = effect.color ? figmaColorToCss(effect.color) : "rgba(0, 0, 0, 0.25)";
    const inset = effect.type === "INNER_SHADOW" ? "inset " : "";
    return `${inset}${parts.join(" ")} ${color}`;
  }
  function blurEffectToCss(effect) {
    var _a;
    if (effect.type !== "LAYER_BLUR" && effect.type !== "BACKGROUND_BLUR") return null;
    return `blur(${round((_a = effect.radius) != null ? _a : 0)}px)`;
  }
  function addEffectStyleTokens(out, effectStyles) {
    const list = (Array.isArray(effectStyles) ? effectStyles : []).filter(
      (style) => style && typeof style.name === "string" && style.name.trim() !== ""
    );
    for (const style of list) {
      const visible = (style.effects || []).filter((effect) => effect && effect.visible !== false);
      const shadows = visible.map(shadowEffectToCss).filter((css) => css !== null);
      const blurs = visible.map(blurEffectToCss).filter((css) => css !== null);
      const segments = groupSegments(style.name);
      if (segments.length === 0) continue;
      const named = stripLeadingGroup(segments, ["shadow", "shadows", "effect", "effects", "elevation", "elevations"]);
      const blurNamed = stripLeadingGroup(segments, ["blur", "blurs", "effect", "effects"]);
      const extensions = () => ({ modes: {}, figma: { collection: EFFECT_STYLE_COLLECTION, defaultMode: "" } });
      if (shadows.length > 0) {
        setToken(out, [SHADOW_ROOT].concat(named), { $type: "shadow", $value: shadows.join(", "), $extensions: extensions() });
      }
      if (blurs.length > 0) {
        setToken(out, [BLUR_ROOT].concat(blurNamed), { $type: "string", $value: blurs.join(" "), $extensions: extensions() });
      }
    }
  }
  function variablesToW3CMultiMode(graph) {
    var _a;
    const out = {};
    const collections = Array.isArray(graph == null ? void 0 : graph.collections) ? graph.collections : [];
    const variables = Array.isArray(graph == null ? void 0 : graph.variables) ? graph.variables : [];
    const collectionById = /* @__PURE__ */ new Map();
    for (const c of collections) if (c && typeof c.id === "string") collectionById.set(c.id, c);
    const canonicalPaths = resolveCanonicalPaths(variables, collectionById);
    const idToName = /* @__PURE__ */ new Map();
    for (const [id, path] of canonicalPaths) idToName.set(id, path.join("."));
    for (const variable of variables) {
      const path = canonicalPaths.get(variable.id);
      if (!path) continue;
      const valuesByMode = isRecord(variable.valuesByMode) ? variable.valuesByMode : {};
      const collection = collectionById.get(variable.collectionId);
      const modes = collection && Array.isArray(collection.modes) && collection.modes.length > 0 ? collection.modes : Object.keys(valuesByMode).map((modeId) => ({ modeId, name: modeId }));
      if (modes.length === 0) continue;
      const byMode = {};
      for (const mode of modes) {
        if (!(mode.modeId in valuesByMode)) continue;
        byMode[mode.name] = normalizeVariableValue(valuesByMode[mode.modeId], idToName);
      }
      const defaultModeId = collection && typeof collection.defaultModeId === "string" ? collection.defaultModeId : modes[0].modeId;
      const defaultMode = (_a = modes.find((m) => m.modeId === defaultModeId)) != null ? _a : modes[0];
      const defaultValue = defaultMode.name in byMode ? byMode[defaultMode.name] : Object.values(byMode)[0];
      if (defaultValue === void 0) continue;
      const explicitType = figmaTypeToW3C(variable.resolvedType, defaultValue);
      const collectionName = collection && typeof collection.name === "string" ? collection.name : void 0;
      const $extensions = { modes: byMode };
      if (collectionName) {
        $extensions.figma = { collection: collectionName, defaultMode: defaultMode.name };
        const scopes = Array.isArray(variable.scopes) ? variable.scopes.filter((scope) => scope !== "ALL_SCOPES") : [];
        if (scopes.length > 0) $extensions.figma.scopes = scopes;
      }
      setToken(out, path, { $type: explicitType, $value: defaultValue, $extensions });
    }
    addTextStyleTokens(out, graph.textStyles, idToName);
    addEffectStyleTokens(out, graph.effectStyles);
    return out;
  }
  function isTokenLeaf(value) {
    return isRecord(value) && "$value" in value;
  }
  function leaves(tree, prefix = []) {
    const out = [];
    for (const key of Object.keys(tree)) {
      const value = tree[key];
      const path = prefix.concat([key]);
      if (isTokenLeaf(value)) out.push({ path, token: value });
      else if (isRecord(value)) out.push(...leaves(value, path));
    }
    return out;
  }
  var NON_IDENT_CHARS = /[^0-9a-zÀ-ɏͰ-ӿ԰-׿؀-ۿ฀-๿぀-ヿ一-鿿가-힯]+/g;
  function varName(segments) {
    return segments.reduce((acc, segment) => acc.concat(slugSegments(segment)), []).map((segment) => segment.toLowerCase().replace(NON_IDENT_CHARS, "-").replace(/^-+|-+$/g, "")).filter(Boolean).join("-");
  }
  function aliasTarget(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/^\{(.+)\}$/);
    if (!match) return null;
    return match[1].split(".").map((p) => p.trim()).filter(Boolean);
  }
  var UNITLESS_TOKEN = /(^|[-_])(opacity|z-?index|font-?weight|weight|line-?height|lineheight|flex|order|aspect|ratio|scale|count|columns?)([-_]|$)/i;
  var LINE_HEIGHT_TOKEN = /(^|[-_])line-?height([-_]|$)/i;
  var LINE_HEIGHT_RATIO_MAX = 4;
  function roundEmitted(value) {
    return Math.round(value * 100) / 100;
  }
  function cssValue(value, path) {
    const alias = aliasTarget(value);
    if (alias) return `var(--${varName(alias)})`;
    if (typeof value === "number") {
      const rounded = roundEmitted(value);
      if (rounded === 0) return "0";
      if (path && path.some((seg) => LINE_HEIGHT_TOKEN.test(seg))) {
        return Math.abs(rounded) < LINE_HEIGHT_RATIO_MAX ? String(rounded) : `${rounded}px`;
      }
      const unitless = path ? path.some((seg) => UNITLESS_TOKEN.test(seg)) : false;
      return unitless ? String(rounded) : `${rounded}px`;
    }
    if (typeof value === "boolean") return String(value);
    if (typeof value === "string") return value;
    return String(value != null ? value : "");
  }
  function isAliasValue(value) {
    return typeof value === "string" && /^\{.+\}$/.test(value);
  }
  function modesOf(token2) {
    var _a;
    const modes = (_a = token2.$extensions) == null ? void 0 : _a.modes;
    return isRecord(modes) ? modes : {};
  }
  function collectionOf(token2) {
    var _a;
    const figma2 = (_a = token2.$extensions) == null ? void 0 : _a.figma;
    if (isRecord(figma2) && typeof figma2.collection === "string") return figma2.collection;
    return void 0;
  }
  function collectionDefaultModeOf(token2) {
    var _a;
    const figma2 = (_a = token2.$extensions) == null ? void 0 : _a.figma;
    if (isRecord(figma2) && typeof figma2.defaultMode === "string") return figma2.defaultMode;
    return void 0;
  }
  function pickDefaultTheme(allLeaves, themes, hint) {
    if (themes.indexOf(hint) !== -1) return hint;
    for (const entry of allLeaves) {
      const def = collectionDefaultModeOf(entry.token);
      if (def && themes.indexOf(def) !== -1) return def;
    }
    return themes[0];
  }
  function participatesInTheming(token2) {
    const modes = modesOf(token2);
    const names = Object.keys(modes);
    return names.length >= 2 || isAliasValue(token2.$value) || names.some((n) => isAliasValue(modes[n]));
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
      themes.push(hint && hint.trim() || firstModes[0] || "default");
    }
    return themes;
  }
  function valueForTheme(token2, theme) {
    const modes = modesOf(token2);
    return theme in modes ? modes[theme] : token2.$value;
  }
  function themeSlug(theme) {
    return varName([theme]) || theme;
  }
  var SCALE_TOKEN_KEY = "altery-typo-scale";
  function isScaleToken(token2) {
    var _a;
    const figma2 = (_a = token2.$extensions) == null ? void 0 : _a.figma;
    return isRecord(figma2) && figma2.collection === "Typography" && figma2.defaultMode === SCALE_TOKEN_KEY;
  }
  var TSHIRT_LADDER = ["3xs", "2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl"];
  var WEIGHT_NAMES = { 100: "thin", 200: "extra-light", 300: "light", 400: "regular", 500: "medium", 600: "semi-bold", 700: "bold", 800: "extra-bold", 900: "black" };
  function numericKey(v) {
    return typeof v === "number" ? v : 0;
  }
  function valueNameToken(v) {
    if (typeof v === "number") return String(Math.round(v));
    return slugSegments(String(v)).join("-") || "default";
  }
  var TYPO_AXIS_SCOPE = {
    "font-size": ["FONT_SIZE"],
    "font-family": ["FONT_FAMILY"],
    "font-weight": ["FONT_WEIGHT"],
    "line-height": ["LINE_HEIGHT"],
    "letter-spacing": ["LETTER_SPACING"],
    "paragraph-spacing": ["PARAGRAPH_SPACING"],
    "paragraph-indent": ["PARAGRAPH_INDENT"]
  };
  function planTypographyVariables(graph, options) {
    var _a;
    const naming = (options == null ? void 0 : options.typoNaming) === "value" ? "value" : "tshirt";
    const styles = (Array.isArray(graph == null ? void 0 : graph.textStyles) ? graph.textStyles : []).filter((t) => t && typeof t.name === "string" && t.name.trim() !== "").slice().sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)));
    const axes = {
      "font-size": { type: "FLOAT", field: "fontSize", get: (t) => typeof t.fontSize === "number" ? t.fontSize : void 0 },
      "font-family": { type: "STRING", field: "fontFamily", get: (t) => t.fontName && typeof t.fontName.family === "string" ? t.fontName.family : void 0 },
      "font-weight": { type: "FLOAT", field: "fontWeight", get: (t) => fontWeightOf(t) },
      "line-height": {
        type: "FLOAT",
        field: "lineHeight",
        get: (t) => {
          const lh = t.lineHeight;
          if (!isRecord(lh) || typeof lh.value !== "number") return void 0;
          if (lh.unit === "PIXELS") return lh.value;
          if (lh.unit === "PERCENT") return Number((lh.value / 100).toFixed(4));
          return void 0;
        },
        bindOk: (t) => isRecord(t.lineHeight) && t.lineHeight.unit === "PIXELS"
      },
      "letter-spacing": { type: "FLOAT", field: "letterSpacing", get: (t) => isRecord(t.letterSpacing) && t.letterSpacing.unit === "PIXELS" && typeof t.letterSpacing.value === "number" ? t.letterSpacing.value : void 0 },
      "paragraph-spacing": { type: "FLOAT", field: "paragraphSpacing", get: (t) => typeof t.paragraphSpacing === "number" && t.paragraphSpacing > 0 ? t.paragraphSpacing : void 0 },
      "paragraph-indent": { type: "FLOAT", field: "paragraphIndent", get: (t) => typeof t.paragraphIndent === "number" && t.paragraphIndent > 0 ? t.paragraphIndent : void 0 }
    };
    const order = ["font-size", "font-family", "font-weight", "line-height", "letter-spacing", "paragraph-spacing", "paragraph-indent"];
    const keyOf = (v) => typeof v + ":" + String(v);
    const variables = [];
    const nameByAxisValue = {};
    for (const axis of order) {
      const ax = axes[axis];
      if (!ax) continue;
      const distinct = /* @__PURE__ */ new Map();
      for (const t of styles) {
        const v = ax.get(t);
        if (v === void 0 || v === null) continue;
        if (!distinct.has(keyOf(v))) distinct.set(keyOf(v), v);
      }
      if (distinct.size === 0) continue;
      const entries = Array.from(distinct.values());
      if (axis === "font-family") {
        entries.sort((a, b) => String(a).localeCompare(String(b)));
      } else {
        entries.sort((a, b) => numericKey(a) - numericKey(b));
      }
      let nameFor;
      if (axis === "font-family") {
        nameFor = (v) => varName([String(v)]) || "default";
      } else if (axis === "font-weight") {
        nameFor = (v) => WEIGHT_NAMES[Number(v)] || valueNameToken(v);
      } else if (naming === "tshirt" && (axis === "font-size" || axis === "line-height")) {
        const idx = /* @__PURE__ */ new Map();
        entries.forEach((v, i) => {
          idx.set(keyOf(v), TSHIRT_LADDER[i] || valueNameToken(v));
        });
        nameFor = (v) => idx.get(keyOf(v));
      } else {
        nameFor = (v) => valueNameToken(v);
      }
      nameByAxisValue[axis] = /* @__PURE__ */ new Map();
      const used = {};
      for (const v of entries) {
        let leaf = nameFor(v);
        while (used[leaf]) leaf = leaf + "-2";
        used[leaf] = true;
        const name = axis + "/" + leaf;
        nameByAxisValue[axis].set(keyOf(v), name);
        variables.push({ name, type: ax.type, value: v, scopes: TYPO_AXIS_SCOPE[axis] || [] });
      }
    }
    const bindings = [];
    for (const t of styles) {
      for (const axis of order) {
        const ax = axes[axis];
        if (!ax) continue;
        const v = ax.get(t);
        if (v === void 0 || v === null) continue;
        if (ax.bindOk && !ax.bindOk(t)) continue;
        const varName_ = (_a = nameByAxisValue[axis]) == null ? void 0 : _a.get(keyOf(v));
        if (varName_) bindings.push({ styleId: t.id, styleName: t.name, field: ax.field, varName: varName_ });
      }
    }
    return { collectionName: "Typography", variables, bindings };
  }
  function extractTypographyScale(tree, options) {
    return tree;
  }
  function inlinePrimitivesTree(tree, flattenAll) {
    const all = leaves(tree);
    const byName = /* @__PURE__ */ new Map();
    for (const e of all) byName.set(e.path.join("."), e);
    const primitive = /* @__PURE__ */ new Set();
    for (const e of all) if (!participatesInTheming(e.token) && !isScaleToken(e.token)) primitive.add(e.path.join("."));
    const referenced = /* @__PURE__ */ new Set();
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
    const inline = (value, theme, seen, originPath) => {
      if (!isAliasValue(value)) {
        return originPath && typeof value === "number" ? cssValue(value, originPath) : value;
      }
      const target = aliasTarget(value).join(".");
      if (!byName.has(target) || seen.has(target)) return value;
      if (!flattenAll && !primitive.has(target)) return value;
      const entry = byName.get(target);
      const next = new Set(seen);
      next.add(target);
      return inline(valueForTheme(entry.token, theme), theme, next, entry.path);
    };
    const out = {};
    for (const e of all) {
      const name = e.path.join(".");
      if (primitive.has(name)) {
        if (referenced.has(name)) continue;
        setToken(out, e.path, e.token);
        continue;
      }
      const token2 = e.token;
      const modes = modesOf(token2);
      const newModes = {};
      for (const k of Object.keys(modes)) newModes[k] = inline(modes[k], k, /* @__PURE__ */ new Set());
      const defMode = collectionDefaultModeOf(token2);
      const themeForDefault = defMode && defMode in modes ? defMode : Object.keys(modes)[0];
      const newDefault = inline(token2.$value, themeForDefault, /* @__PURE__ */ new Set());
      const $extensions = __spreadProps(__spreadValues({}, token2.$extensions), { modes: newModes });
      setToken(out, e.path, { $type: token2.$type, $value: newDefault, $extensions });
    }
    return out;
  }
  function themeDeclarations(allLeaves, theme) {
    const order = [];
    const groups = /* @__PURE__ */ new Map();
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
    const defaultTheme = pickDefaultTheme(allLeaves, themes, defaultModeName || themes[0]);
    const ordered = [defaultTheme].concat(themes.filter((t) => t !== defaultTheme));
    return { defaultTheme, ordered };
  }
  function themeBlock(allLeaves, theme, selector) {
    return `${selector} {
${themeDeclarations(allLeaves, theme).join("\n")}
}`;
  }
  function cssAttrValue(value) {
    return String(value).replace(/[\\"]/g, "\\$&");
  }
  var RENAMES_EXTENSION = "altery";
  var segmentsOf = (name) => name.split("/").filter((segment) => segment.trim() !== "");
  function legacyAliasPairs(tree, renames) {
    if (!renames) return [];
    const emitted = new Set(leaves(tree).map((entry) => varName(entry.path)));
    const pairs = [];
    const seen = /* @__PURE__ */ new Set();
    for (const key of Object.keys(renames)) {
      const from = varName(segmentsOf(key));
      const to = varName(segmentsOf(renames[key]));
      if (from === "" || to === "" || from === to) continue;
      if (!emitted.has(to) || emitted.has(from) || seen.has(from)) continue;
      seen.add(from);
      pairs.push({ from, to });
    }
    return pairs.sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
  }
  var LEGACY_COMMENT = "/* Renamed by a color remap \u2014 the old names keep resolving */";
  function toLegacyAliasCss(pairs, selector = ":root") {
    if (pairs.length === 0) return "";
    const lines = pairs.map((pair2) => `  --${pair2.from}: var(--${pair2.to});`);
    return `${LEGACY_COMMENT}
${selector} {
${lines.join("\n")}
}
`;
  }
  function toTokensCss(tree, ordered, defaultTheme, attr, renames) {
    const a = attr || "data-theme-name";
    const allLeaves = leaves(tree);
    if (allLeaves.length === 0) return "";
    const blocks = ordered.map((theme) => {
      const themeSel = `[${a}="${cssAttrValue(theme)}"]`;
      const selector = theme === defaultTheme ? `:root,
${themeSel}` : themeSel;
      return themeBlock(allLeaves, theme, selector);
    });
    const legacy = toLegacyAliasCss(legacyAliasPairs(tree, renames));
    return blocks.join("\n\n") + "\n" + (legacy === "" ? "" : "\n" + legacy);
  }
  function toThemeModuleCssFiles(tree, ordered, defaultTheme, attr, useGlobal, renames) {
    const a = attr || "data-theme-name";
    const wrap = useGlobal ? (sel) => `:global(${sel})` : (sel) => sel;
    const allLeaves = leaves(tree);
    const files = {};
    if (allLeaves.length === 0) return files;
    const used = /* @__PURE__ */ new Set();
    for (const theme of ordered) {
      const themeSel = wrap(`[${a}="${cssAttrValue(theme)}"]`);
      const selector = theme === defaultTheme ? `${wrap(":root")},
${themeSel}` : themeSel;
      const base = varName([theme]) || "theme";
      let name = base;
      let n = 2;
      while (used.has(name)) name = `${base}-${n++}`;
      used.add(name);
      const legacy = theme === defaultTheme ? toLegacyAliasCss(legacyAliasPairs(tree, renames), wrap(":root")) : "";
      files[`${name}.module.css`] = themeBlock(allLeaves, theme, selector) + "\n" + (legacy === "" ? "" : "\n" + legacy);
    }
    return files;
  }
  function buildTsTree(allLeaves) {
    const root = {};
    for (const entry of allLeaves) {
      let cursor = root;
      for (const segment of entry.path.slice(0, -1)) {
        const next = cursor[segment];
        if (typeof next === "string" || next === void 0) cursor[segment] = {};
        cursor = cursor[segment];
      }
      const leaf = entry.path[entry.path.length - 1];
      cursor[leaf] = `var(--${varName(entry.path)})`;
    }
    return root;
  }
  function renderTsTree(tree, indent2) {
    const inner = indent2 + "  ";
    const entries = Object.keys(tree).map((key) => {
      const value = tree[key];
      const renderedKey = JSON.stringify(key);
      if (typeof value === "string") return `${inner}${renderedKey}: ${JSON.stringify(value)},`;
      return `${inner}${renderedKey}: ${renderTsTree(value, inner)},`;
    });
    return `{
${entries.join("\n")}
${indent2}}`;
  }
  function toTokensTs(tree, themes) {
    const allLeaves = leaves(tree);
    const tsTree = buildTsTree(allLeaves);
    return `export const tokens = ${renderTsTree(tsTree, "")} as const;
export type Tokens = typeof tokens;

export const themes = ${JSON.stringify(themes)} as const;
export type Theme = (typeof themes)[number];
`;
  }
  function toTokensJson(tree, renames) {
    const payload = renames && Object.keys(renames).length > 0 ? __spreadProps(__spreadValues({}, tree), { $extensions: { [RENAMES_EXTENSION]: { renames } } }) : tree;
    return JSON.stringify(payload, null, 2) + "\n";
  }
  function extractBreakpointTokens(graph) {
    const out = {};
    if (!(graph == null ? void 0 : graph.collections) || !(graph == null ? void 0 : graph.variables)) return out;
    const coll = graph.collections.filter((c) => c.name.trim().toLowerCase() === "breakpoints")[0];
    if (!coll) return out;
    const bpModeNames = { desktop: 1, tablet: 1, mobile: 1, xl: 1, lg: 1, md: 1, sm: 1, xs: 1 };
    const modeKeys = (coll.modes || []).map((m) => m.name.trim().toLowerCase());
    const looksModeBased = (coll.modes || []).length >= 2 && modeKeys.every((k) => bpModeNames[k] || /^\d{3,5}$/.test(k));
    if (looksModeBased) {
      const tokens = {};
      for (const v of graph.variables) {
        if (v.collectionId !== coll.id || v.resolvedType !== "FLOAT") continue;
        for (const mode of coll.modes || []) {
          const value = v.valuesByMode[mode.modeId];
          if (typeof value !== "number" || !isFinite(value) || value <= 0) continue;
          const key = mode.name.trim().toLowerCase();
          if (!key) continue;
          const existing = tokens[key];
          if (existing === void 0 || value > existing) tokens[key] = Math.round(value);
        }
      }
      if (Object.keys(tokens).length > 0) return tokens;
    }
    const tokens2 = {};
    for (const v of graph.variables) {
      if (v.collectionId !== coll.id || v.resolvedType !== "FLOAT") continue;
      const value = v.valuesByMode[coll.defaultModeId || ""];
      if (typeof value !== "number" || !isFinite(value) || value <= 0) continue;
      const segs = v.name.split("/");
      const key = segs[segs.length - 1].trim().toLowerCase();
      if (key) tokens2[key] = Math.round(value);
    }
    return tokens2;
  }
  function primaryDefaultMode(graph) {
    const collections = (graph == null ? void 0 : graph.collections) || [];
    for (const c of collections) {
      const modes = c.modes || [];
      const mode = modes.find((m) => m.modeId === c.defaultModeId) || modes[0];
      if (mode == null ? void 0 : mode.name) return mode.name;
    }
    return "default";
  }
  function hasTypographyVars(graph) {
    return ((graph == null ? void 0 : graph.collections) || []).some((c) => c.name.trim().toLowerCase() === "typography");
  }
  function hasBreakpointCollection(graph) {
    return ((graph == null ? void 0 : graph.collections) || []).some((c) => c.name.trim().toLowerCase() === "breakpoints");
  }
  function hasGeneratedBpCollection(graph) {
    return ((graph == null ? void 0 : graph.collections) || []).some((c) => {
      var _a;
      return ((_a = c.name) == null ? void 0 : _a.trim().toLowerCase()) === "breakpoints" && c.generated;
    });
  }
  function buildSummary(graph, tree) {
    const all = leaves(tree);
    const collections = (graph.collections || []).map((c) => ({
      name: c.name,
      modes: (c.modes || []).map((m) => m.name),
      variableCount: (graph.variables || []).filter((v) => v.collectionId === c.id).length
    }));
    const textStyleCount = (graph.textStyles || []).length;
    if (textStyleCount > 0) collections.push({ name: TEXT_STYLE_COLLECTION, modes: [], variableCount: textStyleCount });
    const effectStyleCount = (graph.effectStyles || []).length;
    if (effectStyleCount > 0) collections.push({ name: EFFECT_STYLE_COLLECTION, modes: [], variableCount: effectStyleCount });
    return {
      fileName: graph.fileName || "Untitled",
      collections,
      totalVariables: (graph.variables || []).length,
      textStyleCount,
      effectStyleCount,
      hasTypographyVars: hasTypographyVars(graph),
      hasGeneratedTypoCollection: (graph.collections || []).some((c) => c.generated),
      hasBreakpointCollection: hasBreakpointCollection(graph),
      hasGeneratedBpCollection: hasGeneratedBpCollection(graph),
      tokenCount: all.length,
      themes: themeModesOf(all)
    };
  }
  function readmeExample(tree) {
    if (!tree) return "";
    const all = leaves(tree);
    const firstMatching = (test) => {
      for (const leaf of all) {
        const slug2 = varName(leaf.path);
        if (test(slug2, String(leaf.token.$type || ""))) return slug2;
      }
      return null;
    };
    const background2 = firstMatching((_slug, type) => type === "color");
    const padding = firstMatching(
      (slug2, type) => type === "number" && /(^|-)(spacing|space|gap|padding|inset)(-|$)/.test(slug2)
    );
    const radius = firstMatching((slug2, type) => type === "number" && /(^|-)(radius|radii|corner)(-|$)/.test(slug2));
    const lines = [
      background2 ? `  background: var(--${background2});` : null,
      padding ? `  padding: var(--${padding});` : null,
      radius ? `  border-radius: var(--${radius});` : null
    ].filter(Boolean);
    if (lines.length === 0) return "";
    return `

\`\`\`css
.button {
${lines.join("\n")}
}
\`\`\``;
  }
  function buildReadme(summary, options, tree, renames) {
    const attr = options.themeAttr;
    const themeList = summary.themes.map((t) => `\`${t}\``).join(", ");
    const moduleList = summary.themes.map((t) => `\`${varName([t])}.module.css\``).join(", ");
    const collLines = summary.collections.map(
      (c) => c.modes.length ? `- **${c.name}** \u2014 ${c.variableCount} variables, modes: ${c.modes.map((m) => `\`${m}\``).join(", ")}` : c.name === EFFECT_STYLE_COLLECTION ? `- **${c.name}** \u2014 ${c.variableCount} effect styles \u2192 \`shadow/\u2026\` / \`blur/\u2026\` tokens` : `- **${c.name}** \u2014 ${c.variableCount} text styles \u2192 \`typography/\u2026\` tokens`
    ).join("\n");
    const defaultTheme = summary.themes[0] || "Light";
    const others = summary.themes.filter((t) => t !== defaultTheme);
    const switchExample = others.length ? `

Switch theme by setting the attribute on any ancestor (e.g. \`<html>\`):

\`\`\`html
<html ${attr}="${others[0]}">
\`\`\`` : "";
    const rootSel = options.cssModulesGlobal ? ":global(:root)" : ":root";
    const moduleSel = options.cssModulesGlobal ? `:global([${attr}="\u2026"])` : `[${attr}="\u2026"]`;
    const moduleRow = options.emitModuleFiles ? `
| \`<theme>.module.css\` | The same blocks, one file per theme (${moduleList}). Every variable under \`${moduleSel}\` \u2014 the default theme also on \`${rootSel}\`. Concatenated, they reproduce \`tokens.css\`. |` : "";
    const inlineNote = !options.inlinePrimitives ? "Primitives are emitted as their own variables; semantic tokens reference them with `var(--\u2026)`." : options.flattenAliases ? "**Every** alias is resolved to a literal \u2014 no `var(--\u2026)` references remain anywhere. `tokens.json` keeps the full, un-inlined tree for re-import." : "Primitive (raw, single-mode) values are **inlined** into the semantic tokens that use them, so the primitive layer doesn't appear as its own variables. References between semantic tokens stay as `var(--\u2026)`. `tokens.json` keeps the full, un-inlined tree for re-import.";
    const settingsLine = [
      `inline primitives \`${options.inlinePrimitives ? "on" : "off"}\``,
      options.inlinePrimitives ? `flatten all \`${options.flattenAliases ? "on" : "off"}\`` : null,
      `typography scale \`${options.typoExtract ? "on" : "off"}\``,
      options.typoExtract ? `scale only \`${options.typoScaleOnly ? "on" : "off"}\`` : null,
      options.typoExtract ? `scale names \`${options.typoNaming === "value" ? "by value" : "t-shirt"}\`` : null,
      options.typoExtract && !options.typoScaleOnly ? `font shorthand \`${options.typoShorthand ? "on" : "off"}\`` : null,
      `theme attribute \`${attr}\``,
      `per-theme modules \`${options.emitModuleFiles ? "on" : "off"}\``,
      options.emitModuleFiles ? `\`:global()\` \`${options.cssModulesGlobal ? "on" : "off"}\`` : null
    ].filter(Boolean).join(" \xB7 ");
    const typoNote = options.typoExtract && summary.textStyleCount ? options.typoScaleOnly ? "\n\nText-style values are factored into a shared typography scale (`--font-size-\u2026`, `--font-weight-\u2026`, \u2026). Only the scale is emitted \u2014 compose each text style in your own CSS by referencing the primitives directly (e.g. `font-size: var(--font-size-md)`)." : "\n\nText-style values are factored into a shared typography scale (`--font-size-\u2026`, `--font-weight-\u2026`, \u2026); each style references the scale with `var(--\u2026)`" + (options.typoShorthand ? ", plus a CSS `font` shorthand token per style (`--<style>-font`)" : "") + "." : "";
    const aliasPairs = tree ? legacyAliasPairs(tree, renames) : [];
    const aliasSection = aliasPairs.length ? `

## Renamed tokens

${aliasPairs.length} custom propert${aliasPairs.length === 1 ? "y was" : "ies were"} renamed in Figma by a color remap. The old names are still declared at the bottom of \`tokens.css\`, pointing at the new ones, so nothing that already imported them breaks:

\`\`\`css
${aliasPairs.slice(0, 6).map((pair2) => `--${pair2.from}: var(--${pair2.to});`).join("\n")}${aliasPairs.length > 6 ? `
/* \u2026and ${aliasPairs.length - 6} more */` : ""}
\`\`\`

They are aliases, not a second source of truth \u2014 migrate to the new names when convenient. \`tokens.ts\` only carries the current names.` : "";
    const moduleSection = options.emitModuleFiles ? `

## Per-theme CSS Modules

The same blocks are also emitted one file per theme \u2014 ${moduleList}${options.cssModulesGlobal ? " \u2014 wrapped in `:global(\u2026)` for CSS-Modules projects (Next.js, etc.)" : ""}. Concatenated (or merged by your bundler), they reproduce \`tokens.css\`.

\`\`\`ts
// build-time: pick one theme, the bundler inlines it
import "./${varName([defaultTheme])}.module.css";
\`\`\`

For **runtime** switching keep every theme present (use \`tokens.css\`, or import
all \`*.module.css\`) and toggle \`${attr}\` on an ancestor.` : "";
    return `# Altery Design Tokens

Generated by the **Altery Design System Export** Figma plugin from **${summary.fileName}**.

- ${summary.totalVariables} variables across ${summary.collections.length} collection(s)${summary.textStyleCount ? `
- ${summary.textStyleCount} text styles \u2192 \`typography/\u2026\` tokens` : ""}
- Themes (modes): ${themeList || "`default`"}
- Settings: ${settingsLine}

## Files

| File | What it is |
|------|------------|
| \`tokens.css\` | CSS custom properties. One self-contained block per theme. The merged single file. |${moduleRow}
| \`tokens.json\` | Canonical W3C token tree (every mode under \`$extensions.modes\`, source collection under \`$extensions.figma\`). For diffing / re-import. |
| \`tokens.ts\` | Typed \`tokens\` object (values are \`var(--\u2026)\` refs) + \`themes\` / \`Theme\`. |

${inlineNote}${typoNote}

## Collections

${collLines}

## Using the tokens

Import the stylesheet once:

\`\`\`css
@import "./tokens.css";
\`\`\`

The default theme (\`${defaultTheme}\`) is applied on \`:root\`, so it works with no attribute set.${switchExample}

Each \`[${attr}="\u2026"]\` block re-declares **every** variable for that theme, so toggling
the attribute swaps the whole set.${readmeExample(tree)}${aliasSection}${moduleSection}
`;
  }
  var DEFAULT_OPTIONS = {
    inlinePrimitives: true,
    flattenAliases: false,
    themeAttr: "data-theme-name",
    emitModuleFiles: true,
    cssModulesGlobal: true,
    typoExtract: true,
    typoScaleOnly: true,
    typoNaming: "tshirt",
    typoShorthand: false,
    delivery: {
      endpoint: "",
      secret: "",
      target: "folder",
      route: { repo: "", branch: "", path: "", package: "" },
      onChange: false,
      onOpen: false
    }
  };
  function sanitizeAttr(value) {
    const cleaned = typeof value === "string" ? value.trim().replace(/[^A-Za-z0-9_-]/g, "") : "";
    return cleaned || DEFAULT_OPTIONS.themeAttr;
  }
  function normalizeDelivery(d) {
    const obj = isRecord(d) ? d : {};
    const s = (v) => typeof v === "string" ? v : "";
    const route = isRecord(obj.route) ? obj.route : {};
    const targets = ["folder", "git", "pr", "npm"];
    return {
      endpoint: s(obj.endpoint).trim(),
      secret: s(obj.secret),
      target: targets.indexOf(obj.target) !== -1 ? obj.target : "folder",
      route: {
        repo: s(route.repo).trim(),
        branch: s(route.branch).trim(),
        path: s(route.path).trim(),
        package: s(route.package).trim()
      },
      onChange: !!obj.onChange,
      onOpen: !!obj.onOpen
    };
  }
  function normalizeOptions(o) {
    const obj = isRecord(o) ? o : {};
    const pick = (key) => obj[key] === void 0 ? DEFAULT_OPTIONS[key] : !!obj[key];
    return {
      inlinePrimitives: pick("inlinePrimitives"),
      flattenAliases: pick("flattenAliases"),
      emitModuleFiles: pick("emitModuleFiles"),
      cssModulesGlobal: pick("cssModulesGlobal"),
      typoExtract: pick("typoExtract"),
      typoScaleOnly: pick("typoScaleOnly"),
      typoNaming: obj.typoNaming === "value" ? "value" : "tshirt",
      typoShorthand: pick("typoShorthand"),
      themeAttr: sanitizeAttr(obj.themeAttr),
      delivery: normalizeDelivery(obj.delivery)
    };
  }
  function buildPackage(graph, options, renames) {
    const opts = normalizeOptions(options);
    const rawTree = variablesToW3CMultiMode(graph);
    const generated = (graph.collections || []).some((c) => c == null ? void 0 : c.generated);
    let sourceTree;
    if (opts.typoExtract && !generated) sourceTree = extractTypographyScale(rawTree, opts);
    else if (opts.typoScaleOnly) {
      sourceTree = __spreadValues({}, rawTree);
      delete sourceTree.typography;
    } else sourceTree = rawTree;
    const summary = buildSummary(graph, sourceTree);
    const files = {};
    const emitted = { tree: {}, themes: [], defaultTheme: "" };
    if (summary.tokenCount > 0) {
      const defaultMode = primaryDefaultMode(graph);
      const { defaultTheme, ordered } = orderedThemes(leaves(sourceTree), defaultMode);
      const cssTree = opts.inlinePrimitives ? inlinePrimitivesTree(sourceTree, opts.flattenAliases) : sourceTree;
      files["tokens.css"] = toTokensCss(cssTree, ordered, defaultTheme, opts.themeAttr, renames);
      if (opts.emitModuleFiles) {
        const themeFiles = toThemeModuleCssFiles(cssTree, ordered, defaultTheme, opts.themeAttr, opts.cssModulesGlobal, renames);
        for (const name of Object.keys(themeFiles)) files[name] = themeFiles[name];
      }
      files["tokens.json"] = toTokensJson(sourceTree, renames);
      files["tokens.ts"] = toTokensTs(cssTree, ordered);
      files["README.md"] = buildReadme(summary, opts, cssTree, renames);
      emitted.tree = cssTree;
      emitted.themes = ordered;
      emitted.defaultTheme = defaultTheme;
    }
    return { summary, files, options: opts, emitted };
  }

  // src/settings.ts
  var DJANGO_BOOTSTRAP_VALUES = {
    target: "django",
    modules: { tokens: true, templates: true, i18n: true, animation: true },
    targetOptions: {
      platform: "django",
      framework: "bootstrap",
      bootstrapFidelity: "components",
      bootstrapSource: "vendored",
      bootstrapVersion: "5.3"
    },
    tokens: { inlinePrimitives: true, flattenAliases: false, themeAttribute: "", emitJson: true, emitScss: false, emitModuleFiles: true, cssModulesGlobal: true, typoExtract: true, typoScaleOnly: true, typoShorthand: false, typoNaming: "tshirt", collectionRoles: "" },
    i18n: { wrapTranslate: true, sourceLanguage: "en" }
  };
  var DESIGN_TOKENS_VALUES = {
    target: "design-tokens",
    modules: { tokens: true, templates: false, i18n: false, animation: false },
    targetOptions: {
      platform: "django",
      framework: "none",
      bootstrapFidelity: "tokens",
      bootstrapSource: "vendored",
      bootstrapVersion: "5.3"
    },
    tokens: { inlinePrimitives: true, flattenAliases: false, themeAttribute: "data-theme-name", emitJson: true, emitScss: false, emitModuleFiles: true, cssModulesGlobal: true, typoExtract: true, typoScaleOnly: true, typoShorthand: false, typoNaming: "tshirt", collectionRoles: "" },
    i18n: { wrapTranslate: true, sourceLanguage: "en" }
  };
  var TAURI_APP_VALUES = {
    target: "django",
    modules: { tokens: true, templates: true, i18n: false, animation: true },
    targetOptions: {
      platform: "tauri",
      framework: "none",
      bootstrapFidelity: "tokens",
      bootstrapSource: "cdn",
      bootstrapVersion: "5.3"
    },
    tokens: { inlinePrimitives: true, flattenAliases: false, themeAttribute: "", emitJson: true, emitScss: false, emitModuleFiles: true, cssModulesGlobal: true, typoExtract: true, typoScaleOnly: true, typoShorthand: false, typoNaming: "tshirt", collectionRoles: "" },
    i18n: { wrapTranslate: true, sourceLanguage: "en" }
  };
  var EXPORT_PRESETS = [
    { id: "django-bootstrap", label: "Django \xD7 Bootstrap", values: DJANGO_BOOTSTRAP_VALUES },
    { id: "tauri-app", label: "Tauri app", values: TAURI_APP_VALUES },
    { id: "design-tokens", label: "Design tokens only", values: DESIGN_TOKENS_VALUES },
    {
      id: "bootstrap-tokens",
      label: "Bootstrap tokens only",
      values: __spreadProps(__spreadValues({}, DJANGO_BOOTSTRAP_VALUES), {
        modules: { tokens: true, templates: false, i18n: false, animation: false },
        targetOptions: __spreadProps(__spreadValues({}, DJANGO_BOOTSTRAP_VALUES.targetOptions), { bootstrapFidelity: "tokens" })
      })
    }
  ];
  function clonePackage(values) {
    return {
      target: values.target,
      modules: __spreadValues({}, values.modules),
      targetOptions: __spreadValues({}, values.targetOptions),
      tokens: __spreadValues({}, values.tokens),
      i18n: __spreadValues({}, values.i18n)
    };
  }
  var DEFAULT_DELIVERY = { endpoint: "", secret: "", onExport: false };
  var DEFAULT_LINT = { maxNestingDepth: 8 };
  var DEFAULT_DOCS = { componentDocs: true, componentPreviews: false, previewBudgetMb: 8 };
  var DEFAULT_EXPORT_OPTIONS = __spreadValues({
    scopeMode: "page",
    delivery: __spreadValues({}, DEFAULT_DELIVERY),
    lint: __spreadValues({}, DEFAULT_LINT),
    docs: __spreadValues({}, DEFAULT_DOCS)
  }, clonePackage(DJANGO_BOOTSTRAP_VALUES));
  function isRecord2(value) {
    return typeof value === "object" && value !== null;
  }
  function isScopeMode(value) {
    return value === "page" || value === "selection" || value === "frame";
  }
  function isTargetId(value) {
    return value === "design-tokens" || value === "django" || value === "ds-tools";
  }
  function normalizeModules(raw) {
    const defaults = DJANGO_BOOTSTRAP_VALUES.modules;
    if (!isRecord2(raw)) return __spreadValues({}, defaults);
    return {
      tokens: typeof raw.tokens === "boolean" ? raw.tokens : defaults.tokens,
      templates: typeof raw.templates === "boolean" ? raw.templates : defaults.templates,
      i18n: typeof raw.i18n === "boolean" ? raw.i18n : defaults.i18n,
      animation: typeof raw.animation === "boolean" ? raw.animation : defaults.animation
    };
  }
  function normalizeTargetOptions(raw) {
    const defaults = DJANGO_BOOTSTRAP_VALUES.targetOptions;
    if (!isRecord2(raw)) return __spreadValues({}, defaults);
    return {
      platform: raw.platform === "django" || raw.platform === "tauri" ? raw.platform : defaults.platform,
      framework: raw.framework === "none" || raw.framework === "bootstrap" ? raw.framework : defaults.framework,
      bootstrapFidelity: raw.bootstrapFidelity === "tokens" || raw.bootstrapFidelity === "utilities" || raw.bootstrapFidelity === "components" || raw.bootstrapFidelity === "theme" ? raw.bootstrapFidelity : defaults.bootstrapFidelity,
      bootstrapSource: raw.bootstrapSource === "assume" || raw.bootstrapSource === "cdn" || raw.bootstrapSource === "vendored" ? raw.bootstrapSource : defaults.bootstrapSource,
      bootstrapVersion: typeof raw.bootstrapVersion === "string" && raw.bootstrapVersion.trim() !== "" ? raw.bootstrapVersion.trim() : defaults.bootstrapVersion
    };
  }
  function normalizeTokens(raw) {
    const defaults = DJANGO_BOOTSTRAP_VALUES.tokens;
    if (!isRecord2(raw)) return __spreadValues({}, defaults);
    return {
      inlinePrimitives: typeof raw.inlinePrimitives === "boolean" ? raw.inlinePrimitives : defaults.inlinePrimitives,
      flattenAliases: typeof raw.flattenAliases === "boolean" ? raw.flattenAliases : defaults.flattenAliases,
      themeAttribute: typeof raw.themeAttribute === "string" ? raw.themeAttribute.trim() : defaults.themeAttribute,
      emitJson: typeof raw.emitJson === "boolean" ? raw.emitJson : defaults.emitJson,
      emitScss: typeof raw.emitScss === "boolean" ? raw.emitScss : defaults.emitScss,
      emitModuleFiles: typeof raw.emitModuleFiles === "boolean" ? raw.emitModuleFiles : defaults.emitModuleFiles,
      cssModulesGlobal: typeof raw.cssModulesGlobal === "boolean" ? raw.cssModulesGlobal : defaults.cssModulesGlobal,
      typoExtract: typeof raw.typoExtract === "boolean" ? raw.typoExtract : defaults.typoExtract,
      typoScaleOnly: typeof raw.typoScaleOnly === "boolean" ? raw.typoScaleOnly : defaults.typoScaleOnly,
      typoShorthand: typeof raw.typoShorthand === "boolean" ? raw.typoShorthand : defaults.typoShorthand,
      typoNaming: raw.typoNaming === "value" ? "value" : "tshirt",
      collectionRoles: typeof raw.collectionRoles === "string" ? raw.collectionRoles.trim() : defaults.collectionRoles
    };
  }
  function normalizeI18n(raw) {
    const defaults = DJANGO_BOOTSTRAP_VALUES.i18n;
    if (!isRecord2(raw)) return __spreadValues({}, defaults);
    return {
      wrapTranslate: typeof raw.wrapTranslate === "boolean" ? raw.wrapTranslate : defaults.wrapTranslate,
      sourceLanguage: typeof raw.sourceLanguage === "string" && raw.sourceLanguage.trim() !== "" ? raw.sourceLanguage.trim() : defaults.sourceLanguage
    };
  }
  function normalizeDelivery2(raw) {
    if (!isRecord2(raw)) return __spreadValues({}, DEFAULT_DELIVERY);
    return {
      endpoint: typeof raw.endpoint === "string" ? raw.endpoint.trim() : DEFAULT_DELIVERY.endpoint,
      secret: typeof raw.secret === "string" ? raw.secret : DEFAULT_DELIVERY.secret,
      onExport: typeof raw.onExport === "boolean" ? raw.onExport : DEFAULT_DELIVERY.onExport
    };
  }
  function normalizeDocs(raw) {
    if (!isRecord2(raw)) return __spreadValues({}, DEFAULT_DOCS);
    return {
      componentDocs: typeof raw.componentDocs === "boolean" ? raw.componentDocs : DEFAULT_DOCS.componentDocs,
      componentPreviews: typeof raw.componentPreviews === "boolean" ? raw.componentPreviews : DEFAULT_DOCS.componentPreviews,
      previewBudgetMb: typeof raw.previewBudgetMb === "number" && Number.isFinite(raw.previewBudgetMb) ? Math.min(512, Math.max(1, Math.round(raw.previewBudgetMb))) : DEFAULT_DOCS.previewBudgetMb
    };
  }
  function normalizeLint(raw) {
    if (!isRecord2(raw)) return __spreadValues({}, DEFAULT_LINT);
    const depth = raw.maxNestingDepth;
    return {
      maxNestingDepth: typeof depth === "number" && Number.isFinite(depth) ? Math.min(32, Math.max(1, Math.round(depth))) : DEFAULT_LINT.maxNestingDepth
    };
  }
  function normalizeExportOptions(raw) {
    const candidate = isRecord2(raw) ? raw : {};
    return {
      target: isTargetId(candidate.target) ? candidate.target : DEFAULT_EXPORT_OPTIONS.target,
      scopeMode: isScopeMode(candidate.scopeMode) ? candidate.scopeMode : DEFAULT_EXPORT_OPTIONS.scopeMode,
      modules: normalizeModules(candidate.modules),
      targetOptions: normalizeTargetOptions(candidate.targetOptions),
      tokens: normalizeTokens(candidate.tokens),
      i18n: normalizeI18n(candidate.i18n),
      delivery: normalizeDelivery2(candidate.delivery),
      lint: normalizeLint(candidate.lint),
      docs: normalizeDocs(candidate.docs)
    };
  }
  function mergeExportOptions(stored, incoming) {
    const base = isRecord2(stored) ? stored : {};
    const patch = isRecord2(incoming) ? incoming : {};
    return normalizeExportOptions(__spreadValues(__spreadValues({}, base), patch));
  }
  var BUILT_IN_IDS = /* @__PURE__ */ new Set([...EXPORT_PRESETS.map((preset) => preset.id), "custom"]);
  function presetIdForLabel(label3) {
    return "user-" + label3.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function normalizePackageForming(raw) {
    if (!isRecord2(raw)) return clonePackage(DJANGO_BOOTSTRAP_VALUES);
    return {
      target: isTargetId(raw.target) ? raw.target : DJANGO_BOOTSTRAP_VALUES.target,
      modules: normalizeModules(raw.modules),
      targetOptions: normalizeTargetOptions(raw.targetOptions),
      tokens: normalizeTokens(raw.tokens),
      i18n: normalizeI18n(raw.i18n)
    };
  }
  function normalizeUserPresets(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const entry of raw) {
      if (!isRecord2(entry)) continue;
      const label3 = typeof entry.label === "string" ? entry.label.trim() : "";
      if (!label3) continue;
      const id = presetIdForLabel(label3);
      if (BUILT_IN_IDS.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label: label3, values: normalizePackageForming(entry.values) });
    }
    return out;
  }
  function upsertUserPreset(presets, label3, values) {
    const id = presetIdForLabel(label3);
    const filtered = presets.filter((p) => p.id !== id);
    return [...filtered, { id, label: label3, values: normalizePackageForming(values) }];
  }
  function resolveThemeAttribute(options) {
    if (options.tokens.themeAttribute) return options.tokens.themeAttribute;
    if (options.targetOptions.framework === "bootstrap") return "data-bs-theme";
    return "data-theme";
  }

  // src/tokens/index.ts
  function tokenEmitOptionsFrom(options, renames) {
    return {
      inlinePrimitives: options.tokens.inlinePrimitives,
      flattenAliases: options.tokens.flattenAliases,
      themeAttribute: resolveThemeAttribute(options),
      renames
    };
  }
  function emitTokenArtifacts(snapshot, options) {
    const source = variablesToW3CMultiMode(snapshot);
    const { ordered, defaultTheme } = orderedThemes(leaves(source));
    const cssTree = options.inlinePrimitives ? inlinePrimitivesTree(source, options.flattenAliases) : source;
    return {
      css: toTokensCss(cssTree, ordered, defaultTheme, options.themeAttribute, options.renames),
      json: toTokensJson(source, options.renames),
      themes: ordered,
      defaultTheme,
      source,
      emitted: cssTree
    };
  }

  // src/targets/django/bootstrap/map.ts
  var DEFAULT_BOOTSTRAP_MAP = [
    { bsVar: "--bs-primary", rgb: true, candidates: ["color-primary", "colors-primary", "brand-primary", "color-brand-primary", "primary", "color-accent", "accent"] },
    { bsVar: "--bs-secondary", rgb: true, candidates: ["color-secondary", "colors-secondary", "brand-secondary", "secondary"] },
    { bsVar: "--bs-success", rgb: true, candidates: ["color-success", "colors-success", "success", "color-positive", "positive"] },
    { bsVar: "--bs-danger", rgb: true, candidates: ["color-danger", "colors-danger", "danger", "color-error", "error", "color-negative", "negative"] },
    { bsVar: "--bs-warning", rgb: true, candidates: ["color-warning", "colors-warning", "warning", "color-caution", "caution"] },
    { bsVar: "--bs-info", rgb: true, candidates: ["color-info", "colors-info", "info"] },
    { bsVar: "--bs-light", rgb: true, candidates: ["color-light", "colors-light"] },
    { bsVar: "--bs-dark", rgb: true, candidates: ["color-dark", "colors-dark"] },
    { bsVar: "--bs-body-bg", rgb: true, candidates: ["color-bg", "color-background", "background", "color-bg-body", "body-bg", "color-surface", "surface", "color-bg-primary"] },
    { bsVar: "--bs-body-color", rgb: true, candidates: ["color-text", "text-primary", "color-text-primary", "color-fg", "foreground", "body-color", "text-body", "color-body"] },
    { bsVar: "--bs-secondary-color", scssVar: "body-secondary-color", candidates: ["color-text-secondary", "text-secondary", "color-fg-secondary", "color-muted", "text-muted"] },
    { bsVar: "--bs-border-color", candidates: ["color-border", "border-color", "border", "color-stroke", "stroke", "color-divider", "divider"] },
    { bsVar: "--bs-link-color", candidates: ["color-link", "link-color", "link", "color-text-link"] },
    { bsVar: "--bs-link-hover-color", candidates: ["color-link-hover", "link-hover-color", "link-hover"] },
    { bsVar: "--bs-body-font-family", scssVar: "font-family-base", candidates: ["font-family-base", "font-family-body", "typography-font-family-base", "typography-font-family-body", "font-body", "font-family"] },
    { bsVar: "--bs-body-font-size", scssVar: "font-size-base", candidates: ["font-size-base", "font-size-body", "typography-font-size-base", "typography-font-size-body", "text-size-base"] },
    { bsVar: "--bs-border-radius", candidates: ["radius-md", "radius-base", "radius-default", "radius", "border-radius", "corner-radius-md", "corner-radius"] },
    { bsVar: "--bs-border-radius-sm", candidates: ["radius-sm", "radius-small", "corner-radius-sm", "border-radius-sm"] },
    { bsVar: "--bs-border-radius-lg", candidates: ["radius-lg", "radius-large", "corner-radius-lg", "border-radius-lg"] },
    { bsVar: "--bs-border-radius-xl", candidates: ["radius-xl", "corner-radius-xl", "border-radius-xl"] }
  ];
  function cssColorToRgbTriplet(value) {
    const hex = value.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return `${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}`;
    }
    const rgb = value.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (rgb) return `${rgb[1]}, ${rgb[2]}, ${rgb[3]}`;
    return void 0;
  }
  function defaultScssVar(bsVar) {
    return bsVar.replace(/^--bs-/, "");
  }
  function matchBootstrapMap(flatLeaves) {
    var _a;
    const bySlug = /* @__PURE__ */ new Map();
    for (const leaf of flatLeaves) {
      const slug2 = varName(leaf.path);
      if (!bySlug.has(slug2)) bySlug.set(slug2, leaf);
    }
    const matched = /* @__PURE__ */ new Map();
    for (const entry of DEFAULT_BOOTSTRAP_MAP) {
      for (const candidate of entry.candidates) {
        const leaf = bySlug.get(candidate);
        if (!leaf) continue;
        matched.set(entry.bsVar, {
          bsVar: entry.bsVar,
          scssVar: (_a = entry.scssVar) != null ? _a : defaultScssVar(entry.bsVar),
          rgb: entry.rgb === true,
          leaf
        });
        break;
      }
    }
    for (const leaf of flatLeaves) {
      const slug2 = varName(leaf.path);
      if (!slug2.startsWith("bs-")) continue;
      const bsVar = `--${slug2}`;
      matched.set(bsVar, {
        bsVar,
        scssVar: defaultScssVar(bsVar),
        rgb: leaf.token.$type === "color",
        leaf
      });
    }
    const matchedList = [...matched.values()];
    const unmatched = DEFAULT_BOOTSTRAP_MAP.filter((entry) => !matched.has(entry.bsVar)).map((entry) => entry.bsVar);
    return { matched: matchedList, unmatched };
  }
  function themeBlockDeclarations(matched, theme) {
    const lines = [];
    for (const match of matched) {
      const value = cssValue(valueForTheme(match.leaf.token, theme), match.leaf.path);
      lines.push(`  ${match.bsVar}: ${value};`);
      if (match.rgb) {
        const triplet = typeof value === "string" ? cssColorToRgbTriplet(value) : void 0;
        if (triplet) lines.push(`  ${match.bsVar}-rgb: ${triplet};`);
      }
    }
    return lines;
  }
  function emitBootstrapArtifacts(source, themes, options) {
    const flat = leaves(inlinePrimitivesTree(source, true));
    const { matched, unmatched } = matchBootstrapMap(flat);
    const attr = options.themeAttribute || "data-bs-theme";
    const blocks = themes.ordered.map((theme) => {
      const selector = theme === themes.defaultTheme ? `:root,
[${attr}="${themeSlug(theme)}"]` : `[${attr}="${themeSlug(theme)}"]`;
      return `${selector} {
${themeBlockDeclarations(matched, theme).join("\n")}
}`;
    });
    const css = matched.length === 0 ? "" : `/* Bootstrap variable overrides generated from design tokens \u2014 link AFTER bootstrap.css.
   Mapping: bootstrap.map.json (edit + \`altery-dj tokens\` to rebuild without Figma). */
` + blocks.join("\n\n") + "\n";
    const mapJson = JSON.stringify(
      {
        $comment: "Bootstrap variable \u2192 design-token mapping (paths are dotted keys into tokens.json). Edit and run `altery-dj tokens` to rebuild bootstrap-tokens.css / _tokens.scss without a Figma re-export.",
        map: Object.fromEntries(matched.map((match) => [match.bsVar, match.leaf.path.join(".")])),
        unmatched
      },
      null,
      2
    ) + "\n";
    const scssLines = matched.map((match) => {
      const value = cssValue(valueForTheme(match.leaf.token, themes.defaultTheme), match.leaf.path);
      return `$${match.scssVar}: ${value};`;
    });
    const scss = matched.length === 0 ? "" : `// Design-token overrides for Bootstrap's _variables.scss \u2014 @import BEFORE bootstrap.
// Values are the "${themes.defaultTheme}" theme; runtime theming uses bootstrap-tokens.css.
` + scssLines.join("\n") + "\n";
    return { css, mapJson, scss, matched, unmatched };
  }

  // src/targets/django/generate/plan.ts
  function variantProps(spec) {
    const declared = spec.props.filter((prop) => prop.type === "VARIANT");
    if (spec.states && spec.states.length > 0) {
      return [...declared, { name: "State", type: "VARIANT", options: spec.states }];
    }
    return declared;
  }
  function variantMatrix(props) {
    var _a;
    let rows = [{}];
    for (const prop of props) {
      const options = (_a = prop.options) != null ? _a : [];
      const next = [];
      for (const row of rows) {
        for (const option of options) next.push(__spreadProps(__spreadValues({}, row), { [prop.name]: option }));
      }
      rows = next;
    }
    return rows;
  }
  function variantName(values) {
    return Object.entries(values).map(([prop, value]) => `${prop}=${value}`).join(", ");
  }
  function componentProperties(spec) {
    var _a, _b, _c;
    const props = [];
    for (const prop of spec.props) {
      if (prop.type === "VARIANT") {
        const options = (_a = prop.options) != null ? _a : [];
        props.push({ name: prop.name, type: "VARIANT", defaultValue: (_b = options[0]) != null ? _b : "", variantOptions: options });
      } else {
        props.push({ name: prop.name, type: "BOOLEAN", defaultValue: (_c = prop.boolDefault) != null ? _c : false, variantOptions: null });
      }
    }
    if (spec.states && spec.states.length > 0) {
      props.push({ name: "State", type: "VARIANT", defaultValue: spec.states[0], variantOptions: spec.states });
    }
    return props;
  }
  function planComponent(spec) {
    var _a;
    const vProps = variantProps(spec);
    const isSet = vProps.length > 0;
    const matrix = isSet ? variantMatrix(vProps) : [{}];
    const variants = matrix.map((values) => ({
      name: isSet ? variantName(values) : spec.name,
      values
    }));
    return {
      name: spec.name,
      isSet,
      variants,
      parts: (_a = spec.parts) != null ? _a : [],
      componentDef: { setName: spec.name, properties: componentProperties(spec) }
    };
  }
  function planKit(specs) {
    return specs.map(planComponent);
  }

  // src/targets/django/generate/build.ts
  function bootstrapVarForVariantValue(value) {
    const slug2 = value.trim().toLowerCase();
    const bsVar = `--bs-${slug2}`;
    return DEFAULT_BOOTSTRAP_MAP.some((entry) => entry.bsVar === bsVar) ? bsVar : null;
  }
  function variantFillTokenPath(variantValue, availablePaths) {
    const bsVar = bootstrapVarForVariantValue(variantValue);
    if (!bsVar) return null;
    const entry = DEFAULT_BOOTSTRAP_MAP.find((candidate) => candidate.bsVar === bsVar);
    if (!entry) return null;
    const bySlug = /* @__PURE__ */ new Map();
    for (const path of availablePaths) {
      const slug2 = varName(path.split("."));
      if (!bySlug.has(slug2)) bySlug.set(slug2, path);
    }
    for (const candidate of entry.candidates) {
      const path = bySlug.get(candidate);
      if (path) return path;
    }
    return null;
  }
  function buildReport(plans, boundVariants, slots = 0) {
    const variants = plans.reduce((sum, plan) => sum + plan.variants.length, 0);
    return {
      components: plans.length,
      variants,
      bound: boundVariants,
      unbound: variants - boundVariants,
      slots
    };
  }

  // src/targets/django/generate/metrics.ts
  function hexToRgb(hex) {
    const h = hex.replace("#", "").trim();
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const n = parseInt(full, 16);
    return { r: (n >> 16 & 255) / 255, g: (n >> 8 & 255) / 255, b: (n & 255) / 255 };
  }
  function mix(a, b, t) {
    const k = Math.max(0, Math.min(1, t));
    return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
  }
  var WHITE = { r: 1, g: 1, b: 1 };
  var BLACK = { r: 0, g: 0, b: 0 };
  function tint(color, weight) {
    return mix(color, WHITE, weight);
  }
  function shade(color, weight) {
    return mix(color, BLACK, weight);
  }
  var ROLE_HEX = {
    primary: "#0d6efd",
    secondary: "#6c757d",
    success: "#198754",
    danger: "#dc3545",
    warning: "#ffc107",
    info: "#0dcaf0",
    light: "#f8f9fa",
    dark: "#212529",
    link: "#0d6efd"
  };
  var ROLES = ["Primary", "Secondary", "Success", "Danger", "Warning", "Info", "Light", "Dark"];
  var DARK_TEXT_ROLES = /* @__PURE__ */ new Set(["warning", "info", "light"]);
  function roleColor(role) {
    var _a;
    return hexToRgb((_a = ROLE_HEX[role.trim().toLowerCase()]) != null ? _a : ROLE_HEX.primary);
  }
  function roleTextColor(role) {
    return DARK_TEXT_ROLES.has(role.trim().toLowerCase()) ? hexToRgb("#000000") : WHITE;
  }
  function alertColors(role) {
    const base = roleColor(role);
    return { bg: tint(base, 0.8), border: tint(base, 0.7), text: shade(base, 0.4) };
  }
  var COLOR = {
    bodyText: hexToRgb("#212529"),
    // --bs-body-color
    secondaryText: hexToRgb("#6c757d"),
    // --bs-secondary-color
    border: hexToRgb("#dee2e6"),
    // --bs-border-color
    inputBorder: hexToRgb("#ced4da"),
    surface: hexToRgb("#ffffff"),
    // --bs-body-bg
    subtleBg: hexToRgb("#f8f9fa"),
    // --bs-tertiary-bg / table-striped
    headerBg: hexToRgb("#f8f8f9"),
    // card-header ≈ body over rgba(0,0,0,.03)
    trackBg: hexToRgb("#e9ecef"),
    // progress / range track
    placeholder: hexToRgb("#e9ecef"),
    focusRing: hexToRgb("#0d6efd")
  };
  var RADIUS = { sm: 4, base: 6, lg: 8, pill: 999 };
  var FONT = { sm: 14, base: 16, lg: 20, small: 14, label: 16, heading: 20 };
  var CONTROL_HEIGHT = { sm: 31, md: 38, base: 38, lg: 48 };
  var CONTROL_PAD = {
    sm: [4, 8],
    md: [6, 12],
    base: [6, 12],
    lg: [8, 16]
  };
  var SPACE = {
    card: { radius: RADIUS.base, bodyPad: 16, headerPadV: 8, headerPadH: 16 },
    // $card-*-padding
    alert: { padV: 16, padH: 16, radius: RADIUS.base },
    // $alert-padding-y/x 1rem
    badge: { padV: 3, padH: 6, radius: RADIUS.base, font: 12 },
    // .badge .375em .65em @ .75em
    listGroupItem: { padV: 8, padH: 16 },
    // $list-group-item-padding
    accordion: { btnPadV: 16, btnPadH: 20, bodyPadV: 16, bodyPadH: 20 },
    // $accordion-*-padding
    navbar: { padV: 8, padH: 16 },
    // $navbar-padding
    navLink: { padV: 8, padH: 16 },
    // $nav-link-padding
    pageLink: { padV: 6, padH: 12 },
    // $pagination-padding
    dropdown: { minWidth: 160, padV: 8, itemPadV: 4, itemPadH: 16, radius: RADIUS.base },
    // $dropdown-*
    toast: { width: 350, headerPadV: 8, headerPadH: 12, bodyPad: 12, radius: RADIUS.base },
    breadcrumb: { gap: 8 },
    // $breadcrumb-item-padding + divider
    tableCell: { padV: 8, padH: 8 },
    // $table-cell-padding .5rem
    offcanvas: { width: 400, height: 400, pad: 16 },
    // $offcanvas-horizontal-width 400px
    modal: { width: 500, pad: 16, radius: RADIUS.lg },
    // $modal-md 500, content radius .5rem
    progress: { height: 16, radius: RADIUS.base },
    // $progress-height 1rem
    spinner: { size: 32, smSize: 16, border: 3 },
    // 2rem, .25em border
    formCheck: { size: 16, gap: 8, switchWidth: 32 },
    // 1em check, switch 2em wide
    range: { trackH: 8, thumb: 16 },
    // $form-range
    inputGroup: { addonPadV: 6, addonPadH: 12 }
  };

  // src/targets/django/bootstrap/components.ts
  var VARIANT_PROP_NAMES = ["variant", "style", "type", "color", "kind"];
  var SIZE_PROP_NAMES = ["size"];
  var BOOTSTRAP_COMPONENT_NAMES = [
    "button",
    "btn",
    "badge",
    "card",
    "alert",
    // wave 2:
    "buttongroup",
    "button-group",
    "closebutton",
    "close-button",
    "spinner",
    "placeholder",
    "toast",
    "navbar",
    "breadcrumb",
    "nav",
    "tabs",
    "pills",
    "listgroup",
    "list-group",
    "pagination",
    "progress",
    "dropdown",
    "accordion",
    // wave 3 — forms:
    "input",
    "textfield",
    "text-field",
    "textarea",
    "select",
    "checkbox",
    "radio",
    "switch",
    "range",
    "inputgroup",
    "input-group",
    // patterns a real library names differently but Bootstrap builds from existing primitives:
    // a segmented control is a `.btn-group` of `.btn-check`s, an upload is a `type="file"` control.
    "segmented",
    "segmentedcontrol",
    "segmented-control",
    "upload",
    "fileupload",
    "file-upload",
    "fileinput",
    "file-input",
    // wave 3 — offcanvas panel (the overlay trigger is wired in interactions.ts):
    "offcanvas",
    // wave 3c — collapse family:
    "collapse",
    // wave 3f — tabs widget + carousel:
    "carousel",
    // phase 11 — content elements (generation-driven; exported as native table/figure markup):
    "table",
    "figure",
    // phase 11 wider — floating-label form wrapper:
    "floatinglabels",
    "floating-labels",
    "floatinglabel",
    "floating-label",
    "form-floating",
    // phase 12 — item sub-components (masters compose from instances of these):
    "accordionitem",
    "accordion-item",
    "listgroupitem",
    "list-group-item",
    "navlink",
    "nav-link",
    "pageitem",
    "page-item",
    "dropdownitem",
    "dropdown-item",
    "tablerow",
    "table-row",
    "breadcrumbitem",
    "breadcrumb-item",
    "tabpane",
    "tab-pane",
    "carouselslide",
    "carousel-slide"
  ];
  function findProp(component, names) {
    return component.properties.find(
      (prop) => prop.type === "VARIANT" && names.includes(prop.name.trim().toLowerCase())
    );
  }
  function variantClassExpr(prefix, component, names, toVar) {
    const prop = findProp(component, names);
    if (!prop) return null;
    const fallback = String(prop.defaultValue).toLowerCase();
    return `${prefix}-{{ ${toVar(prop.name)}|default:'${fallback}'|lower }}`;
  }
  function normalizedName(componentName) {
    var _a;
    const last = (_a = componentName.split("/").pop()) != null ? _a : componentName;
    return last.trim().toLowerCase();
  }
  function matchBootstrapComponent(componentName, component, toVar) {
    const name = normalizedName(componentName);
    if (name === "button" || name === "btn") {
      const classes = ["btn"];
      const variant2 = variantClassExpr("btn", component, VARIANT_PROP_NAMES, toVar);
      if (variant2) classes.push(variant2);
      const size = variantClassExpr("btn", component, SIZE_PROP_NAMES, toVar);
      if (size) classes.push(size);
      return { kind: "button", tag: "button", attributes: ' type="button"', classes };
    }
    if (name === "badge") {
      const classes = ["badge"];
      const variant2 = variantClassExpr("text-bg", component, VARIANT_PROP_NAMES, toVar);
      if (variant2) classes.push(variant2);
      return { kind: "badge", tag: "span", attributes: "", classes };
    }
    if (name === "card") {
      return {
        kind: "card",
        tag: "div",
        attributes: "",
        classes: ["card"],
        parts: {
          header: { classes: ["card-header"] },
          body: { classes: ["card-body"] },
          footer: { classes: ["card-footer"] },
          image: { classes: ["card-img-top"] }
        }
      };
    }
    if (name === "alert") {
      const classes = ["alert"];
      const variant2 = variantClassExpr("alert", component, VARIANT_PROP_NAMES, toVar);
      if (variant2) classes.push(variant2);
      const dismissible = component.properties.some(
        (prop) => prop.type === "BOOLEAN" && prop.name.trim().toLowerCase() === "dismissible"
      );
      if (dismissible) {
        classes.push("alert-dismissible");
        return {
          kind: "alert",
          tag: "div",
          attributes: ' role="alert"',
          classes,
          appendHtml: '<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>'
        };
      }
      return { kind: "alert", tag: "div", attributes: ' role="alert"', classes };
    }
    if (name === "buttongroup" || name === "button-group" || name === "segmented" || name === "segmentedcontrol" || name === "segmented-control") {
      const classes = ["btn-group"];
      const size = variantClassExpr("btn-group", component, SIZE_PROP_NAMES, toVar);
      if (size) classes.push(size);
      return { kind: "button-group", tag: "div", attributes: ' role="group"', classes };
    }
    if (name === "closebutton" || name === "close-button") {
      return { kind: "close-button", tag: "button", attributes: ' type="button" aria-label="Close"', classes: ["btn-close"] };
    }
    if (name === "spinner") {
      const typeProp = component.properties.find(
        (prop) => prop.type === "VARIANT" && prop.name.trim().toLowerCase() === "type"
      );
      const spinner2 = typeProp ? `spinner-{{ ${toVar(typeProp.name)}|default:'${String(typeProp.defaultValue).toLowerCase()}'|lower }}` : "spinner-border";
      const classes = [spinner2];
      const variant2 = variantClassExpr("text", component, ["variant", "color", "kind"], toVar);
      if (variant2) classes.push(variant2);
      return { kind: "spinner", tag: "div", attributes: ' role="status"', classes };
    }
    if (name === "placeholder") {
      return { kind: "placeholder", tag: "span", attributes: "", classes: ["placeholder"] };
    }
    if (name === "toast") {
      return {
        kind: "toast",
        tag: "div",
        attributes: ' role="alert" aria-live="assertive" aria-atomic="true"',
        classes: ["toast"],
        parts: {
          header: { classes: ["toast-header"] },
          body: { classes: ["toast-body"] }
        }
      };
    }
    if (name === "navbar") {
      const classes = ["navbar"];
      const expand = variantClassExpr("navbar-expand", component, ["expand"], toVar);
      classes.push(expand != null ? expand : "navbar-expand-lg");
      return {
        kind: "navbar",
        tag: "nav",
        attributes: "",
        classes,
        // Responsive toggle: the Toggler shows/hides the Nav below the expand breakpoint. The
        // collapse class lands on the Nav list (functionally toggles; our CSS keeps the look).
        collapse: { toggle: "toggler", target: "nav", targetClass: "collapse navbar-collapse" },
        parts: {
          brand: { classes: ["navbar-brand"] },
          toggler: { tag: "button", classes: ["navbar-toggler"], attributes: ' type="button"' },
          nav: { tag: "ul", classes: ["navbar-nav"] },
          item: { tag: "li", classes: ["nav-item"] }
        }
      };
    }
    if (name === "breadcrumb") {
      return {
        kind: "breadcrumb",
        tag: "ol",
        attributes: "",
        classes: ["breadcrumb"],
        parts: { item: { tag: "li", classes: ["breadcrumb-item"] } }
      };
    }
    if (name === "nav" || name === "pills") {
      const classes = ["nav"];
      const variant2 = variantClassExpr("nav", component, VARIANT_PROP_NAMES, toVar);
      classes.push(variant2 != null ? variant2 : name === "nav" ? "nav-tabs" : "nav-pills");
      return {
        kind: "nav",
        tag: "ul",
        attributes: "",
        classes,
        parts: { item: { tag: "li", classes: ["nav-item"] } }
      };
    }
    if (name === "tabs") {
      return {
        kind: "tabs",
        tag: "div",
        attributes: "",
        classes: [],
        tabs: { toggle: "tab", pane: "pane" },
        // phase 12: when composed of NavLink + TabPane INSTANCES, pair them by order and mint a
        // shared pane_id per pair (the inline `tabs` path above still handles non-instance tabs).
        tabItems: { toggle: "navlink", pane: "tab-pane" },
        parts: {
          nav: { tag: "nav", classes: ["nav", "nav-tabs"], attributes: ' role="tablist"' },
          tab: { tag: "button", classes: ["nav-link"], attributes: ' type="button" role="tab"' },
          content: { classes: ["tab-content"] },
          pane: { classes: ["tab-pane"], attributes: ' role="tabpanel"' }
        }
      };
    }
    if (name === "carousel") {
      return {
        kind: "carousel",
        tag: "div",
        attributes: ' data-bs-ride="carousel"',
        classes: ["carousel", "slide"],
        carousel: { slide: "slide", prev: "prev", next: "next" },
        parts: {
          inner: { classes: ["carousel-inner"] },
          slide: { classes: ["carousel-item"] },
          caption: { classes: ["carousel-caption"] },
          prev: { tag: "button", classes: ["carousel-control-prev"], attributes: ' type="button" data-bs-slide="prev"' },
          next: { tag: "button", classes: ["carousel-control-next"], attributes: ' type="button" data-bs-slide="next"' }
        }
      };
    }
    if (name === "listgroup" || name === "list-group") {
      return {
        kind: "list-group",
        tag: "ul",
        attributes: "",
        classes: ["list-group"],
        parts: { item: { tag: "li", classes: ["list-group-item"] } }
      };
    }
    if (name === "pagination") {
      const classes = ["pagination"];
      const size = variantClassExpr("pagination", component, SIZE_PROP_NAMES, toVar);
      if (size) classes.push(size);
      return {
        kind: "pagination",
        tag: "ul",
        attributes: "",
        classes,
        parts: { item: { tag: "li", classes: ["page-item"] } }
      };
    }
    if (name === "progress") {
      return {
        kind: "progress",
        tag: "div",
        attributes: "",
        classes: ["progress"],
        parts: { bar: { classes: ["progress-bar"], attributes: ' role="progressbar"' } }
      };
    }
    if (name === "dropdown") {
      return {
        kind: "dropdown",
        tag: "div",
        attributes: "",
        classes: ["dropdown"],
        parts: {
          // Bootstrap's data API drives the open/close — no generated JS, same as modals.
          toggle: {
            tag: "button",
            classes: ["dropdown-toggle"],
            attributes: ' type="button" data-bs-toggle="dropdown" aria-expanded="false"'
          },
          menu: { tag: "ul", classes: ["dropdown-menu"] },
          item: { tag: "li", classes: ["dropdown-item"] }
        }
      };
    }
    if (name === "accordion") {
      return {
        kind: "accordion",
        tag: "div",
        attributes: "",
        classes: ["accordion"],
        // Per-item collapse wiring: each Item's Header toggles its own Body (unique id per item).
        collapse: { toggle: "header", target: "body", targetClass: "accordion-collapse collapse", scope: "item" },
        // phase 12: when composed of AccordionItem INSTANCES, the parent mints a unique collapse_id
        // per item + a shared accordion_id (data-bs-parent) and passes them as include params.
        itemInstanceIdParams: { childKind: "accordion-item", idParam: "collapse_id", parentParam: "accordion_id" },
        parts: {
          item: { classes: ["accordion-item"] },
          header: { classes: ["accordion-header"] },
          body: { classes: ["accordion-body"] }
        }
      };
    }
    if (name === "collapse") {
      return {
        kind: "collapse",
        tag: "div",
        attributes: "",
        classes: [],
        collapse: { toggle: "toggle", target: "content", targetClass: "collapse" },
        parts: {
          toggle: { tag: "button", classes: [], attributes: ' type="button"' },
          content: { classes: [] }
        }
      };
    }
    if (name === "input" || name === "textfield" || name === "text-field" || name === "textarea" || name === "select" || name === "upload" || name === "fileupload" || name === "file-upload" || name === "fileinput" || name === "file-input") {
      const isTextarea = name === "textarea";
      const isSelect = name === "select";
      const isFile = name === "upload" || name === "fileupload" || name === "file-upload" || name === "fileinput" || name === "file-input";
      const controlClass = isSelect ? "form-select" : "form-control";
      const sizeCls = variantClassExpr(controlClass, component, SIZE_PROP_NAMES, toVar);
      const stateCls = variantClassExpr("is", component, ["state", "validity"], toVar);
      const fieldClasses = [controlClass, ...sizeCls ? [sizeCls] : [], ...stateCls ? [stateCls] : []];
      return {
        kind: "form-field",
        tag: "div",
        attributes: "",
        classes: [],
        parts: {
          label: { tag: "label", classes: ["form-label"] },
          field: isTextarea ? { tag: "textarea", classes: fieldClasses } : isSelect ? { tag: "select", classes: fieldClasses } : { tag: "input", classes: fieldClasses, attributes: isFile ? ' type="file"' : void 0, void: true },
          help: { classes: ["form-text"] }
        }
      };
    }
    if (name === "floatinglabels" || name === "floating-labels" || name === "floatinglabel" || name === "floating-label" || name === "form-floating") {
      return {
        kind: "floating-label",
        tag: "div",
        attributes: "",
        classes: ["form-floating"],
        parts: {
          field: { tag: "input", classes: ["form-control"], void: true },
          label: { tag: "label", classes: [] }
        }
      };
    }
    if (name === "checkbox" || name === "radio" || name === "switch") {
      const inputType = name === "radio" ? "radio" : "checkbox";
      const rootClasses = name === "switch" ? ["form-check", "form-switch"] : ["form-check"];
      return {
        kind: "form-check",
        tag: "div",
        attributes: "",
        classes: rootClasses,
        parts: {
          field: { tag: "input", classes: ["form-check-input"], attributes: ` type="${inputType}"`, void: true },
          label: { tag: "label", classes: ["form-check-label"] }
        }
      };
    }
    if (name === "range") {
      return { kind: "range", tag: "input", attributes: ' type="range"', classes: ["form-range"], void: true };
    }
    if (name === "offcanvas") {
      const classes = ["offcanvas"];
      const placement = variantClassExpr("offcanvas", component, ["placement"], toVar);
      classes.push(placement != null ? placement : "offcanvas-start");
      return {
        kind: "offcanvas",
        tag: "div",
        attributes: ' tabindex="-1"',
        classes,
        parts: {
          header: { classes: ["offcanvas-header"] },
          body: { classes: ["offcanvas-body"] },
          title: { tag: "h5", classes: ["offcanvas-title"] }
        }
      };
    }
    if (name === "table") {
      return {
        kind: "table",
        tag: "table",
        attributes: "",
        classes: ["table"],
        parts: {
          head: { tag: "thead", classes: [] },
          body: { tag: "tbody", classes: [] },
          row: { tag: "tr", classes: [] },
          th: { tag: "th", classes: [], attributes: ' scope="col"' },
          td: { tag: "td", classes: [] },
          caption: { tag: "caption", classes: [] }
        }
      };
    }
    if (name === "figure") {
      return {
        kind: "figure",
        tag: "figure",
        attributes: "",
        classes: ["figure"],
        parts: {
          image: { tag: "img", classes: ["figure-img", "img-fluid", "rounded"], void: true },
          caption: { tag: "figcaption", classes: ["figure-caption"] }
        }
      };
    }
    if (name === "inputgroup" || name === "input-group") {
      const classes = ["input-group"];
      const size = variantClassExpr("input-group", component, SIZE_PROP_NAMES, toVar);
      if (size) classes.push(size);
      return {
        kind: "input-group",
        tag: "div",
        attributes: "",
        classes,
        parts: {
          text: { tag: "span", classes: ["input-group-text"] },
          field: { tag: "input", classes: ["form-control"], void: true }
        }
      };
    }
    if (name === "accordionitem" || name === "accordion-item") {
      return {
        kind: "accordion-item",
        tag: "div",
        attributes: "",
        classes: ["accordion-item"],
        // collapse id is an {% include with %} PARAM (not a baked node id), so N reused item partials
        // each get a unique id + a shared data-bs-parent from the parent Accordion.
        collapse: {
          toggle: "button",
          target: "collapse",
          targetClass: "accordion-collapse collapse",
          idParam: "collapse_id",
          parentParam: "accordion_id",
          toggleCollapsedClass: "collapsed"
        },
        parts: {
          header: { tag: "h2", classes: ["accordion-header"] },
          button: { tag: "button", classes: ["accordion-button"], attributes: ' type="button"' },
          collapse: { classes: [] },
          // `.accordion-collapse collapse` arrive via targetClass wiring
          body: { classes: ["accordion-body"] }
        }
      };
    }
    if (name === "listgroupitem" || name === "list-group-item") {
      const classes = ["list-group-item"];
      const color = variantClassExpr("list-group-item", component, ["color", "variant", "contextual"], toVar);
      if (color) classes.push(color);
      const action = variantClassExpr("list-group-item", component, ["itemtype", "action"], toVar);
      if (action) classes.push(action);
      const stateProp = component.properties.find((p) => p.type === "VARIANT" && p.name.trim().toLowerCase() === "state");
      if (stateProp) classes.push(`{{ ${toVar(stateProp.name)}|default:'${String(stateProp.defaultValue).toLowerCase()}'|lower }}`);
      return { kind: "list-group-item", tag: "li", attributes: "", classes };
    }
    if (name === "navlink" || name === "nav-link") {
      const stateProp = component.properties.find(
        (p) => p.type === "VARIANT" && ["state", "variant"].includes(p.name.trim().toLowerCase())
      );
      const st = `${stateProp ? toVar(stateProp.name) : "state"}|default:'${stateProp ? String(stateProp.defaultValue) : "Default"}'`;
      const stateClass = `{% if ${st} == 'Active' %}active{% elif ${st} == 'Disabled' %}disabled{% endif %}`;
      const linkAttrs = `{% if tab_id %} id="{{ tab_id }}-tab" data-bs-toggle="tab" data-bs-target="#{{ tab_id }}" role="tab" aria-controls="{{ tab_id }}" aria-selected="{% if ${st} == 'Active' %}true{% else %}false{% endif %}"{% else %} href="{{ href|default:'#' }}"{% if ${st} == 'Active' %} aria-current="page"{% endif %}{% endif %}{% if ${st} == 'Disabled' %} aria-disabled="true" tabindex="-1"{% endif %}`;
      return {
        kind: "navlink",
        tag: "li",
        attributes: `{% if tab_id %} role="presentation"{% endif %}`,
        classes: ["nav-item"],
        parts: { link: { tag: "a", classes: ["nav-link", stateClass], attributes: linkAttrs } }
      };
    }
    if (name === "pageitem" || name === "page-item") {
      const classes = ["page-item"];
      const state = findProp(component, ["state", ...VARIANT_PROP_NAMES]);
      if (state) classes.push(`{{ ${toVar(state.name)}|default:'${String(state.defaultValue).toLowerCase()}'|lower }}`);
      return {
        kind: "page-item",
        tag: "li",
        attributes: "",
        classes,
        parts: { link: { tag: "a", classes: ["page-link"], attributes: ' href="#"' } }
      };
    }
    if (name === "dropdownitem" || name === "dropdown-item") {
      const variantProp = findProp(component, VARIANT_PROP_NAMES);
      const stateExpr = variantProp ? `{{ ${toVar(variantProp.name)}|default:'${String(variantProp.defaultValue).toLowerCase()}'|lower }}` : null;
      return {
        kind: "dropdown-item",
        tag: "li",
        attributes: "",
        classes: [],
        parts: {
          link: { tag: "a", classes: ["dropdown-item", ...stateExpr ? [stateExpr] : []], attributes: ' href="#"' },
          header: { tag: "h6", classes: ["dropdown-header"] },
          divider: { tag: "hr", classes: ["dropdown-divider"], void: true }
        }
      };
    }
    if (name === "tablerow" || name === "table-row") {
      const classes = [];
      const contextual = variantClassExpr("table", component, ["state", "color"], toVar);
      if (contextual) classes.push(contextual);
      return {
        kind: "table-row",
        tag: "tr",
        attributes: "",
        classes,
        parts: { th: { tag: "th", classes: [], attributes: ' scope="col"' }, td: { tag: "td", classes: [] } }
      };
    }
    if (name === "breadcrumbitem" || name === "breadcrumb-item") {
      const stateProp = component.properties.find(
        (p) => p.type === "VARIANT" && ["state", "variant", "type"].includes(p.name.trim().toLowerCase())
      );
      const classes = ["breadcrumb-item"];
      let attributes = "";
      if (stateProp) {
        const s = toVar(stateProp.name);
        classes.push(`{% if ${s}|lower == 'active' %}active{% endif %}`);
        attributes = `{% if ${s}|lower == 'active' %} aria-current="page"{% endif %}`;
      }
      return { kind: "breadcrumb-item", tag: "li", attributes, classes };
    }
    if (name === "tabpane" || name === "tab-pane") {
      const showActive = `{% if state|default:'inactive'|lower == 'active' %}show active{% endif %}`;
      return {
        kind: "tab-pane",
        tag: "div",
        attributes: ' role="tabpanel" id="{{ pane_id }}"',
        classes: ["tab-pane", "fade", showActive]
      };
    }
    if (name === "carouselslide" || name === "carousel-slide") {
      const classes = ["carousel-item"];
      const stateProp = findProp(component, ["state"]);
      if (stateProp) {
        classes.push(`{% if ${toVar(stateProp.name)}|default:'${String(stateProp.defaultValue).toLowerCase()}'|lower == 'active' %}active{% endif %}`);
      }
      return {
        kind: "carousel-slide",
        tag: "div",
        attributes: "",
        classes,
        parts: { image: { tag: "img", classes: ["d-block", "w-100"], void: true }, caption: { classes: ["carousel-caption"] } }
      };
    }
    return null;
  }
  function partKeyForName(nodeName) {
    return normalizedName(nodeName).replace(/[^a-z0-9]+/g, "-");
  }
  function partForName(parts, nodeName) {
    var _a;
    if (!parts) return null;
    return (_a = parts[partKeyForName(nodeName)]) != null ? _a : null;
  }
  function isBootstrapComponentName(componentName) {
    return BOOTSTRAP_COMPONENT_NAMES.includes(normalizedName(componentName));
  }
  function wantsVariantProp(componentName) {
    const name = normalizedName(componentName);
    return name === "button" || name === "btn" || name === "badge" || name === "alert";
  }
  function injectTriggerAttributes(html, attributesByClass) {
    let out = html;
    for (const [className, attributes] of attributesByClass) {
      const pattern = new RegExp(`(<[a-zA-Z0-9-]+\\s[^>]*class="[^"]*\\b${className}\\b[^"]*")`);
      out = out.replace(pattern, `$1${attributes}`);
    }
    return out;
  }

  // src/targets/django/generate/blueprint.ts
  var solid = (color) => ({ kind: "solid", color });
  var token = (role) => ({ kind: "token", role, fallback: roleColor(role) });
  var NONE = { kind: "none" };
  var openSlot = (description, preferredKinds = []) => ({
    description,
    preferredKinds,
    allowPreferredOnly: false,
    stretchOnInsert: true,
    minChildren: 0,
    maxChildren: null
  });
  function inst(of, values, opts = {}) {
    return __spreadValues({ type: "instance", of, values }, opts);
  }
  function txt(name, text2, opts = {}) {
    var _a, _b;
    return {
      type: "text",
      name,
      text: text2,
      fontSize: (_a = opts.fontSize) != null ? _a : FONT.base,
      color: (_b = opts.color) != null ? _b : opts.muted ? solid(COLOR.secondaryText) : solid(COLOR.bodyText),
      bold: opts.bold,
      align: opts.align,
      grow: opts.grow,
      muted: opts.muted,
      x: opts.x,
      y: opts.y
    };
  }
  function frame(name, opts = {}) {
    var _a;
    return __spreadValues({ type: "frame", name, children: (_a = opts.children) != null ? _a : [] }, opts);
  }
  function labelText(spec, fallback) {
    var _a, _b, _c;
    return (_c = (_b = (_a = spec.parts) == null ? void 0 : _a.find((p) => p.text != null)) == null ? void 0 : _b.text) != null ? _c : fallback;
  }
  function sizeRadius(size) {
    return size === "sm" ? RADIUS.sm : size === "lg" ? RADIUS.lg : RADIUS.base;
  }
  function sizeFont(size) {
    return size === "sm" ? FONT.sm : size === "lg" ? FONT.lg : FONT.base;
  }
  function stateFill(role, state) {
    const base = roleColor(role);
    if (state === "hover") return solid(shade(base, 0.1));
    if (state === "active") return solid(shade(base, 0.2));
    return token(role);
  }
  var button = (spec, v) => {
    var _a, _b, _c, _d;
    const raw = (_a = v.Variant) != null ? _a : "Primary";
    const size = (_b = v.Size) != null ? _b : "md";
    const state = (_c = v.State) != null ? _c : "default";
    const [padV, padH] = (_d = CONTROL_PAD[size]) != null ? _d : CONTROL_PAD.md;
    const lower = raw.trim().toLowerCase();
    const isLink = lower === "link";
    const isOutline = lower.startsWith("outline");
    const role = isOutline ? raw.replace(/^outline-?/i, "") : raw;
    let fill = NONE;
    let stroke;
    let text2;
    if (isLink) {
      text2 = solid(roleColor("primary"));
    } else if (isOutline) {
      stroke = { color: roleColor(role), weight: 1 };
      if (state === "hover" || state === "active") {
        fill = stateFill(role, state);
        text2 = solid(roleTextColor(role));
      } else {
        text2 = solid(roleColor(role));
      }
    } else {
      fill = stateFill(role, state);
      text2 = solid(roleTextColor(role));
    }
    return frame("Button", {
      direction: "horizontal",
      padding: [padV, padH, padV, padH],
      gap: 6,
      primaryAlign: "center",
      counterAlign: "center",
      width: "hug",
      height: "hug",
      fill,
      stroke,
      radius: sizeRadius(size),
      opacity: state === "disabled" ? 0.65 : 1,
      children: [txt("Label", labelText(spec, "Button"), { fontSize: sizeFont(size), color: text2 })]
    });
  };
  var badge = (spec, v) => {
    var _a, _b;
    const role = (_a = v.Variant) != null ? _a : "Primary";
    const pill = ((_b = v.Shape) != null ? _b : "").trim().toLowerCase() === "pill";
    return frame("Badge", {
      direction: "horizontal",
      padding: [SPACE.badge.padV, SPACE.badge.padH, SPACE.badge.padV, SPACE.badge.padH],
      primaryAlign: "center",
      counterAlign: "center",
      width: "hug",
      height: "hug",
      fill: token(role),
      radius: pill ? RADIUS.pill : SPACE.badge.radius,
      children: [txt("Label", labelText(spec, "Badge"), { fontSize: SPACE.badge.font, bold: true, color: solid(roleTextColor(role)) })]
    });
  };
  var alert = (spec, v) => {
    var _a;
    const role = (_a = v.Variant) != null ? _a : "Primary";
    const c = alertColors(role);
    return frame("Alert", {
      direction: "horizontal",
      padding: [SPACE.alert.padV, SPACE.alert.padH, SPACE.alert.padV, SPACE.alert.padH],
      counterAlign: "center",
      width: 320,
      height: "hug",
      fill: solid(c.bg),
      stroke: { color: c.border, weight: 1 },
      radius: SPACE.alert.radius,
      children: [txt("Text", labelText(spec, "A short alert message."), { color: solid(c.text), grow: true })]
    });
  };
  var card = (spec) => {
    const has = (name) => {
      var _a;
      return (_a = spec.parts) == null ? void 0 : _a.some((p) => p.name.toLowerCase() === name);
    };
    const children = [];
    if (has("header")) {
      children.push(
        frame("Header", {
          direction: "horizontal",
          padding: [SPACE.card.headerPadV, SPACE.card.headerPadH, SPACE.card.headerPadV, SPACE.card.headerPadH],
          width: "fill",
          fill: solid(COLOR.headerBg),
          stroke: { color: COLOR.border, weight: 1, side: "bottom" },
          children: [txt("HeaderText", "Card header", { bold: true })]
        })
      );
    }
    children.push(
      frame("Body", {
        direction: "vertical",
        padding: SPACE.card.bodyPad,
        gap: 8,
        width: "fill",
        slot: openSlot("Card content \u2014 title, text, images, buttons"),
        children: [txt("Title", "Card title", { fontSize: FONT.heading, bold: true }), txt("Text", "Card body text goes here.", {})]
      })
    );
    if (has("footer")) {
      children.push(
        frame("Footer", {
          direction: "horizontal",
          padding: [SPACE.card.headerPadV, SPACE.card.headerPadH, SPACE.card.headerPadV, SPACE.card.headerPadH],
          width: "fill",
          fill: solid(COLOR.headerBg),
          stroke: { color: COLOR.border, weight: 1, side: "top" },
          children: [txt("FooterText", "Card footer", { muted: true, fontSize: FONT.sm })]
        })
      );
    }
    return frame("Card", {
      direction: "vertical",
      width: 320,
      height: "hug",
      fill: solid(COLOR.surface),
      stroke: { color: COLOR.border, weight: 1 },
      radius: SPACE.card.radius,
      clip: true,
      children
    });
  };
  var spinner = (_spec, v) => {
    var _a, _b;
    const role = (_a = v.Variant) != null ? _a : "Primary";
    const isGrow = ((_b = v.Type) != null ? _b : "border").toLowerCase() === "grow";
    const size = SPACE.spinner.size;
    return frame("Spinner", {
      direction: "none",
      width: size,
      height: size,
      fill: isGrow ? token(role) : NONE,
      stroke: isGrow ? void 0 : { color: roleColor(role), weight: SPACE.spinner.border },
      radius: RADIUS.pill,
      opacity: isGrow ? 0.4 : 1,
      children: []
    });
  };
  var closeButton = (_spec, v) => {
    var _a;
    const dark = ((_a = v.Theme) != null ? _a : "Light").trim().toLowerCase() === "dark";
    return frame("CloseButton", {
      direction: "horizontal",
      primaryAlign: "center",
      counterAlign: "center",
      width: 24,
      height: 24,
      radius: RADIUS.base,
      fill: dark ? solid(COLOR.bodyText) : NONE,
      children: [txt("X", "\xD7", { fontSize: 14, color: dark ? solid(COLOR.surface) : solid(COLOR.secondaryText) })]
    });
  };
  var placeholder = (_spec, v) => {
    var _a;
    const size = ((_a = v.Size) != null ? _a : "md").trim().toLowerCase();
    const h = size === "xs" ? 8 : size === "sm" ? 10 : size === "lg" ? 16 : 12;
    return frame("Placeholder", { direction: "none", width: 160, height: h, fill: solid(COLOR.placeholder), radius: RADIUS.sm, opacity: 0.5, children: [] });
  };
  var listGroup = () => frame("ListGroup", {
    direction: "vertical",
    width: 280,
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    radius: RADIUS.base,
    clip: true,
    children: [
      inst("ListGroupItem", { State: "Active" }, { width: "fill" }),
      inst("ListGroupItem", { State: "Default" }, { width: "fill", text: { ItemText: "A second item" } }),
      inst("ListGroupItem", { State: "Default" }, { width: "fill", text: { ItemText: "A third item" } })
    ]
  });
  var pagination = () => frame("Pagination", {
    direction: "horizontal",
    gap: 0,
    width: "hug",
    children: [
      inst("PageItem", { State: "Prev" }),
      inst("PageItem", { State: "Default" }, { text: { PageText: "1" } }),
      inst("PageItem", { State: "Active" }, { text: { PageText: "2" } }),
      inst("PageItem", { State: "Default" }, { text: { PageText: "3" } }),
      inst("PageItem", { State: "Next" })
    ]
  });
  var progress = (_spec, v) => {
    var _a;
    const role = (_a = v.Variant) != null ? _a : "Primary";
    return frame("Progress", {
      direction: "horizontal",
      width: 280,
      height: SPACE.progress.height,
      fill: solid(COLOR.trackBg),
      radius: SPACE.progress.radius,
      clip: true,
      children: [frame("Bar", { direction: "none", width: 140, height: SPACE.progress.height, fill: token(role), children: [] })]
    });
  };
  var navbar = (_spec, v) => {
    var _a;
    const dark = ((_a = v.Theme) != null ? _a : "Light").trim().toLowerCase() === "dark";
    const bg = dark ? roleColor("dark") : COLOR.subtleBg;
    const brandColor = dark ? COLOR.surface : COLOR.bodyText;
    const activeColor = dark ? COLOR.surface : roleColor("primary");
    const mutedColor = dark ? { r: 0.73, g: 0.75, b: 0.78 } : COLOR.secondaryText;
    const navPad = [SPACE.navLink.padV, SPACE.navLink.padH, SPACE.navLink.padV, SPACE.navLink.padH];
    const link = (text2, active) => frame("Item", { direction: "horizontal", padding: navPad, width: "hug", children: [txt("ItemText", text2, { color: solid(active ? activeColor : mutedColor) })] });
    return frame("Navbar", {
      direction: "horizontal",
      padding: [SPACE.navbar.padV, SPACE.navbar.padH, SPACE.navbar.padV, SPACE.navbar.padH],
      gap: 16,
      counterAlign: "center",
      primaryAlign: "space-between",
      width: 480,
      fill: solid(bg),
      children: [
        txt("Brand", "Navbar", { bold: true, fontSize: FONT.lg, color: solid(brandColor) }),
        frame("Nav", { direction: "horizontal", gap: 8, width: "hug", slot: openSlot("Nav links or buttons \u2014 drop items here", ["Button"]), children: [link("Home", true), link("Features", false), link("Pricing", false)] })
      ]
    });
  };
  var breadcrumb = () => frame("Breadcrumb", {
    direction: "horizontal",
    gap: SPACE.breadcrumb.gap,
    counterAlign: "center",
    width: "hug",
    children: [
      inst("BreadcrumbItem", { State: "Link" }, { text: { Label: "Home" } }),
      inst("BreadcrumbItem", { State: "Link" }, { text: { Label: "Library" } }),
      inst("BreadcrumbItem", { State: "Active" }, { text: { Label: "Data" } })
    ]
  });
  var navStrip = (spec) => frame(spec.name, {
    direction: "horizontal",
    gap: 4,
    counterAlign: "center",
    width: "hug",
    stroke: spec.name.trim().toLowerCase() === "pills" ? void 0 : { color: COLOR.border, weight: 1, side: "bottom" },
    children: [
      inst("NavLink", { State: "Active" }, { text: { Label: "Active" } }),
      inst("NavLink", { State: "Default" }, { text: { Label: "Link" } }),
      inst("NavLink", { State: "Default" }, { text: { Label: "Link" } })
    ]
  });
  var tabs = () => frame("Tabs", {
    direction: "vertical",
    width: 360,
    children: [
      frame("Nav", {
        direction: "horizontal",
        gap: 4,
        stroke: { color: COLOR.border, weight: 1, side: "bottom" },
        width: "fill",
        children: [inst("NavLink", { State: "Active" }, { text: { Label: "Tab one" } }), inst("NavLink", { State: "Default" }, { text: { Label: "Tab two" } })]
      }),
      frame("Content", {
        direction: "vertical",
        width: "fill",
        slot: openSlot("Tab panels \u2014 drop TabPane instances", ["TabPane"]),
        children: [inst("TabPane", { State: "Active" }, { width: "fill" }), inst("TabPane", { State: "Inactive" }, { width: "fill", text: { PaneText: "Second tab panel content." } })]
      })
    ]
  });
  var carousel = () => frame("Carousel", {
    direction: "none",
    width: 360,
    height: 200,
    fill: solid(COLOR.trackBg),
    radius: RADIUS.base,
    clip: true,
    children: [
      frame("Inner", {
        direction: "none",
        width: 360,
        height: 200,
        x: 0,
        y: 0,
        clip: true,
        slot: openSlot("Slides \u2014 drop CarouselSlide instances", ["CarouselSlide"]),
        children: [inst("CarouselSlide", { State: "Active" }, { x: 0, y: 0 })]
      }),
      frame("Prev", { direction: "horizontal", primaryAlign: "center", counterAlign: "center", width: 40, height: 200, x: 0, y: 0, children: [txt("PrevIcon", "\u2039", { fontSize: 24 })] }),
      frame("Next", { direction: "horizontal", primaryAlign: "center", counterAlign: "center", width: 40, height: 200, x: 320, y: 0, children: [txt("NextIcon", "\u203A", { fontSize: 24 })] })
    ]
  });
  var dropdown = () => frame("Dropdown", {
    direction: "vertical",
    gap: 4,
    width: "hug",
    children: [
      frame("Toggle", {
        direction: "horizontal",
        gap: 6,
        padding: [CONTROL_PAD.md[0], CONTROL_PAD.md[1], CONTROL_PAD.md[0], CONTROL_PAD.md[1]],
        counterAlign: "center",
        width: "hug",
        fill: token("Primary"),
        radius: RADIUS.base,
        children: [txt("ToggleText", "Dropdown", { color: solid(roleTextColor("Primary")) }), txt("Caret", "\u25BE", { color: solid(roleTextColor("Primary")) })]
      }),
      frame("Menu", {
        direction: "vertical",
        padding: [SPACE.dropdown.padV, 0, SPACE.dropdown.padV, 0],
        slot: openSlot("Menu items \u2014 drop DropdownItem instances", ["DropdownItem"]),
        width: SPACE.dropdown.minWidth,
        fill: solid(COLOR.surface),
        stroke: { color: COLOR.border, weight: 1 },
        radius: SPACE.dropdown.radius,
        children: [
          inst("DropdownItem", { Variant: "Default" }, { width: "fill" }),
          inst("DropdownItem", { Variant: "Active" }, { width: "fill", text: { LinkText: "Active link" } }),
          inst("DropdownItem", { Variant: "Divider" }, { width: "fill" }),
          inst("DropdownItem", { Variant: "Default" }, { width: "fill", text: { LinkText: "Another action" } })
        ]
      })
    ]
  });
  var accordion = () => frame("Accordion", {
    direction: "vertical",
    width: 360,
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    radius: RADIUS.base,
    clip: true,
    children: [
      inst("AccordionItem", { State: "Open" }, { width: "fill", text: { Title: "Accordion Item #1" } }),
      inst("AccordionItem", { State: "Closed" }, { width: "fill", text: { Title: "Accordion Item #2" } })
    ]
  });
  var collapse = (_spec, v) => {
    var _a;
    const expanded = ((_a = v.State) != null ? _a : "Expanded").trim().toLowerCase() === "expanded";
    const children = [
      frame("Toggle", { direction: "horizontal", padding: [CONTROL_PAD.md[0], CONTROL_PAD.md[1], CONTROL_PAD.md[0], CONTROL_PAD.md[1]], width: "hug", fill: token("Primary"), radius: RADIUS.base, children: [txt("ToggleText", "Toggle content", { color: solid(roleTextColor("Primary")) })] })
    ];
    if (expanded) {
      children.push(frame("Content", { direction: "vertical", padding: 16, width: 300, fill: solid(COLOR.surface), stroke: { color: COLOR.border, weight: 1 }, radius: RADIUS.base, children: [txt("ContentText", "Collapsible content revealed on toggle.", {})] }));
    }
    return frame("Collapse", { direction: "vertical", gap: 8, width: "hug", children });
  };
  var toast = (_spec, v) => {
    var _a;
    const simple = ((_a = v.Layout) != null ? _a : "WithHeader").trim().toLowerCase() === "simple";
    const children = [];
    if (!simple) {
      children.push(
        frame("Header", {
          direction: "horizontal",
          gap: 8,
          counterAlign: "center",
          primaryAlign: "space-between",
          padding: [SPACE.toast.headerPadV, SPACE.toast.headerPadH, SPACE.toast.headerPadV, SPACE.toast.headerPadH],
          width: "fill",
          stroke: { color: COLOR.border, weight: 1, side: "bottom" },
          children: [txt("HeaderText", "Notification", { bold: true }), txt("Time", "just now", { muted: true, fontSize: FONT.sm })]
        })
      );
    }
    children.push(frame("Body", { direction: "horizontal", primaryAlign: "space-between", counterAlign: "center", padding: SPACE.toast.bodyPad, width: "fill", slot: openSlot("Toast content"), children: [txt("BodyText", "Hello, this is a toast message.", { grow: true }), ...simple ? [txt("Close", "\xD7", { muted: true })] : []] }));
    return frame("Toast", {
      direction: "vertical",
      width: SPACE.toast.width,
      fill: solid(COLOR.surface),
      stroke: { color: COLOR.border, weight: 1 },
      radius: SPACE.toast.radius,
      clip: true,
      children
    });
  };
  var offcanvas = (_spec, v) => {
    var _a;
    const placement = ((_a = v.Placement) != null ? _a : "Start").trim().toLowerCase();
    const horizontal = placement === "start" || placement === "end";
    return frame("Offcanvas", {
      direction: "vertical",
      width: horizontal ? SPACE.offcanvas.width : 520,
      height: horizontal ? 320 : 200,
      fill: solid(COLOR.surface),
      stroke: { color: COLOR.border, weight: 1 },
      children: [
        frame("Header", {
          direction: "horizontal",
          primaryAlign: "space-between",
          counterAlign: "center",
          padding: SPACE.offcanvas.pad,
          width: "fill",
          stroke: { color: COLOR.border, weight: 1, side: "bottom" },
          children: [txt("Title", "Offcanvas", { bold: true, fontSize: FONT.lg }), txt("Close", "\xD7", { muted: true })]
        }),
        frame("Body", { direction: "vertical", padding: SPACE.offcanvas.pad, gap: 8, width: "fill", grow: true, slot: openSlot("Offcanvas content"), children: [txt("BodyText", "Offcanvas panel body content.", {})] })
      ]
    });
  };
  var modal = () => frame("Modal", {
    direction: "vertical",
    width: SPACE.modal.width,
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    radius: SPACE.modal.radius,
    clip: true,
    children: [
      frame("Header", {
        direction: "horizontal",
        primaryAlign: "space-between",
        counterAlign: "center",
        padding: SPACE.modal.pad,
        width: "fill",
        stroke: { color: COLOR.border, weight: 1, side: "bottom" },
        children: [txt("Title", "Modal title", { bold: true, fontSize: FONT.lg }), txt("Close", "\xD7", { muted: true })]
      }),
      frame("Body", { direction: "vertical", padding: SPACE.modal.pad, gap: 8, width: "fill", slot: openSlot("Modal content"), children: [txt("BodyText", "Modal body content goes here.", {})] }),
      frame("Footer", {
        direction: "horizontal",
        gap: 8,
        primaryAlign: "max",
        padding: SPACE.modal.pad,
        width: "fill",
        stroke: { color: COLOR.border, weight: 1, side: "top" },
        children: [
          frame("CancelBtn", { direction: "horizontal", padding: [6, 12, 6, 12], width: "hug", fill: token("Secondary"), radius: RADIUS.base, children: [txt("CancelText", "Close", { color: solid(roleTextColor("Secondary")) })] }),
          frame("SaveBtn", { direction: "horizontal", padding: [6, 12, 6, 12], width: "hug", fill: token("Primary"), radius: RADIUS.base, children: [txt("SaveText", "Save changes", { color: solid(roleTextColor("Primary")) })] })
        ]
      })
    ]
  });
  var formField = (spec, v) => {
    var _a, _b, _c, _d;
    const size = (_a = v.Size) != null ? _a : "md";
    const state = ((_b = v.State) != null ? _b : "default").toLowerCase();
    const kind = spec.name.trim().toLowerCase();
    const isTextarea = kind === "textarea";
    const isSelect = kind === "select";
    const disabled = state === "disabled";
    const h = isTextarea ? 72 : (_c = CONTROL_HEIGHT[size]) != null ? _c : CONTROL_HEIGHT.md;
    const [padV, padH] = (_d = CONTROL_PAD[size]) != null ? _d : CONTROL_PAD.md;
    const borderColor = state === "valid" ? roleColor("success") : state === "invalid" ? roleColor("danger") : COLOR.inputBorder;
    const fieldChildren = isSelect ? [txt("FieldText", "Choose\u2026", { muted: true, fontSize: sizeFont(size), grow: true }), txt("Caret", "\u25BE", { muted: true })] : [txt("FieldText", isTextarea ? "Textarea" : "Input text", { muted: true, fontSize: sizeFont(size), grow: true })];
    const children = [txt("Label", "Label", { bold: false })];
    children.push(
      frame("Field", {
        direction: "horizontal",
        counterAlign: isTextarea ? "min" : "center",
        padding: [padV, padH, padV, padH],
        width: "fill",
        height: h,
        fill: solid(disabled ? COLOR.trackBg : COLOR.surface),
        stroke: { color: borderColor, weight: 1 },
        radius: sizeRadius(size),
        children: fieldChildren
      })
    );
    const helpColor = state === "valid" ? solid(roleColor("success")) : state === "invalid" ? solid(roleColor("danger")) : solid(COLOR.secondaryText);
    const helpText = state === "valid" ? "Looks good!" : state === "invalid" ? "Please fix this field." : "Help text";
    children.push(txt("Help", helpText, { fontSize: FONT.sm, color: helpColor }));
    return frame(spec.name, { direction: "vertical", gap: 4, width: 240, children });
  };
  var formCheck = (spec, v) => {
    var _a;
    const kind = spec.name.trim().toLowerCase();
    const isSwitch = kind === "switch";
    const isRadio = kind === "radio";
    const state = ((_a = v.State) != null ? _a : "Checked").toLowerCase();
    const checked = state === "checked";
    const disabled = state === "disabled";
    const boxChildren = checked && !isSwitch ? [txt("Glyph", isRadio ? "\u25CF" : "\u2713", { fontSize: 10, color: solid(roleTextColor("Primary")) })] : [];
    const box = frame("Field", {
      direction: "horizontal",
      primaryAlign: isSwitch ? "max" : "center",
      counterAlign: "center",
      padding: isSwitch ? 2 : 0,
      width: isSwitch ? SPACE.formCheck.switchWidth : SPACE.formCheck.size,
      height: SPACE.formCheck.size,
      fill: checked ? token("Primary") : solid(COLOR.surface),
      stroke: { color: checked ? roleColor("primary") : COLOR.inputBorder, weight: 1 },
      radius: isSwitch || isRadio ? RADIUS.pill : RADIUS.sm,
      children: isSwitch ? [frame("Knob", { direction: "none", width: 12, height: 12, fill: solid(COLOR.surface), radius: RADIUS.pill, children: [] })] : boxChildren
    });
    return frame(spec.name, {
      direction: "horizontal",
      gap: SPACE.formCheck.gap,
      counterAlign: "center",
      width: "hug",
      opacity: disabled ? 0.5 : 1,
      children: [box, txt("Label", `${spec.name} label`, {})]
    });
  };
  var range = () => {
    const mid = (SPACE.range.thumb - SPACE.range.trackH) / 2;
    return frame("Range", {
      direction: "none",
      width: 240,
      height: SPACE.range.thumb,
      children: [
        frame("Track", { direction: "none", width: 240, height: SPACE.range.trackH, x: 0, y: mid, fill: solid(COLOR.trackBg), radius: RADIUS.pill, children: [] }),
        frame("Thumb", { direction: "none", width: SPACE.range.thumb, height: SPACE.range.thumb, x: 112, y: 0, fill: token("Primary"), radius: RADIUS.pill, children: [] })
      ]
    });
  };
  var inputGroup = () => frame("InputGroup", {
    direction: "horizontal",
    counterAlign: "center",
    width: 300,
    height: CONTROL_HEIGHT.md,
    children: [
      frame("Text", { direction: "horizontal", primaryAlign: "center", counterAlign: "center", padding: [SPACE.inputGroup.addonPadV, SPACE.inputGroup.addonPadH, SPACE.inputGroup.addonPadV, SPACE.inputGroup.addonPadH], height: "fill", fill: solid(COLOR.trackBg), stroke: { color: COLOR.inputBorder, weight: 1 }, slot: openSlot("Add-on \u2014 text or button", ["Button"]), children: [txt("AddonText", "@", { muted: true })] }),
      frame("Field", { direction: "horizontal", counterAlign: "center", padding: [CONTROL_PAD.md[0], CONTROL_PAD.md[1], CONTROL_PAD.md[0], CONTROL_PAD.md[1]], grow: true, height: "fill", fill: solid(COLOR.surface), stroke: { color: COLOR.inputBorder, weight: 1 }, children: [txt("FieldText", "Username", { muted: true, grow: true })] })
    ]
  });
  var buttonGroup = (_spec, v) => {
    var _a, _b;
    const size = (_a = v.Size) != null ? _a : "md";
    const [padV, padH] = (_b = CONTROL_PAD[size]) != null ? _b : CONTROL_PAD.md;
    const font = sizeFont(size);
    const seg = (text2, active = false) => frame("Button", {
      direction: "horizontal",
      primaryAlign: "center",
      counterAlign: "center",
      padding: [padV, padH, padV, padH],
      width: "hug",
      fill: active ? token("Primary") : NONE,
      stroke: { color: roleColor("primary"), weight: 1 },
      children: [txt("Label", text2, { fontSize: font, color: active ? solid(roleTextColor("Primary")) : solid(roleColor("primary")) })]
    });
    return frame("ButtonGroup", { direction: "horizontal", gap: 0, width: "hug", slot: openSlot("Buttons \u2014 drop Button instances", ["Button"]), children: [seg("Left", true), seg("Middle"), seg("Right")] });
  };
  var table = () => frame("Table", {
    direction: "vertical",
    width: 360,
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    radius: RADIUS.sm,
    clip: true,
    children: [
      inst("TableRow", { Type: "Head" }, { width: "fill" }),
      inst("TableRow", { Type: "Body" }, { width: "fill" }),
      inst("TableRow", { Type: "Body" }, { width: "fill" }),
      inst("TableRow", { Type: "Body" }, { width: "fill" })
    ]
  });
  var figure = () => frame("Figure", {
    direction: "vertical",
    gap: 8,
    width: 280,
    children: [
      frame("Image", { direction: "horizontal", primaryAlign: "center", counterAlign: "center", width: 280, height: 160, fill: solid(COLOR.trackBg), radius: RADIUS.base, children: [txt("ImagePlaceholder", "Image", { muted: true })] }),
      txt("Caption", "A caption for the above image.", { muted: true, fontSize: FONT.sm })
    ]
  });
  var floatingLabel = (spec, v) => {
    var _a;
    const control = ((_a = v.Control) != null ? _a : "Input").trim().toLowerCase();
    const isTextarea = control === "textarea";
    const h = isTextarea ? 88 : 58;
    const value = control === "select" ? "Open this select menu" : control === "textarea" ? "Comments" : "name@example.com";
    return frame(spec.name, {
      direction: "none",
      width: 260,
      height: h,
      children: [
        frame("Field", {
          direction: "none",
          x: 0,
          y: 0,
          width: 260,
          height: h,
          fill: solid(COLOR.surface),
          stroke: { color: COLOR.inputBorder, weight: 1 },
          radius: RADIUS.base,
          children: [txt("FieldText", value, { x: 12, y: h - 26, muted: true })]
        }),
        // The floated (resting-small) label — sits at the top-left, mapped to <label> on export.
        txt("Label", "Email address", { x: 12, y: 6, fontSize: 12, muted: true })
      ]
    });
  };
  var tooltip = (spec) => frame(spec.name, {
    direction: "horizontal",
    primaryAlign: "center",
    counterAlign: "center",
    padding: [4, 8, 4, 8],
    width: "hug",
    height: "hug",
    fill: solid({ r: 0, g: 0, b: 0 }),
    radius: RADIUS.base,
    opacity: 0.9,
    children: [txt("Inner", labelText(spec, "Tooltip text"), { fontSize: 14, color: solid(COLOR.surface) })]
  });
  var popover = () => frame("Popover", {
    direction: "vertical",
    width: 260,
    fill: solid(COLOR.surface),
    stroke: { color: COLOR.border, weight: 1 },
    radius: RADIUS.base,
    clip: true,
    children: [
      frame("Header", {
        direction: "horizontal",
        padding: [8, 16, 8, 16],
        width: "fill",
        fill: solid(COLOR.trackBg),
        stroke: { color: COLOR.border, weight: 1, side: "bottom" },
        children: [txt("HeaderText", "Popover title", { bold: true })]
      }),
      frame("Body", { direction: "vertical", padding: 16, width: "fill", children: [txt("BodyText", "And here is some popover content.", {})] })
    ]
  });
  var accordionItem = (spec, v) => {
    var _a;
    const state = ((_a = v.State) != null ? _a : "Closed").trim().toLowerCase();
    const open = state === "open";
    const disabled = state === "disabled";
    return frame("AccordionItem", {
      direction: "vertical",
      width: 360,
      fill: solid(COLOR.surface),
      stroke: { color: COLOR.border, weight: 1 },
      radius: RADIUS.base,
      clip: true,
      opacity: disabled ? 0.65 : 1,
      children: [
        frame("Header", {
          direction: "horizontal",
          padding: [SPACE.accordion.btnPadV, SPACE.accordion.btnPadH, SPACE.accordion.btnPadV, SPACE.accordion.btnPadH],
          width: "fill",
          fill: open ? solid(tint(roleColor("primary"), 0.8)) : solid(COLOR.surface),
          stroke: { color: COLOR.border, weight: 1, side: "bottom" },
          children: [
            frame("Button", {
              direction: "horizontal",
              primaryAlign: "space-between",
              counterAlign: "center",
              width: "fill",
              grow: true,
              children: [
                txt("Title", labelText(spec, "Accordion Item"), { color: open ? solid(shade(roleColor("primary"), 0.2)) : solid(COLOR.bodyText) }),
                txt("Chevron", open ? "\u25BE" : "\u25B8", { muted: true })
              ]
            })
          ]
        }),
        frame("Collapse", {
          direction: "vertical",
          width: "fill",
          children: [
            frame("Body", {
              direction: "vertical",
              padding: [SPACE.accordion.bodyPadV, SPACE.accordion.bodyPadH, SPACE.accordion.bodyPadV, SPACE.accordion.bodyPadH],
              width: "fill",
              slot: openSlot("Accordion panel content", ["Button"]),
              children: [txt("BodyText", "Accordion body \u2014 expanded content.", {})]
            })
          ]
        })
      ]
    });
  };
  var listGroupItem = (_spec, v) => {
    var _a;
    const state = ((_a = v.State) != null ? _a : "Default").trim().toLowerCase();
    const active = state === "active";
    const disabled = state === "disabled";
    return frame("ListGroupItem", {
      direction: "horizontal",
      counterAlign: "center",
      padding: [SPACE.listGroupItem.padV, SPACE.listGroupItem.padH, SPACE.listGroupItem.padV, SPACE.listGroupItem.padH],
      width: 280,
      fill: active ? token("Primary") : solid(COLOR.surface),
      stroke: { color: COLOR.border, weight: 1 },
      opacity: disabled ? 0.65 : 1,
      children: [
        frame("Content", {
          direction: "horizontal",
          counterAlign: "center",
          width: "fill",
          grow: true,
          slot: openSlot("Item content \u2014 text, badge, or a form control", ["Badge"]),
          children: [txt("ItemText", "An item", { color: active ? solid(roleTextColor("Primary")) : solid(COLOR.bodyText) })]
        })
      ]
    });
  };
  var navLink = (_spec, v) => {
    var _a;
    const state = ((_a = v.State) != null ? _a : "Default").trim().toLowerCase();
    const active = state === "active";
    const disabled = state === "disabled";
    return frame("NavLink", {
      direction: "horizontal",
      width: "hug",
      children: [
        frame("Link", {
          direction: "horizontal",
          padding: [SPACE.navLink.padV, SPACE.navLink.padH, SPACE.navLink.padV, SPACE.navLink.padH],
          width: "hug",
          fill: active ? token("Primary") : NONE,
          radius: active ? RADIUS.base : 0,
          opacity: disabled ? 0.65 : 1,
          children: [txt("Label", "Link", { color: active ? solid(roleTextColor("Primary")) : solid(roleColor("primary")) })]
        })
      ]
    });
  };
  var pageItem = (_spec, v) => {
    var _a;
    const state = ((_a = v.State) != null ? _a : "Default").trim().toLowerCase();
    const active = state === "active";
    const disabled = state === "disabled";
    const label3 = state === "prev" ? "\xAB" : state === "next" ? "\xBB" : state === "ellipsis" ? "\u2026" : "1";
    return frame("PageItem", {
      direction: "horizontal",
      width: "hug",
      children: [
        frame("Link", {
          direction: "horizontal",
          primaryAlign: "center",
          counterAlign: "center",
          padding: [SPACE.pageLink.padV, SPACE.pageLink.padH, SPACE.pageLink.padV, SPACE.pageLink.padH],
          fill: active ? token("Primary") : solid(COLOR.surface),
          stroke: { color: COLOR.border, weight: 1 },
          opacity: disabled ? 0.65 : 1,
          children: [txt("PageText", label3, { color: active ? solid(roleTextColor("Primary")) : solid(roleColor("primary")) })]
        })
      ]
    });
  };
  var dropdownItem = (_spec, v) => {
    var _a;
    const variant2 = ((_a = v.Variant) != null ? _a : "Default").trim().toLowerCase();
    if (variant2 === "divider") {
      return frame("DropdownItem", { direction: "vertical", width: 200, padding: [SPACE.dropdown.padV, 0, SPACE.dropdown.padV, 0], children: [frame("Divider", { direction: "none", width: "fill", height: 1, fill: solid(COLOR.border), children: [] })] });
    }
    if (variant2 === "header") {
      return frame("DropdownItem", { direction: "vertical", width: 200, children: [frame("Header", { direction: "horizontal", padding: [SPACE.dropdown.itemPadV, SPACE.dropdown.itemPadH, SPACE.dropdown.itemPadV, SPACE.dropdown.itemPadH], width: "fill", children: [txt("HeaderText", "Dropdown header", { muted: true, bold: true, fontSize: FONT.sm })] })] });
    }
    const active = variant2 === "active";
    const disabled = variant2 === "disabled";
    return frame("DropdownItem", {
      direction: "vertical",
      width: 200,
      children: [
        frame("Link", {
          direction: "horizontal",
          padding: [SPACE.dropdown.itemPadV, SPACE.dropdown.itemPadH, SPACE.dropdown.itemPadV, SPACE.dropdown.itemPadH],
          width: "fill",
          fill: active ? token("Primary") : NONE,
          opacity: disabled ? 0.65 : 1,
          children: [txt("LinkText", "Action", { color: active ? solid(roleTextColor("Primary")) : solid(COLOR.bodyText) })]
        })
      ]
    });
  };
  var tableRow = (_spec, v) => {
    var _a;
    const head = ((_a = v.Type) != null ? _a : "Head").trim().toLowerCase() === "head";
    const cells = head ? ["#", "Name", "Role"] : ["1", "Alice", "Admin"];
    return frame("TableRow", {
      direction: "horizontal",
      width: 360,
      fill: head ? solid(COLOR.subtleBg) : solid(COLOR.surface),
      children: cells.map(
        (c) => frame(head ? "Th" : "Td", {
          direction: "horizontal",
          grow: true,
          counterAlign: "center",
          padding: [SPACE.tableCell.padV, SPACE.tableCell.padH, SPACE.tableCell.padV, SPACE.tableCell.padH],
          stroke: { color: COLOR.border, weight: 1, side: "bottom" },
          children: [txt("CellText", c, { bold: head })]
        })
      )
    });
  };
  var breadcrumbItem = (_spec, v) => {
    var _a;
    const active = ((_a = v.State) != null ? _a : "Link").trim().toLowerCase() === "active";
    return frame("BreadcrumbItem", {
      direction: "horizontal",
      width: "hug",
      children: [txt("Label", active ? "Data" : "Home", { color: active ? solid(COLOR.secondaryText) : solid(roleColor("primary")) })]
    });
  };
  var tabPane = () => frame("TabPane", {
    direction: "vertical",
    padding: 16,
    width: 360,
    fill: solid(COLOR.surface),
    slot: openSlot("Tab panel content"),
    children: [txt("PaneText", "Active tab panel content.", {})]
  });
  var carouselSlide = () => frame("CarouselSlide", {
    direction: "none",
    width: 360,
    height: 200,
    fill: solid(COLOR.trackBg),
    radius: RADIUS.base,
    clip: true,
    children: [
      frame("Image", { direction: "horizontal", primaryAlign: "center", counterAlign: "center", x: 0, y: 0, width: 360, height: 200, children: [txt("ImgText", "Slide", { muted: true })] }),
      frame("Caption", { direction: "vertical", x: 110, y: 150, width: 140, slot: openSlot("Slide caption", ["Button"]), children: [txt("CaptionText", "Slide caption", { color: solid(COLOR.surface) })] })
    ]
  });
  var RENDERERS = {
    button,
    badge,
    alert,
    card,
    spinner,
    "close-button": closeButton,
    placeholder,
    "list-group": listGroup,
    pagination,
    progress,
    navbar,
    breadcrumb,
    nav: navStrip,
    tabs,
    carousel,
    dropdown,
    accordion,
    collapse,
    toast,
    offcanvas,
    modal,
    "form-field": formField,
    "form-check": formCheck,
    range,
    "input-group": inputGroup,
    "button-group": buttonGroup,
    table,
    figure,
    "floating-label": floatingLabel,
    tooltip,
    popover,
    "accordion-item": accordionItem,
    "list-group-item": listGroupItem,
    navlink: navLink,
    "page-item": pageItem,
    "dropdown-item": dropdownItem,
    "table-row": tableRow,
    "breadcrumb-item": breadcrumbItem,
    "tab-pane": tabPane,
    "carousel-slide": carouselSlide
  };
  var RENDERER_KINDS = Object.keys(RENDERERS);
  var slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  function specKind(spec) {
    var _a, _b;
    const def = { key: `gen-${spec.name}`, setName: spec.name, properties: planComponent(spec).componentDef.properties };
    return (_b = (_a = matchBootstrapComponent(spec.name, def, slug)) == null ? void 0 : _a.kind) != null ? _b : null;
  }
  function fallbackRenderer(spec) {
    var _a;
    const parts = (_a = spec.parts) != null ? _a : [];
    const children = parts.length ? parts.map(
      (p) => p.text != null ? txt(p.name, p.text, {}) : frame(p.name, { direction: "horizontal", counterAlign: "center", padding: 8, width: "fill", height: 32, fill: solid(COLOR.subtleBg), stroke: { color: COLOR.border, weight: 1 }, radius: RADIUS.sm, children: [txt(`${p.name}Label`, p.name, { muted: true, fontSize: FONT.sm })] })
    ) : [txt("Label", spec.name, { muted: true })];
    return frame(spec.name, { direction: "vertical", gap: 8, padding: 12, width: 240, fill: solid(COLOR.surface), stroke: { color: COLOR.border, weight: 1 }, radius: RADIUS.base, children });
  }
  function blueprintVariant(spec, values) {
    var _a;
    const kind = (_a = specKind(spec)) != null ? _a : slug(spec.name);
    const renderer = RENDERERS[kind];
    return renderer ? renderer(spec, values) : fallbackRenderer(spec);
  }

  // src/targets/django/generate/sheet.ts
  function packShelves(sizes, maxWidth, gapX, gapY) {
    const placed = [];
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    for (const size of sizes) {
      if (x > 0 && x + size.w > maxWidth) {
        x = 0;
        y += rowHeight + gapY;
        rowHeight = 0;
      }
      placed.push({ x, y });
      x += size.w + gapX;
      rowHeight = Math.max(rowHeight, size.h);
    }
    return placed;
  }
  function variantCells(plan) {
    var _a, _b;
    const variantProps2 = plan.componentDef.properties.filter((prop) => prop.type === "VARIANT");
    const total = plan.variants.length;
    if (variantProps2.length <= 1) {
      return plan.variants.map((_, i) => ({ x: 0, y: i }));
    }
    const firstCount = (_b = (_a = variantProps2[0].variantOptions) == null ? void 0 : _a.length) != null ? _b : 1;
    const restCount = Math.max(1, Math.round(total / firstCount));
    return plan.variants.map((_, i) => ({ x: i % restCount, y: Math.floor(i / restCount) }));
  }
  function clusterSubtitle(plan) {
    const props = plan.componentDef.properties;
    const axes = props.filter((p) => p.type === "VARIANT").map((p) => {
      var _a, _b;
      return `${p.name} (${(_b = (_a = p.variantOptions) == null ? void 0 : _a.length) != null ? _b : 0})`;
    });
    const bools = props.filter((p) => p.type === "BOOLEAN").map((p) => p.name);
    const n = plan.variants.length;
    const parts = [];
    parts.push(axes.length ? axes.join(" \xB7 ") : "single frame");
    parts.push(`${n} ${n === 1 ? "variant" : "variants"}`);
    if (bools.length) parts.push(`bool: ${bools.join(", ")}`);
    return parts.join("  \xB7  ");
  }

  // src/targets/django/bootstrap/specs.ts
  var ROLES2 = ["Primary", "Secondary", "Success", "Danger", "Warning", "Info", "Light", "Dark"];
  var SIZES = ["sm", "md", "lg"];
  var variant = (name, options) => ({ name, type: "VARIANT", options });
  var bool = (name, boolDefault = false) => ({ name, type: "BOOLEAN", boolDefault });
  var BOOTSTRAP_SPECS = [
    // ---- Components ----------------------------------------------------------------------
    {
      // Variant carries both solid roles and Outline-* (so the exporter's `btn-{{variant|lower}}`
      // yields `btn-outline-primary` natively) plus Link.
      name: "Button",
      props: [variant("Variant", [...ROLES2, ...ROLES2.map((r) => `Outline-${r}`), "Link"]), variant("Size", SIZES)],
      states: ["default", "hover", "active", "disabled"],
      parts: [{ name: "Label", text: "Button" }]
    },
    {
      name: "Badge",
      props: [variant("Variant", ROLES2), variant("Shape", ["Default", "Pill"])],
      parts: [{ name: "Label", text: "Badge" }]
    },
    {
      name: "Alert",
      props: [variant("Variant", ROLES2), bool("Dismissible")],
      parts: [{ name: "Text", text: "A short alert message." }]
    },
    {
      name: "Card",
      props: [],
      parts: [
        { name: "Header", text: "Card header" },
        { name: "Body", text: "Card body text." },
        { name: "Footer", text: "Card footer" }
      ]
    },
    {
      name: "Accordion",
      props: [],
      // container → lone master + content slot (see blueprint)
      parts: [
        { name: "Item" },
        { name: "Header", text: "Accordion item" },
        { name: "Body", text: "Accordion body content." }
      ]
    },
    {
      name: "Breadcrumb",
      props: [],
      // composed from BreadcrumbItem instances (divider is CSS on the parent)
      parts: [{ name: "Item", text: "Home" }]
    },
    {
      name: "ButtonGroup",
      props: [],
      // container → lone master + slot for Button instances
      parts: [{ name: "Button", text: "Left" }]
    },
    {
      name: "CloseButton",
      props: [variant("Theme", ["Light", "Dark"])],
      parts: []
    },
    {
      name: "Collapse",
      props: [variant("State", ["Collapsed", "Expanded"])],
      parts: [
        { name: "Toggle", text: "Toggle content" },
        { name: "Content", text: "Collapsible content." }
      ]
    },
    {
      name: "Dropdown",
      props: [],
      // container → lone master + Menu slot
      parts: [
        { name: "Toggle", text: "Dropdown" },
        { name: "Menu" },
        { name: "Item", text: "Action" }
      ]
    },
    {
      name: "ListGroup",
      props: [],
      // container → lone master + items slot
      parts: [{ name: "Item", text: "An item" }]
    },
    {
      name: "Navbar",
      props: [],
      // container → lone master + Nav slot
      parts: [
        { name: "Brand", text: "Navbar" },
        { name: "Nav" },
        { name: "Item", text: "Home" }
      ]
    },
    {
      name: "Nav",
      props: [],
      parts: [{ name: "Item", text: "Active" }]
    },
    {
      name: "Pills",
      props: [],
      parts: [{ name: "Item", text: "Active" }]
    },
    {
      name: "Pagination",
      props: [],
      // composed from PageItem instances
      parts: [{ name: "Item", text: "1" }]
    },
    {
      name: "Progress",
      props: [variant("Variant", ROLES2)],
      parts: [{ name: "Bar" }]
    },
    {
      name: "Spinner",
      props: [variant("Variant", ROLES2), variant("Type", ["border", "grow"])]
    },
    {
      name: "Toast",
      props: [],
      // container → lone master + Body slot
      parts: [
        { name: "Header", text: "Notification" },
        { name: "Body", text: "Hello, this is a toast message." }
      ]
    },
    {
      name: "Offcanvas",
      props: [],
      // container → lone master + Body slot
      parts: [
        { name: "Header" },
        { name: "Title", text: "Offcanvas" },
        { name: "Body", text: "Offcanvas body content." }
      ]
    },
    {
      // The full tabbed widget: a Nav strip of Tab links + a Content area of Panes. The generator
      // seeds two tabs/panes; the exporter order-pairs Tab[i]↔Pane[i] (wave 3f).
      name: "Tabs",
      props: [],
      parts: [
        { name: "Nav" },
        { name: "Tab", text: "Tab one" },
        { name: "Tab", text: "Tab two" },
        { name: "Content" },
        { name: "Pane", text: "Panel one" },
        { name: "Pane", text: "Panel two" }
      ]
    },
    {
      name: "Carousel",
      props: [],
      parts: [
        { name: "Inner" },
        { name: "Slide" },
        { name: "Prev", text: "Previous" },
        { name: "Next", text: "Next" },
        { name: "Caption", text: "Slide one" }
      ]
    },
    {
      name: "Placeholder",
      props: [variant("Size", ["xs", "sm", "md", "lg"])],
      parts: []
    },
    // ---- Forms ---------------------------------------------------------------------------
    {
      name: "Input",
      props: [variant("Size", SIZES), variant("State", ["default", "valid", "invalid", "disabled"])],
      parts: [{ name: "Label", text: "Label" }, { name: "Field" }, { name: "Help", text: "Help text" }]
    },
    {
      name: "Textarea",
      props: [variant("Size", SIZES), variant("State", ["default", "valid", "invalid"])],
      parts: [{ name: "Label", text: "Label" }, { name: "Field" }, { name: "Help", text: "Help text" }]
    },
    {
      name: "Select",
      props: [variant("Size", SIZES), variant("State", ["default", "valid", "invalid", "disabled"])],
      parts: [{ name: "Label", text: "Label" }, { name: "Field" }, { name: "Help", text: "Help text" }]
    },
    {
      name: "Checkbox",
      props: [variant("State", ["Checked", "Unchecked", "Disabled"])],
      parts: [{ name: "Field" }, { name: "Label", text: "Checkbox label" }]
    },
    {
      name: "Radio",
      props: [variant("State", ["Checked", "Unchecked", "Disabled"])],
      parts: [{ name: "Field" }, { name: "Label", text: "Radio label" }]
    },
    {
      name: "Switch",
      props: [variant("State", ["Checked", "Unchecked", "Disabled"])],
      parts: [{ name: "Field" }, { name: "Label", text: "Switch label" }]
    },
    {
      name: "Range",
      props: [],
      parts: []
    },
    {
      name: "InputGroup",
      props: [],
      parts: [{ name: "Text", text: "@" }, { name: "Field", text: "Username" }]
    },
    {
      // `.form-floating` — the label rests as a placeholder, then floats up on focus/fill.
      name: "FloatingLabels",
      props: [variant("Control", ["Input", "Textarea", "Select"])],
      parts: [{ name: "Field" }, { name: "Label", text: "Email address" }]
    },
    // ---- Content -------------------------------------------------------------------------
    {
      name: "Table",
      props: [],
      // composed from TableRow instances
      parts: [{ name: "Row" }, { name: "Th", text: "#" }, { name: "Td", text: "Cell" }, { name: "Caption", text: "Table caption" }]
    },
    {
      name: "Figure",
      props: [],
      parts: [{ name: "Image" }, { name: "Caption", text: "A caption for the above image." }]
    },
    // ---- Prototype skeletons (built as overlays per §6.3 — NOT recognized, generated as
    // starting-point blanks only). Dispatched in blueprint.ts by name.
    {
      name: "Modal",
      props: [],
      parts: [
        { name: "Header" },
        { name: "Title", text: "Modal title" },
        { name: "Body", text: "Modal body content." },
        { name: "Footer" }
      ]
    },
    {
      name: "Tooltip",
      props: [],
      parts: [{ name: "Inner", text: "Tooltip text" }]
    },
    {
      name: "Popover",
      props: [],
      parts: [
        { name: "Header", text: "Popover title" },
        { name: "Body", text: "And here is some popover content." }
      ]
    },
    // ---- Item sub-components (phase 12) --------------------------------------------------
    // Standalone recognized masters (variants + slots) that the container masters compose from as
    // INSTANCES. Each round-trips on its own: its partial carries the Bootstrap class + parts, and
    // wiring items (AccordionItem, TabPane) take a parent-minted unique id as an include param.
    {
      name: "AccordionItem",
      props: [variant("State", ["Closed", "Open", "Disabled"])],
      parts: [{ name: "Header" }, { name: "Button", text: "Accordion Item" }, { name: "Collapse" }, { name: "Body", text: "Accordion body content." }]
    },
    {
      name: "ListGroupItem",
      props: [variant("State", ["Default", "Active", "Disabled"])],
      parts: [{ name: "Content", text: "An item" }]
    },
    {
      name: "NavLink",
      props: [variant("State", ["Default", "Active", "Disabled"])],
      parts: [{ name: "Label", text: "Link" }]
    },
    {
      name: "PageItem",
      props: [variant("State", ["Default", "Active", "Disabled", "Prev", "Next", "Ellipsis"])],
      parts: [{ name: "Link", text: "1" }]
    },
    {
      name: "DropdownItem",
      props: [variant("Variant", ["Default", "Active", "Disabled", "Header", "Divider"])],
      parts: [{ name: "Link", text: "Action" }]
    },
    {
      name: "TableRow",
      props: [variant("Type", ["Head", "Body"])],
      parts: [{ name: "Th", text: "#" }, { name: "Td", text: "Cell" }]
    },
    {
      name: "BreadcrumbItem",
      props: [variant("State", ["Link", "Active"])],
      parts: [{ name: "Label", text: "Home" }]
    },
    {
      name: "TabPane",
      props: [variant("State", ["Active", "Inactive"])],
      parts: [{ name: "Content", text: "Tab panel content." }]
    },
    {
      name: "CarouselSlide",
      props: [variant("State", ["Active", "Inactive"])],
      parts: [{ name: "Image" }, { name: "Caption", text: "Slide caption" }]
    }
  ];

  // src/targets/django/generate/kit.ts
  var KIT_PAGE_NAME = "Altery Bootstrap Kit";
  var HEADER_OFFSET = 140;
  var CLUSTER_HEAD_H = 68;
  var CLUSTER_MIN_W = 260;
  var CELL_GAP = 24;
  var SHEET_MAX_W = 1720;
  var SHEET_GAP_X = 88;
  var SHEET_GAP_Y = 96;
  async function loadKitFonts() {
    var _a, _b;
    for (const family of ["Inter", "Roboto", "Helvetica", "Arial"]) {
      try {
        const regular = { family, style: "Regular" };
        await figma.loadFontAsync(regular);
        let bold = regular;
        for (const style of ["Bold", "Semi Bold", "Medium"]) {
          try {
            const candidate = { family, style };
            await figma.loadFontAsync(candidate);
            bold = candidate;
            break;
          } catch (e) {
          }
        }
        return { regular, bold };
      } catch (e) {
      }
    }
    const available = await figma.listAvailableFontsAsync();
    const fallback = (_b = (_a = available[0]) == null ? void 0 : _a.fontName) != null ? _b : { family: "Roboto", style: "Regular" };
    await figma.loadFontAsync(fallback);
    return { regular: fallback, bold: fallback };
  }
  function solidPaint(color) {
    return { type: "SOLID", color };
  }
  function resolveFill(fill, ctx) {
    if (!fill || fill.kind === "none") return [];
    if (fill.kind === "solid") return [solidPaint(fill.color)];
    const variable = ctx.roleVars.get(fill.role.trim().toLowerCase());
    if (variable) {
      ctx.variantBound = true;
      return [figma.variables.setBoundVariableForPaint(solidPaint(fill.fallback), "color", variable)];
    }
    return [solidPaint(fill.fallback)];
  }
  function applyStroke(el, stroke) {
    el.strokes = [solidPaint(stroke.color)];
    el.strokeAlign = "INSIDE";
    if (!stroke.side || stroke.side === "all") {
      el.strokeWeight = stroke.weight;
      return;
    }
    el.strokeTopWeight = stroke.side === "top" ? stroke.weight : 0;
    el.strokeRightWeight = stroke.side === "right" ? stroke.weight : 0;
    el.strokeBottomWeight = stroke.side === "bottom" ? stroke.weight : 0;
    el.strokeLeftWeight = stroke.side === "left" ? stroke.weight : 0;
  }
  function applyPadding(el, padding) {
    if (padding == null) return;
    const [t, r, b, l] = typeof padding === "number" ? [padding, padding, padding, padding] : padding;
    el.paddingTop = t;
    el.paddingRight = r;
    el.paddingBottom = b;
    el.paddingLeft = l;
  }
  var PRIMARY_ALIGN = { min: "MIN", center: "CENTER", max: "MAX", "space-between": "SPACE_BETWEEN" };
  var COUNTER_ALIGN = { min: "MIN", center: "CENTER", max: "MAX" };
  function configureFrame(el, node, ctx) {
    if (node.direction && node.direction !== "none") {
      el.layoutMode = node.direction === "horizontal" ? "HORIZONTAL" : "VERTICAL";
      if (node.gap != null) el.itemSpacing = node.gap;
      applyPadding(el, node.padding);
      if (node.primaryAlign) el.primaryAxisAlignItems = PRIMARY_ALIGN[node.primaryAlign];
      if (node.counterAlign) el.counterAxisAlignItems = COUNTER_ALIGN[node.counterAlign];
    } else {
      el.layoutMode = "NONE";
    }
    el.fills = resolveFill(node.fill, ctx);
    if (node.stroke) applyStroke(el, node.stroke);
    if (node.radius != null) el.cornerRadius = node.radius;
    if (node.clip != null) el.clipsContent = node.clip;
    if (node.opacity != null) el.opacity = node.opacity;
  }
  function applyOwnSizing(el, node) {
    var _a, _b, _c, _d;
    const num = (v) => typeof v === "number" ? v : void 0;
    if (!node.direction || node.direction === "none") {
      el.resizeWithoutConstraints(Math.max(0.01, (_a = num(node.width)) != null ? _a : el.width), Math.max(0.01, (_b = num(node.height)) != null ? _b : el.height));
      return;
    }
    const horizontal = node.direction === "horizontal";
    const primaryDim = horizontal ? node.width : node.height;
    const counterDim = horizontal ? node.height : node.width;
    el.primaryAxisSizingMode = primaryDim === "hug" || primaryDim == null ? "AUTO" : "FIXED";
    el.counterAxisSizingMode = counterDim === "hug" || counterDim == null ? "AUTO" : "FIXED";
    if (num(node.width) != null || num(node.height) != null) {
      el.resizeWithoutConstraints(Math.max(0.01, (_c = num(node.width)) != null ? _c : el.width), Math.max(0.01, (_d = num(node.height)) != null ? _d : el.height));
    }
  }
  function applyParentFill(el, node, parentDir) {
    if (!parentDir || parentDir === "none") return;
    const parentHorizontal = parentDir === "horizontal";
    const width = node.type === "text" ? void 0 : node.width;
    const height = node.type === "text" ? void 0 : node.height;
    if (width === "fill") {
      if (parentHorizontal) el.layoutGrow = 1;
      else el.layoutAlign = "STRETCH";
    }
    if (height === "fill") {
      if (parentHorizontal) el.layoutAlign = "STRETCH";
      else el.layoutGrow = 1;
    }
    if (node.grow) el.layoutGrow = 1;
  }
  function buildText(node, ctx) {
    var _a;
    const el = figma.createText();
    el.name = node.name;
    el.fontName = node.bold ? ctx.fonts.bold : ctx.fonts.regular;
    el.characters = node.text;
    el.fontSize = node.fontSize;
    const paints = resolveFill(node.color, ctx);
    el.fills = paints.length ? paints : [solidPaint(COLOR.bodyText)];
    el.textAlignHorizontal = ((_a = node.align) != null ? _a : "left").toUpperCase();
    el.textAutoResize = node.grow ? "HEIGHT" : "WIDTH_AND_HEIGHT";
    return el;
  }
  function buildInstance(parent, node, parentDir, ctx) {
    var _a, _b, _c;
    const target = ctx.itemComponents.get(node.of);
    if (target && ctx.instancesSupported) {
      try {
        const main = target.type === "COMPONENT_SET" ? target.defaultVariant : target;
        if (typeof main.createInstance !== "function") throw new Error("createInstance unavailable");
        const instance = main.createInstance();
        parent.appendChild(instance);
        if (node.values && Object.keys(node.values).length > 0) {
          try {
            instance.setProperties(node.values);
          } catch (e) {
          }
        }
        if (node.text) {
          for (const [layer, chars] of Object.entries(node.text)) {
            const t = instance.findOne((n) => n.type === "TEXT" && n.name === layer);
            if (t) {
              try {
                t.characters = chars;
              } catch (e) {
              }
            }
          }
        }
        applyParentFill(instance, node, parentDir);
        if (parentDir === "none") {
          instance.x = (_a = node.x) != null ? _a : 0;
          instance.y = (_b = node.y) != null ? _b : 0;
        }
        return instance;
      } catch (e) {
        ctx.instancesSupported = false;
      }
    }
    const spec = SPEC_BY_NAME.get(node.of);
    if (!spec) {
      const placeholder2 = figma.createFrame();
      placeholder2.name = node.of;
      parent.appendChild(placeholder2);
      return placeholder2;
    }
    return buildInto(parent, blueprintVariant(spec, (_c = node.values) != null ? _c : {}), parentDir, ctx);
  }
  function buildInto(parent, node, parentDir, ctx) {
    var _a, _b, _c, _d, _e;
    if (node.type === "instance") return buildInstance(parent, node, parentDir, ctx);
    if (node.type === "text") {
      const el2 = buildText(node, ctx);
      parent.appendChild(el2);
      applyParentFill(el2, node, parentDir);
      if (parentDir === "none") {
        el2.x = (_a = node.x) != null ? _a : 0;
        el2.y = (_b = node.y) != null ? _b : 0;
      }
      return el2;
    }
    let slotNode;
    let slotProp;
    if (node.slot && ctx.root && ctx.slotsSupported && typeof ctx.root.createSlot === "function") {
      try {
        const before = new Set(Object.keys(ctx.root.componentPropertyDefinitions));
        slotNode = ctx.root.createSlot();
        slotProp = Object.keys(ctx.root.componentPropertyDefinitions).find((k) => !before.has(k));
      } catch (e) {
        ctx.slotsSupported = false;
      }
    }
    const el = slotNode != null ? slotNode : figma.createFrame();
    el.name = node.name;
    parent.appendChild(el);
    configureFrame(el, node, ctx);
    for (const child of node.children) buildInto(el, child, (_c = node.direction) != null ? _c : "vertical", ctx);
    applyOwnSizing(el, node);
    applyParentFill(el, node, parentDir);
    if (parentDir === "none") {
      el.x = (_d = node.x) != null ? _d : 0;
      el.y = (_e = node.y) != null ? _e : 0;
    }
    if (slotProp && node.slot && ctx.root) ctx.pendingSlots.push({ component: ctx.root, propName: slotProp, spec: node.slot });
    return el;
  }
  function buildVariantComponent(root, name, ctx) {
    var _a;
    const component = figma.createComponent();
    component.name = name;
    const prevRoot = ctx.root;
    ctx.root = component;
    configureFrame(component, root, ctx);
    for (const child of root.children) buildInto(component, child, (_a = root.direction) != null ? _a : "vertical", ctx);
    applyOwnSizing(component, root);
    ctx.root = prevRoot;
    return component;
  }
  function buildCluster(page, plan, ctx) {
    let bound = 0;
    const components = [];
    for (const variant2 of plan.variants) {
      ctx.variantBound = false;
      const root = blueprintVariant(findSpec(plan.name), variant2.values);
      const component = buildVariantComponent(root, variantNodeName(plan, variant2), ctx);
      page.appendChild(component);
      if (ctx.variantBound) bound += 1;
      components.push(component);
    }
    const cells = variantCells(plan);
    const cellW = Math.max(...components.map((c) => c.width));
    const cellH = Math.max(...components.map((c) => c.height));
    for (let i = 0; i < components.length; i++) {
      components[i].x = cells[i].x * (cellW + CELL_GAP);
      components[i].y = cells[i].y * (cellH + CELL_GAP);
    }
    let node;
    let key;
    let isSet;
    if (plan.isSet && components.length > 1) {
      const set = figma.combineAsVariants(components, page);
      set.name = plan.name;
      node = set;
      key = set.key;
      isSet = true;
    } else {
      node = components[0];
      key = components[0].key;
      isSet = false;
    }
    const heading = figma.createText();
    heading.fontName = ctx.fonts.bold;
    heading.characters = plan.name;
    heading.fontSize = FONT.heading;
    heading.fills = [solidPaint(COLOR.bodyText)];
    page.appendChild(heading);
    const subtitle = figma.createText();
    subtitle.fontName = ctx.fonts.regular;
    subtitle.characters = clusterSubtitle(plan);
    subtitle.fontSize = 13;
    subtitle.fills = [solidPaint(COLOR.secondaryText)];
    page.appendChild(subtitle);
    const size = { w: Math.max(node.width, CLUSTER_MIN_W), h: CLUSTER_HEAD_H + node.height };
    return { cluster: { nodes: [heading, subtitle, node], node, key, isSet, heading, subtitle, size }, bound };
  }
  function wireSlots(ctx, keyByName) {
    var _a, _b, _c, _d, _e;
    let wired = 0;
    for (const ps of ctx.pendingSlots) {
      try {
        const preferredValues = ((_a = ps.spec.preferredKinds) != null ? _a : []).map((name) => keyByName.get(name)).filter((v) => v != null);
        ps.component.editComponentProperty(ps.propName, {
          description: ps.spec.description,
          preferredValues,
          slotSettings: {
            allowPreferredValuesOnly: (_b = ps.spec.allowPreferredOnly) != null ? _b : false,
            minChildren: (_c = ps.spec.minChildren) != null ? _c : null,
            maxChildren: (_d = ps.spec.maxChildren) != null ? _d : null,
            stretchChildOnInsert: (_e = ps.spec.stretchOnInsert) != null ? _e : true
          }
        });
        wired += 1;
      } catch (e) {
      }
    }
    return wired;
  }
  var CLUSTER_PAD = 20;
  function placeCluster(cluster, at) {
    cluster.heading.x = at.x;
    cluster.heading.y = at.y;
    cluster.subtitle.x = at.x;
    cluster.subtitle.y = at.y + 28;
    cluster.node.x = at.x;
    cluster.node.y = at.y + CLUSTER_HEAD_H;
  }
  function addClusterBackground(page, cluster, at) {
    const rect = figma.createRectangle();
    rect.name = `${cluster.heading.characters} \xB7 panel`;
    rect.x = at.x - CLUSTER_PAD;
    rect.y = at.y - CLUSTER_PAD;
    rect.resizeWithoutConstraints(cluster.size.w + CLUSTER_PAD * 2, cluster.size.h + CLUSTER_PAD * 2);
    rect.fills = [solidPaint(COLOR.surface)];
    rect.strokes = [solidPaint(COLOR.border)];
    rect.strokeWeight = 1;
    rect.cornerRadius = 12;
    page.insertChild(0, rect);
  }
  function pageHeader(page, ctx, plans, variants) {
    const title = figma.createText();
    title.fontName = ctx.fonts.bold;
    title.characters = "Altery Bootstrap Kit";
    title.fontSize = 32;
    title.fills = [solidPaint(COLOR.bodyText)];
    title.x = 0;
    title.y = 0;
    page.appendChild(title);
    const subtitle = figma.createText();
    subtitle.fontName = ctx.fonts.regular;
    subtitle.characters = `${plans.length} master components \xB7 ${variants} variants \xB7 pixel-accurate Bootstrap 5.3 blanks \u2014 restyle these, keep the layer names.`;
    subtitle.fontSize = 15;
    subtitle.fills = [solidPaint(COLOR.secondaryText)];
    subtitle.x = 0;
    subtitle.y = 46;
    page.appendChild(subtitle);
    const legend = figma.createText();
    legend.fontName = ctx.fonts.regular;
    legend.characters = "Role fills bind to your color tokens where names match \xB7 see docs/BOOTSTRAP-CATALOG.md for the full component reference.";
    legend.fontSize = 13;
    legend.fills = [solidPaint(COLOR.secondaryText)];
    legend.x = 0;
    legend.y = 72;
    page.appendChild(legend);
  }
  var ITEM_SPEC_NAMES = /* @__PURE__ */ new Set([
    "AccordionItem",
    "ListGroupItem",
    "NavLink",
    "PageItem",
    "DropdownItem",
    "TableRow",
    "BreadcrumbItem",
    "TabPane",
    "CarouselSlide"
  ]);
  var SPEC_BY_NAME = new Map(BOOTSTRAP_SPECS.map((spec) => [spec.name, spec]));
  function findSpec(name) {
    const spec = SPEC_BY_NAME.get(name);
    if (!spec) throw new Error(`no spec for ${name}`);
    return spec;
  }
  function variantNodeName(plan, variant2) {
    return plan.isSet ? variant2.name : plan.name;
  }
  async function generateDesignKit(colorVariables) {
    const fonts = await loadKitFonts();
    const plans = planKit(BOOTSTRAP_SPECS);
    const availablePaths = [];
    const pathToVarId = /* @__PURE__ */ new Map();
    for (const variable of colorVariables) {
      const path = variable.name.split("/").join(".");
      availablePaths.push(path);
      if (!pathToVarId.has(path)) pathToVarId.set(path, variable.id);
    }
    const roleVars = /* @__PURE__ */ new Map();
    for (const role of [...ROLES, "Link"]) {
      const path = variantFillTokenPath(role, availablePaths);
      const varId = path ? pathToVarId.get(path) : null;
      roleVars.set(role.toLowerCase(), varId ? await figma.variables.getVariableByIdAsync(varId) : null);
    }
    const ctx = {
      fonts,
      roleVars,
      variantBound: false,
      root: null,
      slotsSupported: true,
      pendingSlots: [],
      itemComponents: /* @__PURE__ */ new Map(),
      instancesSupported: true
    };
    const page = figma.createPage();
    page.name = KIT_PAGE_NAME;
    const variantCount = plans.reduce((sum, plan) => sum + plan.variants.length, 0);
    pageHeader(page, ctx, plans, variantCount);
    const itemPlans = plans.filter((plan) => ITEM_SPEC_NAMES.has(plan.name));
    const masterPlans = plans.filter((plan) => !ITEM_SPEC_NAMES.has(plan.name));
    let bound = 0;
    const keyByName = /* @__PURE__ */ new Map();
    const record = (name, cluster) => keyByName.set(name, { type: cluster.isSet ? "COMPONENT_SET" : "COMPONENT", key: cluster.key });
    const itemClusters = [];
    for (const plan of itemPlans) {
      const { cluster, bound: clusterBound } = buildCluster(page, plan, ctx);
      bound += clusterBound;
      ctx.itemComponents.set(plan.name, cluster.node);
      record(plan.name, cluster);
      itemClusters.push(cluster);
    }
    const masterClusters = [];
    for (const plan of masterPlans) {
      const { cluster, bound: clusterBound } = buildCluster(page, plan, ctx);
      bound += clusterBound;
      record(plan.name, cluster);
      masterClusters.push(cluster);
    }
    const clusters = [...masterClusters, ...itemClusters];
    const positions = packShelves(clusters.map((c) => c.size), SHEET_MAX_W, SHEET_GAP_X, SHEET_GAP_Y);
    for (let i = 0; i < clusters.length; i++) {
      const at = { x: positions[i].x, y: positions[i].y + HEADER_OFFSET };
      placeCluster(clusters[i], at);
      addClusterBackground(page, clusters[i], at);
    }
    const slots = wireSlots(ctx, keyByName);
    return buildReport(plans, bound, slots);
  }

  // src/utils/graphics.ts
  function isExportedGraphic(node) {
    return Array.isArray(node.exportSettings) && node.exportSettings.length > 0;
  }
  async function resolveExportSettings(node) {
    var _a, _b, _c;
    const own = (_a = node.exportSettings) != null ? _a : [];
    if (own.length > 0) return own;
    if (node.type !== "INSTANCE") return [];
    try {
      const master = node.getMainComponentAsync ? await node.getMainComponentAsync() : (_b = node.mainComponent) != null ? _b : null;
      return (_c = master == null ? void 0 : master.exportSettings) != null ? _c : [];
    } catch (e) {
      return [];
    }
  }

  // src/targets/django/geometry.ts
  var TWO_PI = Math.PI * 2;
  function approx(a, b) {
    return Math.abs(a - b) < 1e-4;
  }
  function isDefaultArc(arc) {
    return approx(arc.startingAngle, 0) && approx(arc.endingAngle, TWO_PI) && approx(arc.innerRadius, 0);
  }
  function round2(value) {
    return Math.round(value * 100) / 100;
  }
  function polar(cx, cy, rx, ry, angle) {
    return [round2(cx + rx * Math.cos(angle)), round2(cy + ry * Math.sin(angle))];
  }
  function ellipseArcPath(arc, width, height) {
    const cx = width / 2;
    const cy = height / 2;
    const rx = width / 2;
    const ry = height / 2;
    const delta = arc.endingAngle - arc.startingAngle;
    const largeArc = Math.abs(delta) > Math.PI ? 1 : 0;
    const sweep = delta >= 0 ? 1 : 0;
    const [ox0, oy0] = polar(cx, cy, rx, ry, arc.startingAngle);
    const [ox1, oy1] = polar(cx, cy, rx, ry, arc.endingAngle);
    if (arc.innerRadius <= 0) {
      return `M ${round2(cx)} ${round2(cy)} L ${ox0} ${oy0} A ${round2(rx)} ${round2(ry)} 0 ${largeArc} ${sweep} ${ox1} ${oy1} Z`;
    }
    const irx = rx * arc.innerRadius;
    const iry = ry * arc.innerRadius;
    const [ix0, iy0] = polar(cx, cy, irx, iry, arc.startingAngle);
    const [ix1, iy1] = polar(cx, cy, irx, iry, arc.endingAngle);
    const innerSweep = sweep ? 0 : 1;
    return `M ${ox0} ${oy0} A ${round2(rx)} ${round2(ry)} 0 ${largeArc} ${sweep} ${ox1} ${oy1} L ${ix1} ${iy1} A ${round2(irx)} ${round2(iry)} 0 ${largeArc} ${innerSweep} ${ix0} ${iy0} Z`;
  }
  var PLAIN_STROKE_CAPS = /* @__PURE__ */ new Set(["NONE", "ROUND", "SQUARE"]);
  function isMixed(value) {
    return typeof value === "symbol";
  }
  function needsSvg(node) {
    if (isMixed(node.strokeCap) || isMixed(node.strokeJoin)) return true;
    if (typeof node.strokeCap === "string" && !PLAIN_STROKE_CAPS.has(node.strokeCap)) return true;
    if (typeof node.strokeJoin === "string" && node.strokeJoin !== "MITER") return true;
    if (Array.isArray(node.dashPattern) && node.dashPattern.length > 0) return true;
    if (typeof node.strokeMiterLimit === "number" && node.strokeMiterLimit !== 4) return true;
    if (node.variableWidthStrokeProperties != null) return true;
    const complex = node.complexStrokeProperties;
    if (complex && (complex.type === "BRUSH" || complex.type === "DYNAMIC")) return true;
    if (node.arcData && !isDefaultArc(node.arcData)) return true;
    return false;
  }

  // src/targets/django/easing/index.ts
  var BEZIER_PRESETS = {
    EASE_IN: { x1: 0.42, y1: 0, x2: 1, y2: 1 },
    EASE_OUT: { x1: 0, y1: 0, x2: 0.58, y2: 1 },
    EASE_IN_AND_OUT: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
    EASE_IN_BACK: { x1: 0.36, y1: 0, x2: 0.66, y2: -0.56 },
    EASE_OUT_BACK: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 },
    EASE_IN_AND_OUT_BACK: { x1: 0.68, y1: -0.6, x2: 0.32, y2: 1.6 }
  };
  var NAMED_SPRING_BOUNCE = {
    GENTLE: 0,
    QUICK: 0.05,
    BOUNCY: 0.6,
    SLOW: 0.15
  };
  var BASE_SPRING_ANGULAR_FREQUENCY = 10;
  function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
  }
  function round3(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }
  function bezierToCss(bezier) {
    return `cubic-bezier(${bezier.x1}, ${bezier.y1}, ${bezier.x2}, ${bezier.y2})`;
  }
  function easingToCss(easing) {
    switch (easing.type) {
      case "LINEAR":
        return "linear";
      case "HOLD":
        return "step-end";
      case "CUSTOM_CUBIC_BEZIER": {
        if (!easing.easingFunctionCubicBezier) {
          throw new Error("CUSTOM_CUBIC_BEZIER easing is missing easingFunctionCubicBezier");
        }
        return bezierToCss(easing.easingFunctionCubicBezier);
      }
      case "GENTLE":
      case "QUICK":
      case "BOUNCY":
      case "SLOW":
      case "CUSTOM_SPRING":
        throw new Error(
          `${easing.type} is a spring easing \u2014 use sampleSpring()/springToCssLinear() instead of easingToCss()`
        );
      default:
        return bezierToCss(BEZIER_PRESETS[easing.type]);
    }
  }
  function physicalSpringToNormalized(spring) {
    const dampingRatio = spring.damping / (2 * Math.sqrt(spring.stiffness * spring.mass));
    return clamp(1 - dampingRatio, 0, 1);
  }
  function resolveSpringBounce(easing) {
    if (easing.type === "CUSTOM_SPRING") {
      if (!easing.easingFunctionSpring) {
        throw new Error("CUSTOM_SPRING easing is missing easingFunctionSpring");
      }
      return easing.easingFunctionSpring.bounce;
    }
    if (easing.type in NAMED_SPRING_BOUNCE) {
      return NAMED_SPRING_BOUNCE[easing.type];
    }
    throw new Error(`${easing.type} is not a spring easing`);
  }
  function springDerivative(state, dampingRatio, omega0) {
    return {
      d: state.v,
      v: -omega0 * omega0 * state.d - 2 * dampingRatio * omega0 * state.v
    };
  }
  function rk4Step(state, dt, dampingRatio, omega0) {
    const k1 = springDerivative(state, dampingRatio, omega0);
    const k2 = springDerivative({ d: state.d + dt / 2 * k1.d, v: state.v + dt / 2 * k1.v }, dampingRatio, omega0);
    const k3 = springDerivative({ d: state.d + dt / 2 * k2.d, v: state.v + dt / 2 * k2.v }, dampingRatio, omega0);
    const k4 = springDerivative({ d: state.d + dt * k3.d, v: state.v + dt * k3.v }, dampingRatio, omega0);
    return {
      d: state.d + dt / 6 * (k1.d + 2 * k2.d + 2 * k3.d + k4.d),
      v: state.v + dt / 6 * (k1.v + 2 * k2.v + 2 * k3.v + k4.v)
    };
  }
  var MIN_DAMPING_RATIO = 1e-3;
  var SETTLE_TOLERANCE = 4e-3;
  var MAX_SETTLE_TIME_SEC = 10;
  function findSettlingTimeSec(dampingRatio, omega0) {
    const period = 2 * Math.PI / omega0;
    const dt = Math.min(period / 100, 0.01);
    const maxSteps = Math.ceil(MAX_SETTLE_TIME_SEC / dt);
    let state = { d: -1, v: 0 };
    let lastUnsettledStep = 0;
    for (let step = 1; step <= maxSteps; step++) {
      state = rk4Step(state, dt, dampingRatio, omega0);
      if (Math.abs(state.d) > SETTLE_TOLERANCE) lastUnsettledStep = step;
    }
    return Math.min(lastUnsettledStep * dt, MAX_SETTLE_TIME_SEC);
  }
  var SAMPLE_COUNT = 80;
  function sampleSpring(bounce, angularFrequency = BASE_SPRING_ANGULAR_FREQUENCY) {
    const dampingRatio = clamp(1 - bounce, MIN_DAMPING_RATIO, 1);
    const settlingTimeSec = findSettlingTimeSec(dampingRatio, angularFrequency);
    if (settlingTimeSec <= 0) {
      return { points: Array(SAMPLE_COUNT).fill(1), settlingTimeMs: 0 };
    }
    const dt = settlingTimeSec / (SAMPLE_COUNT - 1);
    const points = [0];
    let state = { d: -1, v: 0 };
    for (let i = 1; i < SAMPLE_COUNT; i++) {
      state = rk4Step(state, dt, dampingRatio, angularFrequency);
      points.push(1 + state.d);
    }
    points[points.length - 1] = 1;
    return { points, settlingTimeMs: settlingTimeSec * 1e3 };
  }
  function springToCssLinear(bounce, angularFrequency) {
    const { points, settlingTimeMs } = sampleSpring(bounce, angularFrequency);
    return { easing: `linear(${points.map((p) => round3(p, 4)).join(", ")})`, durationMs: settlingTimeMs };
  }

  // src/targets/django/smart-animate/easing-adapter.ts
  function transitionToCssTiming(transition) {
    const { easing, duration } = transition;
    const durationMs = Math.round(duration * 1e3);
    switch (easing.type) {
      case "LINEAR":
        return { timingFunction: "linear", durationMs };
      case "CUSTOM_CUBIC_BEZIER": {
        if (!easing.easingFunctionCubicBezier) {
          throw new Error("CUSTOM_CUBIC_BEZIER easing is missing easingFunctionCubicBezier");
        }
        const { x1, y1, x2, y2 } = easing.easingFunctionCubicBezier;
        return { timingFunction: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`, durationMs };
      }
      case "CUSTOM_SPRING": {
        if (!easing.easingFunctionSpring) {
          throw new Error("CUSTOM_SPRING easing is missing easingFunctionSpring");
        }
        const bounce = physicalSpringToNormalized(easing.easingFunctionSpring);
        const sampled = springToCssLinear(bounce);
        return { timingFunction: sampled.easing, durationMs: sampled.durationMs };
      }
      case "GENTLE":
      case "QUICK":
      case "BOUNCY":
      case "SLOW": {
        const sampled = springToCssLinear(NAMED_SPRING_BOUNCE[easing.type]);
        return { timingFunction: sampled.easing, durationMs: sampled.durationMs };
      }
      default: {
        const bezier = BEZIER_PRESETS[easing.type];
        return { timingFunction: `cubic-bezier(${bezier.x1}, ${bezier.y1}, ${bezier.x2}, ${bezier.y2})`, durationMs };
      }
    }
  }

  // src/targets/django/assets.ts
  function rasterColorProfile(node) {
    var _a, _b;
    const profile = (_b = (_a = node.exportSettings) == null ? void 0 : _a[0]) == null ? void 0 : _b.colorProfile;
    return profile === "SRGB" || profile === "DISPLAY_P3_V4" ? profile : void 0;
  }
  var RASTER_FORMATS = [
    { format: "png", figmaFormat: "PNG" }
  ];
  var RASTER_SCALES = [1, 2];
  function slugify(name) {
    const slug2 = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
    return slug2 || "asset";
  }
  function idSegment(id) {
    return id.replace(/[^a-zA-Z0-9_-]+/g, "-");
  }
  function scaleSuffix(scale) {
    return scale === 1 ? "" : `@${scale}x`;
  }
  function rasterFilename(id, name, format, scale) {
    return `${idSegment(id)}-${slugify(name)}${scaleSuffix(scale)}.${format}`;
  }
  async function exportRasterAsset(node) {
    const assets = [];
    const colorProfile = rasterColorProfile(node);
    for (const { format, figmaFormat } of RASTER_FORMATS) {
      for (const scale of RASTER_SCALES) {
        const bytes = await node.exportAsync(__spreadValues({
          format: figmaFormat,
          constraint: { type: "SCALE", value: scale }
        }, colorProfile ? { colorProfile } : {}));
        assets.push({ filename: rasterFilename(node.id, node.name, format, scale), format, scale, bytes });
      }
    }
    return assets;
  }
  function bytesMatch(bytes, offset, signature) {
    return signature.every((byte, index) => bytes[offset + index] === byte);
  }
  function detectImageFillFormat(bytes) {
    if (bytesMatch(bytes, 0, [137, 80, 78, 71])) return "png";
    if (bytesMatch(bytes, 0, [255, 216, 255])) return "jpg";
    if (bytesMatch(bytes, 0, [71, 73, 70, 56])) return "gif";
    if (bytesMatch(bytes, 0, [82, 73, 70, 70]) && bytesMatch(bytes, 8, [87, 69, 66, 80])) return "webp";
    return "png";
  }
  function containerFillFilename(id, name, format, index = 0) {
    const suffix = index > 0 ? `-${index + 1}` : "";
    return `${idSegment(id)}-${slugify(name)}-fill${suffix}.${format}`;
  }
  function imageFillLeafFilename(id, name, format) {
    return `${idSegment(id)}-${slugify(name)}.${format}`;
  }
  var DEFAULT_VECTOR_INLINE_THRESHOLD_BYTES = 4096;
  function vectorFilename(id, name) {
    return `${idSegment(id)}-${slugify(name)}.svg`;
  }
  function videoFilename(id, name) {
    return `${idSegment(id)}-${slugify(name)}.mp4`;
  }
  function videoPosterFilename(id, name) {
    return `${idSegment(id)}-${slugify(name)}-poster.png`;
  }
  function maskFilename(id, name) {
    return `${idSegment(id)}-${slugify(name)}-mask.svg`;
  }
  function utf8ByteLength(text2) {
    var _a;
    let bytes = 0;
    for (const char of text2) {
      const codePoint = (_a = char.codePointAt(0)) != null ? _a : 0;
      if (codePoint <= 127) bytes += 1;
      else if (codePoint <= 2047) bytes += 2;
      else if (codePoint <= 65535) bytes += 3;
      else bytes += 4;
    }
    return bytes;
  }
  async function exportVectorAsset(node, inlineThresholdBytes = DEFAULT_VECTOR_INLINE_THRESHOLD_BYTES) {
    const svg = await node.exportAsync({ format: "SVG_STRING" });
    if (utf8ByteLength(svg) <= inlineThresholdBytes) return { kind: "inline", svg };
    return { kind: "file", filename: vectorFilename(node.id, node.name), svg };
  }
  var SETTING_EXTENSIONS = {
    PNG: "png",
    JPG: "jpg",
    SVG: "svg",
    PDF: "pdf",
    GIF: "gif",
    MP4: "mp4",
    WEBM: "webm"
  };
  function isVideoAssetPath(path) {
    return path.endsWith(".mp4") || path.endsWith(".webm");
  }
  function scaleModeToObjectFit(scaleMode) {
    switch (scaleMode) {
      case "FIT":
        return "contain";
      case "TILE":
        return "fill";
      case "CROP":
      case "FILL":
        return "cover";
      default:
        return "cover";
    }
  }
  function sanitizeSuffix(suffix) {
    return suffix.replace(/[^a-zA-Z0-9@_-]+/g, "-");
  }
  function designerAssetFilename(id, name, setting) {
    var _a;
    const ext = SETTING_EXTENSIONS[setting.format];
    if (!ext) return null;
    let suffix = setting.suffix ? sanitizeSuffix(setting.suffix) : "";
    if (!suffix && ((_a = setting.constraint) == null ? void 0 : _a.type) === "SCALE" && setting.constraint.value !== 1) {
      suffix = `@${setting.constraint.value}x`;
    }
    return `${idSegment(id)}-${slugify(name)}${suffix}.${ext}`;
  }
  function primaryDesignerSetting(settings) {
    var _a, _b, _c;
    const svg = settings.find((s) => s.format === "SVG");
    if (svg) return svg;
    const rasters = settings.filter((s) => s.format === "PNG" || s.format === "JPG");
    const oneX = rasters.find((s) => !s.constraint || s.constraint.type === "SCALE" && s.constraint.value === 1);
    const gif = settings.find((s) => s.format === "GIF");
    const video = settings.find((s) => s.format === "MP4" || s.format === "WEBM");
    return (_c = (_b = (_a = oneX != null ? oneX : rasters[0]) != null ? _a : gif) != null ? _b : video) != null ? _c : null;
  }
  function primaryDesignerAssetFilename(id, name, settings) {
    const primary = primaryDesignerSetting(settings);
    const filename = primary ? designerAssetFilename(id, name, primary) : null;
    return filename != null ? filename : rasterFilename(id, name, "png", 1);
  }
  async function exportDesignerAssets(node, settingsOverride) {
    var _a;
    const settings = (_a = settingsOverride != null ? settingsOverride : node.exportSettings) != null ? _a : [];
    const assets = [];
    const seen = /* @__PURE__ */ new Set();
    for (const setting of settings) {
      const filename = designerAssetFilename(node.id, node.name, setting);
      if (!filename) {
        console.warn(`[export] "${node.name}" (${node.id}): unrecognized export format ${setting.format} \u2014 skipped`);
        continue;
      }
      if (seen.has(filename)) continue;
      try {
        assets.push({ filename, content: await node.exportAsync(setting) });
        seen.add(filename);
      } catch (error) {
        console.warn(
          `[export] "${node.name}" (${node.id}): ${setting.format} export failed \u2014 skipped:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    if (primaryDesignerSetting(settings) === null) {
      const filename = primaryDesignerAssetFilename(node.id, node.name, settings);
      try {
        assets.push({ filename, content: await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } }) });
      } catch (error) {
        console.warn(
          `[export] "${node.name}" (${node.id}): fallback PNG export failed \u2014 skipped:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    return assets;
  }

  // src/targets/django/ir.ts
  function hasVideoFill(node) {
    return Array.isArray(node.fills) && node.fills.some((fill) => fill.type === "VIDEO" && fill.visible !== false);
  }
  function videoFill(node) {
    if (!Array.isArray(node.fills)) return null;
    const fill = node.fills.find((f) => f.type === "VIDEO" && f.visible !== false);
    return fill != null ? fill : null;
  }
  function hasMediaData(node) {
    var _a;
    return typeof node === "object" && node !== null && "mediaData" in node && typeof ((_a = node.mediaData) == null ? void 0 : _a.hash) === "string";
  }
  function imageFillHash(node) {
    var _a;
    if (!Array.isArray(node.fills)) return null;
    const imageFill = node.fills.find(
      (fill) => fill.type === "IMAGE" && fill.visible !== false
    );
    return (_a = imageFill == null ? void 0 : imageFill.imageHash) != null ? _a : null;
  }
  function imageFillRotation(node) {
    if (!Array.isArray(node.fills)) return void 0;
    const imageFill = node.fills.find(
      (fill) => fill.type === "IMAGE" && fill.visible !== false
    );
    const rotation = imageFill == null ? void 0 : imageFill.rotation;
    return rotation === 90 || rotation === 180 || rotation === 270 ? rotation : void 0;
  }
  function visibleImageFills(node) {
    if (!Array.isArray(node.fills)) return [];
    return node.fills.filter(
      (fill) => fill.type === "IMAGE" && fill.visible !== false && typeof fill.imageHash === "string"
    );
  }
  var imageFillFormatByHash = /* @__PURE__ */ new Map();
  function imageFillFormat(imageHash) {
    let format = imageFillFormatByHash.get(imageHash);
    if (!format) {
      format = (async () => {
        var _a;
        if (typeof figma === "undefined") return "png";
        try {
          const bytes = await ((_a = figma.getImageByHash(imageHash)) == null ? void 0 : _a.getBytesAsync());
          return bytes ? detectImageFillFormat(bytes) : "png";
        } catch (e) {
          return "png";
        }
      })();
      imageFillFormatByHash.set(imageHash, format);
    }
    return format;
  }
  async function containerBackgroundImage(node) {
    const vfill = videoFill(node);
    if (vfill && vfill.videoHash) {
      return {
        backgroundVideo: {
          videoHash: vfill.videoHash,
          assetSrc: `img/${videoFilename(node.id, node.name)}`,
          posterSrc: `img/${videoPosterFilename(node.id, node.name)}`,
          scaleMode: vfill.scaleMode
        }
      };
    }
    const imageFills = visibleImageFills(node);
    if (imageFills.length === 0) return {};
    const backgroundImages = await Promise.all(
      imageFills.map(async (fill, index) => {
        const format = await imageFillFormat(fill.imageHash);
        const assetSrc = `img/${containerFillFilename(node.id, node.name, format, index)}`;
        return { imageHash: fill.imageHash, assetSrc };
      })
    );
    return { backgroundImages };
  }
  function styleIdOf(node, key) {
    const value = node[key];
    return typeof value === "string" && value !== "" ? value : void 0;
  }
  async function resolveStyleId(styleId) {
    var _a;
    if (!styleId || typeof figma === "undefined") return void 0;
    try {
      const style = await figma.getStyleByIdAsync(styleId);
      return (_a = style == null ? void 0 : style.name) != null ? _a : void 0;
    } catch (e) {
      return void 0;
    }
  }
  async function readStyleRefs(node) {
    const [fillStyleName, strokeStyleName, effectStyleName, gridStyleName] = await Promise.all([
      resolveStyleId(styleIdOf(node, "fillStyleId")),
      resolveStyleId(styleIdOf(node, "strokeStyleId")),
      resolveStyleId(styleIdOf(node, "effectStyleId")),
      resolveStyleId(styleIdOf(node, "gridStyleId"))
    ]);
    const styleRefs = __spreadValues(__spreadValues(__spreadValues(__spreadValues({}, fillStyleName ? { fillStyleName } : {}), strokeStyleName ? { strokeStyleName } : {}), effectStyleName ? { effectStyleName } : {}), gridStyleName ? { gridStyleName } : {});
    return Object.keys(styleRefs).length > 0 ? { styleRefs } : {};
  }
  var JUSTIFY_CONTENT = {
    MIN: "flex-start",
    MAX: "flex-end",
    CENTER: "center",
    SPACE_BETWEEN: "space-between"
  };
  var ALIGN_ITEMS = {
    MIN: "flex-start",
    MAX: "flex-end",
    CENTER: "center",
    BASELINE: "baseline"
  };
  function normalizeGridTrack(track) {
    var _a, _b;
    if (track.type === "FIXED") return { type: "fixed", value: (_a = track.value) != null ? _a : 0 };
    if (track.type === "FLEX") return { type: "fr", value: (_b = track.value) != null ? _b : 1 };
    return { type: "hug" };
  }
  function clipFlag(node) {
    return node.clipsContent ? { clip: true } : {};
  }
  var OVERFLOW_DIRECTION = {
    HORIZONTAL: "x",
    VERTICAL: "y",
    BOTH: "both"
  };
  function overflowFlag(node) {
    if (!node.clipsContent) return {};
    const direction = node.overflowDirection;
    return direction && direction !== "NONE" ? { overflow: OVERFLOW_DIRECTION[direction] } : {};
  }
  var MEASURED_OVERFLOW_SLACK_PX = 8;
  function measuredOverflowFlag(node) {
    try {
      if (!node.clipsContent || !node.children) return {};
      const mode = node.layoutMode;
      if (mode !== "HORIZONTAL" && mode !== "VERTICAL") return {};
      if (node.primaryAxisSizingMode !== "FIXED") return {};
      const size = mode === "VERTICAL" ? node.height : node.width;
      if (typeof size !== "number") return {};
      let extent = 0;
      for (const child of node.children) {
        if (child.visible === false) continue;
        if ("layoutPositioning" in child && child.layoutPositioning === "ABSOLUTE") continue;
        const edge = mode === "VERTICAL" ? child.y + child.height : child.x + child.width;
        if (edge > extent) extent = edge;
      }
      if (extent > size + MEASURED_OVERFLOW_SLACK_PX) return { overflow: mode === "VERTICAL" ? "y" : "x" };
      return {};
    } catch (e) {
      return {};
    }
  }
  function flexLayout(al, node) {
    const wrap = al.layoutMode === "HORIZONTAL" && al.layoutWrap === "WRAP";
    const crossGap = wrap && al.counterAxisSpacing != null && al.counterAxisSpacing !== al.itemSpacing ? { crossGap: al.counterAxisSpacing } : {};
    const alignContent = wrap && al.counterAxisAlignContent === "SPACE_BETWEEN" ? { alignContent: "space-between" } : {};
    return __spreadValues(__spreadValues(__spreadValues(__spreadValues(__spreadValues(__spreadValues({
      kind: "flex",
      direction: al.layoutMode === "HORIZONTAL" ? "row" : "column",
      wrap,
      gap: al.itemSpacing,
      justifyContent: JUSTIFY_CONTENT[al.primaryAxisAlignItems],
      alignItems: ALIGN_ITEMS[al.counterAxisAlignItems],
      padding: {
        top: al.paddingTop,
        right: al.paddingRight,
        bottom: al.paddingBottom,
        left: al.paddingLeft
      }
    }, crossGap), alignContent), al.strokesIncludedInLayout ? { strokesIncludedInLayout: true } : {}), al.itemReverseZIndex ? { reverseZIndex: true } : {}), clipFlag(node)), overflowFlag(node).overflow ? overflowFlag(node) : measuredOverflowFlag(node));
  }
  function gridLayout(node) {
    return __spreadValues(__spreadValues(__spreadValues(__spreadValues({
      kind: "grid",
      columns: node.gridColumnSizes.map(normalizeGridTrack),
      rows: node.gridRowSizes.map(normalizeGridTrack),
      columnGap: node.gridColumnGap,
      rowGap: node.gridRowGap
    }, node.gridItemsPositioning === "ROW_AUTO_FLOW" ? { autoFlow: "row" } : {}), node.gridAutoTracks === "ROWS" ? { autoRows: true } : {}), clipFlag(node)), overflowFlag(node));
  }
  function readInferredAutoLayout(node) {
    var _a;
    try {
      return (_a = node.inferredAutoLayout) != null ? _a : null;
    } catch (e) {
      return null;
    }
  }
  function normalizeLayout(node) {
    if (node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL") {
      return { layout: flexLayout(node, node), warnings: [] };
    }
    if (node.layoutMode === "GRID") {
      return { layout: gridLayout(node), warnings: [] };
    }
    const inferred = readInferredAutoLayout(node);
    if (inferred && (inferred.layoutMode === "HORIZONTAL" || inferred.layoutMode === "VERTICAL")) {
      const direction = inferred.layoutMode === "HORIZONTAL" ? "row" : "column";
      return {
        layout: flexLayout(inferred, node),
        warnings: [`"${node.name}" has no Auto Layout \u2014 inferred a ${direction} flex layout from its children`]
      };
    }
    return {
      layout: __spreadValues(__spreadValues({ kind: "absolute" }, clipFlag(node)), overflowFlag(node)),
      warnings: [`"${node.name}" has no Auto Layout \u2014 children fall back to absolute positioning`]
    };
  }
  function groupLayout(node) {
    return {
      layout: { kind: "absolute" },
      warnings: [`"${node.name}" is a Group without Auto Layout \u2014 children fall back to absolute positioning`]
    };
  }
  function normalizeSize(sizing, value) {
    if (sizing === "HUG") return { mode: "hug" };
    if (sizing === "FILL") return { mode: "fill" };
    return { mode: "fixed", value };
  }
  function minMax(node) {
    const constraints = {
      minWidth: node.minWidth,
      maxWidth: node.maxWidth,
      minHeight: node.minHeight,
      maxHeight: node.maxHeight
    };
    const out = {};
    for (const [key, value] of Object.entries(constraints)) {
      if (typeof value === "number") out[key] = value;
    }
    return out;
  }
  function normalizeSizing(node) {
    return __spreadValues({
      width: normalizeSize(node.layoutSizingHorizontal, node.width),
      height: normalizeSize(node.layoutSizingVertical, node.height)
    }, minMax(node));
  }
  function isManualGridParent(node) {
    return node.layoutMode === "GRID" && node.gridItemsPositioning !== "ROW_AUTO_FLOW";
  }
  function normalizeGridPlacement(node, isGridChild) {
    if (!isGridChild) return null;
    return {
      rowStart: node.gridRowAnchorIndex,
      rowSpan: node.gridRowSpan,
      columnStart: node.gridColumnAnchorIndex,
      columnSpan: node.gridColumnSpan
    };
  }
  function stripPropertySuffix(name) {
    const index = name.lastIndexOf("#");
    return index === -1 ? name : name.slice(0, index);
  }
  function normalizeComponentPropertyReferences(refs) {
    if (!refs) return {};
    const result = {};
    if (refs.visible) result.visible = stripPropertySuffix(refs.visible);
    if (refs.characters) result.characters = stripPropertySuffix(refs.characters);
    if (refs.mainComponent) result.mainComponent = stripPropertySuffix(refs.mainComponent);
    return result;
  }
  var COMPONENT_PROPERTY_TYPES = /* @__PURE__ */ new Set(["BOOLEAN", "TEXT", "VARIANT", "INSTANCE_SWAP"]);
  function isSupportedComponentPropertyType(type) {
    return COMPONENT_PROPERTY_TYPES.has(type);
  }
  function readComponentPropertyDefinitions(node) {
    var _a;
    const parent = node.parent;
    const source = parent && parent.type === "COMPONENT_SET" ? parent : node;
    try {
      return { definitions: (_a = source.componentPropertyDefinitions) != null ? _a : {}, warning: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { definitions: {}, warning: `"${node.name}" component properties couldn't be read (${reason}) \u2014 treated as having none` };
    }
  }
  function normalizeComponentDef(node) {
    var _a;
    const properties = [];
    const { definitions, warning } = readComponentPropertyDefinitions(node);
    const warnings = warning ? [warning] : [];
    for (const [rawName, def] of Object.entries(definitions)) {
      if (!isSupportedComponentPropertyType(def.type)) {
        warnings.push(`"${node.name}" property "${stripPropertySuffix(rawName)}" has unsupported type ${def.type} \u2014 skipped`);
        continue;
      }
      properties.push({
        name: stripPropertySuffix(rawName),
        type: def.type,
        defaultValue: def.defaultValue,
        variantOptions: (_a = def.variantOptions) != null ? _a : null
      });
    }
    const setName = node.parent && node.parent.type === "COMPONENT_SET" ? node.parent.name : null;
    return { component: { key: node.key, properties, setName }, warnings };
  }
  function readComponentProperties(node) {
    try {
      return node.componentProperties;
    } catch (e) {
      return void 0;
    }
  }
  function readComponentPropertyReferences(node) {
    try {
      return node.componentPropertyReferences;
    } catch (e) {
      return null;
    }
  }
  function normalizeComponentProperties(properties) {
    const result = {};
    for (const [rawName, prop] of Object.entries(properties != null ? properties : {})) {
      if (!isSupportedComponentPropertyType(prop.type)) continue;
      const name = stripPropertySuffix(rawName);
      if (prop.type === "BOOLEAN") result[name] = { type: "BOOLEAN", value: Boolean(prop.value) };
      else result[name] = { type: prop.type, value: String(prop.value) };
    }
    return result;
  }
  var LAYOUT_ALIGN_SELF = {
    MIN: "flex-start",
    CENTER: "center",
    MAX: "flex-end"
  };
  function childLayoutOverrides(node) {
    const overrides = {};
    try {
      if (node.layoutPositioning === "ABSOLUTE") overrides.absoluteInLayout = true;
      const alignSelf = node.layoutAlign && LAYOUT_ALIGN_SELF[node.layoutAlign];
      if (alignSelf) overrides.alignSelf = alignSelf;
    } catch (e) {
    }
    return overrides;
  }
  var CONSTRAINT_TYPE = {
    MIN: "min",
    MAX: "max",
    CENTER: "center",
    STRETCH: "stretch",
    SCALE: "scale"
  };
  function readConstraints(node) {
    const constraints = node.constraints;
    if (!constraints) return void 0;
    return { horizontal: CONSTRAINT_TYPE[constraints.horizontal], vertical: CONSTRAINT_TYPE[constraints.vertical] };
  }
  function readAspectRatio(node) {
    const ratio = node.targetAspectRatio;
    return ratio ? { aspectRatio: { width: ratio.x, height: ratio.y } } : {};
  }
  var NAVIGATE_TRIGGERS = /* @__PURE__ */ new Set(["ON_CLICK", "MOUSE_UP"]);
  function readNavigateReaction(node) {
    var _a;
    let reactions;
    try {
      reactions = node.reactions;
    } catch (e) {
      return {};
    }
    for (const reaction of reactions != null ? reactions : []) {
      if (!reaction.trigger || !NAVIGATE_TRIGGERS.has(reaction.trigger.type)) continue;
      for (const action of (_a = reaction.actions) != null ? _a : []) {
        if (action.type !== "NODE" || action.navigation !== "NAVIGATE" || !action.destinationId) continue;
        return { navigate: __spreadValues({ destinationId: action.destinationId }, readNavigateTransition(action.transition)) };
      }
    }
    return {};
  }
  function readNavigateTransition(transition) {
    if (!transition) return {};
    try {
      const timing = transitionToCssTiming(transition);
      const direction = "direction" in transition ? { direction: transition.direction } : {};
      return { transition: __spreadProps(__spreadValues({ style: transition.type }, direction), { durationMs: timing.durationMs, timingFunction: timing.timingFunction }) };
    } catch (e) {
      return {};
    }
  }
  var INTERACTION_TRIGGERS = /* @__PURE__ */ new Set(["ON_HOVER", "ON_PRESS", "ON_CLICK", "MOUSE_UP"]);
  function readInteractions(node, sourceId) {
    var _a, _b;
    let reactions;
    try {
      reactions = node.reactions;
    } catch (e) {
      return {};
    }
    const interactions = [];
    for (const reaction of reactions != null ? reactions : []) {
      if (!reaction.trigger || !INTERACTION_TRIGGERS.has(reaction.trigger.type)) continue;
      const t = reaction.trigger.type;
      const trigger = t === "ON_HOVER" || t === "ON_PRESS" ? t : "ON_CLICK";
      for (const action of (_a = reaction.actions) != null ? _a : []) {
        if (action.type !== "NODE" || action.navigation !== "CHANGE_TO" || !action.destinationId) continue;
        const transition = (_b = action.transition) != null ? _b : { type: "DISSOLVE", easing: { type: "LINEAR" }, duration: 0 };
        const { timingFunction, durationMs } = transitionToCssTiming(
          transition
        );
        interactions.push(__spreadValues({ trigger, destinationId: action.destinationId, durationMs, timingFunction }, sourceId ? { sourceId } : {}));
      }
    }
    return interactions.length > 0 ? { interactions } : {};
  }
  async function readChainedPressInteraction(hover) {
    var _a, _b;
    try {
      const hoverVariant = await figma.getNodeByIdAsync(hover.destinationId);
      if (!hoverVariant || !("reactions" in hoverVariant)) return null;
      const chained = (_a = readInteractions(hoverVariant, hover.destinationId).interactions) != null ? _a : [];
      return (_b = chained.find((i) => i.trigger === "ON_PRESS")) != null ? _b : null;
    } catch (e) {
      return null;
    }
  }
  var OVERLAY_POSITION_TYPES = /* @__PURE__ */ new Set([
    "CENTER",
    "TOP_LEFT",
    "TOP_CENTER",
    "TOP_RIGHT",
    "BOTTOM_LEFT",
    "BOTTOM_CENTER",
    "BOTTOM_RIGHT",
    "MANUAL"
  ]);
  function readOverlays(node) {
    var _a, _b, _c;
    let reactions;
    try {
      reactions = node.reactions;
    } catch (e) {
      return {};
    }
    const overlays = [];
    for (const reaction of reactions != null ? reactions : []) {
      if (!reaction.trigger) continue;
      for (const action of (_a = reaction.actions) != null ? _a : []) {
        if (action.type !== "NODE" || action.navigation !== "OVERLAY" || !action.destinationId) continue;
        const positionType = OVERLAY_POSITION_TYPES.has((_b = action.overlayPositionType) != null ? _b : "") ? action.overlayPositionType : "CENTER";
        const rawBackground = action.overlayBackground;
        const background2 = rawBackground && rawBackground.type === "SOLID_COLOR" && rawBackground.color ? { type: "SOLID_COLOR", color: rawBackground.color } : { type: "NONE" };
        const closeInteraction = action.overlayBackgroundInteraction === "CLOSE_ON_CLICK_OUTSIDE" ? "CLOSE_ON_CLICK_OUTSIDE" : "NONE";
        const relativePosition = (_c = action.overlayRelativePosition) != null ? _c : null;
        overlays.push({
          trigger: reaction.trigger.type,
          destinationId: action.destinationId,
          relativePosition,
          positionType,
          background: background2,
          closeInteraction
        });
      }
    }
    return overlays.length > 0 ? { overlays } : {};
  }
  function baseProps(node, isGridChild) {
    const constraints = readConstraints(node);
    return __spreadValues(__spreadValues(__spreadValues(__spreadValues(__spreadValues(__spreadValues({
      id: node.id,
      name: node.name,
      position: { x: node.x, y: node.y },
      sizing: normalizeSizing(node),
      gridPlacement: normalizeGridPlacement(node, isGridChild),
      componentPropertyReferences: normalizeComponentPropertyReferences(readComponentPropertyReferences(node)),
      warnings: []
    }, constraints ? { constraints } : {}), childLayoutOverrides(node)), readAspectRatio(node)), readNavigateReaction(node)), readInteractions(node)), readOverlays(node));
  }
  function fixedChildrenCount(node) {
    return node.numberOfFixedChildren ? { fixedChildrenCount: node.numberOfFixedChildren } : {};
  }
  function isMaskNode(node) {
    return node.isMask === true;
  }
  function radiusNumber(value) {
    return typeof value === "number" ? value : 0;
  }
  function maskClipRadius(node) {
    const uniform = node.cornerRadius;
    if (typeof uniform === "number") return uniform > 0 ? uniform : void 0;
    const corners = node;
    const topLeft = radiusNumber(corners.topLeftRadius);
    const topRight = radiusNumber(corners.topRightRadius);
    const bottomRight = radiusNumber(corners.bottomRightRadius);
    const bottomLeft = radiusNumber(corners.bottomLeftRadius);
    if (!topLeft && !topRight && !bottomRight && !bottomLeft) return void 0;
    return { topLeft, topRight, bottomRight, bottomLeft };
  }
  function maskDescriptor(node) {
    if (node.type === "RECTANGLE") return __spreadValues({ kind: "clip", shape: "rect" }, maskClipRadius(node) != null ? { radius: maskClipRadius(node) } : {});
    if (node.type === "ELLIPSE") return { kind: "clip", shape: "ellipse" };
    const mode = node.maskType === "LUMINANCE" ? "luminance" : "alpha";
    return { kind: "image", mode, nodeId: node.id, assetSrc: `img/${maskFilename(node.id, node.name)}` };
  }
  function offsetChildren(children, dx, dy) {
    if (!dx && !dy) return children;
    return children.map((child) => __spreadProps(__spreadValues({}, child), { position: { x: child.position.x - dx, y: child.position.y - dy } }));
  }
  function buildMaskWrapper(maskLive, maskIr, masked) {
    if (masked.length === 0) return null;
    const mask = maskDescriptor(maskLive);
    return __spreadProps(__spreadValues({
      id: `${maskLive.id}--mask`,
      name: maskIr.name,
      position: maskIr.position,
      sizing: maskIr.sizing,
      gridPlacement: null,
      componentPropertyReferences: {},
      warnings: []
    }, maskIr.constraints ? { constraints: maskIr.constraints } : {}), {
      type: "container",
      // A geometric clip hides overflow; a mask-image already bounds the paint, so no extra clip.
      layout: mask.kind === "clip" ? { kind: "absolute", clip: true } : { kind: "absolute" },
      component: null,
      mask,
      children: offsetChildren(masked, maskIr.position.x, maskIr.position.y)
    });
  }
  function groupMasks(children) {
    const out = [];
    let i = 0;
    while (i < children.length) {
      const { live, ir } = children[i];
      if (!isMaskNode(live)) {
        out.push(ir);
        i++;
        continue;
      }
      let j = i + 1;
      const masked = [];
      while (j < children.length && !isMaskNode(children[j].live)) {
        masked.push(children[j].ir);
        j++;
      }
      const wrapper = buildMaskWrapper(live, ir, masked);
      if (wrapper) out.push(wrapper);
      i = j;
    }
    return out;
  }
  async function serializeChildren(node, isGridParent) {
    const serialized = await Promise.all(
      node.children.map(async (child) => {
        const ir = await serializeNode(child, isGridParent);
        return ir ? { live: child, ir } : null;
      })
    );
    return groupMasks(serialized.filter((child) => child !== null));
  }
  async function serializeFrame(node, isGridChild = false) {
    const { layout, warnings } = normalizeLayout(node);
    return __spreadProps(__spreadValues(__spreadValues(__spreadValues(__spreadValues({}, baseProps(node, isGridChild)), await containerBackgroundImage(node)), await readStyleRefs(node)), fixedChildrenCount(node)), {
      type: "container",
      layout,
      component: null,
      warnings,
      children: await serializeChildren(node, isManualGridParent(node))
    });
  }
  async function serializeGroup(node, isGridChild = false) {
    const { layout, warnings } = groupLayout(node);
    return __spreadProps(__spreadValues(__spreadValues(__spreadValues({}, baseProps(node, isGridChild)), await containerBackgroundImage(node)), await readStyleRefs(node)), {
      type: "container",
      layout,
      component: null,
      warnings,
      children: offsetChildren(await serializeChildren(node, false), node.x, node.y)
    });
  }
  var TEXT_ALIGN = {
    CENTER: "center",
    RIGHT: "right",
    JUSTIFIED: "justify"
  };
  var TEXT_ALIGN_VERTICAL = {
    CENTER: "center",
    BOTTOM: "flex-end"
  };
  function mixedOrNumber(value) {
    return typeof value === "number" ? value : void 0;
  }
  function textTruncate(node) {
    if (node.textTruncation !== "ENDING") return {};
    const maxLines = typeof node.maxLines === "number" ? node.maxLines : null;
    return { truncate: { maxLines } };
  }
  async function serializeText(node, isGridChild = false) {
    const textAlign = TEXT_ALIGN[node.textAlignHorizontal];
    const textAlignVertical = TEXT_ALIGN_VERTICAL[node.textAlignVertical];
    const paragraphSpacing = mixedOrNumber(node.paragraphSpacing);
    const paragraphIndent = mixedOrNumber(node.paragraphIndent);
    const listSpacing = mixedOrNumber(node.listSpacing);
    return __spreadValues(__spreadValues(__spreadValues(__spreadValues(__spreadValues(__spreadValues(__spreadValues(__spreadValues(__spreadValues(__spreadValues(__spreadValues(__spreadProps(__spreadValues(__spreadValues({}, baseProps(node, isGridChild)), await readStyleRefs(node)), {
      type: "text",
      characters: node.characters
    }), textAlign ? { textAlign } : {}), textAlignVertical ? { textAlignVertical } : {}), textTruncate(node)), node.textAutoResize === "WIDTH_AND_HEIGHT" ? { noWrap: true } : {}), node.textAutoResize && node.textAutoResize !== "NONE" ? { autoResize: true } : {}), paragraphSpacing ? { paragraphSpacing } : {}), paragraphIndent ? { paragraphIndent } : {}), listSpacing ? { listSpacing } : {}), node.leadingTrim === "CAP_HEIGHT" ? { leadingTrim: "CAP_HEIGHT" } : {}), node.hangingPunctuation ? { hangingPunctuation: true } : {}), node.hangingList ? { hangingList: true } : {});
  }
  function firstSolidCss(paints) {
    if (!Array.isArray(paints)) return void 0;
    const solid4 = paints.find((p) => (p == null ? void 0 : p.type) === "SOLID" && p.visible !== false);
    if (!(solid4 == null ? void 0 : solid4.color)) return void 0;
    return rgbaToCss(solid4.opacity != null && solid4.opacity < 1 ? __spreadProps(__spreadValues({}, solid4.color), { a: solid4.opacity }) : solid4.color);
  }
  function arcStrokeAttrs(node) {
    const stroke = firstSolidCss(node.strokes);
    if (!stroke) return "";
    const weight = node.strokeWeight;
    const width = typeof weight === "number" ? weight : 1;
    return ` stroke="${stroke}" stroke-width="${width}"`;
  }
  function arcInlineSvg(node) {
    var _a;
    if (node.type !== "ELLIPSE") return void 0;
    const arc = node.arcData;
    if (!arc || isDefaultArc(arc)) return void 0;
    const width = Math.round(node.width * 100) / 100;
    const height = Math.round(node.height * 100) / 100;
    const d = ellipseArcPath(arc, node.width, node.height);
    const fill = (_a = firstSolidCss(node.fills)) != null ? _a : "currentColor";
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="${fill}"${arcStrokeAttrs(node)}/></svg>`;
  }
  async function serializeShape(node, isGridChild) {
    const base = __spreadValues(__spreadValues({}, baseProps(node, isGridChild)), await readStyleRefs(node));
    const filled = node;
    if (hasVideoFill(filled)) {
      const vfill = videoFill(filled);
      return __spreadProps(__spreadValues({}, base), {
        type: "image",
        imageHash: null,
        assetSrc: `img/${videoFilename(node.id, node.name)}`,
        posterSrc: `img/${videoPosterFilename(node.id, node.name)}`,
        videoScaleMode: vfill == null ? void 0 : vfill.scaleMode
      });
    }
    if (hasMediaData(node)) {
      return __spreadProps(__spreadValues({}, base), {
        type: "image",
        imageHash: null,
        assetSrc: `img/${videoFilename(node.id, node.name)}`,
        posterSrc: `img/${videoPosterFilename(node.id, node.name)}`
      });
    }
    const forceSvg = needsSvg(node);
    const imageHash = imageFillHash(filled);
    if (imageHash !== null && !forceSvg) {
      const imageRotation = imageFillRotation(filled);
      const format = await imageFillFormat(imageHash);
      const assetSrc = format === "png" ? `img/${rasterFilename(node.id, node.name, "png", 1)}` : `img/${imageFillLeafFilename(node.id, node.name, format)}`;
      return __spreadValues(__spreadProps(__spreadValues({}, base), {
        type: "image",
        imageHash,
        assetSrc
      }), imageRotation ? { imageRotation } : {});
    }
    const arc = arcInlineSvg(node);
    return __spreadValues(__spreadProps(__spreadValues({}, base), { type: "vector" }), arc ? { inlineSvg: arc } : {});
  }
  async function serializeGenericContainer(node, isGridChild) {
    const hasAutoLayout = "layoutMode" in node;
    const { layout, warnings } = hasAutoLayout ? normalizeLayout(node) : { layout: { kind: "absolute" }, warnings: [] };
    return __spreadProps(__spreadValues(__spreadValues(__spreadValues({}, baseProps(node, isGridChild)), await containerBackgroundImage(node)), await readStyleRefs(node)), {
      type: "container",
      layout,
      component: null,
      warnings,
      children: await serializeChildren(node, isManualGridParent(node))
    });
  }
  async function serializeComponent(node, isGridChild = false) {
    const { layout, warnings: layoutWarnings } = normalizeLayout(node);
    const { component, warnings: componentWarnings } = normalizeComponentDef(node);
    return __spreadProps(__spreadValues(__spreadValues(__spreadValues(__spreadValues({}, baseProps(node, isGridChild)), await containerBackgroundImage(node)), await readStyleRefs(node)), fixedChildrenCount(node)), {
      type: "container",
      layout,
      component,
      warnings: [...layoutWarnings, ...componentWarnings],
      children: await serializeChildren(node, isManualGridParent(node))
    });
  }
  async function serializeInstance(node, isGridChild = false) {
    var _a, _b, _c, _d, _e, _f, _g;
    const mainComponent = await node.getMainComponentAsync();
    let componentSetName = null;
    try {
      componentSetName = mainComponent ? ((_a = mainComponent.parent) == null ? void 0 : _a.type) === "COMPONENT_SET" ? mainComponent.parent.name : mainComponent.name : null;
    } catch (e) {
      componentSetName = (_b = mainComponent == null ? void 0 : mainComponent.name) != null ? _b : null;
    }
    const { layout, warnings } = normalizeLayout(node);
    const ownReactions = __spreadValues(__spreadValues(__spreadValues({}, readNavigateReaction(node)), readInteractions(node, mainComponent == null ? void 0 : mainComponent.id)), readOverlays(node));
    const inheritedReactions = mainComponent ? __spreadValues(__spreadValues(__spreadValues({}, readNavigateReaction(mainComponent)), readInteractions(mainComponent, mainComponent.id)), readOverlays(mainComponent)) : {};
    const navigate = (_c = ownReactions.navigate) != null ? _c : inheritedReactions.navigate;
    const overlays = (_d = ownReactions.overlays) != null ? _d : inheritedReactions.overlays;
    let interactions = (_e = ownReactions.interactions) != null ? _e : inheritedReactions.interactions;
    if (interactions && !interactions.some((i) => i.trigger === "ON_PRESS")) {
      const hover = interactions.find((i) => i.trigger === "ON_HOVER");
      const press = hover ? await readChainedPressInteraction(hover) : null;
      if (press) interactions = [...interactions, press];
    }
    const reactions = __spreadValues(__spreadValues(__spreadValues({}, navigate ? { navigate } : {}), interactions ? { interactions } : {}), overlays ? { overlays } : {});
    return __spreadProps(__spreadValues(__spreadValues(__spreadValues(__spreadValues(__spreadValues({}, baseProps(node, isGridChild)), await containerBackgroundImage(node)), await readStyleRefs(node)), fixedChildrenCount(node)), reactions), {
      type: "instance-ref",
      layout,
      warnings,
      componentId: (_f = mainComponent == null ? void 0 : mainComponent.id) != null ? _f : null,
      componentKey: (_g = mainComponent == null ? void 0 : mainComponent.key) != null ? _g : null,
      componentSetName,
      componentProperties: normalizeComponentProperties(readComponentProperties(node)),
      children: await serializeChildren(node, isManualGridParent(node))
    });
  }
  async function serializeExportedGraphic(node, isGridChild, settingsOverride) {
    var _a, _b;
    const base = __spreadValues(__spreadValues({}, baseProps(node, isGridChild)), await readStyleRefs(node));
    const settings = settingsOverride != null ? settingsOverride : (_a = node.exportSettings) != null ? _a : [];
    const assetSrc = `img/${primaryDesignerAssetFilename(node.id, node.name, settings)}`;
    if (((_b = primaryDesignerSetting(settings)) == null ? void 0 : _b.format) === "SVG") {
      return __spreadProps(__spreadValues({}, base), { type: "vector", assetSrc });
    }
    return __spreadProps(__spreadValues({}, base), { type: "image", imageHash: null, assetSrc });
  }
  var SHAPE_TYPES = /* @__PURE__ */ new Set([
    "RECTANGLE",
    "ELLIPSE",
    "POLYGON",
    "STAR",
    "LINE",
    "VECTOR",
    "BOOLEAN_OPERATION",
    "TEXT_PATH",
    // FigJam decoration leaves — never appear in a design file, but render as graphics if they do.
    "STAMP",
    "HIGHLIGHT",
    "WASHI_TAPE",
    "MEDIA",
    // FigJam content nodes + connector (docs/1TO1-FIDELITY.md M6). The docs make richer HTML
    // achievable for some (semantic <table>, <pre><code>, link/embed cards) but a graphic export —
    // exportAsync captures the rendered node, connector line and label included — is the honest
    // minimum bar: none of these is ever dropped. Routed here (ahead of the `children`/`fills`
    // fallbacks) so a `cellAt`-based TABLE or a fill-less CODE_BLOCK/CONNECTOR still serializes.
    "STICKY",
    "SHAPE_WITH_TEXT",
    "CODE_BLOCK",
    "TABLE",
    "TABLE_CELL",
    "EMBED",
    "LINK_UNFURL",
    "CONNECTOR"
  ]);
  async function serializeNode(node, isGridChild = false) {
    if (node.removed) return null;
    if (node.visible === false) return null;
    const exportSettings = await resolveExportSettings(node);
    if (exportSettings.length > 0 && !hasVideoFill(node)) {
      return serializeExportedGraphic(node, isGridChild, exportSettings);
    }
    switch (node.type) {
      case "FRAME":
        return serializeFrame(node, isGridChild);
      case "COMPONENT":
        return serializeComponent(node, isGridChild);
      case "INSTANCE":
        return serializeInstance(node, isGridChild);
      case "TEXT":
        return serializeText(node, isGridChild);
      case "GROUP":
      case "TRANSFORM_GROUP":
        return serializeGroup(node, isGridChild);
      case "SLICE":
        return null;
    }
    if (SHAPE_TYPES.has(node.type)) return serializeShape(node, isGridChild);
    if ("children" in node) return serializeGenericContainer(node, isGridChild);
    if ("fills" in node) return serializeShape(node, isGridChild);
    console.warn(`[ir] node type ${node.type} ("${node.name}") has no visual representation \u2014 skipped`);
    return null;
  }

  // src/targets/django/text-styles.ts
  var TEXT_SEGMENT_FIELDS = [
    "fontName",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "textCase",
    "textDecoration",
    "textDecorationStyle",
    "textDecorationOffset",
    "textDecorationThickness",
    "textDecorationColor",
    "textDecorationSkipInk",
    "openTypeFeatures",
    "hyperlink",
    "listOptions",
    "indentation"
  ];
  function segmentClassName(baseClassName, index) {
    return `${baseClassName}--segment-${index}`;
  }
  function lineHeightToCss(lineHeight) {
    if (lineHeight.unit === "AUTO") return "normal";
    if (lineHeight.unit === "PERCENT") return `${lineHeight.value}%`;
    return `${lineHeight.value}px`;
  }
  function letterSpacingToCss(letterSpacing) {
    if (letterSpacing.unit === "PERCENT") return `${letterSpacing.value / 100}em`;
    return `${letterSpacing.value}px`;
  }
  function isItalic(style) {
    return /italic/i.test(style);
  }
  function textCaseDeclarations(textCase) {
    switch (textCase) {
      case "UPPER":
        return ["text-transform: uppercase;"];
      case "LOWER":
        return ["text-transform: lowercase;"];
      case "TITLE":
        return ["text-transform: capitalize;"];
      case "SMALL_CAPS":
        return ["font-variant: small-caps;"];
      case "SMALL_CAPS_FORCED":
        return ["font-variant: small-caps;", "text-transform: uppercase;"];
      default:
        return [];
    }
  }
  function textDecorationCss(decoration) {
    if (decoration === "UNDERLINE") return "underline";
    if (decoration === "STRIKETHROUGH") return "line-through";
    return null;
  }
  var DECORATION_STYLE_CSS = { SOLID: "solid", WAVY: "wavy", DOTTED: "dotted" };
  function decorationMetricCss(metric) {
    if (!metric || metric.unit === "AUTO") return null;
    return metric.unit === "PERCENT" ? `${metric.value}%` : `${metric.value}px`;
  }
  function decorationColorCss(decorationColor) {
    if (!decorationColor || decorationColor.value === "AUTO") return null;
    const { color, opacity } = decorationColor.value;
    return rgbaToCss(opacity === void 0 ? color : __spreadProps(__spreadValues({}, color), { a: opacity }));
  }
  function openTypeFeatureSettingsCss(features) {
    if (!features) return null;
    const tags = Object.keys(features).sort();
    if (tags.length === 0) return null;
    return tags.map((tag) => `"${tag.toLowerCase()}" ${features[tag] ? 1 : 0}`).join(", ");
  }
  function genericFamilyFor(family) {
    if (/mono|code|courier/i.test(family)) return "monospace";
    if (/serif(?!\s*sans)|georgia|garamond|times/i.test(family) && !/sans/i.test(family)) return "serif";
    return "sans-serif";
  }
  function segmentToDeclarations(segment, overrides = {}) {
    const declarations = [
      `font-family: "${segment.fontName.family}", ${genericFamilyFor(segment.fontName.family)};`,
      `font-weight: ${segment.fontWeight};`,
      `font-style: ${isItalic(segment.fontName.style) ? "italic" : "normal"};`,
      `font-size: ${segment.fontSize}px;`,
      `line-height: ${lineHeightToCss(segment.lineHeight)};`,
      `letter-spacing: ${letterSpacingToCss(segment.letterSpacing)};`,
      ...textCaseDeclarations(segment.textCase)
    ];
    const decoration = textDecorationCss(segment.textDecoration);
    if (decoration) {
      declarations.push(`text-decoration: ${decoration};`);
      const style = segment.textDecorationStyle && DECORATION_STYLE_CSS[segment.textDecorationStyle];
      if (style) declarations.push(`text-decoration-style: ${style};`);
      const decorationColor = decorationColorCss(segment.textDecorationColor);
      if (decorationColor) declarations.push(`text-decoration-color: ${decorationColor};`);
      const offset = decorationMetricCss(segment.textDecorationOffset);
      if (offset) declarations.push(`text-underline-offset: ${offset};`);
      const thickness = decorationMetricCss(segment.textDecorationThickness);
      if (thickness) declarations.push(`text-decoration-thickness: ${thickness};`);
      if (segment.textDecorationSkipInk === true) declarations.push("text-decoration-skip-ink: auto;");
      else if (segment.textDecorationSkipInk === false) declarations.push("text-decoration-skip-ink: none;");
    }
    const featureSettings = openTypeFeatureSettingsCss(segment.openTypeFeatures);
    if (featureSettings) declarations.push(`font-feature-settings: ${featureSettings};`);
    if (overrides.leadingTrim === "CAP_HEIGHT") {
      declarations.push("text-box-trim: trim-both;", "text-box-edge: cap alphabetic;");
    }
    if (overrides.hangingPunctuation || overrides.hangingList) {
      declarations.push("hanging-punctuation: first last;");
    }
    if (overrides.color) declarations.push(`color: ${overrides.color};`);
    return declarations;
  }
  function segmentsToCss(baseClassName, segments, overrides = {}) {
    return segments.map((segment, index) => {
      const body = segmentToDeclarations(segment, overrides).map((declaration) => `  ${declaration}`).join("\n");
      return `.${segmentClassName(baseClassName, index)} {
${body}
}`;
    });
  }
  function splitTextParagraphs(segments) {
    const paragraphs = [
      { runs: [], listType: "NONE", listDepth: 0 }
    ];
    segments.forEach((segment, index) => {
      const parts = segment.characters.split("\n");
      parts.forEach((part, partIndex) => {
        var _a, _b, _c;
        if (partIndex > 0) paragraphs.push({ runs: [], listType: "NONE", listDepth: 0 });
        if (part.length === 0) return;
        const current = paragraphs[paragraphs.length - 1];
        current.listType = (_b = (_a = segment.listOptions) == null ? void 0 : _a.type) != null ? _b : "NONE";
        current.listDepth = (_c = segment.indentation) != null ? _c : 0;
        current.runs.push({ segment: __spreadProps(__spreadValues({}, segment), { characters: part }), index });
      });
    });
    return paragraphs;
  }
  function isMultiBlockText(paragraphs) {
    return paragraphs.length > 1 || paragraphs.some((paragraph) => paragraph.listType !== "NONE");
  }

  // src/targets/django/bootstrap/theme.ts
  var ROLE_PROP_NAMES = /* @__PURE__ */ new Set(["variant", "type", "style", "color", "kind"]);
  var SIZE_PROP_NAMES2 = /* @__PURE__ */ new Set(["size"]);
  var STATE_PROP_NAMES = /* @__PURE__ */ new Set(["state"]);
  function parseVariantName(name) {
    const props = /* @__PURE__ */ new Map();
    for (const segment of name.split(",")) {
      const [rawKey, rawValue] = segment.split("=");
      if (rawValue === void 0) {
        const value = rawKey.trim().toLowerCase();
        if (value) props.set("variant", value);
        continue;
      }
      props.set(rawKey.trim().toLowerCase(), rawValue.trim().toLowerCase());
    }
    return props;
  }
  function findProp2(props, names) {
    for (const [key, value] of props) if (names.has(key)) return value;
    return null;
  }
  function normalizeState(state) {
    if (state === null) return "base";
    if (["default", "standart", "standard", "rest", "enabled", "base", "normal"].includes(state)) return "base";
    if (state === "hover") return "hover";
    if (["press", "pressed", "active", "click"].includes(state)) return "active";
    return null;
  }
  function normalizeSize2(size) {
    if (size === null) return "md";
    if (["sm", "small"].includes(size)) return "sm";
    if (["md", "medium", "meduim", "default", "regular"].includes(size)) return "md";
    if (["lg", "large"].includes(size)) return "lg";
    return null;
  }
  function parsePadding(padding) {
    var _a;
    if (!padding) return null;
    const parts = padding.trim().split(/\s+/);
    if (parts.length === 0) return null;
    return { y: parts[0], x: (_a = parts[1]) != null ? _a : parts[0] };
  }
  function parseBorderColor(border) {
    if (!border) return null;
    const match = border.match(/^\s*\S+\s+\S+\s+(.+)$/);
    return match ? match[1].trim() : null;
  }
  function background(css) {
    var _a, _b;
    return (_b = (_a = css["background"]) != null ? _a : css["background-color"]) != null ? _b : null;
  }
  function buttonStateValues(variant2) {
    var _a, _b, _c, _d;
    return {
      color: (_b = (_a = variant2.labelCss) == null ? void 0 : _a["color"]) != null ? _b : null,
      bg: background(variant2.css),
      borderColor: (_d = (_c = parseBorderColor(variant2.css["border"])) != null ? _c : variant2.css["border-color"]) != null ? _d : null
    };
  }
  function declBlock(selector, decls) {
    const lines = [...decls].map(([prop, value]) => `  ${prop}: ${value};`);
    return `${selector} {
${lines.join("\n")}
}`;
  }
  function buildButtonTheme(set) {
    var _a, _b, _c, _d;
    const rows = [];
    for (const variant2 of set.variants) {
      const props = parseVariantName(variant2.name);
      const role = findProp2(props, ROLE_PROP_NAMES);
      const size = normalizeSize2(findProp2(props, SIZE_PROP_NAMES2));
      const state = normalizeState(findProp2(props, STATE_PROP_NAMES));
      if (!role || !size || !state) continue;
      rows.push({ role, size, state, variant: variant2 });
    }
    if (rows.length === 0) return [];
    const rules = [];
    rules.push("/* un-layered consumer \u2014 btn-group/input-group corner-zeroing must not cut the design's corners */\n.btn {\n  border-radius: var(--bs-btn-border-radius);\n}");
    const sizeSelector = { md: ".btn", sm: ".btn-sm", lg: ".btn-lg" };
    for (const size of ["md", "sm", "lg"]) {
      const row = rows.find((r) => r.size === size && r.state === "base");
      if (!row) continue;
      const decls = /* @__PURE__ */ new Map();
      const padding = parsePadding(row.variant.css["padding"]);
      if (padding) {
        decls.set("--bs-btn-padding-y", padding.y);
        decls.set("--bs-btn-padding-x", padding.x);
      }
      const fontSize = (_a = row.variant.labelCss) == null ? void 0 : _a["font-size"];
      if (fontSize) decls.set("--bs-btn-font-size", fontSize);
      const fontWeight = (_b = row.variant.labelCss) == null ? void 0 : _b["font-weight"];
      if (fontWeight) decls.set("--bs-btn-font-weight", fontWeight);
      const radius = row.variant.css["border-radius"];
      if (radius) decls.set("--bs-btn-border-radius", radius);
      if (decls.size > 0) rules.push(declBlock(sizeSelector[size], decls));
    }
    const roleOrder = [...new Set(rows.map((r) => r.role))];
    for (const role of roleOrder) {
      const pick = (state) => {
        var _a2, _b2, _c2;
        return (_c2 = (_b2 = (_a2 = rows.find((r) => r.role === role && r.state === state && r.size === "md")) != null ? _a2 : rows.find((r) => r.role === role && r.state === state)) == null ? void 0 : _b2.variant) != null ? _c2 : null;
      };
      const baseVariant = pick("base");
      if (!baseVariant) continue;
      const base = buttonStateValues(baseVariant);
      const hover = pick("hover") ? buttonStateValues(pick("hover")) : base;
      const active = pick("active") ? buttonStateValues(pick("active")) : base;
      const decls = /* @__PURE__ */ new Map();
      const put = (name, value, fallback = null) => {
        const resolved = value != null ? value : fallback;
        if (resolved) decls.set(name, resolved);
      };
      put("--bs-btn-color", base.color);
      put("--bs-btn-bg", base.bg);
      put("--bs-btn-border-color", base.borderColor, "transparent");
      put("--bs-btn-hover-color", hover.color, base.color);
      put("--bs-btn-hover-bg", hover.bg, base.bg);
      put("--bs-btn-hover-border-color", hover.borderColor, (_c = base.borderColor) != null ? _c : "transparent");
      put("--bs-btn-active-color", active.color, base.color);
      put("--bs-btn-active-bg", active.bg, base.bg);
      put("--bs-btn-active-border-color", active.borderColor, (_d = base.borderColor) != null ? _d : "transparent");
      if (decls.size > 0) rules.push(declBlock(`.btn-${role}`, decls));
    }
    return rules;
  }
  var KIND_BUILDERS = {
    button: buildButtonTheme
  };
  function instanceAxisValues(props) {
    let role = null;
    let size = null;
    for (const [name, prop] of Object.entries(props)) {
      if (prop.type !== "VARIANT" || typeof prop.value !== "string") continue;
      const key = name.trim().toLowerCase();
      if (ROLE_PROP_NAMES.has(key)) role = prop.value.trim().toLowerCase();
      if (SIZE_PROP_NAMES2.has(key)) size = prop.value.trim().toLowerCase();
    }
    return { role, size: normalizeSize2(size) };
  }
  function collectThemedInstanceMasters(nodes, sets) {
    const parsedBySet = /* @__PURE__ */ new Map();
    for (const set of sets) {
      if (set.kind !== "button") continue;
      const rows = [];
      for (const variant2 of set.variants) {
        const props = parseVariantName(variant2.name);
        const role = findProp2(props, ROLE_PROP_NAMES);
        const size = normalizeSize2(findProp2(props, SIZE_PROP_NAMES2));
        const state = normalizeState(findProp2(props, STATE_PROP_NAMES));
        if (!role || !size || state !== "base") continue;
        rows.push({ role, size, css: variant2.css });
      }
      if (rows.length > 0) parsedBySet.set(set.setName.trim().toLowerCase(), rows);
    }
    if (parsedBySet.size === 0) return /* @__PURE__ */ new Map();
    const masters = /* @__PURE__ */ new Map();
    const visit = (node) => {
      var _a, _b, _c;
      if (node.type === "instance-ref" && node.componentSetName) {
        const rows = parsedBySet.get(node.componentSetName.trim().toLowerCase());
        if (rows) {
          const { role, size } = instanceAxisValues((_a = node.componentProperties) != null ? _a : {});
          const roles = new Set(rows.map((row) => row.role));
          const resolvedRole = role != null ? role : roles.size === 1 ? [...roles][0] : null;
          if (resolvedRole) {
            const match = (_b = rows.find((row) => row.role === resolvedRole && row.size === (size != null ? size : "md"))) != null ? _b : rows.find((row) => row.role === resolvedRole);
            if (match) masters.set(node.id, match.css);
          }
        }
      }
      for (const child of (_c = node.children) != null ? _c : []) visit(child);
    };
    for (const node of nodes) visit(node);
    return masters;
  }
  function isVarSafeBackground(value) {
    return !/gradient\(|url\(/.test(value);
  }
  function normalizeValue(value) {
    if (value === void 0 || value === null) return null;
    let v = value.trim().toLowerCase().replace(/\s+/g, " ");
    for (let i = 0; i < 3 && v.includes("var("); i += 1) {
      v = v.replace(/var\(--[^,()]+,\s*([^()]*(?:\([^()]*\))?[^()]*)\)/g, "$1").trim();
    }
    return v;
  }
  function sameValue(a, b) {
    return normalizeValue(a) === normalizeValue(b);
  }
  function sameRadius(a, b) {
    const collapse2 = (value) => {
      if (value === null) return null;
      const parts = value.split(" ");
      return parts.every((part) => part === parts[0]) ? parts[0] : value;
    };
    return collapse2(normalizeValue(a)) === collapse2(normalizeValue(b));
  }
  function samePadding(a, b) {
    var _a, _b;
    const pa = parsePadding((_a = normalizeValue(a)) != null ? _a : void 0);
    const pb = parsePadding((_b = normalizeValue(b)) != null ? _b : void 0);
    if (pa === null || pb === null) return pa === pb;
    return pa.y === pb.y && pa.x === pb.x;
  }
  function themeButtonInstanceDecl(decl, masterCss) {
    var _a, _b, _c;
    const master = (property) => masterCss[property];
    const background2 = (_a = decl["background"]) != null ? _a : decl["background-color"];
    if (background2 !== void 0 && isVarSafeBackground(background2)) {
      delete decl["background"];
      delete decl["background-color"];
      if (!sameValue(background2, (_b = master("background")) != null ? _b : master("background-color"))) {
        decl["--bs-btn-bg"] = background2;
        decl["--bs-btn-hover-bg"] = background2;
        decl["--bs-btn-active-bg"] = background2;
      }
    }
    const radius = decl["border-radius"];
    if (radius !== void 0) {
      delete decl["border-radius"];
      if (!sameRadius(radius, master("border-radius"))) decl["--bs-btn-border-radius"] = radius;
    }
    const padding = decl["padding"];
    if (padding !== void 0) {
      delete decl["padding"];
      if (!samePadding(padding, master("padding"))) {
        const parsed = parsePadding(padding);
        if (parsed) {
          decl["--bs-btn-padding-y"] = parsed.y;
          decl["--bs-btn-padding-x"] = parsed.x;
        }
      }
    }
    const border = decl["border"];
    if (border !== void 0) {
      delete decl["border"];
      if (!sameValue(border, master("border"))) {
        const width = (_c = border.match(/^\s*(\S+)/)) == null ? void 0 : _c[1];
        const color = parseBorderColor(border);
        if (width) decl["--bs-btn-border-width"] = width;
        if (color) {
          decl["--bs-btn-border-color"] = color;
          decl["--bs-btn-hover-border-color"] = color;
          decl["--bs-btn-active-border-color"] = color;
        }
      }
    }
  }
  function buildBootstrapTheme(sets) {
    const rules = [];
    for (const set of sets) {
      const builder = KIND_BUILDERS[set.kind];
      if (!builder) continue;
      rules.push(...builder(set));
    }
    if (rules.length === 0) return "";
    const header = "/* bootstrap-theme.css \u2014 GENERATED from the Figma kit masters (REFORM phase 14).\n   Per-component Bootstrap variable sets: edit the kit masters and re-export to retheme.\n   Loaded after bootstrap-tokens.css, before tokens/project CSS. */";
    return `${header}

${rules.join("\n\n")}
`;
  }

  // src/targets/django/css-emitter.ts
  function toClassName(id) {
    return `n${id.replace(/[^a-zA-Z0-9]+/g, "-")}`;
  }
  function classNameFor(id, options) {
    var _a, _b;
    return toClassName((_b = (_a = options.idAliases) == null ? void 0 : _a.get(id)) != null ? _b : id);
  }
  var IR_OWNED_CSS = /* @__PURE__ */ new Set([
    // box model / positioning / sizing
    "width",
    "height",
    "min-width",
    "max-width",
    "min-height",
    "max-height",
    "top",
    "right",
    "bottom",
    "left",
    "inset",
    "position",
    "float",
    "clear",
    "box-sizing",
    "overflow",
    "overflow-x",
    "overflow-y",
    "aspect-ratio",
    // flexbox
    "display",
    "flex",
    "flex-grow",
    "flex-shrink",
    "flex-basis",
    "flex-direction",
    "flex-wrap",
    "flex-flow",
    "align-items",
    "align-self",
    "align-content",
    "justify-content",
    "justify-items",
    "justify-self",
    "place-items",
    "place-content",
    "place-self",
    "order",
    "gap",
    "row-gap",
    "column-gap",
    // grid
    "grid",
    "grid-template",
    "grid-template-columns",
    "grid-template-rows",
    "grid-template-areas",
    "grid-column",
    "grid-row",
    "grid-area",
    "grid-auto-flow",
    "grid-auto-columns",
    "grid-auto-rows",
    "grid-column-gap",
    "grid-row-gap",
    // spacing
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    // font / text metrics — owned by the per-segment rules and the text box's text-align
    "font",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "font-variant",
    "font-stretch",
    "line-height",
    "letter-spacing",
    "text-align",
    "text-indent",
    "white-space",
    "word-break",
    "word-wrap",
    "text-overflow",
    "writing-mode",
    "-webkit-line-clamp",
    "-webkit-box-orient"
  ]);
  function sanitizeTransform(value) {
    const kept = value.match(/(?:rotate|skew|scale|matrix)[a-zA-Z]*\([^)]*\)/g);
    return kept ? kept.join(" ") : void 0;
  }
  function splitTopLevelCommas(value) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        parts.push(value.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(value.slice(start));
    return parts;
  }
  function sanitizeBackgroundLayers(value) {
    return splitTopLevelCommas(value).map((layer) => layer.replace(/(^|\s)lightgray(\s|$)/, " ").replace(/\s{2,}/g, " ").trim()).filter((layer) => layer.length > 0).join(", ");
  }
  function pickVisualDeclarations(css) {
    const picked = {};
    for (const [property, value] of Object.entries(css)) {
      if (IR_OWNED_CSS.has(property)) continue;
      if (property === "transform") {
        const transform = sanitizeTransform(value);
        if (transform) {
          picked["transform"] = transform;
          picked["transform-origin"] = "0 0";
        }
        continue;
      }
      const sanitized = property === "background" ? sanitizeBackgroundLayers(value) : value;
      if (sanitized.length > 0) picked[property] = sanitized;
    }
    if (picked["backdrop-filter"] && !picked["-webkit-backdrop-filter"]) {
      picked["-webkit-backdrop-filter"] = picked["backdrop-filter"];
    }
    return picked;
  }
  var IMAGE_FILL_PLACEHOLDER = /url\(\s*(["']?)<path-to-image>\1\s*\)/g;
  function imageFillUrls(node) {
    var _a, _b;
    if (node.type === "image") return [`../${(_a = node.assetSrc) != null ? _a : `img/${rasterFilename(node.id, node.name, "png", 1)}`}`];
    if (node.type === "container" || node.type === "instance-ref") {
      return ((_b = node.backgroundImages) != null ? _b : []).map((bg) => `../${bg.assetSrc}`);
    }
    return [];
  }
  function resolveImageFillPlaceholders(declarations, fillUrls) {
    const resolved = {};
    for (const [property, value] of Object.entries(declarations)) {
      let index = 0;
      resolved[property] = value.replace(IMAGE_FILL_PLACEHOLDER, () => {
        if (fillUrls.length === 0) return "none";
        const url = fillUrls[Math.min(index, fillUrls.length - 1)];
        index++;
        return `url(${url})`;
      });
    }
    return resolved;
  }
  function px(value) {
    const rounded = Math.round(value * 100) / 100;
    return `${rounded}px`;
  }
  function pct(value) {
    const rounded = Math.round(value * 100) / 100;
    return `${rounded}%`;
  }
  function maskRadiusCss(radius) {
    if (typeof radius === "number") return px(radius);
    return `${px(radius.topLeft)} ${px(radius.topRight)} ${px(radius.bottomRight)} ${px(radius.bottomLeft)}`;
  }
  function applyMaskDeclarations(mask, decl) {
    if (mask.kind === "clip") {
      if (mask.shape === "ellipse") decl["border-radius"] = "50%";
      else if (mask.radius != null) decl["border-radius"] = maskRadiusCss(mask.radius);
      return;
    }
    const url = `url(../${mask.assetSrc})`;
    decl["-webkit-mask-image"] = url;
    decl["mask-image"] = url;
    decl["-webkit-mask-mode"] = mask.mode;
    decl["mask-mode"] = mask.mode;
    decl["-webkit-mask-size"] = "100% 100%";
    decl["mask-size"] = "100% 100%";
    decl["-webkit-mask-repeat"] = "no-repeat";
    decl["mask-repeat"] = "no-repeat";
  }
  function gridTracks(tracks) {
    return tracks.map((track) => {
      if (track.type === "fixed") return px(track.value);
      if (track.type === "fr") return `${track.value}fr`;
      return "fit-content(100%)";
    }).join(" ");
  }
  function sizeDeclarations(axis, size, parentLayout, decl) {
    if (size.mode === "fixed") {
      decl[axis] = px(size.value);
      return;
    }
    if (size.mode !== "fill") return;
    if ((parentLayout == null ? void 0 : parentLayout.kind) === "flex") {
      const mainAxis = parentLayout.direction === "row" ? "width" : "height";
      if (axis === mainAxis) {
        decl["flex"] = "1 0 0";
        decl[axis === "width" ? "min-width" : "min-height"] = "0";
      } else decl["align-self"] = "stretch";
      return;
    }
    decl[axis] = "100%";
  }
  function fixedPixelSize(node) {
    const { width, height } = node.sizing;
    return width.mode === "fixed" && height.mode === "fixed" ? { width: width.value, height: height.value } : void 0;
  }
  var DEFAULT_CONSTRAINTS = { horizontal: "min", vertical: "min" };
  function applyAxisConstraint(decl, type, position, ownSize, parentSize, startProp, endProp, sizeProp, marginProp) {
    if (type === "center" && parentSize != null) {
      decl[startProp] = "50%";
      decl[marginProp] = px(position - parentSize / 2);
      return;
    }
    if (parentSize != null && ownSize != null) {
      if (type === "max") {
        decl[endProp] = px(parentSize - position - ownSize);
        return;
      }
      if (type === "stretch") {
        decl[startProp] = px(position);
        decl[endProp] = px(parentSize - position - ownSize);
        delete decl[sizeProp];
        return;
      }
      if (type === "scale" && parentSize !== 0) {
        decl[startProp] = pct(position / parentSize * 100);
        decl[sizeProp] = pct(ownSize / parentSize * 100);
        return;
      }
    }
    decl[startProp] = px(position);
  }
  function applyConstraints(node, parentSize, decl) {
    var _a;
    const constraints = (_a = node.constraints) != null ? _a : DEFAULT_CONSTRAINTS;
    const ownSize = fixedPixelSize(node);
    applyAxisConstraint(
      decl,
      constraints.horizontal,
      node.position.x,
      ownSize == null ? void 0 : ownSize.width,
      parentSize == null ? void 0 : parentSize.width,
      "left",
      "right",
      "width",
      "margin-left"
    );
    applyAxisConstraint(
      decl,
      constraints.vertical,
      node.position.y,
      ownSize == null ? void 0 : ownSize.height,
      parentSize == null ? void 0 : parentSize.height,
      "top",
      "bottom",
      "height",
      "margin-top"
    );
  }
  function layoutDeclarations(node, parentLayout, parentSize, childIndex) {
    var _a;
    const decl = {};
    const layout = "layout" in node ? node.layout : null;
    if ((layout == null ? void 0 : layout.kind) === "flex") {
      decl["display"] = "flex";
      decl["flex-direction"] = layout.direction;
      decl["position"] = "relative";
      if (layout.wrap) decl["flex-wrap"] = "wrap";
      const mainGap = layout.gap > 0 && layout.justifyContent !== "space-between" ? layout.gap : 0;
      if (mainGap || layout.crossGap != null) {
        decl["gap"] = layout.crossGap != null ? `${px(layout.crossGap)} ${px(mainGap)}` : px(mainGap);
      }
      const { top, right, bottom, left } = layout.padding;
      if (top || right || bottom || left) decl["padding"] = `${px(top)} ${px(right)} ${px(bottom)} ${px(left)}`;
      const flowChildCount = ("children" in node ? node.children : []).filter((c) => c.absoluteInLayout !== true).length;
      const justifyContent = layout.justifyContent === "space-between" && flowChildCount === 1 ? "center" : layout.justifyContent;
      if (justifyContent !== "flex-start") decl["justify-content"] = justifyContent;
      decl["align-items"] = layout.alignItems;
      if (layout.alignContent) decl["align-content"] = layout.alignContent;
      if (layout.strokesIncludedInLayout) decl["box-sizing"] = "border-box";
    } else if ((layout == null ? void 0 : layout.kind) === "grid") {
      decl["display"] = "grid";
      decl["position"] = "relative";
      decl["grid-template-columns"] = gridTracks(layout.columns);
      if (layout.autoRows) decl["grid-auto-rows"] = "auto";
      else if (layout.rows.length) decl["grid-template-rows"] = gridTracks(layout.rows);
      if (layout.autoFlow) decl["grid-auto-flow"] = layout.autoFlow;
      if (layout.columnGap) decl["column-gap"] = px(layout.columnGap);
      if (layout.rowGap) decl["row-gap"] = px(layout.rowGap);
    } else if ((layout == null ? void 0 : layout.kind) === "absolute") {
      decl["position"] = "relative";
    }
    if (layout == null ? void 0 : layout.clip) decl["overflow"] = "hidden";
    if ((layout == null ? void 0 : layout.overflow) && parentLayout !== null) {
      if (layout.overflow === "x") decl["overflow-x"] = "auto";
      else if (layout.overflow === "y") decl["overflow-y"] = "auto";
      else decl["overflow"] = "auto";
    }
    if ("mask" in node && node.mask) applyMaskDeclarations(node.mask, decl);
    const overlayChild = node.absoluteInLayout === true && ((parentLayout == null ? void 0 : parentLayout.kind) === "flex" || (parentLayout == null ? void 0 : parentLayout.kind) === "grid");
    const absoluteChild = (parentLayout == null ? void 0 : parentLayout.kind) === "absolute" || overlayChild;
    if (absoluteChild) {
      decl["position"] = "absolute";
    }
    if (node.gridPlacement && !overlayChild) {
      decl["grid-row"] = `${node.gridPlacement.rowStart + 1} / span ${node.gridPlacement.rowSpan}`;
      decl["grid-column"] = `${node.gridPlacement.columnStart + 1} / span ${node.gridPlacement.columnSpan}`;
    }
    sizeDeclarations("width", node.sizing.width, parentLayout, decl);
    sizeDeclarations("height", node.sizing.height, parentLayout, decl);
    if (node.sizing.minWidth != null) decl["min-width"] = px(node.sizing.minWidth);
    if (node.sizing.maxWidth != null) decl["max-width"] = px(node.sizing.maxWidth);
    if (node.sizing.minHeight != null) decl["min-height"] = px(node.sizing.minHeight);
    if (node.sizing.maxHeight != null) decl["max-height"] = px(node.sizing.maxHeight);
    if (parentLayout === null && node.type === "container" && node.sizing.width.mode === "fixed") {
      decl["width"] = "100%";
    }
    if (node.aspectRatio && !(node.type === "text" && node.autoResize)) {
      decl["aspect-ratio"] = `${node.aspectRatio.width} / ${node.aspectRatio.height}`;
      delete decl["height"];
    }
    if (absoluteChild) applyConstraints(node, parentSize, decl);
    if ((parentLayout == null ? void 0 : parentLayout.kind) === "flex" && !overlayChild && !decl["flex"]) {
      decl["flex-shrink"] = "0";
    }
    if ((parentLayout == null ? void 0 : parentLayout.kind) === "flex" && !overlayChild && childIndex != null) {
      if (parentLayout.gap < 0 && childIndex > 0) {
        decl[parentLayout.direction === "row" ? "margin-left" : "margin-top"] = px(parentLayout.gap);
      }
      if (parentLayout.reverseZIndex) decl["z-index"] = String(-childIndex);
    }
    if (node.alignSelf && !overlayChild) decl["align-self"] = node.alignSelf;
    if ((parentLayout == null ? void 0 : parentLayout.kind) === "flex" && !overlayChild && decl["align-self"] === "stretch") {
      const crossAxis = parentLayout.direction === "row" ? "height" : "width";
      if (decl[crossAxis === "width" ? "max-width" : "max-height"] != null) {
        delete decl["align-self"];
        decl[crossAxis] = "100%";
      }
    }
    if (node.type === "text") {
      decl["margin"] = "0";
      if (node.textAlign) decl["text-align"] = node.textAlign;
      if (node.paragraphIndent) decl["text-indent"] = px(node.paragraphIndent);
      if (node.noWrap) decl["white-space"] = "nowrap";
      if (node.truncate) {
        const maxLines = (_a = node.truncate.maxLines) != null ? _a : 1;
        if (maxLines <= 1) {
          decl["white-space"] = "nowrap";
          decl["overflow"] = "hidden";
          decl["text-overflow"] = "ellipsis";
        } else {
          decl["display"] = "-webkit-box";
          decl["-webkit-box-orient"] = "vertical";
          decl["-webkit-line-clamp"] = String(maxLines);
          decl["overflow"] = "hidden";
        }
      } else if (node.textAlignVertical) {
        decl["display"] = "flex";
        decl["flex-direction"] = "column";
        decl["justify-content"] = node.textAlignVertical;
      }
    }
    if ((node.type === "image" || node.type === "vector") && !decl["display"]) decl["display"] = "block";
    return decl;
  }
  function uniformCornerRadiusRef(bound) {
    if (bound.cornerRadius) return bound.cornerRadius;
    const { topLeftRadius, topRightRadius, bottomLeftRadius, bottomRightRadius } = bound;
    if (!topLeftRadius || !topRightRadius || !bottomLeftRadius || !bottomRightRadius) return void 0;
    const sameId = [topRightRadius, bottomLeftRadius, bottomRightRadius].every((ref) => ref.id === topLeftRadius.id);
    return sameId ? topLeftRadius : void 0;
  }
  function literalFallback(literal) {
    if (!literal) return void 0;
    const inner = literal.match(/^var\([^,)]+,\s*(.+)\)$/);
    if (inner) return inner[1];
    return literal.startsWith("var(") ? void 0 : literal;
  }
  function withFallback(varName2, fallback) {
    return fallback ? `var(${varName2}, ${fallback})` : `var(${varName2})`;
  }
  function tokenOverrides(bound, isText, variableNamesById, literal = {}) {
    var _a, _b, _c;
    if (!bound) return {};
    const overrides = {};
    const fillProperty = isText ? "color" : "background";
    const fillName = ((_a = bound.fills) == null ? void 0 : _a[0]) && variableNamesById.get(bound.fills[0].id);
    if (fillName) overrides[fillProperty] = withFallback(toCssVarName(fillName), literalFallback(literal[fillProperty]));
    const strokeName = ((_b = bound.strokes) == null ? void 0 : _b[0]) && variableNamesById.get(bound.strokes[0].id);
    if (strokeName) overrides["border-color"] = withFallback(toCssVarName(strokeName), literalFallback(literal["border-color"]));
    const effectName = ((_c = bound.effects) == null ? void 0 : _c[0]) && variableNamesById.get(bound.effects[0].id);
    if (effectName) overrides["box-shadow"] = withFallback(toCssVarName(effectName), literalFallback(literal["box-shadow"]));
    const radiusRef = uniformCornerRadiusRef(bound);
    const radiusName = radiusRef && variableNamesById.get(radiusRef.id);
    if (radiusName) overrides["border-radius"] = withFallback(toCssVarName(radiusName), literalFallback(literal["border-radius"]));
    return overrides;
  }
  function formatRule(className, declarations) {
    const entries = Object.entries(declarations);
    if (entries.length === 0) return null;
    const body = entries.map(([property, value]) => `  ${property}: ${value};`).join("\n");
    return `.${className} {
${body}
}`;
  }
  async function emitTextRules(className, source, node, variableNamesById, rules) {
    var _a, _b, _c;
    const segments = (_b = (_a = source == null ? void 0 : source.getStyledTextSegments) == null ? void 0 : _a.call(source, TEXT_SEGMENT_FIELDS)) != null ? _b : [];
    if (source && segments.length > 0) {
      const literal = pickVisualDeclarations(await source.getCSSAsync());
      const overrides = tokenOverrides(source.boundVariables, true, variableNamesById, literal);
      rules.push(...segmentsToCss(className, segments, {
        color: (_c = overrides.color) != null ? _c : literal.color,
        leadingTrim: node.leadingTrim,
        hangingPunctuation: node.hangingPunctuation,
        hangingList: node.hangingList
      }));
    }
  }
  var VECTOR_LEAF_PAINT = /* @__PURE__ */ new Set([
    "background",
    "background-color",
    "background-image",
    "background-clip",
    "background-origin",
    "background-blend-mode",
    "fill",
    "color"
  ]);
  function solidStrokeColor(strokes) {
    const solid4 = strokes == null ? void 0 : strokes.find((paint) => paint.type === "SOLID" && paint.visible !== false);
    if (!(solid4 == null ? void 0 : solid4.color)) return void 0;
    return rgbaToCss(solid4.opacity != null && solid4.opacity < 1 ? __spreadProps(__spreadValues({}, solid4.color), { a: solid4.opacity }) : solid4.color);
  }
  var STROKE_OWNED_CSS = /* @__PURE__ */ new Set([
    "border",
    "border-width",
    "border-style",
    "border-color",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
    "outline"
  ]);
  function strokeDeclarations(source) {
    const align = source.strokeAlign;
    if (!align) return {};
    const color = solidStrokeColor(source.strokes);
    if (!color) return {};
    if (align === "INSIDE") {
      const w = source.individualStrokeWeights;
      if (w && !(w.top === w.right && w.right === w.bottom && w.bottom === w.left)) {
        return {
          "border-style": "solid",
          "border-color": color,
          "border-top-width": px(w.top),
          "border-right-width": px(w.right),
          "border-bottom-width": px(w.bottom),
          "border-left-width": px(w.left)
        };
      }
      return {};
    }
    const weight = typeof source.strokeWeight === "number" ? source.strokeWeight : void 0;
    if (weight == null) return {};
    if (align === "CENTER") {
      const half = px(weight / 2);
      return { "box-shadow": `0 0 0 ${half} ${color} inset, 0 0 0 ${half} ${color}` };
    }
    return { outline: `${px(weight)} solid ${color}`, "outline-offset": "0px" };
  }
  function scaleBorderRadius(value, smoothing) {
    const factor = 1 + smoothing * 0.6;
    return value.replace(/(-?\d*\.?\d+)px/g, (_match, n) => `${Math.round(parseFloat(n) * factor * 100) / 100}px`);
  }
  function formatStyleRefsComment(className, styleRefs) {
    if (!styleRefs) return void 0;
    const parts = [];
    if (styleRefs.fillStyleName) parts.push(`fill: ${styleRefs.fillStyleName}`);
    if (styleRefs.strokeStyleName) parts.push(`stroke: ${styleRefs.strokeStyleName}`);
    if (styleRefs.effectStyleName) parts.push(`effect: ${styleRefs.effectStyleName}`);
    if (styleRefs.gridStyleName) parts.push(`grid: ${styleRefs.gridStyleName}`);
    if (parts.length === 0) return void 0;
    return `/* .${className} tokens \u2014 ${parts.join(", ")} */`;
  }
  var UNSUPPORTED_EFFECT_TYPES = /* @__PURE__ */ new Set(["NOISE", "TEXTURE", "GLASS", "SHADER"]);
  function warnUnsupportedEffect(nodeId, effectType, notes) {
    console.warn(`[css-emitter] "${nodeId}": ${effectType} effect has no CSS equivalent \u2014 skipped`);
    notes == null ? void 0 : notes.push({ type: "unsupported-effect", node: nodeId, effect: effectType });
  }
  function effectDeclarations(source, nodeId, notes) {
    var _a, _b;
    const effects = source.effects;
    if (!Array.isArray(effects) || effects.length === 0) return {};
    const filters = [];
    let dropBoxShadow = false;
    for (const effect of effects) {
      if (effect.visible === false) continue;
      if (effect.type === "DROP_SHADOW" && effect.showShadowBehindNode) {
        const { x, y } = (_a = effect.offset) != null ? _a : { x: 0, y: 0 };
        const blur = (_b = effect.radius) != null ? _b : 0;
        const color = effect.color ? rgbaToCss(effect.color) : "rgba(0, 0, 0, 1)";
        filters.push(`drop-shadow(${px(x)} ${px(y)} ${px(blur)} ${color})`);
        dropBoxShadow = true;
        continue;
      }
      if (UNSUPPORTED_EFFECT_TYPES.has(effect.type)) warnUnsupportedEffect(nodeId, effect.type, notes);
    }
    if (filters.length === 0) return {};
    return __spreadValues({ filter: filters.join(" ") }, dropBoxShadow ? { dropBoxShadow: true } : {});
  }
  async function emitBoxRules(className, node, source, layout, fillUrls, isVectorLeaf, variableNamesById, rules, notes, themedMaster) {
    let literal = source ? resolveImageFillPlaceholders(pickVisualDeclarations(await source.getCSSAsync()), fillUrls) : {};
    if (isVectorLeaf) {
      literal = Object.fromEntries(Object.entries(literal).filter(([property]) => !VECTOR_LEAF_PAINT.has(property)));
    }
    const overrides = source && !isVectorLeaf ? tokenOverrides(source.boundVariables, false, variableNamesById, literal) : {};
    const decl = __spreadValues(__spreadValues(__spreadValues({}, layout), literal), overrides);
    const stroke = source && !isVectorLeaf ? strokeDeclarations(source) : {};
    if (Object.keys(stroke).length > 0) {
      for (const property of STROKE_OWNED_CSS) delete decl[property];
      if (stroke["box-shadow"] && decl["box-shadow"]) stroke["box-shadow"] = `${stroke["box-shadow"]}, ${decl["box-shadow"]}`;
      Object.assign(decl, stroke);
    }
    const smoothing = source == null ? void 0 : source.cornerSmoothing;
    if (smoothing && smoothing > 0 && decl["border-radius"]) {
      decl["border-radius"] = scaleBorderRadius(decl["border-radius"], smoothing);
      notes == null ? void 0 : notes.push({ type: "squircle-approx", node: node.id, smoothing });
    }
    const effect = source && !isVectorLeaf ? effectDeclarations(source, node.id, notes) : {};
    if (effect.filter) {
      if (effect.dropBoxShadow) delete decl["box-shadow"];
      decl["filter"] = decl["filter"] ? `${effect.filter} ${decl["filter"]}` : effect.filter;
    }
    if (node.type === "image" && node.imageRotation) {
      decl["transform"] = decl["transform"] ? `${decl["transform"]} rotate(${node.imageRotation}deg)` : `rotate(${node.imageRotation}deg)`;
    }
    if (themedMaster) themeButtonInstanceDecl(decl, themedMaster);
    if ("backgroundVideo" in node && node.backgroundVideo) {
      decl["isolation"] = "isolate";
      const bgProps = Object.keys(decl).filter((property) => property === "background" || property.startsWith("background-"));
      if (bgProps.length > 0) {
        const overlay = {
          content: '""',
          position: "absolute",
          inset: "0",
          "z-index": "-1",
          "pointer-events": "none",
          "border-radius": "inherit"
        };
        for (const property of bgProps) {
          overlay[property] = decl[property];
          delete decl[property];
        }
        const rule2 = formatRule(className, decl);
        if (rule2) rules.push(rule2);
        rules.push(formatRule(`${className}::before`, overlay));
        return;
      }
    }
    const rule = formatRule(className, decl);
    if (rule) rules.push(rule);
  }
  async function collectNodeCss(node, parentLayout, parentSize, sceneNodesById, variableNamesById, rules, options, isFixedChild = false, childIndex) {
    var _a, _b, _c, _d;
    const className = classNameFor(node.id, options);
    const source = sceneNodesById.get(node.id);
    const layout = layoutDeclarations(node, parentLayout, parentSize, childIndex);
    if (isFixedChild) {
      layout["position"] = "sticky";
      layout["top"] = "0";
      layout["z-index"] = "10";
    }
    if (node.aspectRatio && node.type === "text" && node.autoResize) {
      rules.push(`/* .${className}: aspect-ratio skipped: auto-resize text */`);
    }
    const styleRefsComment = formatStyleRefsComment(className, node.styleRefs);
    if (styleRefsComment) rules.push(styleRefsComment);
    if (node.type === "text") {
      const segments = (_b = (_a = source == null ? void 0 : source.getStyledTextSegments) == null ? void 0 : _a.call(source, TEXT_SEGMENT_FIELDS)) != null ? _b : [{ characters: node.characters }];
      const paragraphs = splitTextParagraphs(segments);
      if (isMultiBlockText(paragraphs)) {
        const TYPOGRAPHY_KEYS = /* @__PURE__ */ new Set(["margin", "text-align", "text-indent"]);
        const boxDecl = {};
        const typographyDecl = {};
        for (const [property, value] of Object.entries(layout)) {
          ;
          (TYPOGRAPHY_KEYS.has(property) ? typographyDecl : boxDecl)[property] = value;
        }
        const boxRule = formatRule(`${className}--box`, boxDecl);
        if (boxRule) rules.push(boxRule);
        const typographyRule = formatRule(className, typographyDecl);
        if (typographyRule) rules.push(typographyRule);
        if (node.paragraphSpacing) {
          rules.push(`.${className}:not(:first-child) {
  margin-top: ${px(node.paragraphSpacing)};
}`);
        }
        if (node.listSpacing) {
          rules.push(`li.${className}:not(:first-child) {
  margin-top: ${px(node.listSpacing)};
}`);
        }
      } else {
        const boxRule = formatRule(className, layout);
        if (boxRule) rules.push(boxRule);
      }
      await emitTextRules(className, source, node, variableNamesById, rules);
    } else {
      await emitBoxRules(className, node, source, layout, imageFillUrls(node), node.type === "vector", variableNamesById, rules, options.notes, (_c = options.themedInstances) == null ? void 0 : _c.get(node.id));
    }
    if ("children" in node) {
      const ownLayout = "layout" in node ? node.layout : null;
      const ownSize = fixedPixelSize(node);
      const firstFixedIndex = node.children.length - ((_d = node.fixedChildrenCount) != null ? _d : 0);
      for (const [index, child] of node.children.entries()) {
        await collectNodeCss(child, ownLayout, ownSize, sceneNodesById, variableNamesById, rules, options, index >= firstFixedIndex, index);
      }
    }
  }
  async function emitCss(nodes, sceneNodesById, variableNamesById = /* @__PURE__ */ new Map(), options = {}) {
    const rules = options.preamble === false ? [] : ["*, *::before, *::after {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n}"];
    for (const node of nodes) {
      await collectNodeCss(node, null, void 0, sceneNodesById, variableNamesById, rules, options);
    }
    return rules.join("\n\n");
  }

  // src/targets/django/html-emitter.ts
  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  var PLACEHOLDER_PATTERN = /\{(\w+)\}/g;
  function wrapTranslatable(escaped) {
    if (!escaped) return escaped;
    escaped = escaped.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ");
    const names = [...new Set([...escaped.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]))];
    if (names.length === 0) return `{% translate "${escaped}" %}`;
    const withClause = names.map((name) => `${name}=${name}`).join(" ");
    const body = escaped.replace(PLACEHOLDER_PATTERN, (_match, name) => `{{ ${name} }}`);
    return `{% blocktranslate with ${withClause} %}${body}{% endblocktranslate %}`;
  }
  function renderSegmentSpan(className, index, segment) {
    var _a;
    const span = `<span class="${segmentClassName(className, index)}">${wrapTranslatable(escapeHtml(segment.characters))}</span>`;
    if (((_a = segment.hyperlink) == null ? void 0 : _a.type) === "URL") return `<a href="${escapeHtml(segment.hyperlink.value)}">${span}</a>`;
    return span;
  }
  function renderTextSpans(className, segments) {
    return segments.map((segment, index) => renderSegmentSpan(className, index, segment)).join("");
  }
  function renderParagraphRuns(className, runs) {
    return runs.map(({ segment, index }) => renderSegmentSpan(className, index, segment)).join("");
  }
  function renderTextList(items, className, indent2) {
    let i = 0;
    function parseLevel(depth, ind) {
      const tag = items[i].listType === "ORDERED" ? "ol" : "ul";
      const lines = [`${ind}<${tag} class="${className}--list">`];
      while (i < items.length && items[i].listDepth === depth) {
        const item = items[i];
        i++;
        let content = `${renderParagraphRuns(className, item.runs)}`;
        if (i < items.length && items[i].listDepth > depth) {
          content += `
${parseLevel(depth + 1, `${ind}  `)}
${ind}  `;
        }
        lines.push(`${ind}  <li class="${className}">${content}</li>`);
      }
      lines.push(`${ind}</${tag}>`);
      return lines.join("\n");
    }
    return parseLevel(items[0].listDepth, indent2);
  }
  function renderTextBody(paragraphs, className, indent2) {
    const blocks = [];
    let i = 0;
    while (i < paragraphs.length) {
      if (paragraphs[i].listType === "NONE") {
        blocks.push(`${indent2}<p class="${className}">${renderParagraphRuns(className, paragraphs[i].runs)}</p>`);
        i++;
        continue;
      }
      const run = [];
      while (i < paragraphs.length && paragraphs[i].listType !== "NONE") {
        run.push(paragraphs[i]);
        i++;
      }
      blocks.push(renderTextList(run, className, indent2));
    }
    return blocks.join("\n");
  }
  function renderTextBlock(node, source, className, indent2) {
    var _a, _b;
    const segments = (_b = (_a = source == null ? void 0 : source.getStyledTextSegments) == null ? void 0 : _a.call(source, TEXT_SEGMENT_FIELDS)) != null ? _b : [{ characters: node.characters }];
    const paragraphs = splitTextParagraphs(segments);
    if (!isMultiBlockText(paragraphs)) {
      return `${indent2}<p class="${className}">${renderTextSpans(className, segments)}</p>`;
    }
    const inner = renderTextBody(paragraphs, className, `${indent2}  `);
    return `${indent2}<div class="${className}--box">
${inner}
${indent2}</div>`;
  }
  function renderTextNode(node, sceneNodesById, indent2) {
    const className = toClassName(node.id);
    return renderTextBlock(node, sceneNodesById.get(node.id), className, indent2);
  }
  function imageStaticPath(node) {
    return `img/${rasterFilename(node.id, node.name, "png", 1)}`;
  }
  function renderAssetLeaf(node, indent2) {
    var _a;
    const className = toClassName(node.id);
    if (node.type === "vector" && !node.assetSrc && node.inlineSvg) {
      return `${indent2}${node.inlineSvg.replace(/<svg\b/, `<svg class="${className}"`)}`;
    }
    const src = node.type === "image" ? (_a = node.assetSrc) != null ? _a : imageStaticPath(node) : node.assetSrc;
    if (!src) return `${indent2}<div class="${className}"></div>`;
    if (isVideoAssetPath(src)) {
      const poster = node.type === "image" && node.posterSrc ? ` poster="{% static '${node.posterSrc}' %}"` : "";
      const objectFit = scaleModeToObjectFit(node.type === "image" ? node.videoScaleMode : void 0);
      return `${indent2}<video class="${className}" data-autoplay-video src="{% static '${src}' %}"${poster} autoplay loop muted playsinline preload="metadata" style="object-fit:${objectFit}"></video>`;
    }
    return `${indent2}<img class="${className}" src="{% static '${src}' %}" alt="${escapeHtml(node.name)}">`;
  }
  function wrapNavigate(node, rendered, indent2, navMap) {
    var _a;
    const destinationId = (_a = node.navigate) == null ? void 0 : _a.destinationId;
    if (!destinationId) return rendered;
    const slug2 = navMap.get(destinationId);
    if (!slug2) {
      console.warn(`"${node.name}" has a NAVIGATE reaction to "${destinationId}", which isn't in the exported page set \u2014 skipping <a> wrap`);
      return rendered;
    }
    return `${indent2}<a href="{{ navMap.${slug2} }}" style="display:contents">
${rendered}
${indent2}</a>`;
  }
  function renderBackgroundVideoLayer(node, indent2) {
    const bv = "backgroundVideo" in node ? node.backgroundVideo : void 0;
    if (!bv) return null;
    const objectFit = scaleModeToObjectFit(bv.scaleMode);
    const className = toClassName(node.id);
    return `${indent2}<video class="${className}__bg-video" data-autoplay-video src="{% static '${bv.assetSrc}' %}" poster="{% static '${bv.posterSrc}' %}" autoplay loop muted playsinline preload="metadata" style="position:absolute;inset:0;width:100%;height:100%;object-fit:${objectFit};z-index:-2;pointer-events:none"></video>`;
  }
  function renderNode(node, sceneNodesById, indent2, navMap) {
    const className = toClassName(node.id);
    const rendered = (() => {
      switch (node.type) {
        case "text":
          return renderTextNode(node, sceneNodesById, indent2);
        case "image":
        case "vector":
          return renderAssetLeaf(node, indent2);
        case "container":
        case "instance-ref": {
          const bgVideo = renderBackgroundVideoLayer(node, `${indent2}  `);
          if (node.children.length === 0 && !bgVideo) return `${indent2}<div class="${className}"></div>`;
          const inner = node.children.map((child) => renderNode(child, sceneNodesById, `${indent2}  `, navMap)).join("\n");
          const parts = [bgVideo, inner].filter(Boolean);
          return `${indent2}<div class="${className}">
${parts.join("\n")}
${indent2}</div>`;
        }
      }
    })();
    return wrapNavigate(node, rendered, indent2, navMap);
  }
  var REDUCED_MOTION_VIDEO_SNIPPET = `<script>
(function(){var mq=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)');
if(mq&&mq.matches){document.querySelectorAll('video[data-autoplay-video]').forEach(function(v){v.pause();v.removeAttribute('autoplay');});}})();
<\/script>`;
  function emitHtml(nodes, sceneNodesById, cssFile, navMap = /* @__PURE__ */ new Map()) {
    const body = nodes.map((node) => renderNode(node, sceneNodesById, "    ", navMap)).join("\n");
    const hasAutoplayVideo = body.includes("data-autoplay-video");
    return [
      "{% load static %}",
      "{% load i18n %}",
      "<!DOCTYPE html>",
      "<html>",
      "<head>",
      `  <link rel="stylesheet" href="{% static '${cssFile}' %}">`,
      "</head>",
      "<body>",
      body,
      hasAutoplayVideo ? REDUCED_MOTION_VIDEO_SNIPPET : "",
      "</body>",
      "</html>"
    ].filter(Boolean).join("\n");
  }

  // src/targets/django/component-emitter.ts
  function toVarName(name) {
    const slug2 = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return slug2 || "prop";
  }
  function idSlug(id) {
    return id.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function partialPath(component) {
    const slug2 = component.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `components/${slug2 || "component"}--${idSlug(component.id)}.html`;
  }
  function navMapKey(id) {
    return `nav_${id.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
  }
  function pageTemplatePath(page, nameOverride) {
    const name = nameOverride != null ? nameOverride : page.name;
    const slug2 = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `pages/${slug2 || "page"}--${idSlug(page.id)}.html`;
  }
  function textOverrideVarName(mainComponentNodeId2) {
    return `text_${mainComponentNodeId2.replace(/[^a-zA-Z0-9]+/g, "_")}`;
  }
  function escapeDjangoString(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  function djangoStringLiteral(value) {
    return `"${escapeDjangoString(value)}"`;
  }
  function collectComponents(nodes) {
    const found = [];
    const visit = (node) => {
      if (node.type === "container" && node.component) found.push(node);
      if ("children" in node) node.children.forEach(visit);
    };
    nodes.forEach(visit);
    return found;
  }
  function buildComponentRegistry(components) {
    const pathByComponentKey = /* @__PURE__ */ new Map();
    const nodeByComponentId = /* @__PURE__ */ new Map();
    for (const component of components) {
      const path = partialPath(component);
      if (component.component) pathByComponentKey.set(component.component.key, path);
      nodeByComponentId.set(component.id, component);
    }
    return { pathByComponentKey, nodeByComponentId };
  }
  function subtreeHasText(node) {
    if (node.type === "text") return true;
    if ("children" in node) return node.children.some(subtreeHasText);
    return false;
  }
  function findTextNodeById(node, id) {
    if (node.id === id) return node.type === "text" ? node : null;
    if ("children" in node) {
      for (const child of node.children) {
        const found = findTextNodeById(child, id);
        if (found) return found;
      }
    }
    return null;
  }
  function mainComponentNodeId(instanceDescendantId) {
    const index = instanceDescendantId.lastIndexOf(";");
    return index === -1 ? instanceDescendantId : instanceDescendantId.slice(index + 1);
  }
  function collectTextOverrides(instanceNode, mainComponent) {
    const overrides = {};
    const visit = (node) => {
      if (node.type === "text" && !node.componentPropertyReferences.characters) {
        const mainId = mainComponentNodeId(node.id);
        const mainTextNode = findTextNodeById(mainComponent, mainId);
        if (mainTextNode && mainTextNode.characters !== node.characters) overrides[mainId] = node.characters;
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(instanceNode);
    return overrides;
  }
  function collectOverriddenTextNodeIds(roots, registry) {
    const result = /* @__PURE__ */ new Map();
    const visit = (node) => {
      var _a;
      if (node.type === "instance-ref" && node.componentId) {
        const mainComponent = registry.nodeByComponentId.get(node.componentId);
        if (mainComponent) {
          const overrides = collectTextOverrides(node, mainComponent);
          const ids = (_a = result.get(node.componentId)) != null ? _a : /* @__PURE__ */ new Set();
          Object.keys(overrides).forEach((id) => ids.add(id));
          if (ids.size > 0) result.set(node.componentId, ids);
        }
      }
      if ("children" in node) node.children.forEach(visit);
    };
    roots.forEach(visit);
    return result;
  }
  function componentPropertyLiteral(value, registry) {
    if (value.type === "BOOLEAN") return value.value ? "True" : "False";
    if (value.type === "INSTANCE_SWAP") {
      const path = registry.nodeByComponentId.get(value.value);
      return djangoStringLiteral(path ? partialPath(path) : value.value);
    }
    return djangoStringLiteral(value.value);
  }
  function buildIncludeParams(node, registry) {
    const params = Object.entries(node.componentProperties).map(
      ([name, value]) => `${toVarName(name)}=${componentPropertyLiteral(value, registry)}`
    );
    const mainComponent = node.componentId ? registry.nodeByComponentId.get(node.componentId) : void 0;
    if (mainComponent) {
      const textOverrides = collectTextOverrides(node, mainComponent);
      for (const [mainId, characters] of Object.entries(textOverrides)) {
        params.push(`${textOverrideVarName(mainId)}=${djangoStringLiteral(characters)}`);
      }
    }
    return params;
  }
  function renderIncludeTag(path, params) {
    const withClause = params.length > 0 ? ` with ${params.join(" ")}` : "";
    return `{% include "${path}"${withClause} only %}`;
  }
  function variantModifierClasses(className, component) {
    return component.properties.filter((prop) => prop.type === "VARIANT").map((prop) => {
      const varName2 = toVarName(prop.name);
      const fallback = typeof prop.defaultValue === "string" ? prop.defaultValue : String(prop.defaultValue);
      return `${className}--{{ ${varName2}|default:'${fallback}' }}`;
    });
  }
  function rootClassAttr(className, component) {
    if (!component) return className;
    return [className, ...variantModifierClasses(className, component)].join(" ");
  }
  function mergeWiringEntry(map, nodeId, entry) {
    var _a, _b, _c;
    const existing = map.get(nodeId);
    if (!existing) {
      map.set(nodeId, {
        addClasses: entry.addClasses ? [...entry.addClasses] : void 0,
        addAttrs: entry.addAttrs,
        addIncludeParams: entry.addIncludeParams ? [...entry.addIncludeParams] : void 0
      });
      return;
    }
    if (entry.addClasses) existing.addClasses = [...(_a = existing.addClasses) != null ? _a : [], ...entry.addClasses];
    if (entry.addAttrs) existing.addAttrs = ((_b = existing.addAttrs) != null ? _b : "") + entry.addAttrs;
    if (entry.addIncludeParams) existing.addIncludeParams = [...(_c = existing.addIncludeParams) != null ? _c : [], ...entry.addIncludeParams];
  }
  function findPartNode(root, partKey, scopeKey) {
    const search = (node, isRoot) => {
      if (!isRoot && node.type === "instance-ref") return null;
      if (!isRoot && scopeKey && partKeyForName(node.name) === scopeKey) return null;
      if (!isRoot && node.type === "container" && partKeyForName(node.name) === partKey) return node;
      if ("children" in node) {
        for (const child of node.children) {
          const found = search(child, false);
          if (found) return found;
        }
      }
      return null;
    };
    return search(root, true);
  }
  function findScopeNodes(root, scopeKey) {
    const out = [];
    const walk = (node, isRoot) => {
      if (!isRoot && node.type === "instance-ref") return;
      if (!isRoot && node.type === "container" && partKeyForName(node.name) === scopeKey) {
        out.push(node);
        return;
      }
      if ("children" in node) for (const child of node.children) walk(child, false);
    };
    walk(root, true);
    return out;
  }
  function findAllPartNodes(root, partKey) {
    const out = [];
    const walk = (node, isRoot) => {
      if (!isRoot && node.type === "instance-ref") return;
      if (!isRoot && node.type === "container" && partKeyForName(node.name) === partKey) out.push(node);
      if ("children" in node) for (const child of node.children) walk(child, false);
    };
    walk(root, true);
    return out;
  }
  function buildCollapseWiring(map, root, spec) {
    if (spec.idParam) {
      const toggle = findPartNode(root, spec.toggle);
      const target = findPartNode(root, spec.target);
      if (!toggle || !target) return;
      const idRef = `{{ ${spec.idParam} }}`;
      const parentAttr = spec.parentParam ? `{% if ${spec.parentParam} %} data-bs-parent="#{{ ${spec.parentParam} }}"{% endif %}` : "";
      mergeWiringEntry(map, target.id, {
        addClasses: spec.targetClass.split(/\s+/).filter(Boolean),
        addAttrs: ` id="${idRef}"${parentAttr}`
      });
      mergeWiringEntry(map, toggle.id, {
        addClasses: spec.toggleCollapsedClass ? [spec.toggleCollapsedClass] : [],
        addAttrs: ` data-bs-toggle="collapse" data-bs-target="#${idRef}" aria-expanded="false" aria-controls="${idRef}"`
      });
      return;
    }
    const scopeRoots2 = spec.scope ? findScopeNodes(root, spec.scope) : [root];
    for (const scopeRoot of scopeRoots2) {
      const toggle = findPartNode(scopeRoot, spec.toggle, spec.scope);
      const target = findPartNode(scopeRoot, spec.target, spec.scope);
      if (!toggle || !target) continue;
      const domId = `${toClassName(target.id)}-collapse`;
      mergeWiringEntry(map, target.id, { addClasses: spec.targetClass.split(/\s+/).filter(Boolean), addAttrs: ` id="${domId}"` });
      mergeWiringEntry(map, toggle.id, {
        addAttrs: ` data-bs-toggle="collapse" data-bs-target="#${domId}" aria-expanded="false" aria-controls="${domId}"`
      });
    }
  }
  function buildTabsWiring(map, root, spec) {
    const toggles = findAllPartNodes(root, spec.toggle);
    const panes = findAllPartNodes(root, spec.pane);
    const count = Math.min(toggles.length, panes.length);
    for (let i = 0; i < count; i++) {
      const paneId = `${toClassName(panes[i].id)}-pane`;
      const first = i === 0;
      mergeWiringEntry(map, toggles[i].id, {
        addClasses: first ? ["active"] : [],
        addAttrs: ` data-bs-toggle="tab" data-bs-target="#${paneId}" aria-controls="${paneId}"` + (first ? ' aria-selected="true"' : ' aria-selected="false"')
      });
      mergeWiringEntry(map, panes[i].id, { addClasses: first ? ["show", "active"] : [], addAttrs: ` id="${paneId}"` });
    }
  }
  function buildCarouselWiring(map, root, spec) {
    const rootId = `${toClassName(root.id)}-carousel`;
    mergeWiringEntry(map, root.id, { addAttrs: ` id="${rootId}"` });
    findAllPartNodes(root, spec.slide).forEach((slide, i) => {
      if (i === 0) mergeWiringEntry(map, slide.id, { addClasses: ["active"] });
    });
    for (const controlKey of [spec.prev, spec.next]) {
      if (!controlKey) continue;
      for (const control of findAllPartNodes(root, controlKey)) {
        mergeWiringEntry(map, control.id, { addAttrs: ` data-bs-target="#${rootId}"` });
      }
    }
  }
  function findAllInstanceRefs(root, registry, kind) {
    const out = [];
    const walk = (node) => {
      var _a, _b;
      if (node.type === "instance-ref") {
        const main = node.componentId ? registry.nodeByComponentId.get(node.componentId) : void 0;
        const mkind = (main == null ? void 0 : main.component) ? (_b = matchBootstrapComponent((_a = main.component.setName) != null ? _a : main.name, main.component, toVarName)) == null ? void 0 : _b.kind : void 0;
        if (mkind === kind) out.push(node);
        return;
      }
      if ("children" in node) for (const child of node.children) walk(child);
    };
    for (const child of root.children) walk(child);
    return out;
  }
  function buildItemIdParams(map, root, spec, registry) {
    const items = findAllInstanceRefs(root, registry, spec.childKind);
    if (items.length === 0) return;
    const parentId = `${toClassName(root.id)}-accordion`;
    if (spec.parentParam) mergeWiringEntry(map, root.id, { addAttrs: ` id="${parentId}"` });
    for (const item of items) {
      const collapseId = `${toClassName(item.id)}-collapse`;
      const params = [`${spec.idParam}="${collapseId}"`];
      if (spec.parentParam) params.push(`${spec.parentParam}="${parentId}"`);
      mergeWiringEntry(map, item.id, { addIncludeParams: params });
    }
  }
  function buildTabInstanceParams(map, root, spec, registry) {
    const toggles = findAllInstanceRefs(root, registry, spec.toggle);
    const panes = findAllInstanceRefs(root, registry, spec.pane);
    const count = Math.min(toggles.length, panes.length);
    for (let i = 0; i < count; i++) {
      const paneId = `${toClassName(panes[i].id)}-pane`;
      mergeWiringEntry(map, toggles[i].id, { addIncludeParams: [`tab_id="${paneId}"`] });
      mergeWiringEntry(map, panes[i].id, { addIncludeParams: [`pane_id="${paneId}"`] });
    }
  }
  function buildWiring(root, match, registry) {
    const map = /* @__PURE__ */ new Map();
    if (match.collapse) buildCollapseWiring(map, root, match.collapse);
    if (match.tabs) buildTabsWiring(map, root, match.tabs);
    if (match.carousel) buildCarouselWiring(map, root, match.carousel);
    if (registry && match.itemInstanceIdParams) buildItemIdParams(map, root, match.itemInstanceIdParams, registry);
    if (registry && match.tabItems) buildTabInstanceParams(map, root, match.tabItems, registry);
    return map.size > 0 ? map : void 0;
  }
  function wrapVisible(node, rendered, indent2, literalText) {
    const propName = node.componentPropertyReferences.visible;
    if (!propName || literalText) return rendered;
    return `${indent2}{% if ${toVarName(propName)} %}
${rendered}
${indent2}{% endif %}`;
  }
  function renderPartialText(node, className, ctx, indent2) {
    if (ctx.literalText) return renderTextBlock(node, ctx.sceneNodesById.get(node.id), className, indent2);
    const propName = node.componentPropertyReferences.characters;
    if (propName) {
      const varName2 = toVarName(propName);
      return `${indent2}<p class="${className}"><span class="${segmentClassName(className, 0)}">{{ ${varName2} }}</span></p>`;
    }
    if (ctx.overriddenTextNodeIds.has(node.id)) {
      const varName2 = textOverrideVarName(node.id);
      const fallback = escapeDjangoString(node.characters);
      return `${indent2}<p class="${className}"><span class="${segmentClassName(className, 0)}">{{ ${varName2}|default:"${fallback}" }}</span></p>`;
    }
    return renderTextBlock(node, ctx.sceneNodesById.get(node.id), className, indent2);
  }
  function renderPartialInstanceRef(node, className, ctx, indent2) {
    var _a, _b, _c;
    const swapProp = node.componentPropertyReferences.mainComponent;
    if (swapProp && !ctx.literalText) {
      const varName2 = toVarName(swapProp);
      const fallbackComponent = node.componentId ? ctx.registry.nodeByComponentId.get(node.componentId) : void 0;
      const expr = fallbackComponent ? `${varName2}|default:'${partialPath(fallbackComponent)}'` : varName2;
      return `${indent2}{% include ${expr} %}`;
    }
    const path = node.componentKey ? ctx.registry.pathByComponentKey.get(node.componentKey) : void 0;
    if (path) {
      const params = buildIncludeParams(node, ctx.registry);
      const extra = (_b = (_a = ctx.wiring) == null ? void 0 : _a.get(node.id)) == null ? void 0 : _b.addIncludeParams;
      if (extra) params.push(...extra);
      return `${indent2}${renderIncludeTag(path, params)}`;
    }
    if (ctx.bootstrapComponents) {
      const recognizable = recognizableContainerOnPage(node, ctx.registry);
      const comp = recognizable == null ? void 0 : recognizable.component;
      const match = comp ? matchBootstrapComponent((_c = comp.setName) != null ? _c : recognizable.name, comp, toVarName) : null;
      if (recognizable && match && subtreeHasText(node) && !(match.void && node.children.length > 0)) {
        const childCtx = __spreadProps(__spreadValues({}, ctx), { bootstrapParts: match.parts, wiring: buildWiring(recognizable, match, ctx.registry) });
        return renderPartialContainer(recognizable, className, childCtx, indent2);
      }
    }
    const bgVideo = renderBackgroundVideoLayer(node, `${indent2}  `);
    if (node.children.length === 0 && !bgVideo) return `${indent2}<div class="${className}"></div>`;
    const inner = node.children.map((child) => renderPartialNode(child, ctx, `${indent2}  `)).join("\n");
    const parts = [bgVideo, inner].filter(Boolean);
    return `${indent2}<div class="${className}">
${parts.join("\n")}
${indent2}</div>`;
  }
  function renderPartialContainer(node, className, ctx, indent2) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
    const bootstrap = ctx.bootstrapComponents && node.component ? matchBootstrapComponent((_a = node.component.setName) != null ? _a : node.name, node.component, toVarName) : null;
    const part = !node.component && ctx.bootstrapComponents ? partForName(ctx.bootstrapParts, node.name) : null;
    const wiring = (_b = ctx.wiring) == null ? void 0 : _b.get(node.id);
    const joinedClasses = [rootClassAttr(className, ctx.literalText ? null : node.component), ...(_c = bootstrap == null ? void 0 : bootstrap.classes) != null ? _c : [], ...(_d = part == null ? void 0 : part.classes) != null ? _d : [], ...(_e = wiring == null ? void 0 : wiring.addClasses) != null ? _e : []].filter(Boolean).join(" ");
    const classAttr = ctx.literalText ? foldDefaultClassExprs(joinedClasses) : joinedClasses;
    const tag = (_g = (_f = bootstrap == null ? void 0 : bootstrap.tag) != null ? _f : part == null ? void 0 : part.tag) != null ? _g : "div";
    const attrs = ((_i = (_h = bootstrap == null ? void 0 : bootstrap.attributes) != null ? _h : part == null ? void 0 : part.attributes) != null ? _i : "") + ((_j = wiring == null ? void 0 : wiring.addAttrs) != null ? _j : "");
    if ((bootstrap == null ? void 0 : bootstrap.void) || (part == null ? void 0 : part.void)) return `${indent2}<${tag} class="${classAttr}"${attrs}>`;
    const appended = (bootstrap == null ? void 0 : bootstrap.appendHtml) ? `${indent2}  ${bootstrap.appendHtml}` : "";
    const bgVideo = renderBackgroundVideoLayer(node, `${indent2}  `);
    if (node.children.length === 0 && !bgVideo && !appended) return `${indent2}<${tag} class="${classAttr}"${attrs}></${tag}>`;
    const inner = node.children.map((child) => renderPartialNode(child, ctx, `${indent2}  `)).join("\n");
    const parts = [bgVideo, inner, appended].filter(Boolean);
    return `${indent2}<${tag} class="${classAttr}"${attrs}>
${parts.join("\n")}
${indent2}</${tag}>`;
  }
  function renderPartialNode(node, ctx, indent2) {
    var _a;
    const className = toClassName(node.id);
    const rendered = (() => {
      switch (node.type) {
        case "text":
          return renderPartialText(node, className, ctx, indent2);
        case "image":
        case "vector":
          return renderAssetLeaf(node, indent2);
        case "instance-ref":
          return renderPartialInstanceRef(node, className, ctx, indent2);
        case "container":
          return renderPartialContainer(node, className, ctx, indent2);
      }
    })();
    return wrapVisible(node, wrapNavigate(node, rendered, indent2, ctx.navMap), indent2, (_a = ctx.literalText) != null ? _a : false);
  }
  function emitComponentPartial(component, sceneNodesById, registry, overriddenTextNodeIds = /* @__PURE__ */ new Set(), navMap = /* @__PURE__ */ new Map(), bootstrapComponents = false) {
    var _a;
    const match = bootstrapComponents && component.component ? matchBootstrapComponent((_a = component.component.setName) != null ? _a : component.name, component.component, toVarName) : null;
    const wiring = match ? buildWiring(component, match, registry) : void 0;
    const body = renderPartialNode(
      component,
      { sceneNodesById, registry, overriddenTextNodeIds, navMap, bootstrapComponents, bootstrapParts: match == null ? void 0 : match.parts, wiring },
      ""
    );
    return `{% load i18n %}
{% load static %}
${body}`;
  }
  function recognizableContainerOnPage(node, registry) {
    var _a;
    if (node.type === "container" && node.component) return node;
    if (node.type === "instance-ref" && node.componentSetName) {
      const hasPartial = node.componentKey != null && registry.pathByComponentKey.has(node.componentKey);
      if (hasPartial) return null;
      const properties = Object.entries(node.componentProperties).filter((entry) => entry[1].type === "VARIANT").map(([name, value]) => ({ name, type: "VARIANT", defaultValue: value.value, variantOptions: [value.value] }));
      return __spreadProps(__spreadValues({}, node), {
        type: "container",
        component: { key: (_a = node.componentKey) != null ? _a : node.id, setName: node.componentSetName, properties }
      });
    }
    return null;
  }
  function foldDefaultClassExprs(classAttr) {
    return classAttr.replace(/\{\{ [a-zA-Z0-9_]+\|default:'([^']*)'(?:\|lower)? \}\}/g, "$1");
  }
  function renderPageNode(node, sceneNodesById, registry, navMap, indent2, bootstrapComponents) {
    const className = toClassName(node.id);
    const rendered = (() => {
      var _a;
      if (node.type === "instance-ref") {
        const path = node.componentKey ? registry.pathByComponentKey.get(node.componentKey) : void 0;
        if (path) return `${indent2}${renderIncludeTag(path, buildIncludeParams(node, registry))}`;
      }
      if (bootstrapComponents) {
        const recognizable = recognizableContainerOnPage(node, registry);
        if (recognizable) {
          const comp = recognizable.component;
          const match = comp ? matchBootstrapComponent((_a = comp.setName) != null ? _a : recognizable.name, comp, toVarName) : null;
          if (match) {
            const wiring = buildWiring(recognizable, match, registry);
            const ctx = {
              sceneNodesById,
              registry,
              overriddenTextNodeIds: /* @__PURE__ */ new Set(),
              navMap,
              bootstrapComponents,
              bootstrapParts: match.parts,
              wiring,
              literalText: true
              // page-inline: no include binds the labels → render literal characters
            };
            return renderPartialContainer(recognizable, className, ctx, indent2);
          }
        }
      }
      switch (node.type) {
        case "text":
          return renderTextBlock(node, sceneNodesById.get(node.id), className, indent2);
        case "image":
        case "vector":
          return renderAssetLeaf(node, indent2);
        case "container":
        case "instance-ref": {
          const bgVideo = renderBackgroundVideoLayer(node, `${indent2}  `);
          if (node.children.length === 0 && !bgVideo) return `${indent2}<div class="${className}"></div>`;
          const inner = node.children.map((child) => renderPageNode(child, sceneNodesById, registry, navMap, `${indent2}  `, bootstrapComponents)).join("\n");
          const parts = [bgVideo, inner].filter(Boolean);
          return `${indent2}<div class="${className}">
${parts.join("\n")}
${indent2}</div>`;
        }
      }
    })();
    return wrapNavigate(node, rendered, indent2, navMap);
  }
  function emitPage(root, sceneNodesById, registry, navMap = /* @__PURE__ */ new Map(), bootstrapComponents = false) {
    const body = renderPageNode(root, sceneNodesById, registry, navMap, "    ", bootstrapComponents);
    return ['{% extends "base.html" %}', "{% load i18n %}", "{% load static %}", "{% block content %}", body, "{% endblock %}"].join("\n");
  }
  function fontLinks(fontFamilies) {
    if (fontFamilies.length === 0) return [];
    return [
      '  <link rel="preconnect" href="https://fonts.googleapis.com">',
      '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
      ...fontFamilies.map(
        (family) => `  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@100..900&display=swap">`
      )
    ];
  }
  var GSAP_PLUGIN_STATIC_FILE_BY_NAME = {
    CustomEase: "vendor/gsap/CustomEase.min.js",
    DrawSVGPlugin: "vendor/gsap/DrawSVGPlugin.min.js",
    TextPlugin: "vendor/gsap/TextPlugin.min.js"
  };
  function emitBaseHtml(cssFile, tokensCssFile = "css/tokens.css", fontFamilies = [], interactionLinks = { interactionsCss: false, interactionsJs: false }, framework = null) {
    var _a;
    const frameworkCssLines = framework ? [
      "  {% block framework_css %}",
      ...framework.source === "cdn" ? [
        `  <style>@import url("https://cdn.jsdelivr.net/npm/bootstrap@${framework.version}/dist/css/bootstrap.min.css") layer(bootstrap);</style>`
      ] : framework.source === "vendored" ? [`  <style>@import url("{% static 'vendor/bootstrap/bootstrap.min.css' %}") layer(bootstrap);</style>`] : [
        "  {# Bootstrap CSS is expected from the project (Settings \u2192 Bootstrap source: In project). Override this block to link it, or run `altery-dj bootstrap vendor`. #}"
      ],
      "  {% endblock %}",
      ...framework.bootstrapTokensCssFile ? [`  <link rel="stylesheet" href="{% static '${framework.bootstrapTokensCssFile}' %}">`] : [],
      ...framework.themeCssFile ? [`  <link rel="stylesheet" href="{% static '${framework.themeCssFile}' %}">`] : []
    ] : [];
    const frameworkJsLines = framework ? [
      "  {% block framework_js %}",
      ...framework.source === "cdn" ? [
        `  <script src="https://cdn.jsdelivr.net/npm/bootstrap@${framework.version}/dist/js/bootstrap.bundle.min.js" defer><\/script>`
      ] : framework.source === "vendored" ? [`  <script src="{% static 'vendor/bootstrap/bootstrap.bundle.min.js' %}" defer><\/script>`] : ["  {# Bootstrap JS (bundle) is expected from the project \u2014 override this block to link it. #}"],
      "  {% endblock %}"
    ] : [];
    const interactionCssLink = interactionLinks.interactionsCss ? [`  <link rel="stylesheet" href="{% static 'css/interactions.css' %}">`] : [];
    const animationCssLink = interactionLinks.animationsCss ? [`  <link rel="stylesheet" href="{% static 'css/animations.css' %}">`] : [];
    const interactionJsLink = interactionLinks.interactionsJs ? [`  <script src="{% static 'js/interactions.js' %}" defer><\/script>`] : [];
    const animationJsLink = interactionLinks.animationsJs ? [
      `  <script src="{% static 'vendor/gsap/gsap.min.js' %}"><\/script>`,
      ...((_a = interactionLinks.gsapPlugins) != null ? _a : []).map(
        (plugin) => `  <script src="{% static '${GSAP_PLUGIN_STATIC_FILE_BY_NAME[plugin]}' %}" defer><\/script>`
      ),
      `  <script src="{% static 'js/animations.js' %}" defer><\/script>`
    ] : [];
    return [
      "{% load static %}",
      "<!DOCTYPE html>",
      "<html>",
      "<head>",
      ...fontLinks(fontFamilies),
      ...frameworkCssLines,
      ...tokensCssFile ? [`  <link rel="stylesheet" href="{% static '${tokensCssFile}' %}">`] : [],
      `  <link rel="stylesheet" href="{% static '${cssFile}' %}">`,
      ...interactionCssLink,
      ...animationCssLink,
      "</head>",
      "<body>",
      "  {% block content %}{% endblock %}",
      ...frameworkJsLines,
      ...interactionJsLink,
      ...animationJsLink,
      "</body>",
      "</html>"
    ].join("\n");
  }

  // src/targets/django/regenerate.ts
  function generatedBeginMarker(nodeId) {
    return `{# GENERATED:BEGIN ${nodeId} \u2014 edits outside this block survive regeneration #}`;
  }
  function generatedEndMarker(nodeId) {
    return `{# GENERATED:END ${nodeId} #}`;
  }
  function wrapGenerated(nodeId, content) {
    return [generatedBeginMarker(nodeId), content, generatedEndMarker(nodeId)].join("\n");
  }
  function findGeneratedSpan(fileContent, nodeId) {
    const begin = generatedBeginMarker(nodeId);
    const end = generatedEndMarker(nodeId);
    const beginIndex = fileContent.indexOf(begin);
    if (beginIndex === -1) return null;
    const contentStart = beginIndex + begin.length;
    const endIndex = fileContent.indexOf(end, contentStart);
    if (endIndex === -1) return null;
    return { contentStart, contentEnd: endIndex };
  }
  function mergeGenerated(existing, nodeId, fresh) {
    if (existing === null) return fresh;
    const existingSpan = findGeneratedSpan(existing, nodeId);
    if (!existingSpan) return null;
    const freshSpan = findGeneratedSpan(fresh, nodeId);
    if (!freshSpan) return fresh;
    const freshInner = fresh.slice(freshSpan.contentStart, freshSpan.contentEnd);
    return existing.slice(0, existingSpan.contentStart) + freshInner + existing.slice(existingSpan.contentEnd);
  }
  function diffLines(oldText, newText) {
    const oldLines = oldText.length === 0 ? [] : oldText.split("\n");
    const newLines = newText.length === 0 ? [] : newText.split("\n");
    const n = oldLines.length;
    const m = newLines.length;
    const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i2 = n - 1; i2 >= 0; i2--) {
      for (let j2 = m - 1; j2 >= 0; j2--) {
        lcs[i2][j2] = oldLines[i2] === newLines[j2] ? lcs[i2 + 1][j2 + 1] + 1 : Math.max(lcs[i2 + 1][j2], lcs[i2][j2 + 1]);
      }
    }
    const result = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (oldLines[i] === newLines[j]) {
        result.push({ kind: "equal", text: oldLines[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        result.push({ kind: "remove", text: oldLines[i] });
        i++;
      } else {
        result.push({ kind: "add", text: newLines[j] });
        j++;
      }
    }
    while (i < n) {
      result.push({ kind: "remove", text: oldLines[i] });
      i++;
    }
    while (j < m) {
      result.push({ kind: "add", text: newLines[j] });
      j++;
    }
    return result;
  }
  function planRegeneration(existingFiles, freshFiles) {
    var _a;
    const files = [];
    const warnings = [];
    for (const [path, fresh] of freshFiles) {
      const existing = (_a = existingFiles.get(path)) != null ? _a : null;
      const merged = mergeGenerated(existing, fresh.nodeId, fresh.content);
      if (merged === null) {
        warnings.push(`${path}: no GENERATED marker for ${fresh.nodeId} found \u2014 left untouched (fully hand-edited)`);
        files.push({ path, action: "skipped-hand-edited", content: existing, diff: [] });
        continue;
      }
      const action = existing === null ? "create" : merged === existing ? "unchanged" : "update";
      files.push({ path, action, content: merged, diff: diffLines(existing != null ? existing : "", merged) });
    }
    return { files, warnings };
  }

  // src/targets/django/smart-animate/match-layers.ts
  function indexTree(root) {
    const map = /* @__PURE__ */ new Map();
    const walk = (node, prefix) => {
      var _a, _b;
      const seen = /* @__PURE__ */ new Map();
      for (const child of (_a = node.children) != null ? _a : []) {
        const dupIndex = (_b = seen.get(child.name)) != null ? _b : 0;
        seen.set(child.name, dupIndex + 1);
        const path = `${prefix}${child.name}#${dupIndex}`;
        map.set(path, child);
        walk(child, `${path}/`);
      }
    };
    walk(root, "");
    return map;
  }
  function matchLayers(base, target) {
    const baseIndex = indexTree(base);
    const targetIndex = indexTree(target);
    const matched = [];
    const removed = [];
    const added = [];
    for (const [path, node] of baseIndex) {
      const other = targetIndex.get(path);
      if (other && other.type === node.type) {
        matched.push({ path, a: node, b: other });
      } else {
        removed.push({ path, node });
        if (other) added.push({ path, node: other });
      }
    }
    for (const [path, node] of targetIndex) {
      if (!baseIndex.has(path)) added.push({ path, node });
    }
    return { matched, removed, added };
  }

  // src/targets/django/breakpoint-frames.ts
  var NAMED_WIDTHS = { desktop: 1280, tablet: 768, mobile: 375 };
  function extractBreakpointTokens2(snapshot) {
    if (!snapshot) return /* @__PURE__ */ new Map();
    const collection = snapshot.collections.find(
      (c) => c.name.trim().toLowerCase() === "breakpoints"
    );
    if (!collection) return /* @__PURE__ */ new Map();
    const breakpointModeNames = /* @__PURE__ */ new Set(["desktop", "tablet", "mobile", "xl", "lg", "md", "sm", "xs"]);
    const modeKeys = collection.modes.map((m) => m.name.trim().toLowerCase());
    const looksModeBased = collection.modes.length >= 2 && modeKeys.every((k) => breakpointModeNames.has(k) || /^\d{3,5}$/.test(k));
    if (looksModeBased) {
      const tokens2 = /* @__PURE__ */ new Map();
      for (const v of snapshot.variables) {
        if (v.collectionId !== collection.id) continue;
        if (v.resolvedType !== "FLOAT") continue;
        for (const mode of collection.modes) {
          const value = v.valuesByMode[mode.modeId];
          if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
          const key = mode.name.trim().toLowerCase();
          if (key) {
            const existing = tokens2.get(key);
            if (existing === void 0 || value > existing) tokens2.set(key, Math.round(value));
          }
        }
      }
      if (tokens2.size > 0) return tokens2;
    }
    const tokens = /* @__PURE__ */ new Map();
    for (const v of snapshot.variables) {
      if (v.collectionId !== collection.id) continue;
      if (v.resolvedType !== "FLOAT") continue;
      const value = v.valuesByMode[collection.defaultModeId];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
      const key = v.name.split("/").pop().trim().toLowerCase();
      if (key) tokens.set(key, Math.round(value));
    }
    return tokens;
  }
  function resolveNamedWidths(overrides) {
    if (!overrides || overrides.size === 0) return NAMED_WIDTHS;
    return __spreadValues(__spreadValues({}, NAMED_WIDTHS), Object.fromEntries(overrides));
  }
  function parseBreakpointName(name, namedWidths = NAMED_WIDTHS) {
    const match = /^(.*)\/([^/]+)$/.exec(name.trim());
    if (!match) return null;
    const slug2 = match[1].trim();
    if (!slug2) return null;
    const suffix = match[2].trim().toLowerCase();
    if (suffix in namedWidths) return { slug: slug2, width: namedWidths[suffix] };
    const width = /^(\d+)\s*(?:px)?$/.exec(suffix);
    if (width) return { slug: slug2, width: Number(width[1]) };
    return null;
  }
  function detectBreakpointGroups(roots, namedWidthsOverrides) {
    const namedWidths = resolveNamedWidths(namedWidthsOverrides);
    const bySlug = /* @__PURE__ */ new Map();
    const keyOrder = [];
    for (const root of roots) {
      const parsed = parseBreakpointName(root.name, namedWidths);
      if (!parsed) continue;
      const key = parsed.slug.replace(/\s+/g, " ").toLowerCase();
      if (!bySlug.has(key)) {
        bySlug.set(key, { slug: parsed.slug, frames: [] });
        keyOrder.push(key);
      }
      bySlug.get(key).frames.push({ width: parsed.width, node: root });
    }
    const groups = [];
    const groupedIds = /* @__PURE__ */ new Set();
    const widestIds = /* @__PURE__ */ new Set();
    for (const key of keyOrder) {
      const { slug: slug2, frames } = bySlug.get(key);
      if (frames.length < 2) continue;
      const sorted = [...frames].sort((a, b) => b.width - a.width);
      groups.push({ slug: slug2, frames: sorted });
      for (const frame2 of sorted) groupedIds.add(frame2.node.id);
      widestIds.add(sorted[0].node.id);
    }
    const rendered = roots.filter((root) => !groupedIds.has(root.id) || widestIds.has(root.id));
    return { rendered, groups };
  }
  function toDiffable(node) {
    return {
      id: node.id,
      type: node.type,
      name: node.name,
      x: node.position.x,
      y: node.position.y,
      width: node.sizing.width.mode === "fixed" ? node.sizing.width.value : 0,
      height: node.sizing.height.mode === "fixed" ? node.sizing.height.value : 0,
      children: "children" in node ? node.children.map(toDiffable) : void 0
    };
  }
  function indent(block2) {
    return block2.replace(/^/gm, "  ");
  }
  async function emitBreakpointCss(group, sceneNodesById, variableNamesById = /* @__PURE__ */ new Map()) {
    const [widest, ...narrower] = group.frames;
    const widestDiffable = toDiffable(widest.node);
    const blocks = [];
    for (let index = 0; index < narrower.length; index++) {
      const frame2 = narrower[index];
      const nextWiderWidth = index === 0 ? widest.width : narrower[index - 1].width;
      const result = matchLayers(widestDiffable, toDiffable(frame2.node));
      const idAliases = /* @__PURE__ */ new Map([[frame2.node.id, widest.node.id]]);
      for (const pair2 of result.matched) {
        if (pair2.a.id && pair2.b.id) idAliases.set(pair2.b.id, pair2.a.id);
      }
      const overrides = await emitCss([frame2.node], sceneNodesById, variableNamesById, {
        idAliases,
        preamble: false
      });
      const hidden = result.removed.map((entry) => entry.node.id).filter((id) => Boolean(id)).map((id) => `.${toClassName(id)} {
  display: none;
}`);
      const body = [overrides, ...hidden].filter((part) => part.length > 0).join("\n\n");
      blocks.push(`@media (max-width: ${nextWiderWidth - 1}px) {
${indent(body)}
}`);
    }
    return blocks.join("\n\n");
  }
  var BREAKPOINT_COLLECTION_PLUGIN_KEY = "alteryBreakpointsGenerated";
  var DEFAULT_BREAKPOINTS = {
    Desktop: 1440,
    Tablet: 834,
    Mobile: 390
  };
  function planBreakpointSteps(breakpoints = DEFAULT_BREAKPOINTS) {
    const entries = Object.entries(breakpoints);
    const steps = [];
    for (const [mode, width] of entries) {
      const name = mode.trim();
      if (!name) continue;
      if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) continue;
      steps.push({ mode: name, width: Math.round(width) });
    }
    return steps;
  }
  async function generateBreakpointCollection(breakpoints = DEFAULT_BREAKPOINTS) {
    const steps = planBreakpointSteps(breakpoints);
    if (steps.length === 0) {
      throw new Error("No valid breakpoint steps \u2014 all widths were missing or non-positive.");
    }
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const existing = collections.find((c) => c.name.trim().toLowerCase() === "breakpoints");
    const isOurs = existing && existing.getPluginData(BREAKPOINT_COLLECTION_PLUGIN_KEY) !== "";
    if (existing && !isOurs) {
      return snapshotExistingCollection(existing);
    }
    if (existing && isOurs) {
      existing.remove();
    }
    const collection = figma.variables.createVariableCollection("Breakpoints");
    const [first, ...rest] = steps;
    collection.renameMode(collection.defaultModeId, first.mode);
    const modeIds = [collection.defaultModeId];
    for (const step of rest) {
      modeIds.push(collection.addMode(step.mode));
    }
    const widthVar = figma.variables.createVariable("Width", collection, "FLOAT");
    widthVar.description = "Breakpoint viewport width (px) per mode. Generated by Altery plugin.";
    widthVar.hiddenFromPublishing = false;
    for (let i = 0; i < steps.length; i++) {
      widthVar.setValueForMode(modeIds[i], steps[i].width);
    }
    const layoutVar = figma.variables.createVariable("Layout", collection, "STRING");
    layoutVar.description = "Breakpoint layout label (mode name) per mode. Generated by Altery plugin.";
    layoutVar.hiddenFromPublishing = false;
    for (let i = 0; i < steps.length; i++) {
      layoutVar.setValueForMode(modeIds[i], steps[i].mode);
    }
    collection.setPluginData(BREAKPOINT_COLLECTION_PLUGIN_KEY, (/* @__PURE__ */ new Date()).toISOString());
    const widths = {};
    for (const step of steps) widths[step.mode] = step.width;
    return {
      collectionName: collection.name,
      regenerated: Boolean(existing && isOurs),
      modes: steps.map((s) => s.mode),
      variableName: widthVar.name,
      widths
    };
  }
  async function snapshotExistingCollection(collection) {
    const modes = collection.modes.map((m) => m.name);
    const widths = {};
    for (const varId of collection.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(varId);
      if (!v || v.resolvedType !== "FLOAT") continue;
      for (const mode of collection.modes) {
        const value = v.valuesByMode[mode.modeId];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          widths[mode.name] = Math.round(value);
        }
      }
      break;
    }
    return {
      collectionName: collection.name,
      regenerated: false,
      modes,
      variableName: "",
      widths
    };
  }

  // src/targets/django/interactions.ts
  var IR_OWNED_CSS2 = /* @__PURE__ */ new Set([
    "width",
    "height",
    "min-width",
    "max-width",
    "min-height",
    "max-height",
    "top",
    "right",
    "bottom",
    "left",
    "inset",
    "position",
    "float",
    "clear",
    "box-sizing",
    "overflow",
    "overflow-x",
    "overflow-y",
    "aspect-ratio",
    "display",
    "flex",
    "flex-grow",
    "flex-shrink",
    "flex-basis",
    "flex-direction",
    "flex-wrap",
    "flex-flow",
    "align-items",
    "align-self",
    "align-content",
    "justify-content",
    "justify-items",
    "justify-self",
    "place-items",
    "place-content",
    "place-self",
    "order",
    "gap",
    "row-gap",
    "column-gap",
    "grid",
    "grid-template",
    "grid-template-columns",
    "grid-template-rows",
    "grid-template-areas",
    "grid-column",
    "grid-row",
    "grid-area",
    "grid-auto-flow",
    "grid-auto-columns",
    "grid-auto-rows",
    "grid-column-gap",
    "grid-row-gap",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "font",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "font-variant",
    "font-stretch",
    "line-height",
    "letter-spacing",
    "text-align",
    "text-indent",
    "white-space",
    "word-break",
    "word-wrap",
    "text-overflow",
    "writing-mode",
    "-webkit-line-clamp",
    "-webkit-box-orient"
  ]);
  function pseudoClass(trigger) {
    return trigger === "ON_HOVER" ? "hover" : "active";
  }
  function diffCss(sourceCss, destCss) {
    const decls = [];
    for (const [property, value] of Object.entries(destCss)) {
      if (IR_OWNED_CSS2.has(property)) continue;
      if (sourceCss[property] === value) continue;
      if (!(property in sourceCss) && !value) continue;
      decls.push({ property, value });
    }
    return decls;
  }
  function collectReactionDestinationIds(nodes) {
    const ids = /* @__PURE__ */ new Set();
    const visit = (node) => {
      var _a, _b;
      for (const interaction of (_a = node.interactions) != null ? _a : []) {
        ids.add(interaction.destinationId);
        if (interaction.sourceId) ids.add(interaction.sourceId);
      }
      for (const overlay of (_b = node.overlays) != null ? _b : []) ids.add(overlay.destinationId);
      if ("children" in node) for (const child of node.children) visit(child);
    };
    for (const node of nodes) visit(node);
    return ids;
  }
  async function emitInteractions(nodes, sceneNodesById, options = {}) {
    const cssParts = [];
    const jsParts = [];
    const overlayDialogs = /* @__PURE__ */ new Map();
    const triggerAttributes = /* @__PURE__ */ new Map();
    let needsTooltipInit = false;
    let needsPopoverInit = false;
    const irNodeById = /* @__PURE__ */ new Map();
    const indexNode = (node) => {
      irNodeById.set(node.id, node);
      if ("children" in node) for (const child of node.children) indexNode(child);
    };
    for (const node of nodes) indexNode(node);
    const visit = async (node) => {
      var _a, _b, _c, _d, _e, _f;
      if (node.interactions) {
        const className = toClassName(node.id);
        const transitionByProp = /* @__PURE__ */ new Map();
        const stateBlocks = [];
        for (const interaction of node.interactions) {
          const sourceNode = (_a = interaction.sourceId ? sceneNodesById.get(interaction.sourceId) : void 0) != null ? _a : sceneNodesById.get(node.id);
          const sourceCss = (_b = await (sourceNode == null ? void 0 : sourceNode.getCSSAsync())) != null ? _b : {};
          const destNode = sceneNodesById.get(interaction.destinationId);
          const destCss = (_c = await (destNode == null ? void 0 : destNode.getCSSAsync())) != null ? _c : {};
          if (!destNode) {
            console.warn(`"${node.name}" has a ${interaction.trigger} CHANGE_TO interaction targeting "${interaction.destinationId}", which isn't in the exported node set \u2014 skipping`);
            continue;
          }
          const decls = diffCss(sourceCss, destCss);
          if (decls.length === 0) continue;
          for (const d of decls) {
            if (!transitionByProp.has(d.property)) transitionByProp.set(d.property, `${d.property} ${interaction.durationMs}ms ${interaction.timingFunction}`);
          }
          const destBlock = decls.map((d) => `  ${d.property}: ${d.value};`).join("\n");
          if (interaction.trigger === "ON_CLICK") {
            stateBlocks.push(`.${className}.is-active {
${destBlock}
}`);
            jsParts.push(
              `document.querySelectorAll('.${className}').forEach(function (el) { el.addEventListener('click', function () { el.classList.toggle('is-active') }) })`
            );
          } else {
            const pseudo = pseudoClass(interaction.trigger);
            stateBlocks.push(`.${className}:${pseudo} {
${destBlock}
}`);
          }
        }
        if (transitionByProp.size > 0) {
          const base = `.${className} {
  transition:
    ${[...transitionByProp.values()].join(",\n    ")};
}`;
          cssParts.push([base, ...stateBlocks].join("\n"));
        }
      }
      if (node.overlays) {
        const className = toClassName(node.id);
        const dialogs = [];
        for (const overlay of node.overlays) {
          const destNode = sceneNodesById.get(overlay.destinationId);
          if (!destNode) {
            console.warn(`"${node.name}" has an OVERLAY reaction targeting "${overlay.destinationId}", which isn't in the exported node set \u2014 skipping`);
            continue;
          }
          const dialogId = `${className}--overlay-${overlay.destinationId.replace(/[^a-zA-Z0-9]+/g, "-")}`;
          const destComponentName = overlayDestinationComponentName(irNodeById.get(overlay.destinationId));
          if (options.bootstrapModals && (destComponentName === "tooltip" || destComponentName === "popover")) {
            const text2 = escapeHtml(firstTextOf(irNodeById.get(overlay.destinationId)));
            const attr = destComponentName === "tooltip" ? ` data-bs-toggle="tooltip" data-bs-title="${text2}"` : ` data-bs-toggle="popover" data-bs-content="${text2}"`;
            triggerAttributes.set(className, `${(_d = triggerAttributes.get(className)) != null ? _d : ""}${attr}`);
            needsTooltipInit || (needsTooltipInit = destComponentName === "tooltip");
            needsPopoverInit || (needsPopoverInit = destComponentName === "popover");
            continue;
          }
          if (options.bootstrapModals && overlay.trigger === "ON_CLICK") {
            if (destComponentName === "offcanvas") {
              const placement = offcanvasPlacement(irNodeById.get(overlay.destinationId));
              dialogs.push(
                `<div class="offcanvas offcanvas-${placement}" tabindex="-1" id="${dialogId}" aria-hidden="true"><div class="offcanvas-body"></div></div>`
              );
              const existingOc = (_e = triggerAttributes.get(className)) != null ? _e : "";
              triggerAttributes.set(className, `${existingOc} data-bs-toggle="offcanvas" data-bs-target="#${dialogId}"`);
              continue;
            }
            const backdropAttr = overlay.closeInteraction === "CLOSE_ON_CLICK_OUTSIDE" ? "" : ' data-bs-backdrop="static"';
            dialogs.push(
              `<div class="modal fade" id="${dialogId}" tabindex="-1" aria-hidden="true"${backdropAttr}><div class="modal-dialog"><div class="modal-content"></div></div></div>`
            );
            const existing = (_f = triggerAttributes.get(className)) != null ? _f : "";
            triggerAttributes.set(className, `${existing} data-bs-toggle="modal" data-bs-target="#${dialogId}"`);
            continue;
          }
          const backdropCss = overlay.background.type === "SOLID_COLOR" ? `backdrop: rgba(${Math.round(overlay.background.color.r * 255)}, ${Math.round(overlay.background.color.g * 255)}, ${Math.round(overlay.background.color.b * 255)}, ${overlay.background.color.a});` : "";
          const positionStyle = overlay.positionType === "MANUAL" && overlay.relativePosition ? `top: ${overlay.relativePosition.y}px; left: ${overlay.relativePosition.x}px;` : "";
          dialogs.push(
            `<dialog id="${dialogId}" class="${className}--overlay" style="${positionStyle}"></dialog>`
          );
          if (backdropCss) cssParts.push(`#${dialogId}::backdrop { ${backdropCss} }`);
          const event = triggerToEvent(overlay.trigger);
          const closeJs = overlay.closeInteraction === "CLOSE_ON_CLICK_OUTSIDE" ? `
  d.addEventListener('click', (e) => { if (e.target === d) d.close() })` : "";
          jsParts.push(
            `document.querySelectorAll('.${className}').forEach((el) => {
  el.addEventListener('${event}', () => {
    var d = document.getElementById('${dialogId}')
    if (d && typeof d.showModal === 'function') d.showModal()
  })
})`
          );
          if (overlay.closeInteraction === "CLOSE_ON_CLICK_OUTSIDE") {
            jsParts.push(
              `var _d${dialogId.replace(/-/g, "_")} = document.getElementById('${dialogId}')
if (_d${dialogId.replace(/-/g, "_")}) _d${dialogId.replace(/-/g, "_")}.addEventListener('click', function(e) { if (e.target === _d${dialogId.replace(/-/g, "_")}) _d${dialogId.replace(/-/g, "_")}.close() })`
            );
          }
        }
        if (dialogs.length > 0) overlayDialogs.set(node.id, dialogs);
      }
      if ("children" in node) {
        for (const child of node.children) await visit(child);
      }
    };
    for (const node of nodes) await visit(node);
    if (needsTooltipInit) {
      jsParts.push(
        `document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(function (el) { new bootstrap.Tooltip(el) })`
      );
    }
    if (needsPopoverInit) {
      jsParts.push(
        `document.querySelectorAll('[data-bs-toggle="popover"]').forEach(function (el) { new bootstrap.Popover(el) })`
      );
    }
    return {
      css: cssParts.join("\n\n"),
      js: jsParts.join("\n\n"),
      overlayDialogs,
      triggerAttributes
    };
  }
  function firstTextOf(node) {
    if (!node) return "";
    if (node.type === "text" && node.characters.trim() !== "") return node.characters.trim();
    if ("children" in node) {
      for (const child of node.children) {
        if (child.type === "instance-ref") continue;
        const found = firstTextOf(child);
        if (found) return found;
      }
    }
    return "";
  }
  function overlayDestinationComponentName(node) {
    var _a, _b;
    if (!node || !("component" in node) || !node.component) return null;
    const raw = (_a = node.component.setName) != null ? _a : node.name;
    return ((_b = raw.split("/").pop()) != null ? _b : raw).trim().toLowerCase();
  }
  function offcanvasPlacement(node) {
    const placements = ["start", "end", "top", "bottom"];
    if (node && "component" in node && node.component) {
      const prop = node.component.properties.find(
        (p) => p.type === "VARIANT" && p.name.trim().toLowerCase() === "placement"
      );
      const value = prop ? String(prop.defaultValue).trim().toLowerCase() : "";
      if (placements.includes(value)) return value;
    }
    return "start";
  }
  function triggerToEvent(trigger) {
    switch (trigger) {
      case "ON_CLICK":
        return "click";
      case "ON_HOVER":
        return "mouseenter";
      case "ON_PRESS":
        return "mousedown";
      case "MOUSE_UP":
        return "mouseup";
      case "MOUSE_ENTER":
        return "mouseenter";
      case "MOUSE_LEAVE":
        return "mouseleave";
      case "MOUSE_DOWN":
        return "mousedown";
      case "ON_DRAG":
        return "pointerdown";
      case "ON_KEY_DOWN":
        return "keydown";
      case "ON_MEDIA_END":
        return "ended";
      case "ON_MEDIA_HIT":
        return "timeupdate";
      case "AFTER_TIMEOUT":
        return "click";
    }
  }

  // src/targets/django/bootstrap/utilities.ts
  var SPACING_SUFFIX = {
    "0": "0",
    "0px": "0",
    "4px": "1",
    "8px": "2",
    "16px": "3",
    "24px": "4",
    "48px": "5"
  };
  var DISPLAY = {
    flex: "d-flex",
    "inline-flex": "d-inline-flex",
    grid: "d-grid",
    block: "d-block",
    "inline-block": "d-inline-block",
    none: "d-none"
  };
  var FLEX_DIRECTION = {
    row: "flex-row",
    column: "flex-column",
    "row-reverse": "flex-row-reverse",
    "column-reverse": "flex-column-reverse"
  };
  var FLEX_WRAP = {
    wrap: "flex-wrap",
    nowrap: "flex-nowrap",
    "wrap-reverse": "flex-wrap-reverse"
  };
  var JUSTIFY_CONTENT2 = {
    "flex-start": "justify-content-start",
    center: "justify-content-center",
    "flex-end": "justify-content-end",
    "space-between": "justify-content-between",
    "space-around": "justify-content-around",
    "space-evenly": "justify-content-evenly"
  };
  var ALIGN_ITEMS2 = {
    "flex-start": "align-items-start",
    center: "align-items-center",
    "flex-end": "align-items-end",
    stretch: "align-items-stretch",
    baseline: "align-items-baseline"
  };
  var ALIGN_SELF = {
    "flex-start": "align-self-start",
    center: "align-self-center",
    "flex-end": "align-self-end",
    stretch: "align-self-stretch",
    baseline: "align-self-baseline"
  };
  var SIZE = { "25%": "25", "50%": "50", "75%": "75", "100%": "100", auto: "auto" };
  var FONT_WEIGHT = {
    "300": "fw-light",
    "400": "fw-normal",
    "500": "fw-medium",
    "600": "fw-semibold",
    "700": "fw-bold",
    normal: "fw-normal",
    bold: "fw-bold"
  };
  var POSITION = {
    static: "position-static",
    relative: "position-relative",
    absolute: "position-absolute",
    fixed: "position-fixed",
    sticky: "position-sticky"
  };
  var OVERFLOW = {
    hidden: "overflow-hidden",
    auto: "overflow-auto",
    scroll: "overflow-scroll",
    visible: "overflow-visible"
  };
  function spacingSuffix(value) {
    var _a;
    return (_a = SPACING_SUFFIX[value]) != null ? _a : null;
  }
  function sideUtilities(prefix, value) {
    const parts = value.trim().split(/\s+/);
    if (parts.length === 0 || parts.length > 4) return null;
    if (prefix === "m" && parts.some((part) => part.startsWith("-"))) return null;
    const suffixes = parts.map(spacingSuffix);
    if (suffixes.some((suffix) => suffix === null)) return null;
    const [top, right = top, bottom = top, left = right] = suffixes;
    if (top === right && top === bottom && top === left) return [`${prefix}-${top}`];
    if (top === bottom && right === left) return [`${prefix}y-${top}`, `${prefix}x-${right}`];
    return [`${prefix}t-${top}`, `${prefix}e-${right}`, `${prefix}b-${bottom}`, `${prefix}s-${left}`];
  }
  function gapUtilities(value) {
    const parts = value.trim().split(/\s+/);
    if (parts.length === 1) {
      const suffix = spacingSuffix(parts[0]);
      return suffix === null ? null : [`gap-${suffix}`];
    }
    if (parts.length === 2) {
      const [row, column] = parts.map(spacingSuffix);
      if (row === null || column === null) return null;
      return row === column ? [`gap-${row}`] : [`row-gap-${row}`, `column-gap-${column}`];
    }
    return null;
  }
  function declarationUtilities(property, value) {
    switch (property) {
      case "display":
        return DISPLAY[value] ? [DISPLAY[value]] : null;
      case "flex-direction":
        return FLEX_DIRECTION[value] ? [FLEX_DIRECTION[value]] : null;
      case "flex-wrap":
        return FLEX_WRAP[value] ? [FLEX_WRAP[value]] : null;
      case "justify-content":
        return JUSTIFY_CONTENT2[value] ? [JUSTIFY_CONTENT2[value]] : null;
      case "align-items":
        return ALIGN_ITEMS2[value] ? [ALIGN_ITEMS2[value]] : null;
      case "align-self":
        return ALIGN_SELF[value] ? [ALIGN_SELF[value]] : null;
      case "flex-grow":
        return value === "0" || value === "1" ? [`flex-grow-${value}`] : null;
      case "flex-shrink":
        return value === "0" || value === "1" ? [`flex-shrink-${value}`] : null;
      case "gap":
        return gapUtilities(value);
      case "row-gap": {
        const suffix = spacingSuffix(value);
        return suffix === null ? null : [`row-gap-${suffix}`];
      }
      case "column-gap": {
        const suffix = spacingSuffix(value);
        return suffix === null ? null : [`column-gap-${suffix}`];
      }
      case "padding":
        return sideUtilities("p", value);
      case "margin":
        return sideUtilities("m", value);
      case "width":
        return SIZE[value] ? [`w-${SIZE[value]}`] : null;
      case "height":
        return SIZE[value] ? [`h-${SIZE[value]}`] : null;
      case "text-align":
        return value === "center" ? ["text-center"] : value === "justify" ? ["text-justify"] : null;
      case "font-weight":
        return FONT_WEIGHT[value] ? [FONT_WEIGHT[value]] : null;
      case "position":
        return POSITION[value] ? [POSITION[value]] : null;
      case "overflow":
        return OVERFLOW[value] ? [OVERFLOW[value]] : null;
      default:
        return null;
    }
  }
  function propertyFamily(property) {
    if (property === "gap" || property.endsWith("-gap")) return "gap";
    const dash = property.indexOf("-");
    return dash === -1 ? property : property.slice(0, dash);
  }
  function conflictFamily(property) {
    if (property === "overflow" || property.startsWith("overflow-")) return "overflow";
    if (property === "margin" || property.startsWith("margin-")) return "margin";
    if (property === "padding" || property.startsWith("padding-")) return "padding";
    if (property === "gap" || property.endsWith("-gap")) return "gap";
    return property;
  }
  function scanTopLevelBlocks(css) {
    const blocks = [];
    let cursor = 0;
    while (cursor < css.length) {
      const open = css.indexOf("{", cursor);
      if (open === -1) break;
      let depth = 1;
      let index = open + 1;
      while (index < css.length && depth > 0) {
        if (css[index] === "{") depth += 1;
        else if (css[index] === "}") depth -= 1;
        index += 1;
      }
      const prefix = css.slice(cursor, open);
      const afterComment = prefix.lastIndexOf("*/");
      const selector = (afterComment === -1 ? prefix : prefix.slice(afterComment + 2)).trim();
      const selectorStart = selector.length > 0 ? cursor + prefix.lastIndexOf(selector) : open;
      blocks.push({ selector, body: css.slice(open + 1, index - 1), start: selectorStart, end: index });
      cursor = index;
    }
    return blocks;
  }
  var DECLARATION_LINE = /^\s{2}([a-zA-Z-]+):\s(.+);$/;
  function collectProtections(selector, body, protectedFamilies) {
    const classNames = [...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
    if (classNames.length === 0) return;
    for (const line of body.split("\n")) {
      const declaration = DECLARATION_LINE.exec(line);
      if (!declaration) continue;
      for (const className of classNames) {
        let families = protectedFamilies.get(className);
        if (!families) protectedFamilies.set(className, families = /* @__PURE__ */ new Set());
        families.add(propertyFamily(declaration[1]));
      }
    }
  }
  function scanProtections(css, protectedFamilies, topLevelSimpleToo) {
    for (const block2 of scanTopLevelBlocks(css)) {
      if (block2.selector.startsWith("@")) {
        for (const inner of scanTopLevelBlocks(block2.body)) collectProtections(inner.selector, inner.body, protectedFamilies);
        continue;
      }
      if (topLevelSimpleToo || !/^\.[A-Za-z0-9_-]+$/.test(block2.selector)) {
        collectProtections(block2.selector, block2.body, protectedFamilies);
      }
    }
  }
  function appendUtilityClasses(html, utilities) {
    return html.replace(/class="([^"]*)"/g, (full, value) => {
      var _a;
      const tokens = value.split(/\s+/).filter(Boolean);
      const additions = [];
      for (const token2 of tokens) {
        for (const utility of (_a = utilities.get(token2)) != null ? _a : []) {
          if (!tokens.includes(utility) && !additions.includes(utility)) additions.push(utility);
        }
      }
      return additions.length > 0 ? `class="${value} ${additions.join(" ")}"` : full;
    });
  }
  function applyBootstrapUtilities(input) {
    var _a;
    const protectedFamilies = /* @__PURE__ */ new Map();
    scanProtections(input.css, protectedFamilies, false);
    if (input.interactionsCss) scanProtections(input.interactionsCss, protectedFamilies, true);
    const utilities = /* @__PURE__ */ new Map();
    const stats = { extractedDeclarations: 0, keptDeclarations: 0 };
    const pieces = [];
    let position = 0;
    for (const block2 of scanTopLevelBlocks(input.css)) {
      const simple = /^\.([A-Za-z0-9_-]+)$/.exec(block2.selector);
      if (!simple || block2.selector.startsWith("@")) continue;
      const className = simple[1];
      const families = protectedFamilies.get(className);
      const keptFamilies = /* @__PURE__ */ new Set();
      for (const line of block2.body.split("\n")) {
        const declaration = DECLARATION_LINE.exec(line);
        if (!declaration) continue;
        const [, property, value] = declaration;
        const wouldMap = (families == null ? void 0 : families.has(propertyFamily(property))) ? null : declarationUtilities(property, value);
        if (!wouldMap) keptFamilies.add(conflictFamily(property));
      }
      const keptLines = [];
      const extracted = [];
      for (const line of block2.body.split("\n")) {
        if (line.trim() === "") continue;
        const declaration = DECLARATION_LINE.exec(line);
        if (!declaration) {
          keptLines.push(line);
          continue;
        }
        const [, property, value] = declaration;
        const mapped = (families == null ? void 0 : families.has(propertyFamily(property))) || keptFamilies.has(conflictFamily(property)) ? null : declarationUtilities(property, value);
        if (mapped) {
          extracted.push(...mapped.filter((utility) => !extracted.includes(utility)));
          stats.extractedDeclarations += 1;
        } else {
          keptLines.push(line);
          stats.keptDeclarations += 1;
        }
      }
      if (extracted.length === 0) continue;
      const existing = (_a = utilities.get(className)) != null ? _a : [];
      utilities.set(className, [...existing, ...extracted.filter((utility) => !existing.includes(utility))]);
      pieces.push(input.css.slice(position, block2.start));
      pieces.push(keptLines.length > 0 ? `${block2.selector} {
${keptLines.join("\n")}
}` : "");
      position = block2.end;
    }
    pieces.push(input.css.slice(position));
    const css = pieces.join("").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
    const rewrite = (files) => Object.fromEntries(Object.entries(files).map(([path, html]) => [path, appendUtilityClasses(html, utilities)]));
    return { css, pages: rewrite(input.pages), partials: rewrite(input.partials), utilities, stats };
  }

  // src/targets/django/index.ts
  var BASE_HTML_NODE_ID = "base.html";
  async function emitDjango(nodes, sceneNodesById, variableNamesById, opts) {
    const css = await emitCss(nodes, sceneNodesById, variableNamesById);
    const html = emitHtml(nodes, sceneNodesById, opts.cssFile);
    return { html, css };
  }
  async function emitDjangoProject(pageRoots, sceneNodesById, variableNamesById, opts) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    const { rendered, groups } = detectBreakpointGroups(pageRoots, opts.breakpointTokens);
    const components = collectComponents(rendered);
    const registry = buildComponentRegistry(components);
    const overriddenTextNodeIds = collectOverriddenTextNodeIds(rendered, registry);
    const navMap = new Map(rendered.map((root) => [root.id, navMapKey(root.id)]));
    const fileNodeIds = {};
    const bootstrapComponents = ((_a = opts.framework) == null ? void 0 : _a.fidelity) === "components" || ((_b = opts.framework) == null ? void 0 : _b.fidelity) === "theme";
    const partials = {};
    for (const component of components) {
      const path = partialPath(component);
      partials[path] = wrapGenerated(
        component.id,
        emitComponentPartial(
          component,
          sceneNodesById,
          registry,
          (_c = overriddenTextNodeIds.get(component.id)) != null ? _c : /* @__PURE__ */ new Set(),
          navMap,
          bootstrapComponents
        )
      );
      fileNodeIds[path] = component.id;
    }
    const groupSlugByWidestId = new Map(groups.map((group) => [group.frames[0].node.id, group.slug]));
    const pages = {};
    for (const root of rendered) {
      const path = pageTemplatePath(root, groupSlugByWidestId.get(root.id));
      pages[path] = wrapGenerated(root.id, emitPage(root, sceneNodesById, registry, navMap, bootstrapComponents));
      fileNodeIds[path] = root.id;
    }
    const themedInstances = ((_d = opts.framework) == null ? void 0 : _d.fidelity) === "theme" && ((_e = opts.themeSets) == null ? void 0 : _e.length) ? collectThemedInstanceMasters(rendered, opts.themeSets) : void 0;
    let css = await emitCss(rendered, sceneNodesById, variableNamesById, { themedInstances });
    for (const group of groups) {
      const mediaCss = await emitBreakpointCss(group, sceneNodesById, variableNamesById);
      if (mediaCss.length > 0) css += `

${mediaCss}`;
    }
    if (opts.framework) {
      css = `/* Bootstrap bare-.btn state-var safety net \u2014 see emitDjangoProject (P2h). */
:root {
  --bs-btn-active-border-color: transparent;
}

.btn-group > :not(.btn-check:first-child) + .btn {
  margin-left: 0;
}

` + css;
    }
    const {
      css: interactionsCss,
      js: interactionsJs,
      overlayDialogs,
      triggerAttributes
    } = await emitInteractions(rendered, sceneNodesById, { bootstrapModals: bootstrapComponents });
    if (overlayDialogs.size > 0) {
      for (const [nodeId, dialogs] of overlayDialogs) {
        for (const [path, html] of Object.entries(pages)) {
          if (path.includes(nodeId.replace(/[^a-zA-Z0-9]+/g, "-"))) {
            pages[path] = html.replace("{% endblock %}", `  ${dialogs.join("\n  ")}
{% endblock %}`);
          }
        }
      }
    }
    if (triggerAttributes.size > 0) {
      for (const [path, html] of Object.entries(pages)) pages[path] = injectTriggerAttributes(html, triggerAttributes);
      for (const [path, html] of Object.entries(partials)) partials[path] = injectTriggerAttributes(html, triggerAttributes);
    }
    if (opts.framework && (opts.framework.fidelity === "utilities" || opts.framework.fidelity === "components" || opts.framework.fidelity === "theme")) {
      const utilized = applyBootstrapUtilities({ css, interactionsCss, pages, partials });
      css = utilized.css;
      Object.assign(pages, utilized.pages);
      Object.assign(partials, utilized.partials);
    }
    const themeCss = ((_f = opts.framework) == null ? void 0 : _f.fidelity) === "theme" && ((_g = opts.themeSets) == null ? void 0 : _g.length) ? buildBootstrapTheme(opts.themeSets) : "";
    const fontFamilies = [...new Set([...css.matchAll(/font-family: "([^"]+)"/g)].map((match) => match[1]))];
    const baseHtml = wrapGenerated(
      BASE_HTML_NODE_ID,
      emitBaseHtml(
        opts.cssFile,
        (_h = opts.tokensCssFile) != null ? _h : "css/tokens.css",
        fontFamilies,
        __spreadValues({
          interactionsCss: interactionsCss.length > 0,
          interactionsJs: interactionsJs.length > 0
        }, (_i = opts.animationLinks) != null ? _i : { animationsCss: false, animationsJs: false, gsapPlugins: [] }),
        opts.framework ? __spreadProps(__spreadValues({}, opts.framework), { themeCssFile: themeCss.length > 0 ? "css/bootstrap-theme.css" : null }) : null
      )
    );
    fileNodeIds["base.html"] = BASE_HTML_NODE_ID;
    return { baseHtml, pages, partials, css, interactionsCss, interactionsJs, themeCss, fileNodeIds };
  }

  // src/utils/tree.ts
  async function loadAllPagesAsync() {
    await Promise.all(figma.root.children.map((page) => page.loadAsync()));
  }
  var YIELD_EVERY = 500;
  function yieldToHost() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  async function findAllWithCriteria(root, predicate, opts) {
    figma.skipInvisibleInstanceChildren = true;
    try {
      const results = [];
      if ((opts == null ? void 0 : opts.includeRoot) && isSceneNode(root) && predicate(root)) {
        results.push(root);
      }
      let visited = 0;
      const stack = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (hasChildren(node)) {
          for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
        }
        if (node !== root && predicate(node)) results.push(node);
        if (++visited % YIELD_EVERY === 0) await yieldToHost();
      }
      return results;
    } finally {
      figma.skipInvisibleInstanceChildren = false;
    }
  }
  function hasChildren(node) {
    return "children" in node;
  }
  function isSceneNode(node) {
    return node.type !== "DOCUMENT" && node.type !== "PAGE";
  }

  // src/utils/plugin-data.ts
  var NAMESPACE = "altery";
  var MAX_PLUGIN_DATA_BYTES = 1e5;
  function getPluginData(node, key) {
    const raw = node.getSharedPluginData(NAMESPACE, key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  function setPluginData(node, key, value) {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_PLUGIN_DATA_BYTES) {
      throw new Error("pluginData limit 100KB exceeded");
    }
    node.setSharedPluginData(NAMESPACE, key, serialized);
  }

  // src/targets/django/i18n/normalize.ts
  var FIGMA_LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(8232)}${String.fromCharCode(8233)}]`, "g");
  function normalize2(characters) {
    return characters.replace(FIGMA_LINE_SEPARATORS, "\n").replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
  }
  var CONTEXT_SEPARATOR = String.fromCharCode(4);
  function translationKey(msgctxt, characters) {
    return `${msgctxt}${CONTEXT_SEPARATOR}${normalize2(characters)}`;
  }

  // src/targets/django/i18n/extract.ts
  var MARKUP_SEGMENT_FIELDS = ["fontWeight", "hyperlink"];
  function isTextNode(node) {
    return node.type === "TEXT";
  }
  function nodePath(node) {
    const parts = [];
    let cur = node;
    while (cur && cur.type !== "DOCUMENT") {
      parts.unshift(cur.name);
      cur = "parent" in cur ? cur.parent : null;
    }
    return parts.join("/");
  }
  function reference(node) {
    const fileKey = figma.fileKey;
    return `figma://${fileKey != null ? fileKey : ""}?node-id=${node.id} ${nodePath(node)}`;
  }
  function buildMarkup(node) {
    var _a;
    const segments = node.getStyledTextSegments([...MARKUP_SEGMENT_FIELDS]);
    if (segments.length <= 1) return { markup: null, hasInlineStyles: false };
    const baseWeight = Math.min(...segments.map((s) => s.fontWeight));
    let markup = "";
    for (const segment of segments) {
      let chunk = segment.characters;
      if (((_a = segment.hyperlink) == null ? void 0 : _a.type) === "URL") {
        chunk = `<a href="${segment.hyperlink.value}">${chunk}</a>`;
      } else if (segment.fontWeight > baseWeight) {
        chunk = `<strong>${chunk}</strong>`;
      }
      markup += chunk;
    }
    return { markup: normalize2(markup), hasInlineStyles: true };
  }
  async function extractStrings(root) {
    var _a;
    const textNodes = await findAllWithCriteria(root, isTextNode);
    const catalog = /* @__PURE__ */ new Map();
    for (const node of textNodes) {
      const msgid = normalize2(node.characters);
      if (!msgid) continue;
      const key = getPluginData(node, "i18nKey" /* I18N_KEY */);
      const msgctxt = (_a = key == null ? void 0 : key.context) != null ? _a : "";
      const dedupeKey = translationKey(msgctxt, node.characters);
      const existing = catalog.get(dedupeKey);
      if (existing) {
        existing.references.push(reference(node));
        existing.nodeIds.push(node.id);
        if (!existing.comment.includes(node.name)) existing.comment += `; ${node.name}`;
        continue;
      }
      const { markup } = buildMarkup(node);
      catalog.set(dedupeKey, {
        msgid,
        msgctxt,
        markup,
        references: [reference(node)],
        comment: node.name,
        nodeIds: [node.id]
      });
    }
    return [...catalog.values()];
  }

  // src/targets/django/i18n/po.ts
  var HEADER = [
    'msgid ""',
    'msgstr ""',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    '"Content-Transfer-Encoding: 8bit\\n"'
  ].join("\n");
  function escapePoString(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  }
  function quoted(value) {
    return `"${escapePoString(value)}"`;
  }
  function emitEntry(entry) {
    var _a;
    const lines = [];
    if (entry.comment) lines.push(`#. ${entry.comment}`);
    for (const reference2 of entry.references) lines.push(`#: ${reference2}`);
    if (entry.msgctxt) lines.push(`msgctxt ${quoted(entry.msgctxt)}`);
    lines.push(`msgid ${quoted((_a = entry.markup) != null ? _a : entry.msgid)}`);
    lines.push('msgstr ""');
    return lines.join("\n");
  }
  function emitPo(entries) {
    return [HEADER, ...entries.map(emitEntry)].join("\n\n") + "\n";
  }

  // src/targets/django/i18n/annotation.ts
  var PLACEHOLDER_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  function getAnnotation(node) {
    return getPluginData(node, "i18nKey" /* I18N_KEY */);
  }
  function validateAnnotation(annotation, textLength) {
    if (annotation.plural) {
      if (!annotation.plural.one || !annotation.plural.other) {
        throw new Error('plural annotation requires both "one" and "other" forms');
      }
    }
    if (annotation.placeholders) {
      const sorted = [...annotation.placeholders].sort((a, b) => a.start - b.start);
      let cursor = 0;
      for (const ph of sorted) {
        if (!PLACEHOLDER_NAME.test(ph.name)) {
          throw new Error(`invalid placeholder name "${ph.name}"`);
        }
        if (ph.start < 0 || ph.end > textLength || ph.start >= ph.end) {
          throw new Error(`placeholder "${ph.name}" has an out-of-range offset`);
        }
        if (ph.start < cursor) {
          throw new Error(`placeholder "${ph.name}" overlaps a preceding placeholder`);
        }
        cursor = ph.end;
      }
    }
  }
  function setAnnotation(node, annotation) {
    validateAnnotation(annotation, node.characters.length);
    setPluginData(node, "i18nKey" /* I18N_KEY */, annotation);
  }

  // src/targets/django/i18n/keys.ts
  function contextFromVariableName(name) {
    const slash = name.lastIndexOf("/");
    return slash >= 0 ? name.slice(0, slash) : "";
  }
  function applyPlaceholders(text2, placeholders) {
    if (!placeholders || placeholders.length === 0) return text2;
    const sorted = [...placeholders].sort((a, b) => a.start - b.start);
    let result = "";
    let cursor = 0;
    for (const ph of sorted) {
      result += text2.slice(cursor, ph.start);
      result += `%(${ph.name})s`;
      cursor = ph.end;
    }
    result += text2.slice(cursor);
    return result;
  }
  function resolveManualKey(node) {
    var _a;
    const annotation = getAnnotation(node);
    const msgctxt = (_a = annotation == null ? void 0 : annotation.context) != null ? _a : "";
    if (annotation == null ? void 0 : annotation.plural) {
      return {
        msgid: normalize2(annotation.plural.one),
        msgidPlural: normalize2(annotation.plural.other),
        msgctxt,
        source: msgctxt ? "manual" : "text"
      };
    }
    const msgid = applyPlaceholders(normalize2(node.characters), annotation == null ? void 0 : annotation.placeholders);
    return { msgid, msgctxt, source: msgctxt ? "manual" : "text" };
  }
  async function resolveVariableKey(alias, sourceLocale) {
    var _a;
    const variable = await figma.variables.getVariableByIdAsync(alias.id);
    if (!variable || variable.resolvedType !== "STRING") return null;
    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    const mode = (_a = collection == null ? void 0 : collection.modes.find((m) => m.name === sourceLocale)) != null ? _a : collection == null ? void 0 : collection.modes[0];
    const rawValue = mode ? variable.valuesByMode[mode.modeId] : void 0;
    return {
      msgid: typeof rawValue === "string" ? normalize2(rawValue) : "",
      msgctxt: contextFromVariableName(variable.name),
      source: "variable",
      variableName: variable.name
    };
  }
  async function resolveKey(node, options = {}) {
    var _a, _b;
    const alias = (_a = node.boundVariables) == null ? void 0 : _a.characters;
    if (alias) {
      const variableKey = await resolveVariableKey(alias, (_b = options.sourceLocale) != null ? _b : "en");
      if (variableKey) return variableKey;
    }
    return resolveManualKey(node);
  }

  // src/targets/django/i18n/import.ts
  var NODE_ID_REFERENCE = /figma:\/\/[^?]*\?node-id=([^\s]+)/;
  function unescapePoString(raw) {
    return raw.replace(/\\(.)/g, (_, ch) => {
      switch (ch) {
        case "n":
          return "\n";
        case "t":
          return "	";
        case '"':
          return '"';
        case "\\":
          return "\\";
        default:
          return ch;
      }
    });
  }
  function parseQuoted(line) {
    const match = line.match(/"((?:[^"\\]|\\.)*)"/);
    return match ? unescapePoString(match[1]) : "";
  }
  function parsePoBlock(block2) {
    const lines = block2.split("\n");
    let msgctxt = "";
    let msgid = "";
    let msgstr = "";
    let nodeId;
    let field = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (trimmed.startsWith("#:")) {
        const ref = trimmed.match(NODE_ID_REFERENCE);
        if (ref) nodeId = ref[1];
        field = null;
        continue;
      }
      if (trimmed.startsWith("#")) {
        field = null;
        continue;
      }
      if (trimmed.startsWith("msgctxt ")) {
        msgctxt = parseQuoted(trimmed);
        field = "msgctxt";
        continue;
      }
      if (trimmed.startsWith("msgid_plural")) {
        field = null;
        continue;
      }
      if (trimmed.startsWith("msgid ")) {
        msgid = parseQuoted(trimmed);
        field = "msgid";
        continue;
      }
      if (trimmed.startsWith("msgstr[")) {
        field = null;
        continue;
      }
      if (trimmed.startsWith("msgstr ")) {
        msgstr = parseQuoted(trimmed);
        field = "msgstr";
        continue;
      }
      if (trimmed.startsWith('"') && field) {
        const continuation = parseQuoted(trimmed);
        if (field === "msgctxt") msgctxt += continuation;
        else if (field === "msgid") msgid += continuation;
        else msgstr += continuation;
      }
    }
    if (msgid === "" && msgctxt === "") return null;
    return { nodeId, msgctxt, msgid, msgstr };
  }
  function parsePo(content) {
    return content.split(/\r?\n\s*\r?\n/).map(parsePoBlock).filter((entry) => entry !== null);
  }
  function parseJson(content) {
    const data = JSON.parse(content);
    return Object.entries(data).map(([msgctxt, msgstr]) => ({ msgctxt, msgid: "", msgstr }));
  }
  function parseTranslations(content, format) {
    return format === "po" ? parsePo(content) : parseJson(content);
  }

  // src/targets/django/i18n/node-index.ts
  function buildNodeIndex(textNodes) {
    var _a;
    const byNodeId = /* @__PURE__ */ new Map();
    const byContext = /* @__PURE__ */ new Map();
    const byText = /* @__PURE__ */ new Map();
    for (const node of textNodes) {
      byNodeId.set(node.id, node);
      const key = getPluginData(node, "i18nKey" /* I18N_KEY */);
      const context = (_a = key == null ? void 0 : key.context) != null ? _a : "";
      if (context) byContext.set(context, node);
      byText.set(translationKey(context, node.characters), node);
    }
    return { byNodeId, byContext, byText };
  }

  // src/targets/django/i18n/apply.ts
  function resolveNode(entry, index) {
    if (entry.nodeId) {
      const byId = index.byNodeId.get(entry.nodeId);
      if (byId) return byId;
    }
    if (entry.msgctxt) {
      const byContext = index.byContext.get(entry.msgctxt);
      if (byContext) return byContext;
    }
    if (entry.msgid) {
      return index.byText.get(translationKey(entry.msgctxt, entry.msgid));
    }
    return void 0;
  }
  async function applyTranslations(entries, index) {
    const applied = [];
    const skipped = [];
    for (const entry of entries) {
      const node = resolveNode(entry, index);
      if (!node) {
        skipped.push({ entry, reason: "not-found" });
        continue;
      }
      if (node.hasMissingFont) {
        skipped.push({ entry, reason: "missing-font" });
        continue;
      }
      const fonts = node.getRangeAllFontNames(0, node.characters.length);
      await Promise.all(fonts.map((font) => figma.loadFontAsync(font)));
      if (getPluginData(node, "i18nOriginal" /* I18N_ORIGINAL */) === null) {
        setPluginData(node, "i18nOriginal" /* I18N_ORIGINAL */, node.characters);
      }
      node.characters = entry.msgstr;
      applied.push({ nodeId: node.id, node });
    }
    return { applied, skipped };
  }

  // src/targets/django/i18n/overflow-report.ts
  function isAutoLayoutFrame(node) {
    return !!node && "layoutMode" in node && node.layoutMode !== "NONE";
  }
  function findAutoLayoutParent(node) {
    let cur = node.parent;
    while (cur) {
      if (isAutoLayoutFrame(cur)) return cur;
      cur = "parent" in cur ? cur.parent : null;
    }
    return null;
  }
  function hasFixedWidth(parent) {
    return parent.layoutMode === "HORIZONTAL" ? parent.primaryAxisSizingMode === "FIXED" : parent.counterAxisSizingMode === "FIXED";
  }
  function detectOverflows(nodes) {
    const reports = [];
    for (const node of nodes) {
      const parent = findAutoLayoutParent(node);
      if (!parent || !hasFixedWidth(parent)) continue;
      const nodeBox = node.absoluteBoundingBox;
      const parentBox = parent.absoluteBoundingBox;
      if (!nodeBox || !parentBox) continue;
      const expected = parent.width;
      const actual = nodeBox.x + nodeBox.width - parentBox.x;
      if (actual > expected) {
        reports.push({ nodeId: node.id, nodeName: node.name, expected, actual });
      }
    }
    return reports;
  }

  // src/targets/django/i18n/index.ts
  async function importTranslations(content, format, textNodes) {
    const entries = parseTranslations(content, format);
    const index = buildNodeIndex(textNodes);
    const { applied, skipped } = await applyTranslations(entries, index);
    const overflows = detectOverflows(applied.map((a) => a.node));
    return { applied, skipped, overflows };
  }

  // src/targets/django/export/assets.ts
  function collectAssetTargets(nodes) {
    const leaves2 = [];
    const fills = [];
    const videoFills = [];
    const masks = [];
    const visit = (node) => {
      var _a, _b, _c;
      if (node.type === "image") {
        leaves2.push({
          id: node.id,
          type: "image",
          assetSrc: node.assetSrc,
          posterSrc: node.posterSrc,
          inline: false,
          imageHash: (_a = node.imageHash) != null ? _a : void 0,
          unavailable: node.videoUnavailable === true
        });
      } else if (node.type === "vector") {
        leaves2.push({ id: node.id, type: "vector", assetSrc: node.assetSrc, inline: node.inlineSvg != null });
      } else if (node.type === "container" || node.type === "instance-ref") {
        for (const bg of (_b = node.backgroundImages) != null ? _b : []) {
          fills.push({
            nodeId: node.id,
            name: node.name,
            imageHash: bg.imageHash,
            filename: bg.assetSrc.replace(/^img\//, "")
          });
        }
        if (node.backgroundVideo) {
          videoFills.push({
            nodeId: node.id,
            name: node.name,
            filename: node.backgroundVideo.assetSrc.replace(/^img\//, ""),
            posterFilename: node.backgroundVideo.posterSrc.replace(/^img\//, ""),
            unavailable: node.backgroundVideo.videoUnavailable === true
          });
        }
        if (node.type === "container" && ((_c = node.mask) == null ? void 0 : _c.kind) === "image") {
          masks.push({ nodeId: node.mask.nodeId, filename: node.mask.assetSrc.replace(/^img\//, "") });
        }
        node.children.forEach(visit);
      }
    };
    nodes.forEach(visit);
    return { leaves: leaves2, fills, videoFills, masks };
  }
  async function annotateVectorLeaves(nodes, sceneNodesById, inlineThresholdBytes = DEFAULT_VECTOR_INLINE_THRESHOLD_BYTES) {
    const visit = async (node) => {
      if (node.type === "container" || node.type === "instance-ref") {
        for (const child of node.children) await visit(child);
        return;
      }
      if (node.type !== "vector" || node.assetSrc != null || node.inlineSvg != null) return;
      const source = sceneNodesById.get(node.id);
      if (!source) return;
      try {
        const asset = await exportVectorAsset(source, inlineThresholdBytes);
        if (asset.kind === "inline") node.inlineSvg = asset.svg;
        else node.assetSrc = `img/${asset.filename}`;
      } catch (error) {
        console.warn(
          `[export] vector "${source.name}" (${source.id}) failed to export \u2014 left as a placeholder:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    };
    for (const node of nodes) await visit(node);
  }
  async function annotateVideoFills(nodes, sceneNodesById) {
    const videoBytesById = /* @__PURE__ */ new Map();
    const probe = async (nodeId, markUnavailable) => {
      const source = sceneNodesById.get(nodeId);
      if (!source) return;
      try {
        videoBytesById.set(nodeId, await source.exportAsync({ format: "MP4" }));
      } catch (error) {
        markUnavailable();
        console.warn(
          `[export] video "${source.name}" (${source.id}) failed to export \u2014 poster only, .mp4 goes to manualAssets:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    };
    const visit = async (node) => {
      var _a;
      if (node.type === "image" && ((_a = node.assetSrc) == null ? void 0 : _a.endsWith(".mp4")) && !node.videoUnavailable) {
        await probe(node.id, () => {
          node.videoUnavailable = true;
        });
        return;
      }
      if (node.type !== "container" && node.type !== "instance-ref") return;
      const bv = node.backgroundVideo;
      if (bv && !bv.videoUnavailable) {
        await probe(node.id, () => {
          bv.videoUnavailable = true;
        });
      }
      for (const child of node.children) await visit(child);
    };
    for (const node of nodes) await visit(node);
    return videoBytesById;
  }
  function collectManualAssets(nodes) {
    const out = [];
    const visit = (node) => {
      var _a;
      if (node.type === "image" && node.videoUnavailable && node.assetSrc) {
        out.push({ nodeId: node.id, assetSrc: node.assetSrc });
      }
      if (node.type !== "container" && node.type !== "instance-ref") return;
      if ((_a = node.backgroundVideo) == null ? void 0 : _a.videoUnavailable) {
        out.push({ nodeId: node.id, assetSrc: node.backgroundVideo.assetSrc });
      }
      node.children.forEach(visit);
    };
    nodes.forEach(visit);
    return out;
  }
  function toExportAssets(assets) {
    return assets.map((asset) => ({ filename: asset.filename, content: asset.bytes }));
  }
  async function collectExportAssets(nodes, sceneNodesById, getImageByHash, videoBytesById, inlineThresholdBytes = DEFAULT_VECTOR_INLINE_THRESHOLD_BYTES) {
    var _a, _b, _c;
    const { leaves: leaves2, fills, videoFills, masks } = collectAssetTargets(nodes);
    const assets = [];
    const warnSkipped = (source, error) => console.warn(
      `[export] asset "${source.name}" (${source.id}) failed to export \u2014 skipped:`,
      error instanceof Error ? error.message : String(error)
    );
    for (const leaf of leaves2) {
      const source = sceneNodesById.get(leaf.id);
      if (!source) continue;
      if (leaf.inline) continue;
      try {
        const designerSettings = await resolveExportSettings(source);
        if (designerSettings.length > 0) {
          assets.push(...await exportDesignerAssets(source, designerSettings));
        } else if ((_a = leaf.assetSrc) == null ? void 0 : _a.endsWith(".mp4")) {
          const cached = videoBytesById == null ? void 0 : videoBytesById.get(leaf.id);
          if (cached) {
            assets.push({ filename: leaf.assetSrc.replace(/^img\//, ""), content: cached });
          } else if (!leaf.unavailable) {
            try {
              const bytes = await source.exportAsync({ format: "MP4" });
              assets.push({ filename: leaf.assetSrc.replace(/^img\//, ""), content: bytes });
            } catch (mp4Error) {
              assets.push(...toExportAssets(await exportRasterAsset(source)));
            }
          }
          if (leaf.posterSrc) {
            try {
              const posterBytes = await source.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
              assets.push({ filename: leaf.posterSrc.replace(/^img\//, ""), content: posterBytes });
            } catch (posterError) {
              console.warn(`[export] poster for "${source.name}" (${source.id}) failed \u2014 skipped:`, posterError instanceof Error ? posterError.message : String(posterError));
            }
          }
        } else if (leaf.type === "image" && leaf.imageHash && leaf.assetSrc && !leaf.assetSrc.endsWith(".png")) {
          const image = (_b = getImageByHash == null ? void 0 : getImageByHash(leaf.imageHash)) != null ? _b : null;
          if (image) assets.push({ filename: leaf.assetSrc.replace(/^img\//, ""), content: await image.getBytesAsync() });
        } else if (leaf.type === "image") {
          assets.push(...toExportAssets(await exportRasterAsset(source)));
        } else {
          const asset = await exportVectorAsset(source, leaf.assetSrc ? 0 : inlineThresholdBytes);
          if (asset.kind === "file") assets.push({ filename: asset.filename, content: asset.svg });
        }
      } catch (error) {
        warnSkipped(source, error);
      }
    }
    for (const mask of masks) {
      const source = sceneNodesById.get(mask.nodeId);
      if (!source) continue;
      try {
        const svg = await source.exportAsync({ format: "SVG_STRING" });
        assets.push({ filename: mask.filename, content: svg });
      } catch (error) {
        warnSkipped(source, error);
      }
    }
    for (const fill of fills) {
      const image = (_c = getImageByHash == null ? void 0 : getImageByHash(fill.imageHash)) != null ? _c : null;
      if (!image) continue;
      try {
        assets.push({ filename: fill.filename, content: await image.getBytesAsync() });
      } catch (error) {
        warnSkipped({ id: fill.nodeId, name: fill.name }, error);
      }
    }
    for (const vf of videoFills) {
      const source = sceneNodesById.get(vf.nodeId);
      if (!source) continue;
      const cached = videoBytesById == null ? void 0 : videoBytesById.get(vf.nodeId);
      if (cached) {
        assets.push({ filename: vf.filename, content: cached });
      } else if (!vf.unavailable) {
        try {
          const bytes = await source.exportAsync({ format: "MP4" });
          assets.push({ filename: vf.filename, content: bytes });
        } catch (mp4Error) {
          try {
            assets.push(...toExportAssets(await exportRasterAsset(source)));
          } catch (fallbackError) {
            warnSkipped({ id: vf.nodeId, name: vf.name }, fallbackError);
          }
        }
      }
      try {
        const posterBytes = await source.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
        assets.push({ filename: vf.posterFilename, content: posterBytes });
      } catch (posterError) {
        console.warn(`[export] poster for "${vf.name}" (${vf.nodeId}) failed \u2014 skipped:`, posterError instanceof Error ? posterError.message : String(posterError));
      }
    }
    return assets;
  }

  // src/targets/django/export/file-tree.ts
  function buildExportTree(opts) {
    var _a, _b, _c;
    const files = {};
    files["templates/base.html"] = opts.project.baseHtml;
    for (const [path, html] of Object.entries(opts.project.pages)) files[`templates/${path}`] = html;
    for (const [path, html] of Object.entries(opts.project.partials)) files[`templates/${path}`] = html;
    files["static/css/tokens.css"] = opts.tokensCss;
    files[`static/${opts.cssFile}`] = opts.project.css;
    if (opts.project.interactionsCss) files["static/css/interactions.css"] = opts.project.interactionsCss;
    if (opts.project.interactionsJs) files["static/js/interactions.js"] = opts.project.interactionsJs;
    if (opts.project.themeCss) files["static/css/bootstrap-theme.css"] = opts.project.themeCss;
    if ((_a = opts.animation) == null ? void 0 : _a.css) files["static/css/animations.css"] = opts.animation.css;
    if ((_b = opts.animation) == null ? void 0 : _b.js) files["static/js/animations.js"] = opts.animation.js;
    for (const asset of (_c = opts.assets) != null ? _c : []) files[`static/img/${asset.filename}`] = asset.content;
    if (opts.po) files["locale/figma.po"] = opts.po;
    return files;
  }
  function buildRegenStaticFiles(opts) {
    const files = {};
    if (opts.tokensCss) files["static/css/tokens.css"] = opts.tokensCss;
    if (opts.bootstrapTokensCss) files["static/css/bootstrap-tokens.css"] = opts.bootstrapTokensCss;
    if (opts.themeCss) files["static/css/bootstrap-theme.css"] = opts.themeCss;
    if (opts.interactionsCss) files["static/css/interactions.css"] = opts.interactionsCss;
    if (opts.interactionsJs) files["static/js/interactions.js"] = opts.interactionsJs;
    return files;
  }

  // src/targets/django/export/report.ts
  function buildExportReport(input) {
    return JSON.stringify(input, null, 2) + "\n";
  }

  // src/targets/django/lint/index.ts
  var DEFAULT_MAX_NESTING_DEPTH = 8;
  function paintStyleSet(styleId) {
    return styleId !== void 0 && styleId !== "";
  }
  function paintBound(paint) {
    var _a;
    return Boolean((_a = paint.boundVariables) == null ? void 0 : _a.color);
  }
  function hasChildren2(node) {
    return "children" in node;
  }
  function startsNewTemplateFile(node) {
    return node.type === "INSTANCE" || node.type === "COMPONENT";
  }
  function checkNodeShallow(node, depth, findings, maxDepth) {
    var _a, _b;
    if (depth > maxDepth) {
      findings.push({
        nodeId: node.id,
        nodeName: node.name,
        rule: "excessive-nesting",
        message: `Nesting depth ${depth} exceeds ${maxDepth} in one template \u2014 flatten wrapper layers`
      });
    }
    if (node.type === "FRAME" && node.layoutMode === "NONE") {
      findings.push({
        nodeId: node.id,
        nodeName: node.name,
        rule: "missing-auto-layout",
        message: "Frame has no Auto Layout \u2014 children will export with absolute positioning"
      });
    }
    if ("fills" in node && Array.isArray(node.fills) && !paintStyleSet(node.fillStyleId)) {
      const boundFills = "boundVariables" in node ? (_a = node.boundVariables) == null ? void 0 : _a.fills : void 0;
      const hasUnboundSolidFill = node.fills.some(
        (fill, index) => fill.type === "SOLID" && fill.visible !== false && !paintBound(fill) && !(boundFills == null ? void 0 : boundFills[index])
      );
      if (hasUnboundSolidFill) {
        findings.push({
          nodeId: node.id,
          nodeName: node.name,
          rule: "unbound-fill",
          message: "Solid fill is not bound to a color variable"
        });
      }
    }
    if ("strokes" in node && Array.isArray(node.strokes) && !paintStyleSet(node.strokeStyleId)) {
      const boundStrokes = "boundVariables" in node ? (_b = node.boundVariables) == null ? void 0 : _b.strokes : void 0;
      const hasUnboundSolidStroke = node.strokes.some(
        (stroke, index) => stroke.type === "SOLID" && stroke.visible !== false && !paintBound(stroke) && !(boundStrokes == null ? void 0 : boundStrokes[index])
      );
      if (hasUnboundSolidStroke) {
        findings.push({
          nodeId: node.id,
          nodeName: node.name,
          rule: "unbound-stroke",
          message: "Solid stroke is not bound to a color variable"
        });
      }
    }
    if (node.type === "TEXT" && node.textStyleId === "") {
      findings.push({
        nodeId: node.id,
        nodeName: node.name,
        rule: "text-without-style",
        message: "Text node has no text style applied"
      });
    }
    checkBootstrapComponentNaming(node, findings);
  }
  function checkBootstrapComponentNaming(node, findings) {
    var _a, _b;
    const isSet = node.type === "COMPONENT_SET";
    const isLoneComponent = node.type === "COMPONENT" && ((_a = node.parent) == null ? void 0 : _a.type) !== "COMPONENT_SET";
    if (!isSet && !isLoneComponent) return;
    if (!isBootstrapComponentName(node.name) || !wantsVariantProp(node.name)) return;
    let variantPropNames = [];
    try {
      const definitions = (_b = node.componentPropertyDefinitions) != null ? _b : {};
      variantPropNames = Object.entries(definitions).filter(([, def]) => def.type === "VARIANT").map(([rawName]) => rawName.split("#")[0].trim().toLowerCase());
    } catch (e) {
      return;
    }
    if (variantPropNames.some((name) => VARIANT_PROP_NAMES.includes(name))) return;
    findings.push({
      nodeId: node.id,
      nodeName: node.name,
      rule: "bootstrap-component-mismatch",
      message: `Named like a Bootstrap component but no variant prop (${VARIANT_PROP_NAMES.join("/")}) was found \u2014 it will export as a custom partial, not native Bootstrap markup`
    });
  }
  async function instanceOfExportedComponent(instance, cache) {
    let main = null;
    try {
      main = await instance.getMainComponentAsync();
    } catch (e) {
      return false;
    }
    if (!main) return false;
    const cached = cache.get(main.id);
    if (cached !== void 0) return cached;
    const flagged = isExportedGraphic(main);
    cache.set(main.id, flagged);
    return flagged;
  }
  async function lintScopeAsync(roots, options = {}) {
    var _a;
    const maxDepth = (_a = options.maxNestingDepth) != null ? _a : DEFAULT_MAX_NESTING_DEPTH;
    const YIELD_EVERY2 = 500;
    const findings = [];
    let visited = 0;
    const exportedMainCache = /* @__PURE__ */ new Map();
    const stack = [];
    for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], depth: 0 });
    while (stack.length > 0) {
      const { node, depth } = stack.pop();
      if (isExportedGraphic(node)) continue;
      if (node.type === "INSTANCE" && await instanceOfExportedComponent(node, exportedMainCache)) continue;
      checkNodeShallow(node, depth, findings, maxDepth);
      if (hasChildren2(node)) {
        const childDepth = startsNewTemplateFile(node) ? 0 : depth + 1;
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push({ node: node.children[i], depth: childDepth });
        }
      }
      if (++visited % YIELD_EVERY2 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return findings;
  }

  // src/targets/django/lint/fix.ts
  var FIX_COLLECTION_NAME = "Lint fixes";
  async function buildFixContext(progress2) {
    return {
      colorVariables: await figma.variables.getLocalVariablesAsync("COLOR"),
      libraryColorVariables: null,
      colorCandidates: null,
      collectionDefaultMode: /* @__PURE__ */ new Map(),
      textStyles: await figma.getLocalTextStylesAsync(),
      remoteTextStyles: null,
      fixCollection: null,
      boundPaintKeys: /* @__PURE__ */ new Set(),
      progress: progress2
    };
  }
  function enclosingInstance(node) {
    let current = node.parent;
    while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
      if (current.type === "INSTANCE") return current;
      current = current.parent;
    }
    return null;
  }
  function mainComponentSubId(nodeId) {
    const index = nodeId.lastIndexOf(";");
    return index === -1 ? null : nodeId.slice(index + 1);
  }
  async function resolveEditableTarget(node) {
    const instance = enclosingInstance(node);
    if (!instance) return { kind: "node", node, onMainComponent: false };
    const main = await instance.getMainComponentAsync();
    if (!main || main.remote) return { kind: "library" };
    const subId = mainComponentSubId(node.id);
    if (subId) {
      const counterpart = await figma.getNodeByIdAsync(subId);
      if (counterpart && counterpart.type !== "PAGE" && counterpart.type !== "DOCUMENT") {
        return { kind: "node", node: counterpart, onMainComponent: true };
      }
    }
    return { kind: "library" };
  }
  function colorsMatch(a, b, epsilon = 1e-3) {
    const alphaOf = (c) => "a" in c ? c.a : 1;
    return Math.abs(a.r - b.r) <= epsilon && Math.abs(a.g - b.g) <= epsilon && Math.abs(a.b - b.b) <= epsilon && Math.abs(alphaOf(a) - alphaOf(b)) <= epsilon;
  }
  function srgbToLab({ r, g, b }) {
    const linear = (c) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
    const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
    const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
    const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
    const f = (t) => t > 8856e-6 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const [fx, fy, fz] = [f(x), f(y), f(z)];
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }
  function colorDeltaE(a, b) {
    const labA = srgbToLab(a);
    const labB = srgbToLab(b);
    return Math.hypot(labA.L - labB.L, labA.a - labB.a, labA.b - labB.b);
  }
  var SNAP_DELTA_E = 2;
  var SNAP_ALPHA_EPSILON = 0.01;
  function channelToHex2(channel) {
    return Math.round(channel * 255).toString(16).padStart(2, "0");
  }
  function cssHex(color) {
    return `#${channelToHex2(color.r)}${channelToHex2(color.g)}${channelToHex2(color.b)}`;
  }
  function autoVariableName(color) {
    const hex = `${channelToHex2(color.r)}${channelToHex2(color.g)}${channelToHex2(color.b)}`;
    return color.a >= 1 ? `auto/${hex}` : `auto/${hex}-a${Math.round(color.a * 100)}`;
  }
  function sortedIndices(rects, axis) {
    return rects.map((_, i) => i).sort((a, b) => rects[a][axis] - rects[b][axis]);
  }
  function nonOverlapping(rects, order, axis) {
    const size = axis === "x" ? "width" : "height";
    for (let i = 1; i < order.length; i++) {
      const prev = rects[order[i - 1]];
      if (rects[order[i]][axis] < prev[axis] + prev[size] - 1) return false;
    }
    return true;
  }
  function medianGap(rects, order, axis) {
    const size = axis === "x" ? "width" : "height";
    const gaps = [];
    for (let i = 1; i < order.length; i++) {
      const prev = rects[order[i - 1]];
      gaps.push(rects[order[i]][axis] - (prev[axis] + prev[size]));
    }
    if (gaps.length === 0) return 0;
    gaps.sort((a, b) => a - b);
    return Math.max(0, Math.round(gaps[Math.floor(gaps.length / 2)]));
  }
  function predictedRects(children, frameWidth, frameHeight, layout) {
    const horizontal = layout.layoutMode === "HORIZONTAL";
    const innerStart = horizontal ? layout.paddingTop : layout.paddingLeft;
    const innerSize = horizontal ? frameHeight - layout.paddingTop - layout.paddingBottom : frameWidth - layout.paddingLeft - layout.paddingRight;
    const out = children.map((rect) => __spreadValues({}, rect));
    let primary = horizontal ? layout.paddingLeft : layout.paddingTop;
    for (const index of layout.order) {
      const child = children[index];
      const childCross = horizontal ? child.height : child.width;
      const cross = layout.counterAlign === "MIN" ? innerStart : layout.counterAlign === "CENTER" ? innerStart + (innerSize - childCross) / 2 : innerStart + innerSize - childCross;
      out[index] = horizontal ? { x: primary, y: cross, width: child.width, height: child.height } : { x: cross, y: primary, width: child.width, height: child.height };
      primary += (horizontal ? child.width : child.height) + layout.itemSpacing;
    }
    return out;
  }
  function autoLayoutDrift(children, frameWidth, frameHeight, layout) {
    const predicted = predictedRects(children, frameWidth, frameHeight, layout);
    let max = 0;
    for (let i = 0; i < children.length; i++) {
      max = Math.max(max, Math.abs(predicted[i].x - children[i].x), Math.abs(predicted[i].y - children[i].y));
    }
    return max;
  }
  var AUTO_LAYOUT_DRIFT_TOLERANCE = 2;
  function inferAutoLayout(children, frameWidth, frameHeight) {
    if (children.length === 0) {
      return { layoutMode: "VERTICAL", itemSpacing: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0, counterAlign: "MIN", order: [] };
    }
    const byX = sortedIndices(children, "x");
    const byY = sortedIndices(children, "y");
    const rowFits = nonOverlapping(children, byX, "x");
    const columnFits = nonOverlapping(children, byY, "y");
    if (!rowFits && !columnFits) return null;
    let layoutMode;
    if (rowFits && columnFits) {
      const spanX = Math.max(...children.map((r) => r.x + r.width)) - Math.min(...children.map((r) => r.x));
      const spanY = Math.max(...children.map((r) => r.y + r.height)) - Math.min(...children.map((r) => r.y));
      layoutMode = spanX > spanY ? "HORIZONTAL" : "VERTICAL";
    } else {
      layoutMode = rowFits ? "HORIZONTAL" : "VERTICAL";
    }
    const axis = layoutMode === "HORIZONTAL" ? "x" : "y";
    const order = layoutMode === "HORIZONTAL" ? byX : byY;
    const minX = Math.min(...children.map((r) => r.x));
    const minY = Math.min(...children.map((r) => r.y));
    const maxRight = Math.max(...children.map((r) => r.x + r.width));
    const maxBottom = Math.max(...children.map((r) => r.y + r.height));
    const base = {
      layoutMode,
      itemSpacing: medianGap(children, order, axis),
      paddingLeft: Math.max(0, Math.round(minX)),
      paddingTop: Math.max(0, Math.round(minY)),
      paddingRight: Math.max(0, Math.round(frameWidth - maxRight)),
      paddingBottom: Math.max(0, Math.round(frameHeight - maxBottom)),
      counterAlign: "MIN",
      order
    };
    let best = base;
    let bestDrift = autoLayoutDrift(children, frameWidth, frameHeight, base);
    for (const counterAlign of ["CENTER", "MAX"]) {
      const variant2 = __spreadProps(__spreadValues({}, base), { counterAlign });
      const drift = autoLayoutDrift(children, frameWidth, frameHeight, variant2);
      if (drift < bestDrift - 0.5) {
        best = variant2;
        bestDrift = drift;
      }
    }
    return best;
  }
  function scopeAllows(scopes, usage, nodeType) {
    if (scopes.length === 0 || scopes.includes("ALL_SCOPES")) return true;
    if (usage === "stroke") return scopes.includes("STROKE_COLOR");
    if (scopes.includes("ALL_FILLS")) return true;
    if (nodeType === "TEXT") return scopes.includes("TEXT_FILL");
    if (nodeType === "FRAME" || nodeType === "COMPONENT" || nodeType === "INSTANCE" || nodeType === "SECTION") {
      return scopes.includes("FRAME_FILL");
    }
    return scopes.includes("SHAPE_FILL");
  }
  async function defaultModeOf(collectionId, ctx) {
    var _a, _b;
    const cached = ctx.collectionDefaultMode.get(collectionId);
    if (cached !== void 0) return cached;
    let modeId = null;
    try {
      modeId = (_b = (_a = await figma.variables.getVariableCollectionByIdAsync(collectionId)) == null ? void 0 : _a.defaultModeId) != null ? _b : null;
    } catch (e) {
    }
    ctx.collectionDefaultMode.set(collectionId, modeId);
    return modeId;
  }
  async function toColorCandidate(variable, library, ctx) {
    var _a, _b;
    const valueByMode = /* @__PURE__ */ new Map();
    for (const modeId of Object.keys(variable.valuesByMode)) {
      try {
        const { value } = await resolveVariableValue(variable, modeId);
        if (typeof value === "object" && value !== null && "r" in value) {
          const color = value;
          valueByMode.set(modeId, __spreadProps(__spreadValues({}, color), { a: "a" in color ? color.a : 1 }));
        }
      } catch (e) {
      }
    }
    if (valueByMode.size === 0) return null;
    return {
      variable,
      library,
      hidden: variable.hiddenFromPublishing === true,
      scopes: (_a = variable.scopes) != null ? _a : [],
      collectionId: variable.variableCollectionId,
      defaultModeId: (_b = await defaultModeOf(variable.variableCollectionId, ctx)) != null ? _b : [...valueByMode.keys()][0],
      valueByMode
    };
  }
  async function loadColorCandidates(ctx) {
    var _a;
    if (ctx.colorCandidates) return ctx.colorCandidates;
    const pool = [];
    const sources = [
      ...(await loadLibraryColorVariables(ctx)).map((variable) => [variable, true]),
      ...ctx.colorVariables.map((variable) => [variable, false])
    ];
    for (let i = 0; i < sources.length; i++) {
      const [variable, library] = sources[i];
      const candidate = await toColorCandidate(variable, library, ctx);
      if (candidate) pool.push(candidate);
      if ((i + 1) % 100 === 0) {
        (_a = ctx.progress) == null ? void 0 : _a.call(ctx, `preparing token matches\u2026 ${i + 1}/${sources.length}`);
        await yieldToHost();
      }
    }
    ctx.colorCandidates = pool;
    return pool;
  }
  function candidateValueFor(candidate, consumer) {
    var _a, _b;
    const modes = consumer.resolvedVariableModes;
    const modeId = (_a = modes == null ? void 0 : modes[candidate.collectionId]) != null ? _a : candidate.defaultModeId;
    return (_b = candidate.valueByMode.get(modeId)) != null ? _b : candidate.valueByMode.get(candidate.defaultModeId);
  }
  function pickColorCandidate(pool, color, consumer, usage) {
    let best = null;
    for (const candidate of pool) {
      const value = candidateValueFor(candidate, consumer);
      if (!value || !colorsMatch(value, color)) continue;
      const tier = (scopeAllows(candidate.scopes, usage, consumer.type) ? 0 : 2) + (candidate.hidden ? 1 : 0);
      if (tier === 0) return { variable: candidate.variable, library: candidate.library };
      if (!best || tier < best.tier) best = { candidate, tier };
    }
    if (best) return { variable: best.candidate.variable, library: best.candidate.library };
    let near = null;
    for (const candidate of pool) {
      const value = candidateValueFor(candidate, consumer);
      if (!value || Math.abs(value.a - color.a) > SNAP_ALPHA_EPSILON) continue;
      const delta = colorDeltaE(value, color);
      if (delta > SNAP_DELTA_E) continue;
      if (!near || delta < near.delta) near = { candidate, delta };
    }
    if (near) return { variable: near.candidate.variable, library: near.candidate.library, snappedFrom: cssHex(color) };
    return null;
  }
  async function loadLibraryColorVariables(ctx) {
    var _a, _b;
    if (ctx.libraryColorVariables) return ctx.libraryColorVariables;
    const imported = [];
    try {
      const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      for (const collection of collections) {
        try {
          (_a = ctx.progress) == null ? void 0 : _a.call(ctx, `reading library "${collection.libraryName}"\u2026`);
          const candidates = (await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key)).filter(
            (candidate) => candidate.resolvedType === "COLOR"
          );
          for (let i = 0; i < candidates.length; i += 50) {
            const chunk = candidates.slice(i, i + 50);
            const results = await Promise.all(
              chunk.map((candidate) => figma.variables.importVariableByKeyAsync(candidate.key).catch(() => null))
            );
            for (const variable of results) if (variable) imported.push(variable);
            (_b = ctx.progress) == null ? void 0 : _b.call(
              ctx,
              `importing "${collection.name}" tokens\u2026 ${Math.min(i + 50, candidates.length)}/${candidates.length}`
            );
            await yieldToHost();
          }
        } catch (e) {
        }
      }
    } catch (e) {
    }
    ctx.libraryColorVariables = imported;
    return imported;
  }
  async function findOrCreateColorVariable(color, consumer, usage, ctx) {
    var _a;
    const pool = await loadColorCandidates(ctx);
    const picked = pickColorCandidate(pool, color, consumer, usage);
    if (picked) return picked;
    if (!ctx.fixCollection) {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      ctx.fixCollection = (_a = collections.find((collection) => collection.name === FIX_COLLECTION_NAME)) != null ? _a : figma.variables.createVariableCollection(FIX_COLLECTION_NAME);
    }
    const variable = figma.variables.createVariable(autoVariableName(color), ctx.fixCollection, "COLOR");
    const modeId = ctx.fixCollection.modes[0].modeId;
    variable.setValueForMode(modeId, color);
    ctx.colorVariables.push(variable);
    pool.push({
      variable,
      library: false,
      hidden: false,
      scopes: [],
      collectionId: ctx.fixCollection.id,
      defaultModeId: modeId,
      valueByMode: /* @__PURE__ */ new Map([[modeId, color]])
    });
    return { variable, library: false };
  }
  function bindingLabel(picked) {
    const notes = [
      ...picked.library ? ["library"] : [],
      ...picked.snappedFrom ? [`snapped from ${picked.snappedFrom}`] : []
    ];
    return notes.length > 0 ? `${picked.variable.name} (${notes.join(", ")})` : picked.variable.name;
  }
  var PAINT_PROP = { fill: "fills", stroke: "strokes" };
  async function fixUnboundPaints(node, usage, ctx) {
    var _a, _b, _c;
    const prop = PAINT_PROP[usage];
    const batchKey = `${node.id}/${prop}`;
    if (ctx.boundPaintKeys.has(batchKey)) {
      return { status: "fixed", detail: "bound via shared main component" };
    }
    const styleId = node[usage === "fill" ? "fillStyleId" : "strokeStyleId"];
    if (styleId !== void 0 && styleId !== "") {
      return { status: "skipped", detail: `${prop} come from a paint style \u2014 already tokenized, re-scan the scope` };
    }
    const paints = node[prop];
    if (!Array.isArray(paints)) {
      return { status: "failed", detail: `${prop} are unreadable on this node` };
    }
    const boundPaints = "boundVariables" in node ? (_a = node.boundVariables) == null ? void 0 : _a[prop] : void 0;
    const next = paints.slice();
    const boundNames = [];
    for (let i = 0; i < next.length; i++) {
      const paint = next[i];
      const paintBound2 = (_b = paint.boundVariables) == null ? void 0 : _b.color;
      if (paint.type !== "SOLID" || paint.visible === false || paintBound2 || (boundPaints == null ? void 0 : boundPaints[i])) continue;
      const color = __spreadProps(__spreadValues({}, paint.color), { a: (_c = paint.opacity) != null ? _c : 1 });
      const picked = await findOrCreateColorVariable(color, node, usage, ctx);
      next[i] = figma.variables.setBoundVariableForPaint(paint, "color", picked.variable);
      boundNames.push(bindingLabel(picked));
    }
    if (boundNames.length === 0) {
      return { status: "skipped", detail: `no unbound solid ${usage} found \u2014 re-scan the scope` };
    }
    ;
    node[prop] = next;
    ctx.boundPaintKeys.add(batchKey);
    return { status: "fixed", detail: `bound to ${boundNames.join(", ")}` };
  }
  async function loadRemoteTextStyles(ctx) {
    var _a;
    if (ctx.remoteTextStyles) return ctx.remoteTextStyles;
    const styles = [];
    (_a = ctx.progress) == null ? void 0 : _a.call(ctx, "collecting page text styles\u2026");
    try {
      const seen = /* @__PURE__ */ new Set();
      for (const text2 of figma.currentPage.findAllWithCriteria({ types: ["TEXT"] })) {
        const styleId = text2.textStyleId;
        if (typeof styleId !== "string" || styleId === "" || seen.has(styleId)) continue;
        seen.add(styleId);
        const style = await figma.getStyleByIdAsync(styleId);
        if ((style == null ? void 0 : style.type) === "TEXT" && style.remote) styles.push(style);
      }
    } catch (e) {
    }
    ctx.remoteTextStyles = styles;
    return styles;
  }
  function metricEquals(a, b) {
    var _a, _b;
    if (!a || !b || a.unit !== b.unit) return false;
    if (a.value === void 0 && b.value === void 0) return true;
    return Math.abs(((_a = a.value) != null ? _a : 0) - ((_b = b.value) != null ? _b : 0)) <= 0.01;
  }
  async function findOrCreateTextStyle(look, ctx) {
    const matches = (candidate) => {
      var _a, _b;
      return ((_a = candidate.fontName) == null ? void 0 : _a.family) === look.fontName.family && ((_b = candidate.fontName) == null ? void 0 : _b.style) === look.fontName.style && candidate.fontSize === look.fontSize && (look.lineHeight === void 0 || metricEquals(candidate.lineHeight, look.lineHeight)) && (look.letterSpacing === void 0 || metricEquals(candidate.letterSpacing, look.letterSpacing));
    };
    const remote = (await loadRemoteTextStyles(ctx)).find(matches);
    if (remote) return { style: remote, fromLibrary: true };
    const local = ctx.textStyles.find(matches);
    if (local) return { style: local, fromLibrary: false };
    await figma.loadFontAsync(look.fontName);
    const style = figma.createTextStyle();
    style.fontName = look.fontName;
    style.fontSize = look.fontSize;
    if (look.lineHeight !== void 0) style.lineHeight = look.lineHeight;
    if (look.letterSpacing !== void 0) style.letterSpacing = look.letterSpacing;
    style.name = `auto/${look.fontName.family} ${look.fontName.style} ${look.fontSize}`;
    ctx.textStyles.push(style);
    return { style, fromLibrary: false };
  }
  async function fixMixedTextSegments(node, ctx) {
    let segments;
    try {
      segments = node.getStyledTextSegments(["fontName", "fontSize", "lineHeight", "letterSpacing", "textStyleId"]);
    } catch (error) {
      return {
        status: "failed",
        detail: `mixed fonts and unreadable segments \u2014 apply styles manually (${error instanceof Error ? error.message : String(error)})`
      };
    }
    const applied = /* @__PURE__ */ new Set();
    for (const segment of segments) {
      if (segment.textStyleId) continue;
      const { style, fromLibrary } = await findOrCreateTextStyle(segment, ctx);
      await node.setRangeTextStyleIdAsync(segment.start, segment.end, style.id);
      applied.add(fromLibrary ? `${style.name} (library)` : style.name);
    }
    if (applied.size === 0) {
      return { status: "skipped", detail: "every text segment already carries a style \u2014 re-scan the scope" };
    }
    return { status: "fixed", detail: `applied per-segment styles: ${[...applied].join(", ")}` };
  }
  async function fixTextWithoutStyle(node, ctx) {
    const fontName = node.fontName;
    const fontSize = node.fontSize;
    if (fontName === figma.mixed || fontSize === figma.mixed) {
      return fixMixedTextSegments(node, ctx);
    }
    const lineHeight = node.lineHeight === figma.mixed ? void 0 : node.lineHeight;
    const letterSpacing = node.letterSpacing === figma.mixed ? void 0 : node.letterSpacing;
    const { style, fromLibrary } = await findOrCreateTextStyle({ fontName, fontSize, lineHeight, letterSpacing }, ctx);
    await node.setTextStyleIdAsync(style.id);
    return { status: "fixed", detail: `applied text style "${style.name}"${fromLibrary ? " (library)" : ""}` };
  }
  async function fixMissingAutoLayout(node) {
    if (node.layoutMode !== "NONE") {
      return { status: "skipped", detail: "frame already has Auto Layout \u2014 re-scan the scope" };
    }
    const rects = node.children.map((child) => ({
      x: child.x,
      y: child.y,
      width: child.width,
      height: child.height
    }));
    const inferred = inferAutoLayout(rects, node.width, node.height);
    if (!inferred) {
      return { status: "failed", detail: "children overlap on both axes \u2014 apply Auto Layout manually" };
    }
    const drift = autoLayoutDrift(rects, node.width, node.height, inferred);
    if (drift > AUTO_LAYOUT_DRIFT_TOLERANCE) {
      return {
        status: "skipped",
        detail: `children would shift up to ${Math.round(drift)}px (uneven gaps or alignment) \u2014 apply Auto Layout manually`
      };
    }
    const { width, height } = node;
    const ordered = inferred.order.map((index) => node.children[index]);
    for (const child of ordered) node.appendChild(child);
    node.layoutMode = inferred.layoutMode;
    node.primaryAxisSizingMode = "FIXED";
    node.counterAxisSizingMode = "FIXED";
    node.counterAxisAlignItems = inferred.counterAlign;
    node.itemSpacing = inferred.itemSpacing;
    node.paddingLeft = inferred.paddingLeft;
    node.paddingRight = inferred.paddingRight;
    node.paddingTop = inferred.paddingTop;
    node.paddingBottom = inferred.paddingBottom;
    node.resize(width, height);
    return {
      status: "fixed",
      detail: `${inferred.layoutMode.toLowerCase()} Auto Layout, spacing ${inferred.itemSpacing}px`
    };
  }
  function anyVisible(paints) {
    return Array.isArray(paints) && paints.some((p) => p.visible !== false);
  }
  function clippingHasEffect(node) {
    var _a;
    if (!node.clipsContent) return false;
    if (node.rotation) return true;
    const frame2 = node.absoluteBoundingBox;
    if (!frame2) return true;
    for (const child of node.children) {
      if (child.visible === false) continue;
      const bounds = (_a = "absoluteRenderBounds" in child ? child.absoluteRenderBounds : null) != null ? _a : child.absoluteBoundingBox;
      if (!bounds) return true;
      if (bounds.x < frame2.x - 0.5 || bounds.y < frame2.y - 0.5 || bounds.x + bounds.width > frame2.x + frame2.width + 0.5 || bounds.y + bounds.height > frame2.y + frame2.height + 0.5) {
        return true;
      }
    }
    return false;
  }
  function frameHasPaintRole(node) {
    if (anyVisible(node.fills) || anyVisible(node.strokes) || anyVisible(node.effects)) return true;
    if (clippingHasEffect(node)) return true;
    const radius = node.cornerRadius;
    if (radius === figma.mixed || typeof radius === "number" && radius > 0) return true;
    if (typeof node.opacity === "number" && node.opacity < 1) return true;
    if (node.rotation) return true;
    const blend = node.blendMode;
    if (blend && blend !== "PASS_THROUGH" && blend !== "NORMAL") return true;
    if (node.isMask) return true;
    return false;
  }
  function frameHasVisualRole(node) {
    if (frameHasPaintRole(node)) return true;
    if (node.paddingLeft || node.paddingRight || node.paddingTop || node.paddingBottom) return true;
    return false;
  }
  function parentIsAutoLayout(node) {
    const parent = node.parent;
    return !!parent && (parent.type === "FRAME" || parent.type === "COMPONENT" || parent.type === "INSTANCE") && parent.layoutMode !== "NONE";
  }
  function isRedundantWrapper(node) {
    if (!("children" in node) || node.children.length !== 1) return false;
    if (node.type === "GROUP") return true;
    if (node.type !== "FRAME") return false;
    return parentIsAutoLayout(node) ? !frameHasVisualRole(node) : !frameHasPaintRole(node);
  }
  function isFlattenableWrapper(node) {
    const parent = node.parent;
    if (!parent || parent.type === "PAGE" || parent.type === "DOCUMENT") return false;
    return isRedundantWrapper(node) || isDissolvableWrapper(node) || canMergeAutoLayoutWrapper(node);
  }
  function canMergeAutoLayoutWrapper(node) {
    if (node.type !== "FRAME" || node.layoutMode === "NONE") return false;
    if (node.children.length === 0) return false;
    if (frameHasPaintRole(node)) return false;
    if (node.layoutPositioning === "ABSOLUTE") return false;
    const parent = node.parent;
    if (!parent || parent.type !== "FRAME" && parent.type !== "COMPONENT") return false;
    if (parent.layoutMode !== node.layoutMode) return false;
    if (parent.children.length !== 1) return false;
    const contentWidth = parent.width - parent.paddingLeft - parent.paddingRight;
    const contentHeight = parent.height - parent.paddingTop - parent.paddingBottom;
    return Math.abs(node.width - contentWidth) <= 1 && Math.abs(node.height - contentHeight) <= 1;
  }
  function mergeAutoLayoutWrapper(wrapper) {
    const parent = wrapper.parent;
    const children = [...wrapper.children];
    parent.itemSpacing = wrapper.itemSpacing;
    try {
      parent.layoutWrap = wrapper.layoutWrap;
      if (wrapper.layoutWrap === "WRAP") parent.counterAxisSpacing = wrapper.counterAxisSpacing;
    } catch (e) {
    }
    parent.primaryAxisAlignItems = wrapper.primaryAxisAlignItems;
    parent.counterAxisAlignItems = wrapper.counterAxisAlignItems;
    parent.paddingLeft += wrapper.paddingLeft;
    parent.paddingRight += wrapper.paddingRight;
    parent.paddingTop += wrapper.paddingTop;
    parent.paddingBottom += wrapper.paddingBottom;
    for (const child of children) parent.appendChild(child);
    removeWrapperIfAlive(wrapper);
  }
  function isDissolvableWrapper(node) {
    if (!("children" in node) || node.children.length < 2) return false;
    const parent = node.parent;
    if (!parent || !("children" in parent)) return false;
    if (parentIsAutoLayout(node)) return false;
    if (node.type === "GROUP") return true;
    if (node.type !== "FRAME") return false;
    return !frameHasPaintRole(node);
  }
  function unwrapWrapper(wrapper) {
    const parent = wrapper.parent;
    if (!parent || !("children" in parent)) throw new Error("wrapper has no container parent");
    const child = wrapper.children[0];
    const index = parent.children.indexOf(wrapper);
    const parentAutoLayout = (parent.type === "FRAME" || parent.type === "COMPONENT" || parent.type === "INSTANCE") && parent.layoutMode !== "NONE";
    if (parentAutoLayout) {
      parent.insertChild(index, child);
      const w = wrapper;
      for (const copy of [
        () => child.layoutPositioning = w.layoutPositioning,
        () => child.layoutGrow = w.layoutGrow,
        () => child.layoutAlign = w.layoutAlign,
        () => child.layoutSizingHorizontal = w.layoutSizingHorizontal,
        () => child.layoutSizingVertical = w.layoutSizingVertical
      ]) {
        try {
          copy();
        } catch (e) {
        }
      }
    } else {
      const x = wrapper.type === "GROUP" ? child.x : wrapper.x + child.x;
      const y = wrapper.type === "GROUP" ? child.y : wrapper.y + child.y;
      parent.insertChild(index, child);
      try {
        child.x = x;
        child.y = y;
      } catch (e) {
      }
    }
    removeWrapperIfAlive(wrapper);
  }
  function removeWrapperIfAlive(wrapper) {
    try {
      if (!wrapper.removed) wrapper.remove();
    } catch (e) {
    }
  }
  function dissolveWrapper(wrapper) {
    const parent = wrapper.parent;
    if (!parent || !("children" in parent)) throw new Error("wrapper has no container parent");
    const index = parent.children.indexOf(wrapper);
    const isGroup = wrapper.type === "GROUP";
    const offsetX = isGroup ? 0 : wrapper.x;
    const offsetY = isGroup ? 0 : wrapper.y;
    const children = [...wrapper.children];
    children.forEach((child, i) => {
      const x = child.x + offsetX;
      const y = child.y + offsetY;
      parent.insertChild(index + i, child);
      try {
        child.x = x;
        child.y = y;
      } catch (e) {
      }
    });
    removeWrapperIfAlive(wrapper);
  }
  function indexPath(ancestor, descendant) {
    const path = [];
    let current = descendant;
    while (current && current !== ancestor) {
      const parent = current.parent;
      if (!parent || !("children" in parent)) break;
      path.push(parent.children.indexOf(current));
      current = parent;
    }
    return path.reverse();
  }
  function nodeAtPath(root, path) {
    let current = root;
    for (const index of path) {
      if (!("children" in current)) return null;
      const next = current.children[index];
      if (!next) return null;
      current = next;
    }
    return current;
  }
  function unwrapRedundantAncestors(node) {
    let removed = 0;
    let current = node.parent;
    while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
      if (current.type === "INSTANCE" || current.type === "COMPONENT" || current.type === "COMPONENT_SET") break;
      const parent = current.parent;
      try {
        if (isFlattenableWrapper(current)) {
          if (isRedundantWrapper(current)) unwrapWrapper(current);
          else if (isDissolvableWrapper(current)) dissolveWrapper(current);
          else mergeAutoLayoutWrapper(current);
          removed++;
        }
      } catch (e) {
      }
      current = parent;
    }
    return removed;
  }
  function canUnwrapNesting(node) {
    const instance = enclosingInstance(node);
    if (instance) return countRedundantAncestorsWithin(node, instance) > 0;
    let current = node.parent;
    while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
      if (current.type === "INSTANCE" || current.type === "COMPONENT" || current.type === "COMPONENT_SET") break;
      if (isFlattenableWrapper(current)) return true;
      current = current.parent;
    }
    return false;
  }
  async function annotateUnfixableFindings(findings, nodeById) {
    const remoteInstanceCache = /* @__PURE__ */ new Map();
    for (const finding of findings) {
      const node = nodeById.get(finding.nodeId);
      if (!node) continue;
      if (finding.rule === "excessive-nesting") {
        if (!canUnwrapNesting(node)) {
          finding.fixable = false;
          finding.message += " (no safely removable wrappers \u2014 every level adds visuals or layout; needs manual flattening)";
        }
        continue;
      }
      if (finding.rule !== "missing-auto-layout" || node.type !== "FRAME") continue;
      const instance = enclosingInstance(node);
      if (instance) {
        let remote = remoteInstanceCache.get(instance.id);
        if (remote === void 0) {
          const main = await instance.getMainComponentAsync().catch(() => null);
          remote = !main || main.remote;
          remoteInstanceCache.set(instance.id, remote);
        }
        if (remote) {
          finding.fixable = false;
          finding.message += " (inside a library component \u2014 fix it in the source library)";
          continue;
        }
      }
      const rects = node.children.map((child) => ({
        x: child.x,
        y: child.y,
        width: child.width,
        height: child.height
      }));
      const inferred = inferAutoLayout(rects, node.width, node.height);
      if (!inferred) {
        finding.fixable = false;
        finding.message += " (children overlap on both axes \u2014 needs manual layout)";
        continue;
      }
      const drift = autoLayoutDrift(rects, node.width, node.height, inferred);
      if (drift > AUTO_LAYOUT_DRIFT_TOLERANCE) {
        finding.fixable = false;
        finding.message += ` (uneven gaps \u2014 auto-fix would shift children ~${Math.round(drift)}px)`;
      }
    }
  }
  function countRedundantAncestorsWithin(node, boundary) {
    let count = 0;
    let current = node.parent;
    while (current && current !== boundary && "children" in current) {
      if (isFlattenableWrapper(current)) count++;
      current = current.parent;
    }
    return count;
  }
  async function fixExcessiveNesting(node) {
    const instance = enclosingInstance(node);
    if (!instance) {
      const removed2 = unwrapRedundantAncestors(node);
      return removed2 > 0 ? { status: "fixed", detail: `removed ${removed2} redundant wrapper level(s)` } : { status: "skipped", detail: "no redundant wrapper layers to remove \u2014 flatten manually" };
    }
    if (countRedundantAncestorsWithin(node, instance) === 0) {
      return { status: "skipped", detail: "nesting is intrinsic to a component \u2014 flatten it in the main component" };
    }
    const path = indexPath(instance, node);
    let detached;
    try {
      detached = instance.detachInstance();
    } catch (error) {
      return { status: "failed", detail: `couldn't detach the blocking component: ${error instanceof Error ? error.message : String(error)}` };
    }
    const relocated = nodeAtPath(detached, path);
    if (!relocated) return { status: "failed", detail: "lost the node after detaching its component" };
    const removed = unwrapRedundantAncestors(relocated);
    return removed > 0 ? { status: "fixed", detail: `detached the blocking component and removed ${removed} redundant wrapper level(s)` } : { status: "skipped", detail: "detached the component but found no removable wrappers" };
  }
  function withTarget(result, onMainComponent, asOverride = false) {
    if (result.status !== "fixed") return result;
    if (onMainComponent) return { status: "fixed", detail: `${result.detail} (on main component)` };
    if (asOverride) return { status: "fixed", detail: `${result.detail} (override on this instance)` };
    return result;
  }
  async function applyLintFix(node, rule, ctx) {
    let base;
    try {
      base = { nodeId: node.id, nodeName: node.name, rule };
    } catch (e) {
      return {
        nodeId: "removed",
        nodeName: "(removed node)",
        rule,
        status: "failed",
        detail: "node was removed by an earlier fix in this batch \u2014 re-scan the scope"
      };
    }
    try {
      if (rule === "excessive-nesting") {
        return __spreadValues(__spreadValues({}, base), await fixExcessiveNesting(node));
      }
      const resolved = await resolveEditableTarget(node);
      let target = node;
      let onMainComponent = false;
      let asOverride = false;
      if (resolved.kind === "node") {
        target = resolved.node;
        onMainComponent = resolved.onMainComponent;
      } else if (rule === "missing-auto-layout") {
        return __spreadProps(__spreadValues({}, base), { status: "skipped", detail: "layout inside a library component \u2014 fix it in the source library" });
      } else {
        asOverride = true;
      }
      switch (rule) {
        case "unbound-fill":
        case "unbound-stroke": {
          const usage = rule === "unbound-fill" ? "fill" : "stroke";
          let result = withTarget(await fixUnboundPaints(target, usage, ctx), onMainComponent, asOverride);
          if (onMainComponent) {
            const echo = await fixUnboundPaints(node, usage, ctx);
            if (echo.status === "fixed") {
              result = result.status === "fixed" ? { status: "fixed", detail: `${result.detail}; overridden ${PAINT_PROP[usage]} on this instance re-bound` } : { status: "fixed", detail: `${echo.detail} (override on this instance; main component already bound)` };
            }
          }
          return __spreadValues(__spreadValues({}, base), result);
        }
        case "text-without-style": {
          if (target.type !== "TEXT") return __spreadProps(__spreadValues({}, base), { status: "failed", detail: "not a text node" });
          let result = withTarget(await fixTextWithoutStyle(target, ctx), onMainComponent, asOverride);
          if (onMainComponent && node.type === "TEXT" && node.textStyleId === "") {
            const echo = await fixTextWithoutStyle(node, ctx);
            if (echo.status === "fixed") {
              result = result.status === "fixed" ? { status: "fixed", detail: `${result.detail}; overridden text on this instance restyled` } : { status: "fixed", detail: `${echo.detail} (override on this instance; main component already styled)` };
            }
          }
          return __spreadValues(__spreadValues({}, base), result);
        }
        case "missing-auto-layout":
          if (target.type !== "FRAME") return __spreadProps(__spreadValues({}, base), { status: "failed", detail: "not a frame" });
          return __spreadValues(__spreadValues({}, base), withTarget(await fixMissingAutoLayout(target), onMainComponent));
        case "bootstrap-component-mismatch":
          return __spreadProps(__spreadValues({}, base), { status: "skipped", detail: "rename the variant prop in Figma \u2014 not auto-fixable" });
      }
    } catch (error) {
      return __spreadProps(__spreadValues({}, base), { status: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  // src/targets/django/ui/annotation-panel.ts
  var EMPTY_FORM = {
    context: "",
    pluralEnabled: false,
    pluralOne: "",
    pluralOther: "",
    placeholders: []
  };
  function loadAnnotationForm(node) {
    var _a, _b, _c, _d, _e;
    const annotation = getAnnotation(node);
    if (!annotation) return __spreadProps(__spreadValues({}, EMPTY_FORM), { placeholders: [] });
    return {
      context: (_a = annotation.context) != null ? _a : "",
      pluralEnabled: annotation.plural != null,
      pluralOne: (_c = (_b = annotation.plural) == null ? void 0 : _b.one) != null ? _c : "",
      pluralOther: (_e = (_d = annotation.plural) == null ? void 0 : _d.other) != null ? _e : "",
      placeholders: annotation.placeholders ? annotation.placeholders.map((p) => __spreadValues({}, p)) : []
    };
  }
  function formToAnnotation(form) {
    const annotation = {};
    if (form.context) annotation.context = form.context;
    if (form.pluralEnabled) annotation.plural = { one: form.pluralOne, other: form.pluralOther };
    if (form.placeholders.length > 0) annotation.placeholders = form.placeholders.map((p) => __spreadValues({}, p));
    return annotation;
  }
  function applyAnnotationForm(node, form) {
    setAnnotation(node, formToAnnotation(form));
  }
  function escapeHtml3(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function renderAnnotationPanel(form, viewModel = {}) {
    if (viewModel.boundVariableName) {
      return [
        '<section id="i18n-annotation-panel" data-governed-by-variable="true">',
        `  <p class="i18n-annotation-panel__notice">Key comes from bound variable "${escapeHtml3(
          viewModel.boundVariableName
        )}" \u2014 manual annotations are ignored.</p>`,
        "</section>"
      ].join("\n");
    }
    const placeholderRows = form.placeholders.map(
      (p, i) => `    <li class="i18n-placeholder-row" data-index="${i}">
      <input type="number" class="i18n-placeholder-start" value="${p.start}" />
      <input type="number" class="i18n-placeholder-end" value="${p.end}" />
      <input type="text" class="i18n-placeholder-name" value="${escapeHtml3(p.name)}" />
      <button type="button" class="i18n-remove-placeholder" data-index="${i}">Remove</button>
    </li>`
    ).join("\n");
    return [
      '<section id="i18n-annotation-panel">',
      '  <label class="i18n-field">Context (msgctxt)',
      `    <input type="text" id="i18n-context" value="${escapeHtml3(form.context)}" />`,
      "  </label>",
      '  <label class="i18n-field">',
      `    <input type="checkbox" id="i18n-plural-enabled"${form.pluralEnabled ? " checked" : ""} />`,
      "    Has plural forms",
      "  </label>",
      '  <label class="i18n-field">One',
      `    <input type="text" id="i18n-plural-one" value="${escapeHtml3(form.pluralOne)}" />`,
      "  </label>",
      '  <label class="i18n-field">Other',
      `    <input type="text" id="i18n-plural-other" value="${escapeHtml3(form.pluralOther)}" />`,
      "  </label>",
      '  <ul id="i18n-placeholders">',
      placeholderRows,
      "  </ul>",
      '  <button id="i18n-add-placeholder" type="button">Add placeholder</button>',
      "</section>"
    ].join("\n");
  }

  // src/targets/django/motion/types.ts
  var MOTION_PROPERTY_ALLOWLIST = [
    "TRANSLATION_X",
    "TRANSLATION_Y",
    "TRANSLATION_XY",
    "ROTATION",
    "SCALE_X",
    "SCALE_Y",
    "SCALE_XY",
    "OPACITY",
    "WIDTH",
    "HEIGHT",
    "CORNER_RADIUS",
    "RECTANGLE_TOP_LEFT_CORNER_RADIUS",
    "RECTANGLE_TOP_RIGHT_CORNER_RADIUS",
    "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS",
    "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS",
    "STROKE_WEIGHT",
    "BORDER_TOP_WEIGHT",
    "BORDER_BOTTOM_WEIGHT",
    "BORDER_LEFT_WEIGHT",
    "BORDER_RIGHT_WEIGHT",
    "STACK_SPACING",
    "STACK_COUNTER_SPACING",
    "STACK_PADDING_LEFT",
    "STACK_PADDING_TOP",
    "STACK_PADDING_RIGHT",
    "STACK_PADDING_BOTTOM",
    "GRID_ROW_GAP",
    "GRID_COLUMN_GAP",
    "PATH_TRIM_START",
    "PATH_TRIM_END"
  ];

  // src/targets/django/motion/beta-adapter.ts
  function hasMotionApi(node) {
    return "animations" in node && "timelines" in node && "animationStyles" in node && "manualKeyframeTracks" in node;
  }
  function warnOnShaderTracks(indexedTracks, paintsOrEffects) {
    var _a;
    if (!indexedTracks || !Array.isArray(paintsOrEffects)) return;
    for (const indexKey of Object.keys(indexedTracks)) {
      const type = (_a = paintsOrEffects[Number(indexKey)]) == null ? void 0 : _a.type;
      if (type === "SHADER") {
        console.warn("[motion] skipping shader/unknown track:", type);
      }
    }
  }
  function readMotionData(node) {
    var _a, _b, _c, _d;
    if (!hasMotionApi(node)) return null;
    try {
      const manualTracks = node.manualKeyframeTracks;
      const animations = node.animations;
      const tracks = [];
      for (const field of MOTION_PROPERTY_ALLOWLIST) {
        const binding = manualTracks == null ? void 0 : manualTracks[field];
        if (!binding) continue;
        tracks.push({
          field,
          baseValue: binding.baseValue,
          timelineDuration: (_b = (_a = animations == null ? void 0 : animations[field]) == null ? void 0 : _a.timelineDuration) != null ? _b : 0,
          keyframes: binding.keyframes.map((keyframe) => ({
            id: keyframe.id,
            timelinePosition: keyframe.timelinePosition,
            easing: keyframe.easing,
            value: keyframe.value
          }))
        });
      }
      warnOnShaderTracks(manualTracks == null ? void 0 : manualTracks.fills, "fills" in node ? node.fills : void 0);
      warnOnShaderTracks(manualTracks == null ? void 0 : manualTracks.strokes, "strokes" in node ? node.strokes : void 0);
      warnOnShaderTracks(manualTracks == null ? void 0 : manualTracks.effects, "effects" in node ? node.effects : void 0);
      return {
        animationStyles: (_c = node.animationStyles) != null ? _c : [],
        timelines: (_d = node.timelines) != null ? _d : [],
        tracks
      };
    } catch (error) {
      console.warn("[motion] failed to read motion data, skipping node:", node.id, error);
      return null;
    }
  }

  // src/targets/django/motion/backend.ts
  var CSS_ELIGIBLE_TRIGGERS = /* @__PURE__ */ new Set(["autoplay", "loop", "hover"]);
  var SPRING_BOUNCE_THRESHOLD = 0.05;
  var GSAP_NODE_COUNT_THRESHOLD = 3;
  function isLiteralEasing(easing) {
    return easing.type !== "VARIABLE_ALIAS";
  }
  function isSpringEasing(easing) {
    return easing.type === "CUSTOM_SPRING" || easing.type in NAMED_SPRING_BOUNCE;
  }
  function hasBouncySpring(tracks) {
    return tracks.some(
      (track) => track.keyframes.some((keyframe) => {
        const easing = keyframe.easing;
        return isLiteralEasing(easing) && isSpringEasing(easing) && resolveSpringBounce(easing) > SPRING_BOUNCE_THRESHOLD;
      })
    );
  }
  function hasTextDataTrack(tracks) {
    return tracks.some(
      (track) => track.baseValue.type === "TEXT_DATA" || track.keyframes.some((keyframe) => keyframe.value.type === "TEXT_DATA")
    );
  }
  function hasDualPathTrim(tracks) {
    const fields = new Set(tracks.map((track) => track.field));
    return fields.has("PATH_TRIM_START") && fields.has("PATH_TRIM_END");
  }
  function pickBackend(input, override) {
    if (override) {
      return { backend: override, reason: "override" };
    }
    if (hasBouncySpring(input.tracks)) {
      return { backend: "gsap", reason: `spring bounce > ${SPRING_BOUNCE_THRESHOLD}` };
    }
    if (hasTextDataTrack(input.tracks)) {
      return { backend: "gsap", reason: "TEXT_DATA track" };
    }
    if (hasDualPathTrim(input.tracks)) {
      return { backend: "gsap", reason: "PATH_TRIM_START + PATH_TRIM_END" };
    }
    if (input.nodeCount >= GSAP_NODE_COUNT_THRESHOLD) {
      return { backend: "gsap", reason: `${input.nodeCount} animated nodes >= ${GSAP_NODE_COUNT_THRESHOLD}` };
    }
    if (!CSS_ELIGIBLE_TRIGGERS.has(input.trigger)) {
      return { backend: "gsap", reason: `interactive trigger "${input.trigger}"` };
    }
    return { backend: "css", reason: "<=2 nodes, transform/opacity, bezier easing, autoplay/loop/hover trigger" };
  }

  // src/targets/django/motion/css-emitter.ts
  var TRANSFORM_FIELD_MAPPING = {
    TRANSLATION_X: { cssProperty: "translate", axis: "x", unit: "px", identity: 0 },
    TRANSLATION_Y: { cssProperty: "translate", axis: "y", unit: "px", identity: 0 },
    TRANSLATION_XY: { cssProperty: "translate", axis: "xy", unit: "px", identity: 0 },
    SCALE_X: { cssProperty: "scale", axis: "x", unit: "", identity: 1 },
    SCALE_Y: { cssProperty: "scale", axis: "y", unit: "", identity: 1 },
    SCALE_XY: { cssProperty: "scale", axis: "xy", unit: "", identity: 1 }
  };
  var SCALAR_FIELD_MAPPING = {
    ROTATION: { cssProperty: "rotate", unit: "deg" },
    OPACITY: { cssProperty: "opacity", unit: "" }
  };
  function round4(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }
  function formatNumber(value) {
    return String(round4(value, 4));
  }
  function formatTransformDeclaration(mapping, value) {
    const { cssProperty, axis, unit, identity } = mapping;
    const identityFormatted = `${identity}${unit}`;
    if (axis === "xy") {
      if (value.type !== "VECTOR") throw new Error(`Expected a VECTOR value for ${cssProperty} (XY), got ${value.type}`);
      return `${cssProperty}: ${formatNumber(value.value.x)}${unit} ${formatNumber(value.value.y)}${unit}`;
    }
    if (value.type !== "FLOAT") throw new Error(`Expected a FLOAT value for ${cssProperty} (${axis}), got ${value.type}`);
    const formatted = `${formatNumber(value.value)}${unit}`;
    return axis === "x" ? `${cssProperty}: ${formatted} ${identityFormatted}` : `${cssProperty}: ${identityFormatted} ${formatted}`;
  }
  function formatDeclaration(field, value) {
    const transform = TRANSFORM_FIELD_MAPPING[field];
    if (transform) return formatTransformDeclaration(transform, value);
    const scalar = SCALAR_FIELD_MAPPING[field];
    if (scalar) {
      if (value.type !== "FLOAT") throw new Error(`Expected a FLOAT value for ${field}, got ${value.type}`);
      return `${scalar.cssProperty}: ${formatNumber(value.value)}${scalar.unit}`;
    }
    throw new Error(`No CSS mapping for Motion field "${field}" \u2014 not supported by the CSS keyframes emitter`);
  }
  function isLiteralEasing2(easing) {
    return easing.type !== "VARIABLE_ALIAS";
  }
  function easingToTimingFunctionCss(easing) {
    try {
      return easingToCss(easing);
    } catch (e) {
      return springToCssLinear(resolveSpringBounce(easing)).easing;
    }
  }
  function withBaseKeyframe(track) {
    const first = track.keyframes[0];
    if (first && first.timelinePosition === 0) return track.keyframes;
    const base = {
      id: "__base__",
      timelinePosition: 0,
      easing: { type: "LINEAR" },
      value: track.baseValue
    };
    return [base, ...track.keyframes];
  }
  function buildPercentFrames(track) {
    const keyframes = withBaseKeyframe(track);
    const duration = track.timelineDuration;
    const frames = keyframes.map((keyframe) => ({
      percent: duration > 0 ? keyframe.timelinePosition / duration * 100 : 0,
      declaration: formatDeclaration(track.field, keyframe.value)
    }));
    for (let i = 1; i < keyframes.length; i++) {
      const easing = keyframes[i].easing;
      if (!isLiteralEasing2(easing)) {
        throw new Error(
          `Cannot emit CSS for field "${track.field}": keyframe easing is a variable alias \u2014 resolve it before calling the CSS emitter`
        );
      }
      if (frames[i].declaration === frames[i - 1].declaration) continue;
      frames[i - 1].timingFunction = easingToTimingFunctionCss(easing);
    }
    return frames;
  }
  function formatPercent(percent) {
    return `${round4(percent, 3)}%`;
  }
  function formatFrame(frame2) {
    const declarations = [`${frame2.declaration};`];
    if (frame2.timingFunction) declarations.push(`animation-timing-function: ${frame2.timingFunction};`);
    return `  ${formatPercent(frame2.percent)} { ${declarations.join(" ")} }`;
  }
  function emitKeyframesRule(name, track) {
    const frames = buildPercentFrames(track);
    return `@keyframes ${name} {
${frames.map(formatFrame).join("\n")}
}`;
  }
  function sanitizeIdentPart(value) {
    return value.replace(/[^a-zA-Z0-9_-]/g, "");
  }
  function defaultTrackName(selector, track) {
    return `${sanitizeIdentPart(selector)}-${track.field.toLowerCase().replace(/_/g, "-")}`;
  }
  function formatSeconds(duration) {
    return `${round4(duration, 4)}s`;
  }
  function emitNodeAnimationCss(input) {
    var _a;
    const nameForTrack = (_a = input.nameForTrack) != null ? _a : ((track) => defaultTrackName(input.selector, track));
    const baseDeclarations = input.tracks.map((track) => `  ${formatDeclaration(track.field, track.baseValue)};`);
    const animationEntries = input.tracks.map((track) => `${nameForTrack(track)} ${formatSeconds(track.timelineDuration)} linear both`);
    const rule = [
      `${input.selector} {`,
      ...baseDeclarations,
      `  animation:`,
      `    ${animationEntries.join(",\n    ")};`,
      `}`
    ].join("\n");
    const reducedMotionGuard = [
      "@media (prefers-reduced-motion: reduce) {",
      `  ${input.selector} {`,
      "    animation: none;",
      "  }",
      "}"
    ].join("\n");
    const keyframesBlocks = input.tracks.map((track) => emitKeyframesRule(nameForTrack(track), track));
    return [rule, reducedMotionGuard, ...keyframesBlocks].join("\n\n");
  }

  // src/targets/django/motion/gsap-emitter.ts
  function round5(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }
  var NODE_ID_ATTRIBUTE = "data-node-id";
  function nodeSelector(nodeId) {
    return `[${NODE_ID_ATTRIBUTE}="${nodeId}"]`;
  }
  var SPRING_BACK_BOUNCE_THRESHOLD = 0.25;
  var SCALAR_PROPERTY_MAP = {
    TRANSLATION_X: "x",
    TRANSLATION_Y: "y",
    ROTATION: "rotation",
    SCALE_X: "scaleX",
    SCALE_Y: "scaleY",
    OPACITY: "opacity",
    WIDTH: "width",
    HEIGHT: "height",
    CORNER_RADIUS: "borderRadius",
    RECTANGLE_TOP_LEFT_CORNER_RADIUS: "borderTopLeftRadius",
    RECTANGLE_TOP_RIGHT_CORNER_RADIUS: "borderTopRightRadius",
    RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: "borderBottomLeftRadius",
    RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: "borderBottomRightRadius",
    STROKE_WEIGHT: "borderWidth",
    BORDER_TOP_WEIGHT: "borderTopWidth",
    BORDER_BOTTOM_WEIGHT: "borderBottomWidth",
    BORDER_LEFT_WEIGHT: "borderLeftWidth",
    BORDER_RIGHT_WEIGHT: "borderRightWidth",
    // Figma doesn't expose the stack's axis direction on the track itself (§2.2) — spacing maps
    // to the main-axis gap, counter-spacing to the cross-axis one; ambiguous for wrapping stacks.
    STACK_SPACING: "columnGap",
    STACK_COUNTER_SPACING: "rowGap",
    STACK_PADDING_LEFT: "paddingLeft",
    STACK_PADDING_TOP: "paddingTop",
    STACK_PADDING_RIGHT: "paddingRight",
    STACK_PADDING_BOTTOM: "paddingBottom",
    GRID_ROW_GAP: "rowGap",
    GRID_COLUMN_GAP: "columnGap"
  };
  var VECTOR_PROPERTY_MAP = {
    TRANSLATION_XY: ["x", "y"],
    SCALE_XY: ["scaleX", "scaleY"]
  };
  function gsapKeysForField(field) {
    const vector = VECTOR_PROPERTY_MAP[field];
    if (vector) return vector;
    const scalar = SCALAR_PROPERTY_MAP[field];
    return scalar ? [scalar] : void 0;
  }
  function requireFloat(value, context) {
    if (value.type !== "FLOAT") throw new Error(`Expected FLOAT value for ${context}, got ${value.type}`);
    return value.value;
  }
  function requireVector(value, context) {
    if (value.type !== "VECTOR") throw new Error(`Expected VECTOR value for ${context}, got ${value.type}`);
    return value.value;
  }
  function requireTextData(value, context) {
    if (value.type !== "TEXT_DATA") throw new Error(`Expected TEXT_DATA value for ${context}, got ${value.type}`);
    return value.value;
  }
  var EaseRegistry = class {
    constructor() {
      this.namesByKey = /* @__PURE__ */ new Map();
      this.nextIndex = 0;
      this.usesSampledSpring = false;
      this.bezierStatements = [];
      this.springStatements = [];
    }
    allocateName(prefix) {
      return `figma${prefix}${this.nextIndex++}`;
    }
    bezier(bezier) {
      const key = `bezier:${bezier.x1},${bezier.y1},${bezier.x2},${bezier.y2}`;
      const existing = this.namesByKey.get(key);
      if (existing) return existing;
      const name = this.allocateName("Ease");
      this.namesByKey.set(key, name);
      this.bezierStatements.push(`    CustomEase.create(${JSON.stringify(name)}, "${bezier.x1}, ${bezier.y1}, ${bezier.x2}, ${bezier.y2}");`);
      return name;
    }
    sampledSpring(points) {
      const rounded = points.map((point) => round5(point, 4));
      const key = `spring:${rounded.join(",")}`;
      const existing = this.namesByKey.get(key);
      if (existing) return existing;
      const name = this.allocateName("Spring");
      this.namesByKey.set(key, name);
      this.usesSampledSpring = true;
      this.springStatements.push(`    gsap.registerEase(${JSON.stringify(name)}, __figmaLerpEase([${rounded.join(", ")}]));`);
      return name;
    }
  };
  function resolveEase(easing, registry, plugins) {
    if (easing.type === "VARIABLE_ALIAS") return "none";
    if (easing.type === "LINEAR" || easing.type === "HOLD") return "none";
    if (easing.type === "CUSTOM_CUBIC_BEZIER") {
      if (!easing.easingFunctionCubicBezier) {
        throw new Error("CUSTOM_CUBIC_BEZIER easing is missing easingFunctionCubicBezier");
      }
      plugins.add("CustomEase");
      return registry.bezier(easing.easingFunctionCubicBezier);
    }
    if (easing.type === "GENTLE" || easing.type === "QUICK" || easing.type === "BOUNCY" || easing.type === "SLOW" || easing.type === "CUSTOM_SPRING") {
      const bounce = resolveSpringBounce(easing);
      if (bounce <= SPRING_BACK_BOUNCE_THRESHOLD) {
        return `back.out(${round5(1 + 2.5 * bounce, 3)})`;
      }
      return registry.sampledSpring(sampleSpring(bounce).points);
    }
    plugins.add("CustomEase");
    return registry.bezier(BEZIER_PRESETS[easing.type]);
  }
  function formatPercentLabel(percent) {
    return `${round5(percent, 3)}%`;
  }
  function ensureTerminalKeyframe(keyframes, lastPercent, lastVars) {
    if (lastPercent < 100 - 1e-6) {
      keyframes["100%"] = __spreadProps(__spreadValues({}, lastVars), { ease: "none" });
    }
  }
  function trackValueVars(value, gsapKeys, context) {
    if (gsapKeys.length === 2) {
      const vector = requireVector(value, context);
      return { [gsapKeys[0]]: vector.x, [gsapKeys[1]]: vector.y };
    }
    return { [gsapKeys[0]]: requireFloat(value, context) };
  }
  function buildPropertyTween(track, gsapKeys, timelineDuration, registry, plugins) {
    const fromVars = trackValueVars(track.baseValue, gsapKeys, `${track.field} baseValue`);
    const sorted = [...track.keyframes].sort((a, b) => a.timelinePosition - b.timelinePosition);
    const keyframes = {};
    let lastVars = fromVars;
    let lastPercent = 0;
    for (const keyframe of sorted) {
      const vars = trackValueVars(keyframe.value, gsapKeys, `${track.field} keyframe ${keyframe.id}`);
      lastVars = vars;
      if (keyframe.timelinePosition <= 0) {
        lastPercent = 0;
        continue;
      }
      const percent = keyframe.timelinePosition / timelineDuration * 100;
      const ease = resolveEase(keyframe.easing, registry, plugins);
      keyframes[formatPercentLabel(percent)] = __spreadProps(__spreadValues({}, vars), { ease });
      lastPercent = percent;
    }
    ensureTerminalKeyframe(keyframes, lastPercent, lastVars);
    return { fromVars, keyframes };
  }
  function buildTextTween(track, timelineDuration, registry, plugins) {
    plugins.add("TextPlugin");
    const baseText = requireTextData(track.baseValue, `${track.field} baseValue`);
    const fromVars = { text: { value: baseText } };
    const sorted = [...track.keyframes].sort((a, b) => a.timelinePosition - b.timelinePosition);
    const keyframes = {};
    let lastVars = fromVars;
    let lastPercent = 0;
    for (const keyframe of sorted) {
      const text2 = requireTextData(keyframe.value, `${track.field} keyframe ${keyframe.id}`);
      const vars = { text: { value: text2 } };
      lastVars = vars;
      if (keyframe.timelinePosition <= 0) {
        lastPercent = 0;
        continue;
      }
      const percent = keyframe.timelinePosition / timelineDuration * 100;
      const ease = resolveEase(keyframe.easing, registry, plugins);
      keyframes[formatPercentLabel(percent)] = __spreadProps(__spreadValues({}, vars), { ease });
      lastPercent = percent;
    }
    ensureTerminalKeyframe(keyframes, lastPercent, lastVars);
    return { fromVars, keyframes };
  }
  function valueAtOrBefore(track, position, fallback) {
    if (!track) return { value: fallback };
    let value = requireFloat(track.baseValue, `${track.field} baseValue`);
    let easing;
    for (const keyframe of [...track.keyframes].sort((a, b) => a.timelinePosition - b.timelinePosition)) {
      if (keyframe.timelinePosition > position) break;
      value = requireFloat(keyframe.value, `${track.field} keyframe ${keyframe.id}`);
      if (keyframe.timelinePosition === position) easing = keyframe.easing;
    }
    return { value, easing };
  }
  function buildDrawSvgTween(startTrack, endTrack, timelineDuration, registry, plugins) {
    var _a, _b, _c, _d;
    plugins.add("DrawSVGPlugin");
    const startBase = startTrack ? requireFloat(startTrack.baseValue, "PATH_TRIM_START baseValue") : 0;
    const endBase = endTrack ? requireFloat(endTrack.baseValue, "PATH_TRIM_END baseValue") : 1;
    const drawSvgLabel = (start, end) => `${round5(start * 100, 3)}% ${round5(end * 100, 3)}%`;
    const positions = /* @__PURE__ */ new Set();
    for (const keyframe of (_a = startTrack == null ? void 0 : startTrack.keyframes) != null ? _a : []) positions.add(keyframe.timelinePosition);
    for (const keyframe of (_b = endTrack == null ? void 0 : endTrack.keyframes) != null ? _b : []) positions.add(keyframe.timelinePosition);
    const fromVars = { drawSVG: drawSvgLabel(startBase, endBase) };
    const keyframes = {};
    let lastVars = fromVars;
    let lastPercent = 0;
    for (const position of [...positions].sort((a, b) => a - b)) {
      if (position <= 0) continue;
      const start = valueAtOrBefore(startTrack, position, startBase);
      const end = valueAtOrBefore(endTrack, position, endBase);
      const easing = (_d = (_c = start.easing) != null ? _c : end.easing) != null ? _d : { type: "LINEAR" };
      const ease = resolveEase(easing, registry, plugins);
      const vars = { drawSVG: drawSvgLabel(start.value, end.value) };
      const percent = position / timelineDuration * 100;
      keyframes[formatPercentLabel(percent)] = __spreadProps(__spreadValues({}, vars), { ease });
      lastVars = vars;
      lastPercent = percent;
    }
    ensureTerminalKeyframe(keyframes, lastPercent, lastVars);
    return { fromVars, keyframes };
  }
  function renderTween(selector, duration, { fromVars, keyframes }) {
    return `      tl.fromTo(q(${JSON.stringify(selector)}), ${JSON.stringify(fromVars)}, { duration: ${round5(duration, 4)}, keyframes: ${JSON.stringify(keyframes)} }, 0);`;
  }
  var LERP_EASE_HELPER = `    function __figmaLerpEase(points) {
      return function (p) {
        var scaled = Math.max(0, Math.min(1, p)) * (points.length - 1);
        var index = Math.floor(scaled);
        if (index >= points.length - 1) return points[points.length - 1];
        var fraction = scaled - index;
        return points[index] + (points[index + 1] - points[index]) * fraction;
      };
    }`;
  var PLUGIN_GLOBAL_BY_NAME = {
    CustomEase: "CustomEase",
    DrawSVGPlugin: "DrawSVGPlugin",
    TextPlugin: "TextPlugin"
  };
  function renderScript(timelineId, registry, plugins, tweenStatements) {
    const pluginNames = [...plugins];
    const registerPlugin = pluginNames.length > 0 ? `    gsap.registerPlugin(${pluginNames.map((name) => PLUGIN_GLOBAL_BY_NAME[name]).join(", ")});

` : "";
    const easeSetup = [...registry.bezierStatements, ...registry.usesSampledSpring ? [LERP_EASE_HELPER] : [], ...registry.springStatements].join("\n");
    return `(function () {
  function init() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

${registerPlugin}${easeSetup ? easeSetup + "\n\n" : ""}    var build = function (root) {
      var q = gsap.utils.selector(root);
      var tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
${tweenStatements.join("\n")}
      return tl;
    };

    var roots = document.querySelectorAll('[data-timeline="${timelineId}"]');
    (roots.length ? Array.prototype.slice.call(roots) : [document.documentElement]).forEach(function (root) {
      var tl = build(root);
      new IntersectionObserver(function (entries, io) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            tl.play();
            io.disconnect();
          }
        });
      }, { threshold: 0.3 }).observe(root);
    });
  }
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
    : init();
})();
`;
  }
  function emitGsapTimeline(input) {
    var _a;
    const registry = new EaseRegistry();
    const plugins = /* @__PURE__ */ new Set();
    const tweenStatements = [];
    for (const node of input.nodes) {
      const selector = (_a = node.selector) != null ? _a : nodeSelector(node.nodeId);
      const pathTrimStart = node.tracks.find((track) => track.field === "PATH_TRIM_START");
      const pathTrimEnd = node.tracks.find((track) => track.field === "PATH_TRIM_END");
      if (pathTrimStart || pathTrimEnd) {
        tweenStatements.push(renderTween(selector, input.duration, buildDrawSvgTween(pathTrimStart, pathTrimEnd, input.duration, registry, plugins)));
      }
      for (const track of node.tracks) {
        if (track.field === "PATH_TRIM_START" || track.field === "PATH_TRIM_END") continue;
        if (track.baseValue.type === "TEXT_DATA") {
          tweenStatements.push(renderTween(selector, input.duration, buildTextTween(track, input.duration, registry, plugins)));
          continue;
        }
        const gsapKeys = gsapKeysForField(track.field);
        if (!gsapKeys) {
          console.warn("[gsap-emitter] unsupported KeyframeField, skipping:", track.field);
          continue;
        }
        tweenStatements.push(renderTween(selector, input.duration, buildPropertyTween(track, gsapKeys, input.duration, registry, plugins)));
      }
    }
    return { js: renderScript(input.timelineId, registry, plugins, tweenStatements), usedPlugins: [...plugins] };
  }

  // src/targets/django/motion/export-assets.ts
  var EMPTY_MOTION_EXPORT_ARTIFACTS = {
    animation: { css: "", js: "", gsapPlugins: [] },
    animationLinks: { animationsCss: false, animationsJs: false, gsapPlugins: [] }
  };
  var DURATION_EPSILON = 1e-4;
  function sameDuration(a, b) {
    return Math.abs(a - b) <= DURATION_EPSILON;
  }
  function syntheticTimeline(track) {
    return {
      id: `timeline-${String(track.timelineDuration).replace(/[^a-zA-Z0-9_-]+/g, "-") || "0"}`,
      duration: track.timelineDuration
    };
  }
  function timelineForTrack(nodeId, snapshot, track) {
    if (snapshot.timelines.length === 0) return syntheticTimeline(track);
    const durationMatch = snapshot.timelines.find((timeline) => sameDuration(timeline.duration, track.timelineDuration));
    if (durationMatch) return durationMatch;
    if (snapshot.timelines.length === 1) return snapshot.timelines[0];
    console.warn(
      `[motion] node "${nodeId}" has multiple timelines but track "${track.field}" has no timeline id; skipping ambiguous track`
    );
    return null;
  }
  function groupTimelines(nodes) {
    var _a, _b;
    const groups = /* @__PURE__ */ new Map();
    for (const node of nodes) {
      for (const track of node.snapshot.tracks) {
        const timeline = timelineForTrack(node.nodeId, node.snapshot, track);
        if (!timeline) continue;
        const group = (_a = groups.get(timeline.id)) != null ? _a : {
          id: timeline.id,
          duration: timeline.duration,
          nodes: /* @__PURE__ */ new Map()
        };
        if (!groups.has(timeline.id)) groups.set(timeline.id, group);
        if (group.duration <= 0 && track.timelineDuration > 0) group.duration = track.timelineDuration;
        const nodeTracks = (_b = group.nodes.get(node.nodeId)) != null ? _b : { nodeId: node.nodeId, tracks: [] };
        nodeTracks.tracks.push(track);
        group.nodes.set(node.nodeId, nodeTracks);
      }
    }
    return [...groups.values()];
  }
  function cssIdentPart(value) {
    return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "motion";
  }
  function nodeSelector2(nodeId) {
    return `.${toClassName(nodeId)}`;
  }
  function animationName(nodeId, timelineId, track) {
    return `${toClassName(nodeId)}-${cssIdentPart(timelineId)}-${track.field.toLowerCase().replace(/_/g, "-")}`;
  }
  function isCssTrackSupported(selector, timelineId, nodeId, track) {
    try {
      emitNodeAnimationCss({
        selector,
        tracks: [track],
        nameForTrack: () => animationName(nodeId, timelineId, track)
      });
      return true;
    } catch (error) {
      console.warn(`[motion] skipping unsupported CSS animation track "${track.field}" on node "${nodeId}"`, error);
      return false;
    }
  }
  function emitCssTimeline(group) {
    const blocks = [];
    for (const node of group.nodes.values()) {
      const selector = nodeSelector2(node.nodeId);
      const tracks = node.tracks.filter((track) => isCssTrackSupported(selector, group.id, node.nodeId, track));
      if (tracks.length === 0) continue;
      blocks.push(
        emitNodeAnimationCss({
          selector,
          tracks,
          nameForTrack: (track) => animationName(node.nodeId, group.id, track)
        })
      );
    }
    return blocks.join("\n\n");
  }
  function emitGsapTimelineGroup(group) {
    const nodes = [...group.nodes.values()].map((node) => ({
      nodeId: node.nodeId,
      selector: nodeSelector2(node.nodeId),
      tracks: node.tracks
    }));
    return emitGsapTimeline({ timelineId: group.id, duration: group.duration, nodes });
  }
  function emitMotionExportArtifacts(nodes) {
    const cssBlocks = [];
    const jsBlocks = [];
    const usedPlugins = /* @__PURE__ */ new Set();
    for (const group of groupTimelines(nodes)) {
      const nodeTracks = [...group.nodes.values()];
      const tracks = nodeTracks.flatMap((node) => node.tracks);
      if (tracks.length === 0) continue;
      const decision = pickBackend({ tracks, nodeCount: nodeTracks.length, trigger: "autoplay" });
      if (decision.backend === "css") {
        const css = emitCssTimeline(group);
        if (css) cssBlocks.push(css);
        continue;
      }
      try {
        const result = emitGsapTimelineGroup(group);
        if (result.js.trim()) jsBlocks.push(result.js);
        result.usedPlugins.forEach((plugin) => usedPlugins.add(plugin));
      } catch (error) {
        console.warn(`[motion] failed to emit GSAP timeline "${group.id}", skipping`, error);
      }
    }
    const animation = {
      css: cssBlocks.join("\n\n"),
      js: jsBlocks.join("\n\n"),
      gsapPlugins: [...usedPlugins]
    };
    return {
      animation,
      animationLinks: {
        animationsCss: animation.css.length > 0,
        animationsJs: animation.js.length > 0,
        gsapPlugins: animation.gsapPlugins
      }
    };
  }

  // src/targets/design-md/audit.ts
  var TYPO_FIELDS = ["fontFamily", "fontStyle", "fontWeight", "fontSize", "letterSpacing", "lineHeight"];
  function boundFieldCount(boundVariables) {
    if (!boundVariables) return 0;
    return TYPO_FIELDS.filter((field) => typeof boundVariables[field] === "string" && boundVariables[field]).length;
  }
  function presentFieldCount(style) {
    let count = 0;
    if (style.fontName) count += 2;
    if (typeof style.fontSize === "number") count += 1;
    if (style.lineHeight) count += 1;
    if (style.letterSpacing) count += 1;
    return count;
  }
  var MAX_MISSING_REPORTED = 12;
  function buildTokenAudit(graph) {
    var _a, _b, _c, _d, _e, _f;
    const collections = ((_a = graph.collections) != null ? _a : []).map((collection) => {
      var _a2, _b2;
      return {
        name: collection.name,
        modes: ((_a2 = collection.modes) != null ? _a2 : []).map((mode) => mode.name),
        variableCount: ((_b2 = graph.variables) != null ? _b2 : []).filter((variable) => variable.collectionId === collection.id).length,
        generated: collection.generated === true
      };
    });
    const textStyles = (_b = graph.textStyles) != null ? _b : [];
    let detached = 0;
    let partial = 0;
    for (const style of textStyles) {
      const bound = boundFieldCount(style.boundVariables);
      if (bound === 0) detached++;
      else if (bound < presentFieldCount(style)) partial++;
    }
    const missingModeValues = [];
    const collectionById = new Map(((_c = graph.collections) != null ? _c : []).map((collection) => [collection.id, collection]));
    for (const variable of (_d = graph.variables) != null ? _d : []) {
      const collection = collectionById.get(variable.collectionId);
      if (!collection) continue;
      for (const mode of (_e = collection.modes) != null ? _e : []) {
        if (Object.prototype.hasOwnProperty.call((_f = variable.valuesByMode) != null ? _f : {}, mode.modeId)) continue;
        if (missingModeValues.length < MAX_MISSING_REPORTED) missingModeValues.push(`${variable.name} \xB7 ${mode.name}`);
      }
    }
    const named = (name) => collections.some((collection) => collection.name.trim().toLowerCase() === name);
    return {
      textStyleCount: textStyles.length,
      detachedTextStyles: detached,
      partiallyBoundTextStyles: partial,
      collections,
      singleModeCollections: collections.filter((collection) => collection.modes.length === 1).map((collection) => collection.name),
      missingModeValues,
      hasTypographyCollection: named("typography"),
      hasGeneratedTypographyCollection: collections.some((collection) => collection.generated),
      hasBreakpointCollection: named("breakpoints")
    };
  }
  function auditGuardrails(audit) {
    const rules = [];
    if (audit.textStyleCount > 0 && audit.detachedTextStyles > 0) {
      rules.push(
        `**WARNING \u2014 ${audit.detachedTextStyles}/${audit.textStyleCount} Figma text styles are not bound to variables.** Their font values were read off the style and frozen into the tokens below. Use the \`typography/*\` tokens as the source of truth; never hand-tune a font value in CSS.`
      );
    }
    if (audit.partiallyBoundTextStyles > 0) {
      rules.push(
        `${audit.partiallyBoundTextStyles} text style(s) are only partially bound to variables \u2014 some axes are literals. Treat every emitted typography token as authoritative anyway; do not mix token references with literal font values in one rule.`
      );
    }
    if (audit.missingModeValues.length > 0) {
      rules.push(
        `${audit.missingModeValues.length}${audit.missingModeValues.length >= 12 ? "+" : ""} variable/mode pair(s) have no value (${audit.missingModeValues.slice(0, 3).join(", ")}\u2026) and fall back to the default mode. Do not rely on those tokens differing per theme.`
      );
    }
    if (!audit.hasTypographyCollection && audit.textStyleCount > 0) {
      rules.push(
        "There is no `Typography` variable collection \u2014 the type scale is derived from Figma text styles. Adding a font value that is not in the scale below breaks that derivation."
      );
    }
    if (!audit.hasBreakpointCollection) {
      rules.push(
        "There is no `Breakpoints` variable collection \u2014 responsive widths are not tokenized. Use the breakpoints listed in this file (or the project defaults) and never introduce a new one."
      );
    }
    return rules;
  }

  // src/targets/design-md/model.ts
  var ROLE_ORDER = [
    "surface",
    "text",
    "border",
    "icon",
    "shadow",
    "blur",
    "color",
    "spacing",
    "radius",
    "border-width",
    "size",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
    "paragraph",
    "breakpoint",
    "z-index",
    "opacity",
    "duration",
    "easing",
    "flag",
    "other"
  ];
  var ROLE_INFO = {
    surface: { label: "Surface / background", css: "background-color", rule: "Container and page backgrounds. Never pair with a hand-picked text color \u2014 use a `text` token." },
    text: { label: "Text / foreground", css: "color", rule: "Text and label color. Pick the one whose name matches the surface it sits on." },
    border: { label: "Border / divider", css: "border-color", rule: "Borders, dividers, outlines, focus rings." },
    icon: { label: "Icon", css: "color (SVG uses fill: currentColor)", cssShort: "fill / color", rule: "Set `color` on the icon wrapper and let the SVG inherit it." },
    shadow: { label: "Shadow / elevation", css: "box-shadow", rule: "Use as-is; do not re-tune blur, spread or color. Focus rings live here too." },
    blur: { label: "Blur", css: "filter / backdrop-filter", rule: "Ready-made `blur(\u2026)` function \u2014 pick `backdrop-filter` for overlays, `filter` for the element itself." },
    color: {
      label: "Color (unscoped)",
      css: "color / background-color / border-color",
      rule: "Neither the name nor a Figma scope says which property this is for \u2014 read the token path and the component section before applying it. Scoping the variable in Figma (fill / text / stroke) makes the next export state the property exactly."
    },
    spacing: { label: "Spacing", css: "padding / margin / gap", rule: "The ONLY allowed spacing values. No arbitrary px." },
    radius: { label: "Radius", css: "border-radius", rule: "The only allowed corner radii." },
    "border-width": { label: "Border width", css: "border-width / outline-width", rule: "Stroke thickness." },
    size: { label: "Size", css: "width / height / min-* / max-*", rule: "Fixed dimensions (icon boxes, control heights, container widths)." },
    "font-family": { label: "Font family", css: "font-family", rule: "Never name a font directly in CSS \u2014 reference the token." },
    "font-size": { label: "Font size", css: "font-size", rule: "The whole type scale. Do not interpolate intermediate sizes." },
    "font-weight": { label: "Font weight", css: "font-weight", rule: "Only these weights \u2014 a weight not on this list has no matching font face." },
    "line-height": { label: "Line height", css: "line-height", rule: "Unit-less values are ratios; `px` values are absolute." },
    "letter-spacing": { label: "Letter spacing", css: "letter-spacing", rule: "Tracking, in em or px as exported." },
    paragraph: { label: "Paragraph spacing / indent", css: "margin-block-end / text-indent", rule: "Figma paragraph metrics \u2014 apply to block text, not to headings." },
    breakpoint: { label: "Breakpoint", css: "@media (min-width: \u2026)", rule: "The only breakpoints. Never invent a media query width." },
    "z-index": { label: "Z-index / layering", css: "z-index", rule: "Stacking order \u2014 keep the scale, do not add ad-hoc values." },
    opacity: { label: "Opacity", css: "opacity", rule: "Use the token instead of a literal decimal." },
    duration: { label: "Motion duration", css: "transition-duration / animation-duration", rule: "Animation timing comes from tokens, not from taste." },
    easing: { label: "Motion easing", css: "transition-timing-function", rule: "Use the exported curve, not `ease-in-out`." },
    flag: { label: "Boolean flag", css: "\u2014 (build-time switch)", rule: "Not a CSS value: a design-system switch. Read it, do not render it." },
    other: { label: "Unclassified", css: "\u2014", rule: "No role keyword in the name \u2014 inspect the path before using it." }
  };
  function keywords(...words) {
    return new RegExp(`(^|-)(?:${words.join("|")})(?:es|s)?(-|$)`);
  }
  var ROLE_RULES = [
    { role: "font-family", test: keywords("font-family", "font-familie", "typeface", "font-stack") },
    { role: "font-size", test: keywords("font-size", "text-size", "type-size", "fontsize") },
    { role: "font-weight", test: keywords("font-weight", "weight", "fontweight") },
    { role: "line-height", test: keywords("line-height", "leading", "lineheight") },
    { role: "letter-spacing", test: keywords("letter-spacing", "tracking", "letterspacing") },
    { role: "paragraph", test: keywords("paragraph-spacing", "paragraph-indent", "paragraph") },
    { role: "breakpoint", test: keywords("breakpoint", "screen", "viewport") },
    { role: "duration", test: keywords("duration", "delay", "speed") },
    { role: "easing", test: keywords("ease", "easing", "curve", "bezier", "timing") },
    { role: "z-index", test: keywords("z", "z-index", "zindex", "layer", "stack") },
    { role: "opacity", test: keywords("opacity", "alpha", "transparency") },
    { role: "radius", test: keywords("radius", "radii", "corner", "rounded", "roundness") },
    { role: "border-width", test: keywords("border-width", "stroke-width", "outline-width", "border-size") },
    { role: "spacing", test: keywords("spacing", "space", "gap", "padding", "margin", "inset", "gutter") },
    { role: "shadow", test: keywords("shadow", "elevation", "glow") },
    { role: "blur", test: keywords("blur", "frost") },
    { role: "icon", test: keywords("icon", "glyph"), types: ["color"] },
    { role: "border", test: keywords("border", "stroke", "outline", "divider", "separator", "rule"), types: ["color"] },
    { role: "text", test: keywords("text", "fg", "foreground", "label", "content", "ink", "caption", "heading", "title", "on"), types: ["color"] },
    { role: "surface", test: keywords("bg", "background", "surface", "canvas", "fill", "backdrop", "elevated", "card", "sheet"), types: ["color"] },
    { role: "size", test: keywords("size", "width", "height", "dimension", "min", "max") }
  ];
  var SCOPE_ROLES = {
    // Figma distinguishes the CONTAINER fill from the VECTOR fill: a token scoped to SHAPE_FILL is
    // an icon/graphic color, not a background. Collapsing both into "surface" mislabels every
    // icon token in a library that scopes properly.
    FRAME_FILL: ["surface"],
    SHAPE_FILL: ["icon"],
    TEXT_FILL: ["text"],
    ALL_FILLS: ["surface", "icon", "text"],
    STROKE_COLOR: ["border"],
    EFFECT_COLOR: ["shadow"],
    STROKE_FLOAT: ["border-width"],
    CORNER_RADIUS: ["radius"],
    GAP: ["spacing"],
    WIDTH_HEIGHT: ["size"],
    OPACITY: ["opacity"],
    FONT_FAMILY: ["font-family"],
    FONT_STYLE: ["font-family"],
    FONT_WEIGHT: ["font-weight"],
    FONT_SIZE: ["font-size"],
    LINE_HEIGHT: ["line-height"],
    LETTER_SPACING: ["letter-spacing"],
    PARAGRAPH_SPACING: ["paragraph"],
    PARAGRAPH_INDENT: ["paragraph"]
  };
  function rolesFromScopes(scopes) {
    var _a;
    if (!scopes || scopes.length === 0) return [];
    const roles = /* @__PURE__ */ new Set();
    for (const scope of scopes) {
      for (const role of (_a = SCOPE_ROLES[scope]) != null ? _a : []) roles.add(role);
    }
    return ROLE_ORDER.filter((role) => roles.has(role));
  }
  function parseCollectionRoles(raw) {
    const out = {};
    if (!raw) return out;
    for (const pair2 of raw.split(/[,;\n]+/)) {
      const separator = pair2.indexOf(pair2.indexOf(":") !== -1 ? ":" : "=");
      if (separator === -1) continue;
      const collection = pair2.slice(0, separator).trim().toLowerCase();
      const role = pair2.slice(separator + 1).trim().toLowerCase();
      if (!collection || !role) continue;
      if (Object.prototype.hasOwnProperty.call(ROLE_INFO, role)) out[collection] = role;
    }
    return out;
  }
  function classifyRole(slug2, type) {
    for (const rule of ROLE_RULES) {
      if (rule.types && rule.types.indexOf(type) === -1) continue;
      if (rule.test.test(slug2)) return rule.role;
    }
    if (type === "color") return "color";
    if (type === "boolean") return "flag";
    return "other";
  }
  var STATE_WORDS = [
    "focus-visible",
    "focused",
    "focus",
    "hovered",
    "hover",
    "pressed",
    "press",
    "activated",
    "active",
    "disabled",
    "readonly",
    "selected",
    "checked",
    "visited",
    "expanded",
    "collapsed",
    "loading",
    "error",
    "invalid"
  ];
  var BASE_WORDS = ["default", "rest", "resting", "enabled", "normal", "idle", "base"];
  function splitState(slug2) {
    for (const state of STATE_WORDS) {
      if (slug2 === state) return { base: "", state };
      if (slug2.endsWith(`-${state}`)) return { base: slug2.slice(0, -(state.length + 1)), state };
    }
    for (const word of BASE_WORDS) {
      if (slug2 === word) return { base: "" };
      if (slug2.endsWith(`-${word}`)) return { base: slug2.slice(0, -(word.length + 1)) };
    }
    return { base: slug2 };
  }
  var IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  function tsAccessorOf(path) {
    return path.reduce(
      (acc, segment) => IDENTIFIER.test(segment) ? `${acc}.${segment}` : `${acc}[${JSON.stringify(segment)}]`,
      "tokens"
    );
  }
  var COLOR_ROLES = ["surface", "text", "border", "icon", "shadow"];
  function joinCss(roles) {
    var _a;
    const seen = [];
    for (const role of roles) {
      const css = (_a = ROLE_INFO[role].cssShort) != null ? _a : ROLE_INFO[role].css;
      for (const part of css.split(" / ")) if (seen.indexOf(part) === -1) seen.push(part);
    }
    return seen.join(" / ");
  }
  var LIFECYCLE_WORDS = ["experimental", "deprecated", "legacy", "wip", "draft", "temp", "temporary", "obsolete", "unused"];
  function lifecycleOf(path) {
    for (const segment of path) {
      for (const word of segment.split(/[^A-Za-z]+/)) {
        if (word && LIFECYCLE_WORDS.indexOf(word.toLowerCase()) !== -1) return word.toLowerCase();
      }
    }
    return void 0;
  }
  function inheritSiblingRoles(entries) {
    const byParent = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      const parent = entry.path.slice(0, -1).join("/");
      const bucket = byParent.get(parent);
      if (bucket) bucket.push(entry);
      else byParent.set(parent, [entry]);
    }
    for (const bucket of byParent.values()) {
      const anchors = new Set(
        bucket.filter((entry) => !entry.state && COLOR_ROLES.indexOf(entry.role) !== -1).map((entry) => entry.role)
      );
      if (anchors.size !== 1) continue;
      const [role] = [...anchors];
      for (const entry of bucket) if (entry.state && entry.role === "color" && entry.roleSource === "name") entry.role = role;
    }
  }
  function buildTokenEntries(tree, themes, defaultTheme, collectionRoles = {}) {
    const themeList = themes.length > 0 ? themes : [defaultTheme];
    const entries = leaves(tree).map(({ path, token: token2 }) => {
      var _a, _b, _c, _d;
      const slug2 = varName(path);
      const type = String(token2.$type || "");
      const { base, state } = splitState(slug2);
      const themeValues = {};
      for (const theme of themeList) themeValues[theme] = cssValue(valueForTheme(token2, theme), path);
      const distinct = new Set(Object.keys(themeValues).map((theme) => themeValues[theme]));
      const scopeRoles = rolesFromScopes((_b = (_a = token2.$extensions) == null ? void 0 : _a.figma) == null ? void 0 : _b.scopes);
      const collection = (_c = collectionOf(token2)) == null ? void 0 : _c.trim().toLowerCase();
      const named = collection === "breakpoints" && type === "number" ? "breakpoint" : classifyRole(base || slug2, type);
      const mapped = scopeRoles.length === 0 && named === "other" ? collectionRoles[collection != null ? collection : ""] : void 0;
      const role = mapped != null ? mapped : scopeRoles.length === 0 ? named : scopeRoles.indexOf(named) !== -1 ? named : scopeRoles[0];
      return {
        path,
        slug: slug2,
        cssRef: `var(--${slug2})`,
        tsAccessor: tsAccessorOf(path),
        type,
        role,
        roleSource: mapped ? "collection" : scopeRoles.length > 0 ? "scope" : "name",
        scopeRoles,
        applyTo: scopeRoles.length > 0 ? joinCss(scopeRoles) : ROLE_INFO[role].css,
        state,
        lifecycle: lifecycleOf(path),
        collection: collectionOf(token2),
        value: (_d = themeValues[defaultTheme]) != null ? _d : cssValue(token2.$value, path),
        themeValues,
        themed: distinct.size > 1
      };
    });
    inheritSiblingRoles(entries);
    return entries;
  }
  var TYPO_AXES = [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "paragraph-spacing",
    "paragraph-indent"
  ];
  function collectTypography(entries) {
    const byStyle = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      if (entry.path.length < 3) continue;
      if (entry.path[0].toLowerCase() !== "typography") continue;
      const axis = entry.path[entry.path.length - 1];
      if (TYPO_AXES.indexOf(axis) === -1) continue;
      const stylePath = entry.path.slice(0, -1);
      const key = stylePath.join("/");
      let style = byStyle.get(key);
      if (!style) {
        style = { name: stylePath.slice(1).join("/"), path: stylePath, axes: {} };
        byStyle.set(key, style);
      }
      style.axes[axis] = entry;
    }
    return [...byStyle.values()];
  }
  var COMPONENT_WORDS = [
    "button",
    "btn",
    "card",
    "input",
    "field",
    "form",
    "select",
    "checkbox",
    "radio",
    "switch",
    "toggle",
    "slider",
    "badge",
    "chip",
    "tag",
    "pill",
    "alert",
    "toast",
    "banner",
    "modal",
    "dialog",
    "drawer",
    "offcanvas",
    "popover",
    "tooltip",
    "dropdown",
    "menu",
    "nav",
    "navbar",
    "sidebar",
    "tab",
    "table",
    "list",
    "pagination",
    "breadcrumb",
    "accordion",
    "progress",
    "spinner",
    "avatar",
    "header",
    "footer",
    "panel",
    "link",
    "stepper",
    "skeleton",
    "divider",
    "segmented",
    "timeline",
    "upload",
    "calendar",
    "carousel",
    "filter",
    "rating",
    "toolbar",
    "snackbar",
    "notification",
    "datepicker",
    "tile",
    "hero",
    "empty",
    "logo",
    "avatar",
    "sheet"
  ];
  var COMPONENT_WORD_SET = new Set(COMPONENT_WORDS);
  function isComponentWord(segment) {
    const lower = segment.toLowerCase();
    return COMPONENT_WORD_SET.has(lower) || COMPONENT_WORD_SET.has(lower.replace(/e?s$/, ""));
  }
  function titleCase(segment) {
    return segment.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  var BASE_VARIANT = "(base)";
  function componentSegmentIndex(path) {
    for (let index = 0; index < path.length - 1; index++) {
      const segment = path[index].toLowerCase();
      if ((segment === "component" || segment === "components") && index + 1 < path.length - 1) return index + 1;
      if (isComponentWord(segment)) return index;
    }
    return -1;
  }
  function detectComponentBlocks(entries) {
    const blocks = /* @__PURE__ */ new Map();
    const leftovers = [];
    for (const entry of entries) {
      if (entry.path.length < 3) continue;
      if (entry.path[0].toLowerCase() === "typography") continue;
      const index = componentSegmentIndex(entry.path);
      if (index === -1) {
        leftovers.push(entry);
        continue;
      }
      const prefix = entry.path.slice(0, index + 1);
      const key = prefix.join("/");
      let block2 = blocks.get(key);
      if (!block2) {
        block2 = { name: titleCase(prefix[prefix.length - 1]), prefix, variants: [], entryCount: 0 };
        blocks.set(key, block2);
      }
      const variantName2 = entry.path.slice(index + 1, -1).map(titleCase).join(" \xB7 ") || BASE_VARIANT;
      let variant2 = block2.variants.find((candidate) => candidate.name === variantName2);
      if (!variant2) {
        variant2 = { name: variantName2, entries: [] };
        block2.variants.push(variant2);
      }
      variant2.entries.push(entry);
      block2.entryCount++;
    }
    const byPrefix = /* @__PURE__ */ new Map();
    for (const entry of leftovers) {
      const prefix = entry.path.slice(0, -1).join("/");
      const bucket = byPrefix.get(prefix);
      if (bucket) bucket.push(entry);
      else byPrefix.set(prefix, [entry]);
    }
    for (const [prefix, bucket] of byPrefix) {
      const roles = new Set(bucket.map((entry) => entry.role));
      const hasStates = bucket.some((entry) => entry.state);
      if (bucket.length < 2 || roles.size < 2 && !hasStates) continue;
      const segments = prefix.split("/");
      blocks.set(prefix, {
        name: titleCase(segments[segments.length - 1]),
        prefix: segments,
        variants: [{ name: BASE_VARIANT, entries: bucket }],
        entryCount: bucket.length
      });
    }
    for (const block2 of blocks.values()) {
      block2.variants.sort((a, b) => a.name === BASE_VARIANT ? -1 : b.name === BASE_VARIANT ? 1 : a.name.localeCompare(b.name));
    }
    return [...blocks.values()].sort(
      (a, b) => b.entryCount - a.entryCount || a.prefix.join("/").localeCompare(b.prefix.join("/"))
    );
  }
  function findDuplicateValues(entries, type = "color") {
    const byValue = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      if (entry.type !== type) continue;
      if (entry.value.startsWith("var(")) continue;
      const bucket = byValue.get(entry.value);
      if (bucket) bucket.push(entry.slug);
      else byValue.set(entry.value, [entry.slug]);
    }
    const out = [];
    for (const [value, slugs] of byValue) if (slugs.length > 1) out.push({ value, slugs });
    return out.sort((a, b) => b.slugs.length - a.slugs.length);
  }
  function buildTokenModel(tree, themes, defaultTheme, collectionRoles = {}) {
    const entries = buildTokenEntries(tree, themes, defaultTheme, collectionRoles);
    const byRole = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      const bucket = byRole.get(entry.role);
      if (bucket) bucket.push(entry);
      else byRole.set(entry.role, [entry]);
    }
    return {
      entries,
      byRole,
      typography: collectTypography(entries),
      components: detectComponentBlocks(entries),
      duplicateColors: findDuplicateValues(entries),
      themes: themes.length > 0 ? [...themes] : [defaultTheme],
      defaultTheme
    };
  }

  // src/targets/design-md/sections.ts
  var MAX_ROWS = 120;
  function escapeCell(value) {
    return String(value).replace(/\|/g, "\\|").replace(/\n+/g, " ");
  }
  function mdTable(headers, rows) {
    const head = `| ${headers.join(" | ")} |`;
    const sep = `| ${headers.map(() => "---").join(" | ")} |`;
    const body = rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`);
    return [head, sep, ...body].join("\n");
  }
  function pxToRem(value) {
    const match = /^(-?\d*\.?\d+)px$/.exec(value.trim());
    if (!match) return null;
    const rem = Number(match[1]) / 16;
    if (!isFinite(rem)) return null;
    return `${Number(rem.toFixed(4))}rem`;
  }
  function withRem(value) {
    const rem = pxToRem(value);
    return rem ? `${value} / ${rem}` : value;
  }
  function bullet(lines) {
    return lines.map((line) => `- ${line}`).join("\n");
  }
  function renderSections(sections) {
    return sections.filter(([, content]) => content.trim().length > 0).map(([title, content], index) => `## ${index}. ${title}

${content}`).join("\n\n");
  }
  function cappedTable(headers, rows, more) {
    if (rows.length <= MAX_ROWS) return mdTable(headers, rows);
    const rest = rows.slice(MAX_ROWS);
    const names = rest.map((row) => {
      var _a;
      return (_a = row[1]) != null ? _a : row[0];
    }).join(", ");
    return `${mdTable(headers, rows.slice(0, MAX_ROWS))}

_+${rest.length} more of this role \u2014 values in ${more}:_ ${names}`;
  }
  function roleIndexSection(model) {
    const rows = [];
    for (const role of ROLE_ORDER) {
      const entries = model.byRole.get(role);
      if (!entries || entries.length === 0) continue;
      const info = ROLE_INFO[role];
      const sample = entries.slice(0, 3).map((entry) => `\`${entry.cssRef}\``).join(", ");
      const scoped = entries.filter((entry) => entry.roleSource === "scope").length;
      const count = scoped === entries.length ? String(entries.length) : `${entries.length} (${scoped} scoped)`;
      rows.push([info.label, `\`${info.css}\``, count, sample, info.rule]);
    }
    return mdTable(["Role", "Apply to", "Tokens", "Examples", "Rule"], rows);
  }
  function valueColumns(model) {
    return model.themes.length > 1 ? model.themes : [];
  }
  function entryRow(entry, themes) {
    const values = themes.length > 0 ? themes.map((theme) => {
      var _a;
      return `\`${(_a = entry.themeValues[theme]) != null ? _a : entry.value}\``;
    }) : [`\`${entry.value}\``];
    return [`\`${entry.path.join("/")}\``, `\`${entry.cssRef}\``, ...values, `\`${entry.applyTo}\``];
  }
  function tokenReferenceSection(model) {
    const themes = valueColumns(model);
    const valueHeaders = themes.length > 0 ? themes.map((theme) => `Value \xB7 ${theme}`) : ["Value"];
    const headers = ["Figma token", "CSS variable", ...valueHeaders, "Apply to"];
    const chunks = [];
    for (const role of ROLE_ORDER) {
      const entries = model.byRole.get(role);
      if (!entries || entries.length === 0) continue;
      const rows = entries.map((entry) => entryRow(entry, themes));
      chunks.push(
        `### ${ROLE_INFO[role].label} (${entries.length})

` + cappedTable(headers, rows, "the complete set is in `tokens.css` / `tokens.json`")
      );
    }
    return chunks.length > 0 ? chunks.join("\n\n") : "_No tokens in this export._";
  }
  var COMPONENT_DETAIL_LIMIT = 60;
  var MAX_ROLE_COLUMNS = 6;
  function variantCell(entries) {
    if (entries.length === 0) return "\u2014";
    return entries.map((entry) => entry.scopeRoles.length > 1 ? `\`${entry.cssRef}\` (${entry.applyTo})` : `\`${entry.cssRef}\``).join(" ");
  }
  function stateCell(entries) {
    if (entries.length === 0) return "\u2014";
    return entries.map((entry) => `${entry.state} \`${entry.cssRef}\``).join(", ");
  }
  function componentMatrix(block2) {
    const rolesPresent = ROLE_ORDER.filter(
      (role) => block2.variants.some((variant2) => variant2.entries.some((entry) => entry.role === role && !entry.state))
    );
    const roles = rolesPresent.slice(0, MAX_ROLE_COLUMNS);
    const hasStates = block2.variants.some((variant2) => variant2.entries.some((entry) => entry.state));
    const headers = ["Variant", ...roles.map((role) => ROLE_INFO[role].label), ...hasStates ? ["States"] : []];
    const rows = block2.variants.map((variant2) => [
      variant2.name,
      ...roles.map((role) => variantCell(variant2.entries.filter((entry) => entry.role === role && !entry.state))),
      ...hasStates ? [stateCell(variant2.entries.filter((entry) => entry.state))] : []
    ]);
    const applyLine = roles.map((role) => `${ROLE_INFO[role].label} \u2192 \`${ROLE_INFO[role].css}\``).join(" \xB7 ");
    const unscoped = block2.variants.some(
      (variant2) => variant2.entries.some((entry) => entry.role === "color" && entry.roleSource === "name")
    );
    const unscopedNote = unscoped ? "\n\n_These tokens carry no role in their name and no Figma scope: they are this component's own colors \u2014 apply each one where the component uses it, and do not reuse them elsewhere._" : "";
    const dropped = rolesPresent.length > roles.length ? `

_${rolesPresent.length - roles.length} further role(s) on this component are listed in the token reference._` : "";
    return `### ${block2.name}

Figma group \`${block2.prefix.join("/")}\` \xB7 ${block2.entryCount} token(s)` + (applyLine ? `

Apply: ${applyLine}` : "") + `

${mdTable(headers, rows)}${unscopedNote}${dropped}`;
  }
  function componentBlocksSection(blocks, limit = COMPONENT_DETAIL_LIMIT) {
    if (blocks.length === 0) {
      return "_No component-scoped token groups found._ Tokens are grouped by type only, so pick them by role (previous section) and keep the choice consistent across a component.";
    }
    const shown = blocks.slice(0, limit);
    const chunks = shown.map(componentMatrix);
    if (blocks.length > shown.length) {
      const rest = blocks.slice(limit);
      chunks.push(
        `### Further component groups (${rest.length})

` + mdTable(
          ["Component", "Figma group", "Tokens", "Variants"],
          rest.map((block2) => [
            block2.name,
            `\`${block2.prefix.join("/")}\``,
            String(block2.entryCount),
            block2.variants.map((variant2) => variant2.name).slice(0, 8).join(", ")
          ])
        )
      );
    }
    return chunks.join("\n\n");
  }
  var TYPO_COLUMNS = [
    { axis: "font-size", header: "Size (px / rem)", rem: true },
    { axis: "font-weight", header: "Weight" },
    { axis: "line-height", header: "Line height" },
    { axis: "letter-spacing", header: "Letter spacing" },
    { axis: "font-family", header: "Family" }
  ];
  function typographySection(styles) {
    if (styles.length === 0) return "";
    const rows = styles.map((style) => {
      var _a;
      const cells = TYPO_COLUMNS.map(({ axis, rem }) => {
        const entry = style.axes[axis];
        if (!entry) return "\u2014";
        return rem ? withRem(entry.value) : entry.value;
      });
      const prefix = (_a = style.axes["font-size"]) == null ? void 0 : _a.slug.replace(/-font-size$/, "");
      return [style.name, ...cells, prefix ? `\`--${prefix}-*\`` : "\u2014"];
    });
    const table2 = cappedTable(
      ["Text style", ...TYPO_COLUMNS.map((column) => column.header), "Token prefix"],
      rows,
      "the complete set is in `tokens.css`"
    );
    const sample = styles[0];
    const axes = ["font-family", "font-size", "font-weight", "line-height", "letter-spacing"].filter((axis) => sample.axes[axis]).map((axis) => `  ${axis}: ${sample.axes[axis].cssRef};`).join("\n");
    const className = sample.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "text-style";
    const example = axes ? `

Compose a text style by referencing its tokens \u2014 never by copying the numbers:

\`\`\`css
/* ${sample.name} */
.${className} {
${axes}
}
\`\`\`` : "";
    return `${table2}${example}`;
  }
  function themesSection(model, themeAttribute) {
    const themed = model.entries.filter((entry) => entry.themed).length;
    if (model.themes.length < 2) {
      return `Single theme (\`${model.defaultTheme}\`) \u2014 every variable is declared on \`:root\`. No theme attribute is required.`;
    }
    const others = model.themes.filter((theme) => theme !== model.defaultTheme);
    return `Themes: ${model.themes.map((theme) => `\`${theme}\``).join(", ")} \u2014 \`${model.defaultTheme}\` is the default and is declared on \`:root\`. ${themed} token(s) change value between themes.

Switch by setting \`${themeAttribute}\` on an ancestor (usually \`<html>\`):

\`\`\`html
<html ${themeAttribute}="${others[0]}">
\`\`\`

Every theme block re-declares **every** variable, so a component written with \`var(--\u2026)\` themes itself. Do NOT write theme-specific overrides in component CSS, and do NOT branch on the theme in JS to pick a color.`;
  }
  function breakpointsSection(model, modeWidths) {
    var _a;
    const widths = Object.keys(modeWidths != null ? modeWidths : {}).map((name) => (modeWidths != null ? modeWidths : {})[name]);
    const rows = [...(_a = model.byRole.get("breakpoint")) != null ? _a : []].filter((entry) => widths.indexOf(parseFloat(entry.value)) === -1).sort((a, b) => parseFloat(a.value) - parseFloat(b.value)).map((entry) => [`\`${entry.slug}\``, entry.value, `\`@media (min-width: ${entry.value})\``]);
    const fromModes = Object.keys(modeWidths != null ? modeWidths : {}).map((name) => ({ name, width: (modeWidths != null ? modeWidths : {})[name] })).filter((entry) => typeof entry.width === "number" && isFinite(entry.width)).sort((a, b) => a.width - b.width);
    for (const entry of fromModes) {
      rows.push([`${entry.name} _(Figma mode)_`, `${entry.width}px`, `\`@media (min-width: ${entry.width}px)\``]);
    }
    if (rows.length === 0) return "";
    return `${mdTable(["Token / mode", "Width", "Media query"], rows)}

These are the only breakpoints. CSS custom properties do not work inside a media-query condition, so write the literal width above (or compile it from \`tokens.json\`) \u2014 never a different one.` + (fromModes.length > 0 ? " The widths marked _(Figma mode)_ come from a modes-as-breakpoints collection, so they exist as layout modes in Figma rather than as CSS variables." : "");
  }
  function tokenGuardrails(model) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n;
    const rules = [];
    const colors = [
      ...(_a = model.byRole.get("surface")) != null ? _a : [],
      ...(_b = model.byRole.get("text")) != null ? _b : [],
      ...(_c = model.byRole.get("border")) != null ? _c : [],
      ...(_d = model.byRole.get("icon")) != null ? _d : [],
      ...(_e = model.byRole.get("color")) != null ? _e : []
    ];
    if (colors.length > 0) {
      rules.push(
        `**DO NOT** write raw colors (\`#fff\`, \`rgb(\u2026)\`, \`hsl(\u2026)\`, named colors) in CSS, inline styles, or SVG attributes. ${colors.length} color tokens cover this system; if none fits, the design is missing a token \u2014 say so instead of inventing one.`
      );
    }
    const spacing = (_f = model.byRole.get("spacing")) != null ? _f : [];
    if (spacing.length > 0) {
      const values = [...new Set(spacing.map((entry) => entry.value))].slice(0, 12).join(", ");
      rules.push(
        `**DO NOT** use arbitrary spacing (\`padding: 13px\`, \`gap: 7px\`). Allowed values come from \`--${spacing[0].slug}\`-style tokens only (${values}).`
      );
    }
    const radius = (_g = model.byRole.get("radius")) != null ? _g : [];
    if (radius.length > 0) {
      const values = [...new Set(radius.map((entry) => entry.value))].slice(0, 8).join(", ");
      rules.push(`**DO NOT** invent corner radii. The scale is ${values} \u2014 reference the radius tokens.`);
    }
    const weights = (_h = model.byRole.get("font-weight")) != null ? _h : [];
    if (weights.length > 0) {
      const values = [...new Set(weights.map((entry) => entry.value))].sort().join(", ");
      rules.push(
        `**DO NOT** use a font weight outside ${values} \u2014 other weights have no matching font face and the browser will synthesize (smear) them.`
      );
    }
    const shadows = (_i = model.byRole.get("shadow")) != null ? _i : [];
    if (shadows.length > 0) {
      rules.push(
        `**DO NOT** hand-write a \`box-shadow\` or a focus \`outline\`. ${shadows.length} shadow token(s) cover elevation and focus states \u2014 a custom one will not match the design and will not follow a theme change.`
      );
    }
    const sizes = (_j = model.byRole.get("font-size")) != null ? _j : [];
    if (sizes.length > 0) {
      rules.push(
        `**DO NOT** interpolate font sizes. The type scale has ${sizes.length} step(s); pick the closest existing one.`
      );
      const ordered = sizes.map((entry) => ({ entry, px: parseFloat(entry.value) })).filter((step) => isFinite(step.px)).sort((a, b) => a.px - b.px);
      const nearDuplicates = [];
      for (let index = 1; index < ordered.length; index++) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        if (current.px - previous.px < 0.5) {
          nearDuplicates.push(
            `\`--${previous.entry.slug}\` (${previous.entry.value}) vs \`--${current.entry.slug}\` (${current.entry.value})`
          );
        }
      }
      if (nearDuplicates.length > 0) {
        rules.push(
          `**Probable duplicate type-scale steps** \u2014 less than 0.5px apart, so "pick the closest" cannot choose between them: ${nearDuplicates.join("; ")}. Ask the designer which step is canonical; do not resolve the tie yourself.`
        );
      }
    }
    if (model.duplicateColors.length > 0) {
      const sample = model.duplicateColors.slice(0, 3).map((group) => `${group.value} \u2192 ${group.slugs.map((slug2) => `\`--${slug2}\``).join(" / ")}`).join("; ");
      rules.push(
        `**Pick tokens by role, not by value.** Some tokens currently resolve to the same value (${sample}) \u2014 they are separate on purpose and will diverge.`
      );
    }
    const flagged = model.entries.filter((entry) => entry.lifecycle);
    if (flagged.length > 0) {
      const sample = flagged.slice(0, 8).map((entry) => `\`${entry.cssRef}\` (${entry.lifecycle})`).join(", ");
      rules.push(
        `**DO NOT use tokens the designer marked as not-final** \u2014 ${flagged.length} token(s) carry a lifecycle marker in their name: ${sample}${flagged.length > 8 ? ", \u2026" : ""}. They can change or disappear without notice; pick the stable token for the same role instead.`
      );
    }
    const ambiguous = (_k = model.byRole.get("color")) != null ? _k : [];
    if (ambiguous.length > 0) {
      rules.push(
        `**${ambiguous.length} color token(s) carry no role keyword** (bg/text/border/icon) in their name. Read the token path before applying one, and prefer a role-named token when one exists.`
      );
    }
    const unclassified = (_l = model.byRole.get("other")) != null ? _l : [];
    const numeric = unclassified.filter((entry) => entry.type === "number");
    const nonNumeric = unclassified.filter((entry) => entry.type !== "number");
    if (numeric.length > 0) {
      const collections = [...new Set(numeric.map((entry) => entry.collection).filter(Boolean))];
      const origin = collections.length > 0 ? ` (collection ${collections.map((name) => `\`${name}\``).join(", ")})` : "";
      const noSpacing = ((_m = model.byRole.get("spacing")) != null ? _m : []).length === 0;
      const noRadius = ((_n = model.byRole.get("radius")) != null ? _n : []).length === 0;
      if (noSpacing || noRadius) {
        rules.push(
          `**${numeric.length} numeric token(s)${origin} carry no role \u2014 they ARE this file's ${[noSpacing ? "spacing" : "", noRadius ? "radius" : ""].filter(Boolean).join("/")} scale.** Use them for \`padding\` / \`margin\` / \`gap\` / \`border-radius\`; never write a raw px value instead. If no step fits, report the gap. _Designer: scope these variables in Figma (Gap, Corner radius, Width/height) or map their collection to a role in the export settings \u2014 the next export will then state the property exactly._`
        );
      } else {
        rules.push(
          `${numeric.length} numeric token(s)${origin} carry no role in their name or scopes \u2014 use them only where the path makes the intent obvious, and prefer the role-classified spacing/radius tokens.`
        );
      }
    }
    if (nonNumeric.length > 0) {
      rules.push(
        `${nonNumeric.length} token(s) could not be classified from their name \u2014 treat them as system internals unless the path makes the intent obvious.`
      );
    }
    return rules;
  }
  function agentPromptSection(options) {
    const steps = options.steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
    const never = options.never.map((rule) => `- ${rule}`).join("\n");
    return `\`\`\`text
You are ${options.role}. The design system documented in DESIGN.md is authoritative.

Before writing or editing any UI code:
${steps}

Never:
${never}

If a required value has no token, stop and report the gap instead of inventing a value.
\`\`\``;
  }
  function headerSection(options) {
    const stamp = options.generatedAt ? `
     generated: ${options.generatedAt}` : "";
    return `# DESIGN.md \u2014 ${options.fileName}

<!-- GENERATED by the Altery Design System Export Figma plugin.
     target: ${options.target}
     source of truth: Figma file "${options.fileName}"${stamp}
     Do not hand-edit: re-export from Figma instead. -->

${options.intro}`;
  }

  // src/targets/design-md/token-mentions.ts
  function add(index, key, entry) {
    if (!key) return;
    const existing = index.byKey.get(key);
    if (existing === void 0) {
      index.byKey.set(key, entry);
      return;
    }
    if (existing !== entry) index.byKey.set(key, null);
  }
  function buildMentionIndex(entries) {
    const index = { byKey: /* @__PURE__ */ new Map() };
    for (const entry of entries) {
      add(index, entry.slug, entry);
      for (let start = 1; start < entry.path.length; start++) {
        add(index, varName(entry.path.slice(start)), entry);
      }
    }
    return index;
  }
  function mentionKey(text2) {
    return varName([
      text2.trim().replace(/^--/, "").replace(/^\{|\}$/g, "").replace(/[/.]+/g, "-").replace(/\s+/g, "-")
    ]);
  }
  var REFERENCE_SHAPED = /^(?:--[A-Za-z0-9-]+|\{[^}]+\}|[A-Za-z0-9][A-Za-z0-9_-]*(?:[/.][A-Za-z0-9_-]+)+)$/;
  var CANDIDATE = /--[A-Za-z0-9-]+|\{[^}\n]+\}|[A-Za-z0-9][A-Za-z0-9_-]*(?:[/.][A-Za-z0-9_-]+)*/g;
  var HAS_LETTER = /[A-Za-z]/;
  var RAMP_STEP = /^[A-Za-z]{1,2}\d{2,4}$/;
  function findTokenMentions(description, entries, index = buildMentionIndex(entries)) {
    var _a;
    const resolved = [];
    const unresolved = [];
    const rampMisses = [];
    const seen = /* @__PURE__ */ new Set();
    for (const match of (_a = description.match(CANDIDATE)) != null ? _a : []) {
      const text2 = match.trim();
      const referenceShaped = REFERENCE_SHAPED.test(text2);
      if (!referenceShaped && !HAS_LETTER.test(text2)) continue;
      const key = mentionKey(text2);
      if (!key || seen.has(key)) continue;
      const entry = index.byKey.get(key);
      if (entry) {
        seen.add(key);
        resolved.push({ text: text2, entry });
        continue;
      }
      if (referenceShaped) {
        seen.add(key);
        unresolved.push(text2);
      } else if (RAMP_STEP.test(text2)) {
        seen.add(key);
        rampMisses.push(text2);
      }
    }
    if (resolved.length > 0) unresolved.push(...rampMisses);
    return { resolved, unresolved };
  }

  // src/targets/design-md/component-docs.ts
  var COMPONENTS_FILE = "COMPONENTS.md";
  var ICONS_FILE = "ICONS.md";
  var TAG_SEGMENT = /^[A-Za-z][A-Za-z0-9 '’&/-]{0,40}$/;
  var BEHAVIOUR_LANGUAGE = /\b(if|when|while|unless|until|then|must|should|never|always|only|hover(ed)?|press(ed)?|focus(ed)?|disabled|active|selected|checked|loading|error|invalid|state|states|min|max|fill|chang(e|es|ing)|switch(es)?|toggle(s)?|show(s)?|hide(s)?|limit(s)?)\b|%|\d+\s*px/i;
  function classifyDescription(description, properties = [], resolvedMentionCount = 0) {
    const text2 = description.trim();
    if (!text2) return "notes";
    const segments = text2.split(/[,;\n]+/).map((segment) => segment.trim()).filter(Boolean);
    const tagLike = segments.filter(
      (segment) => TAG_SEGMENT.test(segment) && segment.split(/\s+/).length <= 3
    );
    if (segments.length >= 3 && tagLike.length >= segments.length * 0.8) return "tags";
    if (resolvedMentionCount > 0) return "contract";
    if (BEHAVIOUR_LANGUAGE.test(text2)) return "contract";
    const lower = text2.toLowerCase();
    if (properties.some((property) => property.name && lower.indexOf(property.name.toLowerCase()) !== -1))
      return "contract";
    return "notes";
  }
  function isIconDoc(doc) {
    var _a;
    const description = doc.description.trim();
    if (description) return classifyDescription(description, doc.properties) === "tags";
    return doc.properties.length === 0 && /\bicons?\b/i.test(`${(_a = doc.page) != null ? _a : ""} ${doc.name}`);
  }
  function anchorSlug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function buildAnchors(docs) {
    var _a, _b;
    const nameCounts = /* @__PURE__ */ new Map();
    for (const doc of docs) {
      const base = anchorSlug(doc.name);
      nameCounts.set(base, ((_a = nameCounts.get(base)) != null ? _a : 0) + 1);
    }
    const anchors = /* @__PURE__ */ new Map();
    for (const doc of docs) {
      const base = anchorSlug(doc.name);
      anchors.set(doc.id, ((_b = nameCounts.get(base)) != null ? _b : 0) > 1 ? `${base}--${anchorSlug(doc.id)}` : base);
    }
    return anchors;
  }
  function propertyTable(properties) {
    if (properties.length === 0) return "";
    const rows = properties.map((property) => [
      `\`${property.name}\``,
      property.type.toLowerCase().replace("_", " "),
      property.options && property.options.length > 0 ? property.options.map((option) => `\`${option}\``).join(", ") : "\u2014",
      property.defaultValue !== void 0 && property.defaultValue !== "" ? `\`${property.defaultValue}\`` : "\u2014"
    ]);
    return `

${mdTable(["Property", "Type", "Options", "Default"], rows)}`;
  }
  function quoteDescription(description) {
    return description.split("\n").map((line) => line.trim() ? `> ${line}` : ">").join("\n");
  }
  function mentionsBlock(mentions) {
    if (!mentions) return "";
    const { resolved, unresolved } = mentions;
    const parts = [];
    if (resolved.length > 0) {
      parts.push(
        `**Tokens named above**

` + mdTable(
          ["In the text", "Token", "Use", "Value"],
          resolved.map((mention) => [
            `\`${mention.text}\``,
            `\`${mention.entry.path.join("/")}\``,
            `\`${mention.entry.cssRef}\``,
            `\`${mention.entry.value}\``
          ])
        )
      );
    }
    if (unresolved.length > 0) {
      parts.push(
        `**Stale references:** ${unresolved.map((text2) => `\`${text2}\``).join(", ")} \u2014 written like a variable name but matching nothing in this file (renamed, removed, or ambiguous between several variables). Do NOT invent a value: ask the designer which variable is meant.`
      );
    }
    return parts.length > 0 ? `

${parts.join("\n\n")}` : "";
  }
  function analyzeDocs(docs, tokens) {
    const index = tokens.length > 0 ? buildMentionIndex(tokens) : void 0;
    return docs.map((doc) => {
      var _a;
      const description = doc.description.trim();
      const mentions = description && index ? findTokenMentions(description, tokens, index) : null;
      const kind = description ? classifyDescription(description, doc.properties, (_a = mentions == null ? void 0 : mentions.resolved.length) != null ? _a : 0) : null;
      return { doc, description, kind, mentions };
    });
  }
  function byDocumentation(a, b) {
    const weight = (entry) => entry.kind === "contract" ? 0 : entry.kind === "notes" ? 1 : 2;
    return weight(a) - weight(b) || a.doc.name.localeCompare(b.doc.name);
  }
  var KIND_LABEL = {
    contract: "yes \u2014 behaviour contract",
    notes: "notes",
    tags: "search tags"
  };
  function buildComponentsMd(docs, options) {
    var _a;
    if (docs.length === 0) return "";
    const analyzed = analyzeDocs(docs, (_a = options.tokens) != null ? _a : []).sort(byDocumentation);
    const contracts = analyzed.filter((entry) => entry.kind === "contract");
    const anchors = buildAnchors(analyzed.map((entry) => entry.doc));
    const previewNote = analyzed.some((entry) => entry.doc.preview) ? "" : analyzed.some((entry) => entry.doc.previewError) ? `

_No previews in this package: ${analyzed.find((entry) => entry.doc.previewError).doc.previewError}._` : "\n\n_No previews in this package \u2014 enable Settings \u2192 Documentation \u2192 Component previews and re-scan._";
    const index = mdTable(
      ["Component", "Behaviour documented", "Props", "Preview"],
      analyzed.map(({ doc, kind }) => [
        `[${doc.name}](#${anchors.get(doc.id)})`,
        kind ? KIND_LABEL[kind] : "\u2014",
        doc.properties.length > 0 ? doc.properties.map((property) => `\`${property.name}\``).join(", ") : "\u2014",
        doc.preview ? "yes" : "\u2014"
      ])
    );
    const sections = analyzed.map(({ doc, description, kind, mentions }) => {
      const uniqueAnchor = anchors.get(doc.id);
      const parts = [];
      if (uniqueAnchor !== anchorSlug(doc.name)) parts.push(`<a id="${uniqueAnchor}"></a>`);
      parts.push(`## ${doc.name}`);
      const meta = [doc.page ? `Page: ${doc.page}` : "", `Figma node \`${doc.id}\``].filter(Boolean).join(" \xB7 ");
      parts.push(meta);
      if (doc.preview) parts.push(`![${doc.name}](${doc.preview})`);
      else if (doc.previewError) parts.push(`_No preview: ${doc.previewError}._`);
      if (kind === "contract") {
        parts.push(
          `**Behaviour contract \u2014 implement this:**

${quoteDescription(description)}` + mentionsBlock(mentions)
        );
      } else if (kind === "notes") {
        parts.push(
          `**Designer notes** \u2014 written in Figma, but not phrased as a behaviour rule; treat as context, not as a spec:

${quoteDescription(description)}` + mentionsBlock(mentions)
        );
      } else if (kind === "tags") {
        parts.push(`**Search tags:** ${description.replace(/\s*\n\s*/g, ", ")}`);
      } else {
        parts.push(
          "_No description in Figma._ Implement it from the tokens and the preview, and do not invent behaviour the design does not show."
        );
      }
      const properties = propertyTable(doc.properties);
      if (properties) parts.push(`**Properties**${properties}`);
      if (doc.links.length > 0) {
        parts.push(`**Documentation:** ${doc.links.map((link) => `<${link}>`).join(", ")}`);
      }
      return parts.join("\n\n");
    });
    const stamp = options.generatedAt ? `
     generated: ${options.generatedAt}` : "";
    return `# Components \u2014 ${options.fileName}

<!-- GENERATED by the Altery Design System Export Figma plugin.
     source of truth: the Component configuration of each Figma component${stamp}
     Do not hand-edit: re-export from Figma instead. -->

**Read the entry for a component before implementing or changing it.** ${contracts.length} of ${analyzed.length} component(s) carry a behaviour contract written by the designer \u2014 conditional colors, state rules, content limits. None of that is visible in the tokens or the generated CSS, so skipping it produces a component that merely looks right.

${options.usage}

> **For designers:** a colour or size named in a description is resolved by looking it up in
> this file's variable table, so write the variable's real name \u2014 \`Yellow/Y300\`, \`bg/surface\`,
> \`number/Base\`. Any spelling the panel shows works (\`Yellow/Y300\`, \`Yellow.Y300\`, \`Y300\`),
> and a shorter form is fine while it is unambiguous. A name that matches nothing is reported
> as a stale reference instead of being silently dropped.

## Index

${index}${previewNote}

${sections.join("\n\n")}
`;
  }
  function buildIconsMd(docs, options) {
    if (docs.length === 0) return "";
    const sorted = [...docs].sort((a, b) => a.name.localeCompare(b.name));
    const table2 = mdTable(
      ["Icon", "Figma node", "Search tags", "Preview"],
      sorted.map((doc) => [
        doc.name,
        `\`${doc.id}\``,
        doc.description.trim() ? doc.description.trim().replace(/\s*\n\s*/g, ", ") : "\u2014",
        doc.preview ? `![${doc.name}](${doc.preview})` : "\u2014"
      ])
    );
    const stamp = options.generatedAt ? `
     generated: ${options.generatedAt}` : "";
    return `# Icons \u2014 ${options.fileName}

<!-- GENERATED by the Altery Design System Export Figma plugin.${stamp}
     Do not hand-edit: re-export from Figma instead. -->

${sorted.length} icon component(s). Descriptions on icons are **search keywords**, not behaviour contracts \u2014 use this table to find the right glyph, and color it with an \`icon\` role token (see DESIGN.md).

${table2}
`;
  }
  function componentDocsSection(docs, tokens = []) {
    if (docs.length === 0) return "";
    const analyzed = analyzeDocs(docs, tokens);
    const contracts = analyzed.filter((entry) => entry.kind === "contract");
    const notes = analyzed.filter((entry) => entry.kind === "notes");
    if (contracts.length === 0) {
      return `${docs.length} component(s) were exported, but none carries a behaviour contract in Figma` + (notes.length > 0 ? ` (${notes.length} carry designer notes)` : "") + `. See \`${COMPONENTS_FILE}\` for their properties, notes and previews.`;
    }
    const rows = contracts.slice(0, 40).map(({ doc, description }) => [
      `\`${doc.name}\``,
      description.split("\n")[0].replace(/^#+\s*/, "").slice(0, 110),
      doc.preview ? `[preview](${doc.preview})` : "\u2014"
    ]);
    const more = contracts.length > rows.length ? `

_+${contracts.length - rows.length} more in \`${COMPONENTS_FILE}\`._` : "";
    const notesLine = notes.length > 0 ? `

_${notes.length} further component(s) carry designer notes (context, not contracts) in \`${COMPONENTS_FILE}\`._` : "";
    return `**${contracts.length} component(s) carry a behaviour contract** the designer wrote in Figma \u2014 conditional colors, state rules, content limits. They are NOT expressible in tokens or CSS, and an implementation that ignores them is wrong even when it looks correct.

Full text, properties and previews: \`${COMPONENTS_FILE}\`. **Read the entry for a component before you implement or change it.**

${mdTable(["Component", "Contract (first line)", "Preview"], rows)}${more}${notesLine}`;
  }

  // src/targets/design-md/tokens-target.ts
  var FILE_DOCS = [
    {
      match: (path) => path === "tokens.css",
      what: "Every token as a CSS custom property, one self-contained block per theme.",
      use: "Import once, globally. This is the only stylesheet that may declare `--*` design tokens."
    },
    {
      match: (path) => path === "tokens.json",
      what: "Canonical W3C/DTCG tree \u2014 all modes under `$extensions.modes`, source collection under `$extensions.figma`.",
      use: "Read it programmatically (build scripts, codegen, diffing). Do not ship it to the browser."
    },
    {
      match: (path) => path === "tokens.ts",
      what: "Typed `tokens` object whose values are `var(--\u2026)` refs, plus `themes` / `Theme`.",
      use: "Reference tokens from TS/JS (CSS-in-JS, inline styles) with autocomplete instead of string literals."
    },
    {
      match: (path) => path.endsWith(".module.css"),
      what: "The same declarations, one file per theme (CSS Modules).",
      use: "Import a single theme at build time, or all of them for runtime switching."
    },
    {
      match: (path) => path === "README.md",
      what: "Human-facing description of the package.",
      use: "Onboarding. DESIGN.md (this file) is the machine-facing contract."
    },
    {
      match: (path) => path === COMPONENTS_FILE,
      what: "Per-component behaviour contracts: the designer's description, properties, documentation links and previews.",
      use: "Read the entry for a component BEFORE implementing or changing it."
    },
    {
      match: (path) => path === ICONS_FILE,
      what: "The icon library as a lookup table: name, node id, search tags, preview.",
      use: "Find the right glyph by its search tags; icon descriptions are keywords, not contracts."
    },
    {
      match: (path) => path.startsWith("previews/"),
      what: "PNG of a component master, captured from Figma.",
      use: "Visual reference for the contract in COMPONENTS.md."
    },
    {
      match: (path) => path === "DESIGN.md",
      what: "This file \u2014 the design contract for coding agents.",
      use: "Load it into context before writing UI code."
    }
  ];
  function filesTable(files) {
    const rows = files.slice().sort((a, b) => a.localeCompare(b)).map((path) => {
      var _a, _b;
      const doc = FILE_DOCS.find((entry) => entry.match(path));
      return [`\`${path}\``, (_a = doc == null ? void 0 : doc.what) != null ? _a : "Generated artifact.", (_b = doc == null ? void 0 : doc.use) != null ? _b : "\u2014"];
    });
    return mdTable(["File", "What it is", "Use it for"], rows);
  }
  function optionRules(options) {
    const rules = [];
    if (options.inlinePrimitives && !options.flattenAliases) {
      rules.push(
        "**Primitive tokens are inlined**: raw single-mode values (palette ramps, base scales) are NOT emitted as their own variables \u2014 their values sit inside the semantic tokens. A Figma variable name you remember may not exist in CSS. Only use names that appear in `tokens.css`."
      );
    }
    if (options.inlinePrimitives && options.flattenAliases) {
      rules.push(
        "**All aliases are flattened**: no `var(--\u2026)` cross-references remain in `tokens.css`; every token holds a literal. Never re-point one token at another by hand \u2014 change it in Figma and re-export. (`tokens.json` keeps the un-flattened tree.)"
      );
    }
    if (!options.inlinePrimitives) {
      rules.push(
        "Primitives are emitted as their own variables and semantic tokens reference them with `var(--\u2026)`. **Always style with the semantic token**, never with the primitive it resolves to \u2014 the primitive is not theme-aware."
      );
    }
    if (options.typoExtract && options.typoScaleOnly) {
      rules.push(
        "Typography is emitted as a **shared scale only** (`--font-size-*`, `--font-weight-*`, \u2026). Compose each text style in your own CSS from those primitives; do not expect a per-style shorthand token."
      );
    }
    if (options.emitModuleFiles) {
      rules.push(
        "Per-theme CSS Modules ship alongside `tokens.css`" + (options.cssModulesGlobal ? " wrapped in `:global(\u2026)`" : "") + ". Import **either** `tokens.css` **or** the module files \u2014 never both, or the declarations double."
      );
    }
    return rules;
  }
  function buildTokensDesignMd(input) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k;
    const model = buildTokenModel(input.tree, input.themes, input.defaultTheme, (_a = input.collectionRoles) != null ? _a : {});
    const breakpoints = breakpointsSection(model, input.breakpoints);
    const typography = typographySection(model.typography);
    const contract = bullet([
      "This package **is** the design system. Every visual value you need already exists here.",
      "Style with `var(--\u2026)` references. A literal color, spacing, radius, or font value in application code is a bug, not a shortcut.",
      "Pick a token by **role** (\xA72) and by **context** (\xA73) \u2014 not by which value looks closest.",
      "If a value you need has no token, **stop and report the gap**. Do not approximate it.",
      "Never edit the files in this package by hand: they are regenerated on every export from Figma."
    ]);
    const guardrails = [...auditGuardrails(input.audit), ...tokenGuardrails(model), ...optionRules(input.options)];
    const recipeLines = [];
    const recipeGaps = [];
    const surface = (_d = (_b = model.byRole.get("surface")) == null ? void 0 : _b[0]) != null ? _d : (_c = model.byRole.get("color")) == null ? void 0 : _c[0];
    const text2 = (_e = model.byRole.get("text")) == null ? void 0 : _e[0];
    const border = (_f = model.byRole.get("border")) == null ? void 0 : _f[0];
    const radius = (_g = model.byRole.get("radius")) == null ? void 0 : _g[0];
    const spacing = (_h = model.byRole.get("spacing")) == null ? void 0 : _h[0];
    if (surface) recipeLines.push(`  background: ${surface.cssRef};`);
    if (text2) recipeLines.push(`  color: ${text2.cssRef};`);
    if (border) recipeLines.push(`  border: 1px solid ${border.cssRef};`);
    if (radius) recipeLines.push(`  border-radius: ${radius.cssRef};`);
    else recipeGaps.push("radius");
    if (spacing) recipeLines.push(`  padding: ${spacing.cssRef};`);
    else recipeGaps.push("spacing");
    const cardExample = recipeLines.length > 0 ? `Then compose components exclusively from variables:

\`\`\`css
.card {
${recipeLines.join("\n")}
}
\`\`\`

` : "";
    const gapNote = recipeGaps.length > 0 ? `_No ${recipeGaps.join(" or ")} tokens are role-classified in this export, so those lines are omitted above. Do not invent values: use the numeric scale documented under Unclassified in the guardrails (if one shipped) or report the gap to the designer._

` : "";
    const recipes = 'Import the stylesheet once, at the app entry point:\n\n```css\n@import "./tokens.css";\n```\n\n' + cardExample + gapNote + `From TypeScript, reference \`tokens.ts\` instead of writing the variable name as a string:

\`\`\`ts
import { tokens } from "./tokens"

const style = { background: ${(_j = (_i = model.entries[0]) == null ? void 0 : _i.tsAccessor) != null ? _j : "tokens"} }
\`\`\`

**Verify before you commit:** every \`--\u2026\` name you wrote must appear in \`tokens.css\`.

\`\`\`bash
grep -o -- "--[a-z0-9-]*" src/**/*.css | sort -u | while read v; do grep -q -- "$v:" tokens.css || echo "NOT A TOKEN: $v"; done
\`\`\``;
    const agentPrompt = agentPromptSection({
      role: "an expert frontend engineer",
      steps: [
        "Identify every visual requirement of the UI you are about to write: surfaces, text, borders, icons, spacing, radii, type, motion.",
        'Map each one to a token from the "Token \u2192 CSS property" table \u2014 by role first, then by the component group that matches the element.',
        "Resolve theming through the token layer only: write one rule set with `var(--\u2026)`; never branch on the active theme.",
        "Write the code, then re-read it and confirm no literal color, spacing, radius, or font value survived.",
        "State the tokens you used (and any gap you found) before presenting the code."
      ],
      never: [
        "Never write a raw hex/rgb/hsl color, or a px value that has no matching token.",
        "Never edit `tokens.css`, `tokens.json`, `tokens.ts`, or the `*.module.css` files \u2014 they are generated from Figma.",
        "Never re-declare a design token under a new name in application CSS.",
        "Never introduce a breakpoint, font weight, or type size that is not listed in DESIGN.md."
      ]
    });
    const sections = [
      ["The contract", contract],
      ["What ships in this package", filesTable(input.files)],
      ["Token \u2192 CSS property (how to apply anything)", roleIndexSection(model)],
      ["Tokens by component / context", componentBlocksSection(model.components)],
      ["Token reference", tokenReferenceSection(model)],
      ["Component behaviour contracts", componentDocsSection((_k = input.componentDocs) != null ? _k : [], model.entries)],
      ["Typography", typography],
      ["Themes", themesSection(model, input.themeAttribute)],
      ["Breakpoints", breakpoints],
      [
        "Strict guardrails (generated from a Figma audit)",
        guardrails.length > 0 ? bullet(guardrails) : "_No issues found in the Figma file \u2014 keep it that way._"
      ],
      ["Recipes", recipes],
      ["Agent prompt", agentPrompt]
    ];
    const intro = `**Read this file before writing or changing any UI code.** It is the machine-readable contract for the design system exported from Figma: ${model.entries.length} token(s)` + (model.themes.length > 1 ? `, ${model.themes.length} themes` : "") + (model.typography.length > 0 ? `, ${model.typography.length} text style(s)` : "") + ". It tells you which value to use, where to apply it, and what is forbidden.";
    const body = renderSections(sections);
    return `${headerSection({ fileName: input.fileName, target: "design-tokens", generatedAt: input.generatedAt, intro })}

${body}
`;
  }

  // src/targets/design-tokens.ts
  function buildDesignTokens(graph, options, generatedAt, componentDocs = [], renames) {
    const opts = normalizeExportOptions(options);
    const engineOptions = {
      inlinePrimitives: opts.tokens.inlinePrimitives,
      flattenAliases: opts.tokens.flattenAliases,
      themeAttr: resolveThemeAttribute(opts),
      emitModuleFiles: opts.tokens.emitModuleFiles,
      cssModulesGlobal: opts.tokens.cssModulesGlobal,
      typoExtract: opts.tokens.typoExtract,
      typoScaleOnly: opts.tokens.typoScaleOnly,
      typoShorthand: opts.tokens.typoShorthand,
      typoNaming: opts.tokens.typoNaming
    };
    const pkg = buildPackage(graph, engineOptions, renames);
    const collectionRoles = parseCollectionRoles(opts.tokens.collectionRoles);
    const iconDocs = componentDocs.filter((doc) => isIconDoc(doc));
    const realComponentDocs = componentDocs.filter((doc) => !isIconDoc(doc));
    if (pkg.summary.tokenCount > 0) {
      pkg.files["DESIGN.md"] = buildTokensDesignMd({
        fileName: pkg.summary.fileName,
        tree: pkg.emitted.tree,
        themes: pkg.emitted.themes,
        defaultTheme: pkg.emitted.defaultTheme,
        themeAttribute: pkg.options.themeAttr,
        files: [
          ...Object.keys(pkg.files),
          "DESIGN.md",
          ...realComponentDocs.length > 0 ? [COMPONENTS_FILE] : [],
          ...iconDocs.length > 0 ? [ICONS_FILE] : [],
          ...componentDocs.some((doc) => doc.preview) ? ["previews/<component>.png"] : []
        ],
        options: pkg.options,
        audit: buildTokenAudit(graph),
        breakpoints: extractBreakpointTokens(graph),
        componentDocs: realComponentDocs,
        collectionRoles,
        generatedAt
      });
    }
    if (realComponentDocs.length > 0) {
      const componentsMd = buildComponentsMd(realComponentDocs, {
        fileName: pkg.summary.fileName,
        generatedAt,
        usage: "These components live in Figma only \u2014 this package ships their contract, not their markup. Implement them with the tokens documented in `DESIGN.md`.",
        tokens: buildTokenEntries(pkg.emitted.tree, pkg.emitted.themes, pkg.emitted.defaultTheme, collectionRoles)
      });
      if (componentsMd) pkg.files[COMPONENTS_FILE] = componentsMd;
    }
    if (iconDocs.length > 0) {
      const iconsMd = buildIconsMd(iconDocs, { fileName: pkg.summary.fileName, generatedAt });
      if (iconsMd) pkg.files[ICONS_FILE] = iconsMd;
    }
    const summary = {
      target: "design-tokens",
      fileName: pkg.summary.fileName,
      totalVariables: pkg.summary.totalVariables,
      textStyleCount: pkg.summary.textStyleCount,
      effectStyleCount: pkg.summary.effectStyleCount,
      tokenCount: pkg.summary.tokenCount,
      themes: pkg.summary.themes,
      collections: pkg.summary.collections,
      hasTypographyVars: pkg.summary.hasTypographyVars,
      hasGeneratedTypoCollection: pkg.summary.hasGeneratedTypoCollection,
      hasBreakpointCollection: pkg.summary.hasBreakpointCollection,
      hasGeneratedBpCollection: pkg.summary.hasGeneratedBpCollection
    };
    return { files: pkg.files, summary };
  }

  // src/targets/tauri/render-static.ts
  var EMPTY_CTX = /* @__PURE__ */ new Map();
  function escapeHtml4(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function unescapeDjangoString(value) {
    return value.replace(/\\(["\\])/g, "$1");
  }
  function stripComments(src) {
    return src.replace(/\{#[\s\S]*?#\}/g, "");
  }
  function truthy(value) {
    if (value === void 0) return false;
    if (typeof value === "boolean") return value;
    return value !== "" && value !== "False";
  }
  function parseParamValue(raw, ctx) {
    var _a;
    if (raw === "True") return true;
    if (raw === "False") return false;
    const quoted2 = (_a = raw.match(/^"((?:[^"\\]|\\.)*)"$/)) != null ? _a : raw.match(/^'((?:[^'\\]|\\.)*)'$/);
    if (quoted2) return unescapeDjangoString(quoted2[1]);
    return ctx.get(raw);
  }
  function splitParams(clause) {
    const out = [];
    const pattern = /(\w+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
    for (const match of clause.matchAll(pattern)) out.push(`${match[1]}\0${match[2]}`);
    return out;
  }
  function resolveExpr(expr, ctx, opts) {
    const parts = expr.split("|").map((part) => part.trim());
    const head = parts[0];
    let value;
    const navMatch = head.match(/^navMap\.(\w+)$/);
    if (navMatch) {
      value = opts.navHref(navMatch[1]);
    } else {
      value = ctx.get(head);
    }
    for (const filter of parts.slice(1)) {
      const defaultMatch = filter.match(/^default:(.*)$/);
      if (defaultMatch) {
        if (!truthy(value)) value = parseParamValue(defaultMatch[1], ctx);
        continue;
      }
      if (filter === "lower" && typeof value === "string") value = value.toLowerCase();
    }
    if (value === void 0 || typeof value === "boolean") return typeof value === "boolean" && value ? "True" : "";
    return value;
  }
  function findMatchingEnd(src, from, openPattern, endTag) {
    let depth = 0;
    let i = from;
    while (i < src.length) {
      const next = src.indexOf("{%", i);
      if (next === -1) return -1;
      const close = src.indexOf("%}", next);
      if (close === -1) return -1;
      const tag = src.slice(next + 2, close).trim();
      if (openPattern.test(tag)) depth++;
      else if (tag === endTag) {
        if (depth === 0) return next;
        depth--;
      }
      i = close + 2;
    }
    return -1;
  }
  function renderBlocktranslateBody(body, ctx) {
    return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name) => {
      const value = ctx.get(name);
      return typeof value === "string" ? escapeHtml4(value) : `{${name}}`;
    });
  }
  function renderFragment(src, ctx, opts) {
    var _a;
    let out = "";
    let i = 0;
    while (i < src.length) {
      const nextVar = src.indexOf("{{", i);
      const nextTag = src.indexOf("{%", i);
      const next = nextVar === -1 ? nextTag : nextTag === -1 ? nextVar : Math.min(nextVar, nextTag);
      if (next === -1) {
        out += src.slice(i);
        break;
      }
      out += src.slice(i, next);
      if (next === nextVar) {
        const close2 = src.indexOf("}}", next);
        if (close2 === -1) {
          out += src.slice(next);
          break;
        }
        const expr = src.slice(next + 2, close2).trim();
        out += escapeHtml4(resolveExpr(expr, ctx, opts));
        i = close2 + 2;
        continue;
      }
      const close = src.indexOf("%}", next);
      if (close === -1) {
        out += src.slice(next);
        break;
      }
      const tag = src.slice(next + 2, close).trim();
      i = close + 2;
      if (tag.startsWith("load ") || tag.startsWith("extends ")) {
        if (src[i] === "\n") i++;
        continue;
      }
      const staticMatch = (_a = tag.match(/^static\s+'([^']*)'$/)) != null ? _a : tag.match(/^static\s+"([^"]*)"$/);
      if (staticMatch) {
        out += opts.staticHref(staticMatch[1]);
        continue;
      }
      const translateMatch = tag.match(/^translate\s+"([\s\S]*)"$/);
      if (translateMatch) {
        out += translateMatch[1];
        continue;
      }
      if (/^blocktranslate(\s|$)/.test(tag)) {
        const end = findMatchingEnd(src, i, /^blocktranslate(\s|$)/, "endblocktranslate");
        if (end === -1) continue;
        const body = src.slice(i, end);
        const withMatch = tag.match(/^blocktranslate\s+with\s+(.*)$/);
        let blockCtx = ctx;
        if (withMatch) {
          const bound = new Map(ctx);
          for (const pair2 of splitParams(withMatch[1])) {
            const [name, raw] = pair2.split("\0");
            const value = parseParamValue(raw, ctx);
            if (value !== void 0) bound.set(name, value);
          }
          blockCtx = bound;
        }
        out += renderBlocktranslateBody(body, blockCtx);
        i = src.indexOf("%}", end) + 2;
        continue;
      }
      const ifMatch = tag.match(/^if\s+(\w+)$/);
      if (ifMatch) {
        const end = findMatchingEnd(src, i, /^if\s/, "endif");
        if (end === -1) continue;
        const body = src.slice(i, end);
        if (truthy(ctx.get(ifMatch[1]))) out += renderFragment(body, ctx, opts);
        i = src.indexOf("%}", end) + 2;
        continue;
      }
      const includeMatch = tag.match(/^include\s+(.+?)(\s+with\s+(.*?))?(\s+only)?$/);
      if (includeMatch) {
        const [, target, , withClause, only] = includeMatch;
        out += renderInclude(target, withClause, Boolean(only), ctx, opts);
        continue;
      }
    }
    return out;
  }
  function renderInclude(target, withClause, only, ctx, opts) {
    var _a;
    let path;
    const literal = (_a = target.match(/^"([^"]*)"$/)) != null ? _a : target.match(/^'([^']*)'$/);
    if (literal) {
      path = literal[1];
    } else {
      path = resolveExpr(target, ctx, opts);
      if (!path) return "";
    }
    const source = opts.partials.get(path);
    if (!source) {
      console.warn(`[tauri] include target "${path}" is not among the exported partials \u2014 skipped`);
      return "";
    }
    let childCtx;
    if (withClause) {
      const params = new Map(only ? [] : ctx);
      for (const pair2 of splitParams(withClause)) {
        const [name, raw] = pair2.split("\0");
        const value = parseParamValue(raw, ctx);
        if (value !== void 0) params.set(name, value);
      }
      childCtx = params;
    } else {
      childCtx = only ? EMPTY_CTX : ctx;
    }
    return renderFragment(stripComments(source), childCtx, opts);
  }
  function extractContentBlock(pageSrc) {
    const open = pageSrc.indexOf("{% block content %}");
    if (open === -1) return pageSrc;
    const from = open + "{% block content %}".length;
    const end = findMatchingEnd(pageSrc, from, /^block\s/, "endblock");
    if (end === -1) return pageSrc.slice(from);
    return pageSrc.slice(from, end);
  }
  function renderStaticPage(baseHtml, pageHtml, opts, ctx = EMPTY_CTX) {
    const base = stripComments(baseHtml);
    const body = extractContentBlock(stripComments(pageHtml));
    const renderedBody = renderFragment(body, ctx, opts);
    const CONTENT_MARK = "\0CONTENT\0";
    let shell = base.replace("{% block content %}{% endblock %}", CONTENT_MARK);
    shell = shell.replace(/\{%\s*block\s+\w+\s*%\}/g, "").replace(/\{%\s*endblock\s*%\}/g, "");
    shell = renderFragment(shell, ctx, opts);
    const doc = shell.replace(CONTENT_MARK, () => renderedBody);
    return doc.replace(/\n{3,}/g, "\n\n");
  }

  // src/targets/tauri/transitions.ts
  function collectNavEdges(pages) {
    const pageIds = new Set(pages.map((page) => page.id));
    const edges = [];
    const seen = /* @__PURE__ */ new Set();
    for (const page of pages) {
      const visit = (node) => {
        var _a, _b;
        const navigate = node.navigate;
        if (navigate && pageIds.has(navigate.destinationId)) {
          const key = `${page.id}\0${navigate.destinationId}\0${(_b = (_a = navigate.transition) == null ? void 0 : _a.style) != null ? _b : "NONE"}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push({ sourcePageId: page.id, destPageId: navigate.destinationId, transition: navigate.transition });
          }
        }
        if ("children" in node) node.children.forEach(visit);
      };
      visit(page);
    }
    return edges;
  }
  function nameToIdent(name) {
    const sanitized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return sanitized.length > 0 ? sanitized : "node";
  }
  function selectorIdFor(node) {
    return node.type === "instance-ref" && node.componentId ? node.componentId : node.id;
  }
  function nodesByName(page) {
    const byName = /* @__PURE__ */ new Map();
    const visit = (node) => {
      if (node !== page && !byName.has(node.name)) byName.set(node.name, node);
      if (node.type === "instance-ref") return;
      if ("children" in node) node.children.forEach(visit);
    };
    visit(page);
    return byName;
  }
  function selectorCountsPerPage(pages) {
    var _a;
    const maxCounts = /* @__PURE__ */ new Map();
    for (const page of pages) {
      const counts = /* @__PURE__ */ new Map();
      const visit = (node) => {
        var _a2;
        if (node !== page) {
          const sid = selectorIdFor(node);
          counts.set(sid, ((_a2 = counts.get(sid)) != null ? _a2 : 0) + 1);
        }
        if (node.type === "instance-ref") return;
        if ("children" in node) node.children.forEach(visit);
      };
      visit(page);
      for (const [sid, count] of counts) maxCounts.set(sid, Math.max((_a = maxCounts.get(sid)) != null ? _a : 0, count));
    }
    return maxCounts;
  }
  var MAX_MATCHED_LAYERS = 40;
  var DIRECTIONAL_STYLES = /* @__PURE__ */ new Set(["MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"]);
  function directionTransforms(style, direction) {
    var _a, _b, _c;
    const enter = {
      LEFT: "translateX(-100%)",
      RIGHT: "translateX(100%)",
      TOP: "translateY(-100%)",
      BOTTOM: "translateY(100%)"
    };
    const exit = {
      LEFT: "translateX(100%)",
      RIGHT: "translateX(-100%)",
      TOP: "translateY(100%)",
      BOTTOM: "translateY(-100%)"
    };
    const newFrom = (_a = enter[direction]) != null ? _a : enter.RIGHT;
    if (style === "PUSH") return { newFrom, oldTo: (_b = exit[direction]) != null ? _b : exit.RIGHT };
    if (style === "MOVE_OUT" || style === "SLIDE_OUT") return { newFrom: "none", oldTo: (_c = exit[direction]) != null ? _c : exit.RIGHT };
    return { newFrom };
  }
  function emitViewTransitionsCss(input) {
    var _a, _b, _c;
    const animated = input.edges.filter((edge) => Boolean(edge.transition));
    if (animated.length === 0) return "";
    const lines = [
      "/* Cross-document view transitions \u2014 generated from Figma prototype NAVIGATE reactions. */",
      "@view-transition {",
      "  navigation: auto;",
      "}",
      ""
    ];
    const slowest = animated.reduce((a, b) => b.transition.durationMs > a.transition.durationMs ? b : a);
    lines.push(
      "::view-transition-group(root),",
      "::view-transition-group(*) {",
      `  animation-duration: ${slowest.transition.durationMs}ms;`,
      `  animation-timing-function: ${slowest.transition.timingFunction};`,
      "}",
      ""
    );
    const directional = animated.filter((edge) => DIRECTIONAL_STYLES.has(edge.transition.style));
    const styles = new Set(directional.map((edge) => {
      var _a2;
      return `${edge.transition.style}/${(_a2 = edge.transition.direction) != null ? _a2 : "RIGHT"}`;
    }));
    if (directional.length === animated.length && styles.size === 1) {
      const { style, direction = "RIGHT" } = directional[0].transition;
      const { newFrom, oldTo } = directionTransforms(style, direction);
      if (newFrom !== "none") {
        lines.push(
          "@keyframes tauri-vt-enter {",
          `  from { transform: ${newFrom}; }`,
          "  to { transform: none; }",
          "}",
          "::view-transition-new(root) {",
          "  animation-name: tauri-vt-enter;",
          "}",
          ""
        );
      }
      if (oldTo) {
        lines.push(
          "@keyframes tauri-vt-exit {",
          "  from { transform: none; }",
          `  to { transform: ${oldTo}; }`,
          "}",
          "::view-transition-old(root) {",
          "  animation-name: tauri-vt-exit;",
          "}",
          ""
        );
      }
    }
    const morphEdges = animated.filter((edge) => edge.transition.style === "SMART_ANIMATE");
    if (morphEdges.length > 0) {
      const pageById = new Map(input.pages.map((page) => [page.id, page]));
      const namesByPage = /* @__PURE__ */ new Map();
      const lookup = (id) => {
        let names = namesByPage.get(id);
        if (!names) {
          const page = pageById.get(id);
          names = page ? nodesByName(page) : /* @__PURE__ */ new Map();
          namesByPage.set(id, names);
        }
        return names;
      };
      const maxSelectorCounts = selectorCountsPerPage(input.pages);
      const assignments = /* @__PURE__ */ new Map();
      for (const edge of morphEdges) {
        const source = lookup(edge.sourcePageId);
        const dest = lookup(edge.destPageId);
        let matched = 0;
        for (const [name, sourceNode] of source) {
          if (matched >= MAX_MATCHED_LAYERS) break;
          const destNode = dest.get(name);
          if (!destNode) continue;
          const sourceSid = selectorIdFor(sourceNode);
          const destSid = selectorIdFor(destNode);
          if (((_a = maxSelectorCounts.get(sourceSid)) != null ? _a : 0) > 1 || ((_b = maxSelectorCounts.get(destSid)) != null ? _b : 0) > 1) continue;
          const ident = nameToIdent(name);
          const ids = (_c = assignments.get(ident)) != null ? _c : /* @__PURE__ */ new Set();
          ids.add(sourceSid);
          ids.add(destSid);
          assignments.set(ident, ids);
          matched++;
        }
      }
      for (const [ident, ids] of assignments) {
        const selectors = [...ids].map((id) => `.${toClassName(id)}`).join(", ");
        lines.push(`${selectors} { view-transition-name: ${ident}; }`);
      }
      if (assignments.size > 0) lines.push("");
    }
    return lines.join("\n");
  }

  // src/targets/tauri/scroll-guards.ts
  function isGuardCandidate(child, mainAxis) {
    if (child.type !== "container" && child.type !== "instance-ref") return false;
    if (!("children" in child) || child.children.length === 0) return false;
    const layout = "layout" in child ? child.layout : void 0;
    if (layout && "clip" in layout && layout.clip) return false;
    return child.sizing[mainAxis].mode === "fill";
  }
  function emitScrollGuardsCss(pageRoots) {
    const guards = /* @__PURE__ */ new Map();
    const visit = (node) => {
      if (!("children" in node)) return;
      const layout = "layout" in node ? node.layout : void 0;
      if (layout && layout.kind === "flex") {
        const mainAxis = layout.direction === "row" ? "width" : "height";
        for (const child of node.children) {
          if (isGuardCandidate(child, mainAxis)) {
            guards.set(toClassName(child.id), layout.direction === "row" ? "x" : "y");
          }
        }
      }
      node.children.forEach(visit);
    };
    pageRoots.forEach(visit);
    if (guards.size === 0) return "";
    const lines = [
      "/* Tauri squeeze guards: FILL regions scroll instead of painting over siblings when the",
      "   window is smaller than the design frame. Invisible at design size. */"
    ];
    for (const [className, axis] of guards) {
      lines.push(`.${className} { overflow-${axis}: auto; }`);
    }
    return lines.join("\n") + "\n";
  }

  // src/targets/tauri/scaffold.ts
  function identifierFor(slug2) {
    return `com.figma-export.${slug2 || "app"}`;
  }
  function crateNameFor(slug2) {
    const name = slug2.replace(/-/g, "_").replace(/[^a-z0-9_]/g, "");
    return name || "app";
  }
  function tauriConfJson(opts) {
    const conf = {
      $schema: "https://schema.tauri.app/config/2",
      productName: opts.productName,
      version: "0.1.0",
      identifier: identifierFor(opts.slug),
      build: {
        // The static frontend the renderer emitted — no dev server, no beforeDevCommand.
        frontendDist: "../src"
      },
      app: {
        // window.__TAURI__ without an npm bundler — the vanilla-template shape.
        withGlobalTauri: true,
        windows: [
          {
            label: "main",
            title: opts.productName,
            width: Math.max(200, Math.round(opts.window.width)),
            height: Math.max(200, Math.round(opts.window.height)),
            resizable: true
          }
        ],
        security: {
          // Fonts come from Google Fonts, GSAP (when Motion timelines exported) from jsdelivr —
          // both remote. Everything else is app-origin. Tighten to taste.
          csp: null
        }
      },
      bundle: {
        active: true,
        targets: "all",
        icon: ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"]
      }
    };
    return JSON.stringify(conf, null, 2) + "\n";
  }
  function cargoToml(opts) {
    const crate = crateNameFor(opts.slug);
    return `[package]
name = "${crate}"
version = "0.1.0"
description = "${opts.productName.replace(/"/g, '\\"')} \u2014 exported from Figma"
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
`;
  }
  function libRs() {
    return `#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`;
  }
  function mainRs(opts) {
    return `// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ${crateNameFor(opts.slug)}_lib::run()
}
`;
  }
  function capabilitiesJson() {
    return JSON.stringify(
      {
        $schema: "../gen/schemas/desktop-schema.json",
        identifier: "default",
        description: "Default capability for the main window.",
        windows: ["main"],
        permissions: ["core:default"]
      },
      null,
      2
    ) + "\n";
  }
  function packageJson(opts) {
    return JSON.stringify(
      {
        name: opts.slug || "figma-export",
        private: true,
        version: "0.1.0",
        scripts: { tauri: "tauri", dev: "tauri dev", build: "tauri build" },
        devDependencies: { "@tauri-apps/cli": "^2" }
      },
      null,
      2
    ) + "\n";
  }
  function gitignore() {
    return `node_modules/
src-tauri/target/
src-tauri/gen/schemas/
`;
  }
  function readme(opts) {
    const manualAssets = opts.manualAssetNotes && opts.manualAssetNotes.length > 0 ? `
## Manual assets

The Figma API refused to export these video files \u2014 drop them at the listed paths (the markup already references them):

${opts.manualAssetNotes.map((path) => `- \`src/${path}\``).join("\n")}
` : "";
    const gsap = opts.usesGsapCdn ? "\n- Motion timelines exported as GSAP animations load the GSAP runtime from the jsdelivr CDN (see `src/*.html`). For a fully offline app, download the files into `src/assets/vendor/gsap/` and update the script tags.\n" : "";
    return `# ${opts.productName}

A Tauri v2 desktop app exported from Figma. The frontend in \`src/\` is plain static
HTML/CSS/JS \u2014 no bundler, no framework \u2014 served straight from \`frontendDist\`.

## Run

\`\`\`
npm install
npm run dev
\`\`\`

(or \`cargo tauri dev\` with [tauri-cli](https://tauri.app/reference/cli/) installed.)

Prerequisites: Rust + the Tauri v2 system deps \u2014 https://tauri.app/start/prerequisites/

## Build

\`\`\`
npm run tauri icon path/to/app-icon.png   # generate src-tauri/icons/ (1024\xD71024 PNG in)
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
${gsap}${manualAssets}`;
  }
  function buildTauriScaffold(opts) {
    return {
      "src-tauri/tauri.conf.json": tauriConfJson(opts),
      "src-tauri/Cargo.toml": cargoToml(opts),
      "src-tauri/build.rs": "fn main() {\n    tauri_build::build()\n}\n",
      "src-tauri/src/lib.rs": libRs(),
      "src-tauri/src/main.rs": mainRs(opts),
      "src-tauri/capabilities/default.json": capabilitiesJson(),
      "package.json": packageJson(opts),
      ".gitignore": gitignore(),
      "README.md": readme(opts)
    };
  }

  // src/targets/tauri/index.ts
  function pageSlug(pagePath) {
    const base = pagePath.replace(/^pages\//, "").replace(/\.html$/, "");
    const sep = base.lastIndexOf("--");
    return sep === -1 ? base : base.slice(0, sep);
  }
  var GSAP_CDN = {
    "vendor/gsap/gsap.min.js": "https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js",
    "vendor/gsap/CustomEase.min.js": "https://cdn.jsdelivr.net/npm/gsap@3/dist/CustomEase.min.js",
    "vendor/gsap/DrawSVGPlugin.min.js": "https://cdn.jsdelivr.net/npm/gsap@3/dist/DrawSVGPlugin.min.js",
    "vendor/gsap/TextPlugin.min.js": "https://cdn.jsdelivr.net/npm/gsap@3/dist/TextPlugin.min.js"
  };
  function buildTauriExportTree(input) {
    var _a, _b, _c, _d, _e;
    const { project } = input;
    const pagePaths = Object.keys(project.pages);
    const startPath = (_a = input.startPageId && pagePaths.find((path) => project.fileNodeIds[path] === input.startPageId)) != null ? _a : pagePaths[0];
    const slugCounts = /* @__PURE__ */ new Map();
    for (const path of pagePaths) slugCounts.set(pageSlug(path), ((_b = slugCounts.get(pageSlug(path))) != null ? _b : 0) + 1);
    const hrefByPath = /* @__PURE__ */ new Map();
    for (const path of pagePaths) {
      if (path === startPath) {
        hrefByPath.set(path, "index.html");
        continue;
      }
      const slug3 = pageSlug(path);
      hrefByPath.set(path, ((_c = slugCounts.get(slug3)) != null ? _c : 0) > 1 ? path.replace(/^pages\//, "") : `${slug3}.html`);
    }
    const hrefByNavKey = /* @__PURE__ */ new Map();
    const pageHrefs = {};
    for (const [path, href] of hrefByPath) {
      const nodeId = project.fileNodeIds[path];
      if (nodeId) {
        hrefByNavKey.set(navMapKey(nodeId), href);
        pageHrefs[nodeId] = href;
      }
    }
    const renderedRoots = input.pageRoots.filter((root) => pageHrefs[root.id]);
    const edges = collectNavEdges(renderedRoots);
    const transitionsCss = emitViewTransitionsCss({ pages: renderedRoots, edges });
    const partials = new Map(Object.entries(project.partials));
    const bootstrapCdn = input.bootstrapVersion ? {
      "vendor/bootstrap/bootstrap.min.css": `https://cdn.jsdelivr.net/npm/bootstrap@${input.bootstrapVersion}/dist/css/bootstrap.min.css`,
      "vendor/bootstrap/bootstrap.bundle.min.js": `https://cdn.jsdelivr.net/npm/bootstrap@${input.bootstrapVersion}/dist/js/bootstrap.bundle.min.js`
    } : {};
    const renderOpts = {
      staticHref: (path) => {
        var _a2, _b2;
        return (_b2 = (_a2 = GSAP_CDN[path]) != null ? _a2 : bootstrapCdn[path]) != null ? _b2 : `assets/${path}`;
      },
      navHref: (key) => {
        var _a2;
        return (_a2 = hrefByNavKey.get(key)) != null ? _a2 : "#";
      },
      partials
    };
    const files = {};
    for (const [path, pageHtml] of Object.entries(project.pages)) {
      let doc = renderStaticPage(project.baseHtml, pageHtml, renderOpts);
      const nodeId = project.fileNodeIds[path];
      const pageRoot = input.pageRoots.find((root) => root.id === nodeId);
      const title = `<title>${((_d = pageRoot == null ? void 0 : pageRoot.name) != null ? _d : input.productName).replace(/</g, "&lt;")}</title>`;
      const transitionsLink = transitionsCss ? '\n  <link rel="stylesheet" href="assets/css/transitions.css">' : "";
      doc = doc.replace(
        "<head>",
        () => `<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${title}${transitionsLink}`
      );
      files[`src/${(_e = hrefByPath.get(path)) != null ? _e : path.replace(/^pages\//, "")}`] = doc;
    }
    if (input.tokensCss) files["src/assets/css/tokens.css"] = input.tokensCss;
    const scrollGuards = emitScrollGuardsCss(renderedRoots);
    files[`src/assets/${input.cssFile}`] = scrollGuards ? `${project.css}

${scrollGuards}` : project.css;
    if (project.interactionsCss) files["src/assets/css/interactions.css"] = project.interactionsCss;
    if (project.interactionsJs) files["src/assets/js/interactions.js"] = project.interactionsJs;
    if (project.themeCss) files["src/assets/css/bootstrap-theme.css"] = project.themeCss;
    if (input.animation.css) files["src/assets/css/animations.css"] = input.animation.css;
    if (input.animation.js) files["src/assets/js/animations.js"] = input.animation.js;
    if (input.motionTokensJs) files["src/assets/js/motion-tokens.js"] = input.motionTokensJs;
    if (transitionsCss) files["src/assets/css/transitions.css"] = transitionsCss;
    for (const asset of input.assets) files[`src/assets/img/${asset.filename}`] = asset.content;
    const slug2 = input.productName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    Object.assign(
      files,
      buildTauriScaffold({
        productName: input.productName,
        slug: slug2,
        window: input.window,
        manualAssetNotes: input.manualAssetNotes,
        usesGsapCdn: Boolean(input.animation.js)
      })
    );
    return { files, pageHrefs };
  }

  // src/tokens/color.ts
  var clamp01 = (value) => value < 0 ? 0 : value > 1 ? 1 : value;
  function parseHex(input) {
    const hex = input.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      return {
        r: parseInt(hex[0] + hex[0], 16) / 255,
        g: parseInt(hex[1] + hex[1], 16) / 255,
        b: parseInt(hex[2] + hex[2], 16) / 255
      };
    }
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255
      };
    }
    return null;
  }
  var channelToHex3 = (value) => {
    const byte = Math.round(clamp01(value) * 255);
    return byte.toString(16).toUpperCase().padStart(2, "0");
  };
  function formatHex(rgb) {
    return `#${channelToHex3(rgb.r)}${channelToHex3(rgb.g)}${channelToHex3(rgb.b)}`;
  }
  function srgbToLinear(value) {
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(value) {
    return value <= 31308e-7 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  }
  function rgbToOklab(rgb) {
    const r = srgbToLinear(rgb.r);
    const g = srgbToLinear(rgb.g);
    const b = srgbToLinear(rgb.b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return {
      l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    };
  }
  function oklabToLinearRgb(lab) {
    const l_ = lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
    const m_ = lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
    const s_ = lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    return {
      r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    };
  }
  function rgbToOklch(rgb) {
    const lab = rgbToOklab(rgb);
    const c = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
    const h = c < 1e-7 ? 0 : (Math.atan2(lab.b, lab.a) * 180 / Math.PI + 360) % 360;
    return { l: lab.l, c, h };
  }
  function oklchToLinearRgb(color) {
    const rad = color.h * Math.PI / 180;
    return oklabToLinearRgb({ l: color.l, a: color.c * Math.cos(rad), b: color.c * Math.sin(rad) });
  }
  var GAMUT_EPSILON = 1e-4;
  function inGamut(linear) {
    return linear.r >= -GAMUT_EPSILON && linear.r <= 1 + GAMUT_EPSILON && linear.g >= -GAMUT_EPSILON && linear.g <= 1 + GAMUT_EPSILON && linear.b >= -GAMUT_EPSILON && linear.b <= 1 + GAMUT_EPSILON;
  }
  function maxChroma(l, h) {
    if (l <= 0 || l >= 1) return 0;
    let low = 0;
    let high = 0.4;
    if (inGamut(oklchToLinearRgb({ l, c: high, h }))) return high;
    for (let i = 0; i < 28; i++) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinearRgb({ l, c: mid, h }))) low = mid;
      else high = mid;
    }
    return low;
  }
  function clampToGamut(color) {
    const l = clamp01(color.l);
    const linear = oklchToLinearRgb(__spreadProps(__spreadValues({}, color), { l }));
    if (inGamut(linear)) return __spreadProps(__spreadValues({}, color), { l });
    return { l, c: Math.min(color.c, maxChroma(l, color.h)), h: color.h };
  }
  function oklchToRgb(color) {
    const linear = oklchToLinearRgb(clampToGamut(color));
    return {
      r: clamp01(linearToSrgb(linear.r)),
      g: clamp01(linearToSrgb(linear.g)),
      b: clamp01(linearToSrgb(linear.b))
    };
  }
  var hexToOklch = (hex) => {
    const rgb = parseHex(hex);
    return rgb ? rgbToOklch(rgb) : null;
  };
  var oklchToHex = (color) => formatHex(oklchToRgb(color));
  function mixRgb(a, b, amount) {
    const t = clamp01(amount);
    return {
      r: a.r + (b.r - a.r) * t,
      g: a.g + (b.g - a.g) * t,
      b: a.b + (b.b - a.b) * t
    };
  }
  var WHITE2 = { r: 1, g: 1, b: 1 };
  var BLACK2 = { r: 0, g: 0, b: 0 };
  function relativeLuminance(rgb) {
    const r = srgbToLinear(clamp01(rgb.r));
    const g = srgbToLinear(clamp01(rgb.g));
    const b = srgbToLinear(clamp01(rgb.b));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const lighter = Math.max(la, lb);
    const darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
  }
  function readableInk(background2) {
    return contrastRatio(background2, BLACK2) >= contrastRatio(background2, WHITE2) ? BLACK2 : WHITE2;
  }

  // src/tokens/palette.ts
  var DEFAULT_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
  var DEFAULT_NEUTRAL_STEPS = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1e3];
  var DEFAULT_PALETTE_SETTINGS = {
    formula: "oklch",
    steps: DEFAULT_STEPS,
    neutralSteps: DEFAULT_NEUTRAL_STEPS,
    lightnessMax: 0.975,
    lightnessMin: 0.19,
    lightnessCurve: 1.55,
    chromaCurve: 0.55,
    hueTorsion: "auto",
    neutralChroma: 0.06,
    spectra: [
      { id: "orange", label: "Orange", prefix: "O", keyHex: "#FB5B0A", anchorStep: 500 },
      { id: "neutral", label: "Neutral", prefix: "N", keyHex: "#8A8A8A", anchorStep: 500, neutral: true },
      { id: "blue", label: "Blue", prefix: "B", keyHex: "#2364AA", anchorStep: 500 }
    ]
  };
  var clamp2 = (value, min, max) => value < min ? min : value > max ? max : value;
  function autoHueTorsion(hue) {
    const h = (hue % 360 + 360) % 360;
    if (h >= 20 && h < 110) return -10;
    if (h >= 110 && h < 190) return 8;
    if (h >= 190 && h < 290) return 10;
    return -6;
  }
  function baseLadder(count, lightnessMax, lightnessMin, curve) {
    if (count === 1) return [(lightnessMax + lightnessMin) / 2];
    const gamma = curve > 0 ? curve : 1;
    return Array.from({ length: count }, (_, i) => {
      const t = Math.pow(i / (count - 1), gamma);
      return lightnessMax + (lightnessMin - lightnessMax) * t;
    });
  }
  function warpLadder(base, anchor, keyL) {
    const last = base.length - 1;
    if (last <= 0) return [keyL];
    const top = base[0];
    const bottom = base[last];
    return base.map((l, i) => {
      if (i === anchor) return keyL;
      if (i < anchor) {
        const span2 = base[anchor] - top;
        if (Math.abs(span2) < 1e-6) return l;
        return top + (l - top) * ((keyL - top) / span2);
      }
      const span = base[anchor] - bottom;
      if (Math.abs(span) < 1e-6) return l;
      return bottom + (l - bottom) * ((keyL - bottom) / span);
    });
  }
  function chromaEnvelope(t, curve) {
    const bell = 1 - Math.pow(Math.abs(2 * t - 1), 1.6);
    return 1 - curve + curve * bell;
  }
  var sanitizeLabel = (label3) => label3.trim().replace(/[/]/g, "-") || "Color";
  function derivePrefixes(labels) {
    const used = /* @__PURE__ */ new Set();
    return labels.map((raw) => {
      const label3 = sanitizeLabel(raw).replace(/[^A-Za-z0-9]/g, "");
      for (let width = 1; width <= Math.max(1, label3.length); width++) {
        const candidate2 = (label3.slice(0, width) || "C").toUpperCase();
        if (!used.has(candidate2)) {
          used.add(candidate2);
          return candidate2;
        }
      }
      let n = 2;
      let candidate = `${(label3.slice(0, 1) || "C").toUpperCase()}${n}`;
      while (used.has(candidate)) candidate = `${(label3.slice(0, 1) || "C").toUpperCase()}${++n}`;
      used.add(candidate);
      return candidate;
    });
  }
  var normalizeSteps = (steps) => Array.from(new Set(steps.filter((s) => Number.isFinite(s)))).sort((a, b) => a - b);
  function indexOfStep(steps, step) {
    const exact = steps.indexOf(step);
    if (exact !== -1) return exact;
    let best = 0;
    for (let i = 1; i < steps.length; i++) {
      if (Math.abs(steps[i] - step) < Math.abs(steps[best] - step)) best = i;
    }
    return best;
  }
  function rampByMixing(key, count, anchor) {
    return Array.from({ length: count }, (_, i) => {
      if (i === anchor) return key;
      const t = count === 1 ? 0 : i / (count - 1);
      const tAnchor = count === 1 ? 0 : anchor / (count - 1);
      if (i < anchor) return mixRgb(key, WHITE2, tAnchor === 0 ? 0 : (tAnchor - t) / tAnchor);
      return mixRgb(key, BLACK2, tAnchor === 1 ? 0 : (t - tAnchor) / (1 - tAnchor));
    });
  }
  function rampByOklch(key, ladder, anchor, chromaCurve, torsion, neutralChroma) {
    const count = ladder.length;
    const tOf = (i) => count === 1 ? 0.5 : i / (count - 1);
    const tAnchor = tOf(anchor);
    const anchorEnvelope = Math.max(chromaEnvelope(tAnchor, chromaCurve), 0.15);
    const keyChroma = neutralChroma === null ? key.c : key.c * neutralChroma;
    return ladder.map((l, i) => {
      if (i === anchor && neutralChroma === null) return { l, c: key.c, h: key.h };
      const t = tOf(i);
      const chroma = keyChroma * (chromaEnvelope(t, chromaCurve) / anchorEnvelope);
      const hue = key.h + torsion * (t - tAnchor);
      return clampToGamut({ l, c: Math.min(chroma, maxChroma(l, hue)), h: hue });
    });
  }
  function buildSwatches(colors, steps, prefix, marks) {
    return colors.map((rgb, i) => ({
      step: steps[i],
      name: `${prefix}${steps[i]}`,
      hex: formatHex(rgb),
      inkHex: formatHex(readableInk(rgb)),
      isMain: i === marks.main,
      isLight: i === marks.light,
      isDark: i === marks.dark,
      contrastWhite: Math.round(contrastRatio(rgb, WHITE2) * 100) / 100,
      contrastBlack: Math.round(contrastRatio(rgb, BLACK2) * 100) / 100
    }));
  }
  function generateSpectrum(spec, settings, prefix) {
    var _a, _b, _c;
    const warnings = [];
    const neutral = spec.neutral === true;
    const steps = normalizeSteps((_a = spec.steps) != null ? _a : neutral ? settings.neutralSteps : settings.steps);
    const safeSteps = steps.length > 0 ? steps : neutral ? DEFAULT_NEUTRAL_STEPS : DEFAULT_STEPS;
    if (steps.length === 0) {
      warnings.push({
        message: "Step list was empty \u2014 fell back to the default scale.",
        fixLabel: "Restore the default scale",
        fix: { kind: "reset-steps", neutral }
      });
    }
    const keyRgb = parseHex(spec.keyHex);
    if (!keyRgb) warnings.push({ message: `"${spec.keyHex}" is not a valid hex \u2014 used #808080 instead.` });
    const key = keyRgb != null ? keyRgb : { r: 0.5, g: 0.5, b: 0.5 };
    const keyOklch = (_b = hexToOklch(formatHex(key))) != null ? _b : { l: 0.5, c: 0, h: 0 };
    const anchor = indexOfStep(safeSteps, spec.anchorStep);
    if (safeSteps[anchor] !== spec.anchorStep) {
      warnings.push({
        message: `Step ${spec.anchorStep} is not in the scale \u2014 the key was anchored at ${safeSteps[anchor]}.`,
        fixLabel: `Anchor at ${safeSteps[anchor]}`,
        fix: { kind: "anchor-step", spectrumId: spec.id, step: safeSteps[anchor] }
      });
    }
    const lightnessMax = neutral ? 1 : settings.lightnessMax;
    const lightnessMin = neutral ? 0 : settings.lightnessMin;
    const base = baseLadder(safeSteps.length, lightnessMax, lightnessMin, settings.lightnessCurve);
    let suggested = 0;
    for (let i = 1; i < base.length; i++) {
      if (Math.abs(base[i] - keyOklch.l) < Math.abs(base[suggested] - keyOklch.l)) suggested = i;
    }
    const drift = Math.abs(keyOklch.l - base[anchor]);
    if (drift > 0.12 && safeSteps[suggested] !== safeSteps[anchor]) {
      warnings.push({
        message: `The key is much ${keyOklch.l > base[anchor] ? "lighter" : "darker"} than step ${safeSteps[anchor]} on the shared ladder, so this ramp is stretched. Step ${safeSteps[suggested]} would sit flush with the other spectra.`,
        fixLabel: `Move Main to ${safeSteps[suggested]}`,
        fix: { kind: "anchor-step", spectrumId: spec.id, step: safeSteps[suggested] }
      });
    }
    const torsion = (_c = spec.hueTorsion) != null ? _c : settings.hueTorsion === "auto" ? autoHueTorsion(keyOklch.h) : settings.hueTorsion;
    let colors;
    if (settings.formula === "mix") {
      colors = rampByMixing(key, safeSteps.length, anchor);
      if (neutral) {
        colors[0] = WHITE2;
        colors[colors.length - 1] = BLACK2;
      }
    } else {
      const ladder = warpLadder(base, anchor, neutral ? base[anchor] : keyOklch.l);
      const oklchRamp = rampByOklch(
        keyOklch,
        ladder,
        anchor,
        settings.chromaCurve,
        torsion,
        neutral ? clamp2(settings.neutralChroma, 0, 1) : null
      );
      colors = oklchRamp.map(oklchToRgb);
    }
    const markIndex = (step, fallback) => {
      if (step === void 0) return fallback >= 0 && fallback < safeSteps.length ? fallback : -1;
      const index = indexOfStep(safeSteps, step);
      return index === anchor ? -1 : index;
    };
    const lightIndex = markIndex(spec.lightStep, anchor - 2);
    const darkIndex = markIndex(spec.darkStep, anchor + 2);
    return {
      id: spec.id,
      label: sanitizeLabel(spec.label),
      prefix,
      keyHex: formatHex(key),
      anchorStep: safeSteps[anchor],
      neutral,
      swatches: buildSwatches(colors, safeSteps, prefix, { main: anchor, light: lightIndex, dark: darkIndex }),
      suggestedAnchorStep: safeSteps[suggested],
      warnings
    };
  }
  function generatePalette(settings) {
    const prefixes = derivePrefixes(settings.spectra.map((s) => {
      var _a;
      return ((_a = s.prefix) == null ? void 0 : _a.trim()) ? s.prefix.trim() : s.label;
    }));
    const spectra = settings.spectra.map((spec, i) => generateSpectrum(spec, settings, prefixes[i]));
    const warnings = [];
    const labels = spectra.map((s) => s.label.toLowerCase());
    const duplicates = labels.filter((label3, i) => labels.indexOf(label3) !== i);
    if (duplicates.length > 0) {
      warnings.push({
        message: `Duplicate spectrum names (${Array.from(new Set(duplicates)).join(", ")}) will merge into one group.`,
        fixLabel: "Rename the duplicates",
        fix: { kind: "rename-duplicates" }
      });
    }
    return { spectra, warnings };
  }
  function shiftMark(steps, step, delta) {
    if (step === void 0) return void 0;
    const moved = indexOfStep(steps, step) + delta;
    return moved >= 0 && moved < steps.length ? steps[moved] : void 0;
  }
  function applyPaletteFix(settings, fix) {
    var _a, _b;
    const spectra = settings.spectra.map((spec) => __spreadValues({}, spec));
    switch (fix.kind) {
      case "anchor-step": {
        for (const spec of spectra) {
          if (spec.id !== fix.spectrumId) continue;
          const steps = normalizeSteps((_a = spec.steps) != null ? _a : spec.neutral ? settings.neutralSteps : settings.steps);
          if (steps.length === 0) continue;
          const from = indexOfStep(steps, spec.anchorStep);
          const to = indexOfStep(steps, fix.step);
          spec.anchorStep = steps[to];
          spec.lightStep = shiftMark(steps, spec.lightStep, to - from);
          spec.darkStep = shiftMark(steps, spec.darkStep, to - from);
        }
        return __spreadProps(__spreadValues({}, settings), { spectra });
      }
      case "reset-steps":
        return fix.neutral ? __spreadProps(__spreadValues({}, settings), { neutralSteps: [...DEFAULT_NEUTRAL_STEPS], spectra }) : __spreadProps(__spreadValues({}, settings), { steps: [...DEFAULT_STEPS], spectra });
      case "rename-duplicates": {
        const seen = /* @__PURE__ */ new Map();
        for (const spec of spectra) {
          const key = spec.label.trim().toLowerCase();
          const taken = (_b = seen.get(key)) != null ? _b : 0;
          seen.set(key, taken + 1);
          if (taken > 0) spec.label = `${spec.label.trim()} ${taken + 1}`;
        }
        return __spreadProps(__spreadValues({}, settings), { spectra });
      }
      // Not a settings edit — the caller re-runs the write with `splitDarkTheme` instead.
      case "split-dark-theme":
        return __spreadProps(__spreadValues({}, settings), { spectra });
    }
  }
  var HUE_NAMES = [
    { upTo: 20, name: "Rose" },
    { upTo: 32, name: "Red" },
    { upTo: 55, name: "Orange" },
    { upTo: 88, name: "Amber" },
    { upTo: 112, name: "Yellow" },
    { upTo: 140, name: "Lime" },
    { upTo: 172, name: "Green" },
    { upTo: 198, name: "Teal" },
    { upTo: 226, name: "Cyan" },
    { upTo: 245, name: "Sky" },
    { upTo: 266, name: "Blue" },
    { upTo: 285, name: "Indigo" },
    { upTo: 298, name: "Violet" },
    { upTo: 313, name: "Purple" },
    { upTo: 338, name: "Magenta" },
    { upTo: 360, name: "Pink" }
  ];
  function hueName(hue) {
    const h = (hue % 360 + 360) % 360;
    for (const entry of HUE_NAMES) if (h < entry.upTo) return entry.name;
    return "Pink";
  }
  var HARMONY_OFFSETS = [180, 150, 210, 120, 240, 90, 270, 30, 330];
  function hueDistance(a, b) {
    const diff = Math.abs(((a - b) % 360 + 360) % 360);
    return diff > 180 ? 360 - diff : diff;
  }
  var MIN_HUE_SEPARATION = 25;
  function suggestHarmoniousSpectrum(settings, random = Math.random) {
    var _a, _b;
    const colored = settings.spectra.filter((spec) => !spec.neutral);
    const keys = colored.map((spec) => hexToOklch(spec.keyHex)).filter((color) => color !== null && color.c > 0.02);
    const takenLabels = new Set(settings.spectra.map((spec) => spec.label.trim().toLowerCase()));
    const anchorStep = (_b = (_a = colored[0]) == null ? void 0 : _a.anchorStep) != null ? _b : settings.steps[Math.floor(settings.steps.length / 2)];
    let lightness;
    let chroma;
    let hue;
    if (keys.length === 0) {
      lightness = 0.66;
      chroma = 0.16;
      hue = random() * 360;
    } else {
      lightness = keys.reduce((sum, key) => sum + key.l, 0) / keys.length;
      chroma = keys.reduce((sum, key) => sum + key.c, 0) / keys.length;
      const base2 = keys[0].h;
      const candidates = HARMONY_OFFSETS.map((offset) => (base2 + offset) % 360).filter(
        (candidate) => keys.every((key) => hueDistance(candidate, key.h) >= MIN_HUE_SEPARATION)
      );
      hue = candidates.length > 0 ? candidates[Math.floor(random() * candidates.length) % candidates.length] : widestGapHue(keys.map((key) => key.h));
    }
    const fitted = Math.min(chroma, maxChroma(lightness, hue) * 0.95);
    const keyHex = oklchToHex({ l: lightness, c: fitted, h: hue });
    const base = hueName(hue);
    let label3 = base;
    let suffix = 2;
    while (takenLabels.has(label3.toLowerCase())) label3 = `${base} ${suffix++}`;
    return {
      id: `spectrum-${Math.round(hue)}-${settings.spectra.length}`,
      label: label3,
      keyHex,
      anchorStep
    };
  }
  function widestGapHue(hues) {
    const sorted = [...hues].map((h) => (h % 360 + 360) % 360).sort((a, b) => a - b);
    let best = (sorted[0] + 180) % 360;
    let widest = -1;
    for (let i = 0; i < sorted.length; i++) {
      const next = sorted[(i + 1) % sorted.length];
      const gap = i === sorted.length - 1 ? next + 360 - sorted[i] : next - sorted[i];
      if (gap > widest) {
        widest = gap;
        best = (sorted[i] + gap / 2) % 360;
      }
    }
    return best;
  }
  var stepAt = (spectrum, index) => spectrum.swatches[clamp2(index, 0, spectrum.swatches.length - 1)].name;
  var pathOf = (spectrum, name) => `${spectrum.label}/${name}`;
  function themeRoles(palette) {
    var _a;
    const neutral = (_a = palette.spectra.find((s) => s.neutral)) != null ? _a : palette.spectra[0];
    const roles = [];
    if (!neutral) return roles;
    const last = neutral.swatches.length - 1;
    const mirror = (index) => ({
      light: pathOf(neutral, stepAt(neutral, index)),
      dark: pathOf(neutral, stepAt(neutral, last - index))
    });
    roles.push(__spreadValues({ name: "bg/canvas" }, mirror(0)));
    roles.push(__spreadValues({ name: "bg/surface" }, mirror(1)));
    roles.push(__spreadValues({ name: "bg/raised" }, mirror(2)));
    roles.push(__spreadValues({ name: "border/subtle" }, mirror(3)));
    roles.push(__spreadValues({ name: "border/default" }, mirror(4)));
    roles.push(__spreadValues({ name: "text/muted" }, mirror(last - 3)));
    roles.push(__spreadValues({ name: "text/secondary" }, mirror(last - 2)));
    roles.push(__spreadValues({ name: "text/primary" }, mirror(last - 1)));
    for (const spectrum of palette.spectra) {
      if (spectrum.neutral) continue;
      const main = spectrum.swatches.findIndex((s) => s.isMain);
      const light = spectrum.swatches.findIndex((s) => s.isLight);
      const dark = spectrum.swatches.findIndex((s) => s.isDark);
      const key = spectrum.label.toLowerCase();
      roles.push({
        name: `accent/${key}/base`,
        light: pathOf(spectrum, stepAt(spectrum, main)),
        dark: pathOf(spectrum, stepAt(spectrum, light === -1 ? main : light))
      });
      roles.push({
        name: `accent/${key}/hover`,
        light: pathOf(spectrum, stepAt(spectrum, dark === -1 ? main : dark)),
        dark: pathOf(spectrum, stepAt(spectrum, main))
      });
      roles.push({
        name: `accent/${key}/subtle`,
        light: pathOf(spectrum, stepAt(spectrum, 1)),
        dark: pathOf(spectrum, stepAt(spectrum, spectrum.swatches.length - 2))
      });
    }
    return roles;
  }

  // src/tokens/palette-settings.ts
  var isRecord3 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  var number = (value, fallback, min, max) => {
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  var text = (value, fallback) => typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  var flag = (value, fallback) => typeof value === "boolean" ? value : fallback;
  function parseSteps(value, fallback) {
    const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/).filter(Boolean) : null;
    if (!raw) return fallback;
    const steps = Array.from(
      new Set(
        raw.map((entry) => typeof entry === "string" ? Number(entry.trim()) : entry).filter((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0).map((entry) => Math.round(entry))
      )
    ).sort((a, b) => a - b);
    return steps.length >= 2 ? steps : fallback;
  }
  function normalizeSpectrum(value, index) {
    if (!isRecord3(value)) return null;
    const label3 = text(value.label, "");
    if (label3 === "") return null;
    const neutral = flag(value.neutral, false);
    const steps = value.steps === void 0 ? void 0 : parseSteps(value.steps, []);
    const spec = {
      id: text(value.id, `spectrum-${index}`),
      label: label3,
      prefix: text(value.prefix, "").toUpperCase() || void 0,
      keyHex: text(value.keyHex, "#808080"),
      anchorStep: number(value.anchorStep, neutral ? 500 : 500, 0, 1e5),
      neutral
    };
    if (steps && steps.length >= 2) spec.steps = steps;
    if (typeof value.lightStep === "number") spec.lightStep = value.lightStep;
    if (typeof value.darkStep === "number") spec.darkStep = value.darkStep;
    if (value.hueTorsion !== void 0 && value.hueTorsion !== "auto") {
      spec.hueTorsion = number(value.hueTorsion, 0, -60, 60);
    }
    return spec;
  }
  function normalizePaletteFix(value) {
    if (!isRecord3(value)) return null;
    if (value.kind === "anchor-step") {
      const spectrumId = text(value.spectrumId, "");
      if (spectrumId === "" || typeof value.step !== "number" || !Number.isFinite(value.step)) return null;
      return { kind: "anchor-step", spectrumId, step: Math.round(value.step) };
    }
    if (value.kind === "reset-steps") return { kind: "reset-steps", neutral: flag(value.neutral, false) };
    if (value.kind === "rename-duplicates") return { kind: "rename-duplicates" };
    if (value.kind === "split-dark-theme") return { kind: "split-dark-theme" };
    return null;
  }
  function normalizePaletteSettings(value) {
    const defaults = DEFAULT_PALETTE_SETTINGS;
    if (!isRecord3(value)) return __spreadProps(__spreadValues({}, defaults), { spectra: defaults.spectra.map((s) => __spreadValues({}, s)) });
    const spectra = Array.isArray(value.spectra) ? value.spectra.map(normalizeSpectrum).filter((spec) => spec !== null) : [];
    const lightnessMax = number(value.lightnessMax, defaults.lightnessMax, 0.5, 1);
    const lightnessMin = number(value.lightnessMin, defaults.lightnessMin, 0, 0.5);
    return {
      formula: value.formula === "mix" ? "mix" : "oklch",
      steps: parseSteps(value.steps, DEFAULT_STEPS),
      neutralSteps: parseSteps(value.neutralSteps, DEFAULT_NEUTRAL_STEPS),
      lightnessMax,
      // A collapsed or inverted range would flatten every ramp into one shade.
      lightnessMin: lightnessMin < lightnessMax - 0.1 ? lightnessMin : defaults.lightnessMin,
      lightnessCurve: number(value.lightnessCurve, defaults.lightnessCurve, 0.6, 2.5),
      chromaCurve: number(value.chromaCurve, defaults.chromaCurve, 0, 1),
      hueTorsion: value.hueTorsion === "auto" ? "auto" : number(value.hueTorsion, 0, -60, 60),
      neutralChroma: number(value.neutralChroma, defaults.neutralChroma, 0, 1),
      spectra: spectra.length > 0 ? spectra : defaults.spectra.map((s) => __spreadValues({}, s))
    };
  }

  // src/targets/ds-tools/palette-apply.ts
  var DEFAULT_APPLY_OPTIONS = {
    variables: true,
    theme: true,
    canvas: true,
    collectionName: "colors",
    themeCollectionName: "theme",
    splitDarkTheme: false
  };
  var SECTION_PLUGIN_KEY = "altery-palette-section";
  var SWATCH_COMPONENT_PLUGIN_KEY = "altery-palette-swatch";
  function createVariable(name, collection, type) {
    try {
      return figma.variables.createVariable(name, collection, type);
    } catch (e) {
      return figma.variables.createVariable(name, collection.id, type);
    }
  }
  async function findOrCreateCollection(name) {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const existing = collections.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) return { collection: existing, existed: true };
    return { collection: figma.variables.createVariableCollection(name), existed: false };
  }
  async function variableWriter(collection) {
    const locals = await figma.variables.getLocalVariablesAsync("COLOR");
    const byName = /* @__PURE__ */ new Map();
    for (const variable of locals) {
      if (variable.variableCollectionId === collection.id) byName.set(variable.name, variable);
    }
    return {
      upsert(name) {
        const existing = byName.get(name);
        if (existing) return { variable: existing, created: false };
        const variable = createVariable(name, collection, "COLOR");
        byName.set(name, variable);
        return { variable, created: true };
      }
    };
  }
  var rgbOf = (hex) => {
    const rgb = parseHex(hex);
    return rgb ? { r: rgb.r, g: rgb.g, b: rgb.b } : { r: 0.5, g: 0.5, b: 0.5 };
  };
  var variablePath = (spectrum, swatch) => `${spectrum.label}/${swatch.name}`;
  async function writeColorVariables(palette, collectionName) {
    const { collection } = await findOrCreateCollection(collectionName);
    const writer = await variableWriter(collection);
    const modeId = collection.defaultModeId;
    const result = { created: 0, updated: 0, aliases: 0, byPath: /* @__PURE__ */ new Map() };
    for (const spectrum of palette.spectra) {
      for (const swatch of spectrum.swatches) {
        const path = variablePath(spectrum, swatch);
        const { variable, created } = writer.upsert(path);
        variable.setValueForMode(modeId, rgbOf(swatch.hex));
        result.byPath.set(path, variable);
        if (created) result.created++;
        else result.updated++;
      }
      const marks = [
        ["Main", spectrum.swatches.find((s) => s.isMain)],
        ["Light", spectrum.swatches.find((s) => s.isLight)],
        ["Dark", spectrum.swatches.find((s) => s.isDark)]
      ];
      for (const [markName, swatch] of marks) {
        if (!swatch) continue;
        const target = result.byPath.get(variablePath(spectrum, swatch));
        if (!target) continue;
        const { variable, created } = writer.upsert(`${spectrum.label}/${markName}`);
        variable.setValueForMode(modeId, figma.variables.createVariableAlias(target));
        if (created) result.created++;
        else result.updated++;
        result.aliases++;
      }
    }
    return result;
  }
  async function findCollection(name) {
    var _a;
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    return (_a = collections.find((c) => c.name.toLowerCase() === name.toLowerCase())) != null ? _a : null;
  }
  async function writeDarkCompanion(themeCollectionName, roles, colorsByPath) {
    const { collection } = await findOrCreateCollection(darkCompanionName(themeCollectionName));
    const modeId = collection.modes[0].modeId;
    try {
      collection.renameMode(modeId, "Dark");
    } catch (e) {
    }
    const writer = await variableWriter(collection);
    let written = 0;
    for (const role of roles) {
      const dark = colorsByPath.get(role.dark);
      if (!dark) continue;
      const { variable } = writer.upsert(role.name);
      variable.setValueForMode(modeId, figma.variables.createVariableAlias(dark));
      written++;
    }
    return written;
  }
  async function writeThemeCollection(palette, themeCollectionName, colorsByPath, splitDarkTheme) {
    const roles = themeRoles(palette);
    if (roles.length === 0) return { roles: 0, layout: "light-only", warnings: [] };
    const { collection } = await findOrCreateCollection(themeCollectionName);
    const warnings = [];
    let lightModeId = collection.modes[0].modeId;
    try {
      collection.renameMode(lightModeId, "Light");
    } catch (e) {
    }
    const companionExists = await findCollection(darkCompanionName(themeCollectionName)) !== null;
    let split = splitDarkTheme || companionExists;
    let darkMode = collection.modes.find((m) => m.name.toLowerCase() === "dark");
    if (!split && !darkMode) {
      try {
        const darkModeId = collection.addMode("Dark");
        darkMode = { modeId: darkModeId, name: "Dark" };
      } catch (e) {
        warnings.push({
          message: 'This file cannot hold a second mode in one collection \u2014 that needs a paid Figma plan. Only the Light values were written. The dark theme can live in a linked "' + darkCompanionName(themeCollectionName) + '" collection instead; the export folds the two back into one Light/Dark stylesheet.',
          fixLabel: "Create the linked Dark collection",
          fix: { kind: "split-dark-theme" }
        });
      }
    }
    lightModeId = collection.modes[0].modeId;
    const writer = await variableWriter(collection);
    let written = 0;
    for (const role of roles) {
      const light = colorsByPath.get(role.light);
      const dark = colorsByPath.get(role.dark);
      if (!light) continue;
      const { variable } = writer.upsert(role.name);
      variable.setValueForMode(lightModeId, figma.variables.createVariableAlias(light));
      if (!split && darkMode && dark) {
        variable.setValueForMode(darkMode.modeId, figma.variables.createVariableAlias(dark));
      }
      written++;
    }
    if (split) {
      try {
        await writeDarkCompanion(themeCollectionName, roles, colorsByPath);
      } catch (error) {
        split = false;
        warnings.push({ message: `The linked Dark collection could not be written: ${String((error == null ? void 0 : error.message) || error)}` });
      }
    }
    const layout = split ? "split" : darkMode ? "modes" : "light-only";
    return { roles: written, layout, warnings };
  }
  var SWATCH_WIDTH = 150;
  var SWATCH_COLOR_HEIGHT = 105;
  var LABEL_HEIGHT = 20;
  var MARK_HEIGHT = 20;
  var ROW_GAP = 72;
  var SECTION_PADDING = 128;
  var LABEL_SIZE = 13;
  var CAPTION_SIZE = 11;
  async function loadFonts() {
    var _a;
    const candidates = [
      { family: "Inter", style: "Regular" },
      { family: "Roboto", style: "Regular" },
      { family: "Helvetica", style: "Regular" }
    ];
    for (const font of candidates) {
      try {
        await figma.loadFontAsync(font);
        return { body: font };
      } catch (e) {
      }
    }
    const available = await figma.listAvailableFontsAsync();
    const first = (_a = available[0]) == null ? void 0 : _a.fontName;
    if (!first) throw new Error("No fonts are available to label the swatches.");
    await figma.loadFontAsync(first);
    return { body: first };
  }
  var solid2 = (hex) => ({ type: "SOLID", color: rgbOf(hex) });
  function label(text2, fonts, size, hex) {
    const node = figma.createText();
    node.fontName = fonts.body;
    node.fontSize = size;
    node.characters = text2;
    node.fills = [solid2(hex)];
    return node;
  }
  function autoLayout(name, direction, gap) {
    const frame2 = figma.createFrame();
    frame2.name = name;
    frame2.layoutMode = direction;
    frame2.itemSpacing = gap;
    frame2.primaryAxisSizingMode = "AUTO";
    frame2.counterAxisSizingMode = "AUTO";
    frame2.fills = [];
    frame2.clipsContent = false;
    return frame2;
  }
  var PART = { color: "color", step: "step", hex: "hex", mark: "mark", markName: "markName" };
  function buildSwatchComponent(fonts) {
    const component = figma.createComponent();
    component.name = "Color swatch";
    component.setPluginData(SWATCH_COMPONENT_PLUGIN_KEY, "1");
    component.layoutMode = "VERTICAL";
    component.itemSpacing = 0;
    component.primaryAxisSizingMode = "FIXED";
    component.counterAxisSizingMode = "FIXED";
    component.fills = [];
    component.clipsContent = false;
    component.resize(SWATCH_WIDTH, SWATCH_COLOR_HEIGHT + LABEL_HEIGHT + MARK_HEIGHT);
    const block2 = figma.createRectangle();
    block2.name = PART.color;
    block2.resize(SWATCH_WIDTH, SWATCH_COLOR_HEIGHT);
    block2.fills = [solid2("#CCCCCC")];
    component.appendChild(block2);
    const labelRow = autoLayout("label", "HORIZONTAL", 10);
    labelRow.primaryAxisSizingMode = "FIXED";
    labelRow.counterAxisSizingMode = "FIXED";
    labelRow.resize(SWATCH_WIDTH, LABEL_HEIGHT);
    labelRow.paddingLeft = 10;
    labelRow.counterAxisAlignItems = "CENTER";
    const step = label("500", fonts, LABEL_SIZE, "#1A1A1A");
    step.name = PART.step;
    step.textAutoResize = "HEIGHT";
    step.resize(44, LABEL_SIZE * 1.4);
    labelRow.appendChild(step);
    const hex = label("#000000", fonts, LABEL_SIZE, "#1A1A1A");
    hex.name = PART.hex;
    labelRow.appendChild(hex);
    component.appendChild(labelRow);
    const markRow = autoLayout(PART.mark, "HORIZONTAL", 0);
    markRow.primaryAxisSizingMode = "FIXED";
    markRow.counterAxisSizingMode = "FIXED";
    markRow.resize(SWATCH_WIDTH, MARK_HEIGHT);
    markRow.primaryAxisAlignItems = "CENTER";
    markRow.counterAxisAlignItems = "CENTER";
    const markText = label("Main", fonts, LABEL_SIZE, "#1A1A1A");
    markText.name = PART.markName;
    markRow.appendChild(markText);
    component.appendChild(markRow);
    return component;
  }
  var findPart = (instance, name) => instance.findOne((node) => node.name === name);
  function instantiateSwatch(master, swatch, variable) {
    const markName = swatch.isMain ? "Main" : swatch.isLight ? "Light" : swatch.isDark ? "Dark" : null;
    const instance = master.createInstance();
    instance.name = `${swatch.name}${markName ? ` \xB7 ${markName}` : ""}`;
    const block2 = findPart(instance, PART.color);
    if (block2 && "fills" in block2) {
      let paint = solid2(swatch.hex);
      if (variable) paint = figma.variables.setBoundVariableForPaint(paint, "color", variable);
      block2.fills = [paint];
    }
    const step = findPart(instance, PART.step);
    if (step && step.type === "TEXT") step.characters = String(swatch.step);
    const hex = findPart(instance, PART.hex);
    if (hex && hex.type === "TEXT") hex.characters = swatch.hex;
    const mark = findPart(instance, PART.mark);
    if (mark) mark.visible = markName !== null;
    const markText = findPart(instance, PART.markName);
    if (markName && markText && markText.type === "TEXT") markText.characters = markName;
    return instance;
  }
  function buildRow(spectrum, master, fonts, colorsByPath) {
    const row = autoLayout(spectrum.label, "VERTICAL", 8);
    row.appendChild(label(`${spectrum.label}  \xB7  ${spectrum.keyHex}`, fonts, CAPTION_SIZE, "#8A8A8A"));
    const strip = autoLayout("strip", "HORIZONTAL", 0);
    for (const swatch of spectrum.swatches) {
      strip.appendChild(instantiateSwatch(master, swatch, colorsByPath.get(variablePath(spectrum, swatch))));
    }
    row.appendChild(strip);
    return row;
  }
  async function adoptSwatchComponent(fonts) {
    const existing = figma.currentPage.findAllWithCriteria({ types: ["COMPONENT"] }).find((node) => node.getPluginData(SWATCH_COMPONENT_PLUGIN_KEY) === "1");
    if (existing) {
      const intact = [PART.color, PART.step, PART.hex, PART.mark, PART.markName].every(
        (name) => existing.findOne((node) => node.name === name) !== null
      );
      if (intact) {
        for (const text2 of existing.findAllWithCriteria({ types: ["TEXT"] })) {
          if (text2.fontName !== figma.mixed) {
            try {
              await figma.loadFontAsync(text2.fontName);
            } catch (e) {
            }
          }
        }
        return existing;
      }
      existing.remove();
    }
    return buildSwatchComponent(fonts);
  }
  function placementFor(width) {
    const nodes = figma.currentPage.children;
    if (nodes.length === 0) {
      const { x, y } = figma.viewport.center;
      return { x: x - width / 2, y: y - 200 };
    }
    let right = -Infinity;
    let top = Infinity;
    for (const node of nodes) {
      right = Math.max(right, node.x + node.width);
      top = Math.min(top, node.y);
    }
    return { x: right + 200, y: top };
  }
  async function drawBoard(palette, colorsByPath) {
    var _a;
    const fonts = await loadFonts();
    const previous = figma.currentPage.findAllWithCriteria({ types: ["SECTION"] }).find((node) => node.getPluginData(SECTION_PLUGIN_KEY) === "1");
    const previousBox = (_a = previous == null ? void 0 : previous.absoluteBoundingBox) != null ? _a : null;
    const previousSpot = previousBox ? { x: previousBox.x, y: previousBox.y } : null;
    const master = await adoptSwatchComponent(fonts);
    figma.currentPage.appendChild(master);
    if (previous) previous.remove();
    const widestRamp = palette.spectra.reduce((widest, s) => Math.max(widest, s.swatches.length), 0);
    const spot = previousSpot != null ? previousSpot : placementFor(widestRamp * SWATCH_WIDTH + SECTION_PADDING * 2);
    const content = autoLayout("Palettes", "VERTICAL", ROW_GAP);
    content.x = spot.x + SECTION_PADDING;
    content.y = spot.y + SECTION_PADDING;
    const masterRow = autoLayout("Master", "VERTICAL", 8);
    masterRow.appendChild(label("Swatch \u2014 master component", fonts, CAPTION_SIZE, "#8A8A8A"));
    masterRow.appendChild(master);
    content.appendChild(masterRow);
    let swatches = 0;
    for (const spectrum of palette.spectra) {
      content.appendChild(buildRow(spectrum, master, fonts, colorsByPath));
      swatches += spectrum.swatches.length;
    }
    const section = figma.createSection();
    section.name = "Colors";
    section.fills = [solid2("#FFFFFF")];
    section.setPluginData(SECTION_PLUGIN_KEY, "1");
    const width = content.width + SECTION_PADDING * 2;
    const height = content.height + SECTION_PADDING * 2;
    figma.currentPage.appendChild(section);
    section.x = spot.x;
    section.y = spot.y;
    section.resizeWithoutConstraints(width, height);
    section.appendChild(content);
    content.x = section.x + SECTION_PADDING;
    content.y = section.y + SECTION_PADDING;
    const sectionBox = section.absoluteBoundingBox;
    const contentBox = content.absoluteBoundingBox;
    if (sectionBox && contentBox) {
      const dx = sectionBox.x + SECTION_PADDING - contentBox.x;
      const dy = sectionBox.y + SECTION_PADDING - contentBox.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        content.x += dx;
        content.y += dy;
      }
    }
    return { section, swatches };
  }
  async function applyPalette(palette, options) {
    if (figma.editorType === "dev") {
      throw new Error("Switch to Design mode \u2014 Dev Mode can't create variables or draw on the canvas.");
    }
    if (palette.spectra.length === 0) throw new Error("Add at least one spectrum before generating.");
    const warnings = palette.warnings.map((warning) => ({ message: warning.message }));
    for (const spectrum of palette.spectra) {
      for (const warning of spectrum.warnings) warnings.push({ message: `${spectrum.label}: ${warning.message}` });
    }
    let written = { created: 0, updated: 0, aliases: 0, byPath: /* @__PURE__ */ new Map() };
    if (options.variables) written = await writeColorVariables(palette, options.collectionName);
    let roles = 0;
    let themeLayout = "light-only";
    if (options.theme) {
      if (!options.variables) {
        warnings.push({ message: "Theme modes need the colors collection \u2014 enable it to generate the theme." });
      } else {
        const themeResult = await writeThemeCollection(
          palette,
          options.themeCollectionName,
          written.byPath,
          options.splitDarkTheme
        );
        roles = themeResult.roles;
        themeLayout = themeResult.layout;
        warnings.push(...themeResult.warnings);
      }
    }
    let swatches = 0;
    let sectionName = null;
    if (options.canvas) {
      const board = await drawBoard(palette, written.byPath);
      swatches = board.swatches;
      sectionName = board.section.name;
      figma.currentPage.selection = [board.section];
      figma.viewport.scrollAndZoomIntoView([board.section]);
    }
    return {
      collection: options.collectionName,
      created: written.created,
      updated: written.updated,
      aliases: written.aliases,
      themeLayout,
      themeRoles: roles,
      swatches,
      sectionName,
      warnings
    };
  }

  // src/targets/ds-tools/remap-inventory.ts
  var MAX_ADJACENT_PAIRS = 2e4;
  var MAX_LOOSE_COLORS = 400;
  var MAX_NODES = 2e5;
  var siteId = (variableId, modeId) => `${variableId}|${modeId}`;
  var styleSiteId = (styleId, property, index, stop) => `style:${styleId}#${property}:${index}${stop === void 0 ? "" : `.${stop}`}`;
  var looseSiteId = (hex, alpha) => `loose:${hex}:${alpha.toFixed(3)}`;
  var isLooseSite = (id) => id.slice(0, 6) === "loose:";
  var isAlias = (value) => typeof value === "object" && value !== null && value.type === "VARIABLE_ALIAS";
  var isRgb = (value) => typeof value === "object" && value !== null && "r" in value && "g" in value && "b" in value;
  var withAlpha = (color) => ({
    r: color.r,
    g: color.g,
    b: color.b,
    a: "a" in color ? color.a : 1
  });
  var hexOf = (color) => "#" + [color.r, color.g, color.b].map(
    (channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).toUpperCase().padStart(2, "0")
  ).join("");
  var GRADIENTS = ["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"];
  var isGradient = (paint) => GRADIENTS.indexOf(paint.type) !== -1;
  var isShadow = (effect) => effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW";
  var boundIdsOf = (value) => {
    if (!value) return [];
    const list = Array.isArray(value) ? value : [value];
    return list.map((entry) => entry && typeof entry === "object" ? entry.id : null).filter((id) => typeof id === "string");
  };
  var paintsOf = (node, property) => {
    const value = node[property];
    return Array.isArray(value) ? value : [];
  };
  var styleIdOf2 = (node, property) => {
    const key = property === "fills" ? "fillStyleId" : property === "strokes" ? "strokeStyleId" : "effectStyleId";
    const value = node[key];
    return typeof value === "string" ? value : "";
  };
  var nodeLevelBindings = (node, property) => {
    const bound = "boundVariables" in node ? node.boundVariables : void 0;
    return Array.isArray(bound == null ? void 0 : bound[property]) ? bound[property] : [];
  };
  function noteLoose(walk, color) {
    const hex = hexOf(color);
    const id = looseSiteId(hex, color.a);
    const existing = walk.loose.get(id);
    if (existing) existing.count++;
    else if (walk.loose.size < MAX_LOOSE_COLORS) walk.loose.set(id, { hex, alpha: color.a, rgba: color, count: 1 });
    else walk.looseDropped++;
    walk.loosePlaces++;
    return id;
  }
  var pairKey = (a, b, text2) => (a < b ? `${a} ${b}` : `${b} ${a}`) + (text2 ? " t" : " n");
  var EMPTY = [];
  async function walkDocument(localIds, depth, progress2) {
    var _a;
    const walk = {
      usage: /* @__PURE__ */ new Map(),
      styleUsage: /* @__PURE__ */ new Map(),
      foreign: /* @__PURE__ */ new Set(),
      loose: /* @__PURE__ */ new Map(),
      neighbours: /* @__PURE__ */ new Map(),
      nodes: 0,
      loosePlaces: 0,
      looseDropped: 0,
      instances: 0,
      truncated: false
    };
    if (depth === "tokens") return walk;
    const noteVariable = (id) => {
      var _a2;
      walk.usage.set(id, ((_a2 = walk.usage.get(id)) != null ? _a2 : 0) + 1);
      if (!localIds.has(id)) walk.foreign.add(id);
    };
    const notePair = (a, b, text2) => {
      if (walk.neighbours.size >= MAX_ADJACENT_PAIRS) return;
      const key = pairKey(a, b, text2);
      if (!walk.neighbours.has(key)) walk.neighbours.set(key, { a, b, text: text2 });
    };
    const noteStyle = (styleId) => {
      var _a2;
      if (styleId !== "") walk.styleUsage.set(styleId, ((_a2 = walk.styleUsage.get(styleId)) != null ? _a2 : 0) + 1);
    };
    const refsOf = (paints, nodeLevel, boundOnly) => {
      var _a2, _b;
      const refs = [];
      for (let index = 0; index < paints.length; index++) {
        const paint = paints[index];
        if (paint.visible === false) continue;
        const bound = [
          ...boundIdsOf((_a2 = paint.boundVariables) == null ? void 0 : _a2.color),
          ...boundIdsOf(nodeLevel[index])
        ];
        if (bound.length > 0) {
          refs.push(...bound);
          continue;
        }
        if (boundOnly) continue;
        if (paint.type === "SOLID") {
          refs.push(noteLoose(walk, __spreadProps(__spreadValues({}, paint.color), { a: (_b = paint.opacity) != null ? _b : 1 })));
          continue;
        }
        if (isGradient(paint)) for (const stop of paint.gradientStops) noteLoose(walk, withAlpha(stop.color));
      }
      return refs;
    };
    const pages = depth === "page" ? [figma.currentPage] : figma.root.children;
    figma.skipInvisibleInstanceChildren = true;
    try {
      for (const page of pages) {
        progress2 == null ? void 0 : progress2(`reading ${page.name}\u2026`);
        const stack = [];
        const roots = page.children;
        for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], behind: EMPTY });
        while (stack.length > 0) {
          if (walk.nodes >= MAX_NODES) {
            walk.truncated = true;
            break;
          }
          const pending = stack.pop();
          const node = pending.node;
          walk.nodes++;
          const type = node.type;
          const record = node;
          const fillStyle = record.fillStyleId;
          const strokeStyle = record.strokeStyleId;
          const effectStyle = record.effectStyleId;
          const fillPaints = record.fills;
          const strokePaints = record.strokes;
          const effects = record.effects;
          const bound = record.boundVariables;
          const children = "children" in node ? node.children : null;
          noteStyle(typeof fillStyle === "string" ? fillStyle : "");
          noteStyle(typeof strokeStyle === "string" ? strokeStyle : "");
          noteStyle(typeof effectStyle === "string" ? effectStyle : "");
          const isInstance = type === "INSTANCE";
          if (isInstance) walk.instances++;
          const fills = typeof fillStyle === "string" && fillStyle !== "" ? EMPTY : Array.isArray(fillPaints) ? refsOf(fillPaints, Array.isArray(bound == null ? void 0 : bound.fills) ? bound.fills : [], isInstance) : EMPTY;
          const strokes = typeof strokeStyle === "string" && strokeStyle !== "" ? EMPTY : Array.isArray(strokePaints) ? refsOf(
            strokePaints,
            Array.isArray(bound == null ? void 0 : bound.strokes) ? bound.strokes : [],
            isInstance
          ) : EMPTY;
          if ((typeof effectStyle !== "string" || effectStyle === "") && Array.isArray(effects)) {
            for (const effect of effects) {
              if (!isShadow(effect) || effect.visible === false) continue;
              const boundEffect = boundIdsOf((_a = effect.boundVariables) == null ? void 0 : _a.color);
              if (boundEffect.length > 0) {
                for (const id of boundEffect) noteVariable(id);
                continue;
              }
              if (!isInstance) noteLoose(walk, withAlpha(effect.color));
            }
          }
          for (const ref of fills) if (!isLooseSite(ref)) noteVariable(ref);
          for (const ref of strokes) if (!isLooseSite(ref)) noteVariable(ref);
          if (isInstance) {
            if (walk.nodes % 500 === 0) {
              progress2 == null ? void 0 : progress2(`reading ${page.name}\u2026 ${walk.nodes} nodes`);
              await yieldToHost();
            }
            continue;
          }
          for (const fill of fills) for (const stroke of strokes) if (fill !== stroke) notePair(fill, stroke, false);
          const behind = pending.behind;
          if (behind.length > 0) {
            const isText = type === "TEXT";
            const own = isText ? fills : strokes.length === 0 ? fills : [...fills, ...strokes];
            for (const ref of own) for (const parent of behind) if (ref !== parent) notePair(ref, parent, isText);
          }
          if (children !== null && children.length > 0) {
            const passes = fills.length > 0 ? fills : behind;
            for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], behind: passes });
          }
          if (walk.nodes % 500 === 0) {
            progress2 == null ? void 0 : progress2(`reading ${page.name}\u2026 ${walk.nodes} nodes`);
            await yieldToHost();
          }
        }
      }
    } finally {
      figma.skipInvisibleInstanceChildren = false;
    }
    return walk;
  }
  async function readStyles(walk, sites) {
    var _a, _b, _c;
    let paintStyles = 0;
    let effectStyles = 0;
    try {
      for (const style of await figma.getLocalPaintStylesAsync()) {
        paintStyles++;
        const usage = (_a = walk.styleUsage.get(style.id)) != null ? _a : 0;
        for (const [index, paint] of style.paints.entries()) {
          if (paint.visible === false) continue;
          if (paint.type === "SOLID") {
            sites.push({
              id: styleSiteId(style.id, "paints", index),
              groupId: style.id,
              kind: "style",
              name: style.name,
              modeId: null,
              modeName: null,
              rgba: __spreadProps(__spreadValues({}, paint.color), { a: (_b = paint.opacity) != null ? _b : 1 }),
              usage,
              editable: !style.remote,
              primitive: false
            });
            continue;
          }
          if (!isGradient(paint)) continue;
          for (const [stopIndex, stop] of paint.gradientStops.entries()) {
            sites.push({
              id: styleSiteId(style.id, "paints", index, stopIndex),
              groupId: style.id,
              kind: "gradient-stop",
              name: `${style.name} \xB7 stop ${stopIndex + 1}`,
              modeId: null,
              modeName: null,
              rgba: withAlpha(stop.color),
              usage,
              editable: !style.remote,
              primitive: false
            });
          }
        }
      }
    } catch (e) {
    }
    try {
      for (const style of await figma.getLocalEffectStylesAsync()) {
        effectStyles++;
        const usage = (_c = walk.styleUsage.get(style.id)) != null ? _c : 0;
        for (const [index, effect] of style.effects.entries()) {
          if (!isShadow(effect) || effect.visible === false) continue;
          sites.push({
            id: styleSiteId(style.id, "effects", index),
            groupId: style.id,
            kind: "effect",
            name: `${style.name} \xB7 ${effect.type === "DROP_SHADOW" ? "shadow" : "inner shadow"} ${index + 1}`,
            modeId: null,
            modeName: null,
            rgba: withAlpha(effect.color),
            usage,
            editable: !style.remote,
            primitive: false
          });
        }
      }
    } catch (e) {
    }
    return { paints: paintStyles, effects: effectStyles };
  }
  async function readRemapInventory(progress2, depth = "document") {
    var _a, _b, _c, _d;
    const warnings = [];
    progress2 == null ? void 0 : progress2("reading variables\u2026");
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync("COLOR");
    const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
    const localIds = new Set(variables.map((variable) => variable.id));
    const modes = [];
    for (const collection of collections) {
      for (const mode of collection.modes) {
        modes.push({ id: mode.modeId, name: mode.name, collection: collection.name, collectionId: collection.id });
      }
    }
    if (depth === "document") {
      try {
        await loadAllPagesAsync();
      } catch (e) {
        warnings.push("some pages could not be loaded \u2014 their colors are missing from this reading");
      }
    }
    const walk = await walkDocument(localIds, depth, progress2);
    progress2 == null ? void 0 : progress2("building the inventory\u2026");
    const sites = [];
    const modesByVariable = /* @__PURE__ */ new Map();
    for (const variable of variables) {
      const collection = collectionById.get(variable.variableCollectionId);
      if (!collection) continue;
      const values = Object.entries(variable.valuesByMode);
      const themed = collection.modes.length >= 2 || values.some(([, value]) => isAlias(value));
      const usage = (_a = walk.usage.get(variable.id)) != null ? _a : 0;
      const owned = [];
      for (const mode of collection.modes) {
        const value = variable.valuesByMode[mode.modeId];
        if (value === void 0 || isAlias(value) || !isRgb(value)) continue;
        sites.push({
          id: siteId(variable.id, mode.modeId),
          groupId: variable.id,
          kind: "variable",
          name: variable.name,
          modeId: mode.modeId,
          modeName: mode.name,
          rgba: withAlpha(value),
          usage,
          editable: true,
          primitive: !themed
        });
        owned.push(mode.modeId);
      }
      if (owned.length > 0) modesByVariable.set(variable.id, owned);
    }
    let libraryVariables = 0;
    for (const id of walk.foreign) {
      const variable = await figma.variables.getVariableByIdAsync(id).catch(() => null);
      if (!variable || variable.resolvedType !== "COLOR") continue;
      libraryVariables++;
      const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId).catch(() => null);
      const owned = [];
      for (const mode of (_b = collection == null ? void 0 : collection.modes) != null ? _b : []) {
        const value = variable.valuesByMode[mode.modeId];
        if (value === void 0 || isAlias(value) || !isRgb(value)) continue;
        sites.push({
          id: siteId(variable.id, mode.modeId),
          groupId: variable.id,
          kind: "variable",
          name: variable.name,
          modeId: mode.modeId,
          modeName: mode.name,
          rgba: withAlpha(value),
          usage: (_c = walk.usage.get(id)) != null ? _c : 0,
          editable: false,
          primitive: false
        });
        owned.push(mode.modeId);
      }
      if (owned.length > 0) modesByVariable.set(variable.id, owned);
    }
    const styles = await readStyles(walk, sites);
    for (const [id, color] of walk.loose) {
      sites.push({
        id,
        groupId: id,
        kind: "detached",
        name: color.hex + (color.alpha < 0.999 ? ` ${Math.round(color.alpha * 100)}%` : ""),
        modeId: null,
        modeName: null,
        rgba: color.rgba,
        usage: color.count,
        editable: true,
        primitive: false
      });
    }
    const adjacency = [];
    const expand = (ref) => {
      var _a2;
      return isLooseSite(ref) ? [ref] : ((_a2 = modesByVariable.get(ref)) != null ? _a2 : []).map((mode) => siteId(ref, mode));
    };
    const modeOf = (site) => isLooseSite(site) ? null : site.slice(site.lastIndexOf("|") + 1);
    for (const pair2 of walk.neighbours.values()) {
      for (const a of expand(pair2.a)) {
        for (const b of expand(pair2.b)) {
          const modeA = modeOf(a);
          const modeB = modeOf(b);
          if (modeA !== null && modeB !== null && modeA !== modeB) continue;
          adjacency.push({ a, b, text: pair2.text });
        }
      }
    }
    const primaryCollection = collections.map((collection) => ({
      collection,
      count: variables.filter((variable) => variable.variableCollectionId === collection.id).length
    })).sort((a, b) => b.count - a.count)[0];
    if (sites.length === 0) warnings.push("this file holds no colors this tool can remap");
    if (depth === "tokens") {
      warnings.push(
        "read variables and styles only \u2014 loose colors on layers are not in this mapping, and the name that wins a collision is decided without usage counts"
      );
    } else if (depth === "page") {
      warnings.push(`read this page only \u2014 loose colors on other pages are not in this mapping`);
    }
    if (walk.looseDropped > 0) {
      warnings.push(
        `${walk.looseDropped} rarely used loose color(s) beyond the first ${MAX_LOOSE_COLORS} were left out of this reading \u2014 they stay as they are`
      );
    }
    if (walk.instances > 0) {
      warnings.push(
        `${walk.instances} instance(s) were skipped \u2014 their colors belong to a main component, which is read and written on its own; a color overridden by hand on one instance stays as it is`
      );
    }
    if (walk.truncated) {
      warnings.push(
        `this file is larger than one pass can read (stopped at ${MAX_NODES} nodes) \u2014 variables and styles are complete, but loose colors on layers beyond that point are missing`
      );
    }
    if (walk.neighbours.size >= MAX_ADJACENT_PAIRS) {
      warnings.push(
        `this file has more touching colour pairs than one pass can hold \u2014 duplicate separation and the contrast audit ran on the first ${MAX_ADJACENT_PAIRS}`
      );
    }
    return {
      sites,
      adjacency,
      modes,
      primaryModeId: (_d = primaryCollection == null ? void 0 : primaryCollection.collection.defaultModeId) != null ? _d : null,
      stats: {
        variables: variables.length,
        libraryVariables,
        collections: collections.length,
        paintStyles: styles.paints,
        effectStyles: styles.effects,
        looseColors: walk.loose.size,
        loosePlaces: walk.loosePlaces,
        nodes: walk.nodes,
        instances: walk.instances
      },
      warnings
    };
  }

  // src/tokens/remap/token-name.ts
  var STEP_RE = /^([A-Za-z][A-Za-z\s-]*?)?[\s._-]*(\d{1,4})$/;
  var SEGMENT_RE = /[/.]+/;
  var clean = (segment) => segment.trim();
  function parseTokenName(name) {
    var _a;
    const path = String(name != null ? name : "").split(SEGMENT_RE).map(clean).filter((segment) => segment !== "");
    const leaf = path.length > 0 ? path[path.length - 1] : "";
    const group = path.length > 1 ? path[path.length - 2] : null;
    const match = STEP_RE.exec(leaf);
    if (!match) return { path, leaf, group, family: group, step: null };
    const prefix = ((_a = match[1]) != null ? _a : "").replace(/[\s_-]+$/, "").trim();
    const family = group != null ? group : prefix !== "" ? prefix : null;
    return { path, leaf, group, family, step: Number(match[2]) };
  }
  var familyKey = (family) => family.toLowerCase().replace(/[\s._-]+/g, "").trim();
  function renameFamily(name, newFamily, newStep) {
    var _a, _b, _c;
    const parsed = parseTokenName(name);
    if (parsed.path.length === 0) return name;
    const path = [...parsed.path];
    const leafIndex = path.length - 1;
    const step = newStep != null ? newStep : parsed.step;
    if (parsed.group !== null) path[leafIndex - 1] = newFamily;
    const match = STEP_RE.exec(parsed.leaf);
    if (match) {
      const prefix = ((_a = match[1]) != null ? _a : "").replace(/[\s_-]+$/, "").trim();
      const separator = (_c = (_b = /[\s._-]/.exec(parsed.leaf.slice(prefix.length))) == null ? void 0 : _b[0]) != null ? _c : "";
      const newPrefix = prefix === "" ? "" : abbreviate(prefix, newFamily);
      path[leafIndex] = `${newPrefix}${separator}${step != null ? step : match[2]}`;
    }
    return path.join("/");
  }
  function abbreviate(oldPrefix, newFamily) {
    const compact = newFamily.replace(/[\s._-]+/g, "");
    if (oldPrefix.length >= compact.length) return matchCase(oldPrefix, compact);
    return matchCase(oldPrefix, compact.slice(0, oldPrefix.length));
  }
  function matchCase(sample, text2) {
    if (sample === sample.toUpperCase()) return text2.toUpperCase();
    if (sample === sample.toLowerCase()) return text2.toLowerCase();
    return text2.charAt(0).toUpperCase() + text2.slice(1).toLowerCase();
  }

  // src/tokens/remap/spectrum.ts
  var NEUTRAL_SATURATION = 0.5;
  var HUE_GAP = 12;
  var CROWDED_SPREAD = 25;
  var NAMED_HUE_SPREAD = 45;
  var HUE_SECTORS = [
    { from: 0, label: "Pink" },
    { from: 5, label: "Rose" },
    { from: 21, label: "Red" },
    { from: 37, label: "Orange" },
    { from: 59, label: "Amber" },
    { from: 78, label: "Yellow" },
    { from: 109, label: "Lime" },
    { from: 141, label: "Green" },
    { from: 156, label: "Emerald" },
    { from: 173, label: "Teal" },
    { from: 199, label: "Cyan" },
    { from: 226, label: "Sky" },
    { from: 249, label: "Blue" },
    { from: 269, label: "Indigo" },
    { from: 285, label: "Violet" },
    { from: 299, label: "Purple" },
    { from: 313, label: "Fuchsia" },
    { from: 338, label: "Pink" }
  ];
  function hueName2(hue) {
    const h = (hue % 360 + 360) % 360;
    let label3 = HUE_SECTORS[HUE_SECTORS.length - 1].label;
    for (const sector of HUE_SECTORS) if (h >= sector.from) label3 = sector.label;
    return label3;
  }
  var toStop = (member) => {
    const { l, c, h } = rgbToOklch(member.rgba);
    const ceiling = maxChroma(l, h);
    return __spreadProps(__spreadValues({}, member), { l, c, h, saturation: ceiling > 1e-6 ? Math.min(1, c / ceiling) : 0 });
  };
  function hueDistance2(a, b) {
    const diff = Math.abs((a - b) % 360 + 360) % 360;
    return diff > 180 ? 360 - diff : diff;
  }
  var isNeutral = (stop) => stop.saturation < NEUTRAL_SATURATION;
  function meanHue(stops) {
    let x = 0;
    let y = 0;
    for (const stop of stops) {
      const radians = stop.h * Math.PI / 180;
      x += Math.cos(radians) * stop.c;
      y += Math.sin(radians) * stop.c;
    }
    if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return 0;
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function hueRange(stops) {
    const colored = stops.filter((stop) => !isNeutral(stop));
    let widest = 0;
    for (let i = 0; i < colored.length; i++) {
      for (let j = i + 1; j < colored.length; j++) {
        widest = Math.max(widest, hueDistance2(colored[i].h, colored[j].h));
      }
    }
    return widest;
  }
  var byLightness = (a, b) => b.l - a.l;
  function looksLikeRamp(stops) {
    if (stops.length < 2) return false;
    const withStep = stops.filter((stop) => stop.step !== null).length;
    if (withStep >= 2) return true;
    if (stops.every(isNeutral)) return true;
    return hueRange(stops) <= NAMED_HUE_SPREAD;
  }
  function clusterByHue(stops) {
    if (stops.length === 0) return [];
    const sorted = [...stops].sort((a, b) => a.h - b.h);
    if (sorted.length === 1) return [sorted];
    let widestAt = 0;
    let widest = 360 - sorted[sorted.length - 1].h + sorted[0].h;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].h - sorted[i - 1].h;
      if (gap > widest) {
        widest = gap;
        widestAt = i;
      }
    }
    const rotated = [...sorted.slice(widestAt), ...sorted.slice(0, widestAt)];
    const clusters = [[rotated[0]]];
    for (let i = 1; i < rotated.length; i++) {
      const gap = hueDistance2(rotated[i].h, rotated[i - 1].h);
      if (gap > HUE_GAP) clusters.push([rotated[i]]);
      else clusters[clusters.length - 1].push(rotated[i]);
    }
    return clusters;
  }
  function makeSpectrum(stops, source, label3, usedKeys) {
    const sorted = [...stops].sort(byLightness);
    const neutral = sorted.every(isNeutral);
    const range2 = hueRange(sorted);
    let key = familyKey(label3);
    let suffix = 2;
    while (usedKeys.has(key)) key = `${familyKey(label3)}-${suffix++}`;
    usedKeys.add(key);
    return {
      key,
      label: label3,
      source,
      neutral,
      hue: neutral ? 0 : meanHue(sorted),
      hueRange: range2,
      crowded: source === "clustered" && !neutral && range2 > CROWDED_SPREAD,
      stops: sorted
    };
  }
  function inferSpectra(members) {
    var _a;
    const stops = members.map(toStop);
    const usedKeys = /* @__PURE__ */ new Set();
    const spectra = [];
    const unnamed = [];
    const named = /* @__PURE__ */ new Map();
    for (const stop of stops) {
      if (stop.family === null || stop.family.trim() === "") {
        unnamed.push(stop);
        continue;
      }
      const key = familyKey(stop.family);
      const entry = (_a = named.get(key)) != null ? _a : { label: stop.family, stops: [] };
      entry.stops.push(stop);
      named.set(key, entry);
    }
    for (const { label: label3, stops: group } of named.values()) {
      if (looksLikeRamp(group)) spectra.push(makeSpectrum(group, "named", label3, usedKeys));
      else unnamed.push(...group);
    }
    const grays = unnamed.filter(isNeutral);
    const colored = unnamed.filter((stop) => !isNeutral(stop));
    const loose = [];
    if (grays.length >= 2) spectra.push(makeSpectrum(grays, "clustered", "Neutral", usedKeys));
    else loose.push(...grays);
    for (const cluster of clusterByHue(colored)) {
      if (cluster.length < 2) {
        loose.push(...cluster);
        continue;
      }
      spectra.push(makeSpectrum(cluster, "clustered", hueName2(meanHue(cluster)), usedKeys));
    }
    spectra.sort((a, b) => Number(a.neutral) - Number(b.neutral) || a.hue - b.hue);
    const warnings = spectra.filter((spectrum) => spectrum.crowded).map(
      (spectrum) => `"${spectrum.label}" was grouped from color alone and spans ${Math.round(spectrum.hueRange)}\xB0 \u2014 it may be two families; split it in the table if so`
    );
    return { spectra, loose: loose.sort(byLightness), warnings };
  }

  // src/tokens/remap/match.ts
  function deltaE(a, b) {
    const first = rgbToOklch(a);
    const second = rgbToOklch(b);
    const ax = first.c * Math.cos(first.h * Math.PI / 180);
    const ay = first.c * Math.sin(first.h * Math.PI / 180);
    const bx = second.c * Math.cos(second.h * Math.PI / 180);
    const by = second.c * Math.sin(second.h * Math.PI / 180);
    const dl = first.l - second.l;
    return 100 * Math.sqrt(dl * dl + (ax - bx) ** 2 + (ay - by) ** 2);
  }
  function nearestByColor(candidates, color) {
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
      const distance = deltaE(candidate.rgba, color);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return best;
  }
  var WEIGHT_STOP_COUNT = 0.15;
  var NEUTRAL_MISMATCH = 2;
  var EXACT_NAME_BONUS = 0.5;
  var PARTIAL_NAME_BONUS = 0.2;
  function familyCost(from, to) {
    let cost;
    if (from.neutral && to.neutral) cost = 0;
    else if (from.neutral !== to.neutral) cost = NEUTRAL_MISMATCH;
    else cost = hueDistance2(from.hue, to.hue) / 180;
    const fromCount = from.stops.length;
    const toCount = to.stops.length;
    cost += Math.abs(fromCount - toCount) / Math.max(fromCount, toCount) * WEIGHT_STOP_COUNT;
    const fromKey = familyKey(from.label);
    const toKey = familyKey(to.label);
    if (fromKey === toKey) cost -= EXACT_NAME_BONUS;
    else if (fromKey.includes(toKey) || toKey.includes(fromKey)) cost -= PARTIAL_NAME_BONUS;
    return cost;
  }
  function hungarian(cost) {
    const rows = cost.length;
    if (rows === 0) return [];
    const cols = cost[0].length;
    if (cols < rows) throw new Error("hungarian: rows must not exceed cols");
    const u = new Array(rows + 1).fill(0);
    const v = new Array(cols + 1).fill(0);
    const match = new Array(cols + 1).fill(0);
    const way = new Array(cols + 1).fill(0);
    for (let row = 1; row <= rows; row++) {
      match[0] = row;
      let col = 0;
      const minimum = new Array(cols + 1).fill(Infinity);
      const used = new Array(cols + 1).fill(false);
      do {
        used[col] = true;
        const currentRow = match[col];
        let delta = Infinity;
        let nextCol = 0;
        for (let j = 1; j <= cols; j++) {
          if (used[j]) continue;
          const value = cost[currentRow - 1][j - 1] - u[currentRow] - v[j];
          if (value < minimum[j]) {
            minimum[j] = value;
            way[j] = col;
          }
          if (minimum[j] < delta) {
            delta = minimum[j];
            nextCol = j;
          }
        }
        for (let j = 0; j <= cols; j++) {
          if (used[j]) {
            u[match[j]] += delta;
            v[j] -= delta;
          } else {
            minimum[j] -= delta;
          }
        }
        col = nextCol;
      } while (match[col] !== 0);
      do {
        const previous = way[col];
        match[col] = match[previous];
        col = previous;
      } while (col !== 0);
    }
    const assignment = new Array(rows).fill(-1);
    for (let j = 1; j <= cols; j++) if (match[j] > 0) assignment[match[j] - 1] = j - 1;
    return assignment;
  }
  function assignFamilies(from, to) {
    var _a, _b;
    if (from.length === 0 || to.length === 0) return { assignments: [], unused: [...to] };
    const matrix = from.map((source) => to.map((target) => familyCost(source, target)));
    const assignments = [];
    const placed = /* @__PURE__ */ new Set();
    if (from.length <= to.length) {
      const chosen = hungarian(matrix);
      for (const [index, column] of chosen.entries()) {
        if (column < 0) continue;
        placed.add(index);
        assignments.push({ from: from[index], to: to[column], cost: matrix[index][column], shared: false, overflow: false });
      }
    } else {
      const transposed = to.map((_, column) => from.map((_source, row) => matrix[row][column]));
      const chosen = hungarian(transposed);
      for (const [column, row] of chosen.entries()) {
        if (row < 0) continue;
        placed.add(row);
        assignments.push({ from: from[row], to: to[column], cost: matrix[row][column], shared: false, overflow: false });
      }
    }
    for (const [index, source] of from.entries()) {
      if (placed.has(index)) continue;
      let bestColumn = 0;
      for (let column = 1; column < to.length; column++) {
        if (matrix[index][column] < matrix[index][bestColumn]) bestColumn = column;
      }
      assignments.push({
        from: source,
        to: to[bestColumn],
        cost: matrix[index][bestColumn],
        shared: true,
        overflow: true
      });
    }
    const perTarget = /* @__PURE__ */ new Map();
    for (const assignment of assignments) {
      perTarget.set(assignment.to.key, ((_a = perTarget.get(assignment.to.key)) != null ? _a : 0) + 1);
    }
    for (const assignment of assignments) {
      if (((_b = perTarget.get(assignment.to.key)) != null ? _b : 0) > 1) assignment.shared = true;
    }
    const used = new Set(assignments.map((assignment) => assignment.to.key));
    const order = new Map(from.map((spectrum, index) => [spectrum.key, index]));
    assignments.sort((a, b) => {
      var _a2, _b2;
      return ((_a2 = order.get(a.from.key)) != null ? _a2 : 0) - ((_b2 = order.get(b.from.key)) != null ? _b2 : 0);
    });
    return { assignments, unused: to.filter((spectrum) => !used.has(spectrum.key)) };
  }
  function nearestByLightness(stops, l) {
    let best = null;
    let bestDistance = Infinity;
    for (const stop of stops) {
      const distance = Math.abs(stop.l - l);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = stop;
      }
    }
    return best;
  }
  var LADDER_BREAK = 0.15;
  function ladderOutliers(spectrum) {
    const ladder = spectrum.stops.filter((stop) => stop.step !== null).sort((a, b) => a.step - b.step);
    const outliers = /* @__PURE__ */ new Set();
    if (ladder.length < 4) return outliers;
    let up = 0;
    let down = 0;
    for (let i = 1; i < ladder.length; i++) {
      const delta = ladder[i].l - ladder[i - 1].l;
      if (delta > 0.01) up++;
      else if (delta < -0.01) down++;
    }
    const direction = down > up ? -1 : up > down ? 1 : 0;
    if (direction === 0) return outliers;
    const follows = (earlier, later) => direction < 0 ? earlier >= later - LADDER_BREAK : earlier <= later + LADDER_BREAK;
    for (let i = 0; i < ladder.length; i++) {
      const previous = ladder[i - 1];
      const next = ladder[i + 1];
      const breaksBefore = previous !== void 0 && !follows(previous.l, ladder[i].l);
      const breaksAfter = next !== void 0 && !follows(ladder[i].l, next.l);
      const isEnd = previous === void 0 || next === void 0;
      if (isEnd ? breaksBefore || breaksAfter : breaksBefore && breaksAfter) outliers.add(ladder[i].step);
    }
    return outliers;
  }
  function matchStops(from, to) {
    const untrusted = ladderOutliers(to);
    const byStep = /* @__PURE__ */ new Map();
    for (const stop of to.stops) {
      if (stop.step === null || untrusted.has(stop.step) || byStep.has(stop.step)) continue;
      byStep.set(stop.step, stop);
    }
    const matches = [];
    for (const stop of from.stops) {
      const exact = stop.step === null ? void 0 : byStep.get(stop.step);
      const target = exact != null ? exact : nearestByLightness(to.stops, stop.l);
      if (!target) continue;
      matches.push({
        from: stop,
        to: target,
        via: exact ? "step" : "lightness",
        lightnessShift: Math.abs(target.l - stop.l)
      });
    }
    return matches;
  }

  // src/targets/ds-tools/remap-apply.ts
  var DEFAULT_REMAP_APPLY_OPTIONS = {
    values: true,
    rename: true,
    styles: true,
    canvas: true,
    bind: true,
    scope: "document"
  };
  var SNAPSHOT_KEY = "altery-remap-snapshot";
  var SNAPSHOT_COUNT_KEY = "altery-remap-snapshot-chunks";
  var RENAME_KEY = "altery-remap-renames";
  var CHUNK_BYTES = 8e4;
  var MAX_CHUNKS = 12;
  function writeChunked(text2) {
    const chunks = [];
    for (let i = 0; i < text2.length; i += CHUNK_BYTES) chunks.push(text2.slice(i, i + CHUNK_BYTES));
    if (chunks.length > MAX_CHUNKS) {
      throw new Error(`the undo snapshot needs ${chunks.length} slots, more than the ${MAX_CHUNKS} available`);
    }
    const previous = Number(figma.root.getPluginData(SNAPSHOT_COUNT_KEY) || "0");
    for (const [index, chunk] of chunks.entries()) figma.root.setPluginData(`${SNAPSHOT_KEY}-${index}`, chunk);
    for (let index = chunks.length; index < previous; index++) figma.root.setPluginData(`${SNAPSHOT_KEY}-${index}`, "");
    figma.root.setPluginData(SNAPSHOT_COUNT_KEY, String(chunks.length));
    return text2.length;
  }
  function readChunked() {
    const count = Number(figma.root.getPluginData(SNAPSHOT_COUNT_KEY) || "0");
    let text2 = "";
    for (let index = 0; index < count; index++) text2 += figma.root.getPluginData(`${SNAPSHOT_KEY}-${index}`);
    return text2;
  }
  function clearSnapshot() {
    const count = Number(figma.root.getPluginData(SNAPSHOT_COUNT_KEY) || "0");
    for (let index = 0; index < count; index++) figma.root.setPluginData(`${SNAPSHOT_KEY}-${index}`, "");
    figma.root.setPluginData(SNAPSHOT_COUNT_KEY, "0");
  }
  function hasRemapSnapshot() {
    return Number(figma.root.getPluginData(SNAPSHOT_COUNT_KEY) || "0") > 0;
  }
  function readRenameMap() {
    const raw = figma.root.getPluginData(RENAME_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch (e) {
      return {};
    }
  }
  function foldRenames(existing, applied) {
    const next = __spreadValues({}, existing);
    for (const { from, to } of applied) {
      for (const [key, value] of Object.entries(next)) if (value === from) next[key] = to;
      if (from !== to) next[from] = to;
    }
    for (const [key, value] of Object.entries(next)) if (key === value) delete next[key];
    return next;
  }
  function writeRenameMap(map) {
    figma.root.setPluginData(RENAME_KEY, Object.keys(map).length === 0 ? "" : JSON.stringify(map));
  }
  function splitSiteId(id) {
    const separator = id.lastIndexOf("|");
    if (separator <= 0) return null;
    return { variableId: id.slice(0, separator), modeId: id.slice(separator + 1) };
  }
  function parseStyleSiteId(id) {
    if (id.slice(0, 6) !== "style:") return null;
    const hash = id.indexOf("#");
    if (hash < 0) return null;
    const styleId = id.slice(6, hash);
    const [property, rest] = id.slice(hash + 1).split(":");
    if (property !== "paints" && property !== "effects") return null;
    const [indexText, stopText] = rest.split(".");
    const index = Number(indexText);
    if (!Number.isFinite(index)) return null;
    const stop = stopText === void 0 ? null : Number(stopText);
    return { styleId, property, index, stop: stop === null || !Number.isFinite(stop) ? null : stop };
  }
  var round42 = (value) => Math.round(value * 1e4) / 1e4;
  var channelsOf = (color) => {
    var _a;
    return [
      round42(color.r),
      round42(color.g),
      round42(color.b),
      round42((_a = color.a) != null ? _a : 1)
    ];
  };
  var colorOf = (channels) => ({ r: channels[0], g: channels[1], b: channels[2], a: channels[3] });
  var writableVariable = (entry) => entry.site.kind === "variable" && entry.site.editable && !entry.flags.includes("library") && !entry.flags.includes("unchanged");
  var writableStyle = (entry) => (entry.site.kind === "style" || entry.site.kind === "gradient-stop" || entry.site.kind === "effect") && entry.site.editable && !entry.flags.includes("unchanged");
  var writableLoose = (entry) => entry.site.kind === "detached" && !entry.flags.includes("unchanged");
  function makeLoader() {
    const cache = /* @__PURE__ */ new Map();
    return {
      async variable(id) {
        var _a;
        if (cache.has(id)) return (_a = cache.get(id)) != null ? _a : null;
        const variable = await figma.variables.getVariableByIdAsync(id).catch(() => null);
        cache.set(id, variable);
        return variable;
      }
    };
  }
  var SNAP_DELTA_E2 = 2;
  function bindingCandidates(plan) {
    const byColor = /* @__PURE__ */ new Map();
    const entries = plan.entries.filter(writableVariable);
    for (const entry of entries) {
      const address = splitSiteId(entry.site.id);
      if (!address) continue;
      const key = looseSiteId(hexOf(entry.from), entry.from.a);
      if (!byColor.has(key)) byColor.set(key, address.variableId);
    }
    return byColor;
  }
  function nearestVariableFor(entry, plan) {
    let bestId = null;
    let bestDistance = SNAP_DELTA_E2;
    for (const candidate of plan.entries) {
      if (!writableVariable(candidate)) continue;
      if (Math.abs(candidate.from.a - entry.from.a) > 0.01) continue;
      const distance = deltaE(candidate.from, entry.from);
      if (distance < bestDistance) {
        bestDistance = distance;
        const address = splitSiteId(candidate.site.id);
        if (address) bestId = address.variableId;
      }
    }
    return bestId;
  }
  async function applyStyles(plan, snapshot, report) {
    var _a;
    const byStyle = /* @__PURE__ */ new Map();
    for (const entry of plan.entries) {
      if (!writableStyle(entry)) continue;
      const address = parseStyleSiteId(entry.site.id);
      if (!address) continue;
      const group = byStyle.get(address.styleId);
      if (group) group.push({ entry, address });
      else byStyle.set(address.styleId, [{ entry, address }]);
    }
    for (const [styleId, group] of byStyle) {
      const style = await figma.getStyleByIdAsync(styleId).catch(() => null);
      if (!style) {
        report.failed += group.length;
        continue;
      }
      const before = report.paints;
      try {
        if (style.type === "PAINT") {
          const paints = style.paints.map((paint) => __spreadValues({}, paint));
          for (const { entry, address } of group) {
            const paint = paints[address.index];
            if (!paint) continue;
            if (address.stop === null && paint.type === "SOLID") {
              snapshot.styles.push({ s: styleId, p: "paints", i: address.index, j: -1, c: channelsOf(__spreadProps(__spreadValues({}, paint.color), { a: (_a = paint.opacity) != null ? _a : 1 })) });
              paints[address.index] = __spreadProps(__spreadValues({}, paint), { color: { r: entry.to.r, g: entry.to.g, b: entry.to.b }, opacity: entry.to.a });
              report.paints++;
            } else if (address.stop !== null && isGradient(paint)) {
              const stops = paint.gradientStops.map((stop2) => __spreadValues({}, stop2));
              const stop = stops[address.stop];
              if (!stop) continue;
              snapshot.styles.push({ s: styleId, p: "paints", i: address.index, j: address.stop, c: channelsOf(withAlpha(stop.color)) });
              stops[address.stop] = __spreadProps(__spreadValues({}, stop), { color: { r: entry.to.r, g: entry.to.g, b: entry.to.b, a: entry.to.a } });
              paints[address.index] = __spreadProps(__spreadValues({}, paint), { gradientStops: stops });
              report.paints++;
            }
          }
          ;
          style.paints = paints;
        } else if (style.type === "EFFECT") {
          const effects = style.effects.map((effect) => __spreadValues({}, effect));
          for (const { entry, address } of group) {
            const effect = effects[address.index];
            if (!effect || !isShadow(effect)) continue;
            snapshot.styles.push({ s: styleId, p: "effects", i: address.index, j: -1, c: channelsOf(withAlpha(effect.color)) });
            effects[address.index] = __spreadProps(__spreadValues({}, effect), { color: { r: entry.to.r, g: entry.to.g, b: entry.to.b, a: entry.to.a } });
            report.paints++;
          }
          ;
          style.effects = effects;
        } else {
          continue;
        }
        if (report.paints > before) report.styles++;
      } catch (error) {
        report.failed += group.length;
        report.warnings.push(`${style.name}: ${String(error.message)}`);
      }
    }
  }
  async function scopeRoots(scope) {
    if (scope === "selection") return figma.currentPage.selection;
    if (scope === "page") return figma.currentPage.children;
    const roots = [];
    for (const page of figma.root.children) roots.push(...page.children);
    return roots;
  }
  var COLOR_FIELDS = ["fills", "strokes", "effects"];
  function colorOverrideCount(instance) {
    try {
      return instance.overrides.filter(
        (override) => override.overriddenFields.some((field) => COLOR_FIELDS.indexOf(field) !== -1)
      ).length;
    } catch (e) {
      return 0;
    }
  }
  function rewritePaints(node, property, context) {
    var _a, _b;
    if (styleIdOf2(node, property) !== "") return false;
    const paints = paintsOf(node, property);
    if (paints.length === 0) return false;
    const nodeLevel = nodeLevelBindings(node, property);
    const next = paints.map((paint) => __spreadValues({}, paint));
    const code = property === "fills" ? 0 : 1;
    let touched = false;
    for (const [index, paint] of paints.entries()) {
      if (paint.visible === false) continue;
      const paintBound2 = (_a = paint.boundVariables) == null ? void 0 : _a.color;
      if (paintBound2 || nodeLevel[index]) continue;
      if (paint.type === "SOLID") {
        const alpha = (_b = paint.opacity) != null ? _b : 1;
        const entry = context.targets.get(looseSiteId(hexOf(paint.color), alpha));
        if (!entry) continue;
        const variable = context.bindTo.get(entry.site.id);
        let replacement = __spreadProps(__spreadValues({}, paint), { color: { r: entry.to.r, g: entry.to.g, b: entry.to.b }, opacity: entry.to.a });
        if (variable) {
          replacement = figma.variables.setBoundVariableForPaint(replacement, "color", variable);
          context.report.bound++;
        }
        next[index] = replacement;
        context.snapshot.paints.push([node.id, code, index, -1, ...channelsOf(__spreadProps(__spreadValues({}, paint.color), { a: alpha })), variable ? 1 : 0]);
        context.report.paints++;
        touched = true;
        continue;
      }
      if (!isGradient(paint)) continue;
      const stops = paint.gradientStops.map((stop) => __spreadValues({}, stop));
      let stopTouched = false;
      for (const [stopIndex, stop] of paint.gradientStops.entries()) {
        const color = withAlpha(stop.color);
        const entry = context.targets.get(looseSiteId(hexOf(color), color.a));
        if (!entry) continue;
        stops[stopIndex] = __spreadProps(__spreadValues({}, stop), { color: { r: entry.to.r, g: entry.to.g, b: entry.to.b, a: entry.to.a } });
        context.snapshot.paints.push([node.id, code, index, stopIndex, ...channelsOf(color), 0]);
        context.report.paints++;
        stopTouched = true;
      }
      if (stopTouched) {
        next[index] = __spreadProps(__spreadValues({}, paint), { gradientStops: stops });
        touched = true;
      }
    }
    if (!touched) return false;
    node[property] = next;
    return true;
  }
  function rewriteEffects(node, context) {
    var _a;
    if (styleIdOf2(node, "effects") !== "") return false;
    if (!("effects" in node) || !Array.isArray(node.effects) || node.effects.length === 0) return false;
    const next = node.effects.map((effect) => __spreadValues({}, effect));
    let touched = false;
    for (const [index, effect] of node.effects.entries()) {
      if (!isShadow(effect) || effect.visible === false) continue;
      if ((_a = effect.boundVariables) == null ? void 0 : _a.color) continue;
      const color = withAlpha(effect.color);
      const entry = context.targets.get(looseSiteId(hexOf(color), color.a));
      if (!entry) continue;
      next[index] = __spreadProps(__spreadValues({}, effect), { color: { r: entry.to.r, g: entry.to.g, b: entry.to.b, a: entry.to.a } });
      context.snapshot.paints.push([node.id, 2, index, -1, ...channelsOf(color), 0]);
      context.report.paints++;
      touched = true;
    }
    if (!touched) return false;
    node.effects = next;
    return true;
  }
  async function applyCanvas(plan, options, snapshot, report, loader, progress2) {
    var _a;
    const targets = /* @__PURE__ */ new Map();
    for (const entry of plan.entries) if (writableLoose(entry)) targets.set(entry.site.id, entry);
    if (targets.size === 0) return;
    const bindTo = /* @__PURE__ */ new Map();
    if (options.bind && options.values) {
      const exact = bindingCandidates(plan);
      for (const entry of targets.values()) {
        const variableId = (_a = exact.get(entry.site.id)) != null ? _a : nearestVariableFor(entry, plan);
        if (!variableId) continue;
        const variable = await loader.variable(variableId);
        if (variable) bindTo.set(entry.site.id, variable);
      }
    }
    const context = { targets, bindTo, snapshot, report, loader };
    const roots = await scopeRoots(options.scope);
    figma.skipInvisibleInstanceChildren = true;
    try {
      const stack = [...roots];
      let visited = 0;
      while (stack.length > 0) {
        const node = stack.pop();
        visited++;
        if (node.type === "INSTANCE") {
          report.instanceOverrides += colorOverrideCount(node);
          continue;
        }
        rewritePaints(node, "fills", context);
        rewritePaints(node, "strokes", context);
        rewriteEffects(node, context);
        if ("children" in node) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
        if (visited % 200 === 0) {
          progress2 == null ? void 0 : progress2(`repainting\u2026 ${report.paints} places`);
          await yieldToHost();
        }
      }
    } finally {
      figma.skipInvisibleInstanceChildren = false;
    }
    if (report.instanceOverrides > 0) {
      report.warnings.push(
        `${report.instanceOverrides} hand-made color override${report.instanceOverrides === 1 ? "" : "s"} on instances kept the old color \u2014 an override belongs to that one instance, not to the system, so it is left for a human`
      );
    }
  }
  var BYTES = { value: 90, name: 70, style: 70, paint: 60 };
  function estimateSnapshotBytes(plan, options) {
    const values = options.values ? plan.entries.filter(writableVariable).length : 0;
    const names = options.rename ? plan.renames.length : 0;
    const styles = options.styles ? plan.entries.filter(writableStyle).length : 0;
    const paints = options.canvas ? plan.entries.filter(writableLoose).reduce((total, entry) => total + Math.max(1, entry.site.usage), 0) : 0;
    return values * BYTES.value + names * BYTES.name + styles * BYTES.style + paints * BYTES.paint;
  }
  var SNAPSHOT_BUDGET_BYTES = CHUNK_BYTES * MAX_CHUNKS;
  async function applyRemap(plan, options = DEFAULT_REMAP_APPLY_OPTIONS, progress2) {
    const warnings = [];
    const report = {
      values: 0,
      renamed: 0,
      legacy: 0,
      styles: 0,
      paints: 0,
      bound: 0,
      instanceOverrides: 0,
      skippedLibrary: plan.entries.filter((entry) => entry.flags.includes("library")).length,
      unchanged: plan.entries.filter((entry) => entry.flags.includes("unchanged")).length,
      failed: 0,
      snapshotBytes: 0,
      warnings
    };
    const valueTargets = options.values ? plan.entries.filter(writableVariable) : [];
    const renames = options.rename ? plan.renames : [];
    const hasStyles = options.styles && plan.entries.some(writableStyle);
    const hasCanvas = options.canvas && plan.entries.some(writableLoose);
    if (valueTargets.length === 0 && renames.length === 0 && !hasStyles && !hasCanvas) {
      warnings.push("nothing to write");
      return report;
    }
    const estimate = estimateSnapshotBytes(plan, options);
    if (estimate > SNAPSHOT_BUDGET_BYTES) {
      throw new Error(
        `This remap would need about ${Math.round(estimate / 1024)} kB of undo data, more than the ${Math.round(SNAPSHOT_BUDGET_BYTES / 1024)} kB a Figma file can hold for a plugin. Nothing was written \u2014 narrow the scope, or turn off repainting loose layers and run that pass on its own.`
      );
    }
    progress2 == null ? void 0 : progress2("loading variables\u2026");
    const loader = makeLoader();
    const snapshot = { version: 2, values: [], names: [], styles: [], paints: [] };
    for (const entry of valueTargets) {
      const address = splitSiteId(entry.site.id);
      if (!address) continue;
      const variable = await loader.variable(address.variableId);
      if (!variable) continue;
      const current = variable.valuesByMode[address.modeId];
      if (current === void 0 || typeof current !== "object" || !("r" in current)) continue;
      snapshot.values.push({ v: address.variableId, m: address.modeId, c: channelsOf(current) });
    }
    for (const rename of renames) {
      const address = splitSiteId(rename.siteId);
      if (!address) continue;
      const variable = await loader.variable(address.variableId);
      if (variable) snapshot.names.push({ v: address.variableId, n: variable.name });
    }
    if (hasStyles) {
      progress2 == null ? void 0 : progress2("writing styles\u2026");
      await applyStyles(plan, snapshot, report);
    }
    if (hasCanvas) {
      progress2 == null ? void 0 : progress2("repainting layers\u2026");
      await applyCanvas(plan, options, snapshot, report, loader, progress2);
    }
    progress2 == null ? void 0 : progress2("storing the snapshot\u2026");
    try {
      report.snapshotBytes = writeChunked(JSON.stringify(snapshot));
    } catch (error) {
      clearSnapshot();
      warnings.push(
        `${String(error.message)}. ${report.paints} painted places changed before this was known and cannot be reverted from here \u2014 use Figma version history if you need them back.`
      );
    }
    let written = 0;
    for (const entry of valueTargets) {
      const address = splitSiteId(entry.site.id);
      const variable = address ? await loader.variable(address.variableId) : null;
      if (!address || !variable) {
        report.failed++;
        continue;
      }
      try {
        variable.setValueForMode(address.modeId, { r: entry.to.r, g: entry.to.g, b: entry.to.b, a: entry.to.a });
        report.values++;
      } catch (error) {
        report.failed++;
        warnings.push(`${entry.site.name}: ${String(error.message)}`);
      }
      if (++written % 100 === 0) {
        progress2 == null ? void 0 : progress2(`writing values\u2026 ${written}/${valueTargets.length}`);
        await yieldToHost();
      }
    }
    if (renames.length > 0) {
      progress2 == null ? void 0 : progress2("renaming\u2026");
      const applied = [];
      const staged = [];
      for (const [index, rename] of renames.entries()) {
        const address = splitSiteId(rename.siteId);
        const variable = address ? await loader.variable(address.variableId) : null;
        if (!variable) {
          report.failed++;
          continue;
        }
        const from = variable.name;
        try {
          variable.name = `__altery-remap-${index}`;
          staged.push({ variable, to: rename.to, from, legacy: rename.legacy });
        } catch (error) {
          report.failed++;
          warnings.push(`${from}: ${String(error.message)}`);
        }
      }
      for (const item of staged) {
        try {
          item.variable.name = item.to;
          applied.push({ from: item.from, to: item.to });
          report.renamed++;
          if (item.legacy) report.legacy++;
        } catch (error) {
          item.variable.name = item.from;
          report.failed++;
          warnings.push(`${item.from} \u2192 ${item.to}: ${String(error.message)}`);
        }
      }
      writeRenameMap(foldRenames(readRenameMap(), applied));
    }
    return report;
  }
  async function revertStyles(snapshot, warnings) {
    const byStyle = /* @__PURE__ */ new Map();
    for (const entry of snapshot.styles) {
      const group = byStyle.get(entry.s);
      if (group) group.push(entry);
      else byStyle.set(entry.s, [entry]);
    }
    let restored = 0;
    for (const [styleId, group] of byStyle) {
      const style = await figma.getStyleByIdAsync(styleId).catch(() => null);
      if (!style) continue;
      try {
        if (style.type === "PAINT") {
          const paints = style.paints.map((paint) => __spreadValues({}, paint));
          for (const entry of group) {
            const paint = paints[entry.i];
            if (!paint) continue;
            const color = colorOf(entry.c);
            if (entry.j < 0 && paint.type === "SOLID") {
              paints[entry.i] = __spreadProps(__spreadValues({}, paint), { color: { r: color.r, g: color.g, b: color.b }, opacity: color.a });
            } else if (entry.j >= 0 && isGradient(paint)) {
              const stops = paint.gradientStops.map((stop) => __spreadValues({}, stop));
              if (!stops[entry.j]) continue;
              stops[entry.j] = __spreadProps(__spreadValues({}, stops[entry.j]), { color });
              paints[entry.i] = __spreadProps(__spreadValues({}, paint), { gradientStops: stops });
            }
            restored++;
          }
          ;
          style.paints = paints;
        } else if (style.type === "EFFECT") {
          const effects = style.effects.map((effect) => __spreadValues({}, effect));
          for (const entry of group) {
            const effect = effects[entry.i];
            if (!effect || !isShadow(effect)) continue;
            effects[entry.i] = __spreadProps(__spreadValues({}, effect), { color: colorOf(entry.c) });
            restored++;
          }
          ;
          style.effects = effects;
        }
      } catch (error) {
        warnings.push(`${style.name}: ${String(error.message)}`);
      }
    }
    return restored;
  }
  async function revertPaints(snapshot, warnings, progress2) {
    const byNode = /* @__PURE__ */ new Map();
    for (const entry of snapshot.paints) {
      const group = byNode.get(entry[0]);
      if (group) group.push(entry);
      else byNode.set(entry[0], [entry]);
    }
    let restored = 0;
    let handled = 0;
    for (const [nodeId, group] of byNode) {
      const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
      if (!node || node.type === "DOCUMENT" || node.type === "PAGE") continue;
      const scene = node;
      try {
        for (const property of ["fills", "strokes"]) {
          const code = property === "fills" ? 0 : 1;
          const mine = group.filter((entry) => entry[1] === code);
          if (mine.length === 0) continue;
          const paints = paintsOf(scene, property).map((paint) => __spreadValues({}, paint));
          for (const entry of mine) {
            const paint = paints[entry[2]];
            if (!paint) continue;
            const color = colorOf([entry[4], entry[5], entry[6], entry[7]]);
            if (entry[3] < 0 && paint.type === "SOLID") {
              let restoredPaint = __spreadProps(__spreadValues({}, paint), { color: { r: color.r, g: color.g, b: color.b }, opacity: color.a });
              if (entry[8] === 1) restoredPaint = figma.variables.setBoundVariableForPaint(restoredPaint, "color", null);
              paints[entry[2]] = restoredPaint;
            } else if (entry[3] >= 0 && isGradient(paint)) {
              const stops = paint.gradientStops.map((stop) => __spreadValues({}, stop));
              if (!stops[entry[3]]) continue;
              stops[entry[3]] = __spreadProps(__spreadValues({}, stops[entry[3]]), { color });
              paints[entry[2]] = __spreadProps(__spreadValues({}, paint), { gradientStops: stops });
            }
            restored++;
          }
          ;
          scene[property] = paints;
        }
        const shadows = group.filter((entry) => entry[1] === 2);
        if (shadows.length > 0 && "effects" in scene && Array.isArray(scene.effects)) {
          const effects = scene.effects.map((effect) => __spreadValues({}, effect));
          for (const entry of shadows) {
            const effect = effects[entry[2]];
            if (!effect || !isShadow(effect)) continue;
            effects[entry[2]] = __spreadProps(__spreadValues({}, effect), { color: colorOf([entry[4], entry[5], entry[6], entry[7]]) });
            restored++;
          }
          ;
          scene.effects = effects;
        }
      } catch (error) {
        warnings.push(`${scene.name}: ${String(error.message)}`);
      }
      if (++handled % 100 === 0) {
        progress2 == null ? void 0 : progress2(`restoring layers\u2026 ${handled}/${byNode.size}`);
        await yieldToHost();
      }
    }
    return restored;
  }
  async function revertRemap(progress2) {
    var _a, _b, _c;
    const warnings = [];
    const empty = { values: 0, names: 0, styles: 0, paints: 0 };
    const raw = readChunked();
    if (raw === "") return __spreadProps(__spreadValues({}, empty), { warnings: ["there is nothing to revert"] });
    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch (e) {
      clearSnapshot();
      return __spreadProps(__spreadValues({}, empty), { warnings: ["the stored snapshot is unreadable and has been discarded"] });
    }
    const loader = makeLoader();
    let names = 0;
    const staged = [];
    for (const [index, entry] of ((_a = snapshot.names) != null ? _a : []).entries()) {
      const variable = await loader.variable(entry.v);
      if (!variable) continue;
      try {
        variable.name = `__altery-revert-${index}`;
        staged.push({ variable, to: entry.n });
      } catch (error) {
        warnings.push(`${entry.n}: ${String(error.message)}`);
      }
    }
    for (const item of staged) {
      try {
        item.variable.name = item.to;
        names++;
      } catch (error) {
        warnings.push(`${item.to}: ${String(error.message)}`);
      }
    }
    let values = 0;
    for (const [index, entry] of ((_b = snapshot.values) != null ? _b : []).entries()) {
      const variable = await loader.variable(entry.v);
      if (!variable) continue;
      try {
        variable.setValueForMode(entry.m, colorOf(entry.c));
        values++;
      } catch (error) {
        warnings.push(`${variable.name}: ${String(error.message)}`);
      }
      if ((index + 1) % 100 === 0) {
        progress2 == null ? void 0 : progress2(`restoring values\u2026 ${index + 1}/${snapshot.values.length}`);
        await yieldToHost();
      }
    }
    const styles = snapshot.styles ? await revertStyles(snapshot, warnings) : 0;
    const paints = snapshot.paints ? await revertPaints(snapshot, warnings, progress2) : 0;
    clearSnapshot();
    const restored = new Set(((_c = snapshot.names) != null ? _c : []).map((entry) => entry.n));
    const map = readRenameMap();
    for (const key of Object.keys(map)) if (restored.has(key)) delete map[key];
    writeRenameMap(map);
    return { values, names, styles, paints, warnings };
  }

  // src/tokens/remap/color-literal.ts
  var clamp012 = (value) => value < 0 ? 0 : value > 1 ? 1 : value;
  function hslToRgb(h, s, l) {
    const hue = (h % 360 + 360) % 360 / 60;
    const chroma = (1 - Math.abs(2 * l - 1)) * clamp012(s);
    const second = chroma * (1 - Math.abs(hue % 2 - 1));
    const [r, g, b] = hue < 1 ? [chroma, second, 0] : hue < 2 ? [second, chroma, 0] : hue < 3 ? [0, chroma, second] : hue < 4 ? [0, second, chroma] : hue < 5 ? [second, 0, chroma] : [chroma, 0, second];
    const match = clamp012(l) - chroma / 2;
    return { r: r + match, g: g + match, b: b + match };
  }
  function rgbToHsl(rgb) {
    const r = clamp012(rgb.r);
    const g = clamp012(rgb.g);
    const b = clamp012(rgb.b);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const delta = max - min;
    if (delta < 1e-9) return { h: 0, s: 0, l };
    const s = delta / (1 - Math.abs(2 * l - 1));
    const h = max === r ? 60 * ((g - b) / delta % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
    return { h: (h % 360 + 360) % 360, s, l };
  }
  function hwbToRgb(h, w, b) {
    const total = w + b;
    if (total >= 1) {
      const gray = w / total;
      return { r: gray, g: gray, b: gray };
    }
    const base = hslToRgb(h, 1, 0.5);
    const apply = (channel) => channel * (1 - w - b) + w;
    return { r: apply(base.r), g: apply(base.g), b: apply(base.b) };
  }
  function rgbToHwb(rgb) {
    const { h } = rgbToHsl(rgb);
    return { h, w: Math.min(rgb.r, rgb.g, rgb.b), b: 1 - Math.max(rgb.r, rgb.g, rgb.b) };
  }
  var NAMED_COLORS = {
    aliceblue: "F0F8FF",
    antiquewhite: "FAEBD7",
    aqua: "00FFFF",
    aquamarine: "7FFFD4",
    azure: "F0FFFF",
    beige: "F5F5DC",
    bisque: "FFE4C4",
    black: "000000",
    blanchedalmond: "FFEBCD",
    blue: "0000FF",
    blueviolet: "8A2BE2",
    brown: "A52A2A",
    burlywood: "DEB887",
    cadetblue: "5F9EA0",
    chartreuse: "7FFF00",
    chocolate: "D2691E",
    coral: "FF7F50",
    cornflowerblue: "6495ED",
    cornsilk: "FFF8DC",
    crimson: "DC143C",
    cyan: "00FFFF",
    darkblue: "00008B",
    darkcyan: "008B8B",
    darkgoldenrod: "B8860B",
    darkgray: "A9A9A9",
    darkgreen: "006400",
    darkgrey: "A9A9A9",
    darkkhaki: "BDB76B",
    darkmagenta: "8B008B",
    darkolivegreen: "556B2F",
    darkorange: "FF8C00",
    darkorchid: "9932CC",
    darkred: "8B0000",
    darksalmon: "E9967A",
    darkseagreen: "8FBC8F",
    darkslateblue: "483D8B",
    darkslategray: "2F4F4F",
    darkslategrey: "2F4F4F",
    darkturquoise: "00CED1",
    darkviolet: "9400D3",
    deeppink: "FF1493",
    deepskyblue: "00BFFF",
    dimgray: "696969",
    dimgrey: "696969",
    dodgerblue: "1E90FF",
    firebrick: "B22222",
    floralwhite: "FFFAF0",
    forestgreen: "228B22",
    fuchsia: "FF00FF",
    gainsboro: "DCDCDC",
    ghostwhite: "F8F8FF",
    gold: "FFD700",
    goldenrod: "DAA520",
    gray: "808080",
    green: "008000",
    greenyellow: "ADFF2F",
    grey: "808080",
    honeydew: "F0FFF0",
    hotpink: "FF69B4",
    indianred: "CD5C5C",
    indigo: "4B0082",
    ivory: "FFFFF0",
    khaki: "F0E68C",
    lavender: "E6E6FA",
    lavenderblush: "FFF0F5",
    lawngreen: "7CFC00",
    lemonchiffon: "FFFACD",
    lightblue: "ADD8E6",
    lightcoral: "F08080",
    lightcyan: "E0FFFF",
    lightgoldenrodyellow: "FAFAD2",
    lightgray: "D3D3D3",
    lightgreen: "90EE90",
    lightgrey: "D3D3D3",
    lightpink: "FFB6C1",
    lightsalmon: "FFA07A",
    lightseagreen: "20B2AA",
    lightskyblue: "87CEFA",
    lightslategray: "778899",
    lightslategrey: "778899",
    lightsteelblue: "B0C4DE",
    lightyellow: "FFFFE0",
    lime: "00FF00",
    limegreen: "32CD32",
    linen: "FAF0E6",
    magenta: "FF00FF",
    maroon: "800000",
    mediumaquamarine: "66CDAA",
    mediumblue: "0000CD",
    mediumorchid: "BA55D3",
    mediumpurple: "9370DB",
    mediumseagreen: "3CB371",
    mediumslateblue: "7B68EE",
    mediumspringgreen: "00FA9A",
    mediumturquoise: "48D1CC",
    mediumvioletred: "C71585",
    midnightblue: "191970",
    mintcream: "F5FFFA",
    mistyrose: "FFE4E1",
    moccasin: "FFE4B5",
    navajowhite: "FFDEAD",
    navy: "000080",
    oldlace: "FDF5E6",
    olive: "808000",
    olivedrab: "6B8E23",
    orange: "FFA500",
    orangered: "FF4500",
    orchid: "DA70D6",
    palegoldenrod: "EEE8AA",
    palegreen: "98FB98",
    paleturquoise: "AFEEEE",
    palevioletred: "DB7093",
    papayawhip: "FFEFD5",
    peachpuff: "FFDAB9",
    peru: "CD853F",
    pink: "FFC0CB",
    plum: "DDA0DD",
    powderblue: "B0E0E6",
    purple: "800080",
    rebeccapurple: "663399",
    red: "FF0000",
    rosybrown: "BC8F8F",
    royalblue: "4169E1",
    saddlebrown: "8B4513",
    salmon: "FA8072",
    sandybrown: "F4A460",
    seagreen: "2E8B57",
    seashell: "FFF5EE",
    sienna: "A0522D",
    silver: "C0C0C0",
    skyblue: "87CEEB",
    slateblue: "6A5ACD",
    slategray: "708090",
    slategrey: "708090",
    snow: "FFFAFA",
    springgreen: "00FF7F",
    steelblue: "4682B4",
    tan: "D2B48C",
    teal: "008080",
    thistle: "D8BFD8",
    tomato: "FF6347",
    turquoise: "40E0D0",
    violet: "EE82EE",
    wheat: "F5DEB3",
    white: "FFFFFF",
    whitesmoke: "F5F5F5",
    yellow: "FFFF00",
    yellowgreen: "9ACD32"
  };
  var NAMED_BY_HEX = /* @__PURE__ */ new Map();
  for (const name of Object.keys(NAMED_COLORS)) {
    if (!NAMED_BY_HEX.has(NAMED_COLORS[name])) NAMED_BY_HEX.set(NAMED_COLORS[name], name);
  }
  var namedColorFor = (rgb) => {
    var _a;
    return (_a = NAMED_BY_HEX.get(formatHex(rgb).slice(1))) != null ? _a : null;
  };
  var HEX_RE = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
  var FUNC_RE = /\b(rgba?|hsla?|hwb|oklch|oklab)\(\s*([^()]*)\)/gi;
  var NAMED_RE = new RegExp("(?<![\\w-])([a-zA-Z]{3,20})(?![\\w-])", "g");
  function inValuePosition(text2, start, end) {
    const before = text2[start - 1];
    const after = text2[end];
    if ((before === '"' || before === "'") && after === before) return true;
    let lineStart = start;
    while (lineStart > 0 && text2[lineStart - 1] !== "\n") lineStart--;
    const head = text2.slice(lineStart, start);
    if (head.indexOf("//") !== -1 || head.trim().startsWith("*")) return false;
    for (let i = start - 1; i >= lineStart; i--) {
      const character = text2[i];
      if (character === ":") return true;
      if (character === ";" || character === "{" || character === "}") return false;
    }
    return false;
  }
  function parseComponent(raw) {
    const text2 = raw.trim();
    if (text2 === "") return null;
    const percent = text2.endsWith("%");
    const value = Number(percent ? text2.slice(0, -1) : text2);
    return Number.isFinite(value) ? { value, percent } : null;
  }
  function splitArguments(body) {
    const slash = body.split("/");
    const head = slash[0].trim().split(/[\s,]+/).filter(Boolean);
    const tail = slash.length > 1 ? [slash.slice(1).join("/").trim()] : [];
    return [...head, ...tail];
  }
  function parseFunctional(fn, body) {
    const parts = splitArguments(body).map(parseComponent);
    if (parts.length < 3 || parts.slice(0, 3).some((part) => part === null)) return null;
    const [first, second, third, fourth] = parts;
    const alpha = fourth ? clamp012(fourth.percent ? fourth.value / 100 : fourth.value) : 1;
    if (fn === "rgb") {
      const channel = (part) => clamp012(part.percent ? part.value / 100 : part.value / 255);
      return { r: channel(first), g: channel(second), b: channel(third), a: alpha };
    }
    const ratio = (part, full) => part.percent ? part.value / 100 : part.value / full;
    if (fn === "hsl") {
      return __spreadProps(__spreadValues({}, hslToRgb(first.value, ratio(second, 1), ratio(third, 1))), { a: alpha });
    }
    if (fn === "hwb") {
      return __spreadProps(__spreadValues({}, hwbToRgb(first.value, ratio(second, 1), ratio(third, 1))), { a: alpha });
    }
    if (fn === "oklch") {
      return __spreadProps(__spreadValues({}, oklchToRgb({ l: ratio(first, 1), c: second.percent ? second.value / 100 * 0.4 : second.value, h: third.value })), { a: alpha });
    }
    const a = second.percent ? second.value / 100 * 0.4 : second.value;
    const b = third.percent ? third.value / 100 * 0.4 : third.value;
    const chroma = Math.sqrt(a * a + b * b);
    const hue = chroma < 1e-9 ? 0 : (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
    return __spreadProps(__spreadValues({}, oklchToRgb({ l: ratio(first, 1), c: chroma, h: hue })), { a: alpha });
  }
  function parseHexLiteral(digits) {
    const expand = (hex) => hex.split("").map((char) => char + char).join("");
    if (digits.length === 3 || digits.length === 6) {
      const rgb2 = parseHex(digits);
      return rgb2 ? { rgba: __spreadProps(__spreadValues({}, rgb2), { a: 1 }), notation: digits.length === 3 ? "hex3" : "hex6" } : null;
    }
    const short = digits.length === 4;
    if (!short && digits.length !== 8) return null;
    const full = short ? expand(digits) : digits;
    const rgb = parseHex(full.slice(0, 6));
    if (!rgb) return null;
    return {
      rgba: __spreadProps(__spreadValues({}, rgb), { a: parseInt(full.slice(6, 8), 16) / 255 }),
      notation: short ? "hex4" : "hex8"
    };
  }
  function findColorLiterals(text2) {
    const found = [];
    for (const match of text2.matchAll(HEX_RE)) {
      const parsed = parseHexLiteral(match[1]);
      if (!parsed) continue;
      found.push({
        rgba: parsed.rgba,
        notation: parsed.notation,
        source: match[0],
        start: match.index,
        end: match.index + match[0].length
      });
    }
    for (const match of text2.matchAll(FUNC_RE)) {
      const fn = match[1].toLowerCase();
      const kind = fn.startsWith("rgb") ? "rgb" : fn.startsWith("hsl") ? "hsl" : fn;
      const rgba = parseFunctional(kind, match[2]);
      if (!rgba) continue;
      found.push({
        rgba,
        notation: kind,
        source: match[0],
        start: match.index,
        end: match.index + match[0].length
      });
    }
    for (const match of text2.matchAll(NAMED_RE)) {
      const hex = NAMED_COLORS[match[1].toLowerCase()];
      if (hex === void 0) continue;
      if (!inValuePosition(text2, match.index, match.index + match[0].length)) continue;
      const rgb = parseHex(hex);
      if (!rgb) continue;
      found.push({
        rgba: __spreadProps(__spreadValues({}, rgb), { a: 1 }),
        notation: "named",
        source: match[0],
        start: match.index,
        end: match.index + match[0].length
      });
    }
    return found.sort((a, b) => a.start - b.start);
  }
  function parseColorLiteral(text2) {
    const found = findColorLiterals(text2);
    return found.length === 1 ? found[0] : null;
  }
  var round6 = (value, places = 4) => {
    const factor = Math.pow(10, places);
    return Math.round(value * factor) / factor;
  };
  var hexPair = (value) => Math.round(clamp012(value) * 255).toString(16).toUpperCase().padStart(2, "0");
  function formatColorLiteral(rgba, notation) {
    const opaque = rgba.a >= 1 - 1e-6;
    switch (notation) {
      case "hex3":
      case "hex6":
        return opaque ? formatHex(rgba) : formatHex(rgba) + hexPair(rgba.a);
      case "hex4":
      case "hex8":
        return formatHex(rgba) + hexPair(rgba.a);
      case "rgb": {
        const channel = (value) => Math.round(clamp012(value) * 255);
        const parts = [channel(rgba.r), channel(rgba.g), channel(rgba.b)];
        return opaque ? `rgb(${parts.join(", ")})` : `rgba(${parts.join(", ")}, ${round6(rgba.a)})`;
      }
      case "hsl": {
        const { h, s, l } = rgbToHsl(rgba);
        const parts = [`${round6(h, 2)}`, `${round6(s * 100, 2)}%`, `${round6(l * 100, 2)}%`];
        return opaque ? `hsl(${parts.join(", ")})` : `hsla(${parts.join(", ")}, ${round6(rgba.a)})`;
      }
      case "hwb": {
        const { h, w, b } = rgbToHwb(rgba);
        const body = `${round6(h, 2)} ${round6(w * 100, 2)}% ${round6(b * 100, 2)}%`;
        return opaque ? `hwb(${body})` : `hwb(${body} / ${round6(rgba.a)})`;
      }
      case "oklch": {
        const { l, c, h } = rgbToOklch(rgba);
        const body = `${round6(l, 4)} ${round6(c, 4)} ${round6(h, 2)}`;
        return opaque ? `oklch(${body})` : `oklch(${body} / ${round6(rgba.a)})`;
      }
      case "oklab": {
        const { l, c, h } = rgbToOklch(rgba);
        const radians = h * Math.PI / 180;
        const body = `${round6(l, 4)} ${round6(c * Math.cos(radians), 4)} ${round6(c * Math.sin(radians), 4)}`;
        return opaque ? `oklab(${body})` : `oklab(${body} / ${round6(rgba.a)})`;
      }
      case "named": {
        const name = opaque ? namedColorFor(rgba) : null;
        if (name) return name;
        return opaque ? formatHex(rgba) : formatHex(rgba) + hexPair(rgba.a);
      }
    }
  }
  var toHex = (rgba) => formatHex(rgba);

  // src/targets/ds-tools/remap-board.ts
  var SECTION_KEY = "altery-remap-board";
  var SECTION_NAME = "Color remap";
  var SWATCH_WIDTH2 = 96;
  var SWATCH_HEIGHT = 46;
  var CAPTION_SIZE2 = 9;
  var LABEL_SIZE2 = 11;
  var ROW_GAP2 = 22;
  var PADDING = 48;
  var MAX_ROWS_PER_FAMILY = 24;
  async function loadFonts2() {
    var _a;
    const candidates = [
      { family: "Inter", style: "Regular" },
      { family: "Roboto", style: "Regular" },
      { family: "Helvetica", style: "Regular" }
    ];
    for (const font of candidates) {
      try {
        await figma.loadFontAsync(font);
        return { body: font };
      } catch (e) {
      }
    }
    const available = await figma.listAvailableFontsAsync();
    const first = (_a = available[0]) == null ? void 0 : _a.fontName;
    if (!first) throw new Error("No fonts are available to label the board.");
    await figma.loadFontAsync(first);
    return { body: first };
  }
  var rgbOf2 = (hex) => {
    const rgb = parseHex(hex);
    return rgb ? { r: rgb.r, g: rgb.g, b: rgb.b } : { r: 0.5, g: 0.5, b: 0.5 };
  };
  var solid3 = (hex) => ({ type: "SOLID", color: rgbOf2(hex) });
  function label2(text2, fonts, size, hex) {
    const node = figma.createText();
    node.fontName = fonts.body;
    node.fontSize = size;
    node.characters = text2;
    node.fills = [solid3(hex)];
    return node;
  }
  function autoLayout2(name, direction, gap) {
    const frame2 = figma.createFrame();
    frame2.name = name;
    frame2.layoutMode = direction;
    frame2.itemSpacing = gap;
    frame2.primaryAxisSizingMode = "AUTO";
    frame2.counterAxisSizingMode = "AUTO";
    frame2.fills = [];
    frame2.clipsContent = false;
    return frame2;
  }
  var inkOn = (color) => contrastRatio(color, { r: 0, g: 0, b: 0 }) >= contrastRatio(color, { r: 1, g: 1, b: 1 }) ? "#000000" : "#FFFFFF";
  function block(color, caption, fonts) {
    const frame2 = autoLayout2("swatch", "VERTICAL", 0);
    frame2.primaryAxisSizingMode = "FIXED";
    frame2.counterAxisSizingMode = "FIXED";
    frame2.resize(SWATCH_WIDTH2, SWATCH_HEIGHT);
    frame2.fills = [{ type: "SOLID", color: { r: color.r, g: color.g, b: color.b }, opacity: color.a }];
    frame2.paddingLeft = 8;
    frame2.paddingTop = 7;
    frame2.primaryAxisAlignItems = "MIN";
    const hex = toHex(color);
    frame2.appendChild(label2(hex, fonts, CAPTION_SIZE2, inkOn(color)));
    if (caption !== "") frame2.appendChild(label2(caption, fonts, CAPTION_SIZE2, inkOn(color)));
    return frame2;
  }
  function gutter(fonts) {
    const column = autoLayout2("legend", "VERTICAL", 3);
    for (const text2 of ["old", "new"]) {
      const cell = autoLayout2(text2, "VERTICAL", 0);
      cell.primaryAxisSizingMode = "FIXED";
      cell.counterAxisSizingMode = "FIXED";
      cell.resize(34, SWATCH_HEIGHT);
      cell.primaryAxisAlignItems = "CENTER";
      cell.counterAxisAlignItems = "MAX";
      cell.paddingRight = 8;
      cell.appendChild(label2(text2, fonts, CAPTION_SIZE2, "#8A8A8A"));
      column.appendChild(cell);
    }
    return column;
  }
  function pair(entry, fonts) {
    const column = autoLayout2(entry.site.name, "VERTICAL", 3);
    column.appendChild(block(entry.from, entry.fromStep === null ? "" : String(entry.fromStep), fonts));
    column.appendChild(block(entry.to, entry.toStep === null ? "" : String(entry.toStep), fonts));
    const name = entry.site.name.length > 22 ? "\u2026" + entry.site.name.slice(-21) : entry.site.name;
    column.appendChild(label2(name, fonts, CAPTION_SIZE2, "#8A8A8A"));
    return column;
  }
  function groupEntries(plan) {
    var _a;
    const moving = plan.entries.filter((entry) => !entry.flags.includes("unchanged"));
    const targetByFamily = new Map(plan.families.map((family) => [family.fromLabel, family.toLabel]));
    const order = [];
    const grouped = /* @__PURE__ */ new Map();
    for (const entry of moving) {
      const key = (_a = entry.fromFamily) != null ? _a : "Ungrouped";
      const group = grouped.get(key);
      if (group) group.push(entry);
      else {
        grouped.set(key, [entry]);
        order.push(key);
      }
    }
    return order.map((key) => {
      const target = targetByFamily.get(key);
      return {
        title: target ? `${key}  \u2192  ${target}` : key,
        entries: grouped.get(key)
      };
    });
  }
  async function drawRemapBoard(plan) {
    var _a;
    const fonts = await loadFonts2();
    const groups = groupEntries(plan);
    if (groups.length === 0) return { section: SECTION_NAME, rows: 0, families: 0, omitted: 0 };
    const previous = figma.currentPage.findAllWithCriteria({ types: ["SECTION"] }).find((node) => node.getPluginData(SECTION_KEY) === "1");
    const previousBox = (_a = previous == null ? void 0 : previous.absoluteBoundingBox) != null ? _a : null;
    const spot = previousBox ? { x: previousBox.x, y: previousBox.y } : placementFor2(groups);
    if (previous) previous.remove();
    const content = autoLayout2(SECTION_NAME, "VERTICAL", ROW_GAP2);
    content.x = spot.x + PADDING;
    content.y = spot.y + PADDING;
    const heading = autoLayout2("heading", "VERTICAL", 4);
    heading.appendChild(label2(SECTION_NAME, fonts, LABEL_SIZE2 + 3, "#1A1A1A"));
    heading.appendChild(
      label2(
        `old above, new below \xB7 ${plan.entries.filter((entry) => !entry.flags.includes("unchanged")).length} of ${plan.entries.length} colors move`,
        fonts,
        CAPTION_SIZE2 + 1,
        "#8A8A8A"
      )
    );
    content.appendChild(heading);
    let rows = 0;
    let omitted = 0;
    for (const group of groups) {
      const row = autoLayout2(group.title, "VERTICAL", 8);
      row.appendChild(label2(group.title, fonts, LABEL_SIZE2, "#1A1A1A"));
      const strip = autoLayout2("strip", "HORIZONTAL", 6);
      strip.appendChild(gutter(fonts));
      const shown = group.entries.slice(0, MAX_ROWS_PER_FAMILY);
      for (const entry of shown) strip.appendChild(pair(entry, fonts));
      row.appendChild(strip);
      rows += shown.length;
      const hidden = group.entries.length - shown.length;
      if (hidden > 0) {
        omitted += hidden;
        row.appendChild(label2(`+ ${hidden} more in this family`, fonts, CAPTION_SIZE2, "#8A8A8A"));
      }
      content.appendChild(row);
    }
    const section = figma.createSection();
    section.name = SECTION_NAME;
    section.fills = [solid3("#FFFFFF")];
    section.setPluginData(SECTION_KEY, "1");
    figma.currentPage.appendChild(section);
    section.x = spot.x;
    section.y = spot.y;
    section.resizeWithoutConstraints(content.width + PADDING * 2, content.height + PADDING * 2);
    section.appendChild(content);
    const sectionBox = section.absoluteBoundingBox;
    const contentBox = content.absoluteBoundingBox;
    if (sectionBox && contentBox) {
      content.x += sectionBox.x + PADDING - contentBox.x;
      content.y += sectionBox.y + PADDING - contentBox.y;
    }
    return { section: SECTION_NAME, rows, families: groups.length, omitted };
  }
  function placementFor2(groups) {
    const widest = groups.reduce(
      (most, group) => Math.max(most, Math.min(group.entries.length, MAX_ROWS_PER_FAMILY)),
      0
    );
    const width = widest * (SWATCH_WIDTH2 + 6) + PADDING * 2;
    const nodes = figma.currentPage.children;
    if (nodes.length === 0) {
      const { x, y } = figma.viewport.center;
      return { x: x - width / 2, y: y - 200 };
    }
    let right = -Infinity;
    let top = Infinity;
    for (const node of nodes) {
      right = Math.max(right, node.x + node.width);
      top = Math.min(top, node.y);
    }
    return { x: right + 200, y: top };
  }

  // src/tokens/remap/audit.ts
  var TEXT_CONTRAST_MIN = 4.5;
  var NON_TEXT_CONTRAST_MIN = 3;
  var round7 = (value) => Math.round(value * 100) / 100;
  var MEANINGFUL_DROP = 0.1;
  function auditContrast(plan, pairs) {
    var _a;
    const byId = new Map(plan.entries.map((entry) => [entry.site.id, entry]));
    const findings = [];
    const seen = /* @__PURE__ */ new Set();
    let checked = 0;
    let improved = 0;
    for (const pair2 of pairs) {
      const a = byId.get(pair2.a);
      const b = byId.get(pair2.b);
      if (!a || !b) continue;
      const key = pair2.a < pair2.b ? `${pair2.a}|${pair2.b}` : `${pair2.b}|${pair2.a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checked++;
      const before = contrastRatio(a.from, b.from);
      const after = contrastRatio(a.to, b.to);
      if (after > before + MEANINGFUL_DROP) {
        improved++;
        continue;
      }
      if (before - after < MEANINGFUL_DROP) continue;
      const threshold = pair2.text ? TEXT_CONTRAST_MIN : NON_TEXT_CONTRAST_MIN;
      if (after >= threshold) continue;
      findings.push({
        aName: a.site.name,
        bName: b.site.name,
        mode: (_a = a.site.modeName) != null ? _a : b.site.modeName,
        before: round7(before),
        after: round7(after),
        text: pair2.text,
        verdict: before >= threshold ? "broken" : "weakened"
      });
    }
    findings.sort(
      (first, second) => Number(second.verdict === "broken") - Number(first.verdict === "broken") || first.after - second.after || second.before - first.before
    );
    return { findings, checked, improved };
  }
  function describeContrast(finding) {
    const kind = finding.text ? "text" : "boundary";
    const verb = finding.verdict === "broken" ? "fell below" : "dropped further below";
    const threshold = finding.text ? TEXT_CONTRAST_MIN : NON_TEXT_CONTRAST_MIN;
    return `${finding.aName} on ${finding.bName}` + (finding.mode ? ` (${finding.mode})` : "") + `: ${kind} contrast ${finding.before} \u2192 ${finding.after}, ${verb} ${threshold}`;
  }

  // src/tokens/remap/input.ts
  var NAME_KEYS = ["name", "token", "key", "id", "label", "title"];
  var VALUE_KEYS = ["$value", "value", "hex", "color", "colour", "rgb", "fill"];
  var isRecord4 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  function swatchFrom(text2, name) {
    const literals = findColorLiterals(text2);
    if (literals.length !== 1) return null;
    const { rgba } = literals[0];
    const parsed = parseTokenName(name);
    return {
      hex: toHex(rgba),
      alpha: rgba.a,
      rgba,
      name: name.trim(),
      family: parsed.family,
      step: parsed.step
    };
  }
  var joinName = (prefix, key) => prefix === "" ? key : `${prefix}/${key}`;
  function readJsonNode(node, prefix, out, warnings) {
    if (typeof node === "string") {
      const swatch = swatchFrom(node, prefix);
      if (swatch) out.push(swatch);
      else if (prefix !== "") warnings.push(`${prefix}: "${node}" is not a color`);
      return;
    }
    if (Array.isArray(node)) {
      const family = prefix === "" ? null : parseTokenName(prefix).leaf;
      for (const entry of node) {
        if (typeof entry !== "string") {
          readJsonNode(entry, prefix, out, warnings);
          continue;
        }
        const swatch = swatchFrom(entry, prefix);
        if (swatch) out.push(__spreadProps(__spreadValues({}, swatch), { family: family != null ? family : swatch.family }));
        else if (entry.trim() !== "") warnings.push(`${prefix || "entry"}: "${entry}" is not a color`);
      }
      return;
    }
    if (!isRecord4(node)) return;
    const valueKey = VALUE_KEYS.find((key) => typeof node[key] === "string");
    if (valueKey) {
      const nameKey2 = NAME_KEYS.find((key) => typeof node[key] === "string");
      const name = nameKey2 ? String(node[nameKey2]) : prefix;
      const swatch = swatchFrom(String(node[valueKey]), name);
      if (swatch) {
        const family = typeof node.family === "string" ? node.family : typeof node.group === "string" ? node.group : null;
        const step = typeof node.step === "number" ? node.step : null;
        out.push(__spreadProps(__spreadValues({}, swatch), { family: family != null ? family : swatch.family, step: step != null ? step : swatch.step }));
      } else {
        warnings.push(`${name || "entry"}: "${node[valueKey]}" is not a color`);
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("$") && key !== "$value") continue;
      readJsonNode(value, joinName(prefix, key), out, warnings);
    }
  }
  function cleanName(text2) {
    return text2.replace(/["'`]/g, " ").replace(/[,;\t|]+/g, " ").replace(/[:=]+/g, " ").replace(/^\s*[-*•]\s*/, "").replace(/\s+/g, " ").trim();
  }
  function readTextLine(line, index, out, warnings) {
    const literals = findColorLiterals(line);
    if (literals.length === 0) {
      if (line.trim() !== "") warnings.push(`line ${index + 1}: no color found \u2014 "${line.trim().slice(0, 40)}"`);
      return;
    }
    if (literals.length === 1) {
      const literal = literals[0];
      const name = cleanName(line.slice(0, literal.start) + " " + line.slice(literal.end));
      const swatch = swatchFrom(literal.source, name);
      if (swatch) out.push(swatch);
      return;
    }
    warnings.push(`line ${index + 1}: ${literals.length} colors on one line \u2014 names ignored`);
    for (const literal of literals) {
      const swatch = swatchFrom(literal.source, "");
      if (swatch) out.push(swatch);
    }
  }
  function dedupe(swatches, warnings) {
    const seen = /* @__PURE__ */ new Set();
    const kept = [];
    let dropped = 0;
    for (const swatch of swatches) {
      const key = `${swatch.hex}|${swatch.alpha.toFixed(4)}|${swatch.name.toLowerCase()}`;
      if (seen.has(key)) {
        dropped++;
        continue;
      }
      seen.add(key);
      kept.push(swatch);
    }
    if (dropped > 0) warnings.push(`${dropped} duplicate ${dropped === 1 ? "row" : "rows"} dropped`);
    return kept;
  }
  function parsePaletteInput(raw) {
    const text2 = String(raw != null ? raw : "");
    const warnings = [];
    const swatches = [];
    const trimmed = text2.trim();
    if (trimmed === "") return { swatches: [], warnings: [], format: "text" };
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        readJsonNode(JSON.parse(trimmed), "", swatches, warnings);
        return { swatches: dedupe(swatches, warnings), warnings, format: "json" };
      } catch (e) {
        warnings.push("looks like JSON but does not parse \u2014 read line by line instead");
      }
    }
    for (const [index, line] of text2.split(/\r?\n/).entries()) readTextLine(line, index, swatches, warnings);
    return { swatches: dedupe(swatches, warnings), warnings, format: "text" };
  }

  // src/tokens/remap/plan.ts
  var DEFAULT_REMAP_OPTIONS = {
    rename: true,
    separateAdjacent: true,
    legacyGroup: "legacy"
  };
  var NO_MODE = "\0no-mode";
  var siteMember = (site) => {
    const parsed = parseTokenName(site.name);
    return { ref: site.id, name: site.name, rgba: site.rgba, family: parsed.family, step: parsed.step };
  };
  var swatchMember = (swatch, index) => ({
    ref: `new:${index}`,
    name: swatch.name,
    rgba: swatch.rgba,
    family: swatch.family,
    step: swatch.step
  });
  var land = (site, target) => ({ r: target.r, g: target.g, b: target.b, a: site.rgba.a });
  var sameColor = (a, b) => Math.abs(a.r - b.r) < 1 / 512 && Math.abs(a.g - b.g) < 1 / 512 && Math.abs(a.b - b.b) < 1 / 512;
  var colorKey = (color) => [color.r, color.g, color.b].map((channel) => Math.round(channel * 255)).join(",");
  function groupByMode(sites) {
    var _a;
    const groups = /* @__PURE__ */ new Map();
    for (const site of sites) {
      const key = (_a = site.modeId) != null ? _a : NO_MODE;
      const group = groups.get(key);
      if (group) group.push(site);
      else groups.set(key, [site]);
    }
    return groups;
  }
  function readPalette(palette) {
    const { spectra, loose, warnings } = inferSpectra(palette.map(swatchMember));
    const candidates = [
      ...spectra.flatMap((spectrum) => spectrum.stops.map((stop) => __spreadProps(__spreadValues({}, stop), { familyLabel: spectrum.label }))),
      ...loose.map((stop) => __spreadProps(__spreadValues({}, stop), { familyLabel: null }))
    ];
    return { spectra, candidates, warnings };
  }
  function entryFor(site, target, via, toFamily, flags) {
    const parsed = parseTokenName(site.name);
    const to = land(site, target.rgba);
    const all = [...flags];
    if (!site.editable) all.push("library");
    if (sameColor(site.rgba, to)) all.push("unchanged");
    return {
      site,
      from: site.rgba,
      to,
      toName: target.name === "" ? null : target.name,
      fromFamily: parsed.family,
      toFamily,
      fromStep: parsed.step,
      toStep: target.step,
      via,
      deltaE: deltaE(site.rgba, to),
      flags: all
    };
  }
  function planMode(sites, palette, modeId) {
    const byId = new Map(sites.map((site) => [site.id, site]));
    const { spectra } = inferSpectra(sites.map(siteMember));
    const { assignments } = assignFamilies(spectra, palette.spectra);
    const entries = [];
    const families = [];
    for (const assignment of assignments) {
      families.push({
        fromKey: assignment.from.key,
        fromLabel: assignment.from.label,
        toLabel: assignment.to.label,
        modeId,
        shared: assignment.shared,
        cost: assignment.cost,
        stops: assignment.from.stops.length
      });
      for (const match of matchStops(assignment.from, assignment.to)) {
        const site = byId.get(match.from.ref);
        if (!site) continue;
        entries.push(entryFor(site, match.to, match.via, assignment.to.label, assignment.shared ? ["shared-family"] : []));
      }
    }
    const matched = new Set(entries.map((entry) => entry.site.id));
    for (const site of sites) {
      if (matched.has(site.id)) continue;
      const target = nearestByColor(palette.candidates, site.rgba);
      if (!target) continue;
      entries.push(entryFor(site, target, "nearest", target.familyLabel, ["orphan"]));
    }
    return { entries, families, assignments };
  }
  function separateAdjacent(entries, palette, adjacency, warnings) {
    if (adjacency.length === 0) return;
    const byId = new Map(entries.map((entry) => [entry.site.id, entry]));
    const stopsByFamily = new Map(palette.spectra.map((spectrum) => [spectrum.label, spectrum.stops]));
    for (const [left, right] of adjacency) {
      const a = byId.get(left);
      const b = byId.get(right);
      if (!a || !b || a === b) continue;
      if (!sameColor(a.to, b.to)) continue;
      const mover = a.site.usage <= b.site.usage ? a : b;
      const anchor = mover === a ? b : a;
      const stops = mover.toFamily === null ? void 0 : stopsByFamily.get(mover.toFamily);
      if (!stops || stops.length < 2) {
        warnings.push(`${mover.site.name} and ${anchor.site.name} land on the same color and touch on canvas`);
        continue;
      }
      const index = stops.findIndex((stop) => sameColor(__spreadProps(__spreadValues({}, stop.rgba), { a: mover.to.a }), mover.to));
      const neighbours = index < 0 ? [] : [stops[index - 1], stops[index + 1]].filter(Boolean);
      if (neighbours.length === 0) {
        warnings.push(`${mover.site.name} and ${anchor.site.name} land on the same color and touch on canvas`);
        continue;
      }
      let best = neighbours[0];
      let bestContrast = -1;
      for (const candidate of neighbours) {
        const contrast = contrastRatio(candidate.rgba, anchor.to);
        if (contrast > bestContrast) {
          bestContrast = contrast;
          best = candidate;
        }
      }
      mover.to = land(mover.site, best.rgba);
      mover.toStep = best.step;
      mover.toName = best.name === "" ? null : best.name;
      mover.via = "lightness";
      mover.deltaE = deltaE(mover.from, mover.to);
      mover.flags = mover.flags.filter((flag2) => flag2 !== "unchanged");
      mover.flags.push("separated");
    }
  }
  function flagDuplicates(entries) {
    var _a;
    const byMode = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      const key = `${(_a = entry.site.modeId) != null ? _a : NO_MODE}|${colorKey(entry.to)}`;
      const group = byMode.get(key);
      if (group) group.push(entry);
      else byMode.set(key, [entry]);
    }
    for (const group of byMode.values()) {
      if (group.length < 2) continue;
      const distinct = new Set(group.map((entry) => colorKey(entry.from)));
      if (distinct.size < 2) continue;
      for (const entry of group) entry.flags.push("duplicate");
    }
  }
  function flagModeDivergence(entries, warnings) {
    const byVariable = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      if (entry.site.kind !== "variable" || entry.site.modeId === null) continue;
      const key = entry.site.name;
      const group = byVariable.get(key);
      if (group) group.push(entry);
      else byVariable.set(key, [entry]);
    }
    for (const [name, group] of byVariable) {
      const families = new Set(group.map((entry) => {
        var _a;
        return (_a = entry.toFamily) != null ? _a : "\u2014";
      }));
      if (families.size < 2) continue;
      for (const entry of group) entry.flags.push("mode-divergence");
      warnings.push(`${name} lands in different families per mode: ${[...families].join(" / ")}`);
    }
  }
  function planRenames(entries, primaryModeId, taken, options, warnings) {
    var _a;
    if (!options.rename) return [];
    const eligible = entries.filter(
      (entry) => entry.site.kind === "variable" && entry.site.primitive && entry.site.editable && entry.toFamily !== null
    );
    const perEntity = /* @__PURE__ */ new Map();
    for (const entry of eligible) {
      const key = (_a = entry.site.groupId) != null ? _a : entry.site.id;
      const chosen = perEntity.get(key);
      if (!chosen) {
        perEntity.set(key, entry);
        continue;
      }
      if (primaryModeId && entry.site.modeId === primaryModeId && chosen.site.modeId !== primaryModeId) {
        perEntity.set(key, entry);
      }
    }
    const candidates = [...perEntity.values()];
    const proposals = candidates.map((entry) => {
      var _a2;
      return {
        entry,
        to: renameFamily(entry.site.name, entry.toFamily, (_a2 = entry.toStep) != null ? _a2 : void 0)
      };
    }).filter((proposal) => proposal.to !== proposal.entry.site.name).sort((a, b) => b.entry.site.usage - a.entry.site.usage || a.entry.site.name.localeCompare(b.entry.site.name));
    const claimed = /* @__PURE__ */ new Set();
    const renaming = new Set(proposals.map((proposal) => proposal.entry.site.name));
    const renames = [];
    for (const proposal of proposals) {
      const collides = claimed.has(proposal.to) || taken.has(proposal.to) && !renaming.has(proposal.to);
      if (!collides) {
        claimed.add(proposal.to);
        renames.push({ siteId: proposal.entry.site.id, from: proposal.entry.site.name, to: proposal.to, legacy: false });
        continue;
      }
      const parked = `${options.legacyGroup}/${proposal.entry.site.name}`;
      claimed.add(parked);
      renames.push({ siteId: proposal.entry.site.id, from: proposal.entry.site.name, to: parked, legacy: true });
      warnings.push(
        `${proposal.entry.site.name} and another variable both become ${proposal.to} \u2014 the less used one moves to ${parked}, keeping its exported key alive as an alias`
      );
    }
    return renames;
  }
  function buildRemapPlan(request) {
    var _a;
    const options = __spreadValues(__spreadValues({}, DEFAULT_REMAP_OPTIONS), request.options);
    const warnings = [];
    const palette = readPalette(request.palette);
    warnings.push(...palette.warnings);
    if (palette.candidates.length === 0) {
      return { entries: [], renames: [], families: [], unusedFamilies: [], warnings: ["the new palette is empty"] };
    }
    const entries = [];
    const families = [];
    const landedOn = /* @__PURE__ */ new Set();
    for (const [modeKey, group] of groupByMode(request.sites)) {
      const modeId = modeKey === NO_MODE ? null : modeKey;
      const planned = planMode(group, palette, modeId);
      entries.push(...planned.entries);
      families.push(...planned.families);
      for (const assignment of planned.assignments) landedOn.add(assignment.to.key);
    }
    if (options.separateAdjacent) separateAdjacent(entries, palette, (_a = request.adjacency) != null ? _a : [], warnings);
    flagDuplicates(entries);
    flagModeDivergence(entries, warnings);
    const taken = new Set(request.sites.filter((site) => site.kind === "variable").map((site) => site.name));
    const renames = planRenames(entries, request.primaryModeId, taken, options, warnings);
    const skipped = entries.filter((entry) => entry.flags.includes("library"));
    if (skipped.length > 0) {
      const names = new Set(skipped.map((entry) => entry.site.name));
      warnings.push(
        `${names.size} ${names.size === 1 ? "token comes" : "tokens come"} from a library and cannot be written from this file \u2014 run the remap in the library\u2019s source file`
      );
    }
    return {
      entries,
      renames,
      families,
      unusedFamilies: palette.spectra.filter((spectrum) => !landedOn.has(spectrum.key)).map((spectrum) => spectrum.label),
      warnings
    };
  }

  // src/tokens/remap/contract.ts
  var MAPPING_FORMAT = "altery-color-remap";
  var MAPPING_VERSION = 1;
  var round8 = (value, places = 3) => {
    const factor = Math.pow(10, places);
    return Math.round(value * factor) / factor;
  };
  function buildMappingFile(plan, meta = {}) {
    var _a, _b, _c;
    const renamedById = new Map(plan.renames.map((rename) => [rename.siteId, rename.to]));
    return {
      format: MAPPING_FORMAT,
      version: MAPPING_VERSION,
      generatedAt: (_a = meta.generatedAt) != null ? _a : null,
      source: { file: (_b = meta.file) != null ? _b : null, palette: (_c = meta.palette) != null ? _c : null },
      families: plan.families.map((family) => ({
        from: family.fromLabel,
        to: family.toLabel,
        mode: family.modeId,
        shared: family.shared
      })),
      renames: plan.renames.map((rename) => ({ from: rename.from, to: rename.to, legacy: rename.legacy })),
      records: plan.entries.map((entry) => {
        var _a2;
        return {
          kind: entry.site.kind,
          id: entry.site.id,
          name: entry.site.name,
          newName: (_a2 = renamedById.get(entry.site.id)) != null ? _a2 : null,
          mode: entry.site.modeName,
          from: toHex(entry.from),
          fromAlpha: round8(entry.from.a),
          to: toHex(entry.to),
          toAlpha: round8(entry.to.a),
          fromFamily: entry.fromFamily,
          fromStep: entry.fromStep,
          toFamily: entry.toFamily,
          toStep: entry.toStep,
          via: entry.via,
          deltaE: round8(entry.deltaE, 2),
          flags: entry.flags
        };
      }),
      warnings: plan.warnings
    };
  }
  var csvCell = (value) => {
    const text2 = value === null || value === void 0 ? "" : String(value);
    return /[",\n]/.test(text2) ? `"${text2.replace(/"/g, '""')}"` : text2;
  };
  var CSV_COLUMNS = [
    "kind",
    "name",
    "newName",
    "mode",
    "from",
    "fromAlpha",
    "to",
    "toAlpha",
    "fromFamily",
    "fromStep",
    "toFamily",
    "toStep",
    "via",
    "deltaE",
    "flags"
  ];
  function toCsv(mapping) {
    const rows = mapping.records.map(
      (record) => CSV_COLUMNS.map((column) => csvCell(column === "flags" ? record.flags.join(" ") : record[column])).join(",")
    );
    return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
  }

  // src/tokens/remap/rewrite.ts
  var DEFAULT_REWRITE_OPTIONS = { snap: 2, mode: null, byName: false };
  var rgbaOf = (hex, alpha) => {
    const rgb = parseHex(hex);
    return rgb ? __spreadProps(__spreadValues({}, rgb), { a: alpha }) : null;
  };
  var nameKey = (name) => varName(name.split(/[/.]/));
  function buildLookup(mapping, options) {
    const byHex = /* @__PURE__ */ new Map();
    const byName = /* @__PURE__ */ new Map();
    const all = [];
    const conflicting = /* @__PURE__ */ new Set();
    const warnings = [];
    const records = mapping.records.filter(
      (record) => options.mode == null || record.mode === null || record.mode === options.mode
    );
    for (const record of records) {
      const to = rgbaOf(record.to, 1);
      if (!to) continue;
      const target = { rgb: to, hex: record.to };
      for (const name of [record.name, record.newName]) {
        if (name) byName.set(nameKey(name), target);
      }
      if (record.from === record.to) continue;
      const existing = byHex.get(record.from);
      if (existing && existing.hex !== record.to) {
        conflicting.add(record.from);
        continue;
      }
      byHex.set(record.from, target);
    }
    for (const hex of conflicting) {
      byHex.delete(hex);
      warnings.push(
        `${hex} maps to more than one new color in this file \u2014 pass --mode to say which theme this repository is`
      );
    }
    for (const [hex, target] of byHex) {
      const from = rgbaOf(hex, 1);
      if (from) all.push({ from, target });
    }
    return { byHex, all, byName, warnings };
  }
  function matchLiteral(literal, lookup, snap) {
    const hex = toHex(literal.rgba);
    const exact = lookup.byHex.get(hex);
    if (exact) return { target: exact, snapped: false };
    if (snap <= 0) return null;
    let best = null;
    let bestDistance = snap;
    for (const candidate of lookup.all) {
      const distance = deltaE(candidate.from, literal.rgba);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate.target;
      }
    }
    return best ? { target: best, snapped: true } : null;
  }
  function positionOf(text2, offset) {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < offset; i++) {
      if (text2[i] === "\n") {
        line++;
        lineStart = i + 1;
      }
    }
    return { line, column: offset - lineStart + 1 };
  }
  function applyEdits(text2, edits) {
    const ordered = [...edits].sort((a, b) => a.start - b.start);
    const kept = [];
    let reach = -1;
    for (const edit of ordered) {
      if (edit.start < reach) continue;
      kept.push(edit);
      reach = edit.end;
    }
    const replacements = kept.map((edit) => __spreadProps(__spreadValues({}, positionOf(text2, edit.start)), {
      from: edit.from,
      to: edit.to,
      via: edit.via,
      snapped: edit.snapped
    }));
    let out = text2;
    for (let i = kept.length - 1; i >= 0; i--) {
      const edit = kept[i];
      out = out.slice(0, edit.start) + edit.to + out.slice(edit.end);
    }
    return { text: out, replacements };
  }
  var CSS_DECLARATION_RE = /(--[\w-]+)(\s*:\s*)([^;{}\n]+)/g;
  var JSON_DECLARATION_RE = /("([^"\\]+)"\s*:\s*")([^"\\]*)(")/g;
  function nameEdits(text2, lookup) {
    const edits = [];
    const claim = (name, valueStart, value) => {
      const target = lookup.byName.get(nameKey(name));
      if (!target) return;
      const literals = findColorLiterals(value);
      if (literals.length !== 1 || literals[0].source.trim() !== value.trim()) return;
      const literal = literals[0];
      const to = formatColorLiteral(__spreadProps(__spreadValues({}, target.rgb), { a: literal.rgba.a }), literal.notation);
      if (to === literal.source) return;
      edits.push({
        start: valueStart + literal.start,
        end: valueStart + literal.end,
        from: literal.source,
        to,
        via: "name",
        snapped: false
      });
    };
    for (const match of text2.matchAll(CSS_DECLARATION_RE)) {
      claim(match[1].slice(2), match.index + match[1].length + match[2].length, match[3]);
    }
    for (const match of text2.matchAll(JSON_DECLARATION_RE)) {
      claim(match[2], match.index + match[1].length, match[3]);
    }
    return edits;
  }
  function rewriteColors(text2, mapping, options = {}) {
    const settings = __spreadValues(__spreadValues({}, DEFAULT_REWRITE_OPTIONS), options);
    const lookup = buildLookup(mapping, settings);
    const edits = settings.byName ? nameEdits(text2, lookup) : [];
    let untouched = 0;
    for (const literal of findColorLiterals(text2)) {
      const matched = matchLiteral(literal, lookup, settings.snap);
      if (!matched) {
        untouched++;
        continue;
      }
      const to = formatColorLiteral(__spreadProps(__spreadValues({}, matched.target.rgb), { a: literal.rgba.a }), literal.notation);
      if (to === literal.source) continue;
      edits.push({
        start: literal.start,
        end: literal.end,
        from: literal.source,
        to,
        via: "literal",
        snapped: matched.snapped
      });
    }
    const applied = applyEdits(text2, edits);
    return __spreadProps(__spreadValues({}, applied), { untouched, warnings: lookup.warnings });
  }

  // src/tokens/remap/sources.ts
  function swatchOf(hex, name, family, step) {
    const rgb = parseHex(hex);
    if (!rgb) return null;
    return { hex: hex.toUpperCase(), alpha: 1, rgba: __spreadProps(__spreadValues({}, rgb), { a: 1 }), name, family, step };
  }
  function swatchesFromPalette(palette) {
    const swatches = [];
    for (const spectrum of palette.spectra) {
      for (const swatch of spectrum.swatches) {
        const parsed = swatchOf(swatch.hex, `${spectrum.label}/${swatch.step}`, spectrum.label, swatch.step);
        if (parsed) swatches.push(parsed);
      }
    }
    return swatches;
  }
  function swatchesFromNamedColors(entries) {
    var _a;
    const seen = /* @__PURE__ */ new Set();
    const swatches = [];
    let duplicates = 0;
    for (const entry of entries) {
      const rgb = parseHex(entry.hex);
      if (!rgb) continue;
      const alpha = (_a = entry.alpha) != null ? _a : 1;
      const key = `${entry.hex.toUpperCase()}|${alpha.toFixed(3)}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      const parsed = parseTokenName(entry.name);
      swatches.push({
        hex: entry.hex.toUpperCase(),
        alpha,
        rgba: __spreadProps(__spreadValues({}, rgb), { a: alpha }),
        name: entry.name,
        family: parsed.family,
        step: parsed.step
      });
    }
    return { swatches, duplicates };
  }

  // src/targets/ds-tools/remap-sources.ts
  async function swatchesFromSelection() {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      return { swatches: [], warnings: ["nothing is selected \u2014 select the swatches, a frame, or a whole board"] };
    }
    const entries = [];
    const collect = (node) => {
      var _a;
      for (const property of ["fills", "strokes"]) {
        for (const paint of paintsOf(node, property)) {
          if (paint.visible === false) continue;
          if (paint.type === "SOLID") {
            entries.push({ hex: hexOf(paint.color), alpha: (_a = paint.opacity) != null ? _a : 1, name: node.name });
            continue;
          }
          if (!isGradient(paint)) continue;
          for (const [index, stop] of paint.gradientStops.entries()) {
            const color = withAlpha(stop.color);
            entries.push({ hex: hexOf(color), alpha: color.a, name: `${node.name}/${index + 1}` });
          }
        }
      }
    };
    for (const root of selection) {
      collect(root);
      for (const node of await findAllWithCriteria(root, (node2) => true)) collect(node);
    }
    const { swatches, duplicates } = swatchesFromNamedColors(entries);
    const warnings = [];
    if (swatches.length === 0) warnings.push("the selection holds no solid fills");
    if (duplicates > 0) warnings.push(`${duplicates} repeated color(s) in the selection were read once`);
    return { swatches, warnings };
  }
  async function listLibraryCollections() {
    try {
      const available = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      return {
        collections: available.map((collection) => ({
          key: collection.key,
          name: collection.name,
          library: collection.libraryName
        })),
        warnings: available.length === 0 ? ["no libraries are enabled for this file"] : []
      };
    } catch (error) {
      return { collections: [], warnings: [`libraries are unreadable here: ${String(error.message)}`] };
    }
  }
  var isAlias2 = (value) => typeof value === "object" && value !== null && value.type === "VARIABLE_ALIAS";
  var isRgb2 = (value) => typeof value === "object" && value !== null && "r" in value && "g" in value && "b" in value;
  var IMPORT_CHUNK = 50;
  async function swatchesFromLibrary(key, modeName, progress2) {
    var _a, _b;
    const warnings = [];
    let published;
    try {
      published = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(key);
    } catch (error) {
      return { swatches: [], warnings: [`that collection could not be read: ${String(error.message)}`] };
    }
    const colors = published.filter((variable) => variable.resolvedType === "COLOR");
    if (colors.length === 0) return { swatches: [], warnings: ["that collection holds no color variables"] };
    const entries = [];
    let modeId = null;
    let chosenMode = null;
    let aliased = 0;
    for (const [index, candidate] of colors.entries()) {
      if (index % IMPORT_CHUNK === 0) {
        progress2 == null ? void 0 : progress2(`importing library colors\u2026 ${index}/${colors.length}`);
        await yieldToHost();
      }
      const variable = await figma.variables.importVariableByKeyAsync(candidate.key).catch(() => null);
      if (!variable) continue;
      if (modeId === null) {
        const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId).catch(() => null);
        const modes = (_a = collection == null ? void 0 : collection.modes) != null ? _a : [];
        const wanted = modeName ? modes.find((mode2) => mode2.name === modeName) : void 0;
        const fallback = (_b = modes.find((mode2) => mode2.modeId === (collection == null ? void 0 : collection.defaultModeId))) != null ? _b : modes[0];
        const mode = wanted != null ? wanted : fallback;
        if (!mode) continue;
        modeId = mode.modeId;
        chosenMode = mode.name;
        if (modeName && !wanted) warnings.push(`that library has no "${modeName}" mode \u2014 read "${mode.name}" instead`);
      }
      const value = variable.valuesByMode[modeId];
      if (value === void 0) continue;
      if (isAlias2(value)) {
        aliased++;
        continue;
      }
      if (!isRgb2(value)) continue;
      const color = withAlpha(value);
      entries.push({ hex: hexOf(color), alpha: color.a, name: variable.name });
    }
    const { swatches, duplicates } = swatchesFromNamedColors(entries);
    if (chosenMode) warnings.unshift(`read the "${chosenMode}" mode of that collection`);
    if (aliased > 0) warnings.push(`${aliased} alias-valued token(s) skipped \u2014 they point at colors already in the list`);
    if (duplicates > 0) warnings.push(`${duplicates} repeated color(s) were read once`);
    return { swatches, warnings };
  }

  // src/targets/design-md/django-target.ts
  var LINT_RULE_TEXT = {
    "unbound-fill": (n) => `**${n} layer(s) ship a solid fill that is NOT bound to a color variable.** Their literal colors were written into \`project.css\`. Those hex values are not design tokens \u2014 never copy one into new code; use a token from the reference below, or report the gap.`,
    "unbound-stroke": (n) => `**${n} layer(s) ship an unbound stroke color** \u2014 same rule as fills: the literal border colors in \`project.css\` are not tokens.`,
    "text-without-style": (n) => `**${n} text node(s) have no Figma text style**, so their font declarations are one-off literals in \`project.css\` rather than the type scale. Do not treat them as a typographic decision, and do not imitate them in new components.`,
    "missing-auto-layout": (n) => `**${n} frame(s) have no Auto Layout**, so their children exported with absolute positioning. That is a Figma artifact, not a layout choice \u2014 when you touch such a block, re-express it with flex/grid instead of extending the absolute coordinates.`,
    "excessive-nesting": (n) => `**${n} node(s) exceed the nesting threshold** \u2014 the generated markup carries wrapper \`<div>\`s with no semantic meaning. Flatten them when you edit; do not add more.`,
    "bootstrap-component-mismatch": (n) => `**${n} component(s) are named like Bootstrap components but exported as custom partials** (no recognizable variant prop). Do not assume \`.btn\`/\`.card\` markup or Bootstrap JS behaviour exists for them \u2014 read the partial before wiring anything to it.`
  };
  function lintGuardrails(lint) {
    var _a;
    if (!lint) return [];
    if (lint.total === 0) {
      return [
        `The Figma audit of the exported scope (${lint.nodeCount} layer(s)) found no issues \u2014 every fill is bound to a variable, every text node carries a style. Keep the generated code that way.`
      ];
    }
    const rules = [];
    for (const rule of Object.keys(LINT_RULE_TEXT)) {
      const count = (_a = lint.counts[rule]) != null ? _a : 0;
      if (count > 0) rules.push(LINT_RULE_TEXT[rule](count));
    }
    return rules;
  }
  var OWNERSHIP_ROWS = [
    ["`templates/base.html`", "generated (marker-wrapped)", "Skeleton every page extends. Edit only OUTSIDE the `{# GENERATED #}` markers, or override a block in a child template."],
    ["`templates/pages/*.html`", "generated (marker-wrapped)", 'One file per exported top-level frame. `{% extends "base.html" %}` + `{% block content %}`.'],
    ["`templates/components/*.html`", "generated (marker-wrapped)", 'One partial per Figma component, pulled in with `{% include "components/\u2026" with \u2026 only %}`.'],
    ["`static/css/tokens.css`", "generated \u2014 never edit", "Design tokens as CSS custom properties, one block per theme."],
    ["`static/css/*.css` (project)", "generated \u2014 never edit", "Layout/appearance compiled from the Figma nodes. Regenerated wholesale on every export."],
    ["`locale/figma.po`", "generated", "Source strings extracted from the design. Merge into your catalog; never translate in place."],
    ["`export-report.json`", "generated", "Audit trail: who exported, which scope, which modules."],
    ["`COMPONENTS.md`", "generated", "Per-component behaviour contracts from Figma's Component configuration, with previews."],
    ["`previews/*.png`", "generated", "Component master screenshots referenced by COMPONENTS.md."],
    ["`DESIGN.md`", "generated", "This file \u2014 the contract for coding agents."]
  ];
  function packageSection(input) {
    const pkg = input.package;
    const table2 = mdTable(["Path", "Ownership", "What it is"], OWNERSHIP_ROWS);
    const counts = bullet([
      `${pkg.pages.length} page template(s), ${pkg.partials.length} component partial(s).`,
      `Project stylesheet: \`static/${pkg.cssFile}\`.`,
      `${pkg.assetCount} exported asset(s) under \`static/img/\`.` + (pkg.manualAssets.length > 0 ? ` **${pkg.manualAssets.length} asset(s) could not be exported by the Figma API** and must be dropped in by hand at: ${pkg.manualAssets.map((path) => `\`static/${path}\``).join(", ")}.` : ""),
      `Export scope: \`${input.scope.mode}\`${input.scope.frameId ? ` (frame \`${input.scope.frameId}\`)` : ""}. Anything outside that scope is not in this package.`
    ]);
    const pageList = pkg.pages.length > 0 ? `

**Pages**

${pkg.pages.slice(0, 40).map((path) => `- \`templates/${path}\``).join("\n")}` + (pkg.pages.length > 40 ? `
- _+${pkg.pages.length - 40} more_` : "") : "";
    return `${table2}

${counts}${pageList}`;
  }
  function templateSection(input) {
    return "```\n{# GENERATED:BEGIN <figma node id> \u2014 edits outside this block survive regeneration #}\n\u2026generator-owned markup\u2026\n{# GENERATED:END <figma node id> #}\n```\n\n" + bullet([
      "**Everything between the markers is overwritten on the next export.** Put hand-written markup before or after the pair, or in a template that `{% extends %}` the generated one.",
      "A template with no marker at all is never touched by a re-export \u2014 that is the escape hatch for a page you have taken over completely.",
      "Every template carries its own `{% load i18n %}` / `{% load static %}`: `{% load %}` does not propagate across `{% extends %}` or `{% include %}`. Add them to any new template you write.",
      'Pages are `{% extends "base.html" %}` + `{% block content %}`. `base.html` also exposes `{% block framework_css %}` / `{% block framework_js %}`.',
      'Components are included with `{% include "components/<name>--<node id>.html" with \u2026 only %}`. The `--<node id>` suffix is the stable identity \u2014 a rename in Figma changes the readable slug, not the file\'s identity. Do not rename these files.',
      "Reference every asset through `{% static %}` \u2014 never a hardcoded `/static/\u2026` path."
    ]);
  }
  var BOOTSTRAP_RECOGNIZED_SAMPLE = "Button, Badge, Card, Alert, Toast, Navbar, Nav, Tabs, Dropdown, Accordion, Pagination, Breadcrumb, ListGroup, Progress, Spinner, Table, Input, Select, Textarea, Checkbox, Radio, Switch, Range, Upload, Segmented, InputGroup, Offcanvas, Carousel, Collapse";
  var FIDELITY_TEXT = {
    tokens: "Only `--bs-*` variable overrides are emitted. Bootstrap components are NOT used by the generated markup \u2014 layout comes from the project stylesheet.",
    utilities: "Exact-scale layout declarations moved from the stylesheet onto Bootstrap utility classes (`.d-flex`, `.gap-*`, \u2026) in the templates. When you edit layout, prefer the same utilities over new CSS; do not fight an `!important` utility with a custom rule.",
    components: "Recognized Figma components render as native Bootstrap markup (`.btn`, `.card`, modals via the data API). Use Bootstrap's own classes and data attributes for behaviour instead of writing JS.",
    theme: "The Figma kit masters ARE the theme: per-component `--bs-*` sets ship in `static/css/bootstrap-theme.css`. Restyle a component by changing its Bootstrap variables, never by overriding `.btn-primary` in project CSS."
  };
  function bootstrapSection(bootstrap) {
    const rows = bootstrap.matched.map((entry) => [`\`--${entry.slug}\``, `\`${entry.bsVar}\``]);
    const table2 = rows.length > 0 ? mdTable(["Design token", "Bootstrap variable"], rows) : "_No design token matched a Bootstrap variable \u2014 Bootstrap keeps its stock values._";
    const unmatched = bootstrap.unmatched.length > 0 ? `

Not covered by a token (stock Bootstrap values, do not assume they are on-brand): ${bootstrap.unmatched.map((name) => `\`${name}\``).join(", ")}.` : "";
    const recognition = bootstrap.fidelity === "components" || bootstrap.fidelity === "theme" ? `

Only components whose Figma name matches a Bootstrap pattern render as native markup (${BOOTSTRAP_RECOGNIZED_SAMPLE}). Everything else \u2014 steppers, timelines, rating widgets, OTP inputs and any other pattern Bootstrap has no component for \u2014 exports as a custom partial with the design's own CSS. Read the partial before assuming a Bootstrap class or a \`data-bs-*\` behaviour exists on it.` : "";
    return `Bootstrap ${bootstrap.version}, source \`${bootstrap.source}\`, fidelity **\`${bootstrap.fidelity}\`**.

${FIDELITY_TEXT[bootstrap.fidelity]}${recognition}

${table2}${unmatched}

` + bullet([
      "Bootstrap loads inside a CSS cascade layer, so un-layered project CSS wins over Bootstrap declarations regardless of specificity. Do not add `!important` to beat Bootstrap.",
      "Change brand values through `bootstrap.map.json` + `tokens.json` (`altery-dj tokens`) or in Figma \u2014 never by editing `bootstrap-tokens.css`."
    ]);
  }
  function i18nSection(input) {
    if (!input.modules.i18n) {
      return "The i18n module was OFF for this export: template text is literal. If the project is translated, wrap new strings in `{% translate %}` yourself and re-export with i18n enabled.";
    }
    return bullet([
      `${input.i18n.entryCount} source string(s) extracted to \`locale/figma.po\` (source language \`${input.i18n.sourceLanguage}\`).`,
      "Generated text is already wrapped in `{% translate %}` / `{% blocktranslate %}`. **Every new user-visible string you write must be wrapped too.**",
      "Do not translate inside `figma.po` \u2014 merge it into the project catalog (`altery-dj po merge`), then translate there. `figma.po` is regenerated on every export.",
      "Translated text is usually longer than the Figma source: never rely on a fixed width or a single-line assumption for a translatable string."
    ]);
  }
  function motionSection(input) {
    const pkg = input.package;
    const parts = [];
    if (pkg.interactionsCss || pkg.interactionsJs) {
      parts.push(
        "Prototype reactions exported as " + [pkg.interactionsCss ? "`static/css/interactions.css` (hover/press transitions)" : "", pkg.interactionsJs ? "`static/js/interactions.js` (overlay dialogs)" : ""].filter(Boolean).join(" and ") + " \u2014 generated, so add your own behaviour in a separate file."
      );
    }
    if (pkg.animationsCss || pkg.animationsJs) {
      parts.push(
        "Motion timelines exported as " + [pkg.animationsCss ? "`static/css/animations.css`" : "", pkg.animationsJs ? "`static/js/animations.js`" : ""].filter(Boolean).join(" and ") + ". Re-time an animation in Figma, not in the generated file."
      );
    }
    if (input.modules.animation) {
      parts.push("`static/js/motion-tokens.js` exports duration/easing tokens for JS-driven animation.");
    }
    return parts.length > 0 ? bullet(parts) : "";
  }
  var WORKFLOW = bullet([
    "The design source of truth is Figma. To change a generated value, change it in Figma and re-export \u2014 do not patch the generated file.",
    "Apply a fresh export over the project with `altery-dj apply export.zip`, or `altery-dj rebuild export.zip --diff` to merge it while preserving edits outside the `{# GENERATED #}` markers.",
    "Rebuild derived stylesheets from `tokens.json` without a Figma round-trip: `altery-dj tokens --format all`.",
    "Verify a project after an apply: `altery-dj check` (Django system check + a smoke render of every template + `msgfmt` over the locales)."
  ]);
  function buildDjangoDesignMd(input) {
    var _a, _b, _c, _d;
    const model = input.tokens ? buildTokenModel(input.tokens.tree, input.tokens.themes, input.tokens.defaultTheme) : null;
    const contract = bullet([
      "This project is **generated from Figma**. Files inside `{# GENERATED #}` markers and everything under `static/css/` are regenerated on every export \u2014 edits there are lost.",
      input.modules.tokens ? "Style with `var(--token)` from `static/css/tokens.css`. A literal color, spacing, radius, or font value in hand-written code is a bug." : "The tokens module was OFF for this export: there is no `tokens.css`. Take values from the generated project stylesheet and do not invent new ones.",
      "Pick a value by **role** and by **component context**, not by which number looks closest.",
      "If something you need has no token and no generated rule, **stop and report the gap**.",
      "Keep new markup inside the template system: extend `base.html`, include the existing partials, and use `{% static %}` / `{% translate %}`."
    ]);
    const typographyTokenised = model !== null && ((_b = (_a = model.byRole.get("font-size")) == null ? void 0 : _a.length) != null ? _b : 0) > 0;
    const guardrails = [
      ...lintGuardrails(input.lint),
      ...input.tokens ? auditGuardrails(input.tokens.audit) : [],
      ...model ? tokenGuardrails(model) : [],
      ...model && !typographyTokenised ? [
        "Typography is **not tokenized** in this export: font family/size/weight come from the generated project stylesheet, not from `tokens.css`. Reuse an existing generated class instead of inventing font values, and bind the text styles to Figma variables if you want them tokenized."
      ] : [],
      "Never edit `static/css/tokens.css` or the generated project stylesheet \u2014 write your own stylesheet, link it after them, and keep it token-only.",
      "Never hardcode a template path or asset URL: use `{% include %}` / `{% static %}`."
    ];
    const agentPrompt = agentPromptSection({
      role: "an expert Django + frontend engineer working in a project generated from Figma by the Altery exporter",
      steps: [
        "Locate the generated template that owns the UI you are changing (`templates/pages/\u2026` or `templates/components/\u2026`) and read its `{# GENERATED #}` markers before editing anything.",
        'Identify every visual requirement \u2014 surface, text, border, spacing, radius, type, motion \u2014 and map each to a token from the "Token \u2192 CSS property" table.',
        input.bootstrap ? `Respect the Bootstrap fidelity in force (\`${input.bootstrap.fidelity}\`): use the framework's own classes/attributes instead of writing parallel CSS or JS.` : "Express layout with flex/grid in your own stylesheet; do not extend the generated absolute positioning.",
        "Wrap every new user-visible string in `{% translate %}` and every asset reference in `{% static %}`.",
        "Put hand-written changes OUTSIDE the generated markers (or in your own template/stylesheet), then state which tokens you used and which files you touched."
      ],
      never: [
        "Never edit inside a `{# GENERATED:BEGIN \u2026 #}` / `{# GENERATED:END \u2026 #}` block, or any file under `static/css/` that the exporter owns.",
        "Never write a raw hex/rgb/hsl color or a px value that has no matching token.",
        "Never introduce a breakpoint, font weight, or type size that is not listed in DESIGN.md.",
        "Never rename a `components/<name>--<node id>.html` partial \u2014 the node-id suffix is its identity."
      ]
    });
    const sections = [
      ["The contract", contract],
      ["Package layout & ownership", packageSection(input)],
      ["Template system & regeneration", templateSection(input)],
      ["Token \u2192 CSS property (how to apply anything)", model ? roleIndexSection(model) : ""],
      ["Tokens by component / context", model ? componentBlocksSection(model.components) : ""],
      ["Token reference", model ? tokenReferenceSection(model) : ""],
      ["Typography", model ? typographySection(model.typography) : ""],
      ["Themes", model && input.tokens ? themesSection(model, input.tokens.themeAttribute) : ""],
      ["Breakpoints & responsive", model ? breakpointsSection(model, (_c = input.tokens) == null ? void 0 : _c.breakpoints) : ""],
      ["Bootstrap", input.bootstrap ? bootstrapSection(input.bootstrap) : ""],
      ["Component behaviour contracts", componentDocsSection((_d = input.componentDocs) != null ? _d : [])],
      ["Internationalization", i18nSection(input)],
      ["Motion & interactions", motionSection(input)],
      ["Strict guardrails (generated from a Figma audit)", bullet(guardrails)],
      ["Working with this project", WORKFLOW],
      ["Agent prompt", agentPrompt]
    ];
    const intro = "**Read this file before writing or changing any code in this project.** It is the machine-readable contract for a Django project generated from Figma: what is generated (and therefore off-limits), which design tokens exist and where they apply, and what the design audit found.";
    return `${headerSection({ fileName: input.fileName, target: "django", generatedAt: input.generatedAt, intro })}

${renderSections(sections)}
`;
  }

  // src/delivery.ts
  async function deliverPackage(zipBytes, config) {
    if (!config.endpoint) {
      return { ok: false, message: "No delivery endpoint configured." };
    }
    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          "X-Altery-Secret": config.secret,
          "X-Altery-Target": config.target,
          "X-Altery-Route-Repo": config.route.repo,
          "X-Altery-Route-Branch": config.route.branch,
          "X-Altery-Route-Path": config.route.path,
          "X-Altery-Route-Package": config.route.package
        },
        body: zipBytes
      });
      if (!response.ok) {
        const text2 = await response.text().catch(() => "");
        return { ok: false, status: response.status, message: text2 || response.statusText };
      }
      return { ok: true, status: response.status };
    } catch (err) {
      return { ok: false, message: String((err == null ? void 0 : err.message) || err) };
    }
  }

  // src/code.ts
  var remapInventory = null;
  var remapDepth = "document";
  function applyRemapOverrides(plan, overrides) {
    if (!overrides) return plan;
    for (const entry of plan.entries) {
      const forced = overrides[entry.site.id];
      if (!forced) continue;
      const literal = parseColorLiteral(forced);
      if (!literal) continue;
      entry.to = { r: literal.rgba.r, g: literal.rgba.g, b: literal.rgba.b, a: entry.from.a };
      entry.deltaE = deltaE(entry.from, entry.to);
      entry.toName = null;
      entry.via = "nearest";
      entry.flags = entry.flags.filter((flag2) => flag2 !== "unchanged");
      if (!entry.flags.includes("manual")) entry.flags.push("manual");
    }
    return plan;
  }
  async function resolveRemapSource(source) {
    var _a;
    switch (source.kind) {
      case "generator": {
        const settings = normalizePaletteSettings(source.settings);
        return { swatches: swatchesFromPalette(generatePalette(settings)), warnings: [] };
      }
      case "selection": {
        figma.ui.postMessage({ type: "REMAP_PROGRESS", label: "reading the selection\u2026" });
        const result = await swatchesFromSelection();
        return { swatches: result.swatches, warnings: result.warnings };
      }
      case "library": {
        const result = await swatchesFromLibrary(
          source.key,
          (_a = source.mode) != null ? _a : null,
          (label3) => figma.ui.postMessage({ type: "REMAP_PROGRESS", label: label3 })
        );
        return { swatches: result.swatches, warnings: result.warnings };
      }
      default: {
        const parsed = parsePaletteInput(source.text);
        return { swatches: parsed.swatches, warnings: parsed.warnings };
      }
    }
  }
  async function planRemap(source, options, overrides) {
    if (!remapInventory) {
      remapInventory = await readRemapInventory(
        (label3) => figma.ui.postMessage({ type: "REMAP_PROGRESS", label: label3 }),
        remapDepth
      );
    }
    const resolved = await resolveRemapSource(source);
    figma.ui.postMessage({ type: "REMAP_PROGRESS", label: `matching ${resolved.swatches.length} new colors\u2026` });
    const plan = buildRemapPlan({
      sites: remapInventory.sites,
      palette: resolved.swatches,
      primaryModeId: remapInventory.primaryModeId,
      // The plan only needs the pair; the text/boundary distinction belongs to the audit.
      adjacency: remapInventory.adjacency.map((pair2) => [pair2.a, pair2.b]),
      options
    });
    plan.warnings.push(...resolved.warnings);
    return { plan: applyRemapOverrides(plan, overrides), palette: resolved.swatches };
  }
  var REMAP_ROW_LIMIT = 500;
  function remapPlanView(plan) {
    const renamedById = new Map(plan.renames.map((rename) => [rename.siteId, rename]));
    const rank = (entry) => entry.site.kind === "detached" ? 1 : 0;
    const ranked = [...plan.entries].sort((a, b) => {
      const kind = rank(a) - rank(b);
      if (kind !== 0) return kind;
      const moved = Number(a.flags.includes("unchanged")) - Number(b.flags.includes("unchanged"));
      return moved !== 0 ? moved : b.site.usage - a.site.usage;
    });
    const shown = ranked.slice(0, REMAP_ROW_LIMIT);
    return {
      total: plan.entries.length,
      withheld: plan.entries.length - shown.length,
      rows: shown.map((entry) => {
        var _a, _b;
        return {
          id: entry.site.id,
          kind: entry.site.kind,
          name: entry.site.name,
          newName: (_b = (_a = renamedById.get(entry.site.id)) == null ? void 0 : _a.to) != null ? _b : null,
          mode: entry.site.modeName,
          usage: entry.site.usage,
          from: toHex(entry.from),
          fromAlpha: entry.from.a,
          to: toHex(entry.to),
          toAlpha: entry.to.a,
          fromFamily: entry.fromFamily,
          fromStep: entry.fromStep,
          toFamily: entry.toFamily,
          toStep: entry.toStep,
          via: entry.via,
          deltaE: Math.round(entry.deltaE * 10) / 10,
          flags: entry.flags
        };
      }),
      families: plan.families,
      renames: plan.renames,
      unusedFamilies: plan.unusedFamilies,
      warnings: plan.warnings
    };
  }
  function frameworkLinksFrom(options, tokensOn) {
    if (options.targetOptions.framework !== "bootstrap") return null;
    return {
      source: options.targetOptions.bootstrapSource,
      version: options.targetOptions.bootstrapVersion,
      bootstrapTokensCssFile: tokensOn ? "css/bootstrap-tokens.css" : null,
      fidelity: options.targetOptions.bootstrapFidelity
    };
  }
  function defaultRoots() {
    return figma.currentPage.selection.length > 0 ? figma.currentPage.selection : figma.currentPage.children;
  }
  function rootsForScope(scope) {
    if (!scope) return defaultRoots();
    switch (scope.mode) {
      case "selection":
        return figma.currentPage.selection;
      case "frame":
        return figma.currentPage.children.filter((node) => node.id === scope.frameId);
      case "page":
        return figma.currentPage.children;
    }
  }
  async function indexSceneNodes(roots) {
    const index = /* @__PURE__ */ new Map();
    for (const root of roots) {
      index.set(root.id, root);
      const descendants = await findAllWithCriteria(root, (node) => true);
      for (const node of descendants) index.set(node.id, node);
    }
    return index;
  }
  async function addReactionDestinationsToScene(pageRoots, sceneNodesById) {
    const missing = [...collectReactionDestinationIds(pageRoots)].filter((id) => !sceneNodesById.has(id));
    await Promise.all(
      missing.map(async (id) => {
        const node = await figma.getNodeByIdAsync(id);
        if (node && "getCSSAsync" in node) sceneNodesById.set(id, node);
      })
    );
  }
  async function collectThemableSets(sceneNodesById) {
    var _a, _b;
    const setsById = /* @__PURE__ */ new Map();
    for (const node of sceneNodesById.values()) {
      if (node.type !== "INSTANCE") continue;
      try {
        const main = await node.getMainComponentAsync();
        const parent = main == null ? void 0 : main.parent;
        if ((parent == null ? void 0 : parent.type) === "COMPONENT_SET" && !setsById.has(parent.id)) setsById.set(parent.id, parent);
      } catch (e) {
      }
    }
    const sets = [];
    for (const set of setsById.values()) {
      try {
        const kind = (_a = matchBootstrapComponent(set.name, { key: set.key, properties: [] }, (name) => name)) == null ? void 0 : _a.kind;
        if (kind !== "button") continue;
        const variants = [];
        for (const child of set.children) {
          if (child.type !== "COMPONENT") continue;
          const css = await child.getCSSAsync();
          const smoothing = (_b = child.cornerSmoothing) != null ? _b : 0;
          if (smoothing > 0 && css["border-radius"]) css["border-radius"] = scaleBorderRadius(css["border-radius"], smoothing);
          const label3 = child.findOne((descendant) => descendant.type === "TEXT");
          const labelCss = label3 ? await label3.getCSSAsync() : null;
          variants.push({ name: child.name, css, labelCss });
        }
        if (variants.length > 0) sets.push({ kind, setName: set.name, variants });
      } catch (e) {
      }
    }
    return sets;
  }
  function hasFigmaMotionApi() {
    return Boolean(figma.motion);
  }
  function collectMotionExportNodes(sceneNodesById) {
    const nodes = [];
    for (const node of sceneNodesById.values()) {
      const snapshot = readMotionData(node);
      if (snapshot && snapshot.tracks.length > 0) nodes.push({ nodeId: node.id, snapshot });
    }
    return nodes;
  }
  function buildMotionExport(sceneNodesById, modules) {
    if (!modules.animation || !hasFigmaMotionApi()) return EMPTY_MOTION_EXPORT_ARTIFACTS;
    return emitMotionExportArtifacts(collectMotionExportNodes(sceneNodesById));
  }
  async function extractAllStrings(roots) {
    const catalog = /* @__PURE__ */ new Map();
    for (const root of roots) {
      for (const entry of await extractStrings(root)) {
        const key = translationKey(entry.msgctxt, entry.msgid);
        const existing = catalog.get(key);
        if (existing) {
          existing.references.push(...entry.references);
          existing.nodeIds.push(...entry.nodeIds);
          if (!existing.comment.includes(entry.comment)) existing.comment += `; ${entry.comment}`;
          continue;
        }
        catalog.set(key, entry);
      }
    }
    return [...catalog.values()];
  }
  var lastScanIndex = /* @__PURE__ */ new Map();
  function serializeBoundVars(bv) {
    const out = {};
    if (typeof bv !== "object" || bv === null) return out;
    const fields = ["fontFamily", "fontStyle", "fontWeight", "fontSize", "letterSpacing", "lineHeight", "paragraphSpacing", "paragraphIndent"];
    for (const field of fields) {
      const raw = bv[field];
      const b = Array.isArray(raw) ? raw[0] : raw;
      if (typeof b === "object" && b !== null && typeof b.id === "string") {
        out[field] = b.id;
      }
    }
    return out;
  }
  var fontKey = (f) => `${f.family}\0${f.style}`;
  async function probeFontFacts(styles) {
    const facts = /* @__PURE__ */ new Map();
    const fonts = /* @__PURE__ */ new Map();
    for (const s of styles) {
      if (!s.fontName || typeof s.fontName.family !== "string") continue;
      fonts.set(fontKey(s.fontName), { family: s.fontName.family, style: s.fontName.style });
    }
    if (fonts.size === 0 || figma.editorType === "dev") return facts;
    let probe = null;
    try {
      probe = figma.createText();
      probe.name = "[altery] font probe";
      probe.visible = false;
      for (const [key, fontName] of fonts) {
        try {
          await figma.loadFontAsync(fontName);
          probe.fontName = fontName;
          probe.characters = "A";
          const segment = probe.getStyledTextSegments(["fontWeight", "fontStyle"])[0];
          const weight = segment ? segment.fontWeight : probe.fontWeight;
          if (typeof weight === "number" && isFinite(weight) && weight > 0) {
            facts.set(key, { weight, italic: segment ? segment.fontStyle === "ITALIC" : false });
          }
        } catch (e) {
        }
      }
    } catch (e) {
    } finally {
      if (probe) {
        try {
          probe.remove();
        } catch (e) {
        }
      }
    }
    return facts;
  }
  async function readGraph() {
    const [collections, variables, textStyles, effectStyles] = await Promise.all([
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync(),
      typeof figma.getLocalTextStylesAsync === "function" ? figma.getLocalTextStylesAsync() : Promise.resolve([]),
      typeof figma.getLocalEffectStylesAsync === "function" ? figma.getLocalEffectStylesAsync() : Promise.resolve([])
    ]);
    const fontFacts = await probeFontFacts(textStyles);
    const graph = foldSplitThemeCollections({
      fileName: figma.root.name,
      collections: collections.map((c) => {
        let generated = false;
        try {
          generated = c.getPluginData("altery-typo-collection") === "1";
        } catch (e) {
        }
        return {
          id: c.id,
          name: c.name,
          defaultModeId: c.defaultModeId,
          modes: (c.modes || []).map((m) => ({ modeId: m.modeId, name: m.name })),
          generated
        };
      }),
      variables: variables.map((v) => ({
        id: v.id,
        name: v.name,
        collectionId: v.variableCollectionId,
        resolvedType: v.resolvedType,
        valuesByMode: v.valuesByMode,
        // Scopes are the designer's own "where may this be applied" — DESIGN.md prefers them over
        // guessing the role from the token name.
        scopes: v.scopes
      })),
      textStyles: textStyles.map((t) => {
        var _a, _b;
        return {
          id: t.id,
          name: t.name,
          fontName: t.fontName ? { family: t.fontName.family, style: t.fontName.style } : null,
          fontWeight: t.fontName ? (_a = fontFacts.get(fontKey(t.fontName))) == null ? void 0 : _a.weight : void 0,
          italic: t.fontName ? (_b = fontFacts.get(fontKey(t.fontName))) == null ? void 0 : _b.italic : void 0,
          fontSize: t.fontSize,
          lineHeight: t.lineHeight,
          letterSpacing: t.letterSpacing,
          paragraphSpacing: t.paragraphSpacing,
          paragraphIndent: t.paragraphIndent,
          boundVariables: serializeBoundVars(t.boundVariables)
        };
      }),
      // Shadows/blurs live in effect styles, not variables — without this pass a focus ring or an
      // elevation scale never reaches the token package at all.
      effectStyles: effectStyles.map((style) => ({
        id: style.id,
        name: style.name,
        effects: (style.effects || []).map((effect) => {
          const shadow = effect;
          return {
            type: effect.type,
            color: shadow.color ? { r: shadow.color.r, g: shadow.color.g, b: shadow.color.b, a: shadow.color.a } : null,
            offset: shadow.offset ? { x: shadow.offset.x, y: shadow.offset.y } : null,
            radius: effect.radius,
            spread: shadow.spread,
            visible: effect.visible
          };
        })
      }))
    });
    return graph;
  }
  var PREVIEW_MAX_WIDTH = 1600;
  var PREVIEW_MAX_SCALE = 2;
  function previewScale(width) {
    if (!isFinite(width) || width <= 0) return 1;
    return Math.max(0.25, Math.min(PREVIEW_MAX_SCALE, PREVIEW_MAX_WIDTH / width));
  }
  function previewPath(name, id) {
    const slug2 = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `previews/${slug2 || "component"}--${id.replace(/[^a-zA-Z0-9]+/g, "-")}.png`;
  }
  function componentPropertiesOf(node) {
    var _a;
    let definitions = {};
    try {
      definitions = (_a = node.componentPropertyDefinitions) != null ? _a : {};
    } catch (e) {
      return [];
    }
    return Object.keys(definitions).map((rawName) => {
      const definition = definitions[rawName];
      return {
        // Figma suffixes non-variant props with `#<id>`; the designer never sees that part.
        name: rawName.split("#")[0].trim(),
        type: definition.type,
        options: definition.variantOptions ? [...definition.variantOptions] : void 0,
        defaultValue: definition.defaultValue === void 0 ? void 0 : String(definition.defaultValue)
      };
    });
  }
  function isDocumentableComponent(node) {
    var _a;
    if (node.type === "COMPONENT_SET") return true;
    return node.type === "COMPONENT" && ((_a = node.parent) == null ? void 0 : _a.type) !== "COMPONENT_SET";
  }
  async function collectComponentDocs(withPreviews, budgetMb, nodes) {
    var _a;
    const budgetBytes = Math.max(1, budgetMb) * 1024 * 1024;
    const files = {};
    let targets;
    if (nodes) {
      targets = [...nodes];
    } else {
      try {
        await figma.loadAllPagesAsync();
      } catch (e) {
      }
      targets = figma.root.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] }).filter(isDocumentableComponent);
    }
    const pageNameById = /* @__PURE__ */ new Map();
    const pageOf = (node) => {
      let current = node;
      while (current && current.type !== "PAGE") current = current.parent;
      if (!current) return void 0;
      if (!pageNameById.has(current.id)) pageNameById.set(current.id, current.name);
      return pageNameById.get(current.id);
    };
    let previewBytes = 0;
    let previewCount = 0;
    const docs = [];
    for (const node of targets) {
      let description = "";
      let links = [];
      try {
        description = (node.descriptionMarkdown || node.description || "").trim();
        links = ((_a = node.documentationLinks) != null ? _a : []).map((link) => link.uri).filter(Boolean);
      } catch (e) {
      }
      const doc = {
        id: node.id,
        name: node.name,
        page: pageOf(node),
        description,
        links,
        properties: componentPropertiesOf(node),
        variantCount: node.type === "COMPONENT_SET" ? node.children.length : void 0
      };
      if (withPreviews) {
        if (previewBytes >= budgetBytes) {
          doc.previewError = `the ${budgetMb} MB preview budget for this export was already spent \u2014 raise it in Settings \u2192 Documentation`;
        } else {
          try {
            const bytes = await node.exportAsync({
              format: "PNG",
              constraint: { type: "SCALE", value: previewScale(node.width) }
            });
            const path = previewPath(node.name, node.id);
            files[path] = bytes;
            previewBytes += bytes.length;
            previewCount++;
            doc.preview = path;
          } catch (error) {
            doc.previewError = error instanceof Error ? error.message : String(error);
          }
        }
      }
      docs.push(doc);
      if (withPreviews) {
        figma.ui.postMessage({ type: "COMPONENT_PREVIEW_PROGRESS", done: docs.length, total: targets.length });
      }
      if (docs.length % 10 === 0) await yieldToHost();
    }
    return { docs, files };
  }
  var TYPO_COLLECTION_PLUGIN_KEY = "altery-typo-collection";
  function createTypographyVariable(name, collection, type) {
    try {
      return figma.variables.createVariable(name, collection, type);
    } catch (e) {
      return figma.variables.createVariable(name, collection.id, type);
    }
  }
  async function generateTypographyVariables(options) {
    if (figma.editorType === "dev") throw new Error("Switch to Design mode \u2014 Dev Mode can't create variables.");
    const graph = await readGraph();
    const opts = normalizeExportOptions(options);
    const plan = planTypographyVariables(graph, { typoNaming: opts.tokens.typoNaming });
    if (plan.variables.length === 0) throw new Error("No text styles with bindable values found.");
    let replaced = 0;
    for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
      let mine = false;
      try {
        mine = c.getPluginData(TYPO_COLLECTION_PLUGIN_KEY) === "1";
      } catch (e) {
      }
      if (mine) {
        try {
          c.remove();
          replaced++;
        } catch (e) {
        }
      }
    }
    const collection = figma.variables.createVariableCollection(plan.collectionName);
    try {
      collection.setPluginData(TYPO_COLLECTION_PLUGIN_KEY, "1");
    } catch (e) {
    }
    const modeId = collection.modes[0].modeId;
    const byName = {};
    for (const spec of plan.variables) {
      const v = createTypographyVariable(spec.name, collection, spec.type);
      v.setValueForMode(modeId, spec.value);
      try {
        v.scopes = spec.scopes;
      } catch (e) {
      }
      byName[spec.name] = v;
    }
    const styleById = {};
    const localStyles = await figma.getLocalTextStylesAsync();
    for (const s of localStyles) styleById[s.id] = s;
    for (const s of localStyles) {
      if (!s.fontName) continue;
      try {
        await figma.loadFontAsync(s.fontName);
      } catch (e) {
      }
    }
    let bound = 0, failed = 0;
    const failures = [];
    for (const b of plan.bindings) {
      const style = styleById[b.styleId], variable = byName[b.varName];
      if (!style || !variable) {
        failed++;
        continue;
      }
      const field = b.field;
      const before = style.fontName ? { family: style.fontName.family, style: style.fontName.style } : null;
      try {
        style.setBoundVariable(field, variable);
        const after = style.fontName;
        if (before && after && (after.family !== before.family || after.style !== before.style)) {
          style.setBoundVariable(field, null);
          try {
            style.fontName = before;
          } catch (e) {
          }
          failed++;
          if (failures.length < 8) failures.push(`${b.styleName} \xB7 ${b.field}: would change ${before.family} ${before.style} \u2192 ${after.family} ${after.style}`);
          continue;
        }
        bound++;
      } catch (e) {
        failed++;
        if (failures.length < 8) failures.push(`${b.styleName} \xB7 ${b.field}: ${String((e == null ? void 0 : e.message) || e)}`);
      }
    }
    return { collection: plan.collectionName, created: plan.variables.length, bound, failed, failures, replaced };
  }
  figma.showUI(__html__, { width: 420, height: 660, themeColors: true });
  var isRelaunch = figma.command === "reexport";
  Promise.all([
    figma.clientStorage.getAsync("exportOptions"),
    figma.clientStorage.getAsync("userPresets"),
    figma.clientStorage.getAsync("paletteSettings")
  ]).then(([storedOptions, storedPresets, storedPalette]) => {
    figma.ui.postMessage({
      type: "EXPORT_OPTIONS",
      options: normalizeExportOptions(storedOptions),
      presets: EXPORT_PRESETS,
      userPresets: normalizeUserPresets(storedPresets)
    });
    const paletteSettings = normalizePaletteSettings(storedPalette);
    figma.ui.postMessage({
      type: "PALETTE_PREVIEW",
      palette: generatePalette(paletteSettings),
      settings: paletteSettings
    });
  });
  function topLevelAncestorOf(node) {
    let current = node;
    while (current.parent && current.parent.type !== "PAGE") current = current.parent;
    return current;
  }
  function postSelectionToUi() {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) return;
    const node = selection[0];
    const top = topLevelAncestorOf(node);
    figma.ui.postMessage({
      type: "SELECTION_CHANGED",
      nodeId: node.id,
      isText: node.type === "TEXT",
      topLevelFrameId: top.type === "FRAME" ? top.id : null
    });
  }
  figma.on("selectionchange", postSelectionToUi);
  figma.ui.onmessage = async (msg) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r;
    switch (msg.type) {
      /* ---- design-tokens target ---- */
      case "SCAN_TOKENS": {
        try {
          const graph = await readGraph();
          const stored = await figma.clientStorage.getAsync("exportOptions");
          const options = normalizeExportOptions(stored);
          const docsOptions = __spreadValues(__spreadValues({}, options.docs), (_a = msg.docs) != null ? _a : {});
          const componentDocs = docsOptions.componentDocs ? await collectComponentDocs(docsOptions.componentPreviews, docsOptions.previewBudgetMb) : { docs: [], files: {} };
          const artifacts = buildDesignTokens(graph, options, void 0, componentDocs.docs, readRenameMap());
          for (const path of Object.keys(componentDocs.files)) artifacts.files[path] = componentDocs.files[path];
          artifacts.summary.componentCount = componentDocs.docs.length;
          artifacts.summary.previewCount = Object.keys(componentDocs.files).length;
          if (docsOptions.componentPreviews && Object.keys(componentDocs.files).length === 0) {
            const reason = (_b = componentDocs.docs.find((doc) => doc.previewError)) == null ? void 0 : _b.previewError;
            artifacts.summary.previewError = reason != null ? reason : "no components found to capture";
          }
          figma.ui.postMessage({ type: "TOKENS_RESULT", summary: artifacts.summary, files: artifacts.files, options });
        } catch (err) {
          figma.ui.postMessage({ type: "TOKENS_ERROR", message: String((err == null ? void 0 : err.message) || err) });
        }
        break;
      }
      case "DELIVER": {
        try {
          const stored = await figma.clientStorage.getAsync("exportOptions");
          const options = normalizeExportOptions(stored);
          const zipBytes = figma.base64Decode(msg.zipBase64);
          const result = await deliverPackage(zipBytes, {
            endpoint: options.delivery.endpoint,
            secret: options.delivery.secret,
            target: "folder",
            route: { repo: "", branch: "", path: "", package: "" },
            onChange: false,
            onOpen: false
          });
          figma.ui.postMessage(__spreadValues({ type: "DELIVERY_RESULT" }, result));
        } catch (err) {
          figma.ui.postMessage({ type: "DELIVERY_ERROR", message: String((err == null ? void 0 : err.message) || err) });
        }
        break;
      }
      case "GENERATE_TYPOGRAPHY": {
        try {
          const stored = await figma.clientStorage.getAsync("exportOptions");
          const report = await generateTypographyVariables(normalizeExportOptions(stored));
          figma.notify(`Created ${report.created} variables \xB7 bound ${report.bound} field(s)` + (report.failed ? ` \xB7 ${report.failed} failed` : ""));
          figma.ui.postMessage({ type: "TYPOGRAPHY_GENERATED", report });
        } catch (err) {
          const message = String((err == null ? void 0 : err.message) || err);
          figma.notify("Generate failed: " + message);
          figma.ui.postMessage({ type: "TYPOGRAPHY_ERROR", message });
        }
        break;
      }
      /* ---- DS Tools target ---- */
      case "PREVIEW_PALETTE": {
        const settings = normalizePaletteSettings(msg.settings);
        figma.ui.postMessage({ type: "PALETTE_PREVIEW", palette: generatePalette(settings), settings });
        break;
      }
      case "SUGGEST_SPECTRUM": {
        const settings = normalizePaletteSettings(msg.settings);
        figma.ui.postMessage({ type: "SPECTRUM_SUGGESTED", spectrum: suggestHarmoniousSpectrum(settings) });
        break;
      }
      case "FIX_PALETTE": {
        const fix = normalizePaletteFix(msg.fix);
        if (!fix) break;
        const settings = applyPaletteFix(normalizePaletteSettings(msg.settings), fix);
        await figma.clientStorage.setAsync("paletteSettings", settings);
        figma.ui.postMessage({ type: "PALETTE_FIXED", palette: generatePalette(settings), settings });
        break;
      }
      case "SAVE_PALETTE_SETTINGS": {
        await figma.clientStorage.setAsync("paletteSettings", normalizePaletteSettings(msg.settings));
        break;
      }
      case "APPLY_PALETTE": {
        try {
          const settings = normalizePaletteSettings(msg.settings);
          const options = __spreadValues(__spreadValues({}, DEFAULT_APPLY_OPTIONS), (_c = msg.applyOptions) != null ? _c : {});
          const report = await applyPalette(generatePalette(settings), options);
          await figma.clientStorage.setAsync("paletteSettings", settings);
          const parts = [];
          if (options.variables) parts.push(`${report.created} new \xB7 ${report.updated} updated variables`);
          if (report.themeRoles) parts.push(`${report.themeRoles} theme roles`);
          if (report.swatches) parts.push(`${report.swatches} swatches`);
          figma.notify(parts.join(" \xB7 ") || "Nothing selected to generate");
          figma.ui.postMessage({ type: "PALETTE_APPLIED", report });
        } catch (err) {
          const message = String((err == null ? void 0 : err.message) || err);
          figma.notify("Palette failed: " + message);
          figma.ui.postMessage({ type: "PALETTE_ERROR", message });
        }
        break;
      }
      /* ---- DS Tools: color token remapping ---- */
      case "REMAP_SCAN": {
        try {
          remapInventory = await readRemapInventory(
            (label3) => figma.ui.postMessage({ type: "REMAP_PROGRESS", label: label3 }),
            (_d = msg.depth) != null ? _d : "document"
          );
          remapDepth = (_e = msg.depth) != null ? _e : "document";
          figma.ui.postMessage({
            type: "REMAP_INVENTORY",
            stats: remapInventory.stats,
            modes: remapInventory.modes,
            sites: remapInventory.sites.length,
            adjacency: remapInventory.adjacency.length,
            warnings: remapInventory.warnings,
            canRevert: hasRemapSnapshot()
          });
        } catch (err) {
          figma.ui.postMessage({ type: "REMAP_ERROR", message: String((err == null ? void 0 : err.message) || err) });
        }
        break;
      }
      case "REMAP_LIST_LIBRARIES": {
        const result = await listLibraryCollections();
        figma.ui.postMessage({ type: "REMAP_LIBRARIES", collections: result.collections, warnings: result.warnings });
        break;
      }
      case "REMAP_PREVIEW": {
        try {
          const { plan, palette } = await planRemap(msg.source, msg.options, msg.overrides);
          figma.ui.postMessage(__spreadProps(__spreadValues({ type: "REMAP_PLAN" }, remapPlanView(plan)), { paletteSize: palette.length }));
        } catch (err) {
          figma.ui.postMessage({ type: "REMAP_ERROR", message: String((err == null ? void 0 : err.message) || err) });
        }
        break;
      }
      case "REMAP_APPLY": {
        try {
          const { plan } = await planRemap(msg.source, msg.options, msg.overrides);
          const options = __spreadValues(__spreadValues({}, DEFAULT_REMAP_APPLY_OPTIONS), (_f = msg.applyOptions) != null ? _f : {});
          const audit = remapInventory ? auditContrast(plan, remapInventory.adjacency) : { findings: [], checked: 0, improved: 0 };
          const report = await applyRemap(
            plan,
            options,
            (label3) => figma.ui.postMessage({ type: "REMAP_PROGRESS", label: label3 })
          );
          let board = null;
          if (msg.board) {
            try {
              board = await drawRemapBoard(plan);
            } catch (err) {
              report.warnings.push("the canvas board could not be drawn: " + String((err == null ? void 0 : err.message) || err));
            }
          }
          remapInventory = null;
          figma.notify(
            [
              report.values ? `${report.values} values` : "",
              report.renamed ? `${report.renamed} renamed` : "",
              report.legacy ? `${report.legacy} parked in legacy/` : ""
            ].filter(Boolean).join(" \xB7 ") || "Nothing to write"
          );
          figma.ui.postMessage({
            type: "REMAP_APPLIED",
            report,
            board,
            audit: {
              checked: audit.checked,
              improved: audit.improved,
              findings: audit.findings.slice(0, 30).map(describeContrast),
              total: audit.findings.length
            },
            canRevert: hasRemapSnapshot()
          });
        } catch (err) {
          const message = String((err == null ? void 0 : err.message) || err);
          figma.notify("Remap failed: " + message, { error: true });
          figma.ui.postMessage({ type: "REMAP_ERROR", message });
        }
        break;
      }
      case "REMAP_REVERT": {
        try {
          const report = await revertRemap((label3) => figma.ui.postMessage({ type: "REMAP_PROGRESS", label: label3 }));
          remapInventory = null;
          figma.notify(`Reverted ${report.values} values` + (report.names ? ` and ${report.names} names` : ""));
          figma.ui.postMessage({ type: "REMAP_REVERTED", report, canRevert: hasRemapSnapshot() });
        } catch (err) {
          figma.ui.postMessage({ type: "REMAP_ERROR", message: String((err == null ? void 0 : err.message) || err) });
        }
        break;
      }
      case "REMAP_EXPORT_MAPPING": {
        try {
          const { plan } = await planRemap(msg.source, msg.options, msg.overrides);
          const mapping = buildMappingFile(plan, { file: figma.root.name, palette: msg.source.kind });
          figma.ui.postMessage({
            type: "REMAP_MAPPING",
            format: msg.format,
            name: msg.format === "csv" ? "mapping.csv" : "mapping.json",
            content: msg.format === "csv" ? toCsv(mapping) : JSON.stringify(mapping, null, 2)
          });
        } catch (err) {
          figma.ui.postMessage({ type: "REMAP_ERROR", message: String((err == null ? void 0 : err.message) || err) });
        }
        break;
      }
      case "REMAP_REWRITE_FILES": {
        try {
          const { plan } = await planRemap(msg.source, msg.options, msg.overrides);
          const mapping = buildMappingFile(plan, { file: figma.root.name, palette: msg.source.kind });
          const settings = { snap: (_g = msg.snap) != null ? _g : 2, byName: (_h = msg.byName) != null ? _h : false, mode: (_i = msg.mode) != null ? _i : null };
          let replaced = 0;
          let untouched = 0;
          const warnings = /* @__PURE__ */ new Set();
          const files = msg.files.map((file) => {
            const result = rewriteColors(file.text, mapping, settings);
            replaced += result.replacements.length;
            untouched += result.untouched;
            for (const warning of result.warnings) warnings.add(warning);
            return {
              name: file.name,
              text: result.text,
              changed: result.replacements.length,
              // Enough for a report a human reads, not the whole edit list for a big file.
              lines: result.replacements.slice(0, 40).map((entry) => `${file.name}:${entry.line}:${entry.column}  ${entry.from} \u2192 ${entry.to}` + (entry.snapped ? "  [snapped]" : "") + (entry.via === "name" ? "  [by name]" : ""))
            };
          });
          figma.ui.postMessage({
            type: "REMAP_REWRITTEN",
            files,
            replaced,
            untouched,
            warnings: [...warnings]
          });
        } catch (err) {
          figma.ui.postMessage({ type: "REMAP_ERROR", message: String((err == null ? void 0 : err.message) || err) });
        }
        break;
      }
      /* ---- shared ---- */
      case "READ_VARIABLES": {
        const data = await readAllVariables();
        figma.ui.postMessage({ type: "VARIABLES_SNAPSHOT", data });
        break;
      }
      case "EMIT_TOKENS": {
        const [snapshot, stored] = await Promise.all([
          readAllVariables(),
          figma.clientStorage.getAsync("exportOptions")
        ]);
        const css = emitTokenArtifacts(snapshot, tokenEmitOptionsFrom(normalizeExportOptions(stored), readRenameMap())).css;
        figma.ui.postMessage({ type: "TOKENS_CSS", css });
        break;
      }
      case "SYNC_BREAKPOINT_FRAMES": {
        const snapshot = await readAllVariables();
        const breakpointTokens = extractBreakpointTokens2(snapshot);
        const namedWidths = __spreadValues({ desktop: 1280, tablet: 768, mobile: 375 }, Object.fromEntries(breakpointTokens));
        let resized = 0;
        for (const node of figma.currentPage.children) {
          if (node.type !== "FRAME") continue;
          const parsed = parseBreakpointName(node.name, namedWidths);
          if (!parsed) continue;
          if (parsed.width !== node.width) {
            node.resize(parsed.width, node.height);
            resized++;
          }
        }
        figma.ui.postMessage({ type: "BREAKPOINT_FRAMES_SYNCED", resized, tokens: Object.fromEntries(breakpointTokens) });
        break;
      }
      case "GENERATE_BREAKPOINT_COLLECTION": {
        try {
          const result = await generateBreakpointCollection(msg.breakpoints);
          figma.ui.postMessage(__spreadValues({ type: "BREAKPOINT_COLLECTION_GENERATED" }, result));
        } catch (err) {
          figma.ui.postMessage({
            type: "BREAKPOINT_COLLECTION_ERROR",
            message: err instanceof Error ? err.message : String(err)
          });
        }
        break;
      }
      /* ---- django target ---- */
      case "EMIT_DJANGO": {
        const roots = rootsForScope(msg.scope);
        const [irNodes, sceneNodesById, snapshot] = await Promise.all([
          Promise.all(roots.map((root) => serializeNode(root))),
          indexSceneNodes(roots),
          readAllVariables()
        ]);
        const nodes = irNodes.filter((node) => node !== null);
        const variableNamesById = new Map(snapshot.variables.map((variable) => [variable.id, variable.name]));
        await annotateVectorLeaves(nodes, sceneNodesById);
        const { html, css } = await emitDjango(nodes, sceneNodesById, variableNamesById, { cssFile: msg.cssFile });
        figma.ui.postMessage({ type: "DJANGO_TEMPLATE", html, css });
        break;
      }
      case "EMIT_DJANGO_PROJECT": {
        const roots = rootsForScope(msg.scope);
        const [irNodes, sceneNodesById, snapshot] = await Promise.all([
          Promise.all(roots.map((root) => serializeNode(root))),
          indexSceneNodes(roots),
          readAllVariables()
        ]);
        const pageRoots = irNodes.filter((node) => node !== null && node.type === "container");
        const variableNamesById = new Map(snapshot.variables.map((variable) => [variable.id, variable.name]));
        await annotateVectorLeaves(pageRoots, sceneNodesById);
        await addReactionDestinationsToScene(pageRoots, sceneNodesById);
        const previewOptions = normalizeExportOptions(await figma.clientStorage.getAsync("exportOptions"));
        const tokensOn = previewOptions.modules.tokens;
        const previewThemeSets = previewOptions.targetOptions.framework === "bootstrap" && previewOptions.targetOptions.bootstrapFidelity === "theme" ? await collectThemableSets(sceneNodesById) : void 0;
        const previewBreakpointTokens = extractBreakpointTokens2(snapshot);
        const { baseHtml, pages, partials, css, interactionsCss, interactionsJs, themeCss, fileNodeIds } = await emitDjangoProject(
          pageRoots,
          sceneNodesById,
          variableNamesById,
          {
            cssFile: msg.cssFile,
            tokensCssFile: tokensOn ? "css/tokens.css" : null,
            framework: frameworkLinksFrom(previewOptions, tokensOn),
            themeSets: previewThemeSets,
            breakpointTokens: previewBreakpointTokens
          }
        );
        const freshFiles = new Map(
          Object.entries(__spreadValues(__spreadValues({ "base.html": baseHtml }, pages), partials)).map(([path, content]) => [
            path,
            { nodeId: fileNodeIds[path], content }
          ])
        );
        const existingFiles = new Map(Object.entries((_j = msg.existingFiles) != null ? _j : {}));
        const plan = planRegeneration(existingFiles, freshFiles);
        let tokensCss;
        let bootstrapTokensCss;
        if (tokensOn) {
          const tokenEmitOptions = tokenEmitOptionsFrom(previewOptions, readRenameMap());
          const tokenArtifacts = emitTokenArtifacts(snapshot, tokenEmitOptions);
          tokensCss = tokenArtifacts.css;
          if (previewOptions.targetOptions.framework === "bootstrap") {
            const bootstrap = emitBootstrapArtifacts(
              tokenArtifacts.source,
              { ordered: tokenArtifacts.themes, defaultTheme: tokenArtifacts.defaultTheme },
              { themeAttribute: tokenEmitOptions.themeAttribute }
            );
            if (bootstrap.css) bootstrapTokensCss = bootstrap.css;
          }
        }
        const staticFiles = buildRegenStaticFiles({ interactionsCss, interactionsJs, tokensCss, bootstrapTokensCss, themeCss });
        figma.ui.postMessage({ type: "DJANGO_PROJECT_PLAN", css, cssFile: msg.cssFile, plan, staticFiles });
        break;
      }
      case "SCAN": {
        const roots = rootsForScope(msg.scope);
        const index = await indexSceneNodes(roots);
        lastScanIndex = index;
        const frames = figma.currentPage.children.filter((node) => node.type === "FRAME").map((node) => ({ id: node.id, name: node.name }));
        const textNodes = [];
        for (const node of index.values()) {
          if (node.type !== "TEXT") continue;
          textNodes.push({ id: node.id, name: node.name, characters: node.characters });
          if (textNodes.length % 200 === 0) await yieldToHost();
        }
        const lintMaxDepth = typeof msg.lintMaxDepth === "number" ? msg.lintMaxDepth : normalizeExportOptions(await figma.clientStorage.getAsync("exportOptions")).lint.maxNestingDepth;
        const lint = await lintScopeAsync(roots, { maxNestingDepth: lintMaxDepth });
        await annotateUnfixableFindings(lint, index);
        const videoAssets = [];
        for (const node of index.values()) {
          const fills = "fills" in node ? node.fills : void 0;
          if (Array.isArray(fills) && fills.some((f) => f.type === "VIDEO" && f.visible !== false)) {
            videoAssets.push({ nodeId: node.id, name: node.name, assetSrc: `img/${videoFilename(node.id, node.name)}` });
          }
        }
        figma.ui.postMessage({ type: "SCAN_RESULT", frames, textNodes, lint, nodeCount: index.size, videoAssets });
        postSelectionToUi();
        break;
      }
      case "SCAN_TOP": {
        const frames = figma.currentPage.children.filter((node) => node.type === "FRAME").map((node) => ({ id: node.id, name: node.name }));
        figma.ui.postMessage({
          type: "SCAN_TOP_RESULT",
          frames,
          topLevelCount: figma.currentPage.children.length,
          relaunch: isRelaunch
        });
        postSelectionToUi();
        break;
      }
      case "SCROLL_INTO_VIEW": {
        const node = (_k = lastScanIndex.get(msg.nodeId)) != null ? _k : await figma.getNodeByIdAsync(msg.nodeId);
        if (node && "visible" in node) {
          const target = node;
          figma.viewport.scrollAndZoomIntoView([target]);
          try {
            figma.currentPage.selection = [target];
          } catch (e) {
          }
        }
        break;
      }
      case "FIX_LINT": {
        figma.commitUndo();
        const total = msg.findings.length;
        const results = [];
        const progress2 = (label3) => figma.ui.postMessage({ type: "LINT_FIX_PROGRESS", done: results.length, total, label: label3 });
        const ctx = await buildFixContext(progress2);
        try {
          for (const request of msg.findings) {
            const cached = lastScanIndex.get(request.nodeId);
            const node = cached && !cached.removed ? cached : await figma.getNodeByIdAsync(request.nodeId).catch(() => null);
            if (!node || node.removed) {
              results.push({
                nodeId: request.nodeId,
                nodeName: request.nodeId,
                rule: request.rule,
                status: "failed",
                detail: "node no longer exists (an earlier fix may have replaced it) \u2014 re-scan the scope"
              });
            } else {
              results.push(await applyLintFix(node, request.rule, ctx));
            }
            progress2();
            if (results.length % 10 === 0) await yieldToHost();
          }
        } finally {
          figma.commitUndo();
          figma.ui.postMessage({ type: "LINT_FIX_RESULT", results });
        }
        break;
      }
      case "LOAD_ANNOTATION_PANEL": {
        const node = lastScanIndex.get(msg.nodeId);
        if (!node || node.type !== "TEXT") break;
        const resolved = await resolveKey(node);
        const form = loadAnnotationForm(node);
        const html = renderAnnotationPanel(form, {
          boundVariableName: resolved.source === "variable" ? resolved.variableName : void 0
        });
        figma.ui.postMessage({ type: "ANNOTATION_PANEL", nodeId: msg.nodeId, html });
        break;
      }
      case "SET_ANNOTATION": {
        const node = lastScanIndex.get(msg.nodeId);
        if (!node || node.type !== "TEXT") break;
        try {
          applyAnnotationForm(node, msg.form);
          figma.ui.postMessage({ type: "ANNOTATION_SAVED", nodeId: msg.nodeId });
        } catch (error) {
          figma.ui.postMessage({
            type: "ANNOTATION_ERROR",
            nodeId: msg.nodeId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        break;
      }
      case "SAVE_EXPORT_OPTIONS": {
        const stored = await figma.clientStorage.getAsync("exportOptions");
        await figma.clientStorage.setAsync("exportOptions", mergeExportOptions(stored, msg.options));
        break;
      }
      case "SAVE_USER_PRESET": {
        const stored = normalizeUserPresets(await figma.clientStorage.getAsync("userPresets"));
        const updated = upsertUserPreset(stored, msg.label, msg.values);
        await figma.clientStorage.setAsync("userPresets", updated);
        figma.ui.postMessage({ type: "USER_PRESETS", userPresets: updated });
        break;
      }
      case "DELETE_USER_PRESET": {
        const stored = normalizeUserPresets(await figma.clientStorage.getAsync("userPresets"));
        const updated = stored.filter((preset) => preset.id !== msg.id);
        await figma.clientStorage.setAsync("userPresets", updated);
        figma.ui.postMessage({ type: "USER_PRESETS", userPresets: updated });
        break;
      }
      case "GENERATE_KIT": {
        try {
          const snapshot = await readAllVariables();
          const colorVariables = snapshot.variables.filter((variable) => variable.resolvedType === "COLOR").map((variable) => ({ id: variable.id, name: variable.name }));
          const report = await generateDesignKit(colorVariables);
          figma.ui.postMessage({ type: "KIT_GENERATED", report });
          figma.notify(
            `Kit: ${report.components} components, ${report.variants} variants` + (report.slots > 0 ? `, ${report.slots} slots` : "") + (report.bound > 0 ? ` \u2014 ${report.bound} bound to tokens` : " \u2014 no matching tokens, using defaults")
          );
        } catch (error) {
          figma.ui.postMessage({ type: "KIT_ERROR", message: error instanceof Error ? error.message : String(error) });
        }
        break;
      }
      case "IMPORT_TRANSLATIONS": {
        try {
          const roots = rootsForScope(msg.scope);
          const index = await indexSceneNodes(roots);
          const textNodes = [];
          for (const node of index.values()) if (node.type === "TEXT") textNodes.push(node);
          const result = await importTranslations(msg.content, msg.format, textNodes);
          figma.ui.postMessage({
            type: "IMPORT_TRANSLATIONS_RESULT",
            applied: result.applied.length,
            skipped: result.skipped.map((skip) => ({ reason: skip.reason, msgid: skip.entry.msgid })),
            overflows: result.overflows.map(({ nodeId, nodeName, expected, actual }) => ({ nodeId, nodeName, expected, actual }))
          });
          figma.notify(
            `Translations: ${result.applied.length} applied, ${result.skipped.length} skipped` + (result.overflows.length > 0 ? `, ${result.overflows.length} overflow(s)` : "")
          );
        } catch (error) {
          figma.ui.postMessage({
            type: "IMPORT_TRANSLATIONS_ERROR",
            message: error instanceof Error ? error.message : String(error)
          });
        }
        break;
      }
      case "CONFIRM_EXPORT": {
        const { scope, modules, cssFile } = msg;
        const roots = rootsForScope(scope);
        let stage = "scan";
        try {
          figma.ui.postMessage({ type: "EXPORT_PROGRESS", stage: "scan", percent: 10 });
          const exportOptions = normalizeExportOptions(await figma.clientStorage.getAsync("exportOptions"));
          const [irNodes, sceneNodesById, snapshot] = await Promise.all([
            Promise.all(roots.map((root) => serializeNode(root))),
            indexSceneNodes(roots),
            readAllVariables()
          ]);
          const nodes = irNodes.filter((node) => node !== null);
          const pageRoots = nodes.filter((node) => node.type === "container");
          const variableNamesById = new Map(snapshot.variables.map((variable) => [variable.id, variable.name]));
          const motionExport = buildMotionExport(sceneNodesById, modules);
          if (modules.templates) await addReactionDestinationsToScene(pageRoots, sceneNodesById);
          stage = "i18n";
          figma.ui.postMessage({ type: "EXPORT_PROGRESS", stage: "i18n", percent: 30 });
          const entries = modules.i18n ? await extractAllStrings(roots) : [];
          stage = "templates";
          figma.ui.postMessage({ type: "EXPORT_PROGRESS", stage: "templates", percent: 55 });
          const assetSourcesById = sceneNodesById;
          if (modules.templates) await annotateVectorLeaves(nodes, assetSourcesById);
          const videoBytesById = modules.templates ? await annotateVideoFills(nodes, assetSourcesById) : void 0;
          const manualAssets = modules.templates ? collectManualAssets(nodes) : [];
          if (manualAssets.length > 0) {
            figma.notify(
              `${manualAssets.length} video(s): Figma API can't export them \u2014 attach in the plugin panel, or Dev Mode (Shift+D) \u2192 Assets \u2192 Download`,
              { timeout: 8e3 }
            );
          }
          const themeSets = modules.templates && exportOptions.targetOptions.framework === "bootstrap" && exportOptions.targetOptions.bootstrapFidelity === "theme" ? await collectThemableSets(sceneNodesById) : void 0;
          const breakpointTokens = extractBreakpointTokens2(snapshot);
          const [project, assets] = await Promise.all([
            modules.templates ? emitDjangoProject(pageRoots, sceneNodesById, variableNamesById, {
              cssFile,
              tokensCssFile: modules.tokens ? "css/tokens.css" : null,
              animationLinks: motionExport.animationLinks,
              framework: frameworkLinksFrom(exportOptions, modules.tokens),
              themeSets,
              breakpointTokens
            }) : void 0,
            modules.templates ? collectExportAssets(nodes, assetSourcesById, (hash) => figma.getImageByHash(hash), videoBytesById) : []
          ]);
          stage = "assets";
          figma.ui.postMessage({ type: "EXPORT_PROGRESS", stage: "assets", percent: 80 });
          const po = modules.i18n && entries.length > 0 ? emitPo(entries) : void 0;
          const files = project ? buildExportTree({ project, tokensCss: "", cssFile, po, assets, animation: motionExport.animation }) : {};
          if (!project) {
            for (const asset of assets) files[`static/img/${asset.filename}`] = asset.content;
            if (po) files["locale/figma.po"] = po;
          }
          delete files["static/css/tokens.css"];
          let tokenArtifacts;
          let bootstrapArtifacts;
          if (modules.tokens) {
            tokenArtifacts = emitTokenArtifacts(snapshot, tokenEmitOptionsFrom(exportOptions, readRenameMap()));
            files["static/css/tokens.css"] = tokenArtifacts.css;
            if (exportOptions.tokens.emitJson) files["tokens.json"] = tokenArtifacts.json;
            if (exportOptions.targetOptions.framework === "bootstrap") {
              bootstrapArtifacts = emitBootstrapArtifacts(
                tokenArtifacts.source,
                { ordered: tokenArtifacts.themes, defaultTheme: tokenArtifacts.defaultTheme },
                { themeAttribute: tokenEmitOptionsFrom(exportOptions).themeAttribute }
              );
              if (bootstrapArtifacts.css) files["static/css/bootstrap-tokens.css"] = bootstrapArtifacts.css;
              files["bootstrap.map.json"] = bootstrapArtifacts.mapJson;
              if (exportOptions.tokens.emitScss && bootstrapArtifacts.scss) files["static/scss/_tokens.scss"] = bootstrapArtifacts.scss;
            }
          }
          if (modules.animation) files["static/js/motion-tokens.js"] = emitMotionTokensJs(snapshot);
          if (!project && motionExport.animation.css) files["static/css/animations.css"] = motionExport.animation.css;
          if (!project && motionExport.animation.js) files["static/js/animations.js"] = motionExport.animation.js;
          let tauriPageHrefs;
          if (exportOptions.targetOptions.platform === "tauri" && project) {
            let startPageId;
            try {
              startPageId = (_l = figma.currentPage.flowStartingPoints[0]) == null ? void 0 : _l.nodeId;
            } catch (e) {
            }
            const startRootId = startPageId && pageRoots.some((root) => root.id === startPageId) ? startPageId : (_m = pageRoots[0]) == null ? void 0 : _m.id;
            const startScene = startRootId ? sceneNodesById.get(startRootId) : void 0;
            const windowSize = startScene && "width" in startScene ? { width: startScene.width, height: startScene.height } : { width: 1024, height: 768 };
            const bootstrapTokensCss = files["static/css/bootstrap-tokens.css"];
            for (const key of Object.keys(files)) {
              if (key.startsWith("templates/") || key.startsWith("static/")) delete files[key];
            }
            const tauri = buildTauriExportTree({
              project,
              pageRoots,
              cssFile,
              tokensCss: modules.tokens && tokenArtifacts ? tokenArtifacts.css : null,
              animation: motionExport.animation,
              motionTokensJs: modules.animation ? emitMotionTokensJs(snapshot) : null,
              assets,
              productName: figma.root.name,
              startPageId,
              window: windowSize,
              bootstrapVersion: exportOptions.targetOptions.framework === "bootstrap" ? exportOptions.targetOptions.bootstrapVersion : void 0,
              manualAssetNotes: manualAssets.map((asset) => asset.assetSrc)
            });
            Object.assign(files, tauri.files);
            tauriPageHrefs = tauri.pageHrefs;
            if (typeof bootstrapTokensCss === "string" && bootstrapTokensCss) {
              files["src/assets/css/bootstrap-tokens.css"] = bootstrapTokensCss;
            }
          }
          const exportedAt = (/* @__PURE__ */ new Date()).toISOString();
          let componentDocs = [];
          if (exportOptions.docs.componentDocs && project) {
            const documentable = /* @__PURE__ */ new Map();
            for (const path of Object.keys(project.partials)) {
              const nodeId = project.fileNodeIds[path];
              const node = (_n = sceneNodesById.get(nodeId)) != null ? _n : await figma.getNodeByIdAsync(nodeId).catch(() => null);
              if (!node) continue;
              const owner = node.type === "COMPONENT" && ((_o = node.parent) == null ? void 0 : _o.type) === "COMPONENT_SET" ? node.parent : node.type === "COMPONENT" || node.type === "COMPONENT_SET" ? node : null;
              if (owner && !documentable.has(owner.id)) documentable.set(owner.id, owner);
            }
            const collected = await collectComponentDocs(
              exportOptions.docs.componentPreviews,
              exportOptions.docs.previewBudgetMb,
              [...documentable.values()]
            );
            componentDocs = collected.docs;
            for (const path of Object.keys(collected.files)) files[path] = collected.files[path];
            const componentsMd = buildComponentsMd(componentDocs, {
              fileName: figma.root.name,
              generatedAt: exportedAt,
              usage: exportOptions.targetOptions.platform === "tauri" ? "Each component below is rendered inline into the static `src/*.html` pages. The markup is generated; the behaviour written here is NOT \u2014 implement it in your JS." : "Each component below ships as a `templates/components/\u2026` partial. The markup is generated; the behaviour written here is NOT \u2014 implement it in your view/JS.",
              // Resolve `Y300`/`glyph/tetriary` in the prose against the tokens this export shipped.
              tokens: tokenArtifacts ? buildTokenEntries(tokenArtifacts.emitted, tokenArtifacts.themes, tokenArtifacts.defaultTheme) : []
            });
            if (componentsMd) files[COMPONENTS_FILE] = componentsMd;
          }
          let lintAudit = null;
          try {
            const findings = await lintScopeAsync(roots, { maxNestingDepth: exportOptions.lint.maxNestingDepth });
            const counts = {};
            for (const finding of findings) counts[finding.rule] = ((_p = counts[finding.rule]) != null ? _p : 0) + 1;
            lintAudit = { counts, total: findings.length, nodeCount: sceneNodesById.size };
          } catch (error) {
            console.warn("[export] DESIGN.md canvas audit skipped", error);
          }
          files["DESIGN.md"] = buildDjangoDesignMd({
            fileName: figma.root.name,
            generatedAt: exportedAt,
            scope: scope.mode === "frame" ? { mode: "frame", frameId: scope.frameId } : { mode: scope.mode },
            modules,
            package: {
              // Tauri re-roots the tree: pages render to static src/*.html and partials inline
              // into them — DESIGN.md must describe the files that actually shipped.
              pages: tauriPageHrefs ? Object.values(tauriPageHrefs).map((href) => `src/${href}`) : project ? Object.keys(project.pages) : [],
              partials: project && !tauriPageHrefs ? Object.keys(project.partials) : [],
              cssFile: tauriPageHrefs ? `assets/${cssFile}` : cssFile,
              interactionsCss: Boolean(project == null ? void 0 : project.interactionsCss),
              interactionsJs: Boolean(project == null ? void 0 : project.interactionsJs),
              animationsCss: Boolean(motionExport.animation.css),
              animationsJs: Boolean(motionExport.animation.js),
              assetCount: assets.length,
              manualAssets: manualAssets.map((asset) => asset.assetSrc)
            },
            tokens: tokenArtifacts ? {
              tree: tokenArtifacts.emitted,
              themes: tokenArtifacts.themes,
              defaultTheme: tokenArtifacts.defaultTheme,
              themeAttribute: tokenEmitOptionsFrom(exportOptions).themeAttribute,
              audit: buildTokenAudit(snapshot),
              emitJson: exportOptions.tokens.emitJson
            } : void 0,
            bootstrap: bootstrapArtifacts ? {
              fidelity: exportOptions.targetOptions.bootstrapFidelity,
              source: exportOptions.targetOptions.bootstrapSource,
              version: exportOptions.targetOptions.bootstrapVersion,
              matched: bootstrapArtifacts.matched.map((match) => ({ bsVar: match.bsVar, slug: varName(match.leaf.path) })),
              unmatched: bootstrapArtifacts.unmatched,
              themeCss: Boolean(project == null ? void 0 : project.themeCss)
            } : void 0,
            componentDocs,
            i18n: {
              entryCount: entries.length,
              sourceLanguage: exportOptions.i18n.sourceLanguage,
              wrapTranslate: exportOptions.i18n.wrapTranslate
            },
            lint: lintAudit
          });
          let exportedBy = "unknown";
          let activeUserCount = 0;
          try {
            exportedBy = (_r = (_q = figma.currentUser) == null ? void 0 : _q.name) != null ? _r : "unknown";
            activeUserCount = figma.activeUsers.length;
          } catch (e) {
          }
          files["export-report.json"] = buildExportReport({
            exportedAt,
            exportedBy,
            activeUserCount,
            scope,
            modules,
            fileCount: Object.keys(files).length,
            manualAssets: manualAssets.length > 0 ? manualAssets.map((a) => a.assetSrc) : void 0
          });
          try {
            for (const root of roots) root.setRelaunchData({ reexport: "" });
          } catch (e) {
          }
          try {
            await figma.saveVersionHistoryAsync(
              `${exportOptions.targetOptions.platform === "tauri" ? "Tauri" : "Django"} export \u2014 ${(/* @__PURE__ */ new Date()).toISOString()}`,
              `${Object.keys(files).length} file(s), scope: ${scope.mode}`
            );
          } catch (error) {
            console.warn("[export] saveVersionHistoryAsync skipped", error);
          }
          figma.ui.postMessage({ type: "EXPORT_PROGRESS", stage: "done", percent: 100 });
          figma.ui.postMessage({ type: "FILES_READY", files, manualAssets });
        } catch (error) {
          console.error(`[export] failed during "${stage}"`, error);
          figma.ui.postMessage({
            type: "EXPORT_ERROR",
            stage,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        break;
      }
    }
  };
})();
