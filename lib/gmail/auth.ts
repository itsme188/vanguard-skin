import { google, type gmail_v1 } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

/**
 * Check if Gmail OAuth credentials are configured.
 * Requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN.
 */
export function isGmailConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN
  );
}

/**
 * Create an authenticated Gmail API client using OAuth2 refresh token.
 * The googleapis library handles access token refresh automatically.
 */
export function getGmailClient(): gmail_v1.Gmail {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Gmail OAuth not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env.local"
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

/**
 * Generate the OAuth consent URL for initial setup.
 * Used by scripts/gmail-oauth-setup.ts and the Electron OAuth flow.
 */
export function getOAuthConsentUrl(
  clientId: string,
  clientSecret: string,
  redirectUri: string
): string {
  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
  );
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // Force consent to ensure we get a refresh token
  });
}

/**
 * Exchange an authorization code for tokens.
 * Returns the refresh token (and access token, which is ephemeral).
 */
export async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string
): Promise<{ refreshToken: string; accessToken: string }> {
  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
  );
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh token returned. This can happen if consent was previously granted. " +
        "Revoke access at https://myaccount.google.com/permissions and try again."
    );
  }

  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token || "",
  };
}

/**
 * Verify the Gmail connection works by fetching the user's email address.
 * Returns the email address on success, throws on failure.
 */
export async function verifyGmailConnection(): Promise<string> {
  const gmail = getGmailClient();
  const profile = await gmail.users.getProfile({ userId: "me" });
  return profile.data.emailAddress || "unknown";
}
