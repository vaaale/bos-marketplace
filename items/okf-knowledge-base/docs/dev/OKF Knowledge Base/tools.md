# Tool surface — the 18 `okf_*` tools

Declared under the **Knowledge Base** tool group via the 039 Service Tool Exposure contract. Every tool is validated against its `inputSchema` before dispatch and respects the standard tool-gating model. Read-only tools are `parallelSafe`; every writer is sequential, because two concurrent writes to one bundle would race on the same files *and* on the derived-index rebuild each triggers.

**This list is exhaustive.** The service declares these 18 and nothing else.

## Retrieval

### `okf_search` — *readOnly*
`{bundle, query, limit?}` → `{bundle, query, rows[], count, note}`

Each row: `{docId, docTitle, chId, chTitle, description, matchedConcept, status, stale}`.

Concept-anchored, deterministic search over the bundle's concept index. Matches query tokens against concept-term **names** and the index's one-line **descriptions** — not full text. Rows are TOC pointers, not content; follow with `okf_read_concept` or `okf_read_toc`. Identical input returns byte-identical rows. Empty is a valid result: no row is ever invented.

### `okf_read_toc` — *readOnly*
`{bundle, docId}` → `{docId, docTitle, chapters: [{id, title, summary, concepts, status}], indexGeneratedAt, artifact}`

A document's stored table of contents — the level-2 drill-down. `artifact` names the `.md` file it came from.

### `okf_read_concept` — *readOnly*
`{bundle, id}` → `{id, type, frontmatter, body, links, assets, source}`

One concept **in full** — a document stub (`<docId>`) or a chapter (`<docId>/<chId>`). `body` is the complete markdown, never truncated. `assets` lists each stored inline-asset block with its path, kind, and the **interpretation written at ingest**, so the caller gets a diagram's knowledge without re-running vision. `source` is the provenance target: the original URL if there is one, else the stored `raw/` path.

### `okf_list_concepts` — *readOnly*
`{bundle, type?, status?}` → `{terms, documents, chapters, indexGeneratedAt, needsRegeneration}`

The concept **vocabulary** — each term with its chapter count and the (document, chapter) pairs it covers — plus the document and chapter listings. Use it to route semantically when `okf_search` comes back empty, and before coining a new term so the vocabulary grows by extension rather than duplication.

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
`{bundle, source, maxDepth?, maxWorkers?}` → one of:

| `status` | Payload | Meaning |
|---|---|---|
| `queued` | `jobId`, `maxDepth`, `maxWorkers`, `job` | A job was recorded and the bundled `okf-ingest` agent launched; follow it with `okf_list_jobs`. |
| `already_ingested` | `docId`, `rawFile`, `ingestedAt` | Deduplicated against `raw/sources.json`; no run started. |
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
| `okf_find_concepts` | → `okf_search` (concept-anchored, explainable) |
| `okf_read_index` | the index is a `.md` artifact; the app renders it, `okf_list_concepts` returns it |
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
