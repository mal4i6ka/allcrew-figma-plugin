"""`altery-dj bootstrap vendor` — download Bootstrap into <app>/static/vendor/bootstrap/.

The plugin runs with networkAccess "none", so it can't ship Bootstrap's files itself —
base.html's `vendored` source (Settings → Bootstrap source) expects this command to have
placed them. Downloads from jsdelivr pinned to --version (partial pins like `5.3` resolve
to the latest matching release).
"""

from __future__ import annotations

import urllib.error
import urllib.request
from pathlib import Path

VENDOR_FILES = ("css/bootstrap.min.css", "js/bootstrap.bundle.min.js")


def run(args) -> int:
    app_dir = Path(args.app).resolve()
    target_dir = app_dir / "static" / "vendor" / "bootstrap"
    base = args.url_base.rstrip("/")

    downloads = []
    for dist_path in VENDOR_FILES:
        url = f"{base}/bootstrap@{args.version}/dist/{dist_path}"
        filename = dist_path.rsplit("/", 1)[1]
        downloads.append((url, target_dir / filename))

    target_dir.mkdir(parents=True, exist_ok=True)
    for url, target in downloads:
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                target.write_bytes(response.read())
        except (urllib.error.URLError, OSError) as error:
            print(f"[altery-dj bootstrap] failed to fetch {url}: {error}")
            return 1
        print(f"[altery-dj bootstrap] wrote {target.relative_to(app_dir)}")
    print(
        "[altery-dj bootstrap] base.html's vendored links expect exactly these paths"
        " (static/vendor/bootstrap/bootstrap.min.css + bootstrap.bundle.min.js)"
    )
    return 0
