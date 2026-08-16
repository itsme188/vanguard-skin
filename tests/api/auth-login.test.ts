import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { hashPassword } from "@/lib/auth/credentials";
import { verifySession } from "@/lib/queries/sessions";
import { resetLoginThrottle } from "@/lib/auth/throttle";
import { handleLogin } from "@/app/api/auth/login/route";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/lib/auth/cookies";

// Packaged-app trust boundary (#35, task 6) — login handler + global
// throttle. Exercises the pure, dependency-injected `handleLogin` directly
// (no HTTP server, no Next request/response objects) so the auth/session
// logic is fully unit-tested; the POST route is a thin wrapper that maps
// this same result onto real Set-Cookie headers.

const T0 = Date.parse("2026-08-14T12:00:00Z");
const PASSWORD = "correct horse battery staple";

function fresh(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  return database;
}

describe("handleLogin", () => {
  let db: Database.Database;
  const originalHash = process.env.APP_PASSWORD_HASH;

  beforeEach(() => {
    db = fresh();
    resetLoginThrottle();
    process.env.APP_PASSWORD_HASH = hashPassword(PASSWORD);
  });

  afterEach(() => {
    resetLoginThrottle();
    if (originalHash === undefined) {
      delete process.env.APP_PASSWORD_HASH;
    } else {
      process.env.APP_PASSWORD_HASH = originalHash;
    }
  });

  it("correct password: 200, sets both cookies, session verifies against the returned token", () => {
    const result = handleLogin(db, { password: PASSWORD }, { secure: true }, T0);
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);

    const names = result.setCookies.map((c) => c.name).sort();
    expect(names).toEqual([CSRF_COOKIE, SESSION_COOKIE].sort());

    const sessionCookie = result.setCookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(sessionCookie.attrs.httpOnly).toBe(true);
    expect(sessionCookie.attrs.secure).toBe(true);
    expect(sessionCookie.attrs.sameSite).toBe("Lax");
    expect(sessionCookie.attrs.maxAge).toBeGreaterThan(0);

    const csrfCookie = result.setCookies.find((c) => c.name === CSRF_COOKIE)!;
    expect(csrfCookie.attrs.httpOnly).toBe(false);
    expect(csrfCookie.attrs.secure).toBe(true);

    // The session cookie value is a real, verifiable bearer token whose
    // stored CSRF secret matches the CSRF cookie we handed back.
    const verified = verifySession(db, sessionCookie.value, T0);
    expect(verified).not.toBeNull();
    expect(verified!.csrfSecret).toBe(csrfCookie.value);
  });

  it("secure:false yields non-Secure cookies (Electron localhost / APP_COOKIE_SECURE=0)", () => {
    const result = handleLogin(db, { password: PASSWORD }, { secure: false }, T0);
    expect(result.setCookies.length).toBe(2);
    for (const cookie of result.setCookies) {
      expect(cookie.attrs.secure).toBe(false);
    }
  });

  it("wrong password: 401, no cookies set, failure", () => {
    const result = handleLogin(db, { password: "wrong" }, { secure: true }, T0);
    expect(result.status).toBe(401);
    expect(result.setCookies).toEqual([]);
    expect(result.body.success).toBe(false);
  });

  it("missing APP_PASSWORD_HASH: 500, no cookies", () => {
    delete process.env.APP_PASSWORD_HASH;
    const result = handleLogin(db, { password: PASSWORD }, { secure: true }, T0);
    expect(result.status).toBe(500);
    expect(result.setCookies).toEqual([]);
    expect(result.body.success).toBe(false);
  });

  it("throttle: 5 failures lock out the 6th attempt with 429, even with the correct password", () => {
    for (let i = 0; i < 5; i++) {
      const attempt = handleLogin(db, { password: "wrong" }, { secure: true }, T0 + i);
      expect(attempt.status).toBe(401);
    }

    const locked = handleLogin(db, { password: PASSWORD }, { secure: true }, T0 + 100);
    expect(locked.status).toBe(429);
    expect(locked.setCookies).toEqual([]);
  });

  it("a successful login resets the throttle for subsequent attempts", () => {
    handleLogin(db, { password: "wrong" }, { secure: true }, T0);
    handleLogin(db, { password: "wrong" }, { secure: true }, T0);
    const ok = handleLogin(db, { password: PASSWORD }, { secure: true }, T0);
    expect(ok.status).toBe(200);

    // Only 4 more failures since the reset — not enough to trip a fresh
    // lockout — so a correct password on the 5th attempt still succeeds.
    for (let i = 0; i < 4; i++) {
      const attempt = handleLogin(db, { password: "wrong" }, { secure: true }, T0 + i);
      expect(attempt.status).toBe(401);
    }
    const stillOpen = handleLogin(db, { password: PASSWORD }, { secure: true }, T0 + 10);
    expect(stillOpen.status).toBe(200);
  });
});
