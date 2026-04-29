import { Inter, IBM_Plex_Sans, IBM_Plex_Mono, Source_Serif_4 } from "next/font/google";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata = {
  title: "Refined Options · Design Preview",
};

export default function OptionsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={`${inter.variable} ${plexSans.variable} ${plexMono.variable} ${sourceSerif.variable}`}
    >
      <style>{`
        body {
          background: #ece8df;
          color: #1c1c1c;
          font-family: var(--font-geist-sans);
          overflow-x: clip;
        }
      `}</style>
      {children}
    </div>
  );
}
