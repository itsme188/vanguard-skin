/**
 * Phase 4 — one-time OAuth setup for the Cloudflare Worker's Gmail client.
 *
 * Run this AFTER you've created a NEW OAuth 2.0 "Desktop app" client in
 * Google Cloud Console (https://console.cloud.google.com → Credentials) and
 * saved the client ID + secret into .env.local as:
 *
 *   WORKER_GMAIL_CLIENT_ID=...
 *   WORKER_GMAIL_CLIENT_SECRET=...
 *
 * Why a separate client: the existing GOOGLE_CLIENT_ID is used by the Mac
 * newsletter ingestion path (lib/gmail/auth.ts) with only `gmail.readonly`.
 * The Worker needs `gmail.send` too — a fresh client keeps the scopes
 * separated, and the localhost redirect URI doesn't have to be shared.
 *
 * The script opens your browser, captures the OAuth code on a local port,
 * exchanges it for a refresh token, and prints the refresh token. You then
 * run `wrangler secret put WORKER_GMAIL_REFRESH_TOKEN` in workers/cron/ to
 * stash it in the Worker's secret store.
 *
 * Unlike scripts/gmail-oauth-setup.ts, this uses pure fetch (no googleapis
 * dep) because the Worker side needs the same pattern.
 *
 * Usage:
 *   npx tsx scripts/worker-gmail-oauth-setup.ts
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { exec } from "node:child_process";

const PORT = 3457; // distinct from existing 3456 so both scripts can coexist
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    if (!process.env[key]) process.env[key] = m[2].trim();
  }
}

function buildConsentUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForRefreshToken(
  clientId: string,
  clientSecret: string,
  code: string
): Promise<{ refreshToken: string; accessToken: string }> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as {
    refresh_token?: string;
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || json.error) {
    throw new Error(
      `Token exchange failed: ${json.error ?? res.status} ${json.error_description ?? res.statusText}`
    );
  }
  if (!json.refresh_token) {
    throw new Error(
      "No refresh_token returned. You likely already granted consent to this client — " +
        "revoke at https://myaccount.google.com/permissions and re-run."
    );
  }
  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token ?? "",
  };
}

loadEnvLocal();

const clientId = process.env.WORKER_GMAIL_CLIENT_ID;
const clientSecret = process.env.WORKER_GMAIL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "\x1b[31mError:\x1b[0m WORKER_GMAIL_CLIENT_ID and WORKER_GMAIL_CLIENT_SECRET must be in .env.local.\n"
  );
  console.error("Setup:");
  console.error("  1. https://console.cloud.google.com  → Credentials → Create Credentials");
  console.error("  2. Application type: Desktop app");
  console.error("  3. Name it 'Vanguard Cron Worker' (anything — this is for your eyes only)");
  console.error("  4. Copy client ID + secret into .env.local:");
  console.error("       WORKER_GMAIL_CLIENT_ID=...apps.googleusercontent.com");
  console.error("       WORKER_GMAIL_CLIENT_SECRET=GOCSPX-...");
  console.error("  5. Re-run this script.");
  process.exit(1);
}

console.log("\n\x1b[1mPhase 4 Worker Gmail OAuth Setup\x1b[0m\n");
console.log("Scopes: gmail.readonly + gmail.send");
console.log(`Redirect URI: ${REDIRECT_URI}\n`);

const consentUrl = buildConsentUrl(clientId);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>Authorization denied</h1><p>${error}</p>`);
    console.error(`\n\x1b[31mAuthorization denied:\x1b[0m ${error}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(400).end("Missing code");
    return;
  }

  try {
    const { refreshToken } = await exchangeCodeForRefreshToken(
      clientId,
      clientSecret,
      code
    );
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<h1 style="color:#3a7">Worker Gmail connected</h1>` +
        `<p>Refresh token printed to your terminal. You can close this tab.</p>`
    );
    console.log("\n\x1b[32m✓ Authorization successful.\x1b[0m\n");
    console.log("Refresh token (do NOT commit to git — paste into Wrangler secret):\n");
    console.log(`  ${refreshToken}\n`);
    console.log("Next step (from workers/cron/):\n");
    console.log(`  wrangler secret put WORKER_GMAIL_REFRESH_TOKEN`);
    console.log(`  # then paste the token above when prompted\n`);
    server.close();
    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<h1>Token exchange failed</h1><pre>${msg}</pre>`);
    console.error(`\n\x1b[31mToken exchange failed:\x1b[0m ${msg}`);
    server.close();
    setTimeout(() => process.exit(1), 500);
  }
});

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT_URI} for OAuth redirect...\n`);
  console.log("Opening browser...");
  exec(`open "${consentUrl}"`, (err) => {
    if (err) {
      console.log("\nCould not open browser automatically. Open this URL manually:");
      console.log(`\n  ${consentUrl}\n`);
    }
  });
});
