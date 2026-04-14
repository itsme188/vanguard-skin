export interface PageContextData {
  symbol?: string;
  name?: string;
  type?: string;
  weekOf?: string;
  accountScope?: string;
  sourceFilter?: string;
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
    "/dashboard/accounts": "User is on the Accounts page.",
    "/dashboard/holdings": "User is on the Holdings page.",
    "/dashboard/charts": "User is on the Charts page.",
    "/dashboard/import": "User is on the Import page.",
    "/dashboard/data-health": "User is on the Data Health page.",
  };

  return simplePages[pathname] ?? "User is browsing the dashboard.";
}
