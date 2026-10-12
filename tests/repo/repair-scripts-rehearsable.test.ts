/**
 * A repair script must be rehearsable on a copy (lesson 2026-10-12).
 *
 * `scripts/repair-etf-types.ts` hardcoded `data/vanguard.db`, so an `--apply`
 * meant for a rehearsal copy wrote to the live database: the environment
 * override the operator set was simply never read.
 *
 * Every `scripts/repair-*.ts` must take its database from `REPAIR_DB_PATH` or a
 * `--db` flag. The scripts listed in LEGACY_LIVE_ONLY predate the rule and
 * open the live database whatever the environment says: READ THE SCRIPT before
 * rehearsing one, and move it off the list when it is next touched. Do not add
 * a new name to the list.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SCRIPTS_DIR = path.join(process.cwd(), "scripts");

const LEGACY_LIVE_ONLY = new Set<string>([
  "repair-acats-opening-lots.ts",
  "repair-ah-closes.ts",
  "repair-ambiguous-donation-links.ts",
  "repair-buy-sign-post-april.ts",
  "repair-canonical-option-prices.ts",
  "repair-confirmed-donation-leg-amounts.ts",
  "repair-desk-note-refusals.ts",
  "repair-goog-presplit-basis.ts",
  "repair-ibkr-option-trades.ts",
  "repair-inkind-transfer-fmv.ts",
  "repair-key-themes.ts",
  "repair-macro-actual-scale.ts",
  "repair-mismatched-source-urls.ts",
  "repair-missing-external-flows.ts",
  "repair-option-roundtrip-dollars.ts",
  "repair-smh-presplit-basis.ts",
  "repair-source-url-tokens.ts",
  "repair-split-prices.ts",
  "repair-third-person-voice.ts",
  "repair-xml-summaries.ts",
]);

function repairScripts(): string[] {
  return readdirSync(SCRIPTS_DIR).filter((n) => /^repair-.*\.ts$/.test(n)).sort();
}

function takesDatabaseOverride(src: string): boolean {
  return src.includes("REPAIR_DB_PATH") || src.includes('"--db"');
}

describe("repair scripts can be pointed at a rehearsal copy", () => {
  it("finds the repair scripts", () => {
    expect(repairScripts().length).toBeGreaterThan(10);
  });

  it("every repair script outside the legacy list reads REPAIR_DB_PATH or --db", () => {
    const offenders = repairScripts().filter(
      (name) =>
        !LEGACY_LIVE_ONLY.has(name) &&
        !takesDatabaseOverride(readFileSync(path.join(SCRIPTS_DIR, name), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("the legacy list names only scripts that still exist and still lack the override", () => {
    const stale = [...LEGACY_LIVE_ONLY].filter((name) => {
      try {
        return takesDatabaseOverride(readFileSync(path.join(SCRIPTS_DIR, name), "utf8"));
      } catch {
        return true;
      }
    });
    expect(stale).toEqual([]);
  });

  it("the ETF type repair prints its database path before it opens it", () => {
    const src = readFileSync(path.join(SCRIPTS_DIR, "repair-etf-types.ts"), "utf8");
    const printed = src.indexOf("], db: ${DB_PATH}`");
    const opened = src.indexOf("new Database(DB_PATH)");
    expect(printed).toBeGreaterThan(-1);
    expect(opened).toBeGreaterThan(printed);
  });
});
