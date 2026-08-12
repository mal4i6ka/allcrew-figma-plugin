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

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / 'fixtures'
DJANGO_REFERENCE_DIR = FIXTURES_DIR / 'django-reference'


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
