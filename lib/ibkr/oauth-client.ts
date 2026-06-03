/**
 * IBKR OAuth 1.0a live client (Mac / Node — Tier 2).
 *
 * Headless first-party flow against https://api.ibkr.com/v1/api — no Gateway,
 * no browser. Orchestrates the crypto core in lib/ibkr/oauth-crypto.ts:
 *
 *   getLiveSessionToken()  POST /oauth/live_session_token
 *     - DH challenge A = g^a mod p
 *     - base string = PREPEND + standard OAuth base string  (prepend-prefixed,
 *       per the IBKR spec + art1c0/ibkr-client reference)
 *     - RSA-SHA256 sign with the private signature key
 *     - K = B^a mod p (server's DH response), sign-byte adjusted (Java
 *       BigInteger.toByteArray semantics) → HMAC-SHA1 key
 *     - LST = HMAC-SHA1(K_bytes, prepend_bytes); validate against the server's
 *       live_session_token_signature = HMAC-SHA1(LST, consumerKey)
 *
 *   signedRequest()  any /iserver|/portfolio read
 *     - oauth params (token-based) + HMAC-SHA256(LST, base string)
 *
 * The brokerage session for /iserver endpoints additionally needs
 * POST /iserver/auth/ssodh/init then a periodic /tickle keep-alive (handled by
 * the caller / session manager).
 */

import crypto from "node:crypto";
import {
  percentEncode,
  buildSignatureBaseString,
  dhModPow,
  computeLiveSessionToken,
  signRequestHmac,
  signLstRequest,
} from "./oauth-crypto";

export interface IbkrOAuthConfig {
  consumerKey: string;
  accessToken: string;
  /** hex; precomputed RSA-PKCS1v1.5 decrypt of the access-token-secret. */
  prepend: string;
  dhPrimeHex: string;
  dhGenerator: string; // "2"
  /** PEM string of the private signature key. */
  signaturePrivatePem: string;
  baseUrl: string; // https://api.ibkr.com/v1/api
  realm?: string; // limited_poa
}

export interface LiveSessionToken {
  token: string; // base64
  expirationMs: number;
}

function nonce(): string {
  return crypto.randomBytes(12).toString("hex");
}
function nowSeconds(): string {
  return Math.floor(Date.now() / 1000).toString();
}

/** Even-length hex with a Java-BigInteger sign byte (0x00 prefix if MSB set). */
function toSignedHex(hex: string): string {
  let h = hex.length % 2 === 1 ? "0" + hex : hex;
  if (parseInt(h.slice(0, 2), 16) >= 0x80) h = "00" + h;
  return h;
}

function buildAuthHeader(
  realm: string,
  params: Record<string, string>,
): string {
  const inner = Object.keys(params)
    .sort()
    .map((k) => `${k}="${percentEncode(params[k])}"`)
    .join(", ");
  return `OAuth realm="${realm}", ${inner}`;
}

/** Perform the live_session_token handshake. Throws with the server body on failure. */
export async function getLiveSessionToken(
  cfg: IbkrOAuthConfig,
): Promise<LiveSessionToken> {
  const random = crypto.randomBytes(32).toString("hex"); // 256-bit DH secret
  const dhChallenge = dhModPow(cfg.dhGenerator, random, cfg.dhPrimeHex);

  const params: Record<string, string> = {
    oauth_consumer_key: cfg.consumerKey,
    oauth_nonce: nonce(),
    oauth_signature_method: "RSA-SHA256",
    oauth_timestamp: nowSeconds(),
    oauth_token: cfg.accessToken,
    diffie_hellman_challenge: dhChallenge,
  };

  const url = `${cfg.baseUrl}/oauth/live_session_token`;
  // Prepend-prefixed base string, RSA-SHA256 signed.
  const baseString = cfg.prepend + buildSignatureBaseString("POST", url, params);
  const oauthSignature = signLstRequest(baseString, cfg.signaturePrivatePem);

  const authHeader = buildAuthHeader(cfg.realm ?? "limited_poa", {
    ...params,
    oauth_signature: oauthSignature,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "User-Agent": "vanguard-skin/1.0",
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": "0",
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`live_session_token HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const body = JSON.parse(text) as {
    diffie_hellman_response: string;
    live_session_token_signature: string;
    live_session_token_expiration: number;
  };

  // K = B^a mod p, sign-byte adjusted → HMAC-SHA1 key for the LST.
  const sharedSecret = toSignedHex(
    dhModPow(body.diffie_hellman_response, random, cfg.dhPrimeHex),
  );
  const lst = computeLiveSessionToken(sharedSecret, cfg.prepend);

  // Validate: HMAC-SHA1(base64decode(LST), consumerKey) hex == server signature.
  const check = crypto
    .createHmac("sha1", Buffer.from(lst, "base64"))
    .update(cfg.consumerKey, "utf8")
    .digest("hex");
  if (check !== body.live_session_token_signature) {
    throw new Error("Live session token validation failed (signature mismatch)");
  }

  return { token: lst, expirationMs: body.live_session_token_expiration };
}

/** Sign + send a token-based (HMAC-SHA256) read request once an LST is held. */
export async function signedRequest(
  cfg: IbkrOAuthConfig,
  lst: string,
  method: string,
  path: string,
  query: Record<string, string> = {},
): Promise<Response> {
  const url = `${cfg.baseUrl}${path}`;
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: cfg.consumerKey,
    oauth_nonce: nonce(),
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: nowSeconds(),
    oauth_token: cfg.accessToken,
  };
  // Base string includes both oauth params and query params, sorted together.
  const baseString = buildSignatureBaseString(method, url, {
    ...oauthParams,
    ...query,
  });
  oauthParams.oauth_signature = signRequestHmac(lst, baseString);

  const authHeader = buildAuthHeader(cfg.realm ?? "limited_poa", oauthParams);
  const qs = Object.keys(query).length
    ? "?" + Object.entries(query).map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join("&")
    : "";

  return fetch(url + qs, {
    method,
    headers: {
      Authorization: authHeader,
      "User-Agent": "vanguard-skin/1.0",
      Accept: "application/json",
    },
  });
}
