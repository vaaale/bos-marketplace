// The item's assistant contract (T054, ADR-1).
//
// Everything the chat needs from BrowserOS goes through this module: the agent
// catalog, starting a run, the run's event stream, frontend tool results, the
// reconnect probe, cancel, the transcript read, and the app-scoped chat index.
// Components and the chat store call in here; nothing else in the app knows
// what the broker looks like.
//
// Two properties are worth stating, because they are the reason this file
// exists rather than a handful of fetches spread through the app:
//
//   * ORIGIN-INDEPENDENCE. The broker is the parent frame making the call on
//     the app's behalf, so it works identically for a same-origin `local` item
//     and an opaque-origin `marketplace` one. A run is a STREAM, which cannot
//     cross postMessage, so the parent owns the NDJSON tail and pushes each
//     event in — `onRunEvent` is the app's end of that push.
//
//   * ERRORS ARE VALUES, NOT THROWS. A broker method resolves with the HTTP
//     body even when the API failed, so a 409's `activeRunId` survives (that is
//     what lets a send re-attach to an in-flight run instead of erroring). The
//     one thing that DOES reject is an ungranted capability — which this module
//     turns into `{ error }` too, so callers have exactly one shape to handle.

import { whenReady } from "../services/bos";
import type { BosApi, BosAssistantApi, BosRunEvent } from "../services/bos";
import type { AgentInfo, ChatPersistence, TranscriptMessage } from "../types";

export type { BosRunEvent as RunEvent };

/** Where BOS keeps conversation files. Server-owned; this app only reads. */
const CHATS_DIR = "/Documents/Chats";

/** The app-storage key holding the app-scoped conversation index. */
export const CHAT_STATE_KEY = "chat-state";

/** The Main Assistant's well-known id. */
export const DEFAULT_AGENT_ID = "assistant";

/** A broker reply: the API body, or `{ error }` when the call could not be made. */
interface Reply {
  error?: string;
  status?: number;
  [key: string]: unknown;
}

async function sdk(): Promise<BosApi> {
  const api = await whenReady();
  if (!api) throw new Error("BrowserOS is not available.");
  return api;
}

/** Resolve the assistant surface, or fail with the reason it is unusable. */
async function assistant(): Promise<BosAssistantApi> {
  const api = await sdk();
  if (!api.assistant) {
    throw new Error('This BrowserOS build does not expose the "assistant" capability.');
  }
  return api.assistant;
}

/** Run a broker call, normalising a rejection into the same `{ error }` shape. */
async function attempt(fn: () => Promise<unknown>): Promise<Reply> {
  try {
    const body = await fn();
    return body && typeof body === "object" ? (body as Reply) : {};
  } catch (err) {
    return { error: (err as Error).message || "The assistant is unavailable." };
  }
}

// ------------------------------------------------------------------ agents

/**
 * The agents the user can pick between: the Main Assistant plus every
 * user-defined agent (`GET /api/assistant/agent`). Throws when the capability
 * is not granted — the caller shows the "Assistant unavailable" state (T083).
 */
export async function listAgents(): Promise<AgentInfo[]> {
  const api = await assistant();
  const body = (await api.listAgents()) as { agents?: unknown; error?: string };
  if (body && typeof body === "object" && typeof body.error === "string") throw new Error(body.error);
  const raw = Array.isArray(body?.agents) ? (body.agents as Record<string, unknown>[]) : [];
  const agents = raw
    .filter((a) => typeof a.id === "string" && a.id)
    .map((a) => ({
      id: String(a.id),
      name: typeof a.name === "string" && a.name.trim() ? a.name : String(a.id),
      description: typeof a.description === "string" ? a.description : undefined,
      type: typeof a.type === "string" ? a.type : undefined,
    }));
  if (agents.length === 0) throw new Error("No assistant agents are registered.");
  // Main Assistant first, then the rest in the order BOS reported them.
  return agents.sort((a, b) => Number(b.id === DEFAULT_AGENT_ID) - Number(a.id === DEFAULT_AGENT_ID));
}

// ------------------------------------------------------------------ runs

export interface StartRunInput {
  conversationId: string;
  agentId: string;
  message: string;
  surfaceTools?: { name: string; description: string; parameters: unknown }[];
}

export interface StartRunResult {
  runId?: string;
  /** Set on a 409: the conversation already has a run in flight — attach to it. */
  activeRunId?: string;
  error?: string;
}

/** Start a run. Never throws; a 409 comes back as `{ activeRunId }` (T085). */
export async function startRun(input: StartRunInput): Promise<StartRunResult> {
  const body = await attempt(async () => (await assistant()).startRun(input));
  return {
    runId: typeof body.runId === "string" ? body.runId : undefined,
    activeRunId: typeof body.activeRunId === "string" ? body.activeRunId : undefined,
    error: typeof body.error === "string" ? body.error : undefined,
  };
}

/**
 * Subscribe to a run's events. The parent replays everything this app has not
 * seen yet, then streams live, so a re-subscribe after a reload resumes at the
 * right cursor instead of losing the run. Resolves with the unsubscribe.
 */
export async function onRunEvent(runId: string, cb: (event: BosRunEvent) => void): Promise<() => void> {
  const api = await assistant();
  return api.onRunEvent(runId, cb);
}

/** Answer a frontend tool call. First claim wins, server-side. */
export async function postToolResult(runId: string, callId: string, result: string): Promise<void> {
  await attempt(async () => (await assistant()).postToolResult(runId, callId, result));
}

/** The conversation's live run, if any — the reconnect probe. */
export async function getActiveRun(conversationId: string): Promise<string | null> {
  const body = await attempt(async () => (await assistant()).getActiveRun(conversationId));
  return typeof body.runId === "string" ? body.runId : null;
}

/** Stop a run. Idempotent, and safe to call for a run that already finished. */
export async function cancelRun(runId: string): Promise<void> {
  await attempt(async () => (await assistant()).cancelRun(runId));
}

// ------------------------------------------------------------------ transcript

export interface Transcript {
  messages: TranscriptMessage[];
  /** The file's own metadata, when present. */
  title?: string;
  agentId?: string;
}

/**
 * Read a conversation's transcript.
 *
 * This is the RAW file, not the sanitized copy the conversations API serves, so
 * a conversation whose last turn was interrupted can end on an unanswered tool
 * call. That is fine here: the render layer only draws user/assistant messages
 * and skips an assistant message with neither text nor tool calls, so an
 * unsettled tail collapses to nothing rather than to a broken bubble.
 *
 * Throws when the file is missing or unreadable — the caller shows
 * "Conversation not found" and drops the stale index entry (T084).
 */
export async function readTranscript(conversationId: string): Promise<Transcript> {
  const api = await sdk();
  const raw = await api.fs.read(`${CHATS_DIR}/${encodePathSegment(conversationId)}.json`);
  if (typeof raw !== "string") throw new Error("Conversation not found");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Conversation file is not readable");
  }
  const file = (parsed ?? {}) as { messages?: unknown; title?: unknown; agentId?: unknown };
  const messages = Array.isArray(file.messages) ? file.messages.filter(isTranscriptMessage) : [];
  return {
    messages,
    title: typeof file.title === "string" ? file.title : undefined,
    agentId: typeof file.agentId === "string" ? file.agentId : undefined,
  };
}

function isTranscriptMessage(value: unknown): value is TranscriptMessage {
  const m = value as TranscriptMessage | null;
  return !!m && typeof m === "object" && typeof m.id === "string" && typeof m.role === "string";
}

/** Conversation ids are app-minted, but never build a path from an unchecked id. */
function encodePathSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

// ------------------------------------------------------------------ chat index

/**
 * Read the app-scoped chat index. Returns null when nothing has been stored yet
 * (a first run) OR when `storage` is not granted — both mean "start fresh",
 * which is the graceful degradation ADR-5 asks for.
 */
export async function readChatState(): Promise<ChatPersistence | null> {
  const raw = await readKey(CHAT_STATE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ChatPersistence>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      version: 2,
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations.filter(isConversation) : [],
      activeConversationId:
        typeof parsed.activeConversationId === "string" ? parsed.activeConversationId : null,
      selectedAgentId:
        typeof parsed.selectedAgentId === "string" && parsed.selectedAgentId
          ? parsed.selectedAgentId
          : DEFAULT_AGENT_ID,
    };
  } catch {
    return null;
  }
}

/** Persist the app-scoped index. Message content is never written here. */
export async function writeChatState(state: ChatPersistence): Promise<void> {
  await writeKey(CHAT_STATE_KEY, JSON.stringify(state));
}

function isConversation(value: unknown): boolean {
  const c = value as { id?: unknown; agentId?: unknown };
  return !!c && typeof c === "object" && typeof c.id === "string" && typeof c.agentId === "string";
}

// ------------------------------------------------------------------ raw KV
//
// The per-app key/value store, with the same localStorage fallback the rest of
// the app uses: `storage` is a separate grant from `assistant`, and a user who
// has revoked it should lose persistence, not the app.

export async function readKey(key: string): Promise<string | null> {
  const api = await whenReady();
  if (api) {
    const value = await api.storage.get(key).catch(() => undefined);
    if (value !== undefined) return value;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function writeKey(key: string, value: string): Promise<void> {
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
