import { createContext } from "react";

/**
 * How the reading view opens an item's file. Visitors: no provider, so the
 * file's own address is used. The signed-in admin's panel (src/admin/) provides
 * a function that returns { url, downloadUrl, withCredentials } for files only
 * the admin may read (drafts, history, uploads not saved yet), or null to keep
 * the file's own address.
 */
export const FileAccessContext = createContext(null);
