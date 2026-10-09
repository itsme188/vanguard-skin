"use client";

import { useState } from "react";
import type { CalendarEvent } from "@/lib/types";
import { todayET } from "@/lib/calendar/date-utils";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";
import apiFetch, { type ApiFetch } from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";
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
  /**
   * Let the chip wrap inside a narrow parent instead of holding one line.
   * The week-ahead day columns can be ~96px wide with the chat rail open,
   * where a one-line "⚠ Finnhub says Oct 14" ran into the next column. The
   * security hub's roomy row keeps the one-line default.
   */
  wrap?: boolean;
  /**
   * The caller renders EarningsConflictActions for this row, so the hover
   * sentence points at those buttons instead of the Earnings Hub (which only
   * shows the current week and may not hold the row at all).
   */
  resolveHere?: boolean;
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
 * The chip itself is display-only: it names the competing date. A surface
 * that can pass the row's symbol and date also renders
 * EarningsConflictActions (below) and sets `resolveHere`; one that cannot
 * still points at the Hub. No hooks here, so it renders in a plain
 * renderToStaticMarkup pass.
 */
export function EarningsConflictMarker({
  dateStatus,
  dateConflictWith,
  className = "",
  wrap = false,
  resolveHere = false,
}: EarningsConflictMarkerProps) {
  if (dateStatus !== "conflict") return null;

  const [sourceToken, conflictDate] = (dateConflictWith ?? "").split(":");
  const sourceLabel = sourceToken ? conflictSourceLabel(sourceToken) : null;
  const shortDate = conflictDate ? fmtConflictDate(conflictDate) : null;
  const detail = sourceLabel && shortDate ? `${sourceLabel} says ${shortDate}` : "date disputed";
  const where = resolveHere
    ? "Confirm the right date with the buttons on this row."
    : "Confirm on Today → Earnings Hub.";
  const sentence =
    sourceLabel && shortDate
      ? `Sources disagree on the earnings date — ${sourceLabel} says ${shortDate}. ${where}`
      : `Sources disagree on the earnings date. ${where}`;

  return (
    <Chip
      tone="gold"
      size="xs"
      title={sentence}
      wrap={wrap}
      className={`${wrap ? "max-w-full min-w-0 break-words" : ""} ${className}`}
    >
      ⚠ {detail}
    </Chip>
  );
}

export interface ConflictResolveOption {
  /** "shown" = the date this row carries; "other" = the competing vendor date. */
  kind: "shown" | "other";
  date: string;
  label: string;
}

/**
 * The dates a conflicted row can be locked to: its own, and the competing
 * vendor's. A date before today is left out — it is a stale prior-quarter
 * entry, and the server refuses it too (confirmEarningsDate). A malformed or
 * same-day competing date yields only the row's own date.
 */
export function conflictResolveOptions(
  row: { eventDate: string; dateConflictWith: string | null | undefined },
  todayIso: string,
): ConflictResolveOption[] {
  const options: ConflictResolveOption[] = [];
  const shownShort = fmtConflictDate(row.eventDate);
  if (shownShort && row.eventDate >= todayIso) {
    options.push({ kind: "shown", date: row.eventDate, label: `Confirm ${shownShort}` });
  }
  const [sourceToken, otherDate] = (row.dateConflictWith ?? "").split(":");
  const otherShort = otherDate && /^\d{4}-\d{2}-\d{2}$/.test(otherDate) ? fmtConflictDate(otherDate) : null;
  if (sourceToken && otherShort && otherDate !== row.eventDate && otherDate >= todayIso) {
    options.push({
      kind: "other",
      date: otherDate,
      label: `Use ${conflictSourceLabel(sourceToken)} date · ${otherShort}`,
    });
  }
  return options;
}

export type ConfirmConflictOutcome =
  /**
   * `notice`: a sentence the server wants the user to read even though the
   * date was locked (the symbol has several hand-entered dates it would not
   * pick between). Absent on a plain success.
   */
  | { kind: "confirmed"; notice?: string }
  | { kind: "failed"; message: string }
  | { kind: "unreachable" };

/**
 * Lock one date for a conflicted row through POST /api/earnings/confirm-date —
 * the same call the Earnings Hub's "⚠ confirm" popover makes, so both surfaces
 * resolve a conflict one way. Extracted so the network contract is testable in
 * Node: a 2xx without `success: true` is a failure, and a success may carry
 * a notice.
 */
export async function confirmConflictDate(
  input: { symbol: string; date: string; slot: "bmo" | "amc" },
  fetchImpl: ApiFetch = apiFetch,
): Promise<ConfirmConflictOutcome> {
  try {
    const res = await fetchImpl("/api/earnings/confirm-date", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: input.symbol,
        confirmedDate: input.date,
        confirmedTime: input.slot,
      }),
    });
    const result = await readMutationResult<{ data?: { notice?: unknown } }>(res);
    if (!result.ok) return { kind: "failed", message: result.message };
    const notice = result.data.data?.notice;
    return typeof notice === "string" && notice.trim() !== ""
      ? { kind: "confirmed", notice: notice.trim() }
      : { kind: "confirmed" };
  } catch {
    return { kind: "unreachable" };
  }
}

const ACTION_BUTTON_CLASS =
  "relative text-[11px] font-mono px-1.5 py-0.5 rounded text-gold-ink bg-gold/15 hover:bg-gold/25 disabled:opacity-50 cursor-pointer max-w-full break-words text-left pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5";

/**
 * Confirm / use-the-other-date buttons for a date-conflicted earnings row
 * (owner-approved 2026-10-07). The marker used to send the user to the
 * Earnings Hub, which shows only the current week — a conflict in another
 * week could be seen and not resolved. Each button asks first (the choice is
 * locked against later calendar syncs), then reloads the page so the row
 * shows its settled state. Renders nothing for a row that is not in conflict,
 * has no ticker, or has no date left to pick.
 *
 * Never place this inside a link: the week card renders it under the card.
 */
export function EarningsConflictActions({
  dateStatus,
  dateConflictWith,
  symbol,
  eventDate,
  eventTime,
  rawJson,
  releaseTime,
  className = "",
}: {
  dateStatus: CalendarEvent["date_status"];
  dateConflictWith: CalendarEvent["date_conflict_with"];
  symbol: string | null;
  eventDate: string;
  eventTime: string | null;
  rawJson: string | null;
  releaseTime: string | null;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (dateStatus !== "conflict" || !symbol) return null;
  const options = conflictResolveOptions({ eventDate, dateConflictWith }, todayET());
  if (options.length === 0) return null;
  // The row's own slot; the stored clock time decides only when nothing
  // stronger does, and after-close is the default the Hub uses too.
  const slot =
    deriveEarningsSlot(
      { event_time: eventTime, raw_json: rawJson, release_time: releaseTime },
      { allowReleaseTimeFallback: true },
    ) ?? "amc";

  async function pick(option: ConflictResolveOption) {
    if (busy) return;
    const ok = window.confirm(
      `Lock ${symbol} earnings to ${option.date}? Calendar syncs will no longer change this date.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    const outcome = await confirmConflictDate({ symbol: symbol as string, date: option.date, slot });
    if (outcome.kind === "confirmed") {
      // The reload below would wipe an inline message, so a notice is shown
      // in a dialog the user dismisses first (this handler already asks
      // through one).
      if (outcome.notice) window.alert(outcome.notice);
      window.location.reload();
      return;
    }
    setBusy(false);
    setError(
      outcome.kind === "failed"
        ? `Date not confirmed: ${outcome.message}`
        : networkFailureMessage("confirm the date"),
    );
  }

  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 min-w-0 max-w-full ${className}`}>
      {options.map((option) => (
        <button
          key={option.kind}
          type="button"
          disabled={busy}
          onClick={() => void pick(option)}
          className={ACTION_BUTTON_CLASS}
        >
          {option.label}
        </button>
      ))}
      {error && (
        <span role="alert" className="text-[11px] text-down basis-full">
          {error}
        </span>
      )}
    </span>
  );
}
