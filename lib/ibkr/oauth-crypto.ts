/**
 * IBKR OAuth 1.0a crypto core (Mac / Node runtime — Tier 2).
 *
 * Pure, dependency-light building blocks for the headless first-party OAuth 1.0a
 * flow against IBKR's Web API (https://api.ibkr.com/v1/api), no Client Portal
 * Gateway and no browser. The live orchestration (request token → live session
 * token → ssodh/init → tickle → signed reads) layers on top of these.
 *
 * Flow these implement (per IBKR oauth.pdf + OAuth-1.0a-Extended):
 *   - percentEncode / buildSignatureBaseString — OAuth 1.0a signature base string
 *   - dhModPow — Diffie-Hellman challenge (2^x mod p) AND shared secret (B^x mod p)
 *   - computePrepend — RSA PKCS1v1.5 decrypt of the access-token-secret (the
 *     "prepend"); CONSTANT for a given (access_token_secret, encryption key), so
 *     the Worker (Tier 3) can use a precomputed value instead of RSA-decrypting.
 *   - computeLiveSessionToken — HMAC-SHA1(DH shared secret, prepend) → LST (base64)
 *   - signRequestHmac — per-request HMAC-SHA256(base64-decoded LST, base string)
 *   - signLstRequest — RSA-SHA256 signature for the live_session_token request
 *
 * WebCrypto note (Tier 3): every op here except computePrepend (RSA PKCS1v1.5
 * decrypt, which WebCrypto lacks) is reproducible in a Cloudflare Worker. Since
 * the prepend is constant, precompute it on the Mac and ship it as a Worker
 * secret — the Worker then needs only BigInt modexp + WebCrypto RSA-SHA256/HMAC.
 */

import crypto from "node:crypto";

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** RFC 3986 percent-encoding (uppercase hex; only A-Za-z0-9-._~ pass through). */
export function percentEncode(str: string): string {
  const bytes = Buffer.from(str, "utf8");
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (b < 128 && UNRESERVED.test(ch)) {
      out += ch;
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/**
 * OAuth 1.0a signature base string: `METHOD&pctEncode(baseUrl)&pctEncode(params)`
 * where params are sorted by key, each key/value percent-encoded, joined with &.
 */
export function buildSignatureBaseString(
  method: string,
  baseUrl: string,
  params: Record<string, string>,
): string {
  const normalized = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  return `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(normalized)}`;
}

/** Modular exponentiation over BigInt. */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/**
 * Diffie-Hellman power: `base^exp mod modulus`, all hex in/out. Used for both
 * the DH challenge (base="2") and the shared secret (base=server response).
 * Output is even-length hex so it round-trips through Buffer.from(hex).
 */
export function dhModPow(baseHex: string, expHex: string, modHex: string): string {
  const result = modPow(
    BigInt("0x" + baseHex),
    BigInt("0x" + expHex),
    BigInt("0x" + modHex),
  );
  let hex = result.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  return hex;
}

/**
 * Decrypt the IBKR-issued access-token-secret (base64) with our private
 * encryption key (RSA PKCS1 v1.5) to get the "prepend" (hex). Constant for a
 * fixed (secret, key) pair — compute once, reuse forever.
 */
export function computePrepend(
  accessTokenSecretB64: string,
  privateEncryptionPem: string,
): string {
  const decrypted = crypto.privateDecrypt(
    { key: privateEncryptionPem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(accessTokenSecretB64, "base64"),
  );
  return decrypted.toString("hex");
}

/**
 * Live Session Token = HMAC-SHA1 keyed by the DH shared secret over the prepend
 * bytes, base64. (Caller supplies the shared secret already formatted — incl.
 * any sign-byte handling — as hex.)
 */
export function computeLiveSessionToken(sharedSecretHex: string, prependHex: string): string {
  return crypto
    .createHmac("sha1", Buffer.from(sharedSecretHex, "hex"))
    .update(Buffer.from(prependHex, "hex"))
    .digest("base64");
}

/** Per-request signature: HMAC-SHA256 keyed by the base64-decoded LST. */
export function signRequestHmac(liveSessionTokenB64: string, baseString: string): string {
  return crypto
    .createHmac("sha256", Buffer.from(liveSessionTokenB64, "base64"))
    .update(baseString, "utf8")
    .digest("base64");
}

/** RSA-SHA256 signature over the base string with the private signature key. */
export function signLstRequest(baseString: string, privateSignaturePem: string): string {
  return crypto
    .sign("sha256", Buffer.from(baseString, "utf8"), privateSignaturePem)
    .toString("base64");
}
