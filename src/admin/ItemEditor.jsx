import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ItemView, { ITEM_TITLE_ID } from "../components/ItemView.jsx";
import { plural } from "../lib/format.js";
import { parseYouTubeUrl } from "../lib/youtube.js";
import { closeItem } from "../router.js";
import { shapeItem } from "../services/libraryRepository.js";
import BlocksEditor from "./BlocksEditor.jsx";
import { adminApi } from "./client.js";
import {
  blockProblems,
  changedFields,
  checkForm,
  collectBlockIds,
  createPayload,
  FIELD_LABELS,
  formBlockProblems,
  isDirty,
  newBlockId,
  payloadFromForm,
  previewItem,
  sameJson,
  slugify,
  splitServerProblems,
  typeLabel,
} from "./editorModel.js";
import LinksEditor from "./LinksEditor.jsx";
import { AutoTextarea, ConfirmBox, ErrorNotice, PanelTools } from "./ui.jsx";
import { clearUnsaved, saveUnsaved } from "./unsaved.js";

/**
 * The reading view turned into a form, for an existing item ("edit") or a
 * new one ("new", saved as a draft). Same container, same typography: the
 * title, description and text are edited where they are read.
 *
 *  - Save sends only the fields that changed, with the revision the edit is
 *    based on (409 if the item changed elsewhere: the admin chooses to save
 *    over the latest version or to discard).
 *  - Problems are reported before sending, with the server's own rules;
 *    a 422 from the server is shown the same way.
 *  - Unsaved changes are kept in this tab (unsaved.js), closing the panel
 *    asks first, and the browser warns before leaving the page.
 */
const FIELD_IDS = {
  title: "editor-title",
  description: "editor-description",
  categoryId: "editor-category",
  language: "editor-language",
  addedAt: "editor-date",
  tags: "editor-tags",
  slug: "editor-slug",
  fileUrl: "editor-file",
  pageCount: "editor-pages",
  videoUrl: "editor-video",
  url: "editor-url",
  links: "editor-links",
};

const describedBy = (...ids) => ids.filter(Boolean).join(" ") || undefined;

function FieldError({ id, field, message }) {
  if (!message) return null;
  return (
    <p className="editor-error" id={id} lang="en">
      {FIELD_LABELS[field] ?? field} {message}
    </p>
  );
}

/** Field value used to tell whether a server error still applies. */
const fieldValue = (form, field) => (field === "slug" ? form.slug.trim() : payloadFromForm(form)[field]);

export default function ItemEditor({
  kind,
  item = null,
  initialForm,
  baseForm,
  baseRevision = null,
  restored = false,
  meta,
  storageKey,
  toolsElement,
  closeGuardRef,
  onSaved,
  onCancel,
  onReloaded,
  onChangeType,
}) {
  const [form, setForm] = useState(initialForm);
  const [view, setView] = useState("write");
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState(null); // { fields, form }
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [confirm, setConfirm] = useState(null); // "cancel" | "close" | null
  const [showRestored, setShowRestored] = useState(restored);
  const [summaryFocus, setSummaryFocus] = useState(0);
  const summaryRef = useRef(null);
  const formRef = useRef(form);
  formRef.current = form;
  const finishedRef = useRef(false);
  const issuedIds = useRef(new Set());

  const dirty = useMemo(() => isDirty(form, baseForm), [form, baseForm]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const update = useCallback((changes) => setForm((previous) => ({ ...previous, ...changes })), []);
  const makeId = useCallback(() => {
    const used = collectBlockIds(formRef.current.blocks);
    let id;
    do id = newBlockId(formRef.current.blocks);
    while (issuedIds.current.has(id) || used.has(id));
    issuedIds.current.add(id);
    return id;
  }, []);

  const language = meta.languages.find((entry) => entry.code === form.language);
  const dir = language?.dir ?? "ltr";

  /* ---------------------------------------------------------- problems */

  // After the first save attempt, problems update live as the admin fixes them.
  const clientErrors = attempted ? checkForm(form) : null;
  // A server error stays until its field is edited; errors about something
  // the form cannot change ("item", "body") stay until the next save.
  let liveServerErrors = null;
  if (serverErrors) {
    const now = payloadFromForm(form);
    const stillApplies = (field) =>
      field === "slug" || Object.hasOwn(now, field) ? sameJson(fieldValue(form, field), fieldValue(serverErrors.form, field)) : true;
    liveServerErrors = Object.fromEntries(Object.entries(serverErrors.fields).filter(([field]) => stillApplies(field)));
    if (Object.keys(liveServerErrors).length === 0) liveServerErrors = null;
  }
  const errors = clientErrors || liveServerErrors ? { ...liveServerErrors, ...clientErrors } : null;

  const problems = useMemo(() => {
    if (!errors?.blocks) return { byId: new Map(), general: [] };
    const fromClient = clientErrors?.blocks ? formBlockProblems(form) : { byId: new Map(), general: [] };
    const fromServer = liveServerErrors?.blocks ? blockProblems(splitServerProblems(liveServerErrors.blocks), form.blocks) : { byId: new Map(), general: [] };
    const byId = new Map(fromClient.byId);
    for (const [id, list] of fromServer.byId) byId.set(id, [...new Set([...(byId.get(id) ?? []), ...list])]);
    const general = [...new Set([...fromClient.general, ...fromServer.general])];
    if (byId.size === 0 && general.length === 0) general.push(errors.blocks);
    return { byId, general };
    // errors is derived from form and the server answer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, serverErrors, attempted]);

  useEffect(() => {
    if (summaryFocus) summaryRef.current?.focus();
  }, [summaryFocus]);

  // Start typing where the reading view starts: the title.
  useEffect(() => {
    document.getElementById(FIELD_IDS.title)?.focus({ preventScroll: true });
  }, []);

  const focusField = (field) => {
    setView("write");
    requestAnimationFrame(() => {
      const target =
        field === "blocks"
          ? document.querySelector('.block-editor[data-invalid="true"] textarea, .block-editor[data-invalid="true"] input, .block-add button')
          : field === "links"
            ? document.querySelector(".links-editor input, .links-editor button")
            : document.getElementById(FIELD_IDS[field]);
      target?.focus();
    });
  };

  /* ---------------------------------------------------------- unsaved changes */

  const finish = useCallback(() => {
    finishedRef.current = true;
    clearUnsaved(storageKey);
  }, [storageKey]);

  const persist = useCallback(() => {
    if (finishedRef.current) return;
    if (dirtyRef.current) saveUnsaved(storageKey, { type: formRef.current.type, baseRevision, baseForm, form: formRef.current });
    else clearUnsaved(storageKey);
  }, [storageKey, baseRevision, baseForm]);

  useEffect(() => {
    const timer = setTimeout(persist, 400);
    return () => clearTimeout(timer);
  }, [form, persist]);

  useEffect(() => {
    window.addEventListener("pagehide", persist);
    return () => {
      window.removeEventListener("pagehide", persist);
      persist(); // the editor closed without saving (Back button, sign-out, …)
    };
  }, [persist]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // The panel's close button, Escape and backdrop ask before discarding.
  useEffect(() => {
    closeGuardRef.current = () => {
      if (finishedRef.current || !dirtyRef.current) return true;
      setConfirm("close");
      return false;
    };
    return () => {
      closeGuardRef.current = null;
    };
  }, [closeGuardRef]);

  /* ---------------------------------------------------------- saving */

  function handleError(error, snapshot) {
    if (error?.kind === "validation") {
      setServerErrors({ fields: error.fields ?? { body: error.message }, form: snapshot });
      setSummaryFocus((n) => n + 1);
    } else if (error?.kind === "conflict" && error.code === "slug_taken") {
      setServerErrors({ fields: { slug: "is already used by another item (possibly a deleted one). Choose another." }, form: snapshot });
      setSummaryFocus((n) => n + 1);
    } else if (error?.kind === "conflict") {
      setConflict({ currentRevision: error.body?.currentRevision ?? null });
    } else {
      setFailure(error);
    }
  }

  const save = async () => {
    if (saving) return;
    const snapshot = form;
    setFailure(null);
    setConflict(null);
    setConfirm(null);
    setServerErrors(null);
    setAttempted(true);
    if (checkForm(snapshot)) {
      setView("write");
      setSummaryFocus((n) => n + 1);
      return;
    }
    let request;
    if (kind === "new") {
      request = () => adminApi.createItem(createPayload(snapshot));
    } else {
      const changes = changedFields(snapshot, baseForm);
      if (Object.keys(changes).length === 0) {
        finish();
        onCancel();
        return;
      }
      request = () => adminApi.updateItem(item.id, { revision: baseRevision, ...changes });
    }
    setSaving(true);
    try {
      const data = await request();
      finish();
      onSaved(data.item);
    } catch (error) {
      handleError(error, snapshot);
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // Ctrl/Cmd+S saves.
  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // 409: apply this edit's changes on top of the version saved elsewhere.
  const saveOverLatest = async () => {
    const snapshot = form;
    setSaving(true);
    setFailure(null);
    try {
      const latest = await adminApi.getItem(item.id);
      const data = await adminApi.updateItem(item.id, { revision: latest.item.revision, ...changedFields(snapshot, baseForm) });
      finish();
      onSaved(data.item);
    } catch (error) {
      setConflict(null);
      handleError(error, snapshot);
    } finally {
      setSaving(false);
    }
  };

  const showLatest = async () => {
    setSaving(true);
    setFailure(null);
    try {
      const latest = await adminApi.getItem(item.id);
      finish();
      onReloaded(latest.item);
    } catch (error) {
      setFailure(error);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (saving) return;
    if (dirty) setConfirm("cancel");
    else {
      finish();
      onCancel();
    }
  };

  const discard = () => {
    const closing = confirm === "close";
    finish();
    setConfirm(null);
    if (closing) closeItem();
    else onCancel();
  };

  // Back to the saved version as it is now (a new item: back to the type choice).
  const discardRestored = () => {
    finish();
    setShowRestored(false);
    if (kind === "new" && onChangeType) onChangeType();
    else onCancel();
  };

  /* ---------------------------------------------------------- view */

  const published = kind === "edit" && item?.status === "published";
  const entries = errors ? Object.entries(errors) : [];
  const invalidBlockCount = problems.byId.size;
  const video = form.type === "youtube" ? parseYouTubeUrl(form.videoUrl.trim()) : null;
  const heading = kind === "new" ? `New ${typeLabel(form.type).toLowerCase()}` : `Editing “${item.title}”`;

  return (
    <>
      <PanelTools label="Editor" target={toolsElement}>
        <span aria-label="Show" className="admin-segmented" lang="en" role="group">
          <button aria-pressed={view === "write"} onClick={() => setView("write")} type="button">
            Write
          </button>
          <button aria-pressed={view === "preview"} onClick={() => setView("preview")} type="button">
            Preview
          </button>
        </span>
        <span className="admin-tools__state">{saving ? "Saving…" : dirty ? "Unsaved changes" : "No changes"}</span>
        <span className="admin-tools__spacer" />
        <button aria-disabled={saving || undefined} className="button button--small" onClick={cancel} type="button">
          Cancel
        </button>
        <button aria-disabled={saving || undefined} className="button button--small button--primary" onClick={save} type="button">
          {saving ? "Saving…" : kind === "new" ? "Save draft" : "Save"}
        </button>
      </PanelTools>

      <div className="admin-panel-messages" lang="en">
        {showRestored && (
          <div className="admin-notice" role="status">
            <p>
              <strong>Your unsaved changes from earlier are back.</strong> Save them, or discard them to start again from the
              saved version.
            </p>
            <div className="admin-notice__actions">
              <button className="button button--small" onClick={discardRestored} type="button">
                Discard them
              </button>
            </div>
          </div>
        )}
        {published && (
          <p className="admin-notice admin-notice--quiet">This item is published: saving updates what visitors see right away.</p>
        )}
        {kind === "new" && (
          <p className="admin-notice admin-notice--quiet">New items are saved as drafts. Only you see a draft until you publish it.</p>
        )}
        {confirm && (
          <ConfirmBox
            cancelLabel="Keep editing"
            confirmLabel={confirm === "close" ? "Discard and close" : "Discard changes"}
            danger
            onCancel={() => setConfirm(null)}
            onConfirm={discard}
            title="Discard your changes?"
          >
            They have not been saved.
          </ConfirmBox>
        )}
        {conflict && (
          <div className="admin-notice admin-notice--error" role="alert">
            <p>
              <strong>This item was saved elsewhere</strong> (another tab or device
              {conflict.currentRevision ? `, now revision ${conflict.currentRevision}` : ""}) after you started editing. Your changes
              are still here.
            </p>
            <p>Saving over it applies the fields you changed to the latest version and keeps its other changes.</p>
            <div className="admin-notice__actions">
              <button aria-disabled={saving || undefined} className="button button--small button--primary" onClick={() => !saving && saveOverLatest()} type="button">
                Save my changes over it
              </button>
              <button aria-disabled={saving || undefined} className="button button--small" onClick={() => !saving && showLatest()} type="button">
                Discard mine, show the latest
              </button>
            </div>
          </div>
        )}
        <ErrorNotice error={failure} keepsChanges onRetry={save} retryLabel="Try saving again" />
        {errors && (
          <div className="admin-notice admin-notice--error editor-summary" ref={summaryRef} role="alert" tabIndex={-1}>
            <p>
              <strong>Please check {entries.length === 1 ? "this" : "these"} before saving:</strong>
            </p>
            <ul>
              {entries.map(([field, message]) => (
                <li key={field}>
                  <button className="editor-summary__link" onClick={() => focusField(field)} type="button">
                    {FIELD_LABELS[field] ?? field}
                  </button>{" "}
                  {field === "blocks" && invalidBlockCount > 0
                    ? `has problems in ${plural(invalidBlockCount, "block")} (marked below).`
                    : message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {view === "preview" ? (
        <div className="editor-preview">
          {/* The reading view below carries the panel's title id. */}
          <p className="editor-preview__note" lang="en">
            Preview{dirty ? " of your unsaved changes" : ""}, as visitors will see it.
          </p>
          <ItemView item={shapeItem(previewItem(form, item), meta)} />
        </div>
      ) : (
        <form
          className="reader editor"
          dir={dir}
          lang={form.language}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <h2 className="visually-hidden" id={ITEM_TITLE_ID}>
            {heading}
          </h2>

          <header className="reader__header">
            <div className="editor-meta" lang="en">
              <div className="editor-field editor-field--inline">
                <span className="editor-label">Type</span>
                <span className="editor-type">
                  {typeLabel(form.type)}
                  {onChangeType && !dirty && (
                    <button className="editor-type__change" onClick={onChangeType} type="button">
                      Change
                    </button>
                  )}
                </span>
              </div>
              <div className="editor-field editor-field--inline">
                <label className="editor-label" htmlFor={FIELD_IDS.categoryId}>
                  Category
                </label>
                <select
                  aria-invalid={Boolean(errors?.categoryId) || undefined}
                  className="editor-select"
                  id={FIELD_IDS.categoryId}
                  onChange={(event) => update({ categoryId: event.target.value })}
                  value={form.categoryId}
                >
                  {meta.categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="editor-field editor-field--inline">
                <label className="editor-label" htmlFor={FIELD_IDS.language}>
                  Language
                </label>
                <select
                  className="editor-select"
                  id={FIELD_IDS.language}
                  onChange={(event) => update({ language: event.target.value })}
                  value={form.language}
                >
                  {meta.languages.map((entry) => (
                    <option key={entry.code} value={entry.code}>
                      {entry.name === entry.nativeName ? entry.name : `${entry.name} (${entry.nativeName})`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="editor-field editor-field--inline">
                <label className="editor-label" htmlFor={FIELD_IDS.addedAt}>
                  Date
                </label>
                <input
                  aria-invalid={Boolean(errors?.addedAt) || undefined}
                  className="editor-input"
                  id={FIELD_IDS.addedAt}
                  onChange={(event) => update({ addedAt: event.target.value })}
                  type="date"
                  value={form.addedAt}
                />
              </div>
            </div>
            <FieldError field="categoryId" message={errors?.categoryId} />
            <FieldError field="language" message={errors?.language} />
            <FieldError field="addedAt" message={errors?.addedAt} />

            <AutoTextarea
              aria-describedby={describedBy(errors?.title && "editor-title-error")}
              aria-invalid={Boolean(errors?.title) || undefined}
              aria-label="Title"
              className="editor-inplace editor-title"
              id={FIELD_IDS.title}
              onChange={(title) => update({ title })}
              placeholder={dir === "rtl" ? "العنوان" : "Title"}
              singleLine
              value={form.title}
            />
            <FieldError field="title" id="editor-title-error" message={errors?.title} />

            <div className="lede editor-lede">
              <AutoTextarea
                aria-describedby={describedBy(errors?.description && "editor-description-error")}
                aria-invalid={Boolean(errors?.description) || undefined}
                aria-label="Description, shown on the card"
                className="editor-inplace editor-description"
                id={FIELD_IDS.description}
                onChange={(description) => update({ description })}
                placeholder={dir === "rtl" ? "وصف قصير يظهر على البطاقة" : "A short description, shown on the card"}
                singleLine
                value={form.description}
              />
            </div>
            <FieldError field="description" id="editor-description-error" message={errors?.description} />

            <div className="editor-field">
              <label className="editor-label" htmlFor={FIELD_IDS.tags} lang="en">
                Tags
              </label>
              <input
                aria-describedby="editor-tags-hint"
                aria-invalid={Boolean(errors?.tags) || undefined}
                className="editor-input"
                id={FIELD_IDS.tags}
                onChange={(event) => update({ tags: event.target.value })}
                placeholder={dir === "rtl" ? "مثال: فيزياء، ضوء" : "e.g. physics, light"}
                value={form.tags}
              />
              <p className="editor-hint" id="editor-tags-hint" lang="en">
                Separate tags with commas. Search uses them.
              </p>
              <FieldError field="tags" message={errors?.tags} />
            </div>

            {kind === "edit" && (
              <div className="editor-field" dir="ltr" lang="en">
                <span className="editor-label">Item address</span>
                <p className="editor-fixed">
                  <code>#/?item={item.slug}</code>
                  <span className="editor-hint">Fixed, so shared links keep working.</span>
                </p>
              </div>
            )}

            {kind === "new" && (
              <div className="editor-field" dir="ltr" lang="en">
                <label className="editor-label" htmlFor={FIELD_IDS.slug}>
                  Item address <span className="editor-optional">(optional)</span>
                </label>
                <div className="editor-prefixed">
                  <span aria-hidden="true">#/?item=</span>
                  <input
                    aria-describedby="editor-slug-hint"
                    aria-invalid={Boolean(errors?.slug) || undefined}
                    className="editor-input"
                    id={FIELD_IDS.slug}
                    onChange={(event) => update({ slug: event.target.value })}
                    placeholder={slugify(form.title) || "made from the title"}
                    spellCheck={false}
                    value={form.slug}
                  />
                </div>
                <p className="editor-hint" id="editor-slug-hint">
                  Lowercase words joined by hyphens. Shared links use it, so it cannot change later. Left empty, it is made
                  from the title.
                </p>
                <FieldError field="slug" message={errors?.slug} />
              </div>
            )}
          </header>

          {form.type === "pdf" && (
            <div className="editor-section editor-fields" dir="ltr" lang="en">
              <div className="editor-field">
                <label className="editor-label" htmlFor={FIELD_IDS.fileUrl}>
                  PDF file
                </label>
                <input
                  aria-describedby="editor-file-hint"
                  aria-invalid={Boolean(errors?.fileUrl) || undefined}
                  className="editor-input"
                  id={FIELD_IDS.fileUrl}
                  onChange={(event) => update({ fileUrl: event.target.value })}
                  placeholder="documents/name.pdf"
                  spellCheck={false}
                  value={form.fileUrl}
                />
                <p className="editor-hint" id="editor-file-hint">
                  A file already on this site (documents/…) or an https:// link. Uploading files comes later.
                </p>
                <FieldError field="fileUrl" message={errors?.fileUrl} />
              </div>
              <div className="editor-field editor-field--short">
                <label className="editor-label" htmlFor={FIELD_IDS.pageCount}>
                  Pages <span className="editor-optional">(optional)</span>
                </label>
                <input
                  aria-invalid={Boolean(errors?.pageCount) || undefined}
                  className="editor-input"
                  id={FIELD_IDS.pageCount}
                  inputMode="numeric"
                  onChange={(event) => update({ pageCount: event.target.value })}
                  value={form.pageCount}
                />
                <FieldError field="pageCount" message={errors?.pageCount} />
              </div>
            </div>
          )}

          {form.type === "youtube" && (
            <div className="editor-section editor-fields" dir="ltr" lang="en">
              <div className="editor-field">
                <label className="editor-label" htmlFor={FIELD_IDS.videoUrl}>
                  YouTube video
                </label>
                <input
                  aria-describedby="editor-video-hint"
                  aria-invalid={Boolean(errors?.videoUrl) || undefined}
                  className="editor-input"
                  id={FIELD_IDS.videoUrl}
                  inputMode="url"
                  onChange={(event) => update({ videoUrl: event.target.value })}
                  placeholder="https://www.youtube.com/watch?v=…"
                  spellCheck={false}
                  value={form.videoUrl}
                />
                <p className="editor-hint" id="editor-video-hint" role="status">
                  {form.videoUrl.trim() === ""
                    ? "A youtube.com or youtu.be link, or the video id."
                    : video
                      ? `Video found: ${video.isShort ? "a Short, " : ""}id ${video.id}${video.start ? `, starting at ${video.start}s` : ""}.`
                      : "This is not a YouTube video link yet."}
                </p>
                <FieldError field="videoUrl" message={errors?.videoUrl} />
              </div>
            </div>
          )}

          {form.type === "link" && (
            <div className="editor-section editor-fields" dir="ltr" lang="en">
              <div className="editor-field">
                <label className="editor-label" htmlFor={FIELD_IDS.url}>
                  Link URL
                </label>
                <input
                  aria-describedby="editor-url-hint"
                  aria-invalid={Boolean(errors?.url) || undefined}
                  className="editor-input"
                  id={FIELD_IDS.url}
                  inputMode="url"
                  onChange={(event) => update({ url: event.target.value })}
                  placeholder="https://…"
                  spellCheck={false}
                  value={form.url}
                />
                <p className="editor-hint" id="editor-url-hint">
                  The page this item points to (http:// or https://).
                </p>
                <FieldError field="url" message={errors?.url} />
              </div>
            </div>
          )}

          <section aria-labelledby="editor-text-heading" className="editor-section">
            <h3 className="editor-section__title" id="editor-text-heading" lang="en">
              Text{form.type === "article" ? "" : <span className="editor-optional"> (optional)</span>}
            </h3>
            <p className="editor-hint" lang="en">
              Format with the buttons, or type **bold**, *italic*, `code` and [label](https://…).
            </p>
            {problems.general.length > 0 && (
              <ul className="editor-error-list" lang="en">
                {problems.general.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
            <div className="editor-blocks">
              <BlocksEditor blocks={form.blocks} makeId={makeId} onChange={(blocks) => update({ blocks })} problems={problems.byId} />
            </div>
          </section>

          <section aria-labelledby="editor-links-heading" className="editor-section">
            <h3 className="editor-section__title" id="editor-links-heading" lang="en">
              Links <span className="editor-optional">(optional)</span>
            </h3>
            <LinksEditor error={errors?.links} id={FIELD_IDS.links} links={form.links} onChange={(links) => update({ links })} />
          </section>
        </form>
      )}
    </>
  );
}
