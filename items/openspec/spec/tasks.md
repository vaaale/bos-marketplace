# Tasks: The OpenSpec pack (047)

Every task names its acceptance. Where a task exists because something went
wrong earlier in this feature family, the task says so — the reason is the part
that survives.

**No BOS source change is required.** `045` FR-019 … FR-028 all landed. If a task
below cannot be completed without editing `src/`, that is a `045` gap and belongs
there (this spec's Assumption), not a workaround here.

---

## Phase 0 — where the descriptor is validated (T001)

- **T001 — Validate the SHIPPED descriptor through `npm run validate:methods`,
  and keep the unit fixture self-contained.**

  A descriptor validated only by a lookalike proves nothing about the file BOS
  loads — but a unit test cannot load this one. The pack lives in a **different
  repository**, reached through `data/user-apps`, a symlink into the marketplace
  clone, and `/data` is gitignored. A browseros unit test reading
  `method/method.json` would depend on a sibling repo being checked out: the
  pre-seeded-data dependency BOS's testing rule forbids, in a sharper form than
  that rule was written for. The alternatives are worse — a committed copy in
  `tests/` drifts silently, and "skip if absent" is the self-skipping test
  `045` FR-017a exists to remove.

  So the two checks divide by what each can actually reach:
  - The **unit fixture** stays self-contained, carrying verified upstream values
    (v1.13.0, `config.yaml`, the five-phase DAG). It bundles its own fixture, as
    the rule requires.
  - The **shipped descriptor** is checked by `validate:methods` against a running
    BOS — which is where a descriptor defect bites, across a boundary
    (install → restart → route) no unit test crosses anyway.

  *Residual risk, stated rather than hidden:* fixture and shipped descriptor can
  drift, and only the live run catches it. Run `validate:methods` after any
  `method.json` edit.

## Phase 1 — the descriptor (T002 … T005)

- **T002 — `method/method.json`.** Three sections (`changes` active,
  `specs` truth, `changes/archive` archive + `terminal`), all `numbering: "none"`;
  **five phases** — `proposal`, `specs`, `design`, `tasks`, `apply` (FR-017),
  where `tasks` is satisfied by the artifact EXISTING and `apply` by its
  checklist completing. `apply` stays out of `artifacts[]` and `artifactOrder`;
  `constitution: "config.yaml"` with `constitutionRoot: "own"` (NOT `project.md` — legacy); the artifact DAG
  of FR-003; `stateLabels` renaming `pending` → **"Available"**; `schemaVersion`
  and the pinned OpenSpec version **1.13.0** (FR-010).
  *Acceptance:* registers without a schema error; T001 green.

- **T003 — Declare delta specs `scope: "unit"` EXPLICITLY (F3, FR-006a).** On
  both the artifact and its phase predicate. Never rely on the default.
  *Acceptance:* a change containing **zero** delta specs does NOT report
  `specs: done`, and one containing a nested `specs/ui/spec.md` DOES.
  *Why both directions:* the negative case alone passes even when the glob is
  structurally unable to match — that is exactly how `045` FR-027 shipped broken
  in a pack that was already live.

- **T004 — Declare the `ui` artifact and NOTE it as a BOS extension (FR-004,
  FR-012).** `design/ui-mockup.html`, `requires: ["proposal"]`, unit-scoped.
  *Acceptance:* the descriptor carries the note that this is a fork of
  OpenSpec's schema and is invisible to the upstream CLI.

- **T005 — `roles` (US5) — verified, not read (`046` FR-021).** Map intent,
  architect, architect-reviewer, ui-designer onto the FR-declared artifacts, and
  **`developer` onto `apply`, not `tasks`** (FR-017): upstream declares `apply`
  as a stage of its own (`requires: [tasks]`, `tracks: tasks.md`).
  *Acceptance:* install reports **zero** dangling roles. The realistic error is
  naming an OpenSpec command (`opsx:propose`) or a skill id instead of an agent
  id — four of five were wrong this way in the first real pack.

## Phase 2 — templates (T006, T007)

- **T006 — Templates, ADAPTED from upstream (FR-022).** Upstream ships four at
  `schemas/spec-driven/templates/{proposal,spec,design,tasks}.md`. Start from
  those so drift is a diff against a known file rather than an independent
  invention, then shape them so an agent cannot accidentally produce a spec-kit
  artifact.
- **T007 — `method/templates/config.yaml` (FR-011, FR-002a).** OpenSpec's
  constitution equivalent — `schema: spec-driven` plus a `context:` block.
  *Acceptance:* the phase predicate tests for the **`context:` key**, not for a
  non-empty file. `config.yaml` with a schema line and no context is non-empty
  and has no principles, so the obvious predicate reports principles that do not
  exist. Binding a store with no `config.yaml` REPORTS the absence (`045`
  FR-009a owns the reporting; this task only owes the template). Switching a
  spec-kit store here finds no source constitution — spec-kit keeps its own in
  the *system* store — so the outcome is "absent", not "relocated".

## Phase 3 — the driver skill (T008 … T011) — the real work

- **T008 — `SKILL.md`.** The `propose → specs/design → tasks` flow, with
  `specs` and `design` presented as **simultaneously available**, never as an
  order. A driver that says "next, write the specs" contradicts the framework it
  is driving.

- **T009 — The delta-spec convention (FR-007, FR-018 … FR-021).** ADDED /
  MODIFIED / REMOVED / **RENAMED** against current truth, and the rule that implementation detail belongs in
  `design.md` and `tasks.md` — **never** in a spec.
  *Acceptance:* the prose uses **"the specs tree"** and **"delta specs"** as
  distinct terms throughout. This is not style: those two names are the only
  thing stopping an agent writing a delta into the store's truth tree (§3.3).
  It MUST also carry the four rules that fail SILENTLY (§3.9a): scenarios need
  exactly four hashtags; `## Purpose` on a new-capability delta (and NOT on an
  existing one); `RENAMED` uses FROM:/TO:; and a zero-delta change needs
  `skip_specs: true` in `.openspec.yaml` rather than an invented requirement.
  Each of these produces a wrong result quietly, which is why they belong in the
  skill and not only in a validator.

- **T010 — Brownfield framing (FR-007).** Do not generate the whole `specs/`
  tree upfront; specs accrete as changes archive. This is the instinct most
  likely to be violated by an agent trained on greenfield flows, so it needs to
  be stated as a prohibition, not a preference.

- **T011 — Reach BOS knowledge by skill id (FR-008).** `bos-domain`, never
  restated.
  *Acceptance:* grep the pack for BOS install/marketplace mechanics — any hit is
  in the wrong place and will drift.

## Phase 4 — distribution (T012, T013)

- **T012 — Add the `marketplace.json` entry (FR-015).** `method` block with
  `id`, `version`, `schemaVersion`. **No `integration` block** — this pack runs
  no code, and a present-but-incomplete `integration` invalidates the entry
  (`048` FR-017).
  *Acceptance:* every OTHER item still lists. A malformed entry taking the whole
  marketplace down is the failure mode this guards.

- **T013 — Install through the REAL path, then restart (`048` FR-016, FR-019).**
  *Acceptance:* installed from `user-apps` with no fixture copying it into place,
  and still registered after a restart.
  *Why explicit:* `048`'s pack was first placed in the built-in seed location,
  where nothing registers it — inert, with every surface still looking plausible.
  The test that should have caught it copied the pack into place itself, so it
  supplied the very step whose absence was the bug. **A fixture may not
  synthesise the artefact whose absence it exists to catch.**

## Phase 5 — user docs (T014, T015)

- **T014 — `docs/usage/OpenSpec/` (FR-014, SC-008).** What OpenSpec is, how the
  two live trees differ, and how a change flows. `docs/usage/` points at it.

- **T015 — Document the two surprises explicitly.** Neither may be discovered:
  - **There is no archiving inside BOS** (F5, §3.5). `changes/` grows
    monotonically and `specs/` never accrues truth unless the user runs
    `openspec archive` from the CLI. A user who adopts OpenSpec and never runs
    the CLI will find the framework's central mechanism absent with nothing
    explaining why.
  - **Delta specs are browsed in the tree, not the artifact pane** (F6, §3.10).
    "The phase says done and the pane is empty" reads as a bug.
  - Also: which upstream surface the pack was verified against (F8).

## Phase 6 — verification (T016 … T018)

- **T016 — e2e on the fixture-pack harness (FR-013).** A change discovered with
  no `NNN-` prefix; `specs` and `design` both available after `proposal.md`;
  archived changes terminal and read-only. Bundles its own fixture, written at
  test time — never a pre-seeded store.

- **T017 — Live smoke (`npm run validate:methods`).** Against a running BOS.
  *Why:* the unit suite caught none of the seven defects `048` found on first
  live use. Not thin coverage — each lived at a boundary a single-process test
  cannot cross.

- **T018 — Confirm spec-kit is untouched (SC-006).** `045`'s parity check still
  passes; the 143 live spec-kit features are unchanged.

---

## Dependencies

```
T002 ──> T001 (gate)
T002 ──> T003, T004, T005 ──> T012 ──> T013 ──> T017
T002 ──> T006, T007
T008 ──> T009, T010, T011
T013, T015 ──> T016
```

- **T001 depends on T002** despite being Phase 0: the gate exists now and is
  green against the fixture; T001 is the moment it starts testing the real file.
- **Phase 3 is independent of Phases 1–2** and can run in parallel — the skill
  is prose about a flow, not about the descriptor's syntax.
- **T012 → T013 is not optional ordering.** Installing before the manifest entry
  exists is what produces an inert pack that looks installed.

## Parallelisable

T003/T004/T005 (same file, different keys — sequence if editing conflicts);
T006/T007 with all of Phase 3; T014/T015 with Phase 4.

## Critical path

`T002 → T003 → T012 → T013 → T016 → T017`

Phase 3 is off the critical path and is nonetheless the phase that determines
whether the pack is any good (plan.md R4).
