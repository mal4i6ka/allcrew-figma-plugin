/**
 * A node's own pixels, with every descendant hidden.
 *
 * Figma's `exportAsync` has no "skip children" switch, so a card thumbnail whose only child is
 * an overlay — a "10 min" reading-time chip, a rating badge — always bakes that overlay into the
 * exported pixels: the render is of the whole subtree, not of the node's own paint. The fix is a
 * throwaway clone: parked on the node's own page (never reinserted next to the original — an
 * auto-layout parent would reflow around a sibling that is about to be deleted again a moment
 * later), every descendant hidden, exported, then deleted whether the export succeeded or not.
 *
 * Shared by the agent listener's `image.plate` op (context-ops.ts) and `NODE_EXPORT`'s
 * `withoutChildren` flag (code.ts) — one clone/hide/delete implementation, not two.
 */

export interface PlateSettings {
  format: 'PNG' | 'JPG'
  constraint: ExportSettingsConstraints
}

function hasChildren(node: SceneNode): node is SceneNode & ChildrenMixin {
  return 'children' in node
}

function pageOf(node: SceneNode): PageNode | null {
  let parent: BaseNode | null = node.parent
  while (parent && parent.type !== 'PAGE') parent = parent.parent
  // The walk only ever stops on a PAGE or null; BaseNode carries no discriminated link to
  // PageNode's own members for TypeScript to narrow through a manual ancestor walk like this.
  const page = parent as PageNode | null
  return page
}

function hideDescendants(node: SceneNode): void {
  if (!hasChildren(node)) return
  for (const child of node.children) {
    child.visible = false
    hideDescendants(child)
  }
}

/**
 * Renders `node` to bytes with every descendant hidden. Throws if `node` is not on a page —
 * `clone()` itself is universal across every `SceneNode` type, but there has to be somewhere to
 * park the clone that is not back inside the original's own parent. The clone is always removed
 * before this returns, on the success path and on the throw path alike.
 */
export async function exportPlate(node: SceneNode, settings: PlateSettings): Promise<Uint8Array> {
  const page = pageOf(node)
  if (!page) throw new Error(`"${node.name}" is not on a page — nothing to clone onto`)

  // Seals off whatever the designer had pending into its own undo step, so the clone/hide/
  // delete below — net zero on the document once this returns — lands as its own group instead
  // of merging with unrelated edits made just before this call.
  figma.commitUndo()

  const clone = node.clone()
  try {
    // Never reinsert next to the original: appendChild-ing back into its own parent would
    // insert a live sibling and, inside an auto-layout frame, force a reflow around a node
    // that is deleted again a few lines down. The page has no layout of its own, so parking
    // the clone there for its one-tick lifetime disturbs nothing else in the document.
    page.appendChild(clone)
    // appendChild does not preserve absolute position — restore it from the original's own
    // absolute transform (the page is the clone's new parent, so the translation component is
    // exactly the local position it now needs). Cosmetic only — exportAsync renders the
    // clone's own pixels, not where it sits on the canvas — but it costs nothing and leaves
    // less of a trace while the clone briefly exists.
    const transform = node.absoluteTransform
    clone.x = transform[0][2]
    clone.y = transform[1][2]
    hideDescendants(clone)
    return await clone.exportAsync({ format: settings.format, constraint: settings.constraint })
  } finally {
    if (!clone.removed) clone.remove()
  }
}
