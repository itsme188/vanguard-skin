import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import {
  LIVE_HOLDING_SOURCE_PREFIXES,
  classifyHoldingSourceKey,
  isPlaidSourcedHolding,
} from "@/lib/db/holding-sources";

/** Where the newest holdings rows came from. "unknown" asserts nothing. */
export type SnapshotSource = "statement" | "plaid" | "tws" | "unknown";

/** One sleeve of the account and the as-of dates its rows carry. */
export interface SnapshotSleeve {
  label: string;
  oldest: string;
  newest: string;
}

interface SnapshotAgeProps {
  /** Newest as-of date among the holdings rows. Age and tone are read from it. */
  asOfDate: string | null;
  /**
   * Oldest as-of date among the rows, when the account's rows are mixed
   * (cash funds and bonds restate only on the monthly statement). The chip
   * then shows the range instead of claiming one date for every row.
   */
  oldestAsOfDate?: string | null;
  /** Provenance of the newest rows; decides the sentence in the title. */
  source?: SnapshotSource;
  /** Per-sleeve dates for the title (cash funds, bonds, other positions). */
  sleeves?: SnapshotSleeve[];
  /**
   * Source label rendered before the date — typically "Snapshot" on the
   * Accounts page or "Vanguard" when rendered in a header that also
   * surfaces IBKR / aggregate freshness.
   */
  label?: string;
  /**
   * When true, render even for fresh data. Default false hides the chip
   * for snapshots <= 1 day old (avoids noise on live-sync accounts).
   */
  alwaysShow?: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtShortDate(iso: string): string {
  const [, month, day] = iso.split("T")[0].split("-");
  return `${MONTHS[parseInt(month, 10) - 1]} ${parseInt(day, 10)}`;
}

export interface SnapshotAgeMeta {
  ageDays: number;
  ageLabel: string;
  tone: "ink-faint" | "ink-dim" | "warn";
  glyph: string;
}

/**
 * Pure helper exported for tests. Computes display metadata for a snapshot
 * `asOfDate` (YYYY-MM-DD) relative to `now`. Tone escalates with age:
 *   0-7d   → ink-faint (statement just landed, expected)
 *   8-21d  → ink-dim   (mid-cycle, structurally normal)
 *   22d+   → warn      (full statement cycle missed, import overdue)
 *
 * The thresholds are tuned to Vanguard's monthly-statement cadence: a
 * normal monthly statement lands 10-15d after period-end, so up to ~21d
 * is the expected envelope. Anything beyond suggests the user missed
 * an import.
 */
export function computeSnapshotAgeMeta(asOfDate: string, now: Date = new Date()): SnapshotAgeMeta {
  const then = new Date(asOfDate.split("T")[0] + "T00:00:00");
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const ageDays = Math.max(0, Math.floor((today.getTime() - then.getTime()) / 86_400_000));
  const ageLabel = ageDays === 0 ? "today" : ageDays === 1 ? "1d ago" : `${ageDays}d ago`;
  if (ageDays >= 22) return { ageDays, ageLabel, tone: "warn", glyph: "⚠ " };
  if (ageDays >= 8) return { ageDays, ageLabel, tone: "ink-dim", glyph: "" };
  return { ageDays, ageLabel, tone: "ink-faint", glyph: "" };
}

const TONE_CLASS: Record<SnapshotAgeMeta["tone"], string> = {
  "ink-faint": "text-ink-faint",
  "ink-dim": "text-ink-dim",
  warn: "text-down/80",
};

/**
 * Provenance of one holdings row, from its source_key class. The prefix
 * lists live in lib/db/holding-sources.ts; nothing is matched by hand here.
 * An unrecognized or missing key is "unknown", never a guessed source.
 */
export function snapshotSourceFromKey(sourceKey: string | null | undefined): SnapshotSource {
  if (!sourceKey) return "unknown";
  if (classifyHoldingSourceKey(sourceKey) === "statement") return "statement";
  if (isPlaidSourcedHolding(sourceKey)) return "plaid";
  if (LIVE_HOLDING_SOURCE_PREFIXES.some((prefix) => sourceKey.startsWith(prefix))) return "tws";
  return "unknown";
}

export interface SnapshotSummary {
  newest: string;
  oldest: string;
  source: SnapshotSource;
  sleeves: SnapshotSleeve[];
}

/**
 * The dates and provenance behind the snapshot chip, from the holdings rows
 * on screen. Holdings are "latest" per (account, security), so one account
 * can carry several as-of dates at once; the chip must not stamp the newest
 * one on rows that are older. Dates are YYYY-MM-DD, so a string compare
 * orders them. Returns null for no rows.
 */
export function summarizeSnapshot(
  rows: {
    as_of_date: string;
    source_key?: string | null;
    security_type: string | null;
    fund_category?: string | null;
  }[],
): SnapshotSummary | null {
  if (rows.length === 0) return null;
  const range = (subset: typeof rows) => ({
    oldest: subset.reduce((d, r) => (r.as_of_date < d ? r.as_of_date : d), subset[0].as_of_date),
    newest: subset.reduce((d, r) => (r.as_of_date > d ? r.as_of_date : d), subset[0].as_of_date),
  });
  const { oldest, newest } = range(rows);

  const isCash = (r: (typeof rows)[number]) =>
    isCashEquivalentSecurity({
      security_type: r.security_type,
      fund_category: r.fund_category ?? null,
    });
  const isBond = (r: (typeof rows)[number]) => r.security_type?.trim().toLowerCase() === "bond";
  const sleeves: SnapshotSleeve[] = [
    { label: "Cash funds", subset: rows.filter(isCash) },
    { label: "Bonds", subset: rows.filter((r) => !isCash(r) && isBond(r)) },
    { label: "Other positions", subset: rows.filter((r) => !isCash(r) && !isBond(r)) },
  ]
    .filter((s) => s.subset.length > 0)
    .map((s) => ({ label: s.label, ...range(s.subset) }));

  // The source of the NEWEST rows only; if they disagree, assert nothing.
  const newestSources = new Set(
    rows.filter((r) => r.as_of_date === newest).map((r) => snapshotSourceFromKey(r.source_key)),
  );
  const source = newestSources.size === 1 ? [...newestSources][0] : "unknown";

  return { newest, oldest, source, sleeves };
}

const SOURCE_SENTENCE: Record<SnapshotSource, string> = {
  statement: "come from the last imported statement.",
  plaid: "come from the daily Plaid sync; a statement import replaces them at month-end.",
  tws: "come from the last broker sync.",
  unknown: "",
};

/**
 * The chip's hover title. It names the source only when the caller knows it,
 * and lists each sleeve's own date when the account's rows are mixed.
 */
export function buildSnapshotTitle({
  asOfDate,
  oldestAsOfDate = null,
  source = "unknown",
  sleeves = [],
}: {
  asOfDate: string;
  oldestAsOfDate?: string | null;
  source?: SnapshotSource;
  sleeves?: SnapshotSleeve[];
}): string {
  const mixed = oldestAsOfDate !== null && oldestAsOfDate < asOfDate;
  const parts = [
    mixed ? `Holdings as of ${oldestAsOfDate} to ${asOfDate}.` : `Holdings as of ${asOfDate}.`,
  ];
  if (mixed) {
    for (const sleeve of sleeves) {
      const dates =
        sleeve.oldest === sleeve.newest ? sleeve.newest : `${sleeve.oldest} to ${sleeve.newest}`;
      parts.push(`${sleeve.label}: ${dates}.`);
    }
  }
  if (source !== "unknown") {
    parts.push(`${mixed ? "The newest rows" : "These figures"} ${SOURCE_SENTENCE[source]}`);
  }
  return parts.join(" ");
}

export function SnapshotAge({
  asOfDate,
  oldestAsOfDate = null,
  source = "unknown",
  sleeves = [],
  label = "Snapshot",
  alwaysShow = false,
}: SnapshotAgeProps) {
  if (!asOfDate) return null;
  const meta = computeSnapshotAgeMeta(asOfDate);
  if (!alwaysShow && meta.ageDays <= 1) return null;
  // Set only when the rows are mixed: the chip then shows the range.
  const rangeStart =
    oldestAsOfDate !== null && oldestAsOfDate < asOfDate ? oldestAsOfDate : null;

  return (
    <span
      className={`text-[11px] font-mono ${TONE_CLASS[meta.tone]}`}
      title={buildSnapshotTitle({ asOfDate, oldestAsOfDate, source, sleeves })}
    >
      {meta.glyph}
      {rangeStart !== null
        ? `${label} · ${fmtShortDate(rangeStart)} – ${fmtShortDate(asOfDate)} · newest ${meta.ageLabel}`
        : `${label} · ${fmtShortDate(asOfDate)} · ${meta.ageLabel}`}
    </span>
  );
}
