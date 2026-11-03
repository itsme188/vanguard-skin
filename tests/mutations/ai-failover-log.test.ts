import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  recordFailoverEvent,
  readFailoverLog,
  activeFailoverProviderName,
  AI_FAILOVER_LOG_CAP,
} from "@/lib/mutations/ai-failover-log";
import { aiPrepPauseNotice } from "@/lib/earnings/ai-unavailable";

function mkDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);
  return db;
}
const ev = (at: string) => ({
  feature: "newsletterProcessing" as const,
  from: { provider: "anthropic" as const, modelId: "claude-sonnet-4-6" },
  to: { provider: "openai" as const, modelId: "gpt-6.1-sol" },
  kind: "billing" as const,
  at,
});

describe("failover log", () => {
  it("records, caps, and names the active provider within an hour", () => {
    const db = mkDb();
    for (let i = 0; i < AI_FAILOVER_LOG_CAP + 5; i++) recordFailoverEvent(db, ev("2026-11-02T15:00:00.000Z"));
    expect(readFailoverLog(db)).toHaveLength(AI_FAILOVER_LOG_CAP);
    expect(activeFailoverProviderName(db, new Date("2026-11-02T15:30:00.000Z"))).toBe("OpenAI");
    expect(activeFailoverProviderName(db, new Date("2026-11-02T17:00:00.000Z"))).toBeNull();
  });

  it("an empty or unreadable log is no failover", () => {
    const db = mkDb();
    expect(activeFailoverProviderName(db)).toBeNull();
    db.prepare(`INSERT INTO settings VALUES ('ai_failover_log','not json','')`).run();
    expect(readFailoverLog(db)).toEqual([]);
  });

  it("the hub notice names the fallback only when one is active", () => {
    const pause = { kind: "billing" as const, since: null, waitingSteps: 1, waitingPrints: 1 };
    expect(aiPrepPauseNotice(pause, "2026-11-02")).not.toMatch(/running on/);
    expect(aiPrepPauseNotice(pause, "2026-11-02", "OpenAI")).toMatch(/running on OpenAI/);
  });
});
