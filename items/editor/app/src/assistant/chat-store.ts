// The chat pane's state (T060 / T072).
//
// v1 kept the transcript in this app and persisted it. v2 does the opposite:
// the transcripts are SERVER-owned files (`/Documents/Chats/<id>.json`) and
// this store holds only
//
//   * an INDEX of the conversations this app started (ids, titles, agent
//     bindings, timestamps) — persisted under one key, never any message text;
//   * which conversation and which agent are active — persisted, so both come
//     back after a restart (FR-023 / FR-024);
//   * the transcripts it has read, and the run it is currently watching —
//     both purely in memory, re-read on demand.
//
// Keeping the index app-minted (`ate-…`) is what makes the conversation
// dropdown app-scoped by construction: it lists ids this app created, so a
// conversation started from BOS's own chat can never appear in it, and this app
// never has to enumerate — or guess about — the shared chats directory.

import { create } from "zustand";
import * as client from "./client";
import { emptyProjection, mergeTranscript, projectRunEvent, runningCallIds } from "./run-projector";
import type { RunProjection } from "./run-projector";
import { STATE_KEY as EDITOR_STATE_KEY } from "../state/document-store";
import {
  TOOL_DECLARATIONS,
  TOOL_HANDLERS,
  buildAgentContext,
  isEditorTool,
  stripAgentContext,
} from "../tools/assistant-tools";
import type { AgentInfo, AppConversation, ChatMessage, TranscriptMessage } from "../types";

/** Grace period before answering a frontend tool this app cannot run, so a BOS
 *  surface that *can* run it gets first claim (the server takes the first result
 *  posted for a call). Without it, an unhandled call would hang the run until
 *  the server-side tool timeout. */
const FOREIGN_TOOL_GRACE_MS = 4000;

/** How often to check that a run we are attached to is still alive. */
const WATCHDOG_MS = 5000;

/** A locally-echoed user message: what the user typed, before (or instead of)
 *  the server owning it. Never persisted. */
interface ChatEcho {
  id: string;
  conversationId: string;
  text: string;
  at: number;
  /** The send failed — keep it on screen next to the error rather than losing it. */
  failed?: boolean;
}

/** An app-generated line in the transcript (an error, a status). Never persisted. */
interface ChatNotice {
  id: string;
  conversationId: string | null;
  content: string;
  at: number;
  error: boolean;
}

export interface ChatState {
  /** False until the persisted index has been read. */
  hydrated: boolean;
  agents: AgentInfo[];
  /** Non-null when the assistant cannot be used at all (T083). */
  assistantError: string | null;
  conversations: AppConversation[];
  activeConversationId: string | null;
  selectedAgentId: string;
  transcripts: Record<string, TranscriptMessage[]>;
  /** Set when the ACTIVE conversation's transcript could not be read (T084). */
  transcriptError: string | null;
  loadingTranscript: boolean;
  echoes: ChatEcho[];
  notices: ChatNotice[];
  /** The run being watched, if any. One at a time, app-wide. */
  live: RunProjection | null;
  busy: boolean;

  init(): Promise<void>;
  selectAgent(agentId: string): void;
  createConversation(): AppConversation;
  selectConversation(conversationId: string): Promise<void>;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  /** Report something to the user where they are already looking: the chat. */
  notice(content: string, error?: boolean): void;
}

// ------------------------------------------------------------------ helpers

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 6)}`;
}

/** App-minted conversation id. The `ate-` prefix is what scopes the dropdown. */
function mintConversationId(): string {
  return `ate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_TITLE = "New conversation";

/** A conversation that has never had a turn has no transcript file yet. */
function hasEverRun(conversation: AppConversation): boolean {
  return conversation.lastActiveAt > conversation.createdAt;
}

/** The dropdown's title for a conversation: the first thing the user asked. */
function deriveTitle(messages: TranscriptMessage[]): string | null {
  const first = messages.find((m) => m.role === "user" && typeof m.content === "string" && m.content.trim());
  if (!first) return null;
  const line = stripAgentContext(first.content ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

/** The display name for an agent id, falling back to the id itself. */
export function agentNameFor(agents: AgentInfo[], agentId: string): string {
  return agents.find((a) => a.id === agentId)?.name ?? (agentId === client.DEFAULT_AGENT_ID ? "Main Assistant" : agentId);
}

// The live run's subscription and liveness check. Module-level rather than in
// the store because they are resources, not state: nothing renders them, and
// exactly one of each may exist at a time.
let unsubscribeRun: (() => void) | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;

function detachRun(): void {
  if (unsubscribeRun) {
    try {
      unsubscribeRun();
    } catch {
      /* the SDK is gone; nothing to release */
    }
    unsubscribeRun = null;
  }
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
}

// ------------------------------------------------------------------ store

export const useChatStore = create<ChatState>((set, get) => {
  /** Persist the app-scoped index (never any message content). */
  const persist = (): void => {
    const { hydrated, conversations, activeConversationId, selectedAgentId } = get();
    if (!hydrated) return;
    void client.writeChatState({ version: 2, conversations, activeConversationId, selectedAgentId });
  };

  const patchConversation = (id: string, patch: Partial<AppConversation>): void => {
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
    persist();
  };

  /** Read a transcript into the store. Handles both "not written yet" and
   *  "gone" — the first is an empty conversation, the second is a stale index
   *  entry that has to be dropped (T084). */
  const loadTranscript = async (conversationId: string): Promise<void> => {
    set({ loadingTranscript: true });
    try {
      const transcript = await client.readTranscript(conversationId);
      set((s) => ({
        transcripts: { ...s.transcripts, [conversationId]: transcript.messages },
        loadingTranscript: false,
      }));
      const conversation = get().conversations.find((c) => c.id === conversationId);
      if (conversation && conversation.title === DEFAULT_TITLE) {
        const title = deriveTitle(transcript.messages);
        if (title) patchConversation(conversationId, { title });
      }
    } catch (err) {
      const conversation = get().conversations.find((c) => c.id === conversationId);
      if (conversation && !hasEverRun(conversation)) {
        // Never sent a turn, so the server has not created the file. Empty, not broken.
        set((s) => ({
          transcripts: { ...s.transcripts, [conversationId]: [] },
          loadingTranscript: false,
          transcriptError: null,
        }));
        return;
      }
      void err;
      dropConversation(conversationId, "Conversation not found");
    }
  };

  /** Remove a conversation whose transcript has gone, and move on to the next. */
  const dropConversation = (conversationId: string, reason: string): void => {
    const remaining = get()
      .conversations.filter((c) => c.id !== conversationId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const next = remaining[0] ?? null;
    set((s) => {
      const transcripts = { ...s.transcripts };
      delete transcripts[conversationId];
      return {
        conversations: remaining,
        transcripts,
        loadingTranscript: false,
        activeConversationId: s.activeConversationId === conversationId ? (next?.id ?? null) : s.activeConversationId,
        selectedAgentId:
          s.activeConversationId === conversationId && next ? next.agentId : s.selectedAgentId,
        transcriptError: s.activeConversationId === conversationId ? reason : s.transcriptError,
      };
    });
    persist();
    if (next && get().activeConversationId === next.id && !get().transcripts[next.id]) {
      void loadTranscript(next.id);
    }
  };

  /** Execute (or decline) one frontend tool call and answer it. */
  const dispatchFrontendTool = (runId: string, event: client.RunEvent): void => {
    const name = typeof event.name === "string" ? event.name : "";
    const callId = typeof event.callId === "string" ? event.callId : "";
    if (!callId) return;

    if (!isEditorTool(name)) {
      // Somebody else's frontend tool (a BOS global action, an elicitation
      // card). Let a real BOS surface answer it; only if nobody does, unblock
      // the run rather than letting it hang to the tool timeout.
      setTimeout(() => {
        void client.postToolResult(
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

    const args = parseArgs(typeof event.args === "string" ? event.args : "");
    const handler = TOOL_HANDLERS[name];
    void Promise.resolve()
      .then(() => (handler ? handler(args) : JSON.stringify({ ok: false, error: `Unknown tool "${name}".` })))
      .catch((err: Error) => JSON.stringify({ ok: false, error: err.message }))
      .then((result) => client.postToolResult(runId, callId, result));
  };

  /** The run is over: take the server's transcript as the truth and stand down. */
  const finishRun = async (projection: RunProjection): Promise<void> => {
    detachRun();
    const conversationId = projection.conversationId;
    let settled: TranscriptMessage[];
    try {
      settled = mergeTranscript((await client.readTranscript(conversationId)).messages, projection.finalized);
    } catch {
      settled = mergeTranscript(get().transcripts[conversationId] ?? [], projection.finalized);
    }
    set((s) => ({
      transcripts: { ...s.transcripts, [conversationId]: settled },
      live: s.live && s.live.runId === projection.runId ? null : s.live,
      busy: s.live && s.live.runId === projection.runId ? false : s.busy,
      echoes: s.echoes.filter((e) => e.failed || e.conversationId !== conversationId),
    }));

    const conversation = get().conversations.find((c) => c.id === conversationId);
    if (conversation && conversation.title === DEFAULT_TITLE) {
      const title = deriveTitle(settled);
      if (title) patchConversation(conversationId, { title });
    }

    if (projection.error) {
      get().notice(projection.error, true);
    } else if (projection.finishReason === "cancelled") {
      get().notice("Run cancelled.", false);
    }
  };

  /**
   * Watch a run: stream its events into the projection, execute the frontend
   * tool calls it dispatches, and stop when it ends.
   *
   * The poll alongside the event stream is not belt-and-braces: the broker only
   * pushes events for runs THIS app started in THIS parent session, so a run
   * adopted from a 409 after the desktop itself reloaded can be perfectly alive
   * and silent. Two consecutive "no longer the active run" answers is the
   * signal to settle from the transcript instead of waiting forever.
   */
  const attachRun = async (runId: string, conversationId: string): Promise<void> => {
    detachRun();
    set({ live: emptyProjection(runId, conversationId), busy: true });

    const onEvent = (event: client.RunEvent): void => {
      const previous = get().live;
      if (!previous || previous.runId !== runId) return;
      const next = projectRunEvent(previous, event);
      if (next !== previous) set({ live: next });

      if (event.type === "tool_call" && event.execution === "frontend") {
        dispatchFrontendTool(runId, event);
      }
      if (event.type === "message") {
        const message = event.message as TranscriptMessage | undefined;
        if (message?.role === "user") {
          // The server owns this text now; drop the local echo of it.
          set((s) => ({ echoes: s.echoes.filter((e) => e.failed || e.conversationId !== conversationId) }));
        }
      }
      if (next.finished && !previous.finished) void finishRun(next);
    };

    try {
      unsubscribeRun = await client.onRunEvent(runId, onEvent);
    } catch (err) {
      set({ live: null, busy: false });
      get().notice((err as Error).message || "Lost connection to the agent run.", true);
      return;
    }

    let misses = 0;
    watchdog = setInterval(() => {
      const live = get().live;
      if (!live || live.runId !== runId || live.finished) return;
      void client.getActiveRun(conversationId).then((activeRunId) => {
        const current = get().live;
        if (!current || current.runId !== runId || current.finished) return;
        if (activeRunId === runId) {
          misses = 0;
          return;
        }
        misses += 1;
        if (misses < 2) return;
        void finishRun({ ...current, finished: true, finishReason: current.finishReason ?? "completed" });
      });
    }, WATCHDOG_MS);
  };

  return {
    hydrated: false,
    agents: [],
    assistantError: null,
    conversations: [],
    activeConversationId: null,
    selectedAgentId: client.DEFAULT_AGENT_ID,
    transcripts: {},
    transcriptError: null,
    loadingTranscript: false,
    echoes: [],
    notices: [],
    live: null,
    busy: false,

    // ---------------------------------------------------------------- lifecycle

    async init() {
      if (get().hydrated) return;

      const stored = await client.readChatState();
      let conversations = stored?.conversations ?? [];
      let activeConversationId = stored?.activeConversationId ?? null;
      let selectedAgentId = stored?.selectedAgentId ?? client.DEFAULT_AGENT_ID;

      if (!stored) {
        // One-time migration off v1, which owned exactly one conversation and
        // kept its id in the editor snapshot. Its transcript is a real
        // server-side file, so adopting the id keeps that history reachable
        // instead of orphaning it the moment v2 installs.
        const legacyId = await readLegacyConversationId();
        if (legacyId) {
          const now = Date.now();
          conversations = [
            {
              id: legacyId,
              title: DEFAULT_TITLE,
              agentId: client.DEFAULT_AGENT_ID,
              createdAt: now - 1,
              lastActiveAt: now,
            },
          ];
          activeConversationId = legacyId;
        }
      }

      if (activeConversationId && !conversations.some((c) => c.id === activeConversationId)) {
        activeConversationId = conversations[0]?.id ?? null;
      }
      const active = conversations.find((c) => c.id === activeConversationId);
      if (active) selectedAgentId = active.agentId;

      set({ conversations, activeConversationId, selectedAgentId, hydrated: true });

      // The agent catalog. A rejection here is the "Assistant unavailable"
      // state (a revoked capability, or a BOS that cannot answer) — the editor
      // pane must be entirely unaffected by it.
      try {
        const agents = await client.listAgents();
        set({ agents, assistantError: null });
        if (!agents.some((a) => a.id === get().selectedAgentId)) {
          // The remembered agent has been deleted since. Fall back rather than
          // sending every message to an id that no longer resolves.
          const fallback = agents[0].id;
          set({ selectedAgentId: fallback });
          const current = get().activeConversationId;
          if (current) patchConversation(current, { agentId: fallback });
          persist();
        }
      } catch (err) {
        set({ assistantError: (err as Error).message || "The assistant is unavailable." });
      }

      const current = get().activeConversationId;
      if (current) {
        await loadTranscript(current);
        if (!get().assistantError) {
          // A run may still be in flight from before the app was closed.
          const runId = await client.getActiveRun(current);
          if (runId) void attachRun(runId, current);
        }
      }
    },

    // ---------------------------------------------------------------- agents

    selectAgent(agentId) {
      if (!agentId || agentId === get().selectedAgentId) return;
      set({ selectedAgentId: agentId });
      // The dropdown re-binds the ACTIVE conversation, mirroring BOS's own
      // agent picker: there is no separate "default agent" that could drift out
      // of step with what the conversation actually runs on. The transcript is
      // keyed by conversation id, so a re-bind never disturbs it.
      const active = get().activeConversationId;
      if (active) patchConversation(active, { agentId });
      else persist();
    },

    // ---------------------------------------------------------------- conversations

    createConversation() {
      const now = Date.now();
      const conversation: AppConversation = {
        id: mintConversationId(),
        title: DEFAULT_TITLE,
        agentId: get().selectedAgentId,
        createdAt: now,
        lastActiveAt: now,
      };
      set((s) => ({
        conversations: [...s.conversations, conversation],
        activeConversationId: conversation.id,
        transcripts: { ...s.transcripts, [conversation.id]: [] },
        transcriptError: null,
        loadingTranscript: false,
      }));
      persist();
      return conversation;
    },

    async selectConversation(conversationId) {
      const conversation = get().conversations.find((c) => c.id === conversationId);
      if (!conversation || get().activeConversationId === conversationId) return;
      set({
        activeConversationId: conversationId,
        selectedAgentId: conversation.agentId,
        transcriptError: null,
      });
      persist();
      await loadTranscript(conversationId);
      // Rejoin a run that is still going in the conversation just opened.
      if (!get().assistantError && !get().live && get().activeConversationId === conversationId) {
        const runId = await client.getActiveRun(conversationId);
        if (runId && get().activeConversationId === conversationId) void attachRun(runId, conversationId);
      }
    },

    // ---------------------------------------------------------------- sending

    async send(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      const state = get();
      if (state.busy || state.assistantError) return;

      const conversation =
        state.conversations.find((c) => c.id === state.activeConversationId) ?? get().createConversation();
      const conversationId = conversation.id;
      const agentId = conversation.agentId || get().selectedAgentId;

      const echo: ChatEcho = { id: uid("echo"), conversationId, text: trimmed, at: Date.now() };
      set((s) => ({ echoes: [...s.echoes, echo], busy: true, transcriptError: null }));
      patchConversation(conversationId, { lastActiveAt: Date.now() });

      // The context block is rebuilt per send, so switching tabs immediately
      // changes what the agent considers "this document" with no extra wiring.
      const result = await client.startRun({
        conversationId,
        agentId,
        message: `${buildAgentContext()}\n${trimmed}`,
        surfaceTools: TOOL_DECLARATIONS,
      });

      if (result.runId) {
        void attachRun(result.runId, conversationId);
        return;
      }

      if (result.activeRunId) {
        // The conversation already had a run in flight (a second window, or a
        // send that raced a reconnect). Join it rather than reporting a failure
        // the user can do nothing about — but be honest that this message did
        // not go anywhere.
        set((s) => ({ echoes: s.echoes.map((e) => (e.id === echo.id ? { ...e, failed: true } : e)) }));
        get().notice("This conversation already had a reply in progress — reconnected to it. Send your message again once it finishes.", true);
        void attachRun(result.activeRunId, conversationId);
        return;
      }

      set((s) => ({
        busy: false,
        echoes: s.echoes.map((e) => (e.id === echo.id ? { ...e, failed: true } : e)),
      }));
      get().notice(result.error ?? "Could not reach the BrowserOS assistant.", true);
    },

    async stop() {
      const live = get().live;
      if (!live || live.finished) return;
      await client.cancelRun(live.runId);
    },

    notice(content, error = true) {
      set((s) => ({
        notices: [
          ...s.notices,
          { id: uid("notice"), conversationId: s.activeConversationId, content, at: Date.now(), error },
        ].slice(-50),
      }));
    },
  };
});

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The v1 snapshot's single conversation id, if this is an upgrade. */
async function readLegacyConversationId(): Promise<string | null> {
  const raw = await client.readKey(EDITOR_STATE_KEY);
  if (!raw) return null;
  try {
    const snapshot = JSON.parse(raw) as { conversationId?: unknown };
    return typeof snapshot.conversationId === "string" && snapshot.conversationId ? snapshot.conversationId : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ selectors

/** Conversations for the dropdown: most recently used first (FR-024). */
export function conversationsByRecency(conversations: AppConversation[]): AppConversation[] {
  return [...conversations].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

/**
 * What the chat pane draws for the active conversation.
 *
 * Four sources, in this order: the settled transcript, anything the user typed
 * that the server has not taken ownership of yet, whatever the run being watched
 * has settled since, and the reply currently streaming. App-generated notices
 * (errors, cancellations) go last — they are about the exchange as a whole
 * rather than a point in it, and nothing in the transcript is timestamped to
 * interleave them against.
 */
export function chatMessagesFor(state: ChatState): ChatMessage[] {
  const conversationId = state.activeConversationId;
  const out: ChatMessage[] = [];
  const seenMessageIds = new Set<string>();
  const coveredCallIds = new Set<string>();
  const live = state.live && state.live.conversationId === conversationId ? state.live : null;
  const running = new Set(runningCallIds(live));

  const push = (message: TranscriptMessage): void => {
    if (seenMessageIds.has(message.id)) return;
    seenMessageIds.add(message.id);
    const view = toViewMessage(message, running);
    if (!view) return;
    for (const call of view.toolCalls ?? []) coveredCallIds.add(call.id);
    out.push(view);
  };

  if (conversationId) {
    for (const message of state.transcripts[conversationId] ?? []) push(message);

    for (const echo of state.echoes) {
      if (echo.conversationId !== conversationId) continue;
      out.push({ id: echo.id, role: "user", content: echo.text, timestamp: echo.at, error: echo.failed });
    }
  }

  if (live) {
    for (const message of live.finalized) push(message);

    if (!live.finished) {
      // Chips for calls no settled reply claims. Normally empty — the assistant
      // message carrying `toolCalls[]` lands before its calls execute — but a
      // call announced without (or before) its message still gets shown.
      const loose = live.tools.filter((t) => !coveredCallIds.has(t.callId));
      out.push({
        id: `live-${live.runId}`,
        role: "agent",
        content: live.text,
        streaming: true,
        toolCalls: loose.map((t) => ({
          id: t.callId,
          type: "function" as const,
          function: { name: t.name, arguments: t.args },
        })),
        runningCallIds: loose.filter((t) => t.status === "running").map((t) => t.callId),
      });
    }
  }

  for (const notice of state.notices) {
    // A notice raised before any conversation existed belongs to whichever one
    // the user is looking at — it is about the app, not about the thread.
    if (notice.conversationId && notice.conversationId !== conversationId) continue;
    out.push({
      id: notice.id,
      role: "system",
      content: notice.content,
      timestamp: notice.at,
      error: notice.error,
    });
  }

  return out;
}

/** One persisted message as the chat renders it, or null if there is nothing to show. */
function toViewMessage(message: TranscriptMessage, running: Set<string>): ChatMessage | null {
  // Tool results are the agent's working, not its reply — the tool row already
  // says which tools ran, so the raw JSON payloads stay out of the transcript.
  if (message.role === "tool") return null;

  const content = message.role === "user" ? stripAgentContext(message.content ?? "") : (message.content ?? "");
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : undefined;
  // An assistant message with neither text nor tool calls is an interrupted
  // turn's remains; drawing an empty bubble for it would be worse than nothing.
  if (!content.trim() && !toolCalls?.length) return null;

  return {
    id: message.id,
    role: message.role === "user" ? "user" : "agent",
    content,
    toolCalls,
    runningCallIds: toolCalls?.filter((c) => running.has(c.id)).map((c) => c.id),
    error: message.error,
  };
}
