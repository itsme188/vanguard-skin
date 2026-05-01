"use client";

import Link from "next/link";

// Trade Reviews relocates to Analysis sub-view in Phase 5; the legacy
// `?view=reviews` route still renders, so saved bookmarks and the in-page
// trade-reviews UI keep working until Phase 5 ships the redirect.
const VIEWS = [
  { key: "notes", label: "Notes", href: "/dashboard/research" },
  { key: "feeds", label: "Feeds", href: "/dashboard/research?view=feeds" },
  { key: "documents", label: "Documents", href: "/dashboard/research?view=documents" },
];

export function ResearchViewToggle({ currentView }: { currentView: string }) {
  // Desktop users get the tab-dropdown in TabNav; this pill toggle is mobile-only
  // (mobile bottom-nav has no subviews so we need an in-page switcher there).
  return (
    <div className="md:hidden flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5">
      {VIEWS.map((v) => (
        <Link
          key={v.key}
          href={v.href}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            currentView === v.key
              ? "bg-panel text-ink shadow-sm"
              : "text-ink-dim hover:text-ink"
          }`}
        >
          {v.label}
        </Link>
      ))}
    </div>
  );
}
