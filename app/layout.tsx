import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

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

// Instrument Serif kept as a transitional font for legacy `font-serif` headlines
// in tabs not yet re-skinned (Phases 3-7 sweep these per tab). Remove from
// app/layout.tsx + globals.css `--font-serif` token in Phase 8 cleanup once no
// `font-serif` references remain in production code.
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Portfolio Desk",
  description: "Local-first portfolio dashboard",
};

// Anti-FOUC: read theme preference from localStorage and set <html data-theme>
// before React hydrates so the first paint matches the user's choice. Defaults
// to "light" if nothing is stored. Must run synchronously in <head>.
const themeInitScript = `
try {
  var t = localStorage.getItem('vgs:theme');
  if (t !== 'light' && t !== 'dark') t = 'light';
  document.documentElement.setAttribute('data-theme', t);
} catch (e) {
  document.documentElement.setAttribute('data-theme', 'light');
}
if (navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add('electron');
}
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body
        className={`${plexSans.variable} ${plexMono.variable} ${instrumentSerif.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
