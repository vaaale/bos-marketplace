// tools.js — the okf_* tool surface exposed to the BOS assistant (039
// Service Tool Exposure contract) plus their handlers. Each handler is
// `(args, ctx) => Promise<any>` where ctx.core is the bound okf-core module,
// ctx.bundleRoot is the configured storage root, ctx.vfs is the VFS bridge,
// ctx.ingestDefaults carries maxDepth/maxWorkers and ctx.getRuntime resolves
// the service's own loopback base URL (for the job-callback URLs okf_ingest
// hands the sub-agent). Handlers validate shape and delegate to okf-core,
// which owns all storage semantics.
//
// ── EXACTLY 19 TOOLS (spec FR-037 / SC-007, design.md §8.2 + the auto-trigger
//    rework's okf_list_jobs) ─────────────────────────────────────────────
//
// The pre-redesign surface declared 31. This declares 19 and nothing else:
//
//   Retrieval      okf_search · okf_read_toc · okf_read_concept · okf_list_concepts
//   Concepts       okf_upsert_concept · okf_delete_concept · okf_merge_concepts
//   Bundles        okf_list_bundles · okf_init_bundle · okf_import_bundle
//                  okf_export_bundle · okf_delete_bundle
//   Ingest         okf_ingest · okf_add_raw_source · okf_list_jobs
//   Organization   okf_add_link · okf_backlinks
//   Health         okf_lint · okf_stale_report
//
// ADDED (4): okf_search, okf_read_toc, okf_merge_concepts, okf_list_jobs.
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
      "START HERE to find knowledge in a bundle. Concept-anchored search: it matches your query against the bundle's concept vocabulary and the one-line descriptions in its index, and returns a ranked TABLE OF CONTENTS — one row per relevant chapter, each carrying the document, the chapter, a one-line description, and the concept term that matched.\n\n" +
      "Rows are pointers, not content. Follow up with okf_read_concept (the full chapter or document) or okf_read_toc (a document's chapter list). Retrieval is always full documents or full chapters — this tool never returns a snippet.\n\n" +
      "The match is deterministic and concept-anchored, NOT full text: a query that paraphrases body text but misses both the vocabulary and the stored descriptions returns nothing. An empty result is a real answer — widen the query, or read the vocabulary with okf_list_concepts and route from there. Never invent a row.",
    inputSchema: required(
      {
        bundle: STRING,
        query: { type: "string", description: "A natural-language query. Tokenized and matched against concept-term names and the index's one-line descriptions." },
        limit: { type: "number", description: "Maximum rows to return (default 25)." },
      },
      ["bundle", "query"],
    ),
  }),
  readOnly({
    name: "okf_read_toc",
    description:
      "Read a document's stored table of contents: its chapters, each with a one-line description and the concept terms it covers. This is the level-2 drill-down — use it to decide WHICH chapters to read in full, then call okf_read_concept for those.",
    inputSchema: required({ bundle: STRING, docId: STRING }, ["bundle", "docId"]),
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
      "Read the bundle's concept VOCABULARY — every concept term with the number of chapters it covers and which (document, chapter) pairs those are, plus the document and chapter listings. Use this to route semantically when okf_search comes back empty, and ALWAYS before introducing a new term, so you extend an existing term instead of creating a near-duplicate.",
    inputSchema: required(
      { bundle: STRING, type: { type: "string", enum: ["document", "section"] }, status: STATUS_ENUM },
      ["bundle"],
    ),
  }),

  // ── Concepts ───────────────────────────────────────────────────────────
  {
    name: "okf_upsert_concept",
    description:
      "Create or update a concept file — a document stub (`type: document`) or a chapter (`type: section`). Frontmatter is MERGED ON FIELDS and unknown keys are preserved verbatim, so this is also how you set every lifecycle/trust/provenance field: `status` (draft/stable/deprecated), `stale_after`, `verified`, `sources`, `attestations`, and anything else the bundle uses. There are no separate field-setter tools.\n\n" +
      "A chapter MUST carry `parent` (its document id), `concepts` (the terms it covers) and `summary` (one line) — those three are what the concept index and the document TOC are derived from, so a chapter missing them is written but unreachable by okf_search. Both derived artifacts are rebuilt automatically after every write.",
    inputSchema: required(
      {
        bundle: STRING,
        id: { type: "string", description: "`<docId>` for a document stub, `<docId>/<chId>` for a chapter." },
        title: STRING,
        body: { type: "string", description: "The full markdown body. Inline assets go in as a `![caption](raw/assets/<docId>/<file>)` link followed by a `> **Interpretation (LLM, at ingest):** …` blockquote." },
        frontmatter: {
          type: "object",
          description: "Merged over the existing frontmatter. For a chapter: {type:'section', parent, concepts:[…], summary, status, stale_after?, sources:[…]}.",
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
      "A source already in the bundle's provenance ledger returns `already_ingested` with the existing document id and starts no run.",
    inputSchema: required(
      {
        bundle: STRING,
        source: {
          type: "string",
          description: "What to ingest: an http(s) URL, an absolute VFS path (e.g. /workspace/report.pdf), or a raw/ path already in the bundle.",
        },
        maxDepth: { type: "number", description: "Reference-crawl hops beyond the seed source (overrides the bundle default)." },
        maxWorkers: { type: "number", description: "How many references to ingest concurrently (overrides the bundle default)." },
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
      "This does NOT decompose anything into chapters — follow it with okf_ingest for that.",
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
      "List ingest runs and how they went — the same records the app's Jobs tab shows. Each is `{id, status, bundleId, source, queuedAt, startedAt, endedAt, durationMs, progress, summary, error}`, newest first.\n\n" +
      "This is how you follow up on an okf_ingest you started: the run is asynchronous and okf_ingest returns only a jobId, so this is the only way to learn whether it completed (with a summary) or failed (with a reason). Filter by `bundle`, by `status`, or pass the `jobId` you were given.",
    inputSchema: {
      type: "object",
      properties: {
        bundle: { type: "string", description: "Only runs against this bundle." },
        status: { type: "string", enum: ["queued", "running", "completed", "failed"] },
        jobId: { type: "string", description: "Return just this one run." },
        limit: { type: "number", description: "Most recent N runs (default: all)." },
      },
    },
  }),

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
      const rows = await core.search(ctx.bundleRoot, args.bundle, args.query, args.limit);
      return {
        bundle: args.bundle,
        query: args.query,
        rows,
        count: rows.length,
        note: rows.length
          ? "Each row is a TOC pointer. Call okf_read_concept({bundle, id: `<docId>/<chId>`}) for the full chapter, or okf_read_toc({bundle, docId}) for the document's chapter list. Nothing here is a snippet."
          : "No concept term or stored description matched. This search is concept-anchored, not full text — widen the query, or call okf_list_concepts to read the vocabulary and route from there. Do not invent an answer.",
      };
    },
    okf_read_toc: (args, ctx) => core.readToc(ctx.bundleRoot, args.bundle, args.docId),
    okf_read_concept: (args, ctx) => core.readConcept(ctx.bundleRoot, args.bundle, args.id),
    okf_list_concepts: (args, ctx) => core.listConcepts(ctx.bundleRoot, args.bundle, { type: args.type, status: args.status }),

    // ── Concepts ─────────────────────────────────────────────────────────
    okf_upsert_concept: (args, ctx) =>
      core.upsertConcept(ctx.bundleRoot, args.bundle, args.id, { title: args.title, body: args.body, frontmatter: args.frontmatter }),
    okf_delete_concept: (args, ctx) => core.deleteConcept(ctx.bundleRoot, args.bundle, args.id, { rewriteBacklinks: !!args.rewrite_backlinks }),
    okf_merge_concepts: (args, ctx) => core.mergeConcepts(ctx.bundleRoot, args.bundle, args.from, args.to),

    // ── Bundles ──────────────────────────────────────────────────────────
    okf_list_bundles: (args, ctx) => core.listBundles(ctx.bundleRoot),
    okf_init_bundle: (args, ctx) => core.initBundle(ctx.bundleRoot, args.name, { title: args.title, description: args.description }),
    okf_import_bundle: (args, ctx) => core.importBundle(ctx.bundleRoot, args.bundle, { files: args.files, sourcePath: args.sourcePath }),
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
      return core.addRawSource(ctx.bundleRoot, args.bundle, {
        filename: args.filename,
        content: args.content,
        sourcePath: args.sourcePath,
        conceptId: args.conceptId,
        title: args.title,
        originUrl: args.originUrl,
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
        defaults: ctx.ingestDefaults,
      }),

    // The run observer. Reads the SAME core.listJobs() records the app's Jobs
    // tab renders — so what an agent sees and what the user sees can never
    // disagree about a run.
    okf_list_jobs: async (args, ctx) => {
      if (args.jobId) {
        const job = await core.getJob(ctx.bundleRoot, args.jobId);
        if (!job) throw new Error(`job not found: ${args.jobId}`);
        return { jobs: [job], count: 1 };
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

    // ── Organization ─────────────────────────────────────────────────────
    okf_add_link: (args, ctx) => core.addLink(ctx.bundleRoot, args.bundle, args.id, args.target, { label: args.label }),
    okf_backlinks: async (args, ctx) => ({ id: args.id, backlinks: await core.backlinks(ctx.bundleRoot, args.bundle, args.id) }),

    // ── Health ───────────────────────────────────────────────────────────
    okf_lint: (args, ctx) => core.lintBundle(ctx.bundleRoot, args.bundle),
    okf_stale_report: (args, ctx) => core.staleReport(ctx.bundleRoot, args.bundle),
  };
}

module.exports = { DECLARATIONS, makeHandlers };
