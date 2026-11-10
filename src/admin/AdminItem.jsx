import { useCallback, useEffect, useState } from "react";
import ItemView, { ITEM_TITLE_ID } from "../components/ItemView.jsx";
import { EmptyState, LoadingState } from "../components/StatusMessage.jsx";
import useDocumentTitle from "../hooks/useDocumentTitle.js";
import { closeItem, openPanel } from "../router.js";
import { refreshLibrary, shapeItem } from "../services/libraryRepository.js";
import { findItemId, forgetItem, rememberItem } from "./catalog.js";
import { adminApi } from "./client.js";
import { formFromItem, reviveForm } from "./editorModel.js";
import { flash, takePanelNotice } from "./flash.js";
import HistoryView from "./HistoryView.jsx";
import ItemEditor from "./ItemEditor.jsx";
import { ConfirmBox, ErrorNotice, formatDateTime, LibraryUnavailable, PanelTools, StatusBadge, useLibraryMeta } from "./ui.jsx";
import { clearUnsaved, readUnsaved } from "./unsaved.js";

/**
 * One item in Edit mode. Always read straight from the admin API (current
 * revision, drafts included), shown with the normal reading view, plus a
 * toolbar in the panel's top bar: Edit, Publish / Unpublish, History, Delete.
 *
 * Every action sends the revision it is based on; if the item changed
 * elsewhere meanwhile (409), it is reloaded and the admin is told to retry.
 */
export default function AdminItem({ slug, toolsElement, closeGuardRef }) {
  const { meta, error: metaError } = useLibraryMeta();
  const [load, setLoad] = useState({ status: "loading", error: null });
  const [item, setItem] = useState(null); // the admin API's item (raw, with blocks)
  const [mode, setMode] = useState("view"); // view | edit | history | delete
  const [edit, setEdit] = useState(null); // { form, baseForm, baseRevision, restored }
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(() => takePanelNotice(slug));
  const [actionError, setActionError] = useState(null);
  const [stored, setStored] = useState(null); // unsaved changes from earlier in this tab

  const apply = useCallback((next) => {
    setItem(next);
    rememberItem(next);
    const saved = readUnsaved(next.id);
    setStored(saved && reviveForm(saved.form, next.type) ? saved : null);
  }, []);

  const reload = useCallback(async () => {
    setLoad((previous) => ({ status: previous.status === "ready" ? "ready" : "loading", error: null }));
    try {
      const id = await findItemId(slug);
      if (!id) {
        setLoad({ status: "missing", error: null });
        return null;
      }
      const data = await adminApi.getItem(id);
      apply(data.item);
      setLoad({ status: "ready", error: null });
      return data.item;
    } catch (error) {
      setLoad(error?.kind === "not_found" ? { status: "missing", error: null } : { status: "error", error });
      return null;
    }
  }, [slug, apply]);

  useEffect(() => {
    reload();
  }, [reload]);

  useDocumentTitle(item ? (mode === "edit" ? `Editing: ${item.title}` : item.title) : null);

  const startEdit = (saved = null) => {
    const baseForm = formFromItem(item);
    const restoredForm = saved ? reviveForm(saved.form, item.type) : null;
    const restoredBase = saved ? reviveForm(saved.baseForm, item.type) : null;
    setEdit(
      restoredForm
        ? { form: restoredForm, baseForm: restoredBase ?? baseForm, baseRevision: saved.baseRevision ?? item.revision, restored: true }
        : { form: baseForm, baseForm, baseRevision: item.revision, restored: false },
    );
    setNotice(null);
    setActionError(null);
    setMode("edit");
  };

  const discardStored = () => {
    clearUnsaved(item.id);
    setStored(null);
  };

  async function run(action) {
    setBusy(action);
    setActionError(null);
    setNotice(null);
    try {
      if (action === "delete") {
        await adminApi.deleteItem(item.id, item.revision);
        clearUnsaved(item.id);
        forgetItem(item.id);
        refreshLibrary();
        flash(`Deleted “${item.title}”. You can recover it from Deleted items (it returns as a draft).`);
        closeItem();
        return;
      }
      const data = action === "publish" ? await adminApi.publishItem(item.id, item.revision) : await adminApi.unpublishItem(item.id, item.revision);
      apply(data.item);
      setMode("view");
      setNotice(
        action === "publish"
          ? "Published. Visitors can see it now."
          : "Unpublished. It is a draft again, and visitors no longer see it.",
      );
      refreshLibrary();
    } catch (error) {
      if (error?.kind === "conflict") {
        await reload();
        setMode("view");
      } else if (error?.kind === "not_found") {
        setLoad({ status: "missing", error: null });
      }
      setActionError(error);
    } finally {
      setBusy(null);
    }
  }

  if (load.status === "missing") {
    return (
      <EmptyState title="This item is not in the library.">
        <span>It may have been deleted. Deleted items can be recovered.</span>
        <button className="button" onClick={() => openPanel("deleted")} type="button">
          Deleted items
        </button>
      </EmptyState>
    );
  }
  if (load.status === "error") {
    return (
      <div className="reader">
        <h2 className="visually-hidden" id={ITEM_TITLE_ID}>
          This item could not be opened for editing
        </h2>
        <ErrorNotice error={load.error} onRetry={reload} />
      </div>
    );
  }
  if (!meta && metaError) return <LibraryUnavailable toolsElement={toolsElement} />;
  if (!item || !meta) return <LoadingState label="Opening…" />;

  if (mode === "edit") {
    return (
      <ItemEditor
        baseForm={edit.baseForm}
        baseRevision={edit.baseRevision}
        closeGuardRef={closeGuardRef}
        initialForm={edit.form}
        item={item}
        kind="edit"
        meta={meta}
        onCancel={() => {
          setMode("view");
          apply(item);
        }}
        onReloaded={(latest) => {
          apply(latest);
          setMode("view");
          setNotice("Showing the latest version. Your changes were discarded.");
        }}
        onSaved={(saved, { notice: message, published } = {}) => {
          apply(saved);
          setMode("view");
          setNotice(
            message ??
              (published ? "Saved and published. Visitors can see it now." : saved.status === "published" ? "Saved. Visitors see the new version now." : "Saved."),
          );
          refreshLibrary();
        }}
        restored={edit.restored}
        storageKey={item.id}
        toolsElement={toolsElement}
      />
    );
  }

  if (mode === "history") {
    return (
      <HistoryView
        item={item}
        meta={meta}
        onBack={() => setMode("view")}
        onConflict={reload}
        onRestored={(restored, fromRevision) => {
          apply(restored);
          setMode("view");
          setNotice(`Restored revision ${fromRevision} (saved as revision ${restored.revision}).`);
          refreshLibrary();
        }}
        toolsElement={toolsElement}
      />
    );
  }

  const published = item.status === "published";
  return (
    <>
      <PanelTools target={toolsElement}>
        <StatusBadge status={item.status} />
        <span className="admin-tools__spacer" />
        <button className="button button--small button--primary" onClick={() => startEdit()} type="button">
          Edit
        </button>
        <button
          aria-disabled={busy !== null || undefined}
          className="button button--small"
          onClick={() => busy === null && run(published ? "unpublish" : "publish")}
          type="button"
        >
          {busy === "publish" ? "Publishing…" : busy === "unpublish" ? "Unpublishing…" : published ? "Unpublish" : "Publish"}
        </button>
        <button className="button button--small" onClick={() => setMode("history")} type="button">
          History
        </button>
        <button className="button button--small button--danger" onClick={() => setMode("delete")} type="button">
          Delete
        </button>
      </PanelTools>

      <div className="admin-panel-messages">
        <p className="admin-notice admin-notice--success" hidden={!notice} role="status">
          {notice}
        </p>
        <ErrorNotice error={actionError} keepsChanges={false}>
          {actionError?.kind === "conflict" && <p>It has been reloaded: check it, then try again.</p>}
        </ErrorNotice>
        {stored && (
          <div className="admin-notice">
            <p>
              <strong>You have unsaved changes to this item</strong> from {formatDateTime(stored.savedAt)}.
            </p>
            <div className="admin-notice__actions">
              <button className="button button--small button--primary" onClick={() => startEdit(stored)} type="button">
                Continue editing
              </button>
              <button className="button button--small" onClick={discardStored} type="button">
                Discard them
              </button>
            </div>
          </div>
        )}
        {mode === "delete" && (
          <ConfirmBox
            busy={busy === "delete"}
            confirmLabel="Delete"
            danger
            onCancel={() => setMode("view")}
            onConfirm={() => run("delete")}
            title={`Delete “${item.title}”?`}
          >
            It disappears from the library at once{published ? ", for visitors too" : ""}. You can recover it later from
            Deleted items (it comes back as a draft, with its history).
          </ConfirmBox>
        )}
      </div>

      <ItemView item={shapeItem(item, meta)} key={item.id} />
    </>
  );
}
