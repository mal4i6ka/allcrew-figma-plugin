"""`altery-dj apply` — unpack the plugin's export.zip under a Django app directory.

Python port of the retired scripts/apply-django-export.mjs, same conventions:
the zip's `templates/`, `static/` and `locale/` trees land DIRECTLY under `<app>/…`
(unprefixed `{% static %}`/`{% include %}` paths only resolve via APP_DIRS /
AppDirectoriesFinder from there), and `manage.py` must exist at or above the app dir.

Extension over the Node script: the package-metadata files the CLI itself consumes
(`tokens.json`, `bootstrap.map.json` — inputs of `altery-dj tokens`) are copied to the
app root too, as are `DESIGN.md` and `COMPONENTS.md` + `previews/` (the design contract and
the per-component behaviour contracts coding agents read from the repo — useless inside a zip
nobody unpacks). `export-report.json` stays zip-only (audit
metadata), but its `manualAssets` list is checked so missing video sources are called out.
"""

from __future__ import annotations

import json
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

KNOWN_ROOTS = ("templates/", "static/", "locale/", "previews/")
KNOWN_ROOT_FILES = ("tokens.json", "bootstrap.map.json", "DESIGN.md", "COMPONENTS.md")


def find_manage_dir(start_dir: Path) -> Path | None:
    """Walks up from `start_dir` looking for a `manage.py`; returns its directory or None."""
    current = start_dir.resolve()
    while True:
        if (current / "manage.py").exists():
            return current
        if current.parent == current:
            return None
        current = current.parent


@dataclass
class ManualAssets:
    declared: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    present: list[str] = field(default_factory=list)


@dataclass
class ApplyResult:
    app_dir: Path
    manage_dir: Path
    written: list[str]
    manual_assets: ManualAssets


def apply_export(zip_path: Path, app_dir: Path, dry_run: bool = False) -> ApplyResult:
    """Extracts the export zip's known roots under `app_dir`. Raises SystemExit-friendly
    ValueError when no manage.py is found at or above `app_dir`."""
    manage_dir = find_manage_dir(app_dir)
    if manage_dir is None:
        raise ValueError(f"no manage.py found at or above {app_dir} — is this a Django project?")

    written: list[str] = []
    manual = ManualAssets()
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = info.filename
            if not (name.startswith(KNOWN_ROOTS) or name in KNOWN_ROOT_FILES):
                continue
            target = app_dir / name
            if not dry_run:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zf.read(info))
            written.append(name)

        # manualAssets: static paths the plugin could not ship (the Figma API has no
        # video-byte access). Manually placed files are never overwritten by this command,
        # so report which are still missing and which are already satisfied.
        if "export-report.json" in zf.namelist():
            try:
                report = json.loads(zf.read("export-report.json"))
                declared = report.get("manualAssets")
                manual.declared = declared if isinstance(declared, list) else []
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass  # a malformed report must not fail the apply — the trees already landed
            for asset in manual.declared:
                bucket = manual.present if (app_dir / "static" / asset).exists() else manual.missing
                bucket.append(asset)

    return ApplyResult(app_dir=app_dir, manage_dir=manage_dir, written=written, manual_assets=manual)


def _warn_if_unwired_project_root(app_dir: Path, manage_dir: Path) -> None:
    """`--app` pointing at the PROJECT root is silently invisible to stock Django: only
    app-level templates/static resolve via APP_DIRS, so the applied files render nothing
    and the browser keeps showing the old import. Warn unless some settings.py wires
    TEMPLATES.DIRS/STATICFILES_DIRS to the root (the demo stand's scaffold does)."""
    if app_dir != manage_dir:
        return
    for settings_file in app_dir.glob("*/settings.py"):
        text = settings_file.read_text(errors="replace")
        if re.search(r"BASE_DIR\s*/\s*['\"]templates['\"]", text):
            return
    print(
        "[altery-dj apply] note: --app is the PROJECT root, and no settings.py wires\n"
        "  TEMPLATES.DIRS / STATICFILES_DIRS to it — stock Django only loads app-level\n"
        "  templates/static (APP_DIRS), so these files may be invisible to the site.\n"
        "  Either point --app at the app directory (e.g. --app pages/), or serve exports\n"
        "  with the wired demo stand: altery-dj demo up export.zip --app <dir>"
    )


def run(args) -> int:
    zip_path = Path(args.zip)
    app_dir = Path(args.app).resolve()
    if not zip_path.exists():
        print(f"[altery-dj apply] {zip_path} not found")
        return 1
    try:
        result = apply_export(zip_path, app_dir, dry_run=args.dry_run)
    except (ValueError, zipfile.BadZipFile) as error:
        print(f"[altery-dj apply] {error}")
        return 1

    verb = "would write" if args.dry_run else "wrote"
    print(f"[altery-dj apply] manage.py found at {result.manage_dir}")
    print(f"[altery-dj apply] {verb} {len(result.written)} files under {app_dir}:")
    for name in result.written:
        print(f"  {name}")
    _warn_if_unwired_project_root(app_dir, result.manage_dir)
    for asset in result.manual_assets.present:
        print(f"[altery-dj apply] manual asset already in place: static/{asset}")
    if result.manual_assets.missing:
        print(
            f"[altery-dj apply] {len(result.manual_assets.missing)} manual asset(s) still missing"
            " — the Figma API cannot export video bytes."
        )
        print("  In Figma: Dev Mode (Shift+D) → select the video layer → Assets → Download, then save as:")
        for asset in result.manual_assets.missing:
            print(f"    {app_dir / 'static' / asset}")

    if not args.dry_run:
        # An 'assume'-mode export ships a base.html whose Bootstrap link is a comment, so apply
        # would drop it — the utility-class layout (d-flex/d-grid) then dies at the widest
        # breakpoint (only @media raw CSS survives below it). If the stand already vendored
        # Bootstrap, relink so the framework keeps loading. (Downloading stays in `demo`/`bootstrap
        # vendor` — apply does no network.)
        from .demo import relink_assume_to_vendored, vendored_bootstrap_present

        if vendored_bootstrap_present(app_dir) and relink_assume_to_vendored(app_dir):
            print("[altery-dj apply] relinked base.html to the vendored Bootstrap (assume-mode export)")

        # A dev server left running from before this apply keeps serving the OLD templates
        # (runserver --noreload), so the browser shows stale markup after "wrote N files".
        # Restart a managed server so the next refresh reflects what we just wrote.
        from .serve import restart_if_running

        if restart_if_running(result.manage_dir):
            print("[altery-dj apply] restarted the running dev server — refresh the browser")
    return 0
