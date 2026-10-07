import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildMacroExposures } from "@/lib/calendar/briefing";
import type { CalendarEvent } from "@/lib/types";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSec(
  symbol: string,
  sector: string | null,
  industry: string | null = null,
  type = "stock",
): number {
  const r = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, sector, industry) VALUES (?, ?, ?, 'equity', 1, ?, ?)",
    )
    .run(symbol, `${symbol} Corp`, type, sector, industry);
  return r.lastInsertRowid as number;
}

function seedHolding(
  secId: number,
  qty: number,
  asOfDate = "2026-04-27",
): void {
  db.prepare(
    "INSERT INTO holdings (security_id, account_id, quantity, as_of_date) VALUES (?, 1, ?, ?)",
  ).run(secId, qty, asOfDate);
}

function makeMacro(
  id: number,
  type: string,
  title: string,
): CalendarEvent {
  return {
    id,
    source: "claude_macro",
    event_type: type as any,
    event_date: "2026-05-01",
    title,
    source_key: `claude_macro:${type}:2026-05-01`,
  } as CalendarEvent;
}

describe("buildMacroExposures", () => {
  it("includes ZZIND under ISM Manufacturing — the user-reported bug", () => {
    // The original bug: §6 ISM Mfg listed every other industrial in the
    // book ("basically every industrial in the book") but silently
    // dropped ZZIND (sector="Industrials", industry="Metal Fabricate/Hardware").
    const ztrn = seedSec("ZZTRN", "Industrials", "Transportation");
    const xmtr = seedSec("ZZIND", "Industrials", "Metal Fabricate/Hardware");
    const csx = seedSec("ZZRAIL", "Industrials", "Transportation");
    seedHolding(ztrn, 30);
    seedHolding(xmtr, 20);
    seedHolding(csx, 10);

    // Add a non-industrial holding to verify it's filtered out
    const aapl = seedSec("ZZTECH", "Technology", "Computers");
    seedHolding(aapl, 40);

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "April ISM Manufacturing")]);
    const exp = out.get(1);

    expect(exp).toBeDefined();
    expect(exp!.symbols).toContain("ZZIND");
    expect(exp!.symbols).toContain("ZZTRN");
    expect(exp!.symbols).toContain("ZZRAIL");
    expect(exp!.symbols).not.toContain("ZZTECH");
    expect(exp!.basis).toMatch(/Industrials/);
  });

  it("differentiates ISM Services from ISM Manufacturing", () => {
    const xmtr = seedSec("ZZIND", "Industrials");
    const ko = seedSec("ZZSTP", "Consumer Staples", "Beverages");
    seedHolding(xmtr, 20);
    seedHolding(ko, 20);

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "April ISM Services")]);
    const exp = out.get(1);
    expect(exp!.symbols).toContain("ZZSTP");
    expect(exp!.symbols).not.toContain("ZZIND");
  });

  it("FOMC maps to Financials + Real Estate sectors", () => {
    const krc = seedSec("ZZREIT", "Real Estate", "REITS");
    const bac = seedSec("ZZBANK", "Financials", "Banks");
    const aapl = seedSec("ZZTECH", "Technology");
    seedHolding(krc, 30);
    seedHolding(bac, 20);
    seedHolding(aapl, 40);

    const out = buildMacroExposures(db, [makeMacro(1, "fomc", "FOMC Rate Decision")]);
    const exp = out.get(1);
    expect(exp!.symbols).toContain("ZZREIT");
    expect(exp!.symbols).toContain("ZZBANK");
    expect(exp!.symbols).not.toContain("ZZTECH");
  });

  it("GDP returns broad equity (all sectors)", () => {
    const aapl = seedSec("ZZTECH", "Technology");
    const bac = seedSec("ZZBANK", "Financials");
    const xmtr = seedSec("ZZIND", "Industrials");
    seedHolding(aapl, 40);
    seedHolding(bac, 20);
    seedHolding(xmtr, 20);

    const out = buildMacroExposures(db, [makeMacro(1, "gdp", "Q1 Advance GDP")]);
    const exp = out.get(1);
    expect(exp!.symbols).toEqual(expect.arrayContaining(["ZZTECH", "ZZBANK", "ZZIND"]));
  });

  it("Consumer Confidence (other_macro) maps to Consumer sectors", () => {
    const ko = seedSec("ZZSTP", "Consumer Staples");
    const hd = seedSec("ZZRET", "Consumer Discretionary", "Retail");
    const aapl = seedSec("ZZTECH", "Technology");
    seedHolding(ko, 20);
    seedHolding(hd, 30);
    seedHolding(aapl, 40);

    const out = buildMacroExposures(db, [
      makeMacro(1, "other_macro", "April Consumer Confidence"),
    ]);
    const exp = out.get(1);
    expect(exp!.symbols).toContain("ZZSTP");
    expect(exp!.symbols).toContain("ZZRET");
    expect(exp!.symbols).not.toContain("ZZTECH");
  });

  it("returns no entry for unmapped event types (earnings, unknown other_macro)", () => {
    const xmtr = seedSec("ZZIND", "Industrials");
    seedHolding(xmtr, 20);

    const earnings = {
      id: 1,
      source: "finnhub",
      event_type: "earnings" as const,
      event_date: "2026-05-01",
      title: "Some earnings",
      symbol: "ZZIND",
      source_key: "finnhub:ZZIND:2026-05-01",
    } as CalendarEvent;
    const unknownMacro = makeMacro(2, "other_macro", "Something obscure");

    const out = buildMacroExposures(db, [earnings, unknownMacro]);
    expect(out.has(1)).toBe(false);
    expect(out.has(2)).toBe(false);
  });

  it("excludes positions with zero quantity from exposure lists", () => {
    const xmtr = seedSec("ZZIND", "Industrials");
    seedHolding(xmtr, 0);

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "ISM Manufacturing")]);
    expect(out.has(1)).toBe(false);
  });

  it("only the latest as_of_date per account counts (no double-count)", () => {
    const xmtr = seedSec("ZZIND", "Industrials");
    seedHolding(xmtr, 20, "2026-04-20");
    seedHolding(xmtr, 20, "2026-04-27");

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "ISM Manufacturing")]);
    const exp = out.get(1);
    expect(exp!.symbols).toEqual(["ZZIND"]);
  });

  // ── per-(account, security) "latest" keying ──────────────────────
  //
  // The sector-cluster query keyed "latest" off a per-ACCOUNT
  // MAX(as_of_date), which is the same silent-omission class the ZZIND bug
  // above is about: a name whose newest row is an older monthly-statement
  // date lost to a same-account daily row for another security and dropped
  // out of the §6 exposure list entirely.

  it("keeps a statement-lag sector name when a newer row exists for another security in the same account", () => {
    const xmtr = seedSec("ZZIND", "Industrials");
    seedHolding(xmtr, 20, "2026-03-31"); // monthly statement row
    const csx = seedSec("ZZRAIL", "Industrials");
    seedHolding(csx, 10, "2026-04-27"); // newer daily row, same account

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "ISM Manufacturing")]);
    const exp = out.get(1);
    expect(exp).toBeDefined();
    expect(exp!.symbols).toContain("ZZIND");
    expect(exp!.symbols).toContain("ZZRAIL");
  });

  it("hides a sector name whose latest row is a quantity=0 tombstone", () => {
    const xmtr = seedSec("ZZIND", "Industrials");
    seedHolding(xmtr, 20, "2026-03-31");
    seedHolding(xmtr, 0, "2026-04-27"); // closed-position tombstone
    const csx = seedSec("ZZRAIL", "Industrials");
    seedHolding(csx, 10, "2026-04-27");

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "ISM Manufacturing")]);
    const exp = out.get(1);
    expect(exp!.symbols).toEqual(["ZZRAIL"]);
  });

  it("still excludes shorts from sector exposure (long-only rule preserved)", () => {
    // The sector cluster narrates positive exposure; an anti-correlated
    // short must not read as a same-direction sector bet. The rule now lives
    // in latestHoldingsPredicate({ includeShorts: false }).
    const xmtr = seedSec("ZZIND", "Industrials");
    seedHolding(xmtr, -30, "2026-03-31"); // short, statement-date row
    const csx = seedSec("ZZRAIL", "Industrials");
    seedHolding(csx, 10, "2026-04-27");

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "ISM Manufacturing")]);
    const exp = out.get(1);
    expect(exp!.symbols).toEqual(["ZZRAIL"]);
  });
});

describe("§6 prompt directive — exposure-list verbatim rule", () => {
  // Regression: 4/27 live regen showed Opus dropping ZZIND and three other names from
  // ISM Manufacturing despite the f02517c HARD RULE directive. 5/03 escalated
  // to TS-rendered "REQUIRED §6 cluster" pasted verbatim — directive now
  // points to that field. This test guards against a future edit that softens
  // the directive or removes the deterministic-cluster injection.
  it("contains the verbatim-cluster directive + non-lumping rule + paste-this-line cluster injection", () => {
    const briefingSource = readFileSync(
      join(process.cwd(), "lib/calendar/briefing.ts"),
      "utf8",
    );
    // Directive language
    expect(briefingSource).toContain("HARD RULES for §6");
    expect(briefingSource).toContain("Verbatim cluster");
    expect(briefingSource).toContain("No multi-event lumping");
    expect(briefingSource).toContain("Trust the data over your memory");
    // Per-event deterministic cluster injection
    expect(briefingSource).toContain("REQUIRED §6 cluster");
    expect(briefingSource).toContain("paste this exact line");
  });
});
