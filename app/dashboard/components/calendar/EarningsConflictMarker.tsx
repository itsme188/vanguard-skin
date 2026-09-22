import type { CalendarEvent } from "@/lib/types";
import { Chip } from "../Chip";

// Only the two vendor calendars feed the cross-check (migration 057's own
// doc comment: "The calendar now ingests TWO independent free earnings
// calendars (Finnhub + Nasdaq)"), so date_conflict_with only ever carries
// one of these tokens today — the fallback below covers any future source
// without needing this file touched again.
const CONFLICT_SOURCE_LABELS: Record<string, string> = {
  finnhub: "Finnhub",
  nasdaq: "Nasdaq",
};

function conflictSourceLabel(token: string): string {
  return CONFLICT_SOURCE_LABELS[token] ?? token.charAt(0).toUpperCase() + token.slice(1);
}

// Same UTC-anchored short-date idiom as EarningsDateChip's fmtShort and the
// lib/earnings/{worksheet,worksheet-rich,reporter-recap}.ts fmtShortDate
// helpers — a bare `new Date(iso)` on a YYYY-MM-DD string is parsed as UTC
// midnight, which rolls back a calendar day once formatted through a
// negative-UTC-offset locale (ET). Anchoring the constructed Date to UTC AND
// formatting with timeZone: "UTC" keeps the displayed day literal.
function fmtConflictDate(iso: string): string | null {
  const parts = iso.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [y, m, day] = parts;
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export interface EarningsConflictMarkerProps {
  dateStatus: CalendarEvent["date_status"];
  dateConflictWith: CalendarEvent["date_conflict_with"];
  className?: string;
}

/**
 * Read-only marker for a date-conflicted earnings row (calendar_events
 * date_status === 'conflict', migration 057). Shared by the security hub's
 * Upcoming Events list (app/dashboard/security/[id]/page.tsx) and the Today
 * week-ahead view (app/dashboard/today/WeekAheadView.tsx) — both render
 * calendar_events rows directly, outside the Earnings Hub, whose
 * EarningsDateChip already carries the editable "⚠ confirm" affordance and
 * the confirm-date popover (POST /api/earnings/confirm-date). Without a
 * marker here a conflicted row rendered identically to a settled one on
 * these two surfaces — and the competing vendor date can be EARLIER than
 * the one shown, a real risk of missing a print.
 *
 * Intentionally display-only: it names the competing date and points the
 * user at the Hub to resolve it, but never calls the confirm/correct APIs
 * itself — that flow stays single-sourced in EarningsDateChip.
 */
export function EarningsConflictMarker({
  dateStatus,
  dateConflictWith,
  className = "",
}: EarningsConflictMarkerProps) {
  if (dateStatus !== "conflict") return null;

  const [sourceToken, conflictDate] = (dateConflictWith ?? "").split(":");
  const sourceLabel = sourceToken ? conflictSourceLabel(sourceToken) : null;
  const shortDate = conflictDate ? fmtConflictDate(conflictDate) : null;
  const detail = sourceLabel && shortDate ? `${sourceLabel} says ${shortDate}` : "date disputed";
  const sentence =
    sourceLabel && shortDate
      ? `Sources disagree on the earnings date — ${sourceLabel} says ${shortDate}. Confirm on Today → Earnings Hub.`
      : "Sources disagree on the earnings date. Confirm on Today → Earnings Hub.";

  return (
    <Chip tone="gold" size="xs" title={sentence} className={`whitespace-nowrap ${className}`}>
      ⚠ {detail}
    </Chip>
  );
}
