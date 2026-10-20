/**
 * Code Connect, out of the same data the component was built from.
 *
 * Code Connect 2.x reads TEMPLATE files: `<Component>.figma.ts`, a few metadata comments naming the
 * Figma component, and a module that runs against `figma.selectedInstance` and default-exports
 * the snippet Dev Mode shows. The framework parsers the first version of this emitter targeted
 * (`figma.connect(Component, url, { props, example })` in `.figma.tsx`) were retired in 2.0.0 —
 * `publish` now refuses them outright — so a template is the only file worth writing.
 *
 * Nothing here publishes: `npx figma connect publish` reads the files off disk. What it needs is
 * one template per component, sitting beside it, naming the same node id and the same props the
 * component itself declares — which is exactly what `emitReact` already knows about every
 * component it writes.
 *
 * Kept pure on purpose: every fact it needs — the component's name and file, the node it came
 * from, what its props are called in Figma and in code — arrives as an argument. Nothing here
 * calls into `figma.*`, so a test can hand it a component that was never on a canvas and check
 * the file it writes byte for byte.
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
   * order the component declares them. The enum map sends each Figma value to that same string,
   * because the snippet has to name values the component actually compiles against.
   */
  values?: readonly string[]
}

export interface CodeConnectFileOptions {
  /** The component's own name — also its named export. */
  componentName: string
  /** Where the component's file lives, relative to the repository root. Shown in Figma as the
   * mapping's source, and the path the snippet's import points at. */
  componentPath: string
  /** The Figma node id this component was built from, colon and all: `"819:95512"`. */
  nodeId: string
  /** prop name (as the component itself calls it) → what Code Connect asks Figma for. */
  props: ReadonlyMap<string, CodeConnectProp>
  /** The design file's key — the only part of the URL that actually resolves a node. */
  fileKey: string
  /** The design file's own name. Cosmetic in the URL — Figma resolves by key and node-id alone —
   * but the segment a developer actually reads before deciding the link is theirs. */
  fileName: string
}

const isIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** A single-quoted JS string literal. */
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

/** The node link a template's `url=` comment carries. */
export function componentUrl(fileKey: string, fileName: string, nodeId: string): string {
  return `https://www.figma.com/design/${fileKey}/${urlFileName(fileName)}?node-id=${urlNodeId(nodeId)}`
}

/**
 * A template's `id`. Code Connect uses it to tell one published mapping from another across
 * publishes, so it must not move when a component is renamed or an export is re-run — the node
 * id is the one fact about a component that holds still.
 */
export function codeConnectId(nodeId: string): string {
  return `allcrew-${urlNodeId(nodeId)}`
}

/**
 * The design file's key, out of whatever a person pasted: a bare key, or any figma.com link to the
 * file (`/design/`, `/file/`, `/proto/`, a branch link). Null when there is none to find — a key
 * is never guessed, because a template published against the wrong file maps nothing and says
 * nothing.
 */
export function fileKeyFrom(input: string | undefined | null): string | null {
  const text = String(input ?? '').trim()
  if (text === '') return null
  if (/^[A-Za-z0-9]{10,}$/.test(text)) return text
  const branch = /figma\.com\/(?:design|file|proto)\/[A-Za-z0-9]+\/[^/?#]*\/branch\/([A-Za-z0-9]{10,})/.exec(text)
  if (branch) return branch[1]
  const file = /figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]{10,})/.exec(text)
  return file ? file[1] : null
}

/** The value expression for one prop: the `figma.selectedInstance` accessor its Figma type maps to. */
function accessor(prop: CodeConnectProp): string {
  const figmaName = sq(stripPropSuffix(prop.figmaName))
  if (prop.kind === 'boolean') return `instance.getBoolean(${figmaName})`
  if (prop.kind === 'text') return `instance.getString(${figmaName})`
  const entries = (prop.values ?? []).map((value) => `${objectKey(value)}: ${sq(value)}`).join(', ')
  return `instance.getEnum(${figmaName}, { ${entries} })`
}

/** A `<Component>.figma.ts` template, ready for `npx figma connect publish` to read. */
export function codeConnectFile(options: CodeConnectFileOptions): string {
  const importPath = `./${options.componentPath.replace(/^src\//, '').replace(/\.tsx?$/, '')}`
  const names = [...options.props.keys()]
  const values =
    names.length === 0
      ? ''
      : `const instance = figma.selectedInstance\n` +
        `const props = {\n${names.map((name) => `  ${objectKey(name)}: ${accessor(options.props.get(name)!)},`).join('\n')}\n}\n\n`
  // `renderProp` formats each value the way JSX writes it — a bare `disabled`, a quoted string,
  // nothing at all for `false` — and keeps the snippet an array of sections, which string
  // concatenation would flatten into plain text Dev Mode can no longer render pills from.
  const attrs = names.map((name) => `\${figma.helpers.react.renderProp(${sq(name)}, props[${sq(name)}])}`).join('')

  return (
    `// url=${componentUrl(options.fileKey, options.fileName, options.nodeId)}\n` +
    `// source=${options.componentPath}\n` +
    `// component=${options.componentName}\n` +
    `import figma from 'figma'\n\n` +
    values +
    `export default {\n` +
    `  example: figma.code\`<${options.componentName}${attrs} />\`,\n` +
    `  imports: [${sq(`import { ${options.componentName} } from '${importPath}'`)}],\n` +
    `  id: ${sq(codeConnectId(options.nodeId))},\n` +
    `  metadata: { nestable: true },\n` +
    `}\n`
  )
}

/** `figma.config.json` for a repository of template files — no parser, which 2.x refuses. */
export const CODE_CONNECT_CONFIG = {
  codeConnect: { include: ['src/components/**/*.figma.ts'], label: 'React', language: 'jsx' },
}
