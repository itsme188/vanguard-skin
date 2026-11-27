/**
 * Words for the Analysis trust strip's "Positions as of" cell (2026-11-23)
 * and its Plaid lines (Plaid session dating, 2026-11-26).
 * Import-free apart from types, so the client strip and tests can share it.
 * The facts come from lib/queries/positions-freshness.ts.
 */
import type {
  AccountPositionsFreshness,
  PositionsFreshness,
} from "@/lib/queries/positions-freshness";

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
    // Only statement rows, and every account is a Plaid-fed account whose
    // statement covers the session the morning read should have stored:
    // the refresh skips that session on purpose, so this is current.
    if (f.level === "good") {
      return {
        dateText: `${formatPositionsDate(f.newestDate ?? "")} statement`,
        countText: null,
        tone: "good",
        hint: "Positions come from the last imported statement, which covers the latest session.",
      };
    }
    return {
      dateText: `${formatPositionsDate(f.newestDate ?? "")} statement`,
      countText: null,
      tone: "warn",
      hint: "No live sync in this scope. Positions come from the last imported statement.",
    };
  }

  const liveCount = f.accounts.reduce((n, a) => n + a.liveRowCount, 0);
  const totalCount = liveCount + f.statementRowCount;
  const latest = newestLive.reduce((a, b) => (b > a ? b : a));
  const earliestNewest = newestLive.reduce((a, b) => (b < a ? b : a));

  if (f.leftoverCount > 0) {
    return {
      dateText: range(f.oldestCountedLiveDate ?? earliestNewest, latest),
      countText: `${f.leftoverCount} of ${totalCount} positions were not in the latest sync`,
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
      ? `${liveCount} of ${totalCount} positions are current. ${f.statementRowCount} ${f.statementRowCount === 1 ? "is" : "are"} from the ${formatPositionsDate(oldestStatement)} statement`
      : null;
  const stalePlaid = f.accounts.find((a) => a.level === "warn" && a.plaid?.stale);
  const baseHint =
    f.level !== "warn"
      ? "The date of the positions these figures use."
      : stalePlaid
        ? (plaidAccountFreshnessNote(stalePlaid) ?? "The latest sync is more than a trading day old.")
        : "The latest sync is more than a trading day old.";

  return {
    dateText: range(earliestNewest, latest),
    countText: statementText,
    tone: f.level === "good" ? "good" : f.level,
    hint: statementText
      ? `${baseHint} Most positions are current. A few (bonds and some funds) are not in the daily sync, so they still come from the last statement.`
      : baseHint,
  };
}

/**
 * One account's Plaid freshness sentence, or null when the account is not
 * Plaid-fed or is current. "Covered" means a Plaid book or a statement
 * holdings book on that session.
 */
export function plaidAccountFreshnessNote(acct: AccountPositionsFreshness): string | null {
  const p = acct.plaid;
  if (!p || !p.stale) return null;
  const expected = formatPositionsDate(p.expectedSession);
  if (p.newestCoveredSession === null) {
    return `No Vanguard session is stored. The morning read should have stored the ${expected} close.`;
  }
  return `Vanguard's newest stored session is the ${formatPositionsDate(p.newestCoveredSession)} close. The morning read should have stored the ${expected} close.`;
}

export interface PlaidTrustLine {
  /** Stable React key. */
  key: string;
  level: "warn";
  text: string;
}

/**
 * The trust strip's Plaid lines (plan v4, sections B and C, and the A6
 * transition hold). Silent for a scope with no Plaid-fed account (IBKR
 * only, or no accounts). Order: the dating setting, the old-dating line,
 * then one line per held-back account, then one per repeat read.
 */
export function plaidTrustLines(f: PositionsFreshness): PlaidTrustLine[] {
  const p = f.plaid;
  if (!p || p.accountIds.length === 0) return [];
  const lines: PlaidTrustLine[] = [];

  if (p.datingState === "unreadable") {
    lines.push({
      key: "plaid-dating-unreadable",
      level: "warn",
      text:
        "The Plaid dating setting cannot be read, so this page cannot tell which Vanguard daily history uses the old dating. Fix the setting before relying on Vanguard history.",
    });
  } else if (
    p.datingState === "legacy" ||
    (p.datingState === "mixed" && (!p.everyAccountHasFirstSession || p.earliestFirstSession === null))
  ) {
    // Mixed with an account in scope that has no new-format rows yet: that
    // account's whole history is still on the old dating, so the Legacy
    // wording is the true one for this scope.
    lines.push({
      key: "plaid-dating-legacy",
      level: "warn",
      text: "Vanguard daily history still uses the old dating (one session late); repair pending.",
    });
  } else if (p.datingState === "mixed" && p.earliestFirstSession !== null) {
    lines.push({
      key: "plaid-dating-mixed",
      level: "warn",
      text: `Vanguard daily history before ${formatPositionsDate(p.earliestFirstSession)} still uses the old dating; repair pending.`,
    });
  }

  for (const hold of p.transitionHolds) {
    lines.push({
      key: `plaid-hold-${hold.accountId}`,
      level: "warn",
      text: `Plaid's figures for ${hold.accountName} for the ${formatPositionsDate(hold.session)} close cannot be stored yet: older rows dated after that session still need the repair.`,
    });
  }

  for (const r of p.repeatReads) {
    lines.push({
      key: `plaid-repeat-${r.accountId}`,
      level: "warn",
      text: `Plaid's figures for ${r.accountName} for the ${formatPositionsDate(r.session)} close are identical to the ${formatPositionsDate(r.previousSession)} close; Vanguard may not have updated them.`,
    });
  }
  return lines;
}
