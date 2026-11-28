/**
 * Pixels in emitted CSS, rewritten in the unit a developer picked in Dev Mode.
 *
 * Dev Mode offers a scaled unit when the manifest declares one (`codegenPreferences`, "Rem" at
 * 16), and then hands the generate callback `{ unit: 'SCALED', scaleFactor }`. The emitter keeps
 * thinking in pixels — every measurement it reads from Figma is one — and the conversion happens
 * once, here, on the way out, so there is a single place where a rem can be wrong.
 *
 * Everything is converted, hairlines included, because that is what Figma's own CSS does in rem
 * mode; a zero loses its unit, the way CSS writes it.
 */
export function scaleCssUnits(css: string, scaleFactor: number): string {
  if (!(scaleFactor > 0)) return css
  return css.replace(/(^|[^\w.#-])(-?\d*\.?\d+)px\b/g, (_, before: string, amount: string) => {
    const value = Number(amount) / scaleFactor
    if (value === 0) return `${before}0`
    return `${before}${Math.round(value * 10000) / 10000}rem`
  })
}
