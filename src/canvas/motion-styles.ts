export interface MotionStyleTarget {
  type: 'FIGMA' | 'CUSTOM'
  id: string
  name: string
}

/**
 * Resolves either a Figma-provided animation style or a local custom animation style.
 * IDs win over names; an ambiguous name is refused rather than applied unpredictably.
 */
export function resolveMotionStyleTarget(
  reference: string,
  figmaStyles: readonly AvailableAnimationStyle[],
  customStyles: readonly CustomAnimationStyle[]
): MotionStyleTarget {
  const wanted = reference.trim()
  const byId: MotionStyleTarget[] = [
    ...figmaStyles
      .filter((style) => style.styleId === wanted)
      .map((style) => ({ type: 'FIGMA' as const, id: style.styleId, name: style.name })),
    ...customStyles
      .filter((style) => style.id === wanted)
      .map((style) => ({ type: 'CUSTOM' as const, id: style.id, name: style.name })),
  ]
  if (byId.length === 1) return byId[0]

  const byName: MotionStyleTarget[] = [
    ...figmaStyles
      .filter((style) => style.name === wanted)
      .map((style) => ({ type: 'FIGMA' as const, id: style.styleId, name: style.name })),
    ...customStyles
      .filter((style) => style.name === wanted)
      .map((style) => ({ type: 'CUSTOM' as const, id: style.id, name: style.name })),
  ]
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new Error(`animation style name "${wanted}" is ambiguous — use one of these ids: ${byName.map((style) => style.id).join(', ')}`)
  }

  const available = [
    ...figmaStyles.map((style) => `${style.name} (${style.styleId})`),
    ...customStyles.map((style) => `${style.name} (${style.id}, custom)`),
  ]
  throw new Error(`no animation style called "${wanted}" — Figma has ${available.join(', ') || 'none'}`)
}

/** Custom animation styles may contain only Figma-provided animation entries. */
export function resolveFigmaAnimationStyle(
  reference: string,
  figmaStyles: readonly AvailableAnimationStyle[]
): AvailableAnimationStyle {
  const wanted = reference.trim()
  const byId = figmaStyles.filter((style) => style.styleId === wanted)
  if (byId.length === 1) return byId[0]
  const byName = figmaStyles.filter((style) => style.name === wanted)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new Error(`Figma animation name "${wanted}" is ambiguous — use one of these styleIds: ${byName.map((style) => style.styleId).join(', ')}`)
  }
  throw new Error(
    `no Figma animation called "${wanted}" — available: ${figmaStyles.map((style) => `${style.name} (${style.styleId})`).join(', ') || 'none'}`
  )
}

export interface CustomAnimationEntrySpec {
  styleId: string
  props: Readonly<Record<string, AnimationStylePropValue>>
}

/**
 * Replaces a custom style's ordered entries and restores the old list if any add fails.
 * Figma exposes entry mutation one call at a time, so rollback is the atomicity boundary.
 */
export async function replaceCustomAnimationEntries(
  style: CustomAnimationStyle,
  wanted: readonly CustomAnimationEntrySpec[]
): Promise<void> {
  const previous = style.animationEntries.map((entry: AnimationEntry) => ({
    styleId: entry.styleId,
    props: entry.props ?? {},
  }))
  const write = async (entries: readonly CustomAnimationEntrySpec[]) => {
    for (const entry of [...style.animationEntries]) style.removeAnimationEntry(entry.id)
    for (const entry of entries) await style.addAnimationEntryAsync(entry.styleId, entry.props)
  }

  try {
    await write(wanted)
  } catch (error) {
    try {
      await write(previous)
    } catch (rollbackError) {
      throw new Error(
        `${String((error as Error)?.message || error)}; rollback also failed: ${String(
          (rollbackError as Error)?.message || rollbackError
        )}`
      )
    }
    throw error
  }
}
