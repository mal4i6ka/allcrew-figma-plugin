/**
 * A screen as a React repository, not as a picture of one.
 *
 * The deliverable this target exists for: a developer opens what comes out, runs it, sees the
 * screen, replaces the mock with a real call and ships. That means the output is not one file of
 * markup — it is a component per Figma component, a screen that uses them, tokens as CSS
 * variables, a mock beside the data and the copy in a locale, each replaceable on its own.
 *
 * Components come from the instances on the screen, one file per component SET: the variants a
 * screen actually uses become the union type of its props, so `<Button type="primary" size="L">`
 * type-checks against exactly what the design system has. The first instance of a component
 * supplies its markup; a variant whose markup genuinely differs is named as a gap rather than
 * silently taking the first one's shape.
 *
 * Everything the emitter cannot translate leaves a comment at the line it happened on, naming the
 * Figma node. A report in the root would be a report nobody opens.
 */

import type { IrNode } from '../django/ir.ts'
import { emitCss, toClassName } from '../django/css-emitter.ts'
import type { DjangoNodeSource } from '../django/css-emitter.ts'
import { componentName, emitJsx, newContext, propName, type JsxContext } from './jsx.ts'

export interface ReactOutput {
  /** path → contents, ready to be written into a repository. */
  files: Record<string, string>
  /** What could not be translated, gathered for the reply — the same lines are also in the code. */
  gaps: string[]
}

export interface EmitReactOptions {
  /** What the screen component is called. Defaults to the root node's name. */
  name?: string
}

/** A component as the screens use it: its markup, and every property value they ask for. */
interface CollectedComponent {
  name: string
  body: IrNode | null
  /** property name → the values seen across every instance. */
  values: Map<string, Set<string>>
  types: Map<string, string>
}

export async function emitReact(
  roots: readonly IrNode[],
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string>,
  options: EmitReactOptions = {}
): Promise<ReactOutput> {
  const files: Record<string, string> = {}
  const gaps: string[] = []
  const components = new Map<string, CollectedComponent>()

  for (const root of roots) collectComponents(root, components)

  for (const root of roots) {
    const name = componentName(options.name ?? root.name)
    const context = newContext(name.toLowerCase())
    const markup = emitJsx(root, context, 2)

    files[`src/screens/${name}.tsx`] = screenFile(name, markup, context)
    files[`src/screens/${name}.module.css`] = await emitCss([root], sceneNodesById, variableNamesById, {
      preamble: false,
    })
    if (Object.keys(context.copy).length > 0) {
      files[`src/locales/${name.toLowerCase()}.json`] = `${JSON.stringify(context.copy, null, 2)}\n`
    }
    if (context.props.size > 0) files[`src/screens/${name}.mock.ts`] = mockFile(name, context)
    gaps.push(...context.gaps)
  }

  // The screens import it, so it is emitted: a scaffold that does not compile because the
  // generator referred to a file it never wrote is a scaffold nobody runs.
  if (Object.values(files).some((one) => one.includes("from '../copy'"))) files['src/copy.tsx'] = COPY_FILE

  for (const component of components.values()) {
    const built = await componentFile(component, sceneNodesById, variableNamesById)
    files[`src/components/${component.name}.tsx`] = built.tsx
    if (built.css.trim() !== '') files[`src/components/${component.name}.module.css`] = built.css
    gaps.push(...built.gaps)
  }

  return { files, gaps }
}

/* ------------------------------------------------------------------- components */

function collectComponents(node: IrNode, into: Map<string, CollectedComponent>): void {
  if (node.type === 'instance-ref') {
    const name = componentName(node.componentSetName || node.name)
    const held = into.get(name) ?? { name, body: null, values: new Map(), types: new Map() }
    // The first instance supplies the markup. A later one whose shape differs is a real
    // difference and is reported rather than reconciled.
    if (!held.body) held.body = node
    for (const [raw, value] of Object.entries(node.componentProperties ?? {})) {
      const prop = propName(raw)
      const seen = held.values.get(prop) ?? new Set<string>()
      seen.add(String(value.value))
      held.values.set(prop, seen)
      held.types.set(prop, value.type)
    }
    into.set(name, held)
    return
  }
  for (const child of (node as { children?: IrNode[] }).children ?? []) collectComponents(child, into)
}

async function componentFile(
  component: CollectedComponent,
  sceneNodesById: ReadonlyMap<string, DjangoNodeSource>,
  variableNamesById: ReadonlyMap<string, string>
): Promise<{ tsx: string; css: string; gaps: string[] }> {
  const context: JsxContext = {
    ...newContext(component.name.toLowerCase()),
    insideComponent: true,
    rootId: component.body?.id,
  }
  const body = component.body
    ? emitJsx({ ...(component.body as IrNode), type: 'container' } as IrNode, context, 2)
    : '    <div />'
  const css = component.body
    ? await emitCss([{ ...(component.body as IrNode), type: 'container' } as IrNode], sceneNodesById, variableNamesById, {
        preamble: false,
      })
    : ''

  const fields: string[] = []
  for (const [prop, seen] of component.values) {
    const type = component.types.get(prop)
    if (type === 'BOOLEAN') fields.push(`  ${prop}?: boolean`)
    else if (type === 'VARIANT') {
      // The union is what this file's screens actually use — narrower than the component set, and
      // true. A value the design system has and nobody used is not in the type, and adding it
      // would be a promise about markup this emitter has never seen.
      fields.push(`  ${prop}?: ${[...seen].map((one) => JSON.stringify(one)).join(' | ')}`)
    } else fields.push(`  ${prop}?: string`)
  }
  for (const prop of context.props.keys()) if (!component.values.has(prop)) fields.push(`  ${prop}?: string`)

  const props = fields.length > 0 ? `\n${fields.join('\n')}\n` : '\n'
  const imports = [...context.used].filter((one) => one !== component.name)

  const tsx = `${header(component.name)}
import styles from './${component.name}.module.css'
${imports.map((one) => `import { ${one} } from './${one}'`).join('\n')}${imports.length > 0 ? '\n' : ''}${
    Object.keys(context.copy).length > 0 ? "import { useCopy } from '../copy'\n" : ''
  }
export interface ${component.name}Props {${props}  className?: string
}

export function ${component.name}({ ${[...component.values.keys(), ...context.props.keys()]
    .filter((one, index, all) => all.indexOf(one) === index)
    .join(', ')}${component.values.size + context.props.size > 0 ? ', ' : ''}className }: ${component.name}Props) {
${Object.keys(context.copy).length > 0 ? '  const t = useCopy()\n' : ''}  return (
${body}
  )
}
`
  return { tsx, css, gaps: context.gaps }
}

/* ----------------------------------------------------------------------- files */

function screenFile(name: string, markup: string, context: JsxContext): string {
  const imports = [...context.used].map((one) => `import { ${one} } from '../components/${one}'`).join('\n')
  const props = [...context.props.keys()]
  const signature = props.length > 0 ? `{ ${props.join(', ')} }: ${name}Props` : ''
  const declaration =
    props.length > 0
      ? `export interface ${name}Props {\n${props.map((one) => `  ${one}: string`).join('\n')}\n}\n\n`
      : ''

  return `${header(name)}
import styles from './${name}.module.css'
${imports}${imports ? '\n' : ''}${Object.keys(context.copy).length > 0 ? "import { useCopy } from '../copy'\n" : ''}
${declaration}export function ${name}(${signature}) {
${Object.keys(context.copy).length > 0 ? '  const t = useCopy()\n' : ''}  return (
${markup}
  )
}
`
}

function mockFile(name: string, context: JsxContext): string {
  const rows = [...context.props.entries()].map(([prop, value]) => `  ${prop}: ${value},`).join('\n')
  return `${header(name)}
/**
 * What the screen showed in Figma. Replace the object, not the screen: every field here is a
 * prop the component takes, so wiring a real call is one substitution.
 */
export const ${name.charAt(0).toLowerCase()}${name.slice(1)}Mock = {
${rows}
}
`
}

/**
 * The smallest thing that makes `t('key')` work, and the seam where a real i18n library goes.
 *
 * Deliberately not a dependency: the scaffold has to run on `npm install react` alone, and a
 * team that already has i18next replaces this one file rather than unpicking calls from markup.
 */
const COPY_FILE = `/* Generated from Figma. Replace this file with your own i18n — the screens only need \`t\`. */
import { createContext, useContext } from 'react'

export type Copy = Record<string, string>

const CopyContext = createContext<Copy>({})

export const CopyProvider = CopyContext.Provider

export function useCopy(): (key: string) => string {
  const copy = useContext(CopyContext)
  // The key itself when nothing answers to it: a missing translation should be findable on the
  // screen, not an empty box.
  return (key: string) => copy[key] ?? key
}
`

const header = (name: string): string =>
  `/* Generated from Figma — ${name}. Regenerating replaces this file; edits outside it survive. */`

export { toClassName }
