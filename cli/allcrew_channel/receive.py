"""`allcrew-channel receive` — JSON folder receiver for the plugin's Delivery setting.

The plugin POSTs the same per-file JSON contract as the Node receiver. This CLI accepts the
`folder` target only, builds the files into an in-memory zip, and passes it through `apply_export`
so known-root filtering, project-file skips and manual-asset reporting stay identical to `apply`.
`route.path` selects the app-relative destination; `dryRun` returns the plan without writing.

    allcrew-channel receive --app mysite/ --secret s3cret
    allcrew-channel receive --app mysite/ --secret s3cret --once
"""

from __future__ import annotations

import base64
import binascii
import hmac
import io
import json
import tempfile
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path, PurePosixPath

from .apply import ApplyResult, apply_export, find_manage_dir

MAX_BODY_BYTES = 64 * 1024 * 1024


class DeliveryRefusal(ValueError):
    """A malformed or unsafe request the caller can correct."""


def _relative_path(raw: object, field: str) -> Path:
    value = str(raw or "").replace("\\", "/")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part == ".." for part in path.parts):
        raise DeliveryRefusal(f"invalid {field} (traversal): {value}")
    cleaned = [part for part in path.parts if part not in ("", ".")]
    return Path(*cleaned)


def _file_bytes(name: str, value: object) -> tuple[bytes, bool]:
    if isinstance(value, str):
        return value.encode("utf-8"), False
    if isinstance(value, dict) and isinstance(value.get("base64"), str):
        try:
            return base64.b64decode(value["base64"], validate=True), True
        except (binascii.Error, ValueError) as error:
            raise DeliveryRefusal(f'file "{name}" has invalid base64') from error
    raise DeliveryRefusal(f'file "{name}" must be text or {{"base64": "…"}}')


def _folder_delivery(app_dir: Path, message: object) -> tuple[dict, ApplyResult]:
    if not isinstance(message, dict):
        raise DeliveryRefusal("body must be a JSON object")
    target = message.get("target") or "folder"
    if target != "folder":
        raise DeliveryRefusal('allcrew-channel receive supports target "folder" only')
    route = message.get("route") or {}
    if not isinstance(route, dict):
        raise DeliveryRefusal("route must be an object")
    files = message.get("files")
    if not isinstance(files, dict) or not files:
        raise DeliveryRefusal("no files in payload")

    destination = app_dir / _relative_path(route.get("path", ""), "route.path")
    contents: dict[str, tuple[bytes, bool]] = {}
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as zf:
        for name, value in files.items():
            if not isinstance(name, str) or not name:
                raise DeliveryRefusal("file paths must be non-empty strings")
            relative = _relative_path(name, "file path")
            if not relative.parts:
                raise DeliveryRefusal("file paths must be non-empty strings")
            normalized = relative.as_posix()
            if normalized in contents:
                raise DeliveryRefusal(f'duplicate file path after normalization: "{normalized}"')
            content, binary = _file_bytes(name, value)
            contents[normalized] = (content, binary)
            zf.writestr(normalized, content)

    existing = {
        name: (destination / name).read_bytes() if (destination / name).is_file() else None
        for name in contents
    }
    dry_run = message.get("dryRun") is True
    with tempfile.NamedTemporaryFile(suffix=".zip") as spool:
        spool.write(archive.getbuffer())
        spool.flush()
        result = apply_export(Path(spool.name), destination, dry_run=dry_run)

    plan_files = []
    for name in result.written:
        content, binary = contents[name]
        previous = existing[name]
        action = "create" if previous is None else "unchanged" if previous == content else "update"
        plan_files.append({
            "path": name,
            "action": action,
            "added": 0,
            "removed": 0,
            "binary": binary,
        })

    detail_parts = [
        (
            f"dry run: {len(result.written)} file(s) would be applied to {destination} (nothing written)"
            if dry_run
            else f"applied {len(result.written)} file(s) to {destination}"
        )
    ]
    if result.skipped_project_files:
        detail_parts.append("skipped project files: " + ", ".join(result.skipped_project_files))
    if result.manual_assets.missing:
        detail_parts.append(
            "missing manual assets: "
            + ", ".join(f"static/{asset}" for asset in result.manual_assets.missing)
        )
    response = {
        "ok": True,
        "target": "folder",
        "dryRun": dry_run,
        "detail": "; ".join(detail_parts),
        "plan": {"files": plan_files, "diff": "", "truncated": False},
    }
    return response, result


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
            self.send_header("Access-Control-Allow-Headers", "Content-Type, x-allcrew-channel-secret")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802 — health check
            self._respond(200, {
                "ok": True,
                "service": "allcrew-channel-receive",
                "targets": ["folder"],
                "capabilities": {"app": str(app_dir), "dryRun": True},
            })

        def do_POST(self) -> None:  # noqa: N802
            provided = self.headers.get("x-allcrew-channel-secret", "")
            if secret and not hmac.compare_digest(provided.encode(), secret.encode()):
                self._respond(403, {"ok": False, "error": "bad secret"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0") or "0")
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_BODY_BYTES:
                self._respond(400, {"ok": False, "error": f"bad Content-Length: {length}"})
                return

            try:
                message = json.loads(self.rfile.read(length).decode("utf-8"))
                response, result = _folder_delivery(app_dir, message)
            except (DeliveryRefusal, UnicodeDecodeError, json.JSONDecodeError, zipfile.BadZipFile) as error:
                self._respond(400, {"ok": False, "error": str(error)})
                return

            if not response["dryRun"]:
                on_applied()
                print(
                    f"[allcrew-channel receive] applied {len(result.written)} file(s) from {self.client_address[0]}",
                    flush=True,
                )
                for asset in result.manual_assets.missing:
                    print(
                        f"[allcrew-channel receive]   manual asset still missing: static/{asset}",
                        flush=True,
                    )
            self._respond(200, response)

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

    server = HTTPServer((args.host, args.port), make_handler(app_dir, args.secret, on_applied))
    print(f"[allcrew-channel receive] listening on http://{args.host or '0.0.0.0'}:{args.port} → {app_dir}", flush=True)
    print("[allcrew-channel receive] plugin Settings → Delivery → Endpoint: point it here", flush=True)
    try:
        if args.once:
            while applied["count"] == 0:
                server.handle_request()
        else:
            server.serve_forever()
    except KeyboardInterrupt:
        print("\n[allcrew-channel receive] stopped")
    finally:
        server.server_close()
    return 0
