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
    status: (id: string) => Promise<unknown>;
    call: (id: string, path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
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
    try {
      const data = (await window.__bos.services.status(SERVICE_ID)) as { service?: ServiceStatusView };
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

async function call(path: string, init?: RequestInit): Promise<unknown> {
  try {
    const base = await resolveBaseUrl();
    const res = await fetch(new URL(path.replace(/^\//, ""), base).toString(), init);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error) || `${path}: HTTP ${res.status}`);
    return body;
  } catch (err) {
    // Opaque-origin (marketplace) install: the direct fetch above can never
    // succeed (no CORS, by design — docs/dev/apps/services.md §11/§14), so
    // fall back to the window.__bos broker, which performs the SAME call from
    // the trusted same-origin parent frame and relays the result back.
    if (!window.__bos) throw err;
    const method = init?.method ?? "GET";
    const body = init?.body != null ? JSON.parse(String(init.body)) : undefined;
    return window.__bos.services.call(SERVICE_ID, path, { method, body });
  }
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
  runGet: (id: string, runId: string) => call(`workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`),
};
