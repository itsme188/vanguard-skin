import { IBM_Plex_Mono } from "next/font/google";

const plexMono = IBM_Plex_Mono({
  variable: "--font-dark-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata = {
  title: "Dark · Bloomberg-Pro · Design Preview",
};

export default function DarkLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${plexMono.variable} dark-root`}>
      <style>{`
        body { background: #0a0a0a; overflow-x: clip; }
        .dark-root {
          background: #0a0a0a;
          color: #d4d4d4;
          font-family: var(--font-dark-mono), ui-monospace, monospace;
          font-feature-settings: "tnum", "zero", "ss01";
          min-height: 100vh;
          overflow-x: clip;
        }
        main { max-width: 100vw; overflow-x: clip; }
        ::-webkit-scrollbar-thumb { background: #1f1f1f; }
        ::-webkit-scrollbar-thumb:hover { background: #444; }
        .dark-root a.d-link { color: #ffb84d; text-decoration: none; }
        .dark-root a.d-link:hover { color: #ffd28a; text-decoration: underline; }

        /* Dark: dense tables get internal horizontal scroll on mobile */
        .d-frame-body { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        .d-frame-body > * { min-width: 760px; }
        .d-nav-links { display: flex; gap: 16px; }

        @media (max-width: 540px) {
          .d-nav-links { display: none; }
        }
      `}</style>
      {children}
    </div>
  );
}
