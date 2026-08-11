import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";

// ── Earnings date cross-check reconciliation ────────────────────────
//
// After Finnhub + Nasdaq have both written their earnings rows, this pass
// clusters each held/watchlist name's rows (one cluster per reporting event)
// and resolves a single canonical date + a trust status, marking the losers
// `superseded` so every reader (Hub, today/upcoming releases, week-ahead,
// earnings-email candidate finder) shows exactly one row per event.
//
// Resolution priority (see docs/superpowers/specs/2026-06-08-earnings-date-crosscheck-design.md):
//   1. a user_confirmed / manual row → locked canonical (never reverted)
//   2. a past date WITH reported actuals → it demonstrably happened, wins silently
//   3. both sources agree → confirmed
//   4. both future, dates differ → conflict (Nasdaq provisional, awaits the user)
//   5. only one source → single

const GATHER_BACK_DAYS = 21;
const GATHER_FWD_DAYS = 30;
const CLUSTER_PROXIMITY_DAYS = 14;

export interface ReconcileResult {
  confirmed: number;
  conflict: number;
  single: number;
  userConfirmed: number;
}

interface EarningsRow {
  id: number;
  source: string;
  symbol: string | null;
  event_date: string;
  raw_json: string | null;
  actual_value: string | null;
  date_status: string | null;
  consensus_estimate: string | null;
  consensus_value: string | null;
  reaction_snapshot: string | null;
  enriched_at: string | null;
}

function addDaysUTC(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db_ = new Date(b + "T00:00:00Z").getTime();
  return Math.abs(Math.round((da - db_) / 86_400_000));
}

/** Canonical family key so dual-class siblings (GOOG/GOOGL) share a cluster. */
function familyKey(symbol: string | null): string {
  if (!symbol) return "";
  return issuerSiblings(symbol)
    .map((s) => s.toUpperCase())
    .sort()[0];
}

function hasActual(row: EarningsRow): boolean {
  if (row.actual_value != null && row.actual_value !== "") return true;
  try {
    const a = JSON.parse(row.raw_json ?? "{}")?.entry?.epsActual;
    return a != null;
  } catch {
    return false;
  }
}

interface Resolution {
  canonicalId: number;
  status: "confirmed" | "conflict" | "single" | "user_confirmed";
  conflictWith: string | null;
}

/**
 * A manual FUTURE row must never compete with a print that already happened
 * (qa:today-earningshub-add-ticker--manual-future-event-supersedes-reported-quarter):
 * pre-split, a "+ Add ticker" row up to CLUSTER_PROXIMITY_DAYS from the real
 * print joined its cluster and won rung 1, superseding the reported quarter and
 * migrating its actual/reaction/sent-email audit rows onto the future event —
 * deleting the phantom then destroyed the audit trail via ON DELETE CASCADE.
 *
 * Split such a cluster in two: the reported rows resolve on their own (rung 2
 * keeps the print canonical with all its data), and the manual row anchors the
 * remaining future rows as its own event. Mirrors correctEarningsEventDate's
 * refusal to touch rows with captured actuals. A manual row that IS the
 * reported print (verifier/user correction post-print) keeps the whole cluster.
 */
function splitReportedFromManualCluster(
  cluster: EarningsRow[],
  today: string,
): EarningsRow[][] {
  const manual = cluster.find(
    (r) => r.source === "manual" || r.date_status === "user_confirmed",
  );
  if (!manual) return [cluster];
  const isReported = (r: EarningsRow) => r.event_date < today && hasActual(r);
  if (isReported(manual)) return [cluster];
  const reported = cluster.filter(isReported);
  if (reported.length === 0) return [cluster];
  return [reported, cluster.filter((r) => !isReported(r))];
}

/** Resolve one cluster of rows (all referring to the same reporting event). */
function resolveCluster(rows: EarningsRow[], today: string): Resolution {
  // 1. A user-confirmed / manual row is authoritative and locked.
  const manual = rows.find(
    (r) => r.source === "manual" || r.date_status === "user_confirmed",
  );
  if (manual) {
    return { canonicalId: manual.id, status: "user_confirmed", conflictWith: null };
  }

  // 2. A past date with reported actuals demonstrably happened — it wins.
  const occurred = rows
    .filter((r) => r.event_date < today && hasActual(r))
    .sort((a, b) => b.event_date.localeCompare(a.event_date));
  if (occurred.length > 0) {
    return { canonicalId: occurred[0].id, status: "confirmed", conflictWith: null };
  }

  // Rows arrive date-sorted ASC, so find-first picks the OLDEST claim per
  // source. A wrong-date prior-quarter row exactly CLUSTER_PROXIMITY_DAYS
  // before the real print clusters with it and must not shadow the current
  // claim (NBIS 2026-08-10: finnhub 07-29 phantom vs finnhub+nasdaq 08-12
  // agreeing — find-first manufactured a conflict between agreeing sources).
  const finnhubRows = rows.filter((r) => r.source === "finnhub");
  const nasdaqRows = rows.filter((r) => r.source === "nasdaq");

  // 3 & 4. Both calendars present.
  if (finnhubRows.length > 0 && nasdaqRows.length > 0) {
    // Agreement-first: ANY finnhub/nasdaq pair sharing a date is a
    // confirmation. Keep Finnhub canonical (richer raw_json/history that
    // the earnings-email composer already relies on); supersede the rest.
    for (const n of nasdaqRows) {
      const agreeing = finnhubRows.find((f) => f.event_date === n.event_date);
      if (agreeing) {
        return { canonicalId: agreeing.id, status: "confirmed", conflictWith: null };
      }
    }
    // Genuine disagreement → Nasdaq provisional, flagged for the user to
    // confirm vs IBKR — against the LATEST finnhub claim, never a phantom.
    const latestFinnhub = finnhubRows[finnhubRows.length - 1];
    return {
      canonicalId: nasdaqRows[0].id,
      status: "conflict",
      conflictWith: `finnhub:${latestFinnhub.event_date}`,
    };
  }

  // 5. Single source.
  const only = finnhubRows[0] ?? nasdaqRows[0] ?? rows[0];
  return { canonicalId: only.id, status: "single", conflictWith: null };
}

/**
 * Reconcile all held/watchlist earnings rows in a window around `today`.
 * Pure given `today`; idempotent (re-running yields the same marks); never
 * mutates a user_confirmed/manual cluster's canonical date.
 */
export function reconcileEarningsDates(
  db: Database.Database,
  opts: { today: string },
): ReconcileResult {
  const { today } = opts;
  const start = addDaysUTC(today, -GATHER_BACK_DAYS);
  const end = addDaysUTC(today, GATHER_FWD_DAYS);

  const rows = db
    .prepare(
      `SELECT id, source, symbol, event_date, raw_json, actual_value, date_status,
              consensus_estimate, consensus_value, reaction_snapshot, enriched_at
       FROM calendar_events
       WHERE event_type = 'earnings' AND event_date BETWEEN ? AND ?
       ORDER BY event_date ASC`,
    )
    .all(start, end) as EarningsRow[];

  // Group by issuer family, then proximity-cluster within each family.
  const byFamily = new Map<string, EarningsRow[]>();
  for (const r of rows) {
    const key = familyKey(r.symbol);
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key)!.push(r);
  }

  const setCanonical = db.prepare(
    "UPDATE calendar_events SET date_status = ?, date_conflict_with = ?, superseded = 0 WHERE id = ?",
  );
  const setSuperseded = db.prepare(
    "UPDATE calendar_events SET superseded = 1, date_status = NULL, date_conflict_with = NULL WHERE id = ?",
  );

  // Supersession is data-preserving (QA 2026-07-02: confirming a conflicted
  // date orphaned consensus, user-entered actuals, sent-email audit rows,
  // bogeys, and skips on the superseded event — the row regressed to
  // "Consensus not yet published" and the sweep cron could re-send a
  // duplicate preview). Enrichment COALESCEs forward onto the canonical
  // (never overwriting its own non-NULL values — same "sync may only ADD
  // data" invariant as the enrichment-runner), and child audit rows re-point
  // — bogeys and recap-phase rows unconditionally, preview-phase rows gated
  // by send-date plausibility (see the repointPreviewEmails/Skips comment
  // below). UPDATE OR IGNORE keeps the canonical's own row on a UNIQUE
  // collision, leaving the superseded-side duplicate in place for audit.
  const carryEnrichment = db.prepare(
    `UPDATE calendar_events SET
       consensus_estimate = COALESCE(consensus_estimate, ?),
       consensus_value = COALESCE(consensus_value, ?),
       actual_value = COALESCE(actual_value, ?),
       reaction_snapshot = COALESCE(reaction_snapshot, ?),
       enriched_at = COALESCE(enriched_at, ?)
     WHERE id = ?`,
  );
  const repointBogeys = db.prepare(
    "UPDATE OR IGNORE earnings_bogeys SET event_id = ? WHERE event_id = ?",
  );
  // Recap rows are written post-print, so wherever they live they genuinely
  // document that row's release — repointing them onto the surviving
  // canonical is just "audit follows the print", unconditional like bogeys.
  const repointRecapEmails = db.prepare(
    "UPDATE OR IGNORE earnings_emails SET event_id = ? WHERE event_id = ? AND phase = 'recap'",
  );
  const repointRecapSkips = db.prepare(
    "UPDATE OR IGNORE earnings_email_skips SET event_id = ? WHERE event_id = ? AND phase = 'recap'",
  );
  // Preview rows are different: a preview is a PROMISE about a specific
  // future release, sent 105-135 minutes before it (PREVIEW_WINDOW_MIN/MAX_MS
  // in enrichment-runner.ts), so a genuine preview's send DATE always equals
  // the event's print date (+/- 1 day for UTC sent_at vs ET event_date). If
  // the row it's currently on gets superseded, only repoint it onto the new
  // canonical when the send date could plausibly have covered THAT event's
  // print (>= print date minus 1 day — later-than-print sends still count,
  // documenting a post-print stale-slot notice). A preview sent for an
  // earlier phantom date has no relationship to a print that resolves later
  // and must stay behind on the superseded row: findEmailCandidates treats
  // ANY existing preview-phase row on an event as "already handled" (`ee.id
  // IS NULL AND es.id IS NULL`), so dragging a stale preview onto the
  // canonical would both fabricate a "preview sent" for a print the email
  // never covered AND permanently block the genuine preview from ever firing
  // (qa/NBIS 2026-08-10: a preview sent for finnhub's 7/29 phantom date got
  // dragged onto the real 8/12 print when reconcile resolved it 14 days
  // later). Superseded rows referenced by earnings_emails are already
  // delete-protected (lib/mutations/calendar.ts
  // deleteUnenrichedEventsForWeek), so leaving the row behind keeps it
  // archived and invisible to canonical readers rather than losing it.
  const repointPreviewEmails = db.prepare(
    `UPDATE OR IGNORE earnings_emails
        SET event_id = ?
      WHERE event_id = ? AND phase = 'preview' AND date(sent_at) >= date(?, '-1 day')`,
  );
  const repointPreviewSkips = db.prepare(
    `UPDATE OR IGNORE earnings_email_skips
        SET event_id = ?
      WHERE event_id = ? AND phase = 'preview' AND date(skipped_at) >= date(?, '-1 day')`,
  );

  const result: ReconcileResult = { confirmed: 0, conflict: 0, single: 0, userConfirmed: 0 };

  const apply = db.transaction(() => {
    for (const familyRows of byFamily.values()) {
      // Greedy proximity clustering (rows already sorted by date).
      const clusters: EarningsRow[][] = [];
      for (const r of familyRows) {
        const last = clusters[clusters.length - 1];
        if (last && daysBetween(last[last.length - 1].event_date, r.event_date) <= CLUSTER_PROXIMITY_DAYS) {
          last.push(r);
        } else {
          clusters.push([r]);
        }
      }

      for (const proximityCluster of clusters) {
      for (const cluster of splitReportedFromManualCluster(proximityCluster, today)) {
        const res = resolveCluster(cluster, today);
        setCanonical.run(res.status, res.conflictWith, res.canonicalId);
        const canonicalEventDate = cluster.find((r) => r.id === res.canonicalId)!.event_date;
        // Freshest-enriched donor first: with several superseded rows, the
        // first non-NULL value per column wins (COALESCE), so order matters.
        const superseded = cluster
          .filter((r) => r.id !== res.canonicalId)
          .sort((a, b) => (b.enriched_at ?? "").localeCompare(a.enriched_at ?? ""));
        for (const r of superseded) {
          setSuperseded.run(r.id);
          carryEnrichment.run(
            r.consensus_estimate,
            r.consensus_value,
            r.actual_value,
            r.reaction_snapshot,
            r.enriched_at,
            res.canonicalId,
          );
          repointBogeys.run(res.canonicalId, r.id);
          repointRecapEmails.run(res.canonicalId, r.id);
          repointRecapSkips.run(res.canonicalId, r.id);
          repointPreviewEmails.run(res.canonicalId, r.id, canonicalEventDate);
          repointPreviewSkips.run(res.canonicalId, r.id, canonicalEventDate);
        }
        if (res.status === "confirmed") result.confirmed++;
        else if (res.status === "conflict") result.conflict++;
        else if (res.status === "single") result.single++;
        else result.userConfirmed++;
      }
      }
    }
  });
  apply();

  return result;
}
