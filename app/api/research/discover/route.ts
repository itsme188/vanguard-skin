import { isGmailConfigured, getGmailClient } from "@/lib/gmail/auth";
import { discoverNewsletterSenders } from "@/lib/gmail/discover";

/** Where the three Google OAuth fields live in the app. */
const SETTINGS_PLACE = "Settings (the gear icon), under Gmail Newsletters";

/**
 * A failure the owner can act on. Google's OAuth error codes are matched by
 * name; the raw error text is never returned or logged, because a transport
 * error can carry the request it failed on.
 */
function discoverFailure(err: unknown): { status: number; error: string } {
  const text = err instanceof Error ? err.message : "";
  if (/invalid_grant/i.test(text)) {
    return {
      status: 502,
      error:
        `Google refused the saved Gmail sign-in: the refresh token has expired or was revoked. ` +
        `Enter a new Google OAuth refresh token in ${SETTINGS_PLACE}, then restart the app.`,
    };
  }
  if (/invalid_client|unauthorized_client|deleted_client/i.test(text)) {
    return {
      status: 502,
      error:
        `Google did not accept the saved OAuth client. Check the Google OAuth client ID and ` +
        `client secret in ${SETTINGS_PLACE}, then restart the app.`,
    };
  }
  return {
    status: 500,
    error: "Gmail could not be searched for newsletter senders. Nothing was changed. Try again.",
  };
}

/**
 * POST /api/research/discover — Search Gmail for newsletter senders.
 * Returns candidate senders sorted by frequency: `{ success: true, data }`.
 * Failures are `{ success: false, error }` and name the Settings fields
 * (Gmail OAuth is inbound newsletter ingestion only; outbound mail is Resend).
 */
export async function POST() {
  if (!isGmailConfigured()) {
    return Response.json(
      {
        success: false,
        error:
          `Gmail is not connected for newsletters. Enter the Google OAuth client ID, client ` +
          `secret and refresh token in ${SETTINGS_PLACE}, then restart the app.`,
      },
      { status: 400 }
    );
  }

  try {
    const gmail = getGmailClient();
    const senders = await discoverNewsletterSenders(gmail);
    return Response.json({ success: true, data: senders });
  } catch (err) {
    const failure = discoverFailure(err);
    // Class name only: the message and the error object can hold request detail.
    console.error(
      `[research/discover] failed (${err instanceof Error ? err.name : "unknown"}, HTTP ${failure.status})`,
    );
    return Response.json({ success: false, error: failure.error }, { status: failure.status });
  }
}
