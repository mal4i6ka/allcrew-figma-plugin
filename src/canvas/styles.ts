/**
 * Styles — the other half of a design system, and the half a plugin keeps forgetting.
 *
 * A colour can be a variable, and this vocabulary has been able to bind one for a while. A
 * *style* is a different thing: a named bundle of paints, or of type settings, or of effects,
 * that a layer follows whole. Figma's own libraries publish both, and a file like this one is
 * built out of text styles no variable can express — a family, a weight, a size, a line height
 * and a letter spacing that travel together.
 *
 * Everything here is asynchronous, because under `documentAccess: "dynamic-page"` every style
 * getter and setter is: `fillStyleId` is write-only and `setFillStyleIdAsync` is the one that
 * works.
 */

export type StyleKind = 'paint' | 'text' | 'effect' | 'grid'

export const STYLE_KINDS: readonly StyleKind[] = ['paint', 'text', 'effect', 'grid']

/** What Figma calls each kind, for the messages a caller reads. */
const FIGMA_TYPE: Readonly<Record<StyleKind, string>> = {
  paint: 'PAINT',
  text: 'TEXT',
  effect: 'EFFECT',
  grid: 'GRID',
}

export const KIND_OF_TYPE: Readonly<Record<string, StyleKind>> = {
  PAINT: 'paint',
  TEXT: 'text',
  EFFECT: 'effect',
  GRID: 'grid',
}

export async function localStyles(kind: StyleKind): Promise<BaseStyle[]> {
  switch (kind) {
    case 'paint':
      return figma.getLocalPaintStylesAsync()
    case 'text':
      return figma.getLocalTextStylesAsync()
    case 'effect':
      return figma.getLocalEffectStylesAsync()
    default:
      return figma.getLocalGridStylesAsync()
  }
}

/**
 * A style from a name, an id or a published key.
 *
 * The name first, because that is what a person has: styles are named `Body/Regular` and nobody
 * carries their ids around. A name that matches two styles is a question rather than a coin
 * toss — the same rule component properties follow.
 */
export async function styleFor(ref: string, kind: StyleKind): Promise<BaseStyle> {
  const wanted = ref.trim()
  const styles = await localStyles(kind)

  const exact = styles.filter((style) => style.name === wanted)
  const loose = exact.length > 0 ? exact : styles.filter((style) => style.name.toLowerCase() === wanted.toLowerCase())
  if (loose.length === 1) return loose[0]
  if (loose.length > 1) {
    throw new Error(`"${wanted}" matches ${loose.length} ${kind} styles — name one by id`)
  }

  // Not a local name: an id, then a published key, the same two-step components use.
  const byId = await figma.getStyleByIdAsync(wanted).catch(() => null)
  if (byId) {
    if (KIND_OF_TYPE[byId.type] !== kind) throw new Error(`${wanted} is a ${byId.type} style, not ${FIGMA_TYPE[kind]}`)
    return byId
  }
  const imported = await figma.importStyleByKeyAsync(wanted).catch(() => null)
  if (imported) {
    if (KIND_OF_TYPE[imported.type] !== kind) {
      throw new Error(`${wanted} is a ${imported.type} style, not ${FIGMA_TYPE[kind]}`)
    }
    return imported
  }

  const names = styles.slice(0, 12).map((style) => style.name)
  throw new Error(
    `no ${kind} style called "${wanted}"${names.length > 0 ? ` — this file has ${names.join(', ')}` : ' in this file'}`
  )
}

/** What a style holds, on one line — the same shape every other read in this plugin answers with. */
export async function describeStyle(
  style: BaseStyle,
  paints: (value: unknown) => Promise<string | null>,
  effects: (value: unknown) => string
): Promise<string> {
  switch (style.type) {
    case 'PAINT':
      return (await paints((style as PaintStyle).paints)) ?? 'none'
    case 'EFFECT':
      return effects((style as EffectStyle).effects)
    case 'TEXT': {
      const text = style as TextStyle
      const height =
        text.lineHeight.unit === 'AUTO'
          ? 'auto'
          : `${Math.round((text.lineHeight as { value: number }).value * 100) / 100}${text.lineHeight.unit === 'PERCENT' ? '%' : ''}`
      const spacing =
        text.letterSpacing.value === 0
          ? ''
          : ` · tracking ${Math.round(text.letterSpacing.value * 100) / 100}${text.letterSpacing.unit === 'PERCENT' ? '%' : ''}`
      return `${text.fontName.family} ${text.fontName.style} ${text.fontSize}/${height}${spacing}`
    }
    default:
      return `${(style as GridStyle).layoutGrids.length} grid(s)`
  }
}
