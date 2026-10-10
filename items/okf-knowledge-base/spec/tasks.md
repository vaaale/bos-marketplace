# Tasks: OKF Knowledge Base — general-purpose agent KB (redesign + automatic ingestion)

**Input**: `item-okf-knowledge-base/spec.md` (source of truth — 49 FR / 11 NFR / 13 SC / 9 user stories), `item-okf-knowledge-base/design.md` (architecture + ADRs), `item-okf-knowledge-base/tool-surface.md` (the 19 tools + auto-trigger mechanism), `item-okf-knowledge-base/plan.md` (structure + constitution check), `item-okf-knowledge-base/mockup.html` (binding UI contract).

**Supersedes**: the prior 2026-10-09 tasks (branch `bos/okf-kb-redesign`), which were written against an earlier story decomposition and the pre-auto-ingest design. This rewrite is organized by the **spec's nine user-value stories** and includes the **automatic-ingestion scope-add** (worker-side auto-trigger, `okf_list_jobs`, the self-sufficient agent, the app's `POST /jobs`).

**Prerequisites**: spec.md ✅, design.md ✅ (reviewed — one revision round applied), plan.md ✅, mockup.html ✅, tool-surface.md ✅. (No `research.md`/`data-model.md`/`contracts/` — the mechanisms are in design ADRs; the **19-tool I/O table in design §8.2** and the **app REST routes in design §8.3** are the authoritative contracts, pinned here.)

**Path conventions** — all paths are relative to the **item staging directory root** (the Developer writes the item here, then `app_build` installs it into `data/user-apps/items/okf-knowledge-base/`). Service facet under `services/`, app under `app/`, bundled agent under `agents/`, skill under `skills/`, config under `config/`, docs under `docs/`. `e2e/okf-knowledge-base.spec.ts` is **inside the item staging dir** (feature-id = item id `okf-knowledge-base`), run against the branch preview via `BOS_PREVIEW_URL` + `npx playwright test` (the established convention for installed items — see `follow-the-money/e2e/follow-the-money.spec.ts`).

**Format**: `[ID] [P?] [Story] Description`. **[P]** = parallelizable (different files, no dependency on an incomplete task). **Story** = the `spec.md` "User Story N" heading. Within each story: **tests first (write, confirm they fail), then implementation.** Tasks in the same `okf-core.js` / `tools.js` / `http-bridge.js` file are **not** parallel with each other.

---

## Phase 1 — Setup (shared scaffolds)

**Purpose**: establish the item structure + carry forward the unchanged worker scaffolds so the service/app/agent/docs facets have homes.

- [ ] T001 Create the item staging structure: `services/lib/`, `app/src/` (with `app/src/{overview,jobs,query,lib}/`), `agents/okf-ingest/`, `skills/okf-bundle-schema/`, `config/`, `docs/usage/OKF Knowledge Base/`, `docs/dev/OKF Knowledge Base/`.
- [ ] T002 [P] Carry forward `services/service.json` (`id:"okf-knowledge-base"`, `deploymentMode:"tools"`, `entry:"index.js"`, `toolGroups:["Knowledge Base"]`, `configSchema {bundleRoot:"/KnowledgeBase", port:0, maxDepth:1, maxWorkers:3, staleJobMs:1800000}` — **add `staleJobMs`**, ADR-006). Confirm against the installed item before writing.
- [ ] T003 [P] Carry forward `services/index.js` (worker entry: bind HTTP first, `initialized`/`bound`/`tool_declare` handshake, boot `okf-core` + `http-bridge`, `tool_call` dispatch, `mkdir(bundleRoot)`) and `services/lib/http-bridge.js`'s loopback trust guard (`isTrustedPeer` + `sendJson`) unchanged.
- [ ] T004 [P] Carry forward `config/okf-knowledge-base.json` defaults (`bundleRoot`, `port:0`, `maxDepth:1`, `maxWorkers:3`) and **add `staleJobMs:1800000`**.

**Checkpoint**: skeleton in place; unchanged scaffolds confirmed against the installed item.

---

## Phase 2 — Foundational (blocks every story)

**Purpose**: the storage/index/retrieval core, the **auto-trigger mechanism**, and the 19-tool + app-REST surfaces. No story work starts until this is complete. (design ADR-001/002/003/004/005/006/007/008/009.)

- [ ] T005 `services/lib/okf-core.js` — **derived-index layer**: (a) build/regenerate the bundle-level `concept-index.md` (frontmatter `term → [(docId, chId, one-line description, status, stale)]`, human body) from chapter frontmatter (`concepts`/`summary`/`status`/`parent`/title); (b) build/regenerate per-doc `toc/<docId>.md` (frontmatter `chapters:[{id,title,summary,concepts,status}]`); (c) a read-through cache with a dirty flag (a write bumps it; a stale/absent read rebuilds once) and `rebuildIndex`/`rebuildToc` for drift repair; both `.md` are rewritten on the chapter write path so export/import carries a fresh index (FR-007/008/009/010/011, NFR-001/004/011). Reuse existing atomic-write + path-traversal guard; unknown frontmatter keys preserved (NFR-005).
- [ ] T006 `services/lib/okf-core.js` — **`core.search()`**: the deterministic, concept-anchored match per design §6.1 (tokenize; term-name hits outrank description hits; gather covering chapters from the index; dedup chapters to one row; rank term-hit > desc-hit > token-count > deterministic tiebreak; default limit 25; empty on no match). **No LLM in the match.** This single function is shared by the `okf_search` tool and the app `GET /search` route (FR-001/002/036/043). (Depends on T005)
- [ ] T007 `services/lib/okf-core.js` — **graph derivation `core.graph()`** (ADR-004, design §6.3): nodes `{type:doc|chap|concept, id, label, count?}`, edges `{from,to,kind:containment|coverage|link}` computed on read from `parent` frontmatter, the concept index, and `links.json`/`extractLinks` (FR-042/045). (Depends on T005)
- [ ] T008 `services/lib/okf-core.js` — **bundle health** `core.bundleDetail`/`listBundles` (docs/chapters/conceptTerms counts + stale/deprecated, FR-027/US7), **`core.mergeConcepts(from,to)`** (rewrite the concept index, every affected `toc/*.md`, and every chapter `concepts` array that referenced either term → single canonical entry, FR-026/US6/SC-008), and **`core.lint`/`core.staleReport`** (broken inline-asset links, orphan chapters, index/TOC/`links.json` drift; concepts past `stale_after`, FR-033/034). (Depends on T005)
- [ ] T009 `services/lib/vfs-bridge.js` — **binary raw-asset I/O**: `writeBinary` via streaming `PUT /api/fs/raw?path=` (write-temp-then-rename; do NOT buffer a large file in a JSON body — design §10 risk 1) and `readRaw` via `GET /api/fs/raw?path=`; wire `okf-core`'s raw-asset store to use them (FR-020). (Depends on T003)
- [ ] T010 `services/lib/okf-core.js` — **job store**: `createJob`/`getJob`/`listJobs`/`updateJob` under `bundleRoot/.jobs/` (service-level, single-user; in-memory hot map + persisted file so Jobs survive a restart). Record shape per design §8.3 (`id`, `status` queued|running|completed|failed, `bundleId`, `source`, `startedAt`, `endedAt`, `durationMs`, `progress`, `summary`, `error`). **Exclude `.jobs/` from `okf_export_bundle`.** (Depends on T005)
- [ ] T011 `services/lib/okf-core.js` — **`core.triggerIngest({bundle, source, maxDepth?, maxWorkers?})`** — the **single** auto-trigger path (design ADR-005/006, FR-046/047): (a) dedup against `raw/sources.json` (a hit returns the existing `docId`, no run — FR-018); (b) `createJob(queued)`; (c) open the headless run via the `delegate-bridge` (T012) with a `task` embedding `jobId`/`bundle`/`source` and the per-source acquisition first-steps (pin `output_path`); (d) consume the NDJSON: advance `progress` from `{type:"tool"}` lines, and on the terminal line derive state from `result.endedReason` — `completed` → `updateJob(completed, summary from result.output)`; `error`/`max_steps` → `updateJob(failed, result.error)`; a thrown `{type:"error"}` line → `failed`; (e) return `{jobId, status:"queued"}` immediately. (Depends on T010, T012)
- [ ] T012 `services/lib/delegate-bridge.js` — **NEW: the worker's client for `POST /api/subagents/delegate`** (design ADR-005). Opens the loopback request (same base `vfs-bridge` already resolves for `/api/fs`; loopback transport is the trust boundary — no per-request auth, verified against `src/app/api/fs/route.ts` and `src/app/api/subagents/delegate/route.ts`), with `{task, agent:"okf-ingest"}`; consumes the **NDJSON** stream (`content-type: application/x-ndjson`) and reports back: progress from `{type:"tool"}` lines (tool name + index, so the worker can count `okf_upsert_concept` = chapters written), and the terminal `{type:"done"}` (with `result.{output, endedReason}`) / `{type:"error"}`. Fire-and-await is async so `okf_ingest` returns without holding the caller.
- [ ] T013 `services/lib/tools.js` — **rework `DECLARATIONS` to exactly the 19 tools** (design §8.2, authoritative): add `okf_search`, `okf_read_toc`, `okf_merge_concepts`, **`okf_list_jobs`** (readOnly/parallelSafe → `core.listJobs`, same records as the Jobs tab, FR-048); keep the 15 (Retrieval `okf_read_concept`/`okf_list_concepts`; Concepts `okf_upsert_concept`/`okf_delete_concept`; Bundles `okf_list_bundles`/`okf_init_bundle`/`okf_import_bundle`/`okf_export_bundle`/`okf_delete_bundle`; Ingest `okf_add_raw_source`; Organization `okf_add_link`/`okf_backlinks`; Health `okf_lint`/`okf_stale_report`); **remove the 12 net / 16 by name** (fold the field-setters `okf_set_status`/`okf_set_trust`/`okf_add_source`/`okf_attest`/`okf_provenance`/`okf_get_as_of` into `okf_upsert_concept`'s frontmatter merge; drop `okf_bundle_status`/`okf_find_concepts`/`okf_read_index`/`okf_read_bundle_schema`/`okf_append_log`/`okf_remove_link`/`okf_list_links`/`okf_neighbors`/`okf_shortest_path`/`okf_export_graph`). **Rework the `okf_ingest` handler to `core.triggerIngest`** (auto-trigger; return `{jobId, status:"queued"}` — NO `acquisition_required`/`delegation_required` block, ADR-005). Keep `parallelSafe` on the read-only subset; preserve the 039 schema-validation + gating contract (FR-037/038, NFR-008). **Pin the name `okf_init_bundle`.** (Depends on T006, T008, T010, T011)
- [ ] T014 `services/index.js` — **job stale reaper** (ADR-006/FR-049): a worker timer, plus a sweep on (re)start, that marks any job still `queued`/`running` older than `staleJobMs` (from config) as `failed (stale)` via `core.updateJob`. Covers a worker killed mid-run. (Depends on T010, T004)
- [ ] T015 `services/lib/http-bridge.js` — **app-facing REST surface** (design §8.3, authoritative), loopback-guarded, reusing the same `core` functions as the tools: `GET /config`; `GET /bundles`; `POST /bundles`; `GET /bundles/<b>` (detail + health + concept index + documents); `GET /bundles/<b>/toc/<docId>`; `GET /bundles/<b>/concept/<id>` (full chapter); `GET /bundles/<b>/search?query=&limit=` (**identical** to `okf_search`); `GET /bundles/<b>/graph`; `GET /bundles/<b>/assets/<p>` (binary via `readRaw`); `GET /bundles/<b>/lint`; `GET /bundles/<b>/stale`; `POST /bundles/<b>/import`; `GET /bundles/<b>/export`; `DELETE /bundles/<b>`; `POST /bundles/<b>/merge`; **`GET /tools`** (the REAL declared tool list → the app's titlebar badge and the e2e SC-007 assertion read this, not a hardcoded literal); **`POST /jobs`** (body `{bundle, source, maxDepth?, maxWorkers?}` → `core.triggerIngest` — the **app-side auto-trigger**; supersedes the installed `POST /bundles/<b>/ingest` dispatcher); **`GET /jobs`**; `GET /jobs/<id>`; **`POST /jobs/<id>`** (optional sub-agent progress enrichment only — terminal state is owned by the launcher, not this route). (Depends on T006, T007, T008, T010, T011)

**Checkpoint**: the service builds/derives the two-level index, serves deterministic search + graph, tracks jobs (with the reaper), exposes **19 tools** (incl. `okf_ingest` auto-trigger + `okf_list_jobs`) and the full app REST surface (incl. `POST /jobs`, `GET /tools`). **`core.triggerIngest` is the single path both the tool and the app modal use.**

---

## Phase 3 — User Story 1 — "tell me about X" → TOC → full drill-in (P1) 🎯

**Goal**: `okf_search` returns concept-anchored TOC rows; `okf_read_concept`/`okf_read_toc` return **full** documents/chapters (never a snippet).
**Independent Test**: upsert a few chapters → `okf_search` with a paraphrase returns rows with `matchedConcept` → `okf_read_concept` returns the chapter's entire body; `okf_read_toc` returns the doc's chapter list.

### Tests for US1 ⚠️ (write first, confirm FAIL)
- [ ] T016 [P] [US1] e2e in `e2e/okf-knowledge-base.spec.ts`: US1 scenarios 1–4 — `okf_search` returns TOC rows (doc/chapter/description/matchedConcept) for a natural-language query; `okf_read_concept` on a returned chapter returns its **entire** body (not truncated); `okf_read_toc` returns the doc's full chapter list; `okf_read_concept` on a document id returns the whole document (spec US1, SC-001, FR-001–005, NFR-003).

### Implementation for US1
- [ ] T017 [US1] Wire the Retrieval tool handlers in `services/lib/tools.js` → `okf-core.js`: `okf_search` (T006), `okf_read_toc` (returns the per-doc `toc/*.md` rows), `okf_read_concept` (full frontmatter + **entire** body incl. inline-asset links/interpretations, FR-005/SC-001), `okf_list_concepts` (vocabulary + per-term counts, FR-006). Confirm the read paths never truncate to a snippet. (Depends on T013)

**Checkpoint**: US1 functional — deterministic, full-text, concept-anchored retrieval.

---

## Phase 4 — User Story 2 — Ingesting a document organizes it (P1) — **the auto-ingest core**

**Goal**: `okf_ingest` **automatically starts a headless `okf-ingest` run** that decomposes the source into chapters (concepts + one-line summaries), writes the doc TOC, updates the concept index, and is an observable job; re-ingest dedups. The caller gets a `jobId`, not instructions.
**Independent Test**: `okf_ingest({bundle, source})` → returns `{jobId, status:"queued"}` **with no `acquisition_required`/`delegation_required` block**; the run reaches `completed` with a summary; each heading-level section is a chapter with `parent`/`concepts`/`summary` frontmatter; a doc TOC + concept-index entry exist; re-ingesting the same source does **not** duplicate (returns the existing `docId`).

### Tests for US2 ⚠️
- [ ] T018 [P] [US2] e2e in `e2e/okf-knowledge-base.spec.ts`: US2 scenarios 1–4 + the auto-trigger contract — `okf_ingest` returns `{jobId}` immediately and **no instruction block** (SC-013); the run reaches `completed` (summary: chapters/concepts/assets/refs) or `failed` (error), observable via **both** the Jobs tab `GET /jobs` and `okf_list_jobs` (SC-011/FR-048); a structured source decomposes into chapters with `parent`/`concepts`/`summary`; the doc TOC + concept index are updated; re-ingest dedups (spec US2, FR-012–015/018, FR-046/047/049, SC-002/011/013).

### Implementation for US2
- [ ] T019 [US2] `agents/okf-ingest/AGENT.md` — **rewrite to the self-sufficient allowlist + end-to-end instructions** (design §8.4, FR-039): `tools:` = the **full 19-tool `okf_*` surface** + `web_search, web_fetch, file_to_markdown, view_image, video_keyframes` + `file_read, file_list` (NOT `run_command`, NOT `agent_delegate`, no non-`okf_*` tools). Instructions: on trigger, perform the **whole job** — acquisition first-steps per source (URL→`web_fetch(url, output_path)`, PDF/DOCX→`file_to_markdown(path, output_path)`, text→`okf_add_raw_source(sourcePath)`, each pinning `output_path` so the source streams to disk and is never re-emitted), then `okf_add_raw_source`, chapter decomposition, concept assignment (extend-before-create, dedup), one-line summaries, doc-TOC + concept-index maintenance, inline-asset interpretation (T022), bounded reference crawl (each nested ref → its **own** `okf_ingest` → its own job), and finish with a **compact, honest summary** (chapters/concepts/assets/refsSkipped/refsFailed — the report-honestly rule). State clearly: **the agent does NOT finalize the job** — the launcher (worker) writes the terminal state from the run's own signal (ADR-006); the agent's only job-facing duty is the final summary. (Depends on T011)
- [ ] T020 [US2] `skills/okf-bundle-schema/SKILL.md` — **rewrite** the ingest/query/lint conventions (ADR-007): chapter frontmatter (`type`/`parent`/`concepts`/`summary`/`status`/`stale_after`/`sources`), concept-term naming + merge policy, the inline-asset block format, dedup rules, and the report-honestly summary rule. This is the source of conventions for the agent (not a per-bundle `schema.md`). (Depends on T019)
- [ ] T021 [US2] Verify `okf_add_raw_source` (`{bundle, filename?, content?, sourcePath?, conceptId?, title?}`) accepts a staged `sourcePath` so large content never rides an inline arg, versions into `raw/` (append-only, never overwrites), and records the `raw/sources.json` provenance ledger (FR-017/018, NFR-006). (Depends on T013)
- [ ] T022 [US2] Verify the end-to-end run path against `core.triggerIngest` (T011): a triggered run's NDJSON terminal `endedReason` is what the worker finalizes from — confirm `completed` carries `result.output` (the agent's final summary) and `error`/`max_steps` carry `result.error` (ADR-006). If the agent's final text isn't a clean count, that's a skill-prompt fix (T020), not a code fix. (Depends on T011, T019)

**Checkpoint**: US2 functional — `okf_ingest` auto-triggers a self-sufficient headless run that organizes the source into chapters/TOC/index, observable in both surfaces; re-ingest dedups.

---

## Phase 5 — User Story 3 — Scope retrieval to a specific bundle (P1)

**Goal**: `okf_search`/`okf_read_*` take a `bundle` and results come **only** from that bundle; supports comparing a document against a rule base.
**Independent Test**: two bundles with overlapping concepts; `okf_search` naming the rules bundle returns results only from it; the matched rules are retrievable in full.

### Tests for US3 ⚠️
- [ ] T023 [P] [US3] e2e in `e2e/okf-knowledge-base.spec.ts`: US3 scenarios 1–3 — scoped `okf_search` draws only from the named bundle; a matched rule doc is retrievable in full; a document not in a bundle can still be checked against any target bundle per section (spec US3, FR-001).

### Implementation for US3
- [ ] T024 [US3] Confirm `core.search()` and the read tools are **bundle-scoped** (the `bundle` param bounds every query to one bundle root; no cross-bundle leakage) and that multi-bundle coexistence is real (distinct roots, distinct indices). This is mostly a verification + guard task over the T006/T017 foundation — add any missing bundle-boundary assertion. (Depends on T017)

**Checkpoint**: US3 functional — domain-scoped, multi-bundle retrieval.

---

## Phase 6 — User Story 4 — Ingest interprets figures inline (P1)

**Goal**: non-HTML assets (image/video) in a chapter's scope are downloaded to `raw/assets/<docId>/`, interpreted, and written into the chapter as a **link + interpretation blockquote**; HTML links stay remote refs; retrieval returns the stored interpretation without re-vision.
**Independent Test**: ingest an image- + video-bearing doc → each asset is a local copy in `raw/`; the chapter markdown has the link + interpretation; `okf_read_concept` returns both; a plain hyperlink is **not** downloaded.

### Tests for US4 ⚠️
- [ ] T025 [P] [US4] e2e in `e2e/okf-knowledge-base.spec.ts`: US4 scenarios 1–4 — an image and a video are downloaded as local immutable copies in `raw/assets/<docId>/`; each chapter carries `![…](raw/assets/…)` + a `> **Interpretation:** …` block; `okf_read_concept` returns the link **and** the stored interpretation (no re-run of vision); an HTML hyperlink is left as a remote reference (spec US4, FR-020–023, SC-003).

### Implementation for US4
- [ ] T026 [US4] Ensure the inline-asset pipeline is exercised end-to-end by the run (design §7.5, ADR-008): the agent extracts **non-HTML** asset URLs, downloads each to `raw/assets/<docId>/<name>` via `okf-core`'s binary store (`vfs-bridge.writeBinary`, T009), calls `view_image`/`video_keyframes` to get an interpretation, and writes the chapter markdown with the link + interpretation block (the mockup's `assetBlock`/`.interp` shape); HTML links stay remote; a failed download/interpretation marks the block "interpretation unavailable" and is noted in `okf_lint` but does **not** fail the document (spec Edge Cases). Confirm `view_image` + `video_keyframes` are in the agent allowlist (T019) — they are bos-core dependencies assumed shipped (design ADR-005); if absent at implement time, flag a dependency gap, do NOT implement here. (Depends on T009, T019, T020)

**Checkpoint**: US4 functional — inline assets stored + interpreted at ingest; retrieval carries their knowledge.

---

## Phase 7 — User Story 5 — Manage bundles: create/import/export/delete (P2)

**Goal**: create, import, export, delete bundles — via tools and the app — export is spec-conformant OKF **including the concept index and document TOCs**; import re-derives the index best-effort.
**Independent Test**: create a bundle; import an existing OKF dir; export and confirm it's conformant (incl. index + TOCs); delete and confirm it's gone from `okf_list_bundles`.

### Tests for US5 ⚠️
- [ ] T027 [P] [US5] e2e in `e2e/okf-knowledge-base.spec.ts`: US5 scenarios 1–4 — `okf_init_bundle` creates the conformant layout; `okf_import_bundle` makes an existing bundle's documents/chapters/index/TOCs present and queryable (best-effort index on a bundle lacking `parent`/concepts/summary, non-destructive, health reports "needs regeneration" — design §10 risk 9); `okf_export_bundle` is conformant **including `concept-index.md` + `toc/`** and re-imports queryable (SC-004); `okf_delete_bundle` removes only that dir (spec US5, FR-027–030, SC-004).

### Implementation for US5
- [ ] T028 [US5] Wire the Bundle tool handlers in `services/lib/tools.js` → `okf-core.js`: `okf_init_bundle` (conformant layout: `index.md`, `log.md`, `concept-index.md`, `toc/`, `links.json`, `raw/`, `raw/assets/`, `concepts/`), `okf_import_bundle` (dir/git/tarball → best-effort index derivation, non-destructive, reported), `okf_export_bundle` (conformant, **includes** concept index + every TOC, **excludes** `.jobs/`), `okf_delete_bundle` (only that dir). Ensure import/export round-trips a queryable bundle (SC-004). (Depends on T005, T013)

**Checkpoint**: US5 functional — bundle lifecycle incl. conformant export/import.

---

## Phase 8 — User Story 6 — Curate the concept vocabulary (merge) (P2)

**Goal**: `okf_merge_concepts` merges one term into a canonical term, updating the concept index, every affected doc TOC, and every chapter's `concepts` frontmatter → single canonical entry; subsequent queries route via the canonical term.
**Independent Test**: two near-duplicate terms → merge → one canonical index entry; affected TOCs + chapter `concepts` updated; a query matching either term routes to the union.

### Tests for US6 ⚠️
- [ ] T029 [P] [US6] e2e in `e2e/okf-knowledge-base.spec.ts`: US6 scenarios 1–2 — `okf_merge_concepts` consolidates to one canonical term and updates all affected `toc/*.md` + chapter `concepts`; a query that matched either term now routes via the canonical term to the union of chapters (spec US6, FR-026, SC-008).

### Implementation for US6
- [ ] T030 [US6] Wire the `okf_merge_concepts` handler in `services/lib/tools.js` → `core.mergeConcepts` (T008); confirm the derived index + affected TOCs + chapter `concepts` all reference only the canonical term and the index rebuilds (SC-008). (Depends on T008, T013)

**Checkpoint**: US6 functional — vocabulary curation with full derived-artifact consistency.

---

## Phase 9 — User Story 7 — Manage KBs from the app + browse index/TOCs (Overview) (P2)

**Goal**: the app's **Overview** tab is the bundle-management surface — bundle list (per-bundle health) → bundle detail (health stat cards; Concept Index / Documents / Health / Import·Export tabs) → concept index → document → stored TOC → full chapter — matching what the retrieval tools return.
**Independent Test**: open the app; see the bundle list with per-bundle health; open a bundle; view its concept index + a document's TOC; verify both match `okf_search`/`okf_list_concepts` output.

### Tests for US7 ⚠️
- [ ] T031 [P] [US7] e2e in `e2e/okf-knowledge-base.spec.ts`: US7 scenarios 1–3 — the Overview concept-index view shows each term → (doc, chapter) rows with descriptions; the document TOC view renders the stored `toc/*.md`; the bundle status shows doc/chapter/concept-term counts + stale items — all matching the corresponding tool output (spec US7, FR-027/036).

### Implementation for US7
- [ ] T032 [US7] Implement the app **Overview** tab from `mockup.html` (`app/src/overview/`): bundle list (health dots, counts) → bundle detail (health stat cards + Concept Index / Documents / Health / Import·Export tabs) → concept index (searchable, term → rows) → document → stored TOC → full chapter (frontmatter card, markdown, inline-asset blocks, "View source"). Modals: New / Import / Export / Delete. Data from `GET /bundles`, `GET /bundles/<b>`, `GET /bundles/<b>/toc/<docId>`, `GET /bundles/<b>/concept/<id>`, `GET /bundles/<b>/lint`, `GET /bundles/<b>/stale` (T015). (Depends on T015)
- [ ] T033 [US7] Wire the app's create/import/export/delete + concept-term **merge** controls to the T015 routes (`POST /bundles`, `POST /bundles/<b>/import`, `GET /bundles/<b>/export`, `DELETE /bundles/<b>`, `POST /bundles/<b>/merge`), and `bridge.ts` to resolve the service base URL over `httpPath`-else-`runtime.port` (design §8.1; the app needs the `services:read` capability — documented). (Depends on T032)

**Checkpoint**: US7 functional — the Overview tab is a faithful human mirror of the agent's retrieval + management.

---

## Phase 10 — User Story 8 — Watch ingest runs (Jobs) + `okf_list_jobs` (P2) — **the scope-add surface**

**Goal**: a run is observable through its real lifecycle in **both** the app's Jobs tab **and** `okf_list_jobs`; the app's Ingest modal **auto-triggers** a run (no "hand this to an assistant" step); a stuck run is reaper-marked failed.
**Independent Test**: trigger an ingest (tool or modal) → `jobId` returned → the run shows queued/running (live progress) → completed (summary) or failed (error) in the Jobs tab **and** `okf_list_jobs`; kill/abandon a run → reaper marks it failed (stale).

### Tests for US8 ⚠️
- [ ] T034 [P] [US8] e2e in `e2e/okf-knowledge-base.spec.ts`: US8 scenarios 1–4 + SC-011/013 + FR-049 — a triggered run (via the **app `POST /jobs`** and via the `okf_ingest` tool) shows queued → running → completed (summary) / failed (error) in the Jobs tab; `okf_list_jobs` returns the **same** records; a run whose headless process dies/overruns is reaper-marked `failed (stale)` (spec US8, FR-041/044/046/048/049, SC-011/013).

### Implementation for US8
- [ ] T035 [US8] Implement the app **Jobs** tab from `mockup.html` (`app/src/jobs/`): run list (queued/running/completed/failed status dots, bundle, source, elapsed/duration) → expandable detail (summary cells: chapters/concepts/assets/refsSkipped/refsFailed; written-chapter chips; error card; live progress bar); **poll `GET /jobs`** on a short interval (live elapsed + progress); a **live Jobs badge** in the titlebar. Data from `GET /jobs` / `GET /jobs/<id>` (T015). (Depends on T015)
- [ ] T036 [US8] Rework the app's **Ingest modal** to **auto-trigger**: submit calls **`POST /jobs`** (`{bundle, source, maxDepth?, maxWorkers?}`) → the service runs `core.triggerIngest` (the same path as `okf_ingest`, T011/T015) → the modal shows the run in the Jobs tab (queued→running→…) instead of instructing the user to hand steps to an assistant. This **supersedes** the installed `POST /bundles/<b>/ingest` dispatcher path (ADR-005). (Depends on T015, T035)

**Checkpoint**: US8 functional — runs are observable in both surfaces, the app triggers runs directly, and the reaper guarantees no stuck jobs.

---

## Phase 11 — User Story 9 — Explore as graph + search, open full chapters (Query) (P2)

**Goal**: the app's **Query** tab is a single unified view — a **shared search field** on top + a **Graph / Table** toggle below; the Graph is a force-directed, category-colored, edge-labeled knowledge graph; search reflects in both (Table filters rows, Graph highlights + dims); selecting a node/row opens the full chapter in a **mouse-resizable** reader pane with an "Open source" link (original URL else `raw/` path).
**Independent Test**: run a query → Table filters AND Graph highlights (rest dimmed); click a chapter → the resizable pane renders the full chapter + "Open source"; the app search returns the **identical** rows to `okf_search`.

### Tests for US9 ⚠️
- [ ] T037 [P] [US9] e2e in `e2e/okf-knowledge-base.spec.ts`: US9 scenarios 1–3 — the Query Graph renders bundle nodes (doc/chapter/concept-term) + typed directed edges from `GET /bundles/<b>/graph`; the shared search returns rows **identical** to `okf_search` and reflects in both views (Table filter, Graph highlight+dim); selecting a node/row opens the full chapter in the resizable pane with a working "Open source" link (original URL else `raw/` path) (spec US9, FR-036/042/043/045, SC-012, NFR-004).

### Implementation for US9
- [ ] T038 [US9] Implement the app **Query** tab from `mockup.html` (`app/src/query/`): shared search field (top) + **Graph/Table** toggle; **Table** = the node list (type, name, description) filtered by search; **Graph** = the **dependency-free force-directed** SVG (category-colored circular nodes: doc slate / chapter blue / concept violet; labeled directed edges: contains solid / covers dashed-violet / related amber; legend, hover-to-trace-neighbors, pan/zoom/drag; viewBox from real container dimensions; add a node-count guard — design §10 risk 6), ported verbatim from `mockup.html`'s `stepGraph`/`renderGraph`/`drawGraph` (ADR-009); search reflects in both views. (Depends on T015)
- [ ] T039 [US9] Implement the **mouse-resizable reader pane** (`app/src/query/` + `lib/markdown.ts`): the pane renders the selected document (TOC) / chapter (full, incl. inline-asset blocks via `GET /bundles/<b>/assets/<p>` + the stored interpretation) / concept-term (its covering chapters), with the **"Open source"** link at top (the document's original ingested URL from `sources`, else the stored `raw/` path — FR-043). (Depends on T038)
- [ ] T040 [US9] Wire the app **shell** (`app/src/App.tsx`): titlebar (🧠 OKF Knowledge Base + a **"19 okf_\* tools" badge that reads `GET /tools`** — the real declared count, not a hardcoded literal) + the **Overview / Jobs / Query** tab bar with a live Jobs badge; all three tabs (T032, T035, T038) share one app facet; confirm the app reaches the service over `httpPath` (opaque-origin iframe, ADR-003). (Depends on T032, T035, T038)

**Checkpoint**: US9 functional — the full Query tab (graph + table + shared search + resizable reader) is live.

---

## Phase 12 — Polish & cross-cutting

- [ ] T041 [P] Write `docs/usage/OKF Knowledge Base/`: `index.md` (what it does, the three tabs, the retrieval model in plain terms), `ingest.md` (how to trigger ingest — tool or app modal → auto run — what a run does, watching Jobs / `okf_list_jobs`), `troubleshooting.md` (search misses = concept-anchored not full-text; stale items; **stuck jobs / the reaper**; import/export; service not started).
- [ ] T042 [P] Write `docs/dev/OKF Knowledge Base/`: `architecture.md` (service facet, VFS + **delegate** bridges, two-level derived index, **auto-trigger mechanism** (ADR-005/006), reaper, graph derivation), `data-model.md` (bundle layout, frontmatter schema, index/TOC format, **job record**), `tool-surface.md` (the **19** `okf_*` tools, mirroring design §8.2), `extension.md` (adding a bundle convention; the `okf-ingest` skill as the seam).
- [ ] T043 Verify the **upgrade path** for the installed item: `id` preserved; the 31→**19** tool change + the `okf_ingest` dispatcher→**auto-trigger** rework + the new `delegate-bridge`/reaper take effect on `app_build`; pre-existing bundles are handled by T028's best-effort index (no data loss); the bundled agent/skill copy-install + provenance resolves on update (a bos-core dependency assumed shipped — design ADR-005).
- [ ] T044 **Consistency sweep**: confirm spec.md / design.md / tool-surface.md / plan.md / mockup.html / tasks.md agree on (a) the **19**-tool set, (b) the auto-trigger + launcher-owns-finalization + reaper mechanism, (c) the app REST route set (**incl. `POST /jobs`, `GET /tools`**), (d) the self-sufficient agent allowlist, (e) the "Open source" target rule, (f) the `okf_init_bundle` name. Record any drift in the item's `spec.md` (the contract).
- [ ] T045 Run the full Playwright suite (`buildstudio_run_tests` against `item-okf-knowledge-base`) and confirm all 9 stories' acceptance scenarios + **SC-001–013** pass (incl. the SC-007 19-tool assertion via `GET /tools`, and SC-011/013 auto-trigger + both-surface job observability + reaper); capture `test-results.md`.

---

## Dependencies & Execution Order

- **Setup (1)** → **Foundational (2)** → **User Stories (3–11)** → **Polish (12)**.
- **Foundational (T005–T015) blocks every story.** Within it: T005 → {T006, T007, T008} (same `okf-core.js` — sequential); T010 → T011 → (needs T012); T013 needs T006/T008/T010/T011; T014/T015 need T010/T011. T009 (vfs-bridge) is independent.
- **US1 (P1)** = MVP (T017 over the foundation). **US2 (P1)** = the auto-ingest core (T019–T022: agent + skill + trigger verification). **US3 (P1)** over the foundation. **US4 (P1)** depends on US2 (the run carries the inline-asset steps) + T009. **US5/US6 (P2)** over the foundation. **US7/US8/US9 (P2)** are app facets — all depend on T015 (the app REST surface); US8's app `POST /jobs` (T036) depends on the foundational trigger (T011/T015); US9's shell (T040) depends on US7/US8/US9-tab (T032/T035/T038).
- **Within each story**: tests (write + confirm FAIL) → core `okf-core.js` change (if any) → tool handler in `tools.js` → (UI stories) the app facet from `mockup.html` → integration.
- **Parallel**: T002/T003/T004 (Phase 1); across stories, the service-side stories (US1/US2/US3/US4/US5/US6) and the app-side stories (US7/US8/US9) can proceed once the foundation is done. Per-story `[P]` test tasks can be written together (TDD).

## Implementation Strategy

- **MVP first**: Phase 1 → Phase 2 → US1 (retrieval) → **US2 (the auto-ingest core)** → validate: `okf_ingest` returns a `jobId`, the run auto-completes and organizes the source, and the result is searchable. That proves both the redesign's retrieval and the scope-add's auto-trigger.
- **Then**: US3/US4 (scoping + inline assets) → US5/US6 (bundles + curation) → US7/US8/US9 (the three app tabs) → Phase 12 (docs + full e2e).
- **Dependency gaps to flag, not fix**: the four bos-core acquisition tools (`web_fetch`/`file_to_markdown`/`view_image`/`video_keyframes`), the headless `POST /api/subagents/delegate` surface, and the copy-install/provenance mechanism are **assumed-shipped dependencies** (design ADR-005). If any is absent at implement time, flag it — do not implement it inside this item.
- `e2e/okf-knowledge-base.spec.ts` is the **single** e2e file (feature-id = item id `okf-knowledge-base`); each story's test task adds its cases. It runs against the branch preview via `BOS_PREVIEW_URL` + `npx playwright test`.
