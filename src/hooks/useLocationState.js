import { useMemo, useSyncExternalStore } from "react";
import { getHash, parseLocation, subscribe } from "../router.js";

/** Current parsed URL state; re-renders on navigation, Back/Forward and filter changes. */
export default function useLocationState() {
  const hash = useSyncExternalStore(subscribe, getHash);
  return useMemo(() => parseLocation(hash), [hash]);
}
