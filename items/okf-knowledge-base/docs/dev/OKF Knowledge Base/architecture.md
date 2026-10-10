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
| `lib/delegate-bridge.js` | The loopback client for `/api/subagents/delegate`. How the service starts an agent run. |
| `lib/http-bridge.js` | The app-facing REST surface, loopback-guarded. |
| `lib/tools.js` | The 19 `okf_*` declarations + handlers. |

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
- **Identity is type-scoped.** A node's semantic `id` is not unique — a document `api-design` and the concept term `api-design` are different nodes sharing one id. Every node therefore also carries `key = "<type>:<id>"` (`doc:api-design`, `concept:api-design`, `chap:api-design/endpoint-naming`), and that is what the renderer keys its node map, DOM `data-id`/`data-testid`, React keys, match set and selection off. Keying off `id` collapsed such a pair into one node and dropped the other's edges.
- Edges, typed and directed: `containment` (doc→chap, from each chapter's `parent`), `coverage` (chap→concept, from the concept index), `link` (from `links.json`, written by `okf_add_link` alongside the markdown link in the body). `from`/`to` are node **keys**. A `links.json` entry names a concept FILE, so it resolves against the `doc`/`chap` nodes only, never a concept term.

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
- `{type:"done"}` carries `result.endedReason`: `"completed"` → `updateJob(completed)` with a summary parsed from `result.output`; `"error"` or `"max_steps"` → `updateJob(failed)` with `result.error`.
- `{type:"error"}` → failed.
- Stream ends with no terminal line → failed. We don't know it succeeded, so it didn't.

**The launcher owns terminal state.** The thing that watched the run writes the outcome. The agent's only job-facing duty is its final summary text — it cannot declare itself finished, and `POST /jobs/<id>` rejects a `status` field for exactly that reason. An agent that dies, loops, or goes quiet still produces an honest record.

`max_steps` is deliberately **not** a success: the bundle may hold a half-decomposed document, and recording that as completed would be the job store lying about its own data.

## The reaper

`driveRun` writes a terminal state on every path it controls. It cannot cover the process dying under it — a service restart, a BOS reload, a killed Next.js. Those orphan a job in `queued`/`running` with nobody watching.

`core.reapStaleJobs(bundleRoot, staleJobMs)` marks any non-terminal job older than `staleJobMs` (default 30 min) as `failed` with a "stale" reason that says what probably happened. It runs **on a timer** (every 5 minutes, `unref`'d so it never holds the worker open) **and as a sweep on every (re)start**.

The startup sweep is the important half: a restart is precisely the event that orphans jobs, and the first thing a service should do about jobs it finds `running` — when it knows for a fact it is running none of them — is admit they are lost.

## The job store

In-memory hot map, mirrored to `<bundleRoot>/.jobs/jobs.json` so the Jobs tab survives a restart. Service-level, not bundle-level: the tab is global, and a run must outlive the bundle it targeted being deleted mid-flight. History is capped at 200. `.jobs/` is operational state, not OKF content, and is **excluded from export**.

Terminal states are **final**: a late transition against an already-terminal job is recorded as a no-op rather than resurrecting a finished run.

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
| `GET /jobs` · `GET /jobs/<id>` | the job store |
| `POST /jobs/<id>` | progress enrichment **only**; a `status` field is rejected |

`POST /bundles/<b>/ingest` is gone — `POST /jobs` supersedes it.

## The app

`app/src/main.tsx` mounts `App` into `#root`. React is provided by the bundler; the item installs no npm packages and the app has **zero runtime dependencies** — including the force-directed graph, which is an in-app simulation (`query/forceSim.ts`) rather than d3 or vis.js.

Three tabs share one state root, so a run started in Overview immediately bumps the Jobs badge. The Jobs poll (3s) runs on *every* tab, not only while Jobs is open, or a run started from Overview would look like nothing happened.

The Query tab mounts only while visible: its force simulation sizes its viewBox from real container dimensions, which are 0 under `display: none`.

## See also

- [data-model.md](data-model.md) — bundle layout, frontmatter, index/TOC format, the job record.
- [tool-surface.md](tool-surface.md) — the 19 tools.
- [extension.md](extension.md) — where to add a convention, and why the skill is the seam.
