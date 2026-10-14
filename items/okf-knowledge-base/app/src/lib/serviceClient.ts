// serviceClient.ts — the ONLY app→service path (design.md §8.1, per BOS
// services.md §11 — no invented URL). This mirrors the follow-the-money
// item's serviceClient exactly, because that is the established shape for an
// app facet reaching its OWN bundled service.
//
// Reachability bootstrap:
//   GET /api/services/okf-knowledge-base/config   (same-origin BOS API)
//   -> use ONLY runtime / httpPath / values.{port,host}
//   -> httpBaseUrl = httpPath ? origin+httpPath            (Supervisor proxy)
//                  : protocol//hostname:runtime.port/      (standalone dev)
// `runtime === null` is a transient mid-bind window: poll ~1 s for up to ~15 s
// before treating the service as offline. The port is OS-assigned (config
// `port: 0`), so it is NEVER hardcoded and never cached beyond a restart.
//
// Opaque-origin fallback: when this item is installed from a remote
// marketplace the iframe has no same-origin access to /api/services and no
// CORS on the service's own port, so every call falls back to the parent
// frame's `window.__bos.services` broker (the workflows-item pattern,
// services.md §14). That requires the app's `services:read` capability —
// granted in app.json and documented as a one-time Settings step.
//
// The app only ever reads knowledge: writes stay agent/tool-driven. The four
// mutating calls here (bundle create / import / export / delete) are the
// bundle-management actions the mockup gates behind confirmation dialogs.

import type {
  BundleDetail,
  BundleGraph,
  BundleHealth,
  BundleToc,
  ConceptRead,
  DocToc,
  ExportResult,
  GroupedSearchResult,
  Job,
  LintReport,
  SearchResult,
  StaleRow,
  VocabPage,
} from "./types";

const SERVICE_ID = "okf-knowledge-base";

interface BosServices {
  getConfig: (id: string) => Promise<unknown>;
  status?: (id: string) => Promise<unknown>;
  /** The parent frame performs the request and relays the JSON back — the
   *  only channel an opaque-origin install has to invoke the service. */
  call?: (id: string, path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
}

declare global {
  interface Window {
    __bos?: { services: BosServices };
  }
}

interface ServiceConfig {
  httpPath: string | null;
  port: number | null;
  runtime: { bundleRoot?: string } | null;
}

export class ServiceOfflineError extends Error {
  constructor(message = "The OKF Knowledge Base service is not reachable.") {
    super(message);
    this.name = "ServiceOfflineError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let basePromise: Promise<string | null> | null = null;
let serviceConfig: ServiceConfig | null = null;

async function readConfig(): Promise<ServiceConfig | null> {
  try {
    const res = await fetch(`/api/services/${SERVICE_ID}/config`, { cache: "no-store" });
    if (res.ok) return (await res.json()) as ServiceConfig;
  } catch {
    /* opaque origin / no direct network — try the broker below */
  }
  const broker = window.__bos?.services;
  if (!broker) return null;
  try {
    return (await broker.getConfig(SERVICE_ID)) as ServiceConfig;
  } catch {
    return null;
  }
}

async function resolveBaseOnce(): Promise<string | null> {
  // poll ~1 s for up to ~15 s while runtime is null (the worker is mid-bind)
  for (let attempt = 0; attempt < 15; attempt++) {
    const config = await readConfig();
    if (config) {
      serviceConfig = config;
      if (config.httpPath) return `${location.origin}${config.httpPath}`; // Supervisor-fronted
      if (config.port) return `${location.protocol}//${location.hostname}:${config.port}/`; // standalone
    }
    await sleep(1000);
  }
  return null;
}

export function getServiceBaseUrl(): Promise<string | null> {
  if (!basePromise) {
    basePromise = resolveBaseOnce().then((base) => {
      if (base === null) basePromise = null; // allow a later retry
      return base;
    });
  }
  return basePromise;
}

export function getBundleRoot(): string {
  return serviceConfig?.runtime?.bundleRoot || "/KnowledgeBase";
}

async function viaBroker<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const broker = window.__bos?.services?.call;
  if (!broker) {
    throw new ServiceOfflineError(
      "Cannot reach the OKF Knowledge Base service: no direct network access and no window.__bos services broker. Grant this app the services:read capability in Settings → Apps.",
    );
  }
  return (await broker(SERVICE_ID, path.replace(/^\//, ""), init)) as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await getServiceBaseUrl();
  if (!base) {
    return viaBroker<T>(path, {
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
  }
  let res: Response;
  try {
    res = await fetch(new URL(path.replace(/^\//, ""), base).toString(), { cache: "no-store", ...init });
  } catch {
    // A direct fetch to the service's own port fails from a sandboxed,
    // opaque-origin iframe (no CORS on that surface) — relay through the
    // parent frame rather than surfacing a bare network error.
    return viaBroker<T>(path, {
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
  }
  const body = (await res.json().catch(() => null)) as T & { error?: string };
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

function send<T>(path: string, method: "POST" | "DELETE", body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

// ── typed clients, 1:1 with the §8.3 routes ──────────────────────────────

export function fetchBundles(): Promise<{ bundles: BundleHealth[] }> {
  return request("bundles");
}

/** The declared okf_* surface — so the titlebar badge states the real count
 *  rather than a number baked into the UI that could quietly go stale. */
export function fetchTools(): Promise<{ count: number; tools: { name: string; parallelSafe: boolean }[] }> {
  return request("tools");
}

export function createBundle(name: string, title?: string, description?: string): Promise<BundleHealth> {
  return send("bundles", "POST", { name, title, description });
}

export function fetchBundleDetail(bundle: string): Promise<BundleDetail> {
  return request(`bundles/${encodeURIComponent(bundle)}`);
}

export function deleteBundle(bundle: string): Promise<{ name: string; deleted: boolean }> {
  return send(`bundles/${encodeURIComponent(bundle)}`, "DELETE");
}

/** The bundle's table of contents — a page of documents, newest first (FR-069). */
export function fetchBundleToc(bundle: string, offset = 0, limit = 50): Promise<BundleToc> {
  return request(`bundles/${encodeURIComponent(bundle)}/toc?offset=${offset}&limit=${limit}`);
}

/** A page of the vocabulary, optionally filtered by name (ADR-019). */
export function fetchConcepts(bundle: string, opts: { query?: string; offset?: number; limit?: number } = {}): Promise<VocabPage> {
  const q = new URLSearchParams();
  if (opts.query) q.set("query", opts.query);
  if (opts.offset) q.set("offset", String(opts.offset));
  if (opts.limit) q.set("limit", String(opts.limit));
  return request(`bundles/${encodeURIComponent(bundle)}/concepts?${q}`);
}

export function fetchToc(bundle: string, docId: string): Promise<DocToc> {
  return request(`bundles/${encodeURIComponent(bundle)}/toc/${docId.split("/").map(encodeURIComponent).join("/")}`);
}

export function fetchConcept(bundle: string, id: string): Promise<ConceptRead> {
  return request(`bundles/${encodeURIComponent(bundle)}/concept/${id.split("/").map(encodeURIComponent).join("/")}`);
}

/**
 * The app's search. This hits the route that runs the IDENTICAL
 * `core.search()` the `okf_search` tool runs — one capability, two surfaces
 * (FR-036/FR-043). The app does no client-side matching of its own.
 */
export function search(bundle: string, query: string, limit?: number): Promise<SearchResult> {
  return send(`bundles/${encodeURIComponent(bundle)}/search`, "POST", { query, limit });
}

/** The same search, one row per document with its best chapters beneath. */
export function searchByDocument(bundle: string, query: string, limit?: number): Promise<GroupedSearchResult> {
  return send(`bundles/${encodeURIComponent(bundle)}/search`, "POST", { query, limit, groupBy: "document" });
}

/**
 * Consolidate two concept terms (US6). Runs the same core.mergeConcepts() the
 * `okf_merge_concepts` tool runs: it rewrites every chapter's `concepts`
 * frontmatter that referenced `from`, then the concept index and the affected
 * document TOCs follow from the rebuild.
 */
export function mergeConcepts(
  bundle: string,
  from: string,
  to: string,
): Promise<{ from: string; to: string; chaptersRewritten: string[]; tocsRebuilt: string[]; fromTermRemaining: boolean }> {
  return send(`bundles/${encodeURIComponent(bundle)}/merge`, "POST", { from, to });
}

export function fetchGraph(bundle: string): Promise<BundleGraph> {
  return request(`bundles/${encodeURIComponent(bundle)}/graph`);
}

export function fetchLint(bundle: string): Promise<LintReport> {
  return request(`bundles/${encodeURIComponent(bundle)}/lint`);
}

export function fetchStale(bundle: string): Promise<{ bundle: string; stale: StaleRow[] }> {
  return request(`bundles/${encodeURIComponent(bundle)}/stale`);
}

export function exportBundle(bundle: string): Promise<ExportResult> {
  return request(`bundles/${encodeURIComponent(bundle)}/export`);
}

export function importBundle(
  bundle: string,
  payload: { files?: { path: string; content: string }[]; sourcePath?: string },
): Promise<BundleHealth & { imported: number; indexNeedsRegeneration: boolean; note: string }> {
  return send(`bundles/${encodeURIComponent(bundle)}/import`, "POST", payload);
}

/**
 * Start an ingest run — the app-side AUTO-TRIGGER.
 *
 * POST /jobs runs the same `core.triggerIngest()` the `okf_ingest` tool runs:
 * the service dedups against the bundle's provenance, creates the job, and
 * launches the bundled okf-ingest agent itself. It returns as soon as the job
 * exists, so this resolves in milliseconds while the run proceeds in the
 * background and the Jobs tab picks it up on its next poll.
 *
 * This replaces the old `prepareIngest`, which POSTed to a dispatcher route
 * and got back an `agent_delegate` call for the user to relay to their
 * assistant by hand. The modal no longer tells anyone to go do something.
 */
export function triggerIngest(
  bundle: string,
  source: string,
  opts: { maxDepth?: number; reingest?: boolean } = {},
): Promise<{
  status: "queued" | "already_ingested";
  jobId: string | null;
  bundle: string;
  source: string;
  docId?: string;
  reingestOf?: string;
  note: string;
}> {
  return send("jobs", "POST", { bundle, source, ...opts });
}

/** Re-ingest one document, by id — the service resolves its source from the
 *  bundle's provenance ledger, clears the document when the run starts, and
 *  queues the run like any other. */
export function reingestDocument(bundle: string, docId: string): Promise<{ docId: string; jobId: string; source: string; status: string }> {
  return send(`bundles/${encodeURIComponent(bundle)}/documents/${encodeURIComponent(docId)}/reingest`, "POST");
}

/** Re-ingest every document in a bundle — one queued re-ingest per document,
 *  through the service's run queue (at most maxConcurrentRuns at once). */
export function reingestBundle(bundle: string): Promise<{ bundle: string; jobs: { docId: string; jobId: string }[]; note: string }> {
  return send(`bundles/${encodeURIComponent(bundle)}/reingest`, "POST");
}

export function fetchJobs(): Promise<{ jobs: Job[]; total: number; active: number }> {
  return request("jobs");
}

/**
 * One run's FULL record — including `trajectory`, the captured NDJSON event
 * array the Jobs tab's detail view renders (FR-057/FR-058, ADR-013).
 *
 * This is the only surface that carries the events: `fetchJobs()` (the list
 * the app polls) deliberately reports `trajectoryEvents` as a count instead,
 * so a 3-second poll never drags every run's events across the wire.
 */
export function fetchJob(id: string): Promise<Job> {
  return request(`jobs/${encodeURIComponent(id)}`);
}

/**
 * Stop a queued or running run (FR-050) — the Jobs tab's Cancel button.
 *
 * POST /jobs/<id>/cancel runs the same `core.cancelJob()` the
 * `okf_cancel_job` tool runs: the service aborts the underlying headless run
 * and the job moves to the distinct `cancelled` state. Rejects with the
 * service's own message on 404 (unknown job) or 409 (already terminal).
 */
export function cancelJob(id: string): Promise<Job & { cancelled: boolean; aborted: boolean; note: string }> {
  return send(`jobs/${encodeURIComponent(id)}/cancel`, "POST");
}

/**
 * Remove a finished run's record (FR-051) — the Jobs tab's Delete button.
 *
 * DELETE /jobs/<id> runs the same `core.deleteJob()` the `okf_delete_job`
 * tool runs. It removes the RECORD only: the chapters, index, TOCs and raw/
 * sources the run wrote are untouched. A still-active run is refused (409).
 */
export function deleteJob(id: string): Promise<{ deleted: boolean; jobId: string; note: string }> {
  return send(`jobs/${encodeURIComponent(id)}`, "DELETE");
}

/**
 * Absolute URL for a stored inline asset, so the reader pane can render the
 * thumbnail without reaching /api/fs itself (ADR-008). Returns null when the
 * base URL isn't resolved yet or we're on the broker path, where an <img src>
 * can't be relayed — the pane then falls back to the stored interpretation
 * alone, which is the part that actually carries the knowledge.
 */
export function assetUrl(bundle: string, assetPath: string): string | null {
  if (!resolvedBase) return null;
  const rel = assetPath.replace(/^\/+/, "");
  return new URL(`bundles/${encodeURIComponent(bundle)}/assets/${rel.split("/").map(encodeURIComponent).join("/")}`, resolvedBase).toString();
}

let resolvedBase: string | null = null;
void getServiceBaseUrl().then((b) => {
  resolvedBase = b;
});
