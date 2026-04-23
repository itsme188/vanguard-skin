/**
 * /api/search contract tests for the Cmd+K palette backend.
 *
 * Covers the 7 source types the palette navigates into: security, note,
 * transaction, research_article, research_document, level, alert.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import { upsertLevel, triggerLevel } from "@/lib/mutations/security-levels";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

function seedSecurity(symbol: string, name: string | null = null): number {
  const res = hoisted.db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, name ?? `${symbol} Corp`);
  return res.lastInsertRowid as number;
}

async function callSearch(q: string) {
  const mod = await import("@/app/api/search/route");
  const req = new NextRequest(`http://test/api/search?q=${encodeURIComponent(q)}`);
  const res = await mod.GET(req);
  return (await res.json()) as {
    results: Array<{ type: string; id: number; title: string; subtitle: string; href: string }>;
  };
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  vi.resetModules();
});

describe("/api/search", () => {
  it("returns empty results for an empty query", async () => {
    const body = await callSearch("");
    expect(body.results).toEqual([]);
  });

  it("finds a security by symbol prefix", async () => {
    seedSecurity("AAPL");
    seedSecurity("NVDA");
    const body = await callSearch("AAP");
    const security = body.results.find((r) => r.type === "security");
    expect(security?.title).toBe("AAPL");
    expect(security?.href).toMatch(/\/dashboard\/security\/\d+/);
  });

  it("finds a security by name substring", async () => {
    seedSecurity("NVDA", "NVIDIA Corporation");
    const body = await callSearch("NVIDIA");
    expect(body.results.some((r) => r.type === "security" && r.title === "NVDA")).toBe(true);
  });

  it("finds a note by content", async () => {
    const secId = seedSecurity("TSLA");
    hoisted.db
      .prepare(
        "INSERT INTO notes (note_type, security_id, content, event_date) VALUES ('journal', ?, ?, '2026-04-20')"
      )
      .run(secId, "Watching for a breakout above 300");
    const body = await callSearch("breakout");
    const note = body.results.find((r) => r.type === "note");
    expect(note).toBeTruthy();
    expect(note?.subtitle).toContain("breakout");
  });

  it("finds a level by thesis text", async () => {
    const secId = seedSecurity("SPY");
    upsertLevel(hoisted.db, {
      security_id: secId,
      level_type: "support",
      price: 580,
      thesis: "50-day SMA held in March consolidation",
    });
    const body = await callSearch("consolidation");
    const level = body.results.find((r) => r.type === "level");
    expect(level).toBeTruthy();
    expect(level?.title).toContain("SPY");
    expect(level?.subtitle).toContain("consolidation");
  });

  it("finds a level by source_author", async () => {
    const secId = seedSecurity("QQQ");
    upsertLevel(hoisted.db, {
      security_id: secId,
      level_type: "resistance",
      price: 500,
      source_author: "Purple Drink",
    });
    const body = await callSearch("Purple");
    expect(body.results.some((r) => r.type === "level")).toBe(true);
  });

  it("finds an alert by suggested_action text", async () => {
    const secId = seedSecurity("NFLX");
    const levelId = upsertLevel(hoisted.db, {
      security_id: secId,
      level_type: "entry",
      price: 700,
    });
    const { alertId } = triggerLevel(hoisted.db, {
      levelId,
      securityId: secId,
      triggeredPrice: 699,
    });
    hoisted.db
      .prepare("UPDATE level_alerts SET suggested_action = ? WHERE id = ?")
      .run("Consider scaling in on strength with tight stop", alertId);
    const body = await callSearch("scaling");
    const alert = body.results.find((r) => r.type === "alert");
    expect(alert).toBeTruthy();
    expect(alert?.href).toBe("/dashboard/alerts");
  });

  it("falls back cleanly when FTS5 query is too short (doesn't include research docs)", async () => {
    const body = await callSearch("a"); // 1 char → skip FTS5 docs branch
    // No throw, empty-ish response
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.every((r) => r.type !== "research_document")).toBe(true);
  });

  it("returns multiple types when query matches across tables", async () => {
    const secId = seedSecurity("AMZN");
    upsertLevel(hoisted.db, {
      security_id: secId,
      level_type: "entry",
      price: 180,
      thesis: "AMZN earnings catalyst",
    });
    hoisted.db
      .prepare(
        "INSERT INTO notes (note_type, security_id, content, event_date) VALUES ('earnings', ?, 'AMZN Q3 earnings beat', '2026-04-20')"
      )
      .run(secId);
    const body = await callSearch("AMZN");
    const types = new Set(body.results.map((r) => r.type));
    expect(types.has("security")).toBe(true);
    expect(types.has("note")).toBe(true);
    expect(types.has("level")).toBe(true);
  });
});
