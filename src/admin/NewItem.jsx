import { useEffect, useState } from "react";
import { ITEM_TITLE_ID } from "../components/ItemView.jsx";
import { LoadingState } from "../components/StatusMessage.jsx";
import { closeItem, openItem } from "../router.js";
import { setEditMode } from "../services/editMode.js";
import { refreshLibrary } from "../services/libraryRepository.js";
import { rememberItem } from "./catalog.js";
import { emptyForm, reviveForm } from "./editorModel.js";
import { setPanelNotice } from "./flash.js";
import ItemEditor from "./ItemEditor.jsx";
import { PanelTools, useLibraryMeta } from "./ui.jsx";
import { readUnsaved } from "./unsaved.js";

const CHOICES = [
  { type: "article", title: "Article", text: "Text written here: paragraphs, headings, lists, quotes and code." },
  { type: "pdf", title: "PDF", text: "A document already on the site (documents/…) or at an https:// address." },
  { type: "youtube", title: "Video", text: "A YouTube video, played inside the library." },
  { type: "link", title: "Link", text: "An external page worth keeping." },
];

/**
 * "New item" (#/?panel=new): choose the type, then the same editor as for
 * existing items. Saved as a draft; the panel then shows the new draft.
 */
export default function NewItem({ toolsElement, closeGuardRef }) {
  const { meta } = useLibraryMeta();
  const [start, setStart] = useState(() => {
    const saved = readUnsaved("new");
    const form = saved ? reviveForm(saved.form, saved.type) : null;
    return form ? { type: saved.type, form, base: reviveForm(saved.baseForm, saved.type) ?? form, restored: true } : null;
  });

  // The new item is a draft: Edit mode shows it once saved.
  useEffect(() => setEditMode(true), []);

  if (!meta) return <LoadingState label="Opening…" />;

  const choose = (type) => {
    const form = emptyForm(type, {
      categoryId: meta.categories[0]?.id ?? "",
      language: meta.languages.some((language) => language.code === "en") ? "en" : (meta.languages[0]?.code ?? ""),
    });
    setStart({ type, form, base: form, restored: false });
  };

  if (start) {
    return (
      <ItemEditor
        baseForm={start.base}
        closeGuardRef={closeGuardRef}
        initialForm={start.form}
        key={start.type}
        kind="new"
        meta={meta}
        onCancel={closeItem}
        onChangeType={() => setStart(null)}
        onSaved={(item, { notice } = {}) => {
          rememberItem(item);
          refreshLibrary();
          setPanelNotice(
            item.slug,
            notice ?? (item.status === "published" ? "Published. Visitors can see it now." : "Saved as a draft. Only you can see it until you publish it."),
          );
          openItem(item.slug); // the same panel now shows the new item
        }}
        restored={start.restored}
        storageKey="new"
        toolsElement={toolsElement}
      />
    );
  }

  return (
    <>
      <PanelTools label="New item" target={toolsElement}>
        <span className="admin-tools__state">New item</span>
      </PanelTools>
      <div className="reader admin-view" lang="en">
        <header className="reader__header">
          <p className="eyebrow reader__meta">New item</p>
          <h2 className="admin-heading" id={ITEM_TITLE_ID}>
            What would you like to add?
          </h2>
          <p className="lede">It is saved as a draft: only you see it until you publish it.</p>
        </header>
        <ul className="type-choices">
          {CHOICES.map((choice) => (
            <li key={choice.type}>
              <button className="type-choice" onClick={() => choose(choice.type)} type="button">
                <strong>{choice.title}</strong>
                <span>{choice.text}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
