/**
 * Period rules of the filing-summary checker beyond R5's `samePeriod`: column
 * periods, the section's anchors for bogey periods (R6), period equality for
 * bound figures, and the year-before test for growth (R8). Pure.
 */
import { parsePeriodHeader, samePeriod, type PeriodCore } from "./figures";
import type { DocText, PeriodAnchor, TableGrid } from "./types";

/** A period as the SOURCE states it; `anchor` stays only on a bogey period that could not be resolved. */
export type SourcePeriod = PeriodCore & { anchor: PeriodAnchor };

/** The table a figure was read from. */
export interface TableContext { grid: TableGrid; bareDateIsInstant: boolean }

const DURATION_WORD = /\b(?:three|six|nine|twelve)\s+months\b|\bquarters?\b|\byears?\s+end(?:ed|ing)\b|\bweeks\s+end(?:ed|ing)\b/i;

/** Controller ruling 3: a bare date heads an instant only in a table with no duration header. */
export function tableContext(grid: TableGrid): TableContext {
  return { grid, bareDateIsInstant: !grid.columnHeaders.some((h) => DURATION_WORD.test(h)) };
}

/** A column header's period; a period ending after the event date is an outlook, not an actual. */
export function columnPeriod(ctx: TableContext, col: number, eventDate: string): PeriodCore | null {
  const p = parsePeriodHeader(ctx.grid.columnHeaders[col] ?? "", { bareDateIsInstant: ctx.bareDateIsInstant });
  if (!p) return null;
  return p.endDate && p.endDate > eventDate ? { ...p, role: "outlook" } : p;
}

/** The latest quarter column in one table that ended on or before the event date. */
export function latestQuarterEnd(ctx: TableContext, eventDate: string): string | null {
  let latest: string | null = null;
  for (let c = 0; c < ctx.grid.columnHeaders.length; c++) {
    const p = parsePeriodHeader(ctx.grid.columnHeaders[c] ?? "", { bareDateIsInstant: ctx.bareDateIsInstant });
    if (!p || p.kind !== "quarter" || !p.endDate || p.endDate > eventDate) continue;
    if (latest === null || p.endDate > latest) latest = p.endDate;
  }
  return latest;
}

/** Month arithmetic that keeps a month-end a month-end (Sept 30 + 3 months = Dec 31). */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  const wasLast = d === new Date(Date.UTC(y, m, 0)).getUTCDate();
  const t = new Date(Date.UTC(y, m - 1 + months, wasLast ? last : Math.min(d, last)));
  // Calendar arithmetic on a date-only value, formatted field by field (no instant, no time zone).
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** What the section's filing says about this print's periods (R6, controller ruling of fix round 1). */
export interface SectionAnchors { reportedQuarter: string | null; fiscalYearEnd: string | null }

const MONTH_DAY_YEAR =
  "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?\\s+(\\d{1,2}),?\\s+((?:19|20)\\d\\d)";
const YEAR_END_PHRASE = new RegExp(`\\b(?:fiscal\\s+)?(?:year\\s+)?(?:(?:19|20)\\d\\d\\s+)?(?:year\\s+)?(?:ending|ended|ends)\\s+${MONTH_DAY_YEAR}`, "gi");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function iso(month: string, day: string, year: string): string | null {
  const mi = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  const d = Number(day);
  if (mi < 0 || d < 1 || d > new Date(Date.UTC(Number(year), mi + 1, 0)).getUTCDate()) return null;
  return `${year}-${String(mi + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * - reportedQuarter: the latest quarter-kind column with an end date on or
 *   before the event date, across every table of the section's documents.
 * - fiscalYearEnd: the first fiscal year-end AFTER the reported quarter,
 *   rolled forward a year at a time from a year-end the filing states (a
 *   "Year Ended …" column, or "fiscal year … ending/ended <date>" in prose).
 *   A trailing-twelve-month column is not a year-end. Null when the filing
 *   states none: a fiscal-year anchor then stays unconfirmed.
 */
export function sectionAnchors(docs: Array<{ text: DocText }>, eventDate: string): SectionAnchors {
  let reportedQuarter: string | null = null;
  const yearEnds: string[] = [];
  for (const { text } of docs) {
    for (const grid of text.tables) {
      const ctx = tableContext(grid);
      const q = latestQuarterEnd(ctx, eventDate);
      if (q && (reportedQuarter === null || q > reportedQuarter)) reportedQuarter = q;
      for (const h of grid.columnHeaders) {
        if (!/\byears?\s+end(?:ed|ing)\b/i.test(h) || /\btwelve\b|\b12\s*months\b/i.test(h)) continue;
        const p = parsePeriodHeader(h, { bareDateIsInstant: false });
        if (p?.kind === "fiscal_year" && p.endDate) yearEnds.push(p.endDate);
      }
    }
    for (const b of text.blocks) {
      if (b.tableId !== null) continue;
      for (const m of b.text.matchAll(YEAR_END_PHRASE)) {
        if (!/\byear\b/i.test(m[0])) continue;
        const d = iso(m[1], m[2], m[3]);
        if (d) yearEnds.push(d);
      }
    }
  }
  let fiscalYearEnd: string | null = null;
  if (reportedQuarter) {
    for (const ye of yearEnds) {
      let end = ye;
      for (let i = 0; i < 10 && end <= reportedQuarter; i++) end = addMonthsIso(end, 12);
      while (addMonthsIso(end, -12) > reportedQuarter) end = addMonthsIso(end, -12);
      if (end > reportedQuarter && (fiscalYearEnd === null || end < fiscalYearEnd)) fiscalYearEnd = end;
    }
  }
  return { reportedQuarter, fiscalYearEnd };
}

/** Resolve a bogey anchor to a concrete period, or keep the anchor when the filing does not say. */
export function resolveAnchor(p: SourcePeriod, anchors: SectionAnchors): SourcePeriod {
  switch (p.anchor) {
    case "reported_quarter":
      return anchors.reportedQuarter
        ? { kind: "quarter", role: "actual", endDate: anchors.reportedQuarter, fiscalYear: null, fiscalQuarter: null, anchor: null }
        : p;
    case "next_quarter":
      return anchors.reportedQuarter
        ? { kind: "quarter", role: "outlook", endDate: addMonthsIso(anchors.reportedQuarter, 3), fiscalYear: null, fiscalQuarter: null, anchor: null }
        : p;
    case "fiscal_year":
      // A fiscal year is named by the calendar year it ends in.
      return anchors.fiscalYearEnd
        ? { kind: "fiscal_year", role: "outlook", endDate: anchors.fiscalYearEnd, fiscalYear: Number(anchors.fiscalYearEnd.slice(0, 4)), fiscalQuarter: null, anchor: null }
        : p;
    default:
      return p;
  }
}

/**
 * Do two bound periods match? Kind differs → false. Role differs → false,
 * except for a COMPARISON (`ignoreRole`), where a quarter's actual and that
 * same quarter's guidance are one period. An anchor left unresolved matches
 * only the same anchor; otherwise cannot tell. Then R5 `samePeriod`.
 */
export function periodsMatch(pa: SourcePeriod | null, pb: SourcePeriod | null, opts: { ignoreRole?: boolean } = {}): boolean | null {
  if (!pa || !pb) return null;
  if (pa.kind !== pb.kind) return false;
  if (pa.role !== pb.role && !opts.ignoreRole) return false;
  if (pa.anchor || pb.anchor) return pa.anchor && pa.anchor === pb.anchor ? true : null;
  return samePeriod({ ...pa, role: pb.role }, pb);
}

/** Within a week: a 52/53-week fiscal calendar moves its period ends by a day or two. */
function withinWeek(a: string, b: string): boolean {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) <= 7 * 86_400_000;
}

/** R8: `old` ends one year (or, for a quarter, one quarter) before `nw`. Null = cannot tell. */
export function isPriorPeriod(nw: SourcePeriod, old: SourcePeriod): boolean | null {
  if (nw.kind !== old.kind || nw.role !== old.role) return false;
  if (nw.anchor || old.anchor) return null;
  if (nw.endDate && old.endDate) {
    if (withinWeek(addMonthsIso(nw.endDate, -12), old.endDate)) return true;
    return nw.kind === "quarter" && withinWeek(addMonthsIso(nw.endDate, -3), old.endDate);
  }
  if (nw.endDate || old.endDate || nw.fiscalYear === null || old.fiscalYear === null) return null;
  if (nw.kind === "fiscal_year") return old.fiscalYear === nw.fiscalYear - 1;
  if (nw.fiscalQuarter === null || old.fiscalQuarter === null) return null;
  if (old.fiscalYear === nw.fiscalYear - 1 && old.fiscalQuarter === nw.fiscalQuarter) return true;
  if (nw.kind !== "quarter") return false;
  const prevQ = nw.fiscalQuarter === 1 ? { y: nw.fiscalYear - 1, q: 4 } : { y: nw.fiscalYear, q: nw.fiscalQuarter - 1 };
  return old.fiscalYear === prevQ.y && old.fiscalQuarter === prevQ.q;
}
