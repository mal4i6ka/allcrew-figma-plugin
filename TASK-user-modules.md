# Task: user modules (a panel anyone can design, in the canonical look)

> **Stage 1 of 4 landed: the contract and its validator.** `src/modules/contract.ts` parses a
> module file, reports every problem with the path that caused it, and derives what the module
> can actually do. Nothing loads modules yet — that is stage 2.

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
  "module": "altery.module/1",       // format and version, refused if unknown
  "id": "acme.contrast-audit",       // [a-z0-9][a-z0-9.-]*, namespaces storage and commands
  "name": "Contrast audit",          // the picker entry
  "summary": "Audit text/background pairs against the library.",
  "version": "1.0.0",
  "author": "Acme",                  // free text — a label, never an identity claim

  "state": {                         // every value a screen can read or write
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
`table`. A block that reads or writes a value carries `bind`, naming a declared state field;
`value` shows one without offering to edit it; a `button` carries `steps`.

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
starts with a state field or an earlier step's `as` name. Deliberately not a template language:
`{{…}}` invites expressions, and an expression is code by another name.

**Derived, not declared:** `access` (write if any step calls a write), the capability list, and
the cost note (the union of the costs of the commands it calls).

## Staging

| Stage | What | State |
|-------|------|-------|
| 1 | Contract + validator + tests, pure, no I/O | **done** |
| 2 | Storage, import/export, merge into `plugin.commands` / `plugin.call` | next |
| 3 | Screen rendering with the plugin's own components | |
| 4 | Picker section, install consent, enable/disable/remove | |

Stage 2 before stage 3 on purpose: the contract gets exercised through the listener before any
interface is drawn against it.

## What already exists and is reused

| Need | Existing code |
|------|---------------|
| The manifest shape | `src/agent/ui-commands.ts` — `UiCommandDef`, extracted for native commands |
| Dispatch and per-command gating | `src/agent/plugin-ops.ts` — `plugin.call`, `mutatesWhen` |
| A declarative block vocabulary to grow from | `src/agent/board.ts` — `renderBoard` |
| Reply digesting, files instead of payloads | `src/agent/reply-digest.ts` |
| Per-entry problem reporting | the write ops' reports, `cli/altery_dj` |

## Open questions

- **Storage budget.** `figma.clientStorage` is the obvious home, namespaced by module id. Its
  real per-key and total limits need measuring before a module can be told what it may keep.
- **Updates.** A module file carries a `version`; nothing yet decides what happens when a newer
  one is imported over an older one that has stored state.
- **Sharing.** Import/export is a file. Whether the plugin should also fetch a module from a URL
  is a network question the manifest's `allowedDomains` makes plugin-wide, so the answer is
  probably no.
- **v2 expressions.** Enablement (`disabled when the field is empty`) is the first thing a real
  module will want that v1 cannot express. A tiny pure language, evaluated by the plugin, with
  no I/O and no loops — worth designing only once v1 has users.
- **v3 code** is `sandbox.eval`, already decided separately: a third gate, off by default, with
  a `figma` Proxy and a mutation journal. User modules and that decision are the same door from
  two sides.
