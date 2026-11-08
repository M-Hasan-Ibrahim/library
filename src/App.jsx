import { lazy, Suspense, useEffect } from "react";
import ItemPanel from "./components/ItemPanel.jsx";
import SiteLayout from "./components/SiteLayout.jsx";
import useAdminSession from "./hooks/useAdminSession.js";
import useLocationState from "./hooks/useLocationState.js";
import AdminSignInPage from "./pages/AdminSignInPage.jsx";
import LibraryPage from "./pages/LibraryPage.jsx";
import NotFoundPage from "./pages/NotFoundPage.jsx";
import { adminSignInAvailable, checkAdminSession } from "./services/adminSession.js";

// Admin-only interface: a separate chunk, requested only once signed in.
const AdminLayer = lazy(() => import("./admin/AdminLayer.jsx"));

export default function App() {
  const { path, params } = useLocationState();
  const admin = useAdminSession();
  const isLibrary = path === "/";

  useEffect(() => {
    checkAdminSession();
  }, []);

  let page = <NotFoundPage />;
  if (isLibrary) page = <LibraryPage params={params} />;
  else if (path === "/admin" && adminSignInAvailable) page = <AdminSignInPage />;

  const adminTools =
    admin.status === "signed-in" ? (
      <Suspense fallback={null}>
        <AdminLayer session={admin} />
      </Suspense>
    ) : null;

  return (
    <>
      <SiteLayout headerTools={adminTools}>{page}</SiteLayout>
      {/* The library stays mounted underneath, so closing returns to the same scroll position. */}
      {isLibrary && params.item && <ItemPanel slug={params.item} />}
    </>
  );
}
