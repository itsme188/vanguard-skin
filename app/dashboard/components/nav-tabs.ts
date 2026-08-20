export type SubView = { name: string; href: string; matchParam?: { key: string; value: string | null } };
// preserveParams: query params from the CURRENT url that should be carried
// onto this tab's own sub-view links when the dropdown builds hrefs (e.g.
// Analysis's ?scope= surviving a Workspace→Diagnostics jump). Declared per
// tab, not globally, so a param that means something on one tab never leaks
// onto another tab's links (Analysis's ?scope=ibkr must never show up on
// Research's Feeds/Documents hrefs just because the same nav bar is on
// screen). See TabDropdown.tsx withPreservedParams.
export type Tab = { name: string; href: string; subviews?: SubView[]; preserveParams?: string[] };

// IA-locked 6-tab desktop nav (2026-04-29).
// Cuts: Overview (→ Today), Holdings (→ Cmd+K + Accounts), Calendar (→ Today week-ahead).
// Trade Reviews relocates to Analysis sub-view in Phase 5 (still rendered from Research route until then).
export const tabs: Tab[] = [
  { name: "Today", href: "/dashboard/today" },
  { name: "Accounts", href: "/dashboard/accounts" },
  {
    name: "Analysis",
    href: "/dashboard/analysis",
    // Canonical ?view= scheme (2026-06-09; defense added 2026-07-05; giving added
    // 2026-08-17): workspace | diagnostics | performance | trade-reviews | defense |
    // giving. Legacy ?mode=factors / ?mode=classification still resolve to
    // Diagnostics via lib/analysis/view-param.ts; the old Classification /
    // Factor Exposure split is now the in-page mode toggle inside Diagnostics.
    // Analysis is the only tab with an account-scope selector, so it's the
    // only tab that declares ?scope= as a preserved param (2026-08-20).
    preserveParams: ["scope"],
    subviews: [
      { name: "Workspace", href: "/dashboard/analysis", matchParam: { key: "view", value: null } },
      { name: "Diagnostics", href: "/dashboard/analysis?view=diagnostics", matchParam: { key: "view", value: "diagnostics" } },
      { name: "Performance", href: "/dashboard/analysis?view=performance", matchParam: { key: "view", value: "performance" } },
      { name: "Trade Reviews", href: "/dashboard/analysis?view=trade-reviews", matchParam: { key: "view", value: "trade-reviews" } },
      { name: "Defense", href: "/dashboard/analysis?view=defense", matchParam: { key: "view", value: "defense" } },
      { name: "Giving", href: "/dashboard/analysis?view=giving", matchParam: { key: "view", value: "giving" } },
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
