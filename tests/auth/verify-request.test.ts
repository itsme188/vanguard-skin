import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { createSession } from "@/lib/mutations/sessions";
import { decideRequest, type RequestCtx } from "@/lib/auth/verify-request";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/lib/auth/cookies";

// Packaged-app trust boundary (#35, task 18) — the choke-point decision fn.
// Pure over an injected db: no HTTP, no Next types. Every branch of the
// default-deny, credential-kind-specific policy is exercised here.

const T0 = Date.parse("2026-08-14T12:00:00Z");

const HOSTS = new Set([
  "localhost:3099",
  "127.0.0.1:3099",
  "localhost:3000",
  "127.0.0.1:3000",
  "app.myportfoliodesk.com",
]);
const ORIGINS = new Set([
  "http://localhost:3099",
  "http://127.0.0.1:3099",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://app.myportfoliodesk.com",
]);
const CRON_SECRET = "cron-secret-value";
const ELECTRON_CRED = "electron-cred-value";
const GOOD_ORIGIN = "http://localhost:3099";

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/** Base ctx with sane allowlists; override per test. */
function ctx(partial: Partial<RequestCtx> & Pick<RequestCtx, "method" | "pathname">): RequestCtx {
  return {
    host: "localhost:3099",
    cookies: {},
    headers: {},
    hosts: HOSTS,
    origins: ORIGINS,
    cronSecret: CRON_SECRET,
    electronCred: ELECTRON_CRED,
    ...partial,
  };
}

describe("decideRequest — immutable assets + host", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("allows immutable assets with no credential at all", () => {
    const d = decideRequest(db, ctx({ method: "GET", pathname: "/_next/static/chunk.js", host: "evil.example" }), T0);
    expect(d.action).toBe("allow");
  });

  it("denies an unknown Host: deny401 for /api/*", () => {
    const d = decideRequest(db, ctx({ method: "GET", pathname: "/api/summary", host: "evil.example" }), T0);
    expect(d.action).toBe("deny401");
  });

  it("denies an unknown Host: redirectLogin for a page", () => {
    const d = decideRequest(db, ctx({ method: "GET", pathname: "/dashboard/today", host: "evil.example" }), T0);
    expect(d.action).toBe("redirectLogin");
  });
});

describe("decideRequest — public routes", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("allows the login page with no credential", () => {
    const d = decideRequest(db, ctx({ method: "GET", pathname: "/login" }), T0);
    expect(d.action).toBe("allow");
  });

  it("allows POST /api/auth/login with no credential", () => {
    const d = decideRequest(db, ctx({ method: "POST", pathname: "/api/auth/login" }), T0);
    expect(d.action).toBe("allow");
  });
});

describe("decideRequest — human routes (session cookie)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("allows a valid-session GET and returns touchId", () => {
    const { rawToken, id } = createSession(db, { label: "phone" }, T0);
    const d = decideRequest(
      db,
      ctx({ method: "GET", pathname: "/api/summary", cookies: { [SESSION_COOKIE]: rawToken } }),
      T0,
    );
    expect(d.action).toBe("allow");
    expect(d.touchId).toBe(id);
  });

  it("deny401 a no-cookie GET to /api/*", () => {
    const d = decideRequest(db, ctx({ method: "GET", pathname: "/api/summary" }), T0);
    expect(d.action).toBe("deny401");
  });

  it("redirectLogin a no-cookie GET to a dashboard page", () => {
    const d = decideRequest(db, ctx({ method: "GET", pathname: "/dashboard/today" }), T0);
    expect(d.action).toBe("redirectLogin");
  });

  it("deny401 a GET with a garbage (non-existent) session token", () => {
    const d = decideRequest(
      db,
      ctx({ method: "GET", pathname: "/api/summary", cookies: { [SESSION_COOKIE]: "not-a-real-token" } }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });

  it("allows an unsafe method with valid session + Origin + matching CSRF", () => {
    const { rawToken, csrfToken, id } = createSession(db, { label: "phone" }, T0);
    const d = decideRequest(
      db,
      ctx({
        method: "DELETE",
        pathname: "/api/import",
        cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
        headers: { origin: GOOD_ORIGIN, "x-csrf-token": csrfToken },
      }),
      T0,
    );
    expect(d.action).toBe("allow");
    expect(d.touchId).toBe(id);
  });

  it("deny401 an unsafe method missing the CSRF header", () => {
    const { rawToken, csrfToken } = createSession(db, { label: "phone" }, T0);
    const d = decideRequest(
      db,
      ctx({
        method: "DELETE",
        pathname: "/api/import",
        cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
        headers: { origin: GOOD_ORIGIN }, // no x-csrf-token
      }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });

  it("deny401 an unsafe method from an untrusted Origin (even with valid CSRF)", () => {
    const { rawToken, csrfToken } = createSession(db, { label: "phone" }, T0);
    const d = decideRequest(
      db,
      ctx({
        method: "POST",
        pathname: "/api/settings",
        cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
        headers: { origin: "https://evil.example", "x-csrf-token": csrfToken },
      }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });

  it("deny401 an unsafe method with a CSRF header that doesn't match the cookie/secret", () => {
    const { rawToken, csrfToken } = createSession(db, { label: "phone" }, T0);
    const d = decideRequest(
      db,
      ctx({
        method: "POST",
        pathname: "/api/settings",
        cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
        headers: { origin: GOOD_ORIGIN, "x-csrf-token": "mismatched-token-value" },
      }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });
});

describe("decideRequest — cron routes (X-Cron-Secret only)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("allows a cron route with the correct cron secret", () => {
    const d = decideRequest(
      db,
      ctx({ method: "POST", pathname: "/api/cron/digest", headers: { "x-cron-secret": CRON_SECRET } }),
      T0,
    );
    expect(d.action).toBe("allow");
  });

  it("deny401 a cron route with a wrong cron secret", () => {
    const d = decideRequest(
      db,
      ctx({ method: "POST", pathname: "/api/cron/digest", headers: { "x-cron-secret": "wrong" } }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });

  it("deny401 the cron secret presented on a human route", () => {
    const d = decideRequest(
      db,
      ctx({ method: "GET", pathname: "/api/summary", headers: { "x-cron-secret": CRON_SECRET } }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });

  it("deny401 the cron secret presented on an electron route", () => {
    const d = decideRequest(
      db,
      ctx({ method: "POST", pathname: "/api/auth/desktop-bootstrap", headers: { "x-cron-secret": CRON_SECRET } }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });

  it("never accepts the electron cred on a cron route", () => {
    const d = decideRequest(
      db,
      ctx({ method: "POST", pathname: "/api/cron/digest", headers: { "x-electron-cred": ELECTRON_CRED } }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });
});

describe("decideRequest — electron routes (X-Electron-Cred only)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("allows an electron route with the correct electron cred", () => {
    const d = decideRequest(
      db,
      ctx({ method: "POST", pathname: "/api/auth/desktop-bootstrap", headers: { "x-electron-cred": ELECTRON_CRED } }),
      T0,
    );
    expect(d.action).toBe("allow");
  });

  it("deny401 an electron route with a wrong electron cred", () => {
    const d = decideRequest(
      db,
      ctx({ method: "POST", pathname: "/api/auth/desktop-bootstrap", headers: { "x-electron-cred": "wrong" } }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });

  it("never accepts the cron secret on an electron route (already covered) and never a session", () => {
    const { rawToken, csrfToken } = createSession(db, { label: "desktop" }, T0);
    const d = decideRequest(
      db,
      ctx({
        method: "POST",
        pathname: "/api/auth/revoke-all",
        cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
        headers: { origin: GOOD_ORIGIN, "x-csrf-token": csrfToken },
      }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });
});

describe("decideRequest — dual routes (electron cred OR human session)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("allows a dual route with the electron cred alone (no cookie)", () => {
    const d = decideRequest(
      db,
      ctx({ method: "POST", pathname: "/api/tws/connect", headers: { "x-electron-cred": ELECTRON_CRED } }),
      T0,
    );
    expect(d.action).toBe("allow");
  });

  it("allows a dual GET with a valid session (returns touchId)", () => {
    const { rawToken, id } = createSession(db, { label: "phone" }, T0);
    const d = decideRequest(
      db,
      ctx({ method: "GET", pathname: "/api/tws/status", cookies: { [SESSION_COOKIE]: rawToken } }),
      T0,
    );
    expect(d.action).toBe("allow");
    expect(d.touchId).toBe(id);
  });

  it("allows a dual unsafe POST with valid session + Origin + CSRF", () => {
    const { rawToken, csrfToken, id } = createSession(db, { label: "phone" }, T0);
    const d = decideRequest(
      db,
      ctx({
        method: "POST",
        pathname: "/api/tws/connect",
        cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
        headers: { origin: GOOD_ORIGIN, "x-csrf-token": csrfToken },
      }),
      T0,
    );
    expect(d.action).toBe("allow");
    expect(d.touchId).toBe(id);
  });

  it("deny401 a dual unsafe POST with a session but missing CSRF", () => {
    const { rawToken, csrfToken } = createSession(db, { label: "phone" }, T0);
    const d = decideRequest(
      db,
      ctx({
        method: "POST",
        pathname: "/api/tws/connect",
        cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
        headers: { origin: GOOD_ORIGIN }, // no CSRF header
      }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });

  it("deny401 a dual route with neither cred nor session", () => {
    const d = decideRequest(db, ctx({ method: "GET", pathname: "/api/tws/status" }), T0);
    expect(d.action).toBe("deny401");
  });

  it("never accepts the cron secret on a dual route", () => {
    const d = decideRequest(
      db,
      ctx({ method: "POST", pathname: "/api/tws/connect", headers: { "x-cron-secret": CRON_SECRET } }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });
});

describe("decideRequest — fail-closed on blank configured secrets", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("deny401 a cron route when the configured cron secret is blank, even if the presented one is also blank", () => {
    const d = decideRequest(
      db,
      ctx({ method: "POST", pathname: "/api/cron/digest", cronSecret: "", headers: { "x-cron-secret": "" } }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });

  it("deny401 an electron route when the configured electron cred is blank, even if the presented one is also blank", () => {
    const d = decideRequest(
      db,
      ctx({
        method: "POST",
        pathname: "/api/auth/desktop-bootstrap",
        electronCred: "",
        headers: { "x-electron-cred": "" },
      }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });

  it("deny401 a dual route (electron path) when the configured electron cred is blank", () => {
    const d = decideRequest(
      db,
      ctx({
        method: "GET",
        pathname: "/api/tws/status",
        electronCred: "",
        headers: { "x-electron-cred": "" },
      }),
      T0,
    );
    expect(d.action).toBe("deny401");
  });
});
