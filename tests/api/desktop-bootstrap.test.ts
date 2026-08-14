import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { verifySession } from "@/lib/queries/sessions";
import { handleDesktopBootstrap } from "@/app/api/auth/desktop-bootstrap/route";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/lib/auth/cookies";
import {
  buildBootstrapCookieArgs,
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
} from "@/electron/bootstrap-auth";

// Packaged-app trust boundary (#35, task 14) — desktop-bootstrap handler +
// the pure Electron cookie-arg builder. Exercises the dependency-injected
// `handleDesktopBootstrap` directly (no HTTP, no NextRequest) and the pure
// helper that turns a bootstrap response into `session.cookies.set(...)`
// arguments. The Electron main-process wiring itself is verified manually
// (see task-14 report checklist) — it needs a live Electron runtime.

const T0 = Date.parse("2026-08-14T12:00:00Z");
const CRED = "elec-service-cred-abc123";

function fresh(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  return database;
}

describe("handleDesktopBootstrap", () => {
  let db: Database.Database;
  const originalCred = process.env.ELECTRON_SERVICE_CRED;

  beforeEach(() => {
    db = fresh();
    process.env.ELECTRON_SERVICE_CRED = CRED;
  });

  afterEach(() => {
    if (originalCred === undefined) {
      delete process.env.ELECTRON_SERVICE_CRED;
    } else {
      process.env.ELECTRON_SERVICE_CRED = originalCred;
    }
  });

  it("valid cred: 200, mints a verifiable desktop session + csrf", () => {
    const result = handleDesktopBootstrap(db, CRED, T0);
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    if (!result.body.success) throw new Error("expected success");

    const { session, csrf } = result.body.data;
    expect(typeof session).toBe("string");
    expect(session.length).toBeGreaterThan(0);
    expect(typeof csrf).toBe("string");
    expect(csrf.length).toBeGreaterThan(0);

    // The returned session token is a real bearer token, labeled "desktop",
    // whose stored CSRF secret matches the csrf we handed back.
    const verified = verifySession(db, session, T0);
    expect(verified).not.toBeNull();
    expect(verified!.label).toBe("desktop");
    expect(verified!.csrfSecret).toBe(csrf);
  });

  it("mints a FRESH session each call (distinct tokens)", () => {
    const a = handleDesktopBootstrap(db, CRED, T0);
    const b = handleDesktopBootstrap(db, CRED, T0 + 1);
    if (!a.body.success || !b.body.success) throw new Error("expected success");
    expect(a.body.data.session).not.toBe(b.body.data.session);
    // Both remain valid — a new launch does not invalidate an old session row.
    expect(verifySession(db, a.body.data.session, T0 + 2)).not.toBeNull();
    expect(verifySession(db, b.body.data.session, T0 + 2)).not.toBeNull();
  });

  it("wrong cred: 401, no session minted", () => {
    const result = handleDesktopBootstrap(db, "not-the-cred", T0);
    expect(result.status).toBe(401);
    expect(result.body.success).toBe(false);
    const count = db.prepare("SELECT COUNT(*) AS n FROM app_sessions").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("empty cred: 401 (does not match a set env cred)", () => {
    const result = handleDesktopBootstrap(db, "", T0);
    expect(result.status).toBe(401);
    expect(result.body.success).toBe(false);
  });

  it("constant-time compare: a length mismatch is rejected, not thrown", () => {
    // timingSafeEqual throws on unequal buffer lengths; the handler must guard
    // that with a length check and simply return 401.
    const result = handleDesktopBootstrap(db, CRED + "extra", T0);
    expect(result.status).toBe(401);
    expect(result.body.success).toBe(false);
  });

  it("missing ELECTRON_SERVICE_CRED env: 500", () => {
    delete process.env.ELECTRON_SERVICE_CRED;
    const result = handleDesktopBootstrap(db, CRED, T0);
    expect(result.status).toBe(500);
    expect(result.body.success).toBe(false);
  });
});

describe("buildBootstrapCookieArgs (pure Electron helper)", () => {
  it("cookie name constants match lib/auth/cookies.ts (no typo drift)", () => {
    expect(SESSION_COOKIE_NAME).toBe(SESSION_COOKIE);
    expect(CSRF_COOKIE_NAME).toBe(CSRF_COOKIE);
  });

  it("builds session (httpOnly) + csrf (not httpOnly) cookie-set args for the port", () => {
    const boot = { success: true, data: { session: "S-TOKEN", csrf: "C-TOKEN" } };
    const args = buildBootstrapCookieArgs(3099, boot);
    expect(args).toEqual([
      { url: "http://localhost:3099", name: SESSION_COOKIE, value: "S-TOKEN", httpOnly: true },
      { url: "http://localhost:3099", name: CSRF_COOKIE, value: "C-TOKEN", httpOnly: false },
    ]);
  });

  it("throws when the bootstrap response is missing session or csrf", () => {
    expect(() => buildBootstrapCookieArgs(3099, { success: true, data: { session: "S" } })).toThrow();
    expect(() => buildBootstrapCookieArgs(3099, { success: false, error: "nope" })).toThrow();
    expect(() => buildBootstrapCookieArgs(3099, {})).toThrow();
  });
});
