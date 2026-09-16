# Feature Specification: The BMAD pack — a framework that brings its own cast and its own runtime

**Feature Branch**: `048-bmad-pack`

> **This spec lives with the item it describes.** The BMAD pack is a marketplace
> item, so its spec/design/plan/tasks are the item's own `spec/` facet rather
> than a feature folder in `user-specs`. It travels with the pack when the item
> is published, and BOS discovers it as an item-owned spec store (`item-bmad`).
> The BOS-side machinery this pack depends on stays in `user-specs`:
> `045-method-pack-layer` (the descriptor, sections, binding and install path).
> Its original home was `user-specs/build-studio/048-bmad-pack/`.

**Created**: 2026-09-10

**Status**: Draft

**App Target**: marketplace-item

**Input**: Fifth of five features from the swappable-spec-framework analysis. BMAD as an installable method pack, including its BMM / BMB / CIS modules, with BMB usable inside BOS so the user can customise agents and workflows later.

> Depends on `045-method-pack-layer` and `046-spec-kit-pack`. Independent of `047-openspec-pack`. This is the only pack carrying **code** — it declares a `plugin/` facet — and the only one where a marketplace install executes in the Next.js server process.

## Why this exists (context)

BMAD breaks the most assumptions, which makes it the real test of the design and the largest effort in the series.

Unlike spec-kit and OpenSpec it brings **its own cast of roles**, generates artifacts **dynamically** by sharding a PRD into N story files, and ships a **meta-module for customising itself**.

### What BMAD actually is

Verified against its own documentation.

**Roles are the core abstraction.** Each persona is bounded, produces one versioned artifact, and hands off — a relay where each leg has a job, a scoped context window, and a deliverable. The greenfield chain is explicit: `analyst: project-brief.md → pm: prd.md → ux-expert: front-end-spec.md → architect: architecture.md`, behind a "UX Required?" gate that routes around the UX Expert when there is no UI. The UX Expert ("Sally") covers design goals, accessibility, components, typography, colour, grid and animation.

**Sharding is the handoff.** The PO confirms document alignment, then shards `prd.md` and `architecture.md` into `docs/epics/` and `docs/stories/`. The SM's `create-next-story` reads config, picks the next story sequentially (1.1, 1.2, 2.1…), and enriches it with the relevant sharded architecture docs. The Dev agent takes one story file plus architecture summaries and is deliberately an "obedient craftsman", not encouraged to innovate at the architecture level.

**Config is versioned.** v4 used `core-config.yaml`; v6 loads `config.yaml` per workflow with `{planning_artifacts}` and `{implementation_artifacts}` plus an `input_file_patterns` section handling whole and sharded documents across three load strategies. v6 renames commands (`/bmad-bmm-create-architecture`, `/bmad-bmm-create-story`, `/bmad-bmm-dev-story`, `/bmad-bmm-code-review`, `/bmad-bmm-retrospective`) and adds a rule: **always start a fresh chat for each workflow.**

**Three modules, selected at install:**

| Module | Code | Default | Contents |
|---|---|---|---|
| BMad Method | `bmm` | selected | The agile suite; requires module config |
| BMad Builder | `bmb` | **not** selected | 1 agent + 7 workflows: `create-agent`, `create-workflow`, `create-module` |
| Creative Intelligence Suite | `cis` | **not** selected | 5 facilitators + 5 workflows; needs no config |

CIS's five agents (Innovation Strategist, Design Thinking Coach, Brainstorming Coach, Problem Solver, Storyteller/Presentation Master) ship direct commands — `/cis-brainstorm`, `/cis-design-thinking`, `/cis-problem-solve`, `/cis-innovation` — and the docs state they "can be triggered individually **or** embedded as part of larger BMAD-METHOD workflows."

Newer BMAD versions package agents **as skills**, with skill ids and menu triggers per agent. That is convergent with BOS's own model and makes persona-plus-skill composition the grain of the framework rather than something imposed on it.

### Two sub-deliverables; the second is the long pole

- **Mechanism** (User Stories 1–4) — provider roots, the customisation overlay, module selection, the upstream-bug shim.
- **Content** (User Stories 5–6) — deciding what BMAD's workflows *mean* for BOS, and authoring the cast.

Content is plausibly larger than `044` and `045` combined. **This feature is committed (Q4), not a validation target** — the provider roots, overlay and VFS mount exist because BMAD is being built, and are not speculative interface work.

If the content half sprawls, the valve is to cut to BMM-only and defer BMB/CIS to a follow-up feature — a scope decision *within* a committed feature, not an exit from it. Do **not** cut the overlay: without it, customisation has nowhere to write and the authoring loop does not close.

## Clarifications

### Session 2026-09-12

- Q: Where do method packs come from — how are the OpenSpec and BMAD packs distributed and installed? → A: spec-kit ships in-tree; OpenSpec and BMAD are items in the user's own private `user-apps` marketplace. Public publishing is a separate later decision.
- Q: How does a pack declare compatibility with BOS's descriptor format, which will evolve? → A: The descriptor carries a `schemaVersion`; BOS refuses to register a pack whose schema version it does not support, naming the mismatch. No silent defaulting.

- Q: What is the trust policy for a method pack that carries executable code (a `plugin/` facet)? → A: Warning plus an origin gate: packs with a `plugin/` facet install freely from the user's own `user-apps`; from any other marketplace they require an explicit per-pack opt-in.

- Q: Is `048` (BMAD) a real commitment, or a validation target that may never be built? → A: All five features are committed and will be built in sequence, `048` included.

- Q: Are method packs per-user or deployment-wide under Bastion? → A: Per-user, implicitly — packs install into each user's own `data/`; a store's method travels in its version-controlled `spec-store.json`, so users never disagree about a store, they can only lack the pack it asks for.


### Session 2026-09-12 (upstream reconnaissance)

The three repos were cloned and read before Phase 4 was written. Three of this
spec's premises were **wrong for the shipped version**, and are amended here
rather than worked around.

- Q: What shape are BMAD's agents actually in? → A: **Skills, not YAML.** v6.13
  packages everything as `skills/<id>/SKILL.md` with `name` + `description`
  frontmatter — structurally near-identical to BOS's own skill format. "Mary
  the Business Analyst" is `skills/bmad-agent-analyst/`. Sub-agents are plain
  prompt bodies in `agents/*.md` INSIDE a skill. FR-001's justification is
  amended: the provider is still needed, but to project agent-skills into
  *pickable BOS agents*, not to parse a foreign format.
- Q: Does BMAD already have a customisation mechanism? → A: **Yes.** Every
  skill carries `customize.toml` with a base → team → user structural merge,
  resolved by `resolve_customization.py`, and its header reads "DO NOT EDIT —
  overwritten on every update". BMB writes new skills to
  `{project-root}/skills`. FR-004 is amended: BOS supplies the jailed writable
  location; **BMAD owns the merge semantics**. BOS must not implement a second,
  competing one.
- Q: Is issue #999 still open? → A: **No — closed 2026-01-31**, and the buggy
  path shape appears nowhere in current source. The pinned range targeted
  `6.0.0-alpha.*`; upstream is `6.13.0-next`. FR-009 is retired (see
  Non-requirements).

### Session 2026-09-14 (the real package, and what the pack actually shipped)

`npm pack bmad-method@6.12.0` was extracted and read. The spec's earlier
reconnaissance (2026-09-12) was right about the important things — skills not
YAML, `customize.toml` with its own resolver — but it never counted what BMAD
ships, and the pack that was built diverged from it badly.

**BMAD ships 30 skills. The pack shipped 4.**

| | upstream `bmad-method@6.12.0` | the pack as built |
|---|---|---|
| agent skills | 5 (`bmad-agent-analyst/pm/architect/dev/ux-designer`) | 5 personas as `AGENT.md` ✓ |
| core skills | 8 (`bmad-help`, `bmad-review`, `bmad-customize`, `bmad-brainstorming`, `bmad-deep-recon`, `bmad-forge-idea`, `bmad-advanced-elicitation`, `bmad-party-mode`) | **0** |
| `bmm/plan` skills | 10 (`bmad-prd`, `bmad-spec`, `bmad-product-brief`, `bmad-prfaq`, `bmad-ux`, `bmad-architecture`, `bmad-create-epics-and-stories`, `bmad-sprint-planning`, `bmad-project-context`, `bmad-generate-project-context`) | 3 rewritten as `bmad-bos-*` |
| `bmm/ship` skills | 7 (`bmad-build`, `bmad-build-auto`, `bmad-code-review`, `bmad-correct-course`, `bmad-qa-generate-e2e-tests`, `bmad-retrospective`, `bmad-walkthrough`) | **0** |
| templates | 26 files in 9 skills' `assets/` (`prd-template.md`, `brief-template.md`, `spec-template.md`, …) | **0**, and a `templates` dir declared that never existed |
| `customize.toml` | 27 of 30 skills | 3, on the hand-written skills only |

- Q: Why did the pack ship 4 skills? → A: **FR-010 and FR-011a asked for it.**
  FR-010 says "BOS-specific meanings MUST be authored for BMM's workflows" and
  FR-011a says the cast "MUST be authored upstream … and checked into the pack".
  Read together they produced hand-written substitutes rather than imports. That
  was defensible for a cast of 5; it is not for a method of 30 skills, and it
  means the pack receives **no upstream improvement at all** — the exact cost
  `051` documents for forking. **FR-010 is amended below.**

- Q: Does BMAD ship templates? → A: **Yes — 26 files, per skill, under
  `assets/`.** Never in a pack-level directory. The pack declared
  `"templates": "templates"` against an empty directory and told five phases to
  author against the mount; that declaration is removed. `assets/` is the real
  location, and BOS's skill model does not currently carry it (**FR-024**).

- Q: Is BMAD's Python optional? → A: **No.** 75 files call `uv run` against four
  shared scripts — `memlog.py`, `render_skill.py`, `resolve_config.py`,
  `resolve_customization.py` — installed at `{project-root}/_bmad/scripts/`.
  `resolve_customization.py` has a documented fallback; `memlog.py` has none
  ("All writes go through the shared script, never by hand"). BMAD v6 is a
  Python-backed toolchain, not a set of prompts (**FR-025**, **FR-026**).

- Q: Is BMAD a linear pipeline? → A: **No, and the pack asserts that it is.**
  Upstream: *"These are independent tools, not stages. Pick the ones the gap
  calls for, in any order"* and *"Size Follows the Intent"*, with three
  scale-dependent paths (trivial / epic-sized / project-sized). The pack declares
  one 8-phase `phases[]`, which `051` §3.1c made a TOTAL ORDER that the canvas
  renders as a serial chain. **FR-023**.

- Q: Are `bmb` and `cis` this pack's content? → A: **No** — they are separate
  upstream repositories (`bmad-builder`, `creative-intelligence-suite`) resolved
  from `bmad-modules.yaml` and installed on demand. The pack declared both with
  `agentsDir` paths that never existed, so the picker offered modules that
  contribute nothing. **FR-006 is amended**; both declarations are removed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A pack projects its own agent format into BOS (Priority: P1)

BMAD-format agents are usable in BOS without being rewritten into BOS format by hand and without being copied anywhere.

**Why this priority**: nothing else in this feature works without it.

**Independent Test**: Register a provider root over a BMAD module directory; assert its agents appear in `agent_list`.

**Acceptance Scenarios**:

1. **Given** the pack's `plugin/` facet, **When** `loadAllPlugins()` runs at boot, **Then** the provider is registered.
2. **Given** a registered provider, **When** agent discovery enumerates, **Then** the provider is invoked and returns in-memory agents — with no files emitted anywhere.

### User Story 2 - A newly authored agent appears without a restart (Priority: P1)

Running BMB's `create-agent` produces an agent usable immediately.

**Why this priority**: this is why the provider is invoked at discovery rather than parsed at boot. Two concrete reasons: `listSubAgents()` (`subagents/store.ts:321`) re-reads `agentsDir()` on every call today, which is why editing an `AGENT.md` needs no restart — boot-time parsing would make BMAD agents the one kind requiring a bounce, worst precisely for BMB, whose purpose is authoring agents interactively. And per-process-once has already bitten this codebase: `subagents/store.ts:160-166` keys its seed guard on a `Set` of data roots because *"`dataDir()` is env-driven and BOS changes it at runtime (a feature-branch data clone, a per-user container), so a single boolean meant only the FIRST root ever got seeded."*

**Independent Test**: Author an agent via BMB; assert it resolves without restarting the server.

**Acceptance Scenarios**:

1. **Given** a running server, **When** a new agent file appears in the overlay, **Then** the next discovery call returns it.
2. **Given** unchanged files, **When** discovery runs repeatedly, **Then** the provider result is served from an `(root, max mtime)` cache.

### User Story 3 - Customisations survive a pack upgrade (Priority: P1)

A user's edited or BMB-generated agents are untouched when the pack root updates from the marketplace.

**Why this priority**: BMAD's stated intent is that its cast is customised — BMB exists to do exactly that, and is described as transforming BMAD "from a fixed methodology into an extensible platform." A pack whose customisations are lost on upgrade is unusable for its intended purpose.

**Independent Test**: Customise an agent, upgrade the pack root, assert the customisation is intact and still wins.

**Acceptance Scenarios**:

1. **Given** a customised agent in the overlay, **When** the pack root upgrades, **Then** the overlay is untouched and continues to shadow the pack's copy.
2. **Given** BMB's agent, **When** it writes a new workflow, **Then** it writes to the overlay through a jailed VFS mount, never into the read-only pack root.

### User Story 4 - Modules are selected at install (Priority: P2)

A user installs BMM alone, or adds BMB and CIS, and gets exactly the agents those modules contribute.

**Why this priority**: mirrors BMAD's own installer, and CIS needs no module config — making it the cheapest integration test of the mechanism. Ranks below the P1s because a BMM-only pack is already useful.

**Independent Test**: Install with BMM only; assert 8 agents. Add CIS; assert 5 more, `picker`-visible. Remove CIS; assert they disappear.

**Acceptance Scenarios**:

1. **Given** module selection at install, **When** only BMM is selected, **Then** only BMM's roots register.
2. **Given** CIS selected, **When** the picker renders, **Then** its five facilitators appear, grouped under their source.
3. **Given** BMM's roots, **When** the picker renders, **Then** its role agents are hidden but remain reachable by `agent_delegate`.

### User Story 5 - BMAD's workflows produce BOS-grounded output (Priority: P1)

`create-architecture` produces a design in terms of BOS's real containers; `create-front-end-spec` targets BOS's real UI model.

**Why this priority**: this is the feature's actual value. A BMAD pack that produces generic three-tier architectures is worse than no pack.

**Independent Test**: Judgement-based. Run a real feature through the flow and review the artifacts against BOS's actual subsystems.

**Acceptance Scenarios**:

1. **Given** `create-architecture`, **When** it runs, **Then** its containers are BOS's real ones — the Next.js app process, the Supervisor and its preview worktrees, worker-thread service processes, a marketplace item's own git repo, the VFS/GitFS stores, Bastion — not a generic three-tier system.
2. **Given** `create-front-end-spec`, **When** it runs, **Then** it targets BOS's window model, the iframe/app-facet split and the A2UI v0.9 catalog.
3. **Given** BMAD's classification step, **When** it classifies, **Then** it reaches BOS's three real shapes (`bos-core` / `builtin-app` / `marketplace-item`).

### User Story 6 - Pack agents reference BOS knowledge rather than embedding it (Priority: P1)

BMAD's BOS-aware cast loads `bos-domain` rather than carrying its own copy of BOS facts.

**Why this priority**: if BOS domain knowledge is baked into BMB output, the duplication this entire series set out to eliminate reappears in a new place and drifts silently.

**Independent Test**: Grep the pack's agent definitions for BOS subsystem facts; there should be none — only a `bos-domain` reference.

**Acceptance Scenarios**:

1. **Given** any pack agent, **When** it needs BOS facts, **Then** it calls `skill_load('bos-domain')`.
2. **Given** a long session, **When** compaction runs, **Then** the loaded `bos-domain` body survives — via the `unrecoverableTools` default `044` FR-008 establishes.

### Edge Cases

- **Known upstream bug #999.** BMB's `create-module` writes to `.bmad/custom/modules/{name}/` but generates agent YAML referencing `.bmad/{name}/workflows/`, so compiled agents fail to load their workflows. Handle it in the pack as a documented, version-scoped compatibility shim — not a silent rewrite. It must **fail loudly** against a layout it does not recognise, so it breaks visibly rather than silently the day upstream fixes it.
- **BMB output lives outside BOS's review path.** Generated agents are checked into the pack, but the tool producing them is interactive and external. Treat generated files as source to review, not build artefacts to trust; do not assume regeneration is reproducible on demand.
- **CIS overlaps the spec-kit pack's stress-tester.** Structurally fine — one method is active per store, and after `044`/`046` BOS itself ships no stress-tester. The real issue is picker ambiguity, resolved by `045` FR-002's source grouping. **Retire nothing**: coupling BOS's capability set to whether a third-party pack is installed would be a bad dependency.
- **BMAD's "fresh chat per workflow"** exists for context scoping. BOS's delegation inner loop (`src/lib/assistant/inner-loop.ts`) already provides exactly that — a delegated agent runs with its own system prompt and message history, not the parent's. So the intent is already satisfied; do not build new-conversation-per-workflow, which would fragment one feature across N conversations and collide with `agentId` being pinned at conversation creation.
- **BMAD v6 is alpha and renaming things.** Commands changed between v4 and v6; packaging is mid-shift toward skills. Pin the version and expect prose refreshes per upstream release.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Agent discovery MUST support a `provider` root kind: `{ kind: "provider"; packId; visibility; resolve(): Promise<ProviderOutput> }`, where `ProviderOutput` is `{ agents: Agent[]; phases?: PhaseSpec[] }`.

  > **Justification amended 2026-09-12.** This originally read "BMAD's agents are YAML in a different shape". They are not — v6.13 ships them as SKILLS in BOS's own format. The provider survives for a different and narrower reason: **a skill is not an agent.** `bmad-agent-analyst` is a persona a user should be able to pick and talk to, and projecting a skill into a pickable `Agent` must happen in memory — writing generated `AGENT.md` files would break 035's "install copies nothing" and create a derived cache with no invalidation point. BMAD's non-agent skills are NOT projected; they seed through `046`'s existing pack-skill path unchanged. `resolve` MUST be pure — pack files in, in-memory results out — and MUST emit no files, so 035's "install copies nothing" holds and no derived-cache staleness exists.

  > **Amended 2026-09-12 (design review).** Originally `resolve(root): Promise<Agent[]>`. Two changes, both from FR-003: the return type became a struct so the phase graph can be added without a second provider shape (adding one later is how parallel mechanisms are born), and `root` was dropped from the signature because the root is already closed over at registration — passing it again invites two sources of truth for where the pack lives, which is the bug the 045 fixture harness found in `installMethodPack`.

- **FR-002**: The provider MUST be **registered at boot** via the pack's `plugin/` facet through the existing `loadAllPlugins()` (`instrumentation.ts`), and **invoked at discovery**, cached on `(root, max mtime)`. It MUST NOT parse at boot.

- **FR-002a**: Precedence MUST be stated as a **single total order** across all three sources, extending `045` FR-001a rather than introducing a second rule: (1) `data/agents/`, (2) the pack overlay `data/method-packs/<packId>/`, (3) the installed pack root, (4) `seed/agents/`. `045` defines levels 1, 3 and 4; this feature inserts level 2 between them. There MUST NOT be two precedence rules in the codebase.

- **FR-003**: The provider interface MUST be designed to also project the pack's phase graph later (BMAD's `config.yaml` + `input_file_patterns` need equivalent treatment), not agents only.

- **FR-004**: A user-owned **overlay** MUST exist at `data/method-packs/<packId>/`, with higher precedence than the installed pack root.

  > **Amended 2026-09-12.** BOS supplies the jailed, writable location and the precedence; **BMAD owns the merge semantics.** Every BMAD skill ships `customize.toml` with its own base → team → user structural merge, and BMB writes new skills to `{project-root}/skills`. BOS MUST NOT implement a second merge on top of that — the overlay is the *project root* BMAD writes into, not a competing customisation system. FR-004's original premise ("customisation has nowhere to write") still holds exactly: the installed pack root is read-only, so something must provide a writable location. What changed is that BOS no longer decides what layering *means* inside it.

  > **This is an overlay, not an install path, and the distinction MUST be preserved in the implementation.** BOS's rule (035) is one install mechanism — the item symlink — and "install copies nothing". FR-004 does not install anything: the pack is still installed exactly once, as an item symlink, and remains the only thing `listInstalledItems()` knows about. The overlay is a *write destination for user modifications to already-installed content*, which is precisely what `itemConfigDir` (`src/system/items/installed.ts:37` — "BOS-owned mutable config, seeded from the item's defaults at install") already is for config. This extends that established convention from config to content; it MUST NOT acquire install semantics (no manifest, no registration of its own, no discovery of packs that were never installed).

- **FR-004a**: An overlay directory whose pack is not installed MUST be inert and reported, never treated as a pack. If the overlay can bring content into existence on its own, it has become a second install path and FR-004's constraint is violated.

- **FR-005**: A VFS mount MUST expose the overlay so BMB's agent can write there through the ordinary `file_*` tools, jailed to that directory — the same shape as `/Specs/<store>`.

- **FR-005a**: Under `045` FR-013a's origin gate this pack installs **without** an opt-in, because Q1 places it in the user's own `user-apps` (`FR-015`). The gate becomes live for it only if it is ever redistributed from another marketplace — at which point the opt-in is required and MUST NOT be waived on the grounds that the pack was previously trusted locally.

- **FR-005b**: This pack's server code runs in the installing user's **own container** (`045` FR-008a — packs are per-user under Bastion), so its blast radius is that user's BOS, not the deployment. That is part of why Q3's origin gate is proportionate rather than lax; it would not be if an admin could install this pack for everyone.

- **FR-006**: The descriptor MUST support `modules[]` with per-module `default` and `requiresConfig`, mirroring BMAD's installer: `bmm` (default true, requiresConfig true), `bmb` (default false), `cis` (default false, requiresConfig false). Each module contributes agent roots and workflows.

  > **AMENDED 2026-09-14 — this pack declares `bmm` ONLY.** `bmb` and `cis` are
  > not content this pack carries: upstream they are separate repositories
  > (`bmad-builder`, `creative-intelligence-suite`) resolved from
  > `bmad-modules.yaml` and installed on demand, alongside `gds` and `tea` which
  > this spec never mentioned. The pack declared both with `agentsDir` paths that
  > have never existed, so the picker offered modules that would contribute
  > nothing and the install succeeded silently. BOS now REPORTS a module whose
  > agents directory is absent, and both declarations are removed.
  >
  > The `modules[]` MECHANISM is unaffected and still correct — this is about
  > what this pack legitimately contains.
  >
  > **Followed up the same day.** Both were fetched and assessed rather than left
  > as a maybe:
  >
  > - **`bmb` (`bmad-builder@1.1.0`) IS now imported** — it ships two real skills,
  >   `bmad-agent-builder` and `bmad-workflow-builder`. It contributes NO agents,
  >   so it correctly needs no `modules[]` entry: that mechanism gates agent
  >   roots, and declaring one with an `agentsDir` the pack lacks is the very bug
  >   being fixed here.
  > - **`cis` (`bmad-creative-intelligence-suite@0.1.9`) is NOT, and cannot be
  >   copied.** Its ten skills ship `bmad-skill-manifest.yaml` only — persona
  >   metadata that BMAD's installer renders into a `SKILL.md`. There is no
  >   content to vendor. The importer names all ten as skipped rather than copying
  >   YAML into a skills directory where it would register as nothing. Rendering
  >   them means running upstream's renderer; reimplementing it is the move FR-025
  >   already rejects.

- **FR-006a**: The richer `modules[]` MUST be **backward compatible**, NOT a `schemaVersion` bump. `045` ships `modules?: string[]`; this feature needs objects. The descriptor type MUST accept `string[] | ModuleSpec[]`, normalising a bare string to `{ id, default: true }`.

  > Bumping `METHOD_SCHEMA_VERSION` to 2 would make `registerMethod` **refuse every existing pack**, spec-kit's own `method.json` included (`045` FR-003a refuses on mismatch, by design and with no silent defaulting) — a breaking change to every installed pack for a purely additive field. Reserve the bump for a change that genuinely cannot be expressed compatibly. `048` MUST NOT change `METHOD_SCHEMA_VERSION`.

- **FR-007**: Visibility MUST be declared per module root: `bmm/agents/` → `delegate-only` (chain-dependent — Sally without a `prd.md` has no input and no consumer); `cis/agents/` → `picker` (standalone facilitation is the module's stated value); `bmb/agents/` → `picker` (talking to the builder is how you use it). A per-agent override MUST be available for mixed modules.

- **FR-008**: `045` FR-013's install-time code warning MUST be verified to actually render for this pack — it is the first to trigger it.

- **FR-008a**: This pack carries **two independent versions** and they MUST NOT be conflated: the descriptor's `schemaVersion` (`045` FR-003a — which BOS descriptor format it targets) and the pinned upstream **BMAD** version (FR-009's shim range). A BOS descriptor change and a BMAD release are unrelated events.

- ~~**FR-009**~~: **RETIRED 2026-09-12.** A version-scoped shim for issue #999. The issue was closed upstream on 2026-01-31, the buggy path shape appears nowhere in the current source, and the pinned range (`6.0.0-alpha.*`) is nine minor versions behind `6.13.0-next`. Shipping a version-gated path rewrite for a fixed bug is a liability, not a safeguard: it is dead on every version anyone would install, and the one way it can still fire is by misfiring. See Non-requirements.

- **FR-010**: BOS-specific meanings MUST be authored for BMM's workflows — `create-architecture` (BOS's real containers), `create-front-end-spec` (window model, iframe/app-facet split, A2UI catalog), the PRD → epics → stories chain mapped onto descriptor artifacts with `generates` globs covering dynamically-sharded story files, and BMAD's classification step reaching BOS's three shapes.

  > **AMENDED 2026-09-14 — authored as an OVERLAY, never as a replacement.**
  > This requirement is the root cause of the 4-skill pack. Read with FR-011a it
  > produced hand-written substitutes — `bmad-bos-architecture`, `bmad-bos-ux`,
  > `bmad-bos-stories` — that stand in place of `bmad-architecture`, `bmad-ux`
  > and `bmad-create-epics-and-stories` rather than on top of them. The other 27
  > skills were simply not carried.
  >
  > The mistake is visible once the numbers are: authoring "what this means for
  > BOS" is right for the handful of skills where BOS's own subsystems change the
  > answer, and meaningless for `bmad-help`, `bmad-brainstorming`, `bmad-spec`,
  > `bmad-retrospective` and the rest, which are method mechanics with no BOS
  > dimension at all. A substitute for those is strictly worse than the original.
  >
  > `051` supplies the right shape, and this pack should be its first real user:
  > **import the pack's skills wholesale, and express BOS-specific meaning as
  > OVERLAY content** (`data/method-packs/bmad/`, FR-004) over the three skills
  > that need it. The overlay shadows a file and keeps every other file's
  > upstream improvements; a rewrite receives nothing, ever. The three existing
  > `bmad-bos-*` skills become overlay content over their upstream counterparts,
  > and their BOS knowledge is preserved rather than discarded.

- **FR-011**: Every pack agent MUST reference `bos-domain` by skill id rather than embedding BOS facts.

- **FR-011a**: **Initial authoring is out-of-band; BMB-in-BOS is for subsequent customisation only.**

  > **AMENDED 2026-09-14.** Still true of the CAST — the five personas are hand
  > adapted and checked in. It MUST NOT be read as covering the method's skills:
  > those are IMPORTED from the published package, not authored. The distinction
  > this requirement draws is between two authoring loops; the amendment adds a
  > third path that is neither — vendoring what upstream already ships. Authoring the cast *via BMB running inside BOS* is circular — the pack must be installed for BMB to run, and BMB is what produces the pack's cast. So the shipped BMM cast MUST be authored upstream (BMAD + BMB outside BOS, adapted by hand) and checked into the pack. Once installed, BMB-in-BOS customises it, writing to the FR-004 overlay. The two loops MUST NOT be conflated in the implementation plan.

- **FR-011b**: A pack persona that maps onto a BOS capability agent MUST declare that binding explicitly in the descriptor's `roles` — e.g. BMAD's Dev persona binds to BOS's `developer` (the agent holding repo access) rather than replacing it. `046` asserts this relationship; this is where the mechanism is specified. A persona with no BOS counterpart (SM, PO) simply declares none.

- **FR-012**: The pack prose MUST state that BMAD's "fresh chat per workflow" maps to BOS's delegation boundary.

- **FR-013**: This feature MUST carry e2e coverage, built on `045` FR-017a's fixture-pack harness (a hard prerequisite), for module selection (BMM alone, then +CIS, then removal), the BMB round trip (author an agent, assert it resolves without a restart), and overlay survival across a simulated pack-root upgrade. Fixtures MUST be bundled by the test — a fixture pack with a minimal BMAD-shaped layout — never a real BMAD install or pre-seeded content.

- **FR-014**: The pack MUST ship user-facing documentation covering module selection, which agents are conversational vs. delegate-only, how BMB customisation works and where it writes, and the pinned BMAD version. `docs/usage/` MUST point at it.

- **FR-015**: The pack MUST be distributed as an item in the user's own `user-apps` marketplace (`data/user-apps/items/<pack-id>/`), carrying a `method/` facet — the same layout as any other BOS item. Placing pack content in the built-in seed location makes it INERT: nothing registers it, while every surface still looks plausible. Publishing to a public marketplace is explicitly **not** part of this feature.

- **FR-022** *(2026-09-14)*: The pack MUST carry BMAD's skills **as published**,
  imported from a pinned release of `bmad-method`, not rewritten. The import MUST
  record the version it came from, and re-importing a newer release MUST be a
  repeatable operation rather than a hand merge — otherwise the pack drifts from
  upstream the moment either changes, which is what happened.

- **FR-023** *(2026-09-14)*: The descriptor MUST NOT present BMAD as a single
  linear pipeline. Upstream is explicit — *"These are independent tools, not
  stages. Pick the ones the gap calls for, in any order"*, and *"Size Follows the
  Intent"*. `phases[]` is a TOTAL ORDER (`051` §3.1c) and the canvas renders it as
  a serial chain, so one 8-phase array asserts something the method denies.

  BMAD's three scale-dependent paths MUST be declared as three **workflows**
  (`049` FR-002) — trivial, epic-sized, project-sized — and steps that are
  genuinely skippable MUST carry `optional: true` (`051`). Both mechanisms already
  exist and this pack declares neither: `workflows` is absent, so it gets the
  degenerate single default, and not one phase is marked optional.

- **FR-024** *(2026-09-14, corrected while implementing)*: BOS's skill MODEL MUST
  describe a skill's whole directory, not only `SKILL.md`, `scripts/` and
  `references/`.

  > **CORRECTED — the first draft claimed importing BMAD would "silently drop 26
  > template files and the customisation surface of 27". That is FALSE, and I
  > should have read the install path before writing it.** `copyAsset` does
  > `fs.cp(source, dest, { recursive: true })` into `data/skills/<id>`, and
  > `listSkillFiles`/`readSkillFile` walk whatever is there — so the assets always
  > arrived, and an agent could always read a template.
  >
  > The real gap is narrower and sits in the object model around that copy:
  >
  >   - `getSkill()` reported a skill as SKILL.md + scripts + references, so
  >     anything reasoning about its contents saw a partial answer;
  >   - `skillRevParts` hashed only those, so a change confined to a template did
  >     not count as a change;
  >   - `seedFromDiskPath` — BOS's own `seed/skills/` reconciliation — carried
  >     only those, so a BMAD-shaped skill shipped in-tree arrives truncated.
  >
  > Worth keeping as a requirement, and worth keeping the correction visible: the
  > READ path was already general while the MODEL was not, and that asymmetry is
  > exactly the kind of thing that looks fine until something reasons about it.

  The implementation MUST NOT be another allowlist of directory names. Adding
  `assets` would carry the templates and still drop `review-prompts/`, `steps/`,
  `templates/`, `agents/` and the loose root files BMAD also uses — the allowlist
  failure this codebase produced twice in one day. Carry the directory as it IS.

  Additive: an existing skill MUST resolve to exactly what it does today. Build
  output (`__pycache__`) is not content, and the install path stays a FAITHFUL
  copy — stripping belongs to the import (FR-022), since BMAD's own published
  tarball carries byte-caches.

- **FR-025** *(2026-09-14, corrected the same day)*: BMAD's Python MUST run
  wherever BOS executes commands. 75 files call `uv run` against the four shared
  scripts at `{project-root}/_bmad/scripts/`.

  > **CORRECTED — the first draft of this requirement overstated it.** It implied
  > `uv` was needed to install dependencies. It is not. Every PEP 723 block in
  > BMAD declares only `requires-python`, so `uv` is pinning an INTERPRETER, and
  > `node:trixie`'s Python 3.13 already satisfies `>=3.11`. All four shared
  > scripts were run under plain `python3` and work.
  >
  > The measured position, so the decision is made on facts:
  >
  > | | |
  > |---|---|
  > | BMAD's Python | ~5,200 lines — 990 shared, 4,242 in 11 per-skill scripts |
  > | third-party deps | **one**, `ruamel.yaml`, for `bmad-sprint-planning` |
  > | everything else | stdlib, verified by execution |
  > | Python in BOS's images | **already there**, with six packages for run_command |
  >
  > So this adds no runtime and one pip package. `uv` is carried for a different
  > reason than dependencies: it lets BMAD's 75 files run **verbatim**. Dropping
  > it means rewriting `uv run` -> `python3` across all of them, which forks the
  > skills' text and must be re-applied on every re-import — the drift FR-010's
  > amendment exists to end.
  >
  > **Reimplementing the Python in TypeScript was considered and rejected.** It is
  > a fork of someone else's runtime: 5,200 lines that move on every BMAD release,
  > each needing a re-port, which lands the pack back in exactly the no-upstream
  > state this rework is undoing. FR-004 already forbids the largest piece in
  > terms — "BOS MUST NOT implement a second merge on top of that; BMAD owns the
  > merge semantics" — and `resolve_customization.py` IS that merge. A subtly
  > divergent port of hashing, merge rules or git-history mining yields plausible
  > wrong answers rather than errors.

  What a missing runtime costs: `resolve_customization.py` documents a fallback
  ("On failure, read `{skill-root}/customize.toml` directly"); `memlog.py` has
  none and says so ("All writes go through the shared script, never by hand").
  It is a silently broken run log, not degraded operation.

- **FR-026** *(2026-09-14)*: `{project-root}` MUST resolve to **the repository the
  store belongs to** (`050`), and `_bmad/` MUST live there — its four shared
  scripts, its config, and `_bmad/custom/<skill>.toml` for team overrides.

  This is where `npx bmad-method install` puts it, so BMAD's own CLI keeps
  working on the same checkout; config and overrides live with the code they
  describe; and a team override is committed with the repo, which is exactly
  BMAD's stated model for priority-2 customisation. The rejected alternatives:
  the spec store (diverges from upstream layout, and BMAD's CLI would not find
  it) and BOS's data dir (per-user, so two projects could not have different
  BMAD config).

- **FR-027** *(2026-09-14, corrected while implementing)*: The three
  `bmad-bos-*` skills MUST survive the import and MUST be routed to by name.
  Their BOS knowledge — real containers, the window model, BOS's story shapes —
  is the FR-010 content this feature exists to produce, and the one part of the
  pack that could not be imported.

  > **CORRECTED — "become overlay content over their upstream counterparts" is
  > not achievable and, once looked at, not desirable.**
  >
  > Not achievable: the pack overlay (`data/method-packs/<id>/`) is resolved for
  > AGENTS and for PHASE INSTRUCTIONS, and nothing resolves skills through it.
  > For a skill the user-override mechanism is `data/skills/<id>` itself —
  > seed-sync never overwrites a locally edited skill. Building skill-overlay
  > resolution would be a new mechanism for one pack, which is the move this
  > whole rework exists to stop.
  >
  > Not desirable either, which is the better reason. They are not overrides of
  > the upstream skills; they are DIFFERENT skills:
  >
  > | | |
  > |---|---|
  > | `bmad-architecture` | "…architecture decisions that keep separately built parts of a system consistent" — generic, ships `spine-template.md` |
  > | `bmad-bos-architecture` | "Design a BOS feature's architecture **in BOS's own terms**" |
  >
  > Someone running BMAD on their own repo wants the first; someone architecting
  > BOS itself wants the second. Collapsing them would lose a distinction the
  > pack should keep, and shadowing would mean BOS users could never reach
  > upstream's generic version at all.
  >
  > The property that must hold is therefore narrower and is already true: the
  > importer writes only upstream's 30 ids, so different ids cannot collide, and
  > a re-import leaves the BOS skills untouched. That is now asserted rather than
  > assumed. The ROUTING — which of the two to use when — belongs in the driver
  > skill, where the pack's own judgement lives.

### Non-requirements

- **A compatibility shim for issue #999** (was FR-009). Closed upstream 2026-01-31; absent from current source; the pinned range is nine minor versions stale. Re-pin it only if BOS ever needs to support the `6.0.0-alpha` line.
- **A BOS-side customisation merge.** BMAD's `customize.toml` resolver owns that (FR-004, amended).
- Running BMAD's own installer (`npx bmad-method@alpha install`) inside BOS.
- The BMGD (game dev) module or any module beyond BMM/BMB/CIS.
- v4 `core-config.yaml` support — target v6 and say so.
- Retiring or scoping CIS's agents (see Edge Cases).

### Key Entities

- **Provider root** — an agent discovery source backed by a pure function rather than a directory of `AGENT.md` files.
- **Pack overlay** — `data/method-packs/<packId>/`, user-owned, higher precedence than the pack root; where BMB writes.
- **Module** — a selectable sub-bundle of a pack, contributing roots and workflows, with its own visibility.

### Distribution and registration

> Each of these governs a boundary a single-process test cannot cross —
> install → restart, one module instance vs another, parse → rewrite. A unit
> suite cannot reach them, however thorough.

- **FR-016**: A pack MUST be installed by the REAL install path before it is considered working. A test that copies the pack into place supplies the very step whose absence would be the bug, so it cannot detect that step is missing. **A test MUST NOT synthesise the artefact whose absence it is meant to catch.**

- **FR-017**: **The marketplace manifest MUST be validated as a whole, and a malformed entry MUST name the field.** A missing `integration.entrypoint` invalidates the ENTIRE manifest rather than the one entry, so an unrelated typo removes every item from the marketplace. Validation MUST be per entry, and the message MUST identify the item and the missing field.

- **FR-018**: **BOS rewrites `marketplace.json`, so a field its parser does not model is DELETED from the user's repo and committed.** A pack's `modules` declaration is lost exactly this way: parsed-and-dropped, then written back without it. See `045` FR-019 — this is the same defect, and the manifest BOS rewrites most often. A test MUST round-trip a pack's declaration through a BOS-initiated manifest repair.

- **FR-019**: **An installed pack MUST be registered at BOOT, not only at install.** Registering only on the install path works until the first restart, after which the pack silently vanishes while its symlink, its overlay and its marketplace entry all still report it as installed. There MUST be a boot pass over installed packs, and SC-014 MUST cross a real restart.

- **FR-020**: **Registration MUST be reachable lazily, because the boot pass and a route handler do not share a module instance.** A pack registered by the server-boot hook is invisible to API routes — same code, different instance, empty registry. Every consumer MUST be able to ensure registration on demand (memoised), rather than relying on boot ordering. A defect of this shape is invisible to any test that registers and asserts in one process.

- **FR-021**: **A warning MUST NOT assert a consequence that cannot occur.** A dialog reporting that a missing constitution leaves a phase pending can name a phase the target method does not have. A message MUST be derived from the TARGET descriptor: name the phase that actually reads the constitution and that method's own label for the state, or say nothing about consequences. A warning that describes an impossible outcome sends the user to create a file nothing reads, and teaches them to discount the next warning.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Installing with only BMM selected yields a working `project-brief → prd → architecture → stories` flow.
- **SC-002**: Selecting CIS adds five `picker`-visible facilitators; deselecting removes them.
- **SC-003**: BMM agents are absent from the picker and reachable by `agent_delegate`.
- **SC-004**: `create-agent` via BMB produces an agent usable **without a server restart**, written to the overlay, shadowing nothing in the pack root.
- **SC-005**: A pack-root upgrade leaves overlay content untouched.
- ~~**SC-006**~~: **RETIRED** with FR-009.
- **SC-007**: The install-time code warning renders.
- **SC-008**: `045`'s spec-kit snapshot and `047`'s OpenSpec flow both still pass.
- **SC-009**: Zero BOS subsystem facts embedded in pack agent definitions.
- **SC-010**: An overlay directory whose pack is not installed brings nothing into existence — it is inert and reported. Exactly one precedence rule exists in the codebase, covering all four levels.
- **SC-011**: Phase state for sharded stories resolves through `045` FR-004a's set predicate — no BMAD-specific evaluation code exists in the pipeline.
- **SC-012**: e2e covers module selection, the BMB round trip without a restart, and overlay survival across a pack-root upgrade — all on bundled fixtures.

- **SC-017** *(2026-09-14)*: Every skill in the pinned BMAD release is present in
  the pack, asserted by COUNT against the published package rather than by
  inspection — 30 today. A count is what would have caught shipping 4.
- **SC-018**: A skill's `assets/` and `customize.toml` survive seeding into
  `data/skills/`, asserted on a skill that has both. Without it the import looks
  complete and is missing its templates.
- **SC-019**: The descriptor declares BMAD's three paths as workflows, and no
  workflow presents an unskippable step BMAD calls optional.
- **SC-020**: `uv` resolves in the container image, and a skill that shells out to
  `_bmad/scripts/` succeeds there — asserted in the image, not on a dev machine,
  since that difference is the whole risk.
- **SC-021**: Re-importing a newer BMAD release is one repeatable operation, and
  the overlay's BOS-specific content survives it untouched.

- **SC-013**: The pack ships user-facing docs covering modules, agent visibility, BMB customisation and the pinned version; `docs/usage/` points at them.

- **SC-014**: The pack is installed from `user-apps` through the ordinary install path, and is still registered and usable after a server restart.
- **SC-015**: A pack's declarations survive a BOS-initiated `marketplace.json` repair; a malformed entry disables only itself and names the missing field.
- **SC-016**: Every warning shown when switching methods names only phases and state labels that exist in the TARGET method.

## Assumptions

- **Content has no mechanical acceptance test.** "Does the architecture workflow produce a good BOS design?" is a judgement call; plan on iterating with real features rather than declaring it done on first authoring.
- **The trust model is bos-plugins' existing one.** This pack executes in the Next.js server process; reuse the existing plugin loader and `validator.ts` rather than inventing pack-specific sandboxing.
- Using BMB to author the cast is preferable to introducing a BOS-side binding mechanism for one pack. A `preload` frontmatter field was considered for that purpose and rejected — `044` FR-008's compaction protection covers the underlying reliability concern more surgically, and BMAD's own extension point covers the rest. This pack therefore depends on that default being in place (User Story 6, scenario 2).
