/**
 * Static renderer for the Tauri target: resolves the CONSTRAINED Django-template subset the
 * django emitters produce (component-emitter.ts / html-emitter.ts — the only producers) into
 * plain HTML a Tauri webview serves from `frontendDist` with no template engine.
 *
 * Supported subset (everything the emitters can write, nothing more):
 *   {% load … %}                              → dropped
 *   {# … #}                                   → dropped (incl. GENERATED markers)
 *   {% extends "base.html" %}                 → handled by `renderStaticPage`
 *   {% block NAME %}…{% endblock %}           → base: content substitution / unwrap
 *   {% static 'p' %}                          → opts.staticHref(p)
 *   {% translate "s" %}                       → s
 *   {% blocktranslate with a=a %}b{% endblocktranslate %} → b with {{ a }} → ctx or `{a}`
 *   {% if VAR %}…{% endif %}                  → body when ctx[VAR] is truthy (nesting supported)
 *   {% include "p" with k=v … only %}         → recursive partial render
 *   {% include VAR|default:'p' %}             → instance-swap include
 *   {{ VAR }}, {{ VAR|default:"x" }}, {{ VAR|default:'x'|lower }}, {{ navMap.KEY }}
 *
 * Django-runtime semantics preserved: autoescape on variable output, `only` context isolation,
 * `default` filter on empty/missing values.
 */

export interface StaticRenderOptions {
  /** Maps a `{% static 'p' %}` path to the app-relative href (e.g. `p` → `assets/p`). */
  staticHref: (path: string) => string
  /** Maps a `{{ navMap.KEY }}` lookup to a page href (e.g. `index.html`); unknown key → `#`. */
  navHref: (key: string) => string
  /** Partial template source by its emitted path (`components/<name>--<id>.html`). */
  partials: ReadonlyMap<string, string>
}

type Ctx = ReadonlyMap<string, string | boolean>

const EMPTY_CTX: Ctx = new Map()

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Reverse of component-emitter's `escapeDjangoString` (\\ and \"). */
function unescapeDjangoString(value: string): string {
  return value.replace(/\\(["\\])/g, '$1')
}

function stripComments(src: string): string {
  return src.replace(/\{#[\s\S]*?#\}/g, '')
}

function truthy(value: string | boolean | undefined): boolean {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  return value !== '' && value !== 'False'
}

/** Parses one with-clause value: `"quoted"`, `'quoted'`, `True`/`False`, or a bare var name
 * resolved against `ctx` (missing → undefined, matching Django's silent empty). */
function parseParamValue(raw: string, ctx: Ctx): string | boolean | undefined {
  if (raw === 'True') return true
  if (raw === 'False') return false
  const quoted = raw.match(/^"((?:[^"\\]|\\.)*)"$/) ?? raw.match(/^'((?:[^'\\]|\\.)*)'$/)
  if (quoted) return unescapeDjangoString(quoted[1])
  return ctx.get(raw)
}

/** Splits a with-clause (`a="x y" b=True c=var`) on spaces outside quotes. */
function splitParams(clause: string): string[] {
  const out: string[] = []
  const pattern = /(\w+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g
  for (const match of clause.matchAll(pattern)) out.push(`${match[1]}\u0000${match[2]}`)
  return out
}

/** Resolves a variable expression: `name`, `navMap.key`, with optional `|default:LIT` and
 * `|lower` filters. Returns the RAW string (escaping is the caller's concern). */
function resolveExpr(expr: string, ctx: Ctx, opts: StaticRenderOptions): string {
  const parts = expr.split('|').map((part) => part.trim())
  const head = parts[0]

  let value: string | boolean | undefined
  const navMatch = head.match(/^navMap\.(\w+)$/)
  if (navMatch) {
    value = opts.navHref(navMatch[1])
  } else {
    value = ctx.get(head)
  }

  for (const filter of parts.slice(1)) {
    const defaultMatch = filter.match(/^default:(.*)$/)
    if (defaultMatch) {
      if (!truthy(value)) value = parseParamValue(defaultMatch[1], ctx)
      continue
    }
    if (filter === 'lower' && typeof value === 'string') value = value.toLowerCase()
  }

  if (value === undefined || typeof value === 'boolean') return typeof value === 'boolean' && value ? 'True' : ''
  return value
}

/** Finds the matching `{% endTAG %}` for the `{% TAG %}` that ended at `from`, skipping nested
 * same-name tags. Returns the index of the end tag's `{%`, or -1. */
function findMatchingEnd(src: string, from: number, openPattern: RegExp, endTag: string): number {
  let depth = 0
  let i = from
  while (i < src.length) {
    const next = src.indexOf('{%', i)
    if (next === -1) return -1
    const close = src.indexOf('%}', next)
    if (close === -1) return -1
    const tag = src.slice(next + 2, close).trim()
    if (openPattern.test(tag)) depth++
    else if (tag === endTag) {
      if (depth === 0) return next
      depth--
    }
    i = close + 2
  }
  return -1
}

/** Renders a blocktranslate body: `{{ name }}` becomes the ctx value or the designer's literal
 * `{name}` placeholder when unbound. The body text is already HTML-escaped at emit time. */
function renderBlocktranslateBody(body: string, ctx: Ctx): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
    const value = ctx.get(name)
    return typeof value === 'string' ? escapeHtml(value) : `{${name}}`
  })
}

/**
 * Renders one template fragment against a context. Sequential scan: text is copied verbatim,
 * `{{ … }}` substitutes (autoescaped), `{% … %}` dispatches per tag.
 */
export function renderFragment(src: string, ctx: Ctx, opts: StaticRenderOptions): string {
  let out = ''
  let i = 0

  while (i < src.length) {
    const nextVar = src.indexOf('{{', i)
    const nextTag = src.indexOf('{%', i)
    const next = nextVar === -1 ? nextTag : nextTag === -1 ? nextVar : Math.min(nextVar, nextTag)
    if (next === -1) {
      out += src.slice(i)
      break
    }
    out += src.slice(i, next)

    if (next === nextVar) {
      const close = src.indexOf('}}', next)
      if (close === -1) {
        out += src.slice(next)
        break
      }
      const expr = src.slice(next + 2, close).trim()
      out += escapeHtml(resolveExpr(expr, ctx, opts))
      i = close + 2
      continue
    }

    const close = src.indexOf('%}', next)
    if (close === -1) {
      out += src.slice(next)
      break
    }
    const tag = src.slice(next + 2, close).trim()
    i = close + 2

    if (tag.startsWith('load ') || tag.startsWith('extends ')) {
      // Dropped entirely; also swallow the newline the tag occupied when it stood on its own line.
      if (src[i] === '\n') i++
      continue
    }

    const staticMatch = tag.match(/^static\s+'([^']*)'$/) ?? tag.match(/^static\s+"([^"]*)"$/)
    if (staticMatch) {
      out += opts.staticHref(staticMatch[1])
      continue
    }

    const translateMatch = tag.match(/^translate\s+"([\s\S]*)"$/)
    if (translateMatch) {
      out += translateMatch[1]
      continue
    }

    if (/^blocktranslate(\s|$)/.test(tag)) {
      const end = findMatchingEnd(src, i, /^blocktranslate(\s|$)/, 'endblocktranslate')
      if (end === -1) continue
      const body = src.slice(i, end)
      // `with a=a b=b` clause: bind outer ctx names for the body's {{ a }} refs.
      const withMatch = tag.match(/^blocktranslate\s+with\s+(.*)$/)
      let blockCtx = ctx
      if (withMatch) {
        const bound = new Map(ctx)
        for (const pair of splitParams(withMatch[1])) {
          const [name, raw] = pair.split('\u0000')
          const value = parseParamValue(raw, ctx)
          if (value !== undefined) bound.set(name, value)
        }
        blockCtx = bound
      }
      out += renderBlocktranslateBody(body, blockCtx)
      i = src.indexOf('%}', end) + 2
      continue
    }

    const ifMatch = tag.match(/^if\s+(\w+)$/)
    if (ifMatch) {
      const end = findMatchingEnd(src, i, /^if\s/, 'endif')
      if (end === -1) continue
      const body = src.slice(i, end)
      if (truthy(ctx.get(ifMatch[1]))) out += renderFragment(body, ctx, opts)
      i = src.indexOf('%}', end) + 2
      continue
    }

    const includeMatch = tag.match(/^include\s+(.+?)(\s+with\s+(.*?))?(\s+only)?$/)
    if (includeMatch) {
      const [, target, , withClause, only] = includeMatch
      out += renderInclude(target, withClause, Boolean(only), ctx, opts)
      continue
    }

    // Unknown tag (shouldn't happen for emitter output) — drop rather than leak template syntax.
  }

  return out
}

function renderInclude(
  target: string,
  withClause: string | undefined,
  only: boolean,
  ctx: Ctx,
  opts: StaticRenderOptions
): string {
  // Target: `"components/x--id.html"` literal, or a var expr (`icon|default:'components/…'`).
  let path: string
  const literal = target.match(/^"([^"]*)"$/) ?? target.match(/^'([^']*)'$/)
  if (literal) {
    path = literal[1]
  } else {
    path = resolveExpr(target, ctx, opts)
    if (!path) return '' // unbound swap var with no default — Django renders nothing
  }

  const source = opts.partials.get(path)
  if (!source) {
    console.warn(`[tauri] include target "${path}" is not among the exported partials — skipped`)
    return ''
  }

  let childCtx: Ctx
  if (withClause) {
    const params = new Map<string, string | boolean>(only ? [] : ctx)
    for (const pair of splitParams(withClause)) {
      const [name, raw] = pair.split('\u0000')
      const value = parseParamValue(raw, ctx)
      if (value !== undefined) params.set(name, value)
    }
    childCtx = params
  } else {
    childCtx = only ? EMPTY_CTX : ctx
  }

  return renderFragment(stripComments(source), childCtx, opts)
}

/** Extracts the page's `{% block content %}…{% endblock %}` body (a page has exactly one block). */
function extractContentBlock(pageSrc: string): string {
  const open = pageSrc.indexOf('{% block content %}')
  if (open === -1) return pageSrc
  const from = open + '{% block content %}'.length
  const end = findMatchingEnd(pageSrc, from, /^block\s/, 'endblock')
  if (end === -1) return pageSrc.slice(from)
  return pageSrc.slice(from, end)
}

/**
 * Renders one exported page (`{% extends "base.html" %}` + content block) against the base
 * skeleton into a complete static HTML document.
 */
export function renderStaticPage(
  baseHtml: string,
  pageHtml: string,
  opts: StaticRenderOptions,
  ctx: Ctx = EMPTY_CTX
): string {
  const base = stripComments(baseHtml)
  const body = extractContentBlock(stripComments(pageHtml))
  const renderedBody = renderFragment(body, ctx, opts)

  // Render the base shell FIRST, with the content slot held by a marker no template text can
  // contain — splicing the already-rendered body in before a second renderFragment pass would
  // re-process any literal braces the designer typed into text content.
  const CONTENT_MARK = '\u0000CONTENT\u0000'
  let shell = base.replace('{% block content %}{% endblock %}', CONTENT_MARK)
  // Unwrap the remaining {% block X %}…{% endblock %} pairs (framework_css/js keep their inner).
  shell = shell.replace(/\{%\s*block\s+\w+\s*%\}/g, '').replace(/\{%\s*endblock\s*%\}/g, '')
  shell = renderFragment(shell, ctx, opts)
  const doc = shell.replace(CONTENT_MARK, () => renderedBody)

  // Collapse the blank lines dropped tags/comments leave behind — cosmetic only.
  return doc.replace(/\n{3,}/g, '\n\n')
}
