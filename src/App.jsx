import ItemPanel from "./components/ItemPanel.jsx";
import SiteLayout from "./components/SiteLayout.jsx";
import useLocationState from "./hooks/useLocationState.js";
import LibraryPage from "./pages/LibraryPage.jsx";
import NotFoundPage from "./pages/NotFoundPage.jsx";

export default function App() {
  const { path, params } = useLocationState();
  const isLibrary = path === "/";

  return (
    <>
      <SiteLayout>{isLibrary ? <LibraryPage params={params} /> : <NotFoundPage />}</SiteLayout>
      {/* The library stays mounted underneath, so closing returns to the same scroll position. */}
      {isLibrary && params.item && <ItemPanel slug={params.item} />}
    </>
  );
}
