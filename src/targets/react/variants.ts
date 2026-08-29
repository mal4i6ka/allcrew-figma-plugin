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

/**
 * The same key, read off a variant component's NAME.
 *
 * On a component page there are no instances to ask: a variant IS a component, and Figma names it
 * by its axes — `Type=Primary, Size=L`. Same key, same order, so the library and the screens agree
 * on what a variant is called.
 */
export function variantKeyFromName(name: string): string {
  return name
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.includes('='))
    .sort()
    .join(',')
}

/** The axes a set of variant names describes: `Type` → `Primary, Secondary`. */
export function axesOf(names: readonly string[]): Map<string, Set<string>> {
  const axes = new Map<string, Set<string>>()
  for (const name of names) {
    for (const part of name.split(',')) {
      const [axis, value] = part.split('=').map((one) => one.trim())
      if (!axis || value === undefined) continue
      const seen = axes.get(axis) ?? new Set<string>()
      seen.add(value)
      axes.set(axis, seen)
    }
  }
  return axes
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
  return pairOrExplain(left, right).pairs
}

/**
 * The same walk, and — when it fails — the layer that did not line up.
 *
 * "Built differently" is true and useless: on a 144-variant button it was said 108 times without
 * once mentioning that the `Icon` axis adds a layer. A developer reading the gap needs to know
 * WHICH difference, because that is what decides whether they write a CSS rule or a branch.
 */
export function pairOrExplain(left: IrNode, right: IrNode): { pairs: Map<string, string> | null; why?: string } {
  const pairs = new Map<string, string>()
  let why: string | undefined

  const walk = (a: IrNode, b: IrNode, path: string): boolean => {
    if (a.type !== b.type) {
      why = `${path || a.name} is a ${a.type} in one and a ${b.type} in the other`
      return false
    }
    pairs.set(b.id, a.id)
    const kidsA = (a as { children?: IrNode[] }).children ?? []
    const kidsB = (b as { children?: IrNode[] }).children ?? []
    if (kidsA.length !== kidsB.length) {
      const extra = kidsB.length > kidsA.length
        ? kidsB.slice(kidsA.length).map((one) => one.name).join(', ')
        : kidsA.slice(kidsB.length).map((one) => one.name).join(', ')
      why =
        `${path || a.name} holds ${kidsA.length} layer(s) in one and ${kidsB.length} in the other` +
        (extra ? ` — ${kidsB.length > kidsA.length ? 'the extra one is' : 'the missing one is'} ${extra}` : '')
      return false
    }
    for (let index = 0; index < kidsA.length; index++) {
      if (!walk(kidsA[index], kidsB[index], `${path ? `${path} → ` : ''}${kidsA[index].name}`)) return false
    }
    return true
  }

  return walk(left, right, '') ? { pairs } : { pairs: null, why }
}

export interface Aligned {
  /** Every layer any variant has, in the first variant's order, with the additions appended. */
  union: IrNode
  /** node id in the union → the variant keys that actually hold that layer. */
  membership: Map<string, Set<string>>
  /** variant key → (its own node id → the union node it stands for). */
  maps: Map<string, Map<string, string>>
  /** Variants whose layers could not be lined up at all, and why. */
  unmatched: Array<{ key: string; why: string }>
}

/**
 * Every variant of one component, laid over each other.
 *
 * Pairing by POSITION was right until it was not: a button's `Icon=Trailing` variant holds two
 * layers where `Icon=None` holds one, and by position the label lined up with the icon. Variants
 * keep their layer names, so the alignment is by name, and a layer only some variants have is
 * kept with a note of which ones — that note is what becomes the condition in the markup.
 *
 * A layer whose KIND changes between variants — a label that is a text in one and a swapped
 * instance in another — is not one layer with two shapes. Both are kept, each belonging to the
 * variants that have it, and the markup renders whichever the asked-for variant carries.
 */
export function alignVariants(variants: ReadonlyArray<{ key: string; node: IrNode }>): Aligned {
  const membership = new Map<string, Set<string>>()
  const maps = new Map<string, Map<string, string>>()
  const unmatched: Array<{ key: string; why: string }> = []
  const [first, ...rest] = variants
  const union = clone(first.node)

  const belongs = (id: string, key: string) => {
    const seen = membership.get(id) ?? new Set<string>()
    seen.add(key)
    membership.set(id, seen)
  }
  const claimAll = (node: IrNode, key: string) => {
    belongs(node.id, key)
    for (const child of childrenOf(node)) claimAll(child, key)
  }
  claimAll(union, first.key)
  maps.set(first.key, new Map())

  for (const variant of rest) {
    const map = new Map<string, string>()
    const merge = (into: IrNode, from: IrNode): void => {
      map.set(from.id, into.id)
      belongs(into.id, variant.key)

      const existing = childrenOf(into)
      const taken = new Set<number>()
      for (const incoming of childrenOf(from)) {
        // By name first, and only among the children not already claimed: two layers of one name
        // under one parent are rare and must still not both fold into the same union node.
        let at = existing.findIndex((one, index) => !taken.has(index) && one.name === incoming.name && one.type === incoming.type)
        if (at === -1) {
          // A layer this variant has and the union does not: appended, belonging to this variant
          // alone until another turns up with it.
          const added = clone(incoming)
          existing.push(added)
          at = existing.length - 1
          claimNothing(added)
        }
        taken.add(at)
        merge(existing[at], incoming)
      }
    }
    const claimNothing = (node: IrNode) => {
      for (const child of childrenOf(node)) claimNothing(child)
    }
    merge(union, variant.node)
    maps.set(variant.key, map)
  }

  return { union, membership, maps, unmatched }
}

const childrenOf = (node: IrNode): IrNode[] => ((node as { children?: IrNode[] }).children ??= []) as IrNode[]

/** A shallow-enough copy: the union tree grows children, and growing the caller's would be rude. */
function clone(node: IrNode): IrNode {
  const copy = { ...node } as IrNode
  const kids = (node as { children?: IrNode[] }).children
  if (kids) (copy as unknown as { children: IrNode[] }).children = kids.map(clone)
  return copy
}

/**
 * A variant's stylesheet, renamed onto the first variant's layers and scoped to the variant.
 *
 * The rename is exact-token replacement of `.<class>` — the emitter's class names are derived
 * from node ids and share no substring with anything else in the file, so there is nothing else
 * for it to hit. Rules that name a class outside the pair map are left alone and reported by the
 * caller as unscoped.
 */
export function scopeVariantCss(
  css: string,
  pairs: ReadonlyMap<string, string>,
  scope: string,
  /** The base variant's stylesheet: whatever this variant says identically is not worth saying. */
  base?: string
): string {
  let renamed = css
  for (const [from, to] of pairs) {
    if (from === to) continue
    renamed = renamed.split(`.${toClassName(from)}`).join(`.${toClassName(to)}`)
  }

  // Each rule gets the variant class in front of it, so it only applies when the component was
  // asked for that variant. `@media` and `@keyframes` blocks pass through untouched: they carry
  // their own rules, and prefixing the at-rule itself would be nonsense.
  const baseRules = base ? rulesOf(base) : null

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

    const selector = trimmed.slice(0, brace).trim()
    let declarations = trimmed.slice(brace + 1).replace(/\}\s*$/, '')

    // Against the base: a variant that repeats the whole stylesheet to change one colour makes a
    // 285KB file for one button, and buries the one line that actually differs.
    if (baseRules) {
      const held = baseRules.get(selector)
      const kept = declarations
        .split(';')
        .map((one) => one.trim())
        .filter((one) => one !== '' && (!held || !held.has(one)))
      if (kept.length === 0) continue
      declarations = `\n  ${kept.join(';\n  ')};\n`
    }

    const selectors = selector
      .split(',')
      .map((one) => `.${scope} ${one.trim()}`)
      .join(',\n')
    out.push(`${selectors} {${declarations}}`)
  }
  return out.join('\n\n')
}

/** selector → the declarations it holds, for comparing one stylesheet against another. */
function rulesOf(css: string): Map<string, Set<string>> {
  const rules = new Map<string, Set<string>>()
  for (const block of css.split(/\n\n+/)) {
    const trimmed = block.trim()
    if (trimmed === '' || trimmed.startsWith('@')) continue
    const brace = trimmed.indexOf('{')
    if (brace === -1) continue
    const declarations = trimmed
      .slice(brace + 1)
      .replace(/\}\s*$/, '')
      .split(';')
      .map((one) => one.trim())
      .filter((one) => one !== '')
    rules.set(trimmed.slice(0, brace).trim(), new Set(declarations))
  }
  return rules
}
