import type { Metadata, Viewport } from "next";
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
  // Pages export `metadata = { title: "Accounts" }` and get "Accounts · Portfolio Desk".
  title: { default: "Portfolio Desk", template: "%s · Portfolio Desk" },
  description: "Local-first portfolio dashboard",
};

// The single viewport declaration. Exporting it (rather than hand-writing a
// <meta> in <head>) stops Next from emitting its own default tag as a second
// viewport meta — WebKit applies the LAST one parsed, which would drop the
// viewport-fit=cover opt-in that pb-safe / env(safe-area-inset-*) rely on.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
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
  var x = localStorage.getItem('vgs:chatExpanded') === 'true' ? 'true' : 'false';
  document.documentElement.setAttribute('data-chat-expanded', x);
} catch (e) {
  document.documentElement.setAttribute('data-theme', 'light');
  document.documentElement.setAttribute('data-chat-rail', 'open');
  document.documentElement.setAttribute('data-chat-expanded', 'false');
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
