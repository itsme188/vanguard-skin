/**
 * The broader UTC sweep, static guard.
 *
 * `someDate.toISOString().slice(0, 10)` prints the UTC calendar day. For
 * "today" that is wrong between 20:00 and midnight Eastern (the UTC day is
 * already tomorrow), and for a stored instant it puts an evening event on the
 * next day. The rule (CLAUDE.md, "Dates & time"): "today" is `todayET()`, and
 * a real instant's day is its Eastern day (`todayET(instant)`,
 * `lastFiredDateET`).
 *
 * The same expression is CORRECT when the Date was built from a date-only
 * value at UTC midnight (plain calendar arithmetic). The two cannot be told
 * apart by pattern, so this guard works per occurrence:
 *
 *  - EVERY `.toISOString()` cut to a day under app/ and lib/ must be listed in
 *    ALLOWED below, with the class it was reviewed as and one line saying why.
 *  - An entry names the file, a substring of the statement itself (`anchor`),
 *    the enclosing function (`within`) and how many times it occurs. A new
 *    occurrence in an already-listed file does not match and fails.
 *  - A class "date-arithmetic" statement may not read the wall clock
 *    (`new Date()` / `Date.now()`), so a listed line cannot quietly turn into
 *    a "today".
 *  - A stale entry (the code moved or was fixed) fails too, so the list never
 *    outlives what it excuses.
 *
 * Comments are not scanned. tests/, workers/ and scripts/ are out of scope
 * (the Worker has its own Eastern helpers in workers/cron/src/dst.ts).
 *
 * To fix a failure: use `todayET()` / `addDays()` from
 * lib/calendar/date-utils. Add an entry here only for genuine date-only
 * arithmetic or a deliberate UTC vendor contract.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type AllowClass =
  /** A Date built from a date-only value (UTC midnight/noon, Date.UTC, a day number): calendar arithmetic. */
  | "date-arithmetic"
  /** Deliberately UTC: a vendor parameter or a stored key whose zone must not move. */
  | "deliberate-utc"
  /** The import pipeline: a protected area, listed for the owner, not edited by the sweep. */
  | "import-pipeline";

interface Allowed {
  file: string;
  /** Substring of the statement that holds the expression. */
  anchor: string;
  /** Substring of the nearest enclosing `function` declaration line. */
  within: string;
  cls: AllowClass;
  why: string;
  /** Exact number of occurrences this entry covers (default 1). */
  count?: number;
}

const ALLOWED: Allowed[] = [
  // ── app/ ──────────────────────────────────────────────────────────────
  {
    file: "app/dashboard/today/EarningsHubLive.tsx",
    anchor: "date.toISOString().slice(0, 10) !== value",
    within: "function eventDateLabel(",
    cls: "date-arithmetic",
    why: "Round-trip validity check of a date string parsed at UTC noon (refuses 2026-02-30).",
  },
  {
    file: "app/dashboard/components/IncomeYieldSection.tsx",
    anchor: "yearAgo.toISOString().slice(0, 10)",
    within: "function IncomeYieldSection(",
    cls: "date-arithmetic",
    why: "Year-back step on a Date built from the Eastern day string at UTC midnight.",
  },
  {
    file: "app/dashboard/components/SecurityChart.tsx",
    anchor: "return cutoff.toISOString().slice(0, 10);",
    within: "function monthsBackCutoff(",
    cls: "date-arithmetic",
    why: "Month-back step on a Date built from todayET() at UTC midnight.",
  },
  {
    file: "app/api/earnings/release-time/route.ts",
    anchor: "Date.now() - OBSERVATION_LOOKBACK_DAYS",
    within: "function GET(",
    cls: "deliberate-utc",
    why: "Twin of wire-times lookbackSinceDate: a 400-day observation window, the two must agree; one day of fuzz is immaterial.",
  },
  // ── lib/apis ──────────────────────────────────────────────────────────
  {
    file: "lib/apis/fred.ts",
    anchor: "new Date(endDate).getTime() - 30 * 24 * 3600 * 1000",
    within: "function getRiskFreeRate(",
    cls: "date-arithmetic",
    why: "endDate is a date-only string (parsed as UTC midnight); 30 days back from it.",
  },
  {
    file: "lib/apis/press-releases.ts",
    anchor: "const toStr = to.toISOString().slice(0, 10);",
    within: "function fetchAndCachePressReleases(",
    cls: "deliberate-utc",
    why: "Finnhub company-news `to`: the UTC day is a superset in the evening, so a release stamped after UTC midnight is not cut off.",
  },
  {
    file: "lib/apis/press-releases.ts",
    anchor: "const fromStr = from.toISOString().slice(0, 10);",
    within: "function fetchAndCachePressReleases(",
    cls: "deliberate-utc",
    why: "Finnhub company-news `from`: same clock as `to`; the window is days wide and re-fetched rows upsert.",
  },
  {
    file: "lib/apis/analyst-estimates.ts",
    anchor: "new Date(epochSeconds * 1000).toISOString().slice(0, 10)",
    within: "function epochToDate(",
    cls: "deliberate-utc",
    why: "Vendor epoch to the stored rating_date, which is part of the row's identity; moving the zone would re-key stored rows.",
  },
  // ── lib/calendar ──────────────────────────────────────────────────────
  {
    file: "lib/calendar/briefing.ts",
    anchor: "return d.toISOString().slice(0, 10);",
    within: "function addDays(",
    cls: "date-arithmetic",
    why: "Day step on a date string parsed at local noon; noon stays on the same UTC day in any US zone.",
  },
  {
    file: "lib/calendar/enrich-actuals.ts",
    anchor: "return d.toISOString().slice(0, 10);",
    within: "function priorMonthEnd(",
    cls: "date-arithmetic",
    why: "Prior month end of a date string parsed at UTC midnight.",
  },
  {
    file: "lib/calendar/nasdaq.ts",
    anchor: "out.push(d.toISOString().slice(0, 10));",
    within: "function tradingDaysInWindow(",
    cls: "date-arithmetic",
    why: "Walks date strings at UTC midnight with setUTCDate.",
  },
  {
    file: "lib/calendar/reconcile-earnings-dates.ts",
    anchor: "return d.toISOString().slice(0, 10);",
    within: "function addDaysUTC(",
    cls: "date-arithmetic",
    why: "Day step on a date string parsed at UTC midnight.",
  },
  {
    file: "lib/calendar/manual-event-input.ts",
    anchor: "parsed.toISOString().slice(0, 10) === date",
    within: "function ",
    cls: "date-arithmetic",
    why: "Round-trip validity check of a date string parsed at UTC.",
  },
  // ── lib/chart, lib/queries, lib/ibkr, lib/tws, lib/levels ─────────────
  {
    file: "lib/chart/equity-curve-anchor.ts",
    anchor: "return new Date(ms).toISOString().slice(0, 10);",
    within: "function epochMsToIsoDate(",
    cls: "date-arithmetic",
    why: "Inverse of isoDateToEpochMs (UTC midnight of a date string); the chart axis is UTC by design.",
  },
  {
    file: "lib/queries/analysis-trust-state.ts",
    anchor: "return next.toISOString().slice(0, 10);",
    within: "function nextMonthEndDate(",
    cls: "date-arithmetic",
    why: "Next month end via Date.UTC from a date string.",
  },
  {
    file: "lib/queries/reconciliation.ts",
    anchor: "d.toISOString().slice(0, 10) === value",
    within: "function ",
    cls: "date-arithmetic",
    why: "Round-trip validity check of a date string parsed at UTC.",
  },
  {
    file: "lib/ibkr/option-chain.ts",
    anchor: "monthToken(nextMonth.toISOString().slice(0, 10))",
    within: "function candidateMonths(",
    cls: "date-arithmetic",
    why: "First of next month via Date.UTC from the event date string.",
  },
  {
    file: "lib/tws/option-underlyings.ts",
    anchor: "return new Date(n * 86_400_000).toISOString().slice(0, 10);",
    within: "function isoFromDayNumber(",
    cls: "date-arithmetic",
    why: "Inverse of dayNumber (a whole count of UTC days from a date string).",
  },
  {
    file: "lib/levels/scan-range.ts",
    anchor: "return priceDate < cutoff.toISOString().slice(0, 10);",
    within: "function isLevelPriceStale(",
    cls: "date-arithmetic",
    why: "Window step on the caller's `today` string parsed at UTC midnight.",
  },
  {
    file: "lib/print-watch/read-scheduler.ts",
    anchor: "Date.parse(`${today}T00:00:00Z`) - READ_RECONCILE_LOOKBACK_DAYS",
    within: "function reconcilePendingReads(",
    cls: "date-arithmetic",
    why: "Lookback floor from the Eastern day string at UTC midnight.",
  },
  // ── lib/compute ───────────────────────────────────────────────────────
  {
    file: "lib/compute/monthly-snapshot-utils.ts",
    anchor: "return prior.toISOString().slice(0, 10);",
    within: "function priorMonthEndDate(",
    cls: "date-arithmetic",
    why: "Prior month end via Date.UTC from a date string.",
  },
  {
    file: "lib/compute/dietz.ts",
    anchor: "return prior.toISOString().slice(0, 10);",
    within: "function priorMonthEndDate(",
    cls: "date-arithmetic",
    why: "Prior month end via Date.UTC from a date string.",
  },
  {
    file: "lib/compute/performance-window-caption.ts",
    anchor: "return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);",
    within: "function ",
    cls: "date-arithmetic",
    why: "Next day via Date.UTC from parsed date parts.",
  },
  {
    file: "lib/compute/performance-window.ts",
    anchor: "return new Date(Date.UTC(y, monthIndex, day)).toISOString().slice(0, 10);",
    within: "function ",
    cls: "date-arithmetic",
    why: "A calendar date assembled with Date.UTC from parts.",
  },
  {
    file: "lib/compute/corporate-actions.ts",
    anchor: 'new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d',
    within: "function ",
    cls: "date-arithmetic",
    why: "Round-trip validity check of a date string parsed at UTC midnight.",
  },
  {
    file: "lib/compute/xirr.ts",
    anchor: "return d.toISOString().slice(0, 10);",
    within: "function nextDay(",
    cls: "date-arithmetic",
    why: "Day step on a date string parsed at UTC midnight.",
  },
  {
    file: "lib/compute/twr.ts",
    anchor: "return d.toISOString().slice(0, 10);",
    within: "function dayBeforeMonthStart(",
    cls: "date-arithmetic",
    why: "Day step on a date string parsed at UTC midnight.",
  },
  // ── lib/earnings ──────────────────────────────────────────────────────
  {
    file: "lib/earnings/implied-move.ts",
    anchor: "return out.toISOString().slice(0, 10);",
    within: "function defaultExpiryFriday(",
    cls: "date-arithmetic",
    why: "First Friday on or after an event date string parsed at UTC midnight.",
  },
  {
    file: "lib/earnings/report-history.ts",
    anchor: "Date.parse(`${oldest}T00:00:00Z`) - 7 * 86400_000",
    within: "function ",
    cls: "date-arithmetic",
    why: "Seven days before a vendor report date string parsed at UTC midnight.",
  },
  {
    file: "lib/earnings/wire-times.ts",
    anchor: "return d.toISOString().slice(0, 10);",
    within: "function lookbackSinceDate(",
    cls: "deliberate-utc",
    why: "Commented in place as deliberate: a 400-day observation window where a day of fuzz cannot change the cascade.",
  },
  // ── lib/import (protected: listed for the owner, never edited here) ────
  {
    file: "lib/import/parsers/ibkr-holdings.ts",
    anchor: "const today = new Date().toISOString().slice(0, 10);",
    within: "function ",
    cls: "import-pipeline",
    why: "Fallback as-of date when the file carries none. A UTC 'today': open for the owner (import pipeline is do-not-touch).",
  },
  {
    file: "lib/import/parsers/vanguard-export.ts",
    anchor: "const today = new Date().toISOString().slice(0, 10);",
    within: "function ",
    cls: "import-pipeline",
    why: "Fallback as-of date. A UTC 'today': open for the owner (import pipeline is do-not-touch).",
  },
  {
    file: "lib/import/parsers/vanguard-holdings.ts",
    anchor: "const today = new Date().toISOString().slice(0, 10);",
    within: "function ",
    cls: "import-pipeline",
    why: "Fallback as-of date. A UTC 'today': open for the owner (import pipeline is do-not-touch).",
  },
  {
    file: "lib/import/parsers/vanguard-cost-basis.ts",
    anchor: "const today = new Date().toISOString().slice(0, 10);",
    within: "function ",
    cls: "import-pipeline",
    why: "Fallback as-of date, twice. A UTC 'today': open for the owner (import pipeline is do-not-touch).",
    count: 2,
  },
  {
    file: "lib/import/parsers/ibkr-activity.ts",
    anchor: "return d.toISOString().slice(0, 10);",
    within: "function ",
    cls: "import-pipeline",
    why: "Formats a parsed statement date; listed, not reviewed for edit (import pipeline is do-not-touch).",
  },
  {
    file: "lib/import/parsers/ibkr-activity.ts",
    anchor: "d.toISOString().slice(0, 10) === s",
    within: "function ",
    cls: "import-pipeline",
    why: "Round-trip validity check of a statement date string (import pipeline is do-not-touch).",
  },
];

// ─── Scanner ──────────────────────────────────────────────────────────

/** `.toISOString()` cut to its first ten characters, in any of the spellings. */
const UTC_DAY_CUT =
  /\.toISOString\(\)\s*\.\s*(?:slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\)|substr\(\s*0\s*,\s*10\s*\)|split\(\s*["'`]T["'`]\s*\)\s*\[\s*0\s*\])/g;

const WALL_CLOCK = /new Date\(\s*\)|Date\.now\(\)|new Date\(\s*Date\.now\(\)\s*\)/;
const FUNCTION_LINE = /\bfunction\s+\w+\s*[(<]/;

/** Block comments and whole-line `//` comments blanked, line numbers kept. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

interface Occurrence {
  file: string;
  line: number;
  /** The statement: the matched line(s), extended back over a `.`/`)` chain. */
  statement: string;
  /** Nearest preceding function declaration line ("" if none). */
  within: string;
}

function scanSource(file: string, raw: string): Occurrence[] {
  const src = stripComments(raw);
  const lines = src.split("\n");
  const out: Occurrence[] = [];
  for (const m of src.matchAll(UTC_DAY_CUT)) {
    const startLine = src.slice(0, m.index).split("\n").length - 1;
    const endLine = src.slice(0, m.index + m[0].length).split("\n").length - 1;
    // A chained call often starts its own line (`.toISOString()` under the
    // expression it belongs to): walk back to the line that opens the chain.
    let first = startLine;
    while (first > 0 && /^\s*[.)]/.test(lines[first])) first--;
    let within = "";
    for (let i = first; i >= 0; i--) {
      if (FUNCTION_LINE.test(lines[i])) {
        within = lines[i];
        break;
      }
    }
    out.push({
      file,
      line: startLine + 1,
      statement: lines.slice(first, endLine + 1).join("\n"),
      within,
    });
  }
  return out;
}

const SCAN_ROOTS = ["app", "lib"];
const EXCLUDED_SEGMENTS = new Set(["node_modules", ".next", "tests", "__tests__", ".git"]);

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = SCAN_ROOTS.flatMap((root) => collect(path.join(REPO_ROOT, root)));
const occurrences = files.flatMap((full) =>
  scanSource(path.relative(REPO_ROOT, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8")),
);

function matches(entry: Allowed, occ: Occurrence): boolean {
  return (
    entry.file === occ.file &&
    occ.statement.includes(entry.anchor) &&
    occ.within.includes(entry.within)
  );
}

const show = (o: Occurrence) =>
  `${o.file}:${o.line}\n      ${o.statement.trim().replace(/\s*\n\s*/g, " ")}\n      in: ${o.within.trim() || "(no enclosing function)"}`;

// ─── Tests ────────────────────────────────────────────────────────────

describe("the scanner itself", () => {
  const count = (code: string) => scanSource("x.ts", code).length;

  it("sees every spelling of the cut", () => {
    expect(count("const a = new Date().toISOString().slice(0, 10);")).toBe(1);
    expect(count("const a = new Date().toISOString().slice(0,10);")).toBe(1);
    expect(count('const a = new Date().toISOString().split("T")[0];')).toBe(1);
    expect(count("const a = new Date().toISOString().split('T')[0];")).toBe(1);
    expect(count("const a = new Date(Date.now()).toISOString().substring(0, 10);")).toBe(1);
    expect(count("const a = new Date(Date.now() - 5)\n  .toISOString()\n  .slice(0, 10);")).toBe(1);
  });

  it("ignores comments and a full timestamp", () => {
    expect(count("// never new Date().toISOString().slice(0, 10)\nconst a = 1;")).toBe(0);
    expect(count("/* new Date().toISOString().slice(0, 10) */ const a = 1;")).toBe(0);
    expect(count("const stamp = new Date().toISOString();")).toBe(0);
    expect(count("const month = new Date().toISOString().slice(0, 7);")).toBe(0);
  });

  it("reports the whole chained statement and the enclosing function", () => {
    const [occ] = scanSource(
      "x.ts",
      "export function since(): string {\n  return new Date(Date.now() - 5)\n    .toISOString()\n    .slice(0, 10);\n}\n",
    );
    expect(occ.statement).toContain("new Date(Date.now() - 5)");
    expect(occ.within).toContain("function since(");
    expect(occ.line).toBe(3);
  });

  it("walked a real tree (the scan is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(occurrences.length).toBeGreaterThan(20);
  });
});

describe("no UTC day slice under app/ and lib/ outside the reviewed list", () => {
  it("every occurrence is on the allowlist", () => {
    const unlisted = occurrences.filter((occ) => !ALLOWED.some((e) => matches(e, occ)));
    expect(
      unlisted.map(show),
      "A UTC day slice that is not on the reviewed list. For \"today\" use todayET(); " +
        "for a real instant use todayET(instant); for a day step use addDays() " +
        "(lib/calendar/date-utils). List it in ALLOWED only if it is date-only arithmetic " +
        "or a deliberate UTC vendor contract.",
    ).toEqual([]);
  });

  it("every allowlist entry still matches exactly the occurrences it was reviewed for", () => {
    const wrong = ALLOWED.map((entry) => {
      const found = occurrences.filter((occ) => matches(entry, occ)).length;
      const want = entry.count ?? 1;
      return found === want
        ? null
        : `${entry.file} :: ${entry.anchor} :: expected ${want}, found ${found}` +
            (found === 0 ? " (stale entry: remove it, or the anchor moved)" : " (a new copy needs its own review)");
    }).filter((x): x is string => x !== null);
    expect(wrong).toEqual([]);
  });

  it("no occurrence is covered by two entries (each is reviewed once)", () => {
    const doubled = occurrences
      .filter((occ) => ALLOWED.filter((e) => matches(e, occ)).length > 1)
      .map(show);
    expect(doubled).toEqual([]);
  });

  it("a statement listed as date arithmetic never reads the wall clock", () => {
    const leaks = occurrences
      .filter((occ) => {
        const entry = ALLOWED.find((e) => matches(e, occ));
        return entry?.cls === "date-arithmetic" && WALL_CLOCK.test(occ.statement);
      })
      .map(show);
    expect(leaks).toEqual([]);
  });

  it("every entry carries a class and a reason", () => {
    for (const entry of ALLOWED) {
      expect(entry.why.length, `${entry.file} :: ${entry.anchor}`).toBeGreaterThan(20);
      expect(entry.anchor.length, entry.file).toBeGreaterThan(15);
    }
  });

  it("only the import pipeline is listed as import-pipeline, and all of it is", () => {
    for (const entry of ALLOWED) {
      expect(entry.cls === "import-pipeline", entry.file).toBe(entry.file.startsWith("lib/import/"));
    }
  });
});
