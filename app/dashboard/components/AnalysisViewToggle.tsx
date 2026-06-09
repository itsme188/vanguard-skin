import Link from "next/link";
import type { AnalysisSubView } from "@/lib/analysis/view-param";

// Analysis sub-view switcher — mirrors ResearchViewToggle's pill idiom.
// Desktop users get the Analysis tab-dropdown in TabNav; this pill row is
// mobile-only (the mobile bottom-nav has no subviews, so without this 3 of
// the 4 Analysis sub-screens are unreachable on iPhone). Rendered on ALL
// FOUR sub-views so Performance and Trade Reviews are no longer dead-ends.
const VIEWS: { key: AnalysisSubView; label: string; query: string }[] = [
  { key: "workspace", label: "Workspace", query: "" },
  { key: "diagnostics", label: "Diagnostics", query: "view=diagnostics" },
  { key: "performance", label: "Performance", query: "view=performance" },
  { key: "trade-reviews", label: "Reviews", query: "view=trade-reviews" },
];

export function AnalysisViewToggle({
  currentView,
  scope,
}: {
  currentView: AnalysisSubView;
  scope?: string;
}) {
  return (
    <div className="md:hidden flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 w-fit max-w-full overflow-x-auto">
      {VIEWS.map((v) => {
        const parts = [v.query, scope ? `scope=${scope}` : ""].filter(Boolean);
        const href = `/dashboard/analysis${parts.length ? `?${parts.join("&")}` : ""}`;
        return (
          <Link
            key={v.key}
            href={href}
            aria-label={v.key === "trade-reviews" ? "Trade Reviews" : v.label}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
              currentView === v.key
                ? "bg-panel text-ink shadow-sm"
                : "text-ink-dim hover:text-ink"
            }`}
          >
            {v.label}
          </Link>
        );
      })}
    </div>
  );
}
