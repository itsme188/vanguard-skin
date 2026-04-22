/**
 * Electron-free settings store shared with the /api/settings dev-mode
 * fallback route. Same JSON file as electron/settings-store.ts (by design —
 * so running `npm run dev` on :3000 mutates the same settings the packaged
 * Electron app reads).
 *
 * The Electron main process still owns the authoritative read/write path
 * via its own module (which imports `electron` and uses app.getPath). This
 * module is intentionally import-safe for Next.js route handlers.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Matches the SettingsStore interface from electron/settings-store.ts. Kept
// in lockstep with that file — any new field added here must also be added
// to the Electron copy (and vice versa). See CLAUDE.md "Electron env-var
// threading for new settings" for the checklist.
export interface AppSettings {
  anthropicApiKey?: string;
  ibkrAccountCode?: string;
  twsHost?: string;
  twsPort?: number;
  autoConnectTws?: boolean;
  gmailAddress?: string;
  gmailAppPassword?: string;
  briefingEmailTo?: string;
  fredApiKey?: string;
  edgarContactEmail?: string;
  apiNinjasKey?: string;
  pushoverAppToken?: string;
  pushoverUserKey?: string;
  cloudflareAccountId?: string;
  cloudflareGatewayId?: string;
  cloudflareGatewayToken?: string;
  cloudflareWorkersAIToken?: string;
  openaiApiKey?: string;
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

/**
 * Path Electron uses for its Application Support dir. On macOS this matches
 * `app.getPath("userData")` for an app named "Vanguard Dashboard". Non-Mac
 * platforms fall back to ~/.vanguard-skin-settings.json — same fallback
 * Electron uses when `app` isn't available yet.
 */
export function getFallbackSettingsPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Vanguard Dashboard",
      "settings.json",
    );
  }
  return path.join(home, ".vanguard-skin-settings.json");
}

function readFile(): AppSettings {
  try {
    const raw = fs.readFileSync(getFallbackSettingsPath(), "utf-8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeFile(settings: AppSettings): void {
  const p = getFallbackSettingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
}

export function getSettings(): AppSettings {
  return readFile();
}

export function saveSettings(updates: Partial<AppSettings>): AppSettings {
  const current = readFile();
  const merged = { ...current, ...updates };
  writeFile(merged);
  return merged;
}

/** Sanitized view suitable for returning over HTTP — secrets are masked. */
export function getSanitizedSettings(): Record<string, string | number | boolean> {
  const s = getSettings();
  return {
    anthropicApiKey: s.anthropicApiKey ? "***" + s.anthropicApiKey.slice(-4) : "",
    ibkrAccountCode: s.ibkrAccountCode ?? "",
    twsHost: s.twsHost ?? "127.0.0.1",
    twsPort: s.twsPort ?? 7496,
    gmailAddress: s.gmailAddress ?? "",
    gmailAppPassword: s.gmailAppPassword ? "****" : "",
    briefingEmailTo: s.briefingEmailTo ?? "",
    fredApiKey: s.fredApiKey ? "***" + s.fredApiKey.slice(-4) : "",
    edgarContactEmail: s.edgarContactEmail ?? "",
    apiNinjasKey: s.apiNinjasKey ? "***" + s.apiNinjasKey.slice(-4) : "",
    pushoverAppToken: s.pushoverAppToken ? "***" + s.pushoverAppToken.slice(-4) : "",
    pushoverUserKey: s.pushoverUserKey ? "***" + s.pushoverUserKey.slice(-4) : "",
    cloudflareAccountId: s.cloudflareAccountId ?? "",
    cloudflareGatewayId: s.cloudflareGatewayId ?? "",
    cloudflareGatewayToken: s.cloudflareGatewayToken
      ? "***" + s.cloudflareGatewayToken.slice(-4)
      : "",
    cloudflareWorkersAIToken: s.cloudflareWorkersAIToken
      ? "***" + s.cloudflareWorkersAIToken.slice(-4)
      : "",
    openaiApiKey: s.openaiApiKey ? "***" + s.openaiApiKey.slice(-4) : "",
    hasAnthropicKey: !!s.anthropicApiKey,
    hasCloudflareGateway: !!(s.cloudflareAccountId && s.cloudflareGatewayId),
    autoConnectTws: s.autoConnectTws ?? true,
    refreshIntervalMinutes: s.refreshIntervalMinutes ?? 30,
    firstRunComplete: s.firstRunComplete ?? false,
  };
}
