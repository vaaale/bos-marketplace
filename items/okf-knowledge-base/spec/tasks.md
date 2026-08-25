# Tasks: OKF Knowledge Base & Ingestion Pipeline

**Input**: Design documents from `/Specs/user-specs/040-okf-knowledge-base/` (spec.md, design.md, plan.md)

**Prerequisites**: plan.md (required), spec.md (required for user stories), design.md

**Tests**: Included where the story is independently verifiable; e2e for UI-facing stories, unit tests for storage-layer changes, and a scripted-conversation integration check for the `agent_delegate`-based ingest flow (not a Playwright e2e, since it's a server-side agent loop).

**Organization**: Tasks grouped by user story (US1–US8 per spec.md). Item paths under `data/user-apps/items/okf-knowledge-base/`; `bos-core` paths under `src/`.

---

## Implementation status (as built)

**Done:** Phases 1, 2, 3 (US2), 5 (US7), and the US3 tooling. `web_fetch` now routes through Anthropic's native server tool; `file_to_markdown`/`view_image`/`video_keyframes` exist and are registered; `ffmpeg` is in both images; the OKF item's ingest tools are split into `okf_add_raw_source` (mechanical) + `okf_ingest` (dispatcher); the `okf-ingest` agent and `okf-bundle-schema` skill are written and ship with the item; bundled agents/skills copy-install with content-hash provenance and a keep-vs-replace flow.

**Findings that changed the plan** (all recorded in design.md):
1. **`maxWorkers` was blocked on sequential tool execution — now unblocked.** `agent-loop.ts` originally ran every tool call in a turn strictly one at a time, so `maxWorkers` could only ever have been a pacing hint. Rather than work around it, parallel tool execution was added as a **general BOS capability** (T047 below): opt-in `parallelSafe` per tool, adjacent-only batching, bounded concurrency, call-order results. `agent_delegate` is marked safe, so ingest fan-out now genuinely runs in parallel and `maxWorkers` means what it says.
2. **Tool results could not show the model an image.** `attachments` only reached the model on `role:"user"` messages, so FR-030's "pass the image as a multimodal block" had nothing to build on. Closed by adding the `ToolExecuteResult` mechanism to the core tool contract (T011a).

Both are `bos-core` capabilities beyond the four this spec originally anticipated, and both are useful to BOS well outside the KB.

### T047 — Parallel tool execution (`bos-core`) ✅

- [x] `AssistantTool.parallelSafe?: boolean` (default false — every existing tool behaves exactly as before) + `parallel()` marker helper in `tools/server/util.ts`.
- [x] `batchToolCalls()` in `agent-loop.ts`: groups **adjacent** safe calls, capped by `maxParallelTools` (default 6). Adjacency prevents any write from being reordered around a read.
- [x] Results appended in **call order, not completion order**; batch `tool_call` events emitted up front so a frontend batch dispatches together; cancellation, hooks, and per-call error isolation preserved.
- [x] Marked safe (built-in server tools): `web_search`, `web_fetch`, `file_search`, `file_glob`, `view_image`, `agent_delegate`.
- [x] New `tests/assistant/tool-concurrency.test.ts` — batching/grouping, real overlap, non-safe isolation, call-order determinism, one-throws-others-survive, cancel-mid-batch, event ordering.

### T048 — Concurrency follow-ups ✅ (all three done)

- [x] **Single-flighted the `run_command` sandbox.** `ensureContainer` raced on concurrent calls (`registry-miss → rm -f → run --name <same>`): two overlapping calls for one session would collide on the name, or one would tear down the container the other was about to exec into. Added an in-flight promise map keyed by `sessionKey` (different sessions still run in parallel; a failed creation doesn't poison the key), plus the same coalescing for `syncLocalSymlinks` on the local backend. Verified the semantics with a 4-case harness (same-key coalesces to 1, different keys stay parallel, post-settle recreates, failure retries). **Then marked `file_to_markdown` and `video_keyframes` parallel-safe** — each already wrote uniquely-named temp files it alone reads and deletes, and markitdown's Office path is pure Python (no shared LibreOffice profile).
- [x] **`parallelSafe` on the 039 `ToolDeclaration`.** Added to `serviceToolTypes.ts`, threaded through `registry.ts`'s `serviceAssistantTools()`. Confirmed the bridge stores declarations whole (no field stripping) and added a passthrough test asserting a declared flag survives and an undeclared one stays `undefined`. The OKF item now wraps its **17 read-only** tools in a local `readOnly()` helper; all **14 writers** (`okf_upsert_concept`, `okf_add_link`, `okf_delete_*`, `okf_add_raw_source`, `okf_append_log`, …) stay sequential, since concurrent writes would race the same files and okf-core's in-memory backlink index.
- [x] **Client kernel verified re-entrant; frontend parallelism enabled per-tool.** Traced the full path: `dispatchFrontendCall` per-callId and fire-and-forget → `runToolHandler` with all state in per-call locals and self-scoped `activeRuns` add/remove → `flushSurfaceTools`/`flushSurfaceAgents` already coalescing concurrent callers by design → `postToolResult` callId-keyed with server-side first-result-wins. The kernel was never the constraint; only individual handlers are, so opt-in is an explicit allowlist (`PARALLEL_SAFE_FRONTEND_TOOLS` = `file_read`, `file_list`, `bos_app_list` — all stateless reads). Added a test that dispatches two frontend calls together, answers them in reverse order, and asserts the transcript still follows call order.
- [x] 71 tests pass across assistant/agent/compaction (11 concurrency + 1 bridge passthrough are new); `tsc --noEmit` and lint clean.

**Not yet done:** Phase 4's US3 wiring inside the ingest agent's own flow beyond tool availability (T026–T028), Phase 6 baseline verification against a running instance (T036–T040), and Phase 7 polish/delivery (T041–T046, incl. `app_build` + worker restart and the e2e suite updates). Repo-wide `npm run lint` and `npx tsc --noEmit` are clean for every file touched; `tests/assistant` (37) and `tests/agent`+`tests/compaction` (22) pass. The full `npm run test:unit` run cannot start in this environment due to a pre-existing missing `http-proxy-middleware` dep in the `bastion/` sub-project (untouched by this work).

---

**Baseline note**: Bundle/concept CRUD, graph tools, provenance/trust/lifecycle tools, and delete capability (`okf_delete_bundle`/`okf_delete_concept`, 30 `okf_*` tools total) are **already implemented and installed** — verified directly against the running item's `services/lib/tools.js`. Phases for US1, US4, US5, US6, US8 below are therefore verification/consolidation tasks (confirm the baseline still holds and docs now match it), not net-new implementation. The real implementation work is US2, US3, US7 (ingestion redesign + agent/skill bundling) and the Setup/Foundational phases those depend on.

---

## Phase 1: Setup (Shared Infrastructure) — ✅ COMPLETE

**Purpose**: Confirm the as-built baseline and stage the four `bos-core` changes.

- [x] T001 [P] Verified: the installed item declared exactly **30** `okf_*` tools (including `okf_delete_bundle`/`okf_delete_concept`), confirming the "29" in the pre-consolidation docs was stale.
- [x] T002 [P] Verified `markitdown[all]`, `poppler-utils`, `libreoffice`, `python-docx`, `python-pptx` present in both images. `ffmpeg` confirmed absent (→ T009).
- [x] T003 [P] **NFR-011 confirmed.** Traced `agent_delegate` → `delegateToAgent` → `namedDelegationGate(def.id)` → `gateFor(agentId)`: the gate is built from the **named agent's own** `tools` allowlist, not the delegating agent's. `runInnerLoop` passes `parentRun.tools` as the implementation registry, but the separately-passed `gate` is what the model can actually call. Least privilege holds as designed.
- [x] T004 [P] **Risk #1 resolved: sequential only.** `agent-loop.ts:311` executes tool calls strictly sequentially by design ("Execute tool calls sequentially... EVERY call gets an answer... before the loop can end"). `maxWorkers` is therefore a pacing/batch hint, not real concurrency — recorded in design.md and in both tool descriptions so no one is misled.

**Checkpoint**: ✅ Baseline confirmed; delegation and concurrency mechanics understood before building on top of them.

---

## Phase 2: Foundational — `bos-core` prerequisites (Blocking) — ✅ COMPLETE

**Purpose**: The four `bos-core` changes every ingestion user story depends on.

- [x] T005+T006 [US2] **Corrected after a live regression.** The first attempt routed `web_fetch` *exclusively* through Anthropic's native server tool and errored on every other provider. That broke real usage: BOS was configured against a self-hosted OpenAI-compatible endpoint (`provider: openai`, custom `baseUrl`), where the tool had previously worked via the local path — so "fail loudly instead of degrading" turned a working tool into a dead one for exactly the users who had no alternative. Now **two-tier**: native where it exists (Anthropic), local fetch + `htmlToMarkdown` everywhere else, plus a fallback when the native call declines (e.g. its URL-must-be-in-conversation rule). The local converter is dependency-free per CLAUDE.md and preserves/absolutizes links — the specific thing the original `stripHtml` destroyed. Covered by `tests/assistant/html-to-markdown.test.ts` (6 tests) and verified against a live page. Original note follows.

- [x] T005+T006 [US2] **Approach changed — better than planned.** Rather than improving BOS's own HTML→markdown scraping, `web_fetch` now routes through Anthropic's **native `web_fetch_20260318` server tool**, exactly mirroring how `web_search` already routes through native `web_search_20250305`. Anthropic fetches and cleans the page on its own infrastructure; BOS never parses HTML, so there is no local truncation or stripping logic left to get wrong. New `webFetch()`/`isNativeWebFetchAvailable()` in `src/lib/agent/web-search.ts`; handler rewired in `tools/server/web-search.ts`. Verified against current API docs: no beta header needed; the tool can only fetch URLs already present in the conversation (satisfied for seed URLs and for references found inside already-fetched text). Errors clearly on non-Anthropic providers instead of silently degrading. **`src/lib/net.ts`'s `fetchText` is deliberately left in place** — it still backs the legacy CopilotKit `web_fetch` action and `/api/web-fetch`, which are part of the retired chat surface and out of scope here.
- [x] T007 [US3] `src/lib/assistant/tools/server/file-to-markdown.ts` — wraps `markitdown` through `run_command`'s plumbing directly (never exposing free-text `command`), `/workspace`-jailed with `..`-rejection, temp output cleaned up in a `finally`.
- [x] T008 [US3] `src/lib/assistant/tools/server/video-tools.ts` — `ffprobe` for duration → evenly-spaced `ffmpeg` frame sampling, frames returned as image attachments, temp frames cleaned up.
- [x] T009 [US3] `ffmpeg` added to **both** `Dockerfile` and `docker/run-command/Dockerfile`.
- [x] T010 [US3] `isNativeVideoUnderstandingAvailable()` added to `src/lib/agent/web-search.ts`. **Verified against current provider docs: neither Anthropic nor OpenAI accepts native video input today** (Claude vision is JPEG/PNG/GIF/WebP; "Animations are unsupported, and only the first frame is used"). The check returns `false` and is documented as a ready-to-flip gate; frame-sampling is the only working path in this version.
- [x] T011 [US3] **Scope grew — a real gap was found, see new T011a.** The plan assumed `messages.ts`/`model-turn.ts` "already support" showing an image from a tool. They did not: `attachments` only ever reached the model on `role:"user"` messages.
- [x] T011a [US3] **NEW — `ToolExecuteResult` core mechanism.** `AssistantTool.execute` may now return `string | {text, attachments?}`; `serverTool()` passes it through; `agent-loop.ts` threads attachments onto the persisted tool message (keeping `result: string` unchanged for every existing consumer); all three provider builders in `model-turn.ts` render them — Anthropic inside the `tool_result` block array, OpenAI Chat/Responses as a synthetic follow-up user turn (their tool-result messages are text-only). New `view_image` tool is the image-ingestion path (FR-030); `video_keyframes` uses the same mechanism.
- [x] T012 [US2] Registered `file_to_markdown`, `view_image`, `video_keyframes` in `src/lib/assistant/registry.ts` **and** in `src/lib/agent/capabilities-registry.ts` — the latter is required or an agent listing them in its `tools:` allowlist would be flagged unresolved by `gate.ts`.

**Checkpoint**: ✅ `web_fetch` is native; document/image/video acquisition tools exist and are sandbox-contained; native-video capability detection exists; tool results can carry images.

---

## Phase 3: User Story 2 - Ingest a URL without retyping the source (Priority: P1) 🎯 MVP for the redesign

**Goal**: `okf_add_raw_source` + `agent_delegate("okf-ingest", ...)` replace the flat `okf_ingest` call; no article content appears as model output.

**Independent Test**: Ask the assistant to ingest a known URL; inspect the transcript for zero article-length model-generated output; verify concepts appear afterward.

### Tests for User Story 2

- [ ] T013 [P] [US2] Unit test: `okf_add_raw_source` accepts `sourcePath` and registers the file into `raw/` without requiring `content`, in `services/tests/add-raw-source.test.js`.
- [ ] T014 [P] [US2] Unit test: mechanical reference resolution — regex extracts explicit URLs, `arxiv:NNNN.NNNNN`, and DOI patterns from a sample markdown source without any `web_search` call, in `services/tests/reference-resolution.test.js`.
- [ ] T015 [US2] Integration check (scripted conversation, not Playwright): ingest a URL end-to-end; assert the transcript contains no full-article-length assistant-generated text block, and that `okf_list_concepts` reflects new concepts afterward.

### Implementation for User Story 2 — ✅ COMPLETE

- [x] T016 [US2] `okf_add_raw_source` added (renamed from the flat `okf_ingest`), schema widened with `sourcePath`; `okf-core.ingestRaw` reads from the VFS path and derives the filename from its basename when omitted. Append-only `.vN` versioning preserved. Verified against a stubbed VFS: sourcePath ingest, repeat→`.v2`, inline `content` still works, and the both-missing case errors correctly.
- [x] T017 [US2] `okf_ingest` is now a dispatcher: validates the raw source exists (errors with "call okf_add_raw_source first"), resolves `maxDepth`/`maxWorkers` from config + per-call overrides, returns `{status:"delegation_required", delegate:{agent, task}}`. **It cannot call `agent_delegate` itself** — the worker thread is outside the Next.js process — so the calling assistant issues that call. Verified all four paths (happy, override, missing file, missing arg).
- [x] T018 [US2] `agents/okf-ingest/AGENT.md` written with the least-privilege `tools:` allowlist from design.md (no `run_command`, no delete tools).
- [x] T019 [US2] `skills/okf-bundle-schema/SKILL.md` written (concept granularity, the three frontmatter families, linking, ingest/query/lint).
- [x] T020 [US2] **Deferred, deliberately.** `okf_read_bundle_schema` still reads the bundle's own `schema.md`. That file is the bundle owner's per-bundle voice; the new skill is the general fallback, and the skill itself says the bundle's `schema.md` wins on conflict. Rewiring the tool to read the skill would *remove* per-bundle customization rather than add anything — the skill reaches the agent via its `skills:` frontmatter already.
- [x] T021 [US2] `maxDepth`/`maxWorkers` added to `services/service.json`'s `configSchema` and `config/okf-knowledge-base.json`; read into `ingestDefaults` at worker startup and threaded into the handler ctx.
- [x] T022 [US2] Dedup instruction is in the agent prompt and restated in the generated delegation task; `okf_provenance`/`okf_find_concepts` are in the agent's allowlist to perform it.

**Checkpoint**: US2 fully functional — ingesting a URL is a two-call flow (`okf_add_raw_source` + `agent_delegate`), zero article content in the orchestrating conversation's output tokens, references resolved mechanically-first.

---

## Phase 4: User Story 3 - Ingest documents, images, and video (Priority: P1)

**Goal**: PDF/DOCX/PPTX/XLSX, images, and video ingest through the same pipeline as URLs.

**Independent Test**: Ingest a multi-section PDF; verify multiple correctly-linked concepts. Ingest a photo; verify real visual understanding in the resulting concept.

### Tests for User Story 3

- [ ] T023 [P] [US3] Unit/integration test: `file_to_markdown` converts a sample PDF/DOCX/PPTX/XLSX to markdown via `markitdown`, staged through `workspace/`, in `src/lib/assistant/tools/server/__tests__/file-to-markdown.test.ts`.
- [ ] T024 [P] [US3] Integration test: `video_keyframes` extracts frames from a sample video via `ffmpeg` (post-T009), in `src/lib/assistant/tools/server/__tests__/video-tools.test.ts`.
- [ ] T025 [US3] Integration check: ingest an image end-to-end; assert the resulting concept's body reflects visual content beyond literal OCR text (i.e., the multimodal path was used, not a text-only fallback).

### Implementation for User Story 3

- [ ] T026 [US3] Wire `file_to_markdown` output into `okf_add_raw_source` (via `sourcePath`) as the standard path for PDF/DOCX/PPTX/XLSX sources; update `okf-ingest`'s prompt (T018) to call it when given a non-URL, non-text file path.
- [ ] T027 [US3] Wire image ingestion: when the source is an image, pass it to the `okf-ingest` sub-agent as a multimodal content block (via T011) rather than staging through `file_to_markdown`; the original image is still registered into `raw/` (immutable binary source) via `okf_add_raw_source`.
- [ ] T028 [US3] Wire video ingestion: default to `video_keyframes` (T008); when T010's capability check passes for the active provider, pass the video natively instead of sampled frames.

**Checkpoint**: US3 functional — all five non-URL source types (PDF, DOCX, PPTX, XLSX, image; video pending T009/T028) ingest through the same mechanical/semantic split as URLs.

---

## Phase 5: User Story 7 - Marketplace item agent/skill bundling with safe updates (Priority: P2)

**Goal**: Bundled agents/skills (starting with `okf-ingest` + `okf-bundle-schema`) install via copy, not symlink, with provenance-gated updates.

**Independent Test**: Install the item; edit the installed `okf-ingest` agent's prompt; update the item; verify a keep-vs-replace prompt (not a silent overwrite). Reinstall unchanged; verify silent replace.

### Tests for User Story 7

- [ ] T029 [P] [US7] Unit test: `seedItemAgentsAndSkills()` copies an item's `agents/<id>/AGENT.md`/`skills/<id>/SKILL.md` into `data/agents/<id>/`/`data/skills/<id>/` and records `installed_from.{item_id,version,content_hash}`, in `src/system/marketplace/install/__tests__/symlinkManager.test.ts`.
- [ ] T030 [P] [US7] Unit test: an untouched installed agent/skill (hash matches recorded provenance) is silently replaced on update; a diverged one is not touched without confirmation.
- [ ] T031 [US7] Integration test: the keep-vs-replace dialog appears exactly when divergence is detected, and not otherwise.

### Implementation for User Story 7 — ✅ COMPLETE

- [x] T032 [US7] Implemented as `seedItemBundledAssets()` in a new `src/system/marketplace/install/bundledAssets.ts` (rather than inline in `symlinkManager.ts`, which stays focused on the symlink), called from `installItemLink()` right after `seedItemConfig()`. Never throws — a bad bundled extra must not fail the item's primary install.
- [x] T033 [US7] **Provenance is a `.installed-from.json` sidecar, not frontmatter** — the hash must cover the whole asset directory (design.md Risk #3), and a sidecar needs no schema change in either store. Digest sorts paths, includes relative paths, and excludes itself. Verified with a 6-case harness: fresh install, untouched, edited entry file, restore, **edited bundled script** (the Risk #3 case — correctly detected), and sidecar-excluded-from-hash.
- [x] T034 [US7] **Persisted conflicts + Settings UI, not a modal dialog.** Conflicts are written to `dataDir()/system/bundled-asset-conflicts.json` so a headless install (agent `app_build`, marketplace sync) still surfaces the decision later instead of dropping it. `GET/POST /api/bundled-assets` + `BundledAssetConflicts.tsx`, rendered in the **Agents** and **Skills** tabs filtered by kind.
- [x] T035 [US7] `agents/okf-ingest/AGENT.md` + `skills/okf-bundle-schema/SKILL.md` added to the item — first real consumer of the mechanism.
- [x] T035a [US7] **NEW** — registered the three new tools in `capabilities-registry.ts`, without which `gate.ts` would reject the `okf-ingest` agent's allowlist entries as unresolved.

**Checkpoint**: US7 functional — the OKF item's bundled agent/skill install via copy with provenance; a locally-edited copy survives an item update without a silent overwrite.

---

## Phase 6: User Stories 1, 4, 5, 6, 8 - Baseline verification (Priority: P1/P2/P3, already implemented)

**Goal**: Confirm the pre-existing baseline (bundle/concept CRUD, graph tools, native tool query, delete, import/export, provenance/trust/lifecycle) still holds and is accurately documented — no new implementation expected here.

- [ ] T036 [P] Verify US1 (create bundle + concepts) against the running item — no code change expected.
- [ ] T037 [P] Verify US4 (native tool query/traversal, gating, schema validation) against the running item.
- [ ] T038 [P] Verify US5 (`okf_delete_bundle`/`okf_delete_concept`, confirmation-gated UI, non-destructive default) against the running item — these already exist (30-tool baseline includes both); write the e2e assertions the former 041 spec called for but never actually landed (no `041-*.spec.ts` was found in the store), folding them into `e2e/040-okf-knowledge-base.spec.ts`.
- [ ] T039 [P] Verify US6 (import/export) against the running item.
- [ ] T040 [P] Verify US8 (provenance/trust/lifecycle tools) against the running item.

**Checkpoint**: Baseline confirmed and gap-filled (delete e2e coverage) without re-implementing anything already working.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, tool-surface reconciliation, full test run, delivery.

- [ ] T041 [P] Rewrite `tool-surface.md` in this spec directory to reflect the actual current + redesigned tool set: 30 baseline tools, `okf_ingest`'s new dispatcher schema, `okf_add_raw_source` (renamed), and note `file_to_markdown`/`video_keyframes` as non-OKF assistant tools (not part of the 039-declared set).
- [ ] T042 [P] Update `docs/dev/architecture-overview.md` and any other `docs/` references to `okf_ingest`'s old flat signature.
- [ ] T043 Update `e2e/040-okf-knowledge-base.spec.ts` for the renamed/changed tool surface (`okf_add_raw_source`, `okf_ingest`'s new schema) and add the delete-flow assertions from T038.
- [ ] T044 Run the full test suite (unit + e2e + the scripted ingest-flow integration check from T015) and record results.
- [ ] T045 Deliver: `app_build` the updated item (staged `okf-ingest`/`okf-bundle-schema` bundling included), restart the worker (re-declares the changed tool set), and confirm the four `bos-core` changes are merged and deployed (Docker image rebuild required for T009's `ffmpeg` addition).
- [ ] T046 Remove the prior `041-okf-delete-capability/` spec directory entirely (superseded by this consolidated spec — already reflected in this tasks.md's baseline note).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS US2/US3.
- **US2 (Phase 3)**: Depends on Foundational (needs fixed `web_fetch`, T003/T004 findings).
- **US3 (Phase 4)**: Depends on Foundational (T007–T011); largely parallel to US2 but the `okf-ingest` agent (T018, from US2) is where document/image/video wiring (T026–T028) attaches.
- **US7 (Phase 5)**: Independent of US2/US3's runtime behavior, but US2's `agents/okf-ingest/AGENT.md` (T018) and US3's need for the bundling mechanism to exist (T035) mean Phase 5 should land before or alongside Phase 3/4's agent-file tasks are finalized.
- **Baseline verification (Phase 6)**: No blocking dependency — can run anytime, ideally early to confirm the ground truth this whole plan is building on.
- **Polish (Phase 7)**: Depends on all prior phases.

### Parallel Opportunities

- Phase 1: T001–T004 all parallel.
- Phase 2: T007–T010 parallel (different files); T005/T006 sequential (same fix, two call sites); T011/T012 depend on T007–T010.
- Phase 3: T013/T014 parallel; T018/T019 parallel (different files) but both depend on T016/T017.
- Phase 4: T023/T024 parallel; T025 depends on T011.
- Phase 5: T029/T030 parallel; T032 blocks T033/T034.
- Phase 6: T036–T040 all parallel (independent verification tasks).

---

## Implementation Strategy

### MVP First
1. Phase 1 + Phase 2 (bos-core prerequisites).
2. Phase 3 (US2 — URL ingestion redesign). **STOP and VALIDATE**: confirm zero article-length content in transcripts.
3. Phase 6 baseline verification (cheap, de-risks assuming anything is broken that isn't).

### Incremental Delivery
1. Foundational → US2 (MVP of the redesign) → US3 (multi-filetype) → US7 (bundling mechanism, needed for US2/US3's agent to actually install) → baseline verification → polish.

Note the ordering nuance: US7's *mechanism* (copy-install + provenance) must exist before the `okf-ingest` agent from US2 can actually be delivered as an installed, safely-updatable asset — but US2's *design* (the agent's prompt/tool list) can be authored in parallel with US7's plumbing. Sequence Phase 5 (US7) to complete before Phase 7's delivery task (T045), even though Phase 3/4 can start first.

---

## Notes

- [P] tasks = different files, no dependencies.
- Exact paths: item files under `data/user-apps/items/okf-knowledge-base/`; `bos-core` files under `src/`; both are part of the same delivery (T045).
- This tasks.md assumes the 30-tool baseline (including delete) is real and working — verify (Phase 6) rather than re-derive from the old specs' checklists.
- No `041-*` tasks are carried forward as open work — its scope is fully represented in Phase 6/T038 (verification + gap-fill) since the delete tools are already implemented.
