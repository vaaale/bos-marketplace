# Implementation Plan: OKF Knowledge Base & Ingestion Pipeline

**Branch**: `bos/040-okf-knowledge-base` | **Date**: 2026-08-16 | **Spec**: `/Specs/user-specs/040-okf-knowledge-base/spec.md`

**Input**: Feature specification from `spec.md` + design from `design.md`. Consolidates and supersedes the prior `040-okf-knowledge-base` and `041-okf-delete-capability` specs — neither is retained as a separate spec directory.

## Summary

Ship the OKF Knowledge Base as a **marketplace item** (service facet + config-app UI facet, unchanged shape from baseline) plus a **redesigned ingestion pipeline** that requires four small, targeted **`bos-core`** changes:

1. Fix `web_fetch`/`web_search` — clean, complete, link-preserving markdown, no silent truncation.
2. Add `file_to_markdown` (PDF/DOCX/PPTX/XLSX via the sandbox's existing `markitdown`) and `video_keyframes` (ffmpeg) server tools.
3. Extend the marketplace-item install pipeline to copy-install bundled agents/skills with content-hash provenance and a keep-vs-replace update dialog.
4. Add `ffmpeg` to both Docker images; add provider native-video-understanding capability detection.

The ingestion redesign's core move: split **mechanical acquisition** (fetch/convert, deterministic, no LLM) from **semantic decomposition** (deciding concepts, resolving citations, linking the graph — inherently a reasoning task), dispatching the latter to a bundled `okf-ingest` sub-agent via BOS's existing `agent_delegate`/`runInnerLoop` mechanism rather than a flat tool call. Delete capability (bundle + concept, from the former 041) is folded in as baseline, already implemented in the shipped item (30 `okf_*` tools).

## Technical Context

**Language/Version**: JavaScript (Node, ESM) for the item's worker (`services/lib/*.js`); TypeScript for the four `bos-core` changes (`src/`).

**Primary Dependencies**: Item side — none new (plain Node, existing `vfs-bridge`/`http-bridge`). `bos-core` side — no new npm dependencies; `file_to_markdown`/`video_keyframes` shell out to `markitdown`/`ffmpeg`, already-or-soon-to-be present in the sandbox image, via the existing `run_command` tool infrastructure.

**Storage**: Unchanged — spec-conformant OKF Markdown+YAML under `/KnowledgeBase/<bundle>/`. New: `data/agents/okf-ingest/`, `data/skills/okf-bundle-schema/` (copy-installed, not under the item's symlink).

**Testing**: Node unit tests for `okf-core.js` changes (rename + `sourcePath` support); Playwright e2e for the config-app (existing `e2e/040-okf-knowledge-base.spec.ts` needs updates for the renamed tool and new ingest-run UI, plus the delete-flow assertions the former 041 e2e suite never actually landed); a new integration test path for `agent_delegate("okf-ingest", ...)` — likely exercised as a scripted conversation rather than a Playwright e2e, since it's a server-side agent loop, not a UI flow.

**Target Platform**: BrowserOS marketplace item (service + config-app) plus BOS core (`src/`) and both Docker images.

**Project Type**: Mixed — marketplace-item + bos-core.

**Performance Goals**: Deterministic storage/graph primitives unchanged (no vector store). Ingest runs bounded by `maxDepth`/`maxWorkers`, not unbounded crawling.

**Constraints**: 039 loopback-scoped auth; JSON-schema validation before dispatch; tool gating parity; atomic writes + path-traversal guard; unknown frontmatter keys preserved; non-destructive deletes; `raw/` immutable; `configSchema.port` defaults to `0`; the `okf-ingest` sub-agent's tool allowlist stays narrow (NFR-011); `run_command` sandbox never needs `KnowledgeBase/` visible (NFR-013); `ffmpeg` added to both Dockerfiles in lockstep (existing invariant, not a new one this feature introduces).

**Scale/Scope**: Single-user personal KB. Tool surface: 30 existing `okf_*` tools, minus the flat `okf_ingest` behavior (replaced by the dispatcher shape), plus `okf_add_raw_source` (renamed primitive) — net tool count roughly unchanged. Two new non-OKF assistant tools (`file_to_markdown`, `video_keyframes`). One new bundled agent + one new bundled skill. One new install-pipeline step + one new UI dialog (keep-vs-replace).

## Constitution Check

*GATE: Checked against `/Specs/bos-system-specs/.specify/memory/constitution.md`.*

| Principle | Compliance |
|---|---|
| **I. Spec-Driven** | ✅ spec.md is the source of truth; this plan and tasks.md are derivatives. |
| **III. Always Delegate** | ✅ Implementation delegates to the Developer agent for both the item changes and the `src/` changes. |
| **IV. Minimize Blast Radius** | ✅ The `bos-core` surface is enumerated and narrow (§Summary); everything else stays under the item dir or `data/agents|skills/`. |
| **V. VFS Is Not the Source** | ✅ `/KnowledgeBase/` unchanged; `data/agents/`, `data/skills/` are already BOS-owned mutable stores, not source. |
| **VI. Specs & Docs Stay in Sync** | ✅ This consolidation IS the docs-sync step — it replaces two specs that had drifted from what's installed (30 tools vs. documented 29, `okf_ingest`'s real signature vs. `tool-surface.md`'s stale claim). |
| **VII. Respect Boundaries** | ✅ No secrets/package.json/lockfile edits. Dockerfile changes are the one exception this feature deliberately makes (adding `ffmpeg`), called out explicitly rather than snuck in. |

**Complexity Tracking**: One entry, justified in design.md ADR-001 — this feature touches `src/`, unlike its predecessors, because the ingestion redesign genuinely requires core capabilities (fixing a built-in tool, adding built-in tools, changing the install pipeline, changing Docker images) that no marketplace item can provide for itself. No simpler alternative was available: keeping ingestion entirely inside the item would mean `web_fetch` stays broken and document/video conversion stays unavailable to it.

## Project Structure

### Documentation (this feature)

```text
specs/user-specs/040-okf-knowledge-base/
├── spec.md              # this feature's spec (source of truth) — supersedes prior 040 + 041 specs
├── design.md            # architecture: classification, container, component, ingestion pipeline, ADRs
├── plan.md              # this file
├── tasks.md             # created in the tasks step
├── tool-surface.md       # updated tool surface (renamed/added tools, 039 mapping)
├── 040-okf-knowledge-base.html   # baseline UI mockup (still authoritative for existing screens)
└── e2e/
    └── 040-okf-knowledge-base.spec.ts   # existing suite — needs updates (see Testing above)
```

The prior `041-okf-delete-capability/` spec directory is removed — its content (delete capability spec/design/plan/tasks) is fully absorbed into this spec; delete is now baseline (User Story 5), not a scope-add.

### Source Code

```text
# Marketplace item (data/user-apps/items/okf-knowledge-base/) — as-built `services/lib/` layout
services/service.json              # configSchema: + maxDepth, maxWorkers
services/lib/okf-core.js           # rename ingestRaw's tool-facing surface to okf_add_raw_source;
                                    #   add sourcePath support; deleteBundle/deleteConcept unchanged
services/lib/tools.js              # DECLARATIONS: rename + widen the ingest tool's schema; okf_ingest
                                    #   becomes dispatcher-shaped
services/lib/http-bridge.js        # unchanged (DELETE routes already shipped)
services/lib/vfs-bridge.js         # unchanged
agents/okf-ingest/AGENT.md         # NEW — bundled sub-agent definition
skills/okf-bundle-schema/SKILL.md  # NEW — bundled skill (replaces schema.md convention)
app/config-app/index.html          # add maxDepth/maxWorkers settings + ingest-run visibility;
                                    #   delete controls already present

# BOS core (src/) — the four bos-core changes
src/lib/net.ts                                       # fetchText: real markdown conversion, no
                                                      #   silent truncation
src/lib/assistant/tools/server/web-search.ts         # pass through fixed output
src/lib/assistant/tools/server/file-to-markdown.ts   # NEW — file_to_markdown tool
src/lib/assistant/tools/server/video-tools.ts        # NEW — video_keyframes tool
src/lib/agent/web-search.ts                          # + isNativeVideoUnderstandingAvailable()
src/lib/assistant/messages.ts, model-turn.ts          # extend existing image-block support to
                                                      #   native video content where supported
src/system/marketplace/install/symlinkManager.ts     # installItemLink(): + seedItemAgentsAndSkills()
src/lib/agent/subagents/store.ts                      # accept provenance-tagged item-sourced copies
src/lib/agent/skills/store.ts                         #   in addition to seed/*
src/components/.../AgentSkillUpdateDialog.tsx         # NEW — keep-vs-replace dialog (exact location
                                                      #   TBD during implementation — likely alongside
                                                      #   the marketplace install/update UI)

# Docker
Dockerfile, docker/run-command/Dockerfile             # + ffmpeg
```

**Structure Decision**: Standard marketplace-item anatomy for the item itself (unchanged), plus a narrowly-scoped `bos-core` diff for the four prerequisites. Both are delivered together — the item's ingest redesign is not functional without the `bos-core` side (a fixed `web_fetch`, `file_to_markdown`, and the agent/skill bundling mechanism the item's own `agents/`/`skills/` folders depend on).

## Design Notes

### What's unchanged from the original 040/041 (not re-litigated)
- 039 Service Tool Exposure mechanics (declare/validate/gate/lifecycle) — see original mechanism, still exactly as implemented.
- okf-core storage invariants (schema-less, unknown-key preservation, atomic writes, path guard, `raw/` immutability).
- Config-app↔worker bridge (`httpPath`/direct-port fallback across the three deployment scenarios).
- Delete capability mechanics (`okf_delete_bundle`/`okf_delete_concept`, non-destructive default, confirmation-gated UI) — already implemented (30 tools declared today); this consolidation just makes it baseline instead of a documented-but-separately-tracked scope-add.

### What's new (this plan's actual work)
1. **`web_fetch`/`web_search` fix** — replace `src/lib/net.ts`'s regex `stripHtml` + `maxBytes` silent slice with real markdown conversion and either a much larger cap with an explicit truncation marker, or streaming (resolve during implementation per design.md Risk #2).
2. **`file_to_markdown` / `video_keyframes`** — new assistant server tools wrapping `markitdown`/`ffmpeg` via `run_command`, staged through `workspace/` so the sandbox never needs `KnowledgeBase/` visibility (NFR-013).
3. **`okf_add_raw_source`** — rename + widen the existing `ingestRaw` primitive to accept `sourcePath` as an alternative to inline `content`.
4. **`okf_ingest` as dispatcher** — schema gains `maxDepth`/`maxWorkers`; behavior becomes "ensure raw source registered, then this call MUST be followed by `agent_delegate` targeting `okf-ingest`" (exact mechanics — whether `okf_ingest` itself performs the delegate call server-side vs. instructs the calling assistant to — resolved during implementation; design.md's Container diagram assumes the calling assistant issues both calls, since the worker cannot invoke `agent_delegate` itself).
5. **`okf-ingest` bundled agent + `okf-bundle-schema` skill** — new files in the item, installed via the new copy path.
6. **Marketplace agent/skill copy-install + provenance** — `seedItemAgentsAndSkills()`, content-hash comparison, keep-vs-replace dialog.
7. **Native video capability detection + ffmpeg** — mirrors `isNativeWebSearchAvailable()`.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| `src/` changes in a feature otherwise scoped as a marketplace item | Fixing `web_fetch`, adding new assistant tools, changing the install pipeline, and changing Docker images cannot be done from inside a marketplace item (design.md ADR-001) | Keeping ingestion entirely inside the item would leave `web_fetch` broken and document/video conversion permanently unavailable to it — not a viable alternative, not a smaller one |

## Open Decisions (carried from design.md Risks, resolved at tasks/implement)

1. **`maxWorkers` concurrency model** — confirm against `agent-loop.ts` whether parallel `agent_delegate` calls are genuinely concurrent; fall back to a sequential batch-size interpretation if not.
2. **Truncation — resolved, moot.** `web_fetch` routes through Anthropic's native `web_fetch` server tool now, so BOS has no client-side truncation logic left to fix.
3. **Content-hash scope for skills with `scripts/`/`references/`** — hash the whole asset set, not just `SKILL.md`.
4. **`workspace/` staging cleanup** — confirm intermediate files from `file_to_markdown`/`video_keyframes` don't accumulate.
5. **Native video provider coverage** — verify against current provider docs at implementation time.
6. **`agent_delegate` tool-allowlist enforcement** — confirm the sub-agent is actually restricted to its declared `tools`, not the delegating agent's full surface (load-bearing for NFR-011).
7. **Upgrade path for already-installed OKF items** — the schema change to `okf_ingest`, the new `okf_add_raw_source` tool, and first-time agent/skill provenance need to land without requiring a full uninstall/reinstall.
