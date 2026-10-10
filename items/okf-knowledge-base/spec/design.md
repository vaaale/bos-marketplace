# Design — OKF Knowledge Base (Redesign)

Replaces the pre-redesign `design.md`. That document's center of gravity was *ingest*
(a multi-format acquisition pipeline) and its classification was *mixed*
(`bos-core` + `marketplace-item`). This redesign moves the center of gravity to
**organization + concept-anchored retrieval**, turns the settings config-app into a
**standalone master-detail app**, and re-scopes ingest as the mechanism that *builds*
the index retrieval depends on. Decisions the new spec locks in are treated as fixed;
the four old `bos-core` prerequisites are treated as **dependencies, not re-scoped here**
(spec App Target). Where this design carries something forward from the old document
(service-facet shape, VFS loopback bridge, 039 tool exposure, dispatcher-shaped
`okf_ingest`), it is labeled **retained** — not re-litigated.

---

## 1. Classification

**`marketplace-item`** — a single self-contained item at
`data/user-apps/items/okf-knowledge-base/` with **three facets of one item**:

1. **Service facet** — the worker-thread daemon that owns OKF storage, maintains the
   derived index, declares the 19 `okf_*` tools via the 039 Service Tool Exposure
   contract, and runs a loopback REST bridge the app talks to.
2. **App facet** — a **standalone master-detail app** (Overview / Jobs / Query),
   dock-openable, replacing the old settings-embedded `config-app/index.html`.
3. **Bundled agent + skill** — the `okf-ingest` least-privilege sub-agent and the
   `okf-bundle-schema` skill, copy-installed into `data/agents/` / `data/skills/`.

This **agrees with `spec.md`'s own `App Target` field** (`marketplace-item`, not mixed).
The prior design's classification (mixed) is superseded: the four `bos-core` changes the
old spec scoped (fixed `web_fetch`, `file_to_markdown`, `view_image`, `video_keyframes`,
the `ToolExecuteResult` attachment path, `ffmpeg` in Docker, agent/skill copy-install)
are now **assumed-present prerequisites** (spec *Assumptions*). If any has not actually
shipped it is a separate BOS-source follow-up — not part of this item's deliverable.
Nothing in this design touches `src/`.

### Why marketplace-item and not `bos-core`/`builtin-app`

- The KB needs a **background daemon + agent-callable tools + a companion UI**: exactly
  the three-facet marketplace-item shape 039/035 already support (precedent: the
  Terminal item — `app/` + `services/` in one item, `target-marketplace-item.md`).
- **No reasoning toward `bos-core` applies**: the service binds its own loopback port and
  runs entirely outside Next.js; the app is a sandboxed iframe; the agent/skill ride the
  item. Nothing forces routing/middleware/`src/` work.
- **Not `builtin-app`**: the app is a self-contained user tool with its own lifecycle and
  a companion service, not a thin wrapper around a BOS subsystem. The
  built-in-vs-marketplace checklist (`docs/dev/guides/apps.md` §1) tips to item: it
  should be independently installable/removable and it ships a background daemon, which
  a built-in app cannot do at all.

### Facet note (the one thing to say out loud)

A service facet + an app facet in the same item is the **normal shape**, not a special
case (`target-marketplace-item.md`, "Precedent"). This item has both because ingest is
agent-driven (needs the service + sub-agent) *and* the user needs a first-class window
to browse the index/TOC, watch jobs, and explore the graph. One item, one symlink, one
install.

---

## 2. Constitution check

| Principle | Compliance |
|---|---|
| **I. Spec-Driven** — feature defined by a spec before build; pipeline. | ✅ Spec is `item-okf-knowledge-base/spec.md` (this is the `design` step). No code is a source of truth. |
| **II. Server Authority & SSR Boundary** — filesystem/Node live in server code; clients fetch. | ✅ All OKF storage and the derived index live in the worker (server-side, behind the loopback bridge). The app iframe and the assistant both reach it over HTTP; no OKF logic in the app bundle. |
| **III. Always Delegate; Claude Codes** — development on a sub-agent. | ✅ This design is authored by the Architect; implementation is delegated to the Developer. The feature's *runtime* trigger (`okf-ingest`) reuses the existing headless `runSubAgent` surface (`POST /api/subagents/delegate`) over the worker's existing loopback channel — no new infra (ADR-005). |
| **IV. Minimize Blast Radius** — feature branch; self-modification isolated. | ✅ Lands on the active `bos/okf-kb-redesign` branch; item work is branch-coupled in `data/user-apps` and promotes/discards with the branch. |
| **V. The VFS Is Not the Source** — user data under `data/`; versioned apps in their own GitFS repo. | ✅ Bundles live under the VFS at `/KnowledgeBase/` (user data, owned by the service). The item's code lives in the `user-apps` GitFS repo, reached through the item symlink — never in BOS source. |
| **VI. Specs & Docs Stay in Sync** | ✅ The item ships its own `docs/usage/OKF Knowledge Base/` and `docs/dev/OKF Knowledge Base/` facets, updated in the same change. This `design.md` is the architecture artifact the later `plan`/`tasks` reference. |
| **VII. Respect Boundaries** — confirm destructive ops; no new deps unasked. | ✅ `okf_delete_bundle`/`okf_delete_concept` are the only destructive ops and stay explicit-intent (the app gates them behind confirmation dialogs per the mockup; the agent doesn't get them — see §8). No new runtime dependency is introduced: the app reuses BOS's existing in-app SVG force simulation (no `d3`/`vis.js` added — ADR-009). |
| **OKF invariants (NFR-001/005)** — schema-less, human-readable, unknown keys preserved, raw immutable. | ✅ Retained from the installed `okf-core.js` (frontmatter shallow-merge already preserves unknown keys; `raw/` is append-only and never overwritten). The derived index/TOC add *new* frontmatter keys (`type`, `parent`, `concepts`, `summary`, `status`, `stale_after`, `sources`) — all preserved verbatim on write. |
| **Least privilege (NFR-009)** — the ingest sub-agent's allowlist stays narrow. | ✅ §8 lists the exact allowlist; it excludes destructive tools, unrestricted `run_command`, and the full assistant surface. |

No conflicts flagged. One note for the reviewer: NFR-002 ("no vector/SQL/embeddings in
v1") is satisfied structurally — retrieval is a deterministic pass over a derived
`.md`/frontmatter index plus full-chapter reads; the escalation path to a keyword/BM25
pre-filter is documented in ADR-001, not built.

---

## 3. Architecture

### 3.1 Context

The user installs the OKF Knowledge Base item. It becomes a **service** owning
`/KnowledgeBase/<bundle>/`. Three entry points exist:

- **The assistant** uses the 19 `okf_*` tools to ingest (`okf_ingest` auto-starts a headless
  `okf-ingest` run and returns a `jobId` at once), to retrieve (`okf_search` →
  `okf_read_toc`/`okf_read_concept`), to curate concepts and bundles, to observe runs
  (`okf_list_jobs`), and to check health.
- **The user** opens the standalone **app** (a dock window) and uses its three tabs:
  **Overview** (list/manage bundles, browse the concept index and document TOCs, lint,
  import/export), **Jobs** (watch ingest runs through their real lifecycle), and **Query**
  (a force-directed **knowledge graph** and a **concept-anchored search**, both driving a
  resizable reader pane that opens the full chapter with a link to the original source).
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
        DELEG["runSubAgent headless runner (POST /api/subagents/delegate)"]
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
        CORE["lib/okf-core.js — OKF storage engine + derived index/TOC/graph/search"]
        VFSB["lib/vfs-bridge.js — loopback /api/fs (+ /api/fs/raw for binary assets)"]
        HTTPB["lib/http-bridge.js — app-facing REST (bundles, index, toc, search, graph, jobs)"]
        TOOLS["lib/tools.js — 19 okf_* declarations + handlers"]
        AGENTB["agents/okf-ingest/AGENT.md  ·  skills/okf-bundle-schema/SKILL.md"]
        W --> CORE
        W --> VFSB
        W --> HTTPB
        W --> TOOLS
        HTTPB --> CORE
        TOOLS --> CORE
    end

    SUB["okf-ingest sub-agent (headless run, self-sufficient allowlist)"]

    SM -->|spawn + tool_call/tool_result| W
    TOOLS -->|"okf_ingest: POST /api/subagents/delegate {agent,task} (loopback, async)"| DELEG
    DELEG -->|runSubAgent(okf-ingest)| SUB
    DELEG -.->|"NDJSON progress + terminal {done|error} → W finalizes job (ADR-006)"| W
    SUB -->|"okf_* tool_call (IPC)"| SM
    SUB -->|"optional progress (loopback POST /jobs/<id>)"| HTTPB
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
- **Dispatcher-shaped `okf_ingest`** that returns the exact next calls (acquisition
  steps pinning `output_path`, then a delegation block) rather than fetching itself —
  the worker runs outside Next.js with no `web_fetch`/`file_to_markdown`.

**New in this redesign**: the derived **concept index + document TOC** in `okf-core.js`
(§5), **`okf_search`** (the deterministic core primitive, §6), **run observability**
(AbR-006, §7.3), the **inline-asset pipeline** (FR-015/FR-020–023, §7.5), the **graph
derivation** (ADR-004, §6.3), the **app-facing REST surface** (ADR-003, §8), and the
**standalone master-detail app** (replaces the config-app).

### 3.3 Component — deliverable file plan

Paths under `data/user-apps/items/okf-knowledge-base/` (the **as-built** layout the
installed item already uses — a consolidated `services/lib/`, not the old design's
idealized `services/tools/*.js` split):

```
data/user-apps/items/okf-knowledge-base/
├── services/
│   ├── service.json           # RETAINED shape; port default 0 (unchanged). Config schema
│   │                          #   already carries bundleRoot/maxDepth/maxWorkers; adds staleJobMs.
│   ├── index.js               # RETAINED worker entry. Changes: (a) keep the
│   │                          #   bind-then-handshake-first ordering; (b) extend the VFS
│   │                          #   bridge to binary (see vfs-bridge); (c) the okf_ingest
│   │                          #   handler fires the headless delegate request and consumes
│   │                          #   its NDJSON stream to own the job's terminal state
│   │                          #   (ADR-005/006). Tool_declare loop reads tools.js.
│   └── lib/
│       ├── okf-core.js        # REWORKED. Retains: frontmatter YAML-lite, path safety
│       │                      #   (safeJoin/validate*), raw/ append-only, shallow-merge
│       │                      #   upsert, links/extractLinks, log. ADDS: concept index
│       │                      #   + doc-TOC derivation & rebuild (§5.4), okf_search
│       │                      #   (§6), graph derivation (ADR-004, §6.3), merge_concepts,
│       │                      #   bundle health (docs/chapters/term counts + stale),
│       │                      #   binary raw-asset write/read (via vfs-bridge),
│       │                      #   raw/sources.json provenance ledger (FR-018),
│       │                      #   jobs persistence under /KnowledgeBase/.jobs/.
│       ├── vfs-bridge.js      # RETAINED /api/fs loopback. ADDS writeBinary/readRaw for
│       │                      #   non-HTML assets: write via /api/fs op=write with a
│       │                      #   base64 payload; read/stream via GET /api/fs/raw?path=.
│       ├── http-bridge.js     # RETAINED loopback guard (isTrustedPeer) + sendJson.
│       │                      #   REPLACES the old config-app routes with the app-facing
│       │                      #   surface in §8 (bundles, bundle-detail, toc, chapter,
│       │                      #   search, graph, jobs, asset proxy).
│       └── tools.js           # REWORKED. DECLARATIONS = exactly the 19 tools in §8.2
│                              #   (was 31). Handlers reuse okf-core; read-only tools stay
│                              #   parallelSafe (readOnly()). okf_ingest auto-triggers a
│                              #   headless okf-ingest run, returns jobId (ADR-005);
│                              #   okf_list_jobs is readOnly (FR-048).
├── agents/
│   └── okf-ingest/
│       └── AGENT.md           # REWORKED. Self-sufficient allowlist (§8.4): the full
│                              #   okf_* surface + acquisition + VFS reads. Instructions:
│                              #   acquisition (web_fetch/file_to_markdown, output_path
│                              #   pinned), chapter decomposition, concept assignment,
│                              #   one-line summaries, doc-TOC + concept-index maintenance,
│                              #   inline-asset interpret-and-preserve, nested reference
│                              #   ingest (own okf_ingest), final honest summary.
├── skills/
│   └── okf-bundle-schema/
│       └── SKILL.md           # REWORKED. Authoritative ingest/query/lint conventions:
│                              #   two-level index schema, chapter frontmatter
│                              #   (type/parent/concepts/summary/status/sources/stale_after),
│                              #   concept-term naming/merge policy, inline-asset block
│                              #   format, dedup. Replaces the per-bundle schema.md voice
│                              #   as the source of conventions (ADR-007).
├── config/
│   └── okf-knowledge-base.json  # RETAINED (bundleRoot, port:0, maxDepth, maxWorkers, staleJobMs).
├── app/
│   └── src/                   # NEW standalone master-detail app (replaces app/config-app/).
│       ├── main.tsx           # entry — mounts into #root (per the item app-facet anatomy;
│       │                      #   app_build bundles this). React is provided by the
│       │                      #   bundler; no npm install.
│       ├── App.tsx            # tab shell: Overview / Jobs / Query (mockup .app/.tabbar).
│       ├── bridge.ts          # service base-URL resolution: same-origin fetch → else
│       │                      #   __bos broker services.call / services.getConfig
│       │                      #   (workflows-item pattern). Single place the app learns
│       │                      #   httpPath vs runtime.port (services.md §11).
│       ├── overview/          # BundleList, BundleDetail, ConceptIndexView, DocumentsView,
│       │                      #   TocView, ChapterView, HealthView, ImportExport,
│       │                      #   modals (new/import/export/delete/ingest).
│       ├── jobs/              # JobsList (lifecycle status dots, elapsed), JobDetail
│       │                      #   (summary cells / error / progress), polling loop.
│       ├── query/             # QueryShell (bundle select + search + Graph/Table toggle),
│       │                      #   GraphView (force sim — port of the mockup's stepGraph/
│       │                      #   renderGraph/drawGraph, dependency-free), TableRows,
│       │                      #   SearchResults, ReaderPane (frontmatter + md + assets +
│       │                      #   source link + concept-term view), Resizer.
│       └── lib/               # api.ts (typed clients for §8 routes), markdown.ts
│                              #   (the mockup's tiny renderer, kept), types.ts.
└── docs/                       # REQUIRED item facet (target-marketplace-item.md).
    ├── usage/OKF Knowledge Base/
    │   ├── index.md           # what it does, the three tabs, retrieval model in plain terms.
    │   ├── ingest.md          # how to trigger ingest, what a run does, watching Jobs.
    │   └── troubleshooting.md # search misses (concept-anchored, not full-text), stale items,
    │                          #   import/export, service not started (Settings → Plugins).
    └── dev/OKF Knowledge Base/
        ├── architecture.md    # this design, condensed: containers, derived index, jobs.
        ├── data-model.md      # bundle layout, frontmatter schema, index/TOC format.
        ├── tool-surface.md    # the 18 tools (mirror of §9).
        └── extension.md       # adding a bundle convention, the okf-ingest skill as the seam.
```

No `src/` (BOS-source) files are created or modified. No `app.json`/`service.json` are
hand-written into `data/user-apps` — the Developer stages the facets and
`app_build({name, dir, id:"okf-knowledge-base"})` installs the full item.

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
  bundle, trigger ingest) access to the same data the tools expose.
- **Options.** (a) The app calls the 18 `okf_*` tools through some new agent-bridge. (b) A
  **dedicated app-facing REST surface** on the service's loopback port, reusing the *same*
  `okf-core.js` functions as the tools, exposing the shapes the UI actually needs (bundle
  list, bundle detail incl. stats + concept index + documents, doc TOC, chapter, search,
  graph, jobs, job detail, asset proxy).
- **Decision.** **(b)** — the app-side HTTP API **is** the data access layer for
  Overview/Jobs/Query (spec FR-036; the delegation's locked decision). Rationale: the app
  already reaches the service over HTTP today (the old `config-app` did, via `httpPath`);
  the 039 tools are an *agent* surface (IPC-dispatched, JSON-schema-gated) and shouldn't be
  the app's transport; and the app needs shapes (graph, jobs, the concept index as a
  browseable tree) that are *views* over the same core, not new agent capabilities.
- **Consequences.** **Adding app views does NOT add to the 18-tool agent surface** (FR-036)
  — the HTTP routes are internal plumbing, not `tool_declare`d tools. One capability, two
  surfaces: `okf_search` and the `GET /search` route run the **identical** `core.search()`
  (FR-001/FR-002, FR-043). The app's reachability is the standard `httpPath`-else-port
  pattern (`services.md` §11) behind the same loopback trust boundary the old bridge had
  (§8.1).

### ADR-004 — Graph: derived on read from stored frontmatter/index/links, not a stored graph DB

- **Context.** FR-042/FR-045 require a force-directed knowledge graph (documents, chapters,
  concept terms; typed directed edges) for the Query tab. The old design had graph
  "power tools" (`okf_neighbors`, `okf_shortest_path`, `okf_export_graph`) — dropped from
  the 18-tool surface.
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

### ADR-005 — `okf_ingest` auto-triggers a headless `okf-ingest` run (supersedes the dispatcher-returns-instructions model)

- **Context.** Calling `okf_ingest` should start ingestion *automatically* and free the
  caller immediately (spec FR-046). The service is a worker thread outside Next.js — it
  cannot run an LLM turn or call `agent_delegate` *directly*, but it **can reach BOS's HTTP
  surface over loopback** (it already does for the VFS, via `vfs-bridge` → `/api/fs`). The
  question is which existing mechanism starts a **named** agent headlessly, with no live
  conversation occupying the caller's turn.
- **Options.** (a) The worker performs the decomposition — impossible (no agent loop).
  (b) `okf_ingest` returns instructions (`acquisition_required`/`delegation_required` + a
  `delegate` block) and the *calling assistant* runs the acquisition steps and issues
  `agent_delegate` — the installed behavior; it burdens the caller, holds its turn for the
  whole run, and is exactly the "you're told to call the ingestion agent" friction being
  removed. (c) **The worker itself starts the run**: it mints the job, fires
  `POST /api/subagents/delegate` (loopback) with `{task, agent:"okf-ingest"}`, and returns
  `{jobId, status:"queued"}` at once. That route runs the same `runSubAgent`
  (`src/lib/agent/subagents/runner.ts`) the scheduler, workflows, Telegram, and self-heal
  use to start named agents with no conversation; it **streams NDJSON** and ends with a
  terminal `{type:"done", result}` / `{type:"error"}` line. The worker consumes that stream
  asynchronously and owns the job's terminal state (ADR-006).
- **Decision.** **(c)**. No new infra: the worker uses the same loopback channel it already
  uses for the VFS, and `POST /api/subagents/delegate` is the platform's existing
  headless-named-agent entry point (its route comment explicitly anticipates "a consuming
  service"). `okf-ingest` is a `local` agent, so the delegate route's feature-branch gate
  (which applies only to `claude` agents) does not apply. The run performs the **whole job
  end-to-end** (FR-047): acquisition (`web_fetch`/`file_to_markdown`, each pinning
  `output_path` so the source streams to disk, never re-emitted as the caller's tokens),
  `okf_add_raw_source`, chapter decomposition, concept/summary assignment, inline-asset
  interpretation, TOC + concept-index maintenance, and the bounded reference crawl
  (nested references each as their own `okf_ingest` → their own jobs).
- **Consequences.** The caller is freed at `okf_ingest`'s return — no follow-up steps, no
  held turn, and no assistant-side "safety net" to maintain (the worker is the launcher and
  owns the outcome). The document never re-enters the caller as output tokens. Reference
  crawl stays bounded by `maxDepth`/`maxWorkers` (FR-019). **Supersedes** the installed
  `tools.js` dispatcher (`plannedAcquisition` / `delegation_required`) and the old
  `agent_delegate`-via-assistant path; that step sequence is retained only as what the
  headless run now performs *itself*.

### ADR-006 — Run observability: the worker (launcher) owns finalization from the run's own terminal signal, plus a stale reaper

- **Context.** FR-041/FR-044/SC-011 require ingest runs to be observable through a real
  lifecycle (queued → running → completed | failed) with a summary (chapters written,
  concepts assigned, assets interpreted, references skipped/failed) or an error, exposed to
  both the app's Jobs tab **and the `okf_list_jobs` tool** (FR-048), **without** the caller
  emitting the full source and **without** the run-observation plumbing adding tools beyond
  `okf_list_jobs` (FR-044).
- **Why the old boundary problem is gone.** In ADR-005 (c) the **worker** is the one that
  called `POST /api/subagents/delegate` and reads its NDJSON response — so it observes the
  run's real terminal outcome directly, on the same request. It no longer "can't see the
  agent loop"; it *is* the client of the run. Finalization is therefore authoritative in
  the worker, not dependent on the sub-agent remembering to call back.
- **Options.** (a) Sub-agent → service `POST /jobs/<id>` callbacks with the *calling
  assistant* as the safety net (the installed model) — fragile here: the caller is no
  longer in the loop at all, and trusting the sub-agent to emit a correct terminal call
  leaves a crashed/abandoned run stuck "running". (b) **The worker consumes the delegate
  stream and owns terminal state** — the `{type:"done", result}` / `{type:"error"}` line is
  the ground truth, and the worker calls `core.updateJob(jobId, terminal, …)` from it.
  (c) A **worker-side stale reaper** as the last line of defense for a worker that is
  itself killed mid-run (the run keeps going in BOS's process, but the worker lost the
  handle).
- **Decision.** **(b) + (c)**. Job transitions, all owned by the worker:
  - `okf_ingest` called → `core.createJob({id:"run-<n>", status:"queued", bundle, source})`,
    persisted under `bundleRoot/.jobs/`; the worker then fires the delegate request and
    returns `{jobId, status:"queued"}` to the caller (FR-046).
  - The worker marks `running` when the delegate request is accepted. It advances
    `progress` **from the NDJSON `{type:"tool"}` lines it is already reading** (each
    `okf_upsert_concept` = one chapter written) — free, no sub-agent cooperation needed.
    The sub-agent *may additionally* `POST /jobs/<id> {progress:"…"}` for finer text, but
    that is now **optional enrichment**, not the terminal-state path.
  - Stream terminal `{type:"done"}` → the worker records `completed` with the summary. The
    summary is taken from the run's `result` (the sub-agent's final text, which its skill
    instructs to be a compact honest count: chapters/concepts/assets/refsSkipped/refsFailed
    — the existing "report honestly" rule) and/or derived by the worker from the writes it
    handled for the job. Stream terminal `{type:"error"}` → `failed` with the error.
  - **Stale reaper (FR-049):** a worker timer, plus a sweep on (re)start, marks any job
    still `queued`/`running` older than a configured `staleJobMs` (default e.g. 30 min) as
    `failed (stale)`, so a killed worker or an abandoned run never leaves the Jobs tab /
    `okf_list_jobs` showing a run that will never finish.
- **Consequences.** The app's Jobs tab and `okf_list_jobs` read the same
  `core.listJobs()` — one store, two surfaces (the ADR-003 "one capability, two surfaces"
  pattern again). No new IPC channel; `POST /jobs/<id>` remains for optional progress. Jobs
  are single-user (NFR-008); `.jobs/` is operational state under the bundle root (excluded
  from `okf_export_bundle`, per §10 risk 2). The caller is entirely out of the loop — there
  is no assistant safety net to maintain, because the launcher *is* the observer.

### ADR-007 — Bundle conventions live in the `okf-bundle-schema` skill, not a per-bundle `schema.md`

- **Context.** The old design read conventions from a per-bundle `schema.md` via the
  `okf_read_bundle_schema` tool (now **removed** from the 18-tool surface).
- **Decision.** The authoritative conventions are the item's bundled **skill**
  (`skills/okf-bundle-schema/SKILL.md`), attached to `okf-ingest` (FR-040) — reusing BOS's
  skill infrastructure rather than a parallel convention-file mechanism. A bundle *may*
  carry an optional `schema.md` that overrides the skill (the skill already says the
  bundle's voice wins), preserving forward compatibility with pre-redesign bundles.
- **Consequences.** No `okf_read_bundle_schema` tool. The sub-agent learns conventions from
  its attached skill at start; per-bundle divergence is still possible via `schema.md`
  without a tool.

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
`raw/` path — this is the "Open source" target's origin, FR-043), and timestamps.

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
    covers:
      - { docId: deployment, docTitle: Deployment Checklist, chId: canary,
          chTitle: Canary & Rollback,
          description: "5% canary for 30m; auto-rollback on p99 / 5xx thresholds.",
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
  `concepts/**/chId.md`, reads its `concepts`/`summary`/`status`/`parent`/title frontmatter,
  and rebuilds `terms[]` (term → set of (doc, ch, description)) and the body. It is
  O(chapters). Nothing about search depends on the file being *current* — a read-through
  cache validates it (below).
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
`okf_read_toc` (§9) returns it (FR-004). It is exported/imported with the bundle (FR-010).

### 5.5 `links.json` — explicit edges

`okf_add_link` (FR-031) writes an edge **twice**: as a markdown link in the source
chapter's body (`- [Label](<target>.md)` under a `## Links` section — retained from the
installed `addLink`, human-readable, OKF-portable) **and** as an entry in `links.json`
(`{from, to, label?}`) for cheap graph derivation (ADR-004). The two are reconciled by
`okf_lint` (drift between the markdown links and `links.json` is reported, §9 `okf_lint`).
`okf_backlinks` (FR-032) is answered from the link graph (`okf-core`'s existing
`ensureGraph` backlink index, built from `extractLinks`) — unchanged in mechanism.

### 5.6 Invariants (retained + new)

Retained (installed `okf-core.js`): schema-less (only `type` required); unknown frontmatter
keys preserved verbatim (shallow merge, SC-005); human-readable plain markdown;
`raw/` append-only (never overwrite — versioned instead); path-safety on every write.
New: the concept index and each TOC are derived/regenerable and never the sole source of
truth (NFR-004, FR-009); `raw/assets/` are immutable binary copies (FR-020);
`raw/sources.json` is the dedup ledger (FR-018).

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

### 6.2 Derived read views

- **`core.readToc(bundle, docId)`** — returns the doc TOC (FR-004): the chapter list with
  summaries + concepts, from `toc/<docId>.md` (rebuild if dirty).
- **`core.readConcept(bundle, id)`** — returns a concept's (document or chapter) full
  frontmatter + **entire** body + resolved inline-asset links (FR-005, SC-001). For a
  document id it returns the document stub; its TOC is `readToc`. For a chapter it returns
  the chapter markdown including any inline-asset link + interpretation blocks (FR-023).
- **`core.listConcepts(bundle, {type?, status?})`** — the vocabulary with per-term chapter
  counts (FR-006), plus (for the app) the full (doc, chapter) rows.

### 6.3 Graph derivation (ADR-004) — `core.graph(bundle)`

Computed **on read** from stored content; returned as `{nodes, edges}` for the app's
force-directed renderer (FR-042/FR-045):

- **Nodes:**
  - `type:"doc"` — one per document stub (`concepts/<docId>.md`), `label` = title.
  - `type:"chap"` — one per chapter, `id` = `<docId>/<chId>`, `label` = title.
  - `type:"concept"` — one per concept-term in the index, `label` = term, `count` =
    covering-chapter count (drives node radius in the renderer, as in the mockup).
- **Edges (typed, directed):**
  - `containment` — `doc → chap`, from each chapter's `parent` frontmatter (the mockup's
    `contains` label).
  - `coverage` — `chap → concept`, from the concept index (the mockup's `covers` label).
  - `link` — explicit `okf_add_link` edges from `links.json`/`extractLinks` (the mockup's
    `related` label).
- The app computes neighbor highlighting client-side from this list; no `neighbors`/
  `shortest_path` tool is needed (ADR-004). Node/edge color + label scheme is the
  mockup's (documents gray, chapters blue, concept-terms violet; contains solid, covers
  dashed-violet, related solid-amber), rendered in the BOS dark palette.

---

## 7. Ingest pipeline (re-scoped, not re-derived — spec retains the prior architecture)

### 7.1 `okf_ingest` — auto-trigger (supersedes the dispatcher shape)

`okf_ingest({bundle, source, maxDepth?, maxWorkers?})` runs in the worker. It **acts, not
plans**: it mints the job and immediately starts the headless run (ADR-005), then returns
**`{jobId, status:"queued"}`** to the caller — the same shape for every `source` type
(FR-046). The caller does not run acquisition steps and does not delegate anything; it is
free to proceed. Dedup first: if `source`'s normalized key is already in
`raw/sources.json`, the tool returns the existing `docId` (FR-018) rather than starting a
duplicate run.

What the headless run does with each `source` type is fixed (this is what the *run*
performs, not what the caller performs):

| `source` | The run's first steps |
|---|---|
| `https://…/x` (URL) | `web_fetch(url, output_path)` → `okf_add_raw_source(sourcePath)` → decompose |
| `/path/to/x.pdf` (convertible) | `file_to_markdown(path, output_path)` → `okf_add_raw_source(sourcePath)` → decompose |
| `/path/to/x.md` (plain text) | `okf_add_raw_source(sourcePath)` → decompose (no conversion) |
| `raw/x.md` (already in bundle) | decompose directly (source already registered) |

Every acquisition step pins `output_path` — the source streams to disk and the run reads a
receipt, so the document never re-enters the caller (or the run) as output tokens (FR-047).
After acquisition, the run does the FR-012–FR-015 decomposition, FR-020–FR-023
inline-asset interpretation, and the FR-019 bounded reference crawl (nested references
each as their own `okf_ingest` → their own jobs).

### 7.2 `okf_add_raw_source` — mechanical registration (retained)

`{bundle, filename?, content?, sourcePath?, conceptId?, title?}` — versions into `raw/`
(append-only, never overwrites), accepts `content` **or** `sourcePath` (a path already
staged by `web_fetch`/`file_to_markdown` — so large content never passes inline, FR-017),
records the provenance ledger entry, optionally stubs a concept. No LLM, no delegation.

### 7.3 Run observability flow (ADR-005/ADR-006, concrete)

```
Caller (agent or app Ingest modal) ─okf_ingest({bundle, source})─▶ Worker:
            • dedup vs raw/sources.json (if duplicate → return existing docId, no run)
            • core.createJob({id:"run-<n>", status:"queued", bundle, source}); persist
            • fire POST /api/subagents/delegate {agent:"okf-ingest", task}  (loopback, async)
            • return {jobId, status:"queued"} to the caller   ← caller is free now

Worker ─(same HTTP request, NDJSON stream)─▶ runSubAgent("okf-ingest", task) [main process]:
            Sub-agent (self-sufficient allowlist, §8.4); task embeds jobId/bundle/source:
              • (run's first steps per §7.1) acquire → okf_add_raw_source
              • reads raw/<file> directly (file_read) — never re-supplied
              • decomposes into chapters; per chapter:
                   okf_upsert_concept(parent, concepts, summary, status, sources)
              • inline non-HTML assets (§7.5): download → view_image/video_keyframes →
                   write link + interpretation block
              • writes toc/<docId>.md + concept-index.md (write path rebuilds; the sub-agent
                   also runs the skill's final index/toc maintenance step)
              • bounded reference crawl (maxDepth/maxWorkers), dedup vs raw/sources.json;
                   each nested reference = its own okf_ingest → its own job
              • ends with a compact, honest summary (report-honestly rule)

Worker ◀── NDJSON {type:"tool"} lines → advance progress (chapters written so far) ──▶
Worker ◀── terminal {type:"done", result} → core.updateJob(completed, summary)
            OR {type:"error"} → core.updateJob(failed, error)
[stale reaper: any job queued/running > staleJobMs → failed(stale), incl. after restart]

App Jobs tab  ──▶ GET /jobs / GET /jobs/<id>   (poll; ADR-003)
okf_list_jobs   ──▶ core.listJobs()            (same store; FR-048)
            • both render queued → running (live progress) → completed/failed
```

The **launcher owns finalization**: because the worker issued the delegate request, it reads
the run's own terminal signal and writes the job's final state — no assistant safety net,
no dependence on the sub-agent remembering to call back (ADR-006). The stale reaper covers
a worker killed mid-run.

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
document is itself readable/linked.

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
BOS assistant tools the sub-agent's allowlist names; see §8).

---

## 8. Service architecture (worker thread) & the app's data access

### 8.1 Worker, config, reachability (retained shape)

- **Worker entry** `services/index.js`: **bind the HTTP server and send
  `initialized`/`bound`/`tool_declare` first** (before any VFS call — a fix retained from
  the installed item so tool registration is reliable at cold start), then best-effort
  `mkdir(bundleRoot)` + a `.jobs/` load. On `tool_call`, dispatch to `handlers[name]`
  (retained). On `dispose`/`restart`, close the server.
- **Config** `config/okf-knowledge-base.json`: `bundleRoot` (default `/KnowledgeBase`),
  `port` (**default `0`** — OS-assigned, the only safe default, `services.md` §3),
  `maxDepth` (default 1), `maxWorkers` (default 3), `staleJobMs` (default 1800000 — the job-reaper bound, ADR-006). Runtime port is written to
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

### 8.2 The 19 tools (FR-037) — the agent surface, exactly 19

Declared under the **Knowledge Base** tool group (`service.json` `toolGroups` — retained).
Read-only tools are `parallelSafe` (retained `readOnly()`). Validation against each
`inputSchema` happens in the 039 bridge before dispatch (FR-038, retained). **No other
tool is declared** (SC-007). Grouping per FR-037, with input/output at implementation
level:

**Retrieval**
- `okf_search` `{bundle, query, limit?}` → `[{docId, docTitle, chId, chTitle, description, matchedConcept, status, stale}]` (FR-001/002, §6.1). *readOnly.*
- `okf_read_toc` `{bundle, docId}` → the document's TOC: `{docId, docTitle, chapters:[{id, title, summary, concepts, status}]}` (FR-004, §6.2). *readOnly.*
- `okf_read_concept` `{bundle, id}` → `{id, frontmatter, body, links, assets?}` — **full** body incl. inline-asset links + interpretations (FR-003/005, SC-001). *readOnly.*
- `okf_list_concepts` `{bundle, type?, status?}` → the vocabulary: `[{term, count, covers:[{docId, chId, title, description}] }]` (FR-006, §6.2). *readOnly.*

**Concepts**
- `okf_upsert_concept` `{bundle, id, title?, body?, frontmatter?}` → the merged concept. Merge-on-fields; unknown keys preserved (FR-024). Triggers derived index/TOC rebuild.
- `okf_delete_concept` `{bundle, id, rewrite_backlinks?}` → deletes the concept file; non-destructive by default; prunes derived artifacts on rebuild (FR-025).
- `okf_merge_concepts` `{bundle, from, to}` → canonicalizes `from`→`to`: rewrites the concept index, every affected `toc/*.md`, and every chapter `concepts` array that referenced either; single canonical entry (FR-026, US6, SC-008).

**Bundles**
- `okf_list_bundles` `{}` → per-bundle health: `{name, docs, chapters, conceptTerms, stale, deprecated, status}` (FR-027, US7). *readOnly.*
- `okf_init_bundle` `{name, title?, description?}` → creates the conformant layout (index.md, log.md, concept-index.md, toc/, links.json, raw/, concepts/) (FR-028, US5).
- `okf_import_bundle` `{bundle, source, type?}` → import from dir/git/tarball; its documents, chapters, **concept index, and TOCs** are present and queryable (FR-029, US5, SC-004). *Rebuilt from a flat `{files}` manifest or a staged dir.*
- `okf_export_bundle` `{bundle, format?}` → spec-conformant OKF **including the concept index and every document TOC**; re-import reproduces a queryable bundle (FR-029, US5, SC-004). *readOnly.*
- `okf_delete_bundle` `{bundle}` → removes only that bundle's directory (FR-030, US5).

**Ingest**
- `okf_ingest` `{bundle, source, maxDepth?, maxWorkers?}` → **auto-trigger** (FR-016/FR-046, §7.1): mints the job, starts the headless `okf-ingest` run (ADR-005), and returns `{jobId, status:"queued"}` immediately. Returns the existing `docId` on a dedup hit (FR-018). No `acquisition_required`/`delegation_required` instruction block is returned to the caller.
- `okf_add_raw_source` `{bundle, filename?, content?, sourcePath?, conceptId?, title?}` → mechanical raw registration (FR-017, §7.2).

**Jobs**
- `okf_list_jobs` `{limit?}` → `[{id, status, bundleId, source, startedAt, durationMs?, progress?, summary?, error?}]` — the current ingest runs and their lifecycle status, the **same records the app's Jobs tab shows** (FR-041/FR-048). *readOnly / parallelSafe.*

**Organization**
- `okf_add_link` `{bundle, id, target, label?}` → adds an explicit "related" edge (markdown link + `links.json`) (FR-031).
- `okf_backlinks` `{bundle, id}` → concepts linking to `id` (FR-032). *readOnly.*

**Health**
- `okf_lint` `{bundle}` → detects **broken inline-asset links, orphan chapters (no `parent` doc), concept-index / document-TOC drift from the underlying content, and links.json/markdown drift** (FR-033, US-health, SC-010). Because artifacts are derived, drift is *rebuilt*, not patched. *readOnly.*
- `okf_stale_report` `{bundle}` → concepts past `stale_after` (FR-034). *readOnly.*

**Removed from the prior 31** (FR-037): `okf_bundle_status` (→ folded into
`okf_list_bundles` health), `okf_find_concepts` (→ `okf_search`), `okf_read_index`,
`okf_read_bundle_schema` (→ skill, ADR-007), `okf_append_log` (log is internal),
`okf_get_as_of`, `okf_set_trust`/`okf_set_status`/`okf_add_source` (→ `okf_upsert_concept`
frontmatter, FR-024), `okf_attest`/`okf_provenance` (→ `sources` frontmatter),
`okf_remove_link`/`okf_list_links`/`okf_neighbors`/`okf_shortest_path`/`okf_export_graph`
(graph power-tools dropped — retrieval is index-based; the app renders the graph, ADR-004).
Net arithmetic: 31 declared → 19 declared = **12 fewer**. Per FR-037 that's **4 added**
(`okf_search`, `okf_read_toc`, `okf_merge_concepts`, `okf_list_jobs`) and **15 kept**. The
**removed** list names 15–16 tools (the spec's "16 removed" vs. the 31→19 net of 12 differ
by exactly the folding: the field-setter family `okf_set_status`/`okf_set_trust`/
`okf_add_source` — and the `okf_attest`/`okf_provenance` pair — keep their *capability*
inside `okf_upsert_concept` frontmatter and `sources` rather than vanishing, so they're
"removed" tools, not removed features).

### 8.3 App-facing REST routes (ADR-003) — what the app actually calls

All under the service's loopback base (§8.1), loopback-guarded, `sendJson`-shaped (retained
`http-bridge` helpers). These are **not** 039 tools — they're the app's data layer,
reusing the *same* `core` functions as the tools.

| Method + path | Reuses | Returns | Feeds |
|---|---|---|---|
| `GET /config` | `getRuntime()` | `{httpPath, port, runtime:{bundleRoot}}` | `bridge.ts` base-URL |
| `GET /bundles` | `core.listBundles` | `[{name, docs, chapters, conceptTerms, stale, deprecated, status}]` (FR-027) | Overview bundle list + health stat cards |
| `POST /bundles` | `core.initBundle` | bundle health | "New Knowledge Base" modal |
| `GET /bundles/<b>` | `core.bundleDetail` | `{health, documents:[{id, title, chapters, conceptRefs, updated, source}], conceptIndex:[{name, count, covers:[...], stale}]}` (FR-027 + US7) | Bundle detail header + Documents + Concept Index tabs |
| `GET /bundles/<b>/toc/<docId>` | `core.readToc` | doc TOC (FR-004) | Overview Documents → TOC; Query doc node |
| `GET /bundles/<b>/concept/<id>` | `core.readConcept` | full chapter/document (FR-005) | Overview chapter; **Query reader pane** |
| `GET /bundles/<b>/search?query=&limit=` | `core.search` | **identical** to `okf_search` (FR-036/043) | **Query Search results** |
| `GET /bundles/<b>/graph` | `core.graph` | `{nodes:[{id, type:doc|chap|concept, label, count?}], edges:[{from, to, kind:containment|coverage|link}]}` (FR-045, ADR-004) | **Query Knowledge Graph** |
| `GET /bundles/<b>/assets/<assetPath>` | `vfs.readRaw` | binary (image/video bytes) w/ content-type | reader-pane asset thumbnail (ADR-008) |
| `GET /bundles/<b>/lint` | `core.lintBundle` | lint report (FR-033) | Overview Health tab |
| `GET /bundles/<b>/stale` | `core.staleReport` | stale list (FR-034) | Overview Health tab |
| `POST /bundles/<b>/import` | `core.importBundle` | health | Import modal |
| `GET /bundles/<b>/export` | `core.exportBundle` | `{name, files:[{path, content}]}` | Export modal |
| `DELETE /bundles/<b>` | `core.deleteBundle` | `{deleted:true}` | Delete modal (confirmed) |
| `GET /jobs` | job store | `[{id, status, bundleId, source, startedAt, durationMs?, progress?, summary?, error?}]` (FR-041) | **Jobs tab list** + tab badge count |
| `GET /jobs/<id>` | job store | full job record incl. summary/error | Job detail (expand) |
| `POST /jobs/<id>` | job store | updated record | **optional sub-agent progress enrichment** (`{progress:"…"}`, ADR-006) — terminal state is owned by the launcher from the run's own signal, not by this route |

The **graph** and **jobs** response shapes are the *new* surfaces (the delegation's
requirement); their exact JSON is the `nodes/edges` above and the job record below. The
**search** route is byte-for-byte the `okf_search` result. The **asset** route exists so
the opaque-origin app can render stored inline images/video without reaching `/api/fs/raw`
itself.

**Job record** (in-memory hot map + `/KnowledgeBase/.jobs/<id>.md` for restart survival):
```jsonc
{
  "id": "run-1042",
  "status": "queued | running | completed | failed",
  "bundleId": "engineering",
  "source": "https://…/performance-budgets",
  "startedAt": "2026-10-09T11:58:00Z",
  "endedAt": null,
  "durationMs": null,
  "progress": "Interpreting inline asset raw/assets/…/perf-chart.png · writing 3 of 6 chapters",  // optional, live
  "summary": { "chapters": 6, "concepts": 8, "assets": 1, "refsSkipped": 2, "refsFailed": 0,
               "written": ["Perf Budget Basics", "…"] },          // on completed
  "error": null                                                   // on failed
}
```
The Jobs tab **polls** `GET /jobs` (and, for the expanded row, `GET /jobs/<id>`) on a short
interval (the mockup's live "elapsed" + progress bar), reflecting status as it changes
(FR-041, SC-011); `okf_list_jobs` reads the same `core.listJobs()` for the agent surface
(FR-048). (Polling, not SSE, is simplest and matches the loopback bridge; an NDJSON tail
could replace it later without changing the record shape.)

### 8.4 The bundled `okf-ingest` agent — self-sufficient allowlist (FR-039, NFR-009)

`agents/okf-ingest/AGENT.md` `tools:` — **rewritten** so the headless run (ADR-005) is
**end-to-end self-sufficient** (FR-047). Because the run performs acquisition *and*
decomposition *and* reconciliation itself — no caller holds tools for it — it carries the
**full `okf_*` surface plus the named acquisition tools plus VFS reads**:

```
okf_ingest, okf_add_raw_source,
okf_search, okf_read_toc, okf_read_concept, okf_list_concepts,
okf_upsert_concept, okf_delete_concept, okf_merge_concepts,
okf_add_link, okf_backlinks, okf_lint, okf_stale_report,
okf_list_bundles, okf_init_bundle, okf_import_bundle, okf_export_bundle, okf_delete_bundle,
okf_list_jobs,
web_search, web_fetch, file_to_markdown, view_image, video_keyframes,
file_read, file_list
```

(That is the complete 19-tool `okf_*` surface — retrieval, concepts, bundles, ingest,
jobs, organization, health — plus 5 acquisition tools + 2 VFS reads.)

- **Why the full `okf_*` surface (the point of FR-047).** The run is headless and must
  not assume an orchestrating assistant. Re-ingesting a changed source reconciles the
  existing document — that legitimately uses `okf_delete_concept`/`okf_upsert_concept`.
  Following a reference spawns **its own** `okf_ingest` (which mints a nested job, §7.1),
  so the run recurses through the tool, not through `agent_delegate`. `okf_list_jobs`
  lets it observe its own siblings; `okf_lint`/`okf_stale_report` let it verify what it
  wrote before finishing.
- **Acquisition (for references it follows + inline assets):** `web_search`, `web_fetch`,
  `file_to_markdown`, `view_image`, `video_keyframes` — the last two **specifically for
  inline-asset interpretation** (FR-039). `file_read`/`file_list` to read the raw source
  from the bundle.
- **Explicitly NOT granted (least-privilege in scope, NFR-009):** any non-`okf_*` tool,
  unrestricted `run_command`, and `agent_delegate` (nested runs go through `okf_ingest`,
  never through delegating to arbitrary agents). It never gains the top-level assistant's
  full surface.
- **It does NOT finalize the job.** The launcher (the worker, ADR-006) writes the
  terminal state from the run's own signal. The agent's only job-facing duty is to end
  with a **compact, honest summary** (chapters/concepts/assets/refsSkipped/refsFailed) —
  the "report honestly" rule, carried from the prior AGENT.md into this rewrite.
- It has the `okf-bundle-schema` **skill** attached (FR-040) — the conventions (§7.4, §5.2,
  §7.5 block format) live there, not in a per-bundle file.

---

## 9. Data flow, error handling, lifecycle

**Retained** (installed item): 039 tool invocation (`tool_call`→worker→`tool_result`/
`tool_error`, errors in-band never a crash, FR-038/NFR-007); service lifecycle (start/
stop/restart, crash recovery, tools removed on stop/uninstall — SC-009, retained);
app↔worker via `httpPath`/direct-port (ADR-003); path-safety + atomic writes (NFR-006).

**New flows (this redesign):**

```
Retrieval (agent):
  okf_search(bundle, query) → [TOC rows]          (deterministic, §6.1)
    → okf_read_toc(bundle, docId)  → chapter list → okf_read_concept(bundle, doc/ch) → FULL text
  or okf_read_concept(bundle, doc) directly for the whole document

Retrieval (app, Query tab):
  GET /bundles/<b>/search?query=  → same [TOC rows] → click → GET /concept/<id> → FULL chapter
  GET /bundles/<b>/graph          → {nodes, edges}  → force-render → click node → same /concept

Ingest (auto-trigger, ADR-005):
  okf_ingest(bundle, source) → mint job(queued) → POST /api/subagents/delegate {okf-ingest}
            → return {jobId, status:queued} to caller   ← caller is free now
            → headless okf-ingest run (self-sufficient, §8.4): acquire (output_path) →
              okf_add_raw_source → raw/ → chapters (upsert) + concepts/summaries +
              assets (download+interpret) + toc + concept-index (derived rebuild)
            → nested reference = its own okf_ingest → its own job
            → run ends with a compact, honest summary

Inline asset:
  sub-agent → download non-HTML asset → vfs-bridge.writeBinary → raw/assets/<docId>/<name>
            → view_image / video_keyframes → interpretation text
            → okf_upsert_concept writes the link + interpretation block into the chapter

Job lifecycle (launcher owns finalization, ADR-006):
  worker: okf_ingest → mint job(queued) → fire delegate request (async) → return {jobId}
  worker consumes NDJSON: {tool} lines → progress; terminal {done} → completed(summary)
            | {error} → failed(error)
  [stale reaper: job queued/running > staleJobMs → failed(stale), incl. after restart]
  App Jobs tab polls GET /jobs; okf_list_jobs reads core.listJobs() → lifecycle (SC-011)
```

**Error handling:** every `okf_*` and HTTP route returns in-band errors (404/409/400 via
the retained `statusForError`); a failed chapter/asset never fails the whole document
(spec *Edge Cases*); a failed ingest leaves `raw/` and the index consistent because the
derived artifacts rebuild from content (NFR-004). **Lifecycle:** service stop/uninstall
removes all 19 tools immediately (SC-009, retained). The `.jobs/` dir and derived
artifacts are bundle-scoped, so they're removed with `okf_delete_bundle`.

---

## 10. Risks / open questions

1. **`raw/` binary through `/api/fs` base64.** `vfs-bridge` today only does text
   (`readText`/`writeText` → `/api/fs?op=read|write`). Non-HTML assets are binary, so we
   add `writeBinary` (base64 → `op:write`) and `readRaw` (`GET /api/fs/raw?path=`). **Open:
   confirm the `/api/fs` `write` op accepts a base64-marked payload and that `readRaw`
   streams without buffering large video** (services.md §VFS bridge notes `raw` streams
   both directions — verify the *write* side handles binary, or stage via a temp file and
   use the streaming PUT). A 100MB+ video held in a JSON body would be wrong; use the
   streaming path for large assets.
2. **Job record durability vs. OKF purity.** Jobs live under the bundle root
   (`.jobs/`) to survive restart, but they're *operational* state, not OKF *content*.
   **Open: should export include `.jobs/`?** Default: exclude it from `okf_export_bundle`
   (it's not part of the distributable contract, NFR-001) but keep it on disk; confirm the
   reviewer wants export to skip `.jobs/` and `links.json`-drift, or include them.
3. **Headless-run fidelity (ADR-005/ADR-006).** The launcher owns the job's terminal state
   from the run's own `{done}`/`{error}` signal, so the mechanism no longer depends on the
   sub-agent making lifecycle calls — the worker-side stale reaper is the last line of
   defense for a worker killed mid-run. **Residual:** a run that "completes" with a
   partial outcome (e.g. hit `maxDepth`) should record `completed` with an honest
   `refsSkipped`/`refsFailed` summary, not `failed` — the skill/agent prompt carries that
   "report honestly" rule, and the worker derives the summary from the writes it observed
   for the job.
4. **Concept-term normalization & merge quality (FR-026, US6).** Organic vocabulary
   accumulates near-duplicates; `okf_merge_concepts` is the guard. **Open:** the *detection*
   of near-duplicates (to suggest a merge) is a candidate for a lightweight pass in
   `okf_lint` (e.g. flag terms with high token overlap) — not in v1 scope, but the
   data model must keep it possible (terms are just index keys, so a future lint rule is
   additive, not structural).
5. **`okf_search` description-match recall.** The match is over **term names + one-line
   descriptions**, not full text (that's the point — concept-anchored). A query that
   paraphrases content but misses both the term and the one-line description returns
   empty (spec *Edge Cases*: agent widens or reads the vocabulary). **This is intended,
   not a bug** — but the UI must make it legible (the mockup's "No concept terms matched —
   the search matches the vocabulary + stored descriptions, not full text" copy does).
   Ensure `summary` quality at ingest is high, since it's the retrieval surface.
6. **App force-simulation cost on large bundles.** The in-app graph renders all
   nodes/edges for a bundle. A bundle with thousands of chapters makes a heavy force
   sim. **Mitigation (implementation):** cap initial render to a sample or cluster
   by-document, with the search box to narrow; the mockup sim is O(N²) per tick — fine for
   the hundreds-node case the spec's use cases imply, but add a node-count guard.
7. **`okf_import_bundle` source types.** FR-029 says dir/git/tarball; the installed
   `okf_import_bundle` takes a flat `{files}` manifest. **Open: how does the app's Import
   modal (mockup offers dir/git/tarball) hand bytes to the service?** Likely: dir → the
   app reads via the VFS and POSTs `{files}`; git/tarball → the *service* (worker, which
   can `run_command`? no — worker has no shell) — so git/tarball import is probably
   better done by the **assistant** (which has the tools) or a `sourcePath` the app staged.
   Confirm the intended import vector before implementation; the data model (a bundle =
   a directory of `.md`) is unchanged regardless.
8. **`view_image`/`video_keyframes` availability.** These are the fixed BOS prerequisites
   (spec *Assumptions*). If a provider lacks native vision, `view_image` still returns
   vision content blocks; `video_keyframes` falls back to ffmpeg frame sampling
   (the old design's capability gate). The sub-agent interprets whatever it's handed; the
   design doesn't depend on a specific provider.
9. **Pre-existing installed item upgrading into this redesign.** The installed item has 31
   tools, a flat `okf_ingest`, `schema.md`-based conventions, and a config-app. Upgrading
   means: the 31→18 tool change (tools removed on the next start — SC-009), the
   derived-index introduction (bundles created pre-redesign have no `concept-index.md` /
   `toc/`; the read-through rebuild generates them on first read — **self-healing, no
   migration required**, but confirm a pre-redesign bundle's chapters carry enough
   frontmatter — the old model stored `title`/`status`/`verified`/`sources`, not
   `parent`/`concepts`/`summary` — so a *full* index for old bundles may need a one-time
   re-ingest or a best-effort derivation from `title`/links). **This is the biggest
   data-model open question:** decide whether pre-redesign bundles get a best-effort
   derived index (terms from titles/links, descriptions from existing summaries-or-empty)
   or require re-ingest to gain the full two-level index.

---

## 11. UI mockup reference

- **Path:** `item-okf-knowledge-base/mockup.html` (this spec directory) — the **binding
  visual + interaction contract**, already implementing the full app shell:
  - **App shell** — titlebar (🧠 OKF Knowledge Base, "19 okf_* tools" badge, Populated/Empty
    mode toggle) + top tab bar **Overview / Jobs / Query** (with a live Jobs badge). This
    is the FR-035 master-detail app, not a settings page.
  - **Overview** — bundle list (per-bundle Docs/Chapters/Concepts/Stale + status dot) →
    bundle detail (health stat cards; tabs **Concept Index / Documents / Health /
    Import·Export**) → concept index (searchable, expandable term → (doc, chapter) rows
    with descriptions) → document → **stored TOC** → **full chapter** (frontmatter card,
    markdown body, **inline-asset** blocks with thumbnail + stored interpretation,
    "View source (.md)" toggle). Modals: New / Import / Export / **Ingest** / Delete.
  - **Jobs** — run list (status dots queued/running/completed/failed, bundle, source,
    time, elapsed/duration) → expandable detail (summary cells: chapters/concepts/assets/
    refsSkipped/refsFailed; written-chapter chips; error card; live progress bar).
  - **Query** — bundle selector + a **shared search box** + a **Graph / Table** view toggle;
    a **mouse-resizable reader pane** (the `.resizer`) that opens the full chapter
    (frontmatter + markdown + assets + **"Open source"** link at top) or a document's TOC
    or a concept-term view. The **Knowledge Graph** is a dependency-free **force-directed**
    SVG of category-colored circular nodes (doc gray / chapter blue / concept violet) with
    **labeled directed edges** (contains solid / covers dashed-violet / related solid-amber),
    legend, hover-to-trace-neighbors (dims non-neighbors to 30%), pan/zoom/drag, and
    search-highlight.
- **Map to the Component design (§3.3 `app/src/`):** shell→`App.tsx`; Overview
  (list/detail/concept-index/documents/TOC/chapter/health/IO + modals)→`app/src/overview/`;
  Jobs (list/detail/progress)→`app/src/jobs/`; Query (graph + table + search + reader pane
  + resizer)→`app/src/query/`; the force sim is ported verbatim from the mockup's
  `stepGraph/renderGraph/drawGraph/attachGraphInteractions` (ADR-009); the tiny markdown
  renderer + `assetBlock`/`interp` are ported to `app/src/lib/markdown.ts`; the API
  clients in `app/src/lib/api.ts` map 1:1 to the §8.3 REST routes; `bridge.ts` resolves the
  service base URL (§8.1). The mockup's `SOURCES`/`docSource` (URL-or-raw-path) is exactly
  the FR-043 "Open source" target logic (original ingested URL from `sources`, else the
  stored `raw/` path).
- **No separate mockup files** — the spec asks for one consolidated `mockup.html`, which
  this is. The app implements it; where the spec's "To be added at the design step" items
  (shell, Jobs, Query/Graph/Search, resizable pane) are concerned, **the mockup already
  contains them** and this design's §8.3 supplies the data routes that drive them.
