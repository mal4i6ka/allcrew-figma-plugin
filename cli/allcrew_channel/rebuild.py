"""`allcrew-channel rebuild` — re-apply a fresh export.zip WITHOUT overwriting hand edits.

Python port of the plugin's regeneration merge (src/django/regenerate.ts): every generated
template is wrapped in a `{# GENERATED:BEGIN <node id> … #}` / `{# GENERATED:END <node id> #}`
pair, and a rebuild only ever replaces the text INSIDE the matching pair — anything a
developer wrote before/after it survives, and a template that carries no marker at all
(fully hand-authored) is left untouched with a warning. The node id is read from the fresh
file's own BEGIN marker, so renamed layers still land in the right block.

Everything outside `templates/` (static assets, locale, tokens.json, bootstrap.map.json,
DESIGN.md, COMPONENTS.md, previews/) is generator-owned and replaced wholesale, exactly like
`allcrew-channel apply`.

    allcrew-channel rebuild export.zip --app mysite/            # merge + write
    allcrew-channel rebuild export.zip --app mysite/ --dry-run  # classify only
    allcrew-channel rebuild export.zip --app mysite/ --diff     # show unified diffs for updates

Keep the marker strings in sync with src/django/regenerate.ts.
"""

from __future__ import annotations

import difflib
import re
import zipfile
from pathlib import Path

from .apply import KNOWN_ROOT_FILES, KNOWN_ROOTS, find_manage_dir

BEGIN_MARKER_RE = re.compile(r"\{# GENERATED:BEGIN (.+?) — edits outside this block survive regeneration #\}")


def begin_marker(node_id: str) -> str:
    return f"{{# GENERATED:BEGIN {node_id} — edits outside this block survive regeneration #}}"


def end_marker(node_id: str) -> str:
    return f"{{# GENERATED:END {node_id} #}}"


def extract_node_id(fresh: str) -> str | None:
    match = BEGIN_MARKER_RE.search(fresh)
    return match.group(1) if match else None


def _find_span(content: str, node_id: str) -> tuple[int, int] | None:
    begin = begin_marker(node_id)
    begin_index = content.find(begin)
    if begin_index == -1:
        return None
    content_start = begin_index + len(begin)
    end_index = content.find(end_marker(node_id), content_start)
    if end_index == -1:
        return None
    return content_start, end_index


def merge_generated(existing: str | None, node_id: str, fresh: str) -> str | None:
    """1:1 port of regenerate.ts's mergeGenerated: returns the merged text, or None when the
    existing file carries no marker for `node_id` (fully hand-authored — leave untouched)."""
    if existing is None:
        return fresh
    existing_span = _find_span(existing, node_id)
    if existing_span is None:
        return None
    fresh_span = _find_span(fresh, node_id)
    if fresh_span is None:
        return fresh
    fresh_inner = fresh[fresh_span[0] : fresh_span[1]]
    return existing[: existing_span[0]] + fresh_inner + existing[existing_span[1] :]


def run(args) -> int:
    zip_path = Path(args.zip)
    app_dir = Path(args.app).resolve()
    if not zip_path.exists():
        print(f"[allcrew-channel rebuild] {zip_path} not found")
        return 1
    if find_manage_dir(app_dir) is None:
        print(f"[allcrew-channel rebuild] no manage.py found at or above {app_dir} — is this a Django project?")
        return 1

    counts = {"created": 0, "merged": 0, "replaced": 0, "unchanged": 0, "kept": 0}
    warnings: list[str] = []

    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as error:
        print(f"[allcrew-channel rebuild] {error}")
        return 1

    with zf:
        for info in zf.infolist():
            name = info.filename
            if info.is_dir() or not (name.startswith(KNOWN_ROOTS) or name in KNOWN_ROOT_FILES):
                continue
            target = app_dir / name
            fresh_bytes = zf.read(info)

            if name.startswith("templates/"):
                fresh = fresh_bytes.decode("utf-8")
                existing = target.read_text(encoding="utf-8") if target.exists() else None
                node_id = extract_node_id(fresh)
                merged = merge_generated(existing, node_id, fresh) if node_id else fresh

                if merged is None:
                    counts["kept"] += 1
                    warnings.append(f"{name}: no GENERATED marker for {node_id} — left untouched (hand-authored)")
                    continue
                if existing is None:
                    action = "created"
                elif merged == existing:
                    action = "unchanged"
                else:
                    action = "merged"
                counts[action] += 1
                if action == "merged" and args.diff:
                    diff = difflib.unified_diff(
                        existing.splitlines(keepends=True),
                        merged.splitlines(keepends=True),
                        fromfile=f"a/{name}",
                        tofile=f"b/{name}",
                    )
                    print("".join(diff), end="")
                if action != "unchanged" and not args.dry_run:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(merged, encoding="utf-8")
                continue

            # Non-template roots are generator-owned — replaced wholesale, like `apply`.
            if target.exists() and target.read_bytes() == fresh_bytes:
                counts["unchanged"] += 1
                continue
            action = "replaced" if target.exists() else "created"
            counts[action] += 1
            if not args.dry_run:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(fresh_bytes)

    verb = "would be" if args.dry_run else ""
    summary = ", ".join(f"{count} {action}{' ' + verb if verb else ''}".strip() for action, count in counts.items() if count)
    print(f"[allcrew-channel rebuild] {summary or 'nothing to do'}")
    for warning in warnings:
        print(f"[allcrew-channel rebuild] warning: {warning}")
    return 0
