# OKF Knowledge Base — Tool Surface (redesign + auto-ingest scope-add)

Technical reference for the `okf_*` tools declared natively via bos-spec 039 (Service
Tool Exposure) and the non-OKF assistant tools the ingestion pipeline depends on. The
**authoritative table is `design.md` §8.2**; this document mirrors it and documents the
trigger mechanism. Supersedes the prior dispatcher-shaped "31-tool baseline" doc.

## 1. Tool exposure model (039) — unchanged

`deploymentMode: "tools"` on `service.json` opts the service into runtime tool
declaration over worker IPC (one `tool_declare` per tool at startup); `ServiceManager`
registers each into the `AssistantTool` registry. See the original 039 spec for the full
contract (discovery, validation, gating, lifecycle, loopback auth) — none of it changes.

## 1b. Tool group (041)

Every `okf_*` tool appears under the **Knowledge Base** group, declared in
`services/service.json`'s `toolGroups`. An item names the group(s) its tools appear
under; the group's description is what the assistant reads when deciding whether this
family is relevant, and `find_tools(group: "okf-knowledge-base")` returns the whole set
in one call. A tool that resolves to no declared group is rejected at startup, with the
reason surfaced in Settings → Services — there is no fallback group.

## 2. The 19 `okf_*` tools (FR-037)

| Group | Tools |
|---|---|
| Retrieval | `okf_search`, `okf_read_toc`, `okf_read_concept`, `okf_list_concepts` |
| Concepts | `okf_upsert_concept`, `okf_delete_concept`, `okf_merge_concepts` |
| Bundles | `okf_list_bundles`, `okf_init_bundle`, `okf_import_bundle`, `okf_export_bundle`, `okf_delete_bundle` |
| Ingest | `okf_ingest`, `okf_add_raw_source` |
| Jobs | `okf_list_jobs` |
| Organization | `okf_add_link`, `okf_backlinks` |
| Health | `okf_lint`, `okf_stale_report` |

Read-only / parallel-safe (retained `readOnly()`): `okf_search`, `okf_read_toc`,
`okf_read_concept`, `okf_list_concepts`, `okf_list_bundles`, `okf_export_bundle`,
`okf_list_jobs`, `okf_backlinks`, `okf_lint`, `okf_stale_report`. Validation against each
`inputSchema` happens in the 039 bridge before dispatch (FR-038). No other tool is
declared (SC-007).

Signatures (mirroring `design.md` §8.2):

| Tool | Signature | Purpose |
|---|---|---|
| `okf_search` | `{bundle, query, limit?}` | Concept-anchored TOC rows (deterministic, §6.1 of design). |
| `okf_read_toc` | `{bundle, docId}` | A document's stored TOC. |
| `okf_read_concept` | `{bundle, id}` | Full frontmatter + body of a concept (doc/chapter). |
| `okf_list_concepts` | `{bundle, type?, status?}` | The vocabulary with per-term counts. |
| `okf_upsert_concept` | `{bundle, id, title?, body?, frontmatter?}` | Create/update; merge-on-fields; unknown keys preserved. Triggers index/TOC rebuild. |
| `okf_delete_concept` | `{bundle, id, rewrite_backlinks?}` | Delete a concept; non-destructive by default. |
| `okf_merge_concepts` | `{bundle, from, to}` | Canonicalize `from`→`to`; rewrites index, TOCs, chapter `concepts`. |
| `okf_list_bundles` | `{}` | Per-bundle health. |
| `okf_init_bundle` | `{name, title?, description?}` | Create the conformant bundle layout. |
| `okf_import_bundle` | `{bundle, source, type?}` | Import from dir/git/tarball. |
| `okf_export_bundle` | `{bundle, format?}` | Export spec-conformant OKF (incl. index + TOCs). |
| `okf_delete_bundle` | `{bundle}` | Remove only that bundle's directory. |
| `okf_ingest` | `{bundle, source, maxDepth?, maxWorkers?}` | **Auto-trigger** — see §3. |
| `okf_add_raw_source` | `{bundle, filename?, content?, sourcePath?, conceptId?, title?}` | Mechanical raw registration (append-only). |
| `okf_list_jobs` | `{limit?}` | Current ingest runs + lifecycle status (FR-048). |
| `okf_add_link` | `{bundle, id, target, label?}` | Add an explicit "related" edge. |
| `okf_backlinks` | `{bundle, id}` | Concepts linking to `id`. |
| `okf_lint` | `{bundle}` | Broken asset links, orphans, index/TOC/links drift. |
| `okf_stale_report` | `{bundle}` | Concepts past `stale_after`. |

## 3. `okf_ingest` — auto-trigger (was the dispatcher)

**This is the change in the auto-ingest scope-add.** `okf_ingest` no longer returns a
plan for the caller to execute. On a valid source it:

1. Dedups against `raw/sources.json` (a re-ingested source returns the existing
   `docId`, FR-018 — no duplicate run).
2. Mints a job record `{id, status:"queued", bundle, source}` and persists it under
   `bundleRoot/.jobs/`.
3. Fires `POST /api/subagents/delegate` `{task, agent:"okf-ingest"}` over the worker's
   loopback channel (the same channel it already uses for the VFS, via `/api/fs`).
4. Returns `{jobId, status:"queued"}` **immediately** — the caller is freed.

The headless `okf-ingest` run performs the **whole job end-to-end** (FR-047); the
per-source first steps are fixed by the run, not the caller:

| `source` | The run's first steps |
|---|---|
| `https://…/x` (URL) | `web_fetch(url, output_path)` → `okf_add_raw_source(sourcePath)` → decompose |
| `/path/to/x.pdf` (convertible) | `file_to_markdown(path, output_path)` → `okf_add_raw_source(sourcePath)` → decompose |
| `/path/to/x.md` (plain text) | `okf_add_raw_source(sourcePath)` → decompose |
| `raw/x.md` (already in bundle) | decompose directly |

Every acquisition step pins `output_path`, so the source streams to disk and is never
re-emitted as the caller's (or the run's) output tokens (NFR-010).

**Why this is zero new infra (ADR-005).** The worker cannot run an LLM turn or call
`agent_delegate` directly — but it already reaches BOS's HTTP surface over loopback
(`vfs-bridge` → `/api/fs`). `POST /api/subagents/delegate` (`src/app/api/subagents/
delegate/route.ts`) runs a **named** agent via the same `runSubAgent` the scheduler,
workflows, Telegram, and self-heal use, with no conversation; its header comment
explicitly anticipates "a consuming service." `okf-ingest` is a `local` agent, so the
route's feature-branch gate (which applies only to `claude` agents) does not apply.
Loopback transport is the trust boundary — the same model `/api/fs` uses.

**Finalization (ADR-006).** Because the worker issued the delegate request, it reads the
run's own NDJSON terminal signal (`{type:"done"}` / `{type:"error"}`) and owns the job's
terminal state — no assistant safety net, no dependence on the sub-agent remembering to
call back. The worker advances `progress` from the stream's `{type:"tool"}` lines; a
worker-side **stale reaper** (`staleJobMs`, default 30 min) marks any run still
non-terminal as `failed (stale)`, covering a worker killed mid-run. `POST /jobs/<id>`
remains for optional sub-agent progress enrichment.

## 4. Non-OKF assistant tools the pipeline depends on (not 039-declared, not owned by this item)

| Tool | Lives in | Purpose |
|---|---|---|
| `web_fetch` / `web_search` (fixed) | `src/lib/assistant/tools/server/web-search.ts` + `src/lib/net.ts` | Clean markdown, links preserved, no silent truncation. |
| `file_to_markdown` (new) | `src/lib/assistant/tools/server/file-to-markdown.ts` | PDF/DOCX/PPTX/XLSX → markdown via the sandbox's `markitdown`. |
| `video_keyframes` (new) | `src/lib/assistant/tools/server/video-tools.ts` | ffmpeg-based frame sampling for video ingestion. |

These are core BOS assistant tools, available to any agent (not gated behind the OKF
item). The `okf-ingest` bundled agent's own allowlist (design §8.4) names them. The run is
started via the headless delegate surface (§3), **not** via an `agent_delegate` tool the
orchestator issues — so `agent_delegate` is no longer a pipeline dependency.

## 5. Storage layout — unchanged

```
/KnowledgeBase/<bundle>/
├── index.md
├── log.md
├── schema.md            # legacy — superseded by the okf-bundle-schema skill; may be kept
│                         #   for backward compatibility or removed, decided during implementation
├── raw/                 # immutable; text, converted-document markdown, or binary (image/video)
└── concepts/
```

(`.jobs/` and the derived `concept-index.md` / `toc/` / `links.json` are added by the
redesign; see design §5.)

## 6. Bundled agent/skill (installed via copy, not symlink)

```
data/user-apps/items/okf-knowledge-base/
├── agents/
│   └── okf-ingest/AGENT.md          # copy-installed to data/agents/okf-ingest/
└── skills/
    └── okf-bundle-schema/SKILL.md   # copy-installed to data/skills/okf-bundle-schema/
```

The `okf-ingest` agent's allowlist is **self-sufficient** (design §8.4): the full 19-tool
`okf_*` surface + `web_search`, `web_fetch`, `file_to_markdown`, `view_image`,
`video_keyframes` + `file_read`, `file_list`. Nested reference runs are spawned via
`okf_ingest` (each its own job), **not** via `agent_delegate`, which the agent does not
carry.

## 7. Hard invariants — unchanged

1. Schema-less — only `type` required.
2. Unknown keys preserved verbatim (merge-on-fields).
3. Human-readable plain Markdown.
4. No required tooling — git/grep/editor usable.
5. Forward-compatible round-trips.
6. Raw sources immutable (append-only).

## 8. New invariants (redesign + auto-ingest scope-add)

7. **Self-sufficient ingest agent** — the `okf-ingest` allowlist is complete for
   end-to-end ingest but scoped to the KB domain: no non-`okf_*` tools, no unrestricted
   `run_command`, no `agent_delegate`, no top-level assistant surface (FR-039, NFR-009).
8. **No sandbox path widening for mechanical conversion** — `file_to_markdown` /
   `video_keyframes` stage through `workspace/`; the OKF service's own write path moves
   results into `raw/`.
9. **Bounded reference crawl** — `maxDepth`/`maxWorkers` always enforced, with dedup
   against a bundle's existing provenance before any reference is re-ingested.
10. **Caller-freed trigger** — `okf_ingest` returns `{jobId}` without the caller running
    acquisition or delegation steps; the run proceeds headlessly (FR-046).
11. **Launcher owns finalization** — the job's terminal state is written by the worker
    from the run's own terminal signal, with a stale reaper as the last line of defense
    (FR-049, ADR-006).
