"""`altery-dj serve|stop|status|logs` — lifecycle of the project's Django dev server.

The server runs detached (`start_new_session`) with its pid/port/log recorded under
`<manage_dir>/.altery-dj/`, using the project's own `.venv` interpreter when present
(pyenv.project_python). `runserver --noreload` keeps one traceable pid; with DEBUG on,
Django re-reads templates and static files per request, so a fresh `altery-dj apply`
shows up in the browser without a restart.
"""

from __future__ import annotations

import errno
import json
import os
import signal
import socket
import subprocess
import time
from pathlib import Path

from .apply import find_manage_dir
from .pyenv import django_missing_hint, has_django, project_python

STATE_DIR_NAME = ".altery-dj"


def _state_dir(manage_dir: Path) -> Path:
    return manage_dir / STATE_DIR_NAME


def _state_file(manage_dir: Path) -> Path:
    return _state_dir(manage_dir) / "server.json"


def _log_file(manage_dir: Path) -> Path:
    return _state_dir(manage_dir) / "server.log"


def _read_state(manage_dir: Path) -> dict | None:
    try:
        state = json.loads(_state_file(manage_dir).read_text())
        return state if isinstance(state, dict) and "pid" in state else None
    except (OSError, json.JSONDecodeError):
        return None


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError as error:
        return error.errno == errno.EPERM
    return True


def _port_free(host: str, port: int) -> bool:
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def _resolve_manage_dir(args) -> Path | None:
    app_dir = Path(args.app).resolve()
    manage_dir = find_manage_dir(app_dir)
    if manage_dir is None:
        print(f"[altery-dj] no manage.py found at or above {app_dir} — is this a Django project?")
    return manage_dir


def restart_if_running(manage_dir: Path) -> bool:
    """If an altery-dj-managed server is running for `manage_dir`, restart it on the same
    host/port. `runserver --noreload` can keep serving stale markup after a re-apply (the
    process that produced the browser's "old import" after `apply wrote N files"), so `apply`
    calls this to guarantee the next refresh shows the freshly written templates. Returns
    whether a server was restarted."""
    import argparse

    state = _read_state(manage_dir)
    if not state or not _alive(state["pid"]):
        return False
    host, port = state["host"], state["port"]
    run_stop(argparse.Namespace(app=str(manage_dir)))
    run_serve(argparse.Namespace(app=str(manage_dir), host=host, port=port, foreground=False))
    return True


def _url(state: dict) -> str:
    return f"http://{state['host']}:{state['port']}/"


def run_serve(args) -> int:
    manage_dir = _resolve_manage_dir(args)
    if manage_dir is None:
        return 1
    python = project_python(manage_dir)
    if not has_django(python):
        print(f"[altery-dj serve] {django_missing_hint(manage_dir)}")
        return 1

    state = _read_state(manage_dir)
    if state and _alive(state["pid"]):
        print(f"[altery-dj serve] already running (pid {state['pid']}) → {_url(state)}")
        if state["port"] != args.port:
            print(f"[altery-dj serve] note: it serves port {state['port']}, not {args.port} — `altery-dj stop` first to move it")
        return 0

    command = [python, str(manage_dir / "manage.py"), "runserver", f"{args.host}:{args.port}", "--noreload"]
    if args.foreground:
        return subprocess.run(command, cwd=manage_dir).returncode

    if not _port_free(args.host, args.port):
        print(f"[altery-dj serve] {args.host}:{args.port} is already taken by another process")
        print("  stop whatever serves it, or pick a different --port")
        return 1

    _state_dir(manage_dir).mkdir(exist_ok=True)
    log_path = _log_file(manage_dir)
    with open(log_path, "ab") as log:
        process = subprocess.Popen(command, cwd=manage_dir, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    _state_file(manage_dir).write_text(
        json.dumps({"pid": process.pid, "host": args.host, "port": args.port, "python": python})
    )

    # runserver either starts listening within moments or dies with a traceback — wait for
    # one of the two so the user never gets a "started" that is already dead.
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            print(f"[altery-dj serve] server exited immediately (code {process.returncode}) — last log lines:")
            _print_log_tail(log_path, 15)
            _state_file(manage_dir).unlink(missing_ok=True)
            return 1
        if not _port_free(args.host, args.port):
            print(f"[altery-dj serve] running (pid {process.pid}) → http://{args.host}:{args.port}/")
            print(f"  log: {log_path}")
            return 0
        time.sleep(0.2)
    print(f"[altery-dj serve] server did not open {args.host}:{args.port} within 15s — check the log:")
    _print_log_tail(log_path, 15)
    return 1


def run_stop(args) -> int:
    manage_dir = _resolve_manage_dir(args)
    if manage_dir is None:
        return 1
    state = _read_state(manage_dir)
    if not state or not _alive(state["pid"]):
        _state_file(manage_dir).unlink(missing_ok=True)
        print("[altery-dj stop] no server running")
        return 0
    pid = state["pid"]
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and _alive(pid):
        time.sleep(0.1)
    if _alive(pid):
        os.kill(pid, signal.SIGKILL)
    _state_file(manage_dir).unlink(missing_ok=True)
    print(f"[altery-dj stop] stopped (pid {pid})")
    return 0


def run_status(args) -> int:
    manage_dir = _resolve_manage_dir(args)
    if manage_dir is None:
        return 1
    python = project_python(manage_dir)
    print(f"[altery-dj status] project: {manage_dir}")
    print(f"  python: {python} (django: {'yes' if has_django(python) else 'NO — altery-dj demo init'})")
    state = _read_state(manage_dir)
    if state and _alive(state["pid"]):
        print(f"  server: running (pid {state['pid']}) → {_url(state)}")
        print(f"  log: {_log_file(manage_dir)}")
    else:
        print("  server: not running (altery-dj serve)")
    return 0


def _print_log_tail(log_path: Path, lines: int) -> None:
    try:
        tail = log_path.read_text(errors="replace").splitlines()[-lines:]
    except OSError:
        print("  (no log)")
        return
    for line in tail:
        print("  " + line)


def run_logs(args) -> int:
    manage_dir = _resolve_manage_dir(args)
    if manage_dir is None:
        return 1
    log_path = _log_file(manage_dir)
    if not log_path.exists():
        print(f"[altery-dj logs] no log yet at {log_path}")
        return 0
    _print_log_tail(log_path, args.lines)
    return 0
