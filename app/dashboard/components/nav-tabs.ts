export type SubView = { name: string; href: string; matchParam?: { key: string; value: string | null } };
export type Tab = { name: string; href: string; subviews?: SubView[] };

export const tabs: Tab[] = [
  { name: "Today", href: "/dashboard/today" },
  { name: "Overview", href: "/dashboard" },
  { name: "Accounts", href: "/dashboard/accounts" },
  { name: "Holdings", href: "/dashboard/holdings" },
  {
    name: "Analysis",
    href: "/dashboard/analysis",
    subviews: [
      { name: "Classification", href: "/dashboard/analysis", matchParam: { key: "mode", value: null } },
      { name: "Factor Exposure", href: "/dashboard/analysis?mode=factors", matchParam: { key: "mode", value: "factors" } },
    ],
  },
  { name: "Charts", href: "/dashboard/charts" },
  { name: "Calendar", href: "/dashboard/calendar" },
  {
    name: "Research",
    href: "/dashboard/research",
    subviews: [
      { name: "Notes", href: "/dashboard/research", matchParam: { key: "view", value: null } },
      { name: "Trade Reviews", href: "/dashboard/research?view=reviews", matchParam: { key: "view", value: "reviews" } },
      { name: "Feeds", href: "/dashboard/research?view=feeds", matchParam: { key: "view", value: "feeds" } },
      { name: "Documents", href: "/dashboard/research?view=documents", matchParam: { key: "view", value: "documents" } },
    ],
  },
  { name: "Import", href: "/dashboard/import" },
];
