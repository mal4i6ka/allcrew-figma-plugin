/**
 * What a designer changed INSIDE an instance.
 *
 * An instance is rebuilt from its component and its component properties, and that is most of it —
 * but not the half that makes a screen look like itself. The hidden second line, the retyped
 * label, the row set to hug: Figma calls these overrides, keeps them per node, and the channel
 * had no word for them. A copy came back with every row at its default height, which is exactly
 * the failure the export is meant to avoid — ninety per cent right and the missing tenth invisible.
 *
 * Figma says WHICH nodes carry overrides and WHICH fields on each (`instance.overrides`), so
 * nothing here diffs against the main component: only the named fields are read, and only the
 * ones the write vocabulary has a word for. The rest is reported by name rather than guessed at.
 *
 * The address is the part of the child's id after the instance's own — `I<instance>;<at>` — which
 * is stable across instances of the same component. That is what makes an override written on one
 * instance applicable to a copy: same component, same path, same node.
 */

/** Figma's field names → the words this vocabulary uses for the same thing. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  characters: 'text',
  visible: 'visible',
  locked: 'locked',
  name: 'name',
  opacity: 'opacity',
  fills: 'fill',
  strokes: 'stroke',
  strokeWeight: 'strokeWeight',
  cornerRadius: 'cornerRadius',
  effects: 'effects',
  fontName: 'fontName',
  fontSize: 'fontSize',
  letterSpacing: 'letterSpacing',
  lineHeight: 'lineHeight',
  textCase: 'textCase',
  textDecoration: 'textDecoration',
  textAlignHorizontal: 'textAlign',
  textAlignVertical: 'verticalAlign',
  textAutoResize: 'autoResize',
  textTruncation: 'truncate',
  maxLines: 'maxLines',
  paragraphSpacing: 'paragraphSpacing',
  paragraphIndent: 'paragraphIndent',
  width: 'width',
  height: 'height',
  layoutSizingHorizontal: 'sizing',
  layoutSizingVertical: 'sizing',
  itemSpacing: 'layout',
  paddingLeft: 'layout',
  paddingRight: 'layout',
  paddingTop: 'layout',
  paddingBottom: 'layout',
  layoutMode: 'layout',
  primaryAxisAlignItems: 'layout',
  counterAxisAlignItems: 'layout',
  componentProperties: 'properties',
  fillStyleId: 'fillStyle',
  strokeStyleId: 'strokeStyle',
  textStyleId: 'textStyle',
  effectStyleId: 'effectStyle',
  gridStyleId: 'gridStyle',
  styledTextSegments: 'runs',
  boundVariables: 'bind',
  rotation: 'rotation',
  blendMode: 'blendMode',
  constraints: 'constraints',
  reactions: 'links',
}

/** What "the designer took this off" looks like on the way in, for the fields where it can. */
const CLEARED: Readonly<Record<string, unknown>> = {
  fill: 'none',
  stroke: 'none',
  effects: [],
  link: null,
  maxLines: null,
  runs: [],
}

export interface Override {
  /** The child's id within the instance — everything after `I<instance>;`. */
  at: string
  props: Record<string, unknown>
  /** Fields Figma reported as overridden that this vocabulary has no word for. */
  unread?: string[]
}

/**
 * The overrides of one instance, in the shape `overrides` takes on the way in.
 *
 * @param describe reads a node the way `NODE_QUERY props: true` does — passed in rather than
 *                 imported, because the describer lives with the command and knowing about it
 *                 here would tie the two together for no gain.
 */
export async function readOverrides(
  instance: InstanceNode,
  describe: (node: SceneNode) => Promise<Record<string, unknown>>
): Promise<Override[]> {
  const own = instance.id
  const prefix = own.startsWith('I') ? `${own};` : `I${own};`
  const out: Override[] = []

  for (const entry of instance.overrides) {
    // The instance's own overrides are its component properties, which travel as `properties`.
    if (entry.id === own || !entry.id.startsWith(prefix)) continue
    const node = await figma.getNodeByIdAsync(entry.id).catch(() => null)
    if (!node || !('type' in node)) continue

    const reading = await describe(node as SceneNode)
    const wanted = new Set<string>()
    const unread: string[] = []
    for (const field of entry.overriddenFields) {
      const word = FIELD_WORDS[field as string]
      if (word) wanted.add(word)
      else unread.push(field as string)
    }

    const props: Record<string, unknown> = {}
    for (const word of wanted) {
      if (reading[word] !== undefined) props[word] = reading[word]
      // An override can be the REMOVAL of something, and a reading does not print what is not
      // there: a row whose divider the designer took off read as no `stroke` at all, so the
      // override was dropped and the copy came back wearing the component's line again.
      else if (word in CLEARED) props[word] = CLEARED[word]
    }
    // Figma sometimes names a field whose value matches the component again; an override that
    // says nothing is not worth sending.
    if (Object.keys(props).length === 0 && unread.length === 0) continue

    out.push({
      at: entry.id.slice(prefix.length),
      props,
      ...(unread.length > 0 ? { unread } : {}),
    })
  }
  return out
}

/** The id of the node an override addresses, inside a given instance. */
export function addressIn(instance: SceneNode, at: string): string {
  const own = instance.id
  return own.startsWith('I') ? `${own};${at}` : `I${own};${at}`
}
