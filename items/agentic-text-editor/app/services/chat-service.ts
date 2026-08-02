// The bridge between the app's chat pane and the BrowserOS assistant.
//
// BOS runs agent loops on the SERVER (assistant v2): a client POSTs a run, then
// attaches to that run's NDJSON event stream and executes any tool call marked
// `execution: "frontend"`, posting the result back. This module is a small,
// self-contained implementation of exactly that protocol — the app is bundled
// standalone and cannot import BOS's own run client.
//
// The app's twelve agentic_editor_* tools ride along as the run's `surfaceTools`,
// which is what makes them callable by the model for the length of the turn.
//
// NOTE ON TRANSPORT: the run API has no iframe-SDK broker method, so these are
// plain same-origin fetches. That works because a user-authored item is served
// with `origin: "local"` (same-origin sandbox). Every other BOS interaction in
// this app goes through the broker.

import { useEditorStore } from "../state/document-store";
import { TOOL_DECLARATIONS, TOOL_HANDLERS, buildAgentContext, isEditorTool } from "../tools/assistant-tools";

const DEFAULT_AGENT_ID = "assistant";
/** Grace period before answering a frontend tool this app cannot run, so a
 *  BOS surface that *can* run it gets first claim (the server takes the first
 *  result posted for a call). Without it, an unhandled call would hang the run
 *  until the server-side tool timeout. */
const FOREIGN_TOOL_GRACE_MS = 4000;

interface RunEvent {
  type: string;
  seq?: number;
  messageId?: string;
  delta?: string;
  callId?: string;
  name?: string;
  args?: string;
  result?: string;
  execution?: string;
  reason?: string;
  error?: string;
  message?: { id?: string; role?: string; content?: string };
}

let cachedAgentId: string | null = null;

/** Pick the agent this app's chat talks to: the default assistant if present. */
export async function resolveAgentId(): Promise<string> {
  if (cachedAgentId) return cachedAgentId;
  try {
    const res = await fetch("/api/assistant/agent");
    const data = (await res.json()) as { agents?: { id: string; type?: string }[] };
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

async function postToolResult(runId: string, callId: string, result: string): Promise<void> {
  await fetch(`/api/assistant/runs/${encodeURIComponent(runId)}/tool-results`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callId, result }),
  }).catch(() => undefined);
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
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
 * Attach to a run's event stream and pump it into the store until the run
 * finishes. Reconnects with ?since= after a transient drop, the same way BOS's
 * own client does, so a hiccup doesn't strand a live run.
 */
async function attachToRun(runId: string, assistantMessageId: string): Promise<void> {
  const store = useEditorStore.getState();
  let since = 0;
  let boundMessageId: string | null = null;
  let sawText = false;

  for (;;) {
    let finished = false;
    let sawEvent = false;
    try {
      const res = await fetch(`/api/assistant/runs/${encodeURIComponent(runId)}/events?since=${since}`);
      if (res.status === 404 || !res.ok || !res.body) throw new Error(`events stream: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let event: RunEvent;
          try {
            event = JSON.parse(line) as RunEvent;
          } catch {
            continue;
          }
          if (event.type === "ping") continue;
          sawEvent = true;
          if (typeof event.seq === "number") since = Math.max(since, event.seq);

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
            finished = true;
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
          }
        }
      }
    } catch {
      /* fall through to the retry below */
    }
    if (finished) break;
    await new Promise((r) => setTimeout(r, sawEvent ? 500 : 2000));
    const probe = await fetch(`/api/assistant/runs?conversationId=${encodeURIComponent(ensureConversationId())}`)
      .then((r) => r.json() as Promise<{ runId?: string | null }>)
      .catch(() => undefined);
    if (!probe || probe.runId !== runId) {
      if (!sawText) {
        store.updateMessage(assistantMessageId, { content: "Lost connection to the agent run.", error: true });
      }
      break;
    }
  }

  store.updateMessage(assistantMessageId, { streaming: false });
  store.setAgentBusy(false);
}

/** Cancel the in-flight run, if any. */
export async function cancelRun(): Promise<void> {
  const conversationId = useEditorStore.getState().conversationId;
  if (!conversationId) return;
  const probe = await fetch(`/api/assistant/runs?conversationId=${encodeURIComponent(conversationId)}`)
    .then((r) => r.json() as Promise<{ runId?: string | null }>)
    .catch(() => undefined);
  if (!probe?.runId) return;
  await fetch(`/api/assistant/runs/${encodeURIComponent(probe.runId)}/cancel`, { method: "POST" }).catch(() => undefined);
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

  const conversationId = ensureConversationId();
  const agentId = await resolveAgentId();

  const res = await fetch("/api/assistant/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId,
      agentId,
      message: `${buildAgentContext()}\n${trimmed}`,
      surfaceTools: TOOL_DECLARATIONS,
    }),
  }).catch(() => undefined);

  const data = (res ? await res.json().catch(() => ({})) : {}) as { runId?: string; error?: string };
  if (!res || !res.ok || !data.runId) {
    store.updateMessage(reply.id, {
      content: data.error ?? "Could not reach the BrowserOS assistant.",
      streaming: false,
      error: true,
    });
    store.setAgentBusy(false);
    return;
  }

  await attachToRun(data.runId, reply.id);
}
