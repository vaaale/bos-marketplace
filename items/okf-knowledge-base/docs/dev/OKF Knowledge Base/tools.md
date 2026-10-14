# Tool surface — the 18 `okf_*` tools

Declared under the **Knowledge Base** tool group via the 039 Service Tool Exposure contract. Every tool is validated against its `inputSchema` before dispatch and respects the standard tool-gating model. Read-only tools are `parallelSafe`; every writer is sequential, because two concurrent writes to one bundle would race on the same files *and* on the derived-index rebuild each triggers.

**This list is exhaustive.** The service declares these 18 and nothing else.

## Retrieval

### `okf_search` — *readOnly*
`{bundle, query, limit?, groupBy?}` → `{bundle, query, rows[], count, total, searched, clamped?, maxLimit?, note}` — or, with `groupBy: "document"`, `groups: [{docId, docTitle, total, hits[]}]` instead of `rows`.

Each row: `{docId, docTitle, chId, chTitle, description, matchedConcept, kind, status, stale, matchKind, matchedWords, excerpt?}` — a document-level hit has `chId: ""`.

Search over concept and person **terms**, chapter **titles**, **summaries** and the **full text** of every chapter and document stub (inline-asset interpretations included) — a linear scan over the bundle's in-memory model (design.md ADR-015). Matching folds case and accents ("Cordoba" finds "Córdoba") and matches at the start of a word (`api` does not match "rapid"). **Any** query word may match; rows matching more words rank first, then by tier (term > title > summary > full text), a BM25-style score, the document's first-added date and id — identical input, byte-identical output. `matchKind` says what matched; `matchedConcept` is the matched term, or — on a non-term match — the chapter's own term, as a description match always was. A full-text match carries an `excerpt`: the sentence with the match plus at most one either side, ≤ 400 characters, cut from the original text. `limit` defaults to 10 (max 50; a larger request is clamped and says so); with `groupBy`, it counts documents, each with at most 5 hits. Hits are pointers, not content — follow with `okf_read_concept` or `okf_read_toc`. An empty result names what was searched; no row is ever invented.

### `okf_read_toc` — *readOnly*
Two levels:

- `{bundle, offset?, limit?}` → `{bundle, total, offset, limit, clamped?, maxLimit?, documents: [{id, title, chapters, summary, addedAt, attention}]}` — the **bundle's table of contents**: every document, newest first by when it was first added (the ledger's `firstIngestedAt`, so a re-ingest does not move it), 50 per page (max 200). No vocabulary. `index.md` lists the documents in the same order from the same function.
- `{bundle, docId}` → `{docId, docTitle, chapters: [{id, title, summary, concepts, status}], indexGeneratedAt, artifact}` — a document's stored table of contents. `artifact` names the `.md` file it came from.

### `okf_read_concept` — *readOnly*
`{bundle, id}` → `{id, type, frontmatter, body, links, assets, source}`

One concept **in full** — a document stub (`<docId>`) or a chapter (`<docId>/<chId>`). `body` is the complete markdown, never truncated. `assets` lists each stored inline-asset block with its path, kind, and the **interpretation written at ingest**, so the caller gets a diagram's knowledge without re-running vision. `source` is the provenance target: the original URL if there is one, else the stored `raw/` path.

### `okf_list_concepts` — *readOnly*
`{bundle, query?, kind?, status?, offset?, limit?}` → `{terms: [{term, kind, count, covers: [≤ 5], coversTotal}], total, offset, limit, clamped?, indexGeneratedAt, needsRegeneration}`

The concept **vocabulary**, filtered by `query` (a case- and accent-insensitive substring of the term name) and paged — 100 per page, max 500 — because a large bundle has thousands of terms. Each term carries its kind, its count and up to 5 of the chapters it covers. Its job is reuse: query for a term before coining a new one. Documents and chapters are `okf_read_toc`'s — `type` answers with a pointer there rather than a list.

## Concepts

### `okf_upsert_concept`
`{bundle, id, title?, body?, frontmatter?, sourceRange?, interpretations?}` → the merged concept (same shape as `okf_read_concept`, plus `extraction` when a `sourceRange` was used)

Create or update a document stub or a chapter. Frontmatter is **merged on fields** and unknown keys are preserved verbatim. `sources` and `attestations` merge by identity rather than being replaced, so history isn't silently dropped.

This is also the **only** way to set lifecycle, trust and provenance — `status`, `stale_after`, `verified`, `sources`, `attestations` are ordinary frontmatter here. The six former field-setter tools were folded into this call.

A chapter needs `parent`, `concepts` and `summary`: the two derived index levels are built from exactly those three fields, so a chapter missing them is stored but unreachable by `okf_search`. Both derived artifacts rebuild after every write.

**The body-extraction write path (FR-060, ADR-014).** A chapter that came from an ingested source is written WITHOUT a body: the agent passes `sourceRange` and the service slices the body out of `raw/<source>.md` using the heading map `okf_add_raw_source` wrote at chunk time (`.chunks/<docId>/headings.json`). The source document is resolved from the concept id's `<docId>` — there is no source id to pass.

| field | shape | means |
| --- | --- | --- |
| `sourceRange` | `{startHeading: n}` | heading `n` to just before the next heading of the same or a higher level (the default end rule) |
| | `{startHeading: n, toHeading: m}` | heading `n` up to (not including) heading `m` — merging sections into one chapter |
| | `{whole: true}` | the entire source — the no-heading case |
| | `{startHeading: -1}` | the preamble before the first heading |
| `interpretations` | `[{assetLine, interpretation}]` | one per inline asset; `assetLine` is the asset's markdown line verbatim from the source |

`n`/`m` are **global** heading indices, taken from the `headings:` frontmatter list of the chunk the agent read. Precedence: `sourceRange` present → the body is extracted (any `body` passed alongside is ignored); otherwise `body` is used as-is, exactly as before. A range that cannot be resolved — or a heading map that disagrees with `raw/`'s byte length or heading count — **throws**; it never mis-slices silently, and `okf_lint`'s `headingMapDrift` check reports the same drift up front.

**The invariant (SC-019):** the stored body, with the inserted interpretation lines removed, is byte-for-byte a contiguous slice of `raw/<source>.md`. The service's insertions are additive and removable: the source's own asset line is left untouched, and the link to the stored local copy is added beneath it carrying an `<!-- interpretation-asset -->` mark (`core.stripInterpretations` is the exact inverse, exported for that check).

### `okf_delete_concept`
`{bundle, id, rewrite_backlinks?}` → `{id, deleted, rewroteBacklinks, backlinksRewritten}`

Non-destructive by default: only that file is removed, and backlinking chapters are left exactly as they were. With `rewrite_backlinks`, every linker is rewritten to drop the reference and the `links.json` sidecar is pruned. Derived artifacts rebuild either way.

### `okf_merge_concepts`
`{bundle, from, to}` → `{from, to, chaptersRewritten, tocsRebuilt, canonicalTerm, fromTermRemaining}`

Merge one concept term into a canonical one. A term isn't a file — it's a key derived from chapter frontmatter — so this rewrites every chapter's `concepts` array that referenced `from`; the index and the affected TOCs follow from the rebuild, leaving one canonical entry routing to the union of chapters.

## Bundles

### `okf_list_bundles` — *readOnly*
`{}` → `[{name, docs, chapters, conceptTerms, stale, deprecated, status, indexGeneratedAt, indexNeedsRegeneration, checkedAt}]`

### `okf_init_bundle`
`{name, title?, description?}` → bundle health

Creates the conformant layout: `index.md`, `log.md`, `concept-index.md`, `toc/`, `links.json`, `raw/`, `raw/assets/`, `raw/sources.json`, `concepts/`. No `schema.md` — conventions live in the `okf-bundle-schema` skill.

### `okf_import_bundle`
`{bundle, files?, sourcePath?}` → bundle health + `{imported, indexNeedsRegeneration, note}`

Import from a flat `{path, content}` manifest (what `okf_export_bundle` produces) **or** from a VFS directory already staged. The derived index is rebuilt best-effort afterwards and `note` reports honestly whether routing is complete — a bundle whose chapters lack the index frontmatter imports fully but routes partially, and says so. Git/tarball: the caller fetches and unpacks into the VFS first, then imports by path (the worker has no shell).

### `okf_export_bundle` — *readOnly*
`{bundle, format?}` → `{name, files, assets, conceptIndexIncluded, tocsIncluded}`

Regenerates the derived artifacts first, so the manifest always carries a correct `concept-index.md` and every `toc/<docId>.md` — re-importing reproduces a fully queryable bundle. Binary inline assets are listed by path, size and content type rather than inlined. Job records are excluded (operational state, not OKF content).

### `okf_delete_bundle`
`{bundle}` → `{name, deleted}` — removes only that bundle's directory.

## Ingest

### `okf_ingest`
`{bundle, source, maxDepth?, maxWorkers?, reingest?}` → one of:

| `status` | Payload | Meaning |
|---|---|---|
| `queued` | `jobId`, `maxDepth`, `maxWorkers`, `reingestOf?`, `job` | A job was queued; the run queue starts the bundled `okf-ingest` agent when a slot is free (at most `maxConcurrentRuns` at once). Follow it with `okf_list_jobs`. |
| `already_ingested` | `docId`, `rawFile`, `ingestedAt` | Deduplicated against `raw/sources.json`; no run started. Pass `reingest: true` to replace that document. |
| `over_depth` | `parentJobId` | Called from a run with no reference hops left; no run started. |

**Nested ingests are bounded by the run that calls.** BOS passes the calling run
with every tool call (`tool_call.payload.caller.runId`) and each job records its
run's `runId`, so a call from inside one of this service's own ingest runs is
recognised as a reference being followed. Its job gets `parentJobId` and
`maxDepth = parent.maxDepth - 1` — a `maxDepth` argument can lower that, never
raise it — and `maxWorkers` at most the parent's. At zero the call returns
`over_depth`. The bound deliberately does not depend on anything the model
passes: before it, every child restarted at the default depth, and one PDF
became seven concurrent runs.

#### Acquiring a page a plain fetch is refused (FR-067)

Step 0 of a web-page ingest is `web_fetch({url, output_path})` → `okf_add_raw_source({sourcePath})`. Some sites refuse every plain fetch — Medium sits behind Cloudflare, whose bot check answers `web_fetch` with a 403 — while a real browser gets the page, with the user's login if Settings → Browser Automation has a storage state. For that case `buildIngestTask` (`browserFallback`) writes the browser route into the same Step 0: `browser_navigate({url})`, `browser_save_page({output_path})` to the **same** staged path, `browser_close({})`, then step 2 unchanged. `browser_save_page` is a BOS tool: it writes the page open in the agent's session to the VFS as markdown and returns only a receipt, exactly like `web_fetch`'s `output_path`. A binary download (a PDF URL) gets no browser route.

Before this (prod, job run-1022) the agent reached the article with `browser_navigate` and then had no way to put it in a file; it tried reader proxies, which returned the paywall preview.

### `okf_add_raw_source`
`{bundle, filename?, content?, sourcePath?, conceptId?, title?, originUrl?, asset?, docId?}`

Two modes:

- **Document** (default) → `{rawFile, bytes, stored, docId, provenance, concept, note}`. Pass `sourcePath` rather than `content` for anything large — the bytes go disk-to-disk and never cross the model's context. `raw/` is append-only: a repeated name versions to `<base>.v2.<ext>`, never overwrites.
- **Inline asset** (`asset: true`, with `docId`) → `{assetPath, stored, kind, contentType, provenance, blockTemplate, note}`. Registers a downloaded non-HTML asset under `raw/assets/<docId>/` and returns the markdown block template to write into the owning chapter after interpreting it.

Both record a `raw/sources.json` provenance entry, which is what `okf_ingest` dedups against and what the app's "Open source" link resolves through.

**The returned `docId` is the document's one id.** `docIdForSource` derives it from the source's real origin — `originUrl` first, the source path only as a fallback — with the pipeline's internal `okf-staged-` prefix and the file extension stripped, slugified: `…/main/tech_report.pdf` → `tech-report`, never `okf-staged-tech_report`. It is pure and deterministic, so a re-ingest of the same source reconciles onto the same document; nothing agent-authored (a `title`, say) feeds it. The same id keys `.chunks/<docId>/`, the ledger entry, and — because the agent is told to use the returned value verbatim (task text + `AGENT.md` §1b) — `concepts/<docId>.md`, every chapter's `parent`, and `toc/<docId>.md`. An id invented downstream instead of taken from here is what leaves a document's TOC empty.

## Organization

### `okf_add_link`
`{bundle, id, target, label?}` → the updated concept

Writes the edge twice, deliberately: a markdown link in the body (portable — it survives a git clone with no tooling) and an entry in `links.json` (so graph derivation needn't re-parse every body). `okf_lint` reconciles the two.

### `okf_backlinks` — *readOnly*
`{bundle, id}` → `{id, backlinks[]}` — concepts linking to `id`, from bodies and the sidecar.

## Health

### `okf_lint` — *readOnly*
`{bundle}` → `{bundle, documents, chapters, conceptTerms, checks, rebuilt, indexNeedsRegeneration, errors, warnings, checkedAt}`

`checks`: `conceptIndexDrift`, `documentTocDrift`, `brokenInlineAssets`, `orphanChapters`, `linksDrift`.

Detects exactly the failure modes the derived model can have, plus chapters missing `concepts`/`summary` (stored but unreachable). **Detected index/TOC drift is rebuilt, not patched** — patching a derived artifact is how you get a second source of truth. `rebuilt` tells you whether this run did so.

### `okf_stale_report` — *readOnly*
`{bundle}` → `[{id, docId, title, docTitle, status, reason, staleAfter, daysStale}]`

Chapters past `stale_after` or marked deprecated.

---

## What was removed, and where the capability went

The pre-redesign surface declared 31. **3 added**, **16 removed by name**, net **−13**.

| Removed | Where it went |
|---|---|
| `okf_bundle_status` | folded into `okf_list_bundles` health |
| `okf_find_concepts` | → `okf_search` (now terms, titles, summaries and full text) |
| `okf_read_index` | the index is a `.md` artifact; the app renders it, `okf_list_concepts` pages through it, `okf_read_toc({bundle})` lists the documents |
| `okf_read_bundle_schema` | → the `okf-bundle-schema` skill; a per-bundle `schema.md` is just a file |
| `okf_append_log` | the log is internal operational history |
| `okf_get_as_of` | point-in-time reads dropped; `raw/` versioning is the durable record |
| `okf_set_status`, `okf_set_trust`, `okf_add_source`, `okf_attest`, `okf_provenance` | **folded into `okf_upsert_concept`** frontmatter (merge-on-fields). The capability is intact; the five tools are not. |
| `okf_remove_link`, `okf_list_links` | links are visible in `okf_read_concept`; removal is an `okf_upsert_concept` body edit |
| `okf_neighbors`, `okf_shortest_path`, `okf_export_graph` | retrieval is index-based, not path-based. The app renders the graph from the service's `/graph` route and traces neighbours client-side. |

## The app's REST surface — and why it adds no tools

The app is a sandboxed iframe, not an agent: it cannot call the `okf_*` tools, which are IPC-dispatched and schema-gated. It gets its own HTTP data layer on the service's loopback port, reusing the *same* `okf-core` functions the tools call. These routes are internal plumbing — **not `tool_declare`d** — so the 18-tool agent surface is untouched (FR-036 / SC-007).

| Route | Reuses | Notes |
|---|---|---|
| `GET /config` | runtime | base-URL bootstrap |
| `GET /tools` | `DECLARATIONS` | the declared surface, so the titlebar badge states the real count rather than a hardcoded one |
| `GET /bundles` · `POST /bundles` · `DELETE /bundles/<b>` | `listBundles` / `initBundle` / `deleteBundle` | the list and its management actions |
| `GET /bundles/<b>` | `bundleDetail` | health + documents + concept index |
| `GET /bundles/<b>/toc/<docId>` | `readToc` | the stored TOC artifact |
| `GET /bundles/<b>/concept/<id…>` | `readConcept` | the FULL concept; ids contain `/` so the id is the rest of the path |
| `GET`/`POST /bundles/<b>/search` | **`core.search`** | byte-identical to `okf_search`'s rows |
| `GET /bundles/<b>/graph` | `graph` | derived on read |
| `GET /bundles/<b>/assets/<path…>` | `readAsset` | real bytes + content type, so an opaque-origin iframe can render a stored figure |
| `GET /bundles/<b>/lint` · `/stale` | `lintBundle` / `staleReport` | the Health tab |
| `GET /bundles/<b>/export` · `POST /bundles/<b>/import` | `exportBundle` / `importBundle` | the Import·Export tab |
| `POST /bundles/<b>/merge` | **`core.mergeConcepts`** | vocabulary curation from the Concept Index. US6 names the *user* as a merge actor and this is the only user surface; same core function as the tool. |
| `POST /bundles/<b>/ingest` | **`planIngest`** | the Ingest modal. Runs the *same dispatcher* `okf_ingest` runs: records the queued job, returns the delegation. It cannot perform the delegation (no agent loop) and does not pretend to. |
| `GET /jobs` · `GET /jobs/<id>` | job store | the Jobs tab |
| `POST /jobs/<id>/{start,progress,complete,fail}` | job store | the sub-agent's lifecycle callbacks **and** the assistant's safety net |

Knowledge *authoring* stays agent-driven throughout — the app never writes a chapter. What it can do is bundle lifecycle (create/import/export/delete), vocabulary curation (merge), and queueing a run.

### Re-ingest and the run queue (FR-063 / FR-064)

`reingest: true` re-ingests a source the ledger already holds: the job records `reingestDocId`, its source is the document's recorded **origin** (re-acquired, so the run gets fresh chunks and a fresh heading map), and the run rewrites the document under the same id. **Nothing is removed before the run completes** (ADR-024): every `okf_upsert_concept` carries the calling run's id (`caller`), recorded per job by `noteRunWrite`; when the run completes, `replaceDocumentOnSuccess` removes the document's chapters it did not write and logs `document_replace`, and the job summary carries `replaced: {docId, removed}`. A run that wrote nothing for the document removes nothing (`replaced.note` says so); a failed or cancelled run removes nothing. The chunk cache needs no clearing — `writeChunks` replaces it when the new source is registered. `raw/` is never touched.

Dedup (FR-018) holds only while the document exists: `triggerIngest` checks `documentExists` and ingests a source whose document is gone as a new one. A nested caller (FR-061) cannot re-ingest.

Every run goes through `pumpQueue`: queued jobs start oldest-first while fewer than `maxConcurrentRuns` runs launched by this process are live; each finished run pumps again, and so does service startup (after the reaper's sweep, which only reaps `running` jobs). A run whose source is a `raw/` path gets its chunks and heading map from `prepareRawSource` before the agent starts — the task lists the chunk paths instead of telling the agent to read the source whole.

Bundle-wide and per-document re-ingest are REST-only (`POST /bundles/<b>/reingest`, `POST /bundles/<b>/documents/<docId>/reingest`), resolved from the ledger by `reingestDocument`; no tool is added.

