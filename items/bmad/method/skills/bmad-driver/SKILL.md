---
name: BMAD Driver
description: Route work through BMAD — pick the smallest path that fits (trivial, epic-sized or project-sized) and run the right one of its 30 skills. NOT a pipeline to march through. This is BMAD's driver; a store bound to another method has its own.
when_to_use: When the store or project in play is bound to BMAD and you are authoring or advancing a feature through its phases. Load it because `workflow_list` named it as the method's driverSkill.
created_by: seed
pinned: false
---

Drives **BMAD** (imported from `bmad-method`; see `method/upstream.json` for the exact version). BMAD is agile-team-shaped: each phase belongs to a
named role, and the artifact of one phase is the input to the next.

**Route to the smallest path that safely fits the work — never march the user
through every phase.** That is upstream's own instruction, verbatim in intent:
*"Route the user to the smallest path that safely fits the work; never march
them through every skill."* A one-session change does not need a PRD, a UX pass
and an epic breakdown; forcing them produces ceremony, not clarity.

The order below is the shape of a FULL path, not a checklist to complete. Phases
that do not apply are legitimately skipped, and BOS reports them as such rather
than as work owed.

Load `bos-domain` when a phase needs BOS's own subsystems, not before.

## It is not a pipeline. Size follows the intent.

Upstream is explicit: *"These are independent tools, not stages. Pick the ones
the gap calls for, in any order."* BOS lists the phases in an order because a
list has to have one — **nine of the ten are marked optional**, and that is the
method speaking, not a shortcut.

Start by asking whether the intent is already well defined: what should be true
when the work is done, what must not change, what is out of scope. If it is, go
straight to `bmad-spec`. If not, use the thinking skills below to get there.

**Three paths, chosen by the size of the work:**

| Path | What to run |
|---|---|
| **Trivial** | Change → edit → verify. Do not open BMAD for an obvious, low-risk edit. |
| **Epic-sized** | `bmad-spec` with the epic intent → story breakdown → `bmad-build` once per story → `bmad-retrospective` |
| **Project-sized** | The shared documents first (`bmad-prd`, `bmad-architecture`, `bmad-ux`), then the epic path repeatedly across epics |

Never march a user through every phase. The full table below is the shape of the
LONGEST path, not a checklist to complete.

| Phase | Artifact | Role | Persona |
|---|---|---|---|
| principles | the constitution | — | — |
| brief | `product-brief.md` | analyst | Mary |
| prd | `prd.md` | pm | John |
| ux | `ux-design.md` | ui-designer | Sally |
| architecture | `architecture.md` | architect | Winston |
| epics | `epics.md` | pm | John |
| stories | `stories/*.md` (one per story) | dev | Amelia |
| review | — | — | — |

`product-brief.md` is BMAD's leaf marker — the file that makes a directory a
unit. Not `spec.md`. A unit created with the wrong marker is not discovered at
all, which is why the workflow is chosen when the project is created rather than
bound afterwards.

Two things upstream is explicit about that the phase table cannot express:

- **A product brief and a PRFAQ are alternatives — use one, never both.** They
  are two ways to shape the same concept.
- **Project context is an any-time step, not a first one.** Upstream's
  `bmad-project-context` refreshes the repo's agent instructions and is "useful
  any time, in any path". BOS shows `principles` first because a phase list has
  to have an order, not because it must be done first.

**UX belongs after the PRD, and only when the interface is a significant part of
the work.** Architecture comes before epics and stories, because it is what
keeps separately built parts consistent.

## The skills

This pack carries **BMAD's own 30 skills**, imported from the published package
(`method/upstream.json` records the version). Use them; do not reconstruct what
they do from this file.

| Phase | Skill | Notes |
|---|---|---|
| principles | `bmad-project-context` | project context is an ANY-TIME step, not a first one |
| brief | `bmad-product-brief` | or `bmad-prfaq` — **alternatives, never both** |
| prd | `bmad-prd` | ships `assets/prd-template.md` + a validation checklist |
| ux | `bmad-ux` *or* `bmad-bos-ux` | see below |
| architecture | `bmad-architecture` *or* `bmad-bos-architecture` | see below |
| epics | `bmad-create-epics-and-stories` | |
| spec | `bmad-spec` | the centre of the epic path; ships `assets/spec-template.md` |
| stories | `bmad-build` per story, *or* `bmad-bos-stories` | see below |
| review | `bmad-code-review` | |
| retrospective | `bmad-retrospective` | |

**Two of each, and the difference matters.** Three phases have BOTH an upstream
skill and a BOS-specific one:

| | use |
|---|---|
| `bmad-architecture` | architecture for the user's OWN project |
| `bmad-bos-architecture` | architecture **for BrowserOS itself** — BOS's real containers, the Supervisor, worker services, the VFS |
| `bmad-ux` / `bmad-bos-ux` | same split; the BOS one targets the window model, the iframe/app-facet boundary and the A2UI catalog |
| `bmad-create-epics-and-stories` / `bmad-bos-stories` | same split; the BOS one shards into BOS's story shapes |

Ask which system is being built. Working ON BrowserOS is the BOS skill; working
on anything else is upstream's.

**Thinking skills, for when the intent is not yet clear:** `bmad-brainstorming`,
`bmad-forge-idea`, `bmad-deep-recon`, `bmad-advanced-elicitation`. Independent
tools — reach for the one the gap calls for.

**Also available:** `bmad-help` (what to run next), `bmad-review` (review any
artifact through named lenses), `bmad-customize` (write customisation overrides
in plain language), `bmad-party-mode`, `bmad-correct-course`,
`bmad-sprint-planning`, `bmad-walkthrough`, `bmad-qa-generate-e2e-tests`,
`bmad-build-auto`.

## Templates and the Python runtime

Templates are **per skill**, under that skill's `assets/` — `prd-template.md`,
`brief-template.md`, `spec-template.md`, `spine-template.md`,
`prfaq-template.md`. There is no pack-level templates directory; a claim that
there was is what sent five phases to an empty mount before the import.

Many skills shell out to `{project-root}/_bmad/scripts/*.py` for the mechanical
half of their work — exact word counts, deterministic ID checks, the
customisation merge, the run memlog. **If those calls fail, `_bmad/` is not
installed in this repository.** Ask BOS to install it (`method_project_runtime`);
it writes into the user's own repository, so tell them where and let them decide.

`_bmad/custom/<skill>.toml` is where team customisations go — BMAD's own
mechanism, committed with the code. Never edit a skill's `customize.toml`: it
says `DO NOT EDIT` because an update overwrites it, and a full copy would freeze
today's defaults.

## Stories are the unit of implementation

`stories/*.md` — one file per story, each independently implementable, each with
acceptance criteria that can be checked. The phase is done when every story
stands alone; a story that requires reading three others is an epic that was not
sharded.

This is also what the `stories` phase's predicate counts, so the count is the
progress signal — there is no separate tracking file.

## Customising it

Each step skill has a `customize.toml` declaring what a project may override.
Edit the override, never the skill: skills are replaced wholesale on upgrade and
a direct edit is lost without warning.

## Upstream's own entry point

BMAD ships a top-level skill of its own — `bmad` ("BMad Help") — whose job is to
scan what is actually installed and recommend the next step. It is a ROUTER, not
a phase machine: it re-discovers the available skills on every request and
refuses to answer from a stale scan.

BOS's equivalent of that routing lives in the Build Studio agent's prompt
(`workflow_list` → load the method's driver), so this skill does not repeat it.
What this skill adds is the part BOS needs and upstream leaves implicit: a
declared phase list, so a unit can report where it stands.

## Do not read the pack's spec to learn this

`item-bmad`'s spec describes how this pack was BUILT for BOS. It is not usage
documentation, and reconstructing the pipeline from it produces a plausible
answer that drifts from the descriptor. The phase order above comes from
`method.json`; if you need it at runtime, `workflow_list` reports it.
