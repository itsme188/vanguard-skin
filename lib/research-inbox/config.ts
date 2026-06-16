/**
 * The dedicated address users forward articles to (U6). Cloudflare Email
 * Routing's `*@myportfoliodesk.com` catch-all already drops anything sent here
 * into the same Gmail the newsletter pipeline reads, so no new MX/routing is
 * required. Overridable via the RESEARCH_INBOX_ADDRESS env var.
 */
export const RESEARCH_INBOX_ADDRESS =
  process.env.RESEARCH_INBOX_ADDRESS?.trim() || "read@myportfoliodesk.com";
