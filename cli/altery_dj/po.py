"""`altery-dj po merge` — merge the plugin's figma.po into Django's django.po.

Python port of the retired scripts/merge-po.mjs: runs `msgmerge -U` so django.po is
updated in place with figma.po as the reference catalog. `django-admin makemessages` /
`compilemessages` stay the sole owners of django.po's lifecycle — this command never
runs them. Full cycle:

    django-admin makemessages -l ru
    altery-dj po merge --locale ru
    django-admin compilemessages -l ru
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def resolve_paths(args) -> tuple[Path, Path]:
    app_dir = Path(args.app).resolve()
    django_po = Path(args.django_po) if args.django_po else app_dir / "locale" / args.locale / "LC_MESSAGES" / "django.po"
    figma_po = Path(args.figma_po) if args.figma_po else app_dir / "locale" / "figma.po"
    return django_po, figma_po


def run(args) -> int:
    if shutil.which("msgmerge") is None:
        print("[altery-dj po] msgmerge (GNU gettext) not found on PATH — install gettext first")
        return 1
    django_po, figma_po = resolve_paths(args)
    if not django_po.exists():
        print(f"[altery-dj po] {django_po} not found — run `django-admin makemessages -l {args.locale}` first")
        return 1
    if not figma_po.exists():
        print(f"[altery-dj po] {figma_po} not found — export it from the Figma plugin first")
        return 1

    result = subprocess.run(
        ["msgmerge", "--update", "--backup=none", str(django_po), str(figma_po)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"[altery-dj po] msgmerge exited with code {result.returncode}: {result.stderr.strip()}")
        return 1
    print(f"[altery-dj po] merged {figma_po} into {django_po}")
    print("[altery-dj po] next: django-admin compilemessages (or `python manage.py compilemessages`)")
    return 0
