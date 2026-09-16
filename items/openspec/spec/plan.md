# Implementation Plan: The OpenSpec pack (047)

## Summary

Build OpenSpec as an installable method pack: a descriptor, templates, a driver
skill, docs, and this item's own spec facet. **No BOS source change remains** —
`045` FR-019 … FR-028 all landed, including the two the review found (a working
glob provider, and read-only enforcement for frozen sections).

The work is therefore pack content plus one thing that is easy to under-budget:
**the prose**. Roughly 80% of what actually enforces a pipeline is the driver
skill and its references. The descriptor stops BOS contradicting OpenSpec; it
does not make OpenSpec work.

## Technical context

| | |
|---|---|
| Distribution | `user-apps` item — `items/openspec/` |
| Layout | `method/{method.json,templates/,skills/}`, `docs/`, `spec/` |
| No `plugin/` | `integration` is optional in the manifest; this pack runs no code. If one is ever added it MUST carry `entrypoint` (`048` FR-017) |
| Depends on | `045` (descriptor, sections, binding, install), `046` (agent/skill seeding, role resolution) |
| Independent of | `048` — ship regardless of BMAD's state |
| Upstream | **v1.13.0**, `Fission-AI/openspec@9d4e597`, verified — `/opsx:*` is the command surface |

## Constitution check

- **Server decides, client displays** — satisfied by construction: a pack ships
  no code.
- **No workarounds** — the two available here are both rejected in `design.md`:
  modelling sections as BOS Projects (§3.1), and half-implementing the delta
  merge (§3.5). Each would make the pack *look* finished while corrupting the
  thing it is supposed to protect.
- **Docs track features** — FR-014/SC-008. Two consequences in particular must
  reach the user docs rather than being discovered: there is no archiving inside
  BOS (§3.5), and delta specs are browsed in the tree, not the artifact pane
  (§3.10).

## Test strategy

This pack exists to be the acceptance test for `045`, so its own testing is
first-class rather than a final phase.

**Already green** — `browseros tests/specs/openspec-pack.test.ts`, 9 tests
against an OpenSpec-shaped fixture built at test time. It found the six defects
in the acceptance run and two more in review. When `method.json` is written it
MUST replace the fixture descriptor in that file, so the shipped descriptor is
what is under test rather than a hand-written lookalike.

**Three rules carried from what went wrong here:**

1. **Test the negative.** F1 shipped because a test asserted "no delta specs ⇒
   not done", which passes whether the glob works or cannot match at all. Every
   glob-gated phase needs the POSITIVE case too.
2. **Drive the product's call path.** Three separate defects in this feature
   family survived tests that called a helper the product does not call.
3. **A fixture may not supply the step under test.** `048`'s inert-pack bug
   survived a test that copied the pack into place itself.

**Still to write** — e2e on `045` FR-017a's fixture-pack harness (FR-013), and a
live install: install from `user-apps`, restart, confirm the pack is still
registered (`048` FR-016/FR-019).

## Phase breakdown

| Phase | What | Gate |
|---|---|---|
| 0 | Acceptance test adopts the real descriptor | existing 9 tests still green |
| 1 | `method.json` — sections, DAG, artifacts, labels, roles | F3's explicit `scope`, no dangling roles |
| 2 | Templates (adapted from upstream) + `config.yaml` | a fresh store can be authored end to end |
| 3 | Driver skill + one reference per artifact | delta convention + brownfield framing present |
| 4 | Distribution: manifest entry, real install, restart | pack survives a restart |
| 5 | User docs | carries F5 and F6 explicitly |
| 6 | e2e + live smoke | `npm run validate:methods` green |

Phases 1–3 are the substance. Phase 1 is a day; phase 3 is not.

## Rollout

Additive throughout. Nothing existing changes: spec-kit stores are untouched,
and no store adopts OpenSpec until someone binds it. Per `045` FR-010 adoption
is additive — a new store or a new Project, never a migration of existing
spec-kit features (explicitly a non-requirement).

The pack can ship half-built without harm, since an unbound method affects
nothing. It should not: an installed pack a user can bind to, whose driver skill
is absent, produces a store that discovers correctly and authors nothing.

## Risks carried into implementation

- **R1 — MATERIALISED before implementation began.** The original research
  described a superseded surface: `project.md` is legacy in v1.13 and the
  constitution is `config.yaml`. Now verified against
  `Fission-AI/openspec@9d4e597` (v1.13.0). Re-verify against a NAMED COMMIT
  before any future edit — "targets OpenSpec" without one is how this drifted.
- **R2 — the `specs` overload (§3.3)** is the likeliest silent failure in the
  pack. Mitigated by explicit `scope: "unit"` and a negative test — both
  required, neither optional.
- **R3 — no archiving path** means stores grow monotonically and `specs/` never
  accrues truth. Correct decision, user-visible consequence; it must be in the
  docs.
- **R4 — the prose is the deliverable.** The temptation is to ship the
  descriptor, see units render, and call it done. A pack whose driver skill does
  not carry the delta convention produces specs with implementation detail in
  them, which is precisely what OpenSpec exists to prevent.
- **R5 — roles are cross-namespace by hand.** Four of five were wrong in the
  first real pack (`046` FR-021). Verify at install, not by reading.
