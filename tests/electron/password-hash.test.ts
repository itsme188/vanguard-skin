import { describe, it, expect } from "vitest";
import {
  hashPassword as electronHash,
  verifyPassword as electronVerify,
} from "@/electron/password-hash";
import {
  hashPassword as libHash,
  verifyPassword as libVerify,
} from "@/lib/auth/credentials";

// Packaged-app trust boundary (#35, task 15) — parity/drift test for the
// Electron-side scrypt hasher.
//
// WHY A DUPLICATE EXISTS: Electron main cannot cleanly import
// `lib/auth/credentials.ts` — electron/tsconfig.json pins `rootDir: "."` +
// `include: ["*.ts"]`, so any `../lib` import lands outside rootDir (the same
// constraint that forced the cookie-name duplication in task 14's
// bootstrap-auth.ts). The scrypt hasher is therefore duplicated ONCE in
// electron/password-hash.ts, and this test proves the two implementations are
// cross-compatible: a hash minted on one side must verify on the other, or the
// packaged app would provision a first-run hash the login route cannot check.

describe("electron/password-hash parity with lib/auth/credentials", () => {
  it("a hash minted by the Electron hasher verifies via the lib verifier", () => {
    const stored = electronHash("correct horse battery staple");
    expect(libVerify("correct horse battery staple", stored)).toBe(true);
    expect(libVerify("wrong password", stored)).toBe(false);
  });

  it("a hash minted by the lib hasher verifies via the Electron verifier", () => {
    const stored = libHash("hunter2-is-a-bad-password");
    expect(electronVerify("hunter2-is-a-bad-password", stored)).toBe(true);
    expect(electronVerify("nope", stored)).toBe(false);
  });

  it("emits the same stored format `scrypt$<saltHex>$<hashHex>`", () => {
    const stored = electronHash("x");
    const parts = stored.split("$");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("scrypt");
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/); // 16-byte salt
    expect(parts[2]).toMatch(/^[0-9a-f]{64}$/); // 32-byte key
  });

  it("the Electron verifier rejects malformed stored values without throwing", () => {
    expect(electronVerify("x", "not-a-hash")).toBe(false);
    expect(electronVerify("x", "scrypt$zz$zz")).toBe(false);
    expect(electronVerify("x", "")).toBe(false);
  });
});
