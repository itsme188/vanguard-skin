/**
 * Persistent settings store for Electron app.
 * Simple JSON file in the app's user data directory.
 * Replaces .env.local for the packaged app.
 */

import { app, safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface AppSettings {
  anthropicApiKey?: string;
  ibkrAccountCode?: string;
  twsHost?: string;
  twsPort?: number;
  autoConnectTws?: boolean;
  gmailAddress?: string;
  gmailAppPassword?: string;
  /** Resend API key — outbound email (briefing/digest/earnings). Inbound IMAP still uses gmailAddress/gmailAppPassword. */
  resendApiKey?: string;
  /** Verified Resend domain — local-part is set per-call ("briefing", "digest", "earnings"). */
  resendFromDomain?: string;
  briefingEmailTo?: string;
  fredApiKey?: string;
  edgarContactEmail?: string;
  apiNinjasKey?: string;
  /** Alpha Vantage key — earnings call transcripts (free tier, 25 req/day). */
  alphaVantageApiKey?: string;
  pushoverAppToken?: string;
  pushoverUserKey?: string;
  /**
   * Base URL for the "Open in dashboard" deep link inside Pushover notifications.
   * When phone is on the Cloudflare One mesh, default to `http://100.96.0.1:3099`
   * (same target as MESH_HOSTNAME). Falls back to localhost if unset — which
   * only works on the Mac itself and produces a "Safari can't connect"
   * dead-end when tapped from the phone (observed 2026-05-14 mid-travel).
   */
  pushoverLinkBase?: string;
  // Cloudflare AI Gateway — when both accountId + gatewayId are set, every
  // Claude / OpenAI / Workers AI call routes through Cloudflare for
  // observability, caching, and per-feature cost tracking.
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  cloudflareGatewayToken?: string;
  cloudflareWorkersAIToken?: string;
  openaiApiKey?: string;
  // ── Keys migrated off the bundled .env.local (2026-06-16) ──────────────────
  // Previously the packaged server read these straight from the bundled
  // Resources/standalone/.env.local (Next auto-loads from cwd). That shipped
  // every secret inside the DMG. These are now injected from settings.json like
  // the rest; see bootstrapFromEnvLocal's idempotent backfill + main.ts.
  /** Shared secret for X-Cron-Secret on /api/cron/* routes + Worker marker calls. */
  cronSharedSecret?: string;
  /** Finnhub key — per-held-stock earnings calendar sync. */
  finnhubApiKey?: string;
  /** Gmail OAuth (inbound newsletter ingestion via googleapis). */
  googleClientId?: string;
  googleClientSecret?: string;
  googleRefreshToken?: string;
  /** Cloudflare R2 (statement PDF archival). R2_ACCOUNT_ID falls back to cloudflareAccountId. */
  r2AccessKeyId?: string;
  r2BucketName?: string;
  r2SecretAccessKey?: string;
  /** Worker /internal/marker URL — Mac pre-flights cloud-sent dedup markers. */
  workerMarkerUrl?: string;
  /** Plaid client ID — linked banking account sync (optional). */
  plaidClientId?: string;
  /** Plaid secret key — linked banking account sync (optional). */
  plaidSecret?: string;
  /** Plaid environment — sandbox, development, or production. */
  plaidEnv?: string;
  /** Plaid OAuth redirect URI — for account linking flow. */
  plaidRedirectUri?: string;
  /** Auto-refresh interval in minutes. 0 = disabled. Default: 30. */
  refreshIntervalMinutes?: number;
  firstRunComplete?: boolean;
}

const DEFAULTS: AppSettings = {
  twsHost: "127.0.0.1",
  twsPort: 7496,
  autoConnectTws: true,
  refreshIntervalMinutes: 30,
  firstRunComplete: false,
};

function getSettingsPath(): string {
  // During app startup, app.getPath may not be available yet
  try {
    return path.join(app.getPath("userData"), "settings.json");
  } catch {
    return path.join(process.env.HOME || "~", ".vanguard-skin-settings.json");
  }
}

function readFile(): AppSettings {
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf-8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeFile(settings: AppSettings): void {
  const dir = path.dirname(getSettingsPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
}

export function getSettings(): AppSettings {
  return readFile();
}

export function saveSettings(updates: Partial<AppSettings>): void {
  const current = readFile();
  const merged = { ...current, ...updates };
  writeFile(merged);
}

/**
 * Single source mapping each .env.local key to its AppSettings field. Used for
 * BOTH the first-run import and the always-runs backfill. All values are
 * strings (twsHost/twsPort/booleans are not env-bootstrapped).
 *
 * WORKER_GMAIL_* are intentionally absent — the Mac server reads none of them
 * (they're Cloudflare Worker secrets used only by `wrangler deploy`).
 */
const ENV_TO_SETTING: Array<[string, keyof AppSettings]> = [
  ["ANTHROPIC_API_KEY", "anthropicApiKey"],
  ["IBKR_ACCOUNT_CODE", "ibkrAccountCode"],
  ["GMAIL_ADDRESS", "gmailAddress"],
  ["GMAIL_APP_PASSWORD", "gmailAppPassword"],
  ["RESEND_API_KEY", "resendApiKey"],
  ["RESEND_FROM_DOMAIN", "resendFromDomain"],
  ["BRIEFING_EMAIL_TO", "briefingEmailTo"],
  ["FRED_API_KEY", "fredApiKey"],
  ["EDGAR_CONTACT_EMAIL", "edgarContactEmail"],
  ["API_NINJAS_API_KEY", "apiNinjasKey"],
  ["ALPHA_VANTAGE_API_KEY", "alphaVantageApiKey"],
  ["PUSHOVER_APP_TOKEN", "pushoverAppToken"],
  ["PUSHOVER_USER_KEY", "pushoverUserKey"],
  ["PUSHOVER_LINK_BASE", "pushoverLinkBase"],
  ["CLOUDFLARE_ACCOUNT_ID", "cloudflareAccountId"],
  ["CLOUDFLARE_GATEWAY_ID", "cloudflareGatewayId"],
  ["CLOUDFLARE_GATEWAY_TOKEN", "cloudflareGatewayToken"],
  ["CLOUDFLARE_WORKERS_AI_TOKEN", "cloudflareWorkersAIToken"],
  ["OPENAI_API_KEY", "openaiApiKey"],
  // Migrated off the bundled .env.local (2026-06-16) — see AppSettings comment.
  ["CRON_SHARED_SECRET", "cronSharedSecret"],
  ["FINNHUB_API_KEY", "finnhubApiKey"],
  ["GOOGLE_CLIENT_ID", "googleClientId"],
  ["GOOGLE_CLIENT_SECRET", "googleClientSecret"],
  ["GOOGLE_REFRESH_TOKEN", "googleRefreshToken"],
  ["R2_ACCESS_KEY_ID", "r2AccessKeyId"],
  ["R2_BUCKET_NAME", "r2BucketName"],
  ["R2_SECRET_ACCESS_KEY", "r2SecretAccessKey"],
  ["WORKER_MARKER_URL", "workerMarkerUrl"],
  ["PLAID_CLIENT_ID", "plaidClientId"],
  ["PLAID_SECRET", "plaidSecret"],
  ["PLAID_ENV", "plaidEnv"],
  ["PLAID_REDIRECT_URI", "plaidRedirectUri"],
];

function parseEnvFile(envPath: string): Record<string, string> {
  const envMap: Record<string, string> = {};
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    envMap[key] = val;
  }
  return envMap;
}

/**
 * Import API keys from the project's .env.local into settings.json so the
 * packaged app never needs the bundled .env.local (which used to ship every
 * secret inside the DMG — fixed 2026-06-16).
 *
 * Two passes, both reading the dev-repo `~/code/vanguard-skin/.env.local`:
 *  - FIRST RUN (firstRunComplete unset): import every mapped key present.
 *  - EVERY RUN (idempotent backfill): seed any mapped setting that is currently
 *    absent/empty. This lets an existing install pick up newly-migrated keys
 *    (the 9 added 2026-06-16) on the next launch without re-entering anything,
 *    and never overwrites a value the user edited in Settings.
 */
export function bootstrapFromEnvLocal(): void {
  const current = readFile();
  const isFirstRun = !current.firstRunComplete;

  const envPath = path.join(
    process.env.HOME || "/Users/Yitzi",
    "code", "vanguard-skin", ".env.local"
  );

  if (!fs.existsSync(envPath)) {
    // No dev .env.local (e.g. a fresh Mac without the repo). Still mark first
    // run done so we don't probe every launch; the user enters keys in Settings.
    if (isFirstRun) saveSettings({ firstRunComplete: true });
    return;
  }

  const envMap = parseEnvFile(envPath);
  const updates: Record<string, string | boolean> = {};
  for (const [envKey, settingKey] of ENV_TO_SETTING) {
    const val = envMap[envKey];
    if (!val) continue;
    const existing = current[settingKey];
    // First run imports everything; later runs only fill gaps (backfill).
    if (isFirstRun || existing === undefined || existing === "") {
      updates[settingKey] = val;
    }
  }
  if (isFirstRun) updates.firstRunComplete = true;

  if (Object.keys(updates).length > 0) {
    saveSettings(updates as Partial<AppSettings>);
    const action = isFirstRun ? "imported" : "backfilled";
    console.log(`[settings] ${action} ${Object.keys(updates).length} key(s) from .env.local`);
  }
}

export function getSanitizedSettings(): Record<string, string | number | boolean> {
  const s = getSettings();
  return {
    anthropicApiKey: s.anthropicApiKey ? "***" + s.anthropicApiKey.slice(-4) : "",
    ibkrAccountCode: s.ibkrAccountCode ?? "",
    twsHost: s.twsHost ?? "127.0.0.1",
    twsPort: s.twsPort ?? 7496,
    gmailAddress: s.gmailAddress ?? "",
    gmailAppPassword: s.gmailAppPassword ? "****" : "",
    resendApiKey: s.resendApiKey ? "***" + s.resendApiKey.slice(-4) : "",
    resendFromDomain: s.resendFromDomain ?? "",
    briefingEmailTo: s.briefingEmailTo ?? "",
    fredApiKey: s.fredApiKey ? "***" + s.fredApiKey.slice(-4) : "",
    edgarContactEmail: s.edgarContactEmail ?? "",
    apiNinjasKey: s.apiNinjasKey ? "***" + s.apiNinjasKey.slice(-4) : "",
    alphaVantageApiKey: s.alphaVantageApiKey ? "***" + s.alphaVantageApiKey.slice(-4) : "",
    pushoverAppToken: s.pushoverAppToken ? "***" + s.pushoverAppToken.slice(-4) : "",
    pushoverUserKey: s.pushoverUserKey ? "***" + s.pushoverUserKey.slice(-4) : "",
    pushoverLinkBase: s.pushoverLinkBase ?? "",
    cloudflareAccountId: s.cloudflareAccountId ?? "",
    cloudflareGatewayId: s.cloudflareGatewayId ?? "",
    cloudflareGatewayToken: s.cloudflareGatewayToken ? "***" + s.cloudflareGatewayToken.slice(-4) : "",
    cloudflareWorkersAIToken: s.cloudflareWorkersAIToken ? "***" + s.cloudflareWorkersAIToken.slice(-4) : "",
    openaiApiKey: s.openaiApiKey ? "***" + s.openaiApiKey.slice(-4) : "",
    // Migrated off bundled .env.local (2026-06-16). Secrets → ***last4; the
    // OAuth client id, R2 bucket name, and marker URL are not secret → plain.
    cronSharedSecret: s.cronSharedSecret ? "***" + s.cronSharedSecret.slice(-4) : "",
    finnhubApiKey: s.finnhubApiKey ? "***" + s.finnhubApiKey.slice(-4) : "",
    googleClientId: s.googleClientId ?? "",
    googleClientSecret: s.googleClientSecret ? "***" + s.googleClientSecret.slice(-4) : "",
    googleRefreshToken: s.googleRefreshToken ? "***" + s.googleRefreshToken.slice(-4) : "",
    r2AccessKeyId: s.r2AccessKeyId ? "***" + s.r2AccessKeyId.slice(-4) : "",
    r2BucketName: s.r2BucketName ?? "",
    r2SecretAccessKey: s.r2SecretAccessKey ? "***" + s.r2SecretAccessKey.slice(-4) : "",
    workerMarkerUrl: s.workerMarkerUrl ?? "",
    plaidClientId: s.plaidClientId ?? "",
    plaidSecret: s.plaidSecret ? "***" + s.plaidSecret.slice(-4) : "",
    plaidEnv: s.plaidEnv ?? "",
    plaidRedirectUri: s.plaidRedirectUri ?? "",
    hasAnthropicKey: !!s.anthropicApiKey,
    hasCloudflareGateway: !!(s.cloudflareAccountId && s.cloudflareGatewayId),
    autoConnectTws: s.autoConnectTws ?? true,
    refreshIntervalMinutes: s.refreshIntervalMinutes ?? 30,
    firstRunComplete: s.firstRunComplete ?? false,
  };
}

// ─── Encrypted secrets (#35 auth boundary, 2026-08-14) ──────────────────────
//
// A small set of secrets — the app PASSWORD HASH and the ELECTRON-MAIN
// SERVICE CREDENTIAL used by later tasks in the #35 boundary — must never
// live in plaintext settings.json. They are stored OS-keychain-encrypted via
// Electron's `safeStorage`, in a SEPARATE file (secrets.json) outside the
// `AppSettings` interface entirely. This is deliberate, not just "another
// key we forget to sanitize":
//   - `getSanitizedSettings()` (the IPC `get-settings` surface) enumerates
//     explicit AppSettings fields, so a stray key added to AppSettings could
//     theoretically leak by omission of masking. A separate file makes that
//     class of bug structurally impossible — there is no AppSettings field
//     to read from in the first place.
//   - `save-settings` (IPC, renderer-writable) calls `saveSettings()`, which
//     merges into settings.json only. It has no path to secrets.json, so a
//     compromised/buggy renderer call can never overwrite or read a secret.
//
// Fail-closed: every accessor checks `safeStorage.isEncryptionAvailable()`
// first and THROWS if it's false (locked/unsupported keychain) — never a
// silent plaintext fallback.

interface EncryptedSecretsFile {
  [key: string]: string; // base64(safeStorage.encryptString(value))
}

function getSecretsPath(): string {
  try {
    return path.join(app.getPath("userData"), "secrets.json");
  } catch {
    return path.join(process.env.HOME || "~", ".vanguard-skin-secrets.json");
  }
}

function readSecretsFile(): EncryptedSecretsFile {
  try {
    const raw = fs.readFileSync(getSecretsPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSecretsFile(secrets: EncryptedSecretsFile): void {
  const dir = path.dirname(getSecretsPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getSecretsPath(), JSON.stringify(secrets, null, 2));
}

function assertEncryptionAvailable(key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      `[settings] Cannot access encrypted secret "${key}": OS keychain encryption ` +
        `is unavailable (safeStorage.isEncryptionAvailable() === false). Refusing ` +
        `to read or write it in plaintext — unlock the keychain and retry.`,
    );
  }
}

/**
 * Read a secret stored via `setEncryptedSecret`. Returns `null` if the key
 * was never set. Throws (fail-closed) if OS keychain encryption is
 * unavailable — never returns an unprotected value.
 */
export function getEncryptedSecret(key: string): string | null {
  assertEncryptionAvailable(key);
  const secrets = readSecretsFile();
  const stored = secrets[key];
  if (stored === undefined) return null;
  return safeStorage.decryptString(Buffer.from(stored, "base64"));
}

/**
 * Encrypt `value` via the OS keychain and persist it under `key` in
 * secrets.json (never in settings.json / AppSettings). Throws (fail-closed)
 * if OS keychain encryption is unavailable — never falls back to plaintext.
 */
export function setEncryptedSecret(key: string, value: string): void {
  assertEncryptionAvailable(key);
  const secrets = readSecretsFile();
  secrets[key] = safeStorage.encryptString(value).toString("base64");
  writeSecretsFile(secrets);
}

/**
 * Return the existing decrypted secret for `key`, or generate a new 256-bit
 * random secret (hex-encoded), persist it encrypted, and return it. Stable
 * across calls — once created, the same secret is returned every time.
 * Throws (fail-closed) if OS keychain encryption is unavailable.
 */
export function loadOrCreateSecret(key: string): string {
  const existing = getEncryptedSecret(key); // fail-closed guard runs here first
  if (existing !== null) return existing;
  const generated = crypto.randomBytes(32).toString("hex");
  setEncryptedSecret(key, generated);
  return generated;
}
