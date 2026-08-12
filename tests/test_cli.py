"""E2E for the altery-dj CLI (REFORM phase 5, docs/REFORM.md §6).

Covers the DoD: `apply` lays an export.zip out under a Django app, `check` gates it via
manage.py, and `tokens` reproduces the plugin's TypeScript emitters BYTE-FOR-BYTE — the
same goldens under tests/fixtures/expected/ lock both engines (src/tokens/engine.test.ts
on the TS side, this file on the Python side), so parity drift fails one of the suites.

The CLI is exercised the way users run it (`python -m altery_dj …` subprocess), not by
importing internals.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
REPO_DIR = TESTS_DIR.parent
CLI_DIR = REPO_DIR / 'cli'
EXPECTED_DIR = TESTS_DIR / 'fixtures' / 'expected'
DJANGO_REFERENCE_DIR = TESTS_DIR / 'fixtures' / 'django-reference'

HAS_DJANGO = importlib.util.find_spec('django') is not None
HAS_MSGMERGE = shutil.which('msgmerge') is not None


def run_cli(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ, PYTHONPATH=str(CLI_DIR))
    return subprocess.run(
        [sys.executable, '-m', 'altery_dj', *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=cwd or REPO_DIR,
    )


def build_export_zip(zip_path: Path) -> None:
    with zipfile.ZipFile(zip_path, 'w') as zf:
        zf.writestr('templates/base.html', '{% load static %}<html></html>')
        zf.writestr('templates/pages/home.html', '{% extends "base.html" %}')
        zf.writestr('static/css/project.css', 'body { margin: 0; }')
        zf.writestr('locale/figma.po', 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n')
        zf.writestr('tokens.json', (EXPECTED_DIR / 'tokens.json').read_text())
        zf.writestr('bootstrap.map.json', (EXPECTED_DIR / 'bootstrap.map.json').read_text())
        zf.writestr('export-report.json', '{"manualAssets": ["video/hero.mp4"]}')
        zf.writestr('unrelated-root-file.txt', 'must not be applied')


def make_app(tmp_path: Path) -> Path:
    app_dir = tmp_path / 'site'
    app_dir.mkdir()
    (app_dir / 'manage.py').write_text('# stub\n')
    return app_dir


def test_help_lists_commands_and_examples() -> None:
    result = run_cli('help')
    assert result.returncode == 0
    for command in ('apply', 'po', 'tokens', 'bootstrap', 'check'):
        assert command in result.stdout


def test_apply_lays_out_known_roots_and_metadata(tmp_path: Path) -> None:
    app_dir = make_app(tmp_path)
    zip_path = tmp_path / 'export.zip'
    build_export_zip(zip_path)

    result = run_cli('apply', str(zip_path), '--app', str(app_dir))

    assert result.returncode == 0, result.stdout + result.stderr
    assert (app_dir / 'templates' / 'base.html').exists()
    assert (app_dir / 'templates' / 'pages' / 'home.html').exists()
    assert (app_dir / 'static' / 'css' / 'project.css').exists()
    assert (app_dir / 'locale' / 'figma.po').exists()
    # CLI metadata files land at the app root (extension over the retired Node script).
    assert (app_dir / 'tokens.json').exists()
    assert (app_dir / 'bootstrap.map.json').exists()
    # Unknown roots stay in the zip; audit report is not laid out.
    assert not (app_dir / 'unrelated-root-file.txt').exists()
    assert not (app_dir / 'export-report.json').exists()
    # The declared manual asset is missing → called out with its absolute target path.
    assert 'video/hero.mp4' in result.stdout
    assert 'still missing' in result.stdout


def test_apply_dry_run_writes_nothing(tmp_path: Path) -> None:
    app_dir = make_app(tmp_path)
    zip_path = tmp_path / 'export.zip'
    build_export_zip(zip_path)

    result = run_cli('apply', str(zip_path), '--app', str(app_dir), '--dry-run')

    assert result.returncode == 0
    assert 'would write' in result.stdout
    assert not (app_dir / 'templates').exists()


def test_apply_refuses_without_manage_py(tmp_path: Path) -> None:
    app_dir = tmp_path / 'not-django'
    app_dir.mkdir()
    zip_path = tmp_path / 'export.zip'
    build_export_zip(zip_path)

    result = run_cli('apply', str(zip_path), '--app', str(app_dir))

    assert result.returncode == 1
    assert 'manage.py' in result.stdout


def test_apply_warns_when_app_is_an_unwired_project_root(tmp_path: Path) -> None:
    zip_path = tmp_path / 'export.zip'
    build_export_zip(zip_path)
    app_dir = make_app(tmp_path)  # manage.py sits right here → --app is the project root
    result = run_cli('apply', str(zip_path), '--app', str(app_dir))
    assert result.returncode == 0
    assert 'PROJECT root' in result.stdout


@pytest.mark.skipif(not HAS_DJANGO, reason='needs Django for manage.py check')
def test_demo_init_scaffolds_a_root_wired_stand_that_passes_check(tmp_path: Path) -> None:
    app_dir = tmp_path / 'stand'
    result = run_cli('demo', 'init', '--app', str(app_dir), '--no-venv')
    assert result.returncode == 0, result.stdout + result.stderr
    settings = (app_dir / 'demo_site' / 'settings.py').read_text()
    assert '"DIRS": [BASE_DIR / "templates"]' in settings
    assert 'STATICFILES_DIRS' in settings

    # The scaffold wires the project root, so applying there must NOT trigger the
    # unwired-root warning — and the applied export must pass the check gate.
    zip_path = tmp_path / 'export.zip'
    build_export_zip(zip_path)
    applied = run_cli('apply', str(zip_path), '--app', str(app_dir))
    assert applied.returncode == 0
    assert 'PROJECT root' not in applied.stdout
    checked = run_cli('check', '--app', str(app_dir))
    assert checked.returncode == 0, checked.stdout + checked.stderr


@pytest.mark.skipif(not HAS_DJANGO, reason='needs Django for runserver')
def test_demo_up_serves_the_export_and_stop_kills_the_server(tmp_path: Path) -> None:
    import socket
    import urllib.request

    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]

    zip_path = tmp_path / 'export.zip'
    build_export_zip(zip_path)
    app_dir = tmp_path / 'stand'
    try:
        result = run_cli('demo', 'up', str(zip_path), '--app', str(app_dir), '--no-venv', '--port', str(port))
        assert result.returncode == 0, result.stdout + result.stderr
        assert f'http://127.0.0.1:{port}/' in result.stdout

        index_html = urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=5).read().decode()
        assert 'home.html' in index_html, 'the stand index lists the exported page'
        page = urllib.request.urlopen(f'http://127.0.0.1:{port}/page/home.html', timeout=5)
        assert page.status == 200
    finally:
        stopped = run_cli('stop', '--app', str(app_dir))
    assert stopped.returncode == 0
    status = run_cli('status', '--app', str(app_dir))
    assert 'not running' in status.stdout


@pytest.mark.skipif(not HAS_DJANGO, reason='needs Django for runserver')
def test_demo_up_vendors_bootstrap_and_relinks_an_assume_mode_base_html(tmp_path: Path) -> None:
    import socket

    # Fake jsdelivr layout, same pattern as the bootstrap-vendor test.
    dist = tmp_path / 'npm' / 'bootstrap@5.3' / 'dist'
    (dist / 'css').mkdir(parents=True)
    (dist / 'js').mkdir(parents=True)
    (dist / 'css' / 'bootstrap.min.css').write_text('.d-grid{display:grid}')
    (dist / 'js' / 'bootstrap.bundle.min.js').write_text('// bundle')

    zip_path = tmp_path / 'export.zip'
    with zipfile.ZipFile(zip_path, 'w') as zf:
        zf.writestr(
            'templates/base.html',
            '{% load static %}<html><head>\n'
            '  {% block framework_css %}\n'
            '  {# Bootstrap CSS is expected from the project (Settings → Bootstrap source: In project). #}\n'
            '  {% endblock %}\n'
            '</head><body>{% block content %}{% endblock %}\n'
            '  {% block framework_js %}\n'
            '  {# Bootstrap JS (bundle) is expected from the project — override this block to link it. #}\n'
            '  {% endblock %}\n'
            '</body></html>',
        )
        zf.writestr('templates/pages/home.html', '{% extends "base.html" %}')

    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]

    app_dir = tmp_path / 'stand'
    try:
        result = run_cli(
            'demo', 'up', str(zip_path), '--app', str(app_dir), '--no-venv',
            '--port', str(port), '--url-base', (tmp_path / 'npm').as_uri(),
        )
        assert result.returncode == 0, result.stdout + result.stderr
        base_html = (app_dir / 'templates' / 'base.html').read_text()
        assert "vendor/bootstrap/bootstrap.min.css" in base_html, 'assume-mode CSS comment relinked'
        assert "vendor/bootstrap/bootstrap.bundle.min.js" in base_html, 'assume-mode JS comment relinked'
        assert (app_dir / 'static' / 'vendor' / 'bootstrap' / 'bootstrap.min.css').exists()
        assert (app_dir / 'static' / 'vendor' / 'bootstrap' / 'bootstrap.bundle.min.js').exists()
    finally:
        run_cli('stop', '--app', str(app_dir))


@pytest.mark.skipif(not HAS_DJANGO, reason='needs Django for runserver')
def test_apply_restarts_a_running_server_so_it_serves_fresh_templates(tmp_path: Path) -> None:
    import socket
    import urllib.request

    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]

    app_dir = tmp_path / 'stand'
    assert run_cli('demo', 'init', '--app', str(app_dir), '--no-venv').returncode == 0

    def make_zip(marker: str) -> Path:
        zp = tmp_path / f'export-{marker}.zip'
        with zipfile.ZipFile(zp, 'w') as zf:
            zf.writestr('templates/base.html', '{% load static %}<html><body>{% block content %}{% endblock %}</body></html>')
            zf.writestr('templates/pages/home.html', '{% extends "base.html" %}{% block content %}MARKER_' + marker + '{% endblock %}')
        return zp

    run_cli('apply', str(make_zip('one')), '--app', str(app_dir))
    try:
        assert run_cli('serve', '--app', str(app_dir), '--port', str(port)).returncode == 0
        first = urllib.request.urlopen(f'http://127.0.0.1:{port}/page/home.html', timeout=5).read().decode()
        assert 'MARKER_one' in first

        # Re-apply new content; apply should restart the running server so it serves the update.
        applied = run_cli('apply', str(make_zip('two')), '--app', str(app_dir))
        assert 'restarted the running dev server' in applied.stdout
        second = urllib.request.urlopen(f'http://127.0.0.1:{port}/page/home.html', timeout=5).read().decode()
        assert 'MARKER_two' in second, 'the restarted server serves the freshly applied template'
    finally:
        run_cli('stop', '--app', str(app_dir))


def test_apply_relinks_assume_mode_bootstrap_when_the_stand_vendored_it(tmp_path: Path) -> None:
    """Regression: a plain apply of an assume-mode export must not drop the Bootstrap <link>
    on a stand that already vendored it — otherwise the utility-class layout dies past the
    widest breakpoint."""
    app_dir = tmp_path / 'stand'
    (app_dir / 'static' / 'vendor' / 'bootstrap').mkdir(parents=True)
    (app_dir / 'static' / 'vendor' / 'bootstrap' / 'bootstrap.min.css').write_text('.d-flex{display:flex}')
    (app_dir / 'static' / 'vendor' / 'bootstrap' / 'bootstrap.bundle.min.js').write_text('// js')
    (app_dir / 'manage.py').write_text('# stub\n')

    zip_path = tmp_path / 'export.zip'
    with zipfile.ZipFile(zip_path, 'w') as zf:
        zf.writestr(
            'templates/base.html',
            '{% load static %}<html><head>\n'
            '  {% block framework_css %}\n'
            '  {# Bootstrap CSS is expected from the project (Settings → Bootstrap source: In project). #}\n'
            '  {% endblock %}\n'
            '</head><body>{% block content %}{% endblock %}\n'
            '  {% block framework_js %}\n'
            '  {# Bootstrap JS (bundle) is expected from the project — override this block to link it. #}\n'
            '  {% endblock %}\n'
            '</body></html>',
        )

    result = run_cli('apply', str(zip_path), '--app', str(app_dir))
    assert result.returncode == 0
    assert 'relinked base.html to the vendored Bootstrap' in result.stdout
    base_html = (app_dir / 'templates' / 'base.html').read_text()
    assert "vendor/bootstrap/bootstrap.min.css" in base_html
    assert "vendor/bootstrap/bootstrap.bundle.min.js" in base_html


def test_apply_leaves_base_html_alone_without_vendored_bootstrap(tmp_path: Path) -> None:
    """Real projects that manage Bootstrap themselves (assume mode, no vendored files) must be
    left untouched — apply does no network and no relink there."""
    app_dir = make_app(tmp_path)
    zip_path = tmp_path / 'export.zip'
    with zipfile.ZipFile(zip_path, 'w') as zf:
        zf.writestr(
            'templates/base.html',
            '{% block framework_css %}\n  {# Bootstrap CSS is expected from the project #}\n  {% endblock %}',
        )
    result = run_cli('apply', str(zip_path), '--app', str(app_dir))
    assert result.returncode == 0
    assert 'relinked' not in result.stdout
    assert 'Bootstrap CSS is expected from the project' in (app_dir / 'templates' / 'base.html').read_text()


def test_tokens_reproduces_the_typescript_emitters_byte_for_byte(tmp_path: Path) -> None:
    """Parity lock: the Python port and the TS engine share these goldens."""
    app_dir = make_app(tmp_path)
    shutil.copy(EXPECTED_DIR / 'tokens.json', app_dir / 'tokens.json')
    shutil.copy(EXPECTED_DIR / 'bootstrap.map.json', app_dir / 'bootstrap.map.json')

    result = run_cli('tokens', '--app', str(app_dir))

    assert result.returncode == 0, result.stdout + result.stderr
    produced_css = (app_dir / 'static' / 'css' / 'tokens.css').read_text()
    assert produced_css == (EXPECTED_DIR / 'tokens.css').read_text()
    produced_bootstrap = (app_dir / 'static' / 'css' / 'bootstrap-tokens.css').read_text()
    assert produced_bootstrap == (EXPECTED_DIR / 'bootstrap-tokens.css').read_text()
    produced_scss = (app_dir / 'static' / 'scss' / '_tokens.scss').read_text()
    assert produced_scss == (EXPECTED_DIR / '_tokens.scss').read_text()


def test_tokens_warns_on_a_mapping_to_a_missing_token(tmp_path: Path) -> None:
    app_dir = make_app(tmp_path)
    shutil.copy(EXPECTED_DIR / 'tokens.json', app_dir / 'tokens.json')
    (app_dir / 'bootstrap.map.json').write_text('{"map": {"--bs-primary": "color.primary", "--bs-info": "no.such.token"}}')

    result = run_cli('tokens', '--format', 'bootstrap', '--app', str(app_dir))

    assert result.returncode == 0
    assert 'no.such.token' in result.stdout
    produced = (app_dir / 'static' / 'css' / 'bootstrap-tokens.css').read_text()
    assert '--bs-primary: #4f46e5;' in produced
    assert '--bs-info' not in produced


@pytest.mark.skipif(not HAS_MSGMERGE, reason='msgmerge (GNU gettext) not installed')
def test_po_merge_updates_django_po_in_place(tmp_path: Path) -> None:
    po_header = 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n'
    django_po = tmp_path / 'django.po'
    django_po.write_text(po_header + '\nmsgid "Old string"\nmsgstr "Старая строка"\n')
    figma_po = tmp_path / 'figma.po'
    figma_po.write_text(po_header + '\nmsgid "New string"\nmsgstr ""\n')

    result = run_cli('po', 'merge', '--django-po', str(django_po), '--figma-po', str(figma_po))

    assert result.returncode == 0, result.stdout + result.stderr
    merged = django_po.read_text()
    assert 'New string' in merged
    assert 'compilemessages' in result.stdout


@pytest.mark.skipif(not HAS_DJANGO, reason='Django not installed in this interpreter')
def test_check_passes_on_the_reference_project(tmp_path: Path) -> None:
    project_dir = tmp_path / 'django-reference'
    shutil.copytree(DJANGO_REFERENCE_DIR, project_dir)

    result = run_cli('check', '--app', str(project_dir))

    assert result.returncode == 0, result.stdout + result.stderr
    assert 'manage.py check → ok' in result.stdout
    # D2: the smoke-render renders the reference's pages/index.html with an empty context.
    assert 'template smoke-render → ok' in result.stdout


@pytest.mark.skipif(not HAS_DJANGO, reason='Django not installed in this interpreter')
def test_check_smoke_render_catches_a_broken_template(tmp_path: Path) -> None:
    project_dir = tmp_path / 'django-reference'
    shutil.copytree(DJANGO_REFERENCE_DIR, project_dir)
    # A template Django's loaders can see, with a broken tag — manage.py check won't notice it,
    # only a render does.
    broken = project_dir / 'pages' / 'templates' / 'pages' / 'broken.html'
    broken.write_text('{% load static %}\n{% blorp %}\n')

    result = run_cli('check', '--app', str(project_dir))
    assert result.returncode == 1, result.stdout + result.stderr
    assert 'template smoke-render → FAILED' in result.stdout
    assert 'broken.html' in result.stdout

    # --no-render skips it: manage.py check alone still passes (it never renders templates).
    skipped = run_cli('check', '--app', str(project_dir), '--no-render')
    assert skipped.returncode == 0, skipped.stdout + skipped.stderr
    assert 'smoke-render' not in skipped.stdout


def test_bootstrap_vendor_downloads_via_url_base(tmp_path: Path) -> None:
    app_dir = make_app(tmp_path)
    fake_npm = tmp_path / 'npm' / 'bootstrap@5.3' / 'dist'
    (fake_npm / 'css').mkdir(parents=True)
    (fake_npm / 'js').mkdir(parents=True)
    (fake_npm / 'css' / 'bootstrap.min.css').write_text(':root{--bs-blue:#0d6efd}')
    (fake_npm / 'js' / 'bootstrap.bundle.min.js').write_text('/* bundle */')

    result = run_cli('bootstrap', 'vendor', '--app', str(app_dir), '--url-base', (tmp_path / 'npm').as_uri())

    assert result.returncode == 0, result.stdout + result.stderr
    assert (app_dir / 'static' / 'vendor' / 'bootstrap' / 'bootstrap.min.css').exists()
    assert (app_dir / 'static' / 'vendor' / 'bootstrap' / 'bootstrap.bundle.min.js').exists()


def _free_port() -> int:
    import socket

    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def test_receive_applies_a_delivered_zip_and_rejects_a_bad_secret(tmp_path: Path) -> None:
    """REFORM phase 8: the plugin's Delivery POST lands applied, like `altery-dj apply`."""
    import urllib.error
    import urllib.request

    app_dir = make_app(tmp_path)
    zip_path = tmp_path / 'export.zip'
    build_export_zip(zip_path)
    port = _free_port()

    env = dict(os.environ, PYTHONPATH=str(CLI_DIR))
    server = subprocess.Popen(
        [sys.executable, '-m', 'altery_dj', 'receive', '--app', str(app_dir), '--host', '127.0.0.1',
         '--port', str(port), '--secret', 's3cret', '--once'],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    try:
        assert 'listening' in server.stdout.readline()  # startup barrier
        body = zip_path.read_bytes()

        bad = urllib.request.Request(f'http://127.0.0.1:{port}/', data=body, method='POST',
                                     headers={'Content-Type': 'application/zip', 'X-Altery-Secret': 'wrong'})
        try:
            urllib.request.urlopen(bad, timeout=10)
            raise AssertionError('a bad secret must be rejected')
        except urllib.error.HTTPError as error:
            assert error.code == 403

        good = urllib.request.Request(f'http://127.0.0.1:{port}/', data=body, method='POST',
                                      headers={'Content-Type': 'application/zip', 'X-Altery-Secret': 's3cret'})
        with urllib.request.urlopen(good, timeout=10) as response:
            payload = json.loads(response.read())
        assert payload['written'] > 0
        assert payload['missingManualAssets'] == ['video/hero.mp4']
        assert (app_dir / 'templates' / 'base.html').exists()
        assert (app_dir / 'tokens.json').exists()

        assert server.wait(timeout=10) == 0  # --once: exits after the applied package
    finally:
        if server.poll() is None:
            server.kill()
            server.wait()


GENERATED_BEGIN = '{# GENERATED:BEGIN 10:1 — edits outside this block survive regeneration #}'
GENERATED_END = '{# GENERATED:END 10:1 #}'


def build_rebuild_zip(zip_path: Path, body: str = '<div>v2</div>') -> None:
    with zipfile.ZipFile(zip_path, 'w') as zf:
        zf.writestr('templates/pages/home.html', f'{GENERATED_BEGIN}\n{body}\n{GENERATED_END}')
        zf.writestr(
            'templates/pages/fresh.html',
            '{# GENERATED:BEGIN 20:1 — edits outside this block survive regeneration #}\n<p>new page</p>\n{# GENERATED:END 20:1 #}',
        )
        zf.writestr(
            'templates/pages/legacy.html',
            '{# GENERATED:BEGIN 30:1 — edits outside this block survive regeneration #}\n<p>regen</p>\n{# GENERATED:END 30:1 #}',
        )
        zf.writestr('static/css/project.css', 'body{margin:0}')


def seed_rebuild_app(tmp_path: Path) -> Path:
    """An app with hand edits around the marker, a hand-authored legacy page, stale static."""
    app_dir = make_app(tmp_path)
    pages = app_dir / 'templates' / 'pages'
    pages.mkdir(parents=True)
    (pages / 'home.html').write_text(
        f'{{% comment %}}hand top{{% endcomment %}}\n{GENERATED_BEGIN}\n<div>v1</div>\n{GENERATED_END}\nhand bottom\n'
    )
    (pages / 'legacy.html').write_text('completely hand-authored, no markers\n')
    (app_dir / 'static' / 'css').mkdir(parents=True)
    (app_dir / 'static' / 'css' / 'project.css').write_text('old-css')
    return app_dir


def test_rebuild_merges_generated_regions_and_keeps_hand_edits(tmp_path: Path) -> None:
    """REFORM backlog: `rebuild` ports regenerate.ts's marker merge (same semantics as the
    plugin's regeneration panel — see src/django/regenerate.test.ts on the TS side)."""
    app_dir = seed_rebuild_app(tmp_path)
    zip_path = tmp_path / 'export.zip'
    build_rebuild_zip(zip_path)

    result = run_cli('rebuild', str(zip_path), '--app', str(app_dir))

    assert result.returncode == 0, result.stdout + result.stderr
    home = (app_dir / 'templates' / 'pages' / 'home.html').read_text()
    assert 'hand top' in home and 'hand bottom' in home  # edits OUTSIDE the markers survive
    assert '<div>v2</div>' in home and '<div>v1</div>' not in home  # inside is generator-owned
    assert home.count(GENERATED_BEGIN) == 1 and home.count(GENERATED_END) == 1
    # A hand-authored file with no marker is never overwritten — warned instead.
    assert (app_dir / 'templates' / 'pages' / 'legacy.html').read_text() == 'completely hand-authored, no markers\n'
    assert 'legacy.html' in result.stdout and 'left untouched' in result.stdout
    # New template created; generator-owned static replaced wholesale.
    assert (app_dir / 'templates' / 'pages' / 'fresh.html').exists()
    assert (app_dir / 'static' / 'css' / 'project.css').read_text() == 'body{margin:0}'
    assert '1 merged' in result.stdout and '1 kept' in result.stdout


def test_rebuild_dry_run_classifies_without_writing_and_diff_shows_changes(tmp_path: Path) -> None:
    app_dir = seed_rebuild_app(tmp_path)
    zip_path = tmp_path / 'export.zip'
    build_rebuild_zip(zip_path)

    dry = run_cli('rebuild', str(zip_path), '--app', str(app_dir), '--dry-run', '--diff')

    assert dry.returncode == 0
    assert 'would be' in dry.stdout
    assert '+<div>v2</div>' in dry.stdout and '-<div>v1</div>' in dry.stdout
    home = (app_dir / 'templates' / 'pages' / 'home.html').read_text()
    assert '<div>v1</div>' in home  # nothing written
    assert (app_dir / 'static' / 'css' / 'project.css').read_text() == 'old-css'
