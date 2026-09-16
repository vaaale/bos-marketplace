# Design: The OpenSpec pack (047)

## 1. What is actually new here

Almost nothing in BOS, and that is the point. This pack is the acceptance test
for `045`: the descriptor, sections, the phase DAG and the binding chain all
exist, and OpenSpec's job is to be the second framework that proves they are
real rather than spec-kit-shaped.

This pack carries no code of its own — but "a framework pack is just data" is a
property of the LAYER being correct for it, not of the pack. `045` FR-019 … FR-028
are what make that true here; see `spec.md`, "What this pack requires of the
layer". What the pack itself contains is data plus prose:

| Deliverable | Kind |
|---|---|
| `method/method.json` | descriptor — sections, artifacts, phases, labels |
| `method/templates/` | `proposal.md`, `spec.md`, `design.md`, `tasks.md`, `config.yaml` |
| the driver skill + one reference per artifact | prose |
| `docs/usage/` page | prose |
| this item's `spec/` facet | prose |

Two of those are easy to overlook and neither is optional: a glob provider for
`set`/`count` (`045` FR-027 — without it the delta-spec phase can never reach
`done`) and read-only enforcement for frozen sections (`045` FR-028, §3.5).

## 2. Constitution check

- **Principle II — the server decides, the client displays.** Phase state,
  section kinds and terminal-ness are all computed server-side from the
  descriptor; the pack adds no client logic. Satisfied by construction, since
  the pack cannot ship code.
- **No workarounds.** The tempting workaround here is to model OpenSpec's
  `changes/` and `specs/` as BOS *Projects* (each with a hand-written
  `project.json`) so that the pre-`045` Projects-only discovery would find them.
  That is rejected in §3.1: it duplicates the descriptor on disk, and it papers
  over a defect in the layer this pack exists to validate.
- **Specs are the source of truth.** Archiving is explicitly out of scope
  (FR-009) rather than half-implemented; §3.5 states the consequence instead of
  hiding it.

## 3. Architecture

### 3.1 Sections — three trees, one store (FR-001, FR-006)

```
<store>/
├── config.yaml                # constitution: schema + `context:` block
├── specs/                     # kind: truth      leaf: spec.md
│   └── auth/spec.md
└── changes/                   # kind: active     leaf: proposal.md
    ├── add-dark-mode/
    └── archive/               # kind: archive    leaf: proposal.md, terminal
        └── 2026-01-01-add-login/
```

Three properties of this layout are load-bearing:

1. **The sections are at the STORE ROOT, not inside a Project.** OpenSpec owns
   this layout; BOS's Project layer does not apply. `045` FR-026 stops the `033`
   migration rearranging it — without that guard it renames both trees into a
   default Project and commits, emptying the store on the next boot.
2. **`changes/archive` is NESTED inside `changes`.** Section ownership is decided
   by longest prefix (`045` FR-025), so an archived change belongs to the archive
   section, not to the active one. Without that rule every archived change is
   discovered twice — once as live work.
3. **`numbering: "none"` on all three.** A change is named (`add-dark-mode`), not
   numbered — prefixing it would invent an ordering the framework does not have.

**Rejected: modelling the sections as BOS Projects.** It would cost a
`project.json` per section that restates what the descriptor already declares,
drifts from it silently, and appears in the user's repo as BOS-generated litter
— and it would hide a real gap in the layer this pack exists to validate.

### 3.2 The DAG — enablers, not gates (FR-003, FR-005)

```
proposal ──┬──> specs ──┐
           └──> design ─┴──> tasks ──> apply
```

**Five phases, not four** (FR-017). `apply` is declared OUTSIDE upstream's
`artifacts:` list — `requires: [tasks]`, `tracks: tasks.md`, no `generates` —
because executing a plan produces no new artifact. BOS models it as a phase
anyway, and that split is load-bearing:

| Phase | Means | Satisfied by |
|---|---|---|
| `tasks` | the plan is WRITTEN | `tasks.md` is non-empty |
| `apply` | the work is DONE | every checkbox ticked |

Collapse them into one checklist-gated `tasks` phase and a finished `tasks.md`
with nothing ticked renders as an artifact still owed — while execution
progress, the thing actually worth watching, gets no chip at all.

A phase with no artifact is precedented rather than a workaround: spec-kit
already declares four (`constitution`, `clarify`, `analyze`, `implement`).
`phases[]` and `artifacts[]` are independent lists. `apply` must stay out of
`artifacts[]` and `artifactOrder`, which sort file names (F7).

`specs` and `design` both `require: [proposal]` and are genuinely parallel.
OpenSpec's own documentation is explicit: *"Dependencies are enablers, not gates.
They show what's possible to create, not what you must create next."*

This is the requirement that forced `045`'s phases to be a DAG rather than a
linear `PHASE_ORDER`, and it is the one thing the old structure could not express
at all.

**The rename problem.** A `pending` badge reads as "you owe this next", which
directly contradicts OpenSpec's model. The pack therefore renames the *display*,
not the state:

```jsonc
"stateLabels": { "done": "Done", "pending": "Available", "blocked": "Blocked", "na": "—" }
```

**ADR: rename the label, never the state.** Renaming `pending` → `available` in
`PhaseState` would make `045` SC-001 (spec-kit parity) inexpressible by
construction — the two frameworks could no longer be compared at all, because
their state vocabularies would not overlap. State ids stay fixed and
framework-agnostic; every framework-specific word goes through `stateLabels`.

`tasks` is the control case: with neither `specs` nor `design` present it must
render **`blocked`**, not `pending`. Blocked means "unreachable", and that
distinction is what makes "available" meaningful for the other two.

### 3.3 `specs` is overloaded, and MUST be disambiguated (FR-006a)

The single sharpest trap in this pack. `specs` names two different things at two
different roots:

| | What it is | Root |
|---|---|---|
| `sections[1].rel = "specs"` | **the specs tree** — current truth for the whole store | store |
| `artifacts[].generates = "specs/**/*.md"` | **delta specs** — ADDED/MODIFIED/REMOVED fragments inside ONE change | unit (change) |

A resolver that conflates them will, given a change folder, happily match the
store's entire truth tree — so a change with no delta specs at all reports
`specs: done`.

`045` makes this expressible: `ArtifactScope` (`"unit" | "store"`) exists
precisely for this case, and the glob predicates carry a `scope`. The pack MUST
therefore declare the delta-spec artifact and its phase predicate as
**unit-scoped** explicitly, never by relying on a default:

```jsonc
{ "id": "specs", "generates": "specs", "requires": ["proposal"], "scope": "unit" }
// phase predicate
{ "kind": "count", "glob": "specs/**/*.md", "scope": "unit", "min": 1 }
```

**The prose MUST use the two distinct names** — "the specs tree" and "delta
specs" — everywhere in the driver skill and docs. This is not style: the terms
are the only thing preventing an agent from writing a delta into the truth tree.

### 3.4 The `ui` artifact is a BOS extension, and says so (FR-004, FR-012)

OpenSpec has no UI artifact. BOS has a `ui-designer` role whose output would
otherwise be an undeclared file nobody's DAG mentions. The pack adds:

```jsonc
{ "id": "ui", "generates": "design/ui-mockup.html", "requires": ["proposal"], "scope": "unit" }
```

This is legitimate rather than a deviation: OpenSpec ships forkable schemas
(`openspec schema fork`) and treats extension as the supported path. The pack is
using the framework's own extension point.

**The boundary must be documented, not discovered.** A user running the upstream
`openspec` CLI against the same repository knows nothing about `ui-mockup.html`:
it will be invisible to CLI validation and will not be carried by CLI archiving.
The descriptor carries a note and the docs state it plainly. The failure mode of
silence here is a user losing a mockup during an archive and having no way to
know why.

### 3.5 The archive — terminal AND read-only

Two separate requirements, and only one is built:

- **Terminal phase state (FR-006b)** — `045` FR-025 makes a unit in a
  `terminal: true` section return a terminal state instead of being evaluated
  against the DAG. Without it an archived change reports `tasks: available` for
  work finished months ago.
- **Read-only enforcement (FR-009)** — `045` FR-028. Store-level editability
  alone (a writable store plus a live branch) leaves an archived change fully
  editable with no warning: exactly the "edits current truth believing it is a
  proposal" failure US4 exists to prevent, one level down.

  The guard refuses at every USER-FACING write seam: the API's write, delete and
  rename, and the spec-writing agent tool — which matters more than the UI,
  because an agent cannot see a disabled control. Rename checks BOTH ends, since
  moving into an archive is un-reviewed archiving and moving out is un-archiving.

  It is deliberately NOT enforced inside the spec filesystem. BOS must keep write
  access to these paths: seeding writes store roots, and the archive operation
  this feature defers must be able to MOVE a change into the archive. A blanket
  jail there would make that unimplementable, and only whoever tried to build it
  would find out.

**Archiving itself stays out of scope (FR-009, Non-requirements).** It parses
ADDED/MODIFIED/REMOVED, merges into the target spec, and relocates with a date
prefix — real code, and the one piece a data-only pack cannot do. A
partially-correct delta merge silently corrupts the source of truth, so no
partial implementation is acceptable. The consequence, stated rather than
hidden: **in BOS, an OpenSpec store accretes changes and never archives them.**
The user runs `openspec archive` from the CLI, or the change stays in
`changes/`. Revisit when a pack can declare a `service` facet; this is that
facet's first real customer.

### 3.6 The driver skill (FR-007, FR-008)

One `SKILL.md` plus one reference per artifact. It carries two things spec-kit's
driver does not, and they are the substance of the pack:

- **The delta-spec convention.** ADDED / MODIFIED / REMOVED against current
  truth, and the rule that implementation detail belongs in `design.md` and
  `tasks.md` — **never** in a spec. A spec says how the system behaves.
- **Brownfield framing.** Do not generate the whole `specs/` tree upfront. Specs
  accrete as changes archive. This is the premise OpenSpec is built on and the
  instinct most likely to be violated by an agent trained on greenfield flows.

**BOS knowledge is reached by skill id (`bos-domain`), never restated.** Any
sentence in this pack explaining BOS install mechanics is in the wrong place and
will drift.

### 3.7 Roles (FR-005 / US5)

OpenSpec defines no agents — commands are its abstraction. BOS's role layer is
therefore the entire quality floor here, and `roles` must name **resolvable agent
ids** (`046` FR-021): the realistic error is naming a framework command
(`opsx:propose`) or a skill id instead of an agent.

| BOS role | Attaches at |
|---|---|
| intent | `proposal` |
| architect | `design.md` |
| architect-reviewer | gates `design` |
| ui-designer | `ui` (§3.4) |
| developer | `tasks` |

### 3.8 Constitution — `config.yaml`, own store (FR-002, FR-002a, FR-011)

`constitutionRoot: "own"`, `constitution: "config.yaml"`. Unlike spec-kit — whose
constitution lives in the *system* store and is read cross-store — every OpenSpec
store carries its own.

`project.md` is a LEGACY surface — upstream detects it only to report that it
needs manual migration (`src/core/legacy-cleanup.ts`). The live one is
`openspec/config.yaml`, carrying `schema: spec-driven` and a `context:` block
injected into generated artifacts.

**The constitution is a KEY, not a file** (FR-002a). Every other method BOS
supports points `constitution` at a whole markdown file, so the obvious
predicate — "is it non-empty?" — is meaningless here: a `config.yaml` with a
schema line and no `context:` is non-empty and carries no principles. The
predicate must test for the `context:` key. This is the first descriptor whose
constitution is a FRAGMENT of a structured file, and the trap is that the wrong
predicate reports principles that do not exist rather than failing.

Consequence for switching: moving a store from spec-kit to OpenSpec finds no
source constitution inside that store, so `045` FR-009a reports **absent** and
writes nothing. The pack ships a `config.yaml` template so the user can
materialise one; `045` owns whether it is offered at assignment time.

### 3.9 Distribution (FR-015)

A `user-apps` item, exactly like BMAD: `items/openspec/` with `method/`,
`docs/`, and this `spec/` facet. It must be installed through the ordinary
install path and survive a restart (`048` FR-016, FR-019) — placing pack content
in the built-in seed location makes it inert while every surface still looks
plausible, and a fixture that copies it into place cannot detect that.

Public publishing is explicitly **not** part of this feature.

## 4. Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| D1 | Sections at the store root; the descriptor owns the layout | A `project.json` per section — restates the descriptor, drifts, and works around a `045` defect |
| D2 | Rename the LABEL (`pending` → "Available"); never the state | Renaming `PhaseState` — makes spec-kit parity inexpressible |
| D3 | Delta specs are unit-scoped **explicitly** | Relying on the default scope — conflates two different `specs` |
| D4 | Declare `ui` and document it as a BOS extension | Leaving `ui-designer`'s output undeclared, or omitting the role |
| D5 | Archiving out of scope, consequence stated | A partial delta merge — silently corrupts the source of truth |
| D6 | Read-only archive is a `045` concern (FR-028) | Faking it in the pack, which cannot express writability |
| D7 | Delta specs are browsed in the tree, not the artifact pane (§3.10) | Listing nested files as artifacts — changes `artifacts[]` for every framework and breaks `045` SC-001's parity guarantee |

## 5. Risks

- **R1 — upstream moves fast.** `project.md` was the constitution two majors
  ago; it is legacy now. Every structural claim here is verified against
  **v1.13.0** (`Fission-AI/openspec@9d4e597`) and MUST be re-verified against a
  NAMED COMMIT before any future edit. "Targets OpenSpec" without one is how
  prose drifts from the tool.
- **R2 — The `specs` overload (§3.3)** is the most likely source of a
  silently-wrong pack. Test a change with zero delta specs and assert `specs` is
  NOT `done`.
- **R3 — the read-only archive guard fails silently if it regresses.** Nothing
  reports an edit to frozen history, so its absence is invisible until a merge
  is wrong. Depends on `045` FR-028.
- **R4 — No archiving path (§3.5)** means stores grow monotonically. Acceptable,
  but it must be in the user docs, not discovered.
- **R5 — The acceptance test must stay faithful.** Its fixture was deliberately
  not simplified; one section, no archive, or no parallel edges would have hidden
  every finding the first run produced.

## 6. Files

```
items/openspec/
├── method/
│   ├── method.json                 # the descriptor
│   └── templates/
│       ├── proposal.md  spec.md  design.md  tasks.md  config.yaml
├── skills/openspec-driver/
│   ├── SKILL.md
│   └── references/{proposal,delta-specs,design,tasks}.md
├── docs/usage/OpenSpec/…
└── spec/                           # this feature's own artifacts
```

BOS-side, in `user-specs/build-studio/045-method-pack-layer`: `045` FR-019 … FR-028.
All landed — no BOS change remains for this pack.

---

## 3.10 Delta specs are browsed in the TREE, not the artifact pane (F6, F7)

Resolved from the review rather than left to be discovered.

A unit's artifact pane lists the `.md` files **directly inside** the unit. Delta
specs live at `<change>/specs/**/*.md` — nested — so after F1's fix the phase
strip can say `specs: done` while the artifact pane shows no specs at all.

**Decision: leave the artifact pane as it is, and say so.** Surfacing nested
files there would change `Specification.artifacts[]` for every framework, which
is the one shape `045` SC-001 pins byte-for-byte across 143 live spec-kit
features. Buying a cosmetic symmetry in a pack that does not exist yet, at the
cost of the only cross-framework parity guarantee BOS has, is the wrong trade.

The tree is where a change's contents are browsed, and delta specs appear there
correctly. The pack docs must state it, because "the phase says done and the
pane is empty" reads as a bug.

**Related, F7: `artifacts[].id` spans two namespaces.** For ordinary entries it
is a FILE NAME (`proposal.md`); for the delta-spec entry it is a glob key
(`specs`). `artifactOrder` sorts file names, so the `specs` entry can never
match one — harmless, and exactly the kind of thing a later reader "fixes" by
adding an entry that does nothing. Documented as two namespaces on purpose.

If this asymmetry ever becomes worth removing, the right shape is a descriptor
OPT-IN — an artifact declaring itself a set gets its matches listed — so
spec-kit, which declares none, keeps byte-identical output. It is not worth
building for one pack.
