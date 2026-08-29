import React from "react";

export function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="wf-empty">
      <div className="wf-empty-icon">⌗</div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>No workflows in /Workflows/</div>
        <div style={{ marginTop: 4, color: "rgba(255,255,255,0.5)" }}>
          Create one below, or place a workflow JSON at /Workflows/ — the engine, Files, and this app all read the same location.
        </div>
      </div>
      <button className="wf-btn" onClick={onCreate}>
        + New workflow <span className="wf-tool-label">workflow_create</span>
      </button>
    </div>
  );
}
