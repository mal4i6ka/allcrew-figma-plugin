/**
 * The fonts a text layer needs loaded before its characters can be written.
 *
 * `getRangeAllFontNames(start, end)` throws when `start === end` — "Empty range selected. 'end'
 * must be greater than 'start'" — which is every call on an empty layer (documented since
 * @figma/plugin-typings 1.143.0, and seen live; widening the range to `(0, 1)` throws as well,
 * for being outside the characters). An empty layer still has a font: the one its first typed
 * character will take, in `fontName`. That is the font to load, and it is never mixed there — but
 * a mixed value (a symbol, not an object) is answered with nothing rather than passed on.
 */
export interface TextFontSource {
  readonly characters: string
  readonly fontName: unknown
  getRangeAllFontNames(start: number, end: number): FontName[]
}

export function fontsToLoad(text: TextFontSource): FontName[] {
  if (text.characters.length > 0) return text.getRangeAllFontNames(0, text.characters.length)
  const own = text.fontName
  return typeof own === 'object' && own !== null ? [own as FontName] : []
}
