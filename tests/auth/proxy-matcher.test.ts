import { describe, it, expect, vi } from "vitest";

// Packaged-app trust boundary (#35, task 18) — the proxy matcher must cover
// everything except verified immutable static assets. Mock the Node-only db
// singleton so importing proxy.ts here never opens the live portfolio DB; we
// only assert on the exported `config.matcher`.
vi.mock("@/lib/db", () => ({ db: {} }));

import { config } from "@/proxy";

/** Apply a Next-style matcher source string as a full-path regex. The negative
 * lookahead in the source is a real regex construct, so anchoring it end-to-end
 * reproduces which paths the proxy runs for. */
function matches(pathname: string): boolean {
  return config.matcher.some((source) => new RegExp(`^${source}$`).test(pathname));
}

describe("proxy config.matcher", () => {
  it("matches the root path", () => {
    expect(matches("/")).toBe(true);
  });

  it("matches dashboard pages", () => {
    expect(matches("/dashboard/today")).toBe(true);
    expect(matches("/dashboard/security/123")).toBe(true);
  });

  it("matches API routes", () => {
    expect(matches("/api/summary")).toBe(true);
    expect(matches("/api/tws/connect")).toBe(true);
  });

  it("does NOT match immutable static assets", () => {
    expect(matches("/_next/static/chunk.js")).toBe(false);
    expect(matches("/favicon.ico")).toBe(false);
    expect(matches("/robots.txt")).toBe(false);
  });

  it("DOES match dynamic _next data/RSC payloads (not exempt — they carry page props)", () => {
    expect(matches("/_next/data/build/dashboard.json")).toBe(true);
    expect(matches("/_next/image")).toBe(true);
  });
});
