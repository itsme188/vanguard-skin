import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Packaged-app trust boundary (#35, task 2) — password/PIN hashing.
// Pure crypto: no DB, no HTTP. Stored format is `scrypt$<saltHex>$<hashHex>`.

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

function scryptHash(plain: string, salt: Buffer): Buffer {
  return scryptSync(plain, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

/**
 * Hashes a plaintext secret with a fresh random salt. Same construction is
 * used for both account passwords and numeric PINs — hashPassword/hashPin
 * are separate exports (call sites and intent differ) even though the
 * underlying scrypt parameters are identical.
 */
function hashSecret(plain: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptHash(plain, salt);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * Verifies a plaintext secret against a stored `scrypt$<saltHex>$<hashHex>`
 * value. Constant-time comparison via timingSafeEqual; any malformed stored
 * value (wrong shape, bad hex, wrong length) returns false rather than
 * throwing, so a corrupt/foreign value can never crash the auth path.
 */
function verifySecret(plain: string, stored: string): boolean {
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

export function hashPassword(plain: string): string {
  return hashSecret(plain);
}

export function verifyPassword(plain: string, stored: string): boolean {
  return verifySecret(plain, stored);
}

export function hashPin(plain: string): string {
  return hashSecret(plain);
}

export function verifyPin(plain: string, stored: string): boolean {
  return verifySecret(plain, stored);
}
