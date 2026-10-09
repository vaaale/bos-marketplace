// tools.js — the okf_* tool surface exposed to the BOS assistant (039
// Service Tool Exposure contract) plus their handlers. Each handler is
// `(args, ctx) => Promise<any>` where ctx.core is the bound okf-core module,
// ctx.bundleRoot is the configured storage root, ctx.vfs is the VFS bridge,
// ctx.ingestDefaults carries maxDepth/maxWorkers and ctx.getRuntime resolves
// the service's own loopback base URL (for the job-callback URLs okf_ingest
// hands the sub-agent). Handlers validate shape and delegate to okf-core,
// which owns all storage semantics.
//
// ── EXACTLY 18 TOOLS (spec FR-037 / SC-007, design.md §8.2) ──────────────
//
// The pre-redesign surface declared 31. This declares 18 and nothing else:
//
//   Retrieval      okf_search · okf_read_toc · okf_read_concept · okf_list_concepts
//   Concepts       okf_upsert_concept · okf_delete_concept · okf_merge_concepts
//   Bundles        okf_list_bundles · okf_init_bundle · okf_import_bundle
//                  okf_export_bundle · okf_delete_bundle
//   Ingest         okf_ingest · okf_add_raw_source
//   Organization   okf_add_link · okf_backlinks
//   Health         okf_lint · okf_stale_report
//
// ADDED (3): okf_search, okf_read_toc, okf_merge_concepts.
// REMOVED (16 by name, 13 net): okf_bundle_status (folded into
// okf_list_bundles health), okf_find_concepts (-> okf_search),
// okf_read_index, okf_read_bundle_schema (-> the okf-bundle-schema SKILL,
// ADR-007), okf_append_log (the log is internal now), okf_get_as_of,
// okf_set_status, okf_set_trust, okf_add_source, okf_attest, okf_provenance
// (all five field-setters FOLDED into okf_upsert_concept's merge-on-fields
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
      "Ingest a source into a knowledge base as organized chapters. START HERE for any ingest — pass `source` as a URL, a VFS file path, or a raw/ path already in the bundle; you do not need to prepare anything first.\n\n" +
      "This tool never fetches or decomposes anything itself. It records the run as a job and returns the exact next calls to make:\n" +
      "• source not yet in the bundle → status 'acquisition_required' with a `steps` list. Run those calls verbatim (they pin output_path so the document streams to disk instead of through you), then call okf_ingest again with the resulting raw/ path.\n" +
      "• source already in raw/ → status 'delegation_required' with a `delegate` block. Call agent_delegate with it; the 'okf-ingest' agent reads the source from the bundle and writes the chapters, concept terms, summaries, TOC and inline-asset interpretations.\n" +
      "• source already ingested → status 'already_ingested' with the existing document id (no duplicate is created).\n\n" +
      "AFTER agent_delegate returns: if it returned an error or an empty result, POST the returned `callbacks.fail` URL so the run does not sit in the Jobs tab as 'running' forever. That is the safety net for a sub-agent that dies without reporting.\n\n" +
      "Follow the returned instructions literally rather than improvising an equivalent — the parameters they specify are what keep a long document out of your context.",
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

const CONVERTIBLE = /\.(pdf|docx|pptx|xlsx|doc|ppt|xls)$/i;

/** Filesystem-safe slug for the staged copy's filename. */
function stagedName(source) {
  const base =
    source
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean)
      .pop() || "source";
  const slug = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "source";
  return slug.replace(CONVERTIBLE, "") + ".md";
}

/**
 * If `source` still needs acquiring, return the exact tool calls that put it
 * in the bundle's raw/ without its text passing through the model. Returns
 * null when `source` already names something in raw/ (nothing to acquire).
 *
 * Every step pins `output_path`, because that parameter is the whole
 * mechanism: with it the content streams to the VFS and the tool returns a
 * receipt; without it the content comes back as a tool result and the only
 * way to store it is for the model to re-emit the entire document.
 */
function plannedAcquisition(source, bundle, bundleExists) {
  const isUrl = /^https?:\/\//i.test(source);
  const isAbsPath = source.startsWith("/");
  if (!isUrl && !isAbsPath) return null;

  const staged = `/workspace/okf-staged-${stagedName(source)}`;
  const fetchStep = isUrl
    ? { tool: "web_fetch", args: { url: source, output_path: staged } }
    : CONVERTIBLE.test(source)
      ? { tool: "file_to_markdown", args: { path: source, output_path: staged } }
      : null;

  const sourcePath = fetchStep ? staged : source;
  const steps = [
    ...(bundleExists ? [] : [{ tool: "okf_init_bundle", args: { name: bundle } }]),
    ...(fetchStep ? [fetchStep] : []),
    { tool: "okf_add_raw_source", args: { bundle, sourcePath, ...(isUrl ? { originUrl: source } : {}) } },
    { tool: "okf_ingest", args: { bundle, source: "<the rawFile returned by the previous step>" } },
  ];
  return { steps };
}

/** The sub-agent's job-lifecycle callback URLs (ADR-006). */
function jobCallbacks(ctx, jobId) {
  const runtime = typeof ctx.getRuntime === "function" ? ctx.getRuntime() : null;
  const base = runtime && runtime.port ? `http://127.0.0.1:${runtime.port}` : "";
  return {
    start: `${base}/jobs/${jobId}/start`,
    progress: `${base}/jobs/${jobId}/progress`,
    complete: `${base}/jobs/${jobId}/complete`,
    fail: `${base}/jobs/${jobId}/fail`,
  };
}

/**
 * The okf_ingest DISPATCHER. It plans, it never acts: the worker runs outside
 * the Next.js process with no web_fetch, no file_to_markdown and no agent
 * loop, so it validates the source, dedups against the bundle's provenance
 * ledger, mints the job record, and hands back the exact next calls.
 *
 * Shared deliberately by two callers: the `okf_ingest` tool (the agent path)
 * and the app's `POST /bundles/<b>/ingest` route (the Ingest modal, which
 * queues the run and shows the user the delegation to hand the assistant).
 * Same function, so the job a user queues and the job an agent queues are
 * the same record with the same callbacks — and the app still adds no tool.
 */
async function planIngest(core, args, ctx) {

    const source = String(args.source || "").trim();
    if (!source) throw new Error("source is required — a URL, a /workspace path, or a raw/ path");
    const maxDepth = Number.isFinite(args.maxDepth) ? args.maxDepth : ctx.ingestDefaults.maxDepth;
    const maxWorkers = Number.isFinite(args.maxWorkers) ? args.maxWorkers : ctx.ingestDefaults.maxWorkers;
    const bDir = core.safeJoin(ctx.bundleRoot, args.bundle);
    const bundleExists = await ctx.vfs.exists(bDir).catch(() => false);

    // FR-018 dedup: a source already in the bundle's provenance ledger
    // updates its existing document — it is never ingested as a duplicate.
    if (bundleExists && !source.startsWith("raw/")) {
      const known = await core.findSource(ctx.bundleRoot, args.bundle, source).catch(() => null);
      if (known) {
        return {
          status: "already_ingested",
          instructions:
            "This source is already in the bundle's provenance ledger, so it was NOT re-ingested as a duplicate. Read what is already there; only re-ingest (by passing the raw/ path directly) if the source content has genuinely changed, in which case a new raw/ version is written and the existing document is updated in place.",
          bundle: args.bundle,
          source,
          docId: known.docId,
          rawFile: known.rawFile,
          ingestedAt: known.ingestedAt,
          next: [{ tool: "okf_read_toc", args: { bundle: args.bundle, docId: known.docId } }],
        };
      }
    }

    const acquisition = plannedAcquisition(source, args.bundle, bundleExists);
    if (acquisition) {
      const job = await core.createJob(ctx.bundleRoot, { bundleId: args.bundle, source, maxDepth, maxWorkers });
      return {
        status: "acquisition_required",
        instructions:
          "This source is not in the bundle's raw/ yet, and I cannot fetch it from here. " +
          "Run the calls in `steps` IN ORDER, exactly as given — then call okf_ingest again with the raw/ path from the okf_add_raw_source step. " +
          "Pass `output_path` exactly as specified: it makes the fetch write straight to disk and return only a receipt, " +
          "so the document never enters your context and you never have to reproduce it.",
        steps: acquisition.steps,
        bundle: args.bundle,
        source,
        jobId: job.id,
        job,
      };
    }

    const rel = source.startsWith("raw/") ? source : `raw/${source}`;
    if (!(await ctx.vfs.exists(core.safeJoin(bDir, rel)))) {
      throw new Error(`no such raw source: ${rel} — call okf_add_raw_source first`);
    }

    const job = await core.createJob(ctx.bundleRoot, { bundleId: args.bundle, source: rel, maxDepth, maxWorkers });
    const callbacks = jobCallbacks(ctx, job.id);
    return {
      status: "delegation_required",
      instructions:
        "Do NOT read the raw source yourself — that would pull its full text into your context, which this flow exists to avoid. " +
        "Call agent_delegate with agent='okf-ingest' and the task below. When it returns: if the result is an error or empty, " +
        `POST ${callbacks.fail} with {"error": "<what went wrong>"} so the run does not sit in the Jobs tab as running forever.`,
      delegate: {
        agent: "okf-ingest",
        task:
          `Ingest the raw source \`${rel}\` in OKF bundle "${args.bundle}" into organized chapters. jobId: ${job.id}.\n\n` +
          `Read the source from the bundle yourself; do not expect it inline. Decompose it at its natural heading structure into chapters ` +
          `(\`concepts/<docId>/<chId>.md\`, type: section), each carrying \`parent\`, the \`concepts\` terms it covers, and a one-line \`summary\` — ` +
          `those three fields are what the concept index and the document TOC are derived from. Upsert the document stub (\`concepts/<docId>.md\`, type: document) too.\n\n` +
          `For every NON-HTML asset in a chapter's scope: web_fetch it into \`raw/assets/<docId>/\`, register it with ` +
          `okf_add_raw_source({asset:true, docId, sourcePath}), interpret it with view_image or video_keyframes, and write the stored link ` +
          `plus a \`> **Interpretation (LLM, at ingest):** …\` blockquote into the chapter body. Ordinary HTML hyperlinks stay remote references — do not download them.\n\n` +
          `Job lifecycle (required): POST ${callbacks.start} before your first write; POST ${callbacks.complete} with ` +
          `{"summary": {"chapters": n, "concepts": n, "assets": n, "refsSkipped": n, "refsFailed": n, "written": ["chapter titles"]}} on success; ` +
          `POST ${callbacks.fail} with {"error": "…"} if you cannot finish. Optionally POST ${callbacks.progress} with {"progress": "…"} between chapters.\n\n` +
          `Follow at most ${maxDepth} hop(s) of references beyond this seed source, ingesting at most ${maxWorkers} reference(s) concurrently ` +
          `(issue that many agent_delegate calls in a single turn — they run in parallel). Skip any reference already in the bundle's provenance.\n\n` +
          `Report back only a compact summary: chapters written/updated, concept terms assigned, assets interpreted, references ingested and skipped (with reason). Never echo the source text.`,
      },
      bundle: args.bundle,
      source: rel,
      jobId: job.id,
      job,
      callbacks,
      maxDepth,
      maxWorkers,
    };
}

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

    // Dispatcher, not a writer. The worker thread runs outside the Next.js
    // process and so cannot invoke agent_delegate itself — it validates that
    // the raw source really exists, dedups against the bundle's provenance,
    // mints the job record, and hands back the exact delegation the caller
    // should issue. The calling assistant (which IS in-process) makes that
    // agent_delegate call, and owns the failure safety-net on its return.
    okf_ingest: (args, ctx) => planIngest(core, args, ctx),

    // ── Organization ─────────────────────────────────────────────────────
    okf_add_link: (args, ctx) => core.addLink(ctx.bundleRoot, args.bundle, args.id, args.target, { label: args.label }),
    okf_backlinks: async (args, ctx) => ({ id: args.id, backlinks: await core.backlinks(ctx.bundleRoot, args.bundle, args.id) }),

    // ── Health ───────────────────────────────────────────────────────────
    okf_lint: (args, ctx) => core.lintBundle(ctx.bundleRoot, args.bundle),
    okf_stale_report: (args, ctx) => core.staleReport(ctx.bundleRoot, args.bundle),
  };
}

module.exports = { DECLARATIONS, makeHandlers, planIngest, plannedAcquisition, jobCallbacks };
