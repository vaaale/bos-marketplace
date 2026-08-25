// tools.js — the okf_* tool declarations exposed to the BOS assistant (039
// Service Tool Exposure contract) plus their handlers. Each handler is
// `(args, ctx) => Promise<any>` where ctx.core is the bound okf-core module,
// ctx.bundleRoot is the configured storage root, ctx.vfs is the VFS bridge and
// ctx.ingestDefaults carries the bundle's maxDepth/maxWorkers; handlers just
// validate shape and delegate to okf-core, which owns all storage semantics.
//
// Read-only declarations are wrapped in readOnly() to opt into concurrent
// execution (039 `parallelSafe`); writers are left sequential. See below.

const STRING = { type: "string" };
const TRUST_ENUM = { type: "string", enum: ["unverified", "machine-confirmed", "human-reviewed"] };
const STATUS_ENUM = { type: "string", enum: ["draft", "stable", "deprecated"] };

function required(properties, req) {
  return { type: "object", properties, required: req };
}

// Mark a declaration safe to run concurrently with adjacent parallel-safe tool
// calls (bos-spec 039 `parallelSafe`; BOS's agent loop batches them). Applied
// ONLY to read-only handlers: they take no locks, mutate nothing, and the
// worker already correlates concurrent invocations by callId, so N of them can
// be in flight at once. Every writer below is deliberately left sequential —
// two concurrent upserts/links/deletes against the same bundle would race on
// the same files and on okf-core's in-memory backlink index.
function readOnly(declaration) {
  return { ...declaration, parallelSafe: true };
}

const DECLARATIONS = [
  readOnly({
    name: "okf_list_bundles",
    description: "List every OKF bundle under the configured knowledge base root, with health summary stats.",
    inputSchema: { type: "object", properties: {} },
  }),
  {
    name: "okf_init_bundle",
    description: "Create a new, empty OKF bundle (index.md, log.md, schema.md, raw/, concepts/).",
    inputSchema: required(
      { name: STRING, title: STRING, description: STRING },
      ["name"],
    ),
  },
  readOnly({
    name: "okf_bundle_status",
    description: "Get health stats for a bundle: concept count, stale count, human-reviewed count, status breakdown.",
    inputSchema: required({ bundle: STRING }, ["bundle"]),
  }),
  {
    name: "okf_import_bundle",
    description: "Import (create or overwrite files in) a bundle from a flat manifest of { path, content } entries.",
    inputSchema: required(
      {
        bundle: STRING,
        files: {
          type: "array",
          items: required({ path: STRING, content: STRING }, ["path", "content"]),
        },
      },
      ["bundle", "files"],
    ),
  },
  readOnly({
    name: "okf_export_bundle",
    description: "Export an entire bundle as a flat manifest of { path, content } entries.",
    inputSchema: required({ bundle: STRING }, ["bundle"]),
  }),
  {
    name: "okf_upsert_concept",
    description: "Create or update a concept file, merging frontmatter fields (unknown keys are preserved).",
    inputSchema: required(
      {
        bundle: STRING,
        id: STRING,
        title: STRING,
        body: STRING,
        frontmatter: { type: "object" },
      },
      ["bundle", "id"],
    ),
  },
  readOnly({
    name: "okf_read_concept",
    description: "Read a concept's frontmatter, body, and outgoing links.",
    inputSchema: required({ bundle: STRING, id: STRING }, ["bundle", "id"]),
  }),
  {
    name: "okf_delete_concept",
    description:
      "Delete a concept file (does not touch raw/ source documents). By default this is non-destructive and leaves backlinks, index.md, and log.md untouched; set rewrite_backlinks to also rewrite backlinking concepts to drop the reference, update index.md, and log the deletion.",
    inputSchema: required({ bundle: STRING, id: STRING, rewrite_backlinks: { type: "boolean", default: false } }, ["bundle", "id"]),
  },
  {
    name: "okf_delete_bundle",
    description: "Permanently delete an entire OKF bundle — all concepts, raw sources, index.md, schema.md, and log.md. Cannot be undone.",
    inputSchema: required({ bundle: STRING }, ["bundle"]),
  },
  readOnly({
    name: "okf_list_concepts",
    description: "List concepts in a bundle, optionally filtered by lifecycle status or trust level.",
    inputSchema: required({ bundle: STRING, status: STATUS_ENUM, trust: TRUST_ENUM }, ["bundle"]),
  }),
  readOnly({
    name: "okf_find_concepts",
    description: "Full-text search over concept titles/ids/bodies in a bundle.",
    inputSchema: required({ bundle: STRING, query: STRING, limit: { type: "number" } }, ["bundle", "query"]),
  }),
  {
    name: "okf_add_link",
    description: "Add a Markdown link from one concept to another, recorded as a graph edge.",
    inputSchema: required({ bundle: STRING, id: STRING, target: STRING, label: STRING }, ["bundle", "id", "target"]),
  },
  {
    name: "okf_remove_link",
    description: "Remove a link from one concept to another.",
    inputSchema: required({ bundle: STRING, id: STRING, target: STRING }, ["bundle", "id", "target"]),
  },
  readOnly({
    name: "okf_list_links",
    description: "List a concept's outgoing links (graph edges).",
    inputSchema: required({ bundle: STRING, id: STRING }, ["bundle", "id"]),
  }),
  readOnly({
    name: "okf_backlinks",
    description: "List concepts that link to the given concept.",
    inputSchema: required({ bundle: STRING, id: STRING }, ["bundle", "id"]),
  }),
  readOnly({
    name: "okf_neighbors",
    description: "List concepts reachable from a concept within N hops (links and backlinks).",
    inputSchema: required({ bundle: STRING, id: STRING, depth: { type: "number" } }, ["bundle", "id"]),
  }),
  readOnly({
    name: "okf_shortest_path",
    description: "Find the shortest path between two concepts over the link graph.",
    inputSchema: required({ bundle: STRING, from: STRING, to: STRING }, ["bundle", "from", "to"]),
  }),
  readOnly({
    name: "okf_export_graph",
    description: "Export the full concept graph (nodes + edges) for a bundle.",
    inputSchema: required({ bundle: STRING }, ["bundle"]),
  }),
  {
    name: "okf_set_status",
    description: "Set a concept's lifecycle status (draft/stable/deprecated) and optionally its stale_after date.",
    inputSchema: required({ bundle: STRING, id: STRING, status: STATUS_ENUM, staleAfter: STRING }, ["bundle", "id", "status"]),
  },
  readOnly({
    name: "okf_get_as_of",
    description: "Read a concept as it existed at or before a given point in time, using log.md.",
    inputSchema: required({ bundle: STRING, id: STRING, asOf: STRING }, ["bundle", "id", "asOf"]),
  }),
  readOnly({
    name: "okf_stale_report",
    description: "List every concept in a bundle whose stale_after date has passed.",
    inputSchema: required({ bundle: STRING }, ["bundle"]),
  }),
  {
    name: "okf_set_trust",
    description: "Set a concept's trust level on the ladder: unverified, machine-confirmed, or human-reviewed.",
    inputSchema: required({ bundle: STRING, id: STRING, trust: TRUST_ENUM }, ["bundle", "id", "trust"]),
  },
  {
    name: "okf_add_source",
    description: "Attach a provenance source (id, uri, note) to a concept.",
    inputSchema: required(
      { bundle: STRING, id: STRING, source: required({ id: STRING, uri: STRING, note: STRING }, ["id"]) },
      ["bundle", "id", "source"],
    ),
  },
  {
    name: "okf_attest",
    description: "Record a human attestation (reviewer + note) against a concept.",
    inputSchema: required({ bundle: STRING, id: STRING, by: STRING, note: STRING }, ["bundle", "id", "by"]),
  },
  readOnly({
    name: "okf_provenance",
    description: "Read a concept's provenance: trust level, sources, and attestations.",
    inputSchema: required({ bundle: STRING, id: STRING }, ["bundle", "id"]),
  }),
  {
    name: "okf_add_raw_source",
    description:
      "MECHANICAL step: register a source document into raw/ (append-only, versioned — never overwrites). Pass sourcePath (a VFS path something already staged, e.g. web_fetch or file_to_markdown output) rather than content whenever the source is large: with sourcePath the bytes go straight from disk into raw/ and never pass through your context. Use content only for short, already-in-context text. This does NOT decompose the source into concepts — follow it with okf_ingest for that.",
    inputSchema: required(
      { bundle: STRING, filename: STRING, content: STRING, sourcePath: STRING, conceptId: STRING, title: STRING },
      ["bundle"],
    ),
  },
  {
    name: "okf_ingest",
    description:
      "Ingest a source into a bundle as linked concepts. START HERE for any ingest — pass `source` as a URL, a VFS file path, or a raw/ path already in the bundle; you do not need to prepare anything first.\n\n" +
      "This tool never fetches or decomposes anything itself. It returns the exact next calls to make:\n" +
      "• source not yet in the bundle → status 'acquisition_required' with a `steps` list. Run those calls verbatim (they pin output_path so the document streams to disk instead of through you), then call okf_ingest again with the resulting raw/ path.\n" +
      "• source already in raw/ → status 'delegation_required' with a `delegate` block. Call agent_delegate with it; the 'okf-ingest' agent reads the source from the bundle and writes the concepts.\n\n" +
      "Follow the returned instructions literally rather than improvising an equivalent — the parameters they specify are what keep a long document out of your context.",
    inputSchema: required(
      {
        bundle: STRING,
        source: {
          type: "string",
          description:
            "What to ingest: an http(s) URL, an absolute VFS path (e.g. /workspace/report.pdf), or a raw/ path already in the bundle. The first two return acquisition steps; the last proceeds to decomposition.",
        },
        maxDepth: { type: "number", description: "Reference-crawl hops beyond the seed source (overrides the bundle default)." },
        maxWorkers: { type: "number", description: "How many references to ingest concurrently (overrides the bundle default). Issue that many agent_delegate calls in one turn and they genuinely run in parallel." },
      },
      ["bundle", "source"],
    ),
  },
  readOnly({
    name: "okf_lint",
    description: "Check a bundle for broken links, orphan concepts, missing frontmatter, stale concepts, and unreferenced raw sources.",
    inputSchema: required({ bundle: STRING }, ["bundle"]),
  }),
  readOnly({
    name: "okf_read_index",
    description: "Read a bundle's index.md — the curated entry point for retrieval.",
    inputSchema: required({ bundle: STRING }, ["bundle"]),
  }),
  readOnly({
    name: "okf_read_bundle_schema",
    description: "Read a bundle's schema.md — its frontmatter and linking conventions.",
    inputSchema: required({ bundle: STRING }, ["bundle"]),
  }),
  {
    name: "okf_append_log",
    description: "Append a free-form entry to a bundle's log.md (e.g. to record an ingest/lint decision).",
    inputSchema: required({ bundle: STRING, event: STRING, message: STRING, conceptId: STRING }, ["bundle", "event", "message"]),
  },
];

const CONVERTIBLE = /\.(pdf|docx|pptx|xlsx|doc|ppt|xls)$/i;

/** Filesystem-safe slug for the staged copy's filename. */
function stagedName(source) {
  const base = source
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .pop() || "source";
  const slug = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "source";
  return slug.replace(CONVERTIBLE, "") + ".md";
}

/**
 * If `source` still needs acquiring, return the exact tool calls that put it in
 * the bundle's raw/ without its text passing through the model. Returns null
 * when `source` already names something in raw/ (nothing to acquire).
 *
 * Every step pins `output_path`, because that parameter is the whole mechanism:
 * with it the content streams to the VFS and the tool returns a receipt;
 * without it the content comes back as a tool result and the only way to store
 * it is for the model to re-emit the entire document.
 */
function plannedAcquisition(source, bundle, bundleExists) {
  const isUrl = /^https?:\/\//i.test(source);
  const isAbsPath = source.startsWith("/");
  if (!isUrl && !isAbsPath) return null; // a bare name / raw/ path — already in the bundle

  const staged = `/workspace/okf-staged-${stagedName(source)}`;
  const fetchStep = isUrl
    ? { tool: "web_fetch", args: { url: source, output_path: staged } }
    : CONVERTIBLE.test(source)
      ? { tool: "file_to_markdown", args: { path: source, output_path: staged } }
      : null;

  // A plain text/markdown file already in the VFS needs no conversion at all —
  // hand its own path straight to okf_add_raw_source.
  const sourcePath = fetchStep ? staged : source;
  const steps = [
    ...(bundleExists ? [] : [{ tool: "okf_init_bundle", args: { name: bundle } }]),
    ...(fetchStep ? [fetchStep] : []),
    { tool: "okf_add_raw_source", args: { bundle, sourcePath } },
    { tool: "okf_ingest", args: { bundle, source: "<the rawFile returned by the previous step>" } },
  ];
  return { steps };
}

function makeHandlers(core) {
  return {
    okf_list_bundles: (args, ctx) => core.listBundles(ctx.bundleRoot),
    okf_init_bundle: (args, ctx) => core.initBundle(ctx.bundleRoot, args.name, { title: args.title, description: args.description }),
    okf_bundle_status: (args, ctx) => core.bundleStatus(ctx.bundleRoot, args.bundle),
    okf_import_bundle: (args, ctx) => core.importBundle(ctx.bundleRoot, args.bundle, { files: args.files }),
    okf_export_bundle: (args, ctx) => core.exportBundle(ctx.bundleRoot, args.bundle),
    okf_upsert_concept: (args, ctx) =>
      core.upsertConcept(ctx.bundleRoot, args.bundle, args.id, { title: args.title, body: args.body, frontmatter: args.frontmatter }),
    okf_read_concept: (args, ctx) => core.readConcept(ctx.bundleRoot, args.bundle, args.id),
    okf_delete_concept: (args, ctx) => core.deleteConcept(ctx.bundleRoot, args.bundle, args.id, { rewriteBacklinks: !!args.rewrite_backlinks }),
    okf_delete_bundle: (args, ctx) => core.deleteBundle(ctx.bundleRoot, args.bundle),
    okf_list_concepts: (args, ctx) => core.listConcepts(ctx.bundleRoot, args.bundle, { status: args.status, trust: args.trust }),
    okf_find_concepts: (args, ctx) => core.findConcepts(ctx.bundleRoot, args.bundle, { query: args.query, limit: args.limit }),
    okf_add_link: (args, ctx) => core.addLink(ctx.bundleRoot, args.bundle, args.id, args.target, { label: args.label }),
    okf_remove_link: (args, ctx) => core.removeLink(ctx.bundleRoot, args.bundle, args.id, args.target),
    okf_list_links: (args, ctx) => core.listLinks(ctx.bundleRoot, args.bundle, args.id),
    okf_backlinks: (args, ctx) => core.backlinks(ctx.bundleRoot, args.bundle, args.id),
    okf_neighbors: (args, ctx) => core.neighbors(ctx.bundleRoot, args.bundle, args.id, { depth: args.depth }),
    okf_shortest_path: (args, ctx) => core.shortestPath(ctx.bundleRoot, args.bundle, args.from, args.to),
    okf_export_graph: (args, ctx) => core.exportGraph(ctx.bundleRoot, args.bundle),
    okf_set_status: (args, ctx) => core.setStatus(ctx.bundleRoot, args.bundle, args.id, args.status, { staleAfter: args.staleAfter }),
    okf_get_as_of: (args, ctx) => core.getAsOf(ctx.bundleRoot, args.bundle, args.id, args.asOf),
    okf_stale_report: (args, ctx) => core.staleReport(ctx.bundleRoot, args.bundle),
    okf_set_trust: (args, ctx) => core.setTrust(ctx.bundleRoot, args.bundle, args.id, args.trust),
    okf_add_source: (args, ctx) => core.addSource(ctx.bundleRoot, args.bundle, args.id, args.source),
    okf_attest: (args, ctx) => core.attest(ctx.bundleRoot, args.bundle, args.id, { by: args.by, note: args.note }),
    okf_provenance: (args, ctx) => core.provenance(ctx.bundleRoot, args.bundle, args.id),
    okf_add_raw_source: (args, ctx) =>
      core.ingestRaw(ctx.bundleRoot, args.bundle, {
        filename: args.filename,
        content: args.content,
        sourcePath: args.sourcePath,
        conceptId: args.conceptId,
        title: args.title,
      }),
    // Dispatcher, not a writer. The worker thread runs outside the Next.js
    // process and so cannot invoke agent_delegate itself — it validates that
    // the raw source really exists, resolves the effective crawl limits, and
    // hands back the exact delegation the caller should issue. The calling
    // assistant (which IS in-process) then makes that agent_delegate call.
    okf_ingest: async (args, ctx) => {
      const source = String(args.source || "").trim();
      if (!source) throw new Error("source is required — a URL, a /workspace path, or a raw/ path");
      const maxDepth = Number.isFinite(args.maxDepth) ? args.maxDepth : ctx.ingestDefaults.maxDepth;
      const maxWorkers = Number.isFinite(args.maxWorkers) ? args.maxWorkers : ctx.ingestDefaults.maxWorkers;

      // A URL or an unconverted document can't be acquired HERE — this handler
      // runs in a worker thread outside the Next.js process, with no web_fetch
      // and no file_to_markdown. But it can hand back the exact call sequence,
      // which is strictly better than documenting the recipe and hoping: the
      // caller never has to remember `output_path`, and that single parameter
      // is the difference between the document streaming to disk and the model
      // regenerating the whole thing as output tokens.
      // Missing bundle is planned for, not left to the caller. Previously the
      // first okf_add_raw_source just failed with "bundle not found", the agent
      // had to guess how to create one, guessed okf_import_bundle, and then
      // kept reaching for that wrong tool for the rest of the run.
      const bundleExists = await ctx.vfs.exists(core.safeJoin(ctx.bundleRoot, args.bundle)).catch(() => false);
      const acquisition = plannedAcquisition(source, args.bundle, bundleExists);
      if (acquisition) {
        return {
          status: "acquisition_required",
          instructions:
            "This source is not in the bundle's raw/ yet, and I cannot fetch it from here. " +
            "Run the calls in `steps` IN ORDER, exactly as given — then call okf_ingest again with the raw/ path from step 2. " +
            "Pass `output_path` exactly as specified: it makes the fetch write straight to disk and return only a receipt, " +
            "so the document never enters your context and you never have to reproduce it.",
          steps: acquisition.steps,
          bundle: args.bundle,
          source,
        };
      }

      const rel = source.startsWith("raw/") ? source : `raw/${source}`;
      const bDir = core.safeJoin(ctx.bundleRoot, args.bundle);
      if (!(await ctx.vfs.exists(core.safeJoin(bDir, rel)))) {
        throw new Error(`no such raw source: ${rel} — call okf_add_raw_source first`);
      }
      return {
        status: "delegation_required",
        instructions:
          "Do NOT read the raw source yourself — that would pull its full text into your context, which this flow exists to avoid. " +
          "Instead call agent_delegate with agent='okf-ingest' and the task below.",
        delegate: {
          agent: "okf-ingest",
          task:
            `Ingest the raw source \`${rel}\` in OKF bundle "${args.bundle}" into concepts. ` +
            `Read it from the bundle yourself; do not expect it inline. ` +
            `Follow at most ${maxDepth} hop(s) of references beyond this seed source, ingesting at most ${maxWorkers} reference(s) concurrently ` +
            `(issue that many agent_delegate calls in a single turn — they run in parallel). ` +
            `Skip any reference whose source already appears in the bundle's provenance. ` +
            `Report back only a compact summary: concepts written/updated, references ingested, references skipped (with reason). Never echo the source text.`,
        },
        bundle: args.bundle,
        source: rel,
        maxDepth,
        maxWorkers,
      };
    },
    okf_lint: (args, ctx) => core.lintBundle(ctx.bundleRoot, args.bundle),
    okf_read_index: (args, ctx) => core.readIndex(ctx.bundleRoot, args.bundle),
    okf_read_bundle_schema: (args, ctx) => core.readBundleSchema(ctx.bundleRoot, args.bundle),
    okf_append_log: (args, ctx) => core.appendLog(ctx.bundleRoot, args.bundle, { event: args.event, message: args.message, conceptId: args.conceptId }),
  };
}

module.exports = { DECLARATIONS, makeHandlers };
