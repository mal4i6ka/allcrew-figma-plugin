/**
 * i18n annotation panel (T4.2): renders and parses the context/plural/placeholder form the
 * manual-annotation UI needs, and applies edits through `annotation.ts`'s
 * `getAnnotation`/`setAnnotation`. Framework-agnostic — emits a plain HTML string so the plugin
 * UI iframe (T6.1's "UI плагина" epic, see `src/lib/tasks/t6-1-ui.md`) can inject it, and reads
 * form state back as plain data so this stays unit-testable without a DOM.
 * See docs/research/03-i18n-figma-django.md §1.4-1.5, §3.1-3.2.
 */

import {
  getAnnotation,
  setAnnotation,
  type I18nAnnotation,
  type PlaceholderAnnotation,
} from '../i18n/annotation.ts'

export interface AnnotationFormState {
  context: string
  pluralEnabled: boolean
  pluralOne: string
  pluralOther: string
  placeholders: PlaceholderAnnotation[]
}

const EMPTY_FORM: AnnotationFormState = {
  context: '',
  pluralEnabled: false,
  pluralOne: '',
  pluralOther: '',
  placeholders: [],
}

/** Reads a node's stored annotation into the panel's editable form shape. */
export function loadAnnotationForm(node: BaseNode): AnnotationFormState {
  const annotation = getAnnotation(node)
  if (!annotation) return { ...EMPTY_FORM, placeholders: [] }

  return {
    context: annotation.context ?? '',
    pluralEnabled: annotation.plural != null,
    pluralOne: annotation.plural?.one ?? '',
    pluralOther: annotation.plural?.other ?? '',
    placeholders: annotation.placeholders ? annotation.placeholders.map((p) => ({ ...p })) : [],
  }
}

/** Converts the panel's form state back into a storable `I18nAnnotation`, dropping unset fields. */
export function formToAnnotation(form: AnnotationFormState): I18nAnnotation {
  const annotation: I18nAnnotation = {}
  if (form.context) annotation.context = form.context
  if (form.pluralEnabled) annotation.plural = { one: form.pluralOne, other: form.pluralOther }
  if (form.placeholders.length > 0) annotation.placeholders = form.placeholders.map((p) => ({ ...p }))
  return annotation
}

/**
 * Validates and writes the panel's form state onto `node`. Throws on invalid plural/placeholder
 * input (`annotation.ts`'s `validateAnnotation`) so the panel can surface it as a form error
 * instead of silently storing bad data.
 */
export function applyAnnotationForm(node: TextNode, form: AnnotationFormState): void {
  setAnnotation(node, formToAnnotation(form))
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export interface AnnotationPanelViewModel {
  /**
   * Set when the node's key comes from a bound STRING variable (docs §1.4). `keys.ts`'s
   * `resolveKey` always prefers that over a manual annotation, so the panel renders read-only
   * instead of editable fields that would silently have no effect.
   */
  boundVariableName?: string
}

/**
 * Renders the annotation panel's HTML: a context input, a plural toggle with one/other fields,
 * and an editable placeholder-range list — the three DoD fields for T4.2's UI panel.
 */
export function renderAnnotationPanel(form: AnnotationFormState, viewModel: AnnotationPanelViewModel = {}): string {
  if (viewModel.boundVariableName) {
    return [
      '<section id="i18n-annotation-panel" data-governed-by-variable="true">',
      `  <p class="i18n-annotation-panel__notice">Key comes from bound variable "${escapeHtml(
        viewModel.boundVariableName
      )}" — manual annotations are ignored.</p>`,
      '</section>',
    ].join('\n')
  }

  const placeholderRows = form.placeholders
    .map(
      (p, i) => `    <li class="i18n-placeholder-row" data-index="${i}">
      <input type="number" class="i18n-placeholder-start" value="${p.start}" />
      <input type="number" class="i18n-placeholder-end" value="${p.end}" />
      <input type="text" class="i18n-placeholder-name" value="${escapeHtml(p.name)}" />
      <button type="button" class="i18n-remove-placeholder" data-index="${i}">Remove</button>
    </li>`
    )
    .join('\n')

  return [
    '<section id="i18n-annotation-panel">',
    '  <label class="i18n-field">Context (msgctxt)',
    `    <input type="text" id="i18n-context" value="${escapeHtml(form.context)}" />`,
    '  </label>',
    '  <label class="i18n-field">',
    `    <input type="checkbox" id="i18n-plural-enabled"${form.pluralEnabled ? ' checked' : ''} />`,
    '    Has plural forms',
    '  </label>',
    '  <label class="i18n-field">One',
    `    <input type="text" id="i18n-plural-one" value="${escapeHtml(form.pluralOne)}" />`,
    '  </label>',
    '  <label class="i18n-field">Other',
    `    <input type="text" id="i18n-plural-other" value="${escapeHtml(form.pluralOther)}" />`,
    '  </label>',
    '  <ul id="i18n-placeholders">',
    placeholderRows,
    '  </ul>',
    '  <button id="i18n-add-placeholder" type="button">Add placeholder</button>',
    '</section>',
  ].join('\n')
}
