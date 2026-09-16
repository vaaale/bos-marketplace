# Tasks — 048 The BMAD pack

Spec: [`spec.md`](./spec.md) · Design: [`design.md`](./design.md) · Plan: [`plan.md`](./plan.md)

**Four rules that are not negotiable:**

1. **`METHOD_SCHEMA_VERSION` MUST NOT change** (FR-006a). `registerMethod` refuses a mismatch, so a bump makes BOS reject every existing pack — spec-kit's own `method.json` included — for a purely additive field. A task that bumps it is a defect.
2. **`resolve()` emits no files** (FR-001). The moment it writes one, 035's "install copies nothing" is broken and a staleness class exists with no invalidation point.
3. **The shipped cast is authored UPSTREAM** (FR-011a). BMB-in-BOS customises it afterwards. "Just use BMB to generate the cast" cannot work — the pack must be installed for BMB to run.
4. **No new trust mechanism** (ADR-5). Containment is the three existing facts. A task inventing pack-specific sandboxing is out of scope.

---

## PHASE 0 — Prerequisites

### T001 — Writable-overlay fixture
- **Files:** `e2e/_fixtures/method-pack/index.ts`
- **Story:** R5, FR-013
- **Work:**
  - Extend the harness with `writeOverlay(dataDir, packId, { agents })` and `overlayPath(dataDir, packId)`.
  - Needed by every overlay test and by the BMB round trip; 045 T002a produces read-only packs only.
- **Acceptance:** a test can create overlay content and assert it shadows the pack root. **Blocks T006–T009.**

### T002 — 045 T031: the browser-level e2e that was never written
- **Files:** `e2e/045-method-packs.spec.ts` (new); convert `e2e/build-studio.spec.ts:49-56`
- **Story:** R6, 045 SC-013
- **Work:**
  - Phase strip incl. `blocked`, the Method dropdown, preflight, section badges.
  - Convert `build-studio.spec.ts`'s `test.skip(true, "no marketplace item installed in this environment")` onto T001's fixture. **A test that passes by skipping is not coverage**, and it is the pre-seeded-data dependency BOS's testing rule prohibits.
  - Scheduled HERE, not inherited: 048 SC-012 is browser-level, and 045's e2e gap would otherwise become 048's silently.
- **Acceptance:** no test in the touched set skips for want of environment state. **Blocks T017.**

---

## PHASE 1 — M1: provider roots

### T003 — The `AgentRoot` union + ONE dispatch
- **Files:** `src/lib/agent/subagents/roots.ts`, `src/lib/agent/subagents/store.ts`
- **Story:** FR-001, FR-002, FR-003
- **Work:**
  - `AgentRoot` becomes `dir | provider`. `provider` carries `resolve(): Promise<{agents, phases?}>` and `watch: string[]`; **no `path`**.
  - **This breaks FOUR call sites, which is why they are one task, not four:** `idsIn` (`store.ts:323`) does `readdir(root.path)`; `listAgentsAcrossRoots` (`:374`) does `readFile(join(root.path, id, "AGENT.md"))`; `agentRootCollisions` and `shadowedPackAgentReport` both go through `idsIn`. Introduce **one** dispatch yielding `{ id, load() }` per root regardless of kind, consumed by all four — not four `kind === "provider"` branches. Same shape as 045's four-copies-of-the-leaf-rule.
  - `phases` is declared and **unread** (FR-003, ADR-6).
- **Acceptance:** `tsc` clean in one commit (a split leaves it red); both root kinds flow through one code path, verified by there being one.

### T004 — Discovery-time invocation + the `(root, max mtime)` cache
- **Files:** `src/lib/agent/subagents/store.ts`, `tests/agent/provider-roots.test.ts` (new)
- **Story:** FR-002, US2
- **Work:**
  - Invoke at discovery, never at boot: `listAgentsAcrossRoots` re-reads every root per call, which is why editing an `AGENT.md` needs no restart. Boot parsing makes BMAD agents the one kind requiring a bounce — worst for BMB, whose purpose is interactive authoring.
  - Cache on `(root, max mtime over watch[])`. **Not a boolean and not per-process**: `store.ts` already keys its seed guard on a `Set` of data roots because `dataDir()` is env-driven and a single boolean meant only the first root was ever seeded.
  - **R4 — this is a correctness risk, not a perf one.** A stale result means a BMB-authored agent does not appear, which reads as BMB being broken. Re-resolve when the mtime scan is ambiguous.
- **Acceptance:** a new agent file resolves on the next call with no restart; `resolve()` writes nothing (asserted by diffing the tree).

### T005 — Register the provider from the pack's `plugin/` facet
- **Files:** the pack's `plugin/` entry
- **Story:** FR-002
- **Work:** Register through the existing `loadAllPlugins()` (`bos-plugins/loader.ts:113-117`), which already filters `facets.plugin && !broken` and loads from the item symlink. **No new loader** (ADR-5).
- **Acceptance:** provider registered at boot; agents appear in `agent_list`. **Phase 1 revert point.**

---

## PHASE 2 — M2: the overlay

### T006 — Overlay paths + inertness
- **Files:** `src/lib/specs/method/overlay.ts` (new)
- **Story:** FR-004, FR-004a
- **Work:**
  - `data/method-packs/<packId>/`, mirroring the pack's internal layout.
  - **FR-004a — enumeration starts from INSTALLED PACKS, never from the overlay directory listing.** If the overlay can bring content into existence, it has become a second install path and 035's one-mechanism rule is broken. A stray overlay is inert and **reported** — surfaced through 046 T010's shadowed-agent report, not a second report.
  - Precedent is `itemConfigDir` (`installed.ts:37`): BOS already keeps user-mutable state for an installed item outside the item, without that being an install.
- **Acceptance:** SC-010 — an overlay whose pack is absent brings nothing into existence and is reported.

### T007 — Four-level precedence, still ONE rule
- **Files:** `src/lib/agent/subagents/roots.ts`, `tests/agent/agent-roots.test.ts`
- **Story:** FR-002a
- **Work:**
  - Insert the overlay as level 2: `data/agents/` → **overlay** → pack root → `seed/agents/`.
  - `collisionsAmong` and `shadowedPackAgents` **extend** to cover it; they do not gain siblings. **There must not be two precedence rules** (SC-010).
  - Ordering rationale, for the comment: the overlay outranks the pack root because it exists to shadow it (US3); `data/agents/` outranks the overlay because a hand-written BOS agent is a deliberate BOS-format override.
- **Acceptance:** exactly one precedence rule covering all four levels, asserted by test.

### T008 — The overlay VFS mount
- **Files:** `src/lib/specs/spec-mount.ts`, `src/lib/specs/method/install.ts`
- **Story:** FR-005
- **Work:**
  - `/Methods/<packId>/overlay` → jailed `LocalFS`. Registered at install, **unregistered at uninstall** (045 T002's `unregisterMount` exists for this).
  - **One prefix per pack**: `/Methods/<id>/templates` (045) and `/Methods/<id>/overlay` (here). A third prefix is a defect (F5).
  - The pack root stays `ReadonlyFS` and must never be writable.
  - **Not git-backed, deliberately** (F6): `LocalFS`, not `SpecFS`. US3 needs survival across upgrade, which this satisfies; git-backing would couple a user's agent edits to BOS's feature-branch machinery for no stated requirement. Record the revisit condition in the code comment.
- **Acceptance:** BMB writes through `file_*`; the pack root refuses writes; the mount disappears on uninstall.

### T009 — Overlay survives a pack upgrade
- **Files:** `tests/specs/method-pack-fixture.test.ts`
- **Story:** FR-004, US3, SC-005
- **Work:** Customise an agent in the overlay, upgrade the pack root via the harness's `upgradePack`, assert the customisation is intact and still wins.
- **Acceptance:** SC-005. **Phase 2 revert point.**

---

## PHASE 3 — M3 + M4: modules and the shim

### T010 — `ModuleSpec`, backward compatible
- **Files:** `src/lib/specs/method/types.ts`
- **Story:** FR-006, FR-006a
- **Work:**
  - `modules?: string[] | ModuleSpec[]`, normalising a bare string to `{ id, default: true }`.
  - **Do not bump `METHOD_SCHEMA_VERSION`** — rule 1.
- **Acceptance:** a 045-era descriptor with `modules: ["a"]` still registers.

### T011 — Module selection, stored in `itemConfigDir`
- **Files:** `src/lib/specs/method/install.ts`
- **Story:** FR-006, FR-007
- **Work:**
  - Selection lives in `itemConfigDir(packId)` — **not** the descriptor (pack content, overwritten on upgrade) and **not** the overlay (content, not settings). ADR-4.
  - One agent root per SELECTED module, so `agentRoots()` gains one entry per module rather than per pack.
  - Per-module `visibility` (FR-007): `bmm` → `delegate-only`, `bmb`/`cis` → `picker`, with a per-agent override for mixed modules.
- **Acceptance:** SC-002, SC-003 — BMM alone yields its agents only; +CIS adds five `picker`-visible; removal removes them; BMM's stay absent from the picker and reachable by `agent_delegate`.

### T012 — Module selection UI
- **Files:** `src/apps/marketplace/index.tsx`
- **Story:** FR-006
- **Work:** Choose modules at install, defaulting to the descriptor's `default` flags. Mirrors BMAD's own installer.
- **Acceptance:** US4 — install with BMM only, then add CIS.

### T013 — The #999 shim
- **Files:** the pack's `plugin/`
- **Story:** FR-009
- **Work:**
  - Gate on a pinned BMAD version range, cite the issue, and **fail loudly** on an unrecognised layout.
  - The failure being designed against is upstream FIXING #999: a silent rewrite would then corrupt correct paths, invisibly. It must break the day the assumption stops holding.
  - MUST NOT rewrite paths that may already be correct.
- **Acceptance:** SC-006 — verified with a fixture whose layout the shim does not recognise. **Phase 3 revert point — mechanism complete.**

---

## PHASE 4 — Content (the pack itself)

> **~70% of the feature, and the part with no mechanical acceptance test (R1).** Every task here ends in "reviewed against a real feature", not "green". Phase 4 reverts by not shipping the item — which is what makes the valve cheap.

### T014 — The pack skeleton + descriptor
- **Files:** `data/user-apps/items/bmad-method/`
- **Story:** FR-015, FR-006
- **Work:** `method/method.json` + `plugin/` — the first pack carrying **two** facets. Modules declared with `default`/`requiresConfig`/`agentsDir`/`visibility`. Pin the upstream BMAD version, kept strictly separate from `schemaVersion` (FR-008a).
- **Acceptance:** SC-007 — installs through the normal path and FR-008's install-time code warning renders. Verifiable at last: the warning was built in 045 T025 on 2026-09-12, having been dropped from that task's first pass.

### T015 — The BMM cast, authored upstream
- **Files:** the pack's `method/modules/bmm/agents/`
- **Story:** FR-010, FR-011, FR-011a, FR-011b
- **Work:**
  - **Authored UPSTREAM and checked in** — rule 3. BMB-in-BOS is T018's loop, not this one.
  - Every agent reaches BOS facts via `skill_load('bos-domain')` and embeds none. If BOS knowledge is baked in, the duplication this whole series removed reappears where nobody greps.
  - `roles` binds personas to BOS capability agents: Dev → `developer` (the agent holding repo access) rather than replacing it. SM/PO declare none.
- **Acceptance:** SC-009 — grep finds zero BOS subsystem facts in pack agent definitions.

### T016 — BMM's workflows, BOS-grounded
- **Files:** the pack's `method/modules/bmm/workflows/`
- **Story:** FR-010, FR-012, SC-011
- **Work:**
  - `create-architecture` → BOS's real containers, referenced from `bos-domain`, not copied.
  - `create-front-end-spec` → BOS's window model, the iframe/app-facet split, the A2UI v0.9 catalog.
  - PRD → epics → stories mapped onto descriptor artifacts, with sharded stories handled by 045's `set`/`count` predicates over a glob.
  - FR-012: state that BMAD's "fresh chat per workflow" maps to BOS's delegation boundary — the inner loop already gives a delegated agent its own prompt and history. Do NOT build new-conversation-per-workflow.
- **Acceptance:** SC-011 — **no BMAD-specific evaluation code in the pipeline**, verified by grep. SC-001 by judgement, on a real feature.

> **PHASE 4 OUTCOME, recorded 2026-09-14.** T014–T016 shipped, and shipped the
> wrong thing. The pack carries **4 skills where BMAD publishes 30**, no
> templates (26 upstream, in 9 skills' `assets/`), and 3 `customize.toml` where
> upstream has 27. T017 was cut by its own valve — and correctly so, since `bmb`
> and `cis` are separate upstream repositories, not this pack's content. The
> declarations for them were left behind, offering modules that contributed
> nothing until BOS's new install check found them.
>
> Phase 5 re-derives from the published package. See spec FR-022…FR-027.

### T017 — CIS + BMB modules
- **Files:** the pack's `method/modules/{cis,bmb}/`
- **Story:** FR-006, FR-007, US2
- **Work:**
  - CIS: five facilitators, `picker`-visible, no module config. The cheapest integration test of the mechanism.
  - BMB: the builder agent + `create-agent`/`create-workflow`/`create-module`, writing to the overlay through T008's mount.
  - **This is where the valve applies.** If T014–T016 have consumed a full session and this has not started, cut to BMM-only and defer.
- **Acceptance:** SC-004 — `create-agent` produces an agent usable **without a server restart**, written to the overlay, shadowing nothing in the pack root.

### T018 — Documentation
- **Files:** the pack's `docs/usage/`, `docs/dev/method-packs.md`, `docs/usage/` pointer
- **Story:** FR-014, Constitution VI (NON-NEGOTIABLE)
- **Work:**
  - Pack docs: module selection, which agents are conversational vs `delegate-only`, how BMB customisation works and **where it writes**, the pinned BMAD version.
  - `method-packs.md` gains provider-root and overlay sections — the authoring reference must describe both root kinds, not just `dir`.
- **Acceptance:** SC-013.

---

## PHASE 5 — Gates

### T019 — Gates
- **Files:** —
- **Story:** SC-008, SC-012
- **Work:**
  - `npx tsc --noEmit`; `npm run lint`; `npm run test:unit`.
  - **Re-run 045's parity harness and 046's pack tests** (SC-008) — this feature changes the agent-root layer both depend on.
  - E2E on bundled fixtures: module selection, the BMB round trip without a restart, overlay survival.
  - **Manual:** a real `project-brief → prd → architecture → stories` run, reviewed against BOS's actual subsystems (SC-001, FR-010).
- **Acceptance:** all green; Phases 1–3 independently revertible.

---

## Dependency summary

```text
T001 → T006, T007, T008, T009      writable-overlay fixture gates every overlay task
T002 → T017                        browser-level e2e gates the BMB round trip (SC-012)

T003 → T004 → T005                 [Phase 1 revert: agents resolve from a provider]
T005 → T006 → T007 → T008 → T009   [Phase 2 revert: BMB has somewhere to write]

T009 → T010
T010 → T011 → T012 → T017          module selection, needed to install CIS/BMB
T010 → T013                        [Phase 3 revert: mechanism complete]

T013 → T014 → T015 → T016 → T017 → T018 → T019
```

Written as an explicit edge list rather than ASCII art. The art version hid a
real error through two revisions — and a graph whose correctness cannot be
checked without a decoder ring is not a graph, it is a picture of one.

**Why T003 is one task and not four:** the union change and the four call sites it breaks must land together or `tsc` is red. Splitting them is not a smaller commit, it is a broken one.

**Why Phase 0 contains 045's T031:** 048 SC-012 is browser-level and 045's e2e was never written. Scheduling it here makes the gap explicit rather than letting 048 inherit it — the failure the 046 review caught with T025's dropped bullet.

**Parallelisable:** T001/T002 (different files); T012/T013 (unrelated surfaces); T015/T016 after T014 (cast and workflows are separable, though both inform each other in review).

**Critical path** — verified as an actual path through the graph:

`T003 → T004 → T005 → T006 → T007 → T008 → T009 → T010 → T013 → T014 → T015 → T016 → T017 → T018 → T019`

---

## Distribution guards

- **T-G1 — Install from `user-apps` through the real path (FR-016).** No fixture
  may copy the pack into place; if the pack is not distributed as an item, the
  test must FAIL.
- **T-G2 — Restart pass (FR-019, SC-014).** Register installed packs at boot;
  assert across a real restart, not within the installing process.
- **T-G3 — Lazy ensure (FR-020).** Every consumer can force registration on
  demand, memoised. Exercise it from a route, not from the boot path.
- **T-G4 — Manifest round-trip (FR-018, SC-015).** A pack's `modules` survive a
  BOS-initiated repair; a malformed entry disables only itself.
- **T-G5 — Message derivation (FR-021, SC-016).** Assert the warning names only
  phases and state labels present in the TARGET descriptor, including the case
  where the target reads no constitution at all and the sentence must be omitted.
- **T-G6 — Live smoke run.** Install, restart, switch, delegate — against a
  RUNNING BOS. This is the only step that has ever found these.


## PHASE 5 — Re-derivation from the published package (2026-09-14) — COMPLETE

> Phase 4 hand-wrote what upstream already ships. This phase replaced that with
> an IMPORT, so the pack tracks BMAD instead of diverging from it.
>
> | | before | after |
> |---|---|---|
> | skills | 4 | **34** (30 imported + driver + 3 BOS) |
> | templates | 0, and a declared dir that never existed | **26**, per skill under `assets/` |
> | `customize.toml` | 3 | **30** |
> | Python runtime | none | 5 shared scripts + a `projectRuntime` declaration |
> | `bmad-spec` / `bmad-build` | absent | present |
> | optional phases | 0 of 8 | **9 of 10** |

- **T019 — BOS skills carry a whole directory. DONE.** `Skill.files` carries
  everything that is not `SKILL.md`/`scripts/`/`references/`, by relative path,
  and the change-hash covers it.
  *Corrected mid-task:* FR-024 claimed the import would "silently drop 26
  templates". It would not — `copyAsset` does a recursive `fs.cp` and
  `listSkillFiles` walks whatever is there, so the assets always arrived and an
  agent could always read them. The real gap was the object model around that
  copy. Narrower than written, still worth fixing.
  *Not another allowlist:* adding `assets` would have carried the templates and
  dropped `review-prompts/`, `steps/`, `templates/`, `agents/` and the loose root
  files. Carry the directory as it is.

- **T020 — `uv` in both images. DONE.**
  *Corrected:* `uv` installs nothing here. Every PEP 723 block declares only
  `requires-python`, and node:trixie's 3.13 satisfies it; all four shared scripts
  run under plain `python3`, verified by running them. `uv` is carried so BMAD's
  75 files run VERBATIM rather than needing `uv run` rewritten on every
  re-import. One real third-party dependency in the whole of BMAD's Python:
  `ruamel.yaml`, added alongside.
  *Rejected, with reasons in FR-025:* reimplementing the ~5,200 lines in
  TypeScript. It forks someone else's runtime permanently, and FR-004 already
  forbids the largest piece — `resolve_customization.py` IS the merge BMAD owns.

- **T021 — `_bmad/` in the store's repository. DONE.** `project-runtime.ts`.
  `{project-root}` resolves to the store's `repoRoot` (050). The module is mostly
  restraint: only when a pack DECLARES it, never as a side effect of a read path,
  never over a `preserve` path. `custom/` is preserved as a whole directory, so a
  file the user adds under it is safe without the pack knowing.

- **T022 — import the 30 skills, repeatably. DONE.**
  `tools/import-upstream.mjs <version>` reads `npm pack bmad-method@<version>`.
  30 skills, 214 files. Not vendored, each with its reason: `v6-shims` (upstream's
  aliases for pre-v6 names — BOS has no users of them), `tests/`, `__pycache__`.
  *SC-017 is the test this feature never had:* it counts the pack's skills against
  `upstream.json`, not against a number someone typed. Writing it caught a bad
  assertion of mine — I banned `bmad-create-*` as shims, which would have banned
  `bmad-create-epics-and-stories`, a real plan skill.

- **T023 — the BOS skills survive the import. DONE, differently.**
  *FR-027 corrected:* "overlay over their upstream counterparts" is neither
  achievable (nothing resolves skills through the pack overlay) nor desirable
  (they are DIFFERENT skills — generic versus BOS-specific — and shadowing would
  put upstream's generic version out of reach). The property that must hold is
  that a re-import cannot clobber them, which is structural: different ids, and
  the importer writes only upstream's. Asserted.

- **T024 — BMAD stops claiming to be a pipeline. DONE.**
  *FR-023 corrected:* `WorkflowSpec` carries no phases, so three workflow names
  would be three labels over one identical pipeline — a mechanism with no
  subject, which is what killed override. `optional` is how the method's own
  words ("independent tools, not stages") are expressed, and 9 of 10 phases now
  carry it.
  Added `spec` and `retrospective`. **No `build` phase** — `stories` already
  observes exactly what build produces, and a second phase over the same evidence
  is the duplication this codebase keeps paying for. Leaf marker untouched, so no
  unit's discovery moves.

- **T025 — docs and a live run. DONE, 15 of 15.** Against the REAL data dir: the
  installed pack, real skill seeding, the real Python.

  | # | Assertion | |
  |---|---|---|
  | 1 | the pack registers — 10 phases | PASS |
  | 1b | 9 of 10 optional | PASS |
  | 1c | `spec` exists | PASS |
  | 1d | no pack-level templates dir claimed | PASS |
  | 1e | a project runtime is declared | PASS |
  | 2 | **all 30 imported skills seeded into `data/skills`** | PASS |
  | 3 | a skill's TEMPLATE survived seeding | PASS |
  | 3b | and its `customize.toml` | PASS |
  | 4 | `getSkill()` reports the assets (T019, end to end) | PASS |
  | 5 | the BOS-specific skills are intact | PASS |
  | 6 | BMAD's shared Python executes under `python3` | PASS |
  | 6b | **and via `uv run`, the way 75 skill files call it** | PASS |
  | 7 | the runtime reports as missing, having written nothing | PASS |
  | 7b | installing writes into the real repository | PASS |
  | 7c | and the path the skills resolve exists | PASS |

  The run bound `user-specs` to bmad, installed `_bmad/` into its repository,
  then removed it and restored the manifest byte-for-byte.

  *What it caught:* the descriptor claimed version `6.13.0-next` — a BMAD release
  number — while carrying `6.12.0`. That is FR-008a's "two independent versions
  MUST NOT be conflated", violated by the pack's own version field. The pack is
  `2.0.0` now; BMAD's release lives only in `method/upstream.json`.

  *Docs rewritten (FR-014).* The user docs described "the pipeline", listed the
  removed `bmb`/`cis` modules, and said the content was "adapted, not a live
  mirror — after a BMAD release they need re-adapting rather than re-syncing".
  All three were true of the old pack and false of this one. Re-import is now one
  command and a diff.

## Still open

- **The leaf marker.** `product-brief.md` marks a unit. The epic path starts at
  `bmad-spec` and produces `spec.md`, so a unit created that way would not be
  discovered. One marker cannot serve both paths; changing it is a `045` FR-010
  preflight event. Left deliberately untouched here rather than flipped quietly.
- **Persona skills versus persona agents.** The import brought
  `bmad-agent-{analyst,pm,architect,dev,ux-designer}` as skills, alongside the
  pack's hand-written `modules/bmm/agents/{mary,john,winston,amelia,sally}`. Both
  exist. The agents are the BOS projection that binds to capability agents via
  `roles` (FR-011b) and are kept; the skills are BMAD's own way in. Worth a
  decision, not a silent overlap.
