# Implementation Plan: OKF Knowledge Base — general-purpose agent KB (redesign + automatic ingestion)

**Branch**: `bos/okf-auto-ingest` | **Date**: 2026-10-10 | **Spec**: `item-okf-knowledge-base/spec.md`
**Design**: `item-okf-knowledge-base/design.md` (authoritative for architecture/ADRs — this plan folds its structure + ADRs in; it does not re-litigate them)
**UI contract**: `item-okf-knowledge-base/mockup.html` (binding — the app implements it directly)
**Tool-surface reference**: `item-okf-knowledge-base/tool-surface.md`

This plan **supersedes the prior 2026-10-09 plan** (branch `bos/okf-kb-redesign`), which was written against an earlier draft of the spec and the pre-auto-ingest design. It is reorganized to the spec's **nine user-value stories** and reflects the **automatic-ingestion scope-add** approved this session. It still describes the **full current deliverable**: the installed `okf-knowledge-base` item (the original 31-tool, dispatcher-`okf_ingest`, config-app version) is reworked, in place, into the general-purpose KB **plus** the auto-trigger ingestion mechanism.

## Summary

Redesign and extend the installed `okf-knowledge-base` marketplace item into a **general-purpose, agent-managed knowledge base** whose center of gravity is **organization + efficient, concept-anchored retrieval** — full documents or full chapters, never snippet chunks — over a **two-level derived index** stored as OKF-native `.md` artifacts (bundle `concept-index.md` + per-doc `toc/<id>.md`), with **no vector/keyword/embedding/SQL store in v1** (NFR-002). The agent surface is **19 `okf_*` tools**. The companion is a **standalone master-detail app** (Overview / Jobs / Query).

On top of that base, this scope-add changes the **ingestion mechanism**: calling `okf_ingest` (or the app's Ingest modal) **automatically starts a headless `okf-ingest` run** and returns a `jobId` immediately — the caller is freed and does **not** run acquisition steps or delegate anything (FR-046/FR-047). The **launcher (the service worker) owns the job's final state** from the run's own terminal signal, with a **worker-side stale reaper** as the last line of defense (FR-049, ADR-006). A new **`okf_list_jobs`** tool (FR-048) exposes the same run records the app's Jobs tab shows. The bundled **`okf-ingest` agent carries a self-sufficient allowlist** — the full `okf_*` surface plus acquisition plus VFS reads — because the run performs the whole job end-to-end (FR-039).

All of this is a **marketplace item** (service facet + app facet + bundled agent + skill) — **zero `src/` (bos-core) changes**; the four prior `bos-core` prerequisites (clean `web_fetch`, `file_to_markdown`, `view_image`, `video_keyframes`) and the headless `runSubAgent`/`POST /api/subagents/delegate` surface + copy-install/provenance are **dependencies assumed already shipped** (design ADR-005), not re-scoped here.

**Technical approach** (from design): keep the existing worker-thread service facet + `okf-core` storage + VFS bridge + 039 `deploymentMode:"tools"` exactly as installed. Add the **derived-index layer** (build + store as `.md`, regenerate on write). Rework `okf_ingest` from a dispatcher to an **auto-trigger** (worker fires the headless run over its loopback channel). Add the **inline-asset pipeline**. Expose a small **app-facing REST surface** over the existing `httpPath` bridge (bundles, detail, toc, chapter, search, graph, jobs, **`POST /jobs`**, **`GET /tools`**). Rebuild the app facet from `mockup.html`.

## Technical Context

**Language/Version**: Service = plain **Node.js** worker thread, dependency-free (the installed `okf-core.js` already is; frontmatter via the existing lightweight parser). App = **TypeScript/TSX** (esbuild-bundled by `app_build`; may import React — provided by the bundler, no `npm install`).

**Primary Dependencies**: **None new.** The service reuses `okf-core.js` (storage), `vfs-bridge.js` (loopback `/api/fs` + `/api/fs/raw`), `http-bridge.js` (REST over `httpPath`), the 039 tool-declaration IPC, and the **existing** BOS headless-run surface `POST /api/subagents/delegate` (which runs `runSubAgent`). The app uses React (bundled). No external CDN, no vector/keyword/embedding library, no SQL driver, no `d3`/`vis.js`.

**Storage**: **Files under the VFS** at `/KnowledgeBase/<bundle>/`, reached by the service through the loopback `/api/fs` + `/api/fs/raw` bridge. OKF chapter/concept `.md` (frontmatter-carrying) is the **source of truth**; the two-level index (`concept-index.md`, `toc/<id>.md`) is **derived** `.md`, regenerated from frontmatter and never the sole source of truth (design ADR-001/002). `raw/` immutable sources + `raw/assets/<docId>/` downloaded inline assets (binary via streaming `PUT /api/fs/raw`, design §10 risk 1). Job records under `bundleRoot/.jobs/` (operational state; design ADR-006).

**Testing**: **Playwright e2e** — `e2e/okf-knowledge-base.spec.ts` (item-local `e2e/` dir; feature-id = item id `okf-knowledge-base`; run against the branch preview via `BOS_PREVIEW_URL` + `npx playwright test`, the established convention for installed items). Cover: the **19-tool surface** (count asserted against the service's **real** declared set via `GET /tools`, schema validation, the removed 12 by name), the two-level index build + regenerate + stale-detection, `okf_search` determinism (same query → same TOC rows; the app `GET /search` route returns identical rows), inline-asset block shape + no-reinterpret-at-query, **auto-trigger** (calling `okf_ingest` returns `jobId` with **no** `acquisition_required`/`delegation_required` block; the run reaches `completed` with a summary or `failed` with an error; a killed/abandoned run is reaper-marked failed; `okf_list_jobs` reflects the same lifecycle the Jobs tab shows), graph derivation (nodes/edges from frontmatter/index/links, on-read), import/export spec-conformance + best-effort index on pre-existing bundles, and the app's three tabs (Overview / Jobs / Query) + shared-search-reflects-in-both-views + resizable reader pane + "Open source" target.

**Target Platform**: BOS container (the service is a worker thread; the app is a bundled iframe app; the sandbox already ships `markitdown`, `ffmpeg`, `libreoffice`, `poppler` — dependencies, not new installs).

**Project Type**: **Marketplace item** (service facet + app facet + bundled agent + skill), installed via `app_build` into `data/user-apps/items/okf-knowledge-base/` (id preserved).

**Performance Goals**: Retrieval cost **bounded by concept-vocabulary size, not document/chapter count** (NFR-011) — `okf_search` is an O(V) deterministic match over the concept index. The escalation to a real pre-filter/embedding index is gated on the vocabulary being "too big for one routing pass" (NFR-002, design ADR-001), **not** on document count. Ingest is **asynchronous from the caller's perspective** (FR-046) — `okf_ingest` returns in O(job-mint), not O(ingest). No numeric SLO.

**Constraints**: No vector/keyword/embedding/SQL store in v1 (NFR-002). Retrieval returns full documents/chapters (NFR-003). The **19**-tool surface is fixed — app views must not add tools (FR-037, NFR-008). All writes atomic, path-guarded, unknown frontmatter keys preserved (NFR-005/006, FR-024). `raw/` immutable (NFR-006). The derived index is regenerable and never the sole source of truth (NFR-004). Single-user (NFR-008). Loopback-scoped trust boundary. The ingest agent's allowlist is scoped to the KB domain (FR-039, NFR-009).

**Scale/Scope**: N bundles (single-user personal OS); each bundle holds documents → chapters → concept terms. The index is per-bundle. The app has 3 top-level tabs (Overview / Jobs / Query) and the Query tab's 2 views (Graph / Table) + reader pane.

## Constitution Check

*GATE: must pass before implementation. Re-check after the plan's structure is fixed.*

Constitution: `/Specs/bos-system-specs/.specify/memory/constitution.md`.

| # | Principle | Compliance |
|---|---|---|
| I | **BOS source is read-only for marketplace features** — a marketplace item never edits `src/` | ✅ Pure **marketplace item**. Touches only `data/user-apps/items/okf-knowledge-base/` (services/ + app/ + agents/ + skills/ + config/ + docs/). The four prior `bos-core` capabilities and the headless `POST /api/subagents/delegate` surface are **assumed-shipped dependencies**, not re-implemented — no `src/` file is in this plan's structure. |
| II | **Storage in the VFS, owned by the service** | ✅ OKF bundles under `/KnowledgeBase/<bundle>/`, owned by the `okf-knowledge-base` service facet through its loopback VFS bridge. Job records under `bundleRoot/.jobs/`. Nothing in `src/` or the app's client storage holds user knowledge. |
| III | **Data is human-readable, non-lossy** | ✅ Source of truth is OKF `.md`. The derived index is also `.md` (frontmatter-carrying, regenerable) — not a binary/DB blob. Unknown frontmatter keys preserved verbatim on every write (FR-024, NFR-005). `raw/` immutable. No embeddings/vectors/SQL. |
| IV | **No hidden state; deterministic** | ✅ `okf_search` is deterministic (same query → same TOC rows, no LLM in the match — design §6.1). The derived index is **regenerable from source** (NFR-004) — never a second source of truth to drift. Ingest is **observable and finalized** (FR-044/049, ADR-006) — the launcher writes the terminal state from the run's own signal; a reaper guarantees no run is left "running" forever. |
| V | **Least privilege / scoped tools** | ✅ The **19**-tool surface is the whole agent-facing API (FR-037). The `okf-ingest` agent's allowlist is scoped to the KB domain — the full `okf_*` surface + named acquisition + VFS reads, no non-`okf_*` tools, no unrestricted `run_command`, no `agent_delegate` (FR-039, NFR-009). App views are an HTTP surface, not tools (NFR-008). Writes are path-guarded to the bundle root. |
| VI | **Atomic, guarded writes** | ✅ All concept/index/toc writes go through `okf-core`'s existing atomic write + path-traversal guard; the plan reuses, not reinvents, that mechanism. Binary assets stream via `PUT /api/fs/raw` (no whole-file buffering). |
| VII | **Observable lifecycle** | ✅ Ingest runs are observable jobs (queued/running/completed/failed, FR-041/044, NFR-011) with a summary or error, exposed to **both** the Jobs tab and `okf_list_jobs` (one store, two surfaces), and reaper-bounded (FR-049). |
| VIII | **Portable / spec-conformant** | ✅ Export is a spec-conformant OKF bundle including the concept index and document TOCs (FR-010, SC-004); import accepts a bundle and re-derives its index best-effort (design §10 risk 9). The item ships a `docs/` facet (required). |

**Verdict**: PASS — no violations. No Complexity Tracking rows required.

## Project Structure

### Documentation (this feature — the item's spec store)

```text
item-okf-knowledge-base/          # reached via app_spec_* (physically data/user-apps/items/okf-knowledge-base/spec/)
├── spec.md                        # source of truth (49 FR, 11 NFR, 13 SC, 9 user stories)
├── design.md                      # architecture + ADRs (authoritative; reviewed — one revision round applied)
├── tool-surface.md                # the 19 okf_* tools + the auto-trigger mechanism (mirrors design §8.2/005/006)
├── mockup.html                    # binding UI contract (Overview / Jobs / Query)
├── plan.md                        # THIS file
└── tasks.md                       # next step
```

### Source Code (the item — written by the Developer into a fresh staging dir, then installed by `app_build`)

The staging directory root **is the item root**. `app_build` carries these facets into `data/user-apps/items/okf-knowledge-base/`:

```text
okf-knowledge-base/                       # = staging dir root = item root
├── services/
│   ├── service.json                      # id "okf-knowledge-base", deploymentMode "tools",
│   │                                     #   entry "index.js", toolGroups ["Knowledge Base"],
│   │                                     #   configSchema { bundleRoot, port 0, maxDepth, maxWorkers,
│   │                                     #                  staleJobMs }   ← staleJobMs added (ADR-006)
│   ├── index.js                          # worker entry: starts okf-core + http-bridge + 039 tool IPC.
│   │                                     #   ADD: the job **stale reaper** timer + a reaper sweep on
│   │                                     #   (re)start (ADR-006/FR-049).
│   ├── lib/
│   │   ├── okf-core.js                   # storage — EXTEND: derived-index build/regenerate, okf_search,
│   │   │                                 #   okf_merge_concepts, graph derivation, bundle health, binary
│   │   │                                 #   raw-asset write/read (streaming /api/fs/raw), raw/sources.json
│   │   │                                 #   provenance ledger, job records (create/get/list/update) +
│   │   │                                 #   the reaper predicate. Reuse existing atomic-write + path-guard.
│   │   ├── vfs-bridge.js                 # ADD writeBinary (streaming PUT /api/fs/raw) + readRaw; else unchanged.
│   │   ├── delegate-bridge.js            # NEW: the worker's client for POST /api/subagents/delegate —
│   │   │                                 #   opens the loopback request, consumes the NDJSON stream,
│   │   │                                 #   surfaces {progress from tool lines, terminal endedReason +
│   │   │                                 #   output/error}. The okf_ingest trigger path uses this.
│   │   ├── http-bridge.js                # REST — the app-facing surface (design §8.3): bundles, detail,
│   │   │                                 #   toc, chapter, search, graph, jobs, asset proxy, lint, stale,
│   │   │                                 #   import, export, delete, + GET /tools (real declared count) +
│   │   │                                 #   POST /jobs (app-side auto-trigger, shares the okf_ingest path)
│   │   │                                 #   + POST /jobs/<id> (optional sub-agent progress enrichment).
│   │   └── tools.js                      # DECLARATIONS = exactly the 19 tools (design §8.2). okf_ingest
│   │                                     #   = auto-trigger (mint job → delegate-bridge → return jobId,
│   │                                     #   own finalization from endedReason, ADR-005/006). ADD okf_list_jobs
│   │                                     #   (readOnly). Remove the 12 net (16 by name) vs the old 31.
│   └── (no new external deps)
├── app/
│   └── src/                              # the standalone master-detail app from mockup.html:
│                                         #   Overview / Jobs / Query tabs, force-directed graph, shared
│                                         #   search, resizable reader pane; Ingest modal → POST /jobs;
│                                         #   titlebar badge reads GET /tools count. Talks to the service
│                                         #   over httpPath (bridge.ts).
├── agents/
│   └── okf-ingest/AGENT.md               # bundled sub-agent — SELF-SUFFICIENT allowlist (design §8.4):
│                                         #   full okf_* surface + acquisition + VFS reads. Instructions:
│                                         #   end-to-end ingest (acquire → decompose → inline assets →
│                                         #   toc/index → bounded ref crawl via own okf_ingest), final
│                                         #   compact honest summary. Does NOT finalize the job (the launcher
│                                         #   does).
├── skills/
│   └── okf-bundle-schema/SKILL.md        # ingest/query/lint conventions (ADR-007): chapter frontmatter,
│                                         #   concept-term naming/merge, inline-asset block format, dedup,
│                                         #   report-honestly.
├── config/
│   └── okf-knowledge-base.json           # defaults: bundleRoot /KnowledgeBase, port 0, maxDepth 1,
│                                         #   maxWorkers 3, staleJobMs 1800000.
└── docs/                                 # REQUIRED facet — describe the SHIPPED item
    ├── usage/OKF Knowledge Base/
    │   ├── index.md                      # what it does, the three tabs, retrieval model in plain terms
    │   ├── ingest.md                     # how to trigger ingest (tool or app modal → auto run), what a run
    │   │                                 #   does, watching Jobs / okf_list_jobs
    │   └── troubleshooting.md            # search misses, stale items, stuck jobs (reaper), import/export,
    │                                     #   service not started
    └── dev/OKF Knowledge Base/
        ├── architecture.md               # service facet, VFS/delegate bridges, two-level index, auto-trigger
        │                                 #   mechanism (ADR-005/006), reaper
        ├── data-model.md                 # bundle layout, frontmatter schema, index/TOC format, job record
        ├── tool-surface.md               # the 19 okf_* tools (mirror of design §8.2)
        └── extension.md                  # adding a bundle convention; the okf-ingest skill as the seam
```

**Structure Decision**: **Marketplace item, all facets in one `app_build`.** No `src/` (bos-core) file appears — the four prior `bos-core` capabilities and the headless `POST /api/subagents/delegate` surface are dependencies assumed shipped (design ADR-005). The service facet is the one real backend (plain Node worker thread; its `services/` path is **not** a `src/` fragment, so it does not trip the `contentOnly` harness). The app facet is the standalone master-detail app from `mockup.html`. `docs/` is namespaced by the item's display name **`OKF Knowledge Base`** in **both** `usage/` and `dev/` (required — the Docs app reads only those two paths). The `id` is preserved (`okf-knowledge-base`) because this is an in-place rework of an already-installed item.

### Optional companion artifacts — evaluated, decided

Per the plan command, `research.md` / `data-model.md` / `contracts/` are added **only when warranted**:

- **`research.md`** — **not warranted.** Every open mechanism question was resolved during `design` and re-verified by `architect-reviewer` against source (the headless-run surface, its loopback auth model, the `endedReason` terminal shape, the claude-only branch gate, the binary `PUT /api/fs/raw` path, the `POST /jobs` + `GET /tools` app surfaces). The resolutions live in `design.md` ADRs + §8.3.
- **`data-model.md`** — **folded into design.md §5–6, not a separate planning file.** The bundle layout, chapter frontmatter, concept-index/TOC format, and job record are fully specified there. The item's `docs/dev/.../data-model.md` documents the *shipped* model for users (a different audience).
- **`contracts/`** — **not a separate folder.** The authoritative contracts are the **19-tool I/O table in design.md §8.2** and the **app REST routes in design.md §8.3** (including `POST /jobs`, `GET /tools`, `POST /jobs/<id>`). `tasks.md` pins those two tables as the contract and the e2e tests validate against them.

## Design Notes (folded from `design.md` — so the analysis isn't stranded in chat)

The ADRs (design.md §4) are the authoritative decisions, carried by reference:

- **ADR-001** — no vector/SQL/embeddings in v1; a two-level *derived* file index (bundle concept index + per-doc TOC), both `.md`, regenerable, never the sole source of truth; the escalation to a keyword/BM25 pre-filter is gated on the concept *vocabulary* being too big for one deterministic pass (~50k index tokens / ~2s p95), documented before adoption.
- **ADR-002** — two levels (bundle `concept-index.md` + per-doc `toc/<docId>.md`), not one flat file: they map to the two distinct retrieval moves (route-by-concept vs drill-into-a-document) and keep each artifact's size bounded by its own concern.
- **ADR-003** — the app talks to the service over a **dedicated app-facing REST surface**, not the agent tools (the app is an opaque-origin iframe). Adding app views does **not** add to the 19-tool surface — HTTP routes are plumbing, not `tool_declare`d tools. **One capability, two surfaces**: `okf_search` and `GET /search` run the identical `core.search()`; the Jobs tab and `okf_list_jobs` read the identical `core.listJobs()`; the titlebar badge and the e2e count assertion read `GET /tools` (the real declared set).
- **ADR-004** — the knowledge graph is **derived on read** from stored frontmatter/index/`links.json`, not a stored graph DB. Edge types are exactly `containment` (doc→chapter), `coverage` (chapter→term), `link` (explicit). No `neighbors`/`shortest_path`/`export_graph` tools.
- **ADR-005 — `okf_ingest` auto-triggers a headless `okf-ingest` run.** The worker (outside Next.js, no agent loop) **fires `POST /api/subagents/delegate` over its loopback channel** (the same channel it uses for the VFS) with `{task, agent:"okf-ingest"}`, mints the job, and returns `{jobId, status:"queued"}` at once. That route runs the same `runSubAgent` the scheduler/workflows/Telegram/self-heal use; it streams NDJSON ending in a terminal line. `okf-ingest` is a `local` agent, so the route's claude-only feature-branch gate doesn't apply. Loopback transport is the trust boundary (the same model `/api/fs` uses). The run performs the **whole job end-to-end** (FR-047). **This supersedes** the installed dispatcher (`plannedAcquisition`/`delegation_required`) and the old assistant-issues-`agent_delegate` path.
- **ADR-006 — the launcher owns finalization + a stale reaper.** Because the worker issued the delegate request, it reads the run's **own** NDJSON terminal signal and owns the job's terminal state — no assistant safety net, no dependence on the sub-agent remembering to call back. Terminal state is derived from `result.endedReason` (a failed *local* run arrives as `done` with `endedReason:"error"`, because `runSubAgent` self-catches and resolves; the route's `{type:"error"}` line is only its outer `catch`, essentially unreachable for a self-catching local agent): `completed` → `completed` (summary from `result.output`), `error`/`max_steps` → `failed`. A **worker-side stale reaper** (`staleJobMs`, default 30 min; a timer plus a sweep on (re)start) marks any run still non-terminal as `failed (stale)`, covering a worker killed mid-run. `POST /jobs/<id>` remains for optional sub-agent **progress** enrichment.
- **ADR-007** — bundle conventions live in the `okf-bundle-schema` **skill**, attached to `okf-ingest`, not a per-bundle `schema.md` (that tool is removed from the 19).
- **ADR-008** — inline assets are **downloaded + interpreted at ingest** (non-HTML only; HTML links stay remote refs), stored as a link + a blockquote interpretation in the chapter; retrieving the chapter returns the stored interpretation without re-running vision.
- **ADR-009** — the app's force-directed graph is a **dependency-free in-app port** of `mockup.html`'s own simulation (no `d3`/`vis.js`).

**The 19 tools** (design §8.2, authoritative): Retrieval — `okf_search`, `okf_read_toc`, `okf_read_concept`, `okf_list_concepts`; Concepts — `okf_upsert_concept`, `okf_delete_concept`, `okf_merge_concepts`; Bundles — `okf_list_bundles`, `okf_init_bundle`, `okf_import_bundle`, `okf_export_bundle`, `okf_delete_bundle`; Ingest — `okf_ingest` (auto-trigger), `okf_add_raw_source`; **Jobs — `okf_list_jobs`**; Organization — `okf_add_link`, `okf_backlinks`; Health — `okf_lint`, `okf_stale_report`. (vs the installed 31: 4 added, 15 kept, 12 fewer net / 16 removed by name — the field-setters collapsed into `okf_upsert_concept`'s frontmatter merge, graph power-tools dropped.)

**Two-level index** (design §5): bundle `concept-index.md` (frontmatter = `term → [(doc, chapter, one-line description)]`, body = human listing) + per-doc `toc/<docId>.md` (frontmatter = `chapters: [{id, title, summary, concepts, status}]`). Both regenerated from chapter frontmatter on write (a write bumps a dirty flag; a read-through cache rebuilds once) and independently regenerable on read for drift repair.

**`okf_search`** (design §6.1): tokenize → match concept terms (term-name hits outrank description hits) → gather covering chapters from the index → return ranked TOC rows `{docId, docTitle, chId, chTitle, description, matchedConcept, status, stale}`. **No LLM in the match.** **The single function both the `okf_search` tool and the app's `GET /search` route call** (FR-036/043).

**App data access** (design §8.3): the app iframe resolves its service base URL via `httpPath`-else-`runtime.port` (`bridge.ts`; `services.md` §11) — **not** same-origin BOS routes (ADR-003). Routes include `GET /bundles`, `GET /bundles/<b>` (detail + health + concept index + documents), `GET /bundles/<b>/toc/<docId>`, `GET /bundles/<b>/concept/<id>`, `GET /bundles/<b>/search?query=`, `GET /bundles/<b>/graph`, `GET /bundles/<b>/assets/<p>`, `GET /bundles/<b>/lint`, `GET /bundles/<b>/stale`, `POST /bundles/<b>/import`, `GET /bundles/<b>/export`, `DELETE /bundles/<b>`, **`GET /tools`** (real declared count → badge + e2e assertion), **`POST /jobs`** (app Ingest-modal auto-trigger — shares the `okf_ingest` handler's worker-side path; supersedes the installed `POST /bundles/<b>/ingest` dispatcher), **`GET /jobs`**, `GET /jobs/<id>`, **`POST /jobs/<id>`** (optional progress). The app must be granted the `services:read` capability (one-time, documented).

**Upgrade path** (design §10 risk 9): the installed item is the original 31-tool version. Reinstall reworks it in place (id preserved). Pre-existing bundles may lack `parent`/`concepts`/`summary` frontmatter → `okf_import_bundle`/first-open does a **best-effort** derived index (flat doc→chapter, no `parent`, naive/empty concepts); health reports "index needs regeneration"; a re-ingest or an `okf_upsert_concept` pass completes it. **Decision pinned**: best-effort, non-destructive, reported — never silently drop or silently re-derive-overwrite.

## Open items carried into `tasks.md`

1. **`jobs` location** — pinned **service-level** under `bundleRoot/.jobs/` (single-user; matches the global Jobs tab and `okf_list_jobs`). One store, two surfaces.
2. **App facet entry** — pinned `app/src/main.tsx` (bundled by `app_build`); the app reproduces `mockup.html`.
3. **`e2e` path** — pinned `e2e/okf-knowledge-base.spec.ts` (feature-id = item id `okf-knowledge-base`), run via `BOS_PREVIEW_URL` + `npx playwright test`.
4. **Tool name** — pinned `okf_init_bundle` (the spec's name; not `okf_create_bundle`).
5. **`POST /api/subagents/delegate` auth** — verified loopback-trusted (no per-request auth), same as `/api/fs`; the worker uses the same loopback base it already resolves for the VFS. The `delegate-bridge` client must consume the NDJSON to its terminal line.
