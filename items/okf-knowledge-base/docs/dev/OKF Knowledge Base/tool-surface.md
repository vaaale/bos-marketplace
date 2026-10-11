# Tool surface — the 21 `okf_*` tools

Declared at startup over worker IPC (`deploymentMode: "tools"`, one `tool_declare` per tool) and registered into BOS's `AssistantTool` registry. Every one appears under the **Knowledge Base** group named in `services/service.json`'s `toolGroups`; a tool resolving to no declared group is rejected at startup, with the reason surfaced in Settings → Services.

Arguments are validated against each `inputSchema` in the 039 bridge **before** dispatch. Errors come back in-band as `tool_error`, never as a crash. Stopping or uninstalling the service removes all 21 immediately.

**Read-only tools are `parallelSafe`.** Every writer is deliberately sequential: two concurrent upserts, merges or deletes against one bundle would race on the same files *and* on the derived-index rebuild each of them triggers.

`GET /tools` on the service's loopback port returns this list as the service actually declares it. The app's titlebar badge and the e2e count assertion both read that route — neither hardcodes a number.

## Retrieval (4)

| Tool | Input | Returns |
|---|---|---|
| `okf_search` *(readOnly)* | `{bundle, query, limit?}` | `{rows: [{docId, docTitle, chId, chTitle, description, matchedConcept, status, stale}], count}` |
| `okf_read_toc` *(readOnly)* | `{bundle, docId}` | `{docId, docTitle, chapters: [{id, title, summary, concepts, status}]}` |
| `okf_read_concept` *(readOnly)* | `{bundle, id}` | `{id, type, frontmatter, body, links, assets, source}` — the **full** body |
| `okf_list_concepts` *(readOnly)* | `{bundle, type?, status?}` | the vocabulary: `[{term, count, covers: [...]}]`, plus document and chapter listings |

`okf_search` is the entry point. Rows are **pointers, not content** — follow with `okf_read_concept` (whole chapter or document) or `okf_read_toc` (a document's chapter list). Retrieval is always whole documents or whole chapters; no tool here returns a snippet.

The match is deterministic and concept-anchored, over term names and the index's one-line descriptions — **not full text**. A paraphrase that misses both returns nothing, and an empty result is a real answer: widen the query, or read the vocabulary with `okf_list_concepts` and route from there.

`okf_read_concept` returns inline-asset blocks with their stored interpretations, so a diagram's knowledge arrives without re-running vision.

## Concepts (3)

| Tool | Input | Notes |
|---|---|---|
| `okf_upsert_concept` | `{bundle, id, title?, body?, frontmatter?}` | Merge-on-fields; unknown keys preserved. Triggers the derived rebuild. |
| `okf_delete_concept` | `{bundle, id, rewrite_backlinks?}` | Non-destructive by default — only that file. |
| `okf_merge_concepts` | `{bundle, from, to}` | Rewrites every chapter's `concepts` referencing `from`, then the index and affected TOCs. |

`okf_upsert_concept` is **also** how every lifecycle / trust / provenance field is set — `status`, `stale_after`, `verified`, `sources`, and anything else the bundle uses. There are no setter tools; the frontmatter merge is the setter.

`id` is `<docId>` for a document stub, `<docId>/<chId>` for a chapter. A chapter must carry `parent`, `concepts` and `summary`, or it is written and unreachable by `okf_search`.

## Bundles (5)

| Tool | Input | Notes |
|---|---|---|
| `okf_list_bundles` *(readOnly)* | `{}` | Per-bundle health: docs, chapters, conceptTerms, stale, deprecated, status. |
| `okf_init_bundle` | `{name, title?, description?}` | Creates the conformant layout. **This exact name** — not `okf_create_bundle`. |
| `okf_import_bundle` | `{bundle, files?, sourcePath?}` | A flat `{path, content}` manifest, or a staged VFS directory. |
| `okf_export_bundle` *(readOnly)* | `{bundle, format?}` | Regenerates derived artifacts first, so the manifest always carries a correct index + every TOC. |
| `okf_delete_bundle` | `{bundle}` | Removes only that bundle's directory. Cannot be undone. |

Git/tarball import: fetch and unpack into the VFS first, then import the directory by path. The worker has no shell.

## Ingest (2)

| Tool | Input | Returns |
|---|---|---|
| `okf_ingest` | `{bundle, source, maxDepth?, maxWorkers?}` | `{jobId, status: "queued"}` — or `{status: "already_ingested", docId}` |
| `okf_add_raw_source` | `{bundle, filename?, content?, sourcePath?, conceptId?, title?, originUrl?, asset?, docId?}` | the `rawFile` path |

### `okf_ingest` is an auto-trigger, not a dispatcher

One call. The service dedups against the provenance ledger, creates the job, launches the bundled `okf-ingest` agent over the loopback delegate endpoint, and **returns immediately**. There is no `acquisition_required` block, no `delegation_required` block, no `agent_delegate` for the caller to issue, and no second `okf_ingest` call against a `raw/` path. The caller's turn is not held open for the run.

Acquisition didn't disappear — it moved into the sub-agent's task, where the service pins every `output_path` itself. That parameter is still the whole mechanism (the source streams to disk and the tool returns a receipt, instead of the model re-emitting the document as output tokens); it just can no longer be forgotten by whoever read the instruction block.

The run's terminal state is written by the **launcher**, from the run's own `endedReason` — see [architecture.md](architecture.md).

### `okf_add_raw_source` is mechanical

Versions a source into `raw/` (append-only, never overwritten), records the ledger entry, optionally stubs a concept. No LLM, no delegation.

**Prefer `sourcePath` over `content`.** With a path, the bytes go from disk into `raw/` and never pass through anyone's context; `content` is for short, already-in-context text only. With `asset: true` + `docId` it registers a downloaded non-HTML inline asset under `raw/assets/<docId>/` and returns the markdown block template for the chapter.

## Jobs (3)

| Tool | Input | Returns |
|---|---|---|
| `okf_list_jobs` *(readOnly)* | `{bundle?, status?, jobId?, limit?}` | `{jobs, count, active}` |
| `okf_cancel_job` | `{jobId}` | `{cancelled: true, status: "cancelled"}` · `{cancelled: false, reason: "already terminal"}` · not-found |
| `okf_delete_job` | `{jobId}` | `{deleted: true}` · **409** if running · **404** if missing |

A job record is `{id, status, bundleId, source, runId, queuedAt, startedAt, endedAt, durationMs, progress, summary, error}`. `status` is one of **queued · running · completed · cancelled · failed**.

`okf_list_jobs` is `readOnly` and parallel-safe. The other two are **writes** — one stops a live run, the other removes a record — and are deliberately sequential.

All three drive the *same* worker job-store operations as the app's `GET /jobs`, `POST /jobs/<id>/cancel` and `DELETE /jobs/<id>` (ADR-003: one capability, two surfaces), so the agent's view and the user's view cannot disagree about a run.

### `okf_list_jobs` is how you follow up

Since `okf_ingest` returns only a job id, this is the only way an agent learns how a run went. It reads the **same** `core.listJobs()` records the app's Jobs tab renders — including `cancelled` runs, and including the `runId` of a run that got as far as starting.

### `okf_cancel_job` stops a run; `cancelled` is not `failed`

A non-terminal job (running, or queued and not yet started) becomes **`cancelled`**: a terminal state distinct from `failed`, with `error: null`. That distinction is the point — a run the user stopped is not a run that went wrong, and recording it as `failed` would make every Jobs list a lie about its own history.

Cancelling is a **stop, not a rollback**. The job record survives, and so does every chapter the run had already written: writes are atomic and the derived index rebuilds from content, so a cancelled run leaves a smaller bundle, never a broken one.

Cancelling a job that has already finished is an explicit **no-op** — `{cancelled: false, reason: "already terminal"}` — not an error. A job id that does not exist is an in-band not-found, consistently with `okf_delete_job`.

### `okf_delete_job` removes a record, never knowledge

It deletes the job's `.jobs/<id>.md` and drops it from the in-memory map. Chapters, the concept index, every document TOC and `raw/` are untouched — a job record is bookkeeping *about* a run, not the knowledge the run produced.

A **running** job is refused with **409** ("cancel it first"), because tearing the record out from under a live run leaves it writing into a bundle with nothing watching it. A missing job id is a clean **404**. Everything else — completed, cancelled, failed, or still queued — deletes.

### Dependency: the platform's per-run abort route

`okf_cancel_job` needs something this service cannot do by itself. The headless run executes in the **main Next.js process**; the job is owned by the **service worker**, a separate thread with no access to the run's `AbortController`. So the worker asks the process that owns the run, over the same loopback channel it already uses for `/api/fs` and the headless-run endpoint:

```
POST /api/subagents/<runId>/abort   →   {aborted: boolean, runId}
```

That route is **platform-owned and generic** — it carries no OKF knowledge (no job store, no bundle, no agent id) and any headless consumer can use it. This item only *consumes* it. `aborted: false` means "no such live run" (already finished, or never started in this process), which makes the call idempotent rather than an error.

The `runId` it needs comes from the run itself: `delegate-bridge` captures it from the **first `run_started` line** of the stream it already holds, and stores it on the job. A cancel that arrives before that line is remembered and fired the instant the id lands, so a queued-window cancel behaves exactly like a running one. See [architecture.md](architecture.md) for the full flow.

**If that route is missing, cancel degrades honestly**: the job is still marked `cancelled` (the worker owns the job), the abort reports `aborted: false`, and the underlying run continues to its natural end. Nothing lies, but nothing stops either — which is why the route is a real dependency and not a nicety.

## Organization (2)

| Tool | Input | Notes |
|---|---|---|
| `okf_add_link` | `{bundle, id, target, label?}` | Written twice: a markdown link in the body, and an entry in `links.json`. |
| `okf_backlinks` *(readOnly)* | `{bundle, id}` | Concepts linking to `id`. |

## Health (2)

| Tool | Input | Detects |
|---|---|---|
| `okf_lint` *(readOnly)* | `{bundle}` | Broken inline-asset links, orphan chapters, concept-index / TOC drift, `links.json` vs. markdown drift, chapters missing `concepts`/`summary`. |
| `okf_stale_report` *(readOnly)* | `{bundle}` | Chapters past `stale_after` or marked deprecated, with days stale. |

Because both index levels are derived, detected drift is **rebuilt**, not hand-patched.

## What this replaced

The pre-redesign surface declared 31. Six were added — `okf_search`, `okf_read_toc`, `okf_merge_concepts`, `okf_list_jobs`, and the job-control pair `okf_cancel_job` / `okf_delete_job` — and sixteen removed by name:

| Removed | Where the capability went |
|---|---|
| `okf_bundle_status` | folded into `okf_list_bundles` health |
| `okf_find_concepts` | `okf_search` |
| `okf_read_index` | the index is a browsable `.md`; `okf_list_concepts` returns the vocabulary |
| `okf_read_bundle_schema` | the `okf-bundle-schema` **skill**; a per-bundle `schema.md` override is just a file to `file_read` |
| `okf_append_log` | `log.md` is internal now |
| `okf_get_as_of` | — |
| `okf_set_status`, `okf_set_trust`, `okf_add_source` | `okf_upsert_concept` frontmatter (merge-on-fields) |
| `okf_attest`, `okf_provenance` | the `sources` / `verified` frontmatter |
| `okf_remove_link`, `okf_list_links`, `okf_neighbors`, `okf_shortest_path`, `okf_export_graph` | retrieval is index-based; the app renders the graph from the derived `/graph` route |

Net: 31 → 21. The field-setter family and the attest/provenance pair are "removed tools, not removed features" — their capability lives on inside `okf_upsert_concept`. None of the sixteen has come back; `GET /tools` is the check, and the e2e suite asserts both halves (21 declared, none of the sixteen among them).

### Why the three job tools exist when the design said no jobs tool

The original ADR rejected a jobs tool as the mechanism for the **sub-agent to report lifecycle** — and that rejection stands; the launcher owns terminal state instead, and no tool here can declare a run finished. What it never addressed was the *other* direction: an agent's need to ask "did that ingest finish?", and then to act on the answer. Once `okf_ingest` returns only a job id, an agent without these can start a run and then neither learn its outcome nor stop it.

`okf_list_jobs` adds no write capability at all. `okf_cancel_job` and `okf_delete_job` write only to the job store — the run's own terminal signal still writes the status, and deleting a record cannot touch knowledge. The capability they add is exactly the capability the app's Jobs tab already has.

## Non-OKF tools the pipeline depends on

Not declared by this item and not owned by it — BOS assistant tools the bundled `okf-ingest` agent's allowlist names:

| Tool | For |
|---|---|
| `web_fetch` / `web_search` | acquiring URL sources, assets, and followed references |
| `file_to_markdown` | PDF/DOCX/PPTX/XLSX → markdown |
| `view_image` | interpreting image assets |
| `video_keyframes` | interpreting video assets |
| `file_read` / `file_list` | reading the raw source from the bundle |

The bundled agent is granted **eight** `okf_*` tools — `okf_ingest`, `okf_add_raw_source`, `okf_list_concepts`, `okf_read_concept`, `okf_read_toc`, `okf_search`, `okf_upsert_concept`, `okf_add_link` — plus exactly those seven, and **nothing else**: no other BOS tool, no unrestricted `run_command`, no `agent_delegate`. Self-sufficient, so an ingest never stops to ask for a capability; narrow, so it can't reach past its job.

Note what that list does *not* include. `okf_ingest` is the run's **only** job-lifecycle tool — it is there so a followed reference can become its own independent nested job. `okf_list_jobs`, `okf_cancel_job` and `okf_delete_job` are **not** granted: the run *is* a job, and listing, cancelling or deleting jobs is a top-level-assistant and app concern. Nor are the destructive and curation tools (`okf_delete_concept`, `okf_delete_bundle`, `okf_merge_concepts`).
