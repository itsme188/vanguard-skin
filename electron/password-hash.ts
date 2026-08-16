import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Packaged-app trust boundary (#35, task 15) — DUPLICATE of the scrypt hasher
// in `lib/auth/credentials.ts`, kept in sync by the parity/drift test
// `tests/electron/password-hash.test.ts`.
//
// WHY DUPLICATED, NOT IMPORTED: Electron main runs under electron/tsconfig.json
// with `rootDir: "."` + `include: ["*.ts"]`. Any `import … from "../lib/…"`
// resolves OUTSIDE that rootDir and fails the electron tsc build — the exact
// constraint that forced the cookie-name duplication in task 14's
// bootstrap-auth.ts. A "shared location both can import" is impossible here:
// lib/ is excluded from the electron build (rootDir) and electron/ is excluded
// from the root/Next build (tsconfig `exclude: ["electron", …]`), so neither
// side can host a module the other imports. Duplication guarded by a
// cross-verification test is therefore the correct choice (last resort per the
// task brief), NOT a hand-rolled different KDF: the scrypt params below are
// identical to lib/auth/credentials.ts and the parity test proves a hash minted
// here verifies there and vice-versa. Change one, change both.

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

function scryptHash(plain: string, salt: Buffer): Buffer {
  return scryptSync(plain, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

/** Hashes a plaintext password with a fresh random salt.
 * Stored format: `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptHash(plain, salt);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Verifies a plaintext password against a stored `scrypt$<saltHex>$<hashHex>`
 * value. Constant-time; any malformed stored value returns false rather than
 * throwing. */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const [, saltHex, hashHex] = parts;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;

  const actual = scryptHash(plain, salt);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
