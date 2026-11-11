export interface PageContextData {
  symbol?: string;
  name?: string;
  type?: string;
  weekOf?: string;
  accountScope?: string;
  sourceFilter?: string;
  /** Print page: the event's date, resolved on the server (Contract A). */
  eventDate?: string;
}

export function getPageContext(
  pathname: string,
  data?: PageContextData,
): string {
  if (pathname.match(/^\/dashboard\/security\/\d+/)) {
    if (data?.symbol) {
      const parts = [`User is viewing the Security Detail page for ${data.symbol}`];
      if (data.name) parts[0] += ` (${data.name})`;
      if (data.type) parts.push(`Security type: ${data.type}.`);
      return parts.join(". ") + ".";
    }
    return "User is viewing a Security Detail page.";
  }

  if (pathname.match(/^\/dashboard\/print\/\d+/)) {
    if (data?.symbol) {
      const date = data.eventDate ? ` (event date ${data.eventDate})` : "";
      return `User is on the earnings print page for ${data.symbol}${date}.`;
    }
    return "User is on an earnings print page.";
  }

  if (pathname.startsWith("/dashboard/calendar")) {
    if (data?.weekOf) return `User is viewing the Calendar for the week of ${data.weekOf}.`;
    return "User is on the Calendar page.";
  }

  if (pathname.startsWith("/dashboard/research")) {
    if (data?.sourceFilter) return `User is on the Research page, filtered to ${data.sourceFilter}.`;
    return "User is on the Research page.";
  }

  if (pathname.startsWith("/dashboard/analysis")) {
    if (data?.accountScope) return `User is on the Analysis page, scoped to ${data.accountScope}.`;
    return "User is on the Analysis page.";
  }

  const simplePages: Record<string, string> = {
    "/dashboard": "User is on the Overview page.",
    "/dashboard/today": "User is on the Today page.",
    "/dashboard/accounts": "User is on the Accounts page.",
    "/dashboard/holdings": "User is on the Holdings page.",
    "/dashboard/tax-lots": "User is on the Tax Lots page.",
    "/dashboard/levels": "User is on the Levels page.",
    "/dashboard/alerts": "User is on the Alerts page.",
    "/dashboard/notes": "User is on the Notes page.",
    "/dashboard/import": "User is on the Import page.",
    "/dashboard/data-health": "User is on the Data Health page.",
    "/dashboard/settings": "User is on the Settings page.",
  };

  return simplePages[pathname] ?? "User is browsing the dashboard.";
}
