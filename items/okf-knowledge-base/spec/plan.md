# Implementation Plan: OKF Knowledge Base — General-Purpose Agent KB Redesign

**Branch**: `bos/okf-kb-redesign` | **Date**: 2026-10-09 | **Spec**: `item-okf-knowledge-base/spec.md`
**Design**: `item-okf-knowledge-base/design.md` (authoritative for architecture/ADRs — this plan folds its structure + ADRs in; it does not re-litigate them)
**UI contract**: `item-okf-knowledge-base/mockup.html` (binding — the app implements it directly)

**Input**: Feature specification from `item-okf-knowledge-base/spec.md`. This plan **replaces** the prior 040/041 plan (now removed) and supersedes the design/plan of the installed 31-tool `okf-knowledge-base` item. The prior item is already installed (`data/user-apps/items/okf-knowledge-base/`); this is an **in-place redesign of an existing item** — same `id`, same service facet shape, redesigned storage/index/retrieval/tool-surface/app.

## Summary

Redesign the installed `okf-knowledge-base` marketplace item into a **general-purpose, agent-managed knowledge base** whose center of gravity is **organization + efficient retrieval** (not ingestion). Retrieval is **deterministic, concept-anchored, and document/chapter-granular** (full documents or full chapters, never snippet chunks — NFR-005/SC-002) over a **two-level derived index** stored as OKF-native `.md` artifacts (bundle `concept-index.md` + per-doc `toc/<id>.md`), so OKF content stays the sole source of truth and no vector/keyword/embedding store is introduced (NFR-001). The agent surface is cut from 31 to **18 tools** (3 added: `okf_search`, `okf_read_toc`, `okf_merge_concepts`). The app facet becomes a **standalone master-detail app** (Overview / Jobs / Query) — the Query tab is a single unified view: one shared search field + a Graph/Table toggle, the Graph rendered as a force-directed, category-colored, edge-labeled knowledge graph (Neo4J/knowledge-graph style in the BOS dark palette). All of this is a **marketplace item** (service facet + app facet + bundled `okf-ingest` agent) — **zero `src/` (bos-core) changes**; the four prior `bos-core` prerequisites (clean `web_fetch`, `file_to_markdown`, `view_image`, `video_keyframes`) are **dependencies assumed already shipped**, not re-scoped here.

**Technical approach** (from research/design): keep the existing worker-thread service facet + `okf-core` storage + VFS bridge + `deploymentMode:"tools"` (039) exactly as installed. Add a **derived-index layer** (build + store as `.md`, regenerate on write). Replace the flat `okf_ingest` with the dispatcher + `okf-ingest` sub-agent pipeline (already present in the installed item) wired to **job observability** (sub-agent → service loopback-HTTP callbacks; assistant safety-net). Add the **inline-asset pipeline** (download → `view_image`/`video_keyframes` → store link + interpretation). Expose a small **app-facing REST API** over the existing `httpPath` bridge (list/detail/toc/chapter/search/graph/jobs). Rebuild the app facet from `mockup.html`.

## Technical Context

**Language/Version**: Service = plain **Node.js** (worker thread, dependency-free — the installed `okf-core.js` already is; `yaml`/`front-matter` parsed with the existing in-repo lightweight parser or a tiny inline loader, matching `okf-core.js`). App = **TypeScript/TSX** (esbuild-bundled by `app_build`; may import React — provided by the bundler, no `npm install`).

**Primary Dependencies**: **None new.** The service reuses its existing `okf-core.js` (storage), `vfs-bridge.js` (loopback `/api/fs` + `/api/fs/raw`), `http-bridge.js` (REST over `httpPath`), and the 039 `deploymentMode:"tools"` tool-declaration IPC. The app facet uses React (bundled). No external CDN, no vector/keyword/embedding library, no SQL driver.

**Storage**: **Files under the VFS** at `/KnowledgeBase/<bundle>/`, reached by the service through the loopback `/api/fs` + `/api/fs/raw` bridge (the installed `vfs-bridge.js`). OKF chapter/concept `.md` (frontmatter-carrying) is the **source of truth**; the two-level index (`concept-index.md`, `toc/<id>.md`) is **derived** `.md`, regenerated from frontmatter and never the sole source of truth (ADR-002). `raw/` immutable sources + `raw/assets/<docId>/` downloaded inline assets. Job records in a single `jobs.json` under the bundle/service state dir (design.md §7).

**Testing**: **Playwright e2e** — `e2e/<feature-id>.spec.ts` (the `buildstudio_run_tests` contract). Cover: tool surface (18 declared, schema validation, the removed 13), the two-level index build + regenerate + stale-detection, `okf_search` determinism (same query → same TOC rows; app route returns identical rows), inline-asset block shape + no-reinterpret-at-query, job lifecycle (queued→running→completed|failed, via the callback + the assistant safety-net), graph derivation (nodes/edges from frontmatter/index/links, on-read), import/export spec-conformance + best-effort index on pre-existing bundles, the app's three tabs (Overview / Jobs / Query) + shared-search-reflects-in-both-views + resizable reader pane + "Open source" target.

**Target Platform**: BOS container (the service is a worker thread; the app is a bundled iframe app; the sandbox already ships `markitdown`, `ffmpeg`, `libreoffice`, `poppler` — dependencies, not new installs).

**Project Type**: **Marketplace item** (service facet + app facet + bundled agent), installed via `app_build` into `data/user-apps/items/okf-knowledge-base/` (id preserved).

**Performance Goals**: Retrieval cost **bounded by concept-vocabulary size, not document/chapter count** (NFR-004) — `okf_search` is an O(V) deterministic match over the concept index. The escalation to a real pre-filter/embedding index is gated on the vocabulary being "too big for one routing pass" (NFR-002), **not** on document count. No numeric SLO; the measurable property is that search stays a lookup, not a whole-corpus scan.

**Constraints**: No vector/keyword/embedding/SQL store in v1 (NFR-001). Retrieval returns full documents/chapters (NFR-005). The 18-tool surface is fixed — app views must not add tools (FR-037, NFR-008). All writes atomic, path-guarded, unknown frontmatter keys preserved (NFR-003/006/007, FR-021). `raw/` immutable (NFR-009). The derived index is regenerable and never the sole source of truth (NFR-006). Single-user (NFR-013). Loopback-scoped trust boundary (FR-023, NFR-010).

**Scale/Scope**: N bundles (single-user personal OS); each bundle holds documents → chapters → concept terms. The index is per-bundle. The app has 3 top-level tabs (Overview / Jobs / Query) and the Query tab's 2 views (Graph / Table) + reader pane.

## Constitution Check

*GATE: must pass before implementation. Re-check after the plan's structure is fixed.*

Constitution: `/Specs/bos-system-specs/.specify/memory/constitution.md`.

| # | Principle | Compliance |
|---|---|---|
| I | **BOS source is read-only for marketplace features** — a marketplace item never edits `src/` | ✅ This is a pure **marketplace item**. The plan touches only `data/user-apps/items/okf-knowledge-base/` (app/ + services/ + agents/ + docs/ + config/). The four prior `bos-core` capabilities (clean `web_fetch`, `file_to_markdown`, `view_image`, `video_keyframes`) are **assumed-shipped dependencies**, not re-implemented — no `src/` file is in this plan's project structure. |
| II | **Storage in the VFS, owned by the service** | ✅ OKF bundles under `/KnowledgeBase/<bundle>/`, owned and read/written by the `okf-knowledge-base` service facet through its loopback VFS bridge (`/api/fs`, `/api/fs/raw`). Job records under the service's own state. Nothing in `src/` or the app's client storage holds user knowledge. |
| III | **Data is human-readable, non-lossy** | ✅ Source of truth is OKF `.md` (frontmatter + body). The derived index is also `.md` (frontmatter-carrying, regenerable) — not a binary/DB blob. Unknown frontmatter keys are preserved verbatim on every write (FR-021, NFR-003). `raw/` is immutable. No embeddings/vectors/SQL. |
| IV | **No hidden state; deterministic** | ✅ `okf_search` is deterministic (same query → same TOC rows, no LLM in the match — design.md §9). The derived index is **regenerable from source** (NFR-006) — never a second source of truth to drift. Job lifecycle is observable (FR-041/044), not fire-and-forget. |
| V | **Least privilege / scoped tools** | ✅ The 18-tool surface is the whole agent-facing API (FR-037). The `okf-ingest` sub-agent keep/narrow its least-privilege allowlist (FR-017, NFR-012). App views are an HTTP surface, not tools (NFR-008). Writes are path-guarded to the bundle root (FR-021). |
| VI | **Atomic, guarded writes** | ✅ All concept/index/toc writes go through `okf-core`'s existing atomic write + path-traversal guard (FR-021); the plan reuses, not reinvents, that mechanism. |
| VII | **Observable lifecycle** | ✅ Ingest runs are observable jobs (queued/running/completed/failed, FR-041/044, NFR-011) with a summary or error, exposed to the Jobs tab. |
| VIII | **Portable / spec-conformant** | ✅ Export is a spec-conformant OKF bundle (FR-024, SC-003); import accepts a bundle (and re-derives its index best-effort, design.md §7.4 / Risk #9). The item ships a `docs/` facet (required). |

**Verdict**: PASS — no violations. No Complexity Tracking rows required.

## Project Structure

### Documentation (this feature — the item's spec store)

```text
item-okf-knowledge-base/          # reached via app_spec_* (physically data/user-apps/items/okf-knowledge-base/spec/)
├── spec.md                        # source of truth (41 FR, 11 NFR, 10 SC, 9 user stories)
├── design.md                      # architecture + ADRs (authoritative; reviewed APPROVE-WITH-NITS)
├── mockup.html                    # binding UI contract (Overview / Jobs / Query)
├── plan.md                        # THIS file
└── tasks.md                       # next step (Phase 2)
```

### Source Code (the item — written by the Developer into a fresh staging dir, then installed by `app_build`)

The staging directory root **is the item root**. `app_build` carries these facets into `data/user-apps/items/okf-knowledge-base/`:

```text
okf-knowledge-base/                       # = staging dir root = item root
├── services/
│   ├── service.json                      # UNCHANGED in shape: id "okf-knowledge-base",
│   │                                     #   deploymentMode "tools", entry "index.js",
│   │                                     #   configSchema { bundleRoot "/KnowledgeBase", port 0 }
│   ├── index.js                          # worker entry: starts okf-core + http-bridge + tool IPC
│   ├── lib/
│   │   ├── okf-core.js                   # storage layer — EXTEND: derived-index build/regenerate,
│   │   │                                 #   okf_search (concept-anchored), okf_merge_concepts,
│   │   │                                 #   graph derivation, job records (jobs.json), inline-asset
│   │   │                                 #   registration. Reuse existing atomic-write + path-guard.
│   │   ├── vfs-bridge.js                 # UNCHANGED — loopback /api/fs + /api/fs/raw client
│   │   ├── http-bridge.js                # REST — ADD app-facing routes (design.md §8.3): bundles,
│   │   │                                 #   bundle detail, toc, chapter, search, graph, jobs; + job
│   │   │                                 #   lifecycle callback routes (sub-agent → service)
│   │   └── tools.js                      # DECLARATIONS — REDUCE 31 → 18 (design.md §8.2):
│   │                                     #   add okf_search/okf_read_toc/okf_merge_concepts;
│   │                                     #   rename okf_init_bundle→okf_create_bundle (or keep — decide);
│   │                                     #   remove the 13 net (16 by name); keep the 18 read/write
│   │                                     #   parallelSafe markings on the read-only subset
│   └── (no new external deps)
├── app/
│   └── (app facet — REPLACED by the standalone master-detail app from mockup.html:
│         Overview / Jobs / Query tabs, force-directed graph, shared search,
│         resizable reader pane; talks to the service over httpPath)
├── agents/
│   └── okf-ingest/AGENT.md               # bundled sub-agent — KEEP narrow allowlist (design.md §9.1);
│                                         #   add the job-callback obligation (mark running/completed)
├── skills/
│   └── okf-bundle-schema/SKILL.md        # KEEP — ingest/query/lint conventions for the sub-agent
├── config/
│   └── okf-knowledge-base.json           # defaults (bundleRoot, port) — UNCHANGED
└── docs/                                 # REQUIRED facet — describe the SHIPPED item
    ├── usage/OKF Knowledge Base/
    │   ├── overview.md                   # what it does, the three tabs, ingest/query workflows
    │   └── troubleshooting.md            # service not running, empty index, failed job
    └── dev/OKF Knowledge Base/
        ├── architecture.md               # service facet, VFS bridge, two-level index, graph derivation
        ├── tools.md                      # the 18 okf_* tools + I/O schemas
        └── data-model.md                 # bundle layout, frontmatter fields, derived-index .md
```

**Structure Decision**: **Marketplace item, all facets in one `app_build`.** No `src/` (bos-core) file appears — the four prior `bos-core` capabilities are dependencies assumed shipped (design.md ADR-005). The service facet is the one real backend (plain Node worker thread; its `services/` path is **not** a `src/` fragment, so it does not trip the `contentOnly` harness). The app facet is the standalone master-detail app from `mockup.html`. `docs/` is namespaced by the item's display name in **both** `usage/` and `dev/` (required — the Docs app reads only those two paths). The `id` is preserved (`okf-knowledge-base`) because this is an in-place redesign of an already-installed item.

### Optional companion artifacts — evaluated, decided

Per the plan command, `research.md` / `data-model.md` / `contracts/` are added **only when warranted**. Decisions:

- **`research.md`** — **not warranted as a separate file.** Every Phase-0 unknown was resolved during `design` (the architect read the installed item + mockup and made the calls: derived-index shape, search algorithm, job mechanism, graph derivation, app-over-HTTP). The resolutions live in `design.md` ADRs + §9. Stranding them in a second file would duplicate; if a later `clarify` re-opens an unknown, add it then.
- **`data-model.md`** — **folded into this plan + design.md, not a separate file.** The entities (KnowledgeBundle, Concept/chapter, Document, TOC, ConceptIndexEntry, IngestRun/Job, ReferenceCandidate, RawSource/Asset) are already fully specified in `spec.md` §Key Entities and `design.md` §5 (bundle layout) + §6 (concept frontmatter) + §7 (jobs). A third copy is not warranted; the item's `docs/dev/.../data-model.md` (above) is where the *shipped* data model is documented for users, distinct from this planning artifact.
- **`contracts/`** — **warranted, but the authoritative contract is the 18-tool I/O table in `design.md` §8.2 + the app REST routes in `design.md` §8.3.** Rather than duplicate into a `contracts/` folder, `tasks.md` pins those two tables as the contract and the e2e tests validate against them. (If the Developer wants a machine-checkable schema file, that's an `implement` decision inside `services/lib/` — not a planning artifact.)

## Design Notes (folded from `design.md` — so the analysis isn't stranded in chat)

- **ADRs** (design.md §11) are the authoritative decisions and are carried by reference, not restated: ADR-001 (no DB in v1; derived file index; escalation gated on *vocabulary* size), ADR-002 (index = OKF-native `.md`, regenerable, never sole source of truth), ADR-003 (deterministic `okf_search`, no LLM in the match, shared tool + app), ADR-004 (graph derived on-read from frontmatter/index/links, no graph DB), ADR-005 (pure marketplace item; 4 bos-core capabilities are dependencies), ADR-006 (job lifecycle via sub-agent → service loopback-HTTP callbacks + assistant safety-net), ADR-007 (app over HTTP, not the agent tools, because the app is an opaque-origin iframe), ADR-008 (inline assets interpreted at ingest, stored as link + blockquote, no re-vision at query), ADR-009 (31→18 tool surface; field-setters collapsed into `okf_upsert_concept`).
- **The 18 tools** (design.md §8.2, authoritative): Retrieval — `okf_search`, `okf_read_toc`, `okf_read_concept`, `okf_list_concepts`; Concepts — `okf_upsert_concept`, `okf_delete_concept`, `okf_merge_concepts`; Bundles — `okf_list_bundles`, `okf_init_bundle`, `okf_import_bundle`, `okf_export_bundle`, `okf_delete_bundle`; Ingest — `okf_ingest`, `okf_add_raw_source`; Organization — `okf_add_link`, `okf_backlinks`; Health — `okf_lint`, `okf_stale_report`. (15 kept + 3 added = 18 of the original 31 → 13 fewer net; 16 removed by name, per spec.md FR-037.)
- **Two-level index** (design.md §6): bundle `concept-index.md` (concept term → description → covering chapters, frontmatter-carrying) + per-doc `toc/<docId>.md` (TOC rows `concept › chapter — description`). Both regenerated from chapter frontmatter on write; staleness via `index_generated_at` vs chapter `updated_at`.
- **`okf_search`** (design.md §9): tokenize query → match concept terms (exact/substring, weighted) → gather covering chapters from the index → return TOC rows `{docId, docTitle, chId, chTitle, description, matchedConcept}`. **This is the single function both the `okf_search` tool and the app's `POST /search` route call** (FR-036).
- **Graph derivation** (design.md §8.3 `GET /graph`): nodes = documents + chapters + concept terms; edges = containment (chapter→doc, from `parent`), coverage (chapter→term, from the index), explicit links (from stored edges). Computed on read.
- **Inline-asset pipeline** (design.md §7.5): at ingest, extract non-HTML asset URLs → download to `raw/assets/<docId>/` via `/api/fs/raw` → `view_image`/`video_keyframes` → write `![…](raw/assets/…)` + `> **Interpretation:** …` into the chapter body. Stored interpretation → no re-vision at query (NFR-005, SC-006).
- **Job lifecycle** (design.md §8.3 + ADR-006): `okf_ingest` records a job (queued) → `agent_delegate` returns a `jobId` + the two callback URLs → the sub-agent's first tool call marks `running`, its final one marks `completed` (or the calling assistant's safety-net marks `failed` if the run errors before the sub-agent's final callback). Jobs are global, exposed at `GET /jobs` (FR-044, NFR-011).
- **App data access** (design.md §8.3): the app iframe talks to the service over `httpPath` (from `GET /api/services/okf-knowledge-base/config`) — **not** same-origin BOS routes (ADR-007). Routes: `GET /bundles`, `GET /bundles/:id`, `GET /bundles/:id/toc/:docId`, `GET /bundles/:id/concept/:chId`, `POST /bundles/:id/search`, `GET /bundles/:id/graph`, `GET /jobs`, `GET /jobs/:id`, plus the job-callback POSTs. All read-only for the app (writes stay agent/tool-driven), loopback-authed.
- **Upgrade path** (design.md §7.4 / Risk #9): pre-existing bundles may lack `parent`/`concepts`/`summary` frontmatter → `okf_import_bundle`/first-open does a **best-effort** index derivation (flat doc→chapter, no `parent`, empty/naive concepts) and the health tab reports "index needs regeneration"; a re-ingest or an `okf_upsert_concept` pass fills it. **Decision pinned here**: best-effort, non-destructive, reported — never silently drop or silently re-derive-overwrite.
- **App name for `docs/`**: `OKF Knowledge Base` (the display name the user sees) — used verbatim in `docs/usage/OKF Knowledge Base/` and `docs/dev/OKF Knowledge Base/`.

## Open items carried into `tasks.md`

1. **Tool rename**: `okf_init_bundle` (FR-025) vs `okf_create_bundle` (design.md §8.2) — pin one in the first task (recommend keeping the spec's `okf_init_bundle` name; the spec is the contract).
2. **`jobs.json` location** — bundle-level vs service-level: design.md says service state; confirm in the first service task (single-user, so service-level global is fine and matches FR-044's global Jobs tab).
3. **e2e feature-id** — the `buildstudio_run_tests` contract wants `e2e/<feature-id>.spec.ts`; pin the feature-id slug in the test task.
4. **App facet entry** — confirm `app/src/main.tsx` (bundled) is the right app shape for the mockup (the mockup is a self-contained HTML; the app facet is a TSX app that reproduces it — `app_build` bundles it).
