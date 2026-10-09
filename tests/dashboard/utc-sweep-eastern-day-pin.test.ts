/**
 * The broader UTC sweep: source pins for the sites with no testable seam.
 *
 * These are client components, route handlers that open the production db
 * singleton at import, and network fetchers. The repo has no DOM harness, so
 * the date derivation is pinned by reading the source (the convention in
 * tests/dashboard/et-today-components-pin.test.ts). The rule each pin states:
 * "today" comes from `todayET()`, and the calendar day of a real instant is
 * its Eastern day. tests/repo/no-utc-day-slice.test.ts is the guard that
 * keeps a new UTC slice out; these pins say what each fixed site reads now.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

/** Comments stripped so prose describing the old bug never trips a pin. */
const code = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const IMPORTS_TODAY_ET = /import\s*\{[^}]*\btodayET\b[^}]*\}\s*from\s*"(@\/lib|\.\.)\/calendar\/date-utils"/;
const UTC_SLICE = /\.toISOString\(\)\s*\.(slice\(0, ?10\)|split\("T"\)\[0\])/;

describe("chart range cutoffs count back from the Eastern day", () => {
  it("EquityCurveChart: the range cutoff is built from todayET()", () => {
    const src = code("app/dashboard/components/EquityCurveChart.tsx");
    expect(src).toMatch(IMPORTS_TODAY_ET);
    const start = anchorIndex(src, "function rangeCutoffIso(");
    const body = src.slice(start, anchorIndex(src, "\n}\n", start));
    expect(body).toContain("const today = todayET()");
    expect(body).toContain("addDays(today, -range.days)");
    expect(body).not.toMatch(/new Date\(/);
    expect(body).not.toMatch(UTC_SLICE);
  });

  it("SecurityChart: all three month-window cutoffs go through one Eastern-day helper", () => {
    const src = code("app/dashboard/components/SecurityChart.tsx");
    expect(src).toMatch(IMPORTS_TODAY_ET);
    const start = anchorIndex(src, "function monthsBackCutoff(");
    const helper = src.slice(start, anchorIndex(src, "\n}\n", start));
    expect(helper).toContain('new Date(todayET() + "T00:00:00Z")');
    expect(helper).toContain("setUTCMonth(");
    // Declaration plus the three call sites.
    expect(src.match(/monthsBackCutoff\(/g) ?? []).toHaveLength(4);
    // No wall-clock Date is ever shifted by months and sliced.
    expect(src).not.toMatch(/\.setMonth\(/);
    expect(src.match(new RegExp(UTC_SLICE.source, "g")) ?? []).toHaveLength(1);
  });
});

describe("route handlers read today from todayET()", () => {
  it("compute/risk: the week-ago comparison point is a week before the Eastern day", () => {
    const src = code("app/api/compute/risk/route.ts");
    expect(src).toMatch(IMPORTS_TODAY_ET);
    expect(src).toContain("weekAgo(todayET())");
    expect(src).not.toMatch(/toISOString\(\)/);
  });

  it("earnings/bogeys/upload: the default source label carries the Eastern day", () => {
    const src = code("app/api/earnings/bogeys/upload/route.ts");
    expect(src).toMatch(IMPORTS_TODAY_ET);
    expect(src).toContain("`Upload ${todayET()} ${file.name}`");
    expect(src).not.toMatch(/toISOString\(\)/);
  });
});

describe("lib sites with a network or mailbox behind them", () => {
  it("FRED risk-free rate: the default end date is the Eastern day", () => {
    const src = code("lib/apis/fred.ts");
    expect(src).toMatch(IMPORTS_TODAY_ET);
    expect(src).toContain("options?.asOfDate || todayET()");
    expect(src).not.toMatch(/new Date\(\)\s*\.toISOString\(\)/);
  });

  it("chat query_fred: the default start is a year before the Eastern day", () => {
    const src = code("lib/chat/tools.ts");
    const body = sliceBetween(src, 'case "query_fred": {', 'case "');
    expect(body).toContain("const defaultStart = addDays(todayET(), -365)");
    expect(body).not.toMatch(/toISOString\(\)/);
  });

  it("chat query_research_feeds: the window opens N days before the Eastern day", () => {
    const src = code("lib/chat/tools.ts");
    const body = sliceBetween(src, 'case "query_research_feeds": {', 'case "query_calendar_events": {');
    expect(body).toContain("startDate: addDays(todayET(), -daysBack)");
    expect(body).not.toMatch(/toISOString\(\)/);
  });

  it("gmail discover: a sender's latest-email day is the Eastern day of that email", () => {
    const src = code("lib/gmail/discover.ts");
    expect(src).toMatch(IMPORTS_TODAY_ET);
    expect(src).toContain("formattedDate = todayET(new Date(data.latestDate))");
    expect(src).not.toMatch(UTC_SLICE);
  });

  it("vital-knowledge: each email is labelled with its Eastern day", () => {
    const src = code("lib/vital-knowledge.ts");
    expect(src).toMatch(IMPORTS_TODAY_ET);
    expect(src).toContain("const dateStr = todayET(e.date)");
    expect(src).not.toMatch(UTC_SLICE);
  });
});
