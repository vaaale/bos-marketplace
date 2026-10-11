# Architecture

The OKF Knowledge Base ships as one marketplace item with four facets: a **service** (worker thread), a **standalone app**, a bundled **sub-agent**, and a bundled **skill**.

```
┌─ Next.js process (BOS core) ───────────────────────────────────────────┐
│                                                                        │
│  assistant ──okf_* tool_call (IPC)──▶ ServiceManager ──▶ ┌───────────┐ │
│                                                           │  worker   │ │
│  app iframe ──httpPath | runtime.port──────────────────▶ │  thread   │ │
│                                                           └─────┬─────┘ │
│  /api/fs            ◀── loopback ────────────────────────────────┤      │
│  /api/fs/raw        ◀── loopback ────────────────────────────────┤      │
│  /api/subagents/<runId>/abort ◀── loopback (stop a run) ─────────┤      │
│  /api/subagents/delegate ◀── loopback (NDJSON) ──────────────────┘      │
│         │                                                               │
│         └─▶ okf-ingest sub-agent (narrow allowlist, in-process)         │
│                    │                                                    │
│                    └─ okf_* tool_call (IPC) ──▶ ServiceManager ──▶ worker│
└────────────────────────────────────────────────────────────────────────┘
```

## The service

`services/index.js` is the worker entry. Its ordering is load-bearing:

1. **Bind the HTTP server, then send `initialized` / `bound` / `tool_declare` — before any VFS call.** Tool registration must not be gated on BOS's own API routes being up and fast. They often aren't at cold start (Next.js dev compiles, many services' startup sweeps competing for the same request queue), and a worker that spends that time doing I/O gets terminated by `ServiceManager`'s startup timeout with no tool ever declared.
2. *Then*, best-effort and in the background: `mkdir(bundleRoot)`, legacy-bundle migration, job-store warm-up, the reaper's startup sweep, and arming the reaper timer.

`tool_call` messages dispatch to `handlers[name]` from `lib/tools.js`. Errors come back in-band as `tool_error`; the worker never crashes on a bad call.

### The modules

| Module | Owns |
|---|---|
| `lib/okf-core.js` | Everything about storage and derivation: frontmatter parse/serialize, path safety, atomic writes, the two-level derived index, `search`, `graph`, lint, the job store, and `triggerIngest`. |
| `lib/vfs-bridge.js` | The loopback client for `/api/fs` (text) and `/api/fs/raw` (binary). The only way this service touches storage. |
| `lib/delegate-bridge.js` | The loopback client for the headless-run endpoint and the per-run abort route. How the service starts an agent run, captures its `runId`, and stops it. |
| `lib/http-bridge.js` | The app-facing REST surface, loopback-guarded. |
| `lib/tools.js` | The 21 `okf_*` declarations + handlers. |

`okf-core` never touches the host filesystem. Every path it handles is a BOS **VFS** path, and every read/write goes through `vfs-bridge` into `/api/fs`. (An earlier version remapped `bundleRoot` onto a host path derived from the service's config directory; every bundle landed inside BOS's internal `system/` directory, invisible to the Files app and to everything else that reads `/KnowledgeBase` — while the service and its app, which only ever talked to each other, looked fine. The one-time migration for that is still in `index.js`.)

## Two surfaces, one core

The agent reaches the service over 039 tool IPC. The app reaches it over loopback HTTP. **Both call the same `okf-core` functions.**

That is not a style preference — it is what makes `okf_search` and `GET /bundles/<b>/search` incapable of disagreeing. Adding an app view adds zero tools; adding a tool adds zero routes. See [tool-surface.md](tool-surface.md) for the agent side and §"App-facing REST" below for the HTTP side.

The app is a sandboxed iframe, so it resolves its base URL as **`httpPath` if present, else `runtime.port`** (read from `/api/services/okf-knowledge-base/config`), with a fallback to the parent frame's `window.__bos.services.call` broker when the iframe has an opaque origin. That needs the app's **`services:read`** capability. `app/src/lib/serviceClient.ts` is the single place this logic lives.

**Trust boundary:** the HTTP bridge binds `127.0.0.1` *and* independently verifies the TCP peer is loopback. A forwarded `X-Forwarded-For` cannot launder a non-loopback peer. Loopback is the boundary; there is no per-request token, because a process that can open the port is already inside BOS.

## The two-level derived index

Retrieval is backed by two **derived, regenerable** Markdown artifacts, both with machine-readable frontmatter and a human-readable body:

- **`concept-index.md`** (level 1) — `term → [(docId, chId, description, status, stale)]`. The O(V) routing table, bounded by distinct *vocabulary*, not by corpus size.
- **`toc/<docId>.md`** (level 2) — one document's chapters, each with its summary, concepts and status.

Both are rebuilt from chapter frontmatter on every write that can change them, and stamped `index_generated_at`. On read, `getModel()` compares that stamp against the newest chapter's `updated_at`: a drifted or missing artifact rebuilds once, transparently. `rebuildIndex` / `rebuildToc` are also callable directly for repair.

Neither artifact is ever the sole source of truth — `concepts/**` and `raw/**` are. That is what lets a bundle survive a hand edit, a git merge, or an external tool: the derived layer repairs itself from content instead of silently serving something rotten. Both are included in exports and re-imported.

**No database, no embeddings.** The escalation threshold is documented and deliberate: a keyword/BM25 pre-filter over term names and descriptions becomes the first escalation only once one deterministic pass over the index exceeds roughly 50k tokens of index text or ~2s wall-clock at p95. Embeddings only after that is insufficient. Until then, the deterministic pass is the whole of search.

## Search

`core.search()` is the one implementation. Tokenize the query; walk `index.terms`; a token hitting a **term name** outranks a token hitting a **description**; a chapter covering two matching terms is deduplicated to one row; rank by (term-hit tier, distinct tokens matched, then a deterministic `(docId, chId)` tiebreak); default limit 25; empty on no match.

No LLM is in the match. The model does *routing* (which query to issue) and *synthesis* (reading what comes back). Every row names its `matchedConcept`, so a result is explainable. Same query, same rows, always — which is what makes the e2e determinism assertion possible.

## Graph derivation

`core.graph()` computes `{nodes, edges}` **on read** — there is no stored graph.

- Nodes: `doc` (one per document stub), `chap` (one per chapter), `concept` (one per index term, with a `count` that drives node radius).
- Edges, typed and directed: `containment` (doc→chap, from each chapter's `parent`), `coverage` (chap→concept, from the concept index), `link` (from `links.json`, written by `okf_add_link` alongside the markdown link in the body).

Storing the graph would reintroduce the second-thing-to-sync problem the derived layer exists to kill. Derivation walks the same frontmatter search already reads, so it is cheap and always consistent. The app's hover-to-trace-neighbours is computed client-side from the returned edge list; there are no `neighbors` / `shortest_path` tools.

## The auto-trigger

`okf_ingest` used to be a **dispatcher**. The worker has no agent loop, so the tool could only plan: it returned `acquisition_required` with steps to run, or `delegation_required` with an `agent_delegate` call to issue, and the caller executed the ritual. Three calls deep, and the job's terminal state depended on the sub-agent remembering to post lifecycle callbacks.

BOS exposes `POST /api/subagents/delegate` over plain loopback HTTP — the same transport the service already used for `/api/fs`. The worker *can* start a run. So:

```
okf_ingest({bundle, source})
  └─ core.triggerIngest()
       ├─ dedup against raw/sources.json  →  already_ingested, no run
       ├─ createJob(queued)
       ├─ void driveRun(...)              ← detached, NOT awaited
       └─ return {jobId, status: "queued"}   ← the caller is free, now
```

`driveRun` builds the task (embedding `jobId`, bundle, source, and the per-source acquisition first steps, **each pinning `output_path`**), POSTs it to the delegate endpoint, and consumes the NDJSON stream:

- `{type:"tool"}` lines advance `job.progress`.
- `{type:"run_started"}` — the **first** line of every run — carries the run's own `runId`, which is stored on the job record. Everything about stopping a run hangs off it (see below).
- `{type:"done"}` carries `result.endedReason`, and that map is the whole of terminal state: `"completed"` → `updateJob(completed)` with a summary parsed from `result.output`; `"cancelled"` → `updateJob(cancelled)` with `error: null`; `"error"` or `"max_steps"` → `updateJob(failed)` with `result.error`.
- `{type:"error"}` → failed.
- Stream ends with no terminal line → failed. We don't know it succeeded, so it didn't.

**The launcher owns terminal state.** The thing that watched the run writes the outcome. The agent's only job-facing duty is its final summary text — it cannot declare itself finished, and `POST /jobs/<id>` rejects a `status` field for exactly that reason. An agent that dies, loops, or goes quiet still produces an honest record.

`max_steps` is deliberately **not** a success: the bundle may hold a half-decomposed document, and recording that as completed would be the job store lying about its own data.

## The reaper

`driveRun` writes a terminal state on every path it controls. It cannot cover the process dying under it — a service restart, a BOS reload, a killed Next.js. Those orphan a job in `queued`/`running` with nobody watching.

`core.reapStaleJobs(bundleRoot, jobFinalizeTimeoutMs)` marks any non-terminal job older than `jobFinalizeTimeoutMs` (config, default 30 min) as `failed` with a "stale" reason that says what probably happened. It runs **on a timer** (every 5 minutes, `unref`'d so it never holds the worker open) **and as a sweep on every (re)start**.

Only `queued`/`running` jobs are candidates, so the reaper can never relabel a `cancelled` run as `failed`: a deliberate stop is terminal, and terminal states are final.

The startup sweep is the important half: a restart is precisely the event that orphans jobs, and the first thing a service should do about jobs it finds `running` — when it knows for a fact it is running none of them — is admit they are lost.

## The job store

In-memory hot map, mirrored to `<bundleRoot>/.jobs/<id>.md` — **one readable file per run** — so the Jobs tab survives a restart. Service-level, not bundle-level: the tab is global, and a run must outlive the bundle it targeted being deleted mid-flight. History is capped at 200. `.jobs/` is operational state, not OKF content, and is **excluded from export**.

One file per run rather than one shared `jobs.json` is what makes `okf_delete_job` a file delete instead of a read-modify-write of the whole history — a delete racing a concurrent run's progress write can't silently resurrect or drop another run's record. A legacy single-file store is migrated to per-run files on first load (and archived, not deleted).

The lifecycle is `queued → running → completed | cancelled | failed`. Terminal states are **final**: a late transition against an already-terminal job is recorded as a no-op rather than resurrecting or relabelling a finished run. That is also what makes cancel safe to write eagerly — see below.

## Cancel and delete (job control)

### Cancel: stop the run through the platform, record the stop locally

The hard constraint: the run executes in the **main Next.js process**, the job is owned by the **worker**. The worker cannot reach the run's `AbortController`, and it must not abort its own `fetch` on the delegate stream to stop it — the delegate route never wires the request's signal into the run, so aborting the client side closes the stream while the server-side run keeps going, writing chapters with nothing watching it. The run and the job would disagree.

So the worker asks the process that owns the run, over the same loopback channel it already uses for `/api/fs` and the headless-run endpoint:

```
okf_cancel_job({jobId})  |  POST /jobs/<id>/cancel
  └─ core.cancelJob()
       ├─ already terminal?  →  {cancelled:false, reason:"already terminal"}   NO-OP
       ├─ updateJob(status: "cancelled", error: null)      ← written NOW, so the
       │                                                      Jobs tab reflects it
       │                                                      on the next poll
       └─ delegate.cancelRun(jobId, runId)
            └─ POST /api/subagents/<runId>/abort      (platform-owned, generic)
                 → {aborted:true}   the run's AbortController fires
                 → the held stream delivers done{endedReason:"cancelled"}
                 → driveRun's terminal write is a no-op (the job is already
                   cancelled) — one state, written once, from one place
```

Three properties worth naming:

- **`cancelled` is terminal and distinct from `failed`**, with `error: null`. A stop the user asked for is not a run that went wrong.
- **Per-run abort, not family cascade.** A followed reference is an independent top-level run with its own job and its own `runId` (the delegate endpoint does not forward a `parentRunId`), so each is cancelled by its own job. The abort route's `aborted` boolean is per-run.
- **`aborted:false` is not an error.** It means "no such live run" — already finished, or never started in this process — which makes the call idempotent.

### The queued window

A cancel can arrive before the run has announced its `runId`. There is nothing to abort yet, and waiting out a whole run the user has already stopped would be absurd. So `delegate-bridge` remembers the cancel against the job and fires the abort **the instant `run_started` lands and the id is captured**. A queued-window cancel then behaves exactly like a running one.

### Delete: the record, and only the record

```
okf_delete_job({jobId})  |  DELETE /jobs/<id>
  └─ core.deleteJob()
       ├─ running?     →  409  "cancel it first"
       ├─ unknown id?  →  404
       └─ drop from the hot map + delete .jobs/<id>.md      →  {deleted:true}
```

Bundle content is never touched — chapters, the concept index, every TOC and `raw/` are untouched by both operations. A job record is bookkeeping *about* a run, not the knowledge the run produced; deleting one removes a row from a list.

A running run is refused rather than deleted because removing the record of a live run leaves it writing into a bundle with nothing watching it — the one state the launcher model exists to prevent. Cancel first, then delete.

## Inline assets

At ingest, for every non-HTML asset in a chapter's scope: download an immutable copy to `raw/assets/<docId>/<name>`, interpret it with `view_image` or `video_keyframes`, and write the chapter with the link plus a `> **Interpretation (LLM, at ingest):** …` blockquote directly beneath.

HTML pages stay remote references. The interpretation is written **once** and stored as text, so `okf_read_concept` returns the asset's knowledge with no vision call at query time. A failed download or interpretation marks the block unavailable, is counted in the run summary and reported by `okf_lint`, and does not fail the document.

The app's reader pane renders thumbnails through `GET /bundles/<b>/assets/<path>`, because an opaque-origin iframe can't reach `/api/fs/raw` itself.

## App-facing REST

All loopback-guarded, all reusing the same `core` functions as the tools. None of them are `tool_declare`d.

| Route | Core |
|---|---|
| `GET /config` | runtime (`httpPath`, `port`, `bundleRoot`) |
| `GET /tools` | the **real** declared list — the app's titlebar badge and the e2e count assertion read this, never a literal |
| `GET /bundles` · `POST /bundles` | `listBundles` · `initBundle` |
| `GET /bundles/<b>` · `DELETE /bundles/<b>` | `bundleDetail` · `deleteBundle` |
| `GET /bundles/<b>/toc/<docId>` | `readToc` |
| `GET /bundles/<b>/concept/<id>` | `readConcept` |
| `GET\|POST /bundles/<b>/search` | `search` — identical rows to `okf_search` |
| `GET /bundles/<b>/graph` | `graph` |
| `GET /bundles/<b>/assets/<p>` | `readAsset` → `vfs.readRaw` (bytes) |
| `GET /bundles/<b>/lint` · `/stale` | `lintBundle` · `staleReport` |
| `GET /bundles/<b>/export` · `POST /bundles/<b>/import` | `exportBundle` · `importBundle` |
| `POST /bundles/<b>/merge` | `mergeConcepts` |
| `POST /jobs` | **`triggerIngest`** — the app-side auto-trigger |
| `GET /jobs` · `GET /jobs/<id>` | the job store — includes `cancelled` runs and each run's `runId` |
| `POST /jobs/<id>` | progress enrichment **only**; a `status` field is rejected |
| `POST /jobs/<id>/cancel` | **`cancelJob`** — the Jobs tab's Cancel control |
| `DELETE /jobs/<id>` | **`deleteJob`** — the Jobs tab's Delete control (409 while running) |

`POST /bundles/<b>/ingest` is gone — `POST /jobs` supersedes it.

## The app

`app/src/main.tsx` mounts `App` into `#root`. React is provided by the bundler; the item installs no npm packages and the app has **zero runtime dependencies** — including the force-directed graph, which is an in-app simulation (`query/forceSim.ts`) rather than d3 or vis.js.

Three tabs share one state root, so a run started in Overview immediately bumps the Jobs badge. The Jobs poll (3s) runs on *every* tab, not only while Jobs is open, or a run started from Overview would look like nothing happened. The badge counts every run on record, cancelled ones included.

The Jobs rows carry **state-dependent controls**, exactly as the mockup specifies: a `running` row offers **Cancel** and no Delete; a `queued` row offers both; a terminal row (`completed` / `cancelled` / `failed`) offers **Delete** and no Cancel. They call `POST /jobs/<id>/cancel` and `DELETE /jobs/<id>`, which are the same worker operations the `okf_cancel_job` / `okf_delete_job` tools drive. A `cancelled` row renders its own dot — a muted warm amber that reads as *stopped*, deliberately not failed's red — and its own detail card, because the thing to know about a cancelled run is what survived, not what went wrong.

The Query tab mounts only while visible: its force simulation sizes its viewBox from real container dimensions, which are 0 under `display: none`.

## See also

- [data-model.md](data-model.md) — bundle layout, frontmatter, index/TOC format, the job record.
- [tool-surface.md](tool-surface.md) — the 21 tools, and the abort-route dependency.
- [extension.md](extension.md) — where to add a convention, and why the skill is the seam.
