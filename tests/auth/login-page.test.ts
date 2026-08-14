import { describe, it, expect } from "vitest";
import { classifyRoute } from "@/lib/auth/route-policy";
import { safeNextPath, DEFAULT_LOGIN_REDIRECT } from "@/lib/auth/safe-next";

// Packaged-app trust boundary (#35, task 7) — login page guards.
//
// 1. The login page is the ONLY page reachable with no session cookie at
//    all (once the proxy lands in task 18). This test re-confirms the
//    task-3 manifest classifies it "public" — belt-and-suspenders on the
//    one route the whole boundary's escape hatch depends on staying open.
// 2. safeNextPath is the open-redirect guard on the `?next=` query param:
//    a freshly-authenticated session cookie must never be handed to an
//    attacker-controlled page via a crafted next value.

describe("GET /login stays classified public", () => {
  it("classifyRoute still returns public (guards the login page's own reachability)", () => {
    expect(classifyRoute("GET", "/login")).toBe("public");
  });
});

describe("safeNextPath", () => {
  it("allows a same-origin relative path", () => {
    expect(safeNextPath("/dashboard/security/5")).toBe("/dashboard/security/5");
  });

  it("allows the default landing route unchanged", () => {
    expect(safeNextPath("/dashboard/today")).toBe("/dashboard/today");
  });

  it("falls back to the default when next is missing", () => {
    expect(safeNextPath(null)).toBe(DEFAULT_LOGIN_REDIRECT);
    expect(safeNextPath(undefined)).toBe(DEFAULT_LOGIN_REDIRECT);
    expect(safeNextPath("")).toBe(DEFAULT_LOGIN_REDIRECT);
  });

  it("rejects a protocol-relative path (//evil.com)", () => {
    expect(safeNextPath("//evil.com")).toBe(DEFAULT_LOGIN_REDIRECT);
  });

  it("rejects an absolute URL (https://evil.com)", () => {
    expect(safeNextPath("https://evil.com")).toBe(DEFAULT_LOGIN_REDIRECT);
  });

  it("rejects an absolute URL with no scheme separator quirks (http://evil.com)", () => {
    expect(safeNextPath("http://evil.com")).toBe(DEFAULT_LOGIN_REDIRECT);
  });

  it("rejects a path with no leading slash", () => {
    expect(safeNextPath("evil.com")).toBe(DEFAULT_LOGIN_REDIRECT);
  });

  it("rejects a backslash-leading path (browser-normalized protocol-relative bypass)", () => {
    expect(safeNextPath("/\\evil.com")).toBe(DEFAULT_LOGIN_REDIRECT);
  });
});
