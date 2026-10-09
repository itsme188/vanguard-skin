/**
 * An option's stored expiration is never compared by hand, static guard.
 *
 * `securities.expiration_date` has two spellings: dashed `YYYY-MM-DD` and the
 * legacy compact `YYYYMMDD` (stored rows are not normalised). Compared as raw
 * text the compact form sorts after every dashed day of its year
 * (`'20261004' >= '2026-10-06'` is true), and SQLite's `date()` /
 * `julianday()` read it as NULL. Each hand comparison was its own bug: an
 * expired contract that stayed held, a live one missing from the expirations
 * list, a purge preview that listed nothing.
 *
 * The rule (CLAUDE.md, "Live options"): go through lib/compute/option-expiry.ts
 *   - SQL: `liveOptionExpirationSql`, `optionExpirationDashedSql`,
 *     `optionExpirationDaySql`
 *   - JS:  `isOptionLive`, `normalizeOptionExpiration`, `daysToExpiry`
 *
 * What the scan flags, per non-comment line in app/, lib/ and scripts/:
 *   1. `expiration_date` directly followed by `<`, `>`, `<=`, `>=` or BETWEEN;
 *   2. `expiration_date` directly on the right of such an operator;
 *   3. `date(` / `julianday(` / `strftime(` applied straight to it;
 *   4. the JS name `expirationDate` on either side of such an operator.
 * Equality, `IS NULL`, ORDER BY and assignments are not comparisons of order
 * and are not flagged. Migrations are out of scope (history, equality only).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const SCAN_EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const SKIP_DIR = "lib/db/migrations";

interface Allowed {
  file: string;
  /** Substring of the flagged line. */
  anchor: string;
  why: string;
}

const ALLOWED: Allowed[] = [
  {
    file: "scripts/verify-a1-current-prices.ts",
    anchor: "AND s.expiration_date BETWEEN '2026-04-27' AND '2026-05-03'",
    why: "One-off, read-only verification script for a past week with literal dates; prints rows for the operator.",
  },
  {
    file: "scripts/verify-a2-combined-positions.ts",
    anchor: "AND s.expiration_date BETWEEN '2026-04-27' AND '2026-05-03'",
    why: "One-off, read-only verification script for a past week with literal dates; prints rows for the operator.",
  },
];

const OP = String.raw`(?:[<>]=?|(?:NOT\s+)?BETWEEN\b)`;
const RAW_LEFT = new RegExp(String.raw`\bexpiration_date\s*${OP}`, "i");
const RAW_RIGHT = /(?<![=<>-])[<>]=?\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?expiration_date\b/;
// Case-sensitive: SQL `date(`, never JavaScript `new Date(`.
const RAW_FN =
  /(?<![\w.])(?:date|DATE|julianday|JULIANDAY|strftime|STRFTIME)\(\s*(?:'[^']*'\s*,\s*)?(?:[A-Za-z_][A-Za-z0-9_]*\.)?expiration_date\b/;
const JS_LEFT = /\bexpirationDate\s*[<>]=?(?![<>=])/;
const JS_RIGHT = /(?<![=<>-])[<>]=?\s*expirationDate\b/;

function flagged(code: string): boolean {
  return (
    RAW_LEFT.test(code) || RAW_RIGHT.test(code) || RAW_FN.test(code) || JS_LEFT.test(code) || JS_RIGHT.test(code)
  );
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--");
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (SCAN_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const dir of SCAN_DIRS) {
    for (const full of listFiles(path.join(REPO_ROOT, dir))) {
      const file = path.relative(REPO_ROOT, full).split(path.sep).join("/");
      if (file.startsWith(SKIP_DIR + "/")) continue;
      fs.readFileSync(full, "utf8")
        .split("\n")
        .forEach((text, i) => {
          if (isCommentLine(text)) return;
          const code = text.replace(/\s\/\/\s.*$/, "");
          if (flagged(code)) hits.push({ file, line: i + 1, text: code.trim() });
        });
    }
  }
  return hits;
}

const HITS = scan();
const matches = (h: Hit, a: Allowed) => h.file === a.file && h.text.includes(a.anchor);

describe("an option expiration is never compared by hand", () => {
  it("the scanner sees the forms it is meant to see", () => {
    expect(flagged("AND s.expiration_date >= ?")).toBe(true);
    expect(flagged("AND expiration_date < date(?, ?)")).toBe(true);
    expect(flagged("AND s.expiration_date BETWEEN ? AND ?")).toBe(true);
    expect(flagged("AND ? <= s.expiration_date")).toBe(true);
    expect(flagged("AND date(s.expiration_date) < date(?, '-1 day')")).toBe(true);
    expect(flagged("CAST(julianday(s.expiration_date) - julianday(?) AS INTEGER)")).toBe(true);
    expect(flagged("strftime('%Y', expiration_date)")).toBe(true);
    expect(flagged("if (expirationDate < today) return true;")).toBe(true);
    expect(flagged("return today > expirationDate;")).toBe(true);
    expect(flagged("if (row.expiration_date >= today) keep.push(row);")).toBe(true);

    expect(flagged("AND s.expiration_date IS NOT NULL")).toBe(false);
    expect(flagged("ORDER BY s.expiration_date ASC, s.symbol ASC")).toBe(false);
    expect(flagged("expiration_date = COALESCE(excluded.expiration_date, securities.expiration_date),")).toBe(false);
    expect(flagged("AND occ.expiration_date = v.expiration_date")).toBe(false);
    expect(flagged("const fn = (expirationDate: string) => expirationDate.slice(0, 4);")).toBe(false);
    expect(flagged("rows.map((r) => r.expiration_date)")).toBe(false);
    expect(flagged("const d = new Date(row.expiration_date);")).toBe(false);
    expect(flagged("AND ${optionExpirationDaySql(\"s.expiration_date\")} < date(?, '-1 day')")).toBe(false);
    expect(flagged("return normalizeOptionExpiration(expirationDate) >= today;")).toBe(false);
  });

  it("every hand comparison is a reviewed, listed site", () => {
    const unlisted = HITS.filter((h) => !ALLOWED.some((a) => matches(h, a))).map(
      (h) => `${h.file}:${h.line} ${h.text}`,
    );
    expect(
      unlisted,
      "An option expiration is compared by hand. The stored value may be the legacy compact " +
        "YYYYMMDD form. Use liveOptionExpirationSql / optionExpirationDashedSql / " +
        "optionExpirationDaySql in SQL, or isOptionLive / normalizeOptionExpiration in JS " +
        "(lib/compute/option-expiry.ts).",
    ).toEqual([]);
  });

  it("no listed entry is stale, and every entry says why", () => {
    for (const entry of ALLOWED) {
      expect(
        HITS.filter((h) => matches(h, entry)).length,
        `${entry.file}: "${entry.anchor}" is listed but not found exactly once`,
      ).toBe(1);
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });
});
