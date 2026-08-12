import json
import subprocess
import sys
from pathlib import Path

FIXTURES_DIR = Path(__file__).parent / 'fixtures'
DJANGO_REFERENCE_DIR = FIXTURES_DIR / 'django-reference'


def test_figma_reference_has_file_key():
    reference_path = FIXTURES_DIR / 'figma-reference.json'
    assert reference_path.exists(), f'{reference_path} does not exist'

    data = json.loads(reference_path.read_text())
    assert data.get('file_key'), 'figma-reference.json is missing "file_key"'


def test_expected_tokens_css_has_css_variable():
    tokens_path = FIXTURES_DIR / 'expected' / 'tokens.css'
    assert tokens_path.exists(), f'{tokens_path} does not exist'

    content = tokens_path.read_text()
    assert '--' in content, 'expected/tokens.css does not define any CSS custom property'


def test_django_reference_project_check_deploy():
    # sys.executable — the interpreter running pytest (the venv one), not whatever
    # `python` happens to be on PATH, which may not have Django installed.
    result = subprocess.run(
        [sys.executable, 'manage.py', 'check', '--deploy'],
        cwd=DJANGO_REFERENCE_DIR,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, (
        f'manage.py check --deploy failed:\nstdout: {result.stdout}\nstderr: {result.stderr}'
    )
