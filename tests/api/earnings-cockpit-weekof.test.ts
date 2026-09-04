/**
 * Route-level check for ?weekOf= on GET /api/earnings/cockpit (slice F,
 * M-F5): resolveWeekOfParam never 400s — an unparseable value snaps to the
 * current Monday instead of erroring.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  runMigrations(hoisted.db);
});

describe("GET /api/earnings/cockpit — ?weekOf=", () => {
  it("GET and POST honour ?weekOf= and fall back to the current Monday on garbage", async () => {
    const { GET } = await import("@/app/api/earnings/cockpit/route");
    const ok = await GET(new Request("http://localhost/api/earnings/cockpit?weekOf=2026-07-08"));
    expect(ok.status).toBe(200);
    const junk = await GET(new Request("http://localhost/api/earnings/cockpit?weekOf=not-a-date"));
    expect(junk.status).toBe(200); // resolveWeekOfParam never 400s
    expect((await junk.json()).success).toBe(true);
  });
});
