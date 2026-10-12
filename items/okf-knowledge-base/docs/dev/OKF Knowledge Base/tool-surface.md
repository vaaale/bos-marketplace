# Tool surface — the 21 `okf_*` tools

Declared at startup over worker IPC (`deploymentMode: "tools"`, one `tool_declare` per tool) and registered into BOS's `AssistantTool` registry. Every one appears under the **Knowledge Base** group named in `services/service.json`'s `toolGroups`; a tool resolving to no declared group is rejected at startup, with the reason surfaced in Settings → Services.

Arguments are validated against each `inputSchema` in the 039 bridge **before** dispatch. Errors come back in-band as `tool_error`, never as a crash. Stopping or uninstalling the service removes all 21 immediately.

**Read-only tools are `parallelSafe`.** Every writer is deliberately sequential: two concurrent upserts, merges or deletes against one bundle would race on the same files *and* on the derived-index rebuild each of them triggers.

`GET /tools` on the service's loopback port returns this list as the service actually declares it. The app's titlebar badge and the e2e count assertion both read that route — neither hardcodes a number.

## Retrieval (4)

| Tool | Input | Returns |
|---|---|---|
| `okf_search` *(readOnly)* | `{bundle, query, limit?}` | `{rows: [{docId, docTitle, chId, chTitle, description, matchedConcept, kind, status, stale}], count}` |
| `okf_read_toc` *(readOnly)* | `{bundle, docId}` | `{docId, docTitle, chapters: [{id, title, summary, concepts, status}]}` |
| `okf_read_concept` *(readOnly)* | `{bundle, id}` | `{id, type, frontmatter, body, links, assets, source}` — the **full** body |
| `okf_list_concepts` *(readOnly)* | `{bundle, type?, status?, kind?}` | the vocabulary: `[{term, kind, count, covers: [...]}]`, plus document and chapter listings |

`okf_search` is the entry point. Rows are **pointers, not content** — follow with `okf_read_concept` (whole chapter or document) or `okf_read_toc` (a document's chapter list). Retrieval is always whole documents or whole chapters; no tool here returns a snippet.

The match is deterministic and concept-anchored, over term names and the index's one-line descriptions — **not full text**. A paraphrase that misses both returns nothing, and an empty result is a real answer: widen the query, or read the vocabulary with `okf_list_concepts` and route from there.

### The additive `kind` (ADR-011)

Every term the index holds carries a `kind` — `topic`, or `person` for a salient person the bundle registered at ingest (the author, a named key figure).

- **`okf_search`** rows carry that `kind`, so a caller can tell a person hit from a topic hit. The matching **algorithm is unchanged**: a person's name is an ordinary term-name hit, there is no second search path, and a caller that ignores the field sees exactly what it saw before.
- **`okf_list_concepts`** returns `kind` on every term and accepts an optional **`kind` filter** (`topic` | `person` | `all`, default `all`) — `{bundle, kind: "person"}` lists just the people the bundle knows about.

Both changes are **additive and backward compatible**, and the surface count is **unchanged** — person extraction rides on the already-declared tools, and there is no `okf_*` tool specific to persons.

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

## Jobs (3)

| Tool | Input | Returns |
|---|---|---|
| `okf_list_jobs` *(readOnly)* | `{bundle?, status?, jobId?, limit?}` | `{jobs, count, active}` |
| `okf_cancel_job` | `{bundle?, jobId}` | the job, now `cancelled` (`error: null`) — 404 unknown, 409 already terminal |
| `okf_delete_job` | `{jobId}` | `{deleted: true, jobId}` — 404 unknown, 409 still queued/running |

### `okf_ingest` is an auto-trigger, not a dispatcher

One call. The service dedups against the provenance ledger, creates the job, launches the bundled `okf-ingest` agent over the loopback delegate endpoint, and **returns immediately**. There is no `acquisition_required` block, no `delegation_required` block, no `agent_delegate` for the caller to issue, and no second `okf_ingest` call against a `raw/` path. The caller's turn is not held open for the run.

Acquisition didn't disappear — it moved into the sub-agent's task, where the service pins every `output_path` itself. That parameter is still the whole mechanism (the source streams to disk and the tool returns a receipt, instead of the model re-emitting the document as output tokens); it just can no longer be forgotten by whoever read the instruction block.

The run's terminal state is written by the **launcher**, from the run's own `endedReason` — see [architecture.md](architecture.md).

### `okf_add_raw_source` is mechanical

Versions a source into `raw/` (append-only, never overwritten), records the ledger entry, optionally stubs a concept. No LLM, no delegation.

**Prefer `sourcePath` over `content`.** With a path, the bytes go from disk into `raw/` and never pass through anyone's context; `content` is for short, already-in-context text only. With `asset: true` + `docId` it registers a downloaded non-HTML inline asset under `raw/assets/<docId>/` and returns the markdown block template for the chapter.

### `okf_list_jobs` is how you follow up

Since `okf_ingest` returns only a job id, this is the only way an agent learns how a run went. It reads the **same** `core.listJobs()` records the app's Jobs tab renders, so the agent's view and the user's view cannot disagree.

### `okf_cancel_job` / `okf_delete_job` are the agent's half of job control

The app's Jobs tab has a **Cancel** and a **Delete** button; these are the same two capabilities for an agent, running the same `core.cancelJob` / `core.deleteJob` the REST routes (`POST /jobs/<id>/cancel`, `DELETE /jobs/<id>`) run — one capability, two surfaces.

- **Cancel** aborts the underlying headless run through the platform's generic `POST /api/subagents/<runId>/abort` route (the item consumes it; it is not OKF-specific) and moves the job to the distinct **`cancelled`** terminal state. Cancelling is not a failure: `error` stays `null`. If the run has not yet reported its `runId`, the intent is recorded and the launcher fires the abort the moment `run_started` arrives.
- **Delete** removes the **run record only** — never chapters, the index, TOCs or `raw/`. A still-active job is refused (409); cancel it first.

Neither is `parallelSafe`: both mutate the job store. The bundled `okf-ingest` sub-agent gets neither — it does the work, it does not manage the job it is running.

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

The pre-redesign surface declared 31. Six were added — `okf_search`, `okf_read_toc`, `okf_merge_concepts`, `okf_list_jobs`, `okf_cancel_job`, `okf_delete_job` — and sixteen removed by name:

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

Net: 31 → 21. The field-setter family and the attest/provenance pair are "removed tools, not removed features" — their capability lives on inside `okf_upsert_concept`.

### Why `okf_list_jobs` exists when the design said no jobs tool

The original ADR rejected a jobs tool as the mechanism for the **sub-agent to report lifecycle** — and that rejection stands; the launcher owns terminal state instead. What it never addressed was the agent's need to *ask* "did that ingest finish?". Once `okf_ingest` returns only a job id, an agent without this tool can start a run and then has no way to learn its outcome. It is a reader of existing records, adds no write capability, and is `parallelSafe`.

## Non-OKF tools the pipeline depends on

Not declared by this item and not owned by it — BOS assistant tools the bundled `okf-ingest` agent's allowlist names:

| Tool | For |
|---|---|
| `web_fetch` / `web_search` | acquiring URL sources, assets, and followed references |
| `file_to_markdown` | PDF/DOCX/PPTX/XLSX → markdown |
| `view_image` | interpreting image assets |
| `video_keyframes` | interpreting video assets |
| `file_read` / `file_list` | reading the raw source from the bundle |

The agent is granted 19 of the 21 `okf_*` tools (every one except `okf_cancel_job` / `okf_delete_job`) plus exactly those seven, and **nothing else** — no other BOS tool, no unrestricted `run_command`, no `agent_delegate`. Self-sufficient, so an ingest never stops to ask for a capability; narrow, so it can't reach past its job.
