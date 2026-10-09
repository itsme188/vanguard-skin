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

describe("upsertSymbolReleaseTime keeps the note and verified date (D4)", () => {
  function seedWebVerified() {
    upsertSymbolReleaseTime(db, {
      symbol: "ZZA",
      releaseTime: "16:10",
      source: "web_verified",
      note: "wire timestamp",
      verifiedForDate: "2030-01-15",
    });
  }

  it("a save with no note keeps the stored note and verified date", () => {
    seedWebVerified();
    upsertSymbolReleaseTime(db, { symbol: "ZZA", releaseTime: "16:15", source: "user" });
    expect(getSymbolReleaseTimeRow(db, "ZZA")).toMatchObject({
      release_time: "16:15",
      source: "user",
      note: "wire timestamp",
      verified_for_date: "2030-01-15",
    });
  });

  it("a save with a new note replaces the note", () => {
    seedWebVerified();
    upsertSymbolReleaseTime(db, { symbol: "ZZA", releaseTime: "16:15", source: "user", note: "call sheet" });
    expect(getSymbolReleaseTimeRow(db, "ZZA")).toMatchObject({
      note: "call sheet",
      verified_for_date: "2030-01-15",
    });
  });

  it("an explicit null or empty note clears it", () => {
    seedWebVerified();
    upsertSymbolReleaseTime(db, {
      symbol: "ZZA",
      releaseTime: "16:15",
      source: "user",
      note: null,
      verifiedForDate: null,
    });
    expect(getSymbolReleaseTimeRow(db, "ZZA")).toMatchObject({ note: null, verified_for_date: null });

    seedWebVerified();
    upsertSymbolReleaseTime(db, { symbol: "ZZA", releaseTime: "16:15", source: "user", note: "" });
    expect(getSymbolReleaseTimeRow(db, "ZZA")?.note).toBeNull();
  });

  it("a web_verified write still cannot downgrade a user override", () => {
    upsertSymbolReleaseTime(db, { symbol: "ZZA", releaseTime: "07:00", source: "user", note: "mine" });
    upsertSymbolReleaseTime(db, { symbol: "ZZA", releaseTime: "07:30", source: "web_verified", note: "web" });
    expect(getSymbolReleaseTimeRow(db, "ZZA")).toMatchObject({
      release_time: "07:00",
      source: "user",
      note: "mine",
    });
  });
});
