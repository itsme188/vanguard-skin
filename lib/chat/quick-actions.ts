import type { PageContextData } from "./page-context";

export interface QuickAction {
  label: string;
  prompt: string;
}

const GLOBAL_ACTIONS: QuickAction[] = [
  { label: "Portfolio today", prompt: "How's my portfolio doing today?" },
  { label: "This week's events", prompt: "What's happening this week?" },
  { label: "Biggest movers", prompt: "What moved my portfolio today, in dollars?" },
];

export function getQuickActions(
  pathname: string,
  _data?: PageContextData,
): QuickAction[] {
  const pageActions: QuickAction[] = [];

  // The security page's symbol is resolved on the SERVER from the page path
  // (Contract A), so the chips name "the security on this page" and need no
  // symbol from the client.
  if (pathname.match(/^\/dashboard\/security\/\d+/)) {
    pageActions.push(
      { label: "Outlook", prompt: "What's the outlook for the security on this page?" },
      { label: "My position", prompt: "Show my position in the security on this page." },
      { label: "News and earnings", prompt: "Any recent news or earnings for the security on this page?" },
    );
  }

  if (pathname.startsWith("/dashboard/calendar")) {
    pageActions.push(
      { label: "Week summary", prompt: "Summarize this week's events and what I should watch for." },
      { label: "Earnings impact", prompt: "Which upcoming earnings could affect my portfolio?" },
    );
  }

  if (pathname.startsWith("/dashboard/research")) {
    pageActions.push(
      { label: "Key takeaways", prompt: "What are the key takeaways from recent research articles?" },
      { label: "Actionable signals", prompt: "Any actionable signals from the latest newsletters?" },
    );
  }

  if (pathname.startsWith("/dashboard/analysis")) {
    pageActions.push(
      { label: "Risk concentration", prompt: "Where is my risk concentrated?" },
      { label: "Portfolio positioning", prompt: "How am I positioned across sectors and asset classes?" },
    );
  }

  if (pageActions.length > 0) {
    const remaining = 5 - pageActions.length;
    return [...pageActions, ...GLOBAL_ACTIONS.slice(0, Math.max(0, remaining))];
  }

  return GLOBAL_ACTIONS;
}
