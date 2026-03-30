"use client";

import Link from "next/link";

const VIEWS = [
  { key: "notes", label: "Notes", href: "/dashboard/research" },
  { key: "reviews", label: "Trade Reviews", href: "/dashboard/research?view=reviews" },
];

export function ResearchViewToggle({ currentView }: { currentView: string }) {
  return (
    <div className="flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5">
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
