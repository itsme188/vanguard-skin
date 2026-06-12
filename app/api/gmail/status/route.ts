import { NextRequest } from "next/server";
import { isGmailConfigured, verifyGmailConnection } from "@/lib/gmail/auth";

/**
 * GET /api/gmail/status — Check Gmail OAuth connection status.
 *
 * `?check=config` answers from env vars only (no live Google round-trip) —
 * used by useResearchSync's pre-flight so an unconfigured install doesn't
 * fire a doomed sync POST on every Research-tab mount.
 */
export async function GET(req: NextRequest) {
  if (new URL(req.url).searchParams.get("check") === "config") {
    return Response.json({ connected: isGmailConfigured() });
  }

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
