import { useSyncExternalStore } from "react";
import { getEditMode, subscribeEditMode } from "../services/editMode.js";

/** The admin's Edit mode switch; re-renders when it changes. */
export default function useEditMode() {
  return useSyncExternalStore(subscribeEditMode, getEditMode);
}
