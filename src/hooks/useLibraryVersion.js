import { useSyncExternalStore } from "react";
import { getLibraryVersion, subscribeLibrary } from "../services/libraryRepository.js";

/**
 * Changes whenever the library data must be read again (the admin saved
 * something, or switched Edit mode). Visitors never see it change.
 */
export default function useLibraryVersion() {
  return useSyncExternalStore(subscribeLibrary, getLibraryVersion);
}
