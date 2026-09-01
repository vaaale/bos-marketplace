// The bridge between the app's chat pane and the BrowserOS assistant.
//
// BOS runs agent loops on the SERVER (assistant v2): something starts a run,
// attaches to that run's event stream, and executes any tool call marked
// `execution: "frontend"`, posting the result back. This app does exactly that
// through the iframe SDK's `assistant` capability (040-assistant-broker-
// capability) rather than over direct HTTP: a marketplace item is served
// `origin: "marketplace"`, i.e. an OPAQUE-origin sandbox, so a same-origin
// fetch to /api/assistant/* is cross-origin and gets no CORS headers back.
//
// `window.__bos.assistant` moves that work to the parent, which owns the NDJSON
// tail and PUSHES each event into the iframe. Delivery, ordering and reconnect
// are the parent's problem now — this module only reacts to events.
//
// The app's twelve agentic_editor_* tools ride along as the run's `surfaceTools`,
// which is what makes them callable by the model for the length of the turn.

import { assistant } from "./bos";
import { useEditorStore } from "../state/document-store";
import { TOOL_DECLARATIONS, TOOL_HANDLERS, buildAgentContext, isEditorTool } from "../tools/assistant-tools";

const DEFAULT_AGENT_ID = "assistant";
/** Grace period before answering a frontend tool this app cannot run, so a
 *  BOS surface that *can* run it gets first claim (the server takes the first
 *  result posted for a call). Without it, an unhandled call would hang the run
 *  until the server-side tool timeout. */
const FOREIGN_TOOL_GRACE_MS = 4000;
/** How long a run may go silent before we ask whether it is still alive. The
 *  parent pushes events but has no "stream ended" signal to give us, so a run
 *  that dies without a `run_finished` (evicted from retention, server restart)
 *  would otherwise leave the bubble spinning forever. A run legitimately idles
 *  this long while a slow server-side tool works, hence the re-arm on a probe
 *  that still names our run. */
const IDLE_PROBE_MS = 15000;

/** One run event, relayed verbatim by the parent: `{seq, ts, runId, type, ...}`. */
interface RunEvent {
  type: string;
  seq?: number;
  messageId?: string;
  delta?: string;
  callId?: string;
  name?: string;
  args?: unknown;
  execution?: string;
  reason?: string;
  error?: string;
}

/** The shape of an assistant broker reply we care about: the API's own body, or
 *  `{error, status}` when the call failed (the SDK does not throw for those). */
interface BrokerReply {
  error?: string;
  status?: number;
  runId?: string | null;
  agents?: { id: string; type?: string }[];
}

let cachedAgentId: string | null = null;

/** Pick the agent this app's chat talks to: the default assistant if present. */
export async function resolveAgentId(): Promise<string> {
  if (cachedAgentId) return cachedAgentId;
  try {
    const api = await assistant();
    const data = ((await api?.listAgents()) ?? {}) as BrokerReply;
    const agents = data.agents ?? [];
    const preferred =
      agents.find((a) => a.id === DEFAULT_AGENT_ID) ?? agents.find((a) => a.type === "primary") ?? agents[0];
    cachedAgentId = preferred?.id ?? DEFAULT_AGENT_ID;
  } catch {
    cachedAgentId = DEFAULT_AGENT_ID;
  }
  return cachedAgentId;
}

/** The conversation this app instance owns — created once, then persisted. */
export function ensureConversationId(): string {
  const state = useEditorStore.getState();
  if (state.conversationId) return state.conversationId;
  const id = `agentic-editor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  state.setConversationId(id);
  return id;
}

/** The conversation's live run, or undefined if the question could not be asked. */
async function probeActiveRun(conversationId: string): Promise<BrokerReply | undefined> {
  const api = await assistant();
  if (!api) return undefined;
  return (await api.getActiveRun(conversationId).catch(() => undefined)) as BrokerReply | undefined;
}

async function postToolResult(runId: string, callId: string, result: string): Promise<void> {
  const api = await assistant();
  await api?.postToolResult(runId, callId, result).catch(() => undefined);
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Short human label for the tool chip shown under an agent message. */
function summarize(name: string, args: Record<string, unknown>): string {
  const short = name.replace("agentic_editor_", "").replace(/_/g, " ");
  const target = typeof args.path === "string" ? args.path : typeof args.filename === "string" ? args.filename : "";
  return target ? `${short} · ${target}` : short;
}

function dispatchToolCall(runId: string, event: RunEvent, assistantMessageId: string): void {
  const name = event.name ?? "";
  const callId = event.callId ?? "";
  if (!callId) return;
  const args = parseArgs(event.args);

  if (!isEditorTool(name)) {
    // Somebody else's frontend tool (a BOS global action, an elicitation card).
    // Let a real BOS surface answer it; only if nobody does, unblock the run.
    setTimeout(() => {
      void postToolResult(
        runId,
        callId,
        JSON.stringify({
          ok: false,
          error: `"${name}" is not available from the Agentic Text Editor chat. Only agentic_editor_* tools and server-side tools can be used here.`,
        }),
      );
    }, FOREIGN_TOOL_GRACE_MS);
    return;
  }

  const store = useEditorStore.getState();
  store.updateMessage(assistantMessageId, {
    toolCalls: [
      ...(store.messages.find((m) => m.id === assistantMessageId)?.toolCalls ?? []),
      { name, summary: summarize(name, args) },
    ],
  });

  const handler = TOOL_HANDLERS[name];
  void Promise.resolve()
    .then(() => (handler ? handler(args) : JSON.stringify({ ok: false, error: `Unknown tool "${name}".` })))
    .catch((err: Error) => JSON.stringify({ ok: false, error: err.message }))
    .then((result) => postToolResult(runId, callId, result));
}

/**
 * Subscribe to a run and pump its events into the store until it finishes.
 *
 * `onRunEvent` is called ONCE per run: the parent holds a single tail per run,
 * replays whatever this iframe has not seen yet, then streams live — so there
 * is no retry loop, no cursor and no reconnect logic to keep here. What is left
 * is the watchdog: a run that disappears without a `run_finished` is detected by
 * asking the parent whether it is still the conversation's active run.
 */
function streamRun(
  runId: string,
  assistantMessageId: string,
  conversationId: string,
  api: NonNullable<Awaited<ReturnType<typeof assistant>>>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const store = useEditorStore.getState();
    let boundMessageId: string | null = null;
    let sawText = false;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      unsubscribe();
      store.updateMessage(assistantMessageId, { streaming: false });
      store.setAgentBusy(false);
      resolve();
    };

    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void checkAlive(), IDLE_PROBE_MS);
    };

    const checkAlive = async (): Promise<void> => {
      if (settled) return;
      const probe = await probeActiveRun(conversationId);
      if (settled) return;
      // Could not ask (transient) — keep waiting rather than killing a live run.
      if (!probe || typeof probe.error === "string") {
        armIdle();
        return;
      }
      if (probe.runId === runId) {
        armIdle();
        return;
      }
      // The run is gone and never said so: it finished out of retention or the
      // server restarted mid-turn. Whatever text arrived stands.
      if (!sawText) {
        store.updateMessage(assistantMessageId, { content: "Lost connection to the agent run.", error: true });
      }
      finish();
    };

    unsubscribe = api.onRunEvent(runId, (raw) => {
      if (settled) return;
      const event = raw as RunEvent;
      armIdle();

      if (event.type === "text_delta" && event.delta) {
        // A step can produce several assistant messages; keep everything in
        // the one bubble this turn owns, separated by a blank line.
        if (boundMessageId && event.messageId && event.messageId !== boundMessageId) {
          store.appendToMessage(assistantMessageId, "\n\n");
        }
        boundMessageId = event.messageId ?? boundMessageId;
        store.appendToMessage(assistantMessageId, event.delta);
        sawText = true;
      } else if (event.type === "tool_call" && event.execution === "frontend") {
        dispatchToolCall(runId, event, assistantMessageId);
      } else if (event.type === "run_finished") {
        if (event.reason === "error") {
          store.updateMessage(assistantMessageId, {
            content: event.error ?? "The agent run failed.",
            error: true,
          });
        } else if (event.reason === "cancelled" && !sawText) {
          store.updateMessage(assistantMessageId, { content: "Cancelled.", error: true });
        } else if (!sawText) {
          store.updateMessage(assistantMessageId, { content: "(no reply)" });
        }
        finish();
      }
    });

    armIdle();
  });
}

/** Cancel the in-flight run, if any. */
export async function cancelRun(): Promise<void> {
  const conversationId = useEditorStore.getState().conversationId;
  if (!conversationId) return;
  const api = await assistant();
  if (!api) return;
  const probe = await probeActiveRun(conversationId);
  if (!probe?.runId) return;
  await api.cancelRun(probe.runId).catch(() => undefined);
}

/**
 * Send a chat message. The user sees exactly what they typed; the agent also
 * receives the tab context block in front of it (T025), regenerated per send so
 * a tab switch is reflected without any extra bookkeeping (T038).
 */
export async function sendChatMessage(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const store = useEditorStore.getState();
  if (store.agentBusy) return;

  const active = store.getActiveDocument();
  store.addMessage({ role: "user", content: trimmed, relatedDocumentId: active?.id });
  const reply = store.addMessage({ role: "agent", content: "", streaming: true, relatedDocumentId: active?.id });
  store.setAgentBusy(true);

  const failWith = (message: string): void => {
    store.updateMessage(reply.id, { content: message, streaming: false, error: true });
    store.setAgentBusy(false);
  };

  const conversationId = ensureConversationId();
  const api = await assistant();
  if (!api) {
    failWith("Could not reach the BrowserOS assistant.");
    return;
  }
  const agentId = await resolveAgentId();

  // An ungranted `assistant` capability rejects here; an API failure resolves
  // with `{error, status}` instead, so both shapes end up as one message.
  const started = (await api
    .startRun({
      conversationId,
      agentId,
      message: `${buildAgentContext()}\n${trimmed}`,
      surfaceTools: TOOL_DECLARATIONS,
    })
    .catch((err: Error) => ({ error: err.message }))) as BrokerReply;

  if (typeof started?.runId !== "string" || !started.runId) {
    failWith(started?.error ?? "Could not reach the BrowserOS assistant.");
    return;
  }

  await streamRun(started.runId, reply.id, conversationId, api);
}
