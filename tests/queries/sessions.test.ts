import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import {
  createSession,
  touchSession,
  revokeSession,
  revokeAllSessions,
  revokeSessionsByLabel,
  cleanupExpiredSessions,
} from "@/lib/mutations/sessions";
import { verifySession, ABSOLUTE_MS, IDLE_WINDOW_MS } from "@/lib/queries/sessions";

const MIGRATIONS_DIR = join(__dirname, "../../lib/db/migrations");
const T0 = Date.parse("2026-08-14T12:00:00Z");
const DAY = 86_400_000;

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("app_sessions constants", () => {
  it("absolute is 30 days, idle is 7 days", () => {
    expect(ABSOLUTE_MS).toBe(30 * DAY);
    expect(IDLE_WINDOW_MS).toBe(7 * DAY);
  });
});

describe("createSession / verifySession", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("verifies a fresh session and returns its label", () => {
    const { rawToken } = createSession(db, { label: "phone" }, T0);
    const verified = verifySession(db, rawToken, T0);
    expect(verified).not.toBeNull();
    expect(verified!.label).toBe("phone");
  });

  it("returns id and a one-time csrfToken from createSession", () => {
    const { rawToken, csrfToken, id } = createSession(db, { label: "phone" }, T0);
    expect(typeof id).toBe("number");
    expect(rawToken.length).toBeGreaterThanOrEqual(32); // 256-bit token, base64url-encoded
    expect(csrfToken.length).toBeGreaterThan(0);
    // verifySession exposes the same secret back out (needed to validate CSRF headers later)
    const verified = verifySession(db, rawToken, T0);
    expect(verified!.csrfSecret).toBe(csrfToken);
    expect(verified!.id).toBe(id);
  });

  it("stores only the SHA-256 hash of the token, never the raw token", () => {
    const { rawToken } = createSession(db, { label: "phone" }, T0);
    const rows = db.prepare("SELECT token_hash FROM app_sessions").all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(rawToken);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/); // hex-encoded sha256
  });

  it("rejects an unknown / bad token", () => {
    createSession(db, { label: "phone" }, T0);
    expect(verifySession(db, "not-a-real-token", T0)).toBeNull();
  });

  it("rejects after the absolute 30-day window even if recently touched", () => {
    const { rawToken, id } = createSession(db, { label: "phone" }, T0);
    // touch right before expiry so idle alone would not explain rejection
    touchSession(db, id, T0 + 29 * DAY, 0);
    expect(verifySession(db, rawToken, T0 + 31 * DAY)).toBeNull();
  });

  it("rejects after the 7-day idle window even inside the absolute window", () => {
    const { rawToken: t2 } = createSession(db, { label: "phone" }, T0);
    expect(verifySession(db, t2, T0 + 8 * DAY)).toBeNull();
  });

  it("accepts just inside the idle window when untouched", () => {
    const { rawToken } = createSession(db, { label: "phone" }, T0);
    expect(verifySession(db, rawToken, T0 + 6 * DAY + 23 * 60 * 60 * 1000)).not.toBeNull();
  });

  it("accepts just inside the absolute window when kept alive by touches", () => {
    const { rawToken, id } = createSession(db, { label: "phone" }, T0);
    // Touch every 6 days so idle never trips, right up to the 30-day cap.
    for (let t = T0 + 6 * DAY; t < T0 + 29 * DAY; t += 6 * DAY) {
      touchSession(db, id, t, 0);
    }
    expect(verifySession(db, rawToken, T0 + 29 * DAY + 23 * 60 * 60 * 1000)).not.toBeNull();
  });

  it("is side-effect-free (does not mutate last_seen_at)", () => {
    const { rawToken, id } = createSession(db, { label: "phone" }, T0);
    verifySession(db, rawToken, T0 + DAY);
    const row = db.prepare("SELECT last_seen_at FROM app_sessions WHERE id=?").get(id) as { last_seen_at: string };
    expect(Date.parse(row.last_seen_at)).toBe(T0);
  });
});

describe("touchSession", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("is a no-op inside the throttle window", () => {
    const { id } = createSession(db, { label: "x" }, T0);
    touchSession(db, id, T0 + 60_000, 5 * 60_000); // 1min < 5min throttle
    const row = db.prepare("SELECT last_seen_at FROM app_sessions WHERE id=?").get(id) as { last_seen_at: string };
    expect(Date.parse(row.last_seen_at)).toBe(T0);
  });

  it("slides last_seen_at once outside the throttle window", () => {
    const { id } = createSession(db, { label: "x" }, T0);
    touchSession(db, id, T0 + 6 * 60_000, 5 * 60_000); // 6min > 5min throttle
    const row = db.prepare("SELECT last_seen_at FROM app_sessions WHERE id=?").get(id) as { last_seen_at: string };
    expect(Date.parse(row.last_seen_at)).toBe(T0 + 6 * 60_000);
  });
});

describe("revokeSession / revokeAllSessions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("revokeSession deletes only the targeted session", () => {
    const { id: id1, rawToken: t1 } = createSession(db, { label: "a" }, T0);
    const { rawToken: t2 } = createSession(db, { label: "b" }, T0);
    revokeSession(db, id1);
    expect(verifySession(db, t1, T0)).toBeNull();
    expect(verifySession(db, t2, T0)).not.toBeNull();
  });

  it("revokeAllSessions deletes every session", () => {
    const { rawToken: t1 } = createSession(db, { label: "a" }, T0);
    const { rawToken: t2 } = createSession(db, { label: "b" }, T0);
    revokeAllSessions(db);
    expect(verifySession(db, t1, T0)).toBeNull();
    expect(verifySession(db, t2, T0)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM app_sessions").get()).toEqual({ n: 0 });
  });
});

describe("revokeSessionsByLabel", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("deletes only sessions with the given label and returns the count removed", () => {
    const { rawToken: qaToken1 } = createSession(db, { label: "qa" }, T0);
    const { rawToken: qaToken2 } = createSession(db, { label: "qa" }, T0);
    const { rawToken: deviceToken } = createSession(db, { label: "device" }, T0);

    const deleted = revokeSessionsByLabel(db, "qa");

    expect(deleted).toBe(2);
    expect(verifySession(db, qaToken1, T0)).toBeNull();
    expect(verifySession(db, qaToken2, T0)).toBeNull();
    expect(verifySession(db, deviceToken, T0)).not.toBeNull();
  });

  it("returns 0 when no sessions match the label", () => {
    createSession(db, { label: "device" }, T0);
    expect(revokeSessionsByLabel(db, "qa")).toBe(0);
  });
});

describe("cleanupExpiredSessions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("deletes only expired sessions and returns the count removed", () => {
    createSession(db, { label: "a" }, T0 - 40 * DAY); // expires_at = T0-10d, already expired
    createSession(db, { label: "b" }, T0); // expires_at = T0+30d, still fresh
    expect(cleanupExpiredSessions(db, T0, 500)).toBe(1);
    const remaining = db.prepare("SELECT label FROM app_sessions").all() as { label: string }[];
    expect(remaining).toEqual([{ label: "b" }]);
  });

  it("respects the LIMIT and leaves the rest for the next sweep", () => {
    createSession(db, { label: "a" }, T0 - 40 * DAY);
    createSession(db, { label: "b" }, T0 - 40 * DAY);
    createSession(db, { label: "c" }, T0 - 40 * DAY);
    const deleted = cleanupExpiredSessions(db, T0, 2);
    expect(deleted).toBe(2);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM app_sessions").get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it("defaults to a limit of 500 when omitted", () => {
    for (let i = 0; i < 3; i++) {
      createSession(db, { label: `old-${i}` }, T0 - 40 * DAY);
    }
    expect(cleanupExpiredSessions(db, T0)).toBe(3);
  });
});

describe("migration 079: app_sessions", () => {
  /** Apply migrations strictly below the given number, in order (mirrors
   * tests/import/corporate-actions-migration.test.ts's upgrade-path pattern). */
  function migrateBelow(db: Database.Database, stopAt: number) {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      const n = parseInt(f.slice(0, 3), 10);
      if (n >= stopAt) break;
      db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
    }
  }

  it("applies cleanly over a database seeded at 078 and creates the unique token index", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrateBelow(db, 79);

    db.exec(readFileSync(join(MIGRATIONS_DIR, "079_app_sessions.sql"), "utf-8"));

    const indexes = db.prepare("PRAGMA index_list('app_sessions')").all() as { name: string; unique: number }[];
    const tokenIndex = indexes.find((idx) => idx.name === "idx_app_sessions_token");
    expect(tokenIndex).toBeTruthy();
    expect(tokenIndex!.unique).toBe(1);
    expect(indexes.some((idx) => idx.name === "idx_app_sessions_expires")).toBe(true);
  });

  it("full runMigrations path enforces the unique token index", () => {
    const db = fresh();
    createSession(db, { label: "a" }, T0);
    // Force a duplicate token_hash to prove the unique index is really there.
    const row = db.prepare("SELECT token_hash FROM app_sessions").get() as { token_hash: string };
    expect(() =>
      db
        .prepare(
          `INSERT INTO app_sessions (token_hash, csrf_secret, label, created_at, last_seen_at, expires_at)
           VALUES (?, 'x', 'dupe', datetime('now'), datetime('now'), datetime('now'))`
        )
        .run(row.token_hash)
    ).toThrow(/UNIQUE/);
  });
});
