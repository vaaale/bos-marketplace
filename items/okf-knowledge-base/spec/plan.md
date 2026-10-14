# Implementation Plan: OKF Knowledge Base — auto-ingest + job cancel/delete

**Branch**: `bos/okf-docid-fix` | **Date**: 2026-10-11 | **Spec**: `item-okf-knowledge-base/spec.md`
**Design**: `item-okf-knowledge-base/design.md` (authoritative — this plan folds its classification + ADRs in; it does not re-litigate them)
**UI contract**: `item-okf-knowledge-base/mockup.html` (binding — the app implements it directly, incl. the Jobs cancel/delete surface)

This plan **replaces** the pre-auto-ingest plan (which described the 18-tool dispatcher model with sub-agent → service HTTP job callbacks + an assistant safety-net, and zero `src/` changes). It is the plan for the **current** item state plus the **job cancel/delete scope-add**: ingest is **auto-triggered and headless** (`okf_ingest` returns a `jobId` immediately; the worker fires the run and owns its finalization), the job surface is **21 tools** (adds `okf_list_jobs`, `okf_cancel_job`, `okf_delete_job`), jobs carry a distinct **`cancelled`** terminal state, and cancelling a running job goes through **one generic `src/` platform route** (`POST /api/subagents/[runId]/abort`) that the worker consumes over loopback.

## Summary

The item already implements (and this plan carries forward, not re-derives): the **two-level derived index** (`concept-index.md` + per-doc `toc/<id>.md`, O(V), regenerable), **deterministic concept-anchored `okf_search`** (no LLM in the match; full documents/chapters, never snippets), the **standalone master-detail app** (Overview / Jobs / Query, force-directed graph), the **inline-asset pipeline** (download + interpret at ingest, store link + interpretation), and the **auto-triggered headless ingest** (ADR-005: the worker's `delegate-bridge.js` fires `POST /api/subagents/delegate` and `okf_ingest` returns a `jobId` immediately; ADR-006: the **launcher** owns finalization from the run's terminal `endedReason` + a **stale reaper**; the `okf-ingest` agent carries a self-sufficient allowlist).

**This plan's new scope (the job cancel/delete scope-add, FR-050/051/052, US8 scenarios 4–6, SC-014/015):**

1. **Cancel a running job** — the worker captures the run's `runId` (from the `run_started` line it already receives on the delegate stream) and, on cancel, calls the **one new generic `src/` route** `POST /api/subagents/[runId]/abort` (the HTTP face of the existing in-process `abortHeadlessRun`); the run ends with `endedReason:"cancelled"` and the launcher writes the distinct **`cancelled`** terminal state. Nested reference runs are **independent jobs**, each cancelled by its own `runId` (ADR-010/S1 — not a family cascade).
2. **Delete a non-running job** — worker job-store only; removes the record, never bundle content; a running job is rejected (409), a missing one is a clean 404 (FR-051).
3. **Two new agent tools** — `okf_cancel_job {jobId}` and `okf_delete_job {jobId}` (surface **21**); the app's Jobs tab gains a **Cancel** control (running/queued) and a **Delete** control (non-running) driving the same worker operations via `POST /jobs/<id>/cancel` and `DELETE /jobs/<id>` (ADR-003: one capability, two surfaces).
4. **The `cancelled` lifecycle state** — `queued → running → completed | cancelled | failed`; `cancelled` is terminal and distinct from `failed` (an intentional stop, not an error).

**Mixed target** (spec App Target): **`marketplace-item` (primary) + one small `bos-core` mechanism** — the single additive, **generic** `src/app/api/subagents/[runId]/abort/route.ts`. It carries no OKF knowledge (no job store, no bundle, no agent id) and serves any fire-and-forget headless consumer; the item merely consumes it over loopback, exactly as it already consumes `/api/fs` and `POST /api/subagents/delegate`. No other `src/` file changes.

## Technical Context

**Language/Version**: Service = plain **Node.js** (worker thread, dependency-free — the installed `okf-core.js`/`vfs-bridge.js`/`http-bridge.js` already are). **One `src/` file** = **TypeScript** Next.js route handler (`src/app/api/subagents/[runId]/abort/route.ts`). App = **TypeScript/TSX** (esbuild-bundled by `app_build`; React provided by the bundler, no `npm install`).

**Primary Dependencies**: **None new.** Service reuses `okf-core.js`, `vfs-bridge.js`, `http-bridge.js`, `delegate-bridge.js`, and the 039 `deploymentMode:"tools"` IPC. The one `src/` route imports the existing `abortHeadlessRun` from `@/lib/agent/subagents/run-registry`. The app uses React (bundled). No vector/keyword/embedding/SQL, no new runtime package.

**Storage**: **Files under the VFS** at `/KnowledgeBase/<bundle>/`, reached through the loopback `/api/fs` + `/api/fs/raw` bridge. OKF chapter/concept `.md` is the **source of truth**; `concept-index.md` + `toc/<id>.md` are **derived** `.md` (regenerable, never sole source of truth). `raw/` immutable + `raw/assets/<docId>/` inline assets. **Job records** persist under `<bundleRoot>/.jobs/<id>.md` (restart survival) with an in-memory hot map; operational state, **not** OKF content (excluded from export by default — design.md Risk #2).

**The headless run boundary (load-bearing for cancel)**: the run executes in the **main Next.js process** (`runSubAgent`); the job is owned by the **service worker** (a separate process). The worker's `delegate-bridge.js` **fires `POST /api/subagents/delegate`, captures the `runId` from the first `run_started` NDJSON line, and holds the open stream** — so it can (a) finalize the job from the terminal line (ADR-006) and (b) cancel the run by calling the generic abort route with the captured `runId` (ADR-010). The run-registry is process-local (`globalThis`), which is why the abort must go through an **in-process** `src/` route in the same Next.js instance (single-user, true for this item — design.md Risk #4).

**Testing**: **Playwright e2e** — item-local `e2e/okf-knowledge-base.spec.ts` (feature-id = `okf-knowledge-base`), run via `BOS_PREVIEW_URL` + `npx playwright test`. **This scope-add's tests** (beyond the existing auto-ingest suite): the **21-tool surface** (SC-007 — `okf_cancel_job`/`okf_delete_job` present, the 16 removed absent); **`okf_list_jobs`** returns the same records as `GET /jobs` incl. `cancelled` (FR-048); **cancel** — a running job → `okf_cancel_job`/`POST /jobs/<id>/cancel` → `cancelled` terminal (distinct from failed), record + written content preserved, cancel of a terminal job is a no-op (SC-014, US8-4); **delete** — a non-running job is removed and bundle content untouched, a running job is rejected (409), a missing job is a clean 404 (SC-015, US8-5/6); **the `src/` abort route** — `POST /api/subagents/<runId>/abort` on a live run returns `{aborted:true}` and the run ends `cancelled`; on a finished/unknown runId returns `{aborted:false}` (idempotent) (FR-052); **queued-window cancel** — a cancel before `run_started` aborts the moment the `runId` is captured (ADR-010/S4); the **app Jobs tab** — Cancel control on running rows, Delete control on non-running rows, the `cancelled` dot (FR-041, mockup contract). For the run-dependent tests, the established **mock-delegate** seam (`OKF_DELEGATE_URL` env override in `delegate-bridge.js`) makes the headless run deterministic and instant — cancel/delete tests drive a mock run that emits `run_started` then stays open, so cancel can be asserted without a 10-minute real agent.

**Target Platform**: BOS container. **Project Type**: **Marketplace item** (service + app + agent + skill facets, `app_build` into `data/user-apps/items/okf-knowledge-base/`, **id preserved**) **+ one additive `src/` route** committed alongside (a separate `bos-core` file, not part of the item).

**Constraints**: No vector/keyword/embedding/SQL (NFR-002). Full documents/chapters, never snippets (NFR-003). 21-tool surface fixed — app views add no tools (FR-036/037). Writes atomic, path-guarded, unknown frontmatter keys preserved (NFR-005/006). `raw/` immutable. Derived index regenerable (NFR-004). Single-user (NFR-008). The `src/` route stays **generic** — no OKF knowledge (FR-052). Cancel is a **stop, not a rollback** — partial content preserved, index regenerable (ADR-010/S4). Delete touches **only** the job record (FR-051).

## Constitution Check

*GATE: must pass before implementation. Re-check after the plan's structure is fixed.*

Constitution: `/Specs/bos-system-specs/.specify/memory/constitution.md`.

| # | Principle | Compliance |
|---|---|---|
| I | **BOS source is read-only for marketplace features** — a marketplace item never edits `src/` to serve its needs | ✅ **Mixed, and the `src/` is generic + additive.** The item touches only `data/user-apps/items/okf-knowledge-base/` for its facets. The **one** `src/` file — `POST /api/subagents/[runId]/abort` — does **not** special-case OKF (no job store, no bundle, no agent id); it is the HTTP face of the existing in-process `abortHeadlessRun`, consumable by **any** fire-and-forget headless consumer (self-heal already calls `abortHeadlessRun` in-process). It is a new file, not an edit to an existing route/signature. The item **consumes** it over loopback like `/api/fs` and `POST /api/subagents/delegate`. This is the one deliberate, documented exception (spec App Target; design.md §1 + Constitution I note). |
| II | **Server Authority & SSR Boundary** — storage in the VFS, owned by the service | ✅ All OKF storage, the derived index, and the job records live under `/KnowledgeBase/`, owned and reached by the service worker through the loopback VFS bridge. The `src/` route is server-side (in-process, calls the run-registry); the app iframe + assistant reach everything over HTTP. No OKF logic in the app bundle. |
| III | **Data is human-readable, non-lossy** | ✅ Source of truth is OKF `.md`; the derived index is `.md` (regenerable). Job records are `.md` under `.jobs/` (operational, human-readable). Unknown frontmatter keys preserved verbatim (NFR-005). `raw/` immutable. No embeddings/vectors/SQL. |
| IV | **No hidden state; deterministic** | ✅ `okf_search` is deterministic. The derived index is regenerable. Job lifecycle is observable (queued/running/completed/cancelled/failed) and the **terminal state is derived from the run's own `endedReason`** (ADR-006) — there is no separate cancel write path that could drift from the run (ADR-010). |
| V | **Least privilege / scoped tools** | ✅ 21-tool surface (FR-037). The `okf-ingest` sub-agent allowlist (design.md §8.4): `okf_ingest` (fire nested reference jobs — its only job-lifecycle tool) + `okf_add_raw_source` + the read/organize tools + 5 acquisition tools + 2 VFS reads; **not** `okf_list_jobs`/`okf_cancel_job`/`okf_delete_job` (top-level/app concerns), **not** `run_command`/`agent_delegate`/the full surface (NFR-009). Job control stays a top-level-assistant + app surface. |
| VI | **Atomic, guarded writes** | ✅ Concept/index/toc writes reuse `okf-core`'s atomic write + path-guard. Cancel/delete job operations are job-store only and never mutate bundle content (FR-050/051). |
| VII | **Respect Boundaries** — confirm destructive ops; no new deps unasked | ✅ `okf_delete_job`/`okf_delete_concept`/`okf_delete_bundle` stay explicit-intent (the app gates them behind confirmation per the mockup). No new runtime dependency: the app reuses the in-app force sim (ADR-009); cancel reuses the existing run-registry (no new library). The one `src/` route is additive. |

**Verdict**: PASS — the mixed target is the only deviation from pure-marketplace, and it is the **generic, additive, documented** one the spec's App Target and design.md §1/Constitution-I already commit to. No Complexity Tracking rows required.

## Project Structure

### Documentation (this feature — the item's spec store, via `app_spec_*`)

```text
item-okf-knowledge-base/
├── spec.md                        # source of truth (FR-001…FR-052, NFR, SC-001…SC-015, 9 user stories)
├── design.md                      # architecture + ADRs 001–010 (authoritative; reviewed, one revision round)
├── mockup.html                    # binding UI contract — now incl. the Jobs cancel/delete surface + cancelled status
├── plan.md                        # THIS file
└── tasks.md                       # next step
```

### Source Code — the item (staged into a fresh dir, then installed by `app_build`) + one `src/` file

`app_build({name, dir, id:"okf-knowledge-base"})` carries the **item facets**; the **`src/` abort route is a separate `bos-core` file** committed on the branch alongside (not part of the item). Only the files this scope-add **changes** are listed — the auto-ingest baseline files (rework of `okf-core.js`, `vfs-bridge.js` binary, `http-bridge.js`, `tools.js` to 19, the app, `AGENT.md`, `SKILL.md`, `config/`) are carried forward unchanged by this plan.

```text
data/user-apps/items/okf-knowledge-base/
├── services/
│   ├── service.json               # configSchema: ADD jobFinalizeTimeoutMs (stale-reaper bound, ADR-006/FR-049)
│   └── lib/
│       ├── okf-core.js            # ADD to the job store: status ∈ {queued,running,completed,cancelled,failed};
│       │                          #   runId (set on run_started capture); cancelJob(jobId) → mark cancelled +
│       │                          #   signal delegate-bridge to abort; deleteJob(jobId) → remove record (running→
│       │                          #   rejected, missing→not-found); cancelled is terminal + distinct.
│       ├── delegate-bridge.js     # ADD: (a) CAPTURE runId from the first run_started NDJSON line and store it
│       │                          #   on the job; (b) CANCEL — POST /api/subagents/<runId>/abort over loopback,
│       │                          #   then confirm cancelled from the terminal line; (c) queued-window: on
│       │                          #   run_started, if the job is already cancelled, immediately fire the abort
│       │                          #   (ADR-010/S4). Existing: fire delegate, finalize from endedReason, reaper.
│       ├── http-bridge.js         # ADD app routes: POST /jobs/<id>/cancel → {cancelled,status} |
│       │                          #   {cancelled:false,reason}; DELETE /jobs/<id> → {deleted:true} | 409 (running)
│       │                          #   | 404 (missing). Existing: GET /jobs, GET /jobs/<id>, POST /jobs, …
│       └── tools.js               # ADD declarations + handlers: okf_cancel_job {jobId}, okf_delete_job {jobId}
│                                  #   (surface 19→21). okf_list_jobs already present. Read/write markings.
├── app/
│   └── src/
│       ├── jobs/JobsTab (or equivalent)   # ADD: Cancel control on running/queued rows (→ POST /jobs/<id>/cancel),
│       │                                  #   Delete control on non-running rows (→ DELETE /jobs/<id>); render the
│       │                                  #   cancelled status dot + a cancelled sample run. Per mockup.html.
│       └── lib/api.ts                     # ADD: cancelJob(id) + deleteJob(id) clients for the two new routes.
├── agents/
│   └── okf-ingest/AGENT.md        # allowlist now includes okf_ingest (nested reference jobs — its only
│                                  #   job-lifecycle tool); it does NOT get okf_list/cancel/delete_job. (design §8.4)
├── config/
│   └── okf-knowledge-base.json    # ADD jobFinalizeTimeoutMs (default, e.g. 1800000) alongside bundleRoot/port/maxDepth/maxWorkers
└── docs/
    └── dev/OKF Knowledge Base/
        ├── tool-surface.md        # UPDATE to the 21-tool surface (add okf_cancel_job/okf_delete_job) + the
        │                          #   abort-route dependency (the store-root spec-040 tool-surface.md is superseded)
        └── architecture.md        # ADD the cancel/delete + abort-route flow (per-run abort, cancelled state)

src/  (the ONE bos-core file — generic, not OKF-specific, FR-052):
src/app/api/subagents/[runId]/abort/route.ts
    # POST {runId} → import { abortHeadlessRun } from "@/lib/agent/subagents/run-registry";
    #   const aborted = abortHeadlessRun(runId);
    #   200 { aborted, runId }   (aborted:false when no such live run — idempotent)
    #   404 when runId missing/empty. No OKF knowledge — no job store, no bundle, no agent id.
    #   Sibling to src/app/api/subagents/[id]/route.ts (agent metadata, single-segment — no collision;
    #   this is the two-segment /subagents/<runId>/abort).
```

**Structure Decision**: **Marketplace item (all facets in one `app_build`, id preserved) + one additive generic `src/` route.** The `src/` route is the mixed target's single platform contribution; it is a new file (no existing signature change), so its blast radius is one route handler (Constitution IV). The `services/` path is a worker-thread service facet, **not** a `src/` fragment, so it does not trip the `contentOnly` harness. `docs/` is namespaced `OKF Knowledge Base` in `usage/` and `dev/`.

### Optional companion artifacts — evaluated, decided

- **`research.md`** — not warranted (all unknowns resolved in `design`; ADRs + §9 carry them).
- **`data-model.md`** — folded into design.md §5 (bundle layout) + §8.3 (job record incl. `cancelled` + `runId`) + this plan. The item's `docs/dev/.../data-model.md` documents the shipped shape.
- **`contracts/`** — the authoritative contracts are design.md §8.2 (21-tool I/O) + §8.3 (app REST routes incl. `POST /jobs/<id>/cancel`, `DELETE /jobs/<id>`) + the `src/` route's I/O (above). `tasks.md` pins them; e2e validates.

## Design Notes (folded from the current `design.md`)

- **ADR-005 (auto-trigger)** — `okf_ingest` returns `{jobId, job}` immediately; `delegate-bridge.js` fires `POST /api/subagents/delegate` (the `okf-ingest` agent + a task carrying `jobId` + source), captures the `runId` from the first `run_started` line, and holds the stream. The run is **self-sufficient** (FR-047). *(Carried forward — this plan's baseline.)*
- **ADR-006 (launcher finalization + reaper)** — the worker finalizes the job from the terminal line's `endedReason`: `completed`→completed (+summary from the run's final text), **`cancelled`→cancelled**, `error`/`max_steps`→failed. A **stale reaper** (bound `jobFinalizeTimeoutMs`) marks a non-terminal job `failed` if no terminal line arrives. No sub-agent callbacks, no assistant safety-net. *(Carried forward.)*
- **ADR-010 (job cancellation — this scope-add's core decision)** — verified-in-source: `abortHeadlessRun(runId)` (`src/lib/agent/subagents/run-registry.ts`) is process-local (`globalThis`), returns a boolean, and is the run-registry's abort handle (self-heal uses it in-process); `run_started` carries the `runId` as the first delegate NDJSON line; aborting yields `endedReason:"cancelled"`. **Decision**: the worker captures the `runId` and, on cancel, calls the **one generic `src/` route** `POST /api/subagents/[runId]/abort` (which calls `abortHeadlessRun`); the held stream then delivers `cancelled` and the launcher (ADR-006) writes it. The job's `cancelled` is **derived from the run's own terminal signal**, so it can never drift. **Rejections**: (a) the worker aborting its own `fetch` — zombies the run (the delegate route never wires `req.signal` into the run); (b) an OKF-specific abort endpoint — hard-codes OKF into the platform. **Per-run abort (S1)**: nested reference runs are independent top-level runs (the delegate route doesn't forward `parentRunId`, so the registry's family cascade can't reach them) — each is its own job, cancelled by its own `runId`. **Queued-window (S4)**: a cancel before `run_started` marks the job `cancelled`; the moment the `runId` is captured, the bridge immediately fires the abort (≡ running cancel; best-effort prompt stop, partial content preserved, index regenerable).
- **The 21 tools** (design.md §8.2, authoritative): Retrieval — `okf_search`, `okf_read_toc`, `okf_read_concept`, `okf_list_concepts`; Concepts — `okf_upsert_concept`, `okf_delete_concept`, `okf_merge_concepts`; Bundles — `okf_list_bundles`, `okf_init_bundle`, `okf_import_bundle`, `okf_export_bundle`, `okf_delete_bundle`; Ingest — `okf_ingest`, `okf_add_raw_source`; **Jobs — `okf_list_jobs`, `okf_cancel_job`, `okf_delete_job`**; Organization — `okf_add_link`, `okf_backlinks`; Health — `okf_lint`, `okf_stale_report`. Net delta from the prior installed 31: the auto-ingest redesign (retrieval/organization) + this scope-add's two job-control tools. (SC-007 pins 21.)
- **Job record** (design.md §8.3) — `{id, status ∈ queued|running|completed|cancelled|failed, bundleId, source, runId?, startedAt, endedAt, durationMs?, progress?, summary?, error?}`; `cancelled` has `error: null` (a stop, not an error). Persisted `<bundleRoot>/.jobs/<id>.md` + in-memory hot map.
- **App Jobs surface** (mockup contract) — `cancelled` status dot (muted warm amber `#d0894e`, "stopped not errored"), a Cancel control on running/queued rows (`POST /jobs/<id>/cancel`), a Delete control on non-running rows (`DELETE /jobs/<id>`), a cancelled sample run (partial summary "work done before stop · not committed"). The tab badge counts all jobs.
- **Agent allowlist** (design.md §8.4) — `okf_ingest, okf_add_raw_source, okf_list_concepts, okf_read_concept, okf_read_toc, okf_search, okf_upsert_concept, okf_add_link, web_search, web_fetch, browser_navigate, browser_wait_for, browser_save_page, browser_close, file_to_markdown, view_image, video_keyframes, file_read, file_list` (the four browser tools: FR-067). `okf_ingest` is the only job-lifecycle tool (fire independent nested reference jobs, FR-019/FR-047); the three job-control tools stay top-level/app.

## Open items carried into `tasks.md`

1. **The `src/` abort route is the mixed target's deliverable** — one new file, `src/app/api/subagents/[runId]/abort/route.ts`; keep it generic (FR-052). It is committed on the branch **alongside** `app_build` (not part of the item staging dir).
2. **`runId` capture is in `delegate-bridge.js`** — the worker already receives the `run_started` line on its stream; this scope-add adds the capture + the cancel path, not a new channel.
3. **`jobFinalizeTimeoutMs` config** — the reaper bound (carried forward from auto-ingest; ADR-006/FR-049); add to `service.json` configSchema + `config/`.
4. **e2e mock-delegate seam** — `OKF_DELEGATE_URL` env override already exists (the auto-ingest work); the cancel/delete tests reuse it to get a deterministic, controllable in-flight run (emit `run_started`, stay open) so cancel is asserted without a real 10-minute agent.
5. **`cancelled` is distinct from `failed`** — pinned everywhere (job store, both tools' outputs, both app routes, `GET /jobs`, `okf_list_jobs`, the mockup dot). A cancelled run's partial content is preserved and the index regenerates; `error` is `null`.

---

## Scope-add 3 — ingest chunking + job trajectory (FR-055/056/057/058, US11/US12, SC-017/018)

**Design**: `design.md` ADR-012 (chunking) + ADR-013 (trajectory) — authoritative. **UI contract**: `mockup.html` (Jobs tab gains a trajectory section). This is the third increment on the item; it carries forward all prior scope-adds (auto-ingest, cancel/delete, person-kind) and adds **two** capabilities. **No new tools** (21 stays 21, SC-007). **No new `src/` file.** Pure `marketplace-item` — service + app + agent + skill facets, `app_build` (id `okf-knowledge-base` preserved).

### Technical approach

**Chunking (ADR-012).** The agent today reads the entire staged source into its context via `file_read`; a 351KB source is ~1.4M tokens > the 524K limit and the run dies. The fix is a **mechanical, worker-side pre-split** performed inside the **`okf_add_raw_source` handler** (the one point where the agent hands the acquired source to the service — the worker is a plain Node thread with no `web_fetch`, so it cannot chunk a URL source *before* the run; chunking happens *after* the run's `web_fetch` stages it, inside `okf_add_raw_source`). `okf-core.js` gains a **pure** `chunkSource(content, maxChunkSize)` (heading → paragraph → sentence boundaries, each chunk carrying a `headingPath` of ancestor headings + `chunk`/`total` ordinals); the handler writes chunks to **`.chunks/<docId>/<NNN>.md`** (an operational dir at the bundle root, sibling of `.jobs/`, **not** under `raw/` — the full source in `raw/` is the provenance), and returns the chunk paths in the tool response. The agent's task text tells it to process the `chunks` sequentially (one `file_read` per chunk, bounded context). `maxChunkSize` is a new service config (default **32000** chars ≈ 8K tokens), exposed via `GET /config`. Re-ingest is a clear-then-rewrite of `.chunks/<docId>/` (a derived cache, not `raw/` — no NFR-006 violation).

**Trajectory (ADR-013).** The launcher (`delegate-bridge.js`) already reads the delegate NDJSON stream line-by-line (for `run_started` + the terminal). It now **appends every parsed event to `job.trajectory`** — `run_started`, `tool`, `tool_result`, `reasoning_delta`, `final_text`, `done`, and the terminal `error`. Wire type for a tool call is `{type:"tool", tool, input}` (not `tool_call`); a `tool` and its `tool_result` are paired **positionally** (no shared `callId`). The `trajectory` array is stored on the job record (in-memory + `.jobs/<id>.md` frontmatter, same pattern as `concept-index.md`'s `terms:`) and surfaces on the existing `GET /jobs/<id>` (no new route). The app's Jobs-tab detail gains a **trajectory section** — a scrollable list of collapsible cards (a `run_started` header, a card per `tool`+`tool_result` pair showing tool name + input collapsed → expandable to the result, a `done`/`error` terminal card, "No trajectory" for zero events) mirroring the Self-Heal / Agentic Editor tool-call rendering. For a running job the section grows as the existing poll loop re-fetches `GET /jobs/<id>`.

**Mockup** (binding contract): the Jobs-tab detail in `mockup.html` gains the trajectory section with sample `tool`/`tool_result` data — delegated to `ui-designer` (tasks Phase S). The app implements exactly what the mockup shows.

---

## Scope-add 4 — ingest efficiency: bounded output + configurable inactivity timeout (FR-059/FR-060, US13, SC-019)

**Design**: `design.md` **ADR-014** (Part A body-extraction write protocol; Part B configurable inactivity reaper) — authoritative, reviewer-verified, one revision round applied. This is the fourth increment on the item; it carries forward **all** prior scope-adds (auto-ingest, cancel/delete, person-kind, chunking, trajectory) and adds **two** coupled capabilities. **No new tools** (21 stays 21, SC-007). **No new `src/` file.** Pure `marketplace-item` — service + agent + skill facets, `app_build` (id `okf-knowledge-base` preserved). No app change required (a reaped job is still `failed`, just with an accurate `error`; the Jobs tab is unchanged).

### Technical approach

**Part A — body-extraction write protocol (FR-060, SC-019).** The root cost today is the ingest agent **re-emitting the source body as output tokens** when it writes each chapter (`okf_upsert_concept({id, body:<full markdown>})`). The body is byte-for-byte the source already on disk at `raw/<source>.md` (the load-bearing fact ADR-014 verified against `addRawSource`); the only things the agent genuinely *authors* are the frontmatter (`concepts`/`summary`/`person_terms`/`title`/`status`) and the inline-asset interpretation blocks. The fix makes the **service** assemble the chapter:

1. **Heading map at chunk time.** `okf-core.chunkSource` already walks the source for heading boundaries; it now *additionally* emits `.chunks/<docId>/headings.json` = `{ "sourceFile": "raw/<name>.md", "headings": [{index, level, text, start, end}] }` (char offsets into the raw source; `end` = just before the next heading or `sourceLength`). Each chunk's frontmatter `headings:` list gains the GLOBAL indices of its in-chunk headings **plus the immediate boundary heading** (so a `toHeading` merge can always target one — D1/F2). Written in the same clear-then-write window as the chunks (Risk #2).
2. **Metadata-only chapter write (D4/F1).** `okf_upsert_concept` gains **optional** `sourceRange` + `interpretations` fields (the 21-tool surface is unchanged; `body`-only calls are untouched — backward-compatible). Precedence: **if `sourceRange` present → extract; else `body` as-is.** `sourceId` is *not* a field — the service resolves the raw file from the concept id's `docId` (→ `headings.json` → `sourceFile`).
3. **Deterministic extractor (D2/D3/D6).** `okf-core.chapterFromSourceRange(bDir, docId, sourceRange, interpretations)`: read `.chunks/<docId>/headings.json` + `raw/<sourceFile>`; take the **contiguous verbatim slice** `[headings[startHeading].start, <end>)` where `<end>` is resolved from the end rule (`nextSameOrHigher` | `toHeading` | `sourceLength`); `whole:true` → the entire source (the no-heading single-chapter case); `startHeading:-1` → a headingless preamble. Then insert each `{assetLine, interpretation}`: exact-substring match of `assetLine` in the slice → blockquote beneath it (rewriting the asset URL to the local `raw/assets/<docId>/<name>`); fallbacks (filename match, then append + `<!-- interpretation: … -->` marker) — **in all three placements the body-minus-interpretations stays the verbatim slice** (SC-019 invariant). Fail loudly (not silently mis-slice) if `headings.json` disagrees with the raw file size/heading count (Risk #2; surfaced by `okf_lint`).
4. **One call per chapter (D5).** Not batched — each per-chapter `okf_upsert_concept` is small (metadata only) AND is a `tool`/`tool_result` NDJSON event = a **liveness heartbeat** for the Part B reaper (the longest event-less gap becomes one chunk's decomposition, not N re-typed bodies).
5. **Agent/skill instructions.** `AGENT.md` + `SKILL.md` gain the metadata-only write protocol: reference a chapter by `sourceRange` (a heading index from the chunk's `headings:` list + end rule) or `whole:true`, **never re-type the body**; emit interpretations as `{assetLine, interpretation}` (the `blockTemplate` from `okf_add_raw_source`/`addRawAsset` is the agent's *reference* for the exact `assetLine`, not authored body — D3/N7). Allowlist unchanged.

**Part B — configurable inactivity reaper (FR-059, SC-019).** Today the reaper marks a non-terminal job stale 30 min after it *started* — but a single long model generation produces **no trajectory events**, so a live-but-silent run trips it (the user's "several simultaneously → all failed at 32 min"). Two changes:

1. **Inactivity signal = `job.lastEventAt`.** ADR-013's `delegate-bridge.js` already iterates every NDJSON event to append `job.trajectory`; it now also sets `job.lastEventAt = now` on **every** event (one additive line) and persists it on the per-job record (`.jobs/<id>.md`). The reaper compares `now - lastEventAt` against the bound — **inactivity, not total duration** (US13 acceptance 2).
2. **Configurable + a total backstop.** Keep `jobFinalizeTimeoutMs` (default 30 min, now unambiguously an *inactivity* bound) and **add `maxTotalTimeoutMs`** (default **6 h**) — inactivity alone misses an *alive-and-emitting-but-not-progressing* run (slow-thrashing), so the reaper fires when **either** `now - lastEventAt > jobFinalizeTimeoutMs` **or** `now - startedAt > maxTotalTimeoutMs`. Both are `configSchema` entries with `title`/`description`, so they render in **Settings → Plugins → OKF Knowledge Base** (the same mechanism already surfacing `maxDepth`/`maxWorkers`/`maxChunkSize`) — US13 acceptance 3. Config read at service start (a restart picks up a new value, same as `maxChunkSize`).
3. **Honest error messages (B4).** The reaper's `error` distinguishes which bound tripped: inactivity → "no progress (trajectory event) for <bound>; the run was alive but silent (a long model generation, a provider stall, or a BOS restart that dropped the stream)…" (restart listed *among* the causes, no longer asserted); total backstop → "exceeded the maximum total runtime (<bound>) without reaching a terminal state; the run was active but not progressing." **Part A is what makes 30 min safe**: it removes the one generation that was plausibly longer than 30 min (the body re-emission).

**Mockup**: unchanged — no new UI surface (the Jobs tab already renders `failed` + `error`; a reaped job's accurate `error` just reads better). No `ui-designer` task.

### e2e additions (beyond the existing suite)

- **SC-019 verbatim-slice invariant** — ingest a structured source (or drive `chapterFromSourceRange` directly in a unit test): assert a stored chapter's body, with the interpretation blockquote(s) removed, is a **byte-identical slice** of `raw/<source>.md` for the chapter's heading range. Covers `nextSameOrHigher`, `toHeading` (merge), `whole:true` (no-heading), and `startHeading:-1` (preamble).
- **No body re-emission** — assert the agent's per-chapter `okf_upsert_concept` calls carry `sourceRange` (and `interpretations` where there are assets) and **not** a `body` of source text (a trajectory assertion, or a unit test of the write path).
- **Inactivity reaper** — a mock-delegate run that emits events then goes **silent** past a (short) `jobFinalizeTimeoutMs` is reaped `failed` with the inactivity message; a run that keeps emitting events past the *total* 30 min is **not** reaped (US13 acceptance 2). The `maxTotalTimeoutMs` backstop reaps an alive-but-thrashing run.
- **Config surface** — `GET /config` (or the service config) exposes `jobFinalizeTimeoutMs` + `maxTotalTimeoutMs`; changing them is honored (US13 acceptance 3).
- **Unit tests** (offline, fast) for `chunkSource`'s heading-map emission (headings.json shape, the boundary heading in each chunk's list), `chapterFromSourceRange` (slice + interpretation insertion + the three fallbacks + the verbatim-slice invariant + the mismatch fail-loud), and the reaper's inactivity/backstop predicates.

### Open items carried into `tasks.md`

1. **`headings.json` is written in `okf_add_raw_source`** (the chunking seam, ADR-012) — same place that writes `.chunks/<docId>/NNN.md`; clear-then-write together with the chunks (Risk #2). It is **per-doc** (`.chunks/<docId>/headings.json`), alongside the chunks, excluded from export.
2. **`chapterFromSourceRange` resolves `sourceFile` itself** — from the concept id's `docId` → `.chunks/<docId>/headings.json` → `sourceFile`. No `sourceId` field on the tool (D4/F1).
3. **`lastEventAt` is per-job-record + persisted** (`.jobs/<id>.md`) — one additive line in ADR-013's existing trajectory loop; the reaper reads it.
4. **`maxTotalTimeoutMs` is new config** (default 6 h) alongside `jobFinalizeTimeoutMs` (default 30 min, re-described as inactivity) in `service.json` configSchema + `config/`.
5. **The mockup is unchanged** — no `ui-designer` task; no app code change.

## Scope-add 5 — retrieval at scale + a legible graph (US14, FR-001/002/004/006/036/042/043 amended, FR-068–FR-073, SC-020–SC-024)

**Design**: `design.md` **ADR-015 – ADR-022** and **§12** — authoritative; architect-reviewed, one revision round applied (all five must-fix findings and the should-improves addressed). **UI contract**: `mockup.html` (Large bundle mode, Documents = bundle TOC, paged Concept Index, Query search hits, the graph) — binding for *what the screens show*; where it computes (search, layout constants) `design.md` §12.3 and ADR-022 are binding (§12.8). **No new tools** (21 stays 21, SC-007). **No new dependency.** Item-only; depends on two `bos-core` fixes shipped separately (below).

### Technical approach (in build order — each step is test-first)

1. **The model before anything uses it (ADR-016).** Replace `derivedCache` + `graphCache` with one per-bundle model and one serial queue: parallel first read, per-read single-flight refresh by `(size, modified)` signatures, write paths that patch instead of rebuilding, staleness computed at read time, listing/read errors propagated (the `listConceptIds` swallow goes). Everything below reads from it. This is the step that changes write cost from O(bundle) round trips to O(1); it ships even if nothing else did.
2. **Ledger + bundle TOC (ADR-017).** `recordSource` gains a never-overwritten `firstIngestedAt` and runs on the queue; `bundleToc()` feeds both `okf_read_toc({bundle})` and `index.md` (which drops its unbounded term list).
3. **Search (ADR-015, ADR-018).** `searchFullText` over chapters and document stubs: folding, stop words, word-start matching, any-word with coverage-first ranking, tiers, BM25-style score, excerpts per sentence of the original text, `groupBy`, clamping. Today's row fields keep their meaning. Term matching is part of the one scan; the old term-only `searchIndex` was removed rather than kept beside it (one search, not two).
4. **Paged vocabulary, slim detail, summary cap (ADR-019, ADR-021, ADR-020).**
5. **Surfaces.** `tools.js` declarations and handlers (the descriptions live there, not in `service.json`), `http-bridge.js` routes, the `service.json` group text.
6. **Graph (ADR-022).** `core.graph()` ids become the namespaced keys; the app's layout moves to a pure `app/src/lib/graphlayout.mjs` (+ `.d.mts`) — the same pattern as `mdparse.mjs` — so `node --test` can prove "no overlap" and "two nodes for one name" without a browser.
7. **App.** Documents, Concept Index (+ merge type-ahead), `SearchHits`, Query/Table/Reader wiring, CSS; rebuild `dist/`.
8. **Agent-facing text.** `okf-lookup` skill (new), `okf-bundle-schema` pointer, `okf-ingest` AGENT.md (vocabulary by query, summary cap).
9. **Docs, e2e, measurement.**

### Testing strategy

- **Offline unit tests first** (`tests/*.test.mjs`, `node --test`, the memfs server): every behaviour in §12.6. `tests/memfs-server.mjs` gains `size`/`modified` on `list` and a request counter, so "a write issues O(1) reads" is asserted, not estimated. A generator (`tests/fixtures/gen-bundle.mjs`) builds the 500-document and 3,000-chapter bundles in the memfs.
- **Kept contracts are re-asserted, not rewritten**: e2e US1 AS1 (`"what is our rollback policy"`), the description anchoring (e2e 422-426) and the author-by-name path (e2e 1376-1377) must pass unchanged. Only the assertions ADR-018/021 deliberately change move (default row counts; `detail.documents`/`detail.conceptIndex` → paged routes).
- **Graph**: `tests/graph-layout.test.mjs` on `graphlayout.mjs`.
- **e2e** against a running BOS (preview): SC-020–SC-024 end to end, plus the full existing suite.
- **On the deployment, once**: the `/api/fs` round trip and a search's p95 on the real bundle, against ADR-015/016's numbers (§10 risk 12).

### Prerequisites outside the item (`bos-core`)

| | Branch | State |
|---|---|---|
| `vfs.list` leaves out an entry renamed away mid-listing (ENOENT only) | `bos/vfs-list-vanished-entry` (`99832327e`) | done, unmerged |
| Seeded assistant holds the 21-tool OKF surface; deferred ids current | `bos/okf-agent-tools` (`1b0e72d7e`) | done, unmerged |
| Production's hand-edited `data/agents/assistant/AGENT.md` | by hand | pending (user) |

The item's freshness check (step 1) is only reliable on a BOS that has the first fix; the item must not ship to a deployment without it.

### Open items carried into `tasks.md`

1. **Stop-word list** is fixed and English (ADR-015); a bundle in another language matches without it (the fallback "never drop everything" covers a query made only of stop words).
2. **Settle off the paint path** (ADR-022): the app runs the 420 ticks in animation-frame chunks; `graphlayout.mjs` exposes a step function so the test drives it synchronously.
3. **Eviction of idle bundle models** (§10 risk 13) is *not* built — measured first.
4. **`log.md` growth** (ADR-016) is *not* changed — measured first.
