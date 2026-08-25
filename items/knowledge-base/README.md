# Knowledge Base

A BrowserOS marketplace item (**service facet only** — no window app). Lets
you create named knowledge bases, add content from uploaded documents,
Google Drive folders, or crawled websites, and gives BOS agents `kb_search` /
`kb_retrieve` tools to query them. Spec: `spec/spec.md` (this item's own spec folder).

## What's here

```
knowledge-base/
├── services/
│   ├── service.json     # manifest: id, entry, configSchema (port, host, graphitiEndpoint, episodeVerifyTimeoutSeconds)
│   ├── package.json     # @modelcontextprotocol/sdk, mammoth, xlsx, cheerio, pdf-parse, jszip
│   ├── index.js          # worker entry — binds one http.Server, routes /mcp and /api/*
│   ├── lib/              # pipeline, state, extraction, sources, Graphiti client, MCP server
│   └── tests/            # `node --test tests/` — extraction, chunking, dedupe, state
├── config/
│   ├── config.html       # the configApp — KB management UI (Settings → Plugins → Services)
│   └── knowledge-base.json  # default config (port 0, graphitiEndpoint default)
```

No `docker-compose.yml` here and none added to BOS itself — the Graphiti
stack is deployed externally (see below).

## Setup

1. **Deploy Graphiti externally.** This item does not ship or manage
   Graphiti — you deploy `getzep/graphiti`'s MCP server + FalkorDB yourself
   (e.g. in Dokploy). Point Graphiti's structured-output LLM + embeddings at
   BOS's `/api/llm/openai/[...path]` proxy. **Set
   `GRAPHITI_TELEMETRY_ENABLED=false`** on that deployment — Graphiti phones
   home to PostHog by default, which breaks BOS's local-first stance.
2. **Install this item** (Settings → Plugins → Services, or via the
   Marketplace if published there). It starts automatically once installed.
3. **Set the Graphiti MCP endpoint.** Open the config page (Settings →
   Plugins → Services → Knowledge Base → config) and click the gear icon in
   the titlebar → set it to your deployed MCP server's URL. Default is
   `http://127.0.0.1:8020/mcp/`. Changes apply immediately, no reinstall.
4. **Give agents access to the query tools.** This item exposes `kb_search`
   and `kb_retrieve` as a standard MCP server on its own bound port — it does
   **not** register them as built-in BOS tools (there's no dynamic
   tool-registration path into `src/lib/assistant/registry.ts` without
   editing BOS source; see `discrepancies.md` in the spec for the full
   reasoning). Add it in **Settings → MCP Servers**: transport `http`,
   endpoint = whatever `GET /api/services/knowledge-base/config` reports as
   `httpPath` (Supervisor-fronted deployments) or `http://<host>:<runtime
   port>/mcp` (plain `npm run dev`, no Supervisor). Agents then reach
   `kb_search`/`kb_retrieve` through BOS's existing `mcp_tool_search` +
   `mcp_tool_call` gateway tools.

## Source types

- **Upload** — the config page uploads bytes to the VFS via BOS's own
  `/api/fs/upload`; the worker reads them back over the loopback
  `/api/fs/raw` bridge. Supports PDF, TXT, MD, DOCX, XLSX, PPTX, HTML.
- **Local folder** (`type: "folder"`, added after the original spec — see
  "Known limitations" below) — the config page's upload dropzone also
  accepts a whole folder, via drag-drop (`DataTransferItem.webkitGetAsEntry()`
  + a recursive `FileSystemDirectoryReader` walk) or the "select a folder"
  link (`<input webkitdirectory>`). Every file is uploaded into the VFS
  under one generated root path, preserving the folder's relative structure
  (one `/api/fs/upload` call per subfolder, since that route only ever
  writes a flat basename — nesting comes from the destination `path`, not
  the filename), then indexed by recursively walking that VFS subtree
  (`services/lib/sources/folder.js`) the same way `sources/drive.js` walks a
  Drive folder. Supports refresh (FR-010: added/removed files re-sync) the
  same as Drive/Website sources.
- **Google Drive folder** — via BOS's `gsuite`/`drive` integration invoke
  route (OAuth stays server-side). Requires the Drive integration to be
  configured in BOS with the `drive.readonly` scope granted.
- **Website** — a same-hostname crawler (built-in `http`/`https`, no
  headless browser), respecting a simple `robots.txt` Disallow check, capped
  by max depth and page limit per source.

## Ingestion pipeline

Acquire → extract text (pure-JS parsers, no native deps) → chunk into
episodes (one document = one episode by default; large docs split on
Markdown headings or a soft character cap) → SHA-256 content-hash dedupe
(per KB) → `add_memory` on Graphiti (`group_id` = the KB id) → **verify the
episode actually landed** → journal update. A source stuck in
`pending`/`indexing`/`crawling`/`connecting` when the worker restarts is
automatically re-enqueued on boot.

`add_memory` is fire-and-forget — its response is only a queued
acknowledgement, never confirmation the episode exists. A source is **only**
marked `indexed` once `graphiti.waitForEpisode()` (`services/lib/graphiti.js`)
polls `get_episodes` and actually finds the uuid it just queued, up to a
bounded, **operator-configurable** timeout (default 300s/5min — long enough
to cover Graphiti's two real LLM round trips per episode: entity/edge
extraction, then embedding — see "Known limitations" below), automatically
scaled up to 2x while `MAX_CONCURRENT_JOBS` sources are indexing at once
(`services/lib/pipeline.js`'s `verifyTimeoutMs()`). Raise it from the config
page's Connection settings (`episodeVerifyTimeoutSeconds`, applies
immediately, no reinstall) if your deployment's LLM/embeddings backend or
large chunked documents routinely need longer. If it never shows up, the
source is marked `failed`
with a message that says exactly that (queued but unconfirmed, may still be
processing) — it does not guess a specific cause, and never silently marked
`indexed` on the ack alone. This was a real bug: an earlier version marked
sources "indexed" the moment `add_memory`'s queued response came back, so
files looked ingested when nothing had actually landed in Graphiti.

Graphiti connectivity failures (endpoint unreachable/misconfigured) and
verification timeouts both surface as a per-source `failed` status with the
actual error message — they do not silently stall a source in "Indexing"
forever, and they do not affect other sources in the same KB. Every step of
the pipeline (acquire, extract, chunk, the exact `add_memory` call, the
verification poll, and the final indexed/failed decision) is logged at debug
level through `services/lib/log.js`, which BOS pipes to
`GET /api/services/knowledge-base/logs`.

## Known limitations

- **(2026-08-06) Local-folder source type added beyond the original spec.**
  `spec/spec.md`'s FR-003 only calls out uploaded
  *documents*; folder-as-a-source (VFS `type: "folder"`,
  `services/lib/sources/folder.js`) was added afterward per user request,
  following the existing Upload/Drive source conventions rather than
  inventing a new one. Not yet reflected in `spec.md`/`design.md` themselves
  — see `discrepancies.md` in the spec directory.
- **(2026-08-06) The reported "drop didn't contain a readable file" bug did
  not reproduce.** Investigated the exact drop handler in `config/config.html`
  (`filesFromDataTransfer`, now folded into `handleDrop`) three ways: a unit
  test of the fallback logic against the browser-quirk shape the code's own
  comments describe (`.files` empty, `.items` populated), a live-browser
  `DataTransfer`/`File` drop simulation, and a Chromium CDP
  `Input.dispatchDragEvent` native-file-drag simulation (the same mechanism
  Chromium's own drag-and-drop test infra uses, passing a real path via
  `data.files`) — all three correctly extracted the file with zero code
  changes. The drop handler was rewritten anyway to use the FileSystem Entry
  API (`webkitGetAsEntry()`) as its primary path (falling back to
  `getAsFile()`/`.files` for older engines), both to close any remaining gap
  and because folder-drop support (above) needs the same entry-walking
  machinery. If this still reproduces in a specific browser/OS, capture
  `dataTransfer.types` from the logged `console.error` — that's the one
  signal the fallback chain doesn't already cover (e.g. a drag source that
  only offers `text/uri-list`, which no browser API can turn into a `File`).
- The Graphiti MCP tool contract (`services/lib/graphiti.js`) is `add_memory`,
  `search_nodes`, `search_memory_facts`, `get_episodes`, `delete_episode`,
  `clear_graph`, `get_status` — corrected from an earlier `add_episode` guess
  that 404'd as an unknown tool against a real deployment, and verified live
  against a real getzep/graphiti mcp_server deployment (2026-08-06):
  `delete_episode`/`clear_graph`/`get_episodes` take `uuid`/`group_ids`
  (plural, a list)/`max_episodes` respectively, not the `episode_uuid`/
  `group_id`/`last_n`+`reference_time` shape an earlier version sent (which
  the live server silently ignored/rejected). Retrieval-unit field names
  (`services/lib/graphiti.js`, `services/lib/provenance.js`) are still
  unverified against a live deployment beyond `add_memory`/`get_episodes`
  themselves.
- **(Fixed 2026-08-06) Every episode was failing queue processing with `node
  <uuid> not found`.** `add_memory` is fire-and-forget per its own
  docstring — its queued-ack response never carries an episode id — so an
  earlier version of `addEpisode()` generated its own `crypto.randomUUID()`
  and passed it as `add_memory`'s optional `uuid` argument, reasoning that
  the tool accepting a `uuid` meant it could assign one. It doesn't:
  graphiti_core's `add_episode` treats any non-null `uuid` as "this episode
  already exists" and looks it up via `EpisodicNode.get_by_uuid()` instead
  of creating a new node. For a uuid the server had never seen, that lookup
  failed inside the async queue worker on every single episode —
  `services.queue_service - ERROR - Failed to process episode <uuid> for
  group <group_id>: node <uuid> not found` — which is why `get_episodes`
  never showed a landed episode no matter how long the verification poll
  waited (it wasn't a slow embeddings backend; processing was crashing
  immediately, before ever reaching entity extraction/embedding). Fix:
  `addEpisode()` no longer sends `uuid` at all; `waitForEpisode()` now
  discovers the real Graphiti-assigned uuid by matching the polled
  `get_episodes` results on `name` (and `source_description`, to
  disambiguate) instead of on a client-generated uuid.
- **(Fixed 2026-08-06, round 2) Successfully-ingested sources were marked
  `failed` citing "embeddings issues" that were never actually diagnosed.**
  Data *was* landing in Graphiti — `waitForEpisode()`'s old 20s timeout was
  just too short: the episode isn't visible via `get_episodes` until
  graphiti_core's queue worker finishes **both** of its LLM round trips
  (structured-output entity/edge extraction, then embedding), each proxied
  through BOS's `/api/llm/openai/[...path]` to whatever provider is
  configured — routinely well over 20s in practice, worse with
  `MAX_CONCURRENT_JOBS` (`services/lib/pipeline.js`) contending for the same
  LLM. The old `VerificationTimeoutError` message also asserted a specific
  cause ("check the Graphiti server and its embeddings backend") that
  `waitForEpisode()` never actually checked — it only knows whether a
  matching episode showed up in `get_episodes`, nothing about *why* one
  hasn't. Fix: raised the default verify window to ~2min
  (`DEFAULT_VERIFY_TIMEOUT_MS` in `services/lib/graphiti.js`) and reworded
  the failure message (`services/lib/pipeline.js`) to state plainly that
  verification didn't complete in time and the episode may still be
  processing, instead of naming an undiagnosed culprit.
- **(Fixed 2026-08-06, round 3) Even the ~2min window still false-failed a
  real multi-part ingestion.** A large PDF chunked into 21 episodes timed out
  on part 2/21 against a live Graphiti deployment
  (`http://wingman.akhbar.lan:5051/mcp`) — ingestion was still succeeding,
  the verification window just wasn't generous enough for that deployment's
  real entity-extraction/embedding latency. A fixed constant can never be
  right for every deployment, so the fix has two parts: (1) raised the
  default to 300s/5min (`DEFAULT_VERIFY_TIMEOUT_MS` in
  `services/lib/graphiti.js`), and (2) made it operator-configurable —
  `graphiti.currentVerifyTimeoutMs()` reads `episodeVerifyTimeoutSeconds`
  from the same per-service config file `currentEndpoint()` already reads,
  writable from the config page's Connection settings modal
  (`config/config.html`) via the existing generic
  `/api/services/<id>/config` PATCH route, applying immediately with no
  reinstall. `services/lib/pipeline.js`'s `verifyTimeoutMs()` additionally
  scales the configured window by how many sources are indexing
  concurrently right now (capped at `MAX_CONCURRENT_JOBS`, currently 2),
  since concurrent jobs contend for the same Graphiti MCP server and LLM
  backend.
- **(Fixed 2026-08-06, round 2) Source list items in the config page
  (`config/config.html`) had unselectable text and could overflow the
  dialog.** The page sets `user-select: none` on `<body>` app-wide (so
  dragging/clicking feels native) but never opted the source list's text
  back in the way `input`/`textarea` already were — fixed by adding
  `user-select: text` to `.source-info`/`.source-status`. Separately, a long
  `statusMessage` (e.g. the verification-timeout text above) rendered in
  `.source-status-sub` with `white-space: nowrap` and no width cap on its
  `flex-shrink: 0` parent (`.source-status`), so it pushed the row wider
  than the dialog instead of wrapping — fixed by allowing that text to wrap
  (`white-space: normal` + `overflow-wrap`/`word-break`) and capping
  `.source-status` at `max-width: 45%`.
- No generative "ask the KB" tool in v1 (spec Non-Goal) — `kb_search`/
  `kb_retrieve` return entities/facts with passage citations, not answers.
- See `discrepancies.md` (spec directory) for a BOS-source discrepancy found
  during implementation — unrelated to this item's own correctness, but
  worth reading before wiring up per-agent KB access assignment again.
