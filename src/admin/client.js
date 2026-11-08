import { API_URL } from "../services/apiConfig.js";
import { createAdminApi } from "./api.js";

/** The admin API client for this build's API address. */
export const adminApi = createAdminApi({ baseUrl: API_URL });
