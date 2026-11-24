/**
 * Words for the Analysis trust strip's "Positions as of" cell (2026-11-23).
 * Import-free apart from types, so the client strip and tests can share it.
 * The facts come from lib/queries/positions-freshness.ts.
 */
import type { PositionsFreshness } from "@/lib/queries/positions-freshness";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-23" → "Nov 23". A value that is not a YYYY-MM-DD date passes through. */
export function formatPositionsDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return date;
  return `${month} ${Number(m[3])}`;
}

export interface PositionsFreshnessCell {
  /** Dates only: not a portfolio figure. */
  dateText: string;
  /** The leftover count, a portfolio-derived figure: render it masked. */
  countText: string | null;
  tone: "good" | "warn" | "bad" | "neutral";
  hint: string;
}

function range(from: string, to: string): string {
  return from === to
    ? formatPositionsDate(to)
    : `${formatPositionsDate(from)} – ${formatPositionsDate(to)}`;
}

export function positionsFreshnessCell(f: PositionsFreshness): PositionsFreshnessCell {
  if (f.accounts.length === 0) {
    return {
      dateText: "No positions",
      countText: null,
      tone: "neutral",
      hint: "No positions are held in this scope.",
    };
  }

  const newestLive = f.accounts
    .map((a) => a.newestLiveDate)
    .filter((d): d is string => d !== null);

  if (newestLive.length === 0) {
    return {
      dateText: `${formatPositionsDate(f.newestDate ?? "")} statement`,
      countText: null,
      tone: "warn",
      hint: "No live sync in this scope. Positions come from the last imported statement.",
    };
  }

  const latest = newestLive.reduce((a, b) => (b > a ? b : a));
  const earliestNewest = newestLive.reduce((a, b) => (b < a ? b : a));

  if (f.leftoverCount > 0) {
    return {
      dateText: range(f.oldestCountedLiveDate ?? earliestNewest, latest),
      countText: `${f.leftoverCount} not in latest sync`,
      tone: "bad",
      hint:
        "Some positions were not in the latest sync but are still counted as held. They may be closed. Do not rely on these figures until the next sync clears them.",
    };
  }

  // Rows the live sync does not report (bonds, money-market funds) still come
  // from the last statement. Say so in the cell itself: a clean sync date
  // alone would hide that part of the book is a month old.
  const statementDates = f.accounts
    .map((a) => a.statementRows.oldestDate)
    .filter((d): d is string => d !== null);
  const oldestStatement =
    statementDates.length > 0 ? statementDates.reduce((a, b) => (b < a ? b : a)) : null;
  const statementText =
    f.statementRowCount > 0 && oldestStatement !== null
      ? `${f.statementRowCount} from ${formatPositionsDate(oldestStatement)} statement`
      : null;
  const baseHint =
    f.level === "warn"
      ? "The latest sync is more than a trading day old."
      : "The date of the positions these figures use.";

  return {
    dateText: range(earliestNewest, latest),
    countText: statementText,
    tone: f.level === "good" ? "good" : f.level,
    hint: statementText
      ? `${baseHint} Some positions are not in the daily sync and still come from the last statement.`
      : baseHint,
  };
}
