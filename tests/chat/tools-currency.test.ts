/**
 * QA-4 for price history and B23 for levels (Portfolio Assistant plan, Task 5).
 *
 * Prices and level prices are stored in the security's NATIVE currency. The
 * tool output now names that currency so the model never puts a dollar sign
 * on a yen price, and the figure itself is never converted.
 *
 * Protects: the currency label on every native price. Bound: the figure
 * returned equals the stored figure exactly (no FX multiply).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";
import { todayET } from "@/lib/calendar/date-utils";

let db: Database.Database;
let secId: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  secId = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZQJ', 'ZQJ KK', 'stock', 'JPY')")
    .run().lastInsertRowid as number;
  db.prepare("INSERT INTO fx_rates (currency, usd_per_unit, as_of) VALUES ('JPY', 0.007, ?)").run(todayET());
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, 1500)").run(secId, todayET());
  const levelId = db
    .prepare("INSERT INTO security_levels (security_id, level_type, price) VALUES (?, 'support', 1400)")
    .run(secId).lastInsertRowid as number;
  db.prepare(
    "INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price) VALUES (?, ?, datetime('now', '-1 hour'), 1390)",
  ).run(levelId, secId);
});

describe("native prices carry their currency", () => {
  it("query_price_history has one top-level currency and unconverted closes", async () => {
    const r = (await executeTool(db, "query_price_history", { symbol: "ZQJ" })) as {
      data: { currency: string; rows: Array<{ close_price: number; currency?: string }> };
    };
    expect(r.data.currency).toBe("JPY");
    expect(r.data.rows[0].close_price).toBe(1500);
    expect(r.data.rows[0]).not.toHaveProperty("currency");
  });

  it("query_levels rows carry the security's currency and the stored price", async () => {
    const r = (await executeTool(db, "query_levels", { symbol: "ZQJ" })) as {
      data: { levels: Array<{ price: number; currency: string }> };
    };
    expect(r.data.levels[0]).toMatchObject({ price: 1400, currency: "JPY" });
  });

  it("query_alerts rows carry the security's currency and the stored prices", async () => {
    const r = (await executeTool(db, "query_alerts", { symbol: "ZQJ" })) as {
      data: { alerts: Array<{ level_price: number; triggered_price: number; currency: string }> };
    };
    expect(r.data.alerts[0]).toMatchObject({ level_price: 1400, triggered_price: 1390, currency: "JPY" });
  });

  it("an unknown symbol's price history is an error, not an empty list with no currency", async () => {
    const r = (await executeTool(db, "query_price_history", { symbol: "ZZZZ" })) as { error?: string };
    expect(r.error).toBe("No security 'ZZZZ' on file. Nothing was filtered or returned.");
  });
});
