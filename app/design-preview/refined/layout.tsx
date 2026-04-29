import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";

const plexSans = IBM_Plex_Sans({
  variable: "--font-refined-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-refined-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata = {
  title: "Refined · Sage & Linen + Plex · Design Preview",
};

export default function RefinedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${plexSans.variable} ${plexMono.variable} rf-root`}>
      <style>{`
        body { background: #f7f4ed; overflow-x: clip; }
        .rf-root {
          background: #f7f4ed;
          color: #2a2c26;
          font-family: var(--font-refined-sans), ui-sans-serif, system-ui, sans-serif;
          min-height: 100vh;
          overflow-x: clip;
        }
        main { max-width: 100vw; overflow-x: clip; }
        ::-webkit-scrollbar-thumb { background: #d8d2c0; }
        ::-webkit-scrollbar-thumb:hover { background: #a89b80; }
        .rf-link { color: #2a2c26; text-decoration: none; transition: color 0.15s; }
        .rf-link:hover { color: #3a4a3f; }

        /* Refined responsive utilities */
        .rf-section-children > * { min-width: 0; }
        .rf-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .rf-two-col > * { min-width: 0; }
        .rf-movers-row { display: grid; grid-template-columns: 40px 1fr 100px 100px 90px; gap: 14px; align-items: center; }
        .rf-movers-row > * { min-width: 0; }
        .rf-holdings-row { display: grid; grid-template-columns: 40px 96px 1fr 70px 76px 96px 100px 84px; gap: 14px; align-items: center; }
        .rf-holdings-header { display: grid; grid-template-columns: 40px 96px 1fr 70px 76px 96px 100px 84px; gap: 14px; }
        .rf-holdings-row > *, .rf-holdings-header > * { min-width: 0; }
        .rf-week-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px; }
        .rf-week-grid > * { min-width: 0; }
        .rf-nav-links { display: flex; gap: 18px; }

        @media (max-width: 720px) {
          .rf-two-col { grid-template-columns: 1fr; }
          .rf-week-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 540px) {
          .rf-movers-row { grid-template-columns: 32px 1fr auto; row-gap: 4px; }
          .rf-movers-row > .rf-spark { display: none; }
          .rf-movers-row > .rf-value { grid-column: 2 / 3; text-align: left !important; }
          .rf-movers-row > .rf-chip { grid-column: 3 / 4; }
          .rf-holdings-row, .rf-holdings-header { grid-template-columns: 32px 1fr 88px 80px; gap: 10px; }
          .rf-holdings-row > .rf-hide-mobile, .rf-holdings-header > .rf-hide-mobile { display: none; }
          .rf-week-grid { grid-template-columns: 1fr; }
          .rf-nav-links { display: none; }
        }
      `}</style>
      {children}
    </div>
  );
}
