/**
 * A component's API, for a build that has to declare it.
 *
 * `components.list` answers what Figma stores: axes, their options, their defaults. That is the
 * signature - `enum ButtonType { primary, secondary, tertiary }` - and it is only half of what a
 * build needs. The other half is what each value DOES, and nothing in the op surface answered it:
 * the derivation lived inside the CSS emitter (`emitComponentVariantModifierCss` diffs the default
 * variant against single-axis siblings and formats the result as CSS declarations) and inside the
 * React emitter (variant subtree alignment), so a SwiftUI or Compose build could reach it only by
 * generating a stylesheet it has no use for and parsing that back.
 *
 * Here the same walk answers in properties instead of rules:
 *
 * - **One axis at a time.** `Size=Small` is diffed against the variant where Size is Small and
 *   every OTHER axis sits at its own default, because that is the only sibling whose delta belongs
 *   to Size alone. Diffing against an arbitrary member would attribute Secondary's colours to it.
 * - **A layer that only exists in one state is a `presence` change** rather than a silent
 *   omission - that is how "this variant has an icon and the default does not" arrives.
 * - **Non-variant properties are not diffable at all**, and pretending otherwise would be the
 *   wrong answer: a BOOLEAN like `Right Icon` hides a layer inside every variant, and a TEXT
 *   property replaces one layer's characters. What a consumer needs there is WHICH layer the
 *   property drives, which Figma states outright in `componentPropertyReferences`.
 */

import { diffNodeSubtrees, type LiveNode, type StateChange } from './state-ops.ts'
import { variableNameResolver } from './bound-tokens.ts'

/** The Figma fields a component property can drive on a layer, as the property reference names
 * them. `visible` is the toggle a BOOLEAN owns, `characters` the text a TEXT owns,
 * `mainComponent` the swap an INSTANCE_SWAP owns. */
const REFERENCE_FIELDS = ['visible', 'characters', 'mainComponent'] as const

interface VariantMember extends LiveNode {
  readonly variantProperties?: Record<string, string> | null
  readonly componentPropertyReferences?: Record<string, string> | null
}

export interface VariantOption {
  readonly value: string
  /** True on the option the set resolves to when nobody says otherwise. */
  readonly isDefault?: true
  /** The member with this value on this axis and every other axis at its default - the node an
   * agent reads, screenshots or measures to see the option on its own. Absent when the set has no
   * such combination (a non-Cartesian set), which is also why `changes` is then absent. */
  readonly variantId?: string
  readonly variantName?: string
  /** What this option changes against the default variant, addressed by layer path. `presence`
   * names a layer that exists in only one of the two. */
  readonly changes?: readonly StateChange[]
}

export interface VariantAxis {
  readonly name: string
  readonly default: string
  readonly options: readonly VariantOption[]
}

/** Where a non-variant property lands: the layer it drives and the field it drives on it. */
export interface PropertyTarget {
  readonly nodeId: string
  /** Layer-name path from the variant root (`Content/Label`) - the address a person reads. */
  readonly path: string
  readonly field: (typeof REFERENCE_FIELDS)[number]
  /** The member this layer was found in, when it was not the default variant. A boolean that
   * reveals an icon is wired on the variants that HAVE the icon layer, and the default often is
   * not one of them - looking only there answered "wired to nothing" for a property the file
   * plainly uses. */
  readonly variantId?: string
  readonly variantName?: string
}

export interface ComponentProperty {
  readonly name: string
  readonly type: string
  readonly defaultValue?: unknown
  /** INSTANCE_SWAP only: the components the designer offered as alternatives. */
  readonly preferredValues?: readonly unknown[]
  /** The layers this property drives, read off `componentPropertyReferences` across the set's
   * members. Empty means the property is declared and wired to nothing - real, and worth seeing. */
  readonly targets: readonly PropertyTarget[]
}

export interface ComponentApi {
  readonly id: string
  readonly name: string
  readonly key?: string
  readonly type: string
  readonly description?: string
  readonly documentationLinks?: readonly string[]
  readonly defaultVariant?: { readonly id: string; readonly name: string }
  readonly axes: readonly VariantAxis[]
  readonly properties: readonly ComponentProperty[]
  /** Every member, with its own axis values parsed - the map from a combination to a node id. */
  readonly variants: readonly {
    readonly id: string
    readonly name: string
    readonly values: Record<string, string>
  }[]
  /** Set when the per-option diffing hit its budget - see `note` for what that means. */
  readonly stoppedOn?: 'budgetMs'
  readonly note?: string
  /** Set when Figma refused `componentPropertyDefinitions` (a set with errors in the file): the
   * axes are then unknown rather than empty, and saying so beats answering `axes: []`. */
  readonly propertiesError?: string
}

type Definitions = Record<
  string,
  { type: string; defaultValue?: unknown; variantOptions?: readonly string[]; preferredValues?: readonly unknown[] }
>

function normalise(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** The member whose axes all sit at their declared defaults. `undefined` when the set does not
 * contain that combination - the caller then has no baseline to diff against and says so by
 * leaving `defaultVariant` out, rather than nominating the first child and reporting every other
 * option's delta against an arbitrary member. */
function findDefaultVariant(members: readonly VariantMember[], axes: readonly [string, string][]): VariantMember | undefined {
  return members.find((member) =>
    axes.every(([axis, value]) => normalise(member.variantProperties?.[axis]) === normalise(value))
  )
}

/** The member with `axis = value` and every other axis at its default - see the module doc. */
function findIsolated(
  members: readonly VariantMember[],
  axes: readonly [string, string][],
  axis: string,
  value: string
): VariantMember | undefined {
  return members.find((member) =>
    axes.every(([name, fallback]) => {
      const wanted = name === axis ? value : fallback
      return normalise(member.variantProperties?.[name]) === normalise(wanted)
    })
  )
}

/** Every layer under `root` with the path a person reads it by. The root itself is `''`, the same
 * address `diffNodeSubtrees` uses for a node's own change. */
function walkWithPaths(root: LiveNode): Array<{ node: LiveNode; path: string }> {
  const out: Array<{ node: LiveNode; path: string }> = [{ node: root, path: '' }]
  const visit = (node: LiveNode, prefix: string): void => {
    for (const child of node.children ?? []) {
      const path = prefix ? `${prefix}/${child.name}` : child.name
      out.push({ node: child, path })
      visit(child, path)
    }
  }
  visit(root, '')
  return out
}

/**
 * The layers a non-variant property drives. Figma keys the reference by the property's FULL id
 * (`Right Icon#198:4`), which is also the key in `componentPropertyDefinitions` - so they match
 * without parsing the `#` suffix off either side.
 *
 * The default variant is searched first and named implicitly; the other members are searched too,
 * because a boolean that reveals an icon is wired on the variants that have the icon layer, and
 * the default is routinely not one of them. Deduplicated by path+field so 27 members of one set
 * do not report the same layer 27 times.
 */
function targetsAcross(
  members: readonly VariantMember[],
  defaultVariant: VariantMember | undefined,
  propertyKey: string
): PropertyTarget[] {
  const ordered = defaultVariant ? [defaultVariant, ...members.filter((m) => m !== defaultVariant)] : [...members]
  const targets: PropertyTarget[] = []
  const seen = new Set<string>()
  for (const member of ordered) {
    for (const { node, path } of walkWithPaths(member)) {
      const references = (node as VariantMember).componentPropertyReferences
      if (!references) continue
      for (const field of REFERENCE_FIELDS) {
        if (references[field] !== propertyKey) continue
        const key = `${path}\u0000${field}`
        if (seen.has(key)) continue
        seen.add(key)
        targets.push({
          nodeId: node.id,
          path,
          field,
          ...(member === defaultVariant ? {} : { variantId: member.id, variantName: member.name }),
        })
      }
    }
  }
  return targets
}

export interface ComponentApiOptions {
  /** Variable id → name. The op layer leaves it out and gets the cached Figma reader; a test
   * passes a map, which is also what keeps this module free of the plugin global. */
  readonly resolveToken?: (id: string) => Promise<string | null>
  /** How long the per-option diffing may take before the answer comes back without the rest.
   * One option is a `getCSSAsync` walk of two subtrees, so a set with four axes and deep
   * variants is minutes of work that used to have no ceiling at all - the signature is the
   * half a caller can always get, and it should not be held hostage to the deltas. */
  readonly budgetMs?: number
  /** Off skips every subtree diff - the signature (axes, options, defaults, ids) with none of the
   * "what does it change" half. That half is a `getCSSAsync` walk per isolated variant, so a
   * caller that only wants to declare an enum should not pay for it. */
  readonly changes?: boolean
}

/**
 * `node` is the component SET (or a member/instance of one - the set is resolved either way).
 * `definitions` is `componentPropertyDefinitions` as read by the op layer, which owns the guard
 * against Figma's throwing getter.
 */
export async function componentApi(
  set: VariantMember,
  definitions: Definitions | undefined,
  propertiesError: string | undefined,
  options: ComponentApiOptions = {}
): Promise<ComponentApi> {
  const members = (set.children ?? []) as readonly VariantMember[]
  const entries = Object.entries(definitions ?? {})
  const variantEntries = entries.filter(([, spec]) => spec.type === 'VARIANT')
  const axisDefaults = variantEntries.map(([name, spec]) => [name, String(spec.defaultValue ?? '')] as [string, string])
  const defaultVariant = findDefaultVariant(members, axisDefaults)
  const resolveToken = options.resolveToken ?? variableNameResolver()
  const wantChanges = options.changes !== false && defaultVariant !== undefined
  const deadline = options.budgetMs === undefined ? Infinity : Date.now() + options.budgetMs
  let ranOut = false

  const axes: VariantAxis[] = []
  for (const [name, spec] of variantEntries) {
    const defaultValue = String(spec.defaultValue ?? '')
    const options_: VariantOption[] = []
    for (const value of spec.variantOptions ?? []) {
      const isDefault = normalise(value) === normalise(defaultValue)
      const member = isDefault ? defaultVariant : findIsolated(members, axisDefaults, name, value)
      options_.push({
        value,
        ...(isDefault ? { isDefault: true as const } : {}),
        ...(member ? { variantId: member.id, variantName: member.name } : {}),
        // The default option is its own baseline: diffing it against itself is an empty list that
        // would read as "this option changes nothing", which is true and useless.
        // Out of budget: the option still reports its id and name - only the delta is missing,
        // and `stoppedOn` below says why, so a thin answer cannot pass for "changes nothing".
        ...(wantChanges && member && !isDefault && !ranOut
          ? Date.now() > deadline
            ? ((ranOut = true), {})
            : { changes: await diffNodeSubtrees(defaultVariant as LiveNode, member, resolveToken) }
          : {}),
      })
    }
    axes.push({ name, default: defaultValue, options: options_ })
  }

  // A standalone (non-set) component is its own only member, so the reference walk has something
  // to read either way.
  const referenceMembers = members.length > 0 ? members : [set]
  const properties: ComponentProperty[] = entries
    .filter(([, spec]) => spec.type !== 'VARIANT')
    .map(([key, spec]) => ({
      name: key,
      type: spec.type,
      ...(spec.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
      ...(spec.preferredValues ? { preferredValues: spec.preferredValues } : {}),
      targets: targetsAcross(referenceMembers, defaultVariant, key),
    }))

  return {
    id: set.id,
    name: set.name,
    ...(typeof (set as { key?: string }).key === 'string' ? { key: (set as { key?: string }).key } : {}),
    type: set.type,
    ...((set as { description?: string }).description ? { description: (set as { description?: string }).description } : {}),
    ...((set as { documentationLinks?: ReadonlyArray<{ uri: string }> }).documentationLinks?.length
      ? {
          documentationLinks: (set as { documentationLinks?: ReadonlyArray<{ uri: string }> }).documentationLinks!.map(
            (link) => link.uri
          ),
        }
      : {}),
    ...(defaultVariant ? { defaultVariant: { id: defaultVariant.id, name: defaultVariant.name } } : {}),
    axes,
    properties,
    variants: members.map((member) => ({
      id: member.id,
      name: member.name,
      values: { ...(member.variantProperties ?? {}) },
    })),
    ...(propertiesError ? { propertiesError } : {}),
    ...(ranOut
      ? {
          stoppedOn: 'budgetMs' as const,
          note:
            'The budget ran out before every option was diffed: options without `changes` were not ' +
            'measured, which is not the same as measuring them and finding nothing. Raise budgetMs, ' +
            'or ask for one axis at a time.',
        }
      : {}),
  }
}
