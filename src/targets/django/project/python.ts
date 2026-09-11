/**
 * Small string-literal helpers shared by every generator in this directory: Python source here is
 * built by joining plain strings (there is no template engine on this side of the export), so each
 * generator needs the same quoting/escaping discipline `i18n/po.ts`'s `escapePoString` applies for
 * PO strings, just aimed at a Python single-quoted literal instead of a PO one.
 */

/** Renders `value` as a single-quoted Python string literal, escaping the characters that would
 * otherwise break out of the quote or corrupt a single-line statement. */
export function pyStr(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
  return `'${escaped}'`
}

/** `my-app_name` -> `MyAppName`, for the `AppConfig` class name built from a configurable
 * `appName` (Django's `startapp` convention is `<Name>Config`). */
export function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}
