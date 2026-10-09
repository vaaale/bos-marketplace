# Tasks: OKF Knowledge Base — General-Purpose Agent KB Redesign

**Input**: `item-okf-knowledge-base/spec.md` (source of truth, 41 FR / 11 NFR / 10 SC / 9 user stories), `item-okf-knowledge-base/design.md` (architecture + ADRs), `item-okf-knowledge-base/plan.md` (structure + constitution check), `item-okf-knowledge-base/mockup.html` (binding UI contract).

**Prerequisites**: plan.md ✅, spec.md ✅, design.md ✅, mockup.html ✅. (No `research.md`/`data-model.md`/`contracts/` — decisions are in design.md ADRs; the 18-tool I/O table in design.md §8.2 and the REST routes in §8.3 are the authoritative contracts, pinned here.)

**Organization**: tasks grouped by user story. **Story numbers map to the `spec.md` "User Story N" headings.** Each story is independently testable. Tests ARE requested (spec "User Scenarios & Testing" is mandatory; plan commits to Playwright e2e).

**Path conventions** — all paths are relative to the **item staging directory root** (the Developer writes the item here, then `app_build` installs it into `data/user-apps/items/okf-knowledge-base/`). The service facet lives under `services/`, the app facet under `app/`, the bundled agent under `agents/`, docs under `docs/`, config under `config/`. `e2e/` is **inside the item staging dir** (the established convention for installed items — see the existing `okf-knowledge-base/e2e/okf-knowledge-base.spec.ts` and `follow-the-money/e2e/follow-the-money.spec.ts`), run against the branch preview via `BOS_PREVIEW_URL` + `npx playwright test`. The `buildstudio_run_tests` contract's `e2e/<feature-id>.spec.ts` refers to this item-local path.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: the `spec.md` User Story this serves (setup/foundational/polish have no label)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: establish the item structure + the two unchanged scaffolds (service entry, config) so the service/app/agent/docs facets have homes.

- [ ] T001 Create the item staging directory structure: `services/lib/`, `app/`, `agents/okf-ingest/`, `skills/okf-bundle-schema/`, `config/`, `docs/usage/OKF Knowledge Base/`, `docs/dev/OKF Knowledge Base/`
- [ ] T002 [P] Carry forward `services/service.json` unchanged in shape (`id: "okf-knowledge-base"`, `deploymentMode: "tools"`, `entry: "index.js"`, `configSchema { bundleRoot: "/KnowledgeBase", port: 0 }`) — confirm against the installed item before writing
- [ ] T003 [P] Carry forward `services/index.js` (worker entry: boot okf-core + http-bridge + 039 tool-declaration IPC) and `services/lib/vfs-bridge.js` (loopback `/api/fs` + `/api/fs/raw` client) unchanged — the redesign reuses them
- [ ] T004 [P] Carry forward `config/okf-knowledge-base.json` defaults (`bundleRoot`, `port`) unchanged

**Checkpoint**: item skeleton + unchanged scaffolds in place; the service can boot as a `deploymentMode:"tools"` worker exposing zero new tools yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the storage/index/retrieval core that every user story depends on. **No story work starts until this phase is complete.** These tasks are the heart of the redesign (ADR-001/002/003/009).

- [ ] T005 Extend `services/lib/okf-core.js` — the **derived-index layer**: (a) build/regenerate the bundle-level `concept-index.md` from chapter frontmatter (`concepts` field → term → description → covering chapters); (b) build/regenerate per-document `toc/<docId>.md` (TOC rows `concept › chapter — description` from `parent`/`concepts`/`summary`); (c) stamp `index_generated_at` and detect staleness against chapter `updated_at`. Reuse the existing atomic-write + path-traversal guard; unknown frontmatter keys preserved (FR-021, NFR-003/006).
- [ ] T006 Extend `services/lib/okf-core.js` — the **deterministic `okf_search` function** (design.md §9): tokenize query → match concept terms (exact/substring, weighted) → gather covering chapters from the concept index → return ranked TOC rows `{docId, docTitle, chId, chTitle, description, matchedConcept}`. **No LLM in the match.** This one function is shared by the `okf_search` tool and the app's `/search` route (FR-036). (Depends on T005)
- [ ] T007 Extend `services/lib/okf-core.js` — **job records** (`jobs.json` at the service state dir, global): create/get/list a job with lifecycle `queued → running → completed | failed` and a summary-or-error field; append-only, loopback-authed read (FR-044, NFR-011).
- [ ] T008 Extend `services/lib/tools.js` — **reduce the 31-tool `DECLARATIONS` array to the 18 tools** (design.md §8.2, authoritative): add `okf_search`, `okf_read_toc`, `okf_merge_concepts`; keep the 15 (Retrieval `okf_read_concept`/`okf_list_concepts`; Concepts `okf_upsert_concept`/`okf_delete_concept`; Bundles `okf_list_bundles`/`okf_init_bundle`/`okf_import_bundle`/`okf_export_bundle`/`okf_delete_bundle`; Ingest `okf_ingest`/`okf_add_raw_source`; Organization `okf_add_link`/`okf_backlinks`; Health `okf_lint`/`okf_stale_report`); **remove the other 13** (16 by name per FR-037 — the field-setters `okf_set_status`/`okf_set_trust`/`okf_add_source`/`okf_attest`/`okf_provenance`/`okf_get_as_of` collapse into `okf_upsert_concept`'s frontmatter merge; drop `okf_bundle_status`/`okf_find_concepts`/`okf_read_index`/`okf_read_bundle_schema`/`okf_append_log`/`okf_remove_link`/`okf_list_links`/`okf_neighbors`/`okf_shortest_path`/`okf_export_graph`). Fold the removed field-setters into `okf_upsert_concept` (merge-on-fields). Keep `parallelSafe` on the read-only subset. Preserve the 039 schema-validation + gating contract (FR-011–017, NFR-008/014/015). **Pin the name `okf_init_bundle` (the spec's name) — not `okf_create_bundle`.** (Depends on T005, T006)
- [ ] T009 Extend `services/lib/http-bridge.js` — **app-facing REST routes** (design.md §8.3, authoritative), loopback-authed, all read-only for the app: `GET /bundles` (list, FR-041), `GET /bundles/:id` (detail + health + concept index + document list), `GET /bundles/:id/toc/:docId`, `GET /bundles/:id/concept/:chId` (full chapter), `POST /bundles/:id/search` (calls the T006 function, FR-043), `GET /bundles/:id/graph` (nodes + directed labeled edges from `parent`/index/stored links, FR-045), `GET /jobs` (list), `GET /jobs/:id` (detail, FR-044). **Plus** the job-callback routes the sub-agent POSTs to (`POST /jobs/:id/start`, `POST /jobs/:id/complete`, `POST /jobs/:id/fail` — ADR-006). (Depends on T006, T007)

**Checkpoint**: foundation ready — the service builds/derives the two-level index, serves deterministic search, tracks jobs, exposes 18 tools and the app REST surface. User stories can now proceed.

---

## Phase 3: User Story 1 — Create a KB and add concepts (Priority: P1) 🎯 MVP

**Goal**: a bundle exists, concepts (chapters) are added, and the derived index + graph reflect them.
**Independent Test**: `okf_init_bundle("X")` → `okf_upsert_concept` a few chapters with `concepts`/`parent`/`summary` → verify `okf_list_concepts` lists them, `concept-index.md`/`toc/*.md` regenerated, and a search on a term returns the covering chapter.

### Tests for User Story 1 ⚠️ (write first, confirm FAIL)
- [ ] T010 [P] [US1] Playwright e2e in `e2e/okf-knowledge-base.spec.ts` (item-local e2e dir, feature-id = item id `okf-knowledge-base`): US1 acceptance — init bundle, upsert 3 concepts, assert `okf_list_concepts` + index files exist + a term search returns the covering chapter (spec US1 scenarios 1–3).

### Implementation for User Story 1
- [ ] T011 [US1] Wire the `okf_init_bundle`, `okf_upsert_concept`, `okf_read_concept`, `okf_list_concepts` tool handlers in `services/lib/tools.js` to `okf-core.js` (concept CRUD already present — verify + ensure `okf_upsert_concept` triggers the T005 index regeneration after write). (Depends on T005, T008)
- [ ] T012 [US1] Ensure bundle layout on init is spec-conformant: `index.md`, `log.md`, `concepts/`, `raw/`, `raw/assets/`, `toc/`, `concept-index.md` (FR-025 — reconcile the layout wording with what T005 actually writes; pin the real set). (Depends on T005)

**Checkpoint**: US1 fully functional + independently testable (MVP).

---

## Phase 4: User Story 2 — Ingest a URL without retyping the source (Priority: P1)

**Goal**: `okf_ingest` dispatches to the `okf-ingest` sub-agent; the source never re-enters the calling context; the run is an observable job.
**Independent Test**: `okf_ingest({bundle, url})` → returns `jobId` + callback URLs + the `agent_delegate` guidance → sub-agent reads `raw/`, writes chapters → job reaches `completed` with a summary.

### Tests for User Story 2 ⚠️
- [ ] T013 [P] [US2] Playwright e2e in `e2e/okf-kb-redesign.spec.ts`: US2 acceptance — ingest a URL, assert the raw source is registered, the job lifecycle reaches `completed` (or `failed` on the error path), a summary is recorded, and the full source did NOT appear as calling-context output (spec US2, SC-007, FR-044).

### Implementation for User Story 2
- [ ] T014 [US2] Make `okf_ingest` a **dispatcher** in `services/lib/tools.js`: validate the raw source is registered (or guide `okf_add_raw_source` first), record a job (`queued`, T007), return `{jobId, callbackUrls, delegate:{agent:"okf-ingest", task}}` — the task names the `raw/` path to read. (Depends on T007, T008)
- [ ] T015 [US2] Update `agents/okf-ingest/AGENT.md`: **keep the narrow least-privilege allowlist** (design.md §9.1 — raw read, `okf_upsert_concept`/`okf_add_link`/`okf_backlinks`, `okf_read_toc`/`okf_read_concept`/`okf_list_concepts` for dedup, `web_search`/`web_fetch`/`file_to_markdown` for references, `okf_add_raw_source`), and **add the job-callback obligation** (POST `start` on first action, `complete`/`fail` on finish — ADR-006). (Depends on T014)
- [ ] T016 [US2] Verify `okf_add_raw_source` (`{bundle, filename, content?, sourcePath?, conceptId?, title?}`) accepts a staged `sourcePath` so large content never rides an inline arg (FR-029, NFR-009 — `raw/` immutable/append-only). (Depends on T005)
- [ ] T017 [US2] Wire the **assistant safety-net**: the calling assistant's `agent_delegate` error/empty path marks the job `failed` if the sub-agent never posted `complete` (ADR-006). Document this in `agents/okf-ingest/AGENT.md` + `docs/dev/OKF Knowledge Base/architecture.md`. (Depends on T014, T015)

**Checkpoint**: US2 functional — ingest is observable and keeps the source out of the calling context.

---

## Phase 5: User Story 3 — Ingest documents, images, video (Priority: P1)

**Goal**: local PDF/DOCX/PPTX/XLSX, images, and video ingest into chapters, with **inline non-HTML assets downloaded + vision-interpreted + stored as link + interpretation** (ADR-008).
**Independent Test**: ingest a multi-section PDF → each section becomes a linked chapter; ingest an image-bearing doc → the chapter contains `![](raw/assets/…)` + a `> **Interpretation:** …` blockquote; query the chapter → the interpretation is returned as text (no re-vision).

### Tests for User Story 3 ⚠️
- [ ] T018 [P] [US3] Playwright e2e in `e2e/okf-kb-redesign.spec.ts`: US3 acceptance — `file_to_markdown` converts a staged doc; an inline image is downloaded to `raw/assets/<docId>/` and the chapter carries the link + interpretation blockquote; `okf_read_concept` returns the stored interpretation (no re-run of vision) (spec US3, FR-029–032, SC-006).

### Implementation for User Story 3
- [ ] T019 [US3] Extend the `okf-ingest` sub-agent flow (`agents/okf-ingest/AGENT.md` + `skills/okf-bundle-schema/SKILL.md` conventions) with the **inline-asset pipeline** (design.md §7.5): extract non-HTML asset URLs from the source → download each to `raw/assets/<docId>/` via the `/api/fs/raw` bridge → `view_image` (images) / `video_keyframes` (video) → write `![title](raw/assets/<docId>/file)` + `> **Interpretation:** …` into the chapter body. HTML links stay as remote references. (Depends on T015)
- [ ] T020 [US3] Confirm the `view_image` and `video_keyframes` tools are in the sub-agent's allowlist (they are bos-core dependencies assumed shipped — design.md ADR-005; if absent at implement time, flag as a dependency gap, do NOT implement them here). (Depends on T019)

**Checkpoint**: US3 functional — multi-format ingest with stored inline-asset interpretations.

---

## Phase 6: User Story 4 — Agent queries/traverses the KB (Priority: P1)

**Goal**: the agent retrieves via the deterministic, concept-anchored, chapter-granular tools.
**Independent Test**: `okf_search({bundle, query})` returns TOC rows; `okf_read_toc`/`okf_read_concept` return the **full** document/chapter (never a snippet); `okf_backlinks`/`okf_add_link` for traversal/linking.

### Tests for User Story 4 ⚠️
- [ ] T021 [P] [US4] Playwright e2e in `e2e/okf-kb-redesign.spec.ts`: US4 acceptance — `okf_search` is deterministic (same query → same rows), returns full chapters (not chunks), and the app `POST /search` route returns **identical** rows to the tool (spec US4, FR-008–010, FR-036, NFR-004/005, SC-001/002/005).

### Implementation for User Story 4
- [ ] T022 [US4] Wire the Retrieval tools in `services/lib/tools.js` → `okf-core.js`: `okf_search` (T006), `okf_read_toc` (return the per-doc `toc/*.md` or its rows), `okf_read_concept` (full chapter markdown incl. inline-asset blocks), `okf_list_concepts` (with `conceptIndex`/`toc` derived fields per design.md §8.2), `okf_backlinks`, `okf_add_link`. Confirm read paths never truncate to a snippet. (Depends on T006, T008)

**Checkpoint**: US4 functional — deterministic, chapter-granular agent retrieval.

---

## Phase 7: User Story 5 — Delete a bundle or concept (Priority: P1)

**Goal**: delete is available to the agent (tools) and non-destructive by default.
**Independent Test**: `okf_delete_concept` leaves the bundle intact (optionally rewriting backlinks); `okf_delete_bundle` removes only that bundle; deleting a missing target → clear "not found."

### Tests for User Story 5 ⚠️
- [ ] T023 [P] [US5] Playwright e2e in `e2e/okf-kb-redesign.spec.ts`: US5 acceptance — delete a concept (bundle intact, `rewrite_backlinks` honored), delete a bundle (only that dir removed), delete a missing target (graceful "not found"), and confirm the derived index regenerates after each (spec US5, FR-018, NFR-006/007).

### Implementation for User Story 5
- [ ] T024 [US5] Wire `okf_delete_concept` (non-destructive default + `rewrite_backlinks` option, FR-018) and `okf_delete_bundle` (FR-028) in `services/lib/tools.js` → `okf-core.js`; ensure each triggers the T005 index regeneration and a path-guarded remove (only within the bundle root). (Depends on T005, T008)

**Checkpoint**: US5 functional — agent-driven, non-destructive-by-default delete.

---

## Phase 8: User Story 6 — Manage & distribute bundles (import/export/health) + the app Overview (Priority: P2)

**Goal**: bundles can be imported/exported and their health viewed; the app's **Overview** tab (bundle list → detail → concept index / documents / health) is the UI for this.
**Independent Test**: export a bundle → re-import it → concepts queryable and the export is spec-conformant; pre-existing bundle (no `parent`/`concepts`/`summary`) imports with a **best-effort** derived index reported as "needs regeneration" (design.md Risk #9); the app Overview renders list + detail + concept index + documents + health.

### Tests for User Story 6 ⚠️
- [ ] T025 [P] [US6] Playwright e2e in `e2e/okf-kb-redesign.spec.ts`: US6 acceptance — export→import round-trips with concepts/links/frontmatter intact (SC-003); a pre-existing bundle imports with best-effort index (non-destructive, reported) — spec US6, FR-024/026, design.md §7.4.

### Implementation for User Story 6
- [ ] T026 [US6] Wire `okf_import_bundle` (spec-conformant dir/git/tarball → `/KnowledgeBase/`, then **best-effort** index derivation: flat doc→chapter, no `parent`, naive/empty concepts; health reports "index needs regeneration"; a re-ingest or `okf_upsert_concept` pass completes it) and `okf_export_bundle` (spec-conformant) in `services/lib/tools.js` → `okf-core.js` (FR-024, FR-026). (Depends on T005)
- [ ] T027 [US6] Implement the app **Overview** tab from `mockup.html`: bundle list (search/filter, new/import/export actions) → bundle detail (health stat cards + Concept Index / Documents / Health / Import·Export tabs) → concept index → document → stored TOC → full chapter (inline-asset blocks + "View source (.md)"). Data from `GET /bundles`, `GET /bundles/:id`, `GET /bundles/:id/toc/:docId`, `GET /bundles/:id/concept/:chId` (T009). (Depends on T009)
- [ ] T028 [US6] Wire the app's export/import buttons to the service (POST routes added to T009 if not already present) and the health tab to the bundle-detail response. (Depends on T027)

**Checkpoint**: US6 functional — distribution + the Overview UI.

---

## Phase 9: User Story 7 — Bundled agent/skill updates don't clobber edits (Priority: P2)

**Goal**: the `okf-ingest` agent + `okf-bundle-schema` skill are **copied** on install with content-hash provenance; updates replace silently when untouched, prompt keep-vs-replace when diverged.
**Independent Test**: install → edit the installed agent → update the item → a keep-vs-replace prompt appears (not a silent overwrite); reinstall unchanged → no prompt.

### Tests for User Story 7 ⚠️
- [ ] T029 [P] [US7] Playwright e2e in `e2e/okf-kb-redesign.spec.ts`: US7 acceptance — copy-install + provenance (`installedFrom {itemId, version, contentHash}` covering the whole asset dir); untouched → silent replace; diverged/unknown → prompt, never silent overwrite (spec US7, FR-030–034, NFR-016).

### Implementation for User Story 7
- [ ] T030 [US7] Confirm the item **declares** `agents/okf-ingest/AGENT.md` and `skills/okf-bundle-schema/SKILL.md` in its directory so the BOS install pipeline (copy-on-install + provenance, a **bos-core dependency assumed shipped** — design.md ADR-005) picks them up. Do NOT implement the install mechanism here; verify the item's layout is what that mechanism consumes, and flag a dependency gap if the shipped mechanism isn't present. (Depends on T015)

**Checkpoint**: US7 functional — safe bundled-asset lifecycle (assuming the shipped bos-core copy-install dependency).

---

## Phase 10: User Story 8 — Provenance, trust, lifecycle (Priority: P3)

**Goal**: provenance/trust/lifecycle are managed **through frontmatter on `okf_upsert_concept`** (the collapsed field-setters) and surfaced by `okf_stale_report`/`okf_lint`.
**Independent Test**: set `trust: human-reviewed` / `status: deprecated` + `stale_after` on a concept via `okf_upsert_concept`; `okf_stale_report` surfaces it; `okf_lint` reports it.

### Tests for User Story 8 ⚠️
- [ ] T031 [P] [US8] Playwright e2e in `e2e/okf-kb-redesign.spec.ts`: US8 acceptance — frontmatter field-set via `okf_upsert_concept` round-trips with unknown keys preserved; `okf_stale_report` returns a past-`stale_after` concept; `okf_lint` surfaces it (spec US8, FR-022, FR-018, NFR-003).

### Implementation for User Story 8
- [ ] T032 [US8] Ensure `okf_upsert_concept` in `services/lib/tools.js` accepts and merges the provenance/trust/lifecycle frontmatter (`sources`, `trust`/`verified`, `status`/`stale_after`, actors) — merge-on-fields, never dropping unknown keys (FR-021) — and that `okf_stale_report`/`okf_lint` read these fields. (Depends on T005, T008)

**Checkpoint**: US8 functional — provenance/trust/lifecycle as first-class frontmatter operations.

---

## Phase 11: User Story 9 — The app's Query tab (shared search + Graph/Table + resizable reader pane) (Priority: P1)

**Goal**: the app **Query** tab is a single unified view — a shared search field on top, a Graph/Table toggle below, both reflecting the same concept-anchored search; the Graph is a force-directed, category-colored, edge-labeled knowledge graph; selecting a node/row opens the full chapter in a mouse-resizable pane with an "Open source" link.
**Independent Test**: type a query → the Table filters rows AND the Graph highlights matching nodes (rest dimmed); click a chapter → the resizable pane renders the full chapter + "Open source" (original URL else `raw/` path); the graph fills its pane (viewBox from real dimensions).

### Tests for User Story 9 ⚠️
- [ ] T033 [P] [US9] Playwright e2e in `e2e/okf-kb-redesign.spec.ts`: US9 acceptance — shared search reflects in both views (Table filter + Graph highlight/dim); graph is force-directed with category colors + labeled directed edges + fills the pane; node/row click opens the full chapter in the resizable reader pane; "Open source" targets the original URL else `raw/` path (spec US9, FR-036–040, FR-041–045, NFR-004, SC-004/010/011/012).

### Implementation for User Story 9
- [ ] T034 [US9] Implement the app **Query** tab from `mockup.html`: shared search field (top) + **Graph/Table** toggle; **Table** = the node list (type dot, name, description, rows from `GET /bundles/:id` + concept index) filtered by search; **Graph** = force-directed SVG of category-colored circular nodes (document/chapter/concept-term) with **labeled directed edges** (contains / covers / related) from `GET /bundles/:id/graph`, viewBox from the real container dimensions (fills the pane, re-lays-out on show + divider drag); search reflects in both (Table filter, Graph highlight + dim). (Depends on T009)
- [ ] T035 [US9] Implement the **mouse-resizable reader pane** + **Jobs** tab: the pane renders the selected document (TOC) / chapter (full, inline-asset blocks) / concept-term (covering chapters) with the "Open source" link at top (original URL else `raw/` path); the **Jobs** tab lists `GET /jobs` (queued/running/completed/failed dots, bundle, source, elapsed/duration) with expandable `GET /jobs/:id` detail (summary cells, written-chapter chips, error card, live progress). (Depends on T009)
- [ ] T036 [US9] Wire the app shell (titlebar + Overview/Jobs/Query tab bar with a live Jobs badge) so the three tabs (T027, T034, T035) share one app facet, and confirm the app reaches the service **over `httpPath`** (opaque-origin iframe, ADR-007) — not same-origin BOS routes. (Depends on T027, T034, T035)

**Checkpoint**: US9 functional — the full app UI (Overview + Jobs + Query) is live against the service.

---

## Phase 12: Polish & Cross-Cutting Concerns

**Purpose**: docs facet, upgrade path, consistency, final validation.

- [ ] T037 [P] Write the item's **`docs/usage/OKF Knowledge Base/`**: `overview.md` (what it does, the three tabs, ingest/query workflows) and `troubleshooting.md` (service not running, empty index, a failed job).
- [ ] T038 [P] Write the item's **`docs/dev/OKF Knowledge Base/`**: `architecture.md` (service facet, VFS bridge, two-level derived index, graph derivation, job mechanism), `tools.md` (the 18 `okf_*` tools + I/O schemas, mirroring design.md §8.2), `data-model.md` (bundle layout + frontmatter fields + the two `.md` index artifacts, mirroring design.md §5–6).
- [ ] T039 Verify the **upgrade path** for an already-installed item: the `id` is preserved, the 31→18 tool reduction takes effect on `app_build`, pre-existing bundles are handled by T026's best-effort index (no data loss), and the bundled agent/skill provenance (T030) resolves correctly on update (design.md §7.4, Risk #9).
- [ ] T040 **Consistency sweep**: confirm spec.md / design.md / plan.md / mockup.html / tasks.md agree on (a) the 18-tool set, (b) the two-level index `.md` artifacts, (c) the app REST route set, (d) the "Open source" target rule, (e) the `okf_init_bundle` name. Record any drift in the item's `spec.md` (it's the contract).
- [ ] T041 Run the full Playwright suite (`buildstudio_run_tests` against feature `okf-kb-redesign`) and confirm all US acceptance scenarios + SC-001–012 pass; capture `test-results.md`.

---

## Dependencies & Execution Order

### Phase Dependencies
- **Setup (1)** → **Foundational (2)** → **User Stories (3–11)** → **Polish (12)**.
- Foundational (T005–T009) **blocks** every user story.

### User Story Dependencies (after Foundational)
- **US1 (P1)**: depends on Foundational only — this is the MVP.
- **US2 (P1)**: depends on Foundational + US1's concept tools (ingest writes concepts).
- **US3 (P1)**: depends on US2 (the ingest pipeline is what carries the inline-asset steps).
- **US4 (P1)**: depends on Foundational (search/index) — independent of US1–3 in code, but logically after US1 has data to query.
- **US5 (P1)**: depends on Foundational (delete touches the index).
- **US6 (P2)**: depends on Foundational + US1 (import derives the index; export reads it); the Overview UI depends on T009.
- **US7 (P2)**: depends on US2 (the bundled agent being updated IS the one US2 configures).
- **US8 (P3)**: depends on Foundational (frontmatter + the collapsed field-setter).
- **US9 (P1)**: depends on Foundational (all its data comes from T009 routes); the app shell (T036) depends on US6's Overview (T027).
- **Polish (12)**: after all stories.

### Within each story
Tests (write + confirm FAIL) → core `okf-core.js` change → tool handler in `tools.js` → (for UI stories) the app facet from `mockup.html` → integration.

### Parallel opportunities
- Phase 1: T002, T003, T004 are `[P]`.
- Phase 2: T005/T006/T007 are largely sequential in `okf-core.js` (same file — do NOT parallelize); T009 (http-bridge) can start once T006/T007 exist.
- Across stories: once Foundational is done, US4/US5/US8 (separate `tools.js` handlers, distinct files from each other) can proceed in parallel by different tasks; US2→US3 is a chain; US6/US9 (app facet) can run in parallel with the service-side stories.
- Per-story test tasks are `[P]` and can all be written together before implementation (TDD).

---

## Implementation Strategy

### MVP first (User Story 1)
1. Phase 1 (Setup) → 2. Phase 2 (Foundational — the index + search core) → 3. Phase 3 (US1) → **STOP & VALIDATE**: a bundle with concepts that search returns. That alone proves the redesign's core (two-level derived index + deterministic chapter-granular retrieval).

### Incremental delivery
4. US2/US3 (ingest + inline assets) → validate. 5. US4/US5 (query/delete) → validate. 6. US6 (import/export/health + Overview UI) → validate. 7. US7/US8 (bundled-asset lifecycle, provenance) → validate. 8. US9 (Jobs + Query UI) → validate. 9. Phase 12 polish + full e2e.

### Notes
- **[P]** = different files, no dependency on an incomplete task. Tasks in the same `okf-core.js`/`tools.js`/`http-bridge.js` are NOT parallelizable with each other.
- Story numbers map to `spec.md` User Story headings; the canonical numbering/wording lives there.
- The four prior `bos-core` capabilities (clean `web_fetch`, `file_to_markdown`, `view_image`, `video_keyframes`) and the copy-install/provenance mechanism are **assumed-shipped dependencies** (design.md ADR-005) — if any is absent at implement time, flag it as a dependency gap; do NOT implement it inside this item.
- `e2e/okf-kb-redesign.spec.ts` is the single e2e file (feature-id `okf-kb-redesign`) that `buildstudio_run_tests` runs; each US's test task adds its cases to it.
