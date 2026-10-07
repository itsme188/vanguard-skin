import type Database from "better-sqlite3";
import type { EmailSendState } from "@/lib/earnings/cockpit-stages";
import {
  notLiveClaimSql,
  sendStateFor,
  DELIVERY_UNKNOWN,
  SENT_BY_CLOUD,
} from "@/lib/earnings/email-states";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { getEmailIgnoredManualTwins } from "@/lib/queries/manual-twin-email";

export interface EarningsEmailAudit {
  id: number;
  event_id: number;
  phase: "preview" | "recap";
  recipient: string;
  sent_at: string;
  ai_input_hash: string | null;
  ai_output_md: string | null;
  error: string | null;
}

/**
 * Single audit row for an (event, phase). Excludes LIVE CLAIM rows — both of
 * them, `'in_progress'` (claimed, composing) and `'sending'` (the provider
 * call is on the wire); the set lives in lib/earnings/email-states.ts and is
 * spelled here by notLiveClaimSql. A claim isn't a sent email, so any reader
 * (the in-app email viewer, in particular) must see "no row" rather than an
 * in-flight/possibly-crashed compose.
 *
 * The two DELIVERED sentinels DO return. A `'sent-by-cloud'` row has
 * `ai_output_md = NULL` (the Worker delivered it; there is no local prose
 * copy). A `'delivery_unknown'` row DOES carry the prose that was composed —
 * we put a message on the wire and never heard back — and the viewer shows
 * that body with the delivery caveat rather than hiding it. Callers branch on
 * `error` (or, better, on sendStateFor(error)) to say which they are looking
 * at.
 */
export function getEmailAudit(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
): EarningsEmailAudit | null {
  return (
    (db
      .prepare(
        `SELECT id, event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error
           FROM earnings_emails
          WHERE event_id = ? AND phase = ?
            AND ${notLiveClaimSql("error")}`,
      )
      .get(eventId, phase) as EarningsEmailAudit | undefined) ?? null
  );
}

export function getEmailAuditsForEvent(
  db: Database.Database,
  eventId: number,
): EarningsEmailAudit[] {
  return db
    .prepare(
      `SELECT id, event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error
         FROM earnings_emails
        WHERE event_id = ?
        ORDER BY phase ASC`,
    )
    .all(eventId) as EarningsEmailAudit[];
}

/**
 * For a list of event_ids, return which phases have been sent.
 * Empty input → empty result. Single round-trip; caller decides
 * which events render which buttons.
 *
 * Excludes LIVE CLAIM rows — `'in_progress'` (mid-compose) and `'sending'`
 * (the provider call is on the wire); see the cross-process send-claim mutex
 * in lib/digest/send-earnings-email.ts, bug B3. Neither has delivered
 * anything yet, so a "sent" chip would be a lie. Both delivered sentinels
 * DO count as sent: `'sent-by-cloud'` (the Worker delivered it) and
 * `'delivery_unknown'` (we may well have delivered it and never learned —
 * counting it as unsent would invite a duplicate).
 */
export function getSentPhasesForEvents(
  db: Database.Database,
  eventIds: number[],
): Record<number, { preview: boolean; recap: boolean }> {
  const out: Record<number, { preview: boolean; recap: boolean }> = {};
  if (eventIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT event_id, phase FROM earnings_emails
        WHERE event_id IN (${eventIds.map(() => "?").join(",")})
          AND ${notLiveClaimSql("error")}`,
    )
    .all(...eventIds) as { event_id: number; phase: "preview" | "recap" }[];
  for (const r of rows) {
    const existing = out[r.event_id] ?? { preview: false, recap: false };
    if (r.phase === "preview") existing.preview = true;
    if (r.phase === "recap") existing.recap = true;
    out[r.event_id] = existing;
  }
  return out;
}

/**
 * Where to look instead, for an email whose calendar entry was later replaced:
 * the LIVE entry for the same company and print, and that entry's own email
 * of the same kind when one was sent.
 */
export interface SupersededEmailReplacement {
  /** The live calendar entry. */
  event_id: number;
  event_date: string;
  /** `sent_at` of the live entry's email of the SAME phase; null when it has
   *  none (a different phase is a different email and is never offered). */
  email_sent_at: string | null;
}

export interface SentEarningsEmail {
  event_id: number;
  phase: "preview" | "recap";
  symbol: string;
  event_date: string;
  sent_at: string;
  /** 1 = Worker-delivered ('sent-by-cloud') — viewer has no local prose copy */
  sent_by_cloud: 0 | 1;
  /** 1 = terminal 'delivery_unknown': the provider's answer was never received.
   *  It IS listed (a body exists), but it is the one row a human must resolve. */
  delivery_unknown: 0 | 1;
  /** 1 = the calendar entry this email was sent for is NOW superseded: a
   *  later reconcile replaced it with another entry for the same print. The
   *  email is real history and stays listed; it is not the print's email. */
  event_superseded: 0 | 1;
  /** Only on an `event_superseded = 1` earnings row, and only when a live
   *  entry for the same print exists. Null otherwise. */
  replacement: SupersededEmailReplacement | null;
}

/**
 * Two earnings rows of one issuer family this many days apart or closer are
 * the same reporting event. This is the reconciler's CLUSTER_PROXIMITY_DAYS
 * (lib/calendar/reconcile-earnings-dates.ts, not exported); the reconciler is
 * the only thing that supersedes a row, so the archive has to look for the
 * live twin across the same span.
 * tests/queries/earnings-emails-superseded.test.ts pins the two together.
 */
export const SUPERSEDED_TWIN_CLUSTER_DAYS = 14;

interface TwinRow {
  id: number;
  event_date: string;
  superseded: number;
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(date + "T00:00:00Z") / 86_400_000);
}

/**
 * The live entry that replaced a superseded earnings row, and its email.
 *
 * `calendar_events` stores no pointer from a superseded row to the row that
 * replaced it, so the twin is found the way the reconciler made it one
 * (`clusterByProximity`): every earnings row of the issuer family, in date
 * order, chained while consecutive rows are within the cluster span. The
 * cluster that holds the superseded row is the print; its live rows are the
 * candidates. The nearest by date wins, the earlier date on a tie (the same
 * order `repointDependentsBeforeDelete` hands audit rows over in), then a row
 * that carries this phase's email, then the lower id.
 *
 * With two live hand-entered rows the reconciler keeps both visible and email
 * follows the EARLIER one (lib/earnings/manual-twin-email.ts), so a pick that
 * rule ignores is swapped for the row email follows.
 *
 * Read-only, and a read of TODAY's state: a row revived tomorrow simply stops
 * being marked.
 */
function createReplacementResolver(db: Database.Database) {
  const emailStmt = db.prepare(
    `SELECT sent_at FROM earnings_emails
      WHERE event_id = ? AND phase = ?
        AND ${notLiveClaimSql("error")}`,
  );
  const emailSentAt = (eventId: number, phase: string): string | null =>
    (emailStmt.get(eventId, phase) as { sent_at: string } | undefined)?.sent_at ?? null;
  const dateStmt = db.prepare(`SELECT event_date FROM calendar_events WHERE id = ?`);
  let ignoredTwins: ReturnType<typeof getEmailIgnoredManualTwins> | null = null;

  return function resolve(
    eventId: number,
    symbol: string,
    phase: "preview" | "recap",
  ): SupersededEmailReplacement | null {
    const family = Array.from(new Set(issuerSiblings(symbol).map((s) => s.toUpperCase())));
    if (family.length === 0) return null;
    const rows = db
      .prepare(
        `SELECT id, event_date, COALESCE(superseded, 0) AS superseded
           FROM calendar_events
          WHERE event_type = 'earnings'
            AND UPPER(symbol) IN (${family.map(() => "?").join(",")})
          ORDER BY event_date ASC, id ASC`,
      )
      .all(...family) as TwinRow[];

    // The reconciler's proximity chain, cut down to the cluster holding this row.
    let cluster: TwinRow[] = [];
    let found = false;
    for (const r of rows) {
      const last = cluster[cluster.length - 1];
      if (
        last &&
        dayNumber(r.event_date) - dayNumber(last.event_date) > SUPERSEDED_TWIN_CLUSTER_DAYS
      ) {
        if (found) break;
        cluster = [];
      }
      cluster.push(r);
      if (r.id === eventId) found = true;
    }
    if (!found) return null;
    const self = cluster.find((r) => r.id === eventId)!;
    const live = cluster.filter((r) => r.superseded === 0 && r.id !== eventId);
    if (live.length === 0) return null;

    const distance = (r: TwinRow) => Math.abs(dayNumber(r.event_date) - dayNumber(self.event_date));
    const pick = [...live].sort(
      (a, b) =>
        distance(a) - distance(b) ||
        a.event_date.localeCompare(b.event_date) ||
        Number(emailSentAt(b.id, phase) != null) - Number(emailSentAt(a.id, phase) != null) ||
        a.id - b.id,
    )[0];

    ignoredTwins ??= getEmailIgnoredManualTwins(db);
    const follows = ignoredTwins.get(pick.id);
    const target = follows
      ? {
          id: follows.emailRowId,
          event_date:
            (dateStmt.get(follows.emailRowId) as { event_date: string } | undefined)?.event_date ??
            follows.emailRowDate,
        }
      : pick;
    return {
      event_id: target.id,
      event_date: target.event_date,
      email_sent_at: emailSentAt(target.id, phase),
    };
  };
}

/**
 * Archive listing of every completed earnings email send, newest-first —
 * backs the alerts "Emails" tab + the Security Detail per-symbol section
 * (spec: docs/superpowers/specs/2026-07-28-earnings-email-archive-design.md).
 * Excludes both LIVE CLAIM values, `'in_progress'` and `'sending'` (the
 * five-value convention in lib/earnings/email-states.ts). A
 * `'delivery_unknown'` row IS listed — an email may well have gone out and a
 * body is stored — but `delivery_unknown = 1` marks it as the one state a
 * human still has to close, by confirming delivery (`markDelivered`) or by
 * refiring. The optional symbol filter is family-aware via issuerSiblings so
 * a GOOG page finds GOOGL events and vice versa.
 *
 * An email whose calendar entry is now superseded stays listed (owner ruling
 * 2026-10-06: honest history, nothing deleted or repointed) and is marked
 * `event_superseded = 1`, with `replacement` naming the live entry for the
 * same print and that entry's email of the same phase. The marking is a
 * per-row decoration applied AFTER the list is selected: it never adds,
 * drops or reorders a row, so any count of this list stays the list's length.
 */
export function getSentEarningsEmails(
  db: Database.Database,
  opts: { symbol?: string; limit?: number } = {},
): SentEarningsEmail[] {
  const limit = opts.limit ?? 500;
  const conditions = [notLiveClaimSql("ee.error")];
  const params: (string | number)[] = [];

  if (opts.symbol) {
    const family = issuerSiblings(opts.symbol).map((s) => s.toUpperCase());
    conditions.push(
      `UPPER(ce.symbol) IN (${family.map(() => "?").join(",")})`,
    );
    params.push(...family);
  }

  const rows = db
    .prepare(
      `SELECT
         ee.event_id, ee.phase, ce.symbol, ce.event_date, ee.sent_at,
         CASE WHEN ee.error = '${SENT_BY_CLOUD}' THEN 1 ELSE 0 END AS sent_by_cloud,
         CASE WHEN ee.error = '${DELIVERY_UNKNOWN}' THEN 1 ELSE 0 END AS delivery_unknown,
         CASE WHEN COALESCE(ce.superseded, 0) = 0 THEN 0 ELSE 1 END AS event_superseded,
         ce.event_type
       FROM earnings_emails ee
       JOIN calendar_events ce ON ce.id = ee.event_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ee.sent_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<
    Omit<SentEarningsEmail, "replacement"> & { event_type: string | null }
  >;

  let resolve: ReturnType<typeof createReplacementResolver> | null = null;
  return rows.map(({ event_type, ...row }) => {
    let replacement: SupersededEmailReplacement | null = null;
    // The twin rule is an earnings rule: a flagged row of any other type is
    // marked but nothing is guessed about what replaced it.
    if (row.event_superseded === 1 && event_type === "earnings" && row.symbol) {
      resolve ??= createReplacementResolver(db);
      replacement = resolve(row.event_id, row.symbol, row.phase);
    }
    return { ...row, replacement };
  });
}

/**
 * Cockpit send-state per (event, phase) INCLUDING live claims — unlike
 * getSentPhasesForEvents/getEmailAudit, which deliberately exclude them.
 *
 * The mapping is sendStateFor (lib/earnings/email-states.ts), which is the
 * LENIENT delivered reading and is deliberately NOT isDeliveredStrict: both
 * live values ('in_progress', 'sending') → 'in-flight', 'sent-by-cloud' →
 * itself, 'delivery_unknown' → 'delivery-unknown', and ANY other historical
 * error string → 'sent' (failure claims are released/deleted by the sweep, so
 * a persistent non-sentinel row means a send that completed). That legacy
 * reading is preserved on purpose — see the two-delivered-questions note in
 * email-states.ts.
 */
export function getEmailStatesForEvents(
  db: Database.Database,
  eventIds: number[],
): Record<number, { preview: EmailSendState; recap: EmailSendState }> {
  const result: Record<number, { preview: EmailSendState; recap: EmailSendState }> = {};
  if (eventIds.length === 0) return result;
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT event_id, phase, error FROM earnings_emails WHERE event_id IN (${placeholders})`,
    )
    .all(...eventIds) as Array<{ event_id: number; phase: "preview" | "recap"; error: string | null }>;
  for (const row of rows) {
    const entry = result[row.event_id] ?? { preview: null, recap: null };
    entry[row.phase] = sendStateFor(row.error);
    result[row.event_id] = entry;
  }
  return result;
}
