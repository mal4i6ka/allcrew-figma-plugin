/**
 * A vector's own artwork, out of the 3D wrapper Figma's SVG export puts it in.
 *
 * Since 3D transforms (@figma/plugin-typings 1.143.0, beta) `exportAsync({ format: 'SVG_STRING' })`
 * on a layer with a 3D transform no longer answers with the artwork. It answers with an `<svg>`
 * the size of the TRANSFORMED bounding box, holding one `<foreignObject data-figma-3d="true">`,
 * holding HTML that applies the layer's whole transform — its 2D matrix and its 3D functions — to
 * the real artwork `<svg>` nested inside (read live, 19.11.2026).
 *
 * The stylesheet already carries that transform on the element (`transform3d.ts`), so shipping the
 * wrapper applies it twice, in a box of the wrong size. The wrapper also cannot be the one that
 * stays: HTML inside a `foreignObject` does not take part in the parent's `perspective`, so a
 * scene's depth would be lost exactly where it is used. So the artwork is taken back out and the
 * element is transformed by CSS like every other layer.
 *
 * Anything that does not look exactly like that wrapper is handed back untouched — a format this
 * new is not one to guess at.
 */

const MARKER = 'data-figma-3d="true"'

export function unwrapFigma3dSvg(svg: string): string {
  if (!svg.includes(MARKER)) return svg

  const wrapperOpen = /^\s*<svg\b[^>]*>\s*/.exec(svg)
  const objectStart = svg.indexOf('<foreignObject')
  const objectEnd = svg.lastIndexOf('</foreignObject>')
  if (!wrapperOpen || objectStart === -1 || objectEnd === -1) return svg
  // One wrapper around one object and nothing beside it: no defs, no second object.
  if (svg.slice(wrapperOpen[0].length, objectStart).trim() !== '') return svg
  if (svg.indexOf('<foreignObject', objectStart + 1) !== -1) return svg
  if (!/^<\/foreignObject>\s*<\/svg>\s*$/.test(svg.slice(objectEnd))) return svg

  const inside = svg.slice(objectStart, objectEnd)
  const innerStart = inside.indexOf('<svg')
  const innerEnd = inside.lastIndexOf('</svg>')
  if (innerStart === -1 || innerEnd === -1) return svg
  // Between the artwork and the end of the object there is only the two wrapping `div`s.
  if (!/^(\s*<\/div>)+\s*$/.test(inside.slice(innerEnd + '</svg>'.length))) return svg

  const inner = inside.slice(innerStart, innerEnd + '</svg>'.length)
  const open = /^<svg\b([^>]*)>/.exec(inner)
  const width = open && /\bwidth="([\d.]+)"/.exec(open[1])?.[1]
  const height = open && /\bheight="([\d.]+)"/.exec(open[1])?.[1]
  if (!open || !width || !height) return svg

  // The opening tag Figma writes for a plain vector export, at the artwork's own size.
  const body = inner.slice(open[0].length)
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">${body}\n`
}
