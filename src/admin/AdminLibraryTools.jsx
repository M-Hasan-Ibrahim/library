import { plural } from "../lib/format.js";
import { openPanel } from "../router.js";
import { useAdminCatalog } from "./catalog.js";

/** Edit mode, next to the item count: how many drafts, and deleted items. */
export default function AdminLibraryTools() {
  const catalog = useAdminCatalog();
  const drafts = catalog.counts?.draft ?? 0;
  return (
    <span className="admin-library-tools">
      {drafts > 0 && <span className="admin-library-tools__count">{plural(drafts, "draft")}, visible only to you</span>}
      <button className="button button--small" onClick={() => openPanel("deleted")} type="button">
        Deleted items
      </button>
    </span>
  );
}
