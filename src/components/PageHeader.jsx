export default function PageHeader({ eyebrow, title, lede }) {
  return (
    <header className="page-header">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {lede && <p className="lede">{lede}</p>}
    </header>
  );
}
