"""Probe executed INSIDE a disposable export-applied Django project (cwd = project dir,
PYTHONPATH = project dir). Prints a JSON report to stdout.

Run by test_export_zip_e2e.py in a subprocess: Django only supports one `django.setup()`
per process, so probing in-process collides with any other test module that already set
Django up against a different disposable project (stale app registry → staticfiles
finders looking in the wrong directory). A subprocess also mirrors how Django actually
runs (`manage.py` is one process per command).
"""

import json
import os
import re
import sys
from pathlib import Path


def assert_css_property(css_text: str, prop: str, value_pattern: str) -> bool:
    """True if `css_text` contains a `prop: <value matching value_pattern>` declaration.

    `value_pattern` is a regex fragment matched (case-insensitively) anywhere in the value.
    The negative lookbehind on `prop` keeps e.g. `prop='width'` from matching `min-width: …`
    (M5 static/responsive property-class assertions, tests/test_export_zip_e2e.py).
    """
    pattern = rf'(?<![\w-]){re.escape(prop)}\s*:\s*[^;{{}}]*{value_pattern}[^;{{}}]*;'
    return re.search(pattern, css_text, re.IGNORECASE) is not None


def main() -> None:
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'reference_site.settings')
    import django

    django.setup()

    # What `manage.py test` does before running tests — among other things, allows the
    # test client's HTTP_HOST ('testserver').
    from django.test.utils import setup_test_environment

    setup_test_environment()

    from django.contrib.staticfiles.finders import find
    from django.template.loader import render_to_string
    from django.test import Client

    app_dir = Path.cwd() / 'pages'
    report = {
        'pages': {},
        'partials': {},
        'static_missing': [],
        'refs': [],
        'ref_missing': [],
        'index_status': None,
        'admin_status': None,
    }

    for page in sorted((app_dir / 'templates' / 'pages').glob('*.html')):
        try:
            html = render_to_string(f'pages/{page.name}')
            report['pages'][page.name] = {
                'ok': True,
                'full_document': '<html' in html.lower(),
                # Residual tags mean the lexer never parsed them (e.g. a newline inside
                # `{% translate "…" %}`) — Django serves them as literal text, silently.
                'unrendered_tags': html.count('{%'),
            }
        except Exception as error:  # noqa: BLE001 — the report carries the failure to the assert
            report['pages'][page.name] = {'ok': False, 'error': f'{type(error).__name__}: {error}'}

    components_dir = app_dir / 'templates' / 'components'
    if components_dir.exists():
        for partial in sorted(components_dir.glob('*.html')):
            try:
                # Missing include-params render as empty strings — this validates SYNTAX.
                render_to_string(f'components/{partial.name}')
                report['partials'][partial.name] = {'ok': True}
            except Exception as error:  # noqa: BLE001
                report['partials'][partial.name] = {'ok': False, 'error': f'{type(error).__name__}: {error}'}

    static_root = app_dir / 'static'
    if static_root.exists():
        for file in static_root.rglob('*'):
            if file.is_file():
                rel = file.relative_to(static_root).as_posix()
                if find(rel) is None:
                    report['static_missing'].append(rel)

    refs = set()
    for template in (app_dir / 'templates').rglob('*.html'):
        refs.update(re.findall(r"\{%\s*static\s+'([^']+)'\s*%\}", template.read_text()))
    report['refs'] = sorted(refs)
    report['ref_missing'] = [ref for ref in sorted(refs) if find(ref) is None]

    # M9: when the export ships interactions.css/interactions.js (ON_HOVER/ON_PRESS/OVERLAY
    # reactions), assert the static files exist — the DoD's "e2e asserts the asset exists when
    # the fixture has reactions" gate.
    report['has_interactions_css'] = (app_dir / 'static' / 'css' / 'interactions.css').is_file()
    report['has_interactions_js'] = (app_dir / 'static' / 'js' / 'interactions.js').is_file()
    interactions_refs = [ref for ref in sorted(refs) if 'interactions' in ref]
    report['interactions_refs'] = interactions_refs
    report['interactions_ref_missing'] = [ref for ref in interactions_refs if find(ref) is None]

    client = Client()
    report['index_status'] = client.get('/').status_code
    report['admin_status'] = client.get('/admin/login/').status_code

    json.dump(report, sys.stdout)


if __name__ == '__main__':
    main()
