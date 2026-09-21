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
  // Fix A: a configured key that the provider REJECTED is a distinct, red state
  // — it must not read as either "configured" (green) or "not configured"
  // (amber), because the user's action is to re-enter/rotate, not to add one.
  const authError = health !== null && health.providers.some((p) => p.status === "auth_error");
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
      {regions.map((r, i) => {
        const rejected = r.reason !== undefined && /rejected/i.test(r.reason);
        const dotCls = r.reason ? (rejected ? "err" : "warn") : r.ok > 0 ? "ok" : "off";
        return (
          <React.Fragment key={r.region}>
            {i > 0 && <span className="sep" />}
            <span className={`hdot ${dotCls}`} data-testid={`region-dot-${r.region}`}>
              <span className="d" />
              {r.region} <span className="count">{r.reason ? (rejected ? "rejected" : "awaiting") : `${r.ok}/${r.total}`}</span>
            </span>
          </React.Fragment>
        );
      })}
      <span className="sep" />
      {/* health === null means no fresh data (service unreachable / not loaded
          yet) — that is NOT a known "not configured." Render an honest unknown
          so an absent health can't masquerade as a false negative. */}
      <span
        className={`key-chip${authError ? " err" : health !== null && health.keyConfigured ? " set" : ""}`}
        onClick={onOpenDrawer}
        data-testid="key-chip"
      >
        <span className="d" />
        {health === null
          ? "key: unknown"
          : authError
            ? "key: REJECTED"
            : health.keyConfigured
              ? "key: configured"
              : "key: not configured"}
      </span>
    </div>
  );
}
