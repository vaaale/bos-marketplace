// The single channel between this app and BrowserOS.
//
// Installed apps run inside a sandboxed iframe and reach BOS through the SDK
// (`window.__bos`), which is injected by /apps/[...slug]. Only the capabilities
// granted in app.json are honoured — this app declares fs:read, fs:write,
// storage, window:title, notify and assistant.
//
// EVERYTHING goes through the SDK, including the assistant: this item is served
// `origin: "marketplace"`, i.e. an opaque-origin sandbox, where a direct fetch to
// /api/* is cross-origin and fails. The `assistant` capability
// (040-assistant-broker-capability) is the supported way for a sandboxed app to
// drive an agent run; see docs/dev/assistant/assistant-broker.md.

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
  /** Requires the "assistant" capability. Every method resolves with the
   *  equivalent HTTP API's body; an API error comes back as `{error, status}`
   *  rather than throwing, and only an UNGRANTED call rejects. `onRunEvent` is
   *  push-based — the parent owns the run's NDJSON stream and relays each event
   *  verbatim — so it must be subscribed to exactly once per run. */
  assistant: {
    listAgents: () => Promise<unknown>;
    startRun: (opts: {
      conversationId: string;
      agentId: string;
      message: string;
      /** JSON-Schema-style declarations; `object` (not Record) so an app can
       *  pass its own precisely-typed schema interface without a cast. */
      surfaceTools?: { name: string; description: string; parameters: object }[];
      attachments?: unknown[];
    }) => Promise<unknown>;
    onRunEvent: (runId: string, cb: (event: { seq: number; type: string; [key: string]: unknown }) => void) => () => void;
    postToolResult: (runId: string, callId: string, result: string) => Promise<unknown>;
    getActiveRun: (conversationId: string) => Promise<unknown>;
    cancelRun: (runId: string) => Promise<unknown>;
  };
}

function sdk(): BosApi | null {
  const w = window as unknown as { __bos?: BosApi };
  return w.__bos ?? null;
}

/** Resolve once the SDK has installed itself (it dispatches `bos:ready`). */
export function whenReady(timeoutMs = 3000): Promise<BosApi | null> {
  if (sdk()) return Promise.resolve(sdk());
  return new Promise((resolve) => {
    const done = (): void => {
      window.removeEventListener("bos:ready", done);
      clearTimeout(timer);
      resolve(sdk());
    };
    const timer = setTimeout(done, timeoutMs);
    window.addEventListener("bos:ready", done);
  });
}

// ---------------------------------------------------------------- assistant

/** The assistant broker, once the SDK is up. Null if the SDK never arrived (a
 *  bare preview outside BOS); an ungranted capability instead rejects per call. */
export async function assistant(): Promise<BosApi["assistant"] | null> {
  const api = await whenReady();
  return api?.assistant ?? null;
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
// Per-app persistent KV. Falls back to localStorage when the capability is
// missing so the app still behaves sensibly in a bare preview.

export async function storageGet(key: string): Promise<string | null> {
  const api = await whenReady();
  if (api) {
    const v = await api.storage.get(key).catch(() => undefined);
    if (v !== undefined) return v;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function storageSet(key: string, value: string): Promise<void> {
  const api = await whenReady();
  if (api) {
    const ok = await api.storage
      .set(key, value)
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* nothing else we can do */
  }
}
