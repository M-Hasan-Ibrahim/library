/* Small line icons for the editor toolbar (24×24, current text colour). */

function Icon({ children }) {
  return (
    <svg aria-hidden="true" fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
      {children}
    </svg>
  );
}

export const UndoIcon = () => (
  <Icon>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Icon>
);

export const RedoIcon = () => (
  <Icon>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Icon>
);

export const BoldIcon = () => (
  <Icon>
    <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z" />
    <path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z" />
  </Icon>
);

export const ItalicIcon = () => (
  <Icon>
    <path d="M14 5h-4M14 19h-4M15 5 9 19" />
  </Icon>
);

export const CodeIcon = () => (
  <Icon>
    <path d="m16 18 6-6-6-6" />
    <path d="m8 6-6 6 6 6" />
  </Icon>
);

export const LinkIcon = () => (
  <Icon>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </Icon>
);

export const BulletListIcon = () => (
  <Icon>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" fill="currentColor" r="1" />
    <circle cx="4.5" cy="12" fill="currentColor" r="1" />
    <circle cx="4.5" cy="18" fill="currentColor" r="1" />
  </Icon>
);

export const OrderedListIcon = () => (
  <Icon>
    <path d="M10 6h10M10 12h10M10 18h10" />
    <path d="M4 4.5h1.5V9M4 9h3" />
    <path d="M4 14.6c.6-.8 2.7-.8 2.7.6 0 1.1-2.7 2-2.7 3.6h2.9" />
  </Icon>
);

export const QuoteIcon = () => (
  <Icon>
    <path d="M9.5 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2.5a1 1 0 0 1 1 1v5c0 3-1.5 4.5-4 5.5" />
    <path d="M19 11h-3.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H18a1 1 0 0 1 1 1v5c0 3-1.5 4.5-4 5.5" />
  </Icon>
);

export const CodeBlockIcon = () => (
  <Icon>
    <rect height="16" rx="2" width="18" x="3" y="4" />
    <path d="m10 9-3 3 3 3M14 9l3 3-3 3" />
  </Icon>
);

export const DividerIcon = () => (
  <Icon>
    <path d="M3 12h18" />
    <path d="M7 6h10M7 18h10" opacity="0.45" />
  </Icon>
);

export const SectionIcon = () => (
  <Icon>
    <rect height="16" rx="2" width="18" x="3" y="4" />
    <path d="m8 10 2 2-2 2M13 12h4" />
  </Icon>
);

export const MoveUpIcon = () => (
  <Icon>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Icon>
);

export const MoveDownIcon = () => (
  <Icon>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Icon>
);

export const IndentIcon = () => (
  <Icon>
    <path d="M3 5h18M11 10h10M11 14h10M3 19h18M3 9l3 3-3 3" />
  </Icon>
);

export const OutdentIcon = () => (
  <Icon>
    <path d="M3 5h18M11 10h10M11 14h10M3 19h18M7 9l-3 3 3 3" />
  </Icon>
);

export const UploadIcon = () => (
  <Icon>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </Icon>
);

export const RefreshIcon = () => (
  <Icon>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 5v6h-6" />
  </Icon>
);
