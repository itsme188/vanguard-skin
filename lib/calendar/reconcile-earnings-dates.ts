import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { mergeEarningsEventState } from "@/lib/earnings/event-merge";
import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";
import { notLiveClaimSql } from "@/lib/earnings/email-states";

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
  manual_actuals_at: string | null;
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

/** The columns every resolution step reads. Shared by both gather queries. */
const EARNINGS_ROW_COLUMNS = `id, source, symbol, event_date, raw_json, actual_value, date_status,
        consensus_estimate, consensus_value, reaction_snapshot, enriched_at,
        manual_actuals_at`;

/**
 * Greedy proximity clustering of ONE issuer family's rows (already sorted by
 * event_date ASC): consecutive rows within CLUSTER_PROXIMITY_DAYS of each
 * other describe the same reporting event.
 */
function clusterByProximity(familyRows: EarningsRow[]): EarningsRow[][] {
  const clusters: EarningsRow[][] = [];
  for (const r of familyRows) {
    const last = clusters[clusters.length - 1];
    if (
      last &&
      daysBetween(last[last.length - 1].event_date, r.event_date) <= CLUSTER_PROXIMITY_DAYS
    ) {
      last.push(r);
    } else {
      clusters.push([r]);
    }
  }
  return clusters;
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

/** Child audit rows moved by one repoint hop. */
export interface RepointCounts {
  bogeys: number;
  emails: number;
  skips: number;
}

/**
 * Build the ONE implementation of "move an earnings row's dependent audit rows
 * onto another row". Both callers share it: the reconcile pass below (donor =
 * a row it just superseded) and `repointDependentsBeforeDelete` (donor = a row
 * about to be DELETEd, whose children would otherwise CASCADE away).
 *
 * Bogeys and recap-phase rows repoint UNCONDITIONALLY. A bogey is the user's
 * own uploaded numbers for the issuer's print; a recap is written post-print,
 * so wherever it lives it genuinely documents that release — audit follows the
 * print.
 *
 * Preview rows are different: a preview is a PROMISE about a specific future
 * release, sent 105-135 minutes before it (PREVIEW_WINDOW_MIN/MAX_MS in
 * enrichment-runner.ts), so a genuine preview's send DATE always equals the
 * event's print date (+/- 1 day for UTC sent_at vs ET event_date). Only
 * repoint one when the send date could plausibly have covered the TARGET's
 * print (>= print date minus 1 day — later-than-print sends still count,
 * documenting a post-print stale-slot notice). A preview sent for an earlier
 * phantom date has no relationship to a print that resolves later and must
 * stay behind: findEmailCandidates treats ANY existing preview-phase row on an
 * event as "already handled" (`ee.id IS NULL AND es.id IS NULL`), so dragging
 * a stale preview onto the target would both fabricate a "preview sent" for a
 * print the email never covered AND permanently block the genuine preview from
 * ever firing (qa/NBIS 2026-08-10: a preview sent for finnhub's 7/29 phantom
 * date got dragged onto the real 8/12 print when reconcile resolved it 14 days
 * later).
 *
 * UPDATE OR IGNORE keeps the target's own row on a UNIQUE (event_id, phase)
 * collision, leaving the donor-side duplicate where it is. When the donor is
 * merely SUPERSEDED that leaves the leftover archived and invisible to
 * canonical readers (superseded rows referenced by earnings_emails are
 * delete-protected — see deleteUnenrichedEventsForWeek); when the donor is
 * being deleted the leftover dies with it, which is the deliberate price of
 * the preview invariant.
 */
function createDependentRepointer(db: Database.Database) {
  const repointBogeys = db.prepare(
    "UPDATE OR IGNORE earnings_bogeys SET event_id = ? WHERE event_id = ?",
  );
  // A LIVE CLAIM is either of two values — `error = 'in_progress'` (claimed,
  // composing, claimEarningsEmailSlot in lib/digest/send-earnings-email.ts) or
  // `error = 'sending'` (the provider call is on the wire). A delete/reconcile
  // racing either must never move the row onto the target event out from under
  // the sender. earnings_emails.error is a five-value state column
  // (lib/earnings/email-states.ts) and every reader already excludes both live
  // values; this writer follows the same rule, through the same helper.
  const repointRecapEmails = db.prepare(
    `UPDATE OR IGNORE earnings_emails
        SET event_id = ?
      WHERE event_id = ? AND phase = 'recap'
        AND ${notLiveClaimSql("error")}`,
  );
  const repointRecapSkips = db.prepare(
    "UPDATE OR IGNORE earnings_email_skips SET event_id = ? WHERE event_id = ? AND phase = 'recap'",
  );
  const repointPreviewEmails = db.prepare(
    `UPDATE OR IGNORE earnings_emails
        SET event_id = ?
      WHERE event_id = ? AND phase = 'preview' AND date(sent_at) >= date(?, '-1 day')
        AND ${notLiveClaimSql("error")}`,
  );
  const repointPreviewSkips = db.prepare(
    `UPDATE OR IGNORE earnings_email_skips
        SET event_id = ?
      WHERE event_id = ? AND phase = 'preview' AND date(skipped_at) >= date(?, '-1 day')`,
  );

  return function repoint(
    fromEventId: number,
    toEventId: number,
    toEventDate: string,
  ): RepointCounts {
    return {
      bogeys: repointBogeys.run(toEventId, fromEventId).changes,
      emails:
        repointRecapEmails.run(toEventId, fromEventId).changes +
        repointPreviewEmails.run(toEventId, fromEventId, toEventDate).changes,
      skips:
        repointRecapSkips.run(toEventId, fromEventId).changes +
        repointPreviewSkips.run(toEventId, fromEventId, toEventDate).changes,
    };
  };
}

export interface HandBackResult extends RepointCounts {
  /** The row the children were handed to; null when the row has no twin. */
  targetId: number | null;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

/**
 * Hand an earnings row's dependent audit rows to the row that will become
 * canonical once it is GONE — call this BEFORE the DELETE, in the same
 * transaction.
 *
 * `earnings_bogeys` / `earnings_emails` / `earnings_email_skips` all declare
 * `ON DELETE CASCADE` on event_id (migrations 042/043/045), so deleting an
 * earnings row silently destroys the user's uploaded bogeys and the sent-email
 * audit trail hanging off it. That matters most on exactly the rows a delete
 * targets: a reconcile pass MOVES those children onto whichever row it makes
 * canonical, so the manual "+ Add ticker" row a user later removes, and the
 * provisional vendor row a user later corrects, are precisely where the whole
 * cluster's audit has accumulated. Losing a preview-phase row also re-opens
 * the print as a findEmailCandidates candidate — a duplicate-send risk, not
 * just missing history.
 *
 * The target is resolved through the same clustering + `resolveCluster` rules
 * the post-delete reconcile pass will apply, so the children land where that
 * pass would have put them anyway; if the pass then supersedes the target for
 * some other reason it carries them onward through the same repoint helper.
 * No-ops (targetId null) when the row is not an earnings row, has no symbol,
 * has no dependents, or has no surviving twin in its cluster.
 */
export function repointDependentsBeforeDelete(
  db: Database.Database,
  opts: { eventId: number; today: string },
): HandBackResult {
  const none: HandBackResult = { targetId: null, bogeys: 0, emails: 0, skips: 0 };

  const doomed = db
    .prepare(
      `SELECT ${EARNINGS_ROW_COLUMNS}
         FROM calendar_events
        WHERE id = ? AND event_type = 'earnings'`,
    )
    .get(opts.eventId) as EarningsRow | undefined;
  if (!doomed) return none;

  const key = familyKey(doomed.symbol);
  if (!key) return none;

  // Live print v2 slice A: the arm, its prepare-step ledger and its scan
  // ledger are dependents too — mergeEarningsEventState (called by the delete
  // paths with the targetId resolved here) hands them to the survivor. Without
  // them in this count an ARMED row that happens to carry no bogeys/emails
  // returns targetId=null, and the arm dies with the row while the print
  // survives. Registry-handler tables (slice B's print state) hang off armed
  // events, so the flag count covers them transitively.
  const dependents = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM earnings_bogeys WHERE event_id = ?)
            + (SELECT COUNT(*) FROM earnings_emails WHERE event_id = ?)
            + (SELECT COUNT(*) FROM earnings_email_skips WHERE event_id = ?)
            + (SELECT COUNT(*) FROM earnings_worksheet_flags WHERE event_id = ?)
            + (SELECT COUNT(*) FROM earnings_prepare_steps WHERE event_id = ?)
            + (SELECT COUNT(*) FROM earnings_bogey_scans WHERE event_id = ?) AS n`,
    )
    .get(
      opts.eventId,
      opts.eventId,
      opts.eventId,
      opts.eventId,
      opts.eventId,
      opts.eventId,
    ) as { n: number };
  if (dependents.n === 0) return none;

  // The reconciler's own gather window, widened so a doomed row parked outside
  // it (a manual date months out) still gathers its cluster.
  const lo = minDate(
    addDaysUTC(opts.today, -GATHER_BACK_DAYS),
    addDaysUTC(doomed.event_date, -CLUSTER_PROXIMITY_DAYS),
  );
  const hi = maxDate(
    addDaysUTC(opts.today, GATHER_FWD_DAYS),
    addDaysUTC(doomed.event_date, CLUSTER_PROXIMITY_DAYS),
  );

  const familyRows = (
    db
      .prepare(
        `SELECT ${EARNINGS_ROW_COLUMNS}
           FROM calendar_events
          WHERE event_type = 'earnings' AND event_date BETWEEN ? AND ?
          ORDER BY event_date ASC`,
      )
      .all(lo, hi) as EarningsRow[]
  ).filter((r) => familyKey(r.symbol) === key);

  const cluster = clusterByProximity(familyRows).find((c) =>
    c.some((r) => r.id === doomed.id),
  );
  const survivors = (cluster ?? []).filter((r) => r.id !== doomed.id);
  if (survivors.length === 0) return none;

  // Resolve the surviving rows exactly as the post-delete pass will — which
  // means RE-CLUSTERING them first. The doomed row can be the proximity BRIDGE
  // that chained two groups into one cluster (finnhub 09-13 → manual 09-14 →
  // nasdaq 09-28: every hop <= 14 days, the ends 15 apart). Resolving the
  // leftovers as one cluster would treat two different prints as a
  // finnhub/nasdaq disagreement and hand the audit to the far row. Splits can
  // also come from splitReportedFromManualCluster (a second manual row beside
  // an already-reported print), so both fan out here and the doomed row's
  // audit goes with the NEAREST resulting print.
  const canonicals = clusterByProximity(survivors)
    .flatMap((group) => splitReportedFromManualCluster(group, opts.today))
    .map((sub) => {
      const res = resolveCluster(sub, opts.today);
      return sub.find((r) => r.id === res.canonicalId)!;
    });
  const target = canonicals.sort(
    (a, b) =>
      daysBetween(a.event_date, doomed.event_date) -
        daysBetween(b.event_date, doomed.event_date) ||
      a.event_date.localeCompare(b.event_date),
  )[0];

  const moved = createDependentRepointer(db)(doomed.id, target.id, target.event_date);
  return { targetId: target.id, ...moved };
}

/**
 * Reconcile all held/watchlist earnings rows in a window around `today`.
 * Pure given `today`; idempotent (re-running yields the same marks); never
 * mutates a user_confirmed/manual cluster's canonical date.
 *
 * `opts.symbols` narrows the pass to the named issuer FAMILIES (dual-class
 * siblings ride along, since the clustering key is the family). It exists so
 * a single-symbol event change — e.g. deleting the manual row that was
 * superseding a vendor date, lib/mutations/calendar.ts::deleteCalendarEvent —
 * can re-resolve just that name's clusters through this one implementation
 * instead of a second, divergent copy of the supersede rules. An omitted or
 * EMPTY list means "no scope" — the whole-window pass sync.ts runs.
 */
export function reconcileEarningsDates(
  db: Database.Database,
  opts: { today: string; symbols?: string[] },
): ReconcileResult {
  const { today } = opts;
  const start = addDaysUTC(today, -GATHER_BACK_DAYS);
  const end = addDaysUTC(today, GATHER_FWD_DAYS);

  const rows = db
    .prepare(
      `SELECT ${EARNINGS_ROW_COLUMNS}
       FROM calendar_events
       WHERE event_type = 'earnings' AND event_date BETWEEN ? AND ?
       ORDER BY event_date ASC`,
    )
    .all(start, end) as EarningsRow[];

  const scopedFamilies =
    opts.symbols && opts.symbols.length > 0
      ? new Set(opts.symbols.map((s) => familyKey(s)).filter((k) => k !== ""))
      : null;

  // Group by issuer family, then proximity-cluster within each family.
  const byFamily = new Map<string, EarningsRow[]>();
  for (const r of rows) {
    const key = familyKey(r.symbol);
    if (scopedFamilies && !scopedFamilies.has(key)) continue;
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
  // via createDependentRepointer — bogeys and recap-phase rows
  // unconditionally, preview-phase rows gated by send-date plausibility (the
  // rules live in that helper's comment, shared with the pre-delete hand-back).
  // manual_actuals_at rides along ONLY with the figure it describes: the
  // desk's acceptance is a statement about one number, so it may land on the
  // canonical when the canonical is about to adopt (or already shows) exactly
  // that actual_value — never when the canonical keeps a different vendor
  // figure the user never saw. SQLite evaluates every RHS against the
  // pre-UPDATE row, so `actual_value IS NULL` here means "about to inherit
  // the donor's". Read-side twin healing (lib/queries/manual-actuals-cluster.ts)
  // is the guarantee; this is defense in depth at the exact write that
  // stranded RBRK's acceptance (QA finding
  // today-week-ahead--accepted-actuals-vanish-after-superseded-twin-flip).
  const carryEnrichment = db.prepare(
    `UPDATE calendar_events SET
       consensus_estimate = COALESCE(consensus_estimate, ?),
       consensus_value = COALESCE(consensus_value, ?),
       manual_actuals_at = CASE
         WHEN actual_value IS NULL OR actual_value = ?
           THEN COALESCE(manual_actuals_at, ?)
         ELSE manual_actuals_at
       END,
       actual_value = COALESCE(actual_value, ?),
       reaction_snapshot = COALESCE(reaction_snapshot, ?),
       enriched_at = COALESCE(enriched_at, ?)
     WHERE id = ?`,
  );
  const repointDependents = createDependentRepointer(db);

  const result: ReconcileResult = { confirmed: 0, conflict: 0, single: 0, userConfirmed: 0 };
  // [C-13] One outbox row per reconcile transaction, only when the merge
  // actually moved something. Already-superseded donors revisited on later
  // syncs report changed:false and write nothing, so the pass stays idempotent
  // at the outbox level too.
  let anyChanged = false;

  const apply = db.transaction(() => {
    for (const familyRows of byFamily.values()) {
      for (const proximityCluster of clusterByProximity(familyRows)) {
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
          // Positional (better-sqlite3 binds `?` only positionally, so the
          // donor's actual_value is passed TWICE — once for the
          // manual_actuals_at CASE test, once for its own COALESCE).
          carryEnrichment.run(
            r.consensus_estimate,
            r.consensus_value,
            r.actual_value,
            r.manual_actuals_at,
            r.actual_value,
            r.reaction_snapshot,
            r.enriched_at,
            res.canonicalId,
          );
          repointDependents(r.id, res.canonicalId, canonicalEventDate);
          // v2 slice A: the repointer moved what it could; the registry merge handles the
          // (source, source_label) collisions it skipped, flags, steps, scans, and B's tables.
          anyChanged ||= mergeEarningsEventState(db, r.id, res.canonicalId).changed;
        }
        if (res.status === "confirmed") result.confirmed++;
        else if (res.status === "conflict") result.conflict++;
        else if (res.status === "single") result.single++;
        else result.userConfirmed++;
      }
      }
    }
    // LAST statement inside the transaction: the arm may have moved onto a new
    // canonical, so the Worker's armed projection has to hear about it — and it
    // has to commit with the moves it describes.
    if (anyChanged) writeArmedEventsOutboxRow(db, { today });
  });
  apply();

  return result;
}
