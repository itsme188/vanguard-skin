import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import { createSession } from "@/lib/mutations/sessions";
import { verifySession } from "@/lib/queries/sessions";

// Packaged-app trust boundary (#35, task 15) — the server-owned "revoke every
// session" endpoint the Electron change-password transaction calls (Electron
// main cannot open better-sqlite3 itself). Mirrors desktop-bootstrap's
// gating: loopback-only + Electron-main service credential, classified
// `electron` in route-policy.

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// Imported AFTER the mock is registered.
import { POST, handleRevokeAll } from "@/app/api/auth/revoke-all/route";

const CRED = "elec-service-cred-abc123";
const T0 = Date.parse("2026-08-14T12:00:00Z");

function fresh(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runMigrations(database);
  return database;
}

function makeReq(host: string | null, cred?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (host !== null) headers["host"] = host;
  if (cred !== undefined) headers["x-electron-cred"] = cred;
  return new NextRequest("http://localhost:3099/api/auth/revoke-all", {
    method: "POST",
    headers,
  });
}

describe("handleRevokeAll (pure, DI)", () => {
  it("revokes every session — previously valid tokens no longer verify", () => {
    const db = fresh();
    const a = createSession(db, { label: "phone" }, T0);
    const b = createSession(db, { label: "desktop" }, T0);
    expect(verifySession(db, a.rawToken, T0)).not.toBeNull();
    expect(verifySession(db, b.rawToken, T0)).not.toBeNull();

    const result = handleRevokeAll(db);
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);

    expect(verifySession(db, a.rawToken, T0)).toBeNull();
    expect(verifySession(db, b.rawToken, T0)).toBeNull();
    const count = db.prepare("SELECT COUNT(*) AS n FROM app_sessions").get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("POST /api/auth/revoke-all — gating", () => {
  const originalCred = process.env.ELECTRON_SERVICE_CRED;

  beforeEach(() => {
    hoisted.db = fresh();
    process.env.ELECTRON_SERVICE_CRED = CRED;
  });

  afterEach(() => {
    if (originalCred === undefined) delete process.env.ELECTRON_SERVICE_CRED;
    else process.env.ELECTRON_SERVICE_CRED = originalCred;
  });

  it("non-loopback Host: 403, credential never examined, sessions untouched", async () => {
    createSession(hoisted.db, { label: "phone" }, T0);
    const res = await POST(makeReq("evil.example", CRED));
    expect(res.status).toBe(403);
    const count = hoisted.db.prepare("SELECT COUNT(*) AS n FROM app_sessions").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("loopback + no credential: 401, sessions untouched", async () => {
    createSession(hoisted.db, { label: "phone" }, T0);
    const res = await POST(makeReq("localhost:3099"));
    expect(res.status).toBe(401);
    const count = hoisted.db.prepare("SELECT COUNT(*) AS n FROM app_sessions").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("loopback + wrong credential: 401, sessions untouched", async () => {
    createSession(hoisted.db, { label: "phone" }, T0);
    const res = await POST(makeReq("127.0.0.1:3099", "wrong"));
    expect(res.status).toBe(401);
    const count = hoisted.db.prepare("SELECT COUNT(*) AS n FROM app_sessions").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("loopback + valid credential: 200 and every session revoked", async () => {
    createSession(hoisted.db, { label: "phone" }, T0);
    createSession(hoisted.db, { label: "desktop" }, T0);
    const res = await POST(makeReq("localhost:3099", CRED));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const count = hoisted.db.prepare("SELECT COUNT(*) AS n FROM app_sessions").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("missing ELECTRON_SERVICE_CRED env: 500 (fails closed), sessions untouched", async () => {
    delete process.env.ELECTRON_SERVICE_CRED;
    createSession(hoisted.db, { label: "phone" }, T0);
    const res = await POST(makeReq("localhost:3099", CRED));
    expect(res.status).toBe(500);
    const count = hoisted.db.prepare("SELECT COUNT(*) AS n FROM app_sessions").get() as { n: number };
    expect(count.n).toBe(1);
  });
});
