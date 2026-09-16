# Implementation Plan: The BMAD pack (048)

**Branch**: `bos/spec-method-packs` | **Date**: 2026-09-12 | **Spec**: [`spec.md`](./spec.md) | **Design**: [`design.md`](./design.md)

## Summary

Four mechanisms and one large body of content. The mechanisms extend 045's agent-root layer and install path; the content is BMAD's cast and workflows, authored to produce BOS-grounded output.

Architecture, six ADRs and the file plan are in [`design.md`](./design.md), which was reviewed 2026-09-12 (six findings, all fixed; FR-001 amended and FR-006a added as a result).

**Scope: FULL — BMM + BMB + CIS.** The spec's BMM-only valve is not taken, but stays available as a mid-implementation retreat. See "The valve" below for exactly when to pull it.

## Technical Context

**Language/Version**: TypeScript 5.x (mechanism) + Markdown/YAML/JSON (content).

**Primary Dependencies**: none new in BOS. The pack pins an upstream BMAD version.

**Storage**: `data/method-packs/<packId>/` (new — the overlay), `data/system/config/<id>/` (module selection, existing `itemConfigDir`), `data/user-apps/items/<pack-id>/` (the pack itself).

**Testing**: `npm run test:unit` — **never** bare `npx playwright test -c playwright.unit.config.ts`. Fixtures come from `e2e/_fixtures/method-pack/` (045 T002a), extended here with a writable-overlay variant.

**Target Platform**: Next.js server + the existing bos-plugin loader. No new runtime.

**Project Type**: `bos-core` (the mechanism) + `marketplace-item` (the pack). **Two targets in one feature** — unusual, and the reason Phase 4 is separable from Phases 1–3.

**Constraints**: `METHOD_SCHEMA_VERSION` MUST NOT change (FR-006a). No new trust mechanism (ADR-5). `resolve()` MUST emit no files (FR-001).

**Scale/Scope**: 22 FRs, 13 SCs. ~30% mechanism, ~70% content.

## Constitution Check

All seven assessed in [`design.md` §2](./design.md). Two carry into implementation:

- **IV (NON-NEGOTIABLE)** — first pack executing code in the Next.js process. Containment is three existing facts (per-user blast radius, origin gate on redistribution, the reviewed bos-plugin loader), **not** a new mechanism. A task that invents pack-specific sandboxing is out of scope by ADR-5.
- **VI (NON-NEGOTIABLE)** — FR-014's docs land **with** the mechanism, not after. `docs/dev/method-packs.md` gains provider-root and overlay sections in the phase that introduces them.

**No violations.**

## Design notes that change task shape

Only the ones that alter sequencing or decomposition:

1. **The union breaks four call sites, not one** (design §3.1 / F4). `idsIn`, `agentRootCollisions`, `shadowedPackAgentReport` and `listAgentsAcrossRoots` all read `root.path`, which a provider root lacks. The fix is ONE dispatch yielding `{id, load()}` per root — so it is a single task, not four, and it must land in the same commit as the union or `tsc` is red.

2. **FR-006a is backward-compatible by construction.** `modules` accepts `string[] | ModuleSpec[]`. No migration task, no `schemaVersion` task. A task that bumps the constant is a defect.

3. **FR-011a forbids the obvious shortcut.** The shipped cast is authored UPSTREAM (BMAD + BMB outside BOS, adapted by hand) and checked in. BMB-in-BOS is for subsequent customisation only. The two loops are separate tasks in separate phases and must not be merged — "just use BMB to generate the cast" cannot work, because the pack must be installed for BMB to run.

4. **The overlay needs a writable fixture** (R5). 045 T002a produces read-only packs. Extending it is a prerequisite for the BMB round-trip test, not a Phase 4 afterthought.

5. **Content has no mechanical acceptance test** (R1). FR-010's tasks end in "reviewed against a real feature", not "green". Plan on iterating.

6. **Two VFS prefixes were collapsed to one** (F5). Everything a pack exposes is under `/Methods/<id>/` — `templates` (045) and `overlay` (here). A task introducing a third prefix is a defect.

## Test Strategy

| Layer | Covers |
|---|---|
| Unit — `tests/agent/agent-roots.test.ts` (extend) | Provider roots in the four-level order; `delegate-only` still delegatable; collisions/shadowing across both root kinds. |
| Unit — `tests/specs/method-pack-fixture.test.ts` (extend) | Module selection (BMM alone → +CIS → removal), overlay precedence, overlay inertness when the pack is absent, the #999 shim's loud failure. |
| Unit — new `tests/agent/provider-roots.test.ts` | `resolve()` emits no files; the `(root, max mtime)` cache re-resolves on change and does not serve stale results. |
| **E2E** — `e2e/048-bmad-pack.spec.ts` | SC-012: module selection, the BMB round trip **without a restart**, overlay survival across a pack-root upgrade. |
| **Manual** | SC-001 (a real `project-brief → prd → architecture → stories` run) and FR-010's output quality. Judgement, not assertion. |

**The e2e prerequisite is real and currently unmet.** 045 T031 — the browser-level spec and the `build-studio.spec.ts:49-56` skip conversion — was never written. 048's SC-012 is browser-level. T031 is therefore scheduled INSIDE this feature (Phase 0) rather than assumed; inheriting the gap silently is exactly what the 046 review caught me doing with T025.

## Phase breakdown

| Phase | Content | Revert point |
|---|---|---|
| **0** | Prerequisites: writable-overlay fixture; 045 T031's e2e harness | Nothing new in `src/` |
| **1** | M1 — provider roots + the four-call-site dispatch | Agents resolve from a provider; no overlay yet |
| **2** | M2 — the overlay, its mount, inertness, four-level precedence | BMB has somewhere to write |
| **3** | M3 + M4 — module selection, per-module visibility, the #999 shim | Mechanism complete; no BMAD content yet |
| **4** | Content — the pack itself: descriptor, cast, workflows, docs | The feature |
| **5** | Gates | — |

Phases 1–3 are `bos-core` and independently revertible with a green suite. Phase 4 is a `marketplace-item` and reverts by not shipping the item — which is what makes the valve cheap.

**The valve.** If Phase 4 sprawls, cut to BMM-only and defer BMB/CIS to a follow-up. Pull it when Phase 4's BMM half is done and the BMB/CIS half has not started after a full working session. **Do NOT cut the overlay** (Phase 2) — without it customisation has nowhere to write and the authoring loop never closes, so cutting it makes BMB undeliverable later rather than deferred.

## Rollout

Same feature branch. The mechanism ships with BOS; the pack is installed per user from their own `user-apps` (FR-015).

**This feature does not complete on merge.** FR-010's content needs real features run through it (R1). Expect prose revisions per upstream BMAD release (R2, FR-008a).

## Risks carried into implementation

- **R1 — content is unbounded and untestable mechanically.** The largest part of the feature, with judgement as its only gate.
- **R2 — BMAD v6 is alpha.** Pin the version; expect churn. Keep the descriptor `schemaVersion` and the upstream BMAD version strictly separate (FR-008a).
- **R3 — the circular authoring loop** (FR-011a) is easy to re-introduce under time pressure.
- **R4 — provider caching is a CORRECTNESS risk, not a perf one.** A stale cache means a BMB-authored agent does not appear, which reads as BMB being broken. Prefer re-resolving when the mtime scan is ambiguous.
- **R5 — the writable-overlay fixture does not exist yet.** Phase 0.
- **R6 — 045 T031 is unwritten.** Scheduled in Phase 0 rather than inherited.
- **R7 — two targets in one feature.** `bos-core` and `marketplace-item` have different delegation mechanics and different promote paths. Do not let a Phase 4 content task drift into `src/`.

## Amendment 2026-09-14 — Phase 5, and what this plan missed

Phases 1–4 shipped. The mechanism half (provider roots, overlay, modules,
precedence) is sound and is used unchanged. The CONTENT half produced a pack with
4 skills where BMAD publishes 30, no templates where upstream ships 26, and 3
`customize.toml` where upstream has 27.

**The plan never counted the thing it was building.** Its test strategy asserts
mechanism — provider roots resolve, the overlay survives an upgrade, precedence
is one rule — and every one of those passed. Nothing asserted COVERAGE of the
method being packaged, so "we shipped a fraction of BMAD" was not a failing test,
it was not a test at all. SC-017 is now that count.

Three further lessons, each cheap to have applied:

1. **Read the package, not only the docs.** The 2026-09-12 reconnaissance session
   cloned the repos and got the important things right — skills not YAML,
   `customize.toml`, `resolve_customization.py`. It did not run `npm pack` and
   count what an install produces. The 30/26/27 numbers were one command away and
   would have redirected Phase 4 entirely.

2. **"Author BOS-specific meaning" needed a boundary.** FR-010 as written scales
   to a handful of skills and silently licenses rewriting a whole method. The
   amendment draws the line where it belongs: import everything, overlay only
   where BOS's own subsystems change the answer.

3. **A pack that vendors a toolchain must state its runtime.** BMAD needs `uv`,
   four Python scripts and a `{project-root}`. None of that appears in this plan's
   Technical Context, and it is the difference between working on a developer
   machine and working in production.

Phase 5's ordering follows from that: the two BOS-side blockers (skill assets,
`uv`) land first, because the import is not verifiable without them.
