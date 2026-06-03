/**
 * Tests for the IBKR OAuth 1.0a crypto core (lib/ibkr/oauth-crypto.ts).
 *
 * These are the pieces that can be verified WITHOUT the live API or activated
 * credentials: RFC-3986 percent-encoding, the OAuth signature base string,
 * Diffie-Hellman modexp, HMAC-based Live Session Token derivation + per-request
 * signing, and RSA sign/decrypt round-trips against the locally-generated keys.
 *
 * Reference: IBKR OAuth 1.0a flow (oauth.pdf + Web API OAuth-1.0a-Extended).
 */

import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  percentEncode,
  buildSignatureBaseString,
  dhModPow,
  computeLiveSessionToken,
  signRequestHmac,
  signLstRequest,
  computePrepend,
} from "@/lib/ibkr/oauth-crypto";

describe("percentEncode (RFC 3986)", () => {
  it("leaves unreserved characters untouched", () => {
    expect(percentEncode("abcXYZ0189-._~")).toBe("abcXYZ0189-._~");
  });
  it("encodes space, plus, slash, ampersand, equals", () => {
    expect(percentEncode(" ")).toBe("%20");
    expect(percentEncode("+")).toBe("%2B");
    expect(percentEncode("/")).toBe("%2F");
    expect(percentEncode("&")).toBe("%26");
    expect(percentEncode("=")).toBe("%3D");
  });
  it("uppercases hex digits", () => {
    // 0xC3 0xA9 = é in UTF-8 → %C3%A9 (uppercase)
    expect(percentEncode("é")).toBe("%C3%A9");
  });
});

describe("buildSignatureBaseString", () => {
  it("is METHOD&pctEncode(url)&pctEncode(sorted params)", () => {
    const base = buildSignatureBaseString("GET", "https://api.ibkr.com/v1/api/portfolio/accounts", {
      oauth_consumer_key: "QAJVIHZHI",
      oauth_nonce: "abc",
      oauth_timestamp: "1700000000",
      oauth_token: "TOK",
      oauth_signature_method: "HMAC-SHA256",
    });
    // Params must be sorted by key and joined with & then percent-encoded whole.
    expect(base.startsWith("GET&https%3A%2F%2Fapi.ibkr.com%2Fv1%2Fapi%2Fportfolio%2Faccounts&")).toBe(true);
    // sorted: oauth_consumer_key, oauth_nonce, oauth_signature_method, oauth_timestamp, oauth_token
    const decodedParams = decodeURIComponent(base.split("&").slice(2).join("&"));
    expect(decodedParams).toBe(
      "oauth_consumer_key=QAJVIHZHI&oauth_nonce=abc&oauth_signature_method=HMAC-SHA256&oauth_timestamp=1700000000&oauth_token=TOK",
    );
  });
});

describe("dhModPow (Diffie-Hellman modexp)", () => {
  it("computes 2^10 mod 17 = 4", () => {
    // 1024 mod 17 = 4
    expect(BigInt("0x" + dhModPow("2", "a", "11"))).toBe(4n); // 0x11 = 17, 0xa = 10
  });
  it("matches Node's modPow for large values", () => {
    const prime = BigInt("0x" + "f".repeat(64)); // arbitrary large odd-ish
    const base = 2n;
    const exp = 123456789n;
    const expected = modPowRef(base, exp, prime);
    const got = BigInt("0x" + dhModPow("2", exp.toString(16), prime.toString(16)));
    expect(got).toBe(expected);
  });
});

describe("computeLiveSessionToken (HMAC-SHA1 of prepend keyed by DH shared secret)", () => {
  it("matches a Node HMAC-SHA1 reference", () => {
    const sharedSecretHex = "00ff10"; // leading-zero byte must be preserved
    const prependHex = "deadbeef";
    const expected = crypto
      .createHmac("sha1", Buffer.from(sharedSecretHex, "hex"))
      .update(Buffer.from(prependHex, "hex"))
      .digest("base64");
    expect(computeLiveSessionToken(sharedSecretHex, prependHex)).toBe(expected);
  });
});

describe("signRequestHmac (per-request HMAC-SHA256 keyed by base64-decoded LST)", () => {
  it("matches a Node HMAC-SHA256 reference", () => {
    const lstB64 = Buffer.from("super-secret-lst").toString("base64");
    const baseString = "GET&https%3A%2F%2Fx&a%3D1";
    const expected = crypto
      .createHmac("sha256", Buffer.from(lstB64, "base64"))
      .update(baseString, "utf8")
      .digest("base64");
    expect(signRequestHmac(lstB64, baseString)).toBe(expected);
  });
});

describe("RSA round-trips against the locally-generated keys", () => {
  const dir = "/Users/Yitzi/code/vanguard-skin/data/ibkr-oauth";
  // These keys exist only on the dev machine; skip cleanly in CI.
  const haveKeys = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("node:fs").accessSync(`${dir}/private_signature.pem`);
      return true;
    } catch {
      return false;
    }
  })();

  it.runIf(haveKeys)("RSA-SHA256 signature verifies with the public signature key", () => {
    const fs = require("node:fs");
    const priv = fs.readFileSync(`${dir}/private_signature.pem`, "utf8");
    const pub = fs.readFileSync(`${dir}/public_signature.pem`, "utf8");
    const baseString = "GET&https%3A%2F%2Fapi.ibkr.com&oauth_x%3D1";
    const sigB64 = signLstRequest(baseString, priv);
    const ok = crypto.verify(
      "sha256",
      Buffer.from(baseString, "utf8"),
      pub,
      Buffer.from(sigB64, "base64"),
    );
    expect(ok).toBe(true);
  });

  it.runIf(haveKeys)("computePrepend decrypts what was encrypted to the public encryption key", () => {
    const fs = require("node:fs");
    const priv = fs.readFileSync(`${dir}/private_encryption.pem`, "utf8");
    const pub = fs.readFileSync(`${dir}/public_encryption.pem`, "utf8");
    // IBKR encrypts the access-token-secret to our public encryption key with
    // PKCS1 v1.5; computePrepend reverses that to the plaintext "prepend".
    const plaintext = Buffer.from("the-decrypted-access-token-secret-bytes");
    const encrypted = crypto.publicEncrypt(
      { key: pub, padding: crypto.constants.RSA_PKCS1_PADDING },
      plaintext,
    );
    const prependHex = computePrepend(encrypted.toString("base64"), priv);
    expect(Buffer.from(prependHex, "hex").toString("utf8")).toBe(
      "the-decrypted-access-token-secret-bytes",
    );
  });
});

// Local reference modPow for the test only.
function modPowRef(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}
