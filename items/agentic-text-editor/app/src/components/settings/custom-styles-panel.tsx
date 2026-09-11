"use client";

// Settings → Custom Styles (v3, FR-029; mockup.html is the binding contract).
//
// The tab swaps between two views: the LIST (built-in group + user group) and
// the EDITOR (name + CSS form beside a live preview). This panel owns the swap
// and the editor's draft state — the draft has to live here because two
// children render it at once: the form edits it and the preview column restyles
// on every keystroke.
//
// The registry itself is the module cache in config/custom-styles.ts; all
// mutations go through the document store's style actions, whose
// customStylesVersion bump is what re-renders this panel AND any open preview.

import { useState } from "react";
import { ArrowLeft, Check, Lock, Plus, Trash2, Undo2 } from "lucide-react";
import {
  builtinDefaultCss,
  effectiveCss,
  isBuiltin,
  isOverridden,
  styleExists,
} from "../../config/custom-styles";
import { useEditorStore } from "../../state/document-store";
import { StyleEditor } from "./style-editor";
import { StyleList } from "./style-list";
import { StylePreview } from "./style-preview";

/** Starting CSS for a brand-new style (the mockup's NEW_CSS). */
const NEW_STYLE_CSS = [
  "background: rgba(255,255,255,0.06);",
  "border: 1px solid rgba(255,255,255,0.18);",
  "border-radius: 8px;",
  "padding: 12px 16px;",
  "color: #e0e0e0;",
].join("\n");

/** null = list view; otherwise the editor view's target. */
type EditTarget = { isNew: true } | { isNew: false; name: string };

export function CustomStylesPanel() {
  // Subscribing to the version is what re-reads the registry after every CRUD.
  useEditorStore((s) => s.customStylesVersion);

  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftCss, setDraftCss] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  const openEditor = (name: string): void => {
    setEditing({ isNew: false, name });
    setDraftName(name);
    setDraftCss(effectiveCss(name));
    setNameError(null);
  };

  const openNew = (): void => {
    setEditing({ isNew: true });
    setDraftName("");
    setDraftCss(NEW_STYLE_CSS);
    setNameError(null);
  };

  const backToList = (): void => {
    setEditing(null);
    setNameError(null);
  };

  /** Done: validate, dispatch to the store, return to the list. */
  const save = (): void => {
    if (!editing) return;
    const store = useEditorStore.getState();
    const name = draftName.trim();
    if (editing.isNew) {
      if (!name) {
        setNameError('Give the style a name (used in ::: {custom-style="…"}).');
        return;
      }
      if (styleExists(name)) {
        setNameError(`“${name}” already exists.`);
        return;
      }
      store.addStyle(name, draftCss);
    } else if (isBuiltin(editing.name)) {
      store.overrideBuiltIn(editing.name, draftCss);
    } else if (name && name !== editing.name) {
      // A renamed user style: the old entry goes, the new name takes the CSS.
      if (styleExists(name)) {
        setNameError(`“${name}” already exists.`);
        return;
      }
      store.removeStyle(editing.name);
      store.addStyle(name, draftCss);
    } else {
      if (!name) {
        setNameError('Give the style a name (used in ::: {custom-style="…"}).');
        return;
      }
      store.updateStyle(editing.name, draftCss);
    }
    backToList();
  };

  const removeCurrent = (): void => {
    if (editing && !editing.isNew && !isBuiltin(editing.name)) {
      useEditorStore.getState().removeStyle(editing.name);
    }
    backToList();
  };

  const resetCurrent = (): void => {
    if (!editing || editing.isNew || !isBuiltin(editing.name)) return;
    useEditorStore.getState().resetBuiltIn(editing.name);
    setDraftCss(builtinDefaultCss(editing.name) ?? "");
  };

  // ------------------------------------------------------------- editor view

  if (editing) {
    const builtin = !editing.isNew && isBuiltin(editing.name);
    const defaultCss = builtin ? builtinDefaultCss(editing.name) : null;
    const modified = builtin && (isOverridden(editing.name) || draftCss !== defaultCss);

    return (
      <div className="ate-cs-edit" data-testid="ate-cs-editor">
        <div className="ate-cs-edit-head">
          <button
            type="button"
            className="ate-btn-icon"
            onClick={backToList}
            aria-label="Back to styles"
            data-testid="ate-cs-back"
          >
            <ArrowLeft size={14} strokeWidth={2} />
          </button>
          <div className="ate-cs-edit-title">
            {editing.isNew ? "New style" : <>Edit <em>{editing.name}</em></>}
          </div>
          {builtin ? (
            <span className="ate-pill ate-pill-amber">
              <Lock size={10} strokeWidth={2} />
              built-in
            </span>
          ) : (
            <span className="ate-pill ate-pill-violet">user</span>
          )}
          <span className="ate-cs-spacer" />
          <button type="button" className="ate-btn ate-btn-primary" onClick={save} data-testid="ate-cs-save">
            <Check size={13} strokeWidth={2} />
            Done
          </button>
        </div>

        <div className="ate-cs-edit-body">
          <StyleEditor
            name={draftName}
            css={draftCss}
            builtin={builtin}
            isNew={!!editing.isNew}
            nameError={nameError}
            onNameChange={(next) => {
              setDraftName(next);
              if (nameError && next.trim()) setNameError(null);
            }}
            onCssChange={setDraftCss}
            actions={
              <div className="ate-cs-form-actions">
                {!editing.isNew && !builtin && (
                  <button
                    type="button"
                    className="ate-btn ate-btn-danger"
                    onClick={removeCurrent}
                    data-testid="ate-cs-remove"
                  >
                    <Trash2 size={13} strokeWidth={1.9} />
                    Remove style
                  </button>
                )}
                {builtin && (
                  <button
                    type="button"
                    className="ate-btn"
                    onClick={resetCurrent}
                    disabled={!modified}
                    data-testid="ate-cs-reset"
                  >
                    <Undo2 size={13} strokeWidth={1.9} />
                    Reset to default
                  </button>
                )}
              </div>
            }
          />
          <StylePreview name={draftName.trim() || "…"} css={draftCss} />
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------- list view

  return (
    <div data-testid="ate-cs-list-view">
      <div className="ate-cs-head">
        <div className="ate-cs-head-text">
          <h3>Custom Styles</h3>
          <p>
            Define named styles used by pandoc fenced divs. Wrap any block in{" "}
            <code>{'::: {custom-style="Name"}'}</code> … <code>:::</code> and it renders here. Names not in this
            registry still render — as a neutral container.
          </p>
        </div>
        <button type="button" className="ate-btn ate-btn-primary" onClick={openNew} data-testid="ate-cs-add">
          <Plus size={13} strokeWidth={2} />
          Add style
        </button>
      </div>

      <StyleList onEdit={openEditor} />
    </div>
  );
}
