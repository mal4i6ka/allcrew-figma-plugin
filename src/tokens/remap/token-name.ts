/**
 * Reading structure out of a color token's name.
 *
 * Both sides of a remap arrive as names before they arrive as anything else: the open file
 * has `colors/Orange/O500`, the designer's paste has `violet-500`. Whatever family and step
 * can be read off a name is worth more than anything inferred from the color itself — it is
 * what the author meant, not what the math guesses — so this runs before hue clustering and
 * its answers win.
 *
 * Pure module: no Figma APIs, so it runs under `node --test`.
 */

export interface TokenName {
  /** Slash-separated segments, e.g. `['colors', 'Orange', 'O500']`. */
  path: string[]
  /** Last segment, e.g. `O500`. */
  leaf: string
  /** The segment above the leaf — the natural group in Figma's variable tree. */
  group: string | null
  /** Ramp family this name claims to belong to, or null when the name shows no family. */
  family: string | null
  /** Ramp position this name claims, or null when the name carries no step. */
  step: number | null
}

/** `O500` / `500` / `violet-500` / `gray_50` — a letter prefix and a numeric tail. */
const STEP_RE = /^([A-Za-z][A-Za-z\s-]*?)?[\s._-]*(\d{1,4})$/

const SEGMENT_RE = /[/.]+/

const clean = (segment: string): string => segment.trim()

export function parseTokenName(name: string): TokenName {
  const path = String(name ?? '')
    .split(SEGMENT_RE)
    .map(clean)
    .filter((segment) => segment !== '')
  const leaf = path.length > 0 ? path[path.length - 1] : ''
  const group = path.length > 1 ? path[path.length - 2] : null

  const match = STEP_RE.exec(leaf)
  if (!match) return { path, leaf, group, family: group, step: null }

  const prefix = (match[1] ?? '').replace(/[\s_-]+$/, '').trim()
  // A group beats a prefix: `Orange/O500` is the Orange ramp, not the "O" ramp.
  const family = group ?? (prefix !== '' ? prefix : null)
  return { path, leaf, group, family, step: Number(match[2]) }
}

/** Same family, compared the way designers mean it — case and separators are noise. */
export const familyKey = (family: string): string =>
  family
    .toLowerCase()
    .replace(/[\s._-]+/g, '')
    .trim()

/**
 * Rebuilds a name with its family segment replaced, preserving everything around it.
 *
 * `colors/Orange/O500` renamed to the Violet family becomes `colors/Violet/V500`: the
 * collection prefix survives, the group is swapped, and a leaf whose letters were an
 * abbreviation of the old family gets the new family's abbreviation. A leaf that is a bare
 * number (`Violet/500`) has nothing to rewrite and is left alone.
 */
export function renameFamily(name: string, newFamily: string, newStep?: number): string {
  const parsed = parseTokenName(name)
  if (parsed.path.length === 0) return name

  const path = [...parsed.path]
  const leafIndex = path.length - 1
  const step = newStep ?? parsed.step

  if (parsed.group !== null) path[leafIndex - 1] = newFamily

  const match = STEP_RE.exec(parsed.leaf)
  if (match) {
    const prefix = (match[1] ?? '').replace(/[\s_-]+$/, '').trim()
    const separator = /[\s._-]/.exec(parsed.leaf.slice(prefix.length))?.[0] ?? ''
    const newPrefix = prefix === '' ? '' : abbreviate(prefix, newFamily)
    path[leafIndex] = `${newPrefix}${separator}${step ?? match[2]}`
  }

  return path.join('/')
}

/**
 * The new family written the way the old prefix was written: `O` → `V`, `Or` → `Vi`,
 * `orange` → `violet`. Keeps a file's own abbreviation convention rather than imposing one.
 */
function abbreviate(oldPrefix: string, newFamily: string): string {
  const compact = newFamily.replace(/[\s._-]+/g, '')
  if (oldPrefix.length >= compact.length) return matchCase(oldPrefix, compact)
  return matchCase(oldPrefix, compact.slice(0, oldPrefix.length))
}

function matchCase(sample: string, text: string): string {
  if (sample === sample.toUpperCase()) return text.toUpperCase()
  if (sample === sample.toLowerCase()) return text.toLowerCase()
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
}
