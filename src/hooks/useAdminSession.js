import { useSyncExternalStore } from "react";
import { getAdminSession, subscribeAdminSession } from "../services/adminSession.js";

/** Current admin sign-in state; re-renders when it changes. */
export default function useAdminSession() {
  return useSyncExternalStore(subscribeAdminSession, getAdminSession);
}
