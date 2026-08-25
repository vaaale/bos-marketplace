import React, { useState } from "react";
import type { AgentSource, OutputType, Workflow, WorkflowStep } from "../lib/types";
import { Graph, GraphLegend } from "./Graph";
import { api } from "../lib/bridge";

// GraphEditor — node/graph authoring surface (mockup's Detail-view "Edit"
// action, wired to workflow_modify). Nodes = steps, edges = `dependencies`;
// editing either is a first-class action here, not just JSON-blob surgery.
// A step is cloned-and-patched field by field so any property this form
// doesn't know about (e.g. a candidate's `agentId`) survives untouched.

interface GraphEditorProps {
  workflow: Workflow;
  onCancel: () => void;
  onSaved: () => void;
}

const OUTPUT_TYPES: OutputType[] = ["delegate", "tool", "research", "ag-ui"];

function uniqueId(existing: Set<string>, base = "step"): string {
  let n = existing.size + 1;
  let id = `${base}-${n}`;
  while (existing.has(id)) {
    n++;
    id = `${base}-${n}`;
  }
  return id;
}

function csv(list?: string[]): string {
  return (list || []).join(", ");
}

function parseCsv(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function defaultStep(id: string): WorkflowStep {
  return {
    id,
    outputType: "delegate",
    agentSource: { kind: "ephemeral", task: "", tools: [], skills: [] },
    dependencies: [],
  };
}

function jsonPreview(value: unknown): string {
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

export function GraphEditor({ workflow, onCancel, onSaved }: GraphEditorProps) {
  const [steps, setSteps] = useState<WorkflowStep[]>(() => workflow.steps.map((s) => ({ ...s })));
  const [selectedId, setSelectedId] = useState<string | null>(steps[0]?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState(() => JSON.stringify(workflow.steps, null, 2));
  const [inputText, setInputText] = useState<Record<string, string>>({});

  const selectedIndex = steps.findIndex((s) => s.id === selectedId);
  const selected = selectedIndex >= 0 ? steps[selectedIndex] : null;

  function patchStep(index: number, patch: Partial<WorkflowStep>) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function patchAgentSource(index: number, patch: Partial<AgentSource>) {
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, agentSource: { ...(s.agentSource || { kind: "ephemeral" }), ...patch } } : s)),
    );
  }

  function renameStep(index: number, newId: string) {
    const oldId = steps[index].id;
    if (!newId || newId === oldId) return;
    setSteps((prev) =>
      prev.map((s, i) => {
        if (i === index) return { ...s, id: newId };
        const dependencies = (s.dependencies || []).map((d) => (d === oldId ? newId : d));
        const candidates = (s.candidates || []).map((c) => (c.id === oldId ? { ...c, id: newId } : c));
        return { ...s, dependencies, candidates };
      }),
    );
    setSelectedId(newId);
  }

  function addStep() {
    const existing = new Set(steps.map((s) => s.id));
    const id = uniqueId(existing);
    setSteps((prev) => [...prev, defaultStep(id)]);
    setSelectedId(id);
  }

  function deleteStep(index: number) {
    const id = steps[index].id;
    setSteps((prev) =>
      prev
        .filter((_, i) => i !== index)
        .map((s) => ({
          ...s,
          dependencies: (s.dependencies || []).filter((d) => d !== id),
          candidates: (s.candidates || []).filter((c) => c.id !== id),
        })),
    );
    if (selectedId === id) setSelectedId(null);
  }

  function toggleDependency(index: number, depId: string) {
    setSteps((prev) =>
      prev.map((s, i) => {
        if (i !== index) return s;
        const has = (s.dependencies || []).includes(depId);
        const dependencies = has ? (s.dependencies || []).filter((d) => d !== depId) : [...(s.dependencies || []), depId];
        return { ...s, dependencies };
      }),
    );
  }

  function addCandidate(index: number) {
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, candidates: [...(s.candidates || []), { id: "", description: "" }] } : s)),
    );
  }

  function patchCandidate(index: number, ci: number, patch: Partial<{ id: string; description?: string }>) {
    setSteps((prev) =>
      prev.map((s, i) => {
        if (i !== index) return s;
        const candidates = (s.candidates || []).map((c, j) => (j === ci ? { ...c, ...patch } : c));
        return { ...s, candidates };
      }),
    );
  }

  function removeCandidate(index: number, ci: number) {
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, candidates: (s.candidates || []).filter((_, j) => j !== ci) } : s)),
    );
  }

  function addResearchAgent(index: number) {
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, researchAgents: [...(s.researchAgents || []), { kind: "ephemeral", task: "" }] } : s)),
    );
  }

  function patchResearchAgent(index: number, ri: number, patch: Partial<AgentSource>) {
    setSteps((prev) =>
      prev.map((s, i) => {
        if (i !== index) return s;
        const researchAgents = (s.researchAgents || []).map((a, j) => (j === ri ? { ...a, ...patch } : a));
        return { ...s, researchAgents };
      }),
    );
  }

  function removeResearchAgent(index: number, ri: number) {
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, researchAgents: (s.researchAgents || []).filter((_, j) => j !== ri) } : s)),
    );
  }

  function setStepInput(index: number, text: string) {
    const id = steps[index].id;
    setInputText((prev) => ({ ...prev, [id]: text }));
    if (!text.trim()) {
      patchStep(index, { input: undefined });
      return;
    }
    try {
      patchStep(index, { input: JSON.parse(text) });
      setError(null);
    } catch {
      // leave the last-valid input in place until the JSON is fixed; the
      // textarea itself still reflects what the user typed via inputText.
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      let nextSteps = steps;
      if (rawMode) {
        try {
          nextSteps = JSON.parse(rawText);
        } catch (err) {
          setError(`Invalid JSON: ${(err as Error).message}`);
          setSaving(false);
          return;
        }
      }
      await api.modify(workflow.id, { steps: nextSteps });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function toggleRaw() {
    if (!rawMode) setRawText(JSON.stringify(steps, null, 2));
    else {
      try {
        setSteps(JSON.parse(rawText));
        setError(null);
      } catch (err) {
        setError(`Invalid JSON: ${(err as Error).message}`);
        return;
      }
    }
    setRawMode((v) => !v);
  }

  return (
    <div className="wf-card" style={{ marginBottom: 12 }}>
      <div className="wf-row">
        <span style={{ fontWeight: 600 }}>Edit graph</span>
        <span className="wf-tool-label">workflow_modify</span>
        <div style={{ flex: 1 }} />
        <button className="wf-btn wf-btn-sm" onClick={toggleRaw}>
          {rawMode ? "Structured editor" : "Edit as JSON"}
        </button>
        {!rawMode ? (
          <button className="wf-btn wf-btn-sm" onClick={addStep}>
            + Add step
          </button>
        ) : null}
      </div>

      {error ? <div style={{ marginTop: 8, fontSize: 12, color: "#fecaca" }}>{error}</div> : null}

      {rawMode ? (
        <textarea
          className="wf-textarea wf-mono"
          style={{ marginTop: 8 }}
          rows={20}
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
        />
      ) : (
        <>
          <div style={{ marginTop: 8 }}>
            <Graph steps={steps} selectedId={selectedId} onSelectNode={setSelectedId} />
            <GraphLegend />
          </div>

          <div style={{ marginTop: 8 }}>
            {steps.map((s, i) => (
              <div
                key={s.id}
                className="wf-step-row"
                style={{ cursor: "pointer", borderColor: s.id === selectedId ? "rgba(139,92,246,0.6)" : undefined }}
                onClick={() => setSelectedId(s.id)}
              >
                <span style={{ flex: 1, fontWeight: 500 }}>{s.id}</span>
                <span className="wf-dim wf-mono" style={{ fontSize: 11 }}>
                  {s.outputType}
                  {(s.dependencies || []).length ? ` · ← ${(s.dependencies || []).join(", ")}` : ""}
                </span>
                <button
                  className="wf-btn wf-btn-sm wf-btn-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteStep(i);
                  }}
                >
                  Delete
                </button>
              </div>
            ))}
            {steps.length === 0 ? <div className="wf-dim" style={{ fontSize: 12 }}>No steps yet — add one above.</div> : null}
          </div>

          {selected && selectedIndex >= 0 ? (
            <div className="wf-card" style={{ marginTop: 12, background: "rgba(139,92,246,0.05)", borderColor: "rgba(139,92,246,0.25)" }}>
              <div className="wf-row">
                <span style={{ fontWeight: 600 }}>Step</span>
                <input
                  className="wf-textarea wf-mono"
                  style={{ width: 180, padding: "4px 8px" }}
                  value={selected.id}
                  onChange={(e) => renameStep(selectedIndex, e.target.value.trim())}
                />
              </div>

              <div className="wf-row" style={{ marginTop: 8 }}>
                <label className="wf-dim" style={{ fontSize: 11, width: 90 }}>
                  outputType
                </label>
                <select
                  className="wf-textarea"
                  style={{ width: 160, padding: "4px 8px" }}
                  value={selected.outputType}
                  onChange={(e) => patchStep(selectedIndex, { outputType: e.target.value as OutputType })}
                >
                  {OUTPUT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              {selected.outputType === "tool" ? (
                <div className="wf-row" style={{ marginTop: 8 }}>
                  <label className="wf-dim" style={{ fontSize: 11, width: 90 }}>
                    toolName
                  </label>
                  <input
                    className="wf-textarea"
                    style={{ padding: "4px 8px" }}
                    value={selected.toolName || ""}
                    onChange={(e) => patchStep(selectedIndex, { toolName: e.target.value })}
                  />
                </div>
              ) : null}

              {selected.outputType === "delegate" || selected.outputType === "tool" ? (
                <div style={{ marginTop: 8 }}>
                  <div className="wf-row">
                    <label className="wf-dim" style={{ fontSize: 11, width: 90 }}>
                      agentSource
                    </label>
                    <select
                      className="wf-textarea"
                      style={{ width: 140, padding: "4px 8px" }}
                      value={selected.agentSource?.kind || "ephemeral"}
                      onChange={(e) => patchAgentSource(selectedIndex, { kind: e.target.value as "static" | "ephemeral" })}
                    >
                      <option value="ephemeral">ephemeral</option>
                      <option value="static">static</option>
                    </select>
                  </div>
                  {selected.agentSource?.kind === "static" ? (
                    <div className="wf-row" style={{ marginTop: 6 }}>
                      <label className="wf-dim" style={{ fontSize: 11, width: 90 }}>
                        agentId
                      </label>
                      <input
                        className="wf-textarea"
                        style={{ padding: "4px 8px" }}
                        value={selected.agentSource?.agentId || ""}
                        onChange={(e) => patchAgentSource(selectedIndex, { agentId: e.target.value })}
                      />
                    </div>
                  ) : (
                    <>
                      <div style={{ marginTop: 6 }}>
                        <label className="wf-dim" style={{ fontSize: 11 }}>
                          task
                        </label>
                        <textarea
                          className="wf-textarea"
                          rows={3}
                          style={{ marginTop: 4 }}
                          value={selected.agentSource?.task || ""}
                          onChange={(e) => patchAgentSource(selectedIndex, { task: e.target.value })}
                        />
                      </div>
                      <div className="wf-row" style={{ marginTop: 6 }}>
                        <label className="wf-dim" style={{ fontSize: 11, width: 90 }}>
                          tools
                        </label>
                        <input
                          className="wf-textarea"
                          style={{ padding: "4px 8px" }}
                          placeholder="comma-separated tool ids — leave empty for none"
                          value={csv(selected.agentSource?.tools)}
                          onChange={(e) => patchAgentSource(selectedIndex, { tools: parseCsv(e.target.value) })}
                        />
                      </div>
                      <div className="wf-row" style={{ marginTop: 6 }}>
                        <label className="wf-dim" style={{ fontSize: 11, width: 90 }}>
                          skills
                        </label>
                        <input
                          className="wf-textarea"
                          style={{ padding: "4px 8px" }}
                          placeholder="comma-separated skill ids"
                          value={csv(selected.agentSource?.skills)}
                          onChange={(e) => patchAgentSource(selectedIndex, { skills: parseCsv(e.target.value) })}
                        />
                      </div>
                    </>
                  )}
                </div>
              ) : null}

              {selected.outputType === "research" ? (
                <div style={{ marginTop: 8 }}>
                  <div className="wf-row">
                    <span className="wf-dim" style={{ fontSize: 11 }}>
                      researchAgents (fan out concurrently)
                    </span>
                    <div style={{ flex: 1 }} />
                    <button className="wf-btn wf-btn-sm" onClick={() => addResearchAgent(selectedIndex)}>
                      + Add
                    </button>
                  </div>
                  {(selected.researchAgents || []).map((a, ri) => (
                    <div key={ri} className="wf-row" style={{ marginTop: 6 }}>
                      <select
                        className="wf-textarea"
                        style={{ width: 110, padding: "4px 8px" }}
                        value={a.kind}
                        onChange={(e) => patchResearchAgent(selectedIndex, ri, { kind: e.target.value as "static" | "ephemeral" })}
                      >
                        <option value="ephemeral">ephemeral</option>
                        <option value="static">static</option>
                      </select>
                      {a.kind === "static" ? (
                        <input
                          className="wf-textarea"
                          placeholder="agentId"
                          style={{ padding: "4px 8px" }}
                          value={a.agentId || ""}
                          onChange={(e) => patchResearchAgent(selectedIndex, ri, { agentId: e.target.value })}
                        />
                      ) : (
                        <input
                          className="wf-textarea"
                          placeholder="task"
                          style={{ padding: "4px 8px" }}
                          value={a.task || ""}
                          onChange={(e) => patchResearchAgent(selectedIndex, ri, { task: e.target.value })}
                        />
                      )}
                      <button className="wf-btn wf-btn-sm wf-btn-danger" onClick={() => removeResearchAgent(selectedIndex, ri)}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <div style={{ marginTop: 8 }}>
                <div className="wf-row">
                  <span className="wf-dim" style={{ fontSize: 11 }}>
                    dependencies (edges into this step)
                  </span>
                </div>
                <div className="wf-row" style={{ marginTop: 4, flexWrap: "wrap" }}>
                  {steps
                    .filter((s) => s.id !== selected.id)
                    .map((s) => {
                      const on = (selected.dependencies || []).includes(s.id);
                      return (
                        <button
                          key={s.id}
                          className={`wf-btn wf-btn-sm ${on ? "wf-btn-primary" : ""}`}
                          onClick={() => toggleDependency(selectedIndex, s.id)}
                        >
                          {on ? "✓ " : ""}
                          {s.id}
                        </button>
                      );
                    })}
                  {steps.length <= 1 ? <span className="wf-dim" style={{ fontSize: 11 }}>Add another step to wire a dependency.</span> : null}
                </div>
              </div>

              <div style={{ marginTop: 8 }}>
                <div className="wf-row">
                  <span className="wf-dim" style={{ fontSize: 11 }}>
                    candidates (dynamic routing — optional)
                  </span>
                  <div style={{ flex: 1 }} />
                  <button className="wf-btn wf-btn-sm" onClick={() => addCandidate(selectedIndex)}>
                    + Add
                  </button>
                </div>
                {(selected.candidates || []).map((c, ci) => (
                  <div key={ci} className="wf-row" style={{ marginTop: 6 }}>
                    <select
                      className="wf-textarea"
                      style={{ width: 140, padding: "4px 8px" }}
                      value={c.id}
                      onChange={(e) => patchCandidate(selectedIndex, ci, { id: e.target.value })}
                    >
                      <option value="">select step…</option>
                      {steps
                        .filter((s) => s.id !== selected.id)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.id}
                          </option>
                        ))}
                    </select>
                    <input
                      className="wf-textarea"
                      placeholder="description"
                      style={{ padding: "4px 8px" }}
                      value={c.description || ""}
                      onChange={(e) => patchCandidate(selectedIndex, ci, { description: e.target.value })}
                    />
                    <button className="wf-btn wf-btn-sm wf-btn-danger" onClick={() => removeCandidate(selectedIndex, ci)}>
                      ×
                    </button>
                  </div>
                ))}
              </div>

              {selected.outputType !== "research" ? (
                <div style={{ marginTop: 8 }}>
                  <label className="wf-dim" style={{ fontSize: 11 }}>
                    input (JSON, optional{selected.outputType === "ag-ui" ? " — this IS the ag-ui output" : ""})
                  </label>
                  <textarea
                    className="wf-textarea wf-mono"
                    rows={3}
                    style={{ marginTop: 4 }}
                    value={inputText[selected.id] ?? jsonPreview(selected.input)}
                    onChange={(e) => setStepInput(selectedIndex, e.target.value)}
                  />
                  {(() => {
                    const text = inputText[selected.id];
                    if (!text || !text.trim()) return null;
                    try {
                      JSON.parse(text);
                      return null;
                    } catch {
                      return (
                        <div style={{ marginTop: 4, fontSize: 11, color: "#fecaca" }}>
                          Invalid JSON — keeping the last valid value until this is fixed.
                        </div>
                      );
                    }
                  })()}
                </div>
              ) : null}

              <div className="wf-row" style={{ marginTop: 8 }}>
                <div style={{ flex: 1 }}>
                  <label className="wf-dim" style={{ fontSize: 11 }}>
                    outputConvention
                  </label>
                  <input
                    className="wf-textarea"
                    style={{ marginTop: 4, padding: "4px 8px" }}
                    value={selected.outputConvention || ""}
                    onChange={(e) => patchStep(selectedIndex, { outputConvention: e.target.value })}
                  />
                </div>
              </div>

              <div className="wf-row" style={{ marginTop: 8 }}>
                <div>
                  <label className="wf-dim" style={{ fontSize: 11 }}>
                    retryLimit
                  </label>
                  <input
                    type="number"
                    className="wf-textarea"
                    style={{ marginTop: 4, width: 90, padding: "4px 8px" }}
                    value={selected.retryLimit ?? ""}
                    onChange={(e) => patchStep(selectedIndex, { retryLimit: e.target.value ? Number(e.target.value) : undefined })}
                  />
                </div>
                <div>
                  <label className="wf-dim" style={{ fontSize: 11 }}>
                    timeout (s)
                  </label>
                  <input
                    type="number"
                    className="wf-textarea"
                    style={{ marginTop: 4, width: 90, padding: "4px 8px" }}
                    value={selected.timeout ?? ""}
                    onChange={(e) => patchStep(selectedIndex, { timeout: e.target.value ? Number(e.target.value) : undefined })}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}

      <div className="wf-row" style={{ marginTop: 12 }}>
        <button className="wf-btn wf-btn-primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="wf-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
