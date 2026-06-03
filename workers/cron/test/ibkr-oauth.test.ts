/**
 * Tests for the Worker WebCrypto OAuth 1.0a port (src/ibkr-oauth.ts).
 * Proves the crypto matches the Node reference without the live API:
 * percent-encoding, base string, DH modexp, and an RSA-SHA256 sign that
 * verifies against the public key (the live handshake is proven separately
 * via the deployed Worker).
 */

import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  percentEncode,
  buildSignatureBaseString,
  dhModPow,
  signRsaSha256,
} from "../src/ibkr-oauth";

describe("worker ibkr-oauth — WebCrypto port", () => {
  it("percentEncode matches RFC 3986", () => {
    expect(percentEncode(" +/&=")).toBe("%20%2B%2F%26%3D");
    expect(percentEncode("aZ0-._~")).toBe("aZ0-._~");
  });

  it("buildSignatureBaseString sorts params + percent-encodes the whole", () => {
    const b = buildSignatureBaseString(
      "POST",
      "https://api.ibkr.com/v1/api/oauth/live_session_token",
      { oauth_consumer_key: "QAJVIHZHI", b: "2", a: "1" },
    );
    expect(b.startsWith("POST&https%3A%2F%2Fapi.ibkr.com%2Fv1%2Fapi%2Foauth%2Flive_session_token&")).toBe(true);
    const params = decodeURIComponent(b.split("&").slice(2).join("&"));
    expect(params).toBe("a=1&b=2&oauth_consumer_key=QAJVIHZHI");
  });

  it("dhModPow computes 2^10 mod 17 = 4 and matches a large reference", () => {
    expect(BigInt("0x" + dhModPow("2", "a", "11"))).toBe(BigInt(4));
    const prime = BigInt("0x" + "f".repeat(64));
    let ref = BigInt(1);
    let base = BigInt(2) % prime;
    let exp = BigInt(123456789);
    while (exp > BigInt(0)) {
      if (exp & BigInt(1)) ref = (ref * base) % prime;
      exp >>= BigInt(1);
      base = (base * base) % prime;
    }
    expect(BigInt("0x" + dhModPow("2", BigInt(123456789).toString(16), prime.toString(16)))).toBe(ref);
  });

  it("signRsaSha256 produces a signature that verifies with the public key", async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs8B64 = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");
    const baseString = "POST&https%3A%2F%2Fapi.ibkr.com&oauth_x%3D1";

    const sigB64 = await signRsaSha256(baseString, pkcs8B64);

    const ok = crypto.verify(
      "sha256",
      Buffer.from(baseString, "utf8"),
      publicKey,
      Buffer.from(sigB64, "base64"),
    );
    expect(ok).toBe(true);
  });
});
