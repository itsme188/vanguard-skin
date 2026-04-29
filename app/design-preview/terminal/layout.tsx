export const metadata = {
  title: "Pure Terminal · Design Preview",
};

export default function TerminalLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`
        body {
          background: #000;
          color: #d4d4d4;
          font-family: var(--font-geist-mono);
          font-feature-settings: "tnum", "zero";
        }
        ::-webkit-scrollbar-thumb { background: #1f1f1f; }
        ::-webkit-scrollbar-thumb:hover { background: #444; }
        a.t-link { color: #ffb84d; text-decoration: none; }
        a.t-link:hover { color: #ffd28a; text-decoration: underline; }

        /* Terminal: dense tables get horizontal scroll on mobile rather than reflowing */
        .t-frame-body { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        .t-frame-body > * { min-width: 720px; }
        .t-nav-links { display: flex; gap: 16px; }

        @media (max-width: 540px) {
          .t-nav-links { display: none; }
        }
      `}</style>
      {children}
    </>
  );
}
