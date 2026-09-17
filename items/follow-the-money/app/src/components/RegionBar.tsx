// Region + lookback segmented controls (FR-007). The active choices are
// persisted by App into localStorage and re-scope dashboard/scanner/detail.
import React from "react";
import type { Lookback, Region } from "../lib/types";

const REGIONS: Region[] = ["US", "Europe", "Norway", "Asia"];
const LOOKBACKS: Lookback[] = ["3M", "6M", "1Y", "2Y"];

interface Props {
  region: Region;
  lookback: Lookback;
  onRegion: (r: Region) => void;
  onLookback: (l: Lookback) => void;
}

export default function RegionBar({ region, lookback, onRegion, onLookback }: Props) {
  return (
    <>
      <div className="ctl-group">
        <span className="ctl-lbl">Region</span>
        <div className="seg" data-testid="region-seg">
          {REGIONS.map((r) => (
            <button key={r} className={region === r ? "on" : ""} onClick={() => onRegion(r)} data-testid={`region-${r}`}>
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="ctl-group">
        <span className="ctl-lbl">Lookback</span>
        <div className="seg" data-testid="lookback-seg">
          {LOOKBACKS.map((l) => (
            <button key={l} className={lookback === l ? "on" : ""} onClick={() => onLookback(l)} data-testid={`lookback-${l}`}>
              {l}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
