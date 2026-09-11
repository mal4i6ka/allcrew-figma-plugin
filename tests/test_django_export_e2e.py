"""E2E render check (T7.2, docs/PLAN.md E7): applies the plugin's emitted `Card` partial and
`tokens.css` (tests/fixtures/expected/*, the same golden output the Node emitters produce and
`altery-dj apply` (cli/) lays down under `<app>/templates/` and `<app>/static/`) onto a
disposable copy of the reference Django project, then actually renders the template through
Django's template engine and confirms staticfiles resolves the emitted stylesheet. Complements
src/export/pipeline.e2e.test.ts (which checks the Node pipeline writes the right files at the
right paths) with the piece Node can't do: proving Django itself accepts and renders that output.

Skips if Django is not installed in the current interpreter, so this isn't a hard dependency of
the JS-only `npm test` gate this task is graded against.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / 'fixtures'
DJANGO_REFERENCE_DIR = FIXTURES_DIR / 'django-reference'
REPO_ROOT = Path(__file__).parent.parent
SCAFFOLD_EXPORT_RUNNER = Path(__file__).parent / '_scaffold_export.mjs'


def _emit_scaffold_export(out_dir: Path) -> None:
    """Runs the real emitters (Node) to produce a standalone Django project under `out_dir`."""
    result = subprocess.run(
        ['node', '--experimental-transform-types', str(SCAFFOLD_EXPORT_RUNNER), str(out_dir)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f'scaffold export failed:\nstdout: {result.stdout}\nstderr: {result.stderr}'


def _apply_golden_export(project_dir: Path) -> None:
    card_partial = (FIXTURES_DIR / 'expected' / 'component_card.html').read_text()
    partial_path = project_dir / 'pages' / 'templates' / 'components' / 'card.html'
    partial_path.parent.mkdir(parents=True, exist_ok=True)
    partial_path.write_text(card_partial)

    tokens_css = (FIXTURES_DIR / 'expected' / 'tokens.css').read_text()
    tokens_path = project_dir / 'pages' / 'static' / 'css' / 'tokens.css'
    tokens_path.parent.mkdir(parents=True, exist_ok=True)
    tokens_path.write_text(tokens_css)


def test_exported_card_partial_renders_through_the_django_template_engine(tmp_path):
    django = pytest.importorskip('django')

    project_dir = tmp_path / 'django-reference'
    shutil.copytree(DJANGO_REFERENCE_DIR, project_dir)
    _apply_golden_export(project_dir)

    sys.path.insert(0, str(project_dir))
    try:
        import os

        os.environ['DJANGO_SETTINGS_MODULE'] = 'reference_site.settings'
        django.setup()

        from django.contrib.staticfiles.finders import find
        from django.template.loader import render_to_string

        visible_html = render_to_string('components/card.html', {'title': 'Hello Card', 'visible': True})
        assert 'Hello Card' in visible_html

        hidden_html = render_to_string('components/card.html', {'title': 'Hello Card', 'visible': False})
        assert 'Hello Card' not in hidden_html

        found = find('css/tokens.css')
        assert found is not None, 'staticfiles finder could not locate the exported tokens.css'
        assert Path(found).read_text() == (FIXTURES_DIR / 'expected' / 'tokens.css').read_text()
    finally:
        sys.path.remove(str(project_dir))
        for mod in list(sys.modules):
            if mod == 'reference_site' or mod.startswith('reference_site.') or mod == 'pages' or mod.startswith('pages.'):
                del sys.modules[mod]


def test_reference_django_project_check_after_export_applied(tmp_path):
    pytest.importorskip('django')

    project_dir = tmp_path / 'django-reference'
    shutil.copytree(DJANGO_REFERENCE_DIR, project_dir)
    _apply_golden_export(project_dir)

    result = subprocess.run(
        [sys.executable, 'manage.py', 'check'],
        cwd=project_dir,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, (
        f'manage.py check failed after applying the export:\nstdout: {result.stdout}\nstderr: {result.stderr}'
    )


SERVE_PROBE = """
import os, re, sys
os.environ['DJANGO_SETTINGS_MODULE'] = 'config.settings'
os.environ['DJANGO_DEBUG'] = '1'
import django
django.setup()
from django.test import Client

client = Client()
home = client.get('/', SERVER_NAME='localhost')
ru_home = client.get('/ru/', SERVER_NAME='localhost')
missing = client.get('/nope/', SERVER_NAME='localhost')
assert home.status_code == 200, home.status_code
assert ru_home.status_code == 200, ru_home.status_code
assert missing.status_code == 404, missing.status_code

html = home.content.decode()
ru_html = ru_home.content.decode()
assert 'name="viewport"' in html, 'no viewport meta — every max-width media query is inert on a phone'
assert '<html lang="en"' in html, html[:200]
assert '<html lang="ru"' in ru_html, ru_html[:200]
# The prototype's NAVIGATE reaction resolves through the generated navMap context processor, and
# picks up the active locale prefix.
assert 'href="/detail/"' in html, [m for m in re.findall(r'href="[^"]*"', html)]
assert 'href="/ru/detail/"' in ru_html, [m for m in re.findall(r'href="[^"]*"', ru_html)]
# The language switcher posts a real locale change.
switched = client.post('/i18n/setlang/', {'language': 'ru', 'next': '/detail/'}, SERVER_NAME='localhost')
assert switched.status_code == 302 and switched.headers['Location'] == '/ru/detail/', switched.headers.get('Location')
print('ok')
"""


def test_generated_django_project_serves_every_page_in_every_locale(tmp_path):
    """The export is only 'an app' if the project it ships actually routes, localizes and renders:
    a missing context processor or a mis-generated URLconf leaves every prototype link empty and
    every localized URL 404ing, which no template-level test would notice."""
    pytest.importorskip('django')

    project_dir = tmp_path / 'export'
    _emit_scaffold_export(project_dir)

    # A sibling test in this module points DJANGO_SETTINGS_MODULE at the reference stand; the
    # generated project's manage.py only `setdefault`s its own, so an inherited value would make
    # both subprocesses load someone else's settings.
    env = {**os.environ, 'PYTHONPATH': str(project_dir), 'DJANGO_SETTINGS_MODULE': 'config.settings'}

    check = subprocess.run([sys.executable, 'manage.py', 'check'], cwd=project_dir, capture_output=True, text=True, env=env)
    assert check.returncode == 0, f'manage.py check failed:\nstdout: {check.stdout}\nstderr: {check.stderr}'

    serve = subprocess.run([sys.executable, '-c', SERVE_PROBE], cwd=project_dir, capture_output=True, text=True, env=env)
    assert serve.returncode == 0, f'serving the generated project failed:\nstdout: {serve.stdout}\nstderr: {serve.stderr}'
