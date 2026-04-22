/**
 * Settings API for the plain-browser dev fallback. The packaged Electron app
 * uses IPC (via window.electronAPI) and never hits this route. This exists
 * so `npm run dev` on :3000 can surface the SettingsModal without Electron.
 *
 * Gated on NODE_ENV=development — in production the route 404s so a
 * packaged app can never inadvertently expose settings over HTTP (even if
 * someone were to run the standalone server outside Electron).
 */

import { NextRequest } from "next/server";
import {
  getSanitizedSettings,
  saveSettings,
  type AppSettings,
} from "@/lib/settings/file-store";

function devOnly(): boolean {
  return process.env.NODE_ENV === "development";
}

export async function GET() {
  if (!devOnly()) {
    return Response.json({ error: "Not available" }, { status: 404 });
  }
  return Response.json(getSanitizedSettings());
}

export async function POST(req: NextRequest) {
  if (!devOnly()) {
    return Response.json({ error: "Not available" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Body must be an object" }, { status: 400 });
  }

  // Coerce field types the way SettingsModal expects Electron IPC to handle
  // them — numbers for the port + refresh, booleans for toggles, strings for
  // everything else. Unknown keys are dropped to avoid accidental schema
  // creep from the client.
  const ALLOWED: Array<keyof AppSettings> = [
    "anthropicApiKey",
    "ibkrAccountCode",
    "twsHost",
    "twsPort",
    "autoConnectTws",
    "gmailAddress",
    "gmailAppPassword",
    "briefingEmailTo",
    "fredApiKey",
    "edgarContactEmail",
    "apiNinjasKey",
    "pushoverAppToken",
    "pushoverUserKey",
    "cloudflareAccountId",
    "cloudflareGatewayId",
    "cloudflareGatewayToken",
    "cloudflareWorkersAIToken",
    "openaiApiKey",
    "refreshIntervalMinutes",
    "firstRunComplete",
  ];
  const NUMBERS: Array<keyof AppSettings> = ["twsPort", "refreshIntervalMinutes"];
  const BOOLEANS: Array<keyof AppSettings> = ["autoConnectTws", "firstRunComplete"];

  const updates: Partial<AppSettings> = {};
  const source = body as Record<string, unknown>;
  for (const key of ALLOWED) {
    if (!(key in source)) continue;
    const raw = source[key];
    if (NUMBERS.includes(key)) {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (Number.isFinite(n)) (updates as Record<string, unknown>)[key] = n;
    } else if (BOOLEANS.includes(key)) {
      (updates as Record<string, unknown>)[key] = raw === true || raw === "true";
    } else {
      (updates as Record<string, unknown>)[key] =
        typeof raw === "string" ? raw : String(raw ?? "");
    }
  }

  saveSettings(updates);
  return Response.json(getSanitizedSettings());
}
