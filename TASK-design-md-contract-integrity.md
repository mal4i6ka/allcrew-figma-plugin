# Task: make the exported contract self-consistent (DESIGN.md / COMPONENTS.md integrity)

> **Status: CLOSED (2026-08-10).** All 7 findings fixed and covered by tests
> (595 passing, `npm test` + `npm run typecheck` + `npm run build` green).
> Resolution notes per finding at the bottom of this file.

## Problem

Implementation agents fail to build UI from the exported package — not because the
instructions are weak, but because they are **stricter than the data underneath
them and contradict it**. The contract forbids raw values and demands "stop and
report the gap", while the package itself names tokens that don't exist, ships
no usable spacing/radius layer, and presents icon search-tags as mandatory
behaviour contracts. A compliant agent deadlocks; a sloppy one invents values.

Observed on the `altery-agentic-dev` export (198 variables, 1634 components,
17 "contracts"). Screen/frame structure export is a separate task
(`TASK-allcrew-full-frame-export.md`); this task is about the integrity of the
design-tokens target itself.

## Findings → required fixes

### 1. Recipes name tokens that never shipped

- `src/targets/design-md/tokens-target.ts:166-167` — the DESIGN.md §8 recipe
  falls back to `var(--radius-md)` / `var(--spacing-md)` when no radius/spacing
  role exists. The generated file then violates its own §8 rule ("every `--…`
  name you wrote must appear in tokens.css").
- `src/tokens/engine.ts:1089` — the generated README hard-codes a `.button`
  example with `--colors-action-default`, `--spacing-md`, `--radius-md`.

**Fix:** examples must be built exclusively from tokens that actually shipped.
If a role has no tokens, omit that CSS line and emit an explicit gap note
("no spacing tokens exported — see §Unclassified / ask the designer") instead
of a plausible-looking fallback.

### 2. The numeric scale is exported but unusable by contract

The `Mesure` collection (`number/Base` = 8px, `number/Half` = 4px, …) is the
project's spacing/radius scale, but the variables are unscoped and keyword
classification (`src/targets/design-md/model.ts:117-126`) doesn't match
`number/*`, so all 19 land in **Unclassified** with the guardrail "treat them
as system internals". Combined with "no raw px", padding and border-radius
become unstylable: the honest agent must halt.

**Fix (layered):**
- Scope mapping already works (`model.ts:154-155`: `GAP` → spacing,
  `CORNER_RADIUS` → radius) — surface this in the export summary/audit as the
  primary recommendation to the designer ("scope the Mesure variables in Figma
  and re-export; the next export will state the property exactly").
- Add an export setting mapping a collection → role (e.g. `Mesure` →
  spacing) for files where scoping isn't practical.
- Until a numeric collection is classified, the DESIGN.md guardrail must say
  "use these for spacing/gap/radius, never raw px" rather than "system
  internals" — the current wording actively forbids the only legal values.

### 3. Icon search-tags are presented as behaviour contracts

`src/targets/design-md/component-docs.ts:149-152` treats **any** non-empty
Figma description as "**Behaviour contract — implement this:**". Icon libraries
store search keywords in descriptions, so 15 of 17 "contracts" in the observed
export are noise ("lock, privacy, security, protection, safe, key, keyhole…"),
and the Sidebar contract is the designer's markdown formatting test. Agents
that trust the section implement garbage; agents that learn to ignore it also
skip the one real contract (Progress bar fill logic).

**Fix:** classify descriptions before promoting them to contracts. Heuristics
that would already separate the observed data cleanly:
- comma-separated bare-word list with no sentence/verb structure → "search
  tags", render as metadata, exclude from the DESIGN.md §5 contract count;
- tiny vector components with no props (icon shape) get a weaker prior;
- keep the strong "implement this" framing only for descriptions with
  conditional/state language, resolved token mentions, or props referenced.

### 4. Mention matcher resolves bare digits

`src/targets/design-md/token-mentions.ts` — `CANDIDATE` accepts bare words
including single digits, and `buildMentionIndex` indexes every trailing path
part, so `letter-spacing/0` answers to the key `0`. Result: "0%" in the
Progress bar contract resolves to `letter-spacing/0`, "list item 1" in the
Sidebar description resolves to `letter-spacing/1` — confidently wrong rows in
the "Tokens named above" table.

**Fix:** a bare-word candidate must contain at least one letter (or be ≥2
chars) to enter the lookup; index trailing parts only for lookups of
reference-shaped mentions.

### 5. Real gaps in a real contract are silently dropped

The Progress bar contract names `L300`, `Y300`, `R500`. Only `L300` exists;
`Y300` and `R500` match nothing — but because bare words are "ordinary prose
until the table says otherwise", they are neither resolved nor reported. The
one genuine contract in the file ships with 2 of its 3 colors unresolvable and
**no stale-reference warning**.

**Fix:** inside a description that resolved ≥1 token, unmatched bare words
matching a ramp-step shape (`/^[A-Za-z]{1,2}\d{2,4}$/`, e.g. `Y300`, `R500`)
must be reported as stale references, same as reference-shaped mentions.
Separately (design-file fix, not plugin): add `Yellow/Y300` and `Red/R500` to
the palette or reword the contract.

### 6. Typography emission ships raw Figma float noise

`font-size/3xs` = `9.899999618530273px`, `line-height/3xs` =
`14.850000381469727px`. Also two near-duplicate steps (3xs 9.9px vs 2xs 10px)
that the guardrail "do not interpolate, pick the closest" turns into a
coin-flip.

**Fix:** round emitted px values to a sane precision (≤2 decimals; prefer 1).
Audit should flag scale steps closer than ~0.5px as probable design-file
duplicates.

### 7. COMPONENTS.md is unnavigable at icon-library scale

574 KB / 15k lines / 1634 entries, dominated by icons; duplicate component
names produce colliding markdown anchors (`Arrows / Arrow` ×4 →
`#arrows-arrow`), so the index's own links are ambiguous and "read the entry
before implementing" costs an agent most of its context budget.

**Fix:**
- split icon-classified components (per finding 3) into a compact
  `ICONS.md` (name / node id / preview table only); keep COMPONENTS.md for
  real components;
- de-duplicate anchors with the node id suffix (`#arrows-arrow--16-11919`),
  and use those ids in the index links.

## Acceptance

Re-export of the same Figma file yields a package where:

1. Every `var(--…)` mentioned anywhere in generated README/DESIGN.md exists in
   `tokens.css` (add this as a generator self-check test).
2. Spacing/radius are either role-classified (scopes or collection mapping) or
   explicitly delegated to the numeric scale — no path where the contract
   simultaneously forbids raw px and forbids the only shipped scale.
3. DESIGN.md §5 lists only genuine behaviour contracts (for the observed file:
   Progress bar, Sidebar-if-rewritten — not 15 icon tag-lists).
4. No "Tokens named above" row is produced from a bare digit; `Y300`/`R500`
   in the Progress bar contract are reported as stale references.
5. No emitted numeric token value has more than 2 decimal places.
6. Icon entries live in `ICONS.md`; all COMPONENTS.md index links resolve to a
   unique anchor.
7. Existing tests pass; new fixtures cover findings 1, 3, 4, 5 (the
   `altery-library` fixture already reproduces the observed export shape).

## Resolution (2026-08-10)

1. **Recipes/README from shipped tokens only.** `tokens-target.ts` builds the
   `.card` recipe per role and omits the line + emits an explicit gap note when
   a role has no tokens; the `tokens.color.surface`/`var(--radius-md)`-style
   fallbacks are gone. `engine.ts buildReadme` now takes the emitted tree and
   derives the `.button` example from real variables (dropped when none fit).
   Self-check test: every `var(--…)` in generated README/DESIGN.md must be
   declared in `tokens.css` (`tokens-target.test.ts`).
2. **Numeric scale usable.** New export setting **Collection roles**
   (`Mesure: spacing`) → `ExportTokensOptions.collectionRoles`, parsed by
   `parseCollectionRoles` (model.ts), applied in `buildTokenEntries` with
   `roleSource: 'collection'` (scopes and name keywords still win). Until a
   numeric collection is classified, the guardrail now says the scale **is**
   the spacing/radius layer ("use for padding/gap/border-radius, never raw
   px") and tells the designer to scope the variables or map the collection —
   the "system internals" quarantine applies only to non-numeric leftovers.
3. **Descriptions classified before promotion.** `classifyDescription`
   (component-docs.ts): comma-separated bare-word lists → `tags` (rendered as
   "Search tags:" metadata); conditional/state language, resolved token
   mentions, or referenced props → `contract` ("implement this" framing);
   everything else → `notes` ("Designer notes — context, not spec").
   Contract counts everywhere (COMPONENTS.md header, DESIGN.md §Component
   behaviour contracts) include only real contracts.
4. **No bare-digit mentions.** A bare word must contain a letter to enter the
   lookup — `0%` / `list item 1` can no longer resolve to `letter-spacing/0`;
   the reference-shaped spelling (`letter-spacing/0`) still resolves.
5. **Ramp-shaped stale references.** In a description that resolved ≥1 token,
   unmatched `/^[A-Za-z]{1,2}\d{2,4}$/` words are reported as stale references.
   (The design-file half — adding `Yellow/Y300` / `Red/R500` or rewording the
   Progress bar contract — remains with the designer; the export now surfaces
   it instead of dropping it.)
6. **Float noise rounded.** All numeric emission goes through a ≤2-decimal
   round (`cssValue`); `9.899999618530273px` → `9.9px`. Type-scale steps
   closer than 0.5px are flagged in the guardrails as probable design-file
   duplicates ("do not resolve the tie yourself").
7. **ICONS.md split + unique anchors.** Icon-classified components (tag
   descriptions, or bare no-prop glyphs on icon pages — `isIconDoc`) ship as a
   compact `ICONS.md` table (name / node id / search tags / preview) listed in
   the DESIGN.md file table; COMPONENTS.md keeps real components. Duplicate
   names get node-id anchors (`#arrows-arrow--16-11919`) via explicit
   `<a id>` targets, and the index links use them.
