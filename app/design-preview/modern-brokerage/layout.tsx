export const metadata = {
  title: "Modern Brokerage · Design Preview",
};

export default function ModernBrokerageLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`
        body {
          background: #fefefe;
          color: #18181b;
          font-family: var(--font-geist-sans);
          overflow-x: clip;
        }
        main { max-width: 100vw; overflow-x: clip; }
        ::-webkit-scrollbar-thumb { background: #e4e4e7; }
        ::-webkit-scrollbar-thumb:hover { background: #a1a1aa; }
        a.mb-link { color: #18181b; text-decoration: none; transition: color 0.15s; }
        a.mb-link:hover { color: #f59e0b; }

        /* Responsive grid utilities for mobile */
        .mb-section-children > * { min-width: 0; }
        .mb-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .mb-two-col > * { min-width: 0; }
        .mb-movers-row { display: grid; grid-template-columns: 44px 1fr 100px 100px 100px; gap: 16px; align-items: center; }
        .mb-movers-row > * { min-width: 0; }
        .mb-holdings-row { display: grid; grid-template-columns: 44px 100px 1fr 80px 80px 100px 110px 100px; gap: 16px; align-items: center; }
        .mb-holdings-header { display: grid; grid-template-columns: 44px 100px 1fr 80px 80px 100px 110px 100px; gap: 16px; }
        .mb-holdings-row > *, .mb-holdings-header > * { min-width: 0; }
        .mb-week-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; }
        .mb-week-grid > * { min-width: 0; }
        .mb-nav-links { display: flex; gap: 18px; }

        @media (max-width: 720px) {
          .mb-two-col { grid-template-columns: 1fr; }
          .mb-week-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 540px) {
          .mb-movers-row { grid-template-columns: 36px 1fr auto; row-gap: 4px; }
          .mb-movers-row > .mb-spark { display: none; }
          .mb-movers-row > .mb-value { grid-column: 2 / 3; text-align: left !important; }
          .mb-movers-row > .mb-chip { grid-column: 3 / 4; }
          .mb-holdings-row, .mb-holdings-header { grid-template-columns: 36px 1fr 90px 80px; gap: 10px; }
          .mb-holdings-row > .mb-hide-mobile, .mb-holdings-header > .mb-hide-mobile { display: none; }
          .mb-week-grid { grid-template-columns: 1fr; }
          .mb-nav-links { display: none; }
        }
      `}</style>
      {children}
    </>
  );
}
