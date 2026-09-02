// EventNodeConfigForm.tsx — the node-config form for `outputType: "event"`
// (US18/FR-046, FR-049).
//
// An event node has NO agent: its whole definition is the event type it emits
// plus how its payload is built, so this form replaces the agentSource/input
// blocks the other output types get. It mirrors the service's own config
// schema exactly (services/engine/node-model.js `normalizeEventConfig` +
// `eventNodeConfigErrors`) — `{ eventType, payload: { mode, value | text } }`
// — and validates against the SAME rules live, so an authoring mistake shows
// up while typing rather than as a validation error after the save.

import React, { useState } from "react";
import type { EventNodeConfig, EventPayloadMode } from "../lib/types";
import { EVENT_TYPE_PATTERN, WORKFLOWS_EVENT_NAMESPACE } from "../lib/types";

interface EventNodeConfigFormProps {
  config: EventNodeConfig | undefined;
  /** Node ids a `{{nodeId.field}}` placeholder may reference (this node's upstreams). */
  upstreamIds: string[];
  onChange: (config: EventNodeConfig) => void;
}

/** FR-046/FR-048a/FR-048b, in the order an author most likely broke them. */
export function eventTypeError(value: string | undefined): string | null {
  const t = (value ?? "").trim();
  if (!t) return "An event node must declare the event type it emits.";
  if (!EVENT_TYPE_PATTERN.test(t)) return "Event types are dot-separated and lowercase — e.g. \"com.bos.workflows.analysis.complete\".";
  if (!t.startsWith(WORKFLOWS_EVENT_NAMESPACE)) return `Workflows may only emit under "${WORKFLOWS_EVENT_NAMESPACE}*" (ADR-14) — this type belongs to another owner.`;
  return null;
}

/** A static payload is emitted verbatim, so it must BE a JSON object. */
export function staticPayloadError(text: string): string | null {
  if (!text.trim()) return "A static payload is required — an event payload is always a JSON object.";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return `Invalid JSON: ${(err as Error).message}`;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return "The payload must be a JSON object (not an array or a scalar).";
  return null;
}

function templateError(text: string, upstreamIds: string[]): string | null {
  if (!text.trim()) return "A template payload needs a JSON template string with {{nodeId.field}} placeholders.";
  if (!upstreamIds.length) return null;
  const refs = Array.from(text.matchAll(/\{\{\s*([^{}\s]+?)\s*\}\}/g)).map((m) => m[1]);
  const unknown = refs.map((r) => r.split(".")[0]).filter((id) => id && !upstreamIds.includes(id));
  if (unknown.length) return `Unknown node id in a placeholder: ${Array.from(new Set(unknown)).join(", ")} — a reference must name an upstream node.`;
  return null;
}

function payloadJson(value: unknown): string {
  if (value === undefined) return "{}";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

export function EventNodeConfigForm({ config, upstreamIds, onChange }: EventNodeConfigFormProps) {
  const eventType = config?.eventType ?? "";
  const mode: EventPayloadMode = config?.payload?.mode === "template" ? "template" : "static";
  const templateText = typeof config?.payload?.text === "string" ? config.payload.text : "";

  // The static textarea keeps the raw text the author typed (so a half-typed
  // brace isn't destroyed by a re-serialize), and only commits `value` up when
  // it parses — the same "keep the last valid value" contract the step `input`
  // textarea already uses.
  const [staticText, setStaticText] = useState(() => payloadJson(config?.payload?.value));

  const typeError = eventTypeError(eventType);
  const staticError = mode === "static" ? staticPayloadError(staticText) : null;
  const tplError = mode === "template" ? templateError(templateText, upstreamIds) : null;

  function setEventType(next: string) {
    onChange({ ...(config || {}), eventType: next, payload: config?.payload ?? { mode: "static", value: {} } });
  }

  function setMode(next: EventPayloadMode) {
    if (next === mode) return;
    if (next === "template") {
      onChange({ ...(config || {}), eventType, payload: { mode: "template", text: templateText } });
    } else {
      const parsed = staticPayloadError(staticText) ? {} : JSON.parse(staticText);
      onChange({ ...(config || {}), eventType, payload: { mode: "static", value: parsed } });
    }
  }

  function setStaticPayload(text: string) {
    setStaticText(text);
    if (staticPayloadError(text)) return; // keep the last valid value until it parses
    onChange({ ...(config || {}), eventType, payload: { mode: "static", value: JSON.parse(text) } });
  }

  function setTemplate(text: string) {
    onChange({ ...(config || {}), eventType, payload: { mode: "template", text } });
  }

  return (
    <div className="wf-event-config" data-testid="wf-event-config">
      <div className="wf-row">
        <span className="wf-event-config-icon">⚡</span>
        <span style={{ fontWeight: 600, fontSize: 12 }}>Event to emit</span>
        <span className="wf-tool-label">outputType: event · no agent</span>
      </div>

      <div style={{ marginTop: 8 }}>
        <label className="wf-dim" style={{ fontSize: 11 }}>
          eventType
        </label>
        <input
          className={`wf-textarea wf-mono ${typeError ? "wf-input-invalid" : ""}`}
          style={{ marginTop: 4, padding: "4px 8px" }}
          placeholder={`${WORKFLOWS_EVENT_NAMESPACE}analysis.complete`}
          aria-label="Event type"
          aria-invalid={typeError ? true : undefined}
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
        />
        {typeError ? (
          <div className="wf-field-error" data-testid="wf-event-type-error">
            {typeError}
          </div>
        ) : (
          <div className="wf-dim" style={{ marginTop: 4, fontSize: 10 }}>
            Emitted into BOS&apos;s event system with a `_wf` provenance envelope (workflow, run, node).
          </div>
        )}
      </div>

      <div className="wf-row" style={{ marginTop: 10 }}>
        <label className="wf-dim" style={{ fontSize: 11, width: 90 }}>
          payload
        </label>
        <div className="wf-mode-toggle" role="group" aria-label="Payload mode">
          <button className={`wf-btn wf-btn-sm ${mode === "static" ? "wf-btn-primary" : ""}`} onClick={() => setMode("static")}>
            Static JSON
          </button>
          <button className={`wf-btn wf-btn-sm ${mode === "template" ? "wf-btn-primary" : ""}`} onClick={() => setMode("template")}>
            Template
          </button>
        </div>
      </div>

      {mode === "static" ? (
        <div style={{ marginTop: 6 }}>
          <textarea
            className={`wf-textarea wf-mono ${staticError ? "wf-input-invalid" : ""}`}
            rows={4}
            aria-label="Static event payload"
            aria-invalid={staticError ? true : undefined}
            value={staticText}
            onChange={(e) => setStaticPayload(e.target.value)}
          />
          {staticError ? (
            <div className="wf-field-error" data-testid="wf-event-payload-error">
              {staticError}
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ marginTop: 6 }}>
          <input
            className={`wf-textarea wf-mono ${tplError ? "wf-input-invalid" : ""}`}
            style={{ padding: "4px 8px" }}
            placeholder={'{"summary": "{{analyze.summary}}", "score": {{score.value}}}'}
            aria-label="Payload template"
            aria-invalid={tplError ? true : undefined}
            value={templateText}
            onChange={(e) => setTemplate(e.target.value)}
          />
          {tplError ? (
            <div className="wf-field-error" data-testid="wf-event-payload-error">
              {tplError}
            </div>
          ) : (
            <div className="wf-dim" style={{ marginTop: 4, fontSize: 10 }}>
              A JSON template string. `{"{{nodeId.field}}"}` is replaced by that upstream node&apos;s output (JSON-encoded), so the rendered text must still parse as a JSON object.
            </div>
          )}
          <div className="wf-row" style={{ marginTop: 6, flexWrap: "wrap" }}>
            <span className="wf-dim" style={{ fontSize: 10 }}>
              available nodes:
            </span>
            {upstreamIds.length === 0 ? (
              <span className="wf-dim" style={{ fontSize: 10 }}>
                none yet — add a dependency to reference an upstream output.
              </span>
            ) : (
              upstreamIds.map((id) => (
                <button
                  key={id}
                  className="wf-btn wf-btn-sm wf-mono"
                  title={`Insert {{${id}.field}}`}
                  onClick={() => setTemplate(`${templateText}{{${id}.output}}`)}
                >
                  {id}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
