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
    // dropped XMTR (sector="Industrial", industry="Metal Fabricate/Hardware").
    const xpo = seedSec("XPO", "Industrial", "Transportation");
    const xmtr = seedSec("XMTR", "Industrial", "Metal Fabricate/Hardware");
    const csx = seedSec("CSX", "Industrial", "Transportation");
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
    expect(exp!.basis).toMatch(/Industrial/);
  });

  it("differentiates ISM Services from ISM Manufacturing", () => {
    const xmtr = seedSec("XMTR", "Industrial");
    const ko = seedSec("KO", "Consumer, Non-cyclical", "Beverages");
    seedHolding(xmtr, 600);
    seedHolding(ko, 100);

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "April ISM Services")]);
    const exp = out.get(1);
    expect(exp!.symbols).toContain("KO");
    expect(exp!.symbols).not.toContain("XMTR");
  });

  it("FOMC maps to Financial sector", () => {
    const krc = seedSec("KRC", "Financial", "REITS");
    const bac = seedSec("BAC", "Financial", "Banks");
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
    const bac = seedSec("BAC", "Financial");
    const xmtr = seedSec("XMTR", "Industrial");
    seedHolding(aapl, 100);
    seedHolding(bac, 100);
    seedHolding(xmtr, 600);

    const out = buildMacroExposures(db, [makeMacro(1, "gdp", "Q1 Advance GDP")]);
    const exp = out.get(1);
    expect(exp!.symbols).toEqual(expect.arrayContaining(["AAPL", "BAC", "XMTR"]));
  });

  it("Consumer Confidence (other_macro) maps to Consumer sectors", () => {
    const ko = seedSec("KO", "Consumer, Non-cyclical");
    const hd = seedSec("HD", "Consumer, Cyclical", "Retail");
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
    const xmtr = seedSec("XMTR", "Industrial");
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
    const xmtr = seedSec("XMTR", "Industrial");
    seedHolding(xmtr, 0);

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "ISM Manufacturing")]);
    expect(out.has(1)).toBe(false);
  });

  it("only the latest as_of_date per account counts (no double-count)", () => {
    const xmtr = seedSec("XMTR", "Industrial");
    seedHolding(xmtr, 600, "2026-04-20");
    seedHolding(xmtr, 600, "2026-04-27");

    const out = buildMacroExposures(db, [makeMacro(1, "pmi", "ISM Manufacturing")]);
    const exp = out.get(1);
    expect(exp!.symbols).toEqual(["XMTR"]);
  });
});

describe("§6 prompt directive — exposure-list verbatim rule", () => {
  // Regression: 4/27 live regen of the briefing showed Opus still dropping
  // XMTR + PRIM + CLH + GFL from the ISM Manufacturing exposure paragraph,
  // even though all four were in the deterministic Holdings exposure field
  // fed to the prompt. The original directive ("Use this list verbatim — do
  // NOT enumerate exposure from prose, do NOT add or drop names") wasn't
  // strong enough. Strengthened 2026-04-27 with imperative HARD RULE
  // language that explicitly forbids ETF additions, prose hand-waves, and
  // memory-driven substitutions. This test guards against a future edit
  // that softens the directive.
  it("contains the strengthened HARD RULE directive in briefing.ts", () => {
    const briefingSource = readFileSync(
      join(process.cwd(), "lib/calendar/briefing.ts"),
      "utf8",
    );
    expect(briefingSource).toContain("HARD RULE");
    expect(briefingSource).toContain("exposure lists are data, not narrative");
    expect(briefingSource).toContain("MUST equal the symbols in the Holdings exposure field");
    expect(briefingSource).toContain("trust the data over your memory");
  });
});
