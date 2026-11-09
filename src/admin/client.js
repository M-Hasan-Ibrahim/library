import { API_URL } from "../services/apiConfig.js";
import { createAdminApi, uploadPdf } from "./api.js";

/** The admin API client for this build's API address. */
export const adminApi = createAdminApi({ baseUrl: API_URL });

/** Uploads a PDF (see api.js uploadPdf). */
export const uploadPdfFile = (file, options) => uploadPdf(API_URL, file, options);

/** True when `url` is a file uploaded to this API (served at <API>/files/…). */
export const isUploadedFile = (url) => Boolean(API_URL) && typeof url === "string" && url.startsWith(`${API_URL}/files/`);

/**
 * The admin's own address for an uploaded file (<API>/api/admin/files/<key>,
 * behind the sign-in), or null for any other address. The public address only
 * answers while a published item uses the file; this one also serves drafts,
 * earlier versions and uploads not saved yet.
 */
export const adminFileUrl = (url) => (isUploadedFile(url) ? `${API_URL}/api/admin/files/${url.slice(`${API_URL}/files/`.length)}` : null);

/** For FileAccessContext (components/fileAccess.js): uploaded files through the admin address. */
export function adminFileAccess(url) {
  const own = adminFileUrl(url);
  return own ? { url: own, downloadUrl: `${own}?download=1`, withCredentials: true } : null;
}

/** For checkForm: this API's own file address (see worker/src/itemInput.js RULES.fileUrl). */
export const INPUT_OPTIONS = API_URL ? { ownFiles: `${API_URL}/files/` } : {};
