/**
 * query_levels reports a level's last fire as history. A re-armed level keeps
 * its last-fired record while it is active again, so the tool must not hand
 * the model `triggered_at` beside `is_active: 1` (it reads as "triggered").
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS } from "@/lib/chat/tools";
import { reactivateLevel, triggerLevel, upsertLevel } from "@/lib/mutations/security-levels";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("query_levels tool — last-fired fields", () => {
  it("names a re-armed level's earlier fire last_fired_*, never triggered_*", async () => {
    const secId = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('ZZQL', 'ZZQL Corp', 'stock', 'equity', 1)"
      )
      .run().lastInsertRowid as number;
    const levelId = upsertLevel(db, { security_id: secId, level_type: "resistance", price: 100 });
    triggerLevel(db, {
      levelId,
      securityId: secId,
      triggeredPrice: 110,
      triggeredAt: "2099-01-01T15:00:00.000Z",
    });
    reactivateLevel(db, levelId);

    const result = (await executeTool(db, "query_levels", { symbol: "ZZQL" })) as {
      error?: string;
      data?: { levels: Array<Record<string, unknown>> };
      levels?: Array<Record<string, unknown>>;
    };
    expect(result.error).toBeUndefined();
    const parsed = { levels: result.data?.levels ?? result.levels ?? [] };

    expect(parsed.levels).toHaveLength(1);
    const level = parsed.levels[0];
    expect(level).toMatchObject({
      id: levelId,
      is_active: 1,
      last_fired_at: "2099-01-01T15:00:00.000Z",
      last_fired_price: 110,
    });
    expect(level).not.toHaveProperty("triggered_at");
    expect(level).not.toHaveProperty("triggered_price");
  });

  it("the tool description tells the model what the last-fired fields mean", () => {
    const tool = CHAT_TOOLS.find((t) => t.name === "query_levels")!;
    expect(tool.description).toContain("last_fired_at");
    expect(tool.description).toContain("is_active");
  });
});
