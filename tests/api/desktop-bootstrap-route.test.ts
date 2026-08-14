import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";

// Packaged-app trust boundary (#35, task 14) — HTTP-boundary tests for the
// POST /api/auth/desktop-bootstrap wrapper: the loopback-only Host assertion
// (defense in depth) and the credential handoff. Uses the repo's standard
// route-test pattern (vi.mock the db singleton with an in-memory DB) so the
// real data/vanguard.db is never touched.

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// Imported AFTER the mock is registered.
import { POST, isLoopbackHost } from "@/app/api/auth/desktop-bootstrap/route";

const CRED = "elec-service-cred-abc123";

function makeReq(host: string | null, cred?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (host !== null) headers["host"] = host;
  if (cred !== undefined) headers["x-electron-cred"] = cred;
  // The URL is irrelevant to the handler (it reads the Host header), but must
  // be well-formed for NextRequest.
  return new NextRequest("http://localhost:3099/api/auth/desktop-bootstrap", {
    method: "POST",
    headers,
  });
}

describe("isLoopbackHost", () => {
  it("accepts loopback hosts (with/without port, IPv6)", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("localhost:3099")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:3099")).toBe(true);
    // IPv6 in a Host header is bracketed (bare "::1" is not a valid Host).
    expect(isLoopbackHost("[::1]:3099")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  it("rejects non-loopback and missing hosts", () => {
    expect(isLoopbackHost("evil.example")).toBe(false);
    expect(isLoopbackHost("evil.example:3099")).toBe(false);
    expect(isLoopbackHost("100.96.0.1:3099")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});

describe("POST /api/auth/desktop-bootstrap — loopback gate", () => {
  const originalCred = process.env.ELECTRON_SERVICE_CRED;

  beforeEach(() => {
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    process.env.ELECTRON_SERVICE_CRED = CRED;
  });

  afterEach(() => {
    if (originalCred === undefined) delete process.env.ELECTRON_SERVICE_CRED;
    else process.env.ELECTRON_SERVICE_CRED = originalCred;
  });

  it("non-loopback Host: 403, and the credential is NEVER read/verified (no session minted)", async () => {
    // A VALID credential is presented — a credential-first implementation would
    // mint a session and 200. The 403 proves the Host check gates FIRST.
    const res = await POST(makeReq("evil.example", CRED));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);

    const count = hoisted.db.prepare("SELECT COUNT(*) AS n FROM app_sessions").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("loopback Host + valid cred: 200 with a real session + csrf", async () => {
    const res = await POST(makeReq("localhost:3099", CRED));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.data.session).toBe("string");
    expect(body.data.session.length).toBeGreaterThan(0);
    expect(typeof body.data.csrf).toBe("string");

    const count = hoisted.db.prepare("SELECT COUNT(*) AS n FROM app_sessions").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("loopback Host + wrong cred: 401", async () => {
    const res = await POST(makeReq("127.0.0.1:3099", "wrong"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
