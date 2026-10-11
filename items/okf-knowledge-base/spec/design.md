# Design — OKF Knowledge Base (Redesign + auto-ingest + job cancel/delete scope-add)

This is the authoritative architecture for the OKF Knowledge Base item. The document's
center of gravity is **organization + concept-anchored retrieval**, with a
**standalone master-detail app** (Overview / Jobs / Query) and ingest re-scoped as the
mechanism that *builds* the index retrieval depends on — and ingest is
**auto-triggered and headless** (the worker fires the run, the caller is freed at return).
This revision (the **job cancel/delete scope-add**, FR-050/FR-051/FR-052, US8 scenarios
4–6, SC-014/SC-015) adds two capabilities on top of the already-designed auto-ingest
baseline: **cancelling a running job** (a distinct `cancelled` terminal state) and
**deleting a non-running job**. It is the first scope of this item that depends on a small
**`bos-core`** platform mechanism — a **generic** headless-run abort route
(`POST /api/subagents/[runId]/abort`, the HTTP face of the existing in-process
`abortHeadlessRun`) — which the item consumes over loopback but does **not** special-case.
Decisions the spec locks in are treated as fixed. Where this design carries something
forward (service-facet shape, VFS loopback bridge, 039 tool exposure, inline-asset
pipeline), it is labeled **retained** — not re-litigated.

**Note on this revision's baseline.** The spec (FR-046/047/048/049) and the auto-ingest
redesign that precede this scope-add already moved `okf_ingest` from a *dispatcher*
(the calling assistant issued `agent_delegate`) to a **worker-fired headless run**
(`okf_ingest` returns a `jobId` immediately; the service's `delegate-bridge.js` fires
`POST /api/subagents/delegate` and the **launcher** — that worker — owns finalization from
the run's NDJSON terminal signal, with a stale reaper; the tool surface is **19** including
`okf_list_jobs`). This document now reconciles those sections (ADR-005, ADR-006, §7.1,
§7.3, §8.2, §8.3, §9) to that 19-tool auto-ingest baseline **and** layers the
cancel/delete scope-add (→ **21** tools, ADR-010). Sections that this scope-add does not
touch (data model §5, retrieval §6, ADR-001–004, ADR-007–009, worker/reachability §8.1,
the bundled-agent allowlist §8.4) are unchanged from the auto-ingest design.

**Note on the person-kind term scope-add (FR-053/FR-054, US10, SC-016).** This increment
adds **salient-person retrieval**: ingest registers the author and named key figures as
**person-kind concept terms** (`kind: person`) in the *same* derived concept index as topic
terms — **not** a new entity type and **not** a separate content file. They are found by name
through the **existing** `okf_search` (a query token matching the person's name is an
ordinary term-name hit — **zero search-algorithm change**) and rendered as a **distinct 4th
node category** in the Query graph. The load-bearing decision — *where a term's `kind` lives*
so it survives the derived-index rebuild without becoming a second source of truth — is a
**parallel `person_terms` frontmatter array** on the chapter/doc-stub that carries the
person, which the index rebuild copies through as a per-term `kind` (ADR-011). The
**21-tool surface is unchanged** (no new tools); the increment touches only `okf-core.js`
(index/graph/search/list derivation), `tools.js` (additive `kind` fields on two existing tool
responses), the `okf-ingest` `AGENT.md` + `okf-bundle-schema` `SKILL.md` (the extraction
convention), and the app's Query tab (4th node color + kind label). It is **pure
`marketplace-item`** — no new `src/` file (the one generic abort route from the cancel/delete
scope-add is untouched).

---

## 1. Classification

**Mixed target — `marketplace-item` (primary) + one small `bos-core` platform mechanism.**

The item deliverable is unchanged in shape: a single self-contained item at
`data/user-apps/items/okf-knowledge-base/` with **three facets of one item**:

1. **Service facet** — the worker-thread daemon that owns OKF storage, maintains the
   derived index, declares the **21 `okf_*` tools** via the 039 Service Tool Exposure
   contract, **auto-triggers ingest as a headless run** it then owns and can cancel, and
   runs a loopback REST bridge the app talks to.
2. **App facet** — a **standalone master-detail app** (Overview / Jobs / Query),
   dock-openable, replacing the old settings-embedded `config-app/index.html`. The Jobs
   tab now carries a **Cancel** control on running jobs and a **Delete** control on
   non-running jobs (FR-041, FR-050, FR-051).
3. **Bundled agent + skill** — the `okf-ingest` least-privilege sub-agent and the
   `okf-bundle-schema` skill, copy-installed into `data/agents/` / `data/skills/`.

The **one `bos-core` change** this scope-add introduces is a **generic, platform-level**
route — `POST /api/subagents/[runId]/abort` (`src/app/api/subagents/[runId]/abort/
route.ts`) — that is the HTTP face of the existing in-process `abortHeadlessRun(runId)`
(`src/lib/agent/subagents/run-registry.ts`). It is **not OKF-specific**: it serves *any*
fire-and-forget headless consumer that needs to abort a run by `runId` (self-heal already
calls `abortHeadlessRun` in-process; this route is the loopback face for out-of-process
consumers like this item). The item **consumes** it over loopback — the same channel it
already uses for `/api/fs` and `POST /api/subagents/delegate`. Nothing else touches `src/`.

This **agrees with `spec.md`'s own `App Target` field**, which now reads
`marketplace-item` (primary) **+ one small `bos-core` platform mechanism**. The prior
(organization-only) design's pure-`marketplace-item` / "nothing touches `src/`" claim is
refined by exactly this one generic route. The four *earlier* `bos-core` prerequisites
(fixed `web_fetch`, `file_to_markdown`, `view_image`, `video_keyframes` + the
`ToolExecuteResult` mechanism, `ffmpeg` in Docker, agent/skill copy-install) remain
**assumed-present dependencies** (spec *Assumptions*), not re-scoped here — the abort route
is a *new, small, generic* mechanism, not a re-scope of those.

### Why the cancel path is a small `bos-core` route and not an item-only mechanism

- **The run lives in the main Next.js process; the job lives in the worker** (a separate
  process). The only way the worker can stop a run it fired is to ask the *process that
  owns the run* to abort it — over HTTP. The item cannot reach the run's `AbortController`
  itself (different process, no shared import).
- **BOS already has the abort handle** — `abortHeadlessRun(runId)` registers every
  headless run's `AbortController` in a run-registry (on `globalThis`, so an in-process
  route can reach a run started elsewhere); it can also, via `parentRunId`, cascade the abort across a run family — a capability OKF's nested reference runs do **not** use (they're independent top-level runs, each stopped by its own job — ADR-010). The missing piece was only its *HTTP face*; that
  is the one `src/` file. This is a **handle on existing machinery, not a new cancel
  path** (the same logic the run-registry header documents for self-heal).
- **No reasoning toward deeper `bos-core` work**: the route does not add routing/
  middleware/tooling; it is a single `POST` that calls one existing function and reports
  the boolean. Any future headless consumer gets it for free.

### Why the item (not the route) owns the job and the `cancelled` state

The job record is **item data** (lives under the bundle's `.jobs/`, owned by the worker).
The platform route aborts the *run*; the worker, which already holds the run's open NDJSON
stream, **observes the terminal `endedReason:"cancelled"`** and writes the `cancelled`
status to the job. The route never knows or cares that an OKF job exists — it aborts a
`runId` and returns `{aborted:true|false}`. That separation is what keeps the route generic
(ADR-010).

---

## 2. Constitution check

| Principle | Compliance |
|---|---|
| **I. Spec-Driven** — feature defined by a spec before build; pipeline. | ✅ Spec is `item-okf-knowledge-base/spec.md` (this is the `design` step). No code is a source of truth. |
| **II. Server Authority & SSR Boundary** — filesystem/Node live in server code; clients fetch. | ✅ All OKF storage and the derived index live in the worker (server-side, behind the loopback bridge). The app iframe and the assistant both reach it over HTTP; no OKF logic in the app bundle. The one `src/` route is server-side too (calls the in-process run-registry). |
| **III. Always Delegate; Claude Codes** — development on a sub-agent. | ✅ This design is authored by the Architect; implementation is delegated to the Developer. The feature's *runtime* delegation is the existing fire-and-forget headless surface (`POST /api/subagents/delegate` → `runSubAgent`), not new infra (ADR-005). |
| **IV. Minimize Blast Radius** — feature branch; self-modification isolated. | ✅ Lands on the active feature branch; item work is branch-coupled in `data/user-apps`. The one `src/` route is additive and generic (a new file; no existing route/signature change), so its blast radius is one route handler. |
| **V. The VFS Is Not the Source** — user data under `data/`; versioned apps in their own GitFS repo. | ✅ Bundles live under the VFS at `/KnowledgeBase/` (user data, owned by the service). The item's code lives in the `user-apps` GitFS repo, reached through the item symlink. The abort route is BOS *source* (platform), not user data. |
| **VI. Specs & Docs Stay in Sync** | ✅ The item ships its own `docs/usage/OKF Knowledge Base/` and `docs/dev/OKF Knowledge Base/` facets, updated in the same change (the item's `docs/dev/OKF Knowledge Base/tool-surface.md` (this change) reflects the 21-tool surface + the abort dependency (the store-root spec-040 tool-surface.md is superseded)). This `design.md` is the architecture artifact the later `plan`/`tasks` reference. |
| **VII. Respect Boundaries** — confirm destructive ops; no new deps unasked. | ✅ `okf_delete_bundle`/`okf_delete_concept`/`okf_delete_job` are the destructive ops and stay explicit-intent (the app gates them behind confirmation per the mockup; `okf_delete_job` removes a job record only, never bundle content — FR-051). No new *runtime dependency* is introduced: the app reuses BOS's existing in-app SVG force simulation (no `d3`/`vis.js` — ADR-009); the cancel path reuses the existing run-registry (no new library). |
| **OKF invariants (NFR-001/005)** — schema-less, human-readable, unknown keys preserved, raw immutable. | ✅ Retained from the installed `okf-core.js` (frontmatter shallow-merge already preserves unknown keys; `raw/` is append-only and never overwritten). The derived index/TOC add *new* frontmatter keys (`type`, `parent`, `concepts`, `summary`, `status`, `stale_after`, `sources`) — all preserved verbatim on write. Cancelling/deleting a job never touches this content (FR-050/FR-051). |
| **Least privilege (NFR-009)** — the ingest sub-agent's allowlist stays narrow. | ✅ §8.4 lists the exact allowlist; it excludes destructive tools, unrestricted `run_command`, and the full assistant surface. The job-control tools (`okf_list_jobs`/`okf_cancel_job`/`okf_delete_job`) are *top-level/app* tools — the `okf-ingest` sub-agent does not need them (it does the work; it doesn't manage the job it's running). |

No conflicts flagged. Two notes for the reviewer:
- **NFR-002** ("no vector/SQL/embeddings in v1") is satisfied structurally — retrieval is
  a deterministic pass over a derived `.md`/frontmatter index plus full-chapter reads; the
  escalation path to a keyword/BM25 pre-filter is documented in ADR-001, not built.
- **The one `src/` change** (the abort route) is the *only* place this "pure marketplace
  item" design touches BOS source, and it is deliberately **generic** — it must not
  special-case OKF (FR-052). Constitution I (BOS source read-only *for marketplace
  features*) is satisfied in the spirit: the item does not *edit* existing `src/` to
  serve its needs; it *consumes* a small platform capability that any headless consumer
  can use. If the reviewer wants the item to be 100% `src/`-free, the alternative is a
  self-contained "ask the run to stop" side-channel, but that would *reinvent* the
  run-registry's abort handle rather than use it — ADR-010 documents why the route is the
  right call.

---

## 3. Architecture

### 3.1 Context

The user installs the OKF Knowledge Base item. It becomes a **service** owning
`/KnowledgeBase/<bundle>/`. Three entry points exist:

- **The assistant** uses the **21 `okf_*` tools** to ingest (`okf_ingest` — which
  **starts the headless run automatically** and returns a `jobId` immediately), to retrieve
  (`okf_search` → `okf_read_toc`/`okf_read_concept`), to curate concepts and bundles, to
  check health, and to **observe / cancel / delete** ingest runs (`okf_list_jobs`,
  `okf_cancel_job`, `okf_delete_job`).
- **The user** opens the standalone **app** (a dock window) and uses its three tabs:
  **Overview** (list/manage bundles, browse the concept index and document TOCs, lint,
  import/export), **Jobs** (watch ingest runs through their real lifecycle, **cancel a
  running one**, **delete a finished one**), and **Query** (a force-directed **knowledge
  graph** and a **concept-anchored search**, both driving a resizable reader pane that
  opens the full chapter with a link to the original source).
- **The retrieval contract** (the redesign's headline) is *concept-anchored,
  chapter-granular, full-text, efficient*: a natural-language query hits a deterministic
  match over a **two-level derived index** (bundle-level concept index + per-document
  TOC), returns ranked TOC rows, and the agent/user then fetches **full** documents or
  **full** chapters — never snippet chunks. There are no embeddings and no database.

### 3.2 Container

BOS's **actual** containers this feature runs in (no generic "the API"/"the database"):

```mermaid
flowchart TD
    subgraph NEXT["Next.js app process (BOS core)"]
        AGENT["Top-level assistant"]
        TREG["AssistantTool registry (039-registered okf_* tools)"]
        DELEG["POST /api/subagents/delegate (NDJSON run stream)"]
        ABORT["POST /api/subagents/[runId]/abort (NEW, generic)"]
        RREG["run-registry: abortHeadlessRun(runId) (in-process, globalThis)"]
        SM["ServiceManager (worker lifecycle, tool_declare bridge)"]
        IF["App iframe: OKF Knowledge Base (Overview/Jobs/Query)"]
        AGENT -->|"okf_* tool_call (IPC)"| SM
        TREG -.registers.-> SM
        IF -->|"same-origin fetch, else __bos broker services.call"| HTTPBASE["service base URL (httpPath or runtime.port)"]
    end

    subgraph SUPER["Supervisor (when supervisorEnabled)"]
        PROXY["proxyServiceHttp → /__supervisor/services/okf-knowledge-base/…"]
    end

    subgraph ITEM["marketplace item: okf-knowledge-base (worker thread, own loopback port)"]
        W["services/index.js — worker entry"]
        CORE["lib/okf-core.js — OKF storage engine + derived index/TOC/graph/search + job store"]
        VFSB["lib/vfs-bridge.js — loopback /api/fs (+ /api/fs/raw for binary assets)"]
        DBR["lib/delegate-bridge.js — fires POST /api/subagents/delegate, holds the NDJSON stream, captures runId from run_started, finalizes the job from the terminal endedReason, stale reaper; cancel = POST /api/subagents/[runId]/abort"]
        HTTPB["lib/http-bridge.js — app-facing REST (bundles, index, toc, search, graph, jobs, + cancel/delete)"]
        TOOLS["lib/tools.js — 21 okf_* declarations + handlers"]
        AGENTB["agents/okf-ingest/AGENT.md  ·  skills/okf-bundle-schema/SKILL.md"]
        W --> CORE
        W --> VFSB
        W --> DBR
        W --> HTTPB
        W --> TOOLS
        HTTPB --> CORE
        TOOLS --> CORE
        DBR --> CORE
    end

    SUB["okf-ingest headless run (in-process, narrow allowlist)"]

    SM -->|spawn + tool_call/tool_result| W
    DBR -->|"POST /api/subagents/delegate (okf-ingest agent + task)"| DELEG
    DELEG -->|spawn/run| SUB
    DELEG -.first line.->|"run_started {runId}"| DBR
    DELEG -.terminal line.->|"done {result.endedReason: completed|cancelled|error|max_steps}"| DBR
    DBR -->|"POST /api/subagents/[runId]/abort (on cancel)"| ABORT
    ABORT -->|in-process| RREG -->|AbortController.abort() → run returns cancelled| SUB
    SUB -->|"okf_* tool_call (IPC)"| SM
    CORE -->|loopback| APIFS["/api/fs, /api/fs/raw  (BOS VFS API)"]
    APIFS --> VFSROOT["/KnowledgeBase/<bundle>/  (VFS)"]
    HTTPBASE -->|proxied| PROXY --> W
    AGENTB -.copy-install.-> DATAA["data/agents/okf-ingest/ · data/skills/okf-bundle-schema/"]
```

**Retained from the installed item** (unchanged shape, per spec *Assumptions*):
- **Worker-thread service**, bound to its own loopback port (`service.json` `port`
  default `0` — OS-assigned, never a fixed number; `services.md` §3), reached from the
  app via the `httpPath`-if-present-else-direct-port pattern (`services.md` §11).
- **`okf-core.js`** as the storage engine over **`vfs-bridge.js`** (loopback
  `/api/fs` — the only sanctioned way an unbundled worker reaches the VFS).
- **039 tool exposure** (`deploymentMode: "tools"`, `tool_declare`, `toolGroups`
  "Knowledge Base").

**Auto-ingest (the baseline this scope-add builds on)**: **`delegate-bridge.js`** — the
worker fires `POST /api/subagents/delegate` with the bundled `okf-ingest` agent spec + a
task, **captures the `runId` from the first `run_started` NDJSON line**, and **holds the
open stream**; `okf_ingest` returns the minted `jobId` immediately and the caller is freed
(FR-046). The **launcher** (that worker) owns finalization from the run's **terminal
`endedReason`** (FR-049), with a **stale reaper** (ADR-006). The run is **self-sufficient**
(FR-047) — it does acquisition + decomposition + assets + index itself.

**New in this scope-add (FR-050/FR-051/FR-052)**: the **cancel** path — `delegate-bridge`
calls the new **generic** `POST /api/subagents/[runId]/abort` (the one `src/` file), which
invokes the in-process `abortHeadlessRun(runId)`; the run's stream then ends with
`endedReason:"cancelled"` and the launcher writes `cancelled` to the job (ADR-010). The
**delete** path removes a non-running job record from the job store (`okf_delete_job` /
`DELETE /jobs/<id>`). **Run observability** (ADR-006, §7.3), the **inline-asset pipeline**
(FR-015/FR-020–023, §7.5), the **graph derivation** (ADR-004, §6.3), the **app-facing REST
surface** (ADR-003, §8), and the **standalone master-detail app** (replaces the
config-app) are carried forward from the auto-ingest design.

### 3.3 Component — deliverable file plan

Paths under `data/user-apps/items/okf-knowledge-base/` (the **as-built** layout the
installed item already uses — a consolidated `services/lib/`, not the old design's
idealized `services/tools/*.js` split). **One file outside the item** — the generic
`src/` abort route — is called out separately at the end.

```
data/user-apps/items/okf-knowledge-base/
├── services/
│   ├── service.json           # RETAINED shape; port default 0 (unchanged). Config schema
│   │                          #   carries bundleRoot/maxDepth/maxWorkers; this scope-add
│   │                          #   may add jobFinalizeTimeoutMs (stale reaper bound, ADR-006).
│   ├── index.js               # RETAINED worker entry. Keep bind-then-handshake-first
│   │                          #   ordering; extend VFS bridge to binary. tool_declare loop
│   │                          #   reads tools.js (now 21). Starts delegate-bridge's stale
│   │                          #   reaper interval.
│   └── lib/
│       ├── okf-core.js        # REWORKED. Retains: frontmatter YAML-lite, path safety,
│       │                      #   raw/ append-only, shallow-merge upsert (person_terms
│       │                      #   preserved verbatim as an unknown key — NFR-005),
│       │                      #   links/extractLinks, log. ADDS: concept index + doc-TOC
│       │                      #   derivation & rebuild (§5.4), okf_search (§6), graph
│       │                      #   derivation (ADR-004, §6.3), merge_concepts, bundle health,
│       │                      #   binary raw-asset write/read, raw/sources.json provenance
│       │                      #   ledger (FR-018), the JOB STORE (records under
│       │                      #   /KnowledgeBase/.jobs/ with status ∈ {queued, running,
│       │                      #   completed, cancelled, failed}, runId, cancel/delete), and
│       │                      #   PERSON KIND (FR-053/FR-054): rebuildIndex reads
│       │                      #   person_terms from chapters + doc stubs → a per-term kind in
│       │                      #   the index (person iff the name appears in any person_terms,
│       │                      #   else topic); kind surfaced in the graph (4th node type,
│       │                      #   §6.3), okf_search rows, and okf_list_concepts terms
│       │                      #   (ADR-011). No search-algorithm change.
│       ├── vfs-bridge.js      # RETAINED /api/fs loopback. writeBinary/readRaw for non-HTML
│       │                      #   assets (base64 write; GET /api/fs/raw stream read).
│       ├── delegate-bridge.js # AUTO-INGEST (baseline) + CANCEL (this scope-add).
│       │                      #   Fires POST /api/subagents/delegate (okf-ingest agent +
│       │                      #   task), streams NDJSON. CAPTURES runId from the first
│       │                      #   run_started line (FR-052 — the run handle the cancel path
│       │                      #   needs). FINALIZES the job from the terminal line's
│       │                      #   endedReason (completed→completed, cancelled→cancelled,
│       │                      #   error/max_steps→failed; ADR-006) + records the run's
│       │                      #   summary. STALE REAPER: a timer marks any job still
│       │                      #   non-terminal past jobFinalizeTimeoutMs as failed.
│       │                      #   CANCEL: POST /api/subagents/<runId>/abort over loopback,
│       │                      #   then confirm cancelled from the terminal line (ADR-010).
│       ├── http-bridge.js     # RETAINED loopback guard (isTrustedPeer) + sendJson. The
│       │                      #   app-facing surface in §8, now including POST /jobs/<id>/
│       │                      #   cancel and DELETE /jobs/<id> (this scope-add).
│       └── tools.js           # REWORKED. DECLARATIONS = exactly the 21 tools in §8.2
│                              #   (was 31; the person-kind increment adds NO tools).
│                              #   Read-only tools stay parallelSafe (readOnly()). okf_ingest
│                              #   mints the job + kicks off delegate-bridge and returns the
│                              #   jobId immediately (ADR-005). Handlers: okf_list_jobs
│                              #   (FR-048), okf_cancel_job (FR-050), okf_delete_job
│                              #   (FR-051). PERSON KIND: okf_list_concepts gains kind on each
│                              #   term (+ optional kind? filter); okf_search rows gain an
│                              #   additive kind field (ADR-011).
├── agents/
│   └── okf-ingest/
│       └── AGENT.md           # REWORKED. Least-privilege allowlist (§8.4) scoped to the
│                              #   ingest/read/write + acquisition tools (UNCHANGED — person
│                              #   extraction rides on okf_upsert_concept, no new tool).
│                              #   Instructions: chapter decomposition, concept assignment,
│                              #   one-line summaries, doc-TOC + concept-index maintenance,
│                              #   inline-asset interpret-and-preserve, PERSON EXTRACTION
│                              #   (FR-053 — author at doc level, named key figures at chapter
│                              #   level, as person_terms; the agent judges salience), and —
│                              #   in its FINAL message — a concise structured run summary
│                              #   the launcher records (ADR-006).
├── skills/
│   └── okf-bundle-schema/
│       └── SKILL.md           # REWORKED. Authoritative ingest/query/lint conventions:
│                              #   two-level index schema, chapter frontmatter, concept-term
│                              #   naming/merge policy, inline-asset block format, dedup,
│                              #   the PERSON-KIND CONVENTION (FR-053/FR-054 — what "salient"
│                              #   means, doc-level author vs chapter-level key figure, the
│                              #   kind: person semantics, ADR-011), and the "end with a
│                              #   structured summary" rule (ADR-006).
├── config/
│   └── okf-knowledge-base.json  # RETAINED (bundleRoot, port:0, maxDepth, maxWorkers);
│                                #   + jobFinalizeTimeoutMs (stale reaper bound).
├── app/
│   └── src/                   # NEW standalone master-detail app (replaces app/config-app/).
│       ├── main.tsx           # entry — mounts into #root (item app-facet anatomy;
│       │                      #   app_build bundles this). React provided by the bundler.
│       ├── App.tsx            # tab shell: Overview / Jobs / Query (mockup .app/.tabbar).
│       ├── bridge.ts          # service base-URL resolution: same-origin fetch → else
│       │                      #   __bos broker services.call / services.getConfig
│       │                      #   (workflows-item pattern). The single place the app learns
│       │                      #   httpPath vs runtime.port (services.md §11).
│       ├── overview/          # BundleList, BundleDetail, ConceptIndexView, DocumentsView,
│       │                      #   TocView, ChapterView, HealthView, ImportExport,
│       │                      #   modals (new/import/export/delete/ingest).
│       ├── jobs/              # JobsList (lifecycle dots incl. CANCELLED; Cancel control on
│       │                      #   running jobs; Delete control on non-running jobs), JobDetail
│       │                      #   (summary cells / error / progress), polling loop.
│       │                      #   (Cancel → POST /jobs/<id>/cancel; Delete → DELETE
│       │                      #   /jobs/<id> — FR-050/FR-051, §8.3.)
│       ├── query/             # QueryShell (bundle select + shared search + Graph/Table
│       │                      #   toggle), GraphView (force sim — port of the mockup's
│       │                      #   stepGraph/renderGraph/drawGraph, dependency-free; + a 4th
│       │                      #   PERSON node color, teal/green, for type:"person", FR-054),
│       │                      #   TableRows (+ a kind column/badge), SearchResults,
│       │                      #   ReaderPane (frontmatter + md + assets + source link +
│       │                      #   concept-term view — a person node opens the SAME term view,
│       │                      #   its covering chapters), Resizer.
│       └── lib/               # api.ts (typed clients for §8 routes, incl. cancel/delete),
│                              #   markdown.ts (the mockup's tiny renderer, kept), types.ts.
└── docs/                       # REQUIRED item facet (target-marketplace-item.md).
    ├── usage/OKF Knowledge Base/
    │   ├── index.md           # what it does, the three tabs, retrieval model in plain terms.
    │   ├── ingest.md          # how to trigger ingest (auto-starts a run, returns jobId),
    │   │                      #   what a run does, watching Jobs, **cancelling** a running
    │   │                      #   run, **deleting** a finished one.
    │   └── troubleshooting.md # search misses (concept-anchored, not full-text), stale items,
    │                          #   import/export, service not started (Settings → Plugins).
    └── dev/OKF Knowledge Base/
        ├── architecture.md    # this design, condensed: containers, derived index, jobs,
        │                      #   and the auto-ingest + cancel/delete + abort-route flow.
        ├── data-model.md      # bundle layout, frontmatter schema, index/TOC format, job record.
        ├── tool-surface.md    # the 21 tools (mirror of §8.2).
        └── extension.md       # adding a bundle convention, the okf-ingest skill as the seam.
```

**The one `src/` (bos-core) file — generic, not OKF-specific** (FR-052):

```
src/app/api/subagents/[runId]/abort/route.ts
    # POST — abort an in-flight headless run by runId.
    #   Body: {} (the runId is the path param).
    #   200 { aborted: true,  runId }  — a live run (or its family) was aborted.
    #   200 { aborted: false, runId }  — no such live run (already finished, or never
    #                                    started in this process); caller reports that
    #                                    truthfully (idempotent, R14-style).
    #   404 — runId missing/empty.
    #   Implementation: import { abortHeadlessRun } from
    #     "@/lib/agent/subagents/run-registry"; const aborted = abortHeadlessRun(runId);
    #   No OKF knowledge — no job store, no bundle, no agent id. It is the HTTP face of
    #   the existing run-registry, sibling to the agent-store route at
    #   src/app/api/subagents/[id]/route.ts (PATCH/DELETE agent metadata by *agent* id —
    #   a distinct single-segment pattern; this is the two-segment /subagents/<runId>/abort).
```

No other `src/` (BOS-source) file is created or modified. No `app.json`/`service.json`
are hand-written into `data/user-apps` — the Developer stages the facets and
`app_build({name, dir, id:"okf-knowledge-base"})` installs the full item; the abort route
is a separate `bos-core` file committed alongside (it is not part of the item).

---

## 4. ADRs

### ADR-001 — Retrieval: a two-level *derived* file index, not a real DB (with the NFR-002 escalation threshold)

- **Context.** The retrieval contract (spec *Overview*; US1/US3) is
  *concept-anchored, chapter-granular, full-text, efficient*, bounded by vocabulary not
  corpus size (FR-002, NFR-011, SC-006). The prior design had **no computed index at all**
  — retrieval was "the LLM traverses the link graph" (`okf_neighbors`/`okf_shortest_path`/
  `okf_export_graph` were the "power tools"). That is O(chapters) LLM work per query and
  doesn't give a ranked, explainable table of contents.
- **Options.**
  - **(a) Vector / embedding store** (a real DB or a vector index over chunked chapters).
    Fast fuzzy recall, but it adds exactly what NFR-002 says is not in v1, it returns
    *chunks* (violating NFR-003's full-text rule), and it needs an embedding pipeline the
    item would have to own or call out for.
  - **(b) SQL / keyword (BM25) index over full chapter text.** Better than (a) on the
    "no embeddings" axis, but it's still a database the item must run, and full-text
    ranking returns the wrong granularity (a matched sentence, not a concept-anchored
    chapter) and can't explain *why* a row matched.
  - **(c) Two-level derived file index — bundle-level concept index + per-doc TOC**, both
    `.md`/frontmatter artifacts derived from chapter frontmatter, with a **deterministic**
    match over the concept vocabulary + one-line descriptions (no LLM in the match itself),
    followed by full-chapter reads.
- **Decision.** **(c)**. Level 1 is a map `concept-term → [(docId, chId, one-line
  description)]` — the routing table and the searchable *vocabulary*; it is O(V) in
  distinct terms, not O(N) documents (FR-011, SC-006). Level 2 is each document's stored
  TOC. Both are **derived and regenerable** from chapter frontmatter (FR-009, NFR-004), so
  neither is the sole source of truth and neither can silently rot; both are stored,
  browsable, exportable `.md` artifacts inside the bundle (NFR-001, FR-010, SC-004). The
  LLM does *routing* (choosing what to query) and *synthesis* (reading returned chapters
  and answering); `okf_search` is the deterministic bridge between them (§6).
- **Consequences / escalation threshold (NFR-002).** No vector/SQL/embeddings in v1. A
  real index (keyword/BM25 pre-filter, or embeddings) MAY be introduced **only** when the
  concept vocabulary V is large enough that one deterministic routing pass over it is
  *measurably* too slow or too token-heavy. Concretely, the trigger is: `okf_search`'s
  single pass over the concept index (term names + descriptions) exceeds ~**50k tokens** of
  index text or >**~2s** of wall-clock for the p95 query, sustained over a real corpus with
  V ≫ the hundreds-typical case — at which point a **keyword/BM25 pre-filter over term
  names + descriptions** (still no full-text vector store, still chapter-granular) is the
  first escalation, and embeddings only after the pre-filter is insufficient. That threshold
  and its justification must be written into this design (or the item's `docs/dev`) *before*
  adoption. Until then the deterministic pass is the whole of search.

### ADR-002 — Two-level derived index vs. one flat concept file per document

- **Context.** FR-007 (bundle-level concept index) and FR-008 (per-document TOC) could be
  collapsed into a single bundle-level artifact, or kept as two.
- **Options.** (a) One flat `index.md` listing every (doc, chapter, term) row. (b) Two
  levels: a bundle-level `concept-index.md` (term → covering chapters) **plus** a
  per-document `toc/<docId>.md` (doc → its chapters).
- **Decision.** **(b)**. The two levels map to the two distinct retrieval moves in US1:
  *route by concept* (Level 1) vs. *drill into a document's structure* (Level 2). A single
  flat file can't cheaply give "the TOC of just this document" without a filter pass, and
  it conflates the O(V) routing table with the per-doc chapter listing. Keeping them
  separate also keeps each artifact's size bounded by its own concern (NFR-011 for Level 1).
- **Consequences.** Both are independently regenerable and independently exportable
  (FR-010). Deleting a document removes its `toc/` file and prunes its chapters from the
  concept index on the next rebuild — no cross-artifact hand-sync.

### ADR-003 — The app talks to the service over HTTP (app-facing REST), not via the agent tools

- **Context.** The app is a browser iframe; it is *not* an agent and cannot call
  `okf_*` tools directly. It needs read (and a little write: create/import/export/delete
  bundle, trigger ingest, **cancel/delete jobs**) access to the same data the tools expose.
- **Options.** (a) The app calls the `okf_*` tools through some new agent-bridge. (b) A
  **dedicated app-facing REST surface** on the service's loopback port, reusing the *same*
  `okf-core.js` functions as the tools, exposing the shapes the UI actually needs (bundle
  list, bundle detail incl. stats + concept index + documents, doc TOC, chapter, search,
  graph, jobs, job detail, **job cancel/delete**, asset proxy).
- **Decision.** **(b)** — the app-side HTTP API **is** the data access layer for
  Overview/Jobs/Query (spec FR-036; the delegation's locked decision). Rationale: the app
  already reaches the service over HTTP today (the old `config-app` did, via `httpPath`);
  the 039 tools are an *agent* surface (IPC-dispatched, JSON-schema-gated) and shouldn't be
  the app's transport; and the app needs shapes (graph, jobs, the concept index as a
  browseable tree, the cancel/delete job controls) that are *views* over the same core, not
  new agent capabilities.
- **Consequences.** **Adding app views does NOT add to the 21-tool agent surface** (FR-036)
  — the HTTP routes are internal plumbing, not `tool_declare`d tools. One capability, two
  surfaces: `okf_search` and the `GET /search` route run the **identical** `core.search()`
  (FR-001/FR-002, FR-043); `okf_cancel_job`/`okf_delete_job` and the `POST /jobs/<id>/
  cancel`/`DELETE /jobs/<id>` routes drive the **identical** worker job-store operations
  (FR-050/FR-051). The app's reachability is the standard `httpPath`-else-port pattern
  (`services.md` §11) behind the same loopback trust boundary the old bridge had (§8.1).

### ADR-004 — Graph: derived on read from stored frontmatter/index/links, not a stored graph DB

- **Context.** FR-042/FR-045 require a force-directed knowledge graph (documents, chapters,
  concept terms; typed directed edges) for the Query tab. The old design had graph
  "power tools" (`okf_neighbors`, `okf_shortest_path`, `okf_export_graph`) — dropped from
  the 21-tool surface.
- **Options.** (a) A stored graph (a second artifact or a graph DB) kept in sync by the
  write path. (b) **Derive nodes+edges on read** from what is already stored: containment
  from each chapter's `parent` frontmatter, coverage from the concept index, explicit
  relationships from `okf_add_link` edges (stored as markdown links + a machine-readable
  `links.json` sidecar, §5.5).
- **Decision.** **(b)**. The graph is a *view* of the same content that the index and TOC
  are views of; storing it separately would reintroduce the "second thing to keep in sync"
  problem NFR-004 exists to kill. Derivation is cheap (it walks the same frontmatter the
  search already reads) and always consistent. The app renders the returned
  `{nodes, edges}` with its own in-app force simulation.
- **Consequences.** Edge types are exactly the three the spec names (FR-042/FR-045):
  `containment` (document→chapter, via `parent`), `coverage` (chapter→concept-term, via
  the concept index), `link` (explicit `okf_add_link`, "related"). No `shortest_path` /
  `neighbors` tool surface is needed — the app's hover-to-trace-neighbors is computed
  client-side from the returned edge list.

### ADR-005 — `okf_ingest` auto-triggers a headless run; the worker fires it, the caller is freed (FR-046/FR-047)

- **Context.** Semantic decomposition (split into chapters, assign concepts, write
  summaries, interpret assets) is a multi-step *reasoning* task. The service is a worker
  thread **outside** Next.js — it cannot run an LLM turn itself, so the work must happen in
  a **headless run** of the bundled `okf-ingest` agent. The question is *who starts it* and
  *who is blocked*.
- **Options.**
  - **(a) The worker performs the decomposition** — impossible (no agent loop in a worker
    thread).
  - **(b) A new async `runId` + status-poll tool pair** — new plumbing the item must own
    end-to-end.
  - **(c) `okf_ingest` returns a plan; the *calling assistant* issues `agent_delegate`** —
    the prior *dispatcher* model. It re-enters the document through the caller, occupies the
    caller's turn for the whole ingest, and pushes acquisition onto the caller.
  - **(d) `okf_ingest` returns a `jobId` immediately; the *worker* fires the headless run
    itself** over BOS's existing fire-and-forget surface (`POST /api/subagents/delegate`),
    and the caller is freed at return (FR-046). The run is **self-sufficient** — it does the
    acquisition (`web_fetch`/`file_to_markdown`, pinning `output_path`), the decomposition,
    the inline assets, and the index (FR-047).
- **Decision.** **(d)**. The worker's **`delegate-bridge.js`** client POSTs
  `POST /api/subagents/delegate` with the `okf-ingest` agent spec + a task that carries the
  `jobId` and the source, **captures the `runId` from the first `run_started` NDJSON line**
  (`runner.ts`, ADR-12 — emitted before anything else so a fire-and-forget caller learns
  the id while the run is in flight), and **holds the open NDJSON stream**. `okf_ingest`
  returns `{jobId, job}` (the minted `queued` record) **immediately**; the caller (an agent
  or the app's Ingest modal, which drives the same worker path via `POST /jobs`) is freed.
  This is a **new consumer** of the existing headless surface (spec *Assumptions*: "the
  same `runSubAgent` the scheduler, workflows, and self-heal use") — **not** new delegation
  infrastructure.
- **Consequences.** The document never re-enters the orchestrating agent as output tokens
  (every acquisition step in the run pins `output_path` — the whole point, FR-047). The
  run occupies **no** caller's turn (FR-046). Reference crawl is bounded by
  `maxDepth`/`maxWorkers` (FR-019, config schema). Because the worker *holds the stream*,
  it is in the right position to **observe the run's terminal outcome** (ADR-006) and to
  **cancel it** (ADR-010) — both of which the dispatcher model (c) could not do cleanly.

### ADR-006 — Run observability: the LAUNCHER (worker) owns finalization from the run's terminal signal + a stale reaper (FR-049)

- **Context.** FR-041/FR-044/FR-049/SC-011/SC-013 require ingest runs to be observable
  through a real lifecycle (**queued → running → completed | cancelled | failed**) with a
  summary (chapters written, concepts assigned, assets interpreted, references
  skipped/failed) or an error — **without** the agent emitting the full source, and **with
  finalization owned by the launcher observing the run's terminal `endedReason`**, plus a
  **stale reaper** so a crashed/abandoned run never leaves a job stuck.
- **The boundary (now the advantage).** In the auto-trigger model (ADR-005), the **worker
  fires `POST /api/subagents/delegate` and holds the open NDJSON stream** — so, unlike the
  old callback model (where the in-process sub-agent had to *call back* over HTTP and an
  assistant had to safety-net it), the worker can **directly observe the run's terminal
  outcome** on the stream it already owns. The launcher is the natural finalizer.
- **Options.**
  - **(a) Polling** — the service guesses completion by watching chapter-file mtimes.
    Fragile (a stalled run looks "running" forever; a partial write looks "done").
  - **(b) Sub-agent → service loopback HTTP lifecycle callbacks** (+ an assistant safety
    net) — the *prior* model. Works, but it depends on the sub-agent cooperating (it can die
    mid-run without calling back) and needed a second safety-net path on the *assistant*
    side.
  - **(c) The launcher (worker) finalizes from the run's NDJSON terminal signal, with a
    stale reaper** — the terminal line is authoritative; no callbacks, no assistant safety
    net; a timer catches the "stream dropped without a terminal line" case.
- **Decision.** **(c)** (FR-049). The service owns the job record (in-memory hot map +
  persisted `/KnowledgeBase/.jobs/<id>.md` so Jobs survives a restart). Finalization:
  - `okf_ingest` called → service mints `{id, status:"queued", bundleId, source}` and
    returns it; `delegate-bridge` fires the run and **stores `runId` on the job** once the
    `run_started` line arrives.
  - The run's **first** substantive tool write marks the job **running** (the worker flips
    queued→running as the run begins doing bundle writes, observed on the stream).
  - **Terminal line** — the delegate route emits a final
    `{type:"done", result, text}` where `result.endedReason ∈ {completed, cancelled,
    error, max_steps}` (BOS `AgentRunEndedReason`, `types.ts:67`; `aborted:true` is set
    when cancelled) — **this is authoritative**:
    - `completed` → **`completed`** + the summary (the run's final `final_text` carries the
      sub-agent's structured summary — chapters/concepts/assets/refsSkipped/refsFailed —
      per the skill's "end with a structured summary" rule; the worker records it, and may
      cross-check against the bundle diff it owns).
    - **`cancelled` → `cancelled`** (a **distinct** terminal state — an intentional stop,
      **not** a failure; FR-050, SC-014). Written when ADR-010's abort fires; the worker
      does *not* treat it as an error.
    - `error` → **`failed`** + `result.error`.
    - `max_steps` → **`failed`** (ran out of budget; reported as failed with the step-limit
      reason, per FR-049's "finalized to a terminal state").
  - **Stale reaper (FR-049, SC-013):** `delegate-bridge` runs a timer; any job still
    `queued`/`running` past `jobFinalizeTimeoutMs` with no terminal line (the stream
    dropped, the process crashed, or the run wedged) is **reaper-marked `failed`**
    (`error: "stale — no terminal signal within <bound>"`), so a run never sticks.
- **Consequences.** No sub-agent callbacks, no assistant safety-net (both dropped from the
  prior model) — the worker's held stream is the single source of the terminal state.
  **`cancelled` is a first-class terminal `endedReason` the launcher handles** (verified:
  `abortHeadlessRun` makes the loop return `cancelled`, and the delegate route's `done`
  line carries it). The `running` progress string is optional/best-effort (the mockup's live
  bar shows it when present). Jobs are single-user (NFR-008); the `.jobs/` dir is
  operational state, not OKF *content* (like `log.md`). Cancelling/deleting a job (ADR-010,
  FR-050/FR-051) never touches bundle content.

### ADR-007 — Bundle conventions live in the `okf-bundle-schema` skill, not a per-bundle `schema.md`

- **Context.** The old design read conventions from a per-bundle `schema.md` via the
  `okf_read_bundle_schema` tool (now **removed** from the 21-tool surface).
- **Decision.** The authoritative conventions are the item's bundled **skill**
  (`skills/okf-bundle-schema/SKILL.md`), attached to `okf-ingest` (FR-040) — reusing BOS's
  skill infrastructure rather than a parallel convention-file mechanism. A bundle *may*
  carry an optional `schema.md` that overrides the skill (the skill already says the
  bundle's voice wins), preserving forward compatibility with pre-redesign bundles.
- **Consequences.** No `okf_read_bundle_schema` tool. The sub-agent learns conventions from
  its attached skill at start; per-bundle divergence is still possible via `schema.md`
  without a tool. The skill also carries the "end with a structured run summary" rule the
  launcher relies on for the job summary (ADR-006).

### ADR-008 — Inline assets: download + interpret at ingest, store link + interpretation in the chapter

- **Context.** FR-015/FR-020–023, US4: figures/diagrams/video carry real knowledge and
  must be preserved so retrieval hands the agent the asset's knowledge *without re-running
  vision*.
- **Decision.** At ingest, the sub-agent extracts **non-HTML** asset URLs from the source,
  downloads each to `raw/assets/<docId>/` (immutable binary, via the vfs-bridge binary
  write), calls `view_image` (images) or `video_keyframes` (video) to get an interpretation,
  and writes the chapter markdown with **a link to the stored asset plus the interpretation
  directly beneath it** (a blockquote, per the Karpathy layering: bytes in `raw/`,
  interpretation as LLM-written wiki text, the link as the edge — spec *Overview*).
  **HTML/hyperlink content stays a remote reference** (FR-022). Because the interpretation
  is *stored text* (written once), `okf_read_concept` returns it without re-running vision
  (FR-023, SC-003). A failed asset download/interpretation marks the block
  "interpretation unavailable" and does **not** fail the whole document (spec *Edge Cases*).
- **Alternatives Considered.** (a) Re-run vision at query time — rejected: burns tokens on
  every read and can't run in `okf_search`'s deterministic pass. (b) Store only a link —
  rejected: retrieval then can't see the diagram's content at all. (c) OCR-only — rejected:
  loses the "what is this diagram *saying*" reasoning layer; `view_image` returns real vision
  content blocks, not OCR.
- **Consequences.** The app's reader pane renders stored assets: for images/video it
  fetches the raw bytes from the service's **asset proxy route** (§8, `GET /bundles/<b>/
  assets/<assetPath>`) and shows the thumbnail + the stored interpretation; retrieval
  (agent side) gets the markdown link + interpretation inline.

### ADR-009 — The app's force-directed graph is dependency-free in-app (no d3/vis.js)

- **Context.** FR-042 wants a Neo4J-style force-directed graph of category-colored circular
  nodes with labeled directed edges, in the BOS dark palette.
- **Options.** (a) Add `d3-force`/`vis.js` as a bundled dependency. (b) Port the **mockup's
  own dependency-free force simulation** (`stepGraph`/`renderGraph`/`drawGraph` — a
  Coulomb + spring + centering model, already in `mockup.html`) into the app.
- **Decision.** **(b)**. The mockup is the binding visual contract *and* already ships a
  working, zero-dependency simulation; porting it avoids adding an external dependency
  (Constitution VII) and guarantees the app looks exactly like the approved mockup. The
  app reuses the same node/edge color/label scheme, the legend, hover-to-trace-neighbors,
  pan/zoom/drag, and the search-highlight-dim behavior.
- **Consequences.** No new package. The graph data comes from the service's `GET
  /bundles/<b>/graph` (ADR-004 derivation); all layout is client-side.

### ADR-010 — Job cancellation: capture the run's `runId`, abort via the generic platform route, and record `cancelled` (FR-050/FR-052)

- **Context.** FR-050/SC-014: a **running** ingest job can be cancelled (from the app's
  Jobs tab or `okf_cancel_job`); the underlying headless run must be **aborted**, and the
  job must transition to a **distinct `cancelled` terminal state** (not `failed`).
  Cancelling a terminal job is a **no-op**. Cancelling does **not** delete the job record or
  the bundle content already written. The hard constraint: the run executes in the **main
  Next.js process**, but the job is owned by the **service worker** (a separate process).
  The worker cannot reach the run's `AbortController` directly — it must ask the process
  that owns the run, over HTTP, to abort it.
- **What already exists (verified in source, not assumed):**
  - `abortHeadlessRun(runId)` (`src/lib/agent/subagents/run-registry.ts:152`) — the
    in-process abort handle. It looks up the run in a registry on `globalThis` (so an
    in-process route can reach a run started elsewhere), aborts the run's `AbortController`, and can — via `parentRunId` — cascade the abort to a run family (the capability OKF's delegate-fired nested runs do **not** participate in; each is an independent top-level run, ADR-010/S1). Returns
    `boolean` — `false` means "no such live run" (already finished, or never started in
    this process). Already consumed in-process by self-heal (`src/lib/self-heal/intake.ts`).
  - **`run_started` carries the `runId`** — `runLocalHeadless` (`runner.ts`, ADR-12) emits
    `{type:"run_started", runId, …}` as the **first** event on the stream, before anything
    else, so a fire-and-forget caller learns the id while the run is in flight. The
    `POST /api/subagents/delegate` route forwards it verbatim as the **first NDJSON line**.
  - **The terminal line carries `endedReason:"cancelled"`** — when `abortHeadlessRun`
    aborts the run's controller, the agent loop returns `cancelled`, the delegate route
    emits `{type:"done", result}` with `result.endedReason:"cancelled"` (+
    `result.aborted:true`). `AgentRunEndedReason = "completed" | "cancelled" | "error" |
    "max_steps"` (`types.ts:67`).
- **Options.**
  - **(a) The worker aborts its own `fetch`** on the delegate stream. **Rejected — it
    zombies the run.** The delegate route never wires the request's `req.signal`
    (client-disconnect) into the run: `runLocalHeadless` creates its **own** internal
    `AbortController` and registers it by `runId`, independent of the HTTP request. So if
    the worker's `fetch` is aborted, the client side closes but the **server-side run keeps
    running to completion** (writing chapters, burning tokens, updating the index) — while
    the worker has given up on it. The run and the job would disagree. (Verified: the
    delegate route's `start(controller){ … await runSubAgent(…) }` references no
    `req.signal` and defines no `cancel` callback.)
  - **(b) A new OKF-specific abort endpoint** (e.g. `POST /api/okf/abort-run`). Rejected —
    it hard-codes OKF into the platform and a future headless consumer would need its own
    copy.
  - **(c) A generic platform route** — `POST /api/subagents/[runId]/abort` — that calls the
    **existing** `abortHeadlessRun(runId)` and reports the boolean. The item consumes it
    over loopback, exactly like it consumes `/api/fs` and `POST /api/subagents/delegate`.
- **Decision.** **(c)** — the **one `src/` file** this scope-add introduces
  (`src/app/api/subagents/[runId]/abort/route.ts`), deliberately **generic** (no OKF
  knowledge — no job store, no bundle, no agent id). **The cancel flow, end to end:**
  1. `okf_cancel_job({jobId})` (or the app's `POST /jobs/<id>/cancel`) → the worker looks
     up the job. If it is already **terminal** (`completed`/`cancelled`/`failed`), return
     `{cancelled:false, reason:"already terminal"}` — **no-op** (FR-050, SC-014).
  2. Otherwise (running — a `runId` is stored on the job; or queued, see note below), the
     worker calls **`POST /api/subagents/<runId>/abort`** over loopback.
  3. That route calls `abortHeadlessRun(runId)` → the run's `AbortController` aborts →
     the agent loop returns `cancelled`. (OKF relies on per-run abort by `runId` — **not** the run-registry's family cascade, which requires `parentRunId` and which `POST /api/subagents/delegate` does not forward; so a nested reference run — FR-047 — is an independent top-level run with its own `runId`, cancelled by its own job, not by the parent's.) The route returns `{aborted:true, runId}` (or `{aborted:false}` if the
     run already ended between the check and the abort — idempotent).
  4. The delegate stream the worker **already holds** then delivers the terminal
     `{type:"done", result.endedReason:"cancelled"}` → `delegate-bridge` finalizes the job
     to **`cancelled`** (ADR-006). The worker marks it `cancelled` even before/at the
     terminal line so the Jobs tab reflects it immediately; the terminal line confirms and
     clears the run handle.
  5. The tool returns `{cancelled:true, status:"cancelled"}`. The job record and any
     bundle content already written are **preserved** (cancellation is a stop, not a
     rollback).
  - **Queued-not-yet-started note:** FR-050 scopes cancel to *running* jobs. A `queued`
    job that hasn't started its run has no live `runId` to abort yet; the worker marks it
    `cancelled` (it's non-terminal, so cancel applies). The run is already executing in the main process the moment `okf_ingest` returns, so `delegate-bridge`, **as soon as `run_started` lands and it captures the `runId`**, checks whether the job is already `cancelled` — if so it **immediately** fires `POST /api/subagents/<runId>/abort` (it does **not** wait for the run to finish naturally). This makes a queued-window cancel behave identically to a running cancel. (A `queued` job is also **deletable** — FR-051 — since it isn't running.) The two documented tool outcomes hold: non-terminal → `cancelled`,
    terminal → `{cancelled:false, reason:"already terminal"}`. A non-existent `jobId` is
    an in-band not-found (the retained `statusForError` 404), consistent with
    `okf_delete_job`.
- **Why this is the architecturally correct path.** The run-registry is the *single*
  authoritative "how do I stop a headless run by id" mechanism in BOS (it is what the run
  *registers itself* with, and what self-heal *uses*). The cancel path reuses it verbatim —
  the worker contributes only (i) capturing the `runId` from the stream it already owns,
  and (ii) a thin generic HTTP route. The job's `cancelled` state is derived from the run's
  own terminal signal (ADR-006), so the job can never disagree with the run: there is no
  separate "cancel" write path that could drift. And because the route is generic and the
  item merely *consumes* it over loopback, the scope-add keeps OKF out of the platform
  while giving the item exactly the cross-process stop handle it structurally needs.
- **Consequences.** One additive `src/` file (a route handler; no existing signature
  change). The item gains no platform coupling it doesn't already have (it already depends
  on the loopback BOS API). The run-registry is **process-local** (`globalThis`), which is
  exactly why the abort must go through an **in-process** route in the same Next.js
  process as the run — a headless run lives in exactly one process (the one that launched
  it), and the item's delegate + abort calls both target that process over loopback.
  Deleting a job (FR-051) is handled entirely in the worker's job store — no platform
  involvement.

### ADR-011 — Person `kind` rides on `person_terms` frontmatter; the derived index copies it through (FR-053/FR-054, US10, SC-016)

- **Context.** FR-053/FR-054 require ingest to register **salient persons** (the author +
  named key figures) as **person-kind concept terms** — findable by name via the *existing*
  `okf_search`, distinct in the graph, kind-reported by `okf_list_concepts` — while keeping
  them in the **same** derived concept index (not a new entity, not a separate content
  file). The load-bearing question: **where does a term's `kind` live** so it (a) survives
  the derived-index rebuild, (b) is **not** a second source of truth, and (c) is **not** a
  per-term content file?
- **Options.**
  - **(a) `kind` on the frontmatter of the chapter/doc-stub that carries the person** — a
    **parallel `person_terms` array** (sibling of `concepts`); `rebuildIndex` derives the
    per-term `kind` from it. **The source of truth the index already rebuilds FROM.**
  - **(b) `kind` on the `concept-index.md` frontmatter term entries** (the derived artifact
    carries it). But the index is *derived* — the kind would have to come from *somewhere*;
    storing it only in the index makes the index partly authoritative, which NFR-004
    forbids (the index must never be the sole source of truth).
  - **(c) A separate `person-terms.md` (or similar) content file.** A new entity/file in the
    bundle — exactly what FR-053 rules out ("not a separate content file"); a second
    artifact to keep in sync.
- **Decision.** **(a)**. `person_terms` is a new **frontmatter key** on the chapter (key
  figures) and the document stub (author). The write path's shallow-merge already preserves
  unknown keys verbatim (NFR-005, SC-005) — so it round-trips with **no writer change** —
  and `rebuildIndex`, which already walks `concepts/**` + doc stubs to read `concepts`,
  reads `person_terms` from the *same* files and derives
  `kind(term) = person` iff the name appears in any `person_terms`, else `topic`. The index,
  graph, `okf_search` rows, and `okf_list_concepts` all **copy the kind through** from that
  single derived source. It is the cleanest fit: no new file, no new entity,
  NFR-005-compliant, and rebuild-surviving *by construction* (the kind is recomputed, not
  stored-then-forgotten).
- **Why (a) over (b)/(c).** (b) makes the *derived* artifact partly authoritative — the
  anti-pattern NFR-004 exists to kill (the index would carry a fact no stored source re-
  derives it from). (c) adds a file + a sync burden for a one-facet distinction. (a) reuses
  the field the topic `concepts` already ride on, so the kind is a property of *where the
  name was registered*, not a separate record.
- **Alternatives Considered — a single `concepts` array of `{name, kind}` objects.**
  Cleaner in principle, but it changes the **existing** `concepts` shape (today a flat name
  array), ripples through `rebuildIndex`/`merge_concepts`/the TOC `concepts` field and the
  export round-trip, and risks colliding with a topic whose *name* happens to be a person.
  The parallel `person_terms` array leaves `concepts` **untouched** (a strictly additive
  key) and makes `kind` a pure function of array membership — the smaller blast radius for
  an increment. (If a name must ever be *both* a topic and a person, the index stores
  `kind:[topic,person]`; the parallel-array shape already leaves that open.)
- **Consequences.** `okf_search`'s algorithm is **unchanged** — a person's name is an
  ordinary term-name hit over `terms[]` (SC-016: "no separate search path"). The only
  surface changes are **additive `kind` fields**: the index `terms[]`, `core.graph`'s node
  set (a 4th `type:"person"`), `okf_search` rows, and `okf_list_concepts` terms (+ optional
  `kind` filter). **No new tool** (21 stays 21). **No new `src/` file** — pure
  `marketplace-item`. `okf_merge_concepts` canonicalizes across the `person_terms` arrays
  too (a person term is a term). The **extraction convention** (who is salient) is **LLM
  judgment** in the `okf-ingest` agent, encoded in `okf-bundle-schema/SKILL.md` (§7.4); the
  service only **stores and derives** — it does not decide salience.

---

## 5. Data model & storage layout

### 5.1 Bundle directory structure (the full layout)

Bundles live at the VFS path `<bundleRoot>/<name>/` (default `/KnowledgeBase/`).
`okf-core.js` treats every path as a BOS **VFS** path and reaches it only through
`vfs-bridge.js` (loopback `/api/fs`; `/api/fs/raw` for binary assets) — it never touches
the host filesystem. Path safety (`safeJoin`, `validateBundleName`, `validateConceptId`)
is retained unchanged.

```
/KnowledgeBase/<bundle>/
├── index.md                 # OKF reserved. Human-curated entry point + a derived
│                            #   "concepts covered" overview. Rebuildable; the *concept
│                            #   index* (below) is the authoritative routing artifact.
├── log.md                   # OKF reserved. Append-only event log (init/ingest/lint/
│                            #   merge/delete). Operational history, not retrieval state.
├── concept-index.md         # DERIVED (Level 1). The O(V) routing table: frontmatter
│                            #   maps each concept-term → covering (doc, chapter,
│                            #   one-line description); body is a human-readable listing.
│                            #   Regenerable from chapter frontmatter; exported/re-imported.
├── toc/                     # DERIVED (Level 2). One file per ingested document.
│   └── <docId>.md           #   Frontmatter {type: toc, document, title, updated} +
│                            #   a `chapters:` array (id, title, summary, concepts,
│                            #   status); body is the human-readable TOC. Regenerable.
├── links.json               # Sidecar. Machine-readable record of okf_add_link edges:
│                            #   [{from, to, label?}]. Keeps explicit "related" edges
│                            #   derivable for the graph without re-parsing every body.
├── .jobs/                   # OPERATIONAL (this scope-add + auto-ingest). One job record
│   └── <id>.md              #   per ingest run: {id, status ∈ queued|running|completed|
│                            #     cancelled|failed, bundleId, source, runId?, startedAt,
│                            #     endedAt, durationMs?, progress?, summary?, error?}.
│                            #   Restart-survival for Jobs. NOT OKF content (like log.md) —
│                            #   excluded from okf_export_bundle by default.
├── raw/                     # IMMUTABLE (append-only, never overwritten).
│   ├── <source>.md          #   Ingested sources (text / converted-doc markdown).
│   ├── <source>.v2.md       #   Re-ingested-changed content versions (new file, old kept).
│   ├── sources.json         #   Provenance ledger: {sourceKey → {rawFile, docId,
│   │                        #     ingestedAt}} for dedup (FR-018) + "Open source" target
│   │                        #     (FR-043). sourceKey = normalized URL or raw path.
│   └── assets/              #   Downloaded non-HTML inline assets (FR-015/FR-020).
│       └── <docId>/
│           ├── <name>.png   #   Binary, written via /api/fs base64; immutable.
│           └── <name>.mp4
└── concepts/                # CONTENT (the source of truth for the derived index).
    ├── <docId>.md           #   Document stub: {type: document, title, summary,
    │                        #     sources, created_at, updated_at}. okf_read_concept on
    │                        #     this returns the document (its TOC is toc/<docId>.md).
    └── <docId>/<chId>.md    #   Chapter (a concept file): {type: section, parent,
                             #     title, concepts[], summary, status, stale_after?,
                             #     sources, created_at, updated_at} + body. The atomic
                             #     full-text retrieval unit. May contain inline-asset
                             #     blocks (link + interpretation).
```

Notes:
- **A chapter is a concept file** (`type: section`). "Concepts" in the *retrieval* sense
  are the **index vocabulary** (terms routing to chapters) — not separate content files.
  This preserves OKF's "everything is a `.md`, only `type` required" invariant (spec
  *Assumptions*). Document stubs are `type: document`.
- **Chapters are nested under the document** (`concepts/<docId>/<chId>.md`). Concept ids
  are `<docId>/<chId>`. `validateConceptId` already allows `/`; `safeJoin` already scopes
  them under `concepts/`. Nesting makes "which chapters belong to this document" a single
  directory listing and keeps `parent` redundant-but-consistent (frontmatter still carries
  `parent` for portability and for graph derivation).
- **Concept terms are not files.** A term is a key in `concept-index.md` frontmatter.
  Merging terms (FR-026) rewrites the index, the affected `toc/*.md`, and every chapter's
  `concepts` array that referenced either — no per-term file to delete.

### 5.2 Chapter (section) frontmatter — the source of truth

```yaml
---
id: api-design/endpoint-naming        # == file path under concepts/
type: section                          # section | document
parent: api-design                     # the document (docId) this chapter belongs to
title: Endpoint Naming Conventions
concepts: [api-design, naming]         # concept TERMS this chapter covers (Level-1 keys)
summary: "REST resource naming: plural nouns, no verbs, versioned paths."   # one line;
                                     #   feeds the concept index AND the doc TOC
person_terms: [Diego Córdoba]        # salient persons this chapter is ABOUT — a
                                     #   PARALLEL array (sibling of concepts); members
                                     #   are registered as kind: person terms (FR-053,
                                     #   ADR-011). Absent when none.
status: stable                         # draft | stable | deprecated (lifecycle)
stale_after: 2026-12-01                # optional ISO; stale once past (NFR-034 / okf_stale_report)
sources:                               # provenance (FR-017, retained)
  - id: raw/api-design.md
    uri: raw/api-design.md
    note: ingested from https://engineering.example.com/handbook/api-design
created_at: 2026-08-01T00:00:00.000Z
updated_at: 2026-08-01T00:00:00.000Z
# unknown keys preserved verbatim on every write (NFR-005, SC-005)
---
```

The **document stub** `concepts/<docId>.md` is the same shape minus `parent`/`concepts`,
with `type: document`, a `title`, a one-line `summary`, `sources` (the original URL and/or
`raw/` path — this is the "Open source" target's origin, FR-043), and timestamps. It also
carries **`person_terms`**: the **author** is registered as a `kind: person` term **at
document level** (FR-053) — the doc stub is the natural home for "who wrote this."

**Person terms ride on frontmatter, not a new entity (FR-053, ADR-011).** A term's `kind`
is **derived, not stored separately**: `kind(term) = person` iff the term's name appears in
any `person_terms` array in the bundle, else `topic` (the default). `person_terms` is a
**sibling** of `concepts` — a *parallel* array — so `concepts` keeps its existing flat
topic-name shape untouched, and a name's kind is a pure function of which array it appears
in (a person name never enters `concepts`; a topic name never enters `person_terms`). It is
a **new frontmatter key**, not a new entity and not a new content file: the write path's
shallow-merge already preserves unknown keys verbatim (NFR-005, SC-005), so no writer change
is needed to round-trip it, and `rebuildIndex` reads it from the chapters/doc-stubs it
already walks — the **same** source of truth the topic `concepts` come from. (If a single
name ever needed to be *both* a topic and a person, the index would store
`kind: [topic, person]`; the parallel-array shape leaves that open, but v1 keeps one
primary kind per name. See ADR-011.)

### 5.3 Concept index (`concept-index.md`) — format & derivation

**Chosen format: a `.md` file whose *frontmatter* carries the machine-readable index and
whose *body* is the human-readable listing.** Justification for picking the `.md`
(frontmatter) form over a pure-JSON sidecar: NFR-001 says the concept index is "a plain
`.md` file inside the bundle" and SC-004 requires it present in an export — so the
authoritative artifact must be `.md`, OKF-portable, greppable in an editor. A pure-JSON
`concept-index.json` sidecar would be a *second* artifact to keep in sync (the thing
NFR-004 kills). Putting the routing data in **frontmatter** (which `okf-core.js` already
parses/serializes losslessly on keys, NFR-005) and the prose in the body gives one
regenerable `.md` that is simultaneously the deterministic search input and a human-
browsable artifact. The app's Overview → Concept Index renders the body/frontmatter
directly.

```markdown
---
type: concept-index
bundle: engineering
terms:
  - name: api-design
    kind: topic
    covers:
      - { docId: api-design, docTitle: API Design Rules, chId: endpoint-naming,
          chTitle: Endpoint Naming Conventions,
          description: "REST resource naming: plural nouns, no verbs, versioned paths.",
          status: stable, stale: false }
      - { docId: error-handling, docTitle: Error Handling Standards, chId: error-response,
          chTitle: Error Response Format,
          description: "RFC-7807 problem+json envelope with stable error codes.",
          status: stable, stale: false }
  - name: rollback
    kind: topic
    covers:
      - { docId: deployment, docTitle: Deployment Checklist, chId: canary,
          chTitle: Canary & Rollback,
          description: "5% canary for 30m; auto-rollback on p99 / 5xx thresholds.",
          status: stable, stale: false }
  - name: Diego Córdoba
    kind: person
    covers:
      - { docId: api-design, docTitle: API Design Rules, chId: endpoint-naming,
          chTitle: Endpoint Naming Conventions,
          description: "REST resource naming: plural nouns, no verbs, versioned paths.",
          status: stable, stale: false }
updated: 2026-10-09T00:00:00.000Z
---
# Concept Index — Engineering Rules & Guidelines

*Derived from chapter frontmatter. Regenerable; not the source of truth.*

- **api-design** — 2 chapters
  - `API Design Rules` › *Endpoint Naming Conventions* — REST resource naming…
  - `Error Handling Standards` › *Error Response Format* — RFC-7807…
- **rollback** — 1 chapter
  - `Deployment Checklist` › *Canary & Rollback* — 5% canary…
```

- **Regenerable (FR-009, NFR-004).** `core.rebuildIndex(bDir)` walks every
  `concepts/**/chId.md` **and the `concepts/<docId>.md` document stubs**, reads their
  `concepts`/`person_terms`/`summary`/`status`/`parent`/title frontmatter, and rebuilds
  `terms[]` (term → `kind` + set of (doc, ch, description)) and the body. A term's
  **`kind` is derived here**: `person` iff the term name appears in any `person_terms`
  array, else `topic` (the default) — so the kind survives a rebuild by being *recomputed*
  from the same frontmatter (FR-053, ADR-011). It is O(chapters). Nothing about search
  depends on the file being *current* — a read-through cache validates it (below).
- **O(V) (FR-011, SC-006).** `terms[]` is keyed by distinct term; a bundle with hundreds of
  articles but a few hundred real topics keeps a small table.
- **Read-through cache.** `okf-core` keeps an in-memory `Map<bDir, {index, tocByDoc,
  graph, builtAt}>`. On any read (search/graph/TOC/list-concepts) it checks freshness: a
  write to the bundle bumps a dirty flag (as `markGraphDirty` already does for the link
  graph); a stale/absent cache rebuilds once. The `.md` artifact is **rewritten on the same
  write path** that mutates chapters (so export/import always carries a fresh, correct
  index — FR-010, SC-004), and independently regenerable on read for drift repair.

### 5.4 Document TOC (`toc/<docId>.md`) — format & derivation

Same pattern: frontmatter machine-readable, body human-readable, `.md`, regenerable from
the document's chapters.

```markdown
---
type: toc
document: api-design
title: API Design Rules
updated: 2026-10-09T00:00:00.000Z
chapters:
  - { id: endpoint-naming, title: Endpoint Naming Conventions,
      summary: "REST resource naming: plural nouns, no verbs, versioned paths.",
      concepts: [api-design, naming], status: stable }
  - { id: versioning, title: Versioning Strategy,
      summary: "URL-path versioning; additive-only…",
      concepts: [api-design, versioning], status: deprecated }
---
# API Design Rules — Contents

1. **Endpoint Naming Conventions** — REST resource naming… · `api-design` `naming`
2. **Versioning Strategy** — URL-path versioning… · `api-design` `versioning`
```

`core.rebuildToc(bDir, docId)` derives it from that document's chapter frontmatter.
`okf_read_toc` (§8.2) returns it (FR-004). It is exported/imported with the bundle (FR-010).

### 5.5 `links.json` — explicit edges

`okf_add_link` (FR-031) writes an edge **twice**: as a markdown link in the source
chapter's body (`- [Label](<target>.md)` under a `## Links` section — retained from the
installed `addLink`, human-readable, OKF-portable) **and** as an entry in `links.json`
(`{from, to, label?}`) for cheap graph derivation (ADR-004). The two are reconciled by
`okf_lint` (drift between the markdown links and `links.json` is reported, §8.2 `okf_lint`).
`okf_backlinks` (FR-032) is answered from the link graph (`okf-core`'s existing
`ensureGraph` backlink index, built from `extractLinks`) — unchanged in mechanism.

### 5.6 Invariants (retained + new)

Retained (installed `okf-core.js`): schema-less (only `type` required); unknown frontmatter
keys preserved verbatim (shallow merge, SC-005); human-readable plain markdown;
`raw/` append-only (never overwrite — versioned instead); path-safety on every write.
New: the concept index and each TOC are derived/regenerable and never the sole source of
truth (NFR-004, FR-009); `raw/assets/` are immutable binary copies (FR-020);
`raw/sources.json` is the dedup ledger (FR-018). **Job control (this scope-add):** a job
record's lifecycle is `queued → running → completed | cancelled | failed`; `cancelled` is
a terminal state distinct from `failed` (FR-050); cancelling/deleting a job never mutates
bundle *content* (chapters, index, TOC, `raw/`) — only the job record in `.jobs/`
(FR-050/FR-051).

### 5.7 Person terms — `kind: person` on a term, derived from `person_terms` frontmatter (FR-053/FR-054, ADR-011)

A **person term** is a concept term carrying `kind: person` — a salient person (the
**author**, registered at **document level** on the doc stub's `person_terms`, or a **named
key figure**, registered at **chapter level** on the chapter's `person_terms`) whom ingest
extracts at ingest (FR-053). It is:

- **The same derived concept index** — a row in `concept-index.md` `terms[]` with `kind:
  person`, alongside the topic terms. **Not** a new entity type, **not** a separate content
  file, **not** a new `concepts/` path (FR-053).
- **Found by name through the existing `okf_search`** — a query token matching the person's
  name is an ordinary term-name hit over `terms[]` (the §6.1 algorithm is unchanged); no
  separate search path (FR-053, SC-016). A person term's `covers` is the set of documents
  they authored / chapters where they are the subject.
- **A distinct graph node** — `type:"person"`, its own color (FR-054, §6.3).
- **Kind-reported by `okf_list_concepts`** — the vocabulary lists `kind` per term (FR-054,
  §8.2).

**Where the `kind` lives (ADR-011):** the *source of truth* for a term's kind is the
`person_terms` frontmatter array on the chapter/doc-stub that carries the person — the same
frontmatter `concepts` rides on, already preserved verbatim by the write path (NFR-005).
The *derived* index copies it through as a per-term `kind`; the *graph* and *tool responses*
copy it through again. Nothing new is stored — the kind is recomputed from frontmatter on
every rebuild, so it can never rot out of sync (NFR-004). The extraction decision (who is
salient) is **LLM judgment** in the `okf-ingest` agent, governed by the `okf-bundle-schema`
skill (§7.4); the service only stores and derives.

---

## 6. Retrieval: `okf_search` and the derived views

### 6.1 `okf_search` — the deterministic core primitive (FR-001/FR-002, §5)

**Input** `{bundle, query}` (optionally `limit`). **No LLM in the match** — it is a
lookup, not a reasoning pass. The LLM does *routing* (deciding which concepts/queries to
issue) and *synthesis* (reading returned chapters and answering); `okf_search` is the
deterministic bridge. **This is the SAME function the app's Query-tab search route calls**
(FR-036/FR-043) — one implementation, `core.search(bundleRoot, bundle, query)`, two
surfaces (tool + HTTP).

**Algorithm** (mirrors the mockup's `searchBundle` exactly — that is the binding contract):

```
search(bundleRoot, bundle, query):
  index = core.getIndex(bundle)            # read-through; rebuildIndex if dirty (5.3)
  tokens = lowercase(query).split(/[^\w-]+/).filter(Boolean)
  if tokens empty: return []
  rows = []; seen = Set()
  for term in index.terms:
    termHit  = any tok where term.name.toLowerCase().includes(tok)
    for cov in term.covers:
      descHit = any tok where cov.description.toLowerCase().includes(tok)
      if termHit or descHit:
        key = cov.docId + "/" + cov.chId
        if not seen.has(key):
          seen.add(key)
          rows.push({ docId, docTitle, chId, chTitle,
                      description: cov.description,
                      matchedConcept: term.name,
                      kind: term.kind,            # "topic" | "person" (ADR-011, additive)
                      status: cov.status, stale: cov.stale })
  rank rows:
    # primary: term-name matches before description-only matches
    # secondary: within a tier, number of distinct query tokens matched, desc
    # tertiary: deterministic tiebreak on (docId, chId) for stable output
  return rows[:limit]   # default limit 25; empty on no match (no invented rows)
```

- **Deterministic & explainable.** Every row names the `matchedConcept` — the user/agent
  sees *why* it matched (the mockup's "matched concept" tag). A term-name match outranks a
  description match, so a paraphrase that hits a one-line description still surfaces,
  anchored to the term that owns it.
- **Bounded by V** (NFR-011): the pass is over `index.terms` (distinct terms), not over
  documents/chapters. A chapter covering two matching terms is de-duplicated to one row.
- **Empty result is a valid result** (spec *Edge Cases*): the agent/user widens the query
  or reads the vocabulary via `okf_list_concepts` and routes semantically. No invented rows.
- **Full-text is the *next* step, not this one** (NFR-003): `okf_search` returns TOC rows;
  the agent then `okf_read_concept`s a chapter for its **entire** body. Search never
  returns a chunk in place of the full text.
- **Person names are ordinary term-name hits (FR-053, SC-016).** Person-kind terms live in
  `index.terms` exactly like topic terms, so a query token matching a person's name matches
  the *term name* above — **the algorithm has no person case at all.** The row's additive
  `kind` field (§8.2) is what tells the caller the match was a person vs a topic; it costs
  nothing and helps the agent route (open the person's covering documents/chapters). This is
  why US10's "no separate search path" holds.

### 6.2 Derived read views

- **`core.readToc(bundle, docId)`** — returns the doc TOC (FR-004): the chapter list with
  summaries + concepts, from `toc/<docId>.md` (rebuild if dirty).
- **`core.readConcept(bundle, id)`** — returns a concept's (document or chapter) full
  frontmatter + **entire** body + resolved inline-asset links (FR-005, SC-001). For a
  document id it returns the document stub; its TOC is `readToc`. For a chapter it returns
  the chapter markdown including any inline-asset link + interpretation blocks (FR-023).
- **`core.listConcepts(bundle, {type?, status?, kind?})`** — the vocabulary with each term's
  **`kind`** (`"topic"|"person"`) and per-term chapter counts (FR-006/FR-054), plus (for the
  app) the full (doc, chapter) rows. The optional `kind` filter lists only persons or only
  topics (US10).

### 6.3 Graph derivation (ADR-004) — `core.graph(bundle)`

Computed **on read** from stored content; returned as `{nodes, edges}` for the app's
force-directed renderer (FR-042/FR-045):

- **Nodes:**
  - `type:"doc"` — one per document stub (`concepts/<docId>.md`), `label` = title.
  - `type:"chap"` — one per chapter, `id` = `<docId>/<chId>`, `label` = title.
  - `type:"concept"` — one per **topic** term in the index (`kind: topic`), `label` = term,
    `count` = covering-chapter count (drives node radius in the renderer, as in the mockup).
  - `type:"person"` — one per **person-kind** term in the index (`kind: person`), `label` =
    the person's name, `count` = covering-chapter count (FR-054, ADR-011). A distinct 4th
    node category — the renderer gives it its own color (teal/green). A person node opens
    the *same* term view as a topic (the chapters/documents it covers) — no new view.
- **Edges (typed, directed):**
  - `containment` — `doc → chap`, from each chapter's `parent` frontmatter (the mockup's
    `contains` label).
  - `coverage` — `chap → concept` **and** `chap`/`doc → person`, all from the concept index
    (the mockup's `covers` label). Person terms are index terms, so their covering edges are
    derived identically: the author's `doc → person` edge comes from the doc stub's
    `person_terms`; a key-figure's `chap → person` edge comes from the chapter's
    `person_terms` (FR-053/FR-054).
  - `link` — explicit `okf_add_link` edges from `links.json`/`extractLinks` (the mockup's
    `related` label).
- The app computes neighbor highlighting client-side from this list; no `neighbors`/
  `shortest_path` tool is needed (ADR-004). Node/edge color + label scheme is the
  mockup's (documents gray, chapters blue, **topic** concept-terms violet, **persons
  teal/green — the 4th node category, FR-054**; contains solid, covers dashed-violet,
  related solid-amber), rendered in the BOS dark palette.

---

## 7. Ingest pipeline (auto-triggered headless run; re-scoped, not re-derived)

### 7.1 `okf_ingest` — auto-triggers a headless run and returns a `jobId` immediately (FR-046/FR-047)

`okf_ingest({bundle, source, maxDepth?, maxWorkers?})` runs in the worker. It does **not**
return an instruction block for the caller to execute — it **starts the run and returns
immediately** (FR-046):

1. Validates the source (URL / absolute VFS path / `raw/` path in the bundle) and the
   bundle; runs the dedup check (if `source`'s normalized key is already in
   `raw/sources.json`, it reports the existing `docId` — FR-018 — rather than re-running).
2. Mints a **job** `{id, status:"queued", bundleId, source}` (persisted to
   `/KnowledgeBase/.jobs/<id>.md`; in-memory map updated).
3. **Fires the headless run** through `delegate-bridge.js`: `POST
   /api/subagents/delegate` with the `okf-ingest` agent + a task carrying the `jobId` and
   the source (the run is **self-sufficient** — it does `web_fetch`/`file_to_markdown`
   pinning `output_path`, `okf_add_raw_source`, the decomposition, inline assets, and the
   index — FR-047). It **captures the `runId`** from the `run_started` line and stores it on
   the job, and **holds the NDJSON stream**.
4. **Returns `{jobId, job}` to the caller immediately.** The caller (agent, or the app's
   Ingest modal — which drives the same worker path via `POST /jobs`) is freed (FR-046,
   SC-013).

The document never re-enters the caller as output tokens (the run's acquisition steps pin
`output_path` inside the run). Reference crawl is bounded by `maxDepth`/`maxWorkers`
(FR-019). **Who finalizes the job is the launcher's job** — see §7.3 / ADR-006; who can
stop it — see ADR-010.

### 7.2 `okf_add_raw_source` — mechanical registration (retained)

`{bundle, filename?, content?, sourcePath?, conceptId?, title?}` — versions into `raw/`
(append-only, never overwrites), accepts `content` **or** `sourcePath` (a path already
staged by `web_fetch`/`file_to_markdown` — so large content never passes inline, FR-017),
records the provenance ledger entry, optionally stubs a concept. No LLM, no delegation.
(Used *inside* the headless run by `okf-ingest`, which holds it on its allowlist.)

### 7.3 Run lifecycle & observability flow (ADR-005/ADR-006) + cancel (ADR-010)

```
Caller ─okf_ingest({bundle, source})─▶ Worker (okf-core + delegate-bridge):
            • validates + dedups (FR-018); mints job {id, status:queued, bundleId, source}
            • fires POST /api/subagents/delegate (okf-ingest agent + task carrying jobId)
            • returns {jobId, job} TO THE CALLER IMMEDIATELY (FR-046) — caller freed

Worker (delegate-bridge) ── holds the open NDJSON stream from the delegate route ──▶
            ◀── run_started {runId}  (FIRST line; runner.ts ADR-12) ──▶ store runId on job
            ◀── tool / tool_result / reasoning_delta / final_text lines (ADR-13) ──▶
            • on first substantive bundle write → job: running

runSubAgent (main Next.js process) ─▶ okf-ingest headless run (narrow allowlist, §8.4):
            • web_fetch / file_to_markdown (pin output_path) → okf_add_raw_source → raw/
            • decomposes into chapters; per chapter: okf_upsert_concept(parent, concepts,
                  summary, status, sources)
            • inline non-HTML assets (§7.5): download → view_image/video_keyframes →
                  write link + interpretation block
            • writes toc/<docId>.md + rebuilds concept-index.md (derived)
            • bounded reference crawl (maxDepth/maxWorkers), dedup vs raw/sources.json
            • ENDS with a structured summary in its final message (skill rule, ADR-006)

Worker (delegate-bridge) ── reads the TERMINAL line ──▶  finalizes the job (FR-049):
            done { result.endedReason } :
               completed            → job: completed  + summary (from run's final text)
               cancelled            → job: cancelled   (ADR-010 fired; distinct, not failed)
               error                → job: failed      + result.error
               max_steps            → job: failed      (step-limit)
            [STALE REAPER: a job still queued/running past jobFinalizeTimeoutMs with no
             terminal line → reaper-marked failed (crashed/wedged run — SC-013)]

App Jobs tab / okf_list_jobs ◀── GET /jobs · GET /jobs/<id> (polling) ──▶
            • renders queued → running (live progress if present) → completed |
              cancelled | failed  (FR-041, SC-011)

CANCEL (this scope-add, ADR-010) — from the app (Cancel on a running job) or okf_cancel_job:
   Worker: job terminal? → {cancelled:false, reason:"already terminal"}  (no-op)
           else (running/queued) →
             POST /api/subagents/<runId>/abort  (loopback; the ONE src/ route)
                → route: abortHeadlessRun(runId)  [run-registry; per-run abort — nested reference runs are independent jobs, not cascaded (ADR-010/S1)]
                → {aborted:true}
             run's AbortController aborts → okf-ingest run returns cancelled →
             delegate stream delivers done { endedReason:cancelled } →
             Worker finalizes job: cancelled   (record + written content preserved)
           → {cancelled:true, status:"cancelled"}

DELETE (this scope-add, FR-051) — from the app (Delete on a non-running job) or okf_delete_job:
   Worker: job running? → rejected (409; "cancel it first")
           job not found? → clean not-found (404)
           else → remove the job record from .jobs/ (bundle content untouched)
           → {deleted:true}
```

The service **cannot** see the agent loop's internals (worker boundary) — but it *does*
own the run's stream, so it observes the authoritative terminal outcome directly
(ADR-006), and it stops the run through the platform's generic abort route (ADR-010).
No sub-agent callbacks, no assistant safety-net, no separate cancel write path that could
drift from the run.

### 7.4 Chapter decomposition & index maintenance (sub-agent + skill)

Per the `okf-bundle-schema` skill (rewritten, §3.3): a source is split into **chapters at
its natural heading structure** (FR-012); a source with no headings is a single chapter
(spec *Edge Cases*). Each chapter becomes a `concepts/<docId>/<chId>.md` with
`type:section`, `parent:<docId>`, one-or-more `concepts` terms (vocabulary grows
organically, FR-013), a one-line `summary` (FR-014), `status`, `stale_after` when the
content has shelf life, and `sources` provenance. **Extend-before-create**: the sub-agent
checks existing terms (via `okf_list_concepts`/the index) before introducing a near-
duplicate. After writing chapters it ensures `toc/<docId>.md` and `concept-index.md` are
rebuilt (FR-015) — the service's write path also rebuilds derived artifacts, so this is
self-healing. A document's stub `concepts/<docId>.md` (`type:document`) is upserted so the
document is itself readable/linked. **On completion the sub-agent ends with a structured
summary** (chapters/concepts/assets/refsSkipped/refsFailed) — the content the launcher
records on the job (ADR-006).

### 7.5 Inline asset mechanism (FR-015/FR-020–023, ADR-008)

For every **non-HTML** asset (image, video, other) within a chapter's scope:
1. The sub-agent extracts the asset URL from the source (markdown `![](...)`, or an
   embedded media reference). **HTML links / hyperlinks are left as remote references**
   (FR-022) — not downloaded.
2. It downloads a **local immutable copy** to `raw/assets/<docId>/<name>` (binary write
   via `vfs-bridge.writeBinary` → `/api/fs` base64; the ledger records it).
3. It **interprets** it with `view_image` (image) or `video_keyframes` (video — frames
   returned as vision content) — the sub-agent *sees* it and writes a faithful
   interpretation (what the diagram says, what the clip demonstrates), not a filename guess.
4. It writes the chapter markdown with **a link to the stored asset and the interpretation
   directly beneath it**:
   ```markdown
   ![Canary rollout console](../../raw/assets/deployment/canary-rollback-demo.mp4)

   > **Interpretation (LLM, at ingest):** Screen-capture of the deploy console: the canary
   > pod set is bumped 0→5%, error-rate and p99 sparklines render live, and when the 5xx
   > threshold trips an "Auto-rollback armed" banner appears…
   ```
   (the exact block shape the mockup's `assetBlock`/`.interp` renders).
5. Retrieval (`okf_read_concept`) returns the link **and** the stored interpretation, so
   the agent has the asset's knowledge **without re-running vision** (FR-023, SC-003). The
   app renders the thumbnail (via the asset proxy route, §8) + the interpretation.
6. **Failure isolation**: if a download or interpretation fails, the block is written with
   the interpretation marked *unavailable* (the mockup's `.interp.unavail` amber state) and
   the asset is noted in `okf_lint`; the document ingest is **not** failed wholesale
   (spec *Edge Cases*).

`view_image`/`video_keyframes` are the two non-OKF acquisition tools the sub-agent is
granted specifically for this (they're not 039-declared, not owned by the item — they're
BOS assistant tools the sub-agent's allowlist names; see §8.4).

---

## 8. Service architecture (worker thread) & the app's data access

### 8.1 Worker, config, reachability (retained shape)

- **Worker entry** `services/index.js`: **bind the HTTP server and send
  `initialized`/`bound`/`tool_declare` first** (before any VFS call — a fix retained from
  the installed item so tool registration is reliable at cold start), then best-effort
  `mkdir(bundleRoot)` + a `.jobs/` load. On `tool_call`, dispatch to `handlers[name]`
  (retained). Start `delegate-bridge`'s stale-reaper interval. On `dispose`/`restart`,
  close the server (and any in-flight delegate stream tears down to a reaper-marked job).
- **Config** `config/okf-knowledge-base.json`: `bundleRoot` (default `/KnowledgeBase`),
  `port` (**default `0`** — OS-assigned, the only safe default, `services.md` §3),
  `maxDepth` (default 1), `maxWorkers` (default 3), and **`jobFinalizeTimeoutMs`** (the
  stale-reaper bound for a non-terminal job — ADR-006/FR-049). Runtime port is written to
  `runtime.json` by `ServiceManager` after the `bound` message.
- **App reachability** (`services.md` §11 — the mandatory reading for any service port):
  the app resolves its base URL as **`httpPath` if present else direct `runtime.port`**:
  - *Bastion / reverse-proxied*: `https://<external-host>/__supervisor/services/
    okf-knowledge-base/` (Supervisor `proxyServiceHttp` forwards to the loopback port).
  - *Supervisor-only*: `http://<host>:<public-port>/__supervisor/services/
    okf-knowledge-base/`.
  - *Standalone `npm run dev`*: `http://localhost:<runtime.port>/` (both paths `null`).
  The app (opaque-origin iframe) uses a **direct same-origin `fetch` first, falling back
  to the `window.__bos` broker's `services.call(id, path, init)`** (the workflows-item
  pattern; `services.md` §14) — `services.call` resolves the same `httpPath`-else-port
  base and performs the real request from the trusted parent frame. `bridge.ts` (§3.3) is
  the single place this logic lives. **The app must be granted the `services:read`
  capability** (Settings → Apps) — noted in `docs/usage` as a one-time step.
- **Trust boundary (retained):** `http-bridge` binds `127.0.0.1` **and** verifies the TCP
  peer is loopback (`isTrustedPeer`) — a forwarded `X-Forwarded-For` header can't launder a
  non-loopback peer. Single-user (NFR-008); no per-user ACL in v1.
- **BOS API reachability from the worker:** the same loopback channel the worker uses for
  `/api/fs` is what it uses for the auto-ingest and cancel paths — `POST
  /api/subagents/delegate` (fire the run), and the new **`POST /api/subagents/[runId]/
  abort`** (abort it, ADR-010). Both target the main Next.js process; the run and the
  abort route are in the **same process** (headless runs are single-process by design —
  the run-registry is `globalThis`-scoped), which is what makes the in-process abort
  resolvable from a route.

### 8.2 The 21 tools (FR-037) — the agent surface, exactly 21

Declared under the **Knowledge Base** tool group (`service.json` `toolGroups` — retained).
Read-only tools are `parallelSafe` (retained `readOnly()`). Validation against each
`inputSchema` happens in the 039 bridge before dispatch (FR-038, retained). **No other
tool is declared** (SC-007). Grouping per FR-037, with input/output at implementation
level:

**Retrieval**
- `okf_search` `{bundle, query, limit?}` → `[{docId, docTitle, chId, chTitle, description, matchedConcept, kind, status, stale}]` (FR-001/002, §6.1). The additive `kind` (`"topic"|"person"`) tells the caller a match was a person vs a topic — free, additive, helps the agent route (FR-053/SC-016, ADR-011); a person's name is an ordinary term-name hit (no algorithm change). *readOnly.*
- `okf_read_toc` `{bundle, docId}` → the document's TOC: `{docId, docTitle, chapters:[{id, title, summary, concepts, status}]}` (FR-004, §6.2). *readOnly.*
- `okf_read_concept` `{bundle, id}` → `{id, frontmatter, body, links, assets?}` — **full** body incl. inline-asset links + interpretations (FR-003/005, SC-001). *readOnly.*
- `okf_list_concepts` `{bundle, type?, status?, kind?}` → the vocabulary: `[{term, kind, count, covers:[{docId, chId, title, description}] }]` (FR-006/FR-054, §6.2). Each term carries `kind` (`"topic"|"person"`) so persons are distinguishable from topics (US10/SC-016); the optional `kind` filter lists only persons or only topics. *readOnly.*

**Concepts**
- `okf_upsert_concept` `{bundle, id, title?, body?, frontmatter?}` → the merged concept. Merge-on-fields; unknown keys preserved (FR-024). Triggers derived index/TOC rebuild.
- `okf_delete_concept` `{bundle, id, rewrite_backlinks?}` → deletes the concept file; non-destructive by default; prunes derived artifacts on rebuild (FR-025).
- `okf_merge_concepts` `{bundle, from, to}` → canonicalizes `from`→`to`: rewrites the concept index, every affected `toc/*.md`, and every chapter `concepts` array that referenced either; single canonical entry (FR-026, US6, SC-008).

**Bundles**
- `okf_list_bundles` `{}` → per-bundle health: `{name, docs, chapters, conceptTerms, stale, deprecated, status}` (FR-027, US7). *readOnly.*
- `okf_init_bundle` `{name, title?, description?}` → creates the conformant layout (index.md, log.md, concept-index.md, toc/, links.json, raw/, concepts/, .jobs/) (FR-028, US5).
- `okf_import_bundle` `{bundle, source, type?}` → import from dir/git/tarball; its documents, chapters, **concept index, and TOCs** are present and queryable (FR-029, US5, SC-004). *Rebuilt from a flat `{files}` manifest or a staged dir.*
- `okf_export_bundle` `{bundle, format?}` → spec-conformant OKF **including the concept index and every document TOC**; re-import reproduces a queryable bundle (FR-029, US5, SC-004). *readOnly.* (Excludes operational `.jobs/` by default — Risk #2.)
- `okf_delete_bundle` `{bundle}` → removes only that bundle's directory (FR-030, US5).

**Ingest**
- `okf_ingest` `{bundle, source, maxDepth?, maxWorkers?}` → **auto-triggers the headless run and returns `{jobId, job}` immediately** (FR-016/FR-046/FR-047, §7.1); the run then proceeds headlessly.
- `okf_add_raw_source` `{bundle, filename?, content?, sourcePath?, conceptId?, title?}` → mechanical raw registration (FR-017, §7.2).

**Jobs** *(FR-044/FR-048/FR-050/FR-051)*
- `okf_list_jobs` `{}` → **readOnly** (parallel-safe) — the current ingest runs and their
  lifecycle status: `[{id, status, bundle, source, startedAt, durationMs?/elapsed?,
  progress?, summary?, error?}]` — **the same records the app's Jobs tab shows** (FR-041,
  FR-048). Includes `cancelled` jobs. *readOnly.*
- `okf_cancel_job` `{jobId}` → **cancel a running (or queued-not-yet-started) job**: abort
  the underlying headless run (ADR-010) and transition the job to the distinct
  **`cancelled`** terminal state. → `{cancelled:true, status:"cancelled"}` for a non-
  terminal job, or `{cancelled:false, reason:"already terminal"}` (no-op) for a terminal
  one (FR-050, SC-014). Does not delete the record or bundle content. A non-existent
  `jobId` is an in-band not-found.
- `okf_delete_job` `{jobId}` → **delete a non-running job record**: completed / cancelled /
  failed, or queued-not-yet-started. → `{deleted:true}`; a **running** job is rejected
  (409, "cancel it first"); a non-existent `jobId` is a clean **404**. Removes the job
  record only — never touches bundle content (FR-051, SC-015).

**Organization**
- `okf_add_link` `{bundle, id, target, label?}` → adds an explicit "related" edge (markdown link + `links.json`) (FR-031).
- `okf_backlinks` `{bundle, id}` → concepts linking to `id` (FR-032). *readOnly.*

**Health**
- `okf_lint` `{bundle}` → detects **broken inline-asset links, orphan chapters (no `parent` doc), concept-index / document-TOC drift from the underlying content, and links.json/markdown drift** (FR-033, US-health, SC-010). Because artifacts are derived, drift is *rebuilt*, not patched. *readOnly.*
- `okf_stale_report` `{bundle}` → concepts past `stale_after` (FR-034). *readOnly.*

**Surface count: exactly 21 (FR-037, SC-007)**, down from the prior installed 31.
**This scope-add's only new surface is the two job-control tools** —
`okf_cancel_job` and `okf_delete_job` — added to the Jobs group alongside
`okf_list_jobs` (which the auto-ingest baseline introduced). The rest of the delta from
31→21 is the retrieval/organization redesign carried forward: `okf_search`,
`okf_read_toc`, `okf_merge_concepts` added; and folded/dropped — `okf_bundle_status` (→
`okf_list_bundles` health), `okf_find_concepts` (→ `okf_search`), `okf_read_index`,
`okf_read_bundle_schema` (→ skill, ADR-007), `okf_append_log` (log is internal),
`okf_get_as_of`, the field-setter/provenance family `okf_set_status`/`okf_set_trust`/
`okf_add_source`/`okf_attest`/`okf_provenance` (→ `okf_upsert_concept` frontmatter +
`sources`), and the graph power-tools `okf_remove_link`/`okf_list_links`/
`okf_neighbors`/`okf_shortest_path`/`okf_export_graph` (→ derived graph, ADR-004).
(The authoritative per-name add/keep/remove set is **FR-037's table**; note the spec's
own Overview "added/removed" tallies differ from FR-037's list by the field-setter
folding — the same off-by-a-few the prior design flagged for 31→18 — the invariant that
matters is the **21 declared tools**, SC-007.)

### 8.3 App-facing REST routes (ADR-003) — what the app actually calls

All under the service's loopback base (§8.1), loopback-guarded, `sendJson`-shaped (retained
`http-bridge` helpers). These are **not** 039 tools — they're the app's data layer,
reusing the *same* `core` functions and job-store operations as the tools.

| Method + path | Reuses | Returns | Feeds |
|---|---|---|---|
| `GET /config` | `getRuntime()` | `{httpPath, port, runtime:{bundleRoot}}` | `bridge.ts` base-URL |
| `GET /bundles` | `core.listBundles` | `[{name, docs, chapters, conceptTerms, stale, deprecated, status}]` (FR-027) | Overview bundle list + health stat cards |
| `POST /bundles` | `core.initBundle` | bundle health | "New Knowledge Base" modal |
| `GET /bundles/<b>` | `core.bundleDetail` | `{health, documents:[{id, title, chapters, conceptRefs, updated, source}], conceptIndex:[{name, count, covers:[...], stale}]}` (FR-027 + US7) | Bundle detail header + Documents + Concept Index tabs |
| `GET /bundles/<b>/toc/<docId>` | `core.readToc` | doc TOC (FR-004) | Overview Documents → TOC; Query doc node |
| `GET /bundles/<b>/concept/<id>` | `core.readConcept` | full chapter/document (FR-005) | Overview chapter; **Query reader pane** |
| `GET /bundles/<b>/search?query=&limit=` | `core.search` | **identical** to `okf_search` (FR-036/043) | **Query Search results** |
| `GET /bundles/<b>/graph` | `core.graph` | `{nodes:[{id, type:doc|chap|concept|person, label, count?}], edges:[{from, to, kind:containment|coverage|link}]}` (FR-045/FR-054, ADR-004) | **Query Knowledge Graph** (4th `person` node color in the app) |
| `GET /bundles/<b>/assets/<assetPath>` | `vfs.readRaw` | binary (image/video bytes) w/ content-type | reader-pane asset thumbnail (ADR-008) |
| `GET /bundles/<b>/lint` | `core.lintBundle` | lint report (FR-033) | Overview Health tab |
| `GET /bundles/<b>/stale` | `core.staleReport` | stale list (FR-034) | Overview Health tab |
| `POST /bundles/<b>/import` | `core.importBundle` | health | Import modal |
| `GET /bundles/<b>/export` | `core.exportBundle` | `{name, files:[{path, content}]}` | Export modal |
| `DELETE /bundles/<b>` | `core.deleteBundle` | `{deleted:true}` | Delete modal (confirmed) |
| `GET /jobs` | job store | `[{id, status, bundleId, source, runId?, startedAt, durationMs?, progress?, summary?, error?}]` — **includes `cancelled`** (FR-041) | **Jobs tab list** + tab badge count |
| `GET /jobs/<id>` | job store | full job record incl. summary/error | Job detail (expand) |
| `POST /jobs` | job store + `delegate-bridge` | `{jobId, job}` (queued) | **Ingest modal** (auto-triggers a run, FR-046) |
| `POST /jobs/<id>/cancel` | job store + `delegate-bridge` → `POST /api/subagents/<runId>/abort` (ADR-010) | `{cancelled:true, status:"cancelled"}` \| `{cancelled:false, reason:"already terminal"}` | **Jobs tab Cancel control** (FR-050) |
| `DELETE /jobs/<id>` | job store | `{deleted:true}` \| 409 (running — cancel first) \| 404 (not found) | **Jobs tab Delete control** (FR-051) |

The **graph** and **jobs** response shapes are the app-facing surfaces; their exact JSON
is the `nodes/edges` above and the job record below. The **search** route is byte-for-byte
the `okf_search` result. The **asset** route exists so the opaque-origin app can render
stored inline images/video without reaching `/api/fs/raw` itself. The **cancel/delete**
routes drive the *same* worker job-store + `delegate-bridge` operations as the
`okf_cancel_job`/`okf_delete_job` tools (ADR-003: one capability, two surfaces).

**Job record** (in-memory hot map + `/KnowledgeBase/.jobs/<id>.md` for restart survival):
```jsonc
{
  "id": "run-1042",
  "status": "queued | running | completed | cancelled | failed",   // cancelled is a
                                                                    //   distinct terminal
                                                                    //   state (FR-050)
  "bundleId": "engineering",
  "source": "https://…/performance-budgets",
  "runId": "headless-okf-ingest-1728…",   // set once captured from run_started (FR-052)
  "startedAt": "2026-10-09T11:58:00Z",
  "endedAt": null,
  "durationMs": null,
  "progress": "Interpreting inline asset raw/assets/…/perf-chart.png · writing 3 of 6 chapters",  // optional, live
  "summary": { "chapters": 6, "concepts": 8, "assets": 1, "refsSkipped": 2, "refsFailed": 0,
               "written": ["Perf Budget Basics", "…"] },          // on completed
  "error": null                                                   // on failed (cancelled
                                                                  //   has error null — it
                                                                  //   is a stop, not an
                                                                  //   error)
}
```
The Jobs tab **polls** `GET /jobs` (and, for the expanded row, `GET /jobs/<id>`) on a short
interval (the mockup's live "elapsed" + progress bar), reflecting status as it changes —
**including the `cancelled` dot** (FR-041, SC-011). The **Cancel** control on a running row
fires `POST /jobs/<id>/cancel`; the **Delete** control on a non-running row fires
`DELETE /jobs/<id>` (FR-050/FR-051). (Polling, not SSE, is simplest and matches the
loopback bridge; an NDJSON tail could replace it later without changing the record shape.)

### 8.4 The bundled `okf-ingest` agent — least-privilege allowlist (FR-039, NFR-009)

`agents/okf-ingest/AGENT.md` `tools:` — **rewritten** for the new surface. The job-control
tools (`okf_list_jobs`/`okf_cancel_job`/`okf_delete_job`) are **not** granted here — the
`okf-ingest` run *is* the job; it does the work and reports a structured summary in its
final message (ADR-006). Managing/listing/cancelling/deleting jobs is a **top-level
assistant and app** concern:

```
okf_ingest,
okf_add_raw_source,
okf_list_concepts, okf_read_concept, okf_read_toc, okf_search,
okf_upsert_concept, okf_add_link,
web_search, web_fetch, file_to_markdown, view_image, video_keyframes,
file_read, file_list
```

- **Read/organize:** `okf_list_concepts` (extend-before-create, dedup), `okf_read_concept`
  (context), `okf_read_toc` (what a doc already covers), `okf_search` (is this term already
  routed?), `okf_add_link` (connect new chapters to existing ones), `okf_upsert_concept`
  (write chapters + document stub + frontmatter; the write path rebuilds the index/TOC).
- **Acquisition (for references it follows + inline assets):** `web_search`, `web_fetch`,
  `file_to_markdown`, `view_image`, `video_keyframes` — the last two **specifically for
  inline-asset interpretation** (FR-039 names them). `file_read`/`file_list` to read the
  raw source from the bundle.
- **`okf_ingest`** is granted so the run can fire **independent nested reference jobs** (FR-019/FR-047) — it is the **only** job-lifecycle tool the `okf-ingest` run gets; it still does **not** get `okf_list_jobs`/`okf_cancel_job`/`okf_delete_job` (those stay top-level-assistant / app concerns — the run fires nested jobs, it doesn't list/cancel/delete them).
- **`okf_add_raw_source`** is granted so the run registers its own source into `raw/`
  (the self-sufficient run, FR-047). Recursive reference ingest, if the run follows one,
  spawns independent nested jobs — each `okf_ingest` call mints its own job, fires its own headless run, and captures its own runId; they appear as separate rows in the Jobs list and are cancelled/deleted independently (per-run abort, not family cascade — ADR-010, S1).
- **Explicitly NOT granted:** `okf_delete_concept`/`okf_delete_bundle` (destructive stays
  a top-level-assistant / app-explicit action), `okf_merge_concepts` (curation, not
  ingest), the job-control tools (`okf_list_jobs`/`okf_cancel_job`/`okf_delete_job`),
  unrestricted `run_command`, `agent_delegate`, and every non-OKF, non-acquisition tool.
  No full assistant surface (NFR-009).
- It has the `okf-bundle-schema` **skill** attached (FR-040) — the conventions (§7.4, §5.2,
  §5.7/ADR-011 **person-kind convention** — what "salient" means: the author at doc level,
  named key figures (subjects, not every name) at chapter level, the `kind: person`
  semantics, and the extend-before-create check that a person name isn't already a topic
  term — the §7.5 block format, and the "end with a structured run summary" rule for
  ADR-006) live there, not in a per-bundle file.

---

## 9. Data flow, error handling, lifecycle

**Retained** (installed item): 039 tool invocation (`tool_call`→worker→`tool_result`/
`tool_error`, errors in-band never a crash, FR-038/NFR-007); service lifecycle (start/
stop/restart, crash recovery, tools removed on stop/uninstall — SC-009, retained);
app↔worker via `httpPath`/direct-port (ADR-003); path-safety + atomic writes (NFR-006).

**Flows (auto-ingest + job control):**

```
Retrieval (agent):
  okf_search(bundle, query) → [TOC rows]          (deterministic, §6.1)
    → okf_read_toc(bundle, docId)  → chapter list → okf_read_concept(bundle, doc/ch) → FULL text
  or okf_read_concept(bundle, doc) directly for the whole document

Retrieval (app, Query tab):
  GET /bundles/<b>/search?query=  → same [TOC rows] → click → GET /concept/<id> → FULL chapter
  GET /bundles/<b>/graph          → {nodes, edges}  → force-render → click node → same /concept

Ingest (auto-triggered, headless — ADR-005/ADR-006):
  okf_ingest → worker mints job(queued) + fires POST /api/subagents/delegate,
              captures runId, holds the stream, RETURNS {jobId, job} immediately
  → okf-ingest run (main process): acquisition (pin output_path) → okf_add_raw_source →
     chapters (upsert) + concepts/summaries + assets (download+interpret) + toc +
     concept-index (derived rebuild) + ENDS with a structured summary
  → worker reads terminal line → job → completed | cancelled | failed (reaper covers stuck)

Job control (this scope-add — ADR-010 / FR-050 / FR-051):
  cancel: okf_cancel_job / POST /jobs/<id>/cancel
          → (terminal? no-op) → POST /api/subagents/<runId>/abort (generic src/ route)
          → abortHeadlessRun(runId) aborts the run → run ends cancelled → worker writes job: cancelled
  delete: okf_delete_job / DELETE /jobs/<id>
          → (running? 409 cancel-first) → (missing? 404) → remove job record only

Inline asset:
  run → download non-HTML asset → vfs-bridge.writeBinary → raw/assets/<docId>/<name>
      → view_image / video_keyframes → interpretation text
      → okf_upsert_concept writes the link + interpretation block into the chapter
```

**Error handling:** every `okf_*` and HTTP route returns in-band errors (404/409/400 via
the retained `statusForError`); a failed chapter/asset never fails the whole document
(spec *Edge Cases*); a failed ingest leaves `raw/` and the index consistent because the
derived artifacts rebuild from content (NFR-004). **Cancel/delete semantics:** cancelling
a terminal job is a no-op; cancelling never deletes the record or content; deleting a
running job is rejected (409); deleting a missing job is a clean 404; deleting never
touches bundle content (FR-050/FR-051, SC-014/SC-015). **Lifecycle:** service
stop/uninstall removes all **21** tools immediately (SC-009, retained); an in-flight
delegate stream tears down and its job is reaper-marked `failed` if it was non-terminal
(ADR-006). The `.jobs/` dir and derived artifacts are bundle-scoped, so they're removed
with `okf_delete_bundle`.

---

## 10. Risks / open questions

1. **`raw/` binary through `/api/fs` base64.** `vfs-bridge` today only does text
   (`readText`/`writeText` → `/api/fs?op=read|write`). Non-HTML assets are binary, so we
   add `writeBinary` (base64 → `op:write`) and `readRaw` (`GET /api/fs/raw?path=`). **Open:
   confirm the `/api/fs` `write` op accepts a base64-marked payload and that `readRaw`
   streams without buffering large video.** A 100MB+ video held in a JSON body would be
   wrong; use the streaming path for large assets.
2. **Job record durability vs. OKF purity.** Jobs live under the bundle root
   (`.jobs/`) to survive restart, but they're *operational* state, not OKF *content*.
   **Open: should export include `.jobs/`?** Default: exclude it from
   `okf_export_bundle` (it's not part of the distributable contract, NFR-001) but keep it
   on disk; confirm the reviewer wants export to skip `.jobs/` (and note that deleting a
   job — FR-051 — is the per-record analogue and also never touches content).
3. **Cancel before the `runId` is captured (queued race).** The worker can only abort a
   run once it has the `runId` from the `run_started` line. A cancel arriving in the tiny
   window between `okf_ingest` returning and `run_started` arriving: the job is marked
   `cancelled` (non-terminal → cancel applies); then `delegate-bridge`, **the moment `run_started` lands and the `runId` is captured**, sees the job is already `cancelled` and **immediately fires `POST /api/subagents/<runId>/abort`** (the committed behavior — it does **not** wait for natural completion). **Residual:** the run may have done a few steps before the abort lands — that's the committed bar (cancel is a stop, not a rollback; partial content is preserved and the index regenerates). The reviewer confirmed this "best-effort prompt stop" (not "atomic no-side-effects cancel") is the right bar.
4. **The one `src/` change must stay generic.** `POST /api/subagents/[runId]/abort` is the
   only BOS-source file. It must not leak OKF knowledge (no job store, no bundle, no agent
   id) or a future headless consumer will inherit OKF coupling. It also relies on the
   run-registry being **process-local** (`globalThis`) — correct because a headless run
   lives in exactly one process, but it means the abort route must be hit in the *same*
   process that owns the run (loopback, same Next.js instance — true for this item).
   **Open (multi-instance deployments):** if BOS ever runs multiple Next.js instances
   behind a load balancer, a run-registry abort only works in the owning instance — a
   future concern, not a v1 one (headless runs + self-heal already share this constraint).
5. **Sub-agent structured-summary fidelity (ADR-006).** The launcher records the job
   summary from the run's final `final_text`; the skill makes "end with a structured
   summary" a first-class rule and the sub-agent "reports honestly" (a partial run that
   hit `maxDepth` reports `completed` with honest `refsSkipped`/`refsFailed`, not
   `failed`). **Residual:** a run that dies *before* its final message (crash) yields no
   summary — the stale reaper marks it `failed`, and the worker can optionally derive a
   partial summary from the bundle diff it owns. Confirm the reviewer wants the reaper
   case to be bare `failed` or best-effort-summary-then-`failed`.
6. **Concept-term normalization & merge quality (FR-026, US6).** Organic vocabulary
   accumulates near-duplicates; `okf_merge_concepts` is the guard. **Open:** the
   *detection* of near-duplicates (to suggest a merge) is a candidate for a lightweight
   pass in `okf_lint` — not in v1 scope, additive.
7. **`okf_search` description-match recall.** The match is over **term names + one-line
   descriptions**, not full text (that's the point — concept-anchored). A paraphrase that
   misses both returns empty (spec *Edge Cases*: agent widens or reads the vocabulary).
   **Intended, not a bug** — the UI makes it legible. Ensure `summary` quality at ingest is
   high, since it's the retrieval surface.
8. **App force-simulation cost on large bundles.** Cap initial render to a sample or
   cluster by-document, with the search box to narrow; the mockup sim is O(N²) per tick —
   fine for the hundreds-node case, but add a node-count guard.
9. **`okf_import_bundle` source types.** dir/git/tarball (FR-029). **Open:** how the app's
   Import modal hands bytes to the service (dir → VFS + POST `{files}`; git/tarball →
   better done by the assistant, which has the tools). Confirm the intended import vector
   before implementation; the data model is unchanged regardless.
10. **`view_image`/`video_keyframes` availability.** Fixed BOS prerequisites (spec
    *Assumptions*). If a provider lacks native vision, `view_image` still returns vision
    content blocks; `video_keyframes` falls back to ffmpeg frame sampling. The run
    interprets whatever it's handed.
11. **Pre-existing installed item upgrading into this redesign.** The installed item has 31
    tools, a dispatcher `okf_ingest`, `schema.md`-based conventions, and a config-app.
    Upgrading means: the 31→21 tool change (tools removed on the next start — SC-009), the
    auto-ingest switch (dispatcher → worker-fired headless run, ADR-005), the
    derived-index introduction (pre-redesign bundles have no `concept-index.md`/`toc/`;
    the read-through rebuild generates them on first read — **self-healing, no migration
    required**), the job-store introduction, and the cancel/delete capability. **Biggest
    data-model open question:** decide whether pre-redesign bundles get a best-effort
    derived index or require re-ingest to gain the full two-level index.

---

## 11. UI mockup reference

- **Path:** `item-okf-knowledge-base/mockup.html` (this spec directory) — the **binding
  visual + interaction contract**, already implementing the full app shell:
  - **App shell** — titlebar (🧠 OKF Knowledge Base, a "21 `okf_*` tools" badge,
    Populated/Empty mode toggle) + top tab bar **Overview / Jobs / Query** (with a live
    Jobs badge). This is the FR-035 master-detail app, not a settings page.
  - **Overview** — bundle list (per-bundle Docs/Chapters/Concepts/Stale + status dot) →
    bundle detail (health stat cards; tabs **Concept Index / Documents / Health /
    Import·Export**) → concept index (searchable, expandable term → (doc, chapter) rows
    with descriptions) → document → **stored TOC** → **full chapter** (frontmatter card,
    markdown body, **inline-asset** blocks with thumbnail + stored interpretation,
    "View source (.md)" toggle). Modals: New / Import / Export / **Ingest** / Delete.
  - **Jobs** (scope-add surface — updated for this change) — run list (status dots **queued/running/completed/cancelled/failed**, bundle, source, time, elapsed/duration), with **a cancelled status dot and a cancelled sample run**, a **Cancel** control on running jobs, and a **Delete** control on non-running jobs (FR-041, FR-050, FR-051) → expandable detail (summary cells: chapters/concepts/assets/refsSkipped/refsFailed; written-chapter chips; error card; live progress bar). Cancel → `POST /jobs/<id>/cancel`; Delete → `DELETE /jobs/<id>` (§8.3) — driven by these routes.
  - **Query** — bundle selector + a **shared search box** + a **Graph / Table** view toggle;
    a **mouse-resizable reader pane** (the `.resizer`) that opens the full chapter
    (frontmatter + markdown + assets + **"Open source"** link at top) or a document's TOC
    or a **concept-term / person view** (both open the same term view — the chapters the
    term covers; FR-054). The **Knowledge Graph** is a dependency-free **force-directed**
    SVG of category-colored circular nodes (doc gray / chapter blue / **topic** concept
    violet / **person teal-green — the 4th node category added by this scope-add**, FR-054)
    with **labeled directed edges** (contains solid / covers dashed-violet / related
    solid-amber), legend, hover-to-trace-neighbors (dims non-neighbors to 30%), pan/zoom/
    drag, and search-highlight. **Person nodes** (e.g. the author) carry `covers`/`doc→`
    person edges to the documents/chapters they are the subject of and render in the 4th
    color; the **Table** view lists the node's `kind` (topic vs person) alongside its type
    and name.
- **Map to the Component design (§3.3 `app/src/`):** shell→`App.tsx`; Overview
  (list/detail/concept-index/documents/TOC/chapter/health/IO + modals)→`app/src/overview/`;
  Jobs (list/detail/progress/**cancel/delete**)→`app/src/jobs/`; Query (graph + table +
  search + reader pane + resizer)→`app/src/query/`; the force sim is ported verbatim from
  the mockup's `stepGraph/renderGraph/drawGraph/attachGraphInteractions` (ADR-009) — with a
  **4th node color for `type:"person"` (teal/green)** added on top of the mockup's
  doc/chapter/topic scheme (FR-054); the
  tiny markdown renderer + `assetBlock`/`interp` are ported to `app/src/lib/markdown.ts`;
  the API clients in `app/src/lib/api.ts` map 1:1 to the §8.3 REST routes (incl. the new
  `POST /jobs/<id>/cancel` and `DELETE /jobs/<id>`); `bridge.ts` resolves the service base
  URL (§8.1). The mockup's `SOURCES`/`docSource` (URL-or-raw-path) is exactly the FR-043
  "Open source" target logic (original ingested URL from `sources`, else the stored `raw/`
  path). The Jobs-tab Cancel/Delete controls and the `cancelled` dot are the scope-add's
  app-side surface; their data routes are in §8.3.
- **No separate mockup files** — the spec asks for one consolidated `mockup.html`, which
  this is. The app implements it; where the spec's "To be added at the design step" items
  (shell, Jobs incl. cancel/delete, Query/Graph/Search, resizable pane) are concerned,
  **the mockup contains them (updated for this scope-add)** and this design's §8.3 supplies the data routes that
  drive them.
