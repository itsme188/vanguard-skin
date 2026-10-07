import { db } from "@/lib/db";
import { getSentEarningsEmails } from "@/lib/queries/earnings-emails";

export const dynamic = "force-dynamic";

/**
 * GET /api/earnings/emails — archive listing of completed earnings email
 * sends, newest-first, for the alerts "Emails" tab. Optional ?symbol=
 * (family-aware) and ?limit=. In-app (no cron auth), same envelope shape as
 * /api/earnings/conflicts list mode.
 *
 * Each row also says whether its calendar entry was later replaced
 * (`event_superseded`) and, when it was, where the live entry's email is
 * (`replacement`). That is a per-row decoration: `count` is the list's own
 * length, so the number and the rows cannot disagree. There is no separate
 * count-only query on this route; if one is ever added it must reuse
 * getSentEarningsEmails' predicate and limit.
 * Spec: docs/superpowers/specs/2026-07-28-earnings-email-archive-design.md
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const symbol = url.searchParams.get("symbol") ?? undefined;
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit =
      Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    const emails = getSentEarningsEmails(db, { symbol, limit });
    return Response.json({ success: true, count: emails.length, emails });
  } catch {
    return Response.json({ success: false, count: 0, emails: [] });
  }
}
