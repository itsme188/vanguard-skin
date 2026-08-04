// Tests the lib composition pieces /api/earnings/release-time relies on that
// aren't yet covered by tests/earnings/wire-times.test.ts: clearUserReleaseTime
// leaves web_verified rows alone; upsert user replaces a web row (PK
// precedence). The route itself is thin (validation + composition) and is
// compile-checked by `npx tsc --noEmit`.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  upsertSymbolReleaseTime,
  clearUserReleaseTime,
  getSymbolReleaseTimeRow,
} from "@/lib/earnings/wire-times";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

it("clearUserReleaseTime removes only a user row", () => {
  upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:10", source: "web_verified" });
  expect(clearUserReleaseTime(db, "XMTR")).toBe(false);
  expect(getSymbolReleaseTimeRow(db, "XMTR")?.source).toBe("web_verified");

  upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });
  expect(clearUserReleaseTime(db, "XMTR")).toBe(true);
  expect(getSymbolReleaseTimeRow(db, "XMTR")).toBeNull(); // PK row replaced then deleted
});

describe("release-time route composition", () => {
  it("clearing a non-existent override is a no-op (cleared=false)", () => {
    expect(clearUserReleaseTime(db, "NOPE")).toBe(false);
    expect(getSymbolReleaseTimeRow(db, "NOPE")).toBeNull();
  });

  it("a user write always proceeds even over an existing user row (edit-in-place)", () => {
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:00", source: "user" });
    upsertSymbolReleaseTime(db, { symbol: "XMTR", releaseTime: "07:30", source: "user" });
    expect(getSymbolReleaseTimeRow(db, "XMTR")).toMatchObject({
      release_time: "07:30",
      source: "user",
    });
  });
});
