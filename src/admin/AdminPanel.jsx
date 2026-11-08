import AdminItem from "./AdminItem.jsx";
import DeletedItems from "./DeletedItems.jsx";
import NewItem from "./NewItem.jsx";
import "./admin.css";

/**
 * The admin's content of the reading panel (Edit mode, or an admin panel):
 * an item with its tools, a new item, or the deleted items.
 */
export default function AdminPanel({ slug, panel, toolsElement, closeGuardRef }) {
  if (panel === "new") return <NewItem closeGuardRef={closeGuardRef} toolsElement={toolsElement} />;
  if (panel === "deleted") return <DeletedItems toolsElement={toolsElement} />;
  return <AdminItem closeGuardRef={closeGuardRef} key={slug} slug={slug} toolsElement={toolsElement} />;
}
