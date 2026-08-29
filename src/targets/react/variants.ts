/**
 * One component, several variants, one file.
 *
 * A component's markup came from the first instance a screen happened to hold, and every other
 * variant was drawn with that one's stylesheet. A secondary button rendered in the primary's
 * colours, silently — the worst kind of wrong, because the screen still looks like a screen.
 *
 * The fix rests on two facts. Variants of one component almost always share a STRUCTURE and
 * differ in style: same layers, same order, different fill. And the CSS emitter names every rule
 * after the node it came from, deterministically. So the second variant's rules can be renamed
 * onto the first variant's layers — position by position down the tree — and scoped under a class
 * the component adds when that variant is asked for.
 *
 * Where the structure genuinely differs, nothing is renamed and nothing is invented: the variant
 * is named as a gap, with the two shapes that did not line up.
 */

import type { IrNode } from '../django/ir.ts'
import { toClassName } from '../django/css-emitter.ts'

/** The variant a set of property values names: `type=Primary,size=L`. */
export function variantKey(properties: Record<string, { type: string; value: unknown }> | undefined): string {
  const parts: string[] = []
  for (const [name, value] of Object.entries(properties ?? {})) {
    if (value.type !== 'VARIANT') continue
    parts.push(`${name.replace(/#.*$/, '')}=${String(value.value)}`)
  }
  return parts.sort().join(',')
}

/** A CSS class for a variant: `type=Primary,size=L` → `v-type-primary-size-l`. */
export function variantClass(key: string): string {
  return `v-${key.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase().replace(/^-+|-+$/g, '')}`
}

/**
 * The node ids of two trees, paired position by position.
 *
 * `null` when the trees do not line up — a different child count or a different kind of node at
 * the same place. That is a structural difference, and pretending otherwise would rename one
 * layer's rules onto another's.
 */
export function pairTrees(left: IrNode, right: IrNode): Map<string, string> | null {
  const pairs = new Map<string, string>()
  const walk = (a: IrNode, b: IrNode): boolean => {
    if (a.type !== b.type) return false
    pairs.set(b.id, a.id)
    const kidsA = (a as { children?: IrNode[] }).children ?? []
    const kidsB = (b as { children?: IrNode[] }).children ?? []
    if (kidsA.length !== kidsB.length) return false
    for (let index = 0; index < kidsA.length; index++) if (!walk(kidsA[index], kidsB[index])) return false
    return true
  }
  return walk(left, right) ? pairs : null
}

/**
 * A variant's stylesheet, renamed onto the first variant's layers and scoped to the variant.
 *
 * The rename is exact-token replacement of `.<class>` — the emitter's class names are derived
 * from node ids and share no substring with anything else in the file, so there is nothing else
 * for it to hit. Rules that name a class outside the pair map are left alone and reported by the
 * caller as unscoped.
 */
export function scopeVariantCss(css: string, pairs: ReadonlyMap<string, string>, scope: string): string {
  let renamed = css
  for (const [from, to] of pairs) {
    if (from === to) continue
    renamed = renamed.split(`.${toClassName(from)}`).join(`.${toClassName(to)}`)
  }

  // Each rule gets the variant class in front of it, so it only applies when the component was
  // asked for that variant. `@media` and `@keyframes` blocks pass through untouched: they carry
  // their own rules, and prefixing the at-rule itself would be nonsense.
  const out: string[] = []
  for (const block of renamed.split(/\n\n+/)) {
    const trimmed = block.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('@')) {
      out.push(trimmed)
      continue
    }
    const brace = trimmed.indexOf('{')
    if (brace === -1) {
      out.push(trimmed)
      continue
    }
    const selectors = trimmed
      .slice(0, brace)
      .split(',')
      .map((one) => `.${scope} ${one.trim()}`)
      .join(',\n')
    out.push(`${selectors} ${trimmed.slice(brace)}`)
  }
  return out.join('\n\n')
}
