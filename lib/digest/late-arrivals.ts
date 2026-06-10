/**
 * late-arrivals.ts — pure helpers for the "just missed the previous email"
 * rescue block.
 *
 * An article is LATE when it was received within `windowMinutes` after the
 * previous email's send time (the composer's sinceDate, which is the
 * last_digest_sent_at ISO timestamp). Late articles lead the next email with
 * an explicit "arrived just after X" note instead of being buried mid-list —
 * this is what rescues TMTB's 8:48 Morning Wrap (vs. the 8:45 send) and a
 * 21:32 Friday EOD Wrap (vs. the 17:30 Friday send).
 *
 * When sinceDate is date-only (manual/cron fallback paths pass YYYY-MM-DD),
 * there is no known send TIME, so nothing is flagged late.
 */

export interface LateArticleLike {
  received_at: string;
  subject: string;
  source_name: string;
  summary: string | null;
  source_url: string | null;
  website_url: string | null;
}

/**
 * Parse either ISO ("2026-06-09T12:48:00.000Z") or SQLite UTC
 * ("2026-06-09 12:48:00") timestamps to epoch millis.
 */
function toUtcMs(ts: string): number {
  if (ts.includes("T")) return Date.parse(ts);
  return Date.parse(ts.replace(" ", "T") + "Z");
}

export function splitLateArrivals<T extends { received_at: string }>(
  articles: T[],
  sinceIso: string,
  windowMinutes = 60,
): { late: T[]; rest: T[] } {
  if (!sinceIso.includes("T")) return { late: [], rest: articles };
  const sinceMs = Date.parse(sinceIso);
  if (Number.isNaN(sinceMs)) return { late: [], rest: articles };
  const cutoffMs = sinceMs + windowMinutes * 60 * 1000;

  const late: T[] = [];
  const rest: T[] = [];
  for (const a of articles) {
    const ms = toUtcMs(a.received_at);
    if (!Number.isNaN(ms) && ms > sinceMs && ms <= cutoffMs) late.push(a);
    else rest.push(a);
  }
  return { late, rest };
}

/**
 * Markdown block for the top of the email. `previousSendLabel` is
 * "this morning's email" (evening) or "yesterday evening's email" (morning).
 * Returns "" when there is nothing late.
 */
export function renderLateArrivalsBlock(
  late: LateArticleLike[],
  previousSendLabel: string,
): string {
  if (late.length === 0) return "";

  const lines: string[] = ["## ⏰ Late arrivals", ""];
  for (const a of late) {
    const etTime = new Date(toUtcMs(a.received_at)).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
    const url = a.source_url || a.website_url;
    const head = url
      ? `**[${a.source_name} — ${a.subject}](${url})**`
      : `**${a.source_name} — ${a.subject}**`;
    lines.push(`${head} *(arrived ${etTime} ET, just after ${previousSendLabel})*`);
    lines.push("");
    if (a.summary) {
      lines.push(a.summary);
      lines.push("");
    }
  }
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}
