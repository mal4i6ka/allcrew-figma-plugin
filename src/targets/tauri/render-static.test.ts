import test from 'node:test'
import assert from 'node:assert/strict'
import { renderFragment, renderStaticPage, type StaticRenderOptions } from './render-static.ts'

function opts(partials: Record<string, string> = {}): StaticRenderOptions {
  return {
    staticHref: (path) => `assets/${path}`,
    navHref: (key) => (key === 'nav_1_2' ? 'settings.html' : '#'),
    partials: new Map(Object.entries(partials)),
  }
}

test('static/load/translate tags resolve', () => {
  const src = `{% load static %}\n<link href="{% static 'css/tokens.css' %}"><p>{% translate "Hello & bye" %}</p>`
  const out = renderFragment(src, new Map(), opts())
  assert.equal(out, `<link href="assets/css/tokens.css"><p>Hello & bye</p>`)
})

test('blocktranslate keeps designer placeholders when unbound and substitutes when bound', () => {
  const src = '{% blocktranslate with name=name %}Hi {{ name }}!{% endblocktranslate %}'
  assert.equal(renderFragment(src, new Map(), opts()), 'Hi {name}!')
  assert.equal(renderFragment(src, new Map([['name', 'Ada']]), opts()), 'Hi Ada!')
})

test('if blocks honor truthiness incl. Django False and support nesting', () => {
  const src = '{% if l_ico %}<i>{% if deep %}D{% endif %}A</i>{% endif %}'
  assert.equal(renderFragment(src, new Map(), opts()), '')
  assert.equal(renderFragment(src, new Map<string, string | boolean>([['l_ico', true]]), opts()), '<i>A</i>')
  assert.equal(
    renderFragment(src, new Map<string, string | boolean>([['l_ico', true], ['deep', 'x']]), opts()),
    '<i>DA</i>'
  )
  assert.equal(renderFragment('{% if v %}X{% endif %}', new Map([['v', 'False']]), opts()), '')
})

test('inline if with attr body (bootstrap parent wiring form)', () => {
  const src = '<div{% if parent %} data-bs-parent="#{{ parent }}"{% endif %}>'
  assert.equal(renderFragment(src, new Map([['parent', 'acc-1']]), opts()), '<div data-bs-parent="#acc-1">')
  assert.equal(renderFragment(src, new Map(), opts()), '<div>')
})

test('variable expressions: default filter, lower, navMap, autoescape', () => {
  const o = opts()
  assert.equal(renderFragment(`{{ size|default:'md' }}`, new Map(), o), 'md')
  assert.equal(renderFragment(`{{ size|default:'MD'|lower }}`, new Map(), o), 'md')
  assert.equal(renderFragment(`{{ size|default:'md' }}`, new Map([['size', 'LG']]), o), 'LG')
  assert.equal(renderFragment('{{ navMap.nav_1_2 }}', new Map(), o), 'settings.html')
  assert.equal(renderFragment('{{ navMap.nav_9 }}', new Map(), o), '#')
  assert.equal(renderFragment('{{ label }}', new Map([['label', 'a<b>"c"']]), o), 'a&lt;b&gt;&quot;c&quot;')
  assert.equal(renderFragment('{{ missing }}', new Map(), o), '')
})

test('include renders the partial with `only` isolation and quoted/boolean/var params', () => {
  const partials = {
    'components/btn--1-5.html': '<button class="b b--{{ variant|default:\'primary\' }}">{% if l_ico %}I{% endif %}{{ label }}</button>',
  }
  const src = '{% include "components/btn--1-5.html" with label="Save \\"draft\\"" l_ico=True only %}'
  const out = renderFragment(src, new Map([['leaks', 'no']]), opts(partials))
  assert.equal(out, '<button class="b b--primary">ISave &quot;draft&quot;</button>')
})

test('include without `only` inherits, missing include target renders empty', () => {
  const partials = { 'components/a--1.html': '{{ outer }}' }
  assert.equal(renderFragment('{% include "components/a--1.html" %}', new Map([['outer', 'X']]), opts(partials)), 'X')
  assert.equal(renderFragment('{% include "components/gone--2.html" %}', new Map(), opts(partials)), '')
})

test('instance-swap include: var with default resolves to a partial path', () => {
  const partials = { 'components/icon--3.html': '<svg/>' }
  assert.equal(renderFragment(`{% include l_ico2|default:'components/icon--3.html' %}`, new Map(), opts(partials)), '<svg/>')
  assert.equal(renderFragment('{% include unbound %}', new Map(), opts(partials)), '')
})

test('nested include chain with text override defaults', () => {
  const partials = {
    'components/card--7.html': '{% include "components/btn--8.html" with text_9="Go" only %}',
    'components/btn--8.html': '<span>{{ text_9|default:"Stop" }}</span>',
  }
  assert.equal(renderFragment('{% include "components/card--7.html" only %}', new Map(), opts(partials)), '<span>Go</span>')
  assert.equal(renderFragment('{% include "components/btn--8.html" only %}', new Map(), opts(partials)), '<span>Stop</span>')
})

test('GENERATED comment markers are stripped', () => {
  const base = [
    '{% load static %}',
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    `  <link rel="stylesheet" href="{% static 'css/project.css' %}">`,
    '</head>',
    '<body>',
    '  {% block content %}{% endblock %}',
    '</body>',
    '</html>',
  ].join('\n')
  const page = [
    '{# GENERATED:BEGIN 1:2 — edits outside this block survive regeneration #}',
    '{% extends "base.html" %}',
    '{% load i18n %}',
    '{% load static %}',
    '{% block content %}',
    '    <div class="n1-2"><p class="n1-3"><span class="n1-3__s0">{% translate "Hi" %}</span></p></div>',
    '{% endblock %}',
    '{# GENERATED:END 1:2 #}',
  ].join('\n')
  const doc = renderStaticPage(base, page, opts())
  assert.ok(doc.includes('<link rel="stylesheet" href="assets/css/project.css">'))
  assert.ok(doc.includes('<span class="n1-3__s0">Hi</span>'))
  assert.ok(!doc.includes('{%'))
  assert.ok(!doc.includes('{#'))
  assert.ok(doc.startsWith('<!DOCTYPE html>') || doc.startsWith('\n'))
})

test('framework blocks unwrap keeping inner content; literal braces in body survive', () => {
  const base = [
    '{% load static %}',
    '<html><head>',
    '  {% block framework_css %}',
    '  <style>@import url("https://cdn.example/bootstrap.css") layer(bootstrap);</style>',
    '  {% endblock %}',
    '</head><body>',
    '  {% block content %}{% endblock %}',
    '</body></html>',
  ].join('\n')
  const page = '{% extends "base.html" %}\n{% block content %}<p>a {{ '.concat('}} b</p>{% endblock %}')
  const doc = renderStaticPage(base, page, opts())
  assert.ok(doc.includes('@import url("https://cdn.example/bootstrap.css")'))
  // A dangling `{{ }}` in text (designer-typed braces) must not corrupt the shell.
  assert.ok(doc.includes('</body></html>'))
})

test('overlay dialogs injected into the content block render', () => {
  const base = '<html><head></head><body>{% block content %}{% endblock %}</body></html>'
  const page = [
    '{% extends "base.html" %}',
    '{% block content %}',
    '<div class="n1"></div>',
    '  <dialog class="overlay-n2" data-overlay="n2"><div class="n2"></div></dialog>',
    '{% endblock %}',
  ].join('\n')
  const doc = renderStaticPage(base, page, opts())
  assert.ok(doc.includes('<dialog class="overlay-n2"'))
})
