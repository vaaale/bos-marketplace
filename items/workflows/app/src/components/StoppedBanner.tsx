import React from "react";

export function StoppedBanner() {
  return (
    <div className="wf-banner">
      <span>⚠</span>
      <span style={{ flex: 1 }}>
        The Workflows service is not running. Workflow tools are unavailable and runs are refused. Start it in Settings → Plugins → Services.
      </span>
    </div>
  );
}
