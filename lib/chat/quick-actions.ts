import type { PageContextData } from "./page-context";

export interface QuickAction {
  label: string;
  prompt: string;
}

const GLOBAL_ACTIONS: QuickAction[] = [
  { label: "Portfolio today", prompt: "How's my portfolio doing today?" },
  { label: "This week's events", prompt: "What's happening this week?" },
  { label: "Biggest movers", prompt: "Show my biggest movers recently." },
];

export function getQuickActions(
  pathname: string,
  data?: PageContextData,
): QuickAction[] {
  const pageActions: QuickAction[] = [];

  if (pathname.match(/^\/dashboard\/security\/\d+/) && data?.symbol) {
    pageActions.push(
      { label: `${data.symbol} outlook`, prompt: `What's the outlook for ${data.symbol}?` },
      { label: `${data.symbol} positions`, prompt: `Show my positions in ${data.symbol}.` },
      { label: `${data.symbol} news`, prompt: `Any recent news or earnings for ${data.symbol}?` },
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
