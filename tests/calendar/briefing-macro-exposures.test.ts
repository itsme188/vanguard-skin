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
  it("includes XMTR under ISM Manufacturing — the user-reported bug", () => {
    // The original bug: §6 ISM Mfg listed XPO, NSC, CSX, PRIM, PWR, CLH,
    // GFL — "basically every industrial in the book" — but silently
    // dropped XMTR (sector="Industrials", industry="Metal Fabricate/Hardware").
    const xpo = seedSec("XPO", "Industrials", "Transportation");
    const xmtr = seedSec("XMTR", "Industrials", "Metal Fabricate/Hardware");
    const csx = seedSec("CSX", "Industrials", "Transportation");
    seedHolding(xpo, 60);
    seedHolding(xmtr, 600);
    seedHolding(csx, 50);

    // Add a non-industrial holding to verify it's filtered out
    const aapl = seedSec("AAPL", "Technology", "Computers");
    seedHolding(aapl, 100);

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "April ISM Manufacturing")]);
    const exp = out.get(1);

    expect(exp).toBeDefined();
    expect(exp!.symbols).toContain("XMTR");
    expect(exp!.symbols).toContain("XPO");
    expect(exp!.symbols).toContain("CSX");
    expect(exp!.symbols).not.toContain("AAPL");
    expect(exp!.basis).toMatch(/Industrials/);
  });

  it("differentiates ISM Services from ISM Manufacturing", () => {
    const xmtr = seedSec("XMTR", "Industrials");
    const ko = seedSec("KO", "Consumer Staples", "Beverages");
    seedHolding(xmtr, 600);
    seedHolding(ko, 100);

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "April ISM Services")]);
    const exp = out.get(1);
    expect(exp!.symbols).toContain("KO");
    expect(exp!.symbols).not.toContain("XMTR");
  });

  it("FOMC maps to Financials + Real Estate sectors", () => {
    const krc = seedSec("KRC", "Real Estate", "REITS");
    const bac = seedSec("BAC", "Financials", "Banks");
    const aapl = seedSec("AAPL", "Technology");
    seedHolding(krc, 161);
    seedHolding(bac, 100);
    seedHolding(aapl, 100);

    const out = buildMacroExposures(db, [makeMacro(1, "fomc", "FOMC Rate Decision")]);
    const exp = out.get(1);
    expect(exp!.symbols).toContain("KRC");
    expect(exp!.symbols).toContain("BAC");
    expect(exp!.symbols).not.toContain("AAPL");
  });

  it("GDP returns broad equity (all sectors)", () => {
    const aapl = seedSec("AAPL", "Technology");
    const bac = seedSec("BAC", "Financials");
    const xmtr = seedSec("XMTR", "Industrials");
    seedHolding(aapl, 100);
    seedHolding(bac, 100);
    seedHolding(xmtr, 600);

    const out = buildMacroExposures(db, [makeMacro(1, "gdp", "Q1 Advance GDP")]);
    const exp = out.get(1);
    expect(exp!.symbols).toEqual(expect.arrayContaining(["AAPL", "BAC", "XMTR"]));
  });

  it("Consumer Confidence (other_macro) maps to Consumer sectors", () => {
    const ko = seedSec("KO", "Consumer Staples");
    const hd = seedSec("HD", "Consumer Discretionary", "Retail");
    const aapl = seedSec("AAPL", "Technology");
    seedHolding(ko, 100);
    seedHolding(hd, 50);
    seedHolding(aapl, 100);

    const out = buildMacroExposures(db, [
      makeMacro(1, "other_macro", "April Consumer Confidence"),
    ]);
    const exp = out.get(1);
    expect(exp!.symbols).toContain("KO");
    expect(exp!.symbols).toContain("HD");
    expect(exp!.symbols).not.toContain("AAPL");
  });

  it("returns no entry for unmapped event types (earnings, unknown other_macro)", () => {
    const xmtr = seedSec("XMTR", "Industrials");
    seedHolding(xmtr, 600);

    const earnings = {
      id: 1,
      source: "finnhub",
      event_type: "earnings" as const,
      event_date: "2026-05-01",
      title: "Some earnings",
      symbol: "XMTR",
      source_key: "finnhub:XMTR:2026-05-01",
    } as CalendarEvent;
    const unknownMacro = makeMacro(2, "other_macro", "Something obscure");

    const out = buildMacroExposures(db, [earnings, unknownMacro]);
    expect(out.has(1)).toBe(false);
    expect(out.has(2)).toBe(false);
  });

  it("excludes positions with zero quantity from exposure lists", () => {
    const xmtr = seedSec("XMTR", "Industrials");
    seedHolding(xmtr, 0);

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "ISM Manufacturing")]);
    expect(out.has(1)).toBe(false);
  });

  it("only the latest as_of_date per account counts (no double-count)", () => {
    const xmtr = seedSec("XMTR", "Industrials");
    seedHolding(xmtr, 600, "2026-04-20");
    seedHolding(xmtr, 600, "2026-04-27");

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "ISM Manufacturing")]);
    const exp = out.get(1);
    expect(exp!.symbols).toEqual(["XMTR"]);
  });
});

describe("§6 prompt directive — exposure-list verbatim rule", () => {
  // Regression: 4/27 live regen showed Opus dropping XMTR+PRIM+CLH+GFL from
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
