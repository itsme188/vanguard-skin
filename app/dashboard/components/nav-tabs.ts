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
    subviews: [
      { name: "Performance", href: "/dashboard/analysis?view=performance", matchParam: { key: "view", value: "performance" } },
      { name: "Classification", href: "/dashboard/analysis", matchParam: { key: "mode", value: null } },
      { name: "Factor Exposure", href: "/dashboard/analysis?mode=factors", matchParam: { key: "mode", value: "factors" } },
      { name: "Trade Reviews", href: "/dashboard/analysis?view=trade-reviews", matchParam: { key: "view", value: "trade-reviews" } },
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
