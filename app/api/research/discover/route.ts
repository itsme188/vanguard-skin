import { isGmailConfigured, getGmailClient } from "@/lib/gmail/auth";
import { discoverNewsletterSenders } from "@/lib/gmail/discover";

/**
 * POST /api/research/discover — Search Gmail for newsletter senders.
 * Returns candidate senders sorted by frequency.
 */
export async function POST() {
  if (!isGmailConfigured()) {
    return Response.json(
      { error: "Gmail OAuth not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env.local" },
      { status: 400 }
    );
  }

  try {
    const gmail = getGmailClient();
    const senders = await discoverNewsletterSenders(gmail);
    return Response.json({ success: true, data: senders });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Discovery failed" },
      { status: 500 }
    );
  }
}
