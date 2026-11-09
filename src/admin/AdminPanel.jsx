import { FileAccessContext } from "../components/fileAccess.js";
import AdminItem from "./AdminItem.jsx";
import { adminFileAccess } from "./client.js";
import DeletedItems from "./DeletedItems.jsx";
import NewItem from "./NewItem.jsx";
import "./admin.css";

/**
 * The admin's content of the reading panel (Edit mode, or an admin panel):
 * an item with its tools, a new item, or the deleted items. Uploaded PDFs are
 * read through the admin's address here (drafts and history are not public).
 */
export default function AdminPanel({ slug, panel, toolsElement, closeGuardRef }) {
  return <FileAccessContext.Provider value={adminFileAccess}>{content({ slug, panel, toolsElement, closeGuardRef })}</FileAccessContext.Provider>;
}

function content({ slug, panel, toolsElement, closeGuardRef }) {
  if (panel === "new") return <NewItem closeGuardRef={closeGuardRef} toolsElement={toolsElement} />;
  if (panel === "deleted") return <DeletedItems toolsElement={toolsElement} />;
  return <AdminItem closeGuardRef={closeGuardRef} key={slug} slug={slug} toolsElement={toolsElement} />;
}
