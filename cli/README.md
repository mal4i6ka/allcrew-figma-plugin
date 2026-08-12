# altery-dj — терминальный компаньон плагина Altery Django Export

Python ≥ 3.11, без зависимостей (stdlib-only). Команды над пакетом, который выгружает
Figma-плагин (REFORM фаза 5, [docs/REFORM.md](../docs/REFORM.md) §6): от распаковки экспорта
до полного цикла разворачивания Django-стенда (venv → сервер → просмотр в браузере).

## Установка

```bash
pipx install -e cli/                # вариант 1: pipx / pip
ln -s "$PWD/cli/bin/altery-dj" /usr/local/bin/altery-dj   # вариант 2: симлинк
```

## Быстрый старт: стенд «от и до»

```bash
altery-dj demo up export.zip --app .django-demo    # venv + скаффолд + apply + сервер
# → http://127.0.0.1:8080/
```

Одна команда: создаёт `.venv` с Django, разворачивает минимальный стенд, **проводит его под
раскладку экспорта** (`TEMPLATES.DIRS` и `STATICFILES_DIRS` смотрят на корневые
`templates/`+`static/`, куда распаковывается zip — стоковый `startproject` их не видит),
при необходимости докачивает Bootstrap, применяет пакет и поднимает dev-сервер в фоне.

## Команды

### Пакет: применить / переприменить

| Команда | Что делает |
|---|---|
| `altery-dj apply export.zip [--app DIR] [--dry-run]` | распаковать пакет в Django-app (ищет manage.py вверх по дереву); также кладёт tokens.json + bootstrap.map.json в корень app. Перезапускает запущенный управляемый сервер, чтобы он отдавал свежие шаблоны; предупреждает, если `--app` — корень проекта, чьи `settings.py` не проводят корневые templates/static |
| `altery-dj rebuild export.zip [--dry-run] [--diff]` | переприменить свежий экспорт: правки **вне** `{# GENERATED #}`-маркеров выживают, шаблон без маркеров не трогается; static/locale заменяются целиком |

### Стенд и dev-сервер

| Команда | Что делает |
|---|---|
| `altery-dj demo init [--app DIR] [--no-venv]` | скаффолд стенда, проводного под раскладку экспорта (корневые templates/static, индекс страниц, view с navMap), + `.venv` с Django (`--no-venv` — текущий интерпретатор) |
| `altery-dj demo up export.zip [--app DIR] [--port 8080] [--no-venv]` | init + apply + serve одной командой; при `assume`-режиме base.html перепривязывает framework-блоки к vendored-файлам и докачивает Bootstrap |
| `altery-dj serve [--app DIR] [--port 8080] [--host 127.0.0.1] [--foreground]` | запустить dev-сервер в фоне (pid/лог под `.altery-dj/`); ждёт, пока порт ответит, при падении печатает хвост лога. `--foreground` — не отцеплять от терминала |
| `altery-dj stop [--app DIR]` | остановить сервер, поднятый `serve` |
| `altery-dj status [--app DIR]` | pid / порт / интерпретатор (есть ли Django) / путь к логу |
| `altery-dj logs [--app DIR] [--lines 50]` | хвост лога dev-сервера |

Интерпретатор для `check`/`serve` берётся из `.venv` стенда (когда есть), а не из того, чем
запущен altery-dj — иначе `manage.py` падает с `No module named 'django'`. Если Django не
найден, команда подсказывает `altery-dj demo init`.

### Проверка, токены, локали, доставка

| Команда | Что делает |
|---|---|
| `altery-dj check [--app DIR] [--no-render]` | manage.py check + смоук-рендер каждого шаблона через Django-движок + msgfmt по locale/*.po |
| `altery-dj tokens [--format css\|bootstrap\|scss\|all] [--app DIR] [--theme-attr A] [--no-inline] [--flatten-all]` | пересобрать производные файлы из tokens.json (+ bootstrap.map.json) без переэкспорта из Figma |
| `altery-dj po merge [--locale ru] [--app DIR] [--django-po P] [--figma-po P]` | `msgmerge -U` figma.po → django.po (makemessages/compilemessages остаются за Django) |
| `altery-dj bootstrap vendor [--version 5.3] [--app DIR]` | скачать Bootstrap в static/vendor/bootstrap/ (для источника «vendored») |
| `altery-dj receive [--app DIR] [--port 8765] [--host H] [--secret S] [--once]` | HTTP-приёмник для Settings → Delivery плагина: принятый zip применяется как `apply` |
| `altery-dj help [команда]` | справка с примерами |

## Типовые сценарии

Разворот с нуля и просмотр:

```bash
altery-dj demo up export.zip --app .django-demo --port 8080
altery-dj status --app .django-demo          # что и где запущено
altery-dj logs --app .django-demo --lines 100
altery-dj stop --app .django-demo
```

Итеративная работа над существующим стендом — повторный экспорт подхватывается без ручного
рестарта (`apply` сам перезапустит управляемый сервер):

```bash
altery-dj apply export.zip --app .django-demo
# поправили bootstrap.map.json → пересборка токенов на месте:
altery-dj tokens --format bootstrap --app .django-demo
```

Применение к своему (не сгенерированному) проекту: указывай `--app` на директорию app
(например `--app pages/`), либо проведи корневые templates/static в его `settings.py`
(`TEMPLATES.DIRS` + `STATICFILES_DIRS`) — иначе стоковый Django не увидит записанные файлы.

Без скачиваний вообще (Delivery): на машине разработчика `altery-dj receive --app site/
--secret s3cret`, в плагине Settings → Delivery → Endpoint `http://<машина>:8765` + тот же
секрет + «Send after export» — каждый экспорт прилетает применённым.

## Паритет с плагином

Эмиттеры `tokens` — порт TS-движка плагина (`src/tokens/engine.ts`,
`src/frameworks/bootstrap/map.ts`); байтовый паритет закреплён общими golden-фикстурами
(`tests/test_cli.py` ↔ `src/tokens/engine.test.ts`). Меняешь формат — меняй оба.
