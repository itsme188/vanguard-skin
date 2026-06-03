/**
 * IBKR OAuth 1.0a headless client — Cloudflare Worker / WebCrypto port (Tier 3).
 *
 * Mirrors the Mac client (lib/ibkr/oauth-client.ts) but uses WebCrypto + BigInt
 * so it runs in the Worker runtime — letting the cloud briefing/evening pull
 * live IBKR positions/prices when the Mac is asleep.
 *
 * The one op WebCrypto lacks (RSA-PKCS1v1.5 decrypt of the access-token-secret)
 * is NOT needed here: the resulting "prepend" is a constant, shipped as a
 * secret. WebCrypto covers the rest:
 *   - DH challenge / shared secret → BigInt modexp
 *   - LST-request signature        → RSASSA-PKCS1-v1_5 / SHA-256 (subtle.sign)
 *   - LST derivation               → HMAC-SHA1   (subtle)
 *   - per-request signature        → HMAC-SHA256 (subtle)
 *
 * The signature private key is supplied as **PKCS8 DER (base64)** — WebCrypto
 * importKey rejects the PKCS1 form `openssl genrsa` emits.
 */

export interface IbkrWorkerConfig {
  consumerKey: string;
  accessToken: string;
  prepend: string; // hex constant
  dhPrimeHex: string;
  dhGenerator: string; // "2"
  /** base64 of the PKCS8 DER private signature key. */
  signatureKeyPkcs8B64: string;
  baseUrl: string; // https://api.ibkr.com/v1/api
  realm: string; // limited_poa
}

// ── encoding helpers ────────────────────────────────────────────────
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

export function percentEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    out += b < 128 && UNRESERVED.test(ch) ? ch : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

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

function hexToBytes(hex: string): Uint8Array {
  const h = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(str: string): Uint8Array {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── BigInt DH ───────────────────────────────────────────────────────
const ZERO = BigInt(0);
const ONE = BigInt(1);
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = ONE;
  base %= mod;
  while (exp > ZERO) {
    if (exp & ONE) r = (r * base) % mod;
    exp >>= ONE;
    base = (base * base) % mod;
  }
  return r;
}
export function dhModPow(baseHex: string, expHex: string, modHex: string): string {
  const r = modPow(BigInt("0x" + baseHex), BigInt("0x" + expHex), BigInt("0x" + modHex));
  let hex = r.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return hex;
}
/** Even-length hex with a Java-BigInteger sign byte (0x00 if MSB set). */
function toSignedHex(hex: string): string {
  let h = hex.length % 2 ? "0" + hex : hex;
  if (parseInt(h.slice(0, 2), 16) >= 0x80) h = "00" + h;
  return h;
}

// ── WebCrypto primitives ────────────────────────────────────────────
// BufferSource casts: TS 5.7 made Uint8Array generic over its backing buffer,
// so `Uint8Array` no longer trivially satisfies WebCrypto's BufferSource param.
// Runtime is unaffected (these ARE ArrayBuffer-backed) — the cast is type-only.
async function hmac(
  hash: "SHA-1" | "SHA-256",
  keyBytes: Uint8Array,
  msgBytes: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as BufferSource,
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes as unknown as BufferSource);
  return new Uint8Array(sig);
}

export async function signRsaSha256(
  baseString: string,
  pkcs8B64: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    b64decode(pkcs8B64) as unknown as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(baseString) as unknown as BufferSource,
  );
  return b64encode(new Uint8Array(sig));
}

// ── OAuth header ────────────────────────────────────────────────────
function nonce(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(12)));
}
function nowSeconds(): string {
  return Math.floor(Date.now() / 1000).toString();
}
function buildAuthHeader(realm: string, params: Record<string, string>): string {
  const inner = Object.keys(params)
    .sort()
    .map((k) => `${k}="${percentEncode(params[k])}"`)
    .join(", ");
  return `OAuth realm="${realm}", ${inner}`;
}

export interface WorkerLiveSessionToken {
  token: string;
  expirationMs: number;
}

export async function getLiveSessionToken(cfg: IbkrWorkerConfig): Promise<WorkerLiveSessionToken> {
  const random = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
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
  const baseString = cfg.prepend + buildSignatureBaseString("POST", url, params);
  const oauthSignature = await signRsaSha256(baseString, cfg.signatureKeyPkcs8B64);

  const authHeader = buildAuthHeader(cfg.realm, { ...params, oauth_signature: oauthSignature });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "User-Agent": "vanguard-skin-worker/1.0",
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": "0",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`live_session_token HTTP ${res.status}: ${text.slice(0, 300)}`);

  const body = JSON.parse(text) as {
    diffie_hellman_response: string;
    live_session_token_signature: string;
    live_session_token_expiration: number;
  };

  const sharedSecret = toSignedHex(dhModPow(body.diffie_hellman_response, random, cfg.dhPrimeHex));
  const lstBytes = await hmac("SHA-1", hexToBytes(sharedSecret), hexToBytes(cfg.prepend));
  const lst = b64encode(lstBytes);

  const check = bytesToHex(await hmac("SHA-1", b64decode(lst), new TextEncoder().encode(cfg.consumerKey)));
  if (check !== body.live_session_token_signature) {
    throw new Error("Live session token validation failed (signature mismatch)");
  }
  return { token: lst, expirationMs: body.live_session_token_expiration };
}

export async function signedRequest(
  cfg: IbkrWorkerConfig,
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
  const baseString = buildSignatureBaseString(method, url, { ...oauthParams, ...query });
  const sigBytes = await hmac("SHA-256", b64decode(lst), new TextEncoder().encode(baseString));
  oauthParams.oauth_signature = b64encode(sigBytes);

  const authHeader = buildAuthHeader(cfg.realm, oauthParams);
  const qs = Object.keys(query).length
    ? "?" + Object.entries(query).map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join("&")
    : "";
  return fetch(url + qs, {
    method,
    headers: {
      Authorization: authHeader,
      "User-Agent": "vanguard-skin-worker/1.0",
      Accept: "application/json",
    },
  });
}

/** Build config from Worker env (secrets). Returns null when unconfigured. */
export function ibkrConfigFromEnv(env: Record<string, string | undefined>): IbkrWorkerConfig | null {
  const {
    IBKR_CONSUMER_KEY,
    IBKR_ACCESS_TOKEN,
    IBKR_PREPEND,
    IBKR_DH_PRIME,
    IBKR_SIGNATURE_KEY_PKCS8,
  } = env;
  if (!IBKR_CONSUMER_KEY || !IBKR_ACCESS_TOKEN || !IBKR_PREPEND || !IBKR_DH_PRIME || !IBKR_SIGNATURE_KEY_PKCS8) {
    return null;
  }
  return {
    consumerKey: IBKR_CONSUMER_KEY,
    accessToken: IBKR_ACCESS_TOKEN,
    prepend: IBKR_PREPEND,
    dhPrimeHex: IBKR_DH_PRIME,
    dhGenerator: env.IBKR_DH_GENERATOR ?? "2",
    signatureKeyPkcs8B64: IBKR_SIGNATURE_KEY_PKCS8,
    baseUrl: env.IBKR_BASE_URL ?? "https://api.ibkr.com/v1/api",
    realm: env.IBKR_REALM ?? "limited_poa",
  };
}
