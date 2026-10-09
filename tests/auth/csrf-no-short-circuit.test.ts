/**
 * `csrfMatches` runs BOTH comparisons every time (wave Q unit 30).
 *
 * The old body was `timingSafeEqual(header, cookie) && timingSafeEqual(header,
 * secret)`: when the header and cookie differed, the comparison against the
 * session secret never ran, so a wrong answer came back after one compare and
 * a right one after two. Not exploitable in practice (the cookie is the
 * caller's own), but a constant-time check should do the same work on every
 * path. The count of `timingSafeEqual` calls is the observable.
 *
 * The truth table itself is pinned in tests/auth/credentials.test.ts and
 * repeated here against the real `timingSafeEqual`, so the change cannot
 * loosen or tighten what passes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ calls: 0 }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const counted: typeof actual.timingSafeEqual = (a, b) => {
    hoisted.calls += 1;
    return actual.timingSafeEqual(a, b);
  };
  return { ...actual, default: { ...actual, timingSafeEqual: counted }, timingSafeEqual: counted };
});

import { csrfMatches } from "@/lib/auth/csrf";

const SECRET = "synthetic-secret-abc";
const OTHER = "synthetic-secret-xyz"; // same length, different value

beforeEach(() => {
  hoisted.calls = 0;
});

describe("csrfMatches does the same work whichever token is wrong", () => {
  it("all three equal: two comparisons, passes", () => {
    expect(csrfMatches(SECRET, SECRET, SECRET)).toBe(true);
    expect(hoisted.calls).toBe(2);
  });

  it("header differs from the cookie: still two comparisons, fails", () => {
    expect(csrfMatches(OTHER, SECRET, SECRET)).toBe(false);
    expect(hoisted.calls).toBe(2);
  });

  it("header and cookie agree but the session secret differs: two comparisons, fails", () => {
    expect(csrfMatches(OTHER, OTHER, SECRET)).toBe(false);
    expect(hoisted.calls).toBe(2);
  });

  it("cookie alone differs: two comparisons, fails", () => {
    expect(csrfMatches(SECRET, OTHER, SECRET)).toBe(false);
    expect(hoisted.calls).toBe(2);
  });

  it("all three different: two comparisons, fails", () => {
    expect(csrfMatches(OTHER, "synthetic-secret-qqq", SECRET)).toBe(false);
    expect(hoisted.calls).toBe(2);
  });
});

describe("csrfMatches truth table is unchanged", () => {
  it("passes only when header, cookie and secret are all equal", () => {
    expect(csrfMatches(SECRET, SECRET, SECRET)).toBe(true);
    expect(csrfMatches(OTHER, SECRET, SECRET)).toBe(false);
    expect(csrfMatches(SECRET, OTHER, SECRET)).toBe(false);
    expect(csrfMatches(SECRET, SECRET, OTHER)).toBe(false);
  });

  it("an empty token never passes, even when all three are empty", () => {
    expect(csrfMatches("", "", "")).toBe(false);
    expect(csrfMatches("", SECRET, SECRET)).toBe(false);
    expect(csrfMatches(SECRET, "", SECRET)).toBe(false);
    expect(csrfMatches(SECRET, SECRET, "")).toBe(false);
  });

  it("a different length fails without throwing", () => {
    expect(csrfMatches("short", SECRET, SECRET)).toBe(false);
    expect(csrfMatches(SECRET, "short", SECRET)).toBe(false);
    expect(csrfMatches(SECRET, SECRET, "short")).toBe(false);
    expect(csrfMatches(`${SECRET}-longer`, `${SECRET}-longer`, SECRET)).toBe(false);
  });

  it("multi-byte tokens compare by bytes and still pass only on equality", () => {
    expect(csrfMatches("töken-1", "töken-1", "töken-1")).toBe(true);
    expect(csrfMatches("töken-1", "töken-1", "töken-2")).toBe(false);
  });
});
