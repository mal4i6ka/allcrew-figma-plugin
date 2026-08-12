"""`altery-dj check` — validate an applied export against the Django project.

Runs `manage.py check`, then a template SMOKE-RENDER (every template Django's loaders can
see — except `components/` partials, which need `{% include with %}` params — rendered with
an empty context, catching broken tags / missing `{% extends %}`/`{% include %}`), and,
when GNU gettext is available, `msgfmt --check` over every .po under <app>/locale. The quick
post-apply gate; the plugin repo's pytest suite goes deeper. `--no-render` skips the render.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from .apply import find_manage_dir
from .pyenv import django_missing_hint, has_django, project_python

# Runs INSIDE the project via `manage.py shell -c` (Django already configured). Enumerates every
# template dir the loaders know (engine DIRS + per-app templates/), renders each by its loader
# name with an empty context, and reports failures. Partials under components/ are skipped — they
# expect include params, so a bare render would false-fail.
_RENDER_SCRIPT = r"""
import os
import sys
from pathlib import Path
from django.template import engines
from django.template.loader import get_template
from django.template.utils import get_app_template_dirs

roots = []
for engine in engines.all():
    roots.extend(getattr(getattr(engine, "engine", None), "dirs", []) or [])
roots.extend(get_app_template_dirs("templates"))

# Only the project's OWN templates — not Django's bundled apps (admin/auth/forms partials that
# can't render standalone). ALTERY_RENDER_ROOT is the project root (manage.py's dir).
project_root = Path(os.environ.get("ALTERY_RENDER_ROOT", "")).resolve()

seen, failures, rendered = set(), [], 0
for root in roots:
    root = Path(root).resolve()
    if not root.is_dir() or project_root not in root.parents and root != project_root:
        continue
    for tpl in sorted(root.rglob("*.html")):
        name = tpl.relative_to(root).as_posix()
        if name in seen or name.startswith("components/") or "/components/" in name:
            continue
        seen.add(name)
        try:
            get_template(name).render({})
            rendered += 1
        except Exception as exc:
            failures.append(name + " :: " + repr(exc))

print("RENDERED %d" % rendered)
for f in failures:
    print("RENDER-FAIL " + f)
sys.exit(1 if failures else 0)
"""


def run(args) -> int:
    app_dir = Path(args.app).resolve()
    manage_dir = find_manage_dir(app_dir)
    if manage_dir is None:
        print(f"[altery-dj check] no manage.py found at or above {app_dir}")
        return 1

    # The stand's own venv when present — running manage.py with the CLI's interpreter is
    # the "No module named 'django'" trap.
    python = project_python(manage_dir)
    if not has_django(python):
        print(f"[altery-dj check] {django_missing_hint(manage_dir)}")
        return 1

    result = subprocess.run(
        [python, str(manage_dir / "manage.py"), "check"],
        cwd=manage_dir,
        capture_output=True,
        text=True,
    )
    output = (result.stdout + result.stderr).strip()
    print(f"[altery-dj check] manage.py check → {'ok' if result.returncode == 0 else 'FAILED'}")
    if output:
        print("  " + "\n  ".join(output.splitlines()))
    if result.returncode != 0:
        return 1

    if not args.no_render:
        render = subprocess.run(
            [python, str(manage_dir / "manage.py"), "shell", "-c", _RENDER_SCRIPT],
            cwd=manage_dir,
            capture_output=True,
            text=True,
            env={**os.environ, "ALTERY_RENDER_ROOT": str(manage_dir)},
        )
        render_out = (render.stdout + render.stderr).strip()
        fails = [line for line in render.stdout.splitlines() if line.startswith("RENDER-FAIL")]
        rendered = next((line for line in render.stdout.splitlines() if line.startswith("RENDERED")), "RENDERED 0")
        status = "ok" if render.returncode == 0 else "FAILED"
        print(f"[altery-dj check] template smoke-render → {status} ({rendered.split(' ', 1)[-1]} rendered)")
        if render.returncode != 0:
            for line in fails or render_out.splitlines():
                print("  " + line)
            return 1

    po_files = sorted((app_dir / "locale").rglob("*.po")) if (app_dir / "locale").exists() else []
    if po_files and shutil.which("msgfmt") is None:
        print("[altery-dj check] msgfmt not found — skipping PO validation (install GNU gettext)")
    else:
        for po_file in po_files:
            po_result = subprocess.run(
                ["msgfmt", "--check", "--output-file", "/dev/null" if sys.platform != "win32" else "NUL", str(po_file)],
                capture_output=True,
                text=True,
            )
            status = "ok" if po_result.returncode == 0 else "FAILED"
            print(f"[altery-dj check] msgfmt {po_file.relative_to(app_dir)} → {status}")
            if po_result.returncode != 0:
                print("  " + "\n  ".join(po_result.stderr.strip().splitlines()))
                return 1
    return 0
