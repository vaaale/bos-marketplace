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
