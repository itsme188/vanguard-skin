import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * QA security-detail-transactions--raw-occ-fallback-beside-formatted-option-rows.
 *
 * OptionLabel rendered the raw stored OCC string ("AMZN  260306P00190000")
 * whenever option_type / strike_price / expiration_date were all NULL — which
 * is the case for ~95 unenriched option securities — so one column mixed two
 * spellings. The fallback belongs in resolveOptionFields (unit-tested in
 * tests/lib/format.test.ts); this pins that the render path actually uses it,
 * since the repo has no React render harness (see the precedent note in
 * tests/dashboard/data-confidence-indicator-privacy.test.ts).
 */

const COMPONENT_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/TransactionsSection.tsx",
);

describe("TransactionsSection OptionLabel falls back to parsing the symbol", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");

  it("imports resolveOptionFields from the format module", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*resolveOptionFields[^}]*\}\s*from\s*["']@\/lib\/format["']/,
    );
  });

  it("derives the rendered fields through it instead of reading the columns raw", () => {
    const start = source.indexOf("function OptionLabel(");
    expect(start, "OptionLabel not found").toBeGreaterThan(-1);
    const body = source.slice(start);
    expect(body).toMatch(/resolveOptionFields\(/);
    expect(body).toMatch(/txn\.option_type/);
    expect(body).toMatch(/txn\.strike_price/);
    expect(body).toMatch(/txn\.expiration_date/);
  });
});
