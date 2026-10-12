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
