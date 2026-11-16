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

/**
 * Older scripts that read the override but still FALL BACK to
 * `data/vanguard.db` when neither is given (review 2026-11-15, R7: run from
 * the main checkout, that fallback is the live database). Frozen: a NEW
 * repair script must refuse when no database is named, as
 * repair-roth-december-snapshots.ts and repair-gift-month-returns.ts do
 * ("No database named. Pass --db <path> or set REPAIR_DB_PATH (there is no
 * default)"). Do not add a name; remove one when its default is removed.
 */
const LEGACY_DEFAULT_PATH = new Set<string>([
  "repair-account-tax-treatment.ts",
  "repair-alert-suggestions.ts",
  "repair-closed-day-tws-rows.ts",
  "repair-donated-lot-basis.ts",
  "repair-duplicate-option-securities.ts",
  "repair-duplicate-research-documents.ts",
  "repair-empty-bogeys.ts",
  "repair-empty-enrichments.ts",
  "repair-etf-types.ts",
  "repair-fred-revision-second-date-rows.ts",
  "repair-fund-growth-value-style.ts",
  "repair-fx-rate.ts",
  "repair-ghost-securities.ts",
  "repair-inkind-transfer-lots.ts",
  "repair-manual-feed-earnings-pairs.ts",
  "repair-mistyped-option-legs.ts",
  "repair-option-attached-levels.ts",
  "repair-option-sectors.ts",
  "repair-premature-reaction-snapshots.ts",
  "repair-refetch-article-html.ts",
  "repair-requeue-failed-enrichment.ts",
  "repair-security-type-corruption.ts",
  "repair-stranded-earnings-suppressions.ts",
  "repair-transcript-sections.ts",
  "repair-zero-ohlcv-bars.ts",
]);

/** Source with comments removed, so a runbook line in a comment is not code. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * A string literal naming the live database as a path: `"data", "vanguard.db"`
 * as path.join arguments, or one literal ending in `data/vanguard.db`.
 */
function hasLiveDatabaseDefault(src: string): boolean {
  return /["'`]data["'`]\s*,\s*["'`]vanguard\.db["'`]|["'`][^"'`\n]*data\/vanguard\.db["'`]/.test(codeOnly(src));
}

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

  it("a repair script outside the frozen lists has no default path to the live database (R7)", () => {
    const offenders = repairScripts().filter(
      (name) =>
        !LEGACY_LIVE_ONLY.has(name) &&
        !LEGACY_DEFAULT_PATH.has(name) &&
        hasLiveDatabaseDefault(readFileSync(path.join(SCRIPTS_DIR, name), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("the default-path list names only scripts that still exist and still default", () => {
    const stale = [...LEGACY_DEFAULT_PATH].filter((name) => {
      try {
        return !hasLiveDatabaseDefault(readFileSync(path.join(SCRIPTS_DIR, name), "utf8"));
      } catch {
        return true;
      }
    });
    expect(stale).toEqual([]);
  });

  it("the detector catches both default forms and ignores a comment", () => {
    expect(hasLiveDatabaseDefault('const p = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");')).toBe(true);
    expect(hasLiveDatabaseDefault('const db = new Database("data/vanguard.db");')).toBe(true);
    expect(hasLiveDatabaseDefault(" * rehearse: sqlite3 data/vanguard.db \"VACUUM INTO '/tmp/x.db'\"\n")).toBe(false);
    expect(hasLiveDatabaseDefault('// default was "data/vanguard.db"\nconst p = process.env.REPAIR_DB_PATH;')).toBe(false);
  });

  it("the ETF type repair prints its database path before it opens it", () => {
    const src = readFileSync(path.join(SCRIPTS_DIR, "repair-etf-types.ts"), "utf8");
    const printed = src.indexOf("], db: ${DB_PATH}`");
    const opened = src.indexOf("new Database(DB_PATH)");
    expect(printed).toBeGreaterThan(-1);
    expect(opened).toBeGreaterThan(printed);
  });
});
