# Feature Specification: The OpenSpec pack — a second framework, and the layer's acceptance test

**Feature Branch**: `047-openspec-pack`

> **This spec lives with the item it describes.** The OpenSpec pack is a
> marketplace item, so its spec/design/plan/tasks are the item's own `spec/`
> facet and travel with the pack when it is published. BOS discovers it as the
> item-owned spec store `item-openspec`. The BOS-side machinery it consumes —
> the descriptor, sections, binding and install path — stays in `user-specs` as
> `045-method-pack-layer`. Original home:
> `user-specs/build-studio/047-openspec-pack/`.

**Created**: 2026-09-10

**Status**: Draft

**App Target**: marketplace-item

**Input**: Fourth of five features from the swappable-spec-framework analysis. OpenSpec as an installable method pack — the cheapest possible second framework, and therefore the real acceptance test for `045-method-pack-layer`.

> Depends on `045-method-pack-layer` and `046-spec-kit-pack`. Independent of `048-bmad-pack` — ship this first regardless of which is more interesting. Carries **no code**: a descriptor, templates, and prose. That claim is only true because generic section-kind rendering was moved into `045` (its FR-010b); if any requirement here needs a BOS source change, it belongs in `045`, not in this pack.

## Why this exists (context)

OpenSpec needs no new BOS mechanism. That makes it the acceptance test for the whole layer: every wrong assumption in `045`'s descriptor is one OpenSpec exposes and spec-kit alone never will.

It is also the pack most likely to see real use. OpenSpec is positioned explicitly as the lightweight alternative to Spec Kit — no Python, no rigid phase gates — and is aimed at brownfield work on the premise that generating all specs upfront makes no sense for software that already exists.

### What OpenSpec actually is

Verified against its own documentation, not from recollection.

**Layout — two trees plus an archive:**

```
openspec/
├── specs/            # source of truth: how the system currently behaves
│   ├── auth/
│   └── payments/
└── changes/          # proposed modifications (active work)
    ├── add-dark-mode/
    └── archive/      # completed changes, date-prefixed
```

**Artifacts per change, with declared dependencies:**

```yaml
name: spec-driven
artifacts:
  - id: proposal
    generates: proposal.md
    requires: []
  - id: specs
    generates: specs/**/*.md
    requires: [proposal]
  - id: design
    generates: design.md
    requires: [proposal]          # parallel with specs
  - id: tasks
    generates: tasks.md
    requires: [specs, design]
```

**The load-bearing quote**, and the reason `045` made phases a DAG:

> "Dependencies are enablers, not gates. They show what's possible to create, not what you must create next."

**Constitution equivalent:** `openspec/config.yaml` — its `context:` block is edited manually and injected into every generated artifact. (`openspec/project.md` is a legacy surface and is not used.)

**Lifecycle:** archiving applies each delta spec's ADDED/MODIFIED/REMOVED sections to the corresponding main spec, then moves the change folder to `changes/archive/` with a date prefix, preserving all artifacts.

**Roles:** none. The docs say only *"humans provide intent, context, and constraints; agents convert this into behavior-first requirements and scenarios."* No discrete agent types are defined. Commands are the abstraction: `/opsx:propose` → `/opsx:apply` → `/opsx:archive`, with `/opsx:explore`, `/opsx:new`, `/opsx:continue`, `/opsx:verify`, `/opsx:sync` and a fast-forward `/opsx:ff` in the expanded profile.

## Clarifications

### Session 2026-09-12

- Q: Where do method packs come from — how are the OpenSpec and BMAD packs distributed and installed? → A: spec-kit ships in-tree; OpenSpec and BMAD are items in the user's own private `user-apps` marketplace. Public publishing is a separate later decision.
- Q: How does a pack declare compatibility with BOS's descriptor format, which will evolve? → A: The descriptor carries a `schemaVersion`; BOS refuses to register a pack whose schema version it does not support, naming the mismatch. No silent defaulting.


## User Scenarios & Testing *(mandatory)*

### User Story 1 - A second framework works with no BOS code changes (Priority: P1)

Installing the OpenSpec pack and assigning it to a store produces a working `propose → specs/design → tasks` flow without touching BOS source.

**Why this priority**: this is the claim `045` makes and cannot prove alone.

**Independent Test**: Install the pack on a clean tree; assign to a fresh store; run the flow; assert no BOS source diff was required.

**Acceptance Scenarios**:

1. **Given** the pack installed and assigned to a fresh store, **When** a change is proposed, **Then** `changes/<name>/proposal.md` is created and discovered.
2. **Given** BOS source at the `046` commit, **When** this pack is exercised, **Then** no BOS code change was needed to make it work.

### User Story 2 - Named changes are not forced into `NNN-` numbering (Priority: P1)

An OpenSpec change is discovered by its name (`add-dark-mode`), with no numeric prefix allocated.

**Why this priority**: `numbering: "none"` is the descriptor field most likely to be silently ignored. If `nextFeatureId` still allocates a prefix, this pack quietly produces spec-kit-shaped folder names and nobody notices until the folders look wrong.

**Independent Test**: Create a change; assert the directory name has no `NNN-` prefix.

**Acceptance Scenarios**:

1. **Given** `numbering: "none"`, **When** a new change is created, **Then** its folder is named without a numeric prefix.
2. **Given** an existing change folder without a prefix, **When** the tree is built, **Then** it is discovered as a leaf.

### User Story 3 - Parallel artifacts render as simultaneously available (Priority: P1)

After `proposal.md` exists, both `specs` and `design` show as available at once, and neither shows as owed.

**Why this priority**: `specs` and `design` both `require: [proposal]` and are genuinely parallel. A `pending` badge implies "you owe this next"; OpenSpec's model is "you may do this now". Rendering it wrong makes the pack fight its own stated philosophy in the UI — and it is the one thing the old linear `PHASE_ORDER` structurally could not express.

**Independent Test**: Create only `proposal.md`; assert both `specs` and `design` render `available`, not `pending`.

**Acceptance Scenarios**:

1. **Given** only `proposal.md`, **When** the phase strip renders, **Then** `specs` and `design` are both `available`.
2. **Given** neither `specs` nor `design` exists, **When** `tasks` is evaluated, **Then** it renders `blocked`, not `pending`.

### User Story 4 - The three trees are visually distinguishable (Priority: P1)

A user can tell at a glance whether they are looking at current truth, an active proposal, or history.

**Why this priority**: three sections with different meanings render in one tree. `specs/` and `changes/` are not peers, and `archive/` is history. Without a distinction a user edits current truth believing they are editing a proposal — a correctness problem, not a cosmetic one.

**Independent Test**: Render a store with all three sections populated; assert each group carries a distinct badge.

**Acceptance Scenarios**:

1. **Given** a store with all three sections, **When** the tree renders, **Then** each section is labelled by kind, reusing the existing owner-badge pattern.
2. **Given** the archive section, **When** a user opens an artifact in it, **Then** it presents as read-only history.

### User Story 5 - BOS's roles still apply under a lightweight framework (Priority: P2)

Adopting OpenSpec does not silently drop the architect that grounds designs in BOS's real subsystems.

**Why this priority**: OpenSpec is deliberately lightweight and defines no agents, so BOS's role layer is the entire quality floor here. But it degrades gracefully — a user gets a working flow without it — so it ranks below the structural stories.

**Independent Test**: Run a change with a UI through the flow; assert all five roles are reachable and attach at the artifacts below.

| BOS role | Attaches at | Notes |
|---|---|---|
| intent | `proposal` | BOS-owned intent skill (`044`) |
| architect | `design.md` | Direct fit — OpenSpec has this artifact, by this name |
| architect-reviewer | gates `design` | Backs the framework's own `/opsx:verify` notion |
| ui-designer | `ui` (declared, see FR-004) | OpenSpec has no UI artifact — a genuine gap |
| developer | `tasks` | Maps to `/opsx:apply` |

**Acceptance Scenarios**:

1. **Given** a change needing a design, **When** the driver reaches `design`, **Then** `architect` is delegated to and writes `design.md`.
2. **Given** a change with a UI, **When** the driver reaches the UI artifact, **Then** `ui-designer` is delegated to and its output appears in the DAG.

### Edge Cases

- **Archiving is out of scope and must be stated as such.** It performs a real semantic operation — parse ADDED/MODIFIED/REMOVED, merge into the target spec, relocate with a date prefix. That is code, and it is the one piece a data-only pack cannot do. A partially-correct delta merge silently corrupts the source of truth, so no partial implementation is acceptable.
- **OpenSpec is moving.** It was recently rebuilt around the `/opsx:*` artifact-guided workflow, replacing an earlier surface, and ships forkable schemas. Pin the targeted version in the descriptor or the prose drifts from the tool within a release.
- **Two-tree layout stresses code that assumed one.** `listSpecifications`, `specTree` and the draft-branch overlay (`insertAtPath`) were written for a single feature tree. If `045`'s `sections` work was shallow, this is where it shows — and the resulting failure is a `045` bug, not a pack bug.
- **Assigning this pack to a store full of spec-kit features** must trigger `045`'s preflight guard, not silently hide 41 features.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The pack MUST declare three sections: `changes` (`active`, leaf `proposal.md`, `numbering: "none"`), `specs` (`truth`, leaf `spec.md`), and `changes/archive` (`archive`, leaf `proposal.md`).

- **FR-002**: The pack MUST declare `constitution: "config.yaml"` — v1.13's constitution equivalent. `project.md` is legacy and MUST NOT be used.

- **FR-003**: The pack MUST declare artifacts `proposal`, `specs` (glob `specs/**/*.md`), `design` and `tasks` with OpenSpec's own `requires` edges: `proposal: []`, `specs: [proposal]`, `design: [proposal]`, `tasks: [specs, design]`.

- **FR-004**: The pack MUST declare a `ui` artifact — `generates: "design/ui-mockup.html"`, `requires: ["proposal"]` — so `ui-designer`'s output is visible in the DAG rather than an undeclared file. The descriptor MUST note this as a BOS addition, legitimate because OpenSpec supports forked schemas explicitly (`openspec schema fork`); this is the framework's own extension point, not a deviation.

- **FR-005**: Phase state MUST render `available` where a spec-kit phase would render `pending`, per OpenSpec's enablers-not-gates model.

- **FR-006**: The pack MUST declare each section's `kind` so `045` FR-010b's generic badge rendering distinguishes them. The rendering itself is `045`'s; this pack only supplies the metadata.

- **FR-006a**: The `specs` name is **overloaded and MUST be disambiguated**: `sections[1].rel = "specs"` is a store-level tree (current truth), while `artifacts[1].generates = "specs/**/*.md"` is a delta directory *inside a change folder*. They are different things at different roots. Artifact globs MUST be explicitly typed as change-relative (or unit-relative) in the descriptor, so a resolver can never conflate the two, and the pack's prose MUST use distinct names for them ("the specs tree" vs "delta specs").

- **FR-006b**: Archived changes MUST NOT render with live phase state. A change under `changes/archive/` is history: its phase strip would otherwise show `tasks: available` for work completed months ago. A section of `kind: "archive"` MUST render its units with a terminal state (or no strip at all) rather than evaluating the DAG against them. Read-only editing (FR-009) is a separate concern and does not cover this.

- **FR-007**: The pack MUST ship a driver skill: one `SKILL.md` plus a reference per artifact, carrying two things spec-kit's driver does not — the **delta-spec convention** (ADDED / MODIFIED / REMOVED, and the rule that implementation detail belongs in `design.md` and `tasks.md`, never in a spec) and **brownfield framing** (do not generate the whole `specs/` tree upfront; specs accrete as changes archive).

- **FR-008**: The driver MUST reach BOS-specific knowledge via `bos-domain` by skill id. Any sentence in this pack explaining BOS install mechanics is in the wrong place.

- **FR-009**: The archive section MUST render read-only, and the pack MUST document that archiving is a manual step (or run outside BOS via the `openspec` CLI). A partial delta-merge implementation MUST NOT be shipped.

- **FR-010**: The descriptor MUST record the targeted OpenSpec version.

- **FR-011**: The pack MUST ship a `config.yaml` template — OpenSpec's constitution equivalent, injected into every generated artifact. Materialising or reporting it at assignment time is **`045` FR-009a's** responsibility, not this pack's; this requirement is only that the template exists for `045` to use, so a store assigned this method never silently generates artifacts with no injected project context.

- **FR-012**: The `ui` artifact (FR-004) is a BOS addition to OpenSpec's schema, and that boundary MUST be documented in the pack: a user running the upstream `openspec` CLI against the same repository will not know about it, so `ui-mockup.html` will be invisible to CLI validation and archiving. State this rather than letting it be found.

- **FR-013**: This feature MUST carry e2e coverage for the full OpenSpec flow, built on `045` FR-017a's fixture-pack harness (a hard prerequisite — without it this criterion can only be satisfied by skipping) — a change discovered without an `NNN-` prefix, `specs` and `design` both rendering available after `proposal.md`, and archived changes rendering terminal rather than live. The test MUST bundle its own OpenSpec-shaped fixture written at test time; it MUST NOT depend on any pre-seeded store, which is exactly the failure mode BOS's testing rule exists to prevent.

- **FR-014**: The pack MUST ship its own user-facing documentation (what OpenSpec is, how its two trees differ, why archiving is manual here), and `docs/usage/` MUST point at it. A user assigning a method they have not used before has nowhere else to look.

- **FR-015**: The pack MUST be distributed as an item in the user's own `user-apps` marketplace (`data/user-apps/items/<pack-id>/`), carrying a `method/` facet — the same layout as any other BOS item, per `034`/`035`. Publishing it to a public marketplace is explicitly **not** part of this feature: it is a later decision that would raise the bar from "works for this BOS" to "generally useful", and nothing here should be designed around it.

### Non-requirements

- The archive/delta-merge operation (FR-009). Revisit when a pack can declare a `service` facet; note this as that facet's first real customer.
- Running the `openspec` CLI — `init`, `validate`, `schema fork`. No execution path is rooted at a spec store.
- Migrating existing spec-kit features into OpenSpec's layout. Adoption is additive: use a new store or new Project, per `045` FR-010.

### Key Entities

- **Change** — a self-contained proposal package under `changes/`, named not numbered, archived on completion.
- **Delta spec** — a spec fragment expressing ADDED/MODIFIED/REMOVED against current truth, merged into `specs/` at archive time.

### What this pack requires of the layer

OpenSpec is the acceptance test for `045`, because it is the first framework
whose shape differs from spec-kit's in every dimension that matters. It depends
on the following being true of the layer, each of which spec-kit alone never
exercises:

| Requirement of `045` | Why OpenSpec needs it |
|---|---|
| Discovery walks SECTIONS, not just Projects (FR-025) | its sections live at the STORE root |
| Section ownership by longest prefix (FR-025) | `changes/archive` nests inside `changes` |
| `terminal` suppresses the phase DAG (FR-025) | archived changes are history |
| No Project migration over a method-owned root (FR-026) | `changes/` and `specs/` ARE the root |
| A glob provider for `set`/`count` (FR-027) | delta specs are nested inside a change |
| Frozen sections are read-only (FR-028) | an archive other specs were merged from |
| The descriptor memo clears per call (FR-021) | rebinding must change numbering at once |

If any of these regresses, this pack is where it shows first — and a failure
here is a `045` bug, not a pack quirk.

### Verified against OpenSpec **v1.13.0** (`Fission-AI/openspec@9d4e597`)

OpenSpec moves fast enough that prose written against it drifts within a
release, so every structural claim in this spec is checked against a NAMED
COMMIT and must be re-checked against another before any future edit.

**Confirmed against `schemas/spec-driven/schema.yaml`:**

- The artifact DAG of FR-003, verbatim from `schemas/spec-driven/schema.yaml`:
  `proposal: []`, `specs: [proposal]` (generates `specs/**/*.md`),
  `design: [proposal]`, `tasks: [specs, design]`.
- The layout: `openspec/changes/<name>/` holding `proposal.md`, `specs/`,
  `tasks.md`; `openspec/specs/<capability-path>/spec.md`; and
  `openspec/changes/archive/<YYYY-MM-DD>-<name>/`.
- Named, un-numbered changes — `numbering: "none"` is right.
- `/opsx:<command>` is the canonical command surface
  (`src/utils/command-references.ts`).
- Schema forking is real (`openspec schema fork`), so FR-004's `ui` artifact
  remains a legitimate use of the framework's own extension point.

**The constitution is `openspec/config.yaml`**, carrying `schema: spec-driven`
and a `context:` block injected into generated artifacts. `openspec/project.md`
is **legacy** — `src/core/legacy-cleanup.ts` detects it only to tell the user it
needs manual migration — so any pack declaring it binds to a surface two majors
old.

**Further requirements from that surface:**

- **FR-017**: The pack MUST model **`apply`** as a phase of its own, and `tasks` MUST mean *planned*, not *done*. Upstream draws this line by declaring `apply` OUTSIDE its `artifacts:` list — `requires: [tasks]`, `tracks: tasks.md`, and no `generates`, because executing a plan produces no new artifact. Collapsing the two (a single `tasks` phase gated on every checkbox being ticked) reports a complete, well-written `tasks.md` with nothing ticked as still owed, and leaves execution progress with no indicator at all — the one signal worth watching. `tasks` is therefore satisfied by the artifact existing; `apply` by its checklist completing. `apply` MUST NOT appear in `artifacts[]` or `artifactOrder`: it generates no file, and `artifactOrder` sorts file names (F7). US5's `developer` role attaches to `apply`, not `tasks`.

  > A phase with no artifact is precedented, not a workaround: spec-kit already declares four (`constitution`, `clarify`, `analyze`, `implement`). `phases[]` and `artifacts[]` are independent lists by design.
- **FR-018**: The delta vocabulary is **ADDED / MODIFIED / REMOVED / RENAMED**.
  This spec and FR-007 name only the first three. `RENAMED` uses `FROM:`/`TO:`.
- **FR-019**: A new-capability delta MUST open with `## Purpose` (50+ characters
  under `--strict`). Omitting it does not fail — archive writes a
  `TBD ... Update Purpose after archive` placeholder into the main spec, which is
  silent corruption of the truth tree and exactly the failure mode this pack is
  meant to avoid.
- **FR-020**: Scenarios MUST use **exactly four hashtags** (`#### Scenario:`).
  Upstream states three hashtags or bullets "will fail silently". The driver
  skill MUST state this as a hard rule — a silent format failure in a
  requirement's scenarios is indistinguishable from having written none.
- **FR-021**: A change with zero deltas is REJECTED by `openspec validate`
  unless its `.openspec.yaml` sets `skip_specs: true`. The pack MUST document
  that opt-out and the rule for it (no spec-level behaviour change), and MUST
  NOT encourage inventing a requirement to satisfy validation.
- **FR-022**: Upstream ships four templates at
  `schemas/spec-driven/templates/{proposal,spec,design,tasks}.md`. The pack
  SHOULD adapt those rather than author its own, so the drift surface is a diff
  against a known upstream file rather than an independent invention.

**Deliberately not modelled:** the upstream repo also carries
`openspec/explorations/`, `initiatives/` and `work/`. These are that
repository's own working areas — not created by `init`, not referenced by the
tool's root resolution — so the three-section model (FR-001) stands.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Installing the pack and assigning it to a fresh store yields a working `propose → specs/design → tasks` flow with zero BOS source changes.
- **SC-002**: A change folder with no `NNN-` prefix is discovered correctly.
- **SC-003**: `specs` and `design` render simultaneously available once `proposal.md` exists.
- **SC-004**: All three section kinds are distinguishable in the tree, and archived changes render with a terminal state rather than a live phase strip.
- **SC-004a**: A store newly assigned this method either has a `config.yaml` carrying a `context:` block, or reports its absence — never silently generates artifacts with no injected project context.
- **SC-005**: All five BOS roles are reachable and attach at the FR-declared artifacts.
- **SC-006**: `045`'s spec-kit parity check (its SC-001) still passes — nothing about spec-kit changed.
- **SC-007**: Assigning this pack to a spec-kit-populated store triggers the preflight and hides nothing silently.

- **SC-008**: The pack ships user-facing docs and `docs/usage/` points at them.
- **SC-009**: A store bound to this method keeps its on-disk layout across a restart — no migration rearranges a store root the method owns.
- **SC-010**: Every unit is discovered exactly once; a change under `changes/archive/` is not also discovered as active work.
- **SC-011**: The descriptor and driver skill are verified against a named upstream commit, and the pinned version matches it.

## Assumptions

- **Failures found here are `045` bugs, not pack bugs.** Budget for `045` rework rather than working around descriptor gaps in the pack. That is the entire reason for shipping this second.
- BOS's role layer is worth keeping under a framework that defines none: a lightweight method should not mean losing designs grounded in BOS's real subsystems.
