/**
 * Django project scaffold (contract item 4): before this, the export shipped only `templates/` +
 * `static/` — a folder Django cannot run, since nothing on disk was `manage.py`-compatible. This
 * emits the minimal-but-production-shaped Django 5 project (settings/urls/views/i18n wiring) that
 * serves those templates as a real multipage, localized site.
 *
 * `pages.py` is the one file a re-export overwrites (contract's "generated page registry"); every
 * other file here is dispatch/config that *reads* `pages.py`, so regenerating never has to touch
 * hand-written project files again once they exist. `views.py`/`design/urls.py`/
 * `context_processors.py` are therefore written to be correct for an *empty* `PAGES` list too —
 * the scaffold has to work before the first export as much as after the hundredth.
 */

import { pyStr, toPascalCase } from './python.ts'

export interface ScaffoldPage {
  /** `pages/home--1-2.html` — relative to `templates/`, matching `component-emitter.ts`'s
   * `pageTemplatePath` output already written under that prefix. */
  readonly templatePath: string
  /** Source Figma node id, e.g. `'1:2'` — carried through for traceability, not used at runtime. */
  readonly nodeId: string
  /** `nav_1_2` — `component-emitter.ts`'s `navMapKey(nodeId)`; the dotted key every exported
   * template's `{{ navMap.<navKey> }}` lookup already expects. */
  readonly navKey: string
  readonly slug: string
  readonly title: string
  /** Prototype start frame → serves at the site root (`''`) instead of `'<slug>/'`. */
  readonly isStart: boolean
}

export interface ScaffoldLanguage {
  readonly code: string
  readonly label: string
}

export interface DjangoScaffoldInput {
  readonly pages: readonly ScaffoldPage[]
  /** Python package name for the Django project (`django-admin startproject <projectName>`). */
  readonly projectName: string
  /** Python package name for the Django app hosting the generated views/urls/pages registry. */
  readonly appName: string
  /** Every language the site serves, including the default. `[]` disables i18n entirely: no
   * `i18n_patterns`, no `LocaleMiddleware`, no `set_language` route. */
  readonly languages: readonly ScaffoldLanguage[]
  readonly defaultLanguage: string
  /** `static`-relative path of the generated stylesheet (e.g. `'css/project.css'`) — `base.html`
   * links it; kept here only so this scaffold's generated comments/README can point at the right
   * file without re-deriving it. */
  readonly staticCssFile: string
}

/** Every entry gets a `'description'` key even though `ScaffoldPage` doesn't carry one yet —
 * `views.py` reads `entry['description']` unconditionally so a future SEO-description field only
 * has to change this generator, not the dispatch that consumes the registry. */
function emitPagesPy(pages: readonly ScaffoldPage[]): string {
  const lines = [
    '"""Generated page registry (do not edit by hand — regenerated on every export): one entry',
    'per exported Figma page frame. `views.py` looks pages up by slug; `context_processors.py`',
    'reverses each page\'s URL into the `navMap` the exported templates already reference via',
    '`{{ navMap.nav_1_2 }}`."""',
    '',
    'PAGES = [',
  ]
  for (const page of pages) {
    lines.push(
      '    {',
      `        'slug': ${pyStr(page.slug)},`,
      `        'template': ${pyStr(page.templatePath)},`,
      `        'title': ${pyStr(page.title)},`,
      "        'description': '',",
      `        'nav_key': ${pyStr(page.navKey)},`,
      `        'node_id': ${pyStr(page.nodeId)},`,
      `        'is_start': ${page.isStart ? 'True' : 'False'},`,
      '    },'
    )
  }
  lines.push(']', '')
  return lines.join('\n')
}

function emitAppUrlsPy(appName: string): string {
  return [
    '"""Generated URL routes (do not edit by hand — regenerated on every export): the',
    'prototype\'s start frame serves at the site root, every other page at `<slug>/`, named',
    '`page-<slug>` so `context_processors.py`\'s `reverse()` calls resolve them."""',
    '',
    'from django.urls import path',
    '',
    'from . import views',
    'from .pages import PAGES',
    '',
    `app_name = ${pyStr(appName)}`,
    '',
    'urlpatterns = [',
    "    path('' if entry['is_start'] else f\"{entry['slug']}/\", views.page, {'slug': entry['slug']}, name=f\"page-{entry['slug']}\")",
    '    for entry in PAGES',
    ']',
    '',
  ].join('\n')
}

function emitContextProcessorsPy(appName: string): string {
  return [
    '"""Context processor: rebuilds `navMap` — see `component-emitter.ts`\'s `navMapKey` on the',
    'TypeScript side — on every request, so the raw `{{ navMap.nav_1_2 }}` lookups the exported',
    'templates already emit resolve to real, i18n-aware URLs instead of rendering empty."""',
    '',
    'from django.urls import reverse',
    '',
    'from .pages import PAGES',
    '',
    '',
    'def nav_map(request):',
    '    return {',
    "        'navMap': {",
    `            page['nav_key']: reverse(f'${appName}:page-{page["slug"]}')`,
    '            for page in PAGES',
    '        }',
    '    }',
    '',
  ].join('\n')
}

function emitAppsPy(appName: string): string {
  return ['from django.apps import AppConfig', '', '', `class ${toPascalCase(appName)}Config(AppConfig):`, `    name = ${pyStr(appName)}`, ''].join(
    '\n'
  )
}

function emitManagePy(projectName: string): string {
  return [
    '#!/usr/bin/env python',
    '"""Django\'s command-line utility for administrative tasks."""',
    'import os',
    'import sys',
    '',
    '',
    'def main():',
    '    """Run administrative tasks."""',
    `    os.environ.setdefault('DJANGO_SETTINGS_MODULE', ${pyStr(`${projectName}.settings`)})`,
    '    try:',
    '        from django.core.management import execute_from_command_line',
    '    except ImportError as exc:',
    '        raise ImportError(',
    '            "Couldn\'t import Django. Are you sure it\'s installed and "',
    '            "available on your PYTHONPATH environment variable? Did you "',
    '            "forget to activate a virtual environment?"',
    '        ) from exc',
    '    execute_from_command_line(sys.argv)',
    '',
    '',
    "if __name__ == '__main__':",
    '    main()',
    '',
  ].join('\n')
}

function emitWsgiPy(projectName: string): string {
  return [
    `"""WSGI config for the ${projectName} project."""`,
    '',
    'import os',
    '',
    'from django.core.wsgi import get_wsgi_application',
    '',
    `os.environ.setdefault('DJANGO_SETTINGS_MODULE', ${pyStr(`${projectName}.settings`)})`,
    '',
    'application = get_wsgi_application()',
    '',
  ].join('\n')
}

function emitAsgiPy(projectName: string): string {
  return [
    `"""ASGI config for the ${projectName} project."""`,
    '',
    'import os',
    '',
    'from django.core.asgi import get_asgi_application',
    '',
    `os.environ.setdefault('DJANGO_SETTINGS_MODULE', ${pyStr(`${projectName}.settings`)})`,
    '',
    'application = get_asgi_application()',
    '',
  ].join('\n')
}

function emitProjectUrlsPy(appName: string, hasLanguages: boolean): string {
  if (hasLanguages) {
    return [
      '"""Root URLconf: mounts the generated page routes under `i18n_patterns` and exposes',
      '`set_language` at `i18n/` for `templates/partials/language-switcher.html`\'s POST."""',
      '',
      'from django.conf.urls.i18n import i18n_patterns',
      'from django.urls import include, path',
      '',
      'urlpatterns = [',
      "    path('i18n/', include('django.conf.urls.i18n')),",
      ']',
      '',
      'urlpatterns += i18n_patterns(',
      `    path('', include(${pyStr(`${appName}.urls`)}, namespace=${pyStr(appName)})),`,
      '    prefix_default_language=False,',
      ')',
      '',
    ].join('\n')
  }
  return [
    '"""Root URLconf: mounts the generated page routes. No `languages` were configured, so',
    'there is no `i18n_patterns` wrapping and no `set_language` endpoint — see `settings.py`\'s',
    '`MIDDLEWARE`/`LANGUAGES` for the i18n toggle this mirrors."""',
    '',
    'from django.urls import include, path',
    '',
    'urlpatterns = [',
    `    path('', include(${pyStr(`${appName}.urls`)}, namespace=${pyStr(appName)})),`,
    ']',
    '',
  ].join('\n')
}

function emitSettingsPy(input: DjangoScaffoldInput): string {
  const { projectName, appName, languages, defaultLanguage, staticCssFile } = input
  const hasLanguages = languages.length > 0

  const middleware = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    ...(hasLanguages ? ['django.middleware.locale.LocaleMiddleware'] : []),
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
  ]

  const languagesBlock = hasLanguages
    ? ['LANGUAGES = [', ...languages.map((lang) => `    (${pyStr(lang.code)}, ${pyStr(lang.label)}),`), ']', '']
    : []

  return [
    '"""Generated Django settings (contract item 4): production-shaped by default. `DEBUG`,',
    '`ALLOWED_HOSTS`, and `SECRET_KEY` come from the environment (see `.env.example`); WhiteNoise',
    'serves `static/` directly so a plain `gunicorn <project>.wsgi` deployment needs no separate',
    'web server for assets."""',
    '',
    'import os',
    'from pathlib import Path',
    '',
    'BASE_DIR = Path(__file__).resolve().parent.parent',
    '',
    "SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', 'django-insecure-dev-key-change-me')",
    '',
    "DEBUG = os.environ.get('DJANGO_DEBUG', '').strip().lower() in ('1', 'true', 'yes')",
    '',
    "ALLOWED_HOSTS = [host.strip() for host in os.environ.get('DJANGO_ALLOWED_HOSTS', '').split(',') if host.strip()]",
    '',
    'INSTALLED_APPS = [',
    "    'django.contrib.staticfiles',",
    `    ${pyStr(appName)},`,
    ']',
    '',
    "# `set_language` (django.views.i18n.set_language) only writes the chosen language into",
    "# `request.session` when `hasattr(request, 'session')` — with no `django.contrib.sessions`",
    '# installed that never holds, so it falls through to the cookie it always also sets. No',
    '# session app is added here because nothing in this project authenticates a user or',
    '# otherwise needs one; the language switcher is deliberately cookie-only.',
    'MIDDLEWARE = [',
    ...middleware.map((m) => `    ${pyStr(m)},`),
    ']',
    '',
    `ROOT_URLCONF = ${pyStr(`${projectName}.urls`)}`,
    '',
    'TEMPLATES = [',
    '    {',
    "        'BACKEND': 'django.template.backends.django.DjangoTemplates',",
    "        'DIRS': [BASE_DIR / 'templates'],",
    "        'APP_DIRS': True,",
    "        'OPTIONS': {",
    "            'context_processors': [",
    "                'django.template.context_processors.debug',",
    "                'django.template.context_processors.request',",
    // Without this, `{{ LANGUAGE_CODE }}` is empty and base.html's <html lang> falls back to the
    // default on every localized page — the page renders in Russian and tells the browser it is
    // English. Only added with languages configured; there is nothing to switch otherwise.
    ...(hasLanguages ? ["                'django.template.context_processors.i18n',"] : []),
    `                ${pyStr(`${appName}.context_processors.nav_map`)},`,
    '            ],',
    '        },',
    '    },',
    ']',
    '',
    `WSGI_APPLICATION = ${pyStr(`${projectName}.wsgi.application`)}`,
    `ASGI_APPLICATION = ${pyStr(`${projectName}.asgi.application`)}`,
    '',
    'USE_I18N = True',
    `LANGUAGE_CODE = ${pyStr(defaultLanguage)}`,
    ...languagesBlock,
    "LOCALE_PATHS = [BASE_DIR / 'locale']",
    '',
    'USE_TZ = True',
    '',
    "STATIC_URL = 'static/'",
    '',
    `# base.html links the generated stylesheet via {% static ${pyStr(staticCssFile)} %}.`,
    "STATICFILES_DIRS = [BASE_DIR / 'static']",
    "STATIC_ROOT = BASE_DIR / 'staticfiles'",
    '',
    'STORAGES = {',
    "    'default': {",
    "        'BACKEND': 'django.core.files.storage.FileSystemStorage',",
    '    },',
    "    'staticfiles': {",
    "        'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage',",
    '    },',
    '}',
    '',
    'if not DEBUG:',
    '    SECURE_HSTS_SECONDS = 31536000',
    // Both HSTS companions matter: without INCLUDE_SUBDOMAINS a single plaintext subdomain undoes
    // the header, and without PRELOAD the domain cannot enter the browser preload list.
    // `manage.py check --deploy` names them individually (W005/W021).
    '    SECURE_HSTS_INCLUDE_SUBDOMAINS = True',
    '    SECURE_HSTS_PRELOAD = True',
    '    SECURE_SSL_REDIRECT = True',
    '    SESSION_COOKIE_SECURE = True',
    '    CSRF_COOKIE_SECURE = True',
    "    X_FRAME_OPTIONS = 'DENY'",
    '',
  ].join('\n')
}

function emitMakefile(languages: readonly ScaffoldLanguage[]): string {
  const messagesCommand =
    languages.length > 0
      ? `python manage.py makemessages ${languages.map((lang) => `-l ${lang.code}`).join(' ')}`
      : 'python manage.py makemessages --all'
  return [
    '.PHONY: install run messages compilemessages collectstatic check',
    '',
    'install:',
    '\tpip install -r requirements.txt',
    '',
    'run:',
    '\tpython manage.py runserver',
    '',
    'messages:',
    `\t${messagesCommand}`,
    '',
    'compilemessages:',
    '\tpython manage.py compilemessages',
    '',
    'collectstatic:',
    '\tpython manage.py collectstatic --noinput',
    '',
    'check:',
    '\tpython manage.py check --deploy',
    '',
  ].join('\n')
}

function emitReadme(input: DjangoScaffoldInput): string {
  const { staticCssFile, languages } = input
  const localizedNote =
    languages.length > 0
      ? `Ships localized into ${languages.map((lang) => lang.code).join(', ')}; \`compilemessages\` below turns the shipped \`locale/**/*.po\` catalogs into the \`.mo\` files Django actually loads. It needs GNU gettext on PATH (\`brew install gettext\` / \`apt install gettext\`) — without \`msgfmt\` the command fails and every page renders in the source language.`
      : 'No additional languages were configured for this export, so `compilemessages` below is a harmless no-op.'
  return [
    '# Generated Django site',
    '',
    'This project was generated by the Figma-to-Django export. Its templates, static assets',
    `(including \`static/${staticCssFile}\`), and this scaffold together form a runnable, localized`,
    'multipage Django 5 site.',
    '',
    localizedNote,
    '',
    '## Run it',
    '',
    '```sh',
    'pip install -r requirements.txt',
    'python manage.py compilemessages',
    'python manage.py collectstatic --noinput',
    'python manage.py runserver',
    '```',
    '',
    'Then open http://127.0.0.1:8000/.',
    '',
  ].join('\n')
}

/**
 * Assembles the full scaffold as a flat `{ path: content }` map (paths relative to the export's
 * zip root, alongside the already-existing `templates/` and `static/` trees). Deterministic:
 * every list here is either a fixed literal or a direct map over caller-ordered input arrays, so
 * the same input always produces byte-identical output.
 */
export function emitDjangoScaffold(input: DjangoScaffoldInput): Record<string, string> {
  const { pages, projectName, appName, languages } = input
  const hasLanguages = languages.length > 0

  const files: Record<string, string> = {}

  files['manage.py'] = emitManagePy(projectName)
  files[`${projectName}/__init__.py`] = ''
  files[`${projectName}/settings.py`] = emitSettingsPy(input)
  files[`${projectName}/urls.py`] = emitProjectUrlsPy(appName, hasLanguages)
  files[`${projectName}/wsgi.py`] = emitWsgiPy(projectName)
  files[`${projectName}/asgi.py`] = emitAsgiPy(projectName)

  files[`${appName}/__init__.py`] = ''
  files[`${appName}/apps.py`] = emitAppsPy(appName)
  files[`${appName}/urls.py`] = emitAppUrlsPy(appName)
  files[`${appName}/views.py`] = [
    '"""Renders a page by slug from the generated `pages.py` registry. Regenerating the export',
    'overwrites `pages.py`, not this dispatch, so page additions/removals need no manual wiring',
    'here."""',
    '',
    'from django.http import Http404',
    'from django.shortcuts import render',
    '',
    'from .pages import PAGES',
    '',
    "_PAGES_BY_SLUG = {page['slug']: page for page in PAGES}",
    '',
    '',
    'def page(request, slug):',
    '    entry = _PAGES_BY_SLUG.get(slug)',
    '    if entry is None:',
    '        raise Http404(f\'No page registered for slug "{slug}"\')',
    '    context = {',
    "        'page_title': entry['title'],",
    "        'page_description': entry['description'],",
    '    }',
    "    return render(request, entry['template'], context)",
    '',
  ].join('\n')
  files[`${appName}/pages.py`] = emitPagesPy(pages)
  files[`${appName}/context_processors.py`] = emitContextProcessorsPy(appName)

  files['templates/404.html'] = [
    '{% extends "base.html" %}',
    '{% load i18n %}',
    '{% block content %}',
    '  <section style="text-align:center; padding:4rem 1rem;">',
    '    <h1>404</h1>',
    '    <p>{% translate "This page doesn\'t exist." %}</p>',
    '  </section>',
    '{% endblock %}',
    '',
  ].join('\n')
  // Django's `server_error` view (`django.views.defaults.server_error`) renders this template
  // with `template.render()` — no request, no context processors. It deliberately does NOT
  // `{% extends "base.html" %}`: base.html's own markup is out of this slice's control and may
  // lean on context processors (e.g. `navMap`) that are unavailable here, so a truly broken
  // request shouldn't risk failing a second time trying to render a layout it can't fully
  // populate.
  files['templates/500.html'] = [
    '{% load i18n %}',
    '<!doctype html>',
    "<html lang=\"{{ LANGUAGE_CODE|default:'en' }}\">",
    '  <head>',
    '    <meta charset="utf-8">',
    '    <title>{% translate "Server error" %}</title>',
    '  </head>',
    '  <body>',
    '    <section style="text-align:center; padding:4rem 1rem;">',
    '      <h1>500</h1>',
    '      <p>{% translate "Something went wrong on our end. Please try again shortly." %}</p>',
    '    </section>',
    '  </body>',
    '</html>',
    '',
  ].join('\n')
  // No JS: the <select> only takes effect once the surrounding form is submitted through the
  // button click below, matching contract item 4's "no JS" — an onchange="this.form.submit()"
  // handler would have been the obvious shortcut, but it's exactly the JS dependency this avoids.
  files['templates/partials/language-switcher.html'] = [
    '{% load i18n %}',
    // `{% url … as var %}` is the non-raising form: applied onto a project that never wired
    // `django.conf.urls.i18n`, the plain `{% url %}` raises NoReverseMatch and takes every page
    // that extends base.html down with it. Missing route → empty string → no switcher, page fine.
    "{% url 'set_language' as set_language_url %}",
    '{% get_current_language as CURRENT_LANGUAGE %}',
    '{% get_available_languages as AVAILABLE_LANGUAGES %}',
    '{% if set_language_url and AVAILABLE_LANGUAGES|length > 1 %}',
    '<form action="{{ set_language_url }}" method="post" class="language-switcher">',
    '  {% csrf_token %}',
    '  <input type="hidden" name="next" value="{{ request.path }}">',
    '  <select name="language">',
    '    {% for code, name in AVAILABLE_LANGUAGES %}',
    '      <option value="{{ code }}"{% if code == CURRENT_LANGUAGE %} selected{% endif %}>{{ name }}</option>',
    '    {% endfor %}',
    '  </select>',
    '  <button type="submit">{% translate "Switch" %}</button>',
    '</form>',
    '{% endif %}',
    '',
  ].join('\n')

  files['requirements.txt'] = ['django>=5.0,<6', 'whitenoise>=6.6,<7', ''].join('\n')
  files['.gitignore'] = ['__pycache__/', '*.pyc', '.env', '/staticfiles/', '/.venv/', '*.mo', ''].join('\n')
  files['.env.example'] = [
    '# Copy to .env (or export these directly) before running in anything but local dev.',
    'DJANGO_SECRET_KEY=change-me',
    'DJANGO_DEBUG=false',
    'DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1',
    '',
  ].join('\n')
  files['README.md'] = emitReadme(input)
  files['Makefile'] = emitMakefile(languages)

  return files
}
