/**
 * Code Connect, out of the same data the component was built from.
 *
 * Code Connect does not publish through the plugin or the MCP bridge — `npx figma connect
 * publish` reads plain `<Component>.figma.tsx` files off disk and resolves each `figma.connect(…)`
 * call by the node URL inside it. No library step, no running plugin, nothing this codebase
 * would have to reach Figma for at publish time. What it needs is one file per component, sitting
 * beside it, naming the same node id and the same props the component itself declares — which is
 * exactly what `emitReact` already knows about every component it writes.
 *
 * Kept a pure function on purpose: every fact it needs — the component's name and file, the
 * node it came from, what its props are called in Figma and in code — arrives as an argument.
 * Nothing here calls into `figma.*`, so a test can hand it a component that was never on a
 * canvas and check the file it writes byte for byte.
 */

import { stripPropSuffix, type PropKind } from './jsx.ts'

/** One prop as Code Connect needs to ask Figma for it. */
export interface CodeConnectProp {
  kind: PropKind
  /**
   * The Figma property's own name — dashes, typos and all. `componentPropertyDefinitions` names
   * are unique only up to a `#nodeId` suffix Figma appends to tell two same-named properties
   * apart; that suffix is not part of what the property is called and never belongs in the file
   * Code Connect reads.
   */
  figmaName: string
  /**
   * For a VARIANT prop: every value the generated component's own union type accepts, in the
   * order the component declares them. `figma.enum`'s values have to be strings the component
   * actually compiles against — inventing a nicer-looking one here would type-check the connect
   * file and fail the moment `example` renders it.
   */
  values?: readonly string[]
}

export interface CodeConnectFileOptions {
  /** The component's own name — also its default export. */
  componentName: string
  /** Where the component's file lives, relative to the repository root. The connect file sits
   * beside it and imports from there — never from a package name nothing in this export wrote. */
  componentPath: string
  /** The Figma node id this component was built from, colon and all: `"819:95512"`. */
  nodeId: string
  /** prop name (as the component itself calls it) → what Code Connect asks Figma for. */
  props: ReadonlyMap<string, CodeConnectProp>
  /**
   * The design file's key. It is the only part of the URL that actually resolves a node — Figma
   * reads `fileKey` + `node-id` and ignores the path segment between them — but it is also the
   * one part a plugin cannot always see: `figma.fileKey` is granted only to a private plugin on
   * an Organization plan, and is `undefined` everywhere else.
   */
  fileKey: string
  /** The design file's own name. Cosmetic in the URL — Figma resolves by fileKey and node-id
   * alone — but the segment a developer actually reads before deciding the link is theirs. */
  fileName: string
}

const isIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** A single-quoted JS string literal — the quote style today's live publish came out in. */
const sq = (text: string): string => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** An object key, quoted only when the text is not already a valid one — `Extra Large` needs the
 * quotes a variant option like `Meduim` does not. */
const objectKey = (text: string): string => (isIdentifier.test(text) ? text : sq(text))

/** Figma writes node ids `1483:116022`; the URL it accepts writes the same id `1483-116022`. */
const urlNodeId = (nodeId: string): string => nodeId.replace(/:/g, '-')

/** The URL's file-name segment. Any string resolves — the id right after the key is what Figma
 * actually reads — so this exists to keep the link legible, not to keep it working. */
const urlFileName = (fileName: string): string => {
  const slug = fileName
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'Untitled' : slug
}

/** One `props` entry: `figma.boolean` / `figma.string` / `figma.enum`, whichever this prop's own
 * Figma type maps to — the same map `kindOfProp` builds every generated component's fields from. */
function propMapping(name: string, prop: CodeConnectProp): string {
  const figmaName = stripPropSuffix(prop.figmaName)
  if (prop.kind === 'boolean') return `${name}: figma.boolean(${sq(figmaName)})`
  if (prop.kind === 'text') return `${name}: figma.string(${sq(figmaName)})`
  const entries = (prop.values ?? []).map((value) => `${objectKey(value)}: ${sq(value)}`).join(', ')
  return `${name}: figma.enum(${sq(figmaName)}, { ${entries} })`
}

/** A `<Component>.figma.tsx` file, ready for `npx figma connect publish` to read. */
export function codeConnectFile(options: CodeConnectFileOptions): string {
  const importBase = options.componentPath.slice(options.componentPath.lastIndexOf('/') + 1).replace(/\.tsx$/, '')
  const url =
    `https://www.figma.com/design/${options.fileKey}/${urlFileName(options.fileName)}` +
    `?node-id=${urlNodeId(options.nodeId)}`
  const names = [...options.props.keys()]
  const propsBlock =
    names.length === 0
      ? '{}'
      : `{\n${names.map((name) => `    ${propMapping(name, options.props.get(name)!)},`).join('\n')}\n  }`
  const attrs = names.map((name) => `${name}={props.${name}}`).join(' ')
  const example = `(props) => <${options.componentName}${attrs === '' ? '' : ` ${attrs}`} />`

  return (
    `import figma from '@figma/code-connect'\n` +
    `import { ${options.componentName} } from './${importBase}'\n\n` +
    `figma.connect(${options.componentName}, ${sq(url)}, {\n` +
    `  props: ${propsBlock},\n` +
    `  example: ${example},\n` +
    `})\n`
  )
}
