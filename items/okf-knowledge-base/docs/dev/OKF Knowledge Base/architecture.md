# Architecture — OKF Knowledge Base

The item is one marketplace item with three facets: a **service** (worker thread), a **standalone app** (dock-openable iframe), and a **bundled agent + skill**. Nothing in BOS `src/` is touched.

```
Next.js app process                     marketplace item (worker thread, own loopback port)
┌──────────────────────────────┐        ┌──────────────────────────────────────────────┐
│ Top-level assistant          │        │ services/index.js      worker entry           │
│   └─ okf_* tool_call ────────┼──IPC──▶│ services/lib/tools.js  18 declarations        │
│ agent_delegate → okf-ingest  │        │ services/lib/okf-core.js  storage + index +   │
│   └─ job callbacks ──────────┼─HTTP──▶│                           search + graph      │
│ App iframe (Overview/Jobs/   │        │ services/lib/http-bridge.js  app REST         │
│   Query) ────────────────────┼─HTTP──▶│ services/lib/vfs-bridge.js ──┐                │
└──────────────────────────────┘        └──────────────────────────────┼────────────────┘
                                                                        │ loopback /api/fs
                                                              /KnowledgeBase/<bundle>/
```

## Service facet

A worker thread in `deploymentMode: "tools"` (the 039 Service Tool Exposure contract). It binds its own HTTP port (`port: 0` — OS-assigned, never fixed) and does three things:

1. **Declares 18 `okf_*` tools** over `tool_declare` at startup. See [tools.md](tools.md).
2. **Owns OKF storage** under `/KnowledgeBase/`, reached only through the loopback VFS bridge.
3. **Serves the app's REST surface** on its loopback port.

### Startup ordering (don't reorder this)

`index.js` binds the HTTP server and posts `initialized` / `bound` / `tool_declare` **before** touching the VFS. The VFS bridge is a loopback HTTP call into BOS's own `/api/fs`, which at cold start may not be up yet; gating the tool handshake on it once meant the worker blew past the ServiceManager startup timeout and *no* `okf_*` tool got registered for that boot. The `mkdir`, the legacy-bundle migration and the job-store warm-up are all best-effort work that happens after the handshake.

### The VFS bridge

`vfs-bridge.js` reaches the VFS over loopback HTTP (`/api/fs` for text, `/api/fs/raw` for bytes). A worker-thread service cannot `import "@/os/vfs"`, and it must not touch the host filesystem: an earlier version derived a host path from the service config directory and wrote every bundle into BOS's internal `system/` tree, invisible to the Files app while appearing to work.

Binary goes through `readRaw` / `writeBinary` and is used for exactly two things: serving an inline asset to the app, and copying an asset a caller staged elsewhere. The *ingest* path never streams bytes through the worker — the `okf-ingest` agent `web_fetch`es an asset directly to its `output_path` inside `raw/assets/`, so a large video never sits in a worker-thread buffer.

### Trust boundary

`http-bridge.js` binds `127.0.0.1` **and** independently checks the TCP peer is loopback. A reverse proxy in front could otherwise forward an off-host request; a forwarded header can't launder a non-loopback peer. A loopback peer *is* the boundary — it's either a local caller or the Supervisor's `httpPath` proxy relaying a browser request, which legitimately carries an `X-Forwarded-For`.

## The two-level derived index

This is the redesign's core mechanism.

| Level | Artifact | Content | Size |
|---|---|---|---|
| 1 | `concept-index.md` | concept term → covering (document, chapter, one-line description) | **O(V)** — distinct terms |
| 2 | `toc/<docId>.md` | one document's chapters with descriptions + covered terms | O(chapters in that doc) |

Both are **`.md` files with the machine-readable data in frontmatter and a human-readable listing in the body**, so one artifact is simultaneously the search input, a greppable file, and something the app renders directly.

**Both are derived and never the sole source of truth.** The canonical content is `concepts/**/*.md` — chapter frontmatter (`parent`, `concepts`, `summary`) plus bodies. `rebuildDerived()` regenerates both levels from that content and stamps `index_generated_at`.

Rebuild happens on **every write that can change them** (upsert, delete, merge, link, import, init) so an export always carries a correct index. It *also* happens on read when drift is detected: `getModel()` compares `index_generated_at` against the newest chapter `updated_at` and rebuilds if the index is older. That read-through path is what makes an externally-edited bundle — a git pull, an editor, another tool — repair itself instead of silently serving a rotten index, and it is why a pre-redesign bundle with no `concept-index.md` at all simply generates one on first read.

`okf_lint` reports drift and rebuilds it rather than patching, because patching a derived artifact is how you end up with two sources of truth.

### Pre-redesign bundles

`classifyBundle()` handles chapters that predate `type`/`parent`/`concepts`/`summary` **best-effort and non-destructively**: a nested legacy concept (`ai/attention`) reads as a chapter of document `ai`; a flat one reads as a document; terms come from `concepts`, else `tags`, else `topics`; descriptions from `summary`, else `description`, else the first line of prose. Nothing is rewritten. `needsRegeneration` is reported so the app can say the routing is partial — the honest answer — rather than pretend the bundle is fully indexed or silently re-derive over the user's data.

## `okf_search` — deterministic, one implementation

```
tokenize(query)
  → match tokens against concept-term NAMES and the index's one-line DESCRIPTIONS
  → collect the covering chapters
  → rank: term-name matches above description-only; then by distinct tokens matched;
          then (docId, chId) for a stable order
  → return TOC rows {docId, docTitle, chId, chTitle, description, matchedConcept, status, stale}
```

**No LLM is in the match.** The LLM does routing (what to ask) and synthesis (reading the chapters it then fetches); this is the deterministic bridge. The pass is over `terms`, so cost is bounded by vocabulary size, not corpus size.

`core.search()` is called by **both** the `okf_search` tool and the app's `/search` route — one implementation, two surfaces, so the UI can't drift from what an agent sees. Identical input gives byte-identical rows.

Empty is a valid result. The match is concept-anchored, not full-text: a paraphrase that misses both the vocabulary and the stored descriptions returns nothing, and both surfaces say so rather than inventing rows. The escalation path if a vocabulary ever outgrows one pass (~50k tokens of index text, or >2s p95) is a keyword/BM25 pre-filter over term names and descriptions — still no vector store. That is documented, not built.

## Graph derivation

`core.graph()` computes `{nodes, edges}` **on read** — nothing is stored:

- nodes: one per document, one per chapter, one per concept term (term radius scales with its coverage count)
- `containment` document → chapter, from `parent`
- `coverage` chapter → concept term, from the concept index
- `link` explicit `okf_add_link` edges, from `links.json`

A stored graph would reintroduce exactly the "second thing to keep in sync" problem the derived index exists to kill. Derivation walks frontmatter the index already reads, so it's cheap and always consistent. The app's hover-to-trace-neighbours is computed client-side from the returned edge list — no `neighbors` or `shortest_path` tool is needed, which is why both were dropped from the surface.

## Ingest and job observability

`okf_ingest` is a **dispatcher, not a writer**. The worker runs outside Next.js: it has no `web_fetch`, no `file_to_markdown`, and cannot start an agent loop. So it validates, dedups against `raw/sources.json`, mints a job record, and returns the exact next calls:

- source not in the bundle → `acquisition_required` with `steps` that **pin `output_path`**. That parameter is the entire mechanism: the document streams to disk and the tool returns a receipt, instead of the content coming back as a tool result that the model must re-emit to store.
- source already in `raw/` → `delegation_required` with an `agent_delegate` block naming the `okf-ingest` agent, the `jobId` and the callback URLs.
- source already ingested → `already_ingested` with the existing `docId`.

### The job lifecycle, and why it looks like this

The service creates the job, but the sub-agent runs in the **main Next.js process** — the worker cannot observe an agent loop across that boundary. The only channels are the agent's tool calls and the service's own loopback HTTP. So:

```
okf_ingest            → job {queued}, jobId + callbacks embedded in the delegation task
sub-agent, first write→ POST /jobs/<id>/start      {running}
sub-agent, optionally → POST /jobs/<id>/progress   {progress: "writing 3 of 6 chapters"}
sub-agent, success    → POST /jobs/<id>/complete   {summary: {...}}
sub-agent, failure    → POST /jobs/<id>/fail       {error}
assistant safety net  → on agent_delegate returning an error/empty, POST .../fail
app Jobs tab          → polls GET /jobs
```

Polling was rejected (a stalled agent looks "running" forever; a partial write looks "done"). A tool for the assistant to mark jobs was rejected (a 19th tool). These callbacks are **plain HTTP on the service's own port, not `tool_declare`d tools** — which is how run observability is added without touching the 18-tool surface at all.

**Terminal states are final.** A late callback arriving after the safety net already failed a run (or vice-versa) is recorded as a no-op rather than resurrecting a finished run. That is what makes it safe for *both* paths to report, which is what closes the gap when one of them lapses.

Jobs are **service-level**, in `<bundleRoot>/.jobs/jobs.json`: the Jobs tab is global, and a run must survive the bundle it targets being deleted mid-flight. They are operational state, deliberately excluded from `okf_export_bundle` — not part of the OKF content contract.

## Inline assets

At ingest, for every non-HTML asset in a chapter's scope: download a local immutable copy into `raw/assets/<docId>/`, interpret it with `view_image` or `video_keyframes`, and write the chapter with the link plus a `> **Interpretation (LLM, at ingest):** …` blockquote beneath it.

The layering is deliberate — bytes in `raw/` (immutable), the interpretation as LLM-written wiki text, the markdown link as the edge between them. Because the interpretation is **stored text written once**, `okf_read_concept` returns it without re-running vision at query time. Re-running vision per read was rejected: it burns tokens on every retrieval and can't run inside `okf_search`'s deterministic pass at all.

HTML hyperlinks stay remote references. A failed download or interpretation writes the block marked unavailable and counts in `refsFailed`; it does not fail the document.

## App facet

A standalone master-detail app (Overview / Jobs / Query), not a settings page. It reaches the service over the service's **`httpPath`** (Supervisor-fronted) else its bound `runtime.port`, resolved once from `GET /api/services/okf-knowledge-base/config` — the port is OS-assigned and never hardcoded. An opaque-origin install (remote marketplace) falls back to the parent frame's `window.__bos.services` broker, which is why the app declares `services:read`.

The app calls the REST surface, **not** the `okf_*` tools: an iframe is not an agent, and the tools are an IPC-dispatched, schema-gated agent surface. Adding app views therefore adds nothing to the 18-tool surface — the route table is in [tools.md](tools.md). Three of those routes deliberately reuse a *shared* function rather than reimplementing it, which is what keeps the two surfaces from drifting: `/search` → `core.search`, `/merge` → `core.mergeConcepts`, `/ingest` → the same `planIngest` dispatcher `okf_ingest` runs. The app renders what the service computes — it has no retrieval logic of its own. Its one dependency-free piece of machinery is the force simulation for the graph (ported from the approved mockup rather than adding `d3-force`).

## What the item does not implement

`web_fetch`, `file_to_markdown`, `view_image`, `video_keyframes`, the tool-result attachment mechanism, and marketplace-item agent/skill copy-install with provenance are **platform capabilities this item calls**. They are not reimplemented here. If one is missing, that is a BOS-source gap, not an item gap.
