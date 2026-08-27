# Task: color token remapping (designer palette → open file → developer data)

> **All five stages landed (2026-08-20).** Paste a palette → read the whole document (variables,
> paint and effect styles, gradient stops, loose colors on layers) → approve the table → write
> values, renames, `legacy/` parking, styles and canvas paints → contrast audit → Revert, plus
> `mapping.json`/`.csv` export and an optional old→new board on canvas. Renamed keys keep
> resolving: the emitter carries them as aliases and both engines write the identical block.
> Phase 2 runs from either side — a drop zone in the panel or `altery-dj remap` over a
> repository — off the same `mapping.json` and the same shared goldens. The new palette can
> come from a paste, the generator, a canvas selection, or a published library.
> 751 tests pass (`npm test`), plus 19 in `pytest tests/test_cli.py`; `npm run typecheck` and
> `npm run build` are green.
> Not yet exercised inside Figma itself — the document-side modules are typed against the
> plugin API but have not been run against a real file.
>
> Stage 5 below is untouched.

## Problem

A designer arrives with a new color scheme. Today the only way to move a file onto it is
by hand: open every variable, retype every value, hunt every detached fill, and then tell
the developers which hex became which hex. Nothing in the plugin maps an *existing* file
onto a *new* palette — `src/tokens/palette.ts` only generates a palette from key colors,
and `src/targets/ds-tools/palette-apply.ts` only writes a generated one into the document.

Two halves:

1. **Figma side** — inventory every color in the open file, map old → new (structurally,
   not per-color), let a human approve the mapping, then swap, reversibly.
2. **Developer side** — take the same mapping to JSON / CSV / stylesheets in a repository
   and replace *values* without touching *keys*.

## Settled rules (the contract this task implements)

These came out of a design session; treat them as fixed requirements, not suggestions.

- **Structural mapping, two levels.** Families are matched to families, then stops within a
  matched pair. Flat per-color nearest-neighbour is a fallback for leftovers only.
- **Stop rule.** Exact step number if the new scale has it, otherwise interpolate by
  perceptual L onto the nearest **existing** step. *Step numbers are never invented* — we
  are moving onto the designer's ladder, so that ladder is the truth.
- **Family matching.** Globally optimal assignment (Hungarian) over a cost matrix built
  from hue, role and stop count. N:1 (palette shrink) is legal.
- **No blocking.** Automatic everywhere; the human looks and edits at will. Orphans take
  their nearest new color however far it is. Nothing prevents Apply.
- **Modes.** Every mode maps independently; divergence between a variable's light and dark
  landing families is reported, not corrected.
- **Nothing is deleted.** Variables are never removed or consolidated; values change in
  place, so bindings survive untouched.
- **Names.** All primitives are renamed to their new family. Semantic tokens keep their
  names. On a name collision the loser moves to a `legacy/` group keeping its old name.
- **Zero cost for developers.** The emitter keeps every previous key alive as an alias
  (`--blue-500: var(--violet-500)`). The rename map lives in document `pluginData` and is
  copied into `tokens.json` → `$extensions`; repeated remaps collapse aliases to the final
  name rather than chaining.
- **Scope.** Inventory is always the whole document. Application scope is selectable
  (only meaningful for detached paints — variables are global anyway).
- **Detached paints.** Bind to a variable when the color is recognised as a token; write a
  recomputed literal when it is an orphan.
- **Coverage.** Solid fills and strokes, paint styles, every gradient stop, effect (shadow)
  colors. Alpha is always preserved; only RGB moves.
- **Duplicates.** Two tokens landing on one color stay duplicates. They are separated only
  on *proven adjacency* (fill+stroke of one node, or a node and its direct parent/text),
  and only onto an adjacent **existing** stop of the new scale, choosing the direction that
  raises the pair's contrast.
- **Library variables are read-only.** Remote variables are inventoried and reported
  ("run this in the source file"), never written.
- **Reversibility.** A snapshot of prior values, names and bindings goes to `pluginData`
  before Apply; Revert restores the last run. Preview *is* Apply + Revert — a variable has
  no page-local value, so there is no other way.
- **Post-Apply audit.** Informational report: contrast deltas for text/background pairs
  found during the walk, duplicates, orphans, skipped library tokens.
- **Phase 2.** One rich mapping record, strategy chosen by flag. Two executors (TS in the
  plugin, Python in `altery-dj`) kept in sync by golden tests, exactly as the token
  emitters already are. Parser accepts anything CSS Color 4 parses; matching uses the same
  ΔE ≤ 2 snap as Figma; dry-run by default and `--write` only on a clean git worktree.

## What already exists and is reused

| Need | Existing code |
|------|---------------|
| OKLCH math, contrast | `src/tokens/color.ts` — `hexToOklch`, `oklchToHex`, `clampToGamut`, `contrastRatio` |
| Spectrum/stop vocabulary | `src/tokens/palette.ts` — `SpectrumSpec`, `DEFAULT_STEPS`, lightness ladder |
| Variable upsert without breaking bindings | `src/targets/ds-tools/palette-apply.ts` — `variableWriter`, `findOrCreateCollection` |
| ΔE snapping, scope ranking, instance-safe edits, library loading | `src/targets/django/lint/fix.ts` — `colorDeltaE:179`, `SNAP_DELTA_E:188`, `scopeAllows:389`, `resolveEditableTarget:136`, `loadLibraryColorVariables:511` |
| Whole-document walk with yields | `src/utils/tree.ts:23` + `figma.loadAllPagesAsync()` (`src/code.ts:434`) |
| Variable snapshot incl. library + split themes | `src/variables.ts` |
| Primitive definition | `src/tokens/engine.ts:756` — `!participatesInTheming && !isScaleToken` |
| Shadow color already in the token package | `src/tokens/engine.ts:380` — `shadowEffectToCss` |
| Repo-side token rewriting without Figma | `cli/altery_dj/tokens.py` |

Gradients appear nowhere in the codebase today — that part is greenfield.

## Module layout

Pure modules (no Figma API, runnable under `node --test`):

- `src/tokens/remap/input.ts` — tolerant parser for the pasted palette: hex (3/6/8),
  `rgb()/rgba()`, optional name / family / step per row, JSON or CSV or loose text.
- `src/tokens/remap/spectrum.ts` — spectrum inference. Name/collection grouping first,
  OKLCH hue clustering for the remainder, `Neutral` for low chroma; hue-sector naming
  (Violet, Amber, Teal, …) for families that arrive unnamed.
- `src/tokens/remap/match.ts` — family assignment (Hungarian over the cost matrix) and stop
  assignment (exact number → nearest existing L).
- `src/tokens/remap/plan.ts` — turns inventory + match into the `RemapPlan`: one entry per
  color site, with flags (`orphan`, `duplicate`, `shifted`, `renamed`, `legacy`, `library`).
- `src/tokens/remap/contract.ts` — `mapping.json` schema, serialization, and the reverse
  lookup structures the phase-2 executor needs.

Figma-side modules:

- `src/targets/ds-tools/remap-inventory.ts` — one document walk producing: variables (all
  modes, local + remote flagged), paint styles, effect styles, detached solid fills and
  strokes, gradient stops, effect colors, per-token usage counts, adjacency pairs.
- `src/targets/ds-tools/remap-apply.ts` — applies a plan; writes the snapshot first;
  implements Revert.
- `src/targets/ds-tools/remap-report.ts` — contrast audit, duplicate/orphan lists, and the
  old|new swatch pair frame on canvas (reusing the section/pluginData tagging that
  `palette-apply.ts` already does).

Engine change:

- `src/tokens/engine.ts` — read the rename map from `$extensions` and emit the legacy alias
  layer; collapse chains so `--blue-500` and `--violet-500` both point at the final name.

## Data model

```
ColorSite       = { kind: 'variable' | 'style' | 'gradient-stop' | 'effect' | 'detached',
                    id, name?, modeId?, index?, rgba, usageCount, editable }
Spectrum        = { key, label, source: 'named' | 'clustered', stops: [{ step, l, rgba }] }
RemapEntry      = { site, from: rgba, to: rgba, fromToken?, toToken?,
                    family: { from, to }, step: { from, to },
                    flags: [...], deltaE }
RemapPlan       = { entries, familyAssignment, orphanFamilies, renames, warnings }
```

`mapping.json` carries variable id, old and new name, old and new hex per mode, family,
step, and the flags — enough for the executor to match by literal *or* by token name,
selected with a flag.

## Algorithm

1. **Inventory.** `loadAllPagesAsync`, then one `findAllWithCriteria` pass with
   `skipInvisibleInstanceChildren` and periodic yields. Collect sites, usage counts and
   adjacency pairs in the same pass; progress goes to the UI as it does for lint fixes.
2. **Old spectra.** Group by name/collection; cluster the remainder by hue; sort each
   family by L; assign step numbers from names when present, otherwise by ladder position.
3. **New spectra.** Same inference over the parsed input (names when given, hue naming
   when not).
4. **Family assignment.** Cost = weighted hue distance + role mismatch + stop-count
   mismatch. Hungarian over the matrix; unmatched old families are flagged, not blocked.
5. **Stops.** Exact step if present in the target scale, otherwise nearest existing step by
   L. Record ΔE for the report.
6. **Conflicts.** Name collisions → loser to `legacy/`. Adjacent duplicates → shift one to
   an adjacent existing stop in the contrast-raising direction.
7. **Plan** → table, canvas frame, `mapping.json`.

## Apply order

1. Write the snapshot (`pluginData`, chunked; refuse Apply and say so if it will not fit).
2. Variable values per mode → renames → `legacy/` moves.
3. Paint styles, effect styles.
4. Gradient stops.
5. Detached paints inside the chosen scope: bind when recognised, literal when orphan;
   skip anything `resolveEditableTarget` reports as library.
6. Persist the rename map, run the audit, post the report.

Revert replays the snapshot in reverse and clears it.

## UI

New section inside `view-ds-tools` (`ui.html:690`), beside the palette generator, sharing
its spectrum/stop vocabulary. Paste box → parsed preview → mapping table grouped by family
(old swatch, new swatch, ΔE, token name, usage count, alternatives dropdown, flag chips) →
Apply / Revert / Export mapping.

New messages in the `src/code.ts:629` switch: `REMAP_SCAN`, `REMAP_PARSE_INPUT`,
`REMAP_PREVIEW`, `REMAP_OVERRIDE`, `REMAP_APPLY`, `REMAP_REVERT`, `REMAP_EXPORT_MAPPING`,
answered by `REMAP_INVENTORY`, `REMAP_PLAN`, `REMAP_APPLIED`, `REMAP_REVERTED`,
`REMAP_ERROR`.

## Phase 2 executors

- `src/tokens/remap/rewrite.ts` — pure: given file text, extension and mapping, return the
  rewritten text plus a replacement list. Full CSS Color 4 parsing, alpha preserved,
  original notation preserved (a hex stays a hex, an `rgba()` stays an `rgba()`).
- `cli/altery_dj/remap.py` — `altery-dj remap --map mapping.json [paths…]`. Dry-run prints
  file, line, before → after and writes nothing. `--write` refuses on a dirty worktree.
- Golden fixtures shared by `node --test` and `pytest`, following the `tokens.ts`/
  `tokens.py` precedent.

## Staging

1. **Vertical slice (MVP).** ✅ Paste input → inventory → matching → table → variable values,
   renames, `legacy/` → snapshot/Revert → `mapping.json` export.
2. **Rest of the document.** ✅ Paint styles, detached paints, gradient stops, effect colors,
   adjacency shifting, contrast audit, canvas swatch frame.
3. **Emitter aliases.** ✅ Rename map through `pluginData` → `$extensions` → CSS alias layer,
   with chain collapsing.
4. **Phase 2.** ✅ TS rewriter, then the Python CLI, sharing goldens.
5. **More inputs.** ✅ Palette generator as a source, canvas swatches, library variables.

## Tests

Pure modules get unit tests next to them (`src/tokens/remap/*.test.ts`): parser tolerance,
hue clustering, stop interpolation with mismatched scales (10↔12, 5↔10), Hungarian
optimality on hand-built matrices, N:1 shrink, collision → `legacy/`, adjacency shift
direction and its "existing stop only" invariant, alias chain collapsing, and the phase-2
rewriter goldens.

Figma-side modules are covered indirectly through plan-level assertions; the inventory and
apply layers stay thin on purpose.

**`package.json` needs its test glob widened** — `src/tokens/**/*.test.ts` already covers
the new pure modules, but `src/targets/ds-tools/**/*.test.ts` is not in the list today.

## Known risks

- Broad CSS Color 4 parsing plus ΔE snapping plus `--write` is the most dangerous
  combination in the whole task; dry-run and the clean-worktree requirement are the only
  guards, and both are procedural.
- With no blocking anywhere, an accessibility regression will reach the file; only the
  post-Apply report catches it.
- The `pluginData` snapshot has a size ceiling. It must be chunked, and Apply must refuse
  rather than silently lose the ability to revert.

## Found on real files (A → B)

Three separate faults, all reproduced from the two token exports and all fixed:

1. **A muted ramp fell into the grays.** Neutrality is a threshold on relative chroma, and a
   real `teal` running `#F3F8F9 → #1A2527` holds a steady 207° hue while never rising above
   0.36 of the chroma sRGB allows. The arithmetic called it gray, the gray/colored
   compatibility rule then forbade `teal → teal`, and twelve teal rungs landed on the new
   neutrals — which reads as the palette having been normalised. **A family name shared by
   both palettes now settles the question**, in the cost function and in the compatibility
   rule alike: it is the author of both palettes saying these are the same family.
2. **A crowded-out rung took the wrong neighbour.** With no room between two anchors, the
   unanchored rung shared whichever anchor sat below it — so an old `10` wedged between a new
   `0` and a new `50` became pure white. It now takes the neighbour nearer its own lightness.
3. **The wrong name survived a collapsed duplicate.** Canvas and library sources fold
   identical colors and kept the first name. A board that draws `background/base` before the
   `neutral/0` it aliases therefore left the new neutral ramp with no `0` at all, and every
   white in the file — nothing white left to land on — moved to the lightest gray in the ramp.
   The name carrying a family *and* a step now wins.

Worth noting for the next fault of this shape: (1) and (3) both look identical from the
panel — a color moving somewhere obviously wrong — but only (3) depends on where the palette
came from. Pasting the same palette as JSON never showed it, because the paste parser does
not fold duplicates.

## Found on the live file (эталон board + карта, 2026-08-20)

Verified against the эталон's own variables (via Figma MCP): the canonical collection is the
strict ladder the operator described — blue is 50…900 with **no 250**; the `A-tokens.json`
export carries extra steps (blue/250, red/150, amber/150, green/150, neutral/925) that the
эталон board does not.

Two more faults, both reproduced and fixed:

1. **The proportional stretch ignored anchors.** When the old ladder is longer than the new
   one (violet 12 → blue 11), the stretch spread rungs by *index*: violet/200 landed on
   blue/250 and everything below shifted one step, even though 50…900 matched number for
   number. Proportional is now reserved for ladders with *no* shared numbers; with even one
   anchor, the anchored fit runs and the tails share their nearest rung. Verified: violet
   50…900 → blue 50…900 exactly, 10 shares 50, 950 shares 900, blue/250 untouched.
2. **Families merged by their last word.** Named grouping keyed on the leaf family name, so
   `colors/neutral`, `colour/neutral` (a British-spelt copy holding old-teal values) and any
   other `…/neutral` in the document fused into one ramp — teal swatches drawn inside the
   neutral strip. A family is now **one group in one place** (keyed and labelled by its full
   group path); name *matching* still compares the leaf word, so `legacy/colors/teal` and
   `colour/neutral` each find their family, but as their own strips.

Plus a new warning: when one opaque color leaves in two directions under two names
(`colors/teal/900` → teal/900 while `colour/neutral/900` → neutral/900, both `#314245`),
the plan says so — `one color, two directions: …` — and leaves the choice to the row-level
override, which is what it exists for.

## The operator's three laws (2026-08-20, final ruling on matching)

Restated by the operator after two rounds of near-misses, now encoded as law, in order:

1. **Identity.** A color the new palette already holds byte-for-byte does not move — `via:
   'exact'`, before any ladder arithmetic. Alpha rides along as everywhere else.
2. **A shared step number is immovable.** No unanchored neighbour may displace an anchor. The
   "displacement budget" that let `grey/10` push `grey/50` onto `neutral/150` is deleted.
3. **No number → fit between the anchors**, on whichever position — free slot or shared
   anchor — is nearest by lightness. Collapsing two old shades onto one new rung is the
   expected outcome of a shrinking palette, never an error. New-only steps (a `150`, a `250`)
   stay empty unless a color's own lightness genuinely lands there.

Plus one guard for thin evidence: in families too short to fit as a ladder (< 3 numbered
rungs), a step number that grossly contradicts the color's own lightness (Δl > 0.15 and
lightness-nearest is closer) is not trusted — a two-stop `toxic/50` is a dark olive, and the
numerals alone would send it to a near-white `green/50`.

Verified on the real A → B exports plus the live file's strays with a standing invariant
script: identity holds for all 15 byte-equal colors, every shared number lands 1:1 in every
family, no ladder comes out inverted, `blue/250`/`neutral/150`/`red/850` stay empty.

## The library reader was the thief (2026-08-20, evening)

The operator reads the reference from **Library → "Altery Design System 3.0 · Colors"** — the
right channel. The reader skipped alias-valued tokens on the reasoning that they point at
colors already in the list. That is only true for aliases *inside the collection being read*;
a `neutral/0` aliasing into a base collection left the palette with no white at all, and
every white in the file "moved" to the lightest gray that made it in. Proven from the drawn
board: 417 pairs and not one lands on #FFFFFF or #000000. Aliases now resolve through their
chain (depth-capped); identical results still collapse afterwards.

An adversarial verification pass (three independent refuters) also confirmed and led to
fixing:
- `fitLadder`'s slot reservation could strand the very slot it reserved — a rung two
  hundredths from a near-white slot took the far anchor and the slot went to nobody. The
  unanchored rungs between two anchors are now placed **jointly**: a monotone assignment
  minimizing total lightness shift (prefix-min DP), which also covers the crowded-tail case.
- Excluded pairs were still renamed, and the phantom rename claimed the target name in
  collision resolution — parking a variable the human kept in `legacy/`. Excluded means
  excluded from every write.
- `separateAdjacent` could move an identity match and could "separate" a pair that was
  already one color in the source file, manufacturing a fork. Both barred.
- The identity lookup keyed on the 8-bit grid missed colors a hair under a rounding boundary
  (hsl()/oklch() palettes); the probe now honors `sameColor`'s tolerance.

## Re-verified against the original (2026-08-20, night)

The operator's correction: the reference neutral scale is *wide* — 0, 50, 100, 150, 200…800,
850, 900, 925, 950, 1000 — not the strict 50…900 run earlier insisted on. Audit of every rule
born during the strict-ladder period: none forbids the wide steps. Anchors pair whatever
numbers both sides share (locked by a test: a source carrying 0/150/850/925/1000 anchors all
sixteen 1:1); new-only steps are reachable by lightness where honest and stay empty otherwise.
One earlier claim corrected for the record: `blue/250` *is* in the reference collection — the
эталон board simply doesn't draw it, and the engine never relied on its absence.

`A-tokens.json` matches the original file's Variables panel group-for-group (119 = 16+10+11+
12+11+11+10+1+37), so every invariant run against it stands against the true reference. With
the full 119 (alpha included) the plan holds all invariants; 23 sites are byte-equal and ride
unchanged, `fade`/`glow` keep their own alpha on their RGB matches.

**Board swatches now carry the real tokens.** Old-side swatches bind the file's own variable,
new-side swatches bind the imported library variable (`ParsedSwatch.variableKey` → plan
`toVariableKey` → board `collectBindings`), so selecting any swatch names its token in
Figma's UI. Best-effort: an unfetchable token leaves a plain fill. The hex label keeps the
as-drawn value even where a bound fill later follows its variable. `mapping.json` records the
landing's `toVariable` key for the developer side.
