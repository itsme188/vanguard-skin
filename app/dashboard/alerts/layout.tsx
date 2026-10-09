import type { ReactNode } from "react";

// Browser tab: "Alerts · Portfolio Desk" (template in app/layout.tsx). The
// page itself is a client component, which cannot export metadata, so the
// segment layout carries it. A fixed word: never a ticker or a figure.
export const metadata = { title: "Alerts" };

export default function AlertsLayout({ children }: { children: ReactNode }) {
  return children;
}
