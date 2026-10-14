// Modals.tsx — New / Import / Ingest / Delete, as the mockup specifies.
//
// The INGEST modal really starts the run. It used to not: ingest was a
// delegated agent run and the service had no way to launch one, so the modal
// handed the user an `okf_ingest(...)` call to copy and give their assistant.
// The service can launch runs now (POST /jobs → core.triggerIngest →
// delegate-bridge), so the button does what the button says, and the run
// appears in the Jobs tab seconds later. Nothing is relayed through the user.

import React from "react";
import { Icon } from "../lib/icons";
import { getBundleRoot, importBundle, triggerIngest, reingestBundle, reingestDocument } from "../lib/serviceClient";
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

export function IngestModal({ bundle, onClose, onStarted }: { bundle: string; onClose: () => void; onStarted?: () => void }) {
  const [source, setSource] = React.useState("");
  const [started, setStarted] = React.useState<Awaited<ReturnType<typeof triggerIngest>> | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const start = async (reingest = false) => {
    setError(null);
    setBusy(true);
    try {
      const res = await triggerIngest(bundle, source, { reingest });
      setStarted(res);
      onStarted?.();
      // A started run is watched in the Jobs tab, not in here — the dialog has
      // nothing left to say, so it gets out of the way (the mockup's Ingest
      // button closes the modal) and `onStarted` takes the user to the run.
      // `already_ingested` is the one case that stays: no run was started, and
      // this note is the only place that answer exists.
      if (res.status !== "already_ingested") onClose();
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
        TOC, and updates the concept index. The work runs in the bundled least-privilege <code>okf-ingest</code> agent —
        starting it here starts it for real, and the run appears in the <b>Jobs</b> tab.
      </div>
      <label>Source (URL, VFS path, or raw/ path)</label>
      <input
        placeholder="https://…/article  ·  /workspace/doc.pdf  ·  raw/…"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        data-testid="ingest-source"
        autoFocus
      />

      {started ? (
        <div className="note" style={{ marginTop: 14 }} data-testid="ingest-started">
          <Icon name="info" size={14} />
          <span>
            {started.status === "already_ingested" ? (
              <>
                <b>Already ingested.</b> This source is in the bundle&apos;s provenance as <code>{started.docId}</code> —
                no run was started, and no duplicate document was created. <b>Re-ingest</b> replaces it with a fresh
                ingest of the same source: the current version stays until the new run completes, a failed or cancelled run
                changes nothing, and <code>raw/</code> keeps every version.
              </>
            ) : (
              <>
                <b>Run {started.jobId} started.</b> It is running now. Watch it in the <b>Jobs</b> tab: it ends{" "}
                <i>completed</i> with a summary, or <i>failed</i> with a reason.
              </>
            )}
          </span>
        </div>
      ) : (
        <div className="desc" style={{ marginTop: 10 }}>
          A source already in this bundle&apos;s provenance ledger is not ingested twice — you will be told which
          document it already is.
        </div>
      )}

      {error ? <div className="app-error" style={{ margin: "12px 0 0" }}>{error}</div> : null}

      <div className="row">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        {started?.status === "already_ingested" ? (
          <button className="btn primary" disabled={busy} onClick={() => void start(true)} data-testid="ingest-reingest">
            <Icon name="refresh" size={14} /> {busy ? "Starting…" : "Re-ingest — replace it"}
          </button>
        ) : (
          <button className="btn primary" disabled={!source || busy} onClick={() => void start()} data-testid="start-ingest">
            <Icon name="import" size={14} /> {busy ? "Starting…" : "Start ingest"}
          </button>
        )}
      </div>
    </Modal>
  );
}

/**
 * Confirm a re-ingest — of one document (`docId`) or of the whole bundle. Both
 * go through the service's run queue; the confirmation says exactly what is
 * replaced, because a re-ingest clears a document when its run starts.
 */
export function ReingestModal({
  bundle,
  docId,
  title,
  docCount,
  onClose,
  onStarted,
}: {
  bundle: string;
  docId?: string;
  title?: string;
  docCount?: number;
  onClose: () => void;
  onStarted?: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      if (docId) await reingestDocument(bundle, docId);
      else await reingestBundle(bundle);
      onStarted?.();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} testid="modal-reingest">
      <h3>{docId ? `Re-ingest “${title || docId}”?` : `Re-ingest all ${docCount ?? ""} document(s) in ${bundle}?`}</h3>
      <div className="desc" style={{ marginTop: 6 }}>
        {docId ? "The document is" : "Each document is"} fetched again from its original source and rewritten under the
        same id. {docId ? "The current version stays" : "Each current version stays"} until its run{" "}
        <b>completes</b> — a failed or cancelled run changes nothing; <code>raw/</code> keeps every version. Runs are queued and start a few at a time — watch them in the{" "}
        <b>Jobs</b> tab.
      </div>
      {error ? <div className="app-error" style={{ margin: "12px 0 0" }}>{error}</div> : null}
      <div className="row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void confirm()} data-testid="reingest-confirm">
          <Icon name="refresh" size={14} /> {busy ? "Queuing…" : "Re-ingest"}
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
