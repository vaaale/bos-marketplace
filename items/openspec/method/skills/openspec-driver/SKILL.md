---
name: OpenSpec Driver
description: Drive the OpenSpec pipeline — propose a change, write its delta specs and design, plan tasks, then apply them.
when_to_use: When authoring or advancing work in a spec store bound to the OpenSpec method — i.e. running any OpenSpec stage (proposal, delta specs, design, tasks, apply) in a store laid out as changes/ + specs/.
created_by: seed
pinned: false
---

Drives **OpenSpec** (verified against v1.13.0). OpenSpec is deliberately
lightweight and brownfield-first: it assumes the system already exists, and that
specs accrete as changes land rather than being written up front.

Load the `bos-domain` skill for anything about BOS itself — install mechanics,
stores, branches. None of that is restated here, and a copy would drift.

## The two trees — never confuse them

A store bound to this method has **two live trees plus an archive**:

```
<store>/
├── config.yaml     project context, injected into every artifact
├── specs/          THE SPECS TREE — how the system behaves TODAY
│   └── <capability-path>/spec.md
└── changes/        proposals — work in flight
    ├── <change-name>/
    │   ├── proposal.md
    │   ├── specs/  DELTA SPECS — what THIS change alters
    │   ├── design.md
    │   └── tasks.md
    └── archive/    completed, frozen, read-only
```

**"The specs tree" and "delta specs" are different things and must always be
called by those names.** The specs tree is current truth for the whole store. A
delta spec is a fragment inside ONE change describing what that change alters.
They are both called `specs` by the file system, and collapsing the terms is the
single most likely way to corrupt a store: a delta written into the specs tree
silently rewrites current truth.

**Never edit the specs tree by hand.** It is updated only by archiving a change.

## The flow

```
proposal ──┬──> delta specs ──┐
           └──> design ───────┴──> tasks ──> apply
```

**Dependencies are enablers, not gates.** Once `proposal.md` exists, delta specs
*and* design are both available — pick either, or do both. BOS shows them as
**"Available"**, which means *you may do this now*, not *you owe this next*.
Never tell the user "next, write the specs" when design is equally open.

`tasks` is done when the plan is WRITTEN. `apply` is done when the work is DONE.

Changes are **named, never numbered** — `add-dark-mode`, not `001-add-dark-mode`.

| Stage | Reference |
|---|---|
| proposal | `references/proposal.md` |
| delta specs | `references/delta-specs.md` |
| design | `references/design.md` |
| tasks + apply | `references/tasks-and-apply.md` |

## Four rules that fail SILENTLY

Get these wrong and nothing errors — the result is simply wrong, and validation
cannot tell the difference. They matter more than anything else in this skill.

1. **Scenarios take exactly four hashtags** — `#### Scenario:`. Three hashtags
   or a bullet list "will fail silently" (upstream's words). A requirement whose
   scenarios are malformed is indistinguishable from one that has none.
2. **A new-capability delta must open with `## Purpose`** (50+ characters).
   Omit it and archive writes a `TBD ... Update Purpose after archive`
   placeholder into the **main** spec — the operation meant to protect truth
   quietly corrupts it. Do **not** add `## Purpose` to a delta for an existing
   capability; there it is ignored.
3. **A change with no delta specs is rejected** unless its `.openspec.yaml` sets
   `skip_specs: true`. Use that for pure refactors, tooling and docs — anything
   with no spec-level behaviour change. **Never invent a requirement to satisfy
   the validator.** If behaviour does not change, no spec should change.
4. **`MODIFIED` requires the ENTIRE updated requirement**, header through every
   scenario. A partial MODIFIED loses the rest at archive time. Adding a new
   concern without changing existing behaviour is `ADDED`, not `MODIFIED`.

## Specs describe behaviour, not implementation

The one rule OpenSpec exists to enforce:

> If the implementation can change without changing externally visible
> behaviour, it does not belong in a spec.

Internal class and function names, library choices, and step-by-step plans go in
`design.md` and `tasks.md`. Prefer positive statements of the user-visible
outcome over negative SHALL-NOTs about the mechanism.

## Brownfield: do NOT generate the specs tree up front

The specs tree grows from archived changes, one capability at a time. Writing it
wholesale from a reading of the codebase produces specs nobody agreed to, which
then look authoritative.

If the store's specs tree is empty, that is the normal starting state. Propose a
change.

## Archiving is NOT available inside BOS

Archiving merges each delta's ADDED/MODIFIED/REMOVED into the specs tree and
moves the change under `changes/archive/` with a date prefix. It is a real
semantic operation, and BOS does not implement it — a partially-correct merge
silently corrupts the source of truth, so no partial version ships.

**Consequence, and say it plainly when asked:** inside BOS a store accumulates
changes and the specs tree never grows. Run `openspec archive <change>` from the
CLI to complete the cycle.

Content under `changes/archive/` is **read-only** — BOS refuses writes to it.
That is frozen history, and other specs were merged from it.
