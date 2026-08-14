/**
 * Encrypted secret accessors (Task 13, #35 auth boundary): the app is about
 * to store two new secrets on the Mac — the app PASSWORD HASH and the
 * ELECTRON-MAIN SERVICE CREDENTIAL (used by later tasks). Both must live in
 * the OS keychain via Electron `safeStorage`, never in plaintext
 * settings.json, and must never surface through AppSettings, the masked
 * getSanitizedSettings() output, or the IPC get-settings handler (which just
 * returns getSanitizedSettings()).
 *
 * Electron isn't available under Vitest (Node env), so `electron` is
 * mocked here: `app.getPath("userData")` points at a per-test tmp dir, and
 * `safeStorage` is a fake reversible cipher whose availability we can flip
 * per test to exercise the fail-closed guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockState = vi.hoisted(() => ({
  userDataDir: "",
  encryptionAvailable: true,
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return mockState.userDataDir;
      throw new Error(`unexpected app.getPath(${name})`);
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => mockState.encryptionAvailable,
    // Fake reversible "encryption" — good enough to prove round-tripping and
    // to prove the on-disk blob isn't the plaintext value.
    encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`, "utf-8"),
    decryptString: (buf: Buffer) => {
      const str = buf.toString("utf-8");
      if (!str.startsWith("enc:")) throw new Error("bad ciphertext");
      return str.slice(4);
    },
  },
}));

import {
  getEncryptedSecret,
  setEncryptedSecret,
  loadOrCreateSecret,
  rotateSecret,
  getSanitizedSettings,
  getSettings,
} from "@/electron/settings-store";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "encrypted-secrets-test-"));
  mockState.userDataDir = tmpDir;
  mockState.encryptionAvailable = true;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getEncryptedSecret / setEncryptedSecret", () => {
  it("round-trips a value through set then get when encryption is available", () => {
    setEncryptedSecret("appPasswordHash", "hash-value-123");
    expect(getEncryptedSecret("appPasswordHash")).toBe("hash-value-123");
  });

  it("returns null for a key that was never set", () => {
    expect(getEncryptedSecret("neverSetKey")).toBeNull();
  });

  it("stores the encrypted blob on disk, not the plaintext value", () => {
    setEncryptedSecret("appPasswordHash", "super-secret-plain-text");
    const secretsPath = path.join(tmpDir, "secrets.json");
    const raw = fs.readFileSync(secretsPath, "utf-8");
    expect(raw).not.toContain("super-secret-plain-text");

    const parsed = JSON.parse(raw);
    expect(typeof parsed.appPasswordHash).toBe("string");
    // base64 of the mock cipher's "enc:<plaintext>" output
    const expectedBlob = Buffer.from(
      "enc:super-secret-plain-text",
      "utf-8",
    ).toString("base64");
    expect(parsed.appPasswordHash).toBe(expectedBlob);
  });

  it("fails closed: throws instead of returning a value when encryption is unavailable", () => {
    setEncryptedSecret("appPasswordHash", "hash-value-123");
    mockState.encryptionAvailable = false;
    expect(() => getEncryptedSecret("appPasswordHash")).toThrow();
  });

  it("fails closed: throws instead of writing plaintext when encryption is unavailable", () => {
    mockState.encryptionAvailable = false;
    expect(() => setEncryptedSecret("appPasswordHash", "x")).toThrow();

    const secretsPath = path.join(tmpDir, "secrets.json");
    expect(fs.existsSync(secretsPath)).toBe(false);
  });

  it("never falls back to plaintext storage anywhere on disk when encryption is unavailable", () => {
    mockState.encryptionAvailable = false;
    expect(() => setEncryptedSecret("appPasswordHash", "must-never-hit-disk")).toThrow();

    for (const name of fs.readdirSync(tmpDir)) {
      const contents = fs.readFileSync(path.join(tmpDir, name), "utf-8");
      expect(contents).not.toContain("must-never-hit-disk");
    }
  });
});

describe("loadOrCreateSecret", () => {
  it("generates a 256-bit hex secret on first call and returns the SAME value on subsequent calls", () => {
    const first = loadOrCreateSecret("electronMainServiceCredential");
    expect(first).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex-encoded = 64 chars

    const second = loadOrCreateSecret("electronMainServiceCredential");
    expect(second).toBe(first);

    // Persisted across a fresh read (not just an in-memory cache).
    expect(getEncryptedSecret("electronMainServiceCredential")).toBe(first);
  });

  it("generates independent secrets per key", () => {
    const a = loadOrCreateSecret("keyA");
    const b = loadOrCreateSecret("keyB");
    expect(a).not.toBe(b);
  });

  it("fails closed: throws when encryption is unavailable, never generating an unprotected secret", () => {
    mockState.encryptionAvailable = false;
    expect(() => loadOrCreateSecret("anyKey")).toThrow();

    const secretsPath = path.join(tmpDir, "secrets.json");
    expect(fs.existsSync(secretsPath)).toBe(false);
  });
});

describe("rotateSecret (#35 task 17 — credential rotation)", () => {
  it("mints a NEW 256-bit hex secret and OVERWRITES any existing value under the key", () => {
    const original = loadOrCreateSecret("electronServiceCred");
    expect(original).toMatch(/^[0-9a-f]{64}$/);

    const rotated = rotateSecret("electronServiceCred");
    expect(rotated).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated).not.toBe(original);

    // Persisted — a subsequent read (not loadOrCreateSecret, which would just
    // return whatever is stored) sees the rotated value, not the original.
    expect(getEncryptedSecret("electronServiceCred")).toBe(rotated);
  });

  it("works on a key that was never set (first rotation == first mint)", () => {
    const rotated = rotateSecret("neverSetKey");
    expect(rotated).toMatch(/^[0-9a-f]{64}$/);
    expect(getEncryptedSecret("neverSetKey")).toBe(rotated);
  });

  it("each call mints an independent value (no accidental caching)", () => {
    const a = rotateSecret("electronServiceCred");
    const b = rotateSecret("electronServiceCred");
    expect(a).not.toBe(b);
    expect(getEncryptedSecret("electronServiceCred")).toBe(b);
  });

  it("fails closed: throws when encryption is unavailable, never writing an unprotected secret", () => {
    mockState.encryptionAvailable = false;
    expect(() => rotateSecret("electronServiceCred")).toThrow();

    const secretsPath = path.join(tmpDir, "secrets.json");
    expect(fs.existsSync(secretsPath)).toBe(false);
  });
});

describe("leak guard — secrets never surface through the AppSettings surfaces", () => {
  it("getSanitizedSettings() does not contain the secret key or value", () => {
    setEncryptedSecret("appPasswordHash", "hash-value-123");

    const sanitized = getSanitizedSettings();
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("appPasswordHash");
    expect(serialized).not.toContain("hash-value-123");
  });

  it("getSettings() (the raw AppSettings read path) does not contain the secret key or value", () => {
    setEncryptedSecret("appPasswordHash", "hash-value-123");

    const settings = getSettings();
    const serialized = JSON.stringify(settings);
    expect(serialized).not.toContain("appPasswordHash");
    expect(serialized).not.toContain("hash-value-123");
  });

  it("settings.json on disk never contains the secret key or plaintext value", () => {
    setEncryptedSecret("appPasswordHash", "hash-value-123");

    const settingsPath = path.join(tmpDir, "settings.json");
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, "utf-8");
      expect(raw).not.toContain("appPasswordHash");
      expect(raw).not.toContain("hash-value-123");
    }
  });
});
