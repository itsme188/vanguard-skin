"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import type { AnalysisSubView } from "@/lib/analysis/view-param";
import { ScrollFade } from "./ScrollFade";

// Analysis sub-view switcher — mirrors ResearchViewToggle's pill idiom.
// Desktop users get the Analysis tab-dropdown in TabNav; this pill row is
// mobile-only (the mobile bottom-nav has no subviews, so without this most
// Analysis sub-screens are unreachable on iPhone). Rendered on ALL SIX
// sub-views so Performance / Trade Reviews / Defense / Giving are not dead-ends.
// The strip overflows at phone width, so the active pill is scrolled into view
// on mount and ScrollFade cues that more pills sit off to the right.
const VIEWS: { key: AnalysisSubView; label: string; query: string }[] = [
  { key: "workspace", label: "Workspace", query: "" },
  { key: "diagnostics", label: "Diagnostics", query: "view=diagnostics" },
  { key: "performance", label: "Performance", query: "view=performance" },
  { key: "trade-reviews", label: "Reviews", query: "view=trade-reviews" },
  { key: "defense", label: "Defense", query: "view=defense" },
  { key: "giving", label: "Giving", query: "view=giving" },
];

export function AnalysisViewToggle({
  currentView,
  scope,
}: {
  currentView: AnalysisSubView;
  scope?: string;
}) {
  const activeRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [currentView]);

  return (
    <ScrollFade className="md:hidden w-fit max-w-full rounded-lg">
      <div className="flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 w-fit">
        {VIEWS.map((v) => {
          const parts = [v.query, scope ? `scope=${scope}` : ""].filter(Boolean);
          const href = `/dashboard/analysis${parts.length ? `?${parts.join("&")}` : ""}`;
          const active = currentView === v.key;
          return (
            <Link
              key={v.key}
              ref={active ? activeRef : undefined}
              href={href}
              aria-label={v.key === "trade-reviews" ? "Trade Reviews" : v.label}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                active
                  ? "bg-panel text-ink shadow-sm"
                  : "text-ink-dim hover:text-ink"
              }`}
            >
              {v.label}
            </Link>
          );
        })}
      </div>
    </ScrollFade>
  );
}
