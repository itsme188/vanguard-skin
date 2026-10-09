/**
 * How a stored reference period (calendar_events.reference_period, migration
 * 097) is shown on a macro card.
 *
 * Owner ruling 2026-10-08: "name the reference month from FRED's observation
 * period, not from the release date minus a fixed lag." The title a row
 * carries was written before the release, from an estimate of the period. It
 * is never edited here. When the stored period is present:
 *   - a title that already names it gets nothing added (one month, named once);
 *   - a title that names a different period, or none, gets the stored period
 *     shown beside it.
 * A row with no stored period (not yet enriched, or not a FRED row) keeps its
 * title as it is.
 *
 * Pure string work: no Date object, no time zone.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type ParsedPeriod =
  | { kind: "month"; year: string; month: number }
  | { kind: "quarter"; year: string; quarter: number }
  | { kind: "week"; year: string; month: number; day: number };

function parsePeriod(period: string | null | undefined): ParsedPeriod | null {
  if (typeof period !== "string") return null;
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (month) return { kind: "month", year: month[1], month: Number(month[2]) };
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter) return { kind: "quarter", year: quarter[1], quarter: Number(quarter[2]) };
  const week = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(period);
  if (week) return { kind: "week", year: week[1], month: Number(week[2]), day: Number(week[3]) };
  return null;
}

function labelOf(p: ParsedPeriod): string {
  if (p.kind === "month") return `${MONTHS[p.month - 1]} ${p.year}`;
  if (p.kind === "quarter") return `Q${p.quarter} ${p.year}`;
  return `the week ended ${MONTHS[p.month - 1].slice(0, 3)} ${p.day}, ${p.year}`;
}

/**
 * "August 2026", "Q2 2026" or "the week ended Aug 29, 2026" for a stored
 * reference period; null for anything else.
 */
export function formatReferencePeriod(period: string | null | undefined): string | null {
  const parsed = parsePeriod(period);
  return parsed ? labelOf(parsed) : null;
}

/**
 * The short line a card prints beside a macro title, or null when there is
 * nothing to add. See the file header for the rule.
 */
export function macroPeriodNote(
  title: string | null | undefined,
  period: string | null | undefined,
): string | null {
  const parsed = parsePeriod(period);
  if (!parsed) return null;
  const text = title ?? "";
  if (parsed.kind === "month") {
    const named = new RegExp(`\\b${MONTHS[parsed.month - 1]}\\b`, "i").test(text);
    if (named) return null;
  } else if (parsed.kind === "quarter") {
    if (new RegExp(`\\bQ${parsed.quarter}\\b`, "i").test(text)) return null;
  }
  return `for ${labelOf(parsed)}`;
}
