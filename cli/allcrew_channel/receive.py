"""`allcrew-channel receive` — HTTP receiver for the plugin's Delivery setting (REFORM phase 8).

The plugin's UI POSTs the built export.zip (Content-Type: application/zip, shared secret
in `X-AllCrew-Channel-Secret`); the receiver applies it with the SAME code path as `allcrew-channel
apply` and answers `{"written": N}`. The plugin runs in a browser iframe, so cross-origin
preflight (OPTIONS) is answered with permissive CORS headers — authentication is the
secret, not the origin. The secret check is timing-safe (`hmac.compare_digest`).

    allcrew-channel receive --app mysite/ --secret s3cret          # serve until Ctrl-C
    allcrew-channel receive --app mysite/ --secret s3cret --once   # exit after one applied zip
"""

from __future__ import annotations

import hmac
import json
import tempfile
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from .apply import apply_export, find_manage_dir

MAX_ZIP_BYTES = 512 * 1024 * 1024  # a runaway body guard, far above any real export


def make_handler(app_dir: Path, secret: str, on_applied) -> type[BaseHTTPRequestHandler]:
    class DeliveryHandler(BaseHTTPRequestHandler):
        server_version = "allcrew-channel-receive"

        def log_message(self, *_args) -> None:  # noqa: N802 — quiet; we print our own lines
            pass

        def _respond(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802 — CORS preflight from the plugin iframe
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-AllCrew-Channel-Secret")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802 — health check
            self._respond(200, {"status": "ok", "app": str(app_dir)})

        def do_POST(self) -> None:  # noqa: N802
            provided = self.headers.get("X-AllCrew-Channel-Secret", "")
            if secret and not hmac.compare_digest(provided.encode(), secret.encode()):
                self._respond(403, {"error": "bad secret"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0") or "0")
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_ZIP_BYTES:
                self._respond(400, {"error": f"bad Content-Length: {length}"})
                return

            body = self.rfile.read(length)
            with tempfile.NamedTemporaryFile(suffix=".zip") as spool:
                spool.write(body)
                spool.flush()
                try:
                    result = apply_export(Path(spool.name), app_dir)
                except (ValueError, zipfile.BadZipFile) as error:
                    self._respond(400, {"error": str(error)})
                    return

            self._respond(
                200,
                {
                    "written": len(result.written),
                    "missingManualAssets": result.manual_assets.missing,
                },
            )
            # flush=True: stdout is block-buffered when piped (plugin users tail the log;
            # the test suite reads these lines as barriers).
            print(f"[allcrew-channel receive] applied {len(result.written)} file(s) from {self.client_address[0]}", flush=True)
            for asset in result.manual_assets.missing:
                print(f"[allcrew-channel receive]   manual asset still missing: static/{asset}", flush=True)
            on_applied()

    return DeliveryHandler


def run(args) -> int:
    app_dir = Path(args.app).resolve()
    if find_manage_dir(app_dir) is None:
        print(f"[allcrew-channel receive] no manage.py found at or above {app_dir} — is this a Django project?")
        return 1
    if not args.secret:
        print("[allcrew-channel receive] warning: no --secret set — any sender on the network can deliver")

    applied = {"count": 0}

    def on_applied() -> None:
        applied["count"] += 1

    # Synchronous by design: one plugin client, quick requests — and `--once`'s post-request
    # count check only works when handle_request() processes the request in THIS thread.
    server = HTTPServer((args.host, args.port), make_handler(app_dir, args.secret, on_applied))
    print(f"[allcrew-channel receive] listening on http://{args.host or '0.0.0.0'}:{args.port} → {app_dir}", flush=True)
    print("[allcrew-channel receive] plugin Settings → Delivery → Endpoint: point it here", flush=True)
    try:
        if args.once:
            # Serve until one zip has been APPLIED (preflights/health checks/403s don't count).
            while applied["count"] == 0:
                server.handle_request()
        else:
            server.serve_forever()
    except KeyboardInterrupt:
        print("\n[allcrew-channel receive] stopped")
    finally:
        server.server_close()
    return 0
