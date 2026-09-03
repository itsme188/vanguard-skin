import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { findEmailCandidates } from "@/lib/calendar/enrichment-runner";

// Seed helper: columns match the actual schema (accounts has no
// account_type/institution columns; securities/holdings columns per
// lib/db/migrations/001_initial_schema.sql + 004_add_options_support.sql —
// see tests/queries/earnings-hub.test.ts for the same pattern).
function seed(db: Database.Database): number {
  const acct = db.prepare(`INSERT INTO accounts (name) VALUES ('et-day-test')`).run();
  const sec = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('BETA','Beta Corp','stock','equity',1)`,
    )
    .run();
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?,?,10,'2026-09-01')`,
  ).run(acct.lastInsertRowid, sec.lastInsertRowid);
  const ev = db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, source_key, symbol)
       VALUES ('finnhub','earnings','2026-09-02','AMC','22:30','BETA','k','BETA')`,
    )
    .run();
  return Number(ev.lastInsertRowid);
}

describe("findEmailCandidates — ET calendar day (Codex round-3 finding 9)", () => {
  it("at 20:30 ET a preview 120 minutes out on TODAY's ET date is a candidate even though the UTC date has rolled", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const id = seed(db);
    // 2026-09-02 20:30 ET == 2026-09-03 00:30 UTC. UTC day math looks for
    // event_date BETWEEN 09-03 AND 09-04 and drops the 09-02 row.
    const now = new Date("2026-09-03T00:30:00Z");
    const out = findEmailCandidates(db, { now });
    expect(out).toEqual([{ eventId: id, symbol: "BETA", phase: "preview" }]);
  });
});
