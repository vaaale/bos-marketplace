// Overview.tsx — the bundle-management surface (FR-035/FR-036 / US7).
//
// Navigation mirrors the mockup exactly:
//   bundle list → bundle detail (health stat cards + Concept Index /
//   Documents / Health / Import·Export tabs) → concept index → document →
//   stored TOC → full chapter (inline-asset blocks + "View source (.md)")
//
// Every number on screen comes from the service's own derived model — the
// app computes no counts of its own, so what the user sees is exactly what
// the agent's okf_list_bundles / okf_read_toc / okf_read_concept return.

import React from "react";
import { Icon } from "../lib/icons";
import { createBundle, deleteBundle, fetchBundleDetail } from "../lib/serviceClient";
import type { BundleDetail, BundleHealth, DocumentRow } from "../lib/types";
import BundleList from "./BundleList";
import BundleDetailView from "./BundleDetail";
import { DeleteModal, ImportModal, IngestModal, NewBundleModal, ReingestModal } from "./Modals";

export type ModalKind = "new" | "import" | "export" | "ingest" | "delete" | "reingest" | null;

interface Props {
  bundles: BundleHealth[];
  activeBundle: string | null;
  onActiveBundle: (name: string | null) => void;
  onBundlesChanged: () => Promise<void> | void;
  /** Called when the Ingest modal starts a real run — the shell switches to
   *  the Jobs tab, which is where the run can actually be watched (FR-041). */
  onIngestStarted?: () => void;
}

export default function Overview({ bundles, activeBundle, onActiveBundle, onBundlesChanged, onIngestStarted }: Props) {
  const [view, setView] = React.useState<"list" | "detail">("list");
  const [detail, setDetail] = React.useState<BundleDetail | null>(null);
  const [openBundle, setOpenBundle] = React.useState<string | null>(null);
  const [modal, setModal] = React.useState<ModalKind>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<BundleHealth | null>(null);
  // null = the whole bundle; a row = one document
  const [reingestTarget, setReingestTarget] = React.useState<DocumentRow | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const loadDetail = React.useCallback(async (name: string) => {
    setDetail(null);
    setDetail(await fetchBundleDetail(name));
  }, []);

  const open = React.useCallback(
    async (name: string) => {
      setOpenBundle(name);
      onActiveBundle(name);
      setView("detail");
      await loadDetail(name);
    },
    [loadDetail, onActiveBundle],
  );

  const goList = () => {
    setView("list");
    setOpenBundle(null);
    setDetail(null);
  };

  const onCreate = async (name: string, description: string) => {
    setBusy("Creating…");
    try {
      await createBundle(name, name, description);
      await onBundlesChanged();
      setModal(null);
      await open(name);
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async () => {
    if (!deleteTarget) return;
    setBusy("Deleting…");
    try {
      await deleteBundle(deleteTarget.name);
      await onBundlesChanged();
      setModal(null);
      setDeleteTarget(null);
      goList();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="wrap">
      <div className="crumb" data-testid="crumb">
        {view === "list" ? (
          <span className="cur">Bundles</span>
        ) : (
          <>
            <a onClick={goList} data-testid="crumb-bundles">
              Bundles
            </a>
            <span className="sep">/</span>
            <span className="cur">{openBundle}</span>
          </>
        )}
      </div>

      {view === "list" ? (
        <BundleList
          bundles={bundles}
          onOpen={open}
          onNew={() => setModal("new")}
          onImport={() => setModal("import")}
          onDelete={(b) => {
            setDeleteTarget(b);
            setModal("delete");
          }}
        />
      ) : (
        <BundleDetailView
          bundleName={openBundle!}
          detail={detail}
          onBack={goList}
          onIngest={() => setModal("ingest")}
          onImport={() => setModal("import")}
          onDelete={() => {
            const b = bundles.find((x) => x.name === openBundle) || null;
            setDeleteTarget(b);
            setModal("delete");
          }}
          onReload={() => loadDetail(openBundle!)}
          onReingestAll={() => {
            setReingestTarget(null);
            setModal("reingest");
          }}
          onReingestDoc={(doc) => {
            setReingestTarget(doc);
            setModal("reingest");
          }}
        />
      )}

      {busy ? <div className="app-loading">{busy}</div> : null}

      {modal === "new" ? <NewBundleModal onClose={() => setModal(null)} onCreate={onCreate} /> : null}
      {modal === "import" ? (
        <ImportModal
          onClose={() => setModal(null)}
          onImported={async (name) => {
            await onBundlesChanged();
            setModal(null);
            await open(name);
          }}
        />
      ) : null}
      {modal === "ingest" ? (
        <IngestModal bundle={openBundle || ""} onClose={() => setModal(null)} onStarted={onIngestStarted} />
      ) : null}
      {modal === "reingest" ? (
        <ReingestModal
          bundle={openBundle || ""}
          docId={reingestTarget?.id}
          title={reingestTarget?.title}
          docCount={detail?.health.docs}
          onClose={() => {
            setModal(null);
            setReingestTarget(null);
          }}
          onStarted={onIngestStarted}
        />
      ) : null}
      {modal === "delete" && deleteTarget ? (
        <DeleteModal
          target={deleteTarget}
          onClose={() => {
            setModal(null);
            setDeleteTarget(null);
          }}
          onConfirm={onDelete}
        />
      ) : null}
    </div>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="note">
      <Icon name="info" size={14} />
      <span>{children}</span>
    </div>
  );
}

export function StatusPill({ status, stale }: { status?: string; stale?: boolean }) {
  if (stale) return <span className="pill stale">stale</span>;
  if (status === "deprecated") return <span className="pill deprecated">deprecated</span>;
  return null;
}
