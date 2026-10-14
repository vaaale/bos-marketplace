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
  /** `person` for a salient person (author / named key figure) the service
   *  derived from `person_terms` frontmatter; `topic` otherwise. Optional on
   *  the wire: a pre-person-kind index carries no `kind` (ADR-011 S4). */
  kind?: TermKind;
  count: number;
  covers: CoverRow[];
  stale: boolean;
}

/** A concept term's kind (ADR-011). Absent on a legacy index = `topic`. */
export type TermKind = "topic" | "person";

/** One entry of the bundle's table of contents (FR-069, ADR-017). */
export interface BundleTocEntry {
  id: string;
  title: string;
  chapters: number;
  summary: string;
  /** When the document was FIRST added to the bundle (the TOC's order). */
  addedAt: string | null;
  /** Any chapter stale or deprecated. */
  attention: boolean;
}

/** A page of results — every list the app shows is bounded by one (NFR-011). */
export interface Paged {
  total: number;
  offset: number;
  limit: number;
  clamped?: boolean;
  maxLimit?: number;
}

export interface BundleToc extends Paged {
  bundle: string;
  documents: BundleTocEntry[];
}

/** One vocabulary term on a page of okf_list_concepts (ADR-019). */
export interface VocabTerm {
  term: string;
  kind: TermKind;
  count: number;
  /** At most 5 of the chapters it covers; `coversTotal` is how many. */
  covers: { docId: string; docTitle: string; chId: string; title: string; description: string; status: string; stale: boolean }[];
  coversTotal: number;
}

export interface VocabPage extends Paged {
  terms: VocabTerm[];
  indexGeneratedAt?: string | null;
}

/** The bundle detail is counts only — each tab pages its own list (ADR-021). */
export interface BundleDetail {
  health: BundleHealth;
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

/** What made a search hit a hit (ADR-018). */
export type MatchKind = "term" | "person" | "title" | "summary" | "text";

/** One hit of okf_search — identical on both surfaces (FR-036). A
 *  document-level hit has `chId: ""`. */
export interface SearchRow {
  docId: string;
  docTitle: string;
  chId: string;
  chTitle: string;
  description: string;
  /** The term that matched; on a non-term match, the chapter's own term (as
   *  a description match always was). Null for a concept with no terms. */
  matchedConcept: string | null;
  kind: TermKind | null;
  status: string;
  stale: boolean;
  matchKind: MatchKind;
  matchedWords: string[];
  /** Where a full-text match is — at most three sentences. Not the content. */
  excerpt?: string;
}

export interface SearchGroup {
  docId: string;
  docTitle: string;
  total: number;
  hits: SearchRow[];
}

interface SearchMeta {
  count: number;
  total: number;
  searched: string[];
  clamped?: boolean;
  maxLimit?: number;
}
export type SearchResult = SearchMeta & { rows: SearchRow[] };
export type GroupedSearchResult = SearchMeta & { groups: SearchGroup[] };

export type GraphNodeType = "doc" | "chap" | "concept" | "person";
export type GraphEdgeKind = "containment" | "coverage" | "link";

export interface GraphNode {
  /** The NAMESPACED key — `doc:…`, `chap:…`, `concept:…`, `person:…` — so a
   *  document and a term with the same name are two nodes (FR-073(f)). Edges
   *  reference it. Map back to content through docId / chId / term. */
  id: string;
  key?: string;
  /** A term node's name (original case). */
  term?: string;
  type: GraphNodeType;
  label: string;
  description?: string;
  count?: number;
  docId?: string;
  chId?: string;
  status?: string;
}

export interface GraphEdge {
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

/** `cancelled` is TERMINAL and is NOT a failure (FR-050) — an intentional
 *  stop, which is why a cancelled job carries `error: null`. */
export type JobStatus = "queued" | "running" | "completed" | "cancelled" | "failed";

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

/**
 * One line of the run's NDJSON stream, stored verbatim by the launcher
 * (FR-057, ADR-013). The shape is open on purpose: the delegate endpoint is
 * allowed to add event kinds, and the renderer matches on `type` and ignores
 * what it does not know rather than failing on it.
 *
 * The wire type for a tool call is **`tool`** — not `tool_call` — and a
 * `tool` line is paired with the `tool_result` that follows it POSITIONALLY:
 * there is no `callId` to correlate them by.
 */
export interface TrajectoryEvent {
  type: string;
  /** `tool` events: the tool's name. */
  tool?: string;
  /** `tool` events: the arguments it was called with. */
  input?: unknown;
  /** `tool_result` events, and `done` (where it carries `endedReason`). */
  result?: unknown;
  /** `done` / `final_text`: the run's final output. */
  text?: string;
  /** `error`: the message the run threw. */
  error?: unknown;
  message?: unknown;
  /** `run_started`. */
  runId?: string;
  agent?: string;
  at?: string;
  [key: string]: unknown;
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
  /** The headless run's id, captured from its `run_started` event (FR-052).
   *  Null until the run names itself — the window `cancelRequested` covers. */
  runId?: string | null;
  /** A cancel that arrived before the runId existed; the launcher fires the
   *  abort as soon as it has the handle. */
  cancelRequested?: boolean;
  /** The run's captured NDJSON stream, in order (FR-057, ADR-013).
   *
   *  Present on the DETAIL read (`GET /jobs/<id>` / `fetchJob`) only. The
   *  list (`GET /jobs`) projects it away and reports `trajectoryEvents`
   *  instead, because the list is polled every few seconds and a run's events
   *  are tens of kilobytes. An empty array means the run produced no events
   *  at all — the one case the "No trajectory captured" note describes. */
  trajectory?: TrajectoryEvent[];
  /** How many events the run captured. On every list row; the array itself
   *  comes from the detail read. */
  trajectoryEvents?: number;
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
