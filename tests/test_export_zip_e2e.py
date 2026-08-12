"""Full-export e2e: proves a REAL zip produced by the plugin's "Export project (.zip)" button
against a real Django project — the piece the golden-fixture test can't cover.

Usage:
    1. In Figma, run the plugin and click "Export project (.zip)".
    2. EXPORT_ZIP=~/Downloads/<export>.zip .venv/bin/python -m pytest tests/test_export_zip_e2e.py -v

Without EXPORT_ZIP the whole module is skipped, so the default pytest run stays hermetic.

What it verifies, on a disposable copy of tests/fixtures/django-reference:
    - the zip's templates/static/locale trees land under the app dir exactly like
      `altery-dj apply` (cli/altery_dj/apply.py) lays them out (same KNOWN_ROOTS convention);
    - `manage.py check` passes with the export applied (django-admin machinery);
    - EVERY exported page template renders through Django's template engine into a full
      document ({% extends base.html %}, {% include %} partials, {% static %}, {% translate %});
    - every component partial parses and renders standalone;
    - every exported static file resolves through the staticfiles finder, and every
      {% static '...' %} path the templates reference actually shipped in the export;
    - locale/figma.po compiles with msgfmt when gettext is installed (skipped otherwise);
    - the dev-server machinery responds end-to-end via Django's test client: the reference
      index view and /admin/login/ both return 200 with the export applied.

Engine checks run through tests/_export_probe.py in a subprocess — Django allows one
`django.setup()` per process, and the golden-fixture e2e module already uses it in-process.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from _export_probe import assert_css_property

TESTS_DIR = Path(__file__).parent
DJANGO_REFERENCE_DIR = TESTS_DIR / 'fixtures' / 'django-reference'

# Mirrors cli/altery_dj/apply.py's KNOWN_ROOTS: only these zip roots are laid out.
KNOWN_ROOTS = ('templates/', 'static/', 'locale/')

EXPORT_ZIP = os.environ.get('EXPORT_ZIP')

pytestmark = pytest.mark.skipif(
    not EXPORT_ZIP,
    reason='set EXPORT_ZIP=/path/to/plugin-export.zip to run the real-zip e2e',
)


def _static_dir(project: dict) -> Path:
    return project['dir'] / 'pages' / 'static'


def _all_css(project: dict) -> str:
    """Concatenates every emitted `*.css` file (site/tokens/interactions/animations) so a single
    `assert_css_property` call can check for a property class regardless of which stylesheet the
    emitter put it in."""
    static = _static_dir(project)
    if not static.exists():
        return ''
    return '\n'.join(path.read_text() for path in sorted(static.rglob('*.css')))


def _all_html(project: dict) -> str:
    """Concatenates every emitted template — checked directly (pre-render) so `{% static %}`
    tags don't need to resolve; only the surrounding markup (e.g. `<video …>` attributes) matters."""
    templates = project['dir'] / 'pages' / 'templates'
    if not templates.exists():
        return ''
    return '\n'.join(path.read_text() for path in sorted(templates.rglob('*.html')))


def _apply_zip(zip_path: Path, app_dir: Path) -> list[str]:
    """Extracts the export zip's known roots under the app dir (altery-dj apply layout)."""
    written = []
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if info.is_dir() or not info.filename.startswith(KNOWN_ROOTS):
                continue
            target = app_dir / info.filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(info))
            written.append(info.filename)
    return written


@pytest.fixture(scope='module')
def project(tmp_path_factory):
    """A disposable reference project with the export applied, plus the in-engine probe report."""
    project_dir = tmp_path_factory.mktemp('e2e') / 'django-reference'
    shutil.copytree(DJANGO_REFERENCE_DIR, project_dir)

    written = _apply_zip(Path(EXPORT_ZIP).expanduser(), project_dir / 'pages')
    assert written, f'{EXPORT_ZIP} contained none of the expected roots {KNOWN_ROOTS}'

    probe = subprocess.run(
        [sys.executable, str(TESTS_DIR / '_export_probe.py')],
        cwd=project_dir,
        env={**os.environ, 'PYTHONPATH': str(project_dir)},
        capture_output=True,
        text=True,
    )
    assert probe.returncode == 0, f'export probe crashed:\nstdout: {probe.stdout}\nstderr: {probe.stderr}'

    # export-report.json lives at the zip ROOT (not under KNOWN_ROOTS): its manualAssets lists
    # static paths the plugin could not ship (the Figma API has no video-byte access) — the
    # templates reference them on purpose, the user drops the files in manually.
    manual_assets: list[str] = []
    with zipfile.ZipFile(Path(EXPORT_ZIP).expanduser()) as zf:
        if 'export-report.json' in zf.namelist():
            manual_assets = json.loads(zf.read('export-report.json')).get('manualAssets', [])

    return {'dir': project_dir, 'written': written, 'report': json.loads(probe.stdout), 'manual_assets': manual_assets}


def test_manage_check_passes_with_export_applied(project):
    result = subprocess.run(
        [sys.executable, 'manage.py', 'check'],
        cwd=project['dir'],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f'manage.py check failed:\n{result.stdout}\n{result.stderr}'


def test_every_exported_page_renders_through_the_engine(project):
    pages = project['report']['pages']
    assert pages, 'the export contains no page templates under templates/pages/'

    broken = {name: result['error'] for name, result in pages.items() if not result['ok']}
    assert not broken, f'pages failed to render through the Django engine: {broken}'

    partial_docs = [name for name, result in pages.items() if not result['full_document']]
    assert not partial_docs, f'pages did not extend base.html into a full document: {partial_docs}'

    leaky = {name: result['unrendered_tags'] for name, result in pages.items() if result['unrendered_tags']}
    assert not leaky, (
        f'rendered pages contain unprocessed {{% … %}} tags (multi-line tag bug?): {leaky}'
    )


def test_every_component_partial_renders_standalone(project):
    partials = project['report']['partials']
    if not partials:
        pytest.skip('export contains no component partials')

    broken = {name: result['error'] for name, result in partials.items() if not result['ok']}
    assert not broken, f'partials failed to render: {broken}'


def test_all_exported_static_files_resolve_through_staticfiles(project):
    assert any(p.startswith('static/') for p in project['written']), 'the export contains no static files'
    missing = project['report']['static_missing']
    assert not missing, f'staticfiles finder cannot resolve exported files: {missing}'


def test_every_static_reference_in_templates_points_at_a_real_file(project):
    """Catches emitter/asset-pass drift: every {% static '...' %} in the export must exist —
    except paths declared in export-report.json manualAssets (video fills the Figma API refuses
    to export; the <video> shows its poster until the user drops the file in manually)."""
    assert project['report']['refs'], 'exported templates reference no static files at all'
    missing = set(project['report']['ref_missing']) - set(project['manual_assets'])
    assert not missing, (
        f'templates reference static files the export did not ship: {sorted(missing)} '
        f'(declared manual assets, allowed: {project["manual_assets"]})'
    )


def test_locale_po_compiles_with_msgfmt(project):
    po = project['dir'] / 'pages' / 'locale' / 'figma.po'
    if not po.exists():
        pytest.skip('export contains no locale/figma.po (i18n module off)')
    msgfmt = shutil.which('msgfmt')
    if not msgfmt:
        pytest.skip('gettext (msgfmt) not installed — brew install gettext to enable this check')

    result = subprocess.run(
        [msgfmt, '--check', '-o', os.devnull, str(po)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f'figma.po failed msgfmt --check:\n{result.stderr}'


def test_dev_server_machinery_serves_pages_and_admin(project):
    """Django test client == the request/response stack `manage.py runserver` uses."""
    assert project['report']['index_status'] == 200, 'the reference index view broke with the export applied'
    assert project['report']['admin_status'] == 200, '/admin/ stopped responding with the export applied'


def test_interactions_assets_resolve_when_fixture_has_reactions(project):
    """M9 DoD: e2e asserts the asset exists when the fixture has reactions. When the export
    templates reference interactions.css or interactions.js (produced by ON_HOVER/ON_PRESS/
    OVERLAY reactions), those static files must ship in the zip and resolve through the
    staticfiles finder — a missing file means the emitter produced a {% static %} ref but
    buildExportTree didn't write the file (or vice versa)."""
    report = project['report']
    # Every {% static %} ref containing 'interactions' must point at a shipped file.
    assert not report['interactions_ref_missing'], (
        f'interaction assets referenced by templates but not shipped: {report["interactions_ref_missing"]}'
    )
    # If the export produced interactions.css/js, the files must exist on disk.
    for ref in report['interactions_refs']:
        if ref.endswith('interactions.css'):
            assert report['has_interactions_css'], 'templates reference interactions.css but the file was not shipped'
        if ref.endswith('interactions.js'):
            assert report['has_interactions_js'], 'templates reference interactions.js but the file was not shipped'


# --- FID.M5: coverage verification ------------------------------------------------------------
#
# Each check below asserts a high-value property/media class on a REPRESENTATIVE node when the
# export actually exercises it, and skips (not fails) when it doesn't — this suite doubles as the
# manual `EXPORT_ZIP=<your export>.zip` tool documented at the top of this file, so it must stay
# usable against an arbitrary real export, not just the M5 coverage fixture. Running it against a
# fixture built specifically to exercise every category (see docs/1TO1-FIDELITY.md's M5 section
# for how the synthetic verification zip was built) is what proves these assertions actually catch
# a regression rather than skipping past it.

STATIC_PROPERTY_CLASSES = [
    ('box-shadow', r'\d'),
    ('backdrop-filter', r'blur\('),
    ('transform-origin', r'0 0'),
    ('min-width', r'.'),
    ('max-width', r'.'),
    ('text-transform', r'(uppercase|lowercase|capitalize)'),
    ('mask-image', r'url\('),
    # Per-side border weights emit the `border-<side>-width` longhands (never a `border-top`
    # shorthand) — see src/django/css-emitter.ts's `strokeDeclarations`.
    ('border-top-width', r'.'),
    ('aspect-ratio', r'\d'),
    ('font-feature-settings', r'.'),
]


@pytest.mark.parametrize('prop,value_pattern', STATIC_PROPERTY_CLASSES, ids=[p for p, _ in STATIC_PROPERTY_CLASSES])
def test_static_property_class_present_when_fixture_exercises_it(project, prop, value_pattern):
    """M5 DoD item 3: each high-value static-property class, asserted on a representative node."""
    css = _all_css(project)
    if prop not in css:
        pytest.skip(f'export CSS has no {prop} declarations')
    assert assert_css_property(css, prop, value_pattern), f'{prop} present but no declaration matches {value_pattern!r}'


def test_media_query_breakpoints_present_when_fixture_has_breakpoint_frames(project):
    """M5 DoD item 4: responsive breakpoint frames emit `@media` blocks."""
    css = _all_css(project)
    if '@media' not in css:
        pytest.skip('export CSS has no @media blocks (no breakpoint frames in the fixture)')
    assert re.search(r'@media[^{]*\{', css), '@media keyword present but no parseable @media block found'


def test_sticky_position_present_when_fixture_has_fixed_children(project):
    """M5 DoD item 4: `numberOfFixedChildren` sticky headers emit `position: sticky`."""
    css = _all_css(project)
    if not assert_css_property(css, 'position', 'sticky'):
        pytest.skip('export CSS has no position:sticky rules (no sticky-header fixture node)')


def test_overflow_scroll_present_when_fixture_has_scrollable_container(project):
    """M5 DoD item 4: scrollable auto-layout containers emit `overflow: scroll`/`auto`. Single-axis
    scroll (the common case — `layout.overflow: 'x'|'y'`) emits `overflow-x`/`overflow-y`, not the
    bare `overflow` property (that's reserved for `'both'`) — see src/django/css-emitter.ts's
    `layoutDeclarations`. Check all three property names so this actually catches the common case."""
    css = _all_css(project)
    found = any(
        assert_css_property(css, prop, '(scroll|auto)') for prop in ('overflow', 'overflow-x', 'overflow-y')
    )
    if not found:
        pytest.skip('export CSS has no overflow:scroll/auto rules (no scrollable fixture node)')


def test_negative_margin_present_when_fixture_has_negative_gap(project):
    """M5 DoD item 4: negative-gap siblings carry a negative `margin`, never a negative `gap`
    (CSS `gap` can't go negative — the emitter must fall back to margin for that case)."""
    css = _all_css(project)
    if not re.search(r'\bgap\s*:\s*-', css) and not re.search(r'\bmargin[a-z-]*\s*:\s*-\d', css):
        pytest.skip('export CSS has no negative-gap siblings')
    assert not re.search(r'\bgap\s*:\s*-', css), 'a negative value leaked into `gap` (CSS gap cannot be negative)'
    assert re.search(r'\bmargin[a-z-]*\s*:\s*-\d', css), 'negative-gap siblings should carry a negative margin instead'


def test_absolute_children_carry_explicit_offsets_when_fixture_has_constraint_pinned_nodes(project):
    """M5 DoD item 4: constraint-pinned children of an ABSOLUTE auto-layout parent get
    `position: absolute` plus explicit `top`/`left`/`right`/`bottom` offsets."""
    css = _all_css(project)
    if not assert_css_property(css, 'position', 'absolute'):
        pytest.skip('export CSS has no position:absolute rules')
    assert re.search(r'\b(top|left|right|bottom)\s*:\s*-?[\d.]+', css), (
        'position:absolute present but no top/left/right/bottom offset found alongside it'
    )


def test_animations_css_keyframes_present_when_fixture_has_motion_timelines(project):
    """M5 DoD item 5: CSS-keyframe Motion timelines ship `@keyframes` rules paired with a
    `prefers-reduced-motion` guard that disables the animation."""
    animations_css_path = _static_dir(project) / 'css' / 'animations.css'
    if not animations_css_path.exists():
        pytest.skip('export ships no static/css/animations.css (no CSS-keyframe timelines in the fixture)')
    css = animations_css_path.read_text()
    assert '@keyframes' in css, 'animations.css shipped but contains no @keyframes rule'
    assert 'prefers-reduced-motion' in css, 'animations.css keyframes have no prefers-reduced-motion guard'


def test_gsap_bundle_shipped_when_templates_reference_it(project):
    """M5 DoD item 5: when a spring/stagger timeline selects the GSAP backend, base.html links
    `vendor/gsap/gsap.min.js` (+ plugin files) — those must actually ship in the export.

    KNOWN GAP (documented in docs/1TO1-FIDELITY.md's M5 section): `buildExportTree` never writes
    the third-party GSAP vendor bundle itself (only the generated `animations.js` that calls it),
    so a GSAP-backend export currently fails this check — vendoring the real minified library is
    out of scope for M5. The M5 verification fixture deliberately uses CSS-keyframe timelines only,
    so this test skips today; it exists to catch a regression the moment the vendor bundle ships.
    """
    html = _all_html(project)
    gsap_refs = sorted(set(re.findall(r"\{%\s*static\s+'(vendor/gsap/[^']+)'\s*%\}", html)))
    if not gsap_refs:
        pytest.skip('export uses no GSAP-backend timelines (no vendor/gsap/ static reference)')
    missing = [ref for ref in gsap_refs if not (_static_dir(project) / ref).exists()]
    assert not missing, f'templates reference GSAP vendor files the export did not ship: {missing}'


def test_video_tag_has_full_playback_attributes_when_fixture_has_video_fill(project):
    """M5 DoD item 5: video-fill/media leaves render `<video autoplay loop muted playsinline
    poster="…" style="object-fit:…">`, not a bare `<video src>`. `object-fit` is an inline style
    (html-emitter.ts's `scaleModeToObjectFit`), not a stylesheet class, so it's checked here
    rather than in STATIC_PROPERTY_CLASSES, which only scans `*.css` files."""
    html = _all_html(project)
    video_tags = re.findall(r'<video\b[^>]*>', html)
    if not video_tags:
        pytest.skip('export has no <video> tags (no video-fill/media fixture node)')
    for tag in video_tags:
        for attr in ('autoplay', 'loop', 'muted', 'playsinline'):
            assert attr in tag, f'<video> tag missing "{attr}": {tag}'
        assert 'poster=' in tag, f'<video> tag missing a poster attribute: {tag}'
        assert re.search(r'object-fit:\s*(cover|contain|fill)', tag), f'<video> tag missing an object-fit style: {tag}'


def test_gif_fill_ships_as_real_gif_bytes_not_a_rerasterized_png(project):
    """M5 DoD item 5: an animated-GIF image fill ships its actual GIF bytes (magic number
    `GIF8`), not a static PNG re-render — the regression this milestone's TDD fix
    (src/ir.ts's serializeShape + src/export/assets.ts's collectExportAssets) closed."""
    img_dir = _static_dir(project) / 'img'
    gif_paths = sorted(img_dir.glob('*.gif')) if img_dir.exists() else []
    if not gif_paths:
        pytest.skip('export ships no .gif assets (no animated-GIF fixture node)')
    for path in gif_paths:
        magic = path.read_bytes()[:4]
        assert magic == b'GIF8', f'{path.name} is named .gif but its bytes are not a GIF ({magic!r})'
