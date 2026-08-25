# Discrepancies — 038-knowledge-base

Found during implementation (2026-08-06). Does not block delivery of this
feature's own scope (marketplace-item service facet + config page); flagged
per Constitution VI (Specs & Docs Stay in Sync).

## BOS source still has Revision-2 per-agent-access plumbing the Revision-3 spec removed

**Spec says (Revision 3, 2026-08-06):** per-agent knowledge-base access
assignment is removed from scope — "there is no per-KB, per-agent query-grant
surface... The `kb-settings.html` mockup is deferred/archived."

**BOS `src/` already has it, merged before the Revision-3 spec update:**

- `src/lib/agent/subagents/types.ts` — `Agent.kbs?: string[]` allowlist field.
- `src/lib/agent/subagents/store.ts` — reads/writes `kbs` alongside
  `tools`/`skills`/`mcp` in an agent's capability allowlists.
- `src/lib/agent/instructions.ts` — `buildKbIndexBlock()` renders a
  "## Knowledge bases" system-prompt block, filtered by the delegating
  agent's `kbs` allowlist (mirrors `buildSkillsIndexBlock`/`buildMcpIndexBlock`).
- `src/lib/assistant/delegation-gate.ts` — wires `buildKbIndexBlock` into the
  ephemeral-agent system-prompt composition.
- `src/components/apps/settings/assistant/KnowledgeBasesGrid.tsx` — a
  Settings → Agents per-agent checkbox grid ("Manage access" UI), explicitly
  the surface Revision 3 says is archived.
- `src/lib/agent/kb-catalog.ts` — read-only catalog reader for the above
  (`listKnowledgeBases()`, reads `<item>/data/kbs.json`). This one is
  still load-bearing and correct — this item's worker writes exactly that
  file/shape (see `services/lib/state.js`), so the catalog itself keeps
  working regardless of the per-agent-grant question below.

**Consequence — a bigger issue than stale UI:** `instructions.ts`'s
`buildKbIndexBlock()` tells the agent verbatim: *"You have access to the
following knowledge bases via kbs_tool_search / kbs_tool_retrieve."* No tool
named `kbs_tool_search` or `kbs_tool_retrieve` exists anywhere in
`src/lib/assistant/registry.ts` or `tools/server/*` — confirmed by reading
the registry's `assistantTools()` (a fixed set of `...xTools()` spreads) and
by researching whether any dynamic tool-registration path exists (it
doesn't). Once any knowledge base is created, every agent's system prompt
makes a promise that currently 404s if the model ever tries to act on it.

**What this item does instead (by design, not a workaround):** ships its own
MCP server (`services/lib/mcpServer.js`, tools `kb_search`/`kb_retrieve`/
`kb_list_knowledge_bases`) over the worker's own bound port. A user adds it
in Settings → MCP Servers (transport `http`, endpoint = this service's
`httpPath`/bound port); agents then reach it through the existing
`mcp_tool_search`/`mcp_tool_call` gateway tools. This satisfies FR-009
without any BOS source change, matching this task's constraint, but it does
**not** make the literal `kbs_tool_search`/`kbs_tool_retrieve` names in the
existing prompt text real.

**Recommended follow-up (a `src/` change, out of scope for this
marketplace-item-only task):** either (a) implement `kbs_tool_search`/
`kbs_tool_retrieve` as real registry tools that proxy to the installed
Knowledge Base item's own query endpoint (mirroring how `mcpTools()`/
`skillsTools()` are registered) — the per-agent `kbs` allowlist plumbing
already exists and would finally do something — or (b) strip the dead
Revision-2 plumbing (`Agent.kbs`, `buildKbIndexBlock`, `KnowledgeBasesGrid.tsx`,
the `## Knowledge bases` prompt block) to match the Revision-3 spec's actual
scope, and rely on the MCP path exclusively. Either resolves the
prompt-promises-a-nonexistent-tool bug; leaving both halves as-is does not.

## Local-folder source type added beyond spec scope (2026-08-06)

**Spec says (FR-003):** "The system MUST support adding **uploaded
documents** as a source type, accepting text-extractable files (PDF, TXT,
MD, DOCX, and similar)." Only Upload/Drive/Website source types are in
scope (FR-003/FR-004/FR-005); the Data Model section (§ Source) lists
exactly those three types.

**What was added:** a fourth source type, `type: "folder"` — a **local**
folder (as opposed to Drive's remote OAuth folder), selected via drag-drop
(`webkitGetAsEntry()` + recursive directory walk) or an
`<input webkitdirectory>` picker in the existing Upload modal
(`config/config.html`). Implementation follows the existing conventions
exactly: `services/lib/sources/folder.js` mirrors `sources/drive.js`'s
recursive-walk shape but over the local VFS (`lib/http-bridge.js`'s new
`vfsList()`, mirroring `vfsStat()`/`vfsReadBytes()`) instead of the Drive
API; `services/lib/pipeline.js` registers it in `ACQUIRERS` with no other
change (it falls into the existing default `"indexing"` in-progress status
and the existing generic FR-010 refresh/de-index diffing, both already
type-agnostic); `services/lib/apiServer.js` adds one route,
`POST /api/kbs/:id/sources/folder`, mirroring `/sources/upload` and
`/sources/drive`.

**Why not filed as a spec amendment instead:** this was a direct, in-session
user request ("add a folder as a source") scoped to this marketplace item
only — no BOS source change, no new architectural surface, and it reuses
100% of the existing ingestion pipeline (extract → chunk → dedupe →
add_memory → verify) untouched. Flagging here per Constitution VI rather
than silently expanding FR-003's wording. A full spec update (`spec.md`
FR-003/Data-Model, `design.md` §5.2) should happen the next time this
feature goes through Build Studio.

## Drag-and-drop file upload bug report did not reproduce (2026-08-06)

**Reported:** dropping a file onto the Upload modal's dropzone
(`config/config.html`) always failed with "That drop didn't contain a
readable file". **Investigated three ways** — a unit test of the existing
`.files`/`.items` fallback against the exact browser-quirk shape its own
comments describe, a live-browser `DataTransfer`/`File` drop simulation, and
a Chromium CDP `Input.dispatchDragEvent` native-file-drag simulation (passing
a real on-disk path via `data.files`, the same mechanism Chromium's own
drag-and-drop tests use) — all three correctly extracted the dropped file
with the code as originally found. Rewrote the handler anyway
(`handleDrop`/`webkitGetAsEntry()`-first, see README "Known limitations")
since folder-drop support needed the same entry-walking machinery regardless
— but could not reproduce a case where a real dropped file failed. If this
recurs, the browser/OS combination and `dataTransfer.types` (already logged
via `console.error` on every "no readable files" drop) matter more than the
handler code at this point.

## Test coverage

- Manual end-to-end verification (install → create KB → upload → ingest →
  fail-gracefully-without-Graphiti → rename → delete) done live against a
  throwaway `next dev` instance pointed at this branch's own data clone
  (`/data-clones/bos/038-knowledge-base`), via Playwright screenshots
  compared against the mockup. Caught two real bugs this way (`state.js`'s
  stats-merge clobbering prior fields, and an uncaught Graphiti-connection
  rejection leaving a source stuck "Indexing" forever) — both fixed and now
  covered by regression tests below.
- Real MCP server ↔ client round trip verified with the actual
  `@modelcontextprotocol/sdk` client/server over HTTP (not mocked).
- Automated tests (36, all passing) under `services/tests/` — run via
  `node --test` from `services/`: extraction (all 7 formats, including real
  `.docx`/`.pptx`/`.xlsx` fixtures), chunking, per-KB dedupe, KB/source state
  CRUD, the website crawler (against a real local HTTP server exercising
  same-domain restriction/depth cap/page limit/robots.txt), the Drive source
  (against a scripted fake adapter — no live Google OAuth needed), and the
  full pipeline orchestration (happy path, dedupe idempotency, and the
  Graphiti-unavailable failure path — the exact bug found manually above).
- No live Graphiti/FalkorDB/MCP server was available in this environment —
  `add_episode`/`search_nodes`/`search_memory_facts`/`get_episodes` are
  implemented per design.md §5.6-5.7 and exercised for connection-failure
  handling (source correctly surfaces "Graphiti unavailable: ..." instead of
  hanging), but never against a real Graphiti response payload. Verify field
  names (`uuid`/`episode_uuid`, `episodes`/`episode_uuids`) against a real
  deployment once available — `services/lib/graphiti.js` and
  `services/lib/provenance.js` isolate that mapping to one place if adjustment
  is needed.
