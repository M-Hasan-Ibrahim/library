import { createContext } from "react";

/**
 * The scrolling element of the reading panel. Components that react to
 * visibility (the PDF viewer) observe this element instead of the window,
 * because the panel — not the page — scrolls while it is open.
 */
export const PanelScrollContext = createContext(null);
