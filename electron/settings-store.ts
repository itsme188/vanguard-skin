/**
 * Persistent settings store for Electron app.
 * Simple JSON file in the app's user data directory.
 * Replaces .env.local for the packaged app.
 */

import { app } from "electron";
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
 * On first launch, import API keys from the project's .env.local file
 * so the user doesn't have to re-enter them in the Settings Modal.
 */
export function bootstrapFromEnvLocal(): void {
  const current = readFile();
  if (current.firstRunComplete) return; // Already set up

  const envPath = path.join(
    process.env.HOME || "/Users/Yitzi",
    "code", "vanguard-skin", ".env.local"
  );

  if (!fs.existsSync(envPath)) return;

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

  const updates: Partial<AppSettings> = { firstRunComplete: true };
  if (envMap.ANTHROPIC_API_KEY) updates.anthropicApiKey = envMap.ANTHROPIC_API_KEY;
  if (envMap.IBKR_ACCOUNT_CODE) updates.ibkrAccountCode = envMap.IBKR_ACCOUNT_CODE;
  if (envMap.GMAIL_ADDRESS) updates.gmailAddress = envMap.GMAIL_ADDRESS;
  if (envMap.GMAIL_APP_PASSWORD) updates.gmailAppPassword = envMap.GMAIL_APP_PASSWORD;
  if (envMap.RESEND_API_KEY) updates.resendApiKey = envMap.RESEND_API_KEY;
  if (envMap.RESEND_FROM_DOMAIN) updates.resendFromDomain = envMap.RESEND_FROM_DOMAIN;
  if (envMap.BRIEFING_EMAIL_TO) updates.briefingEmailTo = envMap.BRIEFING_EMAIL_TO;
  if (envMap.FRED_API_KEY) updates.fredApiKey = envMap.FRED_API_KEY;
  if (envMap.EDGAR_CONTACT_EMAIL) updates.edgarContactEmail = envMap.EDGAR_CONTACT_EMAIL;
  if (envMap.API_NINJAS_API_KEY) updates.apiNinjasKey = envMap.API_NINJAS_API_KEY;
  if (envMap.ALPHA_VANTAGE_API_KEY) updates.alphaVantageApiKey = envMap.ALPHA_VANTAGE_API_KEY;
  if (envMap.PUSHOVER_APP_TOKEN) updates.pushoverAppToken = envMap.PUSHOVER_APP_TOKEN;
  if (envMap.PUSHOVER_USER_KEY) updates.pushoverUserKey = envMap.PUSHOVER_USER_KEY;
  if (envMap.PUSHOVER_LINK_BASE) updates.pushoverLinkBase = envMap.PUSHOVER_LINK_BASE;
  if (envMap.CLOUDFLARE_ACCOUNT_ID) updates.cloudflareAccountId = envMap.CLOUDFLARE_ACCOUNT_ID;
  if (envMap.CLOUDFLARE_GATEWAY_ID) updates.cloudflareGatewayId = envMap.CLOUDFLARE_GATEWAY_ID;
  if (envMap.CLOUDFLARE_GATEWAY_TOKEN) updates.cloudflareGatewayToken = envMap.CLOUDFLARE_GATEWAY_TOKEN;
  if (envMap.CLOUDFLARE_WORKERS_AI_TOKEN) updates.cloudflareWorkersAIToken = envMap.CLOUDFLARE_WORKERS_AI_TOKEN;
  if (envMap.OPENAI_API_KEY) updates.openaiApiKey = envMap.OPENAI_API_KEY;

  saveSettings(updates);
  console.log("[settings] Bootstrapped from .env.local — API keys imported");
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
    hasAnthropicKey: !!s.anthropicApiKey,
    hasCloudflareGateway: !!(s.cloudflareAccountId && s.cloudflareGatewayId),
    autoConnectTws: s.autoConnectTws ?? true,
    refreshIntervalMinutes: s.refreshIntervalMinutes ?? 30,
    firstRunComplete: s.firstRunComplete ?? false,
  };
}
