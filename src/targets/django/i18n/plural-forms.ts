/**
 * Gettext `Plural-Forms` handling shared by the PO emitter (`po.ts`, catalog headers) and the PO
 * importer (`import.ts`, choosing which `msgstr[n]` to apply for a single-string round-trip).
 * The evaluator is hand-rolled rather than `Function`/`eval` because it runs against untrusted
 * `.po` content a translator hands back to the plugin — only the small arithmetic/boolean/
 * ternary grammar gettext's own `Plural-Forms` strings use is supported, nothing else parses.
 */

export interface PluralForms {
  readonly nplurals: number
  readonly expression: string
}

const FALLBACK_PLURAL_FORMS: PluralForms = { nplurals: 2, expression: '(n != 1)' }

const RUSSIAN_UKRAINIAN_FORMS: PluralForms = {
  nplurals: 3,
  expression: '(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2)',
}

/** GNU gettext's canonical `Plural-Forms` reference table, restricted to the languages this
 * export pipeline is asked to support explicitly; anything else falls back to the English-shaped
 * two-form rule, which is wrong for e.g. Arabic or Polish but never throws or under-counts. */
const PLURAL_FORMS_TABLE: Readonly<Record<string, PluralForms>> = {
  ar: {
    nplurals: 6,
    expression: '(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5)',
  },
  de: FALLBACK_PLURAL_FORMS,
  en: FALLBACK_PLURAL_FORMS,
  es: FALLBACK_PLURAL_FORMS,
  fr: { nplurals: 2, expression: '(n > 1)' },
  ja: { nplurals: 1, expression: '0' },
  pl: { nplurals: 3, expression: '(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2)' },
  ru: RUSSIAN_UKRAINIAN_FORMS,
  tr: { nplurals: 2, expression: '(n > 1)' },
  uk: RUSSIAN_UKRAINIAN_FORMS,
  zh: { nplurals: 1, expression: '0' },
}

export function pluralFormsFor(language: string): PluralForms {
  const base = language.trim().toLowerCase().split(/[-_]/)[0]
  return PLURAL_FORMS_TABLE[base] ?? FALLBACK_PLURAL_FORMS
}

export function pluralFormsHeaderLine(forms: PluralForms): string {
  return `Plural-Forms: nplurals=${forms.nplurals}; plural=${forms.expression};`
}

const PLURAL_FORMS_HEADER = /Plural-Forms:\s*nplurals\s*=\s*(\d+)\s*;\s*plural\s*=\s*(.*?);?\s*(?:\n|$)/

/** Parses a `Plural-Forms:` line out of an already-unescaped PO header record's `msgstr` body
 * (T4.4's `parsePoBlock` hands this the joined, real-newline header text, not raw PO source). */
export function parsePluralFormsHeader(headerBody: string): PluralForms | null {
  const match = headerBody.match(PLURAL_FORMS_HEADER)
  if (!match) return null
  return { nplurals: Number(match[1]), expression: match[2].trim() }
}

const PLURAL_EXPRESSION_TOKEN = /\d+|n\b|&&|\|\||==|!=|<=|>=|[<>%+\-*/?:()!]/g

/** Recursive-descent evaluator over gettext's `Plural-Forms` grammar (ternary, `||`/`&&`,
 * equality, relational, `%`/`*`//`, unary `!`/`-`, parens, the `n` variable, integer literals) —
 * exactly the operator set the GNU gettext manual's plural-forms examples use, evaluated against
 * one fixed `n`. */
class PluralExpression {
  private position = 0
  constructor(
    private readonly tokens: readonly string[],
    private readonly n: number
  ) {}

  evaluate(): number {
    return this.ternary()
  }

  private ternary(): number {
    const condition = this.logicalOr()
    if (this.tokens[this.position] !== '?') return condition
    this.position++
    const whenTrue = this.ternary()
    if (this.tokens[this.position] === ':') this.position++
    const whenFalse = this.ternary()
    return condition !== 0 ? whenTrue : whenFalse
  }

  private logicalOr(): number {
    let value = this.logicalAnd()
    while (this.tokens[this.position] === '||') {
      this.position++
      value = value !== 0 || this.logicalAnd() !== 0 ? 1 : 0
    }
    return value
  }

  private logicalAnd(): number {
    let value = this.equality()
    while (this.tokens[this.position] === '&&') {
      this.position++
      value = value !== 0 && this.equality() !== 0 ? 1 : 0
    }
    return value
  }

  private equality(): number {
    let value = this.relational()
    for (;;) {
      const op = this.tokens[this.position]
      if (op !== '==' && op !== '!=') return value
      this.position++
      const rhs = this.relational()
      value = op === '==' ? (value === rhs ? 1 : 0) : value !== rhs ? 1 : 0
    }
  }

  private relational(): number {
    let value = this.additive()
    for (;;) {
      const op = this.tokens[this.position]
      if (op !== '<' && op !== '<=' && op !== '>' && op !== '>=') return value
      this.position++
      const rhs = this.additive()
      if (op === '<') value = value < rhs ? 1 : 0
      else if (op === '<=') value = value <= rhs ? 1 : 0
      else if (op === '>') value = value > rhs ? 1 : 0
      else value = value >= rhs ? 1 : 0
    }
  }

  private additive(): number {
    let value = this.multiplicative()
    for (;;) {
      const op = this.tokens[this.position]
      if (op !== '+' && op !== '-') return value
      this.position++
      const rhs = this.multiplicative()
      value = op === '+' ? value + rhs : value - rhs
    }
  }

  private multiplicative(): number {
    let value = this.unary()
    for (;;) {
      const op = this.tokens[this.position]
      if (op !== '%' && op !== '*' && op !== '/') return value
      this.position++
      const rhs = this.unary()
      value = op === '%' ? value % rhs : op === '*' ? value * rhs : Math.trunc(value / rhs)
    }
  }

  private unary(): number {
    if (this.tokens[this.position] === '!') {
      this.position++
      return this.unary() === 0 ? 1 : 0
    }
    if (this.tokens[this.position] === '-') {
      this.position++
      return -this.unary()
    }
    return this.primary()
  }

  private primary(): number {
    const token = this.tokens[this.position++]
    if (token === '(') {
      const value = this.ternary()
      if (this.tokens[this.position] === ')') this.position++
      return value
    }
    if (token === 'n') return this.n
    return Number(token)
  }
}

/** Evaluates a gettext `plural=` expression for one `n`, returning the `msgstr[n]` index to use.
 * `import.ts` calls this with `n = 1` to pick a single string out of a multi-form translation for
 * the identity round-trip a Figma TEXT node's `characters` requires (see that module's doc
 * comment for the accepted limitation this implies for counts other than 1). */
export function evaluatePluralIndex(expression: string, n: number): number {
  const tokens = expression.match(PLURAL_EXPRESSION_TOKEN) ?? []
  if (tokens.length === 0) return 0
  return Math.trunc(new PluralExpression(tokens, n).evaluate())
}
