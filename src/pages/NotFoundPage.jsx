import PageHeader from "../components/PageHeader.jsx";
import useDocumentTitle from "../hooks/useDocumentTitle.js";

export default function NotFoundPage() {
  useDocumentTitle("Not found");

  return (
    <div className="page">
      <PageHeader
        eyebrow="Not found"
        lede="This page does not exist. It may have been moved or renamed."
        title="Nothing on this shelf"
      />
      <a className="button button--primary" href="#/">
        Back to the library
      </a>
    </div>
  );
}
