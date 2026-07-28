import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getSweepCandidates, parseVerdicts, applyVerdicts,
  cascadeOptionSectors, runSectorVerification,
} from "@/lib/securities/verify-sector-tags";

function seed(db: Database.Database) {
  const ins = db.prepare(
    `INSERT INTO securities (symbol, name, security_type, sector, fund_category, industry, underlying_symbol, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  ins.run("AMZN", "Amazon", "Stock", "Communication Services", "US Sector Equity (Consumer Discretionary)", "Internet", null, "t:amzn");
  ins.run("GOOG", "Alphabet", "Stock", "Communication Services", "US Sector Equity (Technology)", "Internet", null, "t:goog");
  ins.run("KO", "Coca-Cola", "Stock", "Consumer Staples", "US Sector Equity (Consumer Staples)", "Beverages", null, "t:ko");
  ins.run("SMH", "VanEck Semi ETF", "ETF", "Technology", null, "ETF / Semiconductors", null, "t:smh");
  ins.run("GOOGL 260117C00200000", "GOOGL call", "Option", "Communication Services", null, null, "GOOGL", "t:opt1");
  ins.run("KO 260117C00070000", "KO call", "Option", "Consumer Staples", null, null, "KO", "t:opt2");
}

describe("verify-sector-tags sweep", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); runMigrations(db); seed(db); });

  it("candidates = stocks only, garbage excluded, verified skipped by default", () => {
    db.prepare("INSERT INTO securities (symbol, security_type, source_key) VALUES ('2026-01-01 10:00:00', 'Stock', 't:garbage')").run();
    db.prepare("UPDATE securities SET sector_verified_at = datetime('now') WHERE symbol = 'KO'").run();
    const syms = getSweepCandidates(db).map((c) => c.symbol);
    expect(syms).toContain("AMZN");
    expect(syms).toContain("GOOG");
    expect(syms).not.toContain("KO");        // already verified
    expect(syms).not.toContain("SMH");       // ETF out of scope
    expect(syms).not.toContain("2026-01-01 10:00:00"); // garbage
    expect(getSweepCandidates(db, { all: true }).map((c) => c.symbol)).toContain("KO");
    expect(getSweepCandidates(db, { symbols: ["amzn"] }).map((c) => c.symbol)).toEqual(["AMZN"]);
  });

  it("parseVerdicts survives prose preamble + code fences", () => {
    const text = 'Here are my findings:\n```json\n[{"symbol":"AMZN","sector":"Consumer Discretionary","rationale":"GICS: internet retail"}]\n```';
    expect(parseVerdicts(text)).toEqual([
      { symbol: "AMZN", sector: "Consumer Discretionary", rationale: "GICS: internet retail" },
    ]);
  });

  it("applyVerdicts writes + stamps changed AND unchanged rows; Unknown/invalid never write", () => {
    const candidates = getSweepCandidates(db);
    const verdicts = [
      { symbol: "AMZN", sector: "Consumer Discretionary", rationale: "internet retail" },
      { symbol: "GOOG", sector: "Communication Services", rationale: "interactive media" },
    ];
    const { rows, unresolved } = applyVerdicts(db, candidates, verdicts, { apply: true });
    const amzn = db.prepare("SELECT sector, sector_source, sector_verified_at FROM securities WHERE symbol='AMZN'").get() as any;
    expect(amzn.sector).toBe("Consumer Discretionary");
    expect(amzn.sector_source).toBe("gics_verified");
    expect(amzn.sector_verified_at).not.toBeNull();
    const goog = db.prepare("SELECT sector, sector_verified_at FROM securities WHERE symbol='GOOG'").get() as any;
    expect(goog.sector).toBe("Communication Services"); // unchanged…
    expect(goog.sector_verified_at).not.toBeNull();     // …but still stamped
    expect(rows.find((r) => r.symbol === "AMZN")?.changed).toBe(true);
    expect(rows.find((r) => r.symbol === "GOOG")?.changed).toBe(false);
    // a candidate with no verdict lands in unresolved
    expect(unresolved.map((u) => u.symbol)).toContain("KO");
  });

  it("applyVerdicts dry-run reports but does not write", () => {
    const candidates = getSweepCandidates(db);
    applyVerdicts(db, candidates, [{ symbol: "AMZN", sector: "Consumer Discretionary", rationale: "x" }], { apply: false });
    const amzn = db.prepare("SELECT sector, sector_verified_at FROM securities WHERE symbol='AMZN'").get() as any;
    expect(amzn.sector).toBe("Communication Services");
    expect(amzn.sector_verified_at).toBeNull();
  });

  it("Unknown and non-GICS verdicts are unresolved, never written", () => {
    const candidates = getSweepCandidates(db);
    const { unresolved } = applyVerdicts(db, candidates, [
      { symbol: "AMZN", sector: "Unknown", rationale: "unsure" },
      { symbol: "GOOG", sector: "Cyber", rationale: "hallucinated" },
    ], { apply: true });
    expect(unresolved.map((u) => u.symbol)).toEqual(expect.arrayContaining(["AMZN", "GOOG"]));
    const amzn = db.prepare("SELECT sector_verified_at FROM securities WHERE symbol='AMZN'").get() as any;
    expect(amzn.sector_verified_at).toBeNull();
  });

  it("cascadeOptionSectors copies verified stock sectors onto options, issuerSiblings-aware", () => {
    db.prepare("UPDATE securities SET sector='Consumer Discretionary', sector_source='gics_verified', sector_verified_at=datetime('now') WHERE symbol='AMZN'").run();
    db.prepare("UPDATE securities SET sector_source='gics_verified', sector_verified_at=datetime('now') WHERE symbol IN ('GOOG','KO')").run();
    // GOOGL option's underlying "GOOGL" doesn't exist as a row — must resolve to GOOG via issuerSiblings
    const n = cascadeOptionSectors(db, { apply: true });
    expect(n).toBeGreaterThanOrEqual(1);
    const opt = db.prepare("SELECT sector, sector_verified_at FROM securities WHERE symbol='GOOGL 260117C00200000'").get() as any;
    expect(opt.sector).toBe("Communication Services");
    expect(opt.sector_verified_at).toBeNull(); // options are derived rows — never stamped
  });

  it("runSectorVerification wires it together with an injected fetcher", async () => {
    const result = await runSectorVerification(db, {
      apply: true,
      fetchVerdicts: async (batch) =>
        JSON.stringify(batch.map((c) => ({
          symbol: c.symbol,
          sector: c.symbol === "AMZN" ? "Consumer Discretionary" : c.sector ?? "Unknown",
          rationale: "test",
        }))),
    });
    expect(result.applied).toBe(true);
    expect(result.rows.find((r) => r.symbol === "AMZN")?.newSector).toBe("Consumer Discretionary");
  });
});

describe("parseVerdicts control-char defense (live-sweep 2026-07-28 failure)", () => {
  it("survives raw newlines inside string literals (frontier model emits them intermittently)", () => {
    const text =
      '[{"symbol":"UNH","sector":"Healthcare","rationale":"UnitedHealth is a managed\ncare company per GICS"}]';
    expect(parseVerdicts(text)).toEqual([
      { symbol: "UNH", sector: "Healthcare", rationale: "UnitedHealth is a managed care company per GICS" },
    ]);
  });

  it("still throws on genuinely malformed non-JSON", () => {
    expect(() => parseVerdicts("not json at all")).toThrow();
  });
});
