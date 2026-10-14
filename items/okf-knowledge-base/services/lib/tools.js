// tools.js — the okf_* tool surface exposed to the BOS assistant (039
// Service Tool Exposure contract) plus their handlers. Each handler is
// `(args, ctx) => Promise<any>` where ctx.core is the bound okf-core module,
// ctx.bundleRoot is the configured storage root, ctx.vfs is the VFS bridge,
// ctx.ingestDefaults carries maxDepth/maxWorkers and ctx.getRuntime resolves
// the service's own loopback base URL (for the job-callback URLs okf_ingest
// hands the sub-agent). Handlers validate shape and delegate to okf-core,
// which owns all storage semantics.
//
// ── EXACTLY 21 TOOLS (spec FR-037 / SC-007, design.md §8.2 + the auto-trigger
//    rework's okf_list_jobs + the job-control scope-add) ────────────────
//
// The pre-redesign surface declared 31. This declares 21 and nothing else:
//
//   Retrieval      okf_search · okf_read_toc · okf_read_concept · okf_list_concepts
//                  (search: terms, titles, summaries and full text; read_toc:
//                  the bundle's documents, or one document's chapters)
//   Concepts       okf_upsert_concept · okf_delete_concept · okf_merge_concepts
//   Bundles        okf_list_bundles · okf_init_bundle · okf_import_bundle
//                  okf_export_bundle · okf_delete_bundle
//   Ingest         okf_ingest · okf_add_raw_source
//   Jobs           okf_list_jobs · okf_cancel_job · okf_delete_job
//   Organization   okf_add_link · okf_backlinks
//   Health         okf_lint · okf_stale_report
//
// ADDED (6): okf_search, okf_read_toc, okf_merge_concepts, okf_list_jobs,
// okf_cancel_job, okf_delete_job.
//
// okf_cancel_job and okf_delete_job are the 20th and 21st (FR-050/FR-051).
// They are the agent's half of job CONTROL: the app's Jobs tab has a Cancel
// and a Delete button, and an agent that started a run with okf_ingest must
// be able to stop it and clear it without telling the user to go click
// something. Both run the same core.cancelJob/core.deleteJob the REST routes
// run — one capability, two surfaces (ADR-003). Neither is parallelSafe:
// they mutate the job store.
//
// okf_list_jobs is the 19th. Design.md's ADR-006 explicitly rejected a jobs
// tool — but it rejected it as a way for the SUB-AGENT to report lifecycle,
// which the launcher now owns instead. What that ADR never gave the agent was
// a way to ANSWER "did that ingest finish?". Since okf_ingest returns a jobId
// and nothing else, without this tool the only observer of a run would be the
// app, and an agent that started an ingest would have no way to learn how it
// went. It reads the same core.listJobs() records the Jobs tab renders — one
// capability, two surfaces, like okf_search.
//
// REMOVED (16 by name, 12 net): okf_bundle_status (folded into
// okf_list_bundles health), okf_find_concepts (-> okf_search),
// okf_read_index, okf_read_bundle_schema (-> the okf-bundle-schema SKILL,
// ADR-007), okf_append_log (the log is internal now), okf_get_as_of,
// okf_set_status, okf_set_trust, okf_add_source, okf_attest, okf_provenance
// (all the field-setters FOLDED into okf_upsert_concept's merge-on-fields
// frontmatter — the capability stays, the tools go), okf_remove_link,
// okf_list_links, okf_neighbors, okf_shortest_path, okf_export_graph (graph
// power-tools dropped: retrieval is index-based, and the app renders the
// graph from the service's own derived `/graph` route — ADR-004).
//
// Read-only declarations are wrapped in readOnly() to opt into concurrent
// execution (039 `parallelSafe`). Every writer is deliberately sequential:
// two concurrent upserts/merges/deletes against one bundle would race on the
// same files AND on the derived-index rebuild each of them triggers.

const STRING = { type: "string" };
const STATUS_ENUM = { type: "string", enum: ["draft", "stable", "deprecated"] };

function required(properties, req) {
  return { type: "object", properties, required: req };
}

function readOnly(declaration) {
  return { ...declaration, parallelSafe: true };
}

const DECLARATIONS = [
  // ── Retrieval ──────────────────────────────────────────────────────────
  readOnly({
    name: "okf_search",
    description:
      "Find knowledge in a bundle. Searches concept and person terms, chapter titles, summaries AND the full text of every chapter and document (inline-asset interpretations included), and returns ranked hits — one per chapter (a document-level hit has `chId: \"\"`) — each with the document and chapter, the chapter's one-line summary, `matchKind` (what matched: `term`, `person`, `title`, `summary` or `text`), the words that matched, and for a full-text match an `excerpt` (at most three sentences) showing where.\n\n" +
      "Any query word may match; hits that match more of your words rank first. A name, a number or a phrase from a chapter body is found even when it is no concept term. Use `groupBy: \"document\"` to ask \"which documents cover this?\" — one row per document with its best chapters beneath.\n\n" +
      "Hits are pointers. The excerpt shows where a match is; it is not the content — read the chapter in full with okf_read_concept, or the document's chapter list with okf_read_toc({bundle, docId}). Every hit carries `status`/`stale`: say so when you rely on a stale or deprecated chapter.\n\n" +
      "No hits is not yet proof the bundle lacks it: rephrase once, or browse the bundle's documents with okf_read_toc({bundle}). Never invent a hit.",
    inputSchema: required(
      {
        bundle: STRING,
        query: { type: "string", description: "What you are looking for — words, a name, a phrase. Matched (case- and accent-insensitively, at the start of words) against terms, titles, summaries and full text." },
        limit: { type: "number", description: "Maximum hits (default 10, max 50); with groupBy, maximum documents." },
        groupBy: { type: "string", enum: ["document"], description: "Group hits by document: one row per document, at most 5 of its hits beneath." },
      },
      ["bundle", "query"],
    ),
  }),
  readOnly({
    name: "okf_read_toc",
    description:
      "The bundle's table of contents, at two levels.\n\n" +
      "Without `docId`: the bundle's DOCUMENTS, newest first — each with its id, title, chapter count and a short summary of what it is about — 50 per page (`offset`/`limit`, max 200; `total` says how many there are). Browse this to see what a bundle holds, or when a question is about a topic rather than a specific fact.\n\n" +
      "With `docId`: that document's CHAPTERS, each with a one-line summary and the concept terms it covers. Use it to decide WHICH chapters to read in full, then call okf_read_concept for those.",
    inputSchema: required(
      {
        bundle: STRING,
        docId: { type: "string", description: "A document id. Omit it for the bundle-level table of contents." },
        offset: { type: "number", description: "Bundle level only: documents to skip (default 0)." },
        limit: { type: "number", description: "Bundle level only: documents per page (default 50, max 200)." },
      },
      ["bundle"],
    ),
  }),
  readOnly({
    name: "okf_read_concept",
    description:
      "Read one concept IN FULL — a document stub (`<docId>`) or a chapter (`<docId>/<chId>`). Returns the complete markdown body, never a snippet or a chunk, plus its frontmatter, its outgoing links, and its inline-asset blocks (each stored asset's link AND the interpretation written at ingest, so you get the diagram's or video's knowledge without re-running vision).",
    inputSchema: required({ bundle: STRING, id: STRING }, ["bundle", "id"]),
  }),
  readOnly({
    name: "okf_list_concepts",
    description:
      "Look up the bundle's concept VOCABULARY — terms with their `kind` (`topic`, or `person` for an author or named key figure), how many chapters each covers, and up to 5 of them (`coversTotal` says how many). Filter with `query` (part of a term's name); results are paged (default 100, max 500) because a large bundle has thousands of terms.\n\n" +
      "Use it to REUSE a term: before introducing a new one, query for it (`query: \"attention\"`) and extend an existing term instead of creating a near-duplicate. To FIND content, use okf_search; to see what documents a bundle has, okf_read_toc({bundle}).\n\n" +
      "`kind: \"person\"` lists only people, `kind: \"topic\"` only subjects; the default is every term.",
    inputSchema: required(
      {
        bundle: STRING,
        query: { type: "string", description: "Part of a term's name (case- and accent-insensitive)." },
        kind: { type: "string", enum: ["topic", "person", "all"], description: "Filter by term kind. Default `all`." },
        status: STATUS_ENUM,
        offset: { type: "number", description: "Terms to skip (default 0)." },
        limit: { type: "number", description: "Terms per page (default 100, max 500)." },
        type: { type: "string", enum: ["document", "section"], description: "Not a listing: answers with where documents and chapters are listed (okf_read_toc)." },
      },
      ["bundle"],
    ),
  }),

  // ── Concepts ───────────────────────────────────────────────────────────
  {
    name: "okf_upsert_concept",
    description:
      "Create or update a concept file — a document stub (`type: document`) or a chapter (`type: section`). Frontmatter is MERGED ON FIELDS and unknown keys are preserved verbatim, so this is also how you set every lifecycle/trust/provenance field: `status` (draft/stable/deprecated), `stale_after`, `verified`, `sources`, `attestations`, and anything else the bundle uses. There are no separate field-setter tools.\n\n" +
      "A chapter MUST carry `parent` (its document id), `concepts` (the terms it covers) and `summary` (one line) — those three are what the concept index and the document TOC are derived from, so a chapter missing them is written but unreachable by okf_search. Both derived artifacts are rebuilt automatically after every write.\n\n" +
      "WRITING A CHAPTER FROM AN INGESTED SOURCE: do NOT re-type the chapter's body. Pass `sourceRange` instead — the service slices the body verbatim out of `raw/<source>.md` using the heading map okf_add_raw_source built, and you emit only what you authored (the frontmatter, and `interpretations` for any inline asset). `startHeading` is a GLOBAL heading index, taken from the `headings:` frontmatter list of the chunk you are reading — you never count or re-type heading text. One call per chapter.",
    inputSchema: required(
      {
        bundle: STRING,
        id: { type: "string", description: "`<docId>` for a document stub, `<docId>/<chId>` for a chapter." },
        title: STRING,
        body: {
          type: "string",
          description:
            "The full markdown body — for a chapter you are AUTHORING. Ignored when `sourceRange` is given: a chapter extracted from an ingested source must not be re-typed (that is the output-token cost FR-060 removes).",
        },
        // ADR-014 D4: ADDITIVE optional fields on the existing write tool —
        // not a 22nd tool. A call without them behaves exactly as before.
        sourceRange: {
          type: "object",
          description:
            "Extract this chapter's body verbatim from the registered source instead of passing it in `body`. The document is resolved from the concept id's `<docId>` — there is no source id to pass.",
          properties: {
            startHeading: {
              type: "integer",
              description:
                "The GLOBAL heading index this chapter starts at, copied from the `headings:` list in the chunk's frontmatter. Use -1 for the headingless preamble before the first heading. Omit only when `whole` is true.",
            },
            toHeading: {
              type: "integer",
              description:
                "End the chapter just before THIS heading index (exclusive) — how you merge two or more short sections into one chapter. Omitted, the chapter ends at the next heading of the same or a higher level.",
            },
            whole: {
              type: "boolean",
              description: "Take the ENTIRE source as one chapter — the no-heading / single-chapter case.",
            },
          },
        },
        interpretations: {
          type: "array",
          description:
            "The inline-asset interpretations YOU authored. The service inserts each one beneath its asset line in the extracted body and links the stored local copy — you do not write the body around it.",
          items: required(
            {
              assetLine: {
                type: "string",
                description:
                  "The asset's markdown line copied VERBATIM from the chunk you read (e.g. `![Canary console](https://…/canary.mp4)`) — it is matched as an exact substring of the source. The `blockTemplate` okf_add_raw_source/addRawAsset returned is the reference for this string.",
              },
              interpretation: { type: "string", description: "Your interpretation of the asset, as one line of prose." },
            },
            ["assetLine", "interpretation"],
          ),
        },
        frontmatter: {
          type: "object",
          description: "Merged over the existing frontmatter. For a chapter: {type:'section', parent, concepts:[…], summary, person_terms:[…], status, stale_after?, sources:[…]}.",
        },
      },
      ["bundle", "id"],
    ),
  },
  {
    name: "okf_delete_concept",
    description:
      "Delete a concept file. Non-destructive by default: only that file is removed; backlinking chapters are left untouched. Set rewrite_backlinks to also rewrite every chapter that links to it. The concept index and the affected document TOC are rebuilt either way.",
    inputSchema: required({ bundle: STRING, id: STRING, rewrite_backlinks: { type: "boolean", default: false } }, ["bundle", "id"]),
  },
  {
    name: "okf_merge_concepts",
    description:
      "Merge one concept term into another canonical term. Rewrites every chapter's `concepts` frontmatter that referenced `from`, then rebuilds the concept index and every affected document TOC, leaving a single canonical entry that routes to the union of both terms' chapters. Use this when the organically-grown vocabulary has accumulated near-duplicates.",
    inputSchema: required(
      { bundle: STRING, from: { type: "string", description: "The term to retire." }, to: { type: "string", description: "The canonical term to keep." } },
      ["bundle", "from", "to"],
    ),
  },

  // ── Bundles ────────────────────────────────────────────────────────────
  readOnly({
    name: "okf_list_bundles",
    description: "List every knowledge base (OKF bundle) with its health: document count, chapter count, distinct concept-term count, and stale/deprecated chapters.",
    inputSchema: { type: "object", properties: {} },
  }),
  {
    name: "okf_init_bundle",
    description: "Create a new, empty knowledge base: a spec-conformant OKF bundle (index.md, log.md, concept-index.md, toc/, links.json, raw/, raw/assets/, concepts/).",
    inputSchema: required({ name: STRING, title: STRING, description: STRING }, ["name"]),
  },
  {
    name: "okf_import_bundle",
    description:
      "Import an OKF bundle — either from a flat {path, content} manifest (what okf_export_bundle produces) or from `sourcePath`, a directory already staged in the VFS. Its documents, chapters, concept index and TOCs become queryable. The derived index is rebuilt best-effort afterwards; if the imported chapters lack `parent`/`concepts`/`summary`, the result reports that routing is partial rather than silently serving a half index. Nothing is dropped or overwritten. Git/tarball sources: fetch and unpack them yourself, then import the resulting directory by path.",
    inputSchema: required(
      {
        bundle: STRING,
        files: { type: "array", items: required({ path: STRING, content: STRING }, ["path", "content"]) },
        sourcePath: { type: "string", description: "A VFS directory holding the bundle to import (alternative to `files`)." },
        rebuild: { type: "boolean", description: "Set false to skip the post-import index rebuild" },
      },
      ["bundle"],
    ),
  },
  readOnly({
    name: "okf_export_bundle",
    description: "Export a bundle as a spec-conformant OKF manifest. The derived artifacts are regenerated first, so the export always includes a correct concept-index.md and every toc/<docId>.md — re-importing it reproduces a fully queryable bundle. Binary inline assets are listed by path and size, not inlined.",
    inputSchema: required({ bundle: STRING, format: { type: "string", enum: ["manifest"] } }, ["bundle"]),
  }),
  {
    name: "okf_delete_bundle",
    description: "Permanently delete an entire knowledge base — every document, chapter, raw source, inline asset, the concept index and the TOCs. Removes only that bundle's directory. Cannot be undone.",
    inputSchema: required({ bundle: STRING }, ["bundle"]),
  },

  // ── Ingest ─────────────────────────────────────────────────────────────
  {
    name: "okf_ingest",
    description:
      "Ingest a source into a knowledge base as organized chapters. ONE CALL — pass `source` as a URL, a VFS file path, or a raw/ path already in the bundle. You do not need to fetch, convert, stage or delegate anything first, and there is nothing for you to run afterwards.\n\n" +
      "The service starts the run itself: it records a job and launches the bundled least-privilege `okf-ingest` agent, which acquires the source (streaming it to disk, never through anyone's context), decomposes it at its heading structure into chapters with concept terms and one-line summaries, interprets inline assets, and maintains the document TOC and the concept index.\n\n" +
      "Returns IMMEDIATELY with `{jobId, status: 'queued'}` — your turn is not held open for the run. Check how it went with okf_list_jobs: it ends `completed` with a summary, or `failed` with an error.\n\n" +
      "A source already in the bundle's provenance ledger returns `already_ingested` with the existing document id and starts no run — unless you pass `reingest: true`, which replaces that document with a fresh ingest. Runs are queued: at most the service's `maxConcurrentRuns` run at once.",
    inputSchema: required(
      {
        bundle: STRING,
        source: {
          type: "string",
          description: "What to ingest: an http(s) URL, an absolute VFS path (e.g. /workspace/report.pdf), or a raw/ path already in the bundle.",
        },
        maxDepth: { type: "number", description: "Reference-crawl hops beyond the seed source (overrides the bundle default). Called from inside an ingest run, the new run gets one hop less than that run, and this can only lower it." },
        maxWorkers: { type: "number", description: "How many references to ingest concurrently (overrides the bundle default)." },
        reingest: {
          type: "boolean",
          description: "Re-ingest a source that is ALREADY in the bundle: re-acquire it from its origin and rewrite the document under the same id (the current version stays until the run completes — then chapters it did not rewrite are removed; a failed or cancelled run changes nothing; raw/ keeps every version). Only when the user asks for a re-ingest — never for a reference you are following.",
        },
      },
      ["bundle", "source"],
    ),
  },
  {
    name: "okf_add_raw_source",
    description:
      "MECHANICAL step: register a source document — or a downloaded non-HTML inline asset — into the bundle's raw/ store (append-only, versioned, never overwritten).\n\n" +
      "For a document: pass `sourcePath` (a VFS path something already staged, e.g. web_fetch or file_to_markdown output) rather than `content` whenever the source is large — with sourcePath the bytes go straight from disk into raw/ and never pass through your context. Use `content` only for short, already-in-context text.\n\n" +
      "For an inline asset (image/video): set asset:true and pass `docId` plus the `sourcePath` you web_fetch'd it to. The asset is registered under raw/assets/<docId>/ and the call returns the markdown block template to write into the owning chapter after you interpret it with view_image / video_keyframes.\n\n" +
      "This does NOT decompose anything into chapters — follow it with okf_ingest for that.\n\n" +
      "DOC ID: the response carries `docId` — the document's one id, derived from its real origin (`originUrl`, else the source path) and already used to key `.chunks/<docId>/` and the raw/sources.json ledger entry. Write the document stub (`concepts/<docId>.md`), every chapter (`<docId>/<chId>`, `parent: <docId>`) and therefore the TOC under THAT exact id. Coining your own id keys the stub and TOC to one document while the chunks and ledger keep another, and the TOC comes out empty.\n\n" +
      "CHUNKS: for a text source the response carries `chunks` — `[{path, ordinal, total}]`, the source mechanically pre-split at heading/paragraph/sentence boundaries into `.chunks/<docId>/NNN.md`, each at most `maxChunkSize` characters. Process them SEQUENTIALLY with file_read (chunks[0].path first, decompose it into chapters, then chunks[1].path, …) instead of reading the whole `rawFile` — that is what keeps a large document out of your context. Each chunk's frontmatter carries `chunk`/`total`/`headingPath` (the headings open at that point). A source that fits in one chunk returns exactly one entry, so the protocol is the same either way.",
    inputSchema: required(
      {
        bundle: STRING,
        filename: STRING,
        content: STRING,
        sourcePath: STRING,
        conceptId: { type: "string", description: "Optional document id to stub for this source." },
        title: STRING,
        originUrl: { type: "string", description: "The URL this came from, when there is one — it becomes the document's 'Open source' target." },
        asset: { type: "boolean", description: "True when registering a non-HTML inline asset rather than a text source." },
        docId: { type: "string", description: "Required with asset:true — scopes the asset to raw/assets/<docId>/." },
      },
      ["bundle"],
    ),
  },
  readOnly({
    name: "okf_list_jobs",
    description:
      "List ingest runs and how they went — the same records the app's Jobs tab shows. Each is `{id, status, bundleId, source, queuedAt, startedAt, endedAt, durationMs, progress, summary, error, runId, trajectoryEvents}`, newest first.\n\n" +
      "This is how you follow up on an okf_ingest you started: the run is asynchronous and okf_ingest returns only a jobId, so this is the only way to learn whether it completed (with a summary), was cancelled (an intentional stop — `error` is null), or failed (with a reason). Filter by `bundle`, by `status`, or pass the `jobId` you were given.",
    inputSchema: {
      type: "object",
      properties: {
        bundle: { type: "string", description: "Only runs against this bundle." },
        status: { type: "string", enum: ["queued", "running", "completed", "cancelled", "failed"] },
        jobId: { type: "string", description: "Return just this one run." },
        limit: { type: "number", description: "Most recent N runs (default: all)." },
      },
    },
  }),
  {
    name: "okf_cancel_job",
    description:
      "Stop an ingest run that is still queued or running. The service aborts the underlying headless okf-ingest run and the job moves to the distinct `cancelled` state — an intentional stop, NOT a failure, so its `error` stays null.\n\n" +
      "Nothing is removed: the job record stays (delete it with okf_delete_job once you are done with it), and every chapter the run already wrote stays in the bundle. Writes are atomic, so a cancelled run leaves a smaller bundle, never a half-written one.\n\n" +
      "Cancelling a run that already ended (completed / failed / cancelled) is an error, not a no-op you need to guard against — read the status with okf_list_jobs first if you are unsure.",
    inputSchema: required(
      {
        bundle: { type: "string", description: "Optional — the bundle the run targets. Jobs are service-global, so the jobId alone identifies the run." },
        jobId: { type: "string", description: "The run to stop, as returned by okf_ingest or okf_list_jobs." },
      },
      ["jobId"],
    ),
  },
  {
    name: "okf_delete_job",
    description:
      "Delete a FINISHED ingest run's record — completed, cancelled or failed — to clear it from the Jobs list. Returns `{deleted: true, jobId}`.\n\n" +
      "This removes the run record ONLY. The chapters, concept index, TOCs and raw/ sources the run wrote are untouched: deleting a job never deletes knowledge (use okf_delete_concept or okf_delete_bundle for that, deliberately).\n\n" +
      "A run that is still queued or running is refused — cancel it first with okf_cancel_job.",
    inputSchema: required(
      { jobId: { type: "string", description: "The finished run to remove, as listed by okf_list_jobs." } },
      ["jobId"],
    ),
  },

  // ── Organization ───────────────────────────────────────────────────────
  {
    name: "okf_add_link",
    description: "Add an explicit 'related' relationship from one concept to another. Recorded both as a markdown link in the body (portable) and in links.json (for graph derivation).",
    inputSchema: required({ bundle: STRING, id: STRING, target: STRING, label: STRING }, ["bundle", "id", "target"]),
  },
  readOnly({
    name: "okf_backlinks",
    description: "List the concepts that link to the given concept.",
    inputSchema: required({ bundle: STRING, id: STRING }, ["bundle", "id"]),
  }),

  // ── Health ─────────────────────────────────────────────────────────────
  readOnly({
    name: "okf_lint",
    description:
      "Check a bundle's health: broken inline-asset links, orphan chapters with no parent document, concept-index and document-TOC drift from the underlying chapter content, links.json/markdown drift, and chapters missing the `concepts`/`summary` frontmatter that makes them reachable. Because both index levels are derived, detected drift is REBUILT, not hand-patched.",
    inputSchema: required({ bundle: STRING }, ["bundle"]),
  }),
  readOnly({
    name: "okf_stale_report",
    description: "List every chapter past its `stale_after` date or marked deprecated, with how many days stale it is.",
    inputSchema: required({ bundle: STRING }, ["bundle"]),
  }),
];

// ── The dispatcher is gone ───────────────────────────────────────────────
//
// This file used to carry ~140 lines of planning machinery: plannedAcquisition
// (which tool calls would stage the source), jobCallbacks (the four loopback
// URLs the sub-agent was told to POST), and planIngest (which assembled an
// `acquisition_required` / `delegation_required` instruction block for the
// caller to execute).
//
// All of it existed because the worker could not start an agent run. It can
// (`lib/delegate-bridge.js` → `POST /api/subagents/delegate`), so okf_ingest
// now triggers the run itself and the planning layer has no job. The
// acquisition steps did not disappear — they moved into the sub-agent's task,
// built by `core.buildIngestTask`, where the service still pins every
// `output_path` and the caller can no longer forget one.

function makeHandlers(core) {
  return {
    // ── Retrieval ────────────────────────────────────────────────────────
    okf_search: async (args, ctx) => {
      // The same core.search() the app's /search route runs (FR-036).
      const res = await core.search(ctx.bundleRoot, args.bundle, args.query, { limit: args.limit, groupBy: args.groupBy });
      return {
        bundle: args.bundle,
        query: args.query,
        ...res,
        note: res.count
          ? "Each hit is a pointer; an excerpt shows where a match is, not the content. Read a chapter in full with okf_read_concept({bundle, id: `<docId>/<chId>`}) (a document-level hit: id `<docId>`), or a document's chapter list with okf_read_toc({bundle, docId})."
          : `Nothing matched — searched ${res.searched.join(", ")}. Rephrase once, or browse the bundle's documents with okf_read_toc({bundle}); only when both come up empty is it not in this bundle. Do not invent an answer.`,
      };
    },
    okf_read_toc: (args, ctx) => core.readToc(ctx.bundleRoot, args.bundle, args.docId, { offset: args.offset, limit: args.limit }),
    okf_read_concept: (args, ctx) => core.readConcept(ctx.bundleRoot, args.bundle, args.id),
    // `kind` is an additive, optional filter (ADR-011) — omitted means every
    // term, and every term in the response now carries its own `kind`.
    okf_list_concepts: (args, ctx) =>
      core.listConcepts(ctx.bundleRoot, args.bundle, {
        query: args.query,
        type: args.type,
        status: args.status,
        kind: args.kind,
        offset: args.offset,
        limit: args.limit,
      }),

    // ── Concepts ─────────────────────────────────────────────────────────
    // ADR-014 D4 PRECEDENCE: `sourceRange` present -> the service extracts
    // the body from raw/<source>.md via core.chapterFromSourceRange (the
    // agent emitted no body at all); otherwise `body` is used exactly as
    // given — the original path, unchanged for every existing caller.
    okf_upsert_concept: (args, ctx) =>
      core.upsertConcept(ctx.bundleRoot, args.bundle, args.id, {
        title: args.title,
        body: args.body,
        frontmatter: args.frontmatter,
        sourceRange: args.sourceRange,
        interpretations: args.interpretations,
        // which run wrote it — a re-ingest replaces only what its run did not rewrite (FR-064)
        caller: ctx.caller,
      }),
    okf_delete_concept: (args, ctx) => core.deleteConcept(ctx.bundleRoot, args.bundle, args.id, { rewriteBacklinks: !!args.rewrite_backlinks }),
    okf_merge_concepts: (args, ctx) => core.mergeConcepts(ctx.bundleRoot, args.bundle, args.from, args.to),

    // ── Bundles ──────────────────────────────────────────────────────────
    okf_list_bundles: (args, ctx) => core.listBundles(ctx.bundleRoot),
    okf_init_bundle: (args, ctx) => core.initBundle(ctx.bundleRoot, args.name, { title: args.title, description: args.description }),
    okf_import_bundle: (args, ctx) => core.importBundle(ctx.bundleRoot, args.bundle, { files: args.files, sourcePath: args.sourcePath, rebuild: args.rebuild !== false }),
    okf_export_bundle: (args, ctx) => core.exportBundle(ctx.bundleRoot, args.bundle),
    okf_delete_bundle: (args, ctx) => core.deleteBundle(ctx.bundleRoot, args.bundle),

    // ── Ingest ───────────────────────────────────────────────────────────
    okf_add_raw_source: (args, ctx) => {
      if (args.asset) {
        return core.addRawAsset(ctx.bundleRoot, args.bundle, {
          docId: args.docId,
          filename: args.filename,
          sourcePath: args.sourcePath,
          originUrl: args.originUrl,
        });
      }
      // ADR-012 / FR-055: registering the source is ALSO where it is chunked.
      // core.addRawSource writes raw/ and then mechanically pre-splits the
      // same bytes into .chunks/<docId>/NNN.md, returning `chunks` so the
      // agent can read one bounded chunk at a time. The bound comes from the
      // service config (FR-056) — the handler supplies it, the core applies it.
      return core.addRawSource(ctx.bundleRoot, args.bundle, {
        filename: args.filename,
        content: args.content,
        sourcePath: args.sourcePath,
        conceptId: args.conceptId,
        title: args.title,
        originUrl: args.originUrl,
        maxChunkSize: ctx.ingestDefaults && ctx.ingestDefaults.maxChunkSize,
      });
    },

    // THE auto-trigger. One call: the service dedups, creates the job,
    // launches the okf-ingest agent over the loopback delegate endpoint, and
    // returns {jobId, status:"queued"} before the run has started doing
    // anything. No instruction block, nothing for the caller to execute, and
    // the caller's turn is not held open for a multi-minute run.
    okf_ingest: (args, ctx) =>
      core.triggerIngest(ctx.bundleRoot, {
        bundle: args.bundle,
        source: args.source,
        maxDepth: args.maxDepth,
        maxWorkers: args.maxWorkers,
        reingest: args.reingest === true,
        defaults: ctx.ingestDefaults,
        // Which run is calling (from BOS, not the model) — a reference followed
        // from inside an ingest run inherits that run's remaining depth.
        caller: ctx.caller,
      }),

    // The run observer. Reads the SAME core.listJobs() records the app's Jobs
    // tab renders — so what an agent sees and what the user sees can never
    // disagree about a run.
    okf_list_jobs: async (args, ctx) => {
      if (args.jobId) {
        const job = await core.getJob(ctx.bundleRoot, args.jobId);
        if (!job) throw new Error(`job not found: ${args.jobId}`);
        // jobListView, not the raw record: the captured `trajectory`
        // (FR-057) is the USER's debug surface, rendered by the app's Jobs
        // tab from GET /jobs/<id>. Returning tens of kilobytes of the agent's
        // own past tool calls back into its context would be a cost with no
        // reader — ADR-013 rejected a trajectory TOOL for exactly this
        // reason. The count still comes through.
        return { jobs: [core.jobListView(job)], count: 1 };
      }
      const jobs = await core.listJobs(ctx.bundleRoot, {
        bundleId: args.bundle,
        status: args.status,
        limit: args.limit,
      });
      return {
        jobs,
        count: jobs.length,
        active: jobs.filter((j) => j.status === "running" || j.status === "queued").length,
      };
    },

    // Job CONTROL. Both call the same core functions the app's
    // `POST /jobs/<id>/cancel` and `DELETE /jobs/<id>` routes call, so the
    // Cancel button and the tool cannot drift apart (ADR-003). The core
    // raises a carrying `statusCode` (404 unknown / 409 wrong lifecycle
    // state) which the REST bridge turns into a status; here it surfaces as
    // the error message, which is what an agent can act on.
    okf_cancel_job: (args, ctx) => core.cancelJob(ctx.bundleRoot, args.jobId),
    okf_delete_job: (args, ctx) => core.deleteJob(ctx.bundleRoot, args.jobId),

    // ── Organization ─────────────────────────────────────────────────────
    okf_add_link: (args, ctx) => core.addLink(ctx.bundleRoot, args.bundle, args.id, args.target, { label: args.label }),
    okf_backlinks: async (args, ctx) => ({ id: args.id, backlinks: await core.backlinks(ctx.bundleRoot, args.bundle, args.id) }),

    // ── Health ───────────────────────────────────────────────────────────
    okf_lint: (args, ctx) => core.lintBundle(ctx.bundleRoot, args.bundle),
    okf_stale_report: (args, ctx) => core.staleReport(ctx.bundleRoot, args.bundle),
  };
}

module.exports = { DECLARATIONS, makeHandlers };
