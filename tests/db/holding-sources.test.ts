import { describe, it, expect } from "vitest";
import {
  STATEMENT_HOLDING_SOURCE_PREFIXES,
  LIVE_HOLDING_SOURCE_PREFIXES,
  statementSourcedHoldingSql,
  isPlaidSourcedHolding,
} from "@/lib/db/holding-sources";

describe("holdings source_key provenance vocabulary", () => {
  it("enumerates every statement-authority prefix a parser can write", () => {
    // Mirrors the prose enumeration at lib/import/engine.ts:431-436. If a new
    // importer is added, its holdings prefix belongs here — otherwise every
    // statement-authority consumer silently stops seeing its rows.
    expect([...STATEMENT_HOLDING_SOURCE_PREFIXES].sort()).toEqual(
      [
        "canonical:hold:",
        "ibkr:holding:",
        "ibkr:pos:",
        "vanguard-export:holding:",
        "vanguard-pdf:holding:",
        "vanguard:holding:",
      ].sort()
    );
  });

  it("enumerates the live (non-statement) prefixes", () => {
    expect([...LIVE_HOLDING_SOURCE_PREFIXES]).toEqual(["tws-", "plaid:"]);
  });

  it("keeps statement and live prefixes disjoint", () => {
    for (const live of LIVE_HOLDING_SOURCE_PREFIXES) {
      for (const stmt of STATEMENT_HOLDING_SOURCE_PREFIXES) {
        expect(live.startsWith(stmt)).toBe(false);
        expect(stmt.startsWith(live)).toBe(false);
      }
    }
  });

  it("contains no SQL LIKE wildcards in any prefix", () => {
    // The prefixes are interpolated straight into LIKE patterns. A '%' or '_'
    // would silently widen the match (e.g. 'ibkr_pos:' matching 'ibkrXpos:').
    for (const p of [...STATEMENT_HOLDING_SOURCE_PREFIXES, ...LIVE_HOLDING_SOURCE_PREFIXES]) {
      expect(p).not.toMatch(/[%_]/);
      expect(p).not.toContain("'");
    }
  });

  it("builds an OR-ed LIKE predicate over every statement prefix", () => {
    const sql = statementSourcedHoldingSql("h.source_key");
    for (const p of STATEMENT_HOLDING_SOURCE_PREFIXES) {
      expect(sql).toContain(`h.source_key LIKE '${p}%'`);
    }
    // Parenthesized so it can be AND-ed into a larger WHERE without the OR
    // swallowing sibling conditions.
    expect(sql.startsWith("(")).toBe(true);
    expect(sql.endsWith(")")).toBe(true);
  });

  it("supports aliasing the column", () => {
    expect(statementSourcedHoldingSql("h2.source_key")).toContain("h2.source_key LIKE");
    expect(statementSourcedHoldingSql("h2.source_key")).not.toContain("h.source_key LIKE");
  });

  it("detects Plaid-sourced rows and nothing else", () => {
    expect(isPlaidSourcedHolding("plaid:1:2:2026-08-03")).toBe(true);
    expect(isPlaidSourcedHolding("tws-1-2-2026-08-03")).toBe(false);
    expect(isPlaidSourcedHolding("canonical:hold:TAX:AAPL:2026-07-31")).toBe(false);
    expect(isPlaidSourcedHolding(null)).toBe(false);
  });
});
