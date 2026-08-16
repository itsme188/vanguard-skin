import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { createSession, revokeSession } from "@/lib/mutations/sessions";
import { getLiveSessionById, getSessionPin } from "@/lib/queries/sessions";
import { ABSOLUTE_MS, IDLE_WINDOW_MS } from "@/lib/queries/sessions";
import { handleSetPin, handleVerifyPin, isValidPin, MAX_PIN_ATTEMPTS } from "@/lib/auth/pin";
import { verifyPin } from "@/lib/auth/credentials";
import { classifyRoute } from "@/lib/auth/route-policy";

// Packaged-app trust boundary (#35, task 16) — convenience-PIN semantics
// (spec §B2). The PIN is NOT a second password: it re-activates an existing,
// non-expired session on the SAME device and NEVER creates one from cold.
// These exercise the pure, dependency-injected handlers directly; the two
// route files are thin cookie->handler wrappers over the same logic.

const T0 = Date.parse("2026-08-14T12:00:00Z");
const PIN = "246813";

function fresh(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  return database;
}

function sessionCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM app_sessions").get() as { n: number }).n;
}

describe("migration 080_session_pin", () => {
  it("creates session_pins with the expected columns", () => {
    const db = fresh();
    const cols = db.prepare("PRAGMA table_info(session_pins)").all() as { name: string }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["created_at", "fail_count", "locked", "pin_hash", "session_id", "updated_at"].sort());
  });

  it("running migrations twice is idempotent (upgrade-safe)", () => {
    const db = fresh();
    // Simulate a re-run on an already-migrated DB.
    expect(() => runMigrations(db)).not.toThrow();
    const cols = db.prepare("PRAGMA table_info(session_pins)").all() as { name: string }[];
    expect(cols.length).toBeGreaterThan(0);
  });

  it("FK ON DELETE CASCADE removes the PIN row when its session is deleted", () => {
    const db = fresh();
    const s = createSession(db, { label: "phone" }, T0);
    handleSetPin(db, s.id, PIN, T0);
    expect(getSessionPin(db, s.id)).not.toBeNull();

    revokeSession(db, s.id);
    expect(getSessionPin(db, s.id)).toBeNull();
    const orphans = db.prepare("SELECT COUNT(*) AS n FROM session_pins").get() as { n: number };
    expect(orphans.n).toBe(0);
  });
});

describe("isValidPin", () => {
  it("accepts 4–8 digit numeric PINs, rejects everything else", () => {
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("12345678")).toBe(true);
    expect(isValidPin("123")).toBe(false); // too short
    expect(isValidPin("123456789")).toBe(false); // too long
    expect(isValidPin("12a4")).toBe(false); // non-digit
    expect(isValidPin("")).toBe(false);
  });
});

describe("handleSetPin", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("stores a slow-hashed PIN bound to a live session", () => {
    const s = createSession(db, { label: "phone" }, T0);
    const result = handleSetPin(db, s.id, PIN, T0);
    expect(result.ok).toBe(true);

    const row = getSessionPin(db, s.id);
    expect(row).not.toBeNull();
    // Stored value is a scrypt hash, never the plaintext PIN.
    expect(row!.pin_hash).not.toBe(PIN);
    expect(row!.pin_hash.startsWith("scrypt$")).toBe(true);
    expect(verifyPin(PIN, row!.pin_hash)).toBe(true);
  });

  it("rejects an invalid PIN format without touching the DB", () => {
    const s = createSession(db, { label: "phone" }, T0);
    const result = handleSetPin(db, s.id, "12", T0);
    expect(result).toEqual({ ok: false, reason: "invalid-pin" });
    expect(getSessionPin(db, s.id)).toBeNull();
  });

  it("rejects a non-existent session id (no live session -> no PIN)", () => {
    const result = handleSetPin(db, 9999, PIN, T0);
    expect(result).toEqual({ ok: false, reason: "session-invalid" });
  });

  it("rejects an EXPIRED session (absolute window elapsed)", () => {
    const s = createSession(db, { label: "phone" }, T0);
    const afterExpiry = T0 + ABSOLUTE_MS + 1;
    expect(getLiveSessionById(db, s.id, afterExpiry)).toBeNull(); // sanity
    const result = handleSetPin(db, s.id, PIN, afterExpiry);
    expect(result).toEqual({ ok: false, reason: "session-invalid" });
    expect(getSessionPin(db, s.id)).toBeNull();
  });

  it("re-setting a PIN clears prior failure/lockout state", () => {
    const s = createSession(db, { label: "phone" }, T0);
    handleSetPin(db, s.id, PIN, T0);
    // trip a few failures
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) handleVerifyPin(db, s.id, "000000", T0);
    expect(getSessionPin(db, s.id)!.locked).toBe(1);

    handleSetPin(db, s.id, "9999", T0);
    const row = getSessionPin(db, s.id)!;
    expect(row.fail_count).toBe(0);
    expect(row.locked).toBe(0);
    expect(handleVerifyPin(db, s.id, "9999", T0)).toEqual({ ok: true });
  });
});

describe("handleVerifyPin", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("correct PIN on a live session -> success + session touched/extended", () => {
    const s = createSession(db, { label: "phone" }, T0);
    handleSetPin(db, s.id, PIN, T0);

    // Advance a day; last_seen should slide forward on a successful unlock.
    const later = T0 + 24 * 60 * 60 * 1000;
    const before = db.prepare("SELECT last_seen_at FROM app_sessions WHERE id = ?").get(s.id) as { last_seen_at: string };
    const result = handleVerifyPin(db, s.id, PIN, later);
    expect(result).toEqual({ ok: true });

    const after = db.prepare("SELECT last_seen_at FROM app_sessions WHERE id = ?").get(s.id) as { last_seen_at: string };
    expect(Date.parse(after.last_seen_at)).toBeGreaterThan(Date.parse(before.last_seen_at));
    // No new session was ever created.
    expect(sessionCount(db)).toBe(1);
  });

  it("wrong PIN increments the fail count and reports attempts remaining", () => {
    const s = createSession(db, { label: "phone" }, T0);
    handleSetPin(db, s.id, PIN, T0);

    const r1 = handleVerifyPin(db, s.id, "000000", T0);
    expect(r1.ok).toBe(false);
    expect((r1 as { reason: string }).reason).toBe("wrong-pin");
    expect((r1 as { attemptsRemaining: number }).attemptsRemaining).toBe(MAX_PIN_ATTEMPTS - 1);
    expect(getSessionPin(db, s.id)!.fail_count).toBe(1);
  });

  it("locks out after N wrong attempts; a later CORRECT PIN is still rejected", () => {
    const s = createSession(db, { label: "phone" }, T0);
    handleSetPin(db, s.id, PIN, T0);

    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) {
      handleVerifyPin(db, s.id, "000000", T0);
    }
    expect(getSessionPin(db, s.id)!.locked).toBe(1);

    // Even the correct PIN cannot re-unlock a locked PIN — password required.
    const locked = handleVerifyPin(db, s.id, PIN, T0);
    expect(locked).toEqual({ ok: false, reason: "locked" });
    // Session was never destroyed and never re-created by the lockout path.
    expect(sessionCount(db)).toBe(1);
  });

  it("no PIN set on the session -> 'no-pin'", () => {
    const s = createSession(db, { label: "phone" }, T0);
    const result = handleVerifyPin(db, s.id, PIN, T0);
    expect(result).toEqual({ ok: false, reason: "no-pin" });
  });

  it("PIN on an EXPIRED session -> rejected, and NO new session is created", () => {
    const s = createSession(db, { label: "phone" }, T0);
    handleSetPin(db, s.id, PIN, T0);
    expect(sessionCount(db)).toBe(1);

    const afterExpiry = T0 + ABSOLUTE_MS + 1;
    const result = handleVerifyPin(db, s.id, PIN, afterExpiry);
    expect(result).toEqual({ ok: false, reason: "session-invalid" });
    // THE security core: the PIN never cold-creates a session.
    expect(sessionCount(db)).toBe(1);
  });

  it("PIN on an IDLE-expired session -> rejected, no cold session", () => {
    const s = createSession(db, { label: "phone" }, T0);
    handleSetPin(db, s.id, PIN, T0);
    const afterIdle = T0 + IDLE_WINDOW_MS + 1;
    const result = handleVerifyPin(db, s.id, PIN, afterIdle);
    expect(result).toEqual({ ok: false, reason: "session-invalid" });
    expect(sessionCount(db)).toBe(1);
  });

  it("REVOKING the session invalidates the PIN (and its row is gone)", () => {
    const s = createSession(db, { label: "phone" }, T0);
    handleSetPin(db, s.id, PIN, T0);
    revokeSession(db, s.id);

    const result = handleVerifyPin(db, s.id, PIN, T0);
    expect(result).toEqual({ ok: false, reason: "session-invalid" });
    expect(getSessionPin(db, s.id)).toBeNull();
    expect(sessionCount(db)).toBe(0);
  });
});

describe("route classification", () => {
  it("both PIN routes are 'human' (session-cookie required, default-deny)", () => {
    expect(classifyRoute("POST", "/api/auth/pin")).toBe("human");
    expect(classifyRoute("POST", "/api/auth/pin/verify")).toBe("human");
  });
});
