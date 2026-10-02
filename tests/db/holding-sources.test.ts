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
  statementGradeHoldingSql,
  liveOriginHoldingSql,
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

describe("statement-grade and live-origin holding SQL (statement-only synthetic closes, 2026-10-02)", () => {
  // Real SQLite round-trip over a holdings-shaped table: the predicates take a
  // ROW ALIAS because a legacy unsuffixed tombstone is statement-grade only
  // when the same account has a statement-prefix row on the same date.
  const DATE = "2026-08-31";
  function classify(rows: { key: string | null; account?: number; date?: string }[], probe: string) {
    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE holdings (id INTEGER PRIMARY KEY, account_id INTEGER, as_of_date TEXT, source_key TEXT)`);
      const ins = db.prepare(`INSERT INTO holdings (account_id, as_of_date, source_key) VALUES (?, ?, ?)`);
      for (const r of rows) ins.run(r.account ?? 1, r.date ?? DATE, r.key);
      const sg = db.prepare(`SELECT 1 FROM holdings h WHERE h.source_key IS ? AND ${statementGradeHoldingSql("h")}`).get(probe) != null;
      const lo = db.prepare(`SELECT 1 FROM holdings h WHERE h.source_key IS ? AND ${liveOriginHoldingSql("h")}`).get(probe) != null;
      return { sg, lo };
    } finally {
      db.close();
    }
  }
  const one = (key: string) => classify([{ key }], key);

  it("every statement prefix and every :stmt tombstone is statement-grade, never live-origin", () => {
    for (const p of STATEMENT_HOLDING_SOURCE_PREFIXES) expect(one(`${p}x`)).toEqual({ sg: true, lo: false });
    expect(one("recon:closed-equity:1:2:2026-08-31:stmt")).toEqual({ sg: true, lo: false });
  });

  it("live rows and :live tombstones are live-origin, never statement-grade", () => {
    for (const k of ["tws-1-2-2026-08-31", "plaid:1:2:2026-08-31", "recon:closed-equity:1:2:2026-08-31:live"]) {
      expect(one(k)).toEqual({ sg: false, lo: true });
    }
  });

  it("a legacy unsuffixed tombstone on a date the account has a statement row is statement-grade", () => {
    const legacy = "recon:closed-equity:1:2:2026-08-31";
    expect(classify([{ key: legacy }, { key: "canonical:hold:k" }], legacy)).toEqual({ sg: true, lo: false });
  });

  it("a legacy unsuffixed tombstone on a live-only date is live-origin (minted by the old live pass)", () => {
    const legacy = "recon:closed-equity:1:2:2026-08-31";
    expect(classify([{ key: legacy }, { key: "tws-1-3-2026-08-31" }], legacy)).toEqual({ sg: false, lo: true });
    // A statement row for ANOTHER account or ANOTHER date does not justify it.
    expect(classify([{ key: legacy }, { key: "canonical:hold:k", account: 2 }], legacy)).toEqual({ sg: false, lo: true });
    expect(classify([{ key: legacy }, { key: "canonical:hold:k", date: "2026-08-30" }], legacy)).toEqual({
      sg: false,
      lo: true,
    });
  });

  it("demo seeds, unknown prefixes and NULL keys are neither", () => {
    for (const k of ["demo-hold-1", "test-hold-1-2-2026-08-31"]) expect(one(k)).toEqual({ sg: false, lo: false });
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE holdings (id INTEGER PRIMARY KEY, account_id INTEGER, as_of_date TEXT, source_key TEXT)`);
    db.prepare(`INSERT INTO holdings (account_id, as_of_date, source_key) VALUES (1, ?, NULL)`).run(DATE);
    // NULL-safe: NOT (predicate) must be TRUE for a NULL key, never NULL.
    expect(db.prepare(`SELECT 1 FROM holdings h WHERE NOT ${statementGradeHoldingSql("h")}`).get()).toBeDefined();
    expect(db.prepare(`SELECT 1 FROM holdings h WHERE NOT ${liveOriginHoldingSql("h")}`).get()).toBeDefined();
    db.close();
  });

  it("stays DISTINCT from statementSourcedHoldingSql, which never matches a tombstone", () => {
    const sourced = statementSourcedHoldingSql("h.source_key");
    expect(sourced).not.toContain("recon:");
    expect(statementGradeHoldingSql("h")).toContain("recon:closed-equity:");
  });

  it("is parenthesized and honours the alias", () => {
    for (const sql of [statementGradeHoldingSql("x"), liveOriginHoldingSql("x")]) {
      expect(sql.startsWith("(")).toBe(true);
      expect(sql.endsWith(")")).toBe(true);
      expect(sql).toContain("x.source_key");
      expect(sql).not.toContain("h.source_key");
    }
  });
});
