// Modals.tsx — New / Import / Ingest / Delete, as the mockup specifies.
//
// One honest deviation from a naive reading of the mockup, worth stating:
// the INGEST modal does not start an ingest from the browser. Ingest is a
// delegated agent run (`okf_ingest` → `agent_delegate` → the okf-ingest
// sub-agent), and an iframe is not an agent — the service's own dispatcher
// deliberately cannot fetch or decompose anything either (ADR-005). So this
// modal hands the user the exact call to give the assistant, and then points
// at the Jobs tab, where the run they trigger shows up live. Pretending to
// kick off a run from here and silently doing nothing would be worse than a
// modal that says plainly where the button actually is.

import React from "react";
import { Icon } from "../lib/icons";
import { getBundleRoot, importBundle, prepareIngest } from "../lib/serviceClient";
import type { BundleHealth } from "../lib/types";

function Modal({ children, onClose, testid }: { children: React.ReactNode; onClose: () => void; testid: string }) {
  return (
    <div
      className="modal"
      data-testid={testid}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card">{children}</div>
    </div>
  );
}

export function NewBundleModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, description: string) => Promise<void> }) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);

  const submit = async () => {
    try {
      await onCreate(name, description);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal onClose={onClose} testid="modal-new">
      <h3>New Knowledge Base</h3>
      <div className="desc">
        Creates a spec-conformant OKF bundle: <code>{getBundleRoot()}/&lt;name&gt;/</code> with <code>index.md</code>,{" "}
        <code>concept-index.md</code>, <code>toc/</code>, <code>concepts/</code>, <code>raw/</code>.
      </div>
      <label>Bundle name</label>
      <input
        placeholder="e.g. engineering-rules"
        value={name}
        onChange={(e) => setName(e.target.value)}
        data-testid="new-bundle-name"
        autoFocus
      />
      {name && !valid ? (
        <div className="desc" style={{ color: "var(--amber)", marginTop: 6 }}>
          Letters, digits, dot, dash and underscore only — it becomes a directory name.
        </div>
      ) : null}
      <label>Description (optional)</label>
      <input
        placeholder="Short description of what this KB covers"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        data-testid="new-bundle-desc"
      />
      {error ? <div className="app-error" style={{ margin: "12px 0 0" }}>{error}</div> : null}
      <div className="row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!valid} onClick={submit} data-testid="create-bundle-confirm">
          Create Bundle
        </button>
      </div>
    </Modal>
  );
}

export function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: (name: string) => Promise<void> }) {
  const [name, setName] = React.useState("");
  const [sourcePath, setSourcePath] = React.useState("");
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setStatus("Importing…");
    try {
      const res = await importBundle(name, { sourcePath });
      setStatus(res.note);
      await onImported(name);
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    }
  };

  return (
    <Modal onClose={onClose} testid="modal-import">
      <h3>Import Bundle</h3>
      <div className="desc">
        Imports an existing OKF directory from the VFS — its documents, chapters, concept index and document TOCs become
        queryable. If the imported chapters lack <code>parent</code>/<code>concepts</code>/<code>summary</code>, the
        derived index is rebuilt <b>best-effort</b> and reported, never silently half-built.
      </div>
      <label>New bundle name</label>
      <input placeholder="engineering-rules" value={name} onChange={(e) => setName(e.target.value)} data-testid="import-name" />
      <label>Source directory (VFS path)</label>
      <input
        placeholder={`${getBundleRoot()}/some-bundle`}
        value={sourcePath}
        onChange={(e) => setSourcePath(e.target.value)}
        data-testid="import-path"
      />
      <div className="desc" style={{ marginTop: 10 }}>
        Importing from a <b>git URL or tarball</b>? Ask the assistant to fetch and unpack it into the VFS first, then
        import that directory by path — the service runs in a worker thread with no shell of its own.
      </div>
      {status ? <div className="note" style={{ marginTop: 12 }}><Icon name="info" size={14} /><span>{status}</span></div> : null}
      {error ? <div className="app-error" style={{ margin: "12px 0 0" }}>{error}</div> : null}
      <div className="row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!name || !sourcePath} onClick={submit} data-testid="import-confirm">
          Import
        </button>
      </div>
    </Modal>
  );
}

export function IngestModal({ bundle, onClose }: { bundle: string; onClose: () => void }) {
  const [source, setSource] = React.useState("");
  const [queued, setQueued] = React.useState<Awaited<ReturnType<typeof prepareIngest>> | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const call = `okf_ingest({ bundle: "${bundle}", source: "${source || "https://…/article"}" })`;

  const queue = async () => {
    setError(null);
    setBusy(true);
    try {
      setQueued(await prepareIngest(bundle, source));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} testid="modal-ingest">
      <h3>Ingest document</h3>
      <div className="desc">
        Ingest decomposes the source into chapters (each with concept terms and a one-line summary), writes the document
        TOC, and updates the concept index. The decomposition runs in the bundled least-privilege <code>okf-ingest</code>{" "}
        agent — so queueing the run here records it in the <b>Jobs</b> tab, and the assistant performs the delegation.
      </div>
      <label>Source (URL, VFS path, or raw/ path)</label>
      <input
        placeholder="https://…/article  ·  /workspace/doc.pdf  ·  raw/…"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        data-testid="ingest-source"
        autoFocus
      />

      {queued ? (
        <div className="note" style={{ marginTop: 14 }} data-testid="ingest-queued">
          <Icon name="info" size={14} />
          <span>
            {queued.status === "already_ingested" ? (
              <>
                <b>Already ingested.</b> This source is in the bundle's provenance as{" "}
                <code>{queued.docId}</code> — it was not queued again.
              </>
            ) : (
              <>
                <b>Run {queued.jobId} queued.</b> {queued.instructions.split(".")[0]}. Ask the assistant to run the call
                below, then watch it in the <b>Jobs</b> tab.
              </>
            )}
          </span>
        </div>
      ) : null}

      <label>Ask the assistant to run</label>
      <input
        readOnly
        value={call}
        data-testid="ingest-call"
        style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}
      />
      {error ? <div className="app-error" style={{ margin: "12px 0 0" }}>{error}</div> : null}

      <div className="row">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button
          className="btn"
          data-testid="copy-ingest-call"
          onClick={() => {
            void navigator.clipboard?.writeText(call);
            setCopied(true);
          }}
        >
          <Icon name="check" size={14} /> {copied ? "Copied" : "Copy call"}
        </button>
        <button className="btn primary" disabled={!source || busy} onClick={queue} data-testid="queue-ingest">
          <Icon name="import" size={14} /> {busy ? "Queueing…" : "Queue run"}
        </button>
      </div>
    </Modal>
  );
}

export function DeleteModal({ target, onClose, onConfirm }: { target: BundleHealth; onClose: () => void; onConfirm: () => Promise<void> }) {
  return (
    <Modal onClose={onClose} testid="modal-delete">
      <h3>Delete knowledge base?</h3>
      <div className="desc" style={{ marginTop: 6 }}>
        This removes only this bundle's directory (<code>{getBundleRoot()}/{target.name}/</code>). Its {target.docs}{" "}
        document(s), {target.chapters} chapter(s), the concept index, the TOCs and every raw source are all removed.
      </div>
      <div className="confirm-ic" style={{ marginTop: 14, color: "var(--red)" }}>
        <Icon name="alert" size={16} />
        <span style={{ color: "var(--text)" }}>This action cannot be undone.</span>
      </div>
      <div className="row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn danger" onClick={() => void onConfirm()} data-testid="delete-confirm">
          Delete Bundle
        </button>
      </div>
    </Modal>
  );
}
