// bridge.ts — resolves the Workflow Manager service's REST bridge (see
// services/http-bridge.js) and calls it. This is a companion UI to its OWN
// bundled service, so the pattern mirrors Terminal's (docs/dev/apps/
// services.md §12): try a direct, same-origin fetch first (works when this
// item is installed from the LOCAL marketplace, the common case — origin
// "local"), falling back to the window.__bos broker's "services:read"
// capability only if the direct call fails (opaque-origin / remote-
// marketplace install). Every call also prefers the server-provided
// wsPath/httpPath (Supervisor-fronted deployments) over a direct host:port
// connection to the service's own port (§11) — never hardcode a port.

interface BosApi {
  services: {
    getConfig: (id: string) => Promise<unknown>;
    /** Mirrors GET /api/services/<id> for an opaque-origin install. */
    status?: (id: string) => Promise<unknown>;
    /** 043: the parent frame performs the request against the service's own
     *  REST bridge and relays the JSON back — the ONLY channel an
     *  opaque-origin install has to actually invoke the service. */
    call?: (id: string, path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
  };
}

declare global {
  interface Window {
    __bos?: BosApi;
  }
}

const SERVICE_ID = "workflows";

interface ServiceConfig {
  runtime: { port: number; host: string } | null;
  httpPath: string | null;
  wsPath: string | null;
}

interface ServiceStatusView {
  state: string;
}

let cachedBaseUrl: string | null = null;
let cachedBaseUrlAt = 0;
const BASE_URL_TTL_MS = 15000; // the bound port can change across a service restart

async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function getServiceConfig(): Promise<ServiceConfig> {
  try {
    return (await fetchJson(`/api/services/${SERVICE_ID}/config`)) as ServiceConfig;
  } catch {
    if (!window.__bos) throw new Error("cannot reach BOS: no direct network access and no window.__bos broker available");
    return (await window.__bos.services.getConfig(SERVICE_ID)) as ServiceConfig;
  }
}

export async function getServiceRunning(): Promise<boolean> {
  try {
    const data = (await fetchJson(`/api/services/${SERVICE_ID}`)) as { service?: ServiceStatusView };
    return data.service?.state === "running";
  } catch {
    if (!window.__bos) return false;
    const statusFn = window.__bos.services.status;
    if (!statusFn) return false;
    try {
      const data = (await statusFn(SERVICE_ID)) as { service?: ServiceStatusView };
      return data.service?.state === "running";
    } catch {
      return false;
    }
  }
}

async function resolveBaseUrl(): Promise<string> {
  const now = Date.now();
  if (cachedBaseUrl && now - cachedBaseUrlAt < BASE_URL_TTL_MS) return cachedBaseUrl;

  const config = await getServiceConfig();
  let base: string;
  if (config.httpPath) {
    base = `${window.location.origin}${config.httpPath}`;
  } else if (config.runtime?.port) {
    base = `${window.location.protocol}//${window.location.hostname}:${config.runtime.port}/`;
  } else {
    throw new Error("Workflow Manager service has no bound port yet — is it running?");
  }
  cachedBaseUrl = base.endsWith("/") ? base : `${base}/`;
  cachedBaseUrlAt = now;
  return cachedBaseUrl;
}

async function callViaBroker(path: string, init?: RequestInit): Promise<unknown> {
  const broker = window.__bos?.services?.call;
  if (!broker) throw new Error("cannot reach the Workflow Manager service: no direct network access and no window.__bos services broker");
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  return broker(SERVICE_ID, path.replace(/^\//, ""), { method: init?.method || "GET", body });
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  let base: string;
  try {
    base = await resolveBaseUrl();
  } catch {
    // No reachable config (opaque-origin sandbox) — the broker is the fallback.
    return callViaBroker(path, init);
  }
  let res: Response;
  try {
    res = await fetch(new URL(path.replace(/^\//, ""), base).toString(), init);
  } catch {
    // A direct fetch to the service's own port fails from a sandboxed,
    // opaque-origin iframe (no CORS on that surface) — relay through the
    // parent frame instead of surfacing a bare network error.
    return callViaBroker(path, init);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `${path}: HTTP ${res.status}`);
  return body;
}

export const api = {
  list: () => call("workflows"),
  read: (id: string) => call(`workflows/${encodeURIComponent(id)}`),
  create: (body: { workflow?: unknown; taskDescription?: string }) =>
    call("workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  modify: (id: string, changes: unknown) =>
    call(`workflows/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }) }),
  delete: (id: string) => call(`workflows/${encodeURIComponent(id)}`, { method: "DELETE" }),
  run: (id: string, opts?: { featureBranch?: string; conversationId?: string }) =>
    call(`workflows/${encodeURIComponent(id)}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts || {}) }),
  cancel: (id: string) => call(`workflows/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  status: (id: string) => call(`workflows/${encodeURIComponent(id)}/status`),
  export: (id: string) => call(`workflows/${encodeURIComponent(id)}/export`),
  validate: (id: string) => call(`workflows/${encodeURIComponent(id)}/validate`, { method: "POST" }),
  runList: (id: string) => call(`workflows/${encodeURIComponent(id)}/runs`),
  /**
   * US17/FR-044 — the event types BOS's kernel currently has handlers for,
   * used by the Triggers panel's "Browse" picker. This is the SAME
   * `workflow_event_types` handler the assistant calls, exposed on the
   * service's REST bridge (services/http-bridge.js `GET /event-types`).
   */
  eventTypes: () => call("event-types"),
  runGet: (id: string, runId: string, since?: number) =>
    call(`workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}${since ? `?since=${since}` : ""}`),
  /**
   * US19 — bulk-delete persisted run logs (the workflow definition is never
   * touched). Same `workflow_run_delete` handler the assistant's tool calls
   * reach, exposed as POST /workflows/<id>/runs/delete on the service's own
   * REST bridge. Through `call()` this rides the app's existing invoke channel
   * (direct fetch, or the window.__bos services broker under `services:read`)
   * — the app deliberately holds no fs:write capability.
   */
  runDelete: (id: string, runIds: string[]) =>
    call(`workflows/${encodeURIComponent(id)}/runs/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runIds }),
    }),
  /**
   * The service's live run projection, addressed by runId alone
   * (services/engine/run-state.js + http-bridge.js's GET /run/<runId>). This
   * is the single source of truth the trajectory panel tails: `since` is the
   * monotonic event seq from the previous poll, so a long run stays cheap.
   * `workflowId` lets the service fall back to the persisted log once the run
   * has aged out of memory — which is also how a HISTORICAL run replays.
   */
  runLive: (runId: string, opts?: { since?: number; workflowId?: string }) => {
    const params = new URLSearchParams();
    if (opts?.since) params.set("since", String(opts.since));
    if (opts?.workflowId) params.set("workflowId", opts.workflowId);
    const query = params.toString();
    return call(`run/${encodeURIComponent(runId)}${query ? `?${query}` : ""}`);
  },
};
