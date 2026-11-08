import { lazy, Suspense, useEffect } from "react";
import ItemPanel from "./components/ItemPanel.jsx";
import SiteLayout from "./components/SiteLayout.jsx";
import useAdminSession from "./hooks/useAdminSession.js";
import useEditMode from "./hooks/useEditMode.js";
import useLocationState from "./hooks/useLocationState.js";
import AdminSignInPage from "./pages/AdminSignInPage.jsx";
import LibraryPage from "./pages/LibraryPage.jsx";
import NotFoundPage from "./pages/NotFoundPage.jsx";
import { adminSignInAvailable, checkAdminSessionOnLoad } from "./services/adminSession.js";

// Admin-only interface: separate chunks, requested only once signed in.
const AdminLayer = lazy(() => import("./admin/AdminLayer.jsx"));
const AdminPanel = lazy(() => import("./admin/AdminPanel.jsx"));
const AdminLibraryTools = lazy(() => import("./admin/AdminLibraryTools.jsx"));

// Admin-only panels (#/?panel=…); ignored for everyone else.
const ADMIN_PANELS = new Set(["new", "deleted"]);

export default function App() {
  const { path, params } = useLocationState();
  const admin = useAdminSession();
  const editMode = useEditMode();
  const isLibrary = path === "/";

  useEffect(() => {
    checkAdminSessionOnLoad();
  }, []);

  // Only a session confirmed by the API turns on any admin interface; the API
  // checks every admin request again, so none of this grants anything.
  const signedIn = admin.status === "signed-in";
  const editing = signedIn && editMode;
  const adminPanel = signedIn && ADMIN_PANELS.has(params.panel) ? params.panel : "";

  let page = <NotFoundPage />;
  if (isLibrary) {
    const libraryTools = editing ? (
      <Suspense fallback={null}>
        <AdminLibraryTools />
      </Suspense>
    ) : null;
    page = <LibraryPage adminTools={libraryTools} params={params} />;
  } else if (path === "/admin" && adminSignInAvailable) page = <AdminSignInPage />;

  const adminTools = signedIn ? (
    <Suspense fallback={null}>
      <AdminLayer session={admin} />
    </Suspense>
  ) : null;
  // Signed out: globe + Portfolio. Signed in: admin controls + Portfolio.
  // While a returning admin's session is confirmed ("checking"), show neither.
  const showAdminLogin = adminSignInAvailable && (admin.status === "signed-out" || admin.status === "unavailable");

  const panelOpen = isLibrary && (params.item || adminPanel);

  return (
    <>
      <SiteLayout headerTools={adminTools} showAdminLogin={showAdminLogin}>
        {page}
      </SiteLayout>
      {/* The library stays mounted underneath, so closing returns to the same scroll position. */}
      {panelOpen && (
        <ItemPanel
          AdminContent={editing || adminPanel ? AdminPanel : null}
          panel={adminPanel}
          slug={adminPanel ? "" : params.item}
        />
      )}
    </>
  );
}
