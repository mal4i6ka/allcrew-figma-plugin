/**
 * The plugin's own command surface, read off the source that implements it.
 *
 * Every feature this plugin has — the exporters, the palette generator, the colour-token
 * remap, the board drawer, the linter's batch fix — already exists as one `case` in the
 * UI→sandbox switch in `code.ts`. The agent channel used to reach none of it: an op had to be
 * hand-written per capability, so the listener was always a subset of the plugin, and always
 * behind it.
 *
 * So the registry is not maintained — it is *extracted*. `build.mjs` runs `extractUiCommands`
 * over `src/code.ts` at bundle time and injects the result, which means a `case` added
 * tomorrow is callable by an agent the moment it is built, with nothing to register and
 * nothing to keep in sync. The parser is deliberately dumb (a switch is a flat list of string
 * literals, which is exactly what makes this safe to do by regex) and its output is
 * best-effort *description*, never permission: what an agent may actually run is decided by
 * the gates, and by the `@agent` marker each case carries.
 *
 * The marker is the one thing a human writes, on the case itself where it can be reviewed
 * next to the code it describes:
 *
 *     case 'PREVIEW_PALETTE': {
 *       // @agent read: recompute the palette from settings — pure maths
 *
 * `read` (no side effects), `write` (touches the document, stored settings, or the network) or
 * `deny` (never reachable through the channel). A case with no marker is treated as a write:
 * an unclassified command is one nobody has thought about, and guessing "harmless" is how a
 * read gate ends up authorising a mutation.
 */

export type UiCommandAccess = 'read' | 'write' | 'deny'

export interface UiCommandParam {
  name: string
  required: boolean
  /** The TypeScript annotation, verbatim and trimmed. Names a type the agent cannot resolve as
   * often as it names a literal union it can, and both beat "some value goes here". */
  type?: string
}

export interface UiCommandDef {
  /** The `msg.type` the sandbox switches on, e.g. `REMAP_BOARD`. */
  name: string
  access: UiCommandAccess
  /** False when the source carried no `@agent` marker — reported so an agent can see that the
   * write classification is an assumption rather than a statement. */
  classified: boolean
  /** From the marker. Absent on unclassified commands, which have nothing to quote. */
  summary?: string
  /** What the message may carry, from the `PluginMessage` union that declares it — the case
   * body is scraped too, for anything the union has drifted away from. */
  params: readonly UiCommandParam[]
  /** Reply types posted from inside the case. Best-effort: a reply sent from a helper the case
   * calls is not visible here, so this is a hint for what to expect, not a contract. */
  replies: readonly string[]
}

/** Where the extractor starts reading. Cases above this point belong to other switches — the
 * palette source resolver has its own, in lowercase. Rename the handler and the build fails
 * loudly on an empty table rather than shipping one. */
const HANDLER_ANCHOR = 'async function handleUiMessage'

const CASE_PATTERN = /case '([A-Z][A-Z0-9_]*)':/g
const MARKER_PATTERN = /@agent\s+(read|write|deny)\s*:\s*([^\n]*)/
const PARAM_PATTERN = /\bmsg\.([A-Za-z_$][A-Za-z0-9_$]*)/g
/** Both spellings: the sandbox posts through `postToUi` (see `ui-post.ts`), and a call site that
 * still names the host method directly is one this should not go blind on. */
const REPLY_PATTERN = /post(?:ToUi|Message)\(\s*\{\s*(?:\/\/[^\n]*\n\s*)*type:\s*'([A-Za-z][A-Za-z0-9_]*)'/g

export function extractUiCommands(source: string): UiCommandDef[] {
  const start = source.indexOf(HANDLER_ANCHOR)
  if (start < 0) return []
  const handler = source.slice(start)
  const declared = extractDeclaredParams(source)

  const found: Array<{ name: string; at: number; labelAt: number }> = []
  CASE_PATTERN.lastIndex = 0
  for (let match = CASE_PATTERN.exec(handler); match; match = CASE_PATTERN.exec(handler)) {
    found.push({ name: match[1], at: match.index + match[0].length, labelAt: match.index })
  }

  const commands = found.map((entry, index) => {
    // The body ends where the next label starts — not where it ends, or every case would be
    // credited with the next one's name and a fall-through would look like it had code.
    const body = handler.slice(entry.at, index + 1 < found.length ? found[index + 1].labelAt : handler.length)
    const marker = MARKER_PATTERN.exec(body)
    const summary = marker?.[2].trim()

    return {
      name: entry.name,
      access: (marker?.[1] as UiCommandAccess | undefined) ?? 'write',
      classified: marker !== null,
      ...(summary ? { summary } : {}),
      params: mergeParams(
        declared.get(entry.name) ?? [],
        matchesOf(PARAM_PATTERN, body).filter((param) => param !== 'type')
      ),
      replies: repliesIn(body),
      // A label with nothing but its marker between it and the next one is a fall-through: the
      // code that serves it is the block below, and so are its params.
      fallsThrough: stripComments(body).trim() === '',
    }
  })

  for (let index = commands.length - 2; index >= 0; index--) {
    const command = commands[index]
    if (!command.fallsThrough) continue
    command.params = commands[index + 1].params
    command.replies = commands[index + 1].replies
  }

  return commands.map(({ fallsThrough, ...command }) => command)
}

function stripComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** Union first (it knows what is optional), then anything the body reads that the union has
 * forgotten — a drifted type is a reason to report more, not less. */
function mergeParams(declared: readonly UiCommandParam[], scraped: readonly string[]): UiCommandParam[] {
  const out = declared.map((param) => ({ ...param }))
  for (const name of scraped) {
    if (!out.some((param) => param.name === name)) out.push({ name, required: false })
  }
  return out
}

/* --------------------------------------------------- the message type declaration */

const UNION_ANCHOR = 'type PluginMessage ='

/**
 * The params each command accepts, read off the discriminated union that types the handler.
 *
 * Scraping `msg.<key>` from the body finds most of them, but not the ones a case destructures
 * (`const { scope, modules } = msg`) and never which are optional — and "which of these must I
 * send" is the first thing an agent needs to know. The union is the declaration, so it is the
 * better source; the scrape stays as a safety net.
 */
function extractDeclaredParams(source: string): Map<string, UiCommandParam[]> {
  const out = new Map<string, UiCommandParam[]>()
  const start = source.indexOf(UNION_ANCHOR)
  if (start < 0) return out

  // The union runs to the first blank line — every member is a `| { … }` alternative, and the
  // declaration is one paragraph by convention in this file.
  const end = source.indexOf('\n\n', start)
  const union = source.slice(start, end < 0 ? source.length : end)

  for (let index = union.indexOf('{'); index >= 0; index = union.indexOf('{', index + 1)) {
    const member = balancedFrom(union, index)
    if (!member) continue
    const name = /type:\s*'([A-Z][A-Z0-9_]*)'/.exec(member)?.[1]
    if (name) out.set(name, fieldsOf(member))
    index += member.length - 1
  }
  return out
}

/** The `{ … }` starting at `at`, brace-balanced, or null if it never closes. */
function balancedFrom(text: string, at: number): string | null {
  let depth = 0
  for (let index = at; index < text.length; index++) {
    if (text[index] === '{') depth++
    else if (text[index] === '}' && --depth === 0) return text.slice(at, index + 1)
  }
  return null
}

function fieldsOf(member: string): UiCommandParam[] {
  const inner = member.slice(1, -1)
  const fields: UiCommandParam[] = []

  // Split on `;` and newlines, but only at the member's own level: `Array<{ name: string;
  // text: string }>` is one field, not three.
  let depth = 0
  let segment = ''
  const push = () => {
    const match = /^\s*(\w+)(\?)?\s*:\s*([\s\S]+?)\s*$/.exec(segment)
    segment = ''
    if (!match || match[1] === 'type') return
    // Cut types that run long, but say so: a nested object type sliced mid-way reads as a
    // complete annotation that happens to be missing its closing brace.
    const full = match[3].replace(/\s+/g, ' ')
    const type = full.length > 120 ? `${full.slice(0, 119)}…` : full
    fields.push({ name: match[1], required: match[2] !== '?', ...(type ? { type } : {}) })
  }
  for (const char of inner) {
    if (char === '{' || char === '(' || char === '<') depth++
    else if (char === '}' || char === ')' || char === '>') depth--
    if (depth === 0 && (char === ';' || char === '\n')) {
      push()
      continue
    }
    segment += char
  }
  push()
  return fields
}

/**
 * Some replies are posted for a case rather than by it, from a helper it calls. Those are
 * invisible to a regex over the case body — and the two that matter are the ones a caller most
 * needs to expect: a refusal, and the selection notice that rides along with a scan. Named
 * here rather than inlined at every call site, which would trade one blind spot for forty
 * copies of the same three lines.
 */
const HELPER_REPLIES: ReadonlyArray<{ call: string; posts: string }> = [
  { call: 'refuse(', posts: 'COMMAND_REFUSED' },
  { call: 'postSelectionToUi(', posts: 'SELECTION_CHANGED' },
]

function repliesIn(body: string): string[] {
  const found = matchesOf(REPLY_PATTERN, body)
  for (const helper of HELPER_REPLIES) {
    if (body.includes(helper.call) && !found.includes(helper.posts)) found.push(helper.posts)
  }
  return found
}

function matchesOf(pattern: RegExp, text: string): string[] {
  const seen: string[] = []
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (!seen.includes(match[1])) seen.push(match[1])
  }
  return seen
}

/* ------------------------------------------------------------------ the built-in registry */

/**
 * Replaced at bundle time with the extraction of `src/code.ts` — quoted, so this file stays
 * valid and diffable on its own, the same way `ui.html` carries its script embeds.
 *
 * Recomputed on every rebuild (watch included), which is what makes the registry impossible to
 * drift: there is no committed copy to forget. Under `node --test` the marker is still itself,
 * the registry is empty, and the parser is tested against the real source directly.
 */
const INJECTED = '__ALTERY_UI_COMMANDS__'

export const UI_COMMANDS: readonly UiCommandDef[] = (() => {
  // Tested by shape, not against the marker spelled a second time: the injection replaces one
  // literal, and a file with two of them would make which one gets replaced depend on the
  // order they happen to appear in.
  if (!INJECTED.startsWith('[')) return []
  try {
    const parsed: unknown = JSON.parse(INJECTED)
    return Array.isArray(parsed) ? (parsed as UiCommandDef[]) : []
  } catch {
    return []
  }
})()

export const UI_COMMANDS_BY_NAME: ReadonlyMap<string, UiCommandDef> = new Map(
  UI_COMMANDS.map((command) => [command.name, command])
)
