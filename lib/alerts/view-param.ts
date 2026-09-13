// Alerts tab filter param normalization — single source of truth.
//
// Canonical ?view= values mirror the nine pills on the Alerts page
// (app/dashboard/alerts/page.tsx StreamFilter/FILTER_OPTIONS): pending
// (default) | review | armed | conflicts | emails | acted | ignored |
// dismissed | all. Deep links from other surfaces set this on first render
// only (Today's "armed levels" link → ?view=armed, /dashboard/levels/review
// → ?view=review); it is not the tab's live state — selectFilter on the page
// clears the param once the user picks a pill, it never rewrites it to the
// newly selected value.
//
// Pure function, no React/DB imports — unit-tested in
// tests/alerts/view-param.test.ts.

export type StreamFilter =
  | "pending"
  | "review"
  | "armed"
  | "conflicts"
  | "emails"
  | "acted"
  | "ignored"
  | "dismissed"
  | "all";

export interface AlertsFilterOption {
  label: string;
  value: StreamFilter;
}

export const FILTER_OPTIONS: AlertsFilterOption[] = [
  { label: "Pending", value: "pending" },
  { label: "Review", value: "review" },
  { label: "Armed", value: "armed" },
  { label: "Conflicts", value: "conflicts" },
  { label: "Emails", value: "emails" },
  { label: "Acted", value: "acted" },
  { label: "Ignored", value: "ignored" },
  { label: "Dismissed", value: "dismissed" },
  { label: "All", value: "all" },
];

const FILTER_VALUES: ReadonlySet<string> = new Set(
  FILTER_OPTIONS.map((opt) => opt.value)
);

/** Every FILTER_OPTIONS value round-trips; null/empty/unknown fall back to
 *  "pending" (the tab's default landing view). */
export function parseAlertsViewParam(value: string | null): StreamFilter {
  if (value !== null && FILTER_VALUES.has(value)) {
    return value as StreamFilter;
  }
  return "pending";
}
