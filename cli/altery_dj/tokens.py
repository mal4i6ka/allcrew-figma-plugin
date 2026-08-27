"""`altery-dj tokens` — rebuild derived token files from the package's lossless tokens.json.

Python port of the plugin's token engine emitters (src/tokens/engine.ts +
src/frameworks/bootstrap/map.ts). tokens.json is the source of truth the plugin ships at
the package root; this command regenerates:

  static/css/tokens.css            (--format css)
  static/css/bootstrap-tokens.css  (--format bootstrap, needs bootstrap.map.json)
  static/scss/_tokens.scss         (--format scss, needs bootstrap.map.json)

so the developer can edit `bootstrap.map.json` (or flip --flatten-all / --no-inline) and
rebuild WITHOUT a Figma re-export. Output is byte-identical to the plugin's emitters —
locked by tests/test_cli.py against the same goldens the TypeScript engine is tested with.
Keep this module in sync with the TS engine if the emit format changes.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# ---------------------------------------------------------------- naming + values

_SEGMENT_SPLIT = re.compile(r"[/.\s_-]+")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")
UNITLESS_TOKEN = re.compile(
    r"(^|[-_])(opacity|z-?index|font-?weight|weight|line-?height|lineheight|flex|order|aspect|ratio|scale|count|columns?)([-_]|$)",
    re.IGNORECASE,
)
DURATION_TOKEN = re.compile(r"(^|[-_])durations?([-_]|$)", re.IGNORECASE)


def _slug_segments(name: str) -> list[str]:
    trimmed = str(name).strip()
    trimmed = trimmed[2:] if trimmed.startswith("--") else trimmed
    return [part.strip() for part in _SEGMENT_SPLIT.split(trimmed) if part.strip()]


def var_name(segments) -> str:
    parts: list[str] = []
    for segment in segments:
        for piece in _slug_segments(segment):
            slug = _NON_ALNUM.sub("-", piece.lower()).strip("-")
            if slug:
                parts.append(slug)
    return "-".join(parts)


def theme_slug(theme: str) -> str:
    return var_name([theme]) or theme


def _is_token(node) -> bool:
    return isinstance(node, dict) and "$value" in node


def leaves(tree, prefix=()) -> list[tuple[tuple[str, ...], dict]]:
    out = []
    for key, value in tree.items():
        path = prefix + (key,)
        if _is_token(value):
            out.append((path, value))
        elif isinstance(value, dict):
            out.extend(leaves(value, path))
    return out


def _alias_target(value):
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"\{(.+)\}", value)
    if not match:
        return None
    return [part.strip() for part in match.group(1).split(".") if part.strip()]


def _is_alias(value) -> bool:
    return isinstance(value, str) and re.fullmatch(r"\{.+\}", value) is not None


def _number_str(value) -> str:
    # JSON ints stay ints in Python; floats print like JS for the values Figma produces.
    return str(value)


def css_value(value, path=None) -> str:
    alias = _alias_target(value)
    if alias:
        return f"var(--{var_name(alias)})"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if path and any(DURATION_TOKEN.search(seg) for seg in path):
            return f"{_number_str(value)}ms"
        unitless = value == 0 or (path is not None and any(UNITLESS_TOKEN.search(seg) for seg in path))
        return _number_str(value) if unitless else f"{_number_str(value)}px"
    if isinstance(value, str):
        return value
    return str(value) if value is not None else ""


# ---------------------------------------------------------------- themes

def _modes_of(token) -> dict:
    modes = token.get("$extensions", {}).get("modes")
    return modes if isinstance(modes, dict) else {}


def _collection_of(token):
    figma = token.get("$extensions", {}).get("figma")
    return figma.get("collection") if isinstance(figma, dict) else None


def _default_mode_of(token):
    figma = token.get("$extensions", {}).get("figma")
    return figma.get("defaultMode") if isinstance(figma, dict) else None


def participates_in_theming(token) -> bool:
    modes = _modes_of(token)
    return len(modes) >= 2 or _is_alias(token.get("$value")) or any(_is_alias(v) for v in modes.values())


def ordered_themes(all_leaves) -> tuple[str, list[str]]:
    themes: list[str] = []
    for _, token in all_leaves:
        if not participates_in_theming(token):
            continue
        for name in _modes_of(token):
            if name not in themes:
                themes.append(name)
    if not themes:
        first_modes = list(_modes_of(all_leaves[0][1])) if all_leaves else []
        themes.append(first_modes[0] if first_modes else "default")

    default_theme = themes[0]
    for _, token in all_leaves:
        default_mode = _default_mode_of(token)
        if default_mode and default_mode in themes:
            default_theme = default_mode
            break
    return default_theme, [default_theme] + [t for t in themes if t != default_theme]


def value_for_theme(token, theme):
    modes = _modes_of(token)
    return modes[theme] if theme in modes else token.get("$value")


# ---------------------------------------------------------------- inline primitives

def _set_token(root: dict, path, token) -> None:
    cursor = root
    for segment in path[:-1]:
        existing = cursor.get(segment)
        if not isinstance(existing, dict) or "$value" in existing:
            cursor[segment] = {}
        cursor = cursor[segment]
    cursor[path[-1]] = token


def inline_primitives(tree: dict, flatten_all: bool) -> dict:
    all_leaves = leaves(tree)
    by_name = {".".join(path): (path, token) for path, token in all_leaves}
    primitive = {".".join(path) for path, token in all_leaves if not participates_in_theming(token)}

    referenced: set[str] = set()

    def note_ref(value) -> None:
        target = _alias_target(value)
        if target and ".".join(target) in primitive:
            referenced.add(".".join(target))

    for _, token in all_leaves:
        note_ref(token.get("$value"))
        for mode_value in _modes_of(token).values():
            note_ref(mode_value)

    def inline(value, theme, seen, origin_path=None):
        if not _is_alias(value):
            if origin_path is not None and isinstance(value, (int, float)) and not isinstance(value, bool):
                return css_value(value, origin_path)
            return value
        target = ".".join(_alias_target(value))
        if target not in by_name or target in seen:
            return value  # dangling / cycle
        if not flatten_all and target not in primitive:
            return value  # keep semantic→semantic unless flattening
        target_path, target_token = by_name[target]
        return inline(value_for_theme(target_token, theme), theme, seen | {target}, target_path)

    out: dict = {}
    for path, token in all_leaves:
        name = ".".join(path)
        if name in primitive:
            if name in referenced:
                continue  # inlined away
            _set_token(out, path, token)  # unreferenced primitive — keep verbatim
            continue
        modes = _modes_of(token)
        new_modes = {key: inline(value, key, frozenset()) for key, value in modes.items()}
        default_mode = _default_mode_of(token)
        theme_for_default = default_mode if default_mode in modes else next(iter(modes), None)
        new_default = inline(token.get("$value"), theme_for_default, frozenset())
        extensions = dict(token.get("$extensions", {}))
        extensions["modes"] = new_modes
        _set_token(out, path, {"$type": token.get("$type"), "$value": new_default, "$extensions": extensions})
    return out


# ---------------------------------------------------------------- legacy aliases

# Mirror of the TS engine's legacy-alias section (src/tokens/engine.ts). A colour remap renames
# the primitive layer in Figma, which silently deletes the matching custom property here; the
# old names are carried forward as aliases so nothing that already imported them breaks. The
# rename map rides in tokens.json under `$extensions.altery.renames`, and both engines apply the
# same three exclusions — target not emitted, old name still taken, or a rename CSS cannot see.

RENAMES_EXTENSION = "altery"
LEGACY_COMMENT = "/* Renamed by a color remap — the old names keep resolving */"


def renames_of(tree) -> dict:
    """The rename map tokens.json carries, if any."""
    extensions = tree.get("$extensions") if isinstance(tree, dict) else None
    if not isinstance(extensions, dict):
        return {}
    section = extensions.get(RENAMES_EXTENSION)
    if not isinstance(section, dict):
        return {}
    renames = section.get("renames")
    return renames if isinstance(renames, dict) else {}


def _name_segments(name: str) -> list[str]:
    return [segment for segment in str(name).split("/") if segment.strip()]


def legacy_alias_pairs(tree, renames) -> list[tuple[str, str]]:
    if not renames:
        return []
    emitted = {var_name(path) for path, _ in leaves(tree)}
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for key, target in renames.items():
        source = var_name(_name_segments(key))
        destination = var_name(_name_segments(target))
        if not source or not destination or source == destination:
            continue
        if destination not in emitted or source in emitted or source in seen:
            continue
        seen.add(source)
        pairs.append((source, destination))
    pairs.sort(key=lambda pair: pair[0])
    return pairs


def to_legacy_alias_css(pairs, selector=":root") -> str:
    if not pairs:
        return ""
    lines = "\n".join(f"  --{source}: var(--{destination});" for source, destination in pairs)
    return f"{LEGACY_COMMENT}\n{selector} {{\n{lines}\n}}\n"


# ---------------------------------------------------------------- tokens.css emitter

MOTION_KEYFRAMES_COMMENT = "  /* use var(--motion-duration-*) in animation shorthand, not inside @keyframes */"


def _theme_declarations(all_leaves, theme) -> list[str]:
    order: list[str] = []
    groups: dict[str, list] = {}
    for path, token in all_leaves:
        collection = _collection_of(token) or ""
        if collection not in groups:
            groups[collection] = []
            order.append(collection)
        groups[collection].append((path, token))
    labeled = any(collection for collection in order)
    lines: list[str] = []
    for collection in order:
        if labeled and collection:
            lines.append(f"  /* {collection} */")
        for path, token in groups[collection]:
            lines.append(f"  --{var_name(path)}: {css_value(value_for_theme(token, theme), path)};")
    return lines


def to_tokens_css(tree, ordered, default_theme, attr, renames=None) -> str:
    theme_attr = attr or "data-theme"
    all_leaves = leaves(tree)
    if not all_leaves:
        return ""
    has_motion = any(re.fullmatch(r"motion", path[0], re.IGNORECASE) for path, _ in all_leaves if path)
    blocks = []
    for index, theme in enumerate(ordered):
        theme_sel = f'[{theme_attr}="{theme_slug(theme)}"]'
        selector = f":root,\n{theme_sel}" if theme == default_theme else theme_sel
        declarations = _theme_declarations(all_leaves, theme)
        if index == 0 and has_motion:
            declarations.insert(0, MOTION_KEYFRAMES_COMMENT)
        blocks.append(f"{selector} {{\n" + "\n".join(declarations) + "\n}")
    # Last, and outside the theme blocks: an alias resolves wherever it is used, so one copy
    # covers every theme.
    legacy = to_legacy_alias_css(legacy_alias_pairs(tree, renames))
    return "\n\n".join(blocks) + "\n" + ("" if not legacy else "\n" + legacy)


# ---------------------------------------------------------------- bootstrap emitters

# Bootstrap vars whose overrides need the `-rgb` companion (mirror of map.ts's rgb flags).
RGB_COMPANIONS = {
    "--bs-primary", "--bs-secondary", "--bs-success", "--bs-danger", "--bs-warning",
    "--bs-info", "--bs-light", "--bs-dark", "--bs-body-bg", "--bs-body-color",
}
# Every var the default candidate table knows — a mapped var OUTSIDE this set came from the
# bs/* escape hatch, where the companion is emitted whenever the value parses as a color.
KNOWN_TABLE_VARS = RGB_COMPANIONS | {
    "--bs-secondary-color", "--bs-border-color", "--bs-link-color", "--bs-link-hover-color",
    "--bs-body-font-family", "--bs-body-font-size", "--bs-border-radius",
    "--bs-border-radius-sm", "--bs-border-radius-lg", "--bs-border-radius-xl",
}
SCSS_VAR_EXCEPTIONS = {"--bs-secondary-color": "body-secondary-color",
                       "--bs-body-font-family": "font-family-base",
                       "--bs-body-font-size": "font-size-base"}


def css_color_to_rgb_triplet(value: str):
    match = re.fullmatch(r"#([0-9a-f]{6})", value, re.IGNORECASE)
    if match:
        n = int(match.group(1), 16)
        return f"{(n >> 16) & 255}, {(n >> 8) & 255}, {n & 255}"
    match = re.match(r"rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)", value)
    if match:
        return f"{match.group(1)}, {match.group(2)}, {match.group(3)}"
    return None


def _scss_var(bs_var: str) -> str:
    return SCSS_VAR_EXCEPTIONS.get(bs_var, bs_var.removeprefix("--bs-"))


def _resolve_mapped(source_tree, mapping: dict):
    """bootstrap.map.json's map (bsVar → dotted path) resolved against the FLATTENED tree."""
    flat = {".".join(path): (path, token) for path, token in leaves(inline_primitives(source_tree, True))}
    resolved = []
    dangling = []
    for bs_var, dotted in mapping.items():
        entry = flat.get(dotted)
        if entry is None:
            dangling.append((bs_var, dotted))
            continue
        resolved.append((bs_var, entry[0], entry[1]))
    return resolved, dangling


def to_bootstrap_css(source_tree, mapping, ordered, default_theme, attr) -> str:
    resolved, _ = _resolve_mapped(source_tree, mapping)
    if not resolved:
        return ""
    theme_attr = attr or "data-bs-theme"
    blocks = []
    for theme in ordered:
        theme_sel = f'[{theme_attr}="{theme_slug(theme)}"]'
        selector = f":root,\n{theme_sel}" if theme == default_theme else theme_sel
        lines = []
        for bs_var, path, token in resolved:
            value = css_value(value_for_theme(token, theme), path)
            lines.append(f"  {bs_var}: {value};")
            wants_rgb = bs_var in RGB_COMPANIONS or bs_var not in KNOWN_TABLE_VARS
            if wants_rgb:
                triplet = css_color_to_rgb_triplet(value) if isinstance(value, str) else None
                if triplet:
                    lines.append(f"  {bs_var}-rgb: {triplet};")
        blocks.append(f"{selector} {{\n" + "\n".join(lines) + "\n}")
    return (
        "/* Bootstrap variable overrides generated from design tokens — link AFTER bootstrap.css.\n"
        "   Mapping: bootstrap.map.json (edit + `altery-dj tokens` to rebuild without Figma). */\n"
        + "\n\n".join(blocks)
        + "\n"
    )


def to_tokens_scss(source_tree, mapping, default_theme) -> str:
    resolved, _ = _resolve_mapped(source_tree, mapping)
    if not resolved:
        return ""
    lines = []
    for bs_var, path, token in resolved:
        value = css_value(value_for_theme(token, default_theme), path)
        lines.append(f"${_scss_var(bs_var)}: {value};")
    return (
        "// Design-token overrides for Bootstrap's _variables.scss — @import BEFORE bootstrap.\n"
        f'// Values are the "{default_theme}" theme; runtime theming uses bootstrap-tokens.css.\n'
        + "\n".join(lines)
        + "\n"
    )


# ---------------------------------------------------------------- command

def run(args) -> int:
    app_dir = Path(args.app).resolve()
    tokens_json = app_dir / "tokens.json"
    if not tokens_json.exists():
        print(f"[altery-dj tokens] {tokens_json} not found — apply an export first (`altery-dj apply`)")
        return 1
    source_tree = json.loads(tokens_json.read_text(encoding="utf-8"))
    # The map travels beside the tree, not inside it — lift it out before anything walks it.
    renames = renames_of(source_tree)
    source_tree.pop("$extensions", None)
    default_theme, ordered = ordered_themes(leaves(source_tree))

    formats = {args.format} if args.format != "all" else {"css", "bootstrap", "scss"}
    map_path = app_dir / "bootstrap.map.json"
    mapping = None
    if formats & {"bootstrap", "scss"}:
        if not map_path.exists():
            if args.format == "all":
                formats -= {"bootstrap", "scss"}  # no mapping shipped — css only
            else:
                print(f"[altery-dj tokens] {map_path} not found — export with the Bootstrap framework enabled")
                return 1
        else:
            mapping = json.loads(map_path.read_text(encoding="utf-8")).get("map", {})

    written = []
    if "css" in formats:
        css_tree = source_tree if args.no_inline else inline_primitives(source_tree, args.flatten_all)
        target = app_dir / "static" / "css" / "tokens.css"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            to_tokens_css(css_tree, ordered, default_theme, args.theme_attr, renames), encoding="utf-8"
        )
        written.append(target)
    if "bootstrap" in formats and mapping is not None:
        css = to_bootstrap_css(source_tree, mapping, ordered, default_theme, args.theme_attr)
        target = app_dir / "static" / "css" / "bootstrap-tokens.css"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(css, encoding="utf-8")
        written.append(target)
        _, dangling = _resolve_mapped(source_tree, mapping)
        for bs_var, dotted in dangling:
            print(f"[altery-dj tokens] warning: {bs_var} maps to '{dotted}' which is not in tokens.json — skipped")
    if "scss" in formats and mapping is not None:
        target = app_dir / "static" / "scss" / "_tokens.scss"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(to_tokens_scss(source_tree, mapping, default_theme), encoding="utf-8")
        written.append(target)

    for target in written:
        print(f"[altery-dj tokens] wrote {target.relative_to(app_dir)}")
    return 0
