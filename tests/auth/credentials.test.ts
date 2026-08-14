import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, hashPin, verifyPin } from "@/lib/auth/credentials";
import { csrfMatches } from "@/lib/auth/csrf";

// Packaged-app trust boundary (#35, task 2) — pure crypto helpers, no DB/HTTP.

describe("hashPassword / verifyPassword", () => {
  it("round-trips: verifyPassword accepts the plaintext that produced the hash", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("produces distinct hashes for the same plaintext (distinct salt per call)", () => {
    const a = hashPassword("x");
    const b = hashPassword("x");
    expect(a).not.toBe(b);
    // but both still verify the same plaintext
    expect(verifyPassword("x", a)).toBe(true);
    expect(verifyPassword("x", b)).toBe(true);
  });

  it("stores in scrypt$<saltHex>$<hashHex> format", () => {
    const stored = hashPassword("hello");
    const parts = stored.split("$");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("scrypt");
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/); // 16-byte salt, hex
    expect(parts[2]).toMatch(/^[0-9a-f]{64}$/); // 32-byte key, hex
  });

  it("rejects malformed stored values instead of throwing", () => {
    expect(verifyPassword("hello", "not-a-valid-format")).toBe(false);
    expect(verifyPassword("hello", "")).toBe(false);
  });
});

describe("hashPin / verifyPin", () => {
  it("round-trips: verifyPin accepts the PIN that produced the hash", () => {
    const stored = hashPin("1234");
    expect(verifyPin("1234", stored)).toBe(true);
  });

  it("rejects a wrong PIN", () => {
    const stored = hashPin("1234");
    expect(verifyPin("4321", stored)).toBe(false);
  });

  it("produces distinct hashes for the same PIN (distinct salt per call)", () => {
    const a = hashPin("0000");
    const b = hashPin("0000");
    expect(a).not.toBe(b);
    expect(verifyPin("0000", a)).toBe(true);
    expect(verifyPin("0000", b)).toBe(true);
  });

  it("is a separate export from the password path (not just an alias)", () => {
    expect(hashPin).not.toBe(hashPassword);
    expect(verifyPin).not.toBe(verifyPassword);
  });
});

describe("csrfMatches", () => {
  it("passes only when header, cookie, and session secret are all equal", () => {
    expect(csrfMatches("secret-abc", "secret-abc", "secret-abc")).toBe(true);
  });

  it("fails when the header token differs", () => {
    expect(csrfMatches("wrong", "secret-abc", "secret-abc")).toBe(false);
  });

  it("fails when the cookie token differs", () => {
    expect(csrfMatches("secret-abc", "wrong", "secret-abc")).toBe(false);
  });

  it("fails when the session secret differs", () => {
    expect(csrfMatches("secret-abc", "secret-abc", "wrong")).toBe(false);
  });

  it("never passes when all three are empty strings", () => {
    expect(csrfMatches("", "", "")).toBe(false);
  });

  it("fails when only some inputs are empty", () => {
    expect(csrfMatches("", "secret-abc", "secret-abc")).toBe(false);
    expect(csrfMatches("secret-abc", "", "secret-abc")).toBe(false);
    expect(csrfMatches("secret-abc", "secret-abc", "")).toBe(false);
  });
});
