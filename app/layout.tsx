import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Portfolio Desk",
  description: "Local-first portfolio dashboard",
};

// Anti-FOUC: read theme preference from localStorage and set <html data-theme>
// before React hydrates so the first paint matches the user's choice. Defaults
// to "light" if nothing is stored. Must run synchronously in <head>.
//
// Same pattern for the chat right-rail (xl:≥1280px persistent layout): read
// vgs:chatRail and set <html data-chat-rail="open"|"collapsed">. CSS rules in
// globals.css drive the layout reservation (--chat-rail-width) and the
// EarningsHub responsive override (force mobile card layout below 1536px when
// the rail is open and squeezing the content column).
const themeInitScript = `
try {
  var t = localStorage.getItem('vgs:theme');
  if (t !== 'light' && t !== 'dark') t = 'light';
  document.documentElement.setAttribute('data-theme', t);
  var c = localStorage.getItem('vgs:chatRail');
  if (c !== 'collapsed') c = 'open';
  document.documentElement.setAttribute('data-chat-rail', c);
} catch (e) {
  document.documentElement.setAttribute('data-theme', 'light');
  document.documentElement.setAttribute('data-chat-rail', 'open');
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
        className={`${plexSans.variable} ${plexMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
