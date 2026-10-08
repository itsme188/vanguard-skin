/**
 * The preview discloses an AI-synthesis fallback that happened during THIS
 * preview. The composer returns only markdown, so the route reads the
 * composer's fallback ring (settings) before and after the call.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";

const RING_KEY = "synthesis_fallbacks_last_30d";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  adaptive: vi.fn(),
  bySource: vi.fn(),
  byCompany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));
vi.mock("@/lib/digest/daily-digest", () => ({
  generateDigestSinceAdaptive: hoisted.adaptive,
  generateDigestSince: hoisted.bySource,
  getLastDigestSentAt: () => null,
}));
vi.mock("@/lib/digest/group-by-company", () => ({
  generateDigestByCompanySince: hoisted.byCompany,
}));

import { GET, POST } from "@/app/api/digest/preview/route";

function writeRing(entries: Array<{ date: string; reason: string; articleCount: number }>) {
  hoisted.db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(RING_KEY, JSON.stringify(entries));
}

const req = (method: "GET" | "POST") =>
  new NextRequest("http://localhost/api/digest/preview?since=2026-03-02", { method });

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  runMigrations(hoisted.db);
  hoisted.adaptive.mockReset().mockResolvedValue("# Digest\n\nBody");
  hoisted.bySource.mockReset().mockReturnValue("# By source\n\nBody");
  hoisted.byCompany.mockReset().mockReturnValue(null);
});

describe("POST /api/digest/preview — synthesis fallback disclosure", () => {
  it("reports no fallback when the composer records none", async () => {
    const body = await (await POST(req("POST"))).json();
    expect(body.synthesisFallback).toBeNull();
    expect(body.structuredHtml).toBeTruthy();
  });

  it("reports the reason when the composer records a fallback during the call", async () => {
    hoisted.adaptive.mockImplementation(async () => {
      writeRing([{ date: "2026-03-02", reason: "generic: upstream unavailable", articleCount: 7 }]);
      return "# Digest\n\nPer-source body";
    });
    const body = await (await POST(req("POST"))).json();
    expect(body.synthesisFallback).toBe("generic: upstream unavailable");
  });

  it("an OLDER fallback already in the ring is not this preview's fallback", async () => {
    writeRing([{ date: "2026-03-01", reason: "generic: yesterday", articleCount: 6 }]);
    const body = await (await POST(req("POST"))).json();
    expect(body.synthesisFallback).toBeNull();
  });

  it("names the NEWEST entry when the ring already held older ones", async () => {
    writeRing([{ date: "2026-03-01", reason: "generic: yesterday", articleCount: 6 }]);
    hoisted.adaptive.mockImplementation(async () => {
      writeRing([
        { date: "2026-03-01", reason: "generic: yesterday", articleCount: 6 },
        { date: "2026-03-02", reason: "empty synthesis", articleCount: 9 },
      ]);
      return "# Digest\n\nPer-source body";
    });
    const body = await (await POST(req("POST"))).json();
    expect(body.synthesisFallback).toBe("empty synthesis");
  });

  it("an unreadable ring still discloses that a fallback was recorded", async () => {
    hoisted.adaptive.mockImplementation(async () => {
      hoisted.db
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
        .run(RING_KEY, "not json");
      return "# Digest\n\nPer-source body";
    });
    const body = await (await POST(req("POST"))).json();
    expect(body.synthesisFallback).toBe("unknown");
  });

  it("the preview never writes the ring itself", async () => {
    await POST(req("POST"));
    const row = hoisted.db.prepare("SELECT value FROM settings WHERE key = ?").get(RING_KEY);
    expect(row).toBeUndefined();
  });
});

describe("GET /api/digest/preview stays a no-AI read", () => {
  it("never calls the adaptive (AI) composer", async () => {
    const body = await (await GET(req("GET"))).json();
    expect(hoisted.adaptive).not.toHaveBeenCalled();
    expect(body.structuredHtml).toBeNull();
    expect(body.bySourceHtml).toBeTruthy();
  });
});
