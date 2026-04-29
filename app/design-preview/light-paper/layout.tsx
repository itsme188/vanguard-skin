export const metadata = {
  title: "Light Paper · Design Preview",
};

export default function LightPaperLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`
        body {
          background: #f7f5f0;
          color: #1a1a1a;
          font-family: var(--font-geist-sans);
          overflow-x: clip;
        }
        main { max-width: 100vw; overflow-x: clip; }
        ::-webkit-scrollbar-thumb { background: #d6cfbf; }
        ::-webkit-scrollbar-thumb:hover { background: #b8a572; }
        .lp-link { color: #2a2a2a; text-decoration: none; }
        .lp-link:hover { color: #1a1a1a; }

        /* Light Paper responsive utilities */
        .lp-section-children > * { min-width: 0; }
        .lp-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
        .lp-two-col > * { min-width: 0; }
        .lp-week-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
        .lp-week-grid > * { min-width: 0; }
        .lp-table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        .lp-table-scroll > * { min-width: 760px; }
        .lp-nav-links { display: flex; gap: 16px; font-size: 13px; }

        @media (max-width: 720px) {
          .lp-two-col { grid-template-columns: 1fr; }
          .lp-week-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 540px) {
          .lp-week-grid { grid-template-columns: 1fr; }
          .lp-nav-links { display: none; }
        }
      `}</style>
      {children}
    </>
  );
}
