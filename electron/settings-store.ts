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
  gmailAddress?: string;
  gmailAppPassword?: string;
  briefingEmailTo?: string;
  fredApiKey?: string;
  edgarContactEmail?: string;
  apiNinjasKey?: string;
}

const DEFAULTS: AppSettings = {
  twsHost: "127.0.0.1",
  twsPort: 7496,
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
    hasAnthropicKey: !!s.anthropicApiKey,
  };
}
