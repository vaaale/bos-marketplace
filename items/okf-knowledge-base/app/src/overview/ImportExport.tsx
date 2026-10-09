// ImportExport.tsx — the bundle detail's Import / Export tab (US5).
//
// Export is spec-conformant OKF: the service regenerates the derived
// artifacts first, so the manifest always carries a correct concept-index.md
// and every toc/<docId>.md, and re-importing it reproduces a fully queryable
// bundle (SC-004). The card reports both facts from the response rather than
// asserting them, so a malformed export would be visible rather than claimed.

import React from "react";
import { Icon } from "../lib/icons";
import { exportBundle, importBundle } from "../lib/serviceClient";
import type { ExportResult } from "../lib/types";

export default function ImportExport({
  bundle,
  onIngest,
  onImport,
}: {
  bundle: string;
  onIngest: () => void;
  onImport: () => void;
}) {
  const [exported, setExported] = React.useState<ExportResult | null>(null);
  const [copyTo, setCopyTo] = React.useState(`${bundle}-copy`);
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const runExport = async () => {
    setError(null);
    setStatus("Exporting…");
    try {
      const res = await exportBundle(bundle);
      setExported(res);
      setStatus(null);
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    }
  };

  const runRoundTrip = async () => {
    setError(null);
    setStatus("Re-importing the export…");
    try {
      const res = exported || (await exportBundle(bundle));
      const out = await importBundle(copyTo, { files: res.files });
      setStatus(`Imported ${out.imported} file(s) into "${copyTo}": ${out.chapters} chapters, ${out.conceptTerms} concept terms. ${out.note}`);
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    }
  };

  const download = () => {
    if (!exported) return;
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${bundle}-okf-export.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div data-testid="import-export">
      <div className="io-grid">
        <div className="io-card">
          <h4>
            <Icon name="export" size={16} /> Export
          </h4>
          <div className="io-sub">
            Spec-conformant OKF — includes the concept index and every document TOC. Re-importing reproduces a queryable
            bundle.
          </div>
          <div className="row" style={{ justifyContent: "flex-start" }}>
            <button className="btn primary" onClick={runExport} data-testid="export-btn">
              <Icon name="export" size={14} /> Export
            </button>
            {exported ? (
              <button className="btn" onClick={download} data-testid="download-export">
                Download .json
              </button>
            ) : null}
          </div>
          {exported ? (
            <div style={{ marginTop: 12 }} data-testid="export-result">
              <div className="ok-line">
                <span className={`dot ${exported.conceptIndexIncluded ? "green" : "red"}`} />
                concept-index.md included <span className="m">{exported.conceptIndexIncluded ? "yes" : "MISSING"}</span>
              </div>
              <div className="ok-line">
                <span className={`dot ${exported.tocsIncluded ? "green" : "amber"}`} />
                document TOCs included <span className="m">{exported.tocsIncluded}</span>
              </div>
              <div className="ok-line">
                <span className="dot green" />
                files <span className="m">{exported.files.length}</span>
              </div>
              <div className="ok-line">
                <span className="dot green" />
                inline assets (by reference) <span className="m">{exported.assets.length}</span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="io-card">
          <h4>
            <Icon name="import" size={16} /> Import
          </h4>
          <div className="io-sub">
            Add another OKF bundle to this knowledge base service (side-by-side, not into the current bundle), or
            round-trip this bundle's export into a copy to verify conformance.
          </div>
          <label>Round-trip into bundle</label>
          <input value={copyTo} onChange={(e) => setCopyTo(e.target.value)} data-testid="roundtrip-name" />
          <div className="row" style={{ justifyContent: "flex-start" }}>
            <button className="btn primary" onClick={runRoundTrip} data-testid="roundtrip-btn">
              <Icon name="import" size={14} /> Export → Import
            </button>
            <button className="btn" onClick={onImport} data-testid="open-import-modal">
              Import another bundle…
            </button>
          </div>
        </div>
      </div>

      {status ? (
        <div className="note" style={{ marginTop: 14 }} data-testid="io-status">
          <Icon name="info" size={14} />
          <span>{status}</span>
        </div>
      ) : null}
      {error ? <div className="app-error" data-testid="io-error">{error}</div> : null}

      <div className="io-card" style={{ marginTop: 14 }}>
        <h4>
          <Icon name="import" size={16} /> Ingest a document into this bundle
        </h4>
        <div className="io-sub">
          The ingest agent decomposes the source into chapters, assigns concept terms, writes summaries, creates the
          TOC, and updates the concept index. Inline non-HTML assets are downloaded, interpreted, and preserved. The run
          is tracked in the <b>Jobs</b> tab.
        </div>
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <button className="btn primary" onClick={onIngest} data-testid="io-ingest-btn">
            <Icon name="import" size={14} /> Ingest
          </button>
        </div>
      </div>
    </div>
  );
}
