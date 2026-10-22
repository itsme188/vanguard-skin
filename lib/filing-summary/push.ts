/**
 * Filing-summary pushes (spec §9, hardening 15, R16): one Pushover message per
 * filing per print, at most once. A lost push beats a duplicate, so a failed or
 * delivery-unknown push is never retried. The text carries counts, form and
 * time only: no claim text, quotes, figures or bogey values (R15).
 */

import type Database from "better-sqlite3";
import { sendPushover, type PushoverResult } from "@/lib/alerts/notify-pushover";
import { DELIVERY_UNKNOWN } from "@/lib/earnings/email-states";
import { beginPush, claimPushForSending, markPush } from "./store";
import type { StatusCounts } from "./types";

export interface SummaryPushInput {
  symbol: string;
  form: string;
  role: "earnings" | "companion";
  counts: StatusCounts;
  incomplete: boolean;
  /** Eastern wall time of the filing, e.g. "4:12 pm"; "" when unknown. */
  acceptedAtEt: string;
}

/** "12 claims · 9 checked · 1 contradicted · 2 unconfirmed" (zero parts left out). */
export function pushCountsText(c: StatusCounts): string {
  const parts = [`${c.claims} ${c.claims === 1 ? "claim" : "claims"}`];
  if (c.checked) parts.push(`${c.checked} checked`);
  if (c.contradicted) parts.push(`${c.contradicted} contradicted`);
  if (c.warning) parts.push(`${c.warning} with warnings`);
  if (c.unconfirmed) parts.push(`${c.unconfirmed} unconfirmed`);
  if (c.qualitative) parts.push(`${c.qualitative} qualitative`);
  return parts.join(" · ");
}

export function composeSummaryPush(input: SummaryPushInput): { title: string; message: string } {
  const counts = pushCountsText(input.counts);
  const tail = input.incomplete ? " · incomplete" : "";
  if (input.role === "earnings") {
    return { title: `${input.symbol} filing summary`, message: `${counts}${tail}` };
  }
  const title = [input.symbol, input.form, input.acceptedAtEt].filter(Boolean).join(" · ");
  return { title, message: `adds ${counts}${tail}` };
}

const ET_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "4:12 pm" in Eastern time; "" when the stamp is missing or unreadable. */
export function easternTimeText(acceptedAt: string | null): string {
  if (!acceptedAt) return "";
  const ms = Date.parse(acceptedAt);
  if (!Number.isFinite(ms)) return "";
  return ET_TIME.format(new Date(ms)).replace(/\s?([AP])M$/, (_m, x: string) => ` ${x.toLowerCase()}m`);
}

interface PushSectionRow {
  status: string;
  incomplete: number;
  checked_json: string | null;
  trigger: string;
  event_id: number;
  symbol: string | null;
  cik: string;
  accession: string;
  form: string;
  role: "earnings" | "companion";
  accepted_at: string | null;
}

/**
 * sendPushover swallows network errors into `{sent:false, reason:<message>}`,
 * so only the reasons that prove the request never went out, or that got an
 * HTTP answer, are a plain failure. Anything else may have reached Pushover.
 */
function isExplicitRefusal(reason: string | undefined): boolean {
  return reason === "pushover_not_configured" || /^http_\d+$/.test(reason ?? "");
}

export async function sendSummaryPushIfDue(
  db: Database.Database,
  sectionId: number,
  send: (msg: { title: string; message: string; url: string; urlTitle: string }) => Promise<PushoverResult> = sendPushover,
): Promise<void> {
  const row = db
    .prepare(
      `SELECT s.status, s.incomplete, s.checked_json, r.trigger, r.event_id, e.symbol,
              f.cik, f.accession, f.form, f.role, f.accepted_at
         FROM filing_summary_sections s
         JOIN filing_summary_runs r ON r.id = s.run_id
         JOIN filing_summary_filings f ON f.id = s.filing_id
         JOIN calendar_events e ON e.id = r.event_id
        WHERE s.id = ?`,
    )
    .get(sectionId) as PushSectionRow | undefined;
  if (!row || row.status !== "done" || row.trigger !== "auto" || !row.symbol) return;

  let counts: StatusCounts | undefined;
  try {
    counts = (JSON.parse(row.checked_json ?? "null") as { counts?: StatusCounts } | null)?.counts;
  } catch {
    counts = undefined;
  }
  if (!counts) return;

  const { title, message } = composeSummaryPush({
    symbol: row.symbol,
    form: row.form,
    role: row.role,
    counts,
    incomplete: row.incomplete === 1,
    acceptedAtEt: easternTimeText(row.accepted_at),
  });

  // One push per SEC filing, ever: keyed on the filing, not the event, so an
  // event merge (which moves rows by event id) cannot allow a second send.
  const key = `fs:${row.cik}:${row.accession}`;
  if (!beginPush(db, key, row.event_id, title, message)) return;
  if (!claimPushForSending(db, key)) return;

  const base = process.env.PUSHOVER_LINK_BASE ?? "http://localhost:3099";
  try {
    const res = await send({
      title,
      message,
      url: `${base}/dashboard/print/${row.event_id}/filings`,
      urlTitle: "Open summary",
    });
    markPush(db, key, res.sent ? "sent" : isExplicitRefusal(res.reason) ? "failed" : DELIVERY_UNKNOWN);
  } catch {
    // The message may or may not have left the machine: never resend.
    markPush(db, key, DELIVERY_UNKNOWN);
  }
}
