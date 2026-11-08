import { useCallback, useEffect, useState } from "react";
import ItemView, { ITEM_TITLE_ID } from "../components/ItemView.jsx";
import { LoadingState } from "../components/StatusMessage.jsx";
import { shapeItem } from "../services/libraryRepository.js";
import { getAdminSession } from "../services/adminSession.js";
import { adminApi } from "./client.js";
import { ConfirmBox, ErrorNotice, formatDateTime, PanelTools } from "./ui.jsx";

const ACTIONS = {
  import: "Imported",
  create: "Created",
  update: "Edited",
  publish: "Published",
  unpublish: "Unpublished",
  delete: "Deleted",
  restore: "Restored",
};

/** "Edited", "Restored revision 3", … */
export function describeRevision(entry) {
  if (entry.action === "restore" && entry.note) return entry.note;
  return ACTIONS[entry.action] ?? entry.action;
}

/**
 * Every saved version of an item (newest first). A version can be viewed
 * with the normal reading view and restored: its content is copied into a
 * new revision (the status stays as it is; nothing is lost).
 */
export default function HistoryView({ item, meta, toolsElement, onBack, onRestored, onConflict }) {
  const [history, setHistory] = useState({ status: "loading", data: null, error: null });
  const [selected, setSelected] = useState(null); // { entry, status, item, error }
  const [confirm, setConfirm] = useState(null); // revision number
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const email = getAdminSession().email;

  const load = useCallback(async () => {
    setHistory((previous) => ({ ...previous, status: "loading", error: null }));
    try {
      setHistory({ status: "ready", data: await adminApi.itemHistory(item.id), error: null });
    } catch (loadError) {
      setHistory({ status: "error", data: null, error: loadError });
    }
  }, [item.id]);

  useEffect(() => {
    load();
  }, [load, item.revision]);

  const view = async (entry) => {
    setSelected({ entry, status: "loading", item: null, error: null });
    setConfirm(null);
    try {
      const data = await adminApi.itemRevision(item.id, entry.revision);
      setSelected({ entry, status: "ready", item: data.item, error: null });
    } catch (viewError) {
      setSelected({ entry, status: "error", item: null, error: viewError });
    }
  };

  const restore = async (revision) => {
    setBusy(true);
    setError(null);
    try {
      const data = await adminApi.restoreItem(item.id, item.revision, revision);
      onRestored(data.item, revision);
    } catch (restoreError) {
      setError(restoreError);
      setConfirm(null);
      if (restoreError?.kind === "conflict") onConflict();
    } finally {
      setBusy(false);
    }
  };

  const published = item.status === "published";
  const confirmBox = confirm !== null && (
    <ConfirmBox busy={busy} confirmLabel="Restore" onCancel={() => setConfirm(null)} onConfirm={() => restore(confirm)} title={`Restore revision ${confirm}?`}>
      Its content replaces the current one, saved as revision {item.revision + 1}; the current version stays in the history.
      {published ? " This item is published: visitors see the restored version right away." : ""}
    </ConfirmBox>
  );

  if (selected) {
    const current = selected.entry.revision === item.revision;
    return (
      <>
        <PanelTools label="Revision" target={toolsElement}>
          <button className="button button--small" onClick={() => setSelected(null)} type="button">
            <span aria-hidden="true">←</span> History
          </button>
          <span className="admin-tools__state">
            Revision {selected.entry.revision}
            {current ? " (current)" : ""}
          </span>
          <span className="admin-tools__spacer" />
          {!current && (
            <button className="button button--small button--primary" onClick={() => setConfirm(selected.entry.revision)} type="button">
              Restore this version
            </button>
          )}
        </PanelTools>
        <div className="admin-panel-messages" lang="en">
          <p className="admin-notice admin-notice--quiet">
            Revision {selected.entry.revision}: {describeRevision(selected.entry)}, {formatDateTime(selected.entry.changedAt)}. This is how it
            looked then.
          </p>
          {confirmBox}
          <ErrorNotice error={error} />
          <ErrorNotice error={selected.error} onRetry={() => view(selected.entry)} />
        </div>
        {selected.status === "loading" && <LoadingState label="Opening this version…" />}
        {selected.item && <ItemView item={shapeItem(selected.item, meta)} />}
      </>
    );
  }

  const revisions = history.data?.revisions ?? [];
  return (
    <>
      <PanelTools label="History" target={toolsElement}>
        <button className="button button--small" onClick={onBack} type="button">
          <span aria-hidden="true">←</span> Back to the item
        </button>
      </PanelTools>
      <div className="reader admin-view" lang="en">
        <header className="reader__header">
          <p className="eyebrow reader__meta">History</p>
          <h2
            className="admin-heading"
            dir={meta.languages.find((entry) => entry.code === item.language)?.dir}
            id={ITEM_TITLE_ID}
            lang={item.language}
          >
            {item.title}
          </h2>
          <p className="lede">Every saved version, newest first. Restoring copies an earlier version into a new one, so nothing is lost.</p>
        </header>
        {confirmBox}
        <ErrorNotice error={error} />
        <ErrorNotice error={history.error} onRetry={load} />
        {history.status === "loading" && !history.data && <LoadingState label="Loading the history…" />}
        {revisions.length > 0 && (
          <ol className="admin-list">
            {revisions.map((entry) => {
              const current = entry.revision === item.revision;
              return (
                <li className="admin-list__row" key={entry.revision}>
                  <div className="admin-list__info">
                    <strong>
                      Revision {entry.revision}
                      {current && <span className="status-badge status-badge--published">Current</span>}
                    </strong>
                    <span>
                      {describeRevision(entry)} · <time dateTime={entry.changedAt}>{formatDateTime(entry.changedAt)}</time>
                      {entry.changedBy && entry.changedBy !== email ? ` · ${entry.changedBy}` : ""}
                    </span>
                  </div>
                  <div className="admin-list__actions">
                    <button className="button button--small" onClick={() => view(entry)} type="button">
                      View
                    </button>
                    {!current && (
                      <button className="button button--small" onClick={() => setConfirm(entry.revision)} type="button">
                        Restore
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </>
  );
}
