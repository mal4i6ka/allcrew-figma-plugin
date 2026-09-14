/**
 * Agent listener — playbooks.
 *
 * The op manifest says what exists and how to call one op. It does not say in which order to
 * call five of them, and that is the part a fresh agent gets wrong: it screenshots a frame and
 * writes CSS from the pixels while the file could have told it the token, the variant and the
 * transition. A playbook is the missing layer — a named task, the ops it takes, in order, and
 * what to check when it is done.
 *
 * Rules this file lives by, borrowed from the module contract (`src/modules`):
 *
 * - **Nothing is named that does not exist.** Every step names a registered op, and every
 *   example param names a param that op declares. A test enforces both, so a renamed op breaks
 *   the build rather than sending an agent at a command the build does not have.
 * - **Guidance lives on the op; the playbook orders it.** Steps say *why now* — one sentence
 *   of sequencing. What the op itself does is already on `OpDef.summary`/`OpDef.agent`, and
 *   `guide.get` serves those alongside the steps so an agent needs one call, not five.
 * - **Target-agnostic.** A playbook never mentions React, Django or SwiftUI. What comes back
 *   from `design.ir` is a tree of layout, type, colour and interaction; which framework it
 *   becomes is the agent's problem and none of the plugin's business.
 */

export interface GuideStep {
  /** Registered op name — checked against the registry by test. */
  op: string
  /** Why this op at this point in the task, in one sentence. */
  why: string
  /** Example call, param names checked against the op's own spec. */
  params?: Record<string, unknown>
  /** The step runs once per item found by an earlier step (frames, components, assets). */
  each?: string
}

export interface Guide {
  /** `subject.task`, stable — an agent may cite it back. */
  id: string
  title: string
  /** What the agent will have when the playbook is finished. */
  goal: string
  /** When to reach for this one instead of a neighbouring playbook. */
  when: string
  steps: readonly GuideStep[]
  /** How to know it worked — written as things to verify, not as reassurance. */
  checks?: readonly string[]
  /** Traps this task has: what the file will not tell you, what costs a lot, what is a write. */
  notes?: readonly string[]
}

export const GUIDES: readonly Guide[] = [
  {
    id: 'file.bootstrap',
    title: 'First contact with a file',
    goal: 'Know what this file contains — pages, screens, components, tokens — before touching anything.',
    when: 'Always first. Every other playbook assumes the names this one hands back.',
    steps: [
      {
        op: 'document.info',
        why: 'Confirms which file the channel is actually attached to, and its pages.',
      },
      {
        op: 'page.frames',
        why: 'Names the screens and sections on a page — every later op is addressed by node id.',
      },
      {
        op: 'components.list',
        why: 'The vocabulary of the file: component sets with their variants and property definitions.',
        params: { scope: 'document' },
      },
      {
        op: 'variables.get',
        why: 'The token layer. Read it before any colour or spacing decision — values without token names are guesses.',
      },
      {
        op: 'styles.list',
        why: 'Text/paint/effect styles are the other half of the system; a file usually uses both.',
      },
    ],
    checks: [
      'Every screen you plan to build has a node id you read from page.frames, not one you guessed.',
      'You can name the token behind at least one colour on the screen.',
    ],
    notes: [
      'Open the plugin in Figma and this answers from the live document. With it closed, name the file (`fileKey`, or the `ALTERY_FIGMA_FILE_KEY` default) and the bridge answers the read-only half over Figma’s REST API instead — every such answer is marked `source: "rest"`, and `GET /ops` lists what REST can still do.',
      'Reads are gated: "Allow reads" in the plugin panel. Writes never ride along with it.',
    ],
  },

  {
    id: 'screen.build',
    title: 'Turn a screen into code',
    goal: 'A framework-agnostic description of one screen — layout, type, colour as tokens, assets, interactions — plus a way to check what you built against it.',
    when: 'You have a frame and need it implemented in any stack: web, desktop or mobile.',
    steps: [
      {
        op: 'design.ir',
        why: 'The whole screen as a tree: stacks, sizing, typography, paints with their token names, text, interactions.',
        params: { nodeId: '1:16' },
      },
      {
        op: 'assets.export',
        why: 'The pictures the IR only points at — vectors and photos, in the formats and scales your target needs.',
        params: { nodeId: '1:16', select: 'assets', naming: 'web' },
      },
      {
        op: 'design.context',
        why: 'Figma’s own reference rendering of the node, for the cases where the IR leaves you unsure how it should look.',
        params: { nodeId: '1:16' },
      },
      {
        op: 'design.measure',
        why: 'After you build it: the design’s own numbers per layer, so a mismatch names a property instead of a percentage.',
        params: { nodeId: '1:16' },
      },
    ],
    checks: [
      'Every colour and spacing value in your code traces to a token name from the IR, not to a hex you read off a render.',
      'design.measure on the implemented screen disagrees with your build on nothing you did not decide to change.',
    ],
    notes: [
      'design.ir is a description, not code generation: no framework is assumed and none is emitted.',
      'A screen drawn at two widths is two frames — read both and diff them with frames.compare rather than guessing the breakpoint.',
    ],
  },

  {
    id: 'mobile.app',
    title: 'Build a mobile app from a file',
    goal: 'Screens, navigation, per-density assets and motion for an iOS/Android/React Native build.',
    when: 'The target is a mobile app rather than a page.',
    steps: [
      {
        op: 'page.frames',
        why: 'Mobile screens are frames on a page; this names them and their sizes.',
      },
      {
        op: 'design.ir',
        why: 'One call per screen. Auto-layout comes back as stacks with gap/padding/alignment, which is the model RN, SwiftUI and Compose all express, `type` is the table of text styles it is set in, and `screen` names what sits in the system bands, what is pinned and how much is placed by coordinates.',
        each: 'screen',
        params: { nodeId: '1:16' },
      },
      {
        op: 'component.api',
        why: 'The screen instantiates components; this is how to declare one. Axes with their options and defaults are the enum, `changes` is what each value does (with the token behind each value), and a boolean/text property names the layer it drives. design.ir\'s `components[].componentSetId` is the id to pass.',
        each: 'component the screens use',
        params: { nodeId: '819:95512' },
      },
      {
        op: 'assets.export',
        why: 'Icons and images at the densities the platform asks for, with a manifest that already names where each file goes.',
        each: 'screen',
        params: { nodeId: '1:16', select: 'assets', naming: 'ios', scales: [1, 2, 3] },
      },
      {
        op: 'flow.map',
        why: 'The prototype graph is the navigation graph: which screen leads where, on what trigger, and with which transition - each edge carries `curve`, the easing as numbers a native animation API takes.',
      },
      {
        op: 'transition.context',
        why: 'Smart Animate between variants — what actually moves between two states, and which mechanism reproduces it.',
        params: { nodeId: '1:16' },
      },
    ],
    checks: [
      'Every tap target in your build corresponds to a reaction reported by flow.map, and every destination exists.',
      'Assets land at every density the manifest lists — a missing @3x is a blurry icon on the newest phone.',
    ],
    notes: [
      'Figma has no safe-area concept: a status bar drawn in the frame is a layer like any other, and it is your call whether to build it or to inset for the real one.',
      'Vector assets export as SVG; converting them to Android vector drawables or SF Symbols is the build’s job, not the plugin’s. With `naming: "ios"` each imageset also comes with the Contents.json that makes it one - a vector goes in single-scale, with `preserves-vector-representation`.',
      'Animate from a transition’s `curve`, not from the CSS `timingFunction` beside it: a spring arrives there as eighty sampled points, and `curve` carries the damping ratio, stiffness and solved settle time instead.',
    ],
  },

  {
    id: 'system.extract',
    title: 'Extract the design system',
    goal: 'Tokens, styles and the component vocabulary, in a shape a codebase can consume.',
    when: 'You are setting up a project, not implementing one screen.',
    steps: [
      {
        op: 'variables.get',
        why: 'Collections, modes and values, each token with its description and per-platform codeSyntax.',
      },
      {
        op: 'library.collections',
        why: 'A file usually leans on a library it does not own; this names those collections.',
      },
      {
        op: 'library.variables',
        why: 'Reads the borrowed palette itself, so aliases do not come back as dangling keys. Pass `resolve: true` or a theme collection answers with alias ids where you asked for colours.',
        params: { collectionKey: '<from library.collections>', resolve: true },
      },
      {
        op: 'components.list',
        why: 'Component sets with variant axes and property definitions — the props your components will take.',
        params: { scope: 'document', limit: 100 },
      },
      {
        op: 'component.api',
        why: 'Per component, the half components.list cannot answer: what each variant value CHANGES, with the token behind each value, and which layer a boolean/text property drives.',
        each: 'component worth declaring',
        params: { nodeId: '819:95512' },
      },
      {
        op: 'plugin.commands',
        why: 'The panel’s own exporters (tokens, CSS, a whole project) are callable through plugin.call when a ready-made package beats a bespoke one.',
      },
    ],
    checks: [
      'Every alias resolves to a variable you can name, in this file or in a library collection.',
      'Component property names are copied verbatim, typos included — the file is the contract, not your spelling of it.',
      'The token package you build has the file’s THEME in it: a package with one mode, from a file whose Light/Dark lives in a library, is the library read having been skipped.',
    ],
    notes: [
      'The token package comes from `plugin.call` on `SCAN_TOKENS`. Its `tokens` params decide what is in it: `includeLibraries: true` reads the enabled libraries (slow — measured at 44 s on a file with 213 library variables — and the only way to export a theme this file consumes rather than owns), `emitNative: true` adds the iOS asset catalogue, `res/values-night/colors.xml`, `Tokens.swift` and `Tokens.kt` beside the CSS.',
      'Left local-only, the answer’s `summary.notes` names the library collections it did not include — a package with no theme in it says so rather than looking complete.',
    ],
  },

  {
    id: 'motion.implement',
    title: 'Implement motion',
    goal: 'The animations a file already describes, in a backend that suits the target.',
    when: 'The design has animation styles, prototype transitions, or hover/press states.',
    steps: [
      {
        op: 'motion.context',
        why: 'Keyframe tracks with easing as a name AND as numbers (`curve`), what they compile to, and which backend fits — with the reasoning, not just the verdict. Building off the web? `target: "native"`: the css/gsap verdict and its files are a browser answer.',
        params: { nodeId: '1:16' },
      },
      {
        op: 'node.states',
        why: 'Hover/press/overlay as property-level deltas between variants, instead of a wall of CSS.',
        params: { nodeId: '1:16' },
      },
      {
        op: 'transition.context',
        why: 'Smart Animate between two variants, emitted as transitions, a FLIP toggle or View Transitions. An empty answer names which empty it is — instant links, or states that live in a variant axis rather than in the prototype.',
        params: { nodeId: '1:16', strategy: 'all' },
      },
      {
        op: 'motion.preview',
        why: 'A page that actually runs the animation — the difference between “wrong” and “nothing ran”.',
        params: { nodeId: '1:16' },
      },
    ],
    notes: [
      'When the Motion beta is off for the account, motion.context says so outright; a static answer and “I cannot see animation” are different facts.',
    ],
  },

  {
    id: 'fidelity.check',
    title: 'Close the gap between build and design',
    goal: 'Named differences between what you built and what the file says, instead of a similarity percentage.',
    when: 'The screen is implemented and looks nearly right.',
    steps: [
      {
        op: 'design.measure',
        why: 'Figma’s own CSS and boxes per layer, addressed by a path that survives re-reading.',
        params: { nodeId: '1:16' },
      },
      {
        op: 'frames.compare',
        why: 'When two widths disagree, this says which layers differ and which exist on one side only.',
        params: { a: '1:16', b: '1:20' },
      },
      {
        op: 'node.screenshot',
        why: 'A render to look at once the numbers agree — a last human check, not the measurement itself.',
        params: { nodeId: '1:16', scale: 2 },
      },
    ],
    checks: [
      'Each remaining difference is a decision you can state, not a number you cannot explain.',
    ],
  },

  {
    id: 'document.write',
    title: 'Change the document safely',
    goal: 'A write that lands where intended, and is visible to the designer watching the panel.',
    when: 'You are about to modify the file — bind variables, create tokens, draw a board, rename.',
    steps: [
      {
        op: 'sandbox.capabilities',
        why: 'Says what this runtime allows before you plan anything that depends on it.',
      },
      {
        op: 'lint.colors',
        why: 'Find what is actually wrong first: layers painted with a raw colour instead of a variable.',
      },
      {
        op: 'variables.rebind',
        why: 'Moves bindings from one variable to another; run it as a dry run first and read what it says it would move.',
        params: { dryRun: true },
      },
      {
        op: 'node.bind',
        why: 'Binds a layer property to a variable — the fix for a lint finding, one node at a time.',
      },
      {
        op: 'board.render',
        why: 'Leaves a documentation board in the file so the change is reviewable by a human, not only by a diff.',
      },
    ],
    notes: [
      'Writes need "Allow changes" in the panel, which never rides along with reads.',
      'Every write is echoed in the designer’s panel — the channel is not a back door, and should not be used as one.',
      'Prefer a dry run wherever an op offers one; the answer names what would change.',
    ],
  },
]

export interface GuideProblem {
  guide: string
  step: string
  problem: string
}

/**
 * Every step names a registered op, and every example param is a param that op declares.
 *
 * Same rule the module contract keeps: nothing runs that cannot be named. A playbook that
 * cites `design.ir` after someone renamed it would send a fresh agent at a command the build
 * does not have — and it would fail in front of a user, not in CI.
 */
export function validateGuides(
  guides: readonly Guide[],
  ops: ReadonlyMap<string, { params: Record<string, unknown> }>
): GuideProblem[] {
  const problems: GuideProblem[] = []
  for (const guide of guides) {
    for (const step of guide.steps) {
      const op = ops.get(step.op)
      if (!op) {
        problems.push({ guide: guide.id, step: step.op, problem: 'no such op in the registry' })
        continue
      }
      for (const param of Object.keys(step.params ?? {})) {
        if (!(param in op.params)) {
          problems.push({ guide: guide.id, step: step.op, problem: `op takes no param "${param}"` })
        }
      }
    }
  }
  return problems
}
