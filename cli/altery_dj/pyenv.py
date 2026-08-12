"""Which Python interpreter runs a Django project: the stand's own `.venv` when present,
else the interpreter running altery-dj itself. Central so `check`, `serve` and `demo`
agree — running manage.py with the CLI's interpreter is exactly the "No module named
'django'" trap this resolves."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def venv_python(manage_dir: Path) -> Path | None:
    relative = ("Scripts", "python.exe") if os.name == "nt" else ("bin", "python")
    candidate = manage_dir.joinpath(".venv", *relative)
    return candidate if candidate.exists() else None


def project_python(manage_dir: Path) -> str:
    python = venv_python(manage_dir)
    return str(python) if python is not None else sys.executable


def has_django(python: str) -> bool:
    return subprocess.run([python, "-c", "import django"], capture_output=True).returncode == 0


def django_missing_hint(manage_dir: Path) -> str:
    return (
        f"no Django importable by {project_python(manage_dir)}\n"
        f"  create the stand's venv:  altery-dj demo init --app {manage_dir}\n"
        f"  (or activate a virtualenv that has Django installed)"
    )
