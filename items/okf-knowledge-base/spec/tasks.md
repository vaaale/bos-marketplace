# Tasks: OKF Knowledge Base — job cancel/delete scope-add

**Feature**: job cancellation + deletion on the OKF KB ingest pipeline (FR-050/051/052, US8-4/5/6, SC-014/015, 21-tool surface)
**Spec**: `item-okf-knowledge-base/spec.md` · **Plan**: `item-okf-knowledge-base/plan.md` · **Design**: `item-okf-knowledge-base/design.md` (ADR-010 is authoritative) · **UI contract**: `item-okf-knowledge-base/mockup.html`
**Branch**: `bos/okf-docid-fix` (already has the auto-ingest baseline — 19 tools, `delegate-bridge.js` fire/finalize/reaper, job store, Jobs tab — **and** the `docIdForSource` fix; those are carried forward, not re-tasked)

**Baseline assumption**: the installed item already auto-triggers headless ingest and shows Jobs (queued/running/completed/failed). These tasks add **cancel** (a distinct `cancelled` terminal state, via the one generic `src/` abort route) and **delete** (non-running job record), plus the two agent tools, the app controls, and the e2e coverage.

Dependency order: **A** (the `src/` route) is independent. **C** (core job ops) is the foundation; **B** (bridge cancel) needs C + the `runId` it captures; **D**/`E`/`F` (tools / routes / app) need C; **G** (allowlist/config/docs) is independent of the rest of the item work; **H** (e2e) needs B/D/E/F; **I** (install + verify) last.

---

## Phase A — the generic `src/` abort route (FR-052) — `[P]` (no deps)

- [ ] **A1.** Create `src/app/api/subagents/[runId]/abort/route.ts` — `POST` only. Import `abortHeadlessRun` from `@/lib/agent/subagents/run-registry`. Read `runId` from the path param; if missing/empty → `404`. Otherwise `const aborted = abortHeadlessRun(runId)` → return `200 { aborted, runId }` (`aborted:false` when no such live run — idempotent). **Keep it generic**: no OKF knowledge (no job store, no bundle, no agent id), no new deps. Confirm no collision with the existing single-segment `src/app/api/subagents/[id]/route.ts` (agent metadata, PATCH/DELETE) — this is the distinct two-segment `/subagents/<runId>/abort`. *(This is the one `src/` file — commit on the branch alongside `app_build`; it is NOT part of the item staging dir.)*

## Phase C — core job-store cancel/delete + `cancelled` state (foundation)

- [ ] **C1.** `services/lib/okf-core.js` — widen the job status set to `{queued, running, completed, cancelled, failed}`; `cancelled` is **terminal** and **distinct from `failed`** (`error: null`). Add **`runId`** to the persisted job record (`<bundleRoot>/.jobs/<id>.md` + the in-memory hot map) — set once the bridge captures it (B1).
- [ ] **C2.** `services/lib/okf-core.js` — **`cancelJob(jobId)`**: if the job is already terminal → return `{cancelled:false, reason:"already terminal"}` (no-op). Otherwise mark it `cancelled` (non-terminal → applies) and **signal `delegate-bridge` to abort the run** (B2). The record + any already-written bundle content are preserved. Unknown `jobId` → not-found.
- [ ] **C3.** `services/lib/okf-core.js` — **`deleteJob(jobId)`**: if the job is `running` → reject (409, "cancel it first"). Unknown `jobId` → clean not-found (404). Otherwise remove the record from the hot map + delete its `.jobs/<id>.md`. **Never touch bundle content** (chapters, index, TOC, `raw/`).
- [ ] **C4.** `services/lib/okf-core.js` — **`listJobs()`** (backing `okf_list_jobs` + `GET /jobs`) must **include `cancelled`** jobs and expose `runId` in the record shape (FR-048). *(Likely already present from auto-ingest — confirm it surfaces `cancelled` + `runId`.)*

## Phase B — `delegate-bridge.js`: capture `runId` + cancel path

- [ ] **B1.** `services/lib/delegate-bridge.js` — **capture the `runId`** from the **first `run_started` NDJSON line** on the held delegate stream and store it on the job (C1). (The worker already receives this line today; this adds the capture + storage.)
- [ ] **B2.** `services/lib/delegate-bridge.js` — **cancel path**: when `cancelJob` (C2) signals, call **`POST /api/subagents/<runId>/abort`** over loopback (the same channel used for `/api/fs` and `POST /api/subagents/delegate`). The held stream then delivers the terminal `done { result.endedReason:"cancelled" }` → the existing ADR-006 finalizer writes `cancelled` (C1). The tool/route return `{cancelled:true, status:"cancelled"}`.
- [ ] **B3.** `services/lib/delegate-bridge.js` — **queued-window cancel (ADR-010/S4)**: as soon as `run_started` lands and the `runId` is captured, if the job is **already `cancelled`** (user cancelled during the queued window), **immediately fire the abort** (do not wait for natural completion). A queued job is also deletable (C3).
- [ ] **B4.** `services/lib/delegate-bridge.js` — confirm the existing **terminal `endedReason` → job status** mapping handles `cancelled → cancelled` (distinct, not failed) and that the **stale reaper** (`jobFinalizeTimeoutMs`) still marks a non-terminal job `failed` — no change expected; verify.

## Phase D — two new agent tools (surface 19 → 21)

- [ ] **D1.** `services/lib/tools.js` — declare + implement **`okf_cancel_job {jobId}`** → `{cancelled:true, status:"cancelled"}` | `{cancelled:false, reason:"already terminal"}` | not-found (FR-050). Wires to `core.cancelJob` (C2).
- [ ] **D2.** `services/lib/tools.js` — declare + implement **`okf_delete_job {jobId}`** → `{deleted:true}` | 409 (running — cancel first) | 404 (not found) (FR-051). Wires to `core.deleteJob` (C3).
- [ ] **D3.** `services/lib/tools.js` — confirm the declared surface is **exactly 21** (SC-007): `okf_list_jobs`, `okf_cancel_job`, `okf_delete_job` present under the **Knowledge Base** group; none of the 16 removed tools declared. `okf_cancel_job`/`okf_delete_job` are write tools (not `readOnly`/parallel-safe); `okf_list_jobs` stays `readOnly`.

## Phase E — app-facing REST routes

- [ ] **E1.** `services/lib/http-bridge.js` — **`POST /jobs/<id>/cancel`** → `{cancelled:true, status:"cancelled"}` | `{cancelled:false, reason:"already terminal"}` (drives the same worker op as `okf_cancel_job` — ADR-003, one capability two surfaces).
- [ ] **E2.** `services/lib/http-bridge.js` — **`DELETE /jobs/<id>`** → `{deleted:true}` | `409` (running) | `404` (missing) (drives the same op as `okf_delete_job`).

## Phase F — app Jobs tab (per `mockup.html` — binding) `[P]` once E is done

- [ ] **F1.** `app/src/lib/api.ts` — add `cancelJob(id)` → `POST /jobs/<id>/cancel` and `deleteJob(id)` → `DELETE /jobs/<id>` clients.
- [ ] **F2.** `app/src/jobs/…` — render the **`cancelled` status dot** (the mockup's `--stopped` `#d0894e`, "stopped not errored") in the job list + detail; include `cancelled` in the status→color/label map and legend.
- [ ] **F3.** `app/src/jobs/…` — **Cancel control on running/queued rows** → `cancelJob(id)`; on success the row reflects `cancelled`. **Delete control on non-running rows** (completed/cancelled/failed/queued) → `deleteJob(id)`; the row is removed. The state-dependent matrix matches the mockup (running → Cancel only; terminal/queued → Delete).
- [ ] **F4.** `app/src/jobs/…` — confirm the Jobs tab badge counts **all** jobs (incl. `cancelled`) and the app's tool-count badge reads **21**.

## Phase G — agent allowlist, config, docs `[P]` (independent of C–F item wiring)

- [ ] **G1.** `agents/okf-ingest/AGENT.md` — the allowlist **includes `okf_ingest`** (so the run can fire independent nested reference jobs — its only job-lifecycle tool; FR-019/FR-047, design §8.4). Confirm it does **NOT** grant `okf_list_jobs`/`okf_cancel_job`/`okf_delete_job` (top-level/app) and still excludes `run_command`/`agent_delegate`/the full surface (NFR-009).
- [ ] **G2.** `services/service.json` + `config/okf-knowledge-base.json` — add **`jobFinalizeTimeoutMs`** (stale-reaper bound, ADR-006/FR-049) to the config schema + defaults (e.g. 1800000). *(Carried forward from auto-ingest if not already present — confirm.)*
- [ ] **G3.** `docs/dev/OKF Knowledge Base/tool-surface.md` — update to the **21-tool** surface (add `okf_cancel_job`/`okf_delete_job`) + note the **abort-route dependency** (the store-root spec-040 `tool-surface.md` is superseded).
- [ ] **G4.** `docs/dev/OKF Knowledge Base/architecture.md` — add the cancel/delete flow (per-run abort via the generic `src/` route, the `cancelled` terminal state, delete-is-record-only, queued-window abort-on-`runId`-capture). `docs/usage/…/ingest.md` — note cancelling a running run and deleting a finished one from the Jobs tab.

## Phase H — e2e coverage (`e2e/okf-knowledge-base.spec.ts`)

Reuse the existing **mock-delegate seam** (`OKF_DELEGATE_URL` env override in `delegate-bridge.js`) so run-dependent tests are deterministic + instant — a mock run emits `run_started` then stays open, so cancel is asserted without a real 10-minute agent.

- [ ] **H1. (SC-007)** 21-tool surface: `okf_cancel_job` + `okf_delete_job` declared + working; the 16 removed absent; total exactly 21.
- [ ] **H2. (FR-048)** `okf_list_jobs` returns the same records as `GET /jobs`, **including a `cancelled` job**; `runId` present on a run that started.
- [ ] **H3. (SC-014, US8-4)** **cancel**: a running job (mock delegate run open) → `okf_cancel_job` **and** `POST /jobs/<id>/cancel` → transitions to the **`cancelled`** terminal state (not failed); the job record **and** bundle content already written are preserved; **cancel of a terminal job is a no-op** (`{cancelled:false, reason:"already terminal"}`).
- [ ] **H4. (FR-052)** **the `src/` abort route directly**: `POST /api/subagents/<runId>/abort` on a **live** run → `{aborted:true}` and the run ends `cancelled`; on a **finished/unknown** runId → `{aborted:false}` (idempotent); missing runId → 404.
- [ ] **H5. (ADR-010/S4)** **queued-window cancel**: cancel a job before `run_started` arrives → the moment the mock emits `run_started`, the run is aborted and the job lands `cancelled` (≡ running cancel).
- [ ] **H6. (SC-015, US8-5/6)** **delete**: a non-running job → `okf_delete_job` **and** `DELETE /jobs/<id>` → record removed, **bundle content untouched**; a **running** job → rejected (409); a **missing** job → clean 404.
- [ ] **H7. (FR-041, mockup)** **app Jobs tab**: a `cancelled` job shows the `cancelled` dot; a running row shows **Cancel** (not Delete); a terminal row shows **Delete** (not Cancel); clicking Cancel/Delete drives the right route and updates the list.

## Phase I — install + verify

- [ ] **I1.** Stage the item facets (the changed `services/`, `app/`, `agents/`, `config/`, `docs/`) into a fresh staging dir; **`app_build({name:"OKF Knowledge Base", dir:<staging>, id:"okf-knowledge-base"})`** (id preserved — in-place update). The `src/` abort route (A1) is committed on the branch **alongside**, not in the staging dir.
- [ ] **I2.** Restart the service (`POST /api/services/okf-knowledge-base {"action":"restart"}`); confirm `GET /tools` shows **21**, the app Jobs tab renders the cancel/delete surface + `cancelled` dot, and the mock-delegate cancel path works end-to-end against the live instance.
- [ ] **I3.** Run the full e2e suite (`BOS_PREVIEW_URL` + `npx playwright test e2e/okf-knowledge-base.spec.ts`) — all prior auto-ingest tests **and** the new H1–H7 pass.

---

**Notes**
- **Per-run abort, not family cascade** (ADR-010/S1): nested reference runs are independent top-level runs (the delegate route doesn't forward `parentRunId`), so each is its own job cancelled by its own `runId` — the `src/` route's `aborted:true/false` is per-run; do not rely on the registry's `parentRunId` cascade for OKF.
- **`cancelled` is a stop, not a rollback** (ADR-010/S4): partial content is preserved and the index regenerates; a cancelled run's `error` is `null`.
- **One capability, two surfaces** (ADR-003): the tools (D) and the app routes (E) drive the **same** worker ops (C) — test both (H3/H6).
- The **`src/` route stays generic** (FR-052): no OKF knowledge; any headless consumer can use it.

---

## Person-kind term scope-add (FR-053/FR-054, US10, SC-016) — appended 2026-10-11

**Baseline**: the auto-ingest + cancel/delete work above (21-tool surface, job store, headless launcher, Jobs tab). This section adds **person-kind term extraction** at ingest + a **`kind`** field on the derived index + a **4th graph node type** + an **additive `kind`** on two tool responses + the **app query view**.

**Invariants (ADR-011 — do not deviate)**:
- **No new tools** — the surface stays **21** (SC-007). Person search rides the existing `okf_search` (a person's name is an ordinary term-name hit — **zero search-algorithm change**).
- **No new entity / content file** — a person is a **kind-tagged term in the SAME derived concept index**, carried by a parallel **`person_terms`** frontmatter array on the chapter/doc-stub (sibling of `concepts`). The derived index is the only `kind` authority; `rebuildIndex` derives it. Never a hand-synced per-term file.
- **No `src/` change** — this is an item **`services/` + `app/` + `agents/` + `skills/`** rebuild via `app_build` (id `okf-knowledge-base` preserved).
- **`person_terms` is NFR-005-preserved** — the existing shallow-merge upsert already preserves unknown keys verbatim; **no writer change**. A person name goes in `person_terms`, **never** in `concepts` (parallel arrays).
- **Additive / backward-compatible** — every existing surface (search, list, graph, upsert, merge, delete, export/import round-trip, pre-person-kind bundles) MUST keep working; `kind` is a new field existing callers ignore. Legacy indices (no `kind`) default to `topic`.

**Dependency order**: **J** (derived index carries `kind`) is the foundation; **K** (graph 4th node type) needs J; **L** (tool responses gain `kind`) needs J; **M** (extraction convention AGENT.md/SKILL.md) is independent of the item wiring; **N** (app query view) needs J+K+L + the updated `mockup.html`; **O** (e2e + regression) needs J–N; **P** (install + verify) last.

---

### Phase J — derived index carries `kind` (foundation, `services/lib/okf-core.js`)

- [ ] **J1.** `rebuildIndex`: read **`person_terms`** from the **same files it already walks** (chapter stubs under `concepts/**` + document stubs). Derive **`kind(term)`**: a term is `person` iff its **lowercased** name appears in **any** lowercased `person_terms` array (across the bundle), else `topic`. Write `kind` into the derived `concept-index.md` frontmatter `terms[]` entries. The term's `name` in `terms[]` **preserves the original case** from `person_terms` for persons (display), while kind derivation + search matching use the lowercased key (S1). Coverage edges to a person term are derived identically to a topic term (a person is an ordinary term with edges to its covering chapters).
- [ ] **J2.** The stored-terms **trust path** (the fast path that reads `concept-index.md` without a full rebuild when `index_generated_at` is fresh): default **`kind: t.kind || 'topic'`** so a pre-person-kind index (no `kind` field on its terms) is served correctly without a rebuild (S4). No migration required — a legacy bundle is all-`topic` until the next `rebuildIndex` populates `kind` from the now-present (possibly empty) `person_terms`.
- [ ] **J3.** `mergeConcepts`: when canonicalizing `from → to`, rewrite **`person_terms` arrays** that referenced the `from`-name in addition to the existing `concepts` rewrites (S3) — so a person term merged into another person/topic name leaves no `person_terms` referencing the old name, and the derived `kind` stays correct on the next rebuild.
- [ ] **J4.** **Verify** (unit): a fresh rebuild of a bundle with an author + a named key figure yields an index where those names are `kind:'person'` and all existing topic terms are `kind:'topic'`; a bundle with no `person_terms` yields all-`topic` (no crash, no `undefined`); a pre-person-kind stored index (no `kind`) is served as all-`topic` via the trust path.

### Phase K — graph carries a 4th node type (`services/lib/okf-core.js` `core.graph`)

- [ ] **K1.** The graph's `nodes[]`: a person-kind term gets **`type:'person'`** (4th category alongside `doc`/`chap`/`concept`), with the **same count-driven radius** as concept nodes. Coverage edges to a person term use the **same edge kind** as topic coverage (dashed) — the node color is what distinguishes a person from a topic in the app. A term's graph `type` is derived from its index `kind` (`person` → `person`, else `concept`).
- [ ] **K2.** **Verify** (unit): `graph()` on a bundle with persons returns `type:'person'` nodes with correct `count` + coverage edges; a bundle with no persons returns **only** the 3 existing node types (backward compatible — no 4th type, no undefined).

### Phase L — tool responses gain an additive `kind` field (`services/lib/tools.js`)

- [ ] **L1.** `okf_search` (FR-001/002): the term-matching algorithm is **unchanged**. Add an **additive `kind`** field to each `rows[]` entry (so a caller knows a term hit was a person vs a topic). No change to query tokenization, `termHit`/`descHit` scoring, or the `chapterHits`/`docHits` content-body fallback (those are kind-agnostic). A person's name is found by the **existing** `termHit` check (`term.name.toLowerCase().includes(tok)`).
- [ ] **L2.** `okf_list_concepts` (FR-006): add an **optional `kind` filter** parameter (`'topic' | 'person' | 'all'`, default `all`) and include **`kind`** in each `terms[]` response entry. Backward compatible — a caller that omits `kind` gets all terms with the new field present.
- [ ] **L3.** **Verify** (unit): `okf_search` on a person's name ("Diego", "Córdoba", and "Diego Córdoba") returns rows with `kind:'person'`; `okf_list_concepts({kind:'person'})` returns only person terms; `okf_list_concepts()` (no filter) returns all terms each with a `kind` field; a pre-person-kind bundle's search/list work (absent `kind` → treated as topic).

### Phase M — extraction convention (independent of the item wiring) `[P]`

- [ ] **M1.** `skills/okf-bundle-schema/SKILL.md`: add the **person-extraction convention** to the ingest instructions — during ingest, extract **salient persons**: the **author** (registered at **document** level, on the doc-stub's `person_terms`) and **named key figures who are subjects** of the content (registered at **chapter** level, on the relevant chapter stub's `person_terms`). Salience bar: the author always; named key figures **only when they are subjects**, not every name that appears. Person names go in **`person_terms`**, **never** in `concepts` (parallel arrays — ADR-011). Reusing a person across multiple chapters: add the name to each relevant chapter's `person_terms` + the doc-stub; the derived index consolidates them under one term (one `kind:'person'` entry, `count` = covering chapters).
- [ ] **M2.** `agents/okf-ingest/AGENT.md`: add a matching one-liner to the ingest instructions — **"Populate `person_terms` (author + salient named key figures) per the `okf-bundle-schema` skill; never in `concepts`."** The agent's **allowlist is unchanged** (no new tools — person extraction rides on the already-granted `okf_upsert_concept`, which writes `person_terms` via frontmerge; NFR-005 preserves it).
- [ ] **M3.** **Verify** (agent-level, exercised in the implement e2e O2): an ingested article with a named author + a named key figure results in `person_terms` populated on the doc-stub (author) and the relevant chapter stub(s) (key figure); the author is **not** also in `concepts`; a document with no salient person (e.g. a technical spec) leaves `person_terms` empty/absent (all-`topic`).

### Phase N — app query view (per the updated `mockup.html` — binding) `[P]` once J+K+L are done

- [ ] **N1.** `app/src/lib/api.ts`: the typed client for `GET /bundles/<b>/graph` and the search/list routes now surfaces the **`kind`** field + the **`type:'person'`** graph node. (Additive — the existing client types gain a `kind?: 'topic' | 'person'` on terms/rows and a `'person'` to the node-type union.)
- [ ] **N2.** `app/src/query/GraphView` (or equivalent): render the **4th node type `person`** in **teal `#2dd4bf`** (the mockup's `.g-node.person .g-circ`), with its **legend swatch + "Person" label**, **dashed-teal person-coverage edges**, person nodes participating in **`applyGraphSearch`** (name match, highlighted/dimmed like concept nodes) and **`openPane`** (clicking a person node opens the **same term view** as a concept term — its covering chapters — labeled **"Person"** not "Concept term"). Add the **4th graph filter chip** (person) per the mockup.
- [ ] **N3.** `app/src/query/TableView`: the **`kind` column** (Topic / Person) with a **`.dot-person`** teal dot; person rows present when the bundle has them.
- [ ] **N4.** Search results: a **"matched person"** tag (teal) for person-kind term hits, vs the existing violet **"matched concept"** for topic hits (the `kind` on the `rows[]` entry drives the tag).
- [ ] **N5.** `app/src/overview` concept-index view: person terms render a **teal "person" pill** vs the violet concept pill; `renderConceptIndex` reads the new `kind` field. **Verify** (Playwright O2): with a person-bearing bundle, the graph shows the teal person node + legend, the table shows a Person row, the concept index shows the person pill, and clicking the person node opens its chapters.

### Phase O — e2e + regression (`e2e/okf-knowledge-base.spec.ts`)

Reuse the existing mock/fixture harness. Add the person coverage **and** the backward-compat regression.

- [ ] **O1. (FR-053/054, US10-1/2/3, SC-016)** **person search hits**: with a bundle that has a person-kind term (the Diego Córdoba sample, or a fixture seeded with `person_terms`), `okf_search` on the person's name (full, first-name-only, last-name-only) returns the covering documents/chapters with **`kind:'person'`**; the **app** Query-tab search returns the same rows with the **"matched person"** tag; `okf_list_concepts` reports the term with `kind:'person'` (and `{kind:'person'}` filters to it only).
- [ ] **O2. (M3)** **extraction produces `person_terms`**: ingest a source with a named author + named key figure (mock-delegate or a real short run) and assert the resulting chapter/doc-stub frontmatter carries `person_terms` (author on the doc-stub, key figure on the chapter), the author is **not** in `concepts`, and `rebuildIndex` surfaces the term with `kind:'person'`.
- [ ] **O3. (N5 / mockup)** **app graph 4th node type**: the Query-tab graph renders the **teal person node** with a **legend entry**; the **table** shows a **Person** row (`kind` column); clicking the person node opens its covering chapters in the reader pane.
- [ ] **O4. (backward-compat regression — the S4 guard)** **no-person bundle stays clean**: a bundle with **no** `person_terms` (and a pre-person-kind stored index with no `kind`) still produces an **all-`topic`** index, a **3-node-type** graph (no `person` nodes, no `undefined`), working search/list, and a working **export→import round-trip** (the `kind` field survives; a re-imported bundle's persons keep `kind:'person'`).
- [ ] **O5. (SC-007)** **surface still exactly 21** — the person scope-add adds **no tools**; re-assert `GET /tools` is 21 with no `okf_*` person-specific tool.
- [ ] **O6.** Full suite green — all prior auto-ingest **and** cancel/delete tests still pass (the `kind` field is additive; nothing existing breaks).

### Phase P — install + verify

- [ ] **P1.** Stage the changed item facets (`services/lib/okf-core.js`, `services/lib/tools.js`, `app/src/query/*` + `app/src/overview/*` + `app/src/lib/api.ts`, `agents/okf-ingest/AGENT.md`, `skills/okf-bundle-schema/SKILL.md`, `docs/`) into a fresh staging dir; **`app_build({name:"OKF Knowledge Base", dir:<staging>, id:"okf-knowledge-base"})`** (id preserved — in-place update). **No `src/` file in this scope-add.**
- [ ] **P2.** Restart the service (`POST /api/services/okf-knowledge-base {"action":"restart"}`); confirm `GET /tools` is **21**, and with a person-bearing bundle the app Query tab shows the teal person node + legend, the `kind` column, and the person pill in the concept index.
- [ ] **P3.** Run the full e2e suite (`BOS_PREVIEW_URL` + `npx playwright test e2e/okf-knowledge-base.spec.ts`) — O1–O6 **plus** all prior phases' tests pass.

**Notes (person scope-add)**
- **`kind` is derived, never stored-by-hand** (ADR-011): the only authority is `rebuildIndex` reading `person_terms`; the `concept-index.md` frontmatter is a cached, regenerable view. A person's display name keeps original case; matching is lowercased.
- **`person_terms` is NFR-005-preserved, not rewritten by the write path** — it round-trips verbatim on `okf_upsert_concept` (frontmerge) and on `okf_merge_concepts` only when the from-term is a person being canonicalized (J3).
- **Search is unchanged** — the whole feature is "put the person's name in the vocabulary and tag it"; the deterministic term-name match already does the rest. This is why the surface stays 21 and there is no new entity.
- **Pre-person-kind bundles need no migration** — the trust path defaults `kind` to `topic`; the next rebuild (any write, or an explicit lint/rebuild) populates `kind` from the then-present `person_terms`.

---

## Ingest chunking + job trajectory scope-add (FR-055/056/057/058, US11/US12, SC-017/018) — appended 2026-10-12

**Baseline**: all prior scope-adds (auto-ingest, cancel/delete, person-kind, delete/dialog/summary fixes). This section adds **two** capabilities: **ingest chunking** (mechanical pre-split in `okf_add_raw_source` so the agent's per-chunk context stays bounded) and **job trajectory** (the launcher captures the full NDJSON stream; the app renders it as collapsible tool-call cards).

**Invariants (ADR-012 + ADR-013 — do not deviate)**:
- **No new tools** — the surface stays **21** (SC-007). Chunking is a mechanical step inside `okf_add_raw_source` (an existing tool); trajectory is a job-record field + app rendering (no new tool, no new route).
- **No `src/` change** — pure `marketplace-item`. The one generic `src/` abort route from the cancel/delete scope-add is untouched.
- **Chunking is worker-side** — `okf_add_raw_source` handler (in `tools.js`) calls the pure `chunkSource()` function (in `okf-core.js`) and writes chunks to `.chunks/<docId>/NNN.md`. The agent never reads the full source. `okf_ingest` does NOT fetch or chunk (FR-046 preserved).
- **`.chunks/` is operational, not `raw/`** — sibling of `.jobs/`, excluded from export by default, clear-then-rewrite on re-ingest (not append-only — NFR-006 applies to `raw/`, not `.chunks/`).
- **Trajectory is the raw NDJSON events** — `run_started`, `tool`, `tool_result`, `reasoning_delta`, `final_text`, `done`, `error`. Wire type for a tool call is `{type:"tool", tool, input}` (NOT `tool_call`); pairing is positional (no `callId`). Stored in the job record's `.jobs/<id>.md` frontmatter.
- **`maxChunkSize` config** — default 32000 chars (~8K tokens), in `config/okf-knowledge-base.json` + `service.json` configSchema, exposed via `GET /config`.
- **Additive / backward-compatible** — a source within `maxChunkSize` produces a single chunk (no behavioral change). A job with no trajectory (zero events) shows "No trajectory captured."

**Dependency order**: **Q** (chunker function + `okf_add_raw_source` integration) is the foundation for chunking; **R** (config + agent/skill conventions) is independent of Q's I/O wiring; **S** (trajectory capture in `delegate-bridge.js`) is independent of Q; **T** (app trajectory rendering + mockup) needs S; **U** (e2e) needs Q+R+S+T; **V** (install + verify) last.

---

### Phase Q — chunker + `okf_add_raw_source` integration (foundation, `services/lib/`)

- [ ] **Q1.** `services/lib/okf-core.js` — add **`chunkSource(content, maxChunkSize)`**: a **pure function** (no I/O) that splits a markdown string into bounded chunks. Algorithm: (1) split on heading boundaries (lines starting with `#`/`##`/`###`/etc.); (2) if a heading-delimited section exceeds `maxChunkSize`, split further at paragraph boundaries (double-newline); (3) if a paragraph exceeds `maxChunkSize`, split at sentence boundaries (period/space). Each chunk is an object `{chunk: N, total: M, headingPath: [ancestor heading strings], content: "…"}`. A source within `maxChunkSize` → single chunk (no splitting). A headingless source → paragraph/sentence split, empty `headingPath`. **Export** it from the module.
- [ ] **Q2.** `services/lib/okf-core.js` — add **`writeChunks(bDir, docId, chunks)`**: writes each chunk to `.chunks/<docId>/<NNN>.md` (NNN zero-padded 3-digit ordinal) with frontmatter `{chunk, total, headingPath}` + the chunk content. **Clear-then-rewrite**: delete existing `.chunks/<docId>/` dir first (it's a derived cache, not `raw/`). Creates the `.chunks/` and `.chunks/<docId>/` dirs if absent. Uses the existing `vfs.writeText`/`vfs.mkdir`/`vfs.remove` primitives (loopback `/api/fs`).
- [ ] **Q3.** `services/lib/tools.js` — modify the **`okf_add_raw_source` handler**: after the existing `addRawSource` call (which reads the source via VFS and writes it to `raw/`), **additionally**: (a) derive `docId` via the existing `docIdForSource(source)` function; (b) call `core.chunkSource(content, maxChunkSize)` (the pure function from Q1); (c) call `core.writeChunks(bDir, docId, chunks)` (Q2); (d) **include the chunk paths in the response**: the handler's return value gains `{chunks: [{path: ".chunks/<docId>/001.md", ordinal: 1, total: N}, …], maxChunkSize}`. For a single-chunk source (within `maxChunkSize`), the response has one chunk entry (the full source) — no behavioral change for the agent. `maxChunkSize` is read from the service config (Q5).
- [ ] **Q4.** **Verify** (unit / manual): call `chunkSource` with (a) a small source (within `maxChunkSize`) → 1 chunk; (b) a source with 3 headings, each under `maxChunkSize` → 3 chunks, correct `headingPath`; (c) a source with one heading section exceeding `maxChunkSize` → that section is further split at paragraph/sentence boundaries; (d) a headingless source → paragraph/sentence split, empty `headingPath`. Verify `writeChunks` produces the correct file layout (`.chunks/<docId>/001.md` etc.) with correct frontmatter.

### Phase R — config + agent/skill conventions `[P]` (independent of Q's I/O)

- [ ] **R1.** `config/okf-knowledge-base.json` + `services/service.json` — add **`maxChunkSize`** (default **32000**) to the config schema + defaults. Read at service start (same lifecycle as `maxDepth`/`maxWorkers`). Exposed via `GET /config` (add it to the existing `getRuntime()` response if not already there).
- [ ] **R2.** `agents/okf-ingest/AGENT.md` — add a **"Chunk processing"** section to the ingest instructions: "After you call `okf_add_raw_source`, its response includes `chunks` — an array of `{path, ordinal, total}`. Process them **sequentially**: read `chunks[0].path` via `file_read`, decompose it into chapters, write them via `okf_upsert_concept`, then read `chunks[1].path`, etc. The `headingPath` frontmatter in each chunk tells you where you are in the document. **Write the document stub after the first chunk; write the TOC and rebuild the index after the last chunk.** For a source with a single chunk, the process is identical to the non-chunked path." The agent's **allowlist is unchanged** (no new tools — `file_read` and `okf_upsert_concept` are already granted).
- [ ] **R3.** `skills/okf-bundle-schema/SKILL.md` — add the **chunk frontmatter convention**: the chunk file format (`chunk`/`total`/`headingPath` frontmatter + content), the sequential processing protocol (one chunk at a time, in order, stub after chunk 1, TOC + index after the last chunk), and the note that `headingPath` is positional context (the agent still does its own chapter decomposition within each chunk — the chunk is a context window, not a chapter).

### Phase S — trajectory capture (`services/lib/delegate-bridge.js`)

- [ ] **S1.** `services/lib/delegate-bridge.js` — in the existing stream-reading loop (the one that parses `run_started` for the `runId` and the terminal `done` for finalization), **additionally parse every NDJSON line into an event object and push it to `job.trajectory`** (an array on the job record). The events are the raw parsed JSON objects: `{type:"run_started", …}`, `{type:"tool", tool, input}`, `{type:"tool_result", …}`, `{type:"reasoning_delta", …}`, `{type:"final_text", …}`, `{type:"done", result}`, `{type:"error", …}`. **No transformation** — store them as-is. The array grows as the stream is read (for a running job) and is complete when the terminal line arrives.
- [ ] **S2.** `services/lib/okf-core.js` — the job store's `createJob`/`updateJob`/`persistJob` must **carry the `trajectory` array** through the in-memory hot map and the persisted `.jobs/<id>.md` file (frontmatter array, same pattern as `concept-index.md`'s `terms:`). The array is serialized into the frontmatter on persist and deserialized on load. For a running job, the trajectory is persisted incrementally (on each event push) so a service restart mid-run doesn't lose the captured events.
- [ ] **S3.** `services/lib/http-bridge.js` — confirm `GET /jobs/<id>` returns the full job record **including `trajectory`** (it already returns the full record; the `trajectory` field is just a new field in that record — no new route needed). If the current implementation strips unknown fields, add `trajectory` to the passthrough list.
- [ ] **S4.** **Verify** (unit / manual): fire a mock-delegate run (via `OKF_DELEGATE_URL`) that emits a few `tool`/`tool_result` events + a `done`; confirm the job record's `trajectory` array contains all events in order; confirm `GET /jobs/<id>` returns the trajectory; confirm the `.jobs/<id>.md` file on disk contains the trajectory in its frontmatter.

### Phase T — app trajectory rendering + mockup `[P]` once S is done

- [ ] **T1.** `mockup.html` (via `ui-designer` delegation) — the Jobs-tab detail view (the expandable job row) gains a **trajectory section**: a scrollable list of collapsible cards. Sample data: a completed run with `run_started`, 3–4 `tool`+`tool_result` pairs (e.g. `web_fetch`, `okf_add_raw_source`, `okf_upsert_concept`×2), and a `done` terminal. The cards match the Self-Heal / Agentic Editor pattern: tool name + input summary (collapsed) → expandable to show full input and result. A `run_started` header card. A `done`/`error` terminal card. A "No trajectory captured" state for zero-event runs. The mockup is the binding contract — the app implements exactly what it shows.
- [ ] **T2.** `app/src/lib/api.ts` — the typed client for `GET /jobs/<id>` now surfaces the **`trajectory`** field (an array of event objects: `{type, tool?, input?, result?, …}`). Additive — the existing `getJob(id)` client just gains the new field in its return type.
- [ ] **T3.** `app/src/jobs/…` (JobDetail component) — render the **trajectory section** in the expandable job detail: a scrollable list of the `trajectory` events, each rendered as a collapsible card matched on `ev.type`: `run_started` → header card; `tool` + its immediately-following `tool_result` → a card (tool name + input summary collapsed → expandable to full input + result); `done` → terminal card (final output + `endedReason`); `error` → terminal error card; `reasoning_delta`/`final_text` → optional expandable "reasoning" section (or omitted for v1). **Running job**: the trajectory section updates as new events arrive (the existing polling loop re-fetches `GET /jobs/<id>` every 3s — the trajectory array grows). **No trajectory** (zero events): show "No trajectory captured — the run failed before producing events." **>100 events**: virtualize or paginate (the spec's edge case).
- [ ] **T4.** **Verify** (Playwright): with a job that has a trajectory (mock-delegate or a real completed run), clicking the job in the Jobs tab shows the trajectory section with the tool-call cards; expanding a card shows the input and result; the `done` terminal is visible; a job with no trajectory shows the "No trajectory" message.

### Phase U — e2e coverage (`e2e/okf-knowledge-base.spec.ts`)

- [ ] **U1. (FR-055, SC-017)** **chunking produces bounded chunks**: seed a large source (> `maxChunkSize`, with headings) into the VFS; call `okf_add_raw_source` (or trigger an ingest that does it); verify the response includes `chunks` with correct `total` and per-chunk `path`/`ordinal`; verify the chunk files exist at `.chunks/<docId>/NNN.md` with correct frontmatter (`chunk`, `total`, `headingPath`); verify each chunk's content is ≤ `maxChunkSize` characters.
- [ ] **U2. (FR-055)** **single-chunk source (no splitting)**: a source within `maxChunkSize` → `okf_add_raw_source` returns `chunks` with `total: 1`; the agent's processing is identical to the non-chunked path (one `file_read`, one decomposition pass).
- [ ] **U3. (FR-056)** **`maxChunkSize` config**: `GET /config` returns `maxChunkSize` (default 32000); changing it (via the service config) takes effect on the next `okf_add_raw_source` call (no code change needed).
- [ ] **U4. (FR-057)** **trajectory captured**: fire a mock-delegate run (via `OKF_DELEGATE_URL`) that emits `run_started` + 2–3 `tool`/`tool_result` pairs + `done`; verify `GET /jobs/<id>` returns the full `trajectory` array (all events, in order); verify the `.jobs/<id>.md` file on disk contains the trajectory.
- [ ] **U5. (FR-058, SC-018)** **app trajectory rendering**: with a job that has a trajectory, the Jobs-tab detail shows the trajectory section (tool-call cards); expanding a card shows input + result; the `done` terminal is visible. With a zero-event job, "No trajectory captured" is shown.
- [ ] **U6. (SC-007)** **surface still exactly 21** — the chunking + trajectory scope-add adds **no tools**; re-assert `GET /tools` is 21.
- [ ] **U7.** Full suite green — all prior auto-ingest, cancel/delete, person-kind, and delete/dialog/summary tests still pass (the chunking is inside an existing tool; the trajectory is an additive job field; nothing existing breaks).

### Phase V — install + verify

- [ ] **V1.** Stage the changed item facets (`services/lib/okf-core.js`, `services/lib/tools.js`, `services/lib/delegate-bridge.js`, `services/lib/http-bridge.js`, `config/okf-knowledge-base.json`, `services/service.json`, `app/src/jobs/*` + `app/src/lib/api.ts`, `agents/okf-ingest/AGENT.md`, `skills/okf-bundle-schema/SKILL.md`, `docs/`, `mockup.html`) into a fresh staging dir; **`app_build({name:"OKF Knowledge Base", dir:<staging>, id:"okf-knowledge-base"})`** (id preserved — in-place update). **No `src/` file in this scope-add.**
- [ ] **V2.** Restart the service (`POST /api/services/okf-knowledge-base {"action":"restart"}`); confirm `GET /tools` is **21**, `GET /config` includes `maxChunkSize`, and the app Jobs tab renders the trajectory section.
- [ ] **V3.** Run the full e2e suite (`BOS_PREVIEW_URL` + `npx playwright test e2e/okf-knowledge-base.spec.ts`) — U1–U7 **plus** all prior phases' tests pass.

**Notes (chunking + trajectory scope-add)**
- **Chunking is in `okf_add_raw_source`, not `okf_ingest`** (ADR-012/B1): the worker is a plain Node thread outside Next.js — it has no `web_fetch` and cannot pre-stage a URL source. Chunking happens inside the run, after `web_fetch` stages the source and the agent calls `okf_add_raw_source`. `okf_ingest` mints the job and fires the run with the chunk-processing instruction (no fetch, no chunk) — FR-046 preserved.
- **`.chunks/` is operational, not `raw/`** — excluded from export (like `.jobs/`), clear-then-rewrite on re-ingest (not append-only). The full source in `raw/` is the provenance; chunks are derived staging.
- **Trajectory is the raw NDJSON, not a summary** (ADR-013) — it's the audit log. The wire type for a tool call is `tool` (not `tool_call`); pairing is positional (no `callId`). The `error` terminal (the delegate route's catch block) is captured alongside `done`.
- **No new tools, no new routes, no `src/` change** — the surface stays 21; the trajectory is a job-record field surfaced on the existing `GET /jobs/<id>`; the chunking is inside the existing `okf_add_raw_source` handler.
- **`maxChunkSize` default 32000 chars (~8K tokens)** — conservative; a 351KB source becomes ~11 chunks, each well within the model's 524K context. The agent processes them sequentially (one `file_read` per chunk).

---

## Ingest efficiency scope-add (FR-059/FR-060, US13, SC-019) — appended 2026-10-13

**Baseline**: all prior scope-adds (auto-ingest, cancel/delete, person-kind, chunking, trajectory, docId fix, PDF-conversion fix, delete/dialog/summary fixes, reaper fix, addLink stub fix). This section adds **two** capabilities: **body-extraction write protocol** (the agent emits only metadata + interpretations; the service assembles the chapter body from `raw/`) and **configurable inactivity reaper** (the bound measures inactivity, not total duration; both bounds are user-configurable in Settings → Plugins).

**Invariants (ADR-014 — do not deviate)**:
- **No new tools** — the surface stays **21** (SC-007). `okf_upsert_concept` gains optional fields (`sourceRange`, `interpretations`); existing `body`-only calls are untouched (backward-compatible).
- **No `src/` change** — pure `marketplace-item`.
- **Verbatim-slice body invariant (SC-019)**: a stored chapter's body, with the LLM-authored interpretation blockquotes removed, MUST be a byte-identical slice of `raw/<sourceFile>`. The service does the extraction; the agent never re-types body text.
- **`headings.json` is per-doc** (`.chunks/<docId>/headings.json`), written alongside the chunks in `okf_add_raw_source` (clear-then-write, Risk #2). It is operational, excluded from export.
- **`lastEventAt` is a field on the per-job record** (`.jobs/<id>.md`), set on every trajectory event by the ADR-013 loop (one additive line). The reaper compares `now - lastEventAt` against the inactivity bound.
- **`maxTotalTimeoutMs` is new config** (default 6 h) alongside `jobFinalizeTimeoutMs` (default 30 min, now explicitly an *inactivity* bound). Both render in Settings → Plugins.
- **One call per chapter (D5)** — not batched. Each per-chapter `okf_upsert_concept` is small (metadata only) and is a `tool`/`tool_result` NDJSON event = a liveness heartbeat for the Part B reaper.
- **The `blockTemplate` from `okf_add_raw_source`/`addRawAsset`** is the agent's *reference* for the exact `assetLine` string to emit in `interpretations[].assetLine`; the service performs the actual insertion (D3/N7). The agent does not author the body around the template.

**Dependency order**: **W** (heading map + `chapterFromSourceRange` extractor, `okf-core.js`) is the foundation for Part A. **X** (`okf_upsert_concept` gains `sourceRange`/`interpretations`, `tools.js`) needs W. **Y** (config + `lastEventAt` + reaper rework, `config/` + `delegate-bridge.js` + `okf-core.js`) is independent of W/X. **Z** (AGENT.md + SKILL.md metadata-only protocol) is independent of the item wiring. **AA** (e2e + unit tests) needs W+X+Y. **AB** (install + verify) last.

---

### Phase W — heading map + `chapterFromSourceRange` extractor (foundation, `services/lib/okf-core.js`)

- [ ] **W1.** `chunkSource` (the existing pure function from Q1): when it walks the source for heading boundaries, **additionally** record each heading's **char offset** (`start`) and the **source length** (`sourceLength`). Return a `headings` array: `[{index, level, text, start, end}]` where `end` = the `start` of the next heading (or `sourceLength` for the last). Each chunk's frontmatter `headings:` list gains the **global indices** of its in-chunk headings **plus the immediate boundary heading** (the heading that comes *after* the chunk's content — so a `toHeading` merge can always target one; D1/F2). Export the `headings` array + `sourceLength` + `sourceFile` from `chunkSource`'s return value (or a separate `buildHeadingMap` function that `okf_add_raw_source` calls alongside `chunkSource`).
- [ ] **W2.** `writeChunks` (Q2) or `okf_add_raw_source` (Q3): **additionally** write `.chunks/<docId>/headings.json` = `{ "sourceFile": "raw/<name>.md", "headings": [{index, level, text, start, end}] }` in the **same clear-then-write window** as the chunks (delete the old `headings.json` first; Risk #2). `sourceFile` is the `raw/` path that `addRawSource` just registered.
- [ ] **W3.** `okf-core.js` — add **`chapterFromSourceRange(bDir, docId, sourceRange, interpretations, sourceFile)`**: a **pure function** (reads `raw/` + `headings.json` via the existing `vfs` primitives; writes nothing — returns the assembled body string). Logic: (a) read `.chunks/<docId>/headings.json`; **fail loud** if absent or if the `headings` count / `sourceLength` disagrees with the actual `raw/<sourceFile>` size (Risk #2 — surfaced by `okf_lint`); (b) resolve the slice: if `sourceRange.whole` → `[0, sourceLength]`; if `sourceRange.startHeading === -1` → `[0, headings[0].start]` (headingless preamble); else `[headings[sourceRange.startHeading].start, <end>]` where `<end>` is resolved by the end rule: `nextSameOrHigher` → the next heading with `level <= headings[startHeading].level` (or `sourceLength`); `toHeading` → `headings[sourceRange.toHeading].start`; (c) slice `raw/<sourceFile>` at `[start, end)` → the **verbatim body**; (d) for each `{assetLine, interpretation}` in `interpretations`: exact-substring match of `assetLine` in the body → insert the blockquote `\n> **Interpretation (LLM, at ingest):** <interpretation>\n` after the line containing `assetLine` (and rewrite the asset URL to the local `raw/assets/<docId>/<name>` per ADR-008/§7.5); fallback: filename match (last path segment of `assetLine`); fallback: append the blockquote at the end of the body with a `<!-- interpretation: <assetLine> -->` marker. **In all three placements, the body-minus-interpretations is the verbatim slice** (SC-019). **Export** the function for unit testing.
- [ ] **W4.** **Verify** (unit): (a) `chunkSource` on a 3-heading source returns the `headings` array with correct `start`/`end` offsets; (b) `writeChunks` + `okf_add_raw_source` produce a correct `headings.json` (shape, `sourceFile`, offsets); (c) `chapterFromSourceRange` with `nextSameOrHigher` extracts the correct verbatim slice (byte-identical to `raw/` for that range); (d) with `toHeading` (merge of two sections) the slice spans both; (e) with `whole:true` the slice is the entire source; (f) with `startHeading:-1` the slice is the preamble (before the first heading); (g) with one `interpretation` the body has the blockquote inserted after the matching asset line, and the body-minus-interpretation is the verbatim slice; (h) when `headings.json` is missing or disagrees with `raw/` size, the function throws (fail-loud, not silent mis-slice); (i) a chunk-boundary split section (a `##` section split by `maxChunkSize` into two chunks) is reassembled correctly (the `headings.json` has the full section's start/end, not per-chunk).

### Phase X — `okf_upsert_concept` gains `sourceRange` + `interpretations` (tools.js, needs W)

- [ ] **X1.** `services/lib/tools.js` — the **`okf_upsert_concept`** declaration: add **optional** `sourceRange` (object: `{startHeading: int, toHeading?: int, whole?: bool}`) and **optional** `interpretations` (array of `{assetLine: string, interpretation: string}`) to the `inputSchema`. Do NOT add a `sourceId` field (D4/F1 — the service resolves it from the concept id's `docId`). The `body` field stays optional (it already is). Precedence: **if `sourceRange` is present → the handler calls `core.chapterFromSourceRange(bDir, docId, sourceRange, interpretations, sourceFile)` to get the body; otherwise `body` is used as-is** (the existing path). `docId` is extracted from the concept id (`<docId>/<chId>`). `sourceFile` is read from `.chunks/<docId>/headings.json` (the `sourceFile` field, W2).
- [ ] **X2.** **Verify** (unit): a call with `{id:"doc/ch1", sourceRange:{startHeading:3}, frontmatter:{concepts:[...], summary:"..."}}` (no `body`) → the handler extracts the body from `raw/` via W3 and writes the chapter with frontmatter + extracted body. A call with `{id:"doc/ch1", body:"...", frontmatter:{...}}` (no `sourceRange`) → the existing path (body used as-is). A call with both `sourceRange` AND `body` → `sourceRange` wins (precedence). The `interpretations` array is passed through to W3.

### Phase Y — configurable inactivity reaper (`config/` + `delegate-bridge.js` + `okf-core.js`) — independent of W/X

- [ ] **Y1.** `services/lib/delegate-bridge.js` — in the existing trajectory-capture loop (S1, the one that appends every NDJSON event to `job.trajectory`), **additionally set `job.lastEventAt = new Date().toISOString()`** on every event (one additive line). The `lastEventAt` field is carried through the job store's in-memory hot map + persisted `.jobs/<id>.md` frontmatter (same pattern as `trajectory` — S2 already persists `trajectory`; add `lastEventAt` to the same persist path).
- [ ] **Y2.** `config/okf-knowledge-base.json` + `services/service.json` configSchema — **re-describe `jobFinalizeTimeoutMs`** (default 30 min = 1800000 ms) as an **inactivity** bound (the `description` field should say "inactivity timeout — the run is reaped if no trajectory event arrives for this long"). **Add `maxTotalTimeoutMs`** (default 6 h = 21600000 ms) with `title` + `description` ("maximum total runtime — the run is reaped if it has been running for this long regardless of activity; backstop against an alive-but-not-progressing run"). Both render in Settings → Plugins.
- [ ] **Y3.** `services/lib/okf-core.js` — **rework `reapStaleJobs`**: the reaper now fires when **either** `now - Date.parse(job.lastEventAt || job.startedAt) > jobFinalizeTimeoutMs` (inactivity) **OR** `now - Date.parse(job.startedAt || job.queuedAt) > maxTotalTimeoutMs` (total backstop). The `error` message distinguishes which bound tripped: inactivity → "no progress (trajectory event) for <bound>; the run was alive but silent (a long model generation, a provider stall, or a BOS restart that dropped the stream)…"; total backstop → "exceeded the maximum total runtime (<bound>) without reaching a terminal state; the run was active but not progressing." Both bounds are read from the service config (Y2). The existing terminal-state handling (completed/cancelled/failed are not reaped) is unchanged.
- [ ] **Y4.** **Verify** (unit): (a) a job with `lastEventAt` 31 min ago and `startedAt` 10 min ago → reaped (inactivity bound tripped); (b) a job with `lastEventAt` 5 min ago and `startedAt` 35 min ago → NOT reaped (active within inactivity bound, under total bound); (c) a job with `lastEventAt` 10 min ago and `startedAt` 7 h ago → reaped (total backstop tripped); (d) a terminal job (completed/cancelled/failed) → NOT reaped (unchanged); (e) the `error` message correctly names which bound tripped.

### Phase Z — AGENT.md + SKILL.md metadata-only write protocol — independent of W/X/Y

- [ ] **Z1.** `agents/okf-ingest/AGENT.md` — add a **"Chapter write protocol"** section: "When you write a chapter via `okf_upsert_concept`, **do NOT pass the chapter's body text in the `body` field** — the service extracts it from the source. Instead, pass: (a) `id`: `'<docId>/<chId>'`; (b) `sourceRange`: `{startHeading: <the global heading index from the chunk's `headings:` frontmatter>}` — use `toHeading` if you are merging two sections into one chapter, `whole: true` for a headingless source, `startHeading: -1` for a preamble before the first heading; (c) `frontmatter`: the metadata you authored (`concepts`, `summary`, `person_terms`, `title`, `status`, `sources`); (d) `interpretations`: an array of `{assetLine, interpretation}` for each inline asset you interpreted (the `assetLine` is the exact line from the chunk you read — copy it verbatim; the `interpretation` is your text). The service assembles the chapter: frontmatter + verbatim body slice + your interpretations. **One `okf_upsert_concept` call per chapter** (not batched)."
- [ ] **Z2.** `skills/okf-bundle-schema/SKILL.md` — add the **metadata-only write convention**: the `sourceRange` object shape (`startHeading` / `toHeading` / `whole`), the `interpretations` array shape, the heading-index reference (the chunk's `headings:` frontmatter list carries the global indices), the end-rule semantics (`nextSameOrHigher` = default, `toHeading` = merge), the `whole: true` case (no-heading source), the `startHeading: -1` case (preamble), and the note that the `blockTemplate` from `okf_add_raw_source`/`addRawAsset` is the agent's reference for the `assetLine` string (the service does the insertion, the agent does not author the body around the template). The allowlist is unchanged.
- [ ] **Z3.** **Verify** (agent-level, exercised in the implement e2e): the agent's `okf_upsert_concept` calls in a real or mock run carry `sourceRange` (and `interpretations` where there are assets) and **not** a `body` of source text.

### Phase AA — e2e + unit tests (`e2e/okf-knowledge-base.spec.ts` + `tests/`)

- [ ] **AA1. (FR-060, SC-019)** **verbatim-slice invariant (e2e)**: ingest a structured source (seed it in the VFS, call `okf_add_raw_source` to get the chunks + headings.json, then drive `chapterFromSourceRange` or `okf_upsert_concept` with `sourceRange` for 2–3 chapters); assert each stored chapter's body, with interpretation blockquotes removed, is **byte-identical** to the corresponding slice of `raw/<sourceFile>`. Cover `nextSameOrHigher`, `toHeading` (merge), and `whole:true` (no-heading).
- [ ] **AA2. (FR-060)** **no body re-emission (e2e / trajectory assertion)**: in a mock-delegate run (or a real short run), assert the agent's `okf_upsert_concept` calls carry `sourceRange` and **not** a `body` field (or a `body` that is just the verbatim source text). The per-chapter output is bounded by the metadata.
- [ ] **AA3. (FR-059, US13 acceptance 2)** **inactivity reaper (e2e)**: a mock-delegate run that emits events then goes **silent** past a (short, config-set) `jobFinalizeTimeoutMs` → reaped `failed` with the inactivity message. A mock-delegate run that keeps emitting events (one per second) past the *total* 30 min → **NOT** reaped (active within inactivity bound). *(Use a short test timeout — set `jobFinalizeTimeoutMs` to e.g. 5 s in the test config.)*
- [ ] **AA4. (FR-059, US13 acceptance 3)** **config surface (e2e)**: `GET /config` (or the service config) exposes `jobFinalizeTimeoutMs` + `maxTotalTimeoutMs`; changing them is honored (set a short value, trigger a reaped run, confirm the short bound was used).
- [ ] **AA5. (SC-007)** **surface still exactly 21** — the efficiency scope-add adds **no tools**; re-assert `GET /tools` is 21.
- [ ] **AA6.** Full suite green — all prior auto-ingest, cancel/delete, person-kind, chunking, trajectory, and fix tests still pass (the `sourceRange`/`interpretations` fields are additive; the reaper rework is in-place; nothing existing breaks).
- [ ] **AA7. (unit)** `tests/chapter-from-source-range.test.mjs` — the W4 verification cases (verbatim slice for each end rule, interpretation insertion + fallbacks, fail-loud on mismatch). `tests/reap-stale-jobs.test.mjs` — the Y4 verification cases (inactivity vs total vs terminal). Run both offline (no service, no VFS — pure functions + a mock `vfs` object).

### Phase AB — install + verify

- [ ] **AB1.** Stage the changed item facets (`services/lib/okf-core.js`, `services/lib/tools.js`, `services/lib/delegate-bridge.js`, `config/okf-knowledge-base.json`, `services/service.json`, `agents/okf-ingest/AGENT.md`, `skills/okf-bundle-schema/SKILL.md`, `docs/`) into a fresh staging dir; **`app_build({name:"OKF Knowledge Base", dir:<staging>, id:"okf-knowledge-base"})`** (id preserved — in-place update). **No `src/` file in this scope-add. No app change.**
- [ ] **AB2.** Restart the service (`POST /api/services/okf-knowledge-base {"action":"restart"}`); confirm `GET /tools` is **21**, `GET /config` includes `jobFinalizeTimeoutMs` + `maxTotalTimeoutMs`, and `okf_add_raw_source` on a test source produces `headings.json` alongside the chunks.
- [ ] **AB3.** Run the full e2e suite (`BOS_PREVIEW_URL` + `npx playwright test e2e/okf-knowledge-base.spec.ts`) — AA1–AA7 **plus** all prior phases' tests pass.

---

## Retrieval at scale + legible graph scope-add (US14, FR-068–FR-073, SC-020–SC-024) — appended 2026-10-14

**Baseline**: every prior scope-add and fix, on marketplace branch `okf-retrieval-at-scale`. **Design**: `design.md` ADR-015 – ADR-022 + §12 (authoritative). **Plan**: Scope-add 5. **UI contract**: `mockup.html`.

**Invariants — do not deviate**:
- **No new tools** (21, SC-007); **no new dependency**; nothing written to disk for search (SC-023).
- **Test first, every phase**: write the phase's tests, run them, watch them fail for the stated reason, then implement. A test that passes before its implementation is rewritten.
- **Kept contracts stay green unchanged**: e2e US1 AS1 (`"what is our rollback policy"` → canary, `matchedConcept: "rollback"`), description anchoring (e2e 422-426), author-by-name (e2e 1376-1377).
- **No swallowed errors** in anything touched: a failed listing or read propagates (AGENTS.md §1.2); the `vfs.list(...).catch(() => [])` sites in `okf-core.js` are removed, not moved.
- **One mechanism**: the model replaces `derivedCache` *and* `graphCache`; `bundleToc()` feeds both the tool and `index.md`; `graphlayout.mjs` is the one layout.

**Dependency order**: **AC** (prereqs) → **AD** (test harness) → **AE** (model + queue) → **AF** (ledger + bundle TOC) and **AG** (search) in either order → **AH** (vocabulary, detail, summary cap) → **AI** (tool/route surfaces) → **AJ** (graph core + layout) → **AK** (app) → **AL** (agent text) `[P]` from AI on → **AM** (docs) → **AN** (e2e) → **AO** (install, measure, verify).

---

### Phase AC — prerequisites outside the item (`bos-core`)

- [x] **AC1.** `vfs.list` leaves out an entry gone between `readdir` and `stat` (ENOENT only), shared by `vfs.list` and `LocalFS` via `src/os/fs/dir-entries.ts` — `bos/vfs-list-vanished-entry` `99832327e`, test `tests/os/vfs-list-vanished-entry.test.ts`.
- [x] **AC2.** Seeded assistant's `okf_*` tools = the 21-tool surface; deferred ids current — `bos/okf-agent-tools` `1b0e72d7e`, test `tests/agent/okf-tool-allowlist.test.ts`.
- [ ] **AC3.** (user) Edit production's `data/agents/assistant/AGENT.md` by hand to the same lists.
- [ ] **AC4.** Merge AC1/AC2 into `claude` before this item is installed anywhere (AO).

### Phase AD — the test harness can see what the design claims

- [x] **AD1.** `tests/memfs-server.mjs` — `list` returns `size` and `modified` (mtime ms, bumped on every write) like `/api/fs`; add a per-op **request counter** with reset (`/__counts`), and a hook to make one `list` fail (for AE3).
- [x] **AD2.** `tests/fixtures/gen-bundle.mjs` — writes a generated bundle into the memfs: N documents × M chapters, terms, person terms, one name present **only** in one chapter body, a document and a term sharing a name, ledger entries with `ingestedAt`.

### Phase AE — the incremental model, one serial queue per bundle (ADR-016)

**Tests first** — `tests/derived-model.test.mjs`:
- [x] **AE1.** A chapter write on a 3,000-chapter bundle issues **O(1)** concept reads (memfs counter: the written file + its stat), and rewrites only `concept-index.md`, that document's `toc/`, and `index.md`.
- [x] **AE2.** A file changed behind the service's back (written straight into the memfs) — changed, added, deleted — is reflected by the next `search`/`readToc`/`listConcepts`, and that document's stored `toc/` is rewritten.
- [x] **AE3.** A failed `list` during refresh **rejects** the read and leaves the model as it was (never an empty bundle).
- [x] **AE4.** Two concurrent writers (two simulated runs: upserts + `recordSource` + `addLink`) lose no chapter, ledger entry or link; a search issued mid-write never sees a half-patched model; concurrent reads share one refresh (counter).
- [x] **AE5.** A chapter whose `stale_after` passes shows `stale` on the next read with no write in between.
- [x] **AE6.** Backlinks (`okf_backlinks`, `deleteConcept({rewriteBacklinks})`) come from the model — no second full read (counter).

**Implement** — `services/lib/okf-core.js`:
- [x] **AE7.** The model (§12.2) and `queue(bundle)`: serial, re-entrant by construction (public functions enqueue; internals don't), refresh single-flight on it.
- [x] **AE8.** Parallel `classifyBundle`/list (16); remove every `vfs.list(...).catch(() => [])` on the read path; errors propagate.
- [x] **AE9.** Patch paths for `upsertConcept`, `deleteConcept`, `addLink`, `addRawSource`; rebuild paths for `mergeConcepts`, import, `clearDocument`, `initBundle`, lint; `exportBundle` on the queue (rebuild only on drift). `recordSource`, `links.json`, `appendLog` under the queue.
- [x] **AE10.** Delete `derivedCache`, `graphCache`, `markGraphDirty`, `ensureGraph`; `isStale` evaluated at read.
- [x] **AE11.** (found while doing AE8) an unparseable `links.json` or `raw/sources.json` was read as empty and overwritten by the next write — both now throw and are left untouched (`tests/derived-model.test.mjs` AE7).

### Phase AF — first-added date and the bundle TOC (ADR-017)

**Tests first** — `tests/bundle-toc.test.mjs`:
- [x] **AF1.** `recordSource` keeps `firstIngestedAt` across a re-acquire; a legacy entry without it falls back to its `ingestedAt`.
- [x] **AF2.** A 500-document bundle pages completely through `okf_read_toc({bundle})` (default 50, max 200, `clamped`/`maxLimit` when over), newest first, ties by id, each entry `{id, title, chapters, summary, addedAt, attention}`, **no vocabulary**; the order is **unchanged after a real URL re-ingest** of the oldest document driven through `okf_add_raw_source` (not a hand-written ledger).
- [x] **AF3.** `index.md` lists documents in the same order as AF2 and replaces "Concepts covered" with the term count + a link to `concept-index.md`.

**Implement**: `recordSource` `firstIngestedAt`; `addedAt` resolution (ledger → `created_at` → `updated_at`); `bundleToc()`; `readToc(bundle)` without `docId`; `bundleIndexMarkdown()` from `bundleToc()`.

### Phase AG — search (ADR-015, ADR-018)

**Tests first** — `tests/full-text-search.test.mjs`:
- [x] **AG1. (SC-020)** A name present only in one chapter body → that chapter, `matchKind: "text"`, the name in `excerpt`; "Cordoba" finds "Córdoba" and the reverse; `api` does not match "rapid".
- [x] **AG2.** A document stub's author is found by name (`chId: ""`, as today).
- [x] **AG3.** `"what is our rollback policy"` → canary first, `matchedConcept: "rollback"`; `"migrations reviewed"` → pre-deploy, `matchedConcept: "deployment"` (anchored); a query of only stop words still searches.
- [x] **AG4.** Ranking: every-word matches above partial ones; term > title > summary > text within equal coverage; ties by `addedAt` then id; identical input → byte-identical output (FR-002).
- [x] **AG5.** Excerpt ≤ 3 sentences and ≤ 400 characters **including** ellipses; taken from the original text (a ligature/Hangul fixture proves folding never shifts it).
- [x] **AG6.** `limit` default 10, max 50 (`clamped`); `total`, `searched`, `matchedWords`; `groupBy: "document"` → ≤ 10 groups ordered by best hit, ≤ 5 hits each, `total` per group.
- [x] **AG7. (SC-023)** The bundle's file listing is identical before and after a search.

**Implement**: `fold`, stop words, word-start regexes, `searchFullText` (§12.3) over `model.chapters ∪ model.docs`, BM25-style score, per-sentence excerpt, grouping; `search()` returns the ADR-018 object; `searchIndex` removed (term matching is part of the scan). *AG7 passed before the implementation — search wrote nothing then either — and is kept as the guard that the new search still writes nothing.*

### Phase AH — vocabulary, bundle detail, summary cap (ADR-019, ADR-021, ADR-020)

**Tests first** — `tests/paged-vocabulary.test.mjs`:
- [x] **AH1.** `listConcepts({query, kind, status, offset, limit})` — folded substring on the name, default 100 / max 500, `covers` ≤ 5 + `coversTotal`, `total`; `type` answers with the pointer, not a list.
- [x] **AH2.** `bundleDetail` returns `{health, indexGeneratedAt}` only.
- [x] **AH3.** Upserting a **document** stub with a summary of 3 sentences, or 321 characters, is rejected with the limit in the message; a chapter summary is not checked; a stored long summary is never rewritten.

**Implement** in `okf-core.js`.

### Phase AI — tool and route surfaces

**Tests first** — extend `tests/ingest-agent-contract.test.mjs` / add `tests/tool-surface.test.mjs`:
- [x] **AI1.** Still exactly 21 declarations; `okf_search` description no longer says "NOT full text" and names `groupBy`; `okf_read_toc` declares `docId` optional; `okf_list_concepts` declares `query`/`offset`/`limit`; the no-match note (~378) names what was searched.
- [x] **AI2.** `GET /bundles/<b>/toc`, `GET /bundles/<b>/concepts`, search with `groupBy`, slim `GET /bundles/<b>` — each returns exactly the tool's object (one core function, two surfaces).

**Implement**: `services/lib/tools.js` DECLARATIONS + handlers; `services/lib/http-bridge.js`; `services/service.json` group description.

### Phase AJ — the graph: identity and layout (ADR-022)

**Tests first** — `tests/graph-identity.test.mjs`, `tests/graph-layout.test.mjs`:
- [ ] **AJ1. (SC-024)** `core.graph()` on a bundle with document "deployment" and term "deployment" → two nodes (`doc:deployment`, `concept:deployment`), each with its own edges; edges reference keys.
- [ ] **AJ2. (SC-024)** `graphlayout.mjs`: after settle, no two circles overlap (distance ≥ r₁+r₂) on a generated 400-node graph; a chapter ends nearer its own document than the median node; `fitBox(ids)` covers exactly those nodes plus label margin.
- [ ] **AJ3.** `matchSet(hits, nodes, query)` = hit chapters + their documents + matched terms + documents whose title contains the query.

**Implement**: namespaced ids in `core.graph()`; `app/src/lib/graphlayout.mjs` + `.d.mts` (seeding, per-kind springs, cooling, collision, `fitBox`, `matchSet`, a `step()` the app drives in animation-frame chunks); `forceSim.ts` becomes a thin adapter over it or is removed.

### Phase AK — the app (per `mockup.html`)

- [ ] **AK1.** `lib/serviceClient.ts`, `types.ts` — `fetchBundleToc`, `fetchConcepts`, search `groupBy` + new row fields, slim detail.
- [ ] **AK2.** `overview/Overview.tsx`, `BundleDetail.tsx` — counts from the slim detail; tabs load their own pages.
- [ ] **AK3.** `overview/DocumentsView.tsx` — the paged bundle TOC (summary, chapter count, "added", attention, Previous/Next).
- [ ] **AK4.** `overview/ConceptIndexView.tsx` — server-side filter + paging; the merge picker is a type-ahead over `/concepts?query=`.
- [ ] **AK5.** `query/SearchHits.tsx` (new) — ranked hits, match-kind badge, highlighted excerpt, Chapters / By document, "Nothing matched" naming what was searched.
- [ ] **AK6.** `query/QueryTab.tsx`, `TableView.tsx` — a query shows `SearchHits` in Table; no bundle-detail fetch; `matchedConcept` handled when null.
- [ ] **AK7.** `query/ReaderPane.tsx` — the term view via `/concepts?query=<term>&limit=1` and the search route.
- [ ] **AK8.** `query/GraphView.tsx` + `index.css` — keyed ids; fit on load; + / − / fit controls and hint; edge labels on hover only; labels below nodes at constant size (documents always; others zoomed ≥ 1.25, hovered + neighbours, selected, matched); search fades the rest (nodes ~9 %, edges ~3 %) and fits the matches; clearing re-fits all.
- [ ] **AK9.** Rebuild `app/dist/` (esbuild, BOS `buildAppDir` options); `tsc` over `app/src` clean.

### Phase AL — agent-facing text `[P]` once AI's shapes are fixed

- [ ] **AL1.** `skills/okf-lookup/SKILL.md` (new) — FR-071's process: choose the bundle (`okf_list_bundles`); **browse** (`okf_read_toc({bundle})`, paged) or **search** (`okf_search`, `groupBy` for "which documents"); the document's TOC; read only the chapters that answer; cite chapter id + `source`; flag stale/deprecated; keep KB content apart from own knowledge; an empty search is not absence until a rephrase and the TOC agree; a lookup writes nothing, starts no ingest, never reads `raw/`.
- [ ] **AL2.** `skills/okf-bundle-schema/SKILL.md` — §Query → one-line pointer to `okf-lookup`; "extend before you create" → `okf_list_concepts({query})`.
- [ ] **AL3.** `agents/okf-ingest/AGENT.md` — vocabulary checks by query (`okf_list_concepts({query})`, `okf_search`), never the whole list; the document summary cap (≤ 2 sentences, ≤ 300 characters).
- [ ] **AL4.** `tests/ingest-agent-contract.test.mjs` — the prompt never tells the agent to list the whole vocabulary; it states the summary cap; `okf-lookup` exists and names only tools on the surface.

### Phase AM — docs

- [ ] **AM1.** `docs/dev/OKF Knowledge Base/` — `tools.md` (search, two-level TOC, paged vocabulary, slim detail), the model/queue/refresh and its signature limits, the graph.
- [ ] **AM2.** `docs/usage/OKF Knowledge Base/` — browsing vs searching, what the badges mean, the graph controls; troubleshooting: an mtime-preserving copy needs `okf_lint` to be seen.

### Phase AN — e2e (`e2e/okf-knowledge-base.spec.ts`)

- [ ] **AN1.** SC-020–SC-024 end to end against the running service (bundle fixtures written via the API at run time).
- [ ] **AN2.** Move the assertions ADR-018/021 deliberately change: default row counts; `detail.documents`/`detail.conceptIndex` (~532, 542, 1387+, 1767) → the paged routes; the merge flow (~575-583) through the type-ahead; graph ids.
- [ ] **AN3.** US1 AS1, e2e 422-426 and 1376-1377 pass **unchanged**; full suite green.

### Phase AO — install, measure, verify

- [ ] **AO1.** AC4 done (both `bos-core` fixes merged and deployed).
- [ ] **AO2.** All `tests/*.test.mjs` green; e2e green on a preview.
- [ ] **AO3.** On the deployment: time one `/api/fs` `list` and `read`, a refresh of the largest real bundle, and p95 of 20 searches; record them in `design.md` §12.6 against ADR-015/016's numbers. Above the thresholds → stop and revise the design (§10 risk 12), don't tune around it.
- [ ] **AO4.** Merge `okf-retrieval-at-scale` into the marketplace's `main`; restart the OKF service; `GET /tools` = 21; open the app: Documents paged, Concept Index filtered, a search shows hits with excerpts, the graph spreads, fits and focuses.
