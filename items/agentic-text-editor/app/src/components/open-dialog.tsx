"use client";

// The file picker (FR-005) and its "save as" twin.
//
// BOS has no shared file-chooser widget an installed app can mount, so the app
// browses the VFS itself through the SDK's fs:read capability. One component
// serves both jobs: in "save" mode it adds a filename field and returns the
// composed path.

import { useEffect, useState } from "react";
import { ChevronRight, File, FolderOpen, Loader2, X } from "lucide-react";
import { dirname, listDirectory } from "../services/file-service";
import type { VfsEntry } from "../types-vfs";

export function OpenDialog({
  mode,
  title,
  initialDirectory = "/Documents",
  initialFilename = "",
  onCancel,
  onConfirm,
}: {
  mode: "open" | "save";
  title: string;
  initialDirectory?: string;
  initialFilename?: string;
  onCancel: () => void;
  onConfirm: (path: string) => void;
}) {
  const [directory, setDirectory] = useState(initialDirectory);
  const [filename, setFilename] = useState(initialFilename);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The listing, tagged with the directory it belongs to. */
  const [listing, setListing] = useState<{ dir: string; entries: VfsEntry[] } | null>(null);

  // "Loading", "what to show" and "is the selection still valid" are all
  // FUNCTIONS of (directory, listing, selected) — deriving them means the
  // directory-change effect has nothing to set synchronously, and a listing
  // that arrives for a directory the user has already left is ignored rather
  // than briefly painted.
  const loading = listing?.dir !== directory;
  const entries = listing?.dir === directory ? listing.entries : [];
  const selectedPath = selected && dirname(selected) === directory ? selected : null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const found = await listDirectory(directory);
        if (cancelled) return;
        setListing({ dir: directory, entries: found });
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setListing({ dir: directory, entries: [] });
        setError((err as Error).message);
        // A missing directory shouldn't strand the dialog — fall back to the root.
        if (directory !== "/") setDirectory("/");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [directory]);

  const crumbs = ["/", ...directory.split("/").filter(Boolean)];
  const confirmPath =
    mode === "save"
      ? `${directory === "/" ? "" : directory}/${filename.trim()}`.replace(/\/{2,}/g, "/")
      : (selectedPath ?? "");
  const canConfirm = mode === "save" ? filename.trim().length > 0 : selectedPath !== null;

  return (
    <div className="ate-scrim" role="dialog" aria-modal="true" aria-label={title} data-testid="ate-file-dialog">
      <div className="ate-dialog" style={{ width: 520, height: 460 }}>
        <div className="ate-dialog-header">
          <FolderOpen size={14} strokeWidth={1.9} />
          <h3>{title}</h3>
          <button className="ate-btn-icon" onClick={onCancel} aria-label="Close">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="ate-dialog-body">
          <div className="ate-path-crumbs">
            {crumbs.map((crumb, i) => {
              const path = i === 0 ? "/" : `/${crumbs.slice(1, i + 1).join("/")}`;
              return (
                <span key={path} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                  {i > 0 && <ChevronRight size={10} strokeWidth={2} />}
                  <button className="ate-crumb" onClick={() => setDirectory(path)}>
                    {i === 0 ? "Home" : crumb}
                  </button>
                </span>
              );
            })}
          </div>

          {loading ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 4px" }}>
              <Loader2 size={13} className="ate-typing" strokeWidth={2} />
              Loading…
            </div>
          ) : (
            <div className="ate-file-list">
              {directory !== "/" && (
                <button className="ate-file-row" onClick={() => setDirectory(dirname(directory))}>
                  <FolderOpen size={13} strokeWidth={1.9} />
                  ..
                </button>
              )}
              {entries.length === 0 && <div className="ate-note">This folder is empty.</div>}
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  className="ate-file-row"
                  data-selected={selectedPath === entry.path}
                  onClick={() => {
                    if (entry.type === "dir") setDirectory(entry.path);
                    else if (mode === "save") setFilename(entry.name);
                    else setSelected(entry.path);
                  }}
                  onDoubleClick={() => {
                    if (entry.type === "file" && mode === "open") onConfirm(entry.path);
                  }}
                >
                  {entry.type === "dir" ? (
                    <FolderOpen size={13} strokeWidth={1.9} />
                  ) : (
                    <File size={13} strokeWidth={1.9} />
                  )}
                  {entry.name}
                  {entry.type === "file" && <span className="ate-file-meta">{entry.size} B</span>}
                </button>
              ))}
            </div>
          )}

          {mode === "save" && (
            <div className="ate-field" style={{ marginTop: 12 }}>
              <label htmlFor="ate-save-filename">File name</label>
              <input
                id="ate-save-filename"
                className="ate-input"
                value={filename}
                placeholder="notes.md"
                onChange={(e) => setFilename(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canConfirm) onConfirm(confirmPath);
                }}
              />
            </div>
          )}

          {error && <div className="ate-error-text">{error}</div>}
        </div>

        <div className="ate-dialog-footer">
          <button className="ate-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="ate-btn ate-btn-primary"
            disabled={!canConfirm}
            onClick={() => onConfirm(confirmPath)}
            data-testid="ate-file-dialog-confirm"
          >
            {mode === "save" ? "Save" : "Open"}
          </button>
        </div>
      </div>
    </div>
  );
}
