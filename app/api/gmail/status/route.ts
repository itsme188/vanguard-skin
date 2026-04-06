import { isGmailConfigured, verifyGmailConnection } from "@/lib/gmail/auth";

/**
 * GET /api/gmail/status — Check Gmail OAuth connection status.
 */
export async function GET() {
  if (!isGmailConfigured()) {
    return Response.json({
      connected: false,
      reason: "Gmail OAuth not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env.local",
    });
  }

  try {
    const email = await verifyGmailConnection();
    return Response.json({ connected: true, email });
  } catch (err) {
    return Response.json({
      connected: false,
      reason: err instanceof Error ? err.message : "Connection failed",
    });
  }
}
