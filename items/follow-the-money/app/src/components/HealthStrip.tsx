// Always-visible data-health strip (FR-016 / FR-020): as-of + live dot,
// per-region dots with ok/total counts (from health.regions[]), key chip
// (presence only) that opens the ConfigDrawer.
import React from "react";
import type { Health } from "../lib/types";
import { fmtAsOf } from "../lib/format";

interface Props {
  health: Health | null;
  offline: boolean;
  onOpenDrawer: () => void;
}

export default function HealthStrip({ health, offline, onOpenDrawer }: Props) {
  const regions = health?.regions || [];
  const alive = !offline && Boolean(health?.pipelineAlive);
  return (
    <div className="health" data-testid="health-strip">
      <span className="asof">
        <span className={`live${alive ? "" : " off"}`} />
        {offline
          ? "Service offline"
          : `Last refresh ${fmtAsOf(health?.lastFullRefresh || null)}`}{" "}
        · data as-of <span className="num" data-testid="health-asof">{fmtAsOf(health?.asOf || null)}</span>
      </span>
      <span className="sep" />
      {regions.map((r, i) => (
        <React.Fragment key={r.region}>
          {i > 0 && <span className="sep" />}
          <span className={`hdot ${r.reason ? "warn" : r.ok > 0 ? "ok" : "off"}`} data-testid={`region-dot-${r.region}`}>
            <span className="d" />
            {r.region} <span className="count">{r.reason ? "awaiting" : `${r.ok}/${r.total}`}</span>
          </span>
        </React.Fragment>
      ))}
      <span className="sep" />
      <span
        className={`key-chip${health?.keyConfigured ? " set" : ""}`}
        onClick={onOpenDrawer}
        data-testid="key-chip"
      >
        <span className="d" />
        {health?.keyConfigured ? "key: configured" : "key: not configured"}
      </span>
    </div>
  );
}
