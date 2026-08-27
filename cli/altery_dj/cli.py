"""altery-dj command dispatcher. Every command lives in its own module; this file only
parses arguments and routes. `altery-dj help [command]` prints worked examples."""

from __future__ import annotations

import argparse
import sys

from . import __version__

EXAMPLES = {
    "apply": """\
  altery-dj apply export.zip                    # unpack into the current directory (must be a Django app)
  altery-dj apply export.zip --app myapp/       # unpack into a specific app dir
  altery-dj apply export.zip --dry-run          # list what would be written, write nothing""",
    "remap": """\
  altery-dj remap --map mapping.json                    # dry run over the current directory
  altery-dj remap --map mapping.json src/ --write       # apply, refuses on a dirty worktree
  altery-dj remap --map mapping.json --mode Light       # pick a theme when the mapping has several
  altery-dj remap --map mapping.json --snap 0           # exact colours only, no near matches
  altery-dj remap --map mapping.json --by-name          # also rewrite values by their token name""",
    "remap": """\
  altery-dj remap --map mapping.json                    # dry run over the current directory
  altery-dj remap --map mapping.json src/ --write       # apply, refuses on a dirty worktree
  altery-dj remap --map mapping.json --mode Light       # pick a theme when the mapping has several
  altery-dj remap --map mapping.json --snap 0           # exact colours only, no near matches
  altery-dj remap --map mapping.json --by-name          # also rewrite values by their token name""",
    "po": """\
  django-admin makemessages -l ru               # 1. Django owns django.po
  altery-dj po merge --locale ru                # 2. merge the plugin's figma.po into it
  django-admin compilemessages -l ru            # 3. compile
  altery-dj po merge --django-po locale/de/LC_MESSAGES/django.po --figma-po locale/figma.po""",
    "rebuild": """\
  altery-dj rebuild export.zip --app myapp/     # re-apply: hand edits OUTSIDE {# GENERATED #} markers survive
  altery-dj rebuild export.zip --dry-run        # classify only (created/merged/kept), write nothing
  altery-dj rebuild export.zip --diff           # unified diff for every merged template""",
    "tokens": """\
  altery-dj tokens                              # rebuild every derived file tokens.json supports
  altery-dj tokens --format bootstrap           # only bootstrap-tokens.css (after editing bootstrap.map.json)
  altery-dj tokens --format css --flatten-all   # tokens.css with every alias resolved to a literal
  altery-dj tokens --theme-attr data-theme      # non-Bootstrap theme attribute""",
    "bootstrap": """\
  altery-dj bootstrap vendor                    # fetch Bootstrap 5.3 into static/vendor/bootstrap/
  altery-dj bootstrap vendor --version 5.3.3    # pin an exact release""",
    "check": """\
  altery-dj check                               # manage.py check + template smoke-render + msgfmt
  altery-dj check --no-render                   # skip the template render step
  altery-dj check --app myapp/""",
    "receive": """\
  altery-dj receive --app myapp/ --secret s3cret        # accept deliveries from the plugin (port 8765)
  altery-dj receive --app myapp/ --port 9000 --once     # exit after the first applied package
  # In Figma: Settings → Delivery → Endpoint http://<this-machine>:8765, same secret""",
    "demo": """\
  altery-dj demo up export.zip --app .django-demo/      # venv + scaffold + apply + serve → http://127.0.0.1:8080/
  altery-dj demo init --app .django-demo/               # just the stand: scaffold wired for exports + venv""",
    "serve": """\
  altery-dj serve --app .django-demo/ --port 8080       # dev server in the background (pid under .altery-dj/)
  altery-dj status --app .django-demo/                  # pid / port / python / log location
  altery-dj logs --app .django-demo/ --lines 100        # tail the server log
  altery-dj stop --app .django-demo/""",
}


def _add_app_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--app", default=".", help="Django app directory (default: current directory)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="altery-dj",
        description="Terminal companion for the Altery Django Export Figma plugin.",
        epilog="Run `altery-dj help <command>` for worked examples.",
    )
    parser.add_argument("--version", action="version", version=f"altery-dj {__version__}")
    subparsers = parser.add_subparsers(dest="command")

    apply_parser = subparsers.add_parser("apply", help="unpack the plugin's export.zip under a Django app")
    apply_parser.add_argument("zip", help="path to the export.zip the plugin produced")
    _add_app_argument(apply_parser)
    apply_parser.add_argument("--dry-run", action="store_true", help="list what would be written, write nothing")

    rebuild_parser = subparsers.add_parser(
        "rebuild", help="re-apply an export.zip, preserving hand edits outside GENERATED markers"
    )
    rebuild_parser.add_argument("zip", help="path to a freshly exported export.zip")
    _add_app_argument(rebuild_parser)
    rebuild_parser.add_argument("--dry-run", action="store_true", help="classify files, write nothing")
    rebuild_parser.add_argument("--diff", action="store_true", help="print a unified diff for every merged template")

    po_parser = subparsers.add_parser("po", help="PO catalog operations")
    po_sub = po_parser.add_subparsers(dest="po_command", required=True)
    merge_parser = po_sub.add_parser("merge", help="msgmerge the plugin's figma.po into django.po")
    merge_parser.add_argument("--locale", default="ru", help="locale whose django.po to update (default: ru)")
    _add_app_argument(merge_parser)
    merge_parser.add_argument("--django-po", help="explicit path to django.po (overrides --locale/--app)")
    merge_parser.add_argument("--figma-po", help="explicit path to figma.po (default: <app>/locale/figma.po)")

    tokens_parser = subparsers.add_parser("tokens", help="rebuild derived token files from tokens.json")
    tokens_parser.add_argument("--format", choices=["css", "bootstrap", "scss", "all"], default="all")
    _add_app_argument(tokens_parser)
    tokens_parser.add_argument("--theme-attr", default="data-bs-theme", help="theme attribute for CSS selectors")
    tokens_parser.add_argument("--no-inline", action="store_true", help="keep aliases as var() references in tokens.css")
    tokens_parser.add_argument("--flatten-all", action="store_true", help="resolve EVERY alias to a literal in tokens.css")

    from . import remap

    from . import remap

    remap.add_parser(subparsers)

    bootstrap_parser = subparsers.add_parser("bootstrap", help="Bootstrap framework helpers")
    bootstrap_sub = bootstrap_parser.add_subparsers(dest="bootstrap_command", required=True)
    vendor_parser = bootstrap_sub.add_parser("vendor", help="download Bootstrap into static/vendor/bootstrap/")
    vendor_parser.add_argument("--version", default="5.3", help="Bootstrap version pin (default: 5.3)")
    _add_app_argument(vendor_parser)
    vendor_parser.add_argument("--url-base", default="https://cdn.jsdelivr.net/npm", help=argparse.SUPPRESS)

    check_parser = subparsers.add_parser("check", help="manage.py check + template smoke-render + msgfmt")
    _add_app_argument(check_parser)
    check_parser.add_argument("--no-render", action="store_true", help="skip the template smoke-render step")

    receive_parser = subparsers.add_parser("receive", help="HTTP receiver for the plugin's Delivery setting")
    _add_app_argument(receive_parser)
    receive_parser.add_argument("--port", type=int, default=8765, help="port to listen on (default: 8765)")
    receive_parser.add_argument("--host", default="", help="bind address (default: all interfaces)")
    receive_parser.add_argument("--secret", default="", help="shared secret the plugin sends as X-Altery-Secret")
    receive_parser.add_argument("--once", action="store_true", help="exit after one successfully applied package")

    demo_parser = subparsers.add_parser("demo", help="self-contained demo stand: scaffold + venv + server")
    demo_sub = demo_parser.add_subparsers(dest="demo_command", required=True)
    init_parser = demo_sub.add_parser("init", help="scaffold a stand wired for the plugin's export layout")
    _add_app_argument(init_parser)
    init_parser.add_argument("--no-venv", action="store_true", help="skip venv creation (use the current interpreter)")
    up_parser = demo_sub.add_parser("up", help="init + apply an export.zip + serve, end to end")
    up_parser.add_argument("zip", help="path to the export.zip the plugin produced")
    _add_app_argument(up_parser)
    up_parser.add_argument("--port", type=int, default=8080, help="dev-server port (default: 8080)")
    up_parser.add_argument("--no-venv", action="store_true", help="skip venv creation (use the current interpreter)")
    up_parser.add_argument("--url-base", default="https://cdn.jsdelivr.net/npm", help=argparse.SUPPRESS)

    serve_parser = subparsers.add_parser("serve", help="start the project's dev server in the background")
    _add_app_argument(serve_parser)
    serve_parser.add_argument("--port", type=int, default=8080, help="dev-server port (default: 8080)")
    serve_parser.add_argument("--host", default="127.0.0.1", help="bind address (default: 127.0.0.1)")
    serve_parser.add_argument("--foreground", action="store_true", help="run attached to this terminal instead")

    stop_parser = subparsers.add_parser("stop", help="stop the dev server started by `altery-dj serve`")
    _add_app_argument(stop_parser)

    status_parser = subparsers.add_parser("status", help="dev-server / interpreter status for the project")
    _add_app_argument(status_parser)

    logs_parser = subparsers.add_parser("logs", help="tail the dev-server log")
    _add_app_argument(logs_parser)
    logs_parser.add_argument("--lines", type=int, default=50, help="how many trailing lines to print (default: 50)")

    help_parser = subparsers.add_parser("help", help="show worked examples for a command")
    help_parser.add_argument("topic", nargs="?", choices=[*EXAMPLES.keys()])

    return parser


def _run_help(parser: argparse.ArgumentParser, topic: str | None) -> int:
    if topic:
        print(f"altery-dj {topic} — examples:\n{EXAMPLES[topic]}")
        return 0
    parser.print_help()
    print("\nexamples:")
    for command_examples in EXAMPLES.values():
        print(command_examples)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command is None or args.command == "help":
        return _run_help(parser, getattr(args, "topic", None))
    if args.command == "apply":
        from . import apply
        return apply.run(args)
    if args.command == "rebuild":
        from . import rebuild
        return rebuild.run(args)
    if args.command == "po":
        from . import po
        return po.run(args)
    if args.command == "tokens":
        from . import tokens
        return tokens.run(args)
    if args.command == "remap":
        from . import remap

        return remap.run(args)

    if args.command == "bootstrap":
        from . import vendor
        return vendor.run(args)
    if args.command == "check":
        from . import check
        return check.run(args)
    if args.command == "receive":
        from . import receive
        return receive.run(args)
    if args.command == "demo":
        from . import demo
        return demo.run_init(args) if args.demo_command == "init" else demo.run_up(args)
    if args.command in ("serve", "stop", "status", "logs"):
        from . import serve
        runner = {"serve": serve.run_serve, "stop": serve.run_stop, "status": serve.run_status, "logs": serve.run_logs}
        return runner[args.command](args)
    parser.error(f"unknown command {args.command!r}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
