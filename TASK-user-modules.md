# Task: user modules (a panel anyone can design, in the canonical look)

> **The production contract is complete (2026-09-19).** Modules now have a published Draft
> 2020-12 JSON Schema and starter file, strict unknown-key diagnostics, bounded typed state,
> conditional screens and steps, version-aware upgrades, storage budgets, inline permission
> review, direct `modules.*` agent operations, redacted secrets, and an end-to-end browser/agent
> authoring path. Modules remain declarative by design: no arbitrary HTML, JavaScript, network
> access, loops, or undeclared persistence.

## Problem

Adding a capability to this plugin means editing its source: a `case` in `src/code.ts`, a panel
in `ui.html`, a build. That is fine for whoever owns the repository and impossible for everyone
else. A designer who wants "scan the file, map it onto our library, draw the board, export the
mapping" as one button has to ask for it and wait.

They should be able to write it, keep it in a file, hand it to a colleague, and have it appear
in the picker looking exactly like the panels that shipped with the plugin.

## Settled rules

These came out of the session that produced the agent channel; treat them as fixed.

- **The manifest is the shape the channel already speaks.** A module declares its commands in
  the same form `plugin.commands` serves for native ones — name, summary, params with
  `required`/`type`/`shape`/`note`, replies. `plugin.commands` merges both lists and
  `plugin.call` dispatches to either, so an agent sees no difference between a module somebody
  wrote this morning and a feature that shipped in the build.
- **Screens are declared, never authored as markup.** A module ships a *screen spec* rendered
  by the plugin's own components. It therefore cannot break the canonical design, cannot inject
  script into the panel, and can be validated. Free HTML would lose all three.
- **A module does not declare its own permissions.** `access` is *derived* from the native
  commands its steps call: any write anywhere makes the module command a write. A file that
  declares its own `access` is refused — telling the gate what you are is not a module's job.
- **v1 composes, it does not compute.** A step calls a command that already exists and moves a
  value from one place to another. No expressions, no loops, no code. Most of what a module
  wants to be is a pipeline over the existing surface with a form in front, and that version
  needs no new trust.
- **Nothing runs that cannot be named.** A step naming a command this build does not have makes
  the module invalid — never silently skipped. The install screen lists exactly which commands
  the module may run and which of them write, and that list is derived from the file, not from
  a claim inside it.
- **Failure is per entry.** The parser reports every problem it finds with the path that caused
  it, and never throws. One bad block disables one module with a reason on screen, not the
  panel.
- **The listener is the test bench.** A module's commands are callable through `plugin.call`
  before it has any UI, and its screens validate headlessly — so a module can be built and
  checked by an agent without a human clicking anything.

## The contract

```jsonc
{
  "module": "allcrew-channel.module/1",       // format and version, refused if unknown
  "id": "acme.contrast-audit",       // [a-z0-9][a-z0-9.-]*, namespaces storage and commands
  "name": "Contrast audit",          // the picker entry
  "summary": "Audit text/background pairs against the library.",
  "version": "1.0.0",
  "author": "Acme",                  // free text — a label, never an identity claim

  "state": {                         // keys: [A-Za-z][A-Za-z0-9_-]*; dots delimit references
    "libraryKey": { "type": "string", "default": "", "label": "Library collection" },
    "onlyText":   { "type": "boolean", "default": true }
  },

  "screens": {
    "main":     { "blocks": [ … ] },
    "settings": { "blocks": [ … ] }  // optional
  },

  "commands": [                      // what the module exposes to an agent
    {
      "name": "acme.contrast-audit.run",   // must start with the module id
      "summary": "Scan, map onto the library, draw the board.",
      "params": [ { "name": "libraryKey", "required": true, "type": "string" } ],
      "steps": [ … ]
    }
  ]
}
```

**Blocks** (v1): `heading`, `text`, `callout`, `field`, `value`, `select`, `toggle`, `button`,
`table`, `list`, and `code`. A block that reads or writes a value carries `bind`, naming a
declared state field; `value` shows one without offering to edit it; a `button` carries `steps`.
Blocks may carry a typed `when` condition; interactive blocks may also carry `disabledWhen`.
`field` renders strings, bounded numbers, multiline values, and secret strings using the
panel's own controls. `table`, `list`, and `code` render transient step results without
persisting those potentially large values.

**Layout is the panel's, not the author's.** A screen splits into sections at each `heading`,
and every section renders in one fixed order — prose, then the controls you set, then the values
you read, then the data, then the buttons, side by side at the bottom. Order in the file is not
layout, which is why any module comes out with the panel's own rhythm and why there is no
`spacer`: a block whose only job is to push things apart would be an invitation to fight the
rules. To put a button in the middle of a screen, start a new section — that is what a heading
is for. A module's `settings` screen renders in the panel's Settings sub-page, under the
module's name, next to every other target's options.

**Steps** (v1), in order, each one of:

- `{ "call": "REMAP_SCAN", "params": { … }, "as": "inventory" }` — run a native command and
  keep its reply under a name.
- `{ "set": "libraryKey", "from": "inventory.stats.variables" }` — move a value into state.
- `{ "confirm": "This rewrites 540 variables." }` — stop and ask. Through the listener this
  means the call is refused unless it carried `confirm: true`.

**References.** A param value is a literal unless it is `{ "from": "<path>" }`, where the path
starts with a state field, a declared module-command parameter, or an earlier step's `as` name.
Deliberately not a template language: `{{…}}` invites expressions, and an expression is code
by another name.

**Derived, not declared:** `access` (write if any step calls a write), the capability list, and
the cost note (the union of the costs of the commands it calls).

**State and upgrades.** State is limited to declared string, finite number, and boolean fields.
Number bounds are enforced on UI writes, agent writes, stored values, and pipeline output.
`secret: true` is valid only for strings: the panel receives only whether the value is set,
shows an empty password field with explicit replace/clear actions, and agent inspection,
screen reads, run reports and exports omit the value. Upgrades follow SemVer, preserve values
that still match the new declaration, add new defaults, and drop removed or incompatible
fields. Downgrades require an explicit flag.

**Conditions.** `when` and `disabledWhen` name a reachable value with exactly one of `equals`,
`notEquals`, `oneOf`, `truthy`, or `exists`. Steps use the same language. It is intentionally
not an expression engine: there is no evaluation, interpolation, I/O, or loop.

## Staging

| Stage | What | State |
|-------|------|-------|
| 1 | Contract + validator + tests, pure, no I/O | **done** |
| 2 | Storage, import/export, merge into `plugin.commands` / `plugin.call` | **done** |
| 3 | Screen rendering with the plugin's own components | **done** |
| 4 | Picker section, install consent, enable/disable/remove | **done** |
| 5 | JSON Schema, conditions, versioned migrations, storage/security limits | **done** |
| 6 | Direct agent authoring/import ops and live permission review | **done** |

Stage 2 before stage 3 on purpose, and it paid twice: the contract was exercised through the
listener before any interface was drawn against it, and both times the first real run found
something the tests could not — references that resolved only at the top level of a param, and
a declared state type that nothing enforced on write.

## What already exists and is reused

| Need | Existing code |
|------|---------------|
| The manifest shape | `src/agent/ui-commands.ts` — `UiCommandDef`, extracted for native commands |
| Dispatch and per-command gating | `src/agent/plugin-ops.ts` — `plugin.call`, `mutatesWhen` |
| A declarative block vocabulary to grow from | `src/agent/board.ts` — `renderBoard` |
| Reply digesting, files instead of payloads | `src/agent/reply-digest.ts` |
| Per-entry problem reporting | the write ops' reports, `cli/allcrew_channel` |

## Deliberate boundaries

- **Storage is bounded.** A module file is capped at 200 KB, persisted scalar state at 32 KB,
  the complete module store at 1 MB, and one installation at 64 modules. The limits are part of
  the authoring response rather than implementation trivia.
- **Sharing stays file-based.** `modules.export` and the panel's Save action produce a portable
  JSON document. Installing from a URL would expand the plugin-wide network allowlist and create
  an update authority; modules therefore do not fetch themselves.
- **Conditions are not expressions.** The pure comparison language covers visibility,
  enablement, and conditional steps without opening an evaluator. More operators should be
  added only as data, with matching schema and parser support.
- **Arbitrary code is not a module feature.** `sandbox.eval` would need a separate, explicit
  trust model and mutation journal. A declarative module never acquires that authority merely
  by being installed.
