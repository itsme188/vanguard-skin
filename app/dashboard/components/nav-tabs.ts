export type SubView = { name: string; href: string; matchParam?: { key: string; value: string | null } };
export type Tab = { name: string; href: string; subviews?: SubView[] };

// IA-locked 6-tab desktop nav (2026-04-29).
// Cuts: Overview (→ Today), Holdings (→ Cmd+K + Accounts), Calendar (→ Today week-ahead).
// Trade Reviews relocates to Analysis sub-view in Phase 5 (still rendered from Research route until then).
export const tabs: Tab[] = [
  { name: "Today", href: "/dashboard/today" },
  { name: "Accounts", href: "/dashboard/accounts" },
  {
    name: "Analysis",
    href: "/dashboard/analysis",
    // Canonical ?view= scheme (2026-06-09): workspace | diagnostics |
    // performance | trade-reviews. Legacy ?mode=factors / ?mode=classification
    // still resolve to Diagnostics via lib/analysis/view-param.ts; the old
    // Classification / Factor Exposure split is now the in-page mode toggle
    // inside Diagnostics.
    subviews: [
      { name: "Workspace", href: "/dashboard/analysis", matchParam: { key: "view", value: null } },
      { name: "Diagnostics", href: "/dashboard/analysis?view=diagnostics", matchParam: { key: "view", value: "diagnostics" } },
      { name: "Performance", href: "/dashboard/analysis?view=performance", matchParam: { key: "view", value: "performance" } },
      { name: "Trade Reviews", href: "/dashboard/analysis?view=trade-reviews", matchParam: { key: "view", value: "trade-reviews" } },
      { name: "Defense", href: "/dashboard/analysis?view=defense", matchParam: { key: "view", value: "defense" } },
    ],
  },
  {
    name: "Research",
    href: "/dashboard/research",
    subviews: [
      { name: "Notes", href: "/dashboard/research", matchParam: { key: "view", value: null } },
      { name: "Feeds", href: "/dashboard/research?view=feeds", matchParam: { key: "view", value: "feeds" } },
      { name: "Documents", href: "/dashboard/research?view=documents", matchParam: { key: "view", value: "documents" } },
    ],
  },
  { name: "Charts", href: "/dashboard/charts" },
  { name: "Import", href: "/dashboard/import" },
];
