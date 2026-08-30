// The single channel between this app and BrowserOS.
//
// Installed apps run inside a sandboxed iframe and reach BOS through the SDK
// (`window.__bos`), which is injected by /apps/[...slug]. Only the capabilities
// granted in app.json are honoured — this app declares assistant, storage,
// fs:read, fs:write, window:title and notify.
//
// THIS MODULE IS THE ONLY PLACE THAT RESOLVES `window.__bos` (v2, ADR-1). v1
// drove the assistant over same-origin `fetch`, which only works while the item
// is served `origin: "local"`; v2 goes through the `assistant` broker capability
// instead, so the chat keeps working if the item is ever re-served
// opaque-origin from a marketplace. The assistant contract itself lives in one
// module on top of this one — `assistant/client.ts` — and nothing else in the
// app talks to the SDK.

import type { VfsEntry } from "../types-vfs";

interface BosApi {
  fs: {
    list: (path: string) => Promise<unknown>;
    read: (path: string) => Promise<unknown>;
    write: (path: string, content: string) => Promise<unknown>;
    delete: (path: string) => Promise<unknown>;
  };
  settings: { get: () => Promise<unknown> };
  window: { setTitle: (title: string) => Promise<unknown> };
  notify: (message: string, opts?: Record<string, unknown>) => Promise<unknown>;
  storage: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<unknown>;
    remove: (key: string) => Promise<unknown>;
    keys: () => Promise<string[]>;
  };
  /**
   * The `assistant` broker capability (BOS feature 040). Every method resolves
   * with the equivalent HTTP API's body — on an API error the body carries
   * `error`/`status` rather than throwing, so structured detail (a 409's
   * `activeRunId`) survives. An UNGRANTED call rejects; see assistant/client.ts,
   * which is the only consumer.
   */
  assistant?: BosAssistantApi;
}

export interface BosAssistantApi {
  listAgents: () => Promise<unknown>;
  startRun: (opts: BosStartRunOptions) => Promise<unknown>;
  onRunEvent: (runId: string, cb: (event: BosRunEvent) => void) => () => void;
  postToolResult: (runId: string, callId: string, result: string) => Promise<unknown>;
  getActiveRun: (conversationId: string) => Promise<unknown>;
  cancelRun: (runId: string) => Promise<unknown>;
}

/** Mirrors the SDK's `StartRunOptions`. */
export interface BosStartRunOptions {
  conversationId: string;
  agentId: string;
  message: string;
  surfaceTools?: { name: string; description: string; parameters: unknown }[];
}

/** One run event, relayed verbatim from the server's own log. */
export interface BosRunEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

export type { BosApi };

function sdk(): BosApi | null {
  const w = window as unknown as { __bos?: BosApi };
  return w.__bos ?? null;
}

/** How often to re-check for `window.__bos` while waiting for it. */
const READY_POLL_MS = 40;

/** Memoised once the SDK is found — after that `whenReady` is a plain lookup. */
let resolved: BosApi | null = null;

/**
 * Resolve once the SDK has installed itself.
 *
 * BOS inlines the SDK into the app document's <head>, so in practice `__bos`
 * already exists by the time this module's first caller runs. But that is a
 * property of the SERVING route, not a contract this app can lean on: a preview
 * harness, a slow inline script, or a future async injection would all leave a
 * window where it is absent. Waiting on `bos:ready` ALONE is not enough either
 * — that event fires exactly once, at install time, so a listener attached
 * afterwards never hears it and would wait out the whole timeout for an SDK
 * that is already sitting there.
 *
 * So this both listens for the event AND polls, and returns as soon as either
 * says yes. Callers must still handle `null`: "no SDK at all" is a real state
 * (a bare browser preview), just never a state we should INVENT by giving up
 * on an SDK that simply arrived a tick late — that mistake is what latches the
 * chat into its degraded state for the rest of the session.
 */
export function whenReady(timeoutMs = 3000): Promise<BosApi | null> {
  if (resolved) return Promise.resolve(resolved);
  const now = sdk();
  if (now) {
    resolved = now;
    return Promise.resolve(now);
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      window.removeEventListener("bos:ready", onReady);
      clearInterval(poll);
      clearTimeout(timer);
      resolved = sdk();
      resolve(resolved);
    };
    const check = (): void => {
      if (sdk()) finish();
    };
    const onReady = (): void => finish();
    const poll = setInterval(check, READY_POLL_MS);
    const timer = setTimeout(finish, timeoutMs);
    window.addEventListener("bos:ready", onReady);
  });
}

// ---------------------------------------------------------------- VFS

/** List a VFS directory. Throws with a readable message on failure. */
export async function vfsList(path: string): Promise<VfsEntry[]> {
  const api = await whenReady();
  if (!api) throw new Error("BrowserOS file access is unavailable.");
  const entries = await api.fs.list(path);
  if (!Array.isArray(entries)) throw new Error(`Cannot list ${path}`);
  return entries as VfsEntry[];
}

/** Read a text file from the VFS. */
export async function vfsRead(path: string): Promise<string> {
  const api = await whenReady();
  if (!api) throw new Error("BrowserOS file access is unavailable.");
  const content = await api.fs.read(path);
  if (typeof content !== "string") throw new Error(`Cannot read ${path}`);
  return content;
}

/** Write a text file to the VFS (creates or overwrites). */
export async function vfsWrite(path: string, content: string): Promise<void> {
  const api = await whenReady();
  if (!api) throw new Error("BrowserOS file access is unavailable.");
  const res = (await api.fs.write(path, content)) as { error?: string } | undefined;
  if (res && typeof res.error === "string") throw new Error(res.error);
}

// ---------------------------------------------------------------- misc

export async function setWindowTitle(title: string): Promise<void> {
  const api = await whenReady();
  await api?.window.setTitle(title).catch(() => undefined);
}

export async function notify(message: string): Promise<void> {
  const api = await whenReady();
  await api?.notify(message).catch(() => undefined);
}

// ---------------------------------------------------------------- storage
//
// Per-app persistent KV, with a localStorage fallback.
//
// `storage` is a SEPARATE grant from `assistant`, and BOS does not re-seed an
// item's grant file on reinstall — so an item whose manifest asks for both can
// perfectly well be running with only one of them. Persistence therefore has to
// degrade on its own: losing `storage` costs the user durable state, never a
// working chat, and NOTHING in here may ever report a failure that the chat's
// availability check can see.
//
// The first rejection is remembered. Without that, every keystroke-driven
// snapshot write would fire another doomed broker call and log another
// unhandled-looking rejection for the life of the session.

let storageGranted: boolean | null = null;

/** False once a storage call has been refused — the app is on localStorage. */
export function isStoragePersistent(): boolean {
  return storageGranted !== false;
}

export async function storageGet(key: string): Promise<string | null> {
  const api = await whenReady();
  if (api && storageGranted !== false) {
    const v = await api.storage.get(key).catch(() => undefined);
    if (v !== undefined) {
      storageGranted = true;
      return v;
    }
    storageGranted = false;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function storageSet(key: string, value: string): Promise<void> {
  const api = await whenReady();
  if (api && storageGranted !== false) {
    const ok = await api.storage
      .set(key, value)
      .then(() => true)
      .catch(() => false);
    storageGranted = ok;
    if (ok) return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* nothing else we can do */
  }
}
