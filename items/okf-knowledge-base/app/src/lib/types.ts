// types.ts — the wire shapes of the service's app-facing REST surface
// (design.md §8.3). These mirror what services/lib/http-bridge.js returns;
// nothing here is invented client-side.

export interface BundleHealth {
  name: string;
  docs: number;
  chapters: number;
  conceptTerms: number;
  stale: number;
  deprecated: number;
  status: "healthy" | "attention";
  indexGeneratedAt: string | null;
  indexNeedsRegeneration: boolean;
  checkedAt: string;
}

/** The honest "where did this come from" target (FR-043). */
export interface ConceptSource {
  kind: "url" | "raw";
  target: string;
}

export interface CoverRow {
  docId: string;
  docTitle: string;
  chId: string;
  chTitle: string;
  description: string;
  status: string;
  stale: boolean;
}

export interface ConceptTerm {
  name: string;
  count: number;
  covers: CoverRow[];
  stale: boolean;
}

export interface DocumentRow {
  id: string;
  title: string;
  summary: string;
  chapters: number;
  conceptRefs: number;
  updated: string | null;
  needsAttention: boolean;
  source: ConceptSource | null;
}

export interface BundleDetail {
  health: BundleHealth;
  documents: DocumentRow[];
  conceptIndex: ConceptTerm[];
  indexGeneratedAt: string | null;
}

export interface TocChapter {
  id: string;
  title: string;
  summary: string;
  concepts: string[];
  status: string;
}

export interface DocToc {
  docId: string;
  docTitle: string;
  chapters: TocChapter[];
  indexGeneratedAt: string | null;
  artifact: string;
}

/** A stored inline-asset block: the link AND the interpretation (FR-023). */
export interface InlineAsset {
  path: string;
  caption: string;
  kind: "image" | "video" | "audio";
  interpretation: string;
  interpretationAvailable: boolean;
}

export interface ConceptRead {
  id: string;
  type: "document" | "section" | "concept";
  frontmatter: Record<string, unknown>;
  body: string;
  links: string[];
  assets: InlineAsset[];
  source: ConceptSource | null;
}

/** One row of okf_search's output — identical on both surfaces (FR-036). */
export interface SearchRow {
  docId: string;
  docTitle: string;
  chId: string;
  chTitle: string;
  description: string;
  matchedConcept: string;
  status: string;
  stale: boolean;
}

export type GraphNodeType = "doc" | "chap" | "concept";
export type GraphEdgeKind = "containment" | "coverage" | "link";

export interface GraphNode {
  /** Unique across the graph: `<type>:<id>`. The semantic `id` below is NOT
   *  unique — a document and a concept term can share one (FR-045). Key every
   *  lookup, DOM id and React key off `key`, never off `id`. */
  key: string;
  id: string;
  type: GraphNodeType;
  label: string;
  description?: string;
  count?: number;
  docId?: string;
  chId?: string;
  status?: string;
}

export interface GraphEdge {
  /** Endpoint node `key`s, not semantic ids. */
  from: string;
  to: string;
  kind: GraphEdgeKind;
  label: string;
}

export interface BundleGraph {
  bundle: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  indexGeneratedAt: string | null;
}

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobSummary {
  chapters: number;
  concepts: number;
  assets: number;
  refsSkipped: number;
  refsFailed: number;
  written?: string[];
  /** The agent's own final message, verbatim. The counts above are read out
   *  of it where it states them plainly; this is the authority when they
   *  read 0 because the agent phrased something differently. */
  text?: string;
  /** How many tool calls the run made — a floor on what it actually did,
   *  independent of what it said about itself. */
  toolCalls?: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  bundleId: string;
  source: string;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  progress: string | null;
  summary: JobSummary | null;
  error: string | null;
}

export interface LintReport {
  bundle: string;
  documents: number;
  chapters: number;
  conceptTerms: number;
  checks: {
    conceptIndexDrift: number;
    documentTocDrift: number;
    brokenInlineAssets: number;
    orphanChapters: number;
    linksDrift: number;
  };
  rebuilt: boolean;
  indexNeedsRegeneration: boolean;
  errors: { check: string; conceptId?: string; docId?: string; issue: string }[];
  warnings: { check: string; conceptId?: string; docId?: string; issue: string }[];
  checkedAt: string;
}

export interface StaleRow {
  id: string;
  docId: string;
  title: string;
  docTitle: string;
  status: string;
  reason: string;
  staleAfter: string | null;
  daysStale: number | null;
}

export interface ExportResult {
  name: string;
  files: { path: string; content: string }[];
  assets: { path: string; bytes: number | null; contentType: string }[];
  conceptIndexIncluded: boolean;
  tocsIncluded: number;
}
