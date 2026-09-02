// TriggersPanel.tsx — the workflow's EVENT TRIGGERS surface (US16/FR-049).
//
// A workflow's `triggers` array is the list of BOS event types whose arrival
// starts a run of it (services/events.js `reconcileSubscriptions`). This panel
// is the authoring UI for that array: each entry is a removable chip, a new one
// is added either free-text or picked from the live registry, and every
// add/remove is persisted straight away through `workflow_modify` — the SAME
// write path the assistant uses, so the service re-subscribes immediately.
//
// The "Browse" picker reads `workflow_event_types` (US17/FR-044) through the
// service's REST bridge; an empty registry is a legitimate empty list, not an
// error (FR-045).

import React, { useCallback, useState } from "react";
import type { EventTypeEntry, Workflow } from "../lib/types";
import { EVENT_TYPE_PATTERN } from "../lib/types";
import { api } from "../lib/bridge";

interface TriggersPanelProps {
  workflow: Workflow;
  /** Re-read the workflow after a successful write (DetailView owns the copy). */
  onModified: () => void;
}

function normalize(triggers: string[] | undefined): string[] {
  return (triggers || []).filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
}

/** Matches the service's own check (engine/validate.js `eventPolicyErrors`),
 *  except that a `prefix.*` pattern is also accepted here — the kernel honors
 *  it for a SUBSCRIPTION (events.js `triggerMatches`) even though it is not a
 *  concrete emitted type. */
function triggerError(value: string): string | null {
  const t = value.trim();
  if (!t) return null;
  if (EVENT_TYPE_PATTERN.test(t)) return null;
  if (/^[a-z0-9]+(\.[a-z0-9_-]+)*\.\*$/.test(t)) return null;
  return `"${t}" is not a valid event type — dot-separated and lowercase (e.g. "com.bos.files.created"), or a "com.bos.files.*" prefix pattern.`;
}

export function TriggersPanel({ workflow, onModified }: TriggersPanelProps) {
  const triggers = normalize(workflow.triggers);
  const [draft, setDraft] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [types, setTypes] = useState<EventTypeEntry[] | null>(null);
  const [loadingTypes, setLoadingTypes] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draftError = triggerError(draft);

  const persist = useCallback(
    async (next: string[]) => {
      setSaving(true);
      setError(null);
      try {
        // Arrays are REPLACED wholesale by the service's deepMerge, so sending
        // the full next array is the correct patch (handlers.js `deepMerge`).
        await api.modify(workflow.id, { triggers: next });
        onModified();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [workflow.id, onModified],
  );

  async function addTrigger(value: string) {
    const t = value.trim();
    if (!t || triggerError(t)) return;
    if (triggers.includes(t)) {
      setDraft("");
      return;
    }
    setDraft("");
    setBrowsing(false);
    await persist([...triggers, t]);
  }

  async function removeTrigger(t: string) {
    await persist(triggers.filter((x) => x !== t));
  }

  async function toggleBrowse() {
    if (browsing) {
      setBrowsing(false);
      return;
    }
    setBrowsing(true);
    if (types) return; // already loaded this session
    setLoadingTypes(true);
    setError(null);
    try {
      setTypes((await api.eventTypes()) as EventTypeEntry[]);
    } catch (err) {
      setError((err as Error).message);
      setTypes([]);
    } finally {
      setLoadingTypes(false);
    }
  }

  return (
    <div className="wf-triggers" data-testid="wf-triggers">
      <div className="wf-row">
        <h3 className="wf-section-title" style={{ margin: 0 }}>
          Triggers <span className="wf-tool-label">workflow_modify</span>
        </h3>
        {saving ? <span className="wf-pill wf-pill-info">saving…</span> : null}
      </div>
      <div className="wf-dim" style={{ fontSize: 11, marginTop: 2 }}>
        Event types that start a run of this workflow. Each arrival starts a NEW, independent run — concurrent runs are expected.
      </div>

      {error ? (
        <div className="wf-warning-banner" style={{ marginTop: 8 }}>
          ⚠ {error}
        </div>
      ) : null}

      <div className="wf-row wf-trigger-chips" style={{ marginTop: 8, flexWrap: "wrap" }}>
        {triggers.length === 0 ? (
          <span className="wf-dim" style={{ fontSize: 12 }}>
            No triggers — this workflow only runs when you or the assistant start it.
          </span>
        ) : (
          triggers.map((t) => (
            <span key={t} className="wf-trigger-chip" data-testid="wf-trigger-chip">
              <span className="wf-trigger-chip-glyph">⚡</span>
              <span className="wf-mono">{t}</span>
              <button
                className="wf-trigger-chip-remove"
                title={`Remove trigger ${t}`}
                aria-label={`Remove trigger ${t}`}
                disabled={saving}
                onClick={() => removeTrigger(t)}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      <div className="wf-row" style={{ marginTop: 8 }}>
        <input
          className="wf-textarea wf-mono"
          style={{ padding: "4px 8px", borderColor: draftError ? "rgba(248,113,113,0.6)" : undefined }}
          placeholder="com.bos.files.created"
          aria-label="New trigger event type"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addTrigger(draft);
          }}
        />
        <button className="wf-btn wf-btn-sm wf-btn-primary" disabled={saving || !draft.trim() || !!draftError} onClick={() => addTrigger(draft)}>
          + Add trigger
        </button>
        <button className="wf-btn wf-btn-sm" onClick={toggleBrowse}>
          {browsing ? "Close" : "Browse"} <span className="wf-tool-label">workflow_event_types</span>
        </button>
      </div>

      {draftError ? (
        <div style={{ marginTop: 4, fontSize: 11, color: "#fecaca" }}>{draftError}</div>
      ) : null}

      {browsing ? (
        <div className="wf-event-type-list" data-testid="wf-event-type-list">
          {loadingTypes ? (
            <div className="wf-dim" style={{ fontSize: 12, padding: 6 }}>
              Reading the BOS event registry…
            </div>
          ) : (types || []).length === 0 ? (
            <div className="wf-dim" style={{ fontSize: 12, padding: 6 }}>
              No event types are registered yet — type one by hand above; a workflow may subscribe to a type before anything emits it.
            </div>
          ) : (
            (types || []).map((entry) => (
              <button
                key={entry.type}
                className="wf-event-type-row"
                disabled={triggers.includes(entry.type)}
                onClick={() => addTrigger(entry.type)}
                title={triggers.includes(entry.type) ? "already a trigger" : `Add ${entry.type} as a trigger`}
              >
                <span className="wf-mono wf-event-type-name">{entry.type}</span>
                {entry.displayName ? <span className="wf-event-type-display">{entry.displayName}</span> : null}
                <div style={{ flex: 1 }} />
                <span className="wf-mono wf-event-type-count">
                  {entry.handlerCount} handler{entry.handlerCount === 1 ? "" : "s"}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
