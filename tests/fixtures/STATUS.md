# Статус тестового стенда (T0.3)

Дата проверки: 2026-07-04.

## Django

```
$ pip install -r tests/fixtures/django-reference/requirements.txt
Successfully installed django-6.0.6 ...

$ cd tests/fixtures/django-reference && python manage.py check
System check identified no issues (0 silenced).

$ python manage.py check --deploy
System check identified 7 issues (0 silenced).   # только WARNINGS (dev SECRET_KEY/DEBUG), exit code 0
```

## Pytest

```
$ pytest tests/test_fixture_integrity.py -v
tests/test_fixture_integrity.py::test_figma_reference_has_file_key PASSED
tests/test_fixture_integrity.py::test_expected_tokens_css_has_css_variable PASSED
tests/test_fixture_integrity.py::test_django_reference_project_check_deploy PASSED
3 passed
```

Оба прогона проходят без ошибок. Стенд готов к использованию другими тасками
(эмиттеры токенов/компонентов могут сверяться с `expected/`, а
`figma-reference.json` — источник входных данных для юнит-тестов).

## T7.2 (2026-07-04, attempt 2)

Добавлены fixture-driven unit-тесты на все четыре компонента, явно
перечисленных в DoD (резолвер алиасов, layout-маппер, PO-генератор,
keyframes-эмиттер), плюс snapshot- и e2e-тесты:

- `src/variables.fixture.test.ts` ← `ir/variables-alias.json` — резолвер
  алиасов переменных.
- `src/ir.fixture.test.ts` ← `ir/layout-nodes.json` — layout-маппер.
- `src/i18n/po.fixture.test.ts` ← `i18n/po-entries.json` — PO-генератор.
- `src/motion/css-emitter.fixture.test.ts` ← `motion/translation-track.json`,
  `motion/node-animation.json` — keyframes-эмиттер.
- `src/tokens.fixture.test.ts`, `src/django/component-emitter.snapshot.test.ts`
  — snapshot-тесты эмиттеров против `expected/*`.
- `src/export/pipeline.e2e.test.ts` — e2e конвейер (`emitDjangoProject` →
  `emitTokensCss` → `buildExportTree` → zip → `applyDjangoExport`) поверх
  копии `django-reference/`.
- `tests/test_django_export_e2e.py` — рендер экспортированного партиала через
  Django template engine + `staticfiles.finders` + `manage.py check` поверх
  копии `django-reference/` (пропускается, если Django не установлен).

Все входят в `npm test` (кроме Python-теста).

```
$ node --experimental-transform-types --test src/variables.fixture.test.ts \
    src/ir.fixture.test.ts src/i18n/po.fixture.test.ts \
    src/motion/css-emitter.fixture.test.ts src/tokens.fixture.test.ts \
    src/django/component-emitter.snapshot.test.ts src/export/pipeline.e2e.test.ts
# tests 21, pass 21, fail 0

$ pytest tests/test_django_export_e2e.py -v   # (venv с pytest==9.1.1, django==6.0.6)
2 passed
```
