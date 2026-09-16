# Design: The BMAD pack (048)

**Spec**: [`spec.md`](./spec.md) · **Branch**: `bos/spec-method-packs` · **Date**: 2026-09-12

**Scope decision (2026-09-12)**: FULL — BMM + BMB + CIS. The spec's BMM-only valve is **not** taken. It stays available as a mid-implementation retreat if the content half sprawls (spec §"Two sub-deliverables"), but the design below assumes all three modules, because BMB is what makes the overlay load-bearing rather than speculative.

---

## 1. What is actually new here

045 and 046 are built. Against that baseline, 048 adds exactly four mechanisms and one large body of content:

| # | Mechanism | Why 045 could not already do it |
|---|---|---|
| M1 | **Provider agent roots** | `AgentRoot` is `{ kind: "dir"; path }` (`roots.ts:15-36`). Every agent must be an `AGENT.md` on disk. BMAD's agents are YAML in a different shape. |
| M2 | **The overlay** | Precedence has three levels and all three are read-only to the user *as a pack* — there is nowhere for BMB to write that outranks the pack root. |
| M3 | **Module selection** | `installMethodPack` registers one agent root per pack. BMAD contributes three independently-selectable bundles. |
| M4 | **The #999 shim** | No version-scoped compatibility layer exists anywhere in the method layer. |

Everything else 048 needs — descriptor, phases, `set`/`count` predicates for sharded stories, install/uninstall, origin gate, template mounts, the `roles` map — shipped in 045/046 and is **used unchanged**. That is the design's main claim, and SC-011 is its test: *no BMAD-specific evaluation code in the pipeline*.

### What the fixture harness already proved

045 T002a was built as a prerequisite to this design (2026-09-12) and it settles two things that would otherwise be open questions here:

- The **BMAD-shaped modular layout is expressible** — `method/modules/<id>/agents/<agent>/AGENT.md`, with per-module `visibility`, is pinned by a test.
- The **pack root is `<item>/method`**, not the item root. Found by that fixture: `installMethodPack` had been resolving `templates` and `agentsDir` against the item root, one directory too high, silently. Every path in this design is pack-relative against `<item>/method`.

---

## 2. Constitution check

| Principle | Assessment |
|---|---|
| **I — Spec-Driven** (NON-NEGOTIABLE) | Satisfied. This design precedes implementation and the spec precedes it. |
| **II — Server Authority** | Satisfied, with care. The provider runs **server-side only**; `resolve()` returns in-memory `Agent[]` and the client sees the same shape it sees today. The overlay VFS mount (M2) is the one new client-reachable surface and is jailed exactly as `/Specs/<store>` is. |
| **III — Always Delegate** | Satisfied. BMM's cast is delegated to; the Dev persona **binds to** BOS's `developer` rather than replacing it (FR-011b), so repo access still flows through the one agent that has it. |
| **IV — Minimize Blast Radius** (NON-NEGOTIABLE) | **The pressure point.** This is the first pack carrying executable code in the Next.js process. Three containments: it installs per-user (`data/` is a per-user volume under Bastion, FR-005b); the origin gate applies if it is ever redistributed (FR-005a); and it reuses the existing bos-plugin loader and its validator rather than inventing pack-specific sandboxing. **No new trust mechanism is introduced** — see ADR-5. |
| **V — VFS Is Not the Source** | Satisfied, and tested. The overlay is `data/method-packs/<packId>/` — runtime data, not BOS source. FR-004a's inertness rule is what keeps it from becoming a second install path. |
| **VI — Specs & Docs Stay in Sync** (NON-NEGOTIABLE) | Requires FR-014 to land **with** the mechanism, not after. `docs/dev/method-packs.md` gains the provider-root and overlay sections; the pack ships its own `docs/usage/`. |
| **VII — Respect Boundaries** | Satisfied. The pack writes only to its overlay and its own item; it never touches `seed/`, `src/`, or another pack's root. |

**No violations.** One standing risk (IV) with three stated containments.

---

## 3. Architecture

### 3.1 M1 — Provider roots (FR-001, FR-002, FR-003)

`AgentRoot` becomes a discriminated union. The existing `dir` variant is unchanged.

```ts
export type AgentRoot =
  | { kind: "dir"; path: string; visibility: Visibility; packId?: string; label: string }
  | { kind: "provider"; packId: string; visibility: Visibility; label: string;
      /** Pure: pack files in, in-memory results out. Emits NOTHING.
       *  `phases` is declared now and unread in this feature (FR-003). */
      resolve(): Promise<{ agents: Agent[]; phases?: PhaseSpec[] }>;
      /** Inputs whose mtimes key the cache. */
      watch: string[] };
```

**Registered at boot, invoked at discovery.** The pack's `plugin/` facet registers the provider through the existing `loadAllPlugins()` (`bos-plugins/loader.ts:113-117`), which already filters to `facets.plugin && !broken` and loads from the item symlink. No new loader.

Invocation is at discovery because `listAgentsAcrossRoots` re-reads every root on every call — which is why editing an `AGENT.md` needs no restart today. Parsing at boot would make BMAD agents the one kind requiring a bounce, **worst precisely for BMB**, whose entire purpose is authoring agents interactively (US2).

**The union breaks four call sites in `store.ts`, not just `roots.ts`.** `idsIn` does `fs.readdir(root.path)` and `listAgentsAcrossRoots` does `readFile(join(root.path, id, "AGENT.md"))` — a provider root has no `path` at all. So `idsIn`, `agentRootCollisions`, `shadowedPackAgentReport` and `listAgentsAcrossRoots` must each handle both variants. This is the same shape as 045's four-copies-of-the-leaf-rule: the fix is ONE dispatch that yields `{id, load()}` per root regardless of kind, consumed by all four — not four independent `kind === "provider"` branches.

**Cache key is `(root, max mtime over watch[])`.** Not a boolean, not per-process: `subagents/store.ts` already learned this the hard way — its seed guard keys on a `Set` of data roots because `dataDir()` is env-driven and a single boolean meant only the first root was ever seeded. A feature-branch data clone and a per-user container both move the root underneath us.

**FR-003 — designed to project phases later.** `resolve(): Promise<ProviderOutput>` where `ProviderOutput = { agents: Agent[]; phases?: PhaseSpec[] }`, with `phases` unread in this feature. BMAD's `config.yaml` + `input_file_patterns` will need the same treatment, and retrofitting a second provider shape later is how two mechanisms happen.

> **This changed FR-001's stated signature, and the spec was amended rather than quietly diverged from** (design review, 2026-09-12). The original read `resolve(root): Promise<Agent[]>`. `root` is dropped because it is already closed over at registration — passing it again gives two sources of truth for where the pack lives, which is precisely the bug the 045 fixture harness found in `installMethodPack`.

> **Why a provider rather than generating `AGENT.md` files at install.** Generating files would make agents `dir`-discoverable with zero new mechanism — tempting. It is rejected because it breaks 035's "install copies nothing" (the generated files are a derived cache), it creates a staleness class that does not otherwise exist (regenerate when? on upgrade? on BMB write?), and it puts BOS-authored files inside a user-owned tree where the `.seed-rev`/provenance contracts do not apply. FR-001's "MUST emit no files" is the requirement; this is its reasoning.

### 3.2 M2 — The overlay (FR-004, FR-004a, FR-005)

`data/method-packs/<packId>/`, user-owned, mirroring the pack's internal layout (`agents/`, `workflows/`, `modules/<id>/agents/`).

**It is an overlay, not an install path.** The distinction is load-bearing and the spec states it at length. The precedent is `itemConfigDir` (`installed.ts:37` — *"BOS-owned mutable config, seeded from the item's defaults at install"*): BOS already keeps user-mutable state for an installed item **outside** the item, without that state being an install. This extends the established convention from config to content.

**FR-004a — inertness.** An overlay directory whose pack is not installed contributes nothing and is **reported**. If the overlay could bring content into existence, it would be a second install path and 035's one-mechanism rule would be broken. Implementation: the overlay root is only ever consulted *for a packId already in the registry* — enumeration starts from installed packs, never from the overlay directory listing. A stray overlay surfaces in the same report as a shadowed pack agent (046 T010).

**FR-005 — the VFS mount.** `/Methods/<packId>/overlay` → jailed `LocalFS`, registered at install and **unregistered at uninstall** (045 T002's `unregisterMount` exists for exactly this). BMB's agent writes there with ordinary `file_*` tools; the pack root stays `ReadonlyFS` and must never be writable.

> An earlier draft mounted this at `/MethodPacks/<packId>`, giving one pack two unrelated VFS prefixes (`/Methods/<id>/templates` from 045 and `/MethodPacks/<id>` from here). Corrected in review: everything a pack exposes lives under `/Methods/<id>/`.

> **The overlay is NOT git-backed, and that is a decision.** FR-005 says "the same shape as `/Specs/<store>`", but that store is `SpecFS` — git-backed, branch-coupled, with history and promote. The overlay is plain `LocalFS`, so BMB's customisations have no history, no rollback and no promote. US3 requires only that they survive a pack upgrade, which `LocalFS` satisfies. Git-backing it would couple a user's agent edits to BOS's feature-branch machinery for no stated requirement — but if versioned customisation is ever wanted, this is the decision to revisit, and it is a swap of backend rather than a change of shape.

### 3.3 FR-002a — ONE total order, four levels

```
1. data/agents/<id>                    the deployment's own copy      (045)
2. data/method-packs/<packId>/agents/  the user's overlay             (048)  ← new
3. the installed pack root             dir OR provider                (045)
4. seed/agents/<id>                    what BOS ships                 (045)
```

`agentRoots()` is extended to emit level 2 between the existing 1 and 3. **There must not be two precedence rules** — `roots.ts` stays the single source, and `collisionsAmong`/`shadowedPackAgents` extend to cover the new level rather than gaining siblings. SC-010 asserts exactly one rule covering all four.

Ordering rationale: the overlay outranks the pack root because it exists to shadow it (US3); `data/agents/` outranks the overlay because a hand-written BOS agent is a deliberate, BOS-format override and must stay the final word.

### 3.4 M3 — Module selection (FR-006, FR-007)

`modules[]` in the descriptor gains structure:

```jsonc
"modules": [
  { "id": "bmm", "label": "BMad Method", "default": true,  "requiresConfig": true,
    "agentsDir": "modules/bmm/agents", "visibility": "delegate-only" },
  { "id": "bmb", "label": "BMad Builder", "default": false, "requiresConfig": false,
    "agentsDir": "modules/bmb/agents", "visibility": "picker" },
  { "id": "cis", "label": "Creative Intelligence Suite", "default": false, "requiresConfig": false,
    "agentsDir": "modules/cis/agents", "visibility": "picker" }
]
```

**FR-006a — backward compatible, NOT a `schemaVersion` bump.** 045 ships `modules?: string[]`; this needs objects. The type becomes `string[] | ModuleSpec[]`, normalising a bare string to `{ id, default: true }`. Bumping `METHOD_SCHEMA_VERSION` to 2 would make `registerMethod` refuse **every existing pack**, spec-kit's own `method.json` included — a breaking change for a purely additive field. 048 does not touch that constant.

Selection is **per install, stored outside the pack** — in `itemConfigDir(packId)`, the existing home for BOS-owned mutable per-item config. Not in the descriptor (which is pack content and would be overwritten on upgrade) and not in the overlay (which is for content, not settings).

Each selected module registers its own root, so `agentRoots()` gains one entry per selected module, not one per pack. Deselecting removes the root and its agents disappear (SC-002).

**Visibility is per module** (FR-007): BMM's cast is `delegate-only` — Sally without a `prd.md` has no input and no consumer, and putting eight chain-dependent personas in the picker buries the agents a user actually starts conversations with. CIS and BMB are `picker`; standalone facilitation is CIS's stated value, and talking to the builder is how BMB is used.

### 3.5 M4 — The #999 shim (FR-009)

BMB's `create-module` writes to `.bmad/custom/modules/{name}/` but generates agent YAML referencing `.bmad/{name}/workflows/`.

```ts
// Upstream: BMAD issue #999. Gated to a PINNED version range.
if (satisfies(packVersion, BMAD_999_RANGE) && looksLikeAffectedLayout(dir)) { … }
else if (satisfies(packVersion, BMAD_999_RANGE)) throw new Error(…unrecognised layout…)
```

Three constraints, all from the spec: version-scoped, cites the issue, and **fails loudly** against a layout it does not recognise. The failure mode being designed against is upstream *fixing* #999 — a silent rewrite would then corrupt correct paths, and would do so invisibly. It must break the day the assumption stops holding.

### 3.6 Content (FR-010, FR-011, FR-011a, FR-011b)

**FR-011a is a sequencing constraint, not a technique.** Authoring the cast *via BMB running inside BOS* is circular: the pack must be installed for BMB to run, and BMB produces the pack's cast. So the shipped BMM cast is authored **upstream** (BMAD + BMB outside BOS, adapted by hand) and checked into the pack. BMB-in-BOS is for *subsequent* customisation only, writing to the overlay. The two loops must not be conflated in the task list.

**FR-011 / FR-011b — the anti-duplication rule.** Every pack agent reaches BOS facts via `skill_load('bos-domain')`. None embeds them. This is the whole point of 044: if BOS knowledge is baked into BMB output it re-duplicates and then drifts silently, in a place nobody greps. SC-009 is a grep.

`roles` binds personas to BOS capability agents where one exists:

```jsonc
"roles": { "implementer": "developer", "architect": "architect", "ui-designer": "ui-designer" }
```

BMAD's Dev persona **binds to** `developer` (the agent holding repo access) rather than replacing it. SM and PO have no BOS counterpart and declare none.

**FR-012 — "fresh chat per workflow".** BMAD's rule exists for context scoping, and BOS's delegation inner loop already provides exactly that: a delegated agent runs with its own system prompt and message history, not the parent's. The pack's prose MUST say so. BOS MUST NOT build new-conversation-per-workflow — it would fragment one feature across N conversations and collide with `agentId` being pinned at conversation creation.

**FR-015 — distribution.** The pack is an item in the user's own `user-apps` marketplace (`data/user-apps/items/<pack-id>/`), carrying BOTH a `method/` and a `plugin/` facet — the first pack to carry two. Publishing publicly is out of scope and is a heavier decision here than for `047`, because this pack executes server code and pins a specific upstream version.

> **AMENDED 2026-09-14 — this section describes a pack that was built and is
> wrong in one decisive way.** Everything above about the CAST holds. What
> follows about the WORKFLOWS produced hand-written substitutes, and the numbers
> that were never taken say why it could not work:
>
> | | upstream `bmad-method@6.12.0` | built |
> |---|---|---|
> | skills | **30** (5 agents · 8 core · 10 plan · 7 ship) | **4** |
> | templates | 26 files in 9 skills' `assets/` | 0 |
> | `customize.toml` | 27 of 30 | 3 |
>
> Authoring "what this means for BOS" is right where BOS's own subsystems change
> the answer — architecture, UX, stories — and meaningless for `bmad-help`,
> `bmad-brainstorming`, `bmad-spec`, `bmad-retrospective` and twenty-odd others
> that are method mechanics with no BOS dimension. A substitute for those is
> strictly worse than the original, and receives no upstream improvement ever.
>
> ### 3.6a The import model (FR-022, FR-027)
>
> `051` settled the general shape of this and this pack is its first real user:
>
> ```
> IMPORT   the 30 skills as published, from a pinned bmad-method release
>            -> the pack's own content, re-importable
> OVERLAY  BOS-specific meaning, on the three skills that need it
>            -> data/method-packs/bmad/, keeps every other file's upstream fixes
> ```
>
> The three `bmad-bos-*` skills are NOT deleted. They hold the FR-010 content this
> feature exists to produce — BOS's real containers, the window model, BOS's story
> shapes — and it is the one part that could not be imported. They become overlay
> content over `bmad-architecture`, `bmad-ux` and `bmad-create-epics-and-stories`.
>
> Re-import must be ONE repeatable operation (FR-022). A hand merge drifts the
> moment either side changes, which is exactly how the pack reached 4 skills.
>
> ### 3.6b BMAD is not a pipeline, and the descriptor said it was (FR-023)
>
> Upstream: *"These are independent tools, not stages. Pick the ones the gap calls
> for, in any order."* The pack declares one 8-phase `phases[]`, and `051` §3.1c
> made that array a TOTAL ORDER the canvas renders as a serial chain — so the
> pack's central data structure asserts what the method denies. The driver skill
> compensates in prose; prose cannot undo what the data says.
>
> Both fixes already exist and the pack uses neither: `049`'s `workflows[]` for
> BMAD's three scale-dependent paths (trivial / epic / project), and `051`'s
> `optional: true` for steps BMAD calls skippable.
>
> ### 3.6c BMAD v6 is a Python toolchain (FR-025, FR-026)
>
> 75 files call `uv run` against four shared scripts at
> `{project-root}/_bmad/scripts/`. `resolve_customization.py` has a fallback;
> `memlog.py` states it has none. The container image has `python3` and `pip` but
> no `uv`, so this works on a dev machine and fails in production — the worst
> split there is.
>
> `{project-root}` resolves to **the store's repository** (`050`). That is where
> `npx bmad-method install` puts `_bmad/`, so BMAD's own CLI keeps working on the
> same checkout, and a team override committed to `_bmad/custom/` travels with the
> code it describes — which is BMAD's own stated model for priority-2
> customisation.
>
> ### 3.6d Skills carry more than SKILL.md (FR-024)
>
> BOS's skill model carries `SKILL.md`, `scripts/` and `references/`. BMAD also
> uses `assets/` (9 skills — the templates) and `customize.toml` (27 skills — the
> override surface). Importing without them drops both SILENTLY, which is the
> defect class this pack has now produced three times: the empty `templates` dir,
> the `bmb`/`cis` declarations, and the missing skills themselves.

**FR-010 — the workflows.** `create-architecture` must produce BOS's real containers (the Next.js app process, the Supervisor and its preview worktrees, worker-thread service processes, a marketplace item's own git repo, the VFS/GitFS stores, Bastion) — the list `bos-domain` already holds, referenced not copied. `create-front-end-spec` targets BOS's window model, the iframe/app-facet split and the A2UI v0.9 catalog. The PRD → epics → stories chain maps onto descriptor artifacts, with sharded stories handled by 045's `set`/`count` predicates over a glob — **no new evaluation code** (SC-011).

---

## 4. Decisions

**ADR-1 — Provider roots, not generated files.** §3.1. Preserves "install copies nothing"; avoids a derived-cache staleness class with no natural invalidation point.

**ADR-2 — Invoke at discovery, cache on `(root, max mtime)`.** Not boot-time parsing. US2 requires a BMB-authored agent to resolve without a restart, and boot parsing makes BMAD agents uniquely restart-bound — worst for the module whose purpose is interactive authoring.

**ADR-3 — Overlay at `data/method-packs/<packId>/`, not inside the item.** Writing into the item would put user content in a tree the marketplace overwrites on upgrade (US3 fails), and would make the item's git repo carry user edits. Follows `itemConfigDir`'s established shape.

**ADR-4 — Module selection stored in `itemConfigDir`, not the descriptor or the overlay.** The descriptor is pack content (overwritten on upgrade); the overlay is for content, not settings. `itemConfigDir` is already "BOS-owned mutable config, seeded from the item's defaults at install" — exactly this.

**ADR-5 — Reuse bos-plugins' trust model; introduce nothing.** The pack executes in the Next.js process. Inventing pack-specific sandboxing would be a second security mechanism to keep correct, and a weaker one than the reviewed loader. Containment is the three existing facts: per-user blast radius, the origin gate on redistribution, and the install-time warning (built 2026-09-12, so FR-008 can now actually verify it).

**ADR-6 — `phases` in the provider output, unread in this feature.** FR-003. Declaring the field now costs nothing; adding a second provider shape later is how parallel mechanisms are born.

---

## 5. Risks

- **R1 — Content has no mechanical acceptance test.** "Does `create-architecture` produce a good BOS design?" is judgement. Plan to iterate against real features; do not declare FR-010 done on first authoring. This is the largest and least bounded part of the feature.
- **R2 — BMAD v6 is alpha and renaming things.** Commands changed between v4 and v6; packaging is mid-shift toward skills. Pin the version; expect prose refreshes per upstream release. FR-008a keeps the two versions (descriptor `schemaVersion` vs upstream BMAD) from being conflated.
- **R3 — The circular authoring loop (FR-011a)** is easy to re-introduce under time pressure: "just use BMB to generate the cast" is exactly the move that cannot work for the initial authoring.
- **R4 — Provider caching is a correctness risk, not a perf one.** A stale cache means a BMB-authored agent does not appear, which reads as BMB being broken. Prefer re-resolving over serving a stale result when the mtime scan is ambiguous.
- **FR-013 coverage** is carried by R5/R6 below rather than a section of its own: the harness exists, the writable-overlay fixture does not.

- **R5 — e2e depends on the fixture harness** (now built), but the BMB round trip needs a *writable overlay* fixture, which the harness does not yet produce. Extend it as part of this feature rather than hand-rolling a second fixture shape.
- **R6 — 045's browser-level e2e (T031) is still unwritten**, including the `build-studio.spec.ts:49-56` skip conversion. 048 SC-012 is browser-level. Either T031 lands first or 048 inherits the gap — it must not be inherited silently.

---

## 6. Files

```text
src/lib/agent/subagents/roots.ts        AgentRoot union + level 2       (M1, M3, FR-002a)
src/lib/agent/subagents/store.ts        provider invocation + cache     (M1)
src/lib/specs/method/overlay.ts         NEW — overlay paths, inertness  (M2)
src/lib/specs/method/install.ts         module selection, overlay mount (M2, M3)
src/lib/specs/method/types.ts           ModuleSpec, ProviderOutput      (M1, M3)
src/lib/specs/spec-mount.ts             /Methods/<id>/overlay mount     (M2)
e2e/_fixtures/method-pack/              writable-overlay fixture        (R5)
data/user-apps/items/bmad-method/       THE PACK (content)              (FR-010, FR-011)
docs/dev/method-packs.md                provider + overlay sections     (VI)
```

**Estimated split**: mechanism ≈ 30%, content ≈ 70%. The spec's warning that content is "plausibly larger than 044 and 045 combined" should be treated as accurate, and is why the BMM-only valve stays on the table mid-implementation.

---

## 7. Boundaries a unit suite cannot cross

Distributing and installing a pack crosses seams that no single-process test
reaches, however thorough its coverage. Each row is a place where the obvious
implementation passes its tests and fails in the product:

| Boundary | The defect |
|---|---|
| install → restart | a pack registered at install and never again; it vanished on reboot |
| module instance | the boot hook's registry is not the one route handlers read |
| parse → rewrite | a field the parser ignored was **deleted from disk** and committed |
| seed memoisation | `ensureSeed` had already run, so installing seeded nothing |
| descriptor → message | a warning naming a phase the target method did not have |

A unit test runs in one process, one module instance, one memoised state. The
fixtures installed and asserted in the same breath, so they could never observe
the gap — and each one passed while its feature was broken.

**Rule: when a contract spans a restart, a second module instance, or a file BOS
rewrites, the check must cross that boundary.** Asserting the same thing harder
inside one process will not find it.

### 7.2 A fixture that stands in for a missing step cannot detect the step

Pack content in the built-in seed location is inert — nothing registers it —
while every surface still looks plausible. A test that copies the pack into a
temporary `user-apps` and installs it from there proves the pack works *when
distributed as an item*, which says nothing about whether it IS distributed as
one. The fixture supplies the very step whose absence is the bug.

**Rule: a test may not synthesise the artefact whose absence it exists to
catch.** Where distribution is part of the requirement, the test consumes the
real distribution or it is testing something else.

### 7.3 Roles are hand-written against someone else's vocabulary

A framework's skill ids and a pack's agent directory names are both plausible
identifiers, both appear in the upstream docs, and a wrong one degrades to
silence.

**Rule: any hand-authored cross-reference between two namespaces needs a
validation pass at install.** See `046` FR-021.

### 7.4 Messages are derived data too

A warning written against spec-kit's phase names, while claiming to describe an
arbitrary target, asserts consequences the target method cannot produce.

A descriptor-driven system has descriptor-driven *prose*: if a sentence names a
phase or a state, it must read both from the descriptor it is talking about, and
must be able to say nothing when the descriptor has no such phase. An
authoritative-sounding warning that cannot come true is worse than no warning,
because it costs the user work and costs every later warning its credibility.
