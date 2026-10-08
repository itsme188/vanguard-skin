/**
 * Static guard: every query that SELECTS from `ohlcv_bars` reads through the
 * shared priced-bar predicate (`PRICED_BAR_SQL`, lib/queries/ohlcv.ts).
 *
 * Why: bars stored before the 2026-09-06 write guard can carry a zero /
 * non-positive open, high, low or close (or high < low). A reader that takes
 * such a row raw turns it into a number the desk acts on — a zero close reads
 * as a -100% move, a zero low makes a day range or ATR absurd, a zero wick
 * breaks a candlestick axis. The fix was applied one call site at a time
 * (2026-09-06, 2026-09-11, 2026-10-05); this test stops the next new reader
 * from re-opening the class.
 *
 * MATCH UNIT: one SQL literal. For each string/template literal that contains
 * `FROM ohlcv_bars` or `JOIN ohlcv_bars`, the number of `${PRICED_BAR_SQL}`
 * interpolations in that same literal must be at least the number of such
 * reads. Writes (`INSERT … INTO`, `UPDATE ohlcv_bars`, `DELETE FROM`) are not
 * reads and are not matched — `DELETE FROM ohlcv_bars` is excluded by name.
 * A hand-rolled copy of the condition (`close > 0`) does NOT satisfy the
 * guard: the point is one definition of "priced".
 *
 * ALLOWLIST: per literal, keyed by file + an anchor substring that must
 * appear inside the offending literal, each with a justification. A stale
 * entry (no longer matching anything) fails the suite.
 *
 * SCOPE: `lib/**` and `app/**` (.ts/.tsx). `scripts/**` is out of scope —
 * repair and backfill scripts legitimately read corrupt rows to fix them.
 *
 * KNOWN LIMITS (kept simple on purpose, modelled on the allowlist shape of
 * tests/repo/no-handrolled-latest-holdings.test.ts but without its lexer):
 * comments are blanked by line-anchored patterns (a `/*` or `//` that starts
 * a line, or a `//` preceded by whitespace), and a template literal is found
 * by backtick parity. A nested template inside `${…}` or a backtick inside a
 * plain string would shift the parity; the resulting window then almost
 * never contains the predicate, so the failure mode is a loud false alarm,
 * not a silent pass. The self-tests below pin the scanner on both shapes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_DIRS = ["lib", "app"];
const EXCLUDED_SEGMENTS = new Set(["node_modules", ".next", "migrations", "tests", "docs", ".git"]);

const READ_RE = /\b(?:FROM|JOIN)\s+ohlcv_bars\b/gi;
const PREDICATE_RE = /\$\{\s*PRICED_BAR_SQL\s*\}/g;

interface AllowEntry {
  file: string;
  /** Must appear inside the literal that reads ohlcv_bars without the predicate. */
  anchor: string;
  justification: string;
}

const ALLOWLIST: AllowEntry[] = [
  {
    file: "lib/queries/ohlcv.ts",
    anchor: "SELECT MAX(bar_date) as latest FROM ohlcv_bars",
    justification:
      "getLatestOhlcvDate is the incremental-fetch anchor, not a price reader. Filtering it would pin the anchor behind a trailing zero bar and re-request the same TWS window on every chart open (see the function's doc).",
  },
  {
    file: "lib/queries/ohlcv.ts",
    anchor: "MAX(CASE WHEN high > 0 THEN high END) AS high",
    justification:
      "get52WeekRange keeps its own shipped per-aggregate form (CASE WHEN … > 0) so a bar with one bad leg still contributes its good leg; PRICED_BAR_SQL's doc says not to replace it. Its inner MAX(bar_date) only anchors the window.",
  },
  {
    file: "lib/queries/data-health.ts",
    anchor: "JOIN ohlcv_bars ob ON ob.security_id = p.security_id",
    justification:
      "Cross-source discrepancy check: its job is to REPORT bad bars. A zero close must stay visible and count as a 100% disagreement (pinned in tests/queries/data-health.test.ts).",
  },
];

// ─── Scanner ──────────────────────────────────────────────────────────────

/** Blank comments in place (same length, newlines kept) so offsets and
 *  backtick parity are computed over code and literals only. */
export function blankComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blank) // block comment starting a line
    .replace(/(^|[ \t])\/\/[^\n]*/gm, blank); // line comment (not `https://`)
}

export interface RawRead {
  line: number;
  literal: string;
  reads: number;
  predicates: number;
}

/** Literals that read ohlcv_bars more times than they apply the predicate. */
export function findRawReads(src: string): RawRead[] {
  const code = blankComments(src);
  const ticks: number[] = [];
  for (let i = 0; i < code.length; i++) if (code[i] === "`") ticks.push(i);

  const seen = new Set<number>();
  const out: RawRead[] = [];
  for (const m of code.matchAll(READ_RE)) {
    const idx = m.index;
    if (/\bDELETE\s+$/i.test(code.slice(Math.max(0, idx - 12), idx))) continue;

    const before = ticks.filter((t) => t < idx).length;
    let start: number;
    let end: number;
    if (before % 2 === 1) {
      start = ticks[before - 1];
      end = ticks[before] ?? code.length;
    } else {
      // Plain "…" / '…' string: single-line by construction.
      start = code.lastIndexOf("\n", idx) + 1;
      const nl = code.indexOf("\n", idx);
      end = nl === -1 ? code.length : nl;
    }
    if (seen.has(start)) continue;
    seen.add(start);

    const literal = code.slice(start, end);
    const reads = [...literal.matchAll(READ_RE)].filter(
      (r) => !/\bDELETE\s+$/i.test(literal.slice(Math.max(0, r.index - 12), r.index)),
    ).length;
    const predicates = [...literal.matchAll(PREDICATE_RE)].length;
    if (predicates < reads) {
      out.push({ line: code.slice(0, idx).split("\n").length, literal, reads, predicates });
    }
  }
  return out;
}

function collectFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("scanner self-tests", () => {
  const P = "${PRICED_BAR_SQL}";

  it("flags a raw template-literal read", () => {
    const src = "const q = db.prepare(`SELECT close FROM ohlcv_bars WHERE security_id = ?`);";
    expect(findRawReads(src)).toHaveLength(1);
  });

  it("flags a raw plain-string read", () => {
    const src = 'const q = db.prepare("SELECT close FROM ohlcv_bars WHERE security_id = ?");';
    expect(findRawReads(src)).toHaveLength(1);
  });

  it("flags a JOIN read and a hand-rolled copy of the condition", () => {
    const src =
      "db.prepare(`SELECT 1 FROM prices p JOIN ohlcv_bars b ON b.security_id = p.security_id WHERE b.close > 0`);";
    expect(findRawReads(src)).toHaveLength(1);
  });

  it("passes a guarded read", () => {
    const src = `db.prepare(\`SELECT close FROM ohlcv_bars\n WHERE security_id = ? AND ${P}\`);`;
    expect(findRawReads(src)).toHaveLength(0);
  });

  it("one predicate does not cover two reads in the same literal", () => {
    const src = `db.prepare(\`SELECT close FROM ohlcv_bars WHERE ${P}\n UNION ALL SELECT close FROM ohlcv_bars\`);`;
    const hits = findRawReads(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].reads).toBe(2);
    expect(hits[0].predicates).toBe(1);
  });

  it("a guarded literal does not excuse a later raw one", () => {
    const src = [
      `const a = db.prepare(\`SELECT close FROM ohlcv_bars WHERE ${P}\`);`,
      "const b = db.prepare(`SELECT low FROM ohlcv_bars WHERE security_id = ?`);",
    ].join("\n");
    const hits = findRawReads(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
  });

  it("ignores comments (including backticked prose) and writes", () => {
    const src = [
      "/**",
      " * Reads `ohlcv_bars` — e.g. SELECT x FROM ohlcv_bars — raw on purpose.",
      " */",
      "// SELECT x FROM ohlcv_bars",
      "db.prepare(`UPDATE ohlcv_bars SET close = close / ? WHERE security_id = ?`);",
      "db.prepare(`INSERT OR REPLACE INTO ohlcv_bars (security_id) VALUES (?)`);",
      "db.prepare(`DELETE FROM ohlcv_bars WHERE security_id = ?`);",
    ].join("\n");
    expect(findRawReads(src)).toHaveLength(0);
  });
});

describe("ohlcv_bars readers go through PRICED_BAR_SQL", () => {
  const files = SCAN_DIRS.flatMap((d) => collectFiles(path.join(REPO_ROOT, d)));
  const used = new Set<AllowEntry>();
  const violations: string[] = [];
  let guardedSeen = 0;

  for (const abs of files) {
    const src = fs.readFileSync(abs, "utf8");
    if (!/ohlcv_bars/.test(src)) continue;
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
    guardedSeen += [...blankComments(src).matchAll(PREDICATE_RE)].length;
    for (const hit of findRawReads(src)) {
      const entry = ALLOWLIST.find((e) => e.file === rel && hit.literal.includes(e.anchor));
      if (entry) {
        used.add(entry);
        continue;
      }
      violations.push(
        `${rel}:${hit.line} — ${hit.reads} read(s) of ohlcv_bars, ${hit.predicates} \${PRICED_BAR_SQL}`,
      );
    }
  }

  it("the scanner actually sees the tree (sanity floor)", () => {
    expect(files.length).toBeGreaterThan(100);
    // getOhlcvBars, getRecentOhlcvBars, getLatestDailyBar, the chart-default
    // coverage probe, MA level resolution, three trade-review reads.
    expect(guardedSeen).toBeGreaterThanOrEqual(8);
  });

  it("no query reads ohlcv_bars without the shared predicate", () => {
    expect(
      violations,
      "Add `AND ${PRICED_BAR_SQL}` (import from @/lib/queries/ohlcv) to the query. " +
        "Only a reader that must SEE bad bars (data-health, a fetch anchor) belongs in the allowlist, with a justification.",
    ).toEqual([]);
  });

  it("every allowlist entry is justified and still matches a literal", () => {
    for (const e of ALLOWLIST) {
      expect(e.justification.length, `${e.file} :: ${e.anchor}`).toBeGreaterThan(40);
    }
    const stale = ALLOWLIST.filter((e) => !used.has(e)).map((e) => `${e.file} :: ${e.anchor}`);
    expect(stale, "stale allowlist entries — delete them").toEqual([]);
  });
});
