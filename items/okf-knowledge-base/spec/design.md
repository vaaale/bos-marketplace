# Design — OKF Knowledge Base & Ingestion Pipeline (spec 040)

## Classification

**Mixed: `bos-core` (four targeted `src/` changes) + `marketplace-item` (service facet + config-app UI facet).**

The marketplace-item part is unchanged in shape from the original 040/041: a single self-contained item at `data/user-apps/items/okf-knowledge-base/` with a **service facet** (worker-thread daemon, owns OKF storage, declares `okf_*` tools via 039) and an **app facet** (`app/config-app/index.html`, a self-contained settings UI).

The `bos-core` part is new to this spec and is deliberately small and enumerable — four changes, each a prerequisite for the ingestion redesign, none a general-purpose feature in its own right:

1. Fix `web_fetch`/`web_search` (`src/lib/net.ts`, `src/lib/assistant/tools/server/web-search.ts`).
2. Add `file_to_markdown` and `video_keyframes` server tools.
3. Extend `src/system/marketplace/install/symlinkManager.ts` to copy-install bundled agents/skills with provenance tracking.
4. Add `ffmpeg` to both Dockerfiles; add provider native-video-understanding capability detection.

### Rationale (classification ADR)

- The KB itself needs a background daemon + agent-callable tools + a settings UI — that's the service-facet shape 039 already supports; no reasoning toward `bos-core` applies there.
- The four `bos-core` changes are **infrastructure the marketplace item cannot provide for itself**: a worker-thread service cannot patch BOS's own `web_fetch` tool, cannot add a new top-level assistant tool, cannot change how BOS installs marketplace items, and cannot change the Docker image. These necessarily live in `src/`/build config. Everything else (the KB's own tool surface, storage layer, config-app) stays a pure item, as before.
- **No speculative BOS-source growth**: the `bos-core` changes are scoped exactly to what FR-023–FR-037 require, nothing broader (e.g. no general markdown-conversion "app," no new install-mechanism abstraction beyond agents/skills).

---

## Constitution check

| Principle | Compliance |
|---|---|
| **No BOS source edits for marketplace features** — except where the feature genuinely requires one. | ✅ Everything KB-specific stays under the item dir. The four `bos-core` changes are declared up front in App Target, scoped narrowly, and justified above — not a drive-by expansion. |
| **Data ownership** — user data under `dataDir()`, owned by services. | ✅ Storage under `/KnowledgeBase/`; `data/agents/`, `data/skills/` are already BOS-owned mutable stores (not source). |
| **Human-readable, non-lossy data** (OKF invariants). | ✅ Unchanged from baseline. |
| **Safety** — atomic writes, path guards, non-destructive deletes, immutable raw sources, least privilege. | ✅ Baseline invariants retained; NFR-011/012/013 (new) extend the same philosophy to the ingest sub-agent and the sandbox. |
| **Least surprise / no silent data destruction** — extends to the new agent/skill copy-install: never silently overwrite a diverged local copy (FR-037). | ✅ |
| **Loopback-scoped trust boundary**. | ✅ Unchanged — the worker still only reaches BOS via loopback (`vfs-bridge.js` → `/api/fs`), and now additionally triggers `agent_delegate` the same way (see below). |

No conflicts flagged.

---

## Architecture

### Context

A user installs the OKF Knowledge Base item. It becomes a service owning `/KnowledgeBase/<bundle>/`. The user or assistant ingests a URL, a document, an image, or a video into a bundle; queries the bundle via native tools; deletes bundles/concepts; manages bundles via the config-app.

The key architectural addition is **where semantic ingestion actually runs**. The OKF service is a worker thread outside the Next.js process — it cannot itself run an LLM turn or invoke BOS's in-process agent loop. So `okf_ingest`, when called, does not do the decomposition itself. It's a thin dispatcher: it ensures the raw source is registered (`okf_add_raw_source`), then the **calling context** (the top-level assistant, which *is* running inside the main BOS process) issues `agent_delegate` against the bundled `okf-ingest` agent — an existing, in-process BOS mechanism (`src/lib/assistant/tools/server/delegate-local.ts` → `runInnerLoop`, already used today for Build Studio → Developer delegation). The sub-agent runs with its own restricted tool allowlist and calls back into the same `okf_*` tool surface (and `web_fetch`/`web_search`/`file_to_markdown`) to do the actual concept-writing.

Concretely, ingesting a URL is two tool calls from the top-level assistant's perspective:

```
1. okf_add_raw_source({bundle, filename, sourcePath: <web_fetch output>})   — mechanical
2. agent_delegate({agent: "okf-ingest", task: "ingest raw/<file> into bundle <name>"})  — semantic
```

No new "dispatcher/runId/poll" infrastructure is needed — `agent_delegate`'s existing inner loop already handles long-running, multi-step sub-agent work (it has no 30s ceiling; that timeout is specific to the OKF *service's own* tool-call bridge, not to core delegation).

### Container

```mermaid
flowchart TD
    subgraph BOS["Next.js app process"]
        AGENT[Top-level assistant] -->|"okf_add_raw_source"| TREG[AssistantTool registry]
        AGENT -->|"agent_delegate(okf-ingest, task)"| DEL[delegate-local.ts / runInnerLoop]
        DEL -->|bounded sub-agent turn| SUBTOOLS["okf_upsert_concept, okf_add_link, okf_set_*,\nokf_find_concepts, web_search, web_fetch"]
        SUBTOOLS --> TREG
        TREG -->|dispatch tool_call| SM[ServiceManager]
        SM -->|spawn worker| W
        CP[ServiceConfigPanel] -->|iframe| CA[config-app HTML]
    end

    subgraph SUP["Supervisor (when enabled)"]
        PH[proxyServiceHttp] -->|"/__supervisor/services/{id}/"| W
    end

    subgraph ITEM["marketplace item: okf-knowledge-base"]
        W["Worker thread: okf-core + tool handlers + HTTP server"]
        ST["Storage: /KnowledgeBase/{bundle}/"]
        AGENTBUNDLE["agents/okf-ingest/AGENT.md\nskills/okf-bundle-schema/SKILL.md"]
        CA -->|fetch via httpPath| PH
        W --> ST
    end

    AGENTBUNDLE -->|copy-install (FR-035)| DATAAGENTS["data/agents/okf-ingest/\ndata/skills/okf-bundle-schema/"]
```

- **Next.js app process** — hosts `ServiceManager`, the `AssistantTool` registry, `delegate-local.ts` (the sub-agent dispatch mechanism), the config route. Does not touch OKF data directly.
- **Supervisor** — unchanged from baseline: `httpPath` bridge for the config-app.
- **Worker thread** — the service's mechanical layer: okf-core storage, `okf_add_raw_source`, graph/CRUD/lifecycle tools, HTTP bridge. It never runs the ingest sub-agent itself.
- **Bundled agent/skill** — ships inside the item (`agents/okf-ingest/AGENT.md`, `skills/<bundle-schema-id>/SKILL.md`), copy-installed into `data/agents/`/`data/skills/` (see §"Marketplace item agent/skill bundling" below).

### Component (deliverable file plan)

Paths under `data/user-apps/items/okf-knowledge-base/` (as-built layout — consolidated `services/lib/`, matching the actually-installed item, not the original design.md's idealized `services/tools/*.js` split):

```
data/user-apps/items/okf-knowledge-base/
├── services/
│   ├── service.json           # deploymentMode="tools"; configSchema adds maxDepth/maxWorkers defaults
│   └── lib/
│       ├── okf-core.js        # storage layer; add deleteBundle/deleteConcept (already shipped, 30 tools
│       │                       #   incl. okf_delete_bundle/okf_delete_concept); rename ingestRaw's tool-
│       │                       #   facing name to okf_add_raw_source; add sourcePath support
│       ├── vfs-bridge.js       # unchanged — loopback client to /api/fs
│       ├── http-bridge.js      # unchanged (DELETE routes already shipped)
│       └── tools.js            # DECLARATIONS array: rename ingest handler, narrow okf_ingest to a
│                                #   dispatcher-shaped tool (returns guidance to call agent_delegate),
│                                #   add maxDepth/maxWorkers to its schema
├── agents/
│   └── okf-ingest/
│       └── AGENT.md            # NEW — bundled sub-agent: system prompt, tool allowlist (least
│                                #   privilege — no arbitrary run_command, no full assistant surface)
├── skills/
│   └── okf-bundle-schema/
│       └── SKILL.md            # NEW — replaces the old per-bundle schema.md convention; the bundle's
│                                #   ingest/query/lint conventions as a proper BOS skill attached to
│                                #   the okf-ingest agent
├── config/
│   └── okf-knowledge-base.json # add maxDepth (default e.g. 1), maxWorkers (default e.g. 3)
└── app/
    └── config-app/
        └── index.html          # existing delete controls retained; add ingest-run visibility
                                 #   (references skipped/ingested, depth reached) — no mockup yet
```

`src/`-side changes (the four `bos-core` items):

```
src/lib/net.ts                                    # fetchText: real HTML→markdown (links preserved),
                                                   #   remove regex stripHtml, remove/raise silent
                                                   #   maxBytes truncation (paginate or clearly report
                                                   #   truncation instead of silently cutting)
src/lib/assistant/tools/server/web-search.ts      # web_fetch/web_search: pass through the fixed output
src/lib/assistant/tools/server/                   # NEW: file-to-markdown.ts (file_to_markdown tool,
  file-to-markdown.ts, video-tools.ts             #   markitdown via run_command, staged through
                                                   #   workspace/) and video-tools.ts (video_keyframes,
                                                   #   ffmpeg via run_command)
src/lib/agent/web-search.ts                       # add isNativeVideoUnderstandingAvailable() alongside
                                                   #   the existing isNativeWebSearchAvailable()
src/lib/assistant/messages.ts, model-turn.ts      # already support image content blocks (verified) —
                                                   #   extend the same path to accept native video
                                                   #   content when the capability check passes
src/system/marketplace/install/symlinkManager.ts  # installItemLink(): call a new
                                                   #   seedItemAgentsAndSkills(itemPath, itemId) step,
                                                   #   analogous to the existing seedItemConfig()
src/lib/agent/subagents/store.ts                  # accept a provenance-tagged copy source in addition
src/lib/agent/skills/store.ts                     #   to seed/*; record installedFrom{itemId,version,hash}
src/components/...                                # NEW: keep-vs-replace dialog surfaced on item
                                                   #   update when a bundled agent/skill has diverged
                                                   #   from its recorded provenance hash
Dockerfile, docker/run-command/Dockerfile         # add ffmpeg (kept in lockstep per existing comment)
```

---

## Ingestion pipeline (the core of this redesign)

### Mechanical layer — `okf_add_raw_source`

Replaces the original flat `okf_ingest` handler (`ingestRaw` in `okf-core.js`), same underlying function, renamed and widened:

```jsonc
{
  "bundle": "string, required",
  "filename": "string, required",
  "content": "string, optional — inline text (small/pasted sources)",
  "sourcePath": "string, optional — a path already staged on disk (web_fetch/file_to_markdown output); mutually exclusive with content in practice, but not enforced — sourcePath wins if both given",
  "conceptId": "string, optional — stub/extend a concept pointing at this source",
  "title": "string, optional"
}
```

Behavior is otherwise unchanged from the shipped `ingestRaw`: append-only versioning in `raw/` (never overwrites), optional concept stub with `sources` provenance, `log.md` append.

### Acquisition tools that feed it

| Tool | Where | What it does |
|---|---|---|
| `web_fetch` (fixed) | `src/lib/agent/web-search.ts` (`webFetch`/`isNativeWebFetchAvailable`), `src/lib/net.ts` (`htmlToMarkdown`/`fetchText`), wired in `tools/server/web-search.ts` | **Two-tier, native-preferred.** On Anthropic, routes through the native `web_fetch_20260318` server tool — the provider fetches and cleans upstream, BOS never parses HTML. On any other provider (self-hosted, OpenAI-compatible — where no native equivalent exists), falls back to fetching locally and converting with BOS's own dependency-free `htmlToMarkdown`, which preserves `<a href>` targets absolutized against the page URL. Also falls back if the native call *declines* — most often because its "URL must already appear in the conversation" rule wasn't met, which is a provider-specific constraint that shouldn't become a dead end. Truncation, if it ever bites, is explicit in the returned text, never silent. |
| `file_to_markdown` (new) | `src/lib/assistant/tools/server/file-to-markdown.ts` | Wraps `markitdown` (already in the sandbox per `Dockerfile`) via `run_command`'s existing plumbing directly (not the free-text `run_command` tool itself) — narrow enough to grant to a least-privilege sub-agent. PDF/DOCX/PPTX/XLSX only. Input/output staged through `workspace/` — never needs `KnowledgeBase/` visible to the sandbox (NFR-013). |
| `view_image` (new) | `src/lib/assistant/tools/server/view-image.ts` | Reads an image from a VFS path and returns it as a real vision content block via the new `ToolExecuteResult` mechanism (see below) — not OCR, not a text description. |
| `video_keyframes` (new) | `src/lib/assistant/tools/server/video-tools.ts` | `ffmpeg` + `ffprobe` sample ~N evenly-spaced frames (via `run_command`), returned as multiple image attachments through the same `ToolExecuteResult` mechanism. Confirmed (per current `platform.claude.com` vision docs) that neither Anthropic nor OpenAI accept native video input today — `isNativeVideoUnderstandingAvailable()` (`src/lib/agent/web-search.ts`) is a real capability gate that always returns `false` for now, ready to flip on when a provider adds it; frame-sampling is the only working path in this version. |

### The `ToolExecuteResult` mechanism (new `bos-core` capability this design needed and didn't have)

Investigating FR-030 surfaced a real gap: `ChatMessage.attachments` (`src/lib/assistant/messages.ts`) only ever reached the model on `role: "user"` messages — a server tool's result (`role: "tool"`) was plain text, full stop, with no way for a tool to make the model actually *see* something. Closed by extending the core tool-execution contract:
- `AssistantTool.execute` (`src/lib/assistant/tools.ts`) may now return `string | ToolExecuteResult` (`{text, attachments?}`) instead of only `string`; `serverTool()` (`tools/server/util.ts`) passes the richer shape through unchanged.
- `agent-loop.ts`'s tool-execution loop keeps `result: string` exactly as before for every existing consumer (emitted events, hooks, `CANCELLED_RESULT` checks) and only additionally threads `attachments` onto the persisted `toolMessage` — a deliberately narrow diff given how central this file is.
- `model-turn.ts`'s three provider builders (Anthropic, OpenAI Chat, OpenAI Responses) now check `attachments` on `role: "tool"` messages: Anthropic can attach images directly inside the `tool_result` content-block array; OpenAI's tool/function-output messages are text-only in this SDK, so an image rides a synthetic follow-up `user` turn carrying just the image(s), placed immediately after the tool result.
- `view_image` and `video_keyframes` are the first consumers; existing tools are unaffected (plain-string returns still work exactly as before).

None of these require an LLM turn to relay content — they're plain deterministic conversions, matching the "mechanical vs. semantic" split in the spec.

### Semantic layer — the `okf-ingest` sub-agent

Bundled with the item at `agents/okf-ingest/AGENT.md`. Tool allowlist (least privilege, NFR-011):

- Read: `okf_read_bundle_schema` (now backed by the `okf-bundle-schema` skill), `okf_read_index`, `okf_read_concept`, `okf_find_concepts` (dedup — check before creating a duplicate concept), `okf_backlinks`/`okf_neighbors` (contextualize where a new concept fits).
- Write: `okf_upsert_concept`, `okf_add_link`, `okf_set_status`, `okf_set_trust`, `okf_add_source`, `okf_append_log`.
- Acquisition (only for pulling in references it decides to follow): `web_search`, `web_fetch`, `file_to_markdown`, `okf_add_raw_source`.
- Explicitly NOT granted: `run_command` (unrestricted shell), `okf_delete_bundle`/`okf_delete_concept` (destructive ops stay a top-level-assistant-only, explicit-intent action), any non-OKF, non-fetch tool.

Its system prompt (and the `okf-bundle-schema` skill) instruct it to:

1. Read the raw source directly (via the bundle's `raw/<file>` — never re-supplied as an argument).
2. Decide concept granularity; check `okf_find_concepts` before creating a new concept vs. extending an existing one.
3. Write frontmatter (`sources`, `trust`, `status`) and link into the graph.
4. Resolve references:
   - **Mechanical first**: regex the fetched markdown for explicit URLs, `arxiv:NNNN.NNNNN` patterns (→ `arxiv.org/abs/...`), DOI patterns — zero LLM cost, done before the sub-agent even reasons about it (this step runs as plain code inside the dispatch path, not a sub-agent decision).
   - **Reasoning fallback**: only bare "Author et al. Year"-style citations with no explicit identifier are handed to the sub-agent, which uses `web_search` to resolve them.
5. For each reference judged worth ingesting: check dedup (`okf_find_concepts`/provenance) against sources already in the bundle; if new, recurse — bounded by `maxDepth` and fanned out up to `maxWorkers` concurrent `agent_delegate`/ingestion calls.
6. Report back a compact summary (concepts written, references ingested/skipped/failed) — never the raw source content — as `agent_delegate`'s return value.

### Bundle schema as a skill, not a bespoke file

The original design's `schema.md` (a per-bundle Markdown convention file, read via `okf_read_bundle_schema`) is replaced by modeling it as a genuine BOS skill (`skills/okf-bundle-schema/SKILL.md`, or one skill per bundle if bundles need divergent conventions — default: one shared skill covering the general ingest/query/lint conventions, attached to the `okf-ingest` agent). This reuses BOS's existing skill infrastructure (`src/lib/agent/skills/store.ts`) instead of inventing a parallel convention-file mechanism. `okf_read_bundle_schema` is kept as a tool (for agents that want to inspect the conventions directly) but now reads through to the skill content rather than a separate `schema.md`.

### Where the dispatcher actually lives

`okf_ingest`'s handler runs in the item's **worker thread**, which is outside the Next.js process and therefore cannot call `agent_delegate` itself. So the handler is a validator + instruction generator, not an invoker: it checks the named source really exists in `raw/` (failing fast with "call okf_add_raw_source first" if not), resolves the effective `maxDepth`/`maxWorkers` from bundle config + per-call overrides, and returns a `{status: "delegation_required", delegate: {agent, task}}` payload. The **calling assistant** — which is in-process — then issues that `agent_delegate` call. The returned task text explicitly tells the sub-agent to read the source itself, which is what keeps the document out of the orchestrating context.

### Depth/worker configuration

`services/service.json`'s `configSchema` gains:

```jsonc
{
  "maxDepth": { "type": "number", "default": 1, "description": "Reference-crawl hops beyond the seed source." },
  "maxWorkers": { "type": "number", "default": 3, "description": "Concurrent reference ingests." }
}
```

`okf_ingest`'s input schema gains optional `maxDepth`/`maxWorkers` overrides for a single call. Whether `maxWorkers` fan-out is realized as literally-concurrent `agent_delegate` calls (parallel tool-use blocks in one assistant turn) or a sequential loop bounded to feel like a soft concurrency cap is an implementation decision to confirm against how BOS's agent loop dispatches multi-tool-call turns today (see Risks).

---

## Marketplace item agent/skill bundling (the `bos-core` install-pipeline change)

### Precedent this extends

Two existing copy-based patterns already do exactly this shape of thing, just not from a marketplace item:

- `seed/agents/<id>/AGENT.md` → `data/agents/<id>/AGENT.md`, copy-once-never-overwrite (`src/lib/agent/subagents/store.ts`, `applySeedAgent`).
- `seed/skills/<id>/SKILL.md` → `data/skills/<id>/SKILL.md`, same shape (`src/lib/agent/skills/store.ts`, `seedFromDiskPath`).
- `seedItemConfig()` in `src/system/marketplace/install/symlinkManager.ts` already copies an item's `config/` defaults into `data/system/config/<id>/` on install (the one sanctioned copy in the otherwise symlink-only 035 model, because config is mutable state).

This feature adds a fourth copy path, `seedItemAgentsAndSkills(itemPath, itemId)`, called from `installItemLink()` right alongside `seedItemConfig()`.

### Why copy, not symlink

Agents/skills are designed to be locally mutable (user edits via Settings → Agents/Skills; the skill reflective-optimizer rewrites `score`/content over time). A symlink would mean the marketplace item's next `git pull` silently rewrites a user's tuned agent/skill out from under them — exactly the failure mode the 035 symlink model avoids for *app code* by keeping it read-only, but agents/skills are not read-only by design. Copying is the correct mechanism, matching the `seed/*` precedent exactly.

### Provenance and the update-conflict flow

Provenance is a sidecar `.installed-from.json` inside each copied asset directory, **not** a frontmatter field:

```json
{ "itemId": "okf-knowledge-base", "version": "1.2.0", "contentHash": "<sha256>" }
```

A sidecar rather than frontmatter because the hash must cover the **whole asset directory**, not just the entry file — a skill can carry `scripts/` and `references/`, and hashing only `SKILL.md` would call a skill "untouched" after its helper script was edited and then overwrite that edit. The digest walks the directory, sorts paths (so it doesn't depend on readdir order), includes relative paths (so a rename counts as a change), and excludes the sidecar itself (which would otherwise be self-referential). Keeping it out of frontmatter also means the agent/skill parsers need no schema change at all.

On update/reinstall:
- Hash matches the recorded one → untouched since install → **replace silently** (and skip the write entirely when the incoming copy is byte-identical, so reinstalling the same version doesn't churn mtimes).
- Hash differs → **diverged** → record a conflict, touch nothing.
- No sidecar at all → **unknown provenance** → also treated as a conflict, so a copy predating this feature is never clobbered.

**Seeding runs at install time AND lazily on first agent/skill read.** Install-time alone is not enough, for a reason that only shows up in practice: *you do not reinstall an item you already have installed*. An item that gains a bundled agent/skill — because its author shipped one, or because it was installed by a BOS build predating this feature — would never pick it up, since the only hook fires from `installItemLink`. So `reconcileInstalledItemAssets()` (memoized per process, shared by both stores) also runs from `ensureSeed()` in `subagents/store.ts` and `skills/store.ts` — exactly where BOS already seeds its own `seed/agents` → `data/agents` built-ins. Same idempotence either way: unchanged assets are skipped, diverged ones become conflicts. Seeding also logs what it applied; the original version swallowed every error silently, which made "bundles nothing" indistinguishable from "failed".

**Conflicts are persisted, not returned-and-forgotten.** An install can happen with nobody watching (an agent calling `app_build`, a headless marketplace sync), so a purely in-band return value would silently drop the prompt and leave the user pinned to a stale bundled agent forever. `seedItemBundledAssets` therefore appends conflicts to `dataDir()/system/bundled-asset-conflicts.json` (replacing any stale entry for the same asset rather than stacking duplicates), and they surface whenever the user next opens Settings:
- `GET/POST /api/bundled-assets` — list pending conflicts / resolve one.
- `BundledAssetConflicts.tsx` renders them inside the **Agents** and **Skills** tabs, filtered by kind — the decision is about a specific agent or skill, so it belongs where the user already manages them rather than in a tab of its own.
- "Keep mine" is a no-op by construction (the local copy already won by default); "Use the update" performs the deferred copy.

This mirrors dpkg conffile handling / VS Code extension setting merges — well-understood UX, not a novel invention.

---

## Data flow, error handling, lifecycle

Unchanged from baseline for tool invocation, config-app↔worker bridge, and service lifecycle (see original 040's mechanisms — 039 contract, `httpPath`/direct-port fallback, `cleanupServiceTools`). New flows:

### Ingest data flow

```
Assistant → okf_add_raw_source (mechanical, worker) → raw/<file> written
Assistant → agent_delegate("okf-ingest", task) → runInnerLoop (main BOS process)
  → sub-agent reads raw/<file> directly, calls okf_upsert_concept/okf_add_link/... (worker)
  → mechanical reference regex (plain code, no LLM) → web_search only for unresolved bare citations
  → recurse (bounded maxDepth/maxWorkers) → summary returned as agent_delegate's output
```

### Document/media acquisition data flow

```
Assistant → file_to_markdown({path}) → run_command sandbox (workspace/-scoped) → markitdown
  → markdown written to workspace/ → okf_add_raw_source({sourcePath: workspace/...}) → raw/
```

```
Assistant → video_keyframes({path}) → run_command sandbox → ffmpeg → frames in workspace/
  → (native video path: pass video directly to a capability-checked provider instead)
  → okf-ingest sub-agent views frames/video as multimodal content
```

### Marketplace agent/skill install data flow

```
app_build/install → installItemLink() → seedItemConfig() [existing]
                                      → seedItemAgentsAndSkills() [new]
                                           → for each agents/<id>, skills/<id> in the item:
                                               hash-compare against data/agents|skills/<id>'s
                                               recorded installed_from.content_hash
                                               → match/missing-dest: copy + record hash
                                               → mismatch: queue keep-vs-replace prompt
```

---

## ADRs

### ADR-001 — Classify as mixed `bos-core` + `marketplace-item`, not pure marketplace-item
- **Context**: the ingestion redesign needs capabilities (fixing a built-in tool, adding new built-in tools, changing the install pipeline, changing Docker images) that no marketplace item can provide for itself.
- **Decision**: scope the `bos-core` surface to exactly four enumerated changes (§Classification), each justified as a prerequisite, not a general feature.
- **Consequences**: this spec's implementation touches `src/` (unlike the original 040/041, which touched zero `src/` files) — reviewed and accepted because the alternative (keeping ingestion entirely inside the item) cannot fix `web_fetch` or add sandboxed document conversion at all.

### ADR-002 — Ingest is dispatched via `agent_delegate`, not a new async run/poll mechanism
- **Context**: semantic decomposition is a multi-step reasoning task; the original design's flat `okf_ingest` couldn't do it, and a first pass at this redesign considered inventing a dispatcher tool with a `runId` + status-polling tool.
- **Decision**: reuse `agent_delegate`/`runInnerLoop` (`src/lib/assistant/tools/server/delegate-local.ts`), already used for Build Studio → Developer delegation. `okf_ingest`'s job shrinks to being a dispatcher that guides the calling assistant to (a) register the raw source, (b) delegate to the bundled `okf-ingest` agent.
- **Consequences**: no new run-tracking infrastructure; delegation depth is already guarded (`checkDelegationDepth`); the existing mechanism already tolerates long-running sub-agent turns. Trade-off: the calling assistant's own turn is occupied for the duration of the delegated ingest (synchronous from its perspective) — acceptable for v1; a future revision could explore backgrounding if ingest runs prove too slow for interactive use.

### ADR-003 — Mechanical reference resolution before reasoning, not a uniform LLM pass
- **Context**: some references are plain URLs/arXiv IDs/DOIs (mechanically resolvable); others are bare "Author et al. Year" citations (need judgment + search).
- **Decision**: regex-resolve the mechanical cases as plain code before the sub-agent reasons about anything; only hand the sub-agent the remainder, with `web_search` available for those.
- **Consequences**: token/tool-call cost for reference resolution is proportional to actual ambiguity in the source, not a blanket cost paid on every ingest regardless of how many references are already explicit links.

### ADR-004 — Copy-install for bundled agents/skills, with content-hash provenance
- **Context**: 035 established one-symlink-per-item for app code; agents/skills are locally mutable by design, so symlinking them would let a marketplace update silently overwrite local tuning.
- **Decision**: copy on install (matching `seed/agents`/`seed/skills`), record `installed_from.{item_id,version,content_hash}`, and gate updates on a hash comparison — silent replace when untouched, keep-vs-replace prompt when diverged.
- **Consequences**: a small new install step (`seedItemAgentsAndSkills`) and a new UI surface (the keep-vs-replace dialog); no change to the existing one-symlink model for app/service code.

### ADR-005 — Bundle schema modeled as a BOS skill, not a bespoke `schema.md` convention
- **Context**: the original design's `schema.md` was a Markdown convention file with no relationship to BOS's actual skill system.
- **Decision**: model it as a real skill (`skills/okf-bundle-schema/SKILL.md`) attached to the `okf-ingest` agent; `okf_read_bundle_schema` remains as a tool but reads through to the skill.
- **Consequences**: bundle conventions benefit from the skill system's existing tooling (Settings → Skills editing, the reflective optimizer) for free, instead of being a KB-specific dead end.

### ADRs carried unchanged from baseline (see original mechanisms, not re-litigated here)
- Tools declared at runtime over worker IPC (039 ADR-002).
- LLM-based retrieval, not RAG/embeddings.
- Config-app talks to the worker via the Supervisor `httpPath` bridge.
- `okf_delete_bundle` as a real tool (not HTTP-only) — the agent-symmetric counterpart to `okf_init_bundle`.
- Non-destructive-by-default concept deletion.

---

## Risks / open questions

1. **`maxWorkers` concurrency model — resolved, and it IS real concurrency.** Initially resolved as "sequential only": `agent-loop.ts` executed every tool call in a turn strictly one at a time. That limitation has since been **removed** as a general BOS capability rather than worked around here — see §"Parallel tool execution" below. `agent_delegate` is marked `parallelSafe`, so a turn that issues N delegations genuinely runs them at once, bounded by `maxParallelTools` (default 6). `maxWorkers` therefore means what it says, and raising it produces real wall-clock speedup on reference-heavy ingests.

### Parallel tool execution (`bos-core`, general capability)

Added to the agent loop for BOS as a whole, not just for ingest:

- `AssistantTool.parallelSafe?: boolean` — **opt-in, default false**, so every existing tool keeps its exact prior behavior.
- `batchToolCalls()` groups **adjacent** parallel-safe calls into batches capped at `maxParallelTools` (default 6, overridable per run). Adjacency is the safety property: relative order is never rearranged, so given `[read, read, write, read]` the batches are `[read, read] → [write] → [read]` — the reads overlap, but the write still happens strictly between them. Grouping every safe call in a turn regardless of position would break exactly that.
- **Results are appended in call order, never completion order**, so the transcript is deterministic and replays identically regardless of which tool finished first.
- All batch `tool_call` events are emitted before any of them is awaited, so the browser can dispatch a batch of frontend tools concurrently and the UI shows them starting together.
- Cancellation, per-call hooks, in-band error handling, and the "every tool_use id gets an answer" invariant are preserved — a throwing tool cannot strand its siblings.

Parallelism is available on all three tool surfaces:

| Surface | How a tool opts in | Marked so far |
|---|---|---|
| Built-in server tools | `parallel(serverTool(…))` (`tools/server/util.ts`) | `web_search`, `web_fetch`, `file_search`, `file_glob`, `view_image`, `file_to_markdown`, `video_keyframes`, `agent_delegate` |
| Service tools (039) | `parallelSafe: true` on the `ToolDeclaration` sent via `tool_declare` | 17 read-only `okf_*` tools (via the item's own `readOnly()` helper); all 14 writers left sequential |
| Frontend tools | membership in `PARALLEL_SAFE_FRONTEND_TOOLS` (`tools/frontend-declarations.ts`) | `file_read`, `file_list`, `bos_app_list` |

Two prerequisites were resolved to get there rather than worked around:

- **`run_command`'s container creation is now single-flighted.** `ensureContainer` did `registry-miss → docker rm -f → docker run --name <same>`, so two overlapping calls for one session would collide on the container name — or one would tear down the container the other was about to `exec` into. An in-flight promise map keyed by `sessionKey` makes concurrent callers share a single creation while different sessions still proceed in parallel; a failed creation doesn't poison the key (the `finally` always clears it). `syncLocalSymlinks` gets the same coalescing for the local backend. That unblocked marking `file_to_markdown`/`video_keyframes` safe — each already wrote uniquely-named temp files it alone reads and deletes.
- **The client tool kernel was verified re-entrant, not assumed.** `dispatchFrontendCall` is per-callId and fire-and-forget; `runToolHandler` (`tool-kernel.ts`) keeps every controller/timer/abort-registration in a per-call local and only adds/removes its own entry in the `activeRuns` set; `flushSurfaceTools`/`flushSurfaceAgents` were *already* written to coalesce concurrent callers; `postToolResult` is callId-keyed and the server dedupes first-result-wins. So the kernel never was the constraint — only what an individual handler touches is, which is why frontend opt-in is an explicit per-tool allowlist rather than a blanket flag.

Still deliberately sequential everywhere: every writer. Two concurrent upserts to one concept, two writes to one path, or two window mutations in a frame are exactly the races this design guards against.
2. **`web_fetch` truncation — resolved, moot.** Routing through Anthropic's native `web_fetch` tool (ADR, see below) means BOS no longer does its own byte-capped fetch at all — the provider's own `max_content_tokens` tool parameter (unset by default) is the only length control, and it truncates with the request still succeeding rather than silently cutting bytes client-side. No BOS-side truncation logic remains to get wrong.
3. **Content-hash provenance and multi-file skills.** Skills can carry `scripts/`/`references/` subfolders (per `src/lib/agent/skills/store.ts`); the content hash for divergence-detection needs to cover the whole asset set, not just `SKILL.md`'s body, or a changed reference doc would go undetected as "diverged."
4. **`file_to_markdown`/`video_keyframes` sandbox staging.** Confirm the `run_command` backend (local or Docker) reliably shares a `workspace/` path both the calling tool and the sandboxed process can see, and that cleanup of staged intermediate files happens (no orphaned files accumulating in `workspace/` after every ingest).
5. **Native video understanding provider coverage.** Which providers/models BOS supports actually accept video input natively shifts over time and needs verifying against current docs at implementation time, not assumed from this spec.
6. **`okf-ingest` agent's tool allowlist enforcement — resolved, confirmed.** Traced the actual call path: `agent_delegate` (named kind) → `delegateToAgent` (`delegate-common.ts`) → `namedDelegationGate(def.id)` (`delegation-gate.ts`) → `gateFor(agentId)`, which derives the gate from the **named agent's own** declared `tools` allowlist (backfilled to explicit per the Phase B strict-allowlist migration in `subagents/store.ts` — "empty allowlist = zero tools", never "unset ⇒ all"). `runInnerLoop` passes the full `parentRun.tools` map as the tool *implementation* registry, but the separately-passed `gate` is what the model actually sees as callable — and that gate is scoped to `okf-ingest`'s own frontmatter `tools:` list, not the delegating (top-level) agent's surface. NFR-011 holds as designed, contingent only on `agents/okf-ingest/AGENT.md`'s `tools:` field actually listing the narrow allowlist from this design (not an "all tools" default).
7. **Pre-existing OKF installs upgrading into this feature.** An already-installed `okf-knowledge-base` item (30 tools, flat `okf_ingest`) upgrading to this redesign needs the `okf_ingest` schema change, the new `okf_add_raw_source` tool, and the bundled agent/skill's first-ever install (no prior `installed_from` to compare against) — confirm the upgrade path doesn't require a full uninstall/reinstall.

## UI mockup reference

- **Path**: `040-okf-knowledge-base.html` (baseline screens) in this spec directory.
- **Delete controls**: no longer a separate mockup file; their design intent (per-row + toolbar Delete actions, named confirmation dialogs, default-unchecked "rewrite backlinks" checkbox) carries forward as the visual contract for the consolidated config-app.
- **Ingest-run visibility and `maxDepth`/`maxWorkers` settings**: new UI surface, not yet mocked — design during implementation, consistent with the existing visual language.
