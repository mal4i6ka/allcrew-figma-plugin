# Тестовый стенд (T0.3)

Эталонные данные для проверки того, что генерирует плагин Figma → Django.

## Структура

- `figma-reference.json` — снимок эталонного Figma-файла: Local Variables
  (коллекции `Color` / `Spacing` / `Typography`), два компонента с
  Text-пропом и Boolean-пропом (`Card`, `Badge`), именованные текстовые
  стили и фрейм с `SMART_ANIMATE`-переходом между двумя состояниями.
  Формат `collections`/`variables` совпадает со схемой
  `VariableSnapshot` из `src/variables.ts`, так что фикстуру можно
  скармливать напрямую эмиттерам плагина в юнит-тестах.

- `django-reference/` — эталонный Django 6.0 проект (`reference_site`)
  с приложением `pages`, отдающим страницу-заглушку
  (`pages/templates/pages/index.html`). Шаблон использует
  `{% load static %}`, Bootstrap 5 (CDN) и CSS-переменные из
  `pages/static/pages/css/tokens.css` — та же схема токенов, что и в
  `expected/tokens.css`.
  - `make check` — `python manage.py check`
  - `make serve` — `python manage.py runserver 8080`
  - Установка зависимостей: `pip install -r requirements.txt`.

- `expected/` — golden-файлы для snapshot-тестов плагина (T7.2), сгенерированные
  реальными эмиттерами и зафиксированные как контракт:
  - `tokens.css` — вывод `emitTokensCss` (`src/tokens.ts`) на
    `figma-reference.json`; проверяется в `src/tokens.fixture.test.ts`.
  - `component_card.html` — вывод `emitComponentPartial`
    (`src/django/component-emitter.ts`) на IR-фикстуру компонента `Card`
    (`{{ title }}` — TEXT-проп, `{% if visible %}` — BOOLEAN-проп);
    проверяется в `src/django/component-emitter.snapshot.test.ts` и (после
    прогона через полный конвейер и снятия `GENERATED`-маркеров) в
    `src/export/pipeline.e2e.test.ts`.

- `ir/` (T7.2) — фикстуры для юнит-тестов IR-слоя на fixtures:
  - `variables-alias.json` — резолвер алиасов переменных
    (`resolveVariableValue`/`resolveForConsumer` из `src/variables.ts`):
    семантическая переменная, ссылающаяся через `VARIABLE_ALIAS` на
    примитив в другой коллекции, плюс цикл из двух переменных; проверяется
    в `src/variables.fixture.test.ts`.
  - `layout-nodes.json` — layout-маппер (`normalizeLayout`/`serializeNode`
    из `src/ir.ts`): по одному узлу на каждый вид `IrLayout` (flex, grid,
    absolute, Group без Auto Layout); проверяется в `src/ir.fixture.test.ts`.

- `i18n/po-entries.json` (T7.2) — PO-генератор (`emitPo` из `src/i18n/po.ts`):
  запись с контекстом/комментарием/референсом и запись с инлайн-разметкой без
  контекста и комментария; проверяется в `src/i18n/po.fixture.test.ts`.

- `motion/` (T7.2) — keyframes-эмиттер (`emitKeyframesRule`/`emitNodeAnimationCss`
  из `src/motion/css-emitter.ts`):
  - `translation-track.json` — трек `TRANSLATION_Y` с тремя ключевыми кадрами.
  - `node-animation.json` — узел с одним треком `OPACITY`.
  Проверяются в `src/motion/css-emitter.fixture.test.ts`.

## Проверка стенда

```
pip install -r tests/fixtures/django-reference/requirements.txt
pytest tests/test_fixture_integrity.py -v
cd tests/fixtures/django-reference && python manage.py check
npm test   # включает unit-, snapshot- и e2e-тесты T7.2
pytest tests/test_django_export_e2e.py -v   # опционально, пропускается без Django
```

Результат последнего прогона — в `STATUS.md`.
