/**
 * REFORM phase 10 / B4: the pure generation PLANNER. Turns a `ComponentSpec` into the exact
 * set of Figma variants to build — names in Figma's `Prop=Value, Prop=Value` convention (so the
 * B3 exporter reads them back), plus an `IrComponentDef`-shaped descriptor the recognizer
 * understands. No `figma` API here: the Figma builder (phase 10b) consumes this plan; this half
 * is fully Node-testable and is what the round-trip parity test exercises.
 */

import type { IrComponentPropertyDef } from '../ir.ts'
import type { ComponentSpec, SpecPart, SpecProp } from '../bootstrap/specs.ts'

export interface VariantPlan {
  /** Figma variant node name, e.g. `Variant=Primary, Size=md, State=hover`. */
  name: string
  /** Property → value for this variant. */
  values: Record<string, string>
}

export interface ComponentPlan {
  name: string
  /** True when the component has ≥1 variant property (→ a ComponentSet); false → a lone component. */
  isSet: boolean
  variants: VariantPlan[]
  parts: readonly SpecPart[]
  /** The recognizer-facing shape: what `matchBootstrapComponent` reads (setName + properties). */
  componentDef: { setName: string; properties: IrComponentPropertyDef[] }
}

/** The VARIANT properties that form the variant matrix: the spec's VARIANT props, plus a
 * synthesized `State` variant when the spec lists interactive states. */
function variantProps(spec: ComponentSpec): SpecProp[] {
  const declared = spec.props.filter((prop) => prop.type === 'VARIANT')
  if (spec.states && spec.states.length > 0) {
    return [...declared, { name: 'State', type: 'VARIANT', options: spec.states }]
  }
  return declared
}

/** Cartesian product of each variant prop's options, in prop order. */
function variantMatrix(props: readonly SpecProp[]): Array<Record<string, string>> {
  let rows: Array<Record<string, string>> = [{}]
  for (const prop of props) {
    const options = prop.options ?? []
    const next: Array<Record<string, string>> = []
    for (const row of rows) {
      for (const option of options) next.push({ ...row, [prop.name]: option })
    }
    rows = next
  }
  return rows
}

/** Figma variant naming: `Prop=Value, Prop=Value` in property order. */
function variantName(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([prop, value]) => `${prop}=${value}`)
    .join(', ')
}

/** The full prop set as `IrComponentPropertyDef`s — VARIANT props (with `variantOptions` and a
 * default = first option), BOOLEAN props, and the synthesized `State` variant. This is exactly
 * what `matchBootstrapComponent` inspects, so planning + recognition stay symmetric. */
function componentProperties(spec: ComponentSpec): IrComponentPropertyDef[] {
  const props: IrComponentPropertyDef[] = []
  for (const prop of spec.props) {
    if (prop.type === 'VARIANT') {
      const options = prop.options ?? []
      props.push({ name: prop.name, type: 'VARIANT', defaultValue: options[0] ?? '', variantOptions: options })
    } else {
      props.push({ name: prop.name, type: 'BOOLEAN', defaultValue: prop.boolDefault ?? false, variantOptions: null })
    }
  }
  if (spec.states && spec.states.length > 0) {
    props.push({ name: 'State', type: 'VARIANT', defaultValue: spec.states[0], variantOptions: spec.states })
  }
  return props
}

export function planComponent(spec: ComponentSpec): ComponentPlan {
  const vProps = variantProps(spec)
  const isSet = vProps.length > 0
  const matrix = isSet ? variantMatrix(vProps) : [{}]
  const variants: VariantPlan[] = matrix.map((values) => ({
    name: isSet ? variantName(values) : spec.name,
    values,
  }))
  return {
    name: spec.name,
    isSet,
    variants,
    parts: spec.parts ?? [],
    componentDef: { setName: spec.name, properties: componentProperties(spec) },
  }
}

export function planKit(specs: readonly ComponentSpec[]): ComponentPlan[] {
  return specs.map(planComponent)
}

/** Total variants a kit plan would create — for the generation report. */
export function countVariants(plans: readonly ComponentPlan[]): number {
  return plans.reduce((sum, plan) => sum + plan.variants.length, 0)
}
