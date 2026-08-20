"""`altery-dj remap` — apply a colour remap's mapping.json to a repository.

The rule the whole exercise rests on: **keys never change, values do.** A stylesheet keeps
`--color-primary`, a token file keeps `colors.blue.500`; only what they resolve to moves. That
is what makes a palette migration something a team can accept — the diff touches colours and
nothing else.

Two ways to find what to change, because a repository holds both situations:

  * **By literal** — any colour the file holds that matches a colour the design file used to
    have. Works in CSS, SCSS, JSON, SVG, a Tailwind config, anywhere, because it does not care
    about structure. This is the pass that catches hard-coded colours.
  * **By name** (``--by-name``) — a declaration whose *key* is a token name gets the new value
    whatever it currently holds. This is the one that survives drift.

Dry run is the default and prints what would change. ``--write`` refuses to touch a dirty (or
absent) git worktree, because the diff is the only review this operation gets.

Python half of a two-engine pair: src/tokens/remap/rewrite.ts is the other, and the two are
locked to shared goldens under tests/fixtures/remap/.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

from .color import delta_e, find_color_literals, format_color_literal, format_hex, parse_hex

MAPPING_FORMAT = "altery-color-remap"
MAPPING_VERSION = 1

# What a colour can plausibly live in. Anything else is skipped outright rather than scanned:
# a regex over a binary is a way to corrupt one.
DEFAULT_EXTENSIONS = (
    ".css", ".scss", ".sass", ".less", ".styl",
    ".json", ".jsonc", ".json5", ".csv",
    ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte",
    ".html", ".htm", ".svg", ".xml",
    ".py", ".rb", ".php", ".kt", ".swift", ".dart",
    ".yml", ".yaml", ".toml",
)

SKIP_DIRECTORIES = {
    ".git", "node_modules", "dist", "build", ".next", ".nuxt", "__pycache__",
    ".venv", "venv", "vendor", "coverage", ".mypy_cache", ".pytest_cache",
}

# A file larger than this is a bundle, a lockfile or a data dump, not something anyone reviews.
MAX_BYTES = 2 * 1024 * 1024


# ---------------------------------------------------------------- mapping

def load_mapping(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("format") != MAPPING_FORMAT:
        raise ValueError(f"{path} is not a colour mapping (format: {data.get('format')!r})")
    version = data.get("version")
    if not isinstance(version, int) or version > MAPPING_VERSION:
        raise ValueError(f"{path} was written by a newer build (version {version})")
    if not isinstance(data.get("records"), list):
        raise ValueError(f"{path} has no records")
    return data


_SEGMENT_SPLIT = re.compile(r"[/.]")


def _name_key(name: str) -> str:
    from .tokens import var_name

    return var_name(_SEGMENT_SPLIT.split(name))


class Lookup:
    """Old colour → new colour, plus token name → new colour, plus what could not be decided."""

    def __init__(self, mapping: dict, mode: str | None):
        self.by_hex: dict[str, tuple] = {}
        self.by_name: dict[str, tuple] = {}
        self.warnings: list[str] = []
        conflicting: set[str] = set()

        for record in mapping["records"]:
            if mode is not None and record.get("mode") is not None and record.get("mode") != mode:
                continue
            target = parse_hex(record["to"])
            if target is None:
                continue

            # A key is a name, so it can be rewritten even when its value drifted; a repository
            # may hold either the old name or the one stage 3's aliases introduced.
            for name in (record.get("name"), record.get("newName")):
                if name:
                    self.by_name[_name_key(name)] = target

            if record["from"] == record["to"]:
                continue
            existing = self.by_hex.get(record["from"])
            if existing is not None and format_hex(existing) != record["to"]:
                conflicting.add(record["from"])
                continue
            self.by_hex[record["from"]] = target

        for hex_value in sorted(conflicting):
            self.by_hex.pop(hex_value, None)
            self.warnings.append(
                f"{hex_value} maps to more than one new colour in this file — "
                "pass --mode to say which theme this repository is"
            )

        self.candidates = [(parse_hex(hex_value), target) for hex_value, target in self.by_hex.items()]


def _match_literal(literal: dict, lookup: Lookup, snap: float):
    exact = lookup.by_hex.get(format_hex(literal["rgba"]))
    if exact is not None:
        return exact, False
    if snap <= 0:
        return None
    best, best_distance = None, snap
    for source, target in lookup.candidates:
        if source is None:
            continue
        distance = delta_e(source, literal["rgba"])
        if distance < best_distance:
            best_distance, best = distance, target
    return (best, True) if best is not None else None


# ---------------------------------------------------------------- rewriting

_CSS_DECLARATION_RE = re.compile(r"(--[\w-]+)(\s*:\s*)([^;{}\n]+)")
_JSON_DECLARATION_RE = re.compile(r'("([^"\\]+)"\s*:\s*")([^"\\]*)(")')


def _position_of(text: str, offset: int) -> tuple[int, int]:
    line_start = text.rfind("\n", 0, offset) + 1
    return text.count("\n", 0, offset) + 1, offset - line_start + 1


def _name_edits(text: str, lookup: Lookup) -> list[dict]:
    edits: list[dict] = []

    def claim(name: str, value_start: int, value: str) -> None:
        target = lookup.by_name.get(_name_key(name))
        if target is None:
            return
        literals = find_color_literals(value)
        # Only a declaration that is *entirely* one colour is safe to rewrite by name: a
        # shorthand like `1px solid #ccc` names a border, not a colour token.
        if len(literals) != 1 or literals[0]["source"].strip() != value.strip():
            return
        literal = literals[0]
        replacement = format_color_literal(target + (literal["rgba"][3],), literal["notation"])
        if replacement == literal["source"]:
            return
        edits.append({
            "start": value_start + literal["start"],
            "end": value_start + literal["end"],
            "from": literal["source"],
            "to": replacement,
            "via": "name",
            "snapped": False,
        })

    for match in _CSS_DECLARATION_RE.finditer(text):
        claim(match.group(1)[2:], match.start(3), match.group(3))
    for match in _JSON_DECLARATION_RE.finditer(text):
        claim(match.group(2), match.start(3), match.group(3))

    return edits


def rewrite_colors(text: str, mapping: dict, snap: float = 2, mode: str | None = None,
                   by_name: bool = False) -> dict:
    lookup = Lookup(mapping, mode)
    edits = _name_edits(text, lookup) if by_name else []
    untouched = 0

    for literal in find_color_literals(text):
        matched = _match_literal(literal, lookup, snap)
        if matched is None:
            untouched += 1
            continue
        target, snapped = matched
        # The file decides the transparency; the mapping only ever decides the colour.
        replacement = format_color_literal(target + (literal["rgba"][3],), literal["notation"])
        if replacement == literal["source"]:
            continue
        edits.append({
            "start": literal["start"],
            "end": literal["end"],
            "from": literal["source"],
            "to": replacement,
            "via": "literal",
            "snapped": snapped,
        })

    # Applied back to front, so every offset still describes the text it was measured in. The
    # name pass and the literal pass can both claim one value; the first wins rather than the
    # second corrupting what it half-rewrote.
    edits.sort(key=lambda edit: edit["start"])
    kept: list[dict] = []
    reach = -1
    for edit in edits:
        if edit["start"] < reach:
            continue
        kept.append(edit)
        reach = edit["end"]

    replacements = []
    for edit in kept:
        line, column = _position_of(text, edit["start"])
        replacements.append({**edit, "line": line, "column": column})

    out = text
    for edit in reversed(kept):
        out = out[: edit["start"]] + edit["to"] + out[edit["end"] :]

    return {"text": out, "replacements": replacements, "untouched": untouched,
            "warnings": lookup.warnings}


# ---------------------------------------------------------------- walking

def iter_files(roots, extensions) -> list[Path]:
    found: list[Path] = []
    for root in roots:
        if root.is_file():
            found.append(root)
            continue
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            if any(part in SKIP_DIRECTORIES for part in path.parts):
                continue
            if path.suffix.lower() not in extensions:
                continue
            found.append(path)
    return found


def worktree_state(path: Path) -> tuple[bool, str]:
    """(clean, explanation). A repository is the only undo this command offers."""
    try:
        inside = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=path if path.is_dir() else path.parent,
            capture_output=True, text=True,
        )
    except FileNotFoundError:
        return False, "git is not installed"
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        return False, f"{path} is not inside a git worktree"

    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=path if path.is_dir() else path.parent,
        capture_output=True, text=True,
    )
    if status.returncode != 0:
        return False, "git status failed"
    if status.stdout.strip():
        changed = len(status.stdout.strip().splitlines())
        return False, f"the worktree has {changed} uncommitted change(s)"
    return True, "clean"


# ---------------------------------------------------------------- command

def run(args) -> int:
    mapping_path = Path(args.map).resolve()
    if not mapping_path.exists():
        print(f"[altery-dj remap] {mapping_path} not found — export it from the plugin first")
        return 1
    try:
        mapping = load_mapping(mapping_path)
    except (ValueError, json.JSONDecodeError) as error:
        print(f"[altery-dj remap] {error}")
        return 1

    roots = [Path(path).resolve() for path in (args.paths or ["."])]
    for root in roots:
        if not root.exists():
            print(f"[altery-dj remap] {root} not found")
            return 1

    extensions = (
        {ext if ext.startswith(".") else f".{ext}" for ext in args.ext}
        if args.ext
        else set(DEFAULT_EXTENSIONS)
    )

    if args.write and not args.force:
        clean, why = worktree_state(roots[0])
        if not clean:
            print(f"[altery-dj remap] refusing to write: {why}")
            print("  the diff is the only review this gets — commit or stash first, or pass --force")
            return 1

    files = iter_files(roots, extensions)
    total_replacements = 0
    changed_files = 0
    warned: set[str] = set()

    for path in files:
        try:
            if path.stat().st_size > MAX_BYTES:
                continue
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        result = rewrite_colors(text, mapping, snap=args.snap, mode=args.mode, by_name=args.by_name)
        for warning in result["warnings"]:
            if warning not in warned:
                warned.add(warning)
                print(f"[altery-dj remap] warning: {warning}")
        if not result["replacements"]:
            continue

        changed_files += 1
        total_replacements += len(result["replacements"])
        relative = path.relative_to(roots[0]) if path.is_relative_to(roots[0]) else path
        for replacement in result["replacements"]:
            marks = []
            if replacement["snapped"]:
                marks.append("snapped")
            if replacement["via"] == "name":
                marks.append("by name")
            suffix = f"  [{', '.join(marks)}]" if marks else ""
            print(f"  {relative}:{replacement['line']}:{replacement['column']}  "
                  f"{replacement['from']} → {replacement['to']}{suffix}")

        if args.write:
            path.write_text(result["text"], encoding="utf-8")

    verb = "changed" if args.write else "would change"
    print(f"[altery-dj remap] {verb} {total_replacements} colour(s) in {changed_files} file(s) "
          f"of {len(files)} scanned")
    if not args.write and total_replacements:
        print("  dry run — pass --write to apply")
    return 0


def add_parser(subparsers) -> argparse.ArgumentParser:
    parser = subparsers.add_parser(
        "remap",
        help="apply a colour remap's mapping.json to this repository (dry run by default)",
    )
    parser.add_argument("--map", required=True, help="mapping.json exported by the plugin")
    parser.add_argument("paths", nargs="*", help="files or directories to scan (default: .)")
    parser.add_argument("--write", action="store_true", help="apply the changes (default: dry run)")
    parser.add_argument("--force", action="store_true",
                        help="write even when the worktree is dirty or absent")
    parser.add_argument("--snap", type=float, default=2,
                        help="how far off a colour may be and still count (ΔE, 0 = exact only)")
    parser.add_argument("--mode", default=None,
                        help="which theme this repository holds, when the mapping has several")
    parser.add_argument("--by-name", action="store_true",
                        help="also rewrite declarations whose key is a token name")
    parser.add_argument("--ext", action="append",
                        help="limit to this extension (repeatable); defaults to the usual set")
    return parser
