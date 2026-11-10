import { useCallback, useEffect, useState } from "react";
import ItemView, { ITEM_TITLE_ID } from "../components/ItemView.jsx";
import { LoadingState } from "../components/StatusMessage.jsx";
import { openItem } from "../router.js";
import { setEditMode } from "../services/editMode.js";
import { refreshLibrary, shapeItem } from "../services/libraryRepository.js";
import { rememberItem } from "./catalog.js";
import { adminApi } from "./client.js";
import { typeLabel } from "./editorModel.js";
import { ConfirmBox, ErrorNotice, formatDateTime, PanelTools, useLibraryMeta } from "./ui.jsx";

/**
 * Deleted items (#/?panel=deleted). Each can be previewed as it was when
 * deleted, and recovered: it comes back as a DRAFT with its full history,
 * so it is never published again by accident.
 */
export default function DeletedItems({ toolsElement }) {
  const { meta, error: metaError } = useLibraryMeta();
  const [list, setList] = useState({ status: "loading", items: [], error: null });
  const [recovered, setRecovered] = useState({}); // id -> recovered item
  const [preview, setPreview] = useState(null); // { entry, status, item, error }
  const [confirm, setConfirm] = useState(null); // entry
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setList((previous) => ({ ...previous, status: "loading", error: null }));
    try {
      const data = await adminApi.deletedItems();
      setList({ status: "ready", items: data.items ?? [], error: null });
    } catch (loadError) {
      setList({ status: "error", items: [], error: loadError });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Recovered items are drafts: Edit mode shows them.
  useEffect(() => setEditMode(true), []);

  const showPreview = async (entry) => {
    setPreview({ entry, status: "loading", item: null, error: null });
    try {
      const data = await adminApi.itemRevision(entry.id, entry.revision);
      setPreview({ entry, status: "ready", item: data.item, error: null });
    } catch (previewError) {
      setPreview({ entry, status: "error", item: null, error: previewError });
    }
  };

  const recover = async (entry) => {
    setBusy(true);
    setError(null);
    try {
      const data = await adminApi.restoreItem(entry.id, entry.revision, entry.revision);
      rememberItem(data.item);
      refreshLibrary();
      setRecovered((previous) => ({ ...previous, [entry.id]: data.item }));
      setPreview(null);
    } catch (recoverError) {
      setError(recoverError);
      if (recoverError?.kind === "conflict" || recoverError?.kind === "not_found") load();
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const confirmBox = confirm && (
    <ConfirmBox busy={busy} confirmLabel="Recover" onCancel={() => setConfirm(null)} onConfirm={() => recover(confirm)} title={`Recover “${confirm.title}”?`}>
      It comes back as a draft, with its history. Publish it again when you are ready.
    </ConfirmBox>
  );

  if (preview) {
    const done = recovered[preview.entry.id];
    return (
      <>
        <PanelTools label="Deleted item" target={toolsElement}>
          <button className="button button--small" onClick={() => setPreview(null)} type="button">
            <span aria-hidden="true">←</span> Deleted items
          </button>
          <span className="admin-tools__spacer" />
          {!done && (
            <button className="button button--small button--primary" onClick={() => setConfirm(preview.entry)} type="button">
              Recover
            </button>
          )}
        </PanelTools>
        <div className="admin-panel-messages" lang="en">
          <p className="admin-notice admin-notice--quiet">Deleted {formatDateTime(preview.entry.deletedAt)}. This is how it looked then.</p>
          {confirmBox}
          <ErrorNotice error={error} />
          <ErrorNotice error={preview.error} onRetry={() => showPreview(preview.entry)} />
        </div>
        {!meta && metaError && (
          <ErrorNotice error={metaError} onRetry={refreshLibrary} retryLabel="Retry" />
        )}
        {(preview.status === "loading" || (!meta && !metaError)) && <LoadingState label="Opening…" />}
        {preview.item && meta && <ItemView item={shapeItem(preview.item, meta)} />}
      </>
    );
  }

  const entries = list.items;
  return (
    <>
      <PanelTools label="Deleted items" target={toolsElement}>
        <span className="admin-tools__state">Admin only</span>
      </PanelTools>
      <div className="reader admin-view" lang="en">
        <header className="reader__header">
          <p className="eyebrow reader__meta">Admin</p>
          <h2 className="admin-heading" id={ITEM_TITLE_ID}>
            Deleted items
          </h2>
          <p className="lede">Items deleted from the library. Recovering one brings it back as a draft, with its full history.</p>
        </header>
        {confirmBox}
        <ErrorNotice error={error} />
        <ErrorNotice error={list.error} onRetry={load} />
        {list.status === "loading" && entries.length === 0 && <LoadingState label="Loading deleted items…" />}
        {list.status === "ready" && entries.length === 0 && <p className="editor-hint">Nothing has been deleted.</p>}
        {entries.length > 0 && (
          <ul className="admin-list">
            {entries.map((entry) => {
              const done = recovered[entry.id];
              return (
                <li className="admin-list__row" key={`${entry.id}-${entry.revision}`}>
                  <div className="admin-list__info">
                    <strong dir="auto">{entry.title}</strong>
                    <span>
                      {typeLabel(entry.type)} · deleted <time dateTime={entry.deletedAt}>{formatDateTime(entry.deletedAt)}</time>
                    </span>
                  </div>
                  <div className="admin-list__actions">
                    {done ? (
                      <>
                        <span className="admin-list__done" role="status">
                          Recovered as a draft.
                        </span>
                        <button className="button button--small button--primary" onClick={() => openItem(done.slug)} type="button">
                          Open
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="button button--small" onClick={() => showPreview(entry)} type="button">
                          Preview
                        </button>
                        <button className="button button--small" onClick={() => setConfirm(entry)} type="button">
                          Recover
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
