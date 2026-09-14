/**
 * Which token a layer's CSS value came from, keyed by the CSS property it lands on.
 *
 * `getCSSAsync` is the plugin's own reader and it answers in values: a fill bound to a variable
 * comes back as `var(--Base-orange-O500---Main, #FB5B0A)` - a name mangled for CSS, with the
 * literal beside it. That string is fine for a stylesheet and useless as a token: the mangling is
 * lossy (`/` and spaces both become `-`), so the variable it names cannot be looked back up.
 *
 * The binding itself is on the node. `boundVariables` gives the variable id per Figma FIELD, and
 * the table below is the same field→property mapping the CSS emitter applies when it writes those
 * `var(...)` declarations (`tokenOverrides`), read in the other direction - so a diff can say
 * `Base/orange/O400` instead of handing a consumer a CSS string to parse.
 */

/** Figma's bindable field → the CSS property `getCSSAsync` reports it under. One field can land on
 * two properties (a fill is `background` on a box and `color` on text), and both are listed: a
 * layer only ever has one of them in its declarations. */
const PROPERTY_BY_FIELD: Readonly<Record<string, readonly string[]>> = {
  fills: ['background', 'background-color', 'color'],
  strokes: ['border-color'],
  effects: ['box-shadow'],
  strokeWeight: ['border-width'],
  strokeTopWeight: ['border-top-width'],
  strokeRightWeight: ['border-right-width'],
  strokeBottomWeight: ['border-bottom-width'],
  strokeLeftWeight: ['border-left-width'],
  topLeftRadius: ['border-radius', 'border-top-left-radius'],
  topRightRadius: ['border-top-right-radius'],
  bottomLeftRadius: ['border-bottom-left-radius'],
  bottomRightRadius: ['border-bottom-right-radius'],
  itemSpacing: ['gap', 'row-gap', 'column-gap'],
  counterAxisSpacing: ['row-gap'],
  paddingTop: ['padding-top'],
  paddingRight: ['padding-right'],
  paddingBottom: ['padding-bottom'],
  paddingLeft: ['padding-left'],
  width: ['width'],
  minWidth: ['min-width'],
  maxWidth: ['max-width'],
  height: ['height'],
  minHeight: ['min-height'],
  maxHeight: ['max-height'],
  opacity: ['opacity'],
  fontSize: ['font-size'],
  fontWeight: ['font-weight'],
  fontFamily: ['font-family'],
  fontStyle: ['font-style'],
  lineHeight: ['line-height'],
  letterSpacing: ['letter-spacing'],
  paragraphSpacing: ['margin-bottom'],
}

/** A `VariableAlias`, or the array of them a multi-paint field carries. */
type Binding = { readonly id?: unknown } | ReadonlyArray<{ readonly id?: unknown }>

function firstId(binding: Binding | undefined): string | null {
  if (!binding) return null
  const entry = Array.isArray(binding) ? binding[0] : binding
  const id = (entry as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** Reads the node this shape describes - a real `SceneNode` satisfies it, and so does a fixture. */
export interface BoundNode {
  readonly boundVariables?: Record<string, unknown> | null
}

/**
 * Token name per CSS property for one node. `resolve` turns a variable id into its name - the op
 * layer passes `figma.variables.getVariableByIdAsync`, a test passes a map - and a name that will
 * not resolve is left out rather than reported as its own id.
 *
 * Only the fields the node actually binds are looked up, so this is a handful of calls on a layer
 * that binds anything and none at all on the rest.
 */
export async function boundTokensByCssProperty(
  node: BoundNode,
  resolve: (id: string) => Promise<string | null>
): Promise<Record<string, string>> {
  const bound = node.boundVariables
  if (!bound) return {}
  const out: Record<string, string> = {}
  for (const [field, properties] of Object.entries(PROPERTY_BY_FIELD)) {
    const id = firstId(bound[field] as Binding | undefined)
    if (!id) continue
    const name = await resolve(id)
    if (!name) continue
    for (const property of properties) {
      // First binding wins per property: `fills` lands on `background` for a box and `color` for
      // text, and a node is one or the other - but `topLeftRadius` claims `border-radius` only
      // while nothing more specific has.
      if (!(property in out)) out[property] = name
    }
  }
  return out
}

/** A cache around `figma.variables.getVariableByIdAsync` - one diff pass asks about the same few
 * tokens on every layer it walks, and a variable read is a network-backed call for a library one.
 * Misses are remembered too: a deleted variable should cost one failed lookup, not one per layer. */
export function variableNameResolver(): (id: string) => Promise<string | null> {
  const cache = new Map<string, string | null>()
  return async (id: string) => {
    const hit = cache.get(id)
    if (hit !== undefined) return hit
    let name: string | null = null
    try {
      name = (await figma.variables.getVariableByIdAsync(id))?.name ?? null
    } catch {
      name = null
    }
    cache.set(id, name)
    return name
  }
}
