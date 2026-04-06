/**
 * One-time Gmail OAuth setup script.
 *
 * Opens a browser to Google's consent screen, captures the authorization code
 * via a tiny localhost server, exchanges it for a refresh token, and prints
 * the token for pasting into .env.local.
 *
 * Prerequisites:
 *   1. Create a Google Cloud project at https://console.cloud.google.com
 *   2. Enable the Gmail API
 *   3. Create OAuth 2.0 credentials (type: "Desktop app")
 *   4. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local
 *
 * Usage:
 *   npx tsx scripts/gmail-oauth-setup.ts
 */

import fs from "fs";
import path from "path";
import http from "http";
import { exec } from "child_process";
import { getOAuthConsentUrl, exchangeCodeForTokens } from "../lib/gmail/auth";

const PORT = 3456;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// ── Load env ────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (!process.env[key]) process.env[key] = value;
      }
    }
  }
}

loadEnv();

// ── Main ────────────────────────────────────────────────────────────

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("\x1b[31mError:\x1b[0m GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env.local");
  console.error("\nSetup steps:");
  console.error("  1. Go to https://console.cloud.google.com");
  console.error("  2. Create a project (or select existing)");
  console.error("  3. Enable the Gmail API");
  console.error("  4. Go to Credentials → Create Credentials → OAuth client ID");
  console.error("  5. Application type: Desktop app");
  console.error("  6. Copy Client ID and Client Secret into .env.local:");
  console.error("     GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com");
  console.error("     GOOGLE_CLIENT_SECRET=GOCSPX-...");
  console.error("  7. Run this script again");
  process.exit(1);
}

console.log("\n\x1b[1mGmail OAuth Setup\x1b[0m\n");
console.log("This will open your browser to authorize Gmail read access.");
console.log("After granting permission, you'll get a refresh token to add to .env.local.\n");

const consentUrl = getOAuthConsentUrl(clientId, clientSecret, REDIRECT_URI);

// Start a tiny HTTP server to capture the callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h1>Authorization denied</h1><p>${error}</p><p>You can close this tab.</p>`);
      console.error(`\n\x1b[31mAuthorization denied:\x1b[0m ${error}`);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h1>Missing authorization code</h1>");
      return;
    }

    try {
      const { refreshToken } = await exchangeCodeForTokens(
        clientId,
        clientSecret,
        REDIRECT_URI,
        code
      );

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<h1 style="color: green">Gmail connected!</h1>` +
        `<p>Refresh token has been printed to your terminal.</p>` +
        `<p>You can close this tab.</p>`
      );

      console.log("\n\x1b[32m✓ Authorization successful!\x1b[0m\n");
      console.log("Add this to your .env.local:\n");
      console.log(`GOOGLE_REFRESH_TOKEN=${refreshToken}`);
      console.log("\nThen restart the dev server to enable Gmail integration.\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(`<h1>Token exchange failed</h1><p>${msg}</p>`);
      console.error(`\n\x1b[31mToken exchange failed:\x1b[0m ${msg}`);
    }

    server.close();
    // Give the response time to send before exiting
    setTimeout(() => process.exit(0), 500);
  }
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}/callback for OAuth redirect...\n`);
  console.log("Opening browser...");

  // Open browser (macOS)
  exec(`open "${consentUrl}"`, (err) => {
    if (err) {
      console.log("\nCould not open browser automatically. Open this URL manually:");
      console.log(`\n  ${consentUrl}\n`);
    }
  });
});
