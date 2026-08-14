import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Packaged-app trust boundary (#35, task 18) — the proxy's Host/Origin
// allowlists must be extensible via APP_EXTRA_HOSTS / APP_EXTRA_ORIGINS so the
// pre-cutover mesh phone (http://100.96.0.1:3099) can be admitted without
// hardcoding the mesh IP. Mock the Node-only db + session store so we exercise
// the proxy's env-driven ctx construction, not a real DB.

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/mutations/sessions", () => ({ touchSession: vi.fn() }));
vi.mock("@/lib/queries/sessions", () => ({
  // Only "good-token" is a live session; everything else is anonymous.
  verifySession: (_db: unknown, token: string) =>
    token === "good-token" ? { id: 1, csrfSecret: "csrf-secret", label: "phone" } : null,
}));

import proxy from "@/proxy";

const MESH_HOST = "100.96.0.1:3099";
const MESH_URL = `http://${MESH_HOST}/api/summary`;

function meshRequest(withSession: boolean): NextRequest {
  const headers: Record<string, string> = { host: MESH_HOST };
  if (withSession) headers.cookie = "vgs_session=good-token";
  return new NextRequest(MESH_URL, { headers });
}

describe("proxy — APP_EXTRA_HOSTS / APP_EXTRA_ORIGINS env extension", () => {
  const savedHosts = process.env.APP_EXTRA_HOSTS;
  const savedOrigins = process.env.APP_EXTRA_ORIGINS;

  beforeEach(() => {
    delete process.env.APP_EXTRA_HOSTS;
    delete process.env.APP_EXTRA_ORIGINS;
  });
  afterEach(() => {
    if (savedHosts === undefined) delete process.env.APP_EXTRA_HOSTS;
    else process.env.APP_EXTRA_HOSTS = savedHosts;
    if (savedOrigins === undefined) delete process.env.APP_EXTRA_ORIGINS;
    else process.env.APP_EXTRA_ORIGINS = savedOrigins;
  });

  it("denies a mesh-host GET (valid session) when APP_EXTRA_HOSTS is NOT set", () => {
    const res = proxy(meshRequest(true));
    // /api/* deny → 401 (the Host gate rejects before the session even matters).
    expect(res.status).toBe(401);
  });

  it("allows a mesh-host GET with a valid session once APP_EXTRA_HOSTS includes it", () => {
    process.env.APP_EXTRA_HOSTS = "100.96.0.1:3099";
    process.env.APP_EXTRA_ORIGINS = "http://100.96.0.1:3099";
    const res = proxy(meshRequest(true));
    // allow → NextResponse.next() → 200, not a 401/redirect.
    expect(res.status).toBe(200);
  });

  it("still denies a mesh-host GET with NO session even when APP_EXTRA_HOSTS includes it", () => {
    process.env.APP_EXTRA_HOSTS = "100.96.0.1:3099";
    process.env.APP_EXTRA_ORIGINS = "http://100.96.0.1:3099";
    const res = proxy(meshRequest(false));
    // Host now allowlisted, but no session → human route deny401.
    expect(res.status).toBe(401);
  });

  it("honors multiple comma-separated extra hosts (trims whitespace)", () => {
    process.env.APP_EXTRA_HOSTS = "10.0.0.5:3099 , 100.96.0.1:3099";
    const res = proxy(meshRequest(true));
    expect(res.status).toBe(200);
  });
});
