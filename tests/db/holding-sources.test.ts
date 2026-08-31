import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  STATEMENT_HOLDING_SOURCE_PREFIXES,
  LIVE_HOLDING_SOURCE_PREFIXES,
  statementSourcedHoldingSql,
  isPlaidSourcedHolding,
  RECON_HOLDING_SOURCE_PREFIX,
  RECON_STMT_SUFFIX,
  RECON_LIVE_SUFFIX,
  statementOverwritableHoldingSql,
  liveOverwritableHoldingSql,
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

describe("recon tombstone constants", () => {
  it("prefix and suffixes contain no LIKE wildcards or quotes", () => {
    for (const s of [RECON_HOLDING_SOURCE_PREFIX, RECON_STMT_SUFFIX, RECON_LIVE_SUFFIX]) {
      expect(s).not.toMatch(/[%_'"]/);
    }
    expect(RECON_HOLDING_SOURCE_PREFIX).toBe("recon:closed-equity:");
  });
});

describe("overwritable holding SQL", () => {
  // Behavioral pin via a real SQLite round-trip, not string equality.
  function matches(sql: string, sourceKey: string): boolean {
    const db = new Database(":memory:");
    try {
      return (
        db.prepare(`SELECT 1 AS hit WHERE ${sql.replace(/holdings\.source_key/g, "?")}`)
          // every occurrence binds the same value
          .get(...Array(sql.split("holdings.source_key").length - 1).fill(sourceKey)) != null
      );
    } finally {
      db.close();
    }
  }
  const stmtSql = statementOverwritableHoldingSql();
  const liveSql = liveOverwritableHoldingSql();

  it("statement writers may overwrite live rows and ANY tombstone", () => {
    for (const k of ["tws-1-2-2026-08-01", "plaid:1:2:2026-08-01",
      "recon:closed-equity:1:2:2026-08-01:stmt", "recon:closed-equity:1:2:2026-08-01:live",
      "recon:closed-equity:1:2:2026-08-01"]) {
      expect(matches(stmtSql, k)).toBe(true);
    }
    expect(matches(stmtSql, "canonical:hold:x")).toBe(false);
    expect(matches(stmtSql, "vanguard-pdf:holding:x")).toBe(false);
  });

  it("live writers may overwrite live rows and ONLY :live tombstones", () => {
    expect(matches(liveSql, "tws-1-2-2026-08-01")).toBe(true);
    expect(matches(liveSql, "plaid:1:2:2026-08-01")).toBe(true);
    expect(matches(liveSql, "recon:closed-equity:1:2:2026-08-01:live")).toBe(true);
    expect(matches(liveSql, "recon:closed-equity:1:2:2026-08-01:stmt")).toBe(false);
    // legacy unsuffixed = statement-grade (conservative)
    expect(matches(liveSql, "recon:closed-equity:1:2:2026-08-01")).toBe(false);
    expect(matches(liveSql, "canonical:hold:x")).toBe(false);
  });
});
