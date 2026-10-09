import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { mergeEarningsEventState } from "@/lib/earnings/event-merge";
import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";
import { deliveredSql, notLiveClaimSql } from "@/lib/earnings/email-states";
import { mondayOf, todayET } from "@/lib/calendar/date-utils";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";
import { parseFinnhubFigure } from "@/lib/format/finnhub-figure";

// ── Earnings date cross-check reconciliation ────────────────────────
//
// After Finnhub + Nasdaq have both written their earnings rows, this pass
// clusters each held/watchlist name's rows (one cluster per reporting event)
// and resolves a single canonical date + a trust status, marking the losers
// `superseded` so every reader (Hub, today/upcoming releases, week-ahead,
// earnings-email candidate finder) shows exactly one row per event.
//
// Resolution priority (see docs/superpowers/specs/2026-06-08-earnings-date-crosscheck-design.md):
//   1. a user_confirmed / manual row → locked canonical (never reverted);
//      on ONE date a hand-entered row beats a vendor row the user confirmed
//      (a hand-entered row locks by its SOURCE; the pass never writes
//      `user_confirmed` on a row that does not already carry it — see
//      `lockedStatusFor`)
//   2. a past date WITH reported actuals → it demonstrably happened, wins silently
//   3. both sources agree → confirmed
//   4. both future, dates differ → conflict (Nasdaq provisional, awaits the user)
//   5. only one source → single
// Wherever rows of ONE date compete (rungs 2, 3 and 5), a row carrying an
// explicit before-open / after-close slot beats a row carrying only a vendor
// default (owner ruling 2026-10-08) — see `pickSameDateWinner`.
//
// One exemption to "exactly one row per event" (owner ruling 2026-10-06): two
// HAND-ENTERED rows for one name are never resolved against each other — both
// stay visible and the user deletes one. See `keptManualTwins`. Every row a
// pass does hide is reported in `ReconcileResult.superseded`.

const GATHER_BACK_DAYS = 21;
const GATHER_FWD_DAYS = 30;
const CLUSTER_PROXIMITY_DAYS = 14;

/**
 * One earnings row a reconcile pass newly hid (`superseded` 0 → 1), with a
 * short domain-language reason. Symbol, title and date are public calendar
 * data, so the refresh outcome line may name them.
 */
export interface SupersededEarningsRow {
  eventId: number;
  sourceKey: string;
  symbol: string | null;
  title: string;
  eventDate: string;
  /** The pipeline that owns the hidden row: 'finnhub' | 'nasdaq' | 'manual' | … */
  source: string;
  reason: string;
}

export interface ReconcileResult {
  confirmed: number;
  conflict: number;
  single: number;
  /** Locked rows that carry a confirmation the confirm-date route wrote. */
  userConfirmed: number;
  /**
   * Locked hand-entered rows with NO confirmation on file. The pass leaves
   * their `date_status` empty (owner ruling 2026-09-14: a sync never asserts
   * a human confirmation).
   */
  handEntered: number;
  /**
   * Rows THIS pass hid that were showing before it (owner ruling 2026-10-06:
   * any row a sync supersedes is named in the refresh outcome line). A row
   * already hidden before the pass is not repeated, so a second pass over the
   * same book reports nothing.
   */
  superseded: SupersededEarningsRow[];
  /**
   * Hand-entered rows THIS pass brought back beside a hand-entered twin (they
   * were hidden before it). Only a row dated today or later is ever restored
   * — see the revival guard on `keptManualTwins`.
   */
  restored: SupersededEarningsRow[];
}

interface EarningsRow {
  id: number;
  source: string;
  symbol: string | null;
  event_date: string;
  /**
   * Read ONLY to tell whether the row carries a real before-open /
   * after-close slot (`hasRealSlot`). Vendor rows store null here and keep
   * the slot in `raw_json.entry.hour`; hand-entered rows store the slot word
   * or a clock.
   */
  event_time: string | null;
  raw_json: string | null;
  actual_value: string | null;
  date_status: string | null;
  consensus_estimate: string | null;
  consensus_value: string | null;
  reaction_snapshot: string | null;
  enriched_at: string | null;
  manual_actuals_at: string | null;
  /**
   * `calendar_events.created_at` (migration 013, `NOT NULL DEFAULT
   * datetime('now')`) — WHEN the row was typed, which is what separates a
   * post-print date correction from a phantom future add sitting one day off
   * the print. Typed `| null` for the in-memory hypothetical row the
   * would-supersede dry run appends and for pre-013 shapes; an unknown
   * creation time counts as NO evidence (see `createdOnOrAfter`).
   */
  created_at: string | null;
  /**
   * 1 when the row carries its OWN evidence of being a print that happened —
   * see PRINT_EVIDENCE_SQL. 0 (or absent, for the dry run's hypothetical row)
   * otherwise.
   */
  print_evidence?: number | null;
  /**
   * 1 when the row was already hidden BEFORE this resolution ran. Read by the
   * revival guard (`keptManualTwins`) and by the pass's reporting; no rung of
   * `resolveCluster` looks at it. Absent on the dry run's hypothetical row.
   */
  superseded?: number | null;
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

/**
 * Evidence belt (USER RULING 2026-10-02, QA HIGH earnings-reconcile--printed-
 * user-row-loses-actuals-vendor-twin-resurfaces-sent-emails-read-pending): a
 * `calendar_events` row that owns
 *   - a DELIVERED earnings email (any phase; `deliveredSql` — sent locally or
 *     by the cloud, or delivery_unknown; a live claim is not a delivery), or
 *   - an accepted print sheet (a print_watch line or first-pass callout the
 *     desk accepted)
 * has already been treated as the print by the desk's own outputs, so the
 * reconciler must never call it a phantom nor strip its actuals — doing so
 * leaves the sent emails stranded on it and the vendor twin reads as
 * un-recapped (a duplicate recap went out in production).
 *
 * Every leg requires the evidence to date from the row's OWN print, so an
 * email an older bug DRAGGED onto a phantom (the 2026-09-11 MDB shape) never
 * counts:
 *   - a RECAP only when sent on or after the row's event_date. Recaps go out
 *     up to a few days after a print, so a looser `-1 day` floor would let a
 *     phantom at D+1/D+2 holding the recap of print D pass as evidence and
 *     undo the 09-11 split.
 *   - a PREVIEW only when sent within a day either side of the row's date (a
 *     preview goes out ~2h before the release; ±1 covers UTC sent_at vs ET
 *     event_date).
 *   - an accepted print-sheet line / callout only when accepted on or after
 *     event_date − 1 day (acceptance happens at or after the print; −1 covers
 *     the UTC/ET offset).
 *
 * Correlated on the bare `calendar_events` table name — every gather selects
 * `FROM calendar_events` with no alias, and the phantom-strip UPDATE targets it.
 */
const PRINT_EVIDENCE_SQL = `(
  EXISTS (SELECT 1 FROM earnings_emails pe_ee
           WHERE pe_ee.event_id = calendar_events.id
             AND ${deliveredSql("pe_ee.error")}
             AND (
               (pe_ee.phase = 'recap'
                 AND date(pe_ee.sent_at) >= date(calendar_events.event_date))
               OR (pe_ee.phase = 'preview'
                 AND date(pe_ee.sent_at) BETWEEN date(calendar_events.event_date, '-1 day')
                                             AND date(calendar_events.event_date, '+1 day'))
             ))
  OR EXISTS (SELECT 1 FROM print_watch_prints pe_pp
               JOIN print_watch_lines pe_pl ON pe_pl.print_id = pe_pp.id
              WHERE pe_pp.event_id = calendar_events.id
                AND pe_pl.state = 'accepted'
                AND date(pe_pl.updated_at) >= date(calendar_events.event_date, '-1 day'))
  OR EXISTS (SELECT 1 FROM print_watch_prints pe_pp2
               JOIN print_watch_callouts pe_pc ON pe_pc.print_id = pe_pp2.id
              WHERE pe_pp2.event_id = calendar_events.id
                AND pe_pc.state = 'accepted'
                AND date(COALESCE(pe_pc.accepted_at, pe_pc.updated_at)) >= date(calendar_events.event_date, '-1 day'))
)`;

/** The columns every resolution step reads. Shared by both gather queries. */
const EARNINGS_ROW_COLUMNS = `id, source, symbol, event_date, event_time, raw_json, actual_value, date_status,
        consensus_estimate, consensus_value, reaction_snapshot, enriched_at,
        manual_actuals_at, created_at, ${PRINT_EVIDENCE_SQL} AS print_evidence,
        COALESCE(superseded, 0) AS superseded`;

/**
 * The order every gather hands rows to the resolution steps in. Same-date rows
 * are tie-broken by id so "the first row" means the same thing on every pass
 * and on every machine (the gathers used to sort by date alone, leaving
 * same-date order to the query planner).
 */
const EARNINGS_ROW_ORDER = "ORDER BY event_date ASC, id ASC";

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

/** How far off a reported print a manual date can sit and still describe it. */
const POST_PRINT_CORRECTION_DAYS = 1;

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
 *
 * REGRESSION 1 (qa:today-earningshub-add-ticker--manual-future-event-
 * supersedes-reported-quarter-regression-1, 2026-09-11): "is the manual row
 * itself the print" was decided with the same `hasActual` predicate used for
 * vendor rows — and on a manual row BOTH of its inputs can be vendor-inherited
 * rather than the user's own. `carryEnrichment` below copies a superseded
 * donor's actual_value onto the canonical across any date gap, and the
 * enrichment road (lib/calendar/enrich-actuals.ts, manual source-key → Finnhub
 * symbol+date) writes an actual whenever Finnhub carries an entry on the manual
 * row's own date. So a "+ Add ticker" row dated one day back and nine days from
 * the real print read as "I am the print", the split was skipped, and rung 1
 * dragged the print's recap email and the desk's bogeys onto the phantom (live
 * MDB: manual 09-10 vs the 09-01 print).
 *
 * USER RULING (2026-09-11): the date-proximity leg is a POST-PRINT CORRECTION
 * ONLY. A manual / user_confirmed row is the print ITSELF only on its OWN
 * evidence:
 *   - `manual_actuals_at` — the desk accepted actuals ON THIS ROW
 *     (lib/earnings/actuals.ts::saveManualActuals); or
 *   - its date sits within POST_PRINT_CORRECTION_DAYS of a reported vendor row
 *     AND the row was CREATED on or after that print's date — only then does a
 *     one-day-off date describe a print the user had already seen.
 * A manual row typed BEFORE the print and sitting a day off it is a forecast
 * the print disagreed with, not a correction of it: it is a phantom, it splits
 * off, and the vendor row keeps the print with its recap and bogeys. Vendor
 * figures sitting in actual_value / raw_json.entry.epsActual are NOT evidence.
 * Phantom manual rows always land on the NON-reported side so a past date of
 * their own can't carry them back into the print's group.
 *
 * Decided PER MANUAL ROW, not off `cluster.find(isManual)`: a cluster can hold
 * a genuine post-print correction AND a phantom future add at once, and reading
 * only the first (date-ASC) one either stranded the correction on the wrong
 * side or let the phantom veto the split for the whole cluster.
 *
 * `phantomManuals` rides back out so the caller can strip the vendor-inherited
 * actuals those rows are sitting on — see `clearInheritedActuals` in
 * `reconcileEarningsDates`.
 */
interface ClusterSplit {
  /** One or two groups; each resolves independently through `resolveCluster`. */
  groups: EarningsRow[][];
  /** Manual rows the split pushed OFF the reported print's group. */
  phantomManuals: EarningsRow[];
}

function isManualRow(r: EarningsRow): boolean {
  return r.source === "manual" || r.date_status === "user_confirmed";
}

/**
 * Was this row typed on or after `date`? `created_at` is a `datetime('now')`
 * stamp (UTC, "YYYY-MM-DD HH:MM:SS"); only its date half is compared, so a
 * print-evening correction counts. An absent/unparseable stamp is NOT
 * evidence — the conservative direction is "this manual row does not get to
 * take the print".
 */
function createdOnOrAfter(row: EarningsRow, date: string): boolean {
  const created = (row.created_at ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(created)) return false;
  return created >= date;
}

/**
 * Is this manual row the print itself (a post-print correction of, or the
 * same date as, one of `reported`)?
 *
 * USER RULING (2026-10-02) adds two legs to the 2026-09-11 rule:
 *  - SAME-DATE AGREEMENT: a manual row whose event_date EQUALS a reported
 *    vendor row's date IS the print, whatever its creation time — a user who
 *    typed the right date before the print was confirmed, not contradicted.
 *    Rows one or more days off still need `createdOnOrAfter` (09-11 ruling).
 *  - EVIDENCE BELT: a row that owns a delivered earnings email or an accepted
 *    print sheet for its own date (`print_evidence`, PRINT_EVIDENCE_SQL).
 */
function manualIsPostPrintCorrection(manual: EarningsRow, reported: EarningsRow[]): boolean {
  if (manual.manual_actuals_at != null) return true;
  if (manual.print_evidence) return true;
  return reported.some(
    (r) =>
      r.event_date === manual.event_date ||
      (daysBetween(r.event_date, manual.event_date) <= POST_PRINT_CORRECTION_DAYS &&
        createdOnOrAfter(manual, r.event_date)),
  );
}

function splitReportedFromManualCluster(
  cluster: EarningsRow[],
  today: string,
): ClusterSplit {
  const whole = (): ClusterSplit => ({ groups: [cluster], phantomManuals: [] });
  const manuals = cluster.filter(isManualRow);
  if (manuals.length === 0) return whole();
  const isReported = (r: EarningsRow) => r.event_date < today && hasActual(r);
  // Only a print on some OTHER row needs protecting from rung 1; when the
  // manual rows are the cluster's only reported rows there is nothing to split.
  const reported = cluster.filter((r) => !isManualRow(r) && isReported(r));
  if (reported.length === 0) return whole();
  const phantomManuals = manuals.filter((m) => !manualIsPostPrintCorrection(m, reported));
  // Every manual row in the cluster earned the print on its own evidence —
  // unchanged behavior, the whole cluster resolves together at rung 1.
  if (phantomManuals.length === 0) return whole();
  // The print's side keeps the reported rows AND any correction manual (which
  // rung 1 then makes canonical, carrying the audit onto the corrected date).
  const phantomIds = new Set(phantomManuals.map((r) => r.id));
  const printSideIds = new Set([
    ...reported.map((r) => r.id),
    ...manuals.filter((m) => !phantomIds.has(m.id)).map((m) => m.id),
  ]);
  return {
    groups: [
      cluster.filter((r) => printSideIds.has(r.id)),
      cluster.filter((r) => !printSideIds.has(r.id)),
    ],
    phantomManuals,
  };
}

/**
 * Does this row say WHEN in the day the print lands — an explicit before-open
 * or after-close slot — as opposed to carrying only a vendor's default time?
 *
 * Read through the one shared slot resolver, with no release-time fallback:
 * `release_time` cannot tell the two apart (Finnhub stores no hour and the
 * row gets the after-close default; an explicit after-close row gets the
 * same clock). "During market hours" and an unknown hour are not a slot.
 */
function hasRealSlot(r: EarningsRow): boolean {
  return deriveEarningsSlot({ event_time: r.event_time, raw_json: r.raw_json }) !== null;
}

/**
 * Among rows that all sit on ONE date, pick the row the duplicate check keeps
 * (owner ruling 2026-10-08, "two vendors, one print: a real slot beats a
 * default time"). `incumbent` is the row the older rule kept and must be one
 * of `sameDateRows`; `sameDateRows` is in gather order (id ASC).
 *
 * The incumbent keeps the print unless it carries no real slot and another
 * row on the date does. So when both rows carry a slot, or neither does, the
 * answer is exactly what it was before the ruling. Among several slotted
 * challengers the order is Finnhub, then Nasdaq, then lowest id.
 *
 * The loser is hidden through the ordinary fold on the next pass; its slot
 * is never edited in place.
 */
function pickSameDateWinner(incumbent: EarningsRow, sameDateRows: EarningsRow[]): EarningsRow {
  if (hasRealSlot(incumbent)) return incumbent;
  const slotted = sameDateRows.filter(
    (r) => r.id !== incumbent.id && r.event_date === incumbent.event_date && hasRealSlot(r),
  );
  return (
    slotted.find((r) => r.source === "finnhub") ??
    slotted.find((r) => r.source === "nasdaq") ??
    slotted[0] ??
    incumbent
  );
}

/** Resolve one cluster of rows (all referring to the same reporting event). */
function resolveCluster(rows: EarningsRow[], today: string): Resolution {
  // 1. A user-confirmed / manual row is authoritative and locked. The first
  // locked row in gather order (date, then id) wins — except that on its own
  // date a HAND-ENTERED row beats a vendor row the user confirmed, whatever
  // order the two were written in (owner ruling 2026-10-08).
  const firstLocked = rows.find(isManualRow);
  if (firstLocked) {
    const locked =
      firstLocked.source === "manual"
        ? firstLocked
        : (rows.find((r) => r.source === "manual" && r.event_date === firstLocked.event_date) ??
          firstLocked);
    return { canonicalId: locked.id, status: "user_confirmed", conflictWith: null };
  }

  // 2. A past date with reported actuals demonstrably happened — it wins.
  // Several rows can report the same latest date (both vendors, after the
  // print): the first in gather order keeps it unless a twin on that date
  // carries the real slot, so a pair the slot rule resolved before the print
  // does not flip back the moment both rows show actuals.
  const occurred = rows
    .filter((r) => r.event_date < today && hasActual(r))
    .sort((a, b) => b.event_date.localeCompare(a.event_date) || a.id - b.id);
  if (occurred.length > 0) {
    const winner = pickSameDateWinner(occurred[0], occurred);
    return { canonicalId: winner.id, status: "confirmed", conflictWith: null };
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
    // confirmation. Finnhub stays canonical (richer raw_json/history that
    // the earnings-email composer already relies on) UNLESS it carries only
    // a default time and a row on that date carries a real slot; supersede
    // the rest.
    for (const n of nasdaqRows) {
      const agreeing = finnhubRows.find((f) => f.event_date === n.event_date);
      if (agreeing) {
        const winner = pickSameDateWinner(agreeing, rows);
        return { canonicalId: winner.id, status: "confirmed", conflictWith: null };
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

  // 5. Single source. The oldest claim keeps the cluster, as before; a slot
  // only decides between rows on that claim's own date (share-class siblings
  // listed by one vendor), never between dates.
  const only = pickSameDateWinner(finnhubRows[0] ?? nasdaqRows[0] ?? rows[0], rows);
  return { canonicalId: only.id, status: "single", conflictWith: null };
}

/**
 * Hand-entered rows that stay visible BESIDE the cluster's canonical row
 * (owner ruling 2026-10-06, qa:dashboard-today-earningshub-refresh-from-
 * finnhub-refresh-silently-supersedes-a-user-added-earnings-row-the-hub).
 *
 * Rung 1 of `resolveCluster` picks ONE locked canonical per cluster, so two
 * dates the user typed for one name used to collapse to the earlier one: the
 * later row went `superseded = 1` with no message and its actual was folded
 * onto a different date's row. Choosing between two dates the user typed is
 * the user's call, never the reconciler's — so when the canonical is itself
 * hand-entered, every OTHER hand-entered row in the cluster is kept: not
 * superseded, not folded, nothing carried between them. The user deletes one.
 *
 * "Hand-entered" is `source = 'manual'` only ("+ Add ticker", a confirmed
 * date, a date correction — all mint that source). A VENDOR row the user
 * confirmed in place is not hand-entered: it competes with a manual row
 * exactly as before, and the vendor rows of the cluster are still superseded
 * against the canonical exactly as before.
 *
 * REVIVAL GUARD (owner ruling 2026-10-07): a twin an earlier pass had already
 * hidden comes back ONLY when its date is `today` (US Eastern — every caller
 * passes `todayET()`) or later. A hidden twin dated in the past stays hidden
 * and keeps resolving exactly as it did before this rule existed, so a
 * finished print is never re-opened (a revived past row carrying an actual
 * has no recap of its own and would read as unsent). A past-dated twin that
 * was never hidden is not touched by the guard — it stays visible.
 */
function keptManualTwins(cluster: EarningsRow[], res: Resolution, today: string): EarningsRow[] {
  const canonical = cluster.find((r) => r.id === res.canonicalId);
  if (!canonical || canonical.source !== "manual") return [];
  return cluster.filter(
    (r) =>
      r.id !== res.canonicalId &&
      r.source === "manual" &&
      !(r.superseded && r.event_date < today),
  );
}

/**
 * The `date_status` a LOCKED row (rung 1 of `resolveCluster`, or a kept
 * hand-entered twin) is left with (owner ruling 2026-09-14,
 * qa:today-earningshub-refresh--stamps-user-confirmed-on-every-manual-row).
 *
 * `user_confirmed` records that a person confirmed the date, and only the
 * confirm-date route (lib/mutations/confirm-earnings-date.ts) may write it.
 * The pass used to stamp it on every hand-entered row in the window, so one
 * refresh made every "+ Add ticker" row read "You confirmed this date". It now
 * KEEPS the stamp on a row that already carries it and writes none otherwise.
 *
 * The lock itself does not depend on the stamp: `isManualRow` and rung 1 read
 * `source = 'manual'`, so an unstamped hand-entered row still wins its cluster
 * on every pass. `row` must be the row as gathered BEFORE the pass wrote
 * anything.
 */
function lockedStatusFor(row: EarningsRow): "user_confirmed" | null {
  return row.date_status === "user_confirmed" ? "user_confirmed" : null;
}

/** Vendor pipeline names as a person would say them. */
const VENDOR_DISPLAY_NAMES: Record<string, string> = {
  finnhub: "Finnhub",
  nasdaq: "Nasdaq",
  wsh: "Wall Street Horizon",
};

function vendorDisplayName(source: string): string {
  return VENDOR_DISPLAY_NAMES[source.toLowerCase()] ?? source;
}

/** Why `loser` stops showing once `canonical` takes its cluster. */
function supersedeReason(loser: EarningsRow, canonical: EarningsRow, res: Resolution): string {
  if (canonical.source === "manual") {
    return `the date you entered (${canonical.event_date}) takes its place`;
  }
  if (res.status === "user_confirmed") {
    return `the date you confirmed (${canonical.event_date}) takes its place`;
  }
  const vendor = vendorDisplayName(canonical.source);
  if (canonical.event_date === loser.event_date) {
    return `same event as the ${vendor} row for that date`;
  }
  if (res.status === "conflict") {
    return `${vendor} lists ${canonical.event_date} instead; that date shows until you confirm one`;
  }
  return `${vendor} lists ${canonical.event_date} instead`;
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
          ${EARNINGS_ROW_ORDER}`,
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
    .flatMap((group) => splitReportedFromManualCluster(group, opts.today).groups)
    .flatMap((sub) => {
      const res = resolveCluster(sub, opts.today);
      // Hand-entered twins stay visible beside the canonical, so each is a
      // row the doomed one's audit could land on.
      return [
        sub.find((r) => r.id === res.canonicalId)!,
        ...keptManualTwins(sub, res, opts.today),
      ];
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

/** One vendor row a hypothetical manual add would take off the calendar. */
export interface DisplacedVendorRow {
  eventId: number;
  eventDate: string;
  /** The vendor pipeline that owns the row: 'finnhub' | 'nasdaq' | 'wsh' | … */
  source: string;
  symbol: string | null;
}

export interface VendorSupersessionCheck {
  /** True when the add displaces nothing — the caller may write. */
  ok: boolean;
  /** Displaced vendor rows, nearest to the proposed date first. Empty when ok. */
  wouldSupersede: DisplacedVendorRow[];
  /** Plain-English refusal naming the primary row; null when ok. */
  message: string | null;
}

/** The id the hypothetical row carries during the dry run. Sorts LAST among
 *  same-date rows, matching where a freshly INSERTed row's rowid puts it in the
 *  reconciler's `ORDER BY event_date ASC, id ASC` gather. */
const HYPOTHETICAL_ROW_ID = Number.MAX_SAFE_INTEGER;

/** Resolve a family's rows exactly as `reconcileEarningsDates` does, returning
 *  the ids it would leave canonical (every other row it would supersede). */
function canonicalIdsFor(familyRows: EarningsRow[], today: string): Set<number> {
  const canonical = new Set<number>();
  for (const proximityCluster of clusterByProximity(familyRows)) {
    for (const cluster of splitReportedFromManualCluster(proximityCluster, today).groups) {
      const res = resolveCluster(cluster, today);
      canonical.add(res.canonicalId);
      for (const twin of keptManualTwins(cluster, res, today)) canonical.add(twin.id);
    }
  }
  return canonical;
}

/**
 * Would inserting this manual earnings row take a live VENDOR date off the
 * calendar? (qa:today-earningshub-add-ticker--manual-add-silently-supersedes-
 * vendor-date-other-week.)
 *
 * A manual / user_confirmed row is rung 1 of `resolveCluster`, so once the next
 * reconcile pass runs it wins its whole cluster and every vendor row in it goes
 * `superseded = 1` — invisible to every calendar surface, all of which filter
 * `COALESCE(superseded,0) = 0`. That is BY DESIGN when the user is confirming
 * this week's date; it is a surprise when the typed date lands in a different
 * week from the vendor's (ORCL: manual Sep 2 typed, Finnhub's Sep 7 gone, no
 * message). User ruling 2026-09-02: refuse with 409 `would_supersede_vendor` +
 * `force`, mirroring approveLevelGuarded — the semantics once confirmed are
 * unchanged.
 *
 * This is a DRY RUN of the reconciler, not a second rulebook: it gathers the
 * issuer family, appends the hypothetical row, and re-runs the same
 * `clusterByProximity` → `splitReportedFromManualCluster` → `resolveCluster`
 * chain, then reports vendor rows that are canonical BEFORE the add and not
 * after. Attribution is the reason for the before/after diff rather than a
 * "does a vendor row exist nearby" predicate: a Nasdaq twin already losing to
 * an agreeing Finnhub row is not the add's doing and must not be blamed on it.
 *
 * Scope (deliberate, all three checked in
 * tests/calendar/manual-add-supersedes-vendor-guard.test.ts):
 *  - earnings rows only, on both sides;
 *  - vendor rows only (`source != 'manual'`) that are live today
 *    (`COALESCE(superseded,0) = 0`) — a row already superseded for its own
 *    reasons is not something this add takes away;
 *  - DIFFERENT week only (`mondayOf` differs). A same-week add IS still a
 *    supersession, and still the user's date winning by design — but that is
 *    the confirm-the-date flow the form exists for, so it is never gated.
 *
 * Window: the reconciler's own `[today-21, today+30]`, widened to cover the
 * proposed date's cluster the way `repointDependentsBeforeDelete` widens it. A
 * pair parked past today's edge would otherwise pass the guard silently and be
 * superseded a few days later, when the window rolls over them — the delay
 * doesn't make the outcome less surprising.
 *
 * Read-only: no writes, no KV, safe to call before the insert.
 *
 * Also used for a PATCH that moves an existing manual row's event_date
 * (app/api/calendar/events/route.ts): pass `excludeEventId` so the row's own
 * pre-move occurrence doesn't ride along in the gather as a phantom extra row.
 */
export function checkManualAddWouldSupersedeVendor(
  db: Database.Database,
  opts: {
    symbol: string;
    event_date: string;
    /** Defaults to 'earnings'; anything else is not gated. */
    event_type?: string;
    /** ET anchor for the dry run; defaults to todayET(). */
    today?: string;
    /**
     * Excludes this row's CURRENT (pre-edit) occurrence from both the before
     * and after gathers. For PATCH (moving an existing manual row to a new
     * event_date), the row already sits in the family at its OLD date — left
     * in, it would ride along as an unrelated extra row in both the before
     * and after clusters and could manufacture a false diff. Omitted (the
     * POST / new-add case), this is a no-op: no real row carries
     * HYPOTHETICAL_ROW_ID or `undefined`.
     */
    excludeEventId?: number;
  },
): VendorSupersessionCheck {
  const clear: VendorSupersessionCheck = { ok: true, wouldSupersede: [], message: null };

  const eventType = opts.event_type ?? "earnings";
  if (eventType !== "earnings") return clear;

  const symbol = opts.symbol.trim().toUpperCase();
  const key = familyKey(symbol);
  if (!key) return clear;

  const today = opts.today ?? todayET();
  const newDate = opts.event_date;
  const newWeek = mondayOf(newDate);

  const lo = minDate(
    addDaysUTC(today, -GATHER_BACK_DAYS),
    addDaysUTC(newDate, -CLUSTER_PROXIMITY_DAYS),
  );
  const hi = maxDate(
    addDaysUTC(today, GATHER_FWD_DAYS),
    addDaysUTC(newDate, CLUSTER_PROXIMITY_DAYS),
  );

  type GatheredRow = EarningsRow & { superseded: number };
  const familyRows = (
    db
      .prepare(
        `SELECT ${EARNINGS_ROW_COLUMNS}
           FROM calendar_events
          WHERE event_type = 'earnings' AND event_date BETWEEN ? AND ?
          ${EARNINGS_ROW_ORDER}`,
      )
      .all(lo, hi) as GatheredRow[]
  ).filter((r) => familyKey(r.symbol) === key && r.id !== opts.excludeEventId);
  if (familyRows.length === 0) return clear;

  const hypothetical: EarningsRow = {
    id: HYPOTHETICAL_ROW_ID,
    source: "manual",
    symbol,
    event_date: newDate,
    // The hypothetical row is hand-entered, so it locks at rung 1 and its
    // slot is never weighed against a vendor's.
    event_time: null,
    raw_json: null,
    actual_value: null,
    date_status: null,
    consensus_estimate: null,
    consensus_value: null,
    reaction_snapshot: null,
    enriched_at: null,
    manual_actuals_at: null,
    print_evidence: 0,
    superseded: 0,
    // Typed right now: `created_at` would be datetime('now'), so against any
    // print at or before `today` this hypothetical row reads as a post-print
    // correction — exactly what the user is doing when they type a date a day
    // off a print that already happened.
    created_at: today,
  };

  const before = canonicalIdsFor(familyRows, today);
  const after = canonicalIdsFor(
    [...familyRows, hypothetical].sort(
      (a, b) => a.event_date.localeCompare(b.event_date) || a.id - b.id,
    ),
    today,
  );

  const displaced = familyRows
    .filter(
      (r) =>
        r.source !== "manual" &&
        r.superseded === 0 &&
        before.has(r.id) &&
        !after.has(r.id) &&
        mondayOf(r.event_date) !== newWeek,
    )
    .sort(
      (a, b) =>
        daysBetween(a.event_date, newDate) - daysBetween(b.event_date, newDate) ||
        a.event_date.localeCompare(b.event_date),
    );

  if (displaced.length === 0) return clear;

  const primary = displaced[0];
  const others =
    displaced.length > 1
      ? ` (and ${displaced.length - 1} other vendor row${displaced.length === 2 ? "" : "s"} for this issuer)`
      : "";
  // Honest about WHEN: the supersession lands on the next reconcile pass (a
  // calendar sync / "Refresh from Finnhub"), not at the instant of the add.
  const message =
    `${vendorDisplayName(primary.source)} already has ${symbol} earnings on ${primary.event_date} — ` +
    `a different week from the ${newDate} you typed. Adding your date replaces the vendor date${others} ` +
    `at the next calendar refresh: ${primary.event_date} stops showing until you delete the row you are adding.`;

  return {
    ok: false,
    wouldSupersede: displaced.map((r) => ({
      eventId: r.id,
      eventDate: r.event_date,
      source: r.source,
      symbol: r.symbol,
    })),
    message,
  };
}

/** The donor-row fields a fold reads (a gathered row satisfies it). */
export type TwinDonor = Pick<
  EarningsRow,
  | "id"
  | "consensus_estimate"
  | "consensus_value"
  | "actual_value"
  | "manual_actuals_at"
  | "reaction_snapshot"
  | "enriched_at"
>;

/**
 * Build the ONE implementation of "this row loses its cluster to
 * `canonicalId`": mark it superseded, carry its enrichment forward onto the
 * canonical, repoint its audit children, and merge its registry state.
 * `reconcileEarningsDates` calls it per superseded row; the stripped-actuals
 * repair (scripts/repair-reconcile-stripped-actuals.ts) reuses it so a
 * repaired cluster ends exactly where a reconcile pass would put it.
 *
 * Returns whether `mergeEarningsEventState` moved anything — the reconciler's
 * cue to write one armed-events outbox row.
 */
export function createTwinFolder(db: Database.Database) {
  // A hand-entered row keeps a real confirmation while hidden: the pass no
  // longer re-stamps a restored twin (see lockedStatusFor), so clearing it
  // here would lose a confirmation the person made. Its lock reads
  // `source = 'manual'` either way; every other row's status is cleared.
  const setSuperseded = db.prepare(
    `UPDATE calendar_events
        SET superseded = 1,
            date_status = CASE WHEN source = 'manual' AND date_status = 'user_confirmed'
                               THEN 'user_confirmed' ELSE NULL END,
            date_conflict_with = NULL
      WHERE id = ?`,
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

  return function fold(r: TwinDonor, canonicalId: number, canonicalEventDate: string): boolean {
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
      canonicalId,
    );
    repointDependents(r.id, canonicalId, canonicalEventDate);
    // v2 slice A: the repointer moved what it could; the registry merge handles the
    // (source, source_label) collisions it skipped, flags, steps, scans, and B's tables.
    return mergeEarningsEventState(db, r.id, canonicalId).changed;
  };
}

/**
 * Vendor data only a Finnhub row carries, by where each reader looks for it:
 *  - `raw_json.entry.symbol` / `.epsEstimate` / `.revenueEstimate` and
 *    top-level `finnhub_symbol` — the vendor-consensus prepare step
 *    (lib/earnings/prepare-steps/consensus-row.ts). Without them a kept
 *    Nasdaq row reads as "figures withdrawn" and the step deletes the
 *    event's Finnhub bogey.
 *  - `raw_json.entry.quarter` / `.year` — the print's fiscal quarter
 *    (lib/transcripts/fetch.ts; that reader also looks at hidden twins).
 *  - top-level `history` — no reader today; carried with the entry it
 *    describes so the row stays one coherent Finnhub payload.
 *
 * NEVER in this list: `entry.hour` (the kept row won on its own slot, and
 * `deriveEarningsSlot` reads exactly that key), `entry.date` (the kept row's
 * date is the one that counts) and `entry.epsActual` / `entry.revenueActual`
 * (`hasActual` treats them as evidence that a print happened; actuals travel
 * through `actual_value` in the fold, under its own guards).
 */
const FINNHUB_CARRIED_ENTRY_KEYS = ["symbol", "epsEstimate", "revenueEstimate", "quarter", "year"] as const;
const FINNHUB_CARRIED_TOP_KEYS = ["finnhub_symbol", "history"] as const;
/** Top-level marker on the kept row: which keys the carry wrote, and from which row. */
const FINNHUB_CARRY_MARKER = "finnhub_carried";

type JsonObject = Record<string, unknown>;

function asJsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

/** null raw_json → an empty object; anything unparseable or non-object → null (leave the row alone). */
function parseRawJsonObject(raw: string | null): JsonObject | null {
  if (raw == null || raw === "") return {};
  try {
    return asJsonObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * The hidden Finnhub row whose data the kept row borrows: nearest date, then
 * lowest id. Exported so the vendor-consensus prepare step resolves the same
 * row (`findHiddenFinnhubDonor`) instead of carrying a second rule.
 */
export function pickFinnhubDonor<T extends Pick<EarningsRow, "id" | "source" | "event_date">>(
  hidden: T[],
  canonicalEventDate: string,
): T | null {
  const finnhub = hidden.filter((r) => r.source === "finnhub");
  if (finnhub.length === 0) return null;
  return [...finnhub].sort(
    (a, b) =>
      daysBetween(a.event_date, canonicalEventDate) - daysBetween(b.event_date, canonicalEventDate) ||
      a.id - b.id,
  )[0];
}

/** A hidden Finnhub earnings row, as `findHiddenFinnhubDonor` returns it. */
export interface HiddenFinnhubDonor {
  id: number;
  source: string;
  symbol: string | null;
  event_date: string;
  raw_json: string | null;
}

/**
 * The hidden (superseded) Finnhub earnings row that describes the same print
 * as `kept`, read straight from the table: same issuer family
 * (`issuerSiblings`, never symbol equality), within the clustering distance
 * of the kept row's date, and then `pickFinnhubDonor`'s order (nearest date,
 * lowest id) — the row the carrier borrows from once a reconcile pass runs.
 *
 * It exists for readers that must not depend on the carry having run: a
 * vendor sync wipes the carried keys off a kept Nasdaq row until the pass at
 * the end of that sync restores them (lib/earnings/prepare-steps/
 * consensus-row.ts reads through this instead). Read-only. null when the
 * print has no hidden Finnhub row.
 */
export function findHiddenFinnhubDonor(
  db: Database.Database,
  kept: { id: number; symbol: string | null; event_date: string },
): HiddenFinnhubDonor | null {
  if (!kept.symbol) return null;
  const family = [...new Set(issuerSiblings(kept.symbol).map((s) => s.toUpperCase()))];
  if (family.length === 0) return null;
  const hidden = db
    .prepare(
      `SELECT id, source, symbol, event_date, raw_json
         FROM calendar_events
        WHERE event_type = 'earnings' AND source = 'finnhub'
          AND COALESCE(superseded, 0) = 1 AND id != ?
          AND UPPER(symbol) IN (${family.map(() => "?").join(",")})
          AND event_date BETWEEN ? AND ?`,
    )
    .all(
      kept.id,
      ...family,
      addDaysUTC(kept.event_date, -CLUSTER_PROXIMITY_DAYS),
      addDaysUTC(kept.event_date, CLUSTER_PROXIMITY_DAYS),
    ) as HiddenFinnhubDonor[];
  return pickFinnhubDonor(hidden, kept.event_date);
}

/**
 * Build "the kept row borrows what only the hidden Finnhub row carries".
 *
 * Since the 2026-10-08 slot ruling a Nasdaq row can keep a print and hide the
 * Finnhub row (a hand-entered row always could). The fold above carries
 * consensus / actual / reaction columns, COALESCE-style, and nothing else, so
 * the kept row lost three things its readers use:
 *   1. the Finnhub keys of `raw_json` listed on FINNHUB_CARRIED_*;
 *   2. `description` (Finnhub's "Q3 2026 report. Last 4 quarters …" text the
 *      weekly briefing prompt leans on) — a Nasdaq row has none;
 *   3. the revenue estimate inside `consensus_estimate` ("EPS x · Rev y", read
 *      by the earnings emails) — a Nasdaq row states EPS only, and being
 *      non-NULL it blocks the fold's COALESCE.
 *
 * Rules:
 *  - Only what the kept row LACKS is written. A value the kept row has of its
 *    own is never replaced.
 *  - EVERYTHING the carry wrote is recorded on the marker and follows the
 *    Finnhub row from then on: refreshed when the Finnhub row changed, removed
 *    when the Finnhub row no longer states it. The marker holds
 *      `keys`               the raw_json keys carried,
 *      `description`        the description text carried (present only while
 *                           the kept row's description is that carried text),
 *      `consensus_revenue`  the "Rev …" part carried into consensus_estimate.
 *    A description or revenue part is "still the carried one" only while it
 *    equals what the marker recorded; text a person typed over it is theirs.
 *  - Marker lost, value still there (a Nasdaq sync replaces `raw_json` but
 *    keeps the old `consensus_estimate` when it states no forecast of its
 *    own): a description / revenue part EQUAL to the Finnhub row's current one
 *    is taken back under the marker without a column write, so it is followed
 *    again. One that differs is treated as the kept row's own.
 *  - The slot is never touched (see FINNHUB_CARRIED_ENTRY_KEYS).
 *  - The revenue part is managed only on a NASDAQ row, and appended only to
 *    its own "EPS …" text; consensus text on a hand-entered row is never
 *    edited.
 *  - A zero revenue estimate is Finnhub's placeholder for "none published"
 *    (CLAUDE.md, resolved by `parseFinnhubFigure`): it is never carried, as a
 *    raw_json key or as text, and a carried figure that turns into it is
 *    removed.
 *  - A kept row whose raw_json cannot be parsed cannot hold a marker, so
 *    nothing is carried onto it.
 *  - A settled pair writes nothing, so a second pass is a no-op. The carry
 *    does not change the armed projection and never asks for an outbox row.
 *
 * NOT durable on its own for a vendor row: the weekly sync's upsert replaces
 * `raw_json` and `description` for the same source_key and resets
 * `consensus_estimate`. It is restored because every sync ends in a reconcile
 * pass and the pass revisits already-hidden rows — see the caller. Readers
 * that cannot tolerate that gap go through `findHiddenFinnhubDonor`.
 */
export function createFinnhubDataCarrier(db: Database.Database) {
  interface CarryRow {
    id: number;
    source: string;
    raw_json: string | null;
    description: string | null;
    consensus_estimate: string | null;
  }
  const read = db.prepare(
    "SELECT id, source, raw_json, description, consensus_estimate FROM calendar_events WHERE id = ?",
  );
  const writeRawJson = db.prepare("UPDATE calendar_events SET raw_json = ? WHERE id = ?");
  const writeDescription = db.prepare("UPDATE calendar_events SET description = ? WHERE id = ?");
  const writeConsensus = db.prepare("UPDATE calendar_events SET consensus_estimate = ? WHERE id = ?");

  const has = (obj: JsonObject, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
  const isRevenuePart = (part: string) => /^Rev\b/.test(part);
  const consensusParts = (text: string | null) =>
    (text ?? "")
      .split(" · ")
      .map((part) => part.trim())
      .filter((part) => part !== "");

  return function carry(donorId: number, canonicalId: number): void {
    const donor = read.get(donorId) as CarryRow | undefined;
    const kept = read.get(canonicalId) as CarryRow | undefined;
    if (!donor || !kept || donor.source !== "finnhub" || kept.source === "finnhub") return;

    const keptJson = parseRawJsonObject(kept.raw_json);
    // No parseable raw_json, no place for the marker: carry nothing.
    if (!keptJson) return;
    const marker = asJsonObject(keptJson[FINNHUB_CARRY_MARKER]);
    let jsonChanged = false;

    // 1. raw_json keys. A Finnhub row that lost its entry states nothing, so
    //    every key carried earlier is removed.
    const donorJson = (donor.raw_json ? parseRawJsonObject(donor.raw_json) : null) ?? {};
    const donorEntry = { ...(asJsonObject(donorJson.entry) ?? {}) };
    if (donorEntry.revenueEstimate === 0) delete donorEntry.revenueEstimate; // placeholder, not a figure
    const hadEntry = has(keptJson, "entry");
    const keptEntry = hadEntry ? asJsonObject(keptJson.entry) : {};
    const carriedKeys: string[] = [];
    // A kept row whose `entry` is not an object is a shape we do not know: leave its keys alone.
    if (keptEntry) {
      const markerKeys: unknown = marker ? marker.keys : null;
      const previouslyCarried = new Set<string>(
        Array.isArray(markerKeys) ? markerKeys.filter((k): k is string => typeof k === "string") : [],
      );
      const apply = (target: JsonObject, source: JsonObject, key: string, label: string) => {
        const mine = previouslyCarried.has(label);
        if (has(target, key) && !mine) return; // the kept row's own value
        if (has(source, key)) {
          if (!has(target, key) || JSON.stringify(target[key]) !== JSON.stringify(source[key])) {
            target[key] = source[key];
            jsonChanged = true;
          }
          carriedKeys.push(label);
        } else if (mine && has(target, key)) {
          delete target[key]; // the Finnhub row no longer states it
          jsonChanged = true;
        }
      };
      for (const key of FINNHUB_CARRIED_ENTRY_KEYS) apply(keptEntry, donorEntry, key, `entry.${key}`);
      for (const key of FINNHUB_CARRIED_TOP_KEYS) apply(keptJson, donorJson, key, key);
      if (carriedKeys.length > 0 && !hadEntry) keptJson.entry = keptEntry;
    }

    // 2. description: fill an empty one; afterwards follow the Finnhub row
    //    for as long as the kept row still shows the carried text.
    const donorDescription = (donor.description ?? "").trim() !== "" ? donor.description : null;
    const markedDescription = marker && typeof marker.description === "string" ? marker.description : null;
    let carriedDescription: string | null = null;
    if ((kept.description ?? "").trim() === "") {
      if (donorDescription !== null) {
        writeDescription.run(donorDescription, kept.id);
        carriedDescription = donorDescription;
      }
    } else if (kept.description === markedDescription) {
      if (donorDescription === null) writeDescription.run(null, kept.id);
      else {
        if (donorDescription !== kept.description) writeDescription.run(donorDescription, kept.id);
        carriedDescription = donorDescription;
      }
    } else if (markedDescription === null && kept.description === donorDescription) {
      carriedDescription = donorDescription; // marker lost; the text is the Finnhub row's
    }

    // 3. revenue estimate inside a Nasdaq row's consensus text.
    let carriedRevenue: string | null = null;
    if (kept.source === "nasdaq") {
      const parts = consensusParts(kept.consensus_estimate);
      const keptRevenue = parts.filter(isRevenuePart);
      const donorRevenue =
        consensusParts(donor.consensus_estimate).find(
          (part) => isRevenuePart(part) && parseFinnhubFigure(part).revenue != null,
        ) ?? null;
      const markedRevenue =
        marker && typeof marker.consensus_revenue === "string" ? marker.consensus_revenue : null;
      if (keptRevenue.length === 0) {
        // Appended only to the row's own text (an empty consensus is the fold's to fill).
        if (donorRevenue !== null && parts.length > 0) {
          writeConsensus.run([...parts, donorRevenue].join(" · "), kept.id);
          carriedRevenue = donorRevenue;
        }
      } else if (
        keptRevenue.length === 1 &&
        (keptRevenue[0] === markedRevenue || (markedRevenue === null && keptRevenue[0] === donorRevenue))
      ) {
        if (donorRevenue === null) {
          writeConsensus.run(parts.filter((part) => !isRevenuePart(part)).join(" · ") || null, kept.id);
        } else {
          if (donorRevenue !== keptRevenue[0]) {
            writeConsensus.run(
              parts.map((part) => (isRevenuePart(part) ? donorRevenue : part)).join(" · "),
              kept.id,
            );
          }
          carriedRevenue = donorRevenue;
        }
      }
      // Anything else is a revenue figure the kept row has of its own.
    }

    // The marker: what this pass left carried on the row.
    if (carriedKeys.length > 0 || carriedDescription !== null || carriedRevenue !== null) {
      const nextMarker: JsonObject = { from_event_id: donor.id, keys: carriedKeys };
      if (carriedDescription !== null) nextMarker.description = carriedDescription;
      if (carriedRevenue !== null) nextMarker.consensus_revenue = carriedRevenue;
      if (JSON.stringify(marker) !== JSON.stringify(nextMarker)) {
        keptJson[FINNHUB_CARRY_MARKER] = nextMarker;
        jsonChanged = true;
      }
    } else if (has(keptJson, FINNHUB_CARRY_MARKER)) {
      delete keptJson[FINNHUB_CARRY_MARKER];
      jsonChanged = true;
    }
    if (jsonChanged) writeRawJson.run(JSON.stringify(keptJson), kept.id);
  };
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

  // `title` and `source_key` are read for reporting only — no resolution step
  // looks at them.
  type PassRow = EarningsRow & { title: string; source_key: string };
  const rows = db
    .prepare(
      `SELECT ${EARNINGS_ROW_COLUMNS}, title, source_key
       FROM calendar_events
       WHERE event_type = 'earnings' AND event_date BETWEEN ? AND ?
       ${EARNINGS_ROW_ORDER}`,
    )
    .all(start, end) as PassRow[];

  const scopedFamilies =
    opts.symbols && opts.symbols.length > 0
      ? new Set(opts.symbols.map((s) => familyKey(s)).filter((k) => k !== ""))
      : null;

  // Group by issuer family, then proximity-cluster within each family.
  const byFamily = new Map<string, PassRow[]>();
  for (const r of rows) {
    const key = familyKey(r.symbol);
    if (scopedFamilies && !scopedFamilies.has(key)) continue;
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key)!.push(r);
  }

  const setCanonical = db.prepare(
    "UPDATE calendar_events SET date_status = ?, date_conflict_with = ?, superseded = 0 WHERE id = ?",
  );

  // A phantom manual row (split off the print, no desk acceptance of its own)
  // keeps whatever actuals it had INHERITED — `carryEnrichment` copied them
  // from the print on an earlier pass, or the enrichment road wrote a Finnhub
  // figure onto the manual row's own date. That is enough to make it a live
  // recap candidate: findEmailCandidates' recap query and the read-through
  // reporter scan (lib/calendar/enrichment-runner.ts) both select on
  // `actual_value IS NOT NULL` over non-superseded rows, and the phantom is
  // canonical in its own group with no earnings_emails/skip row of its own —
  // so the desk gets a SECOND email carrying the print's numbers under a date
  // that never printed. Strip the inherited actuals instead: the row survives
  // as the user's own (future) event, just without figures it never earned.
  //
  // `manual_actuals_at IS NULL` is the safety rail — a desk-accepted figure is
  // never wiped (and such a row is never a phantom in the first place). The
  // PRINT_EVIDENCE_SQL guard is the same rail for a row that owns a delivered
  // email or an accepted print sheet (ruling 2026-10-02) — also never a
  // phantom, refused here as defense in depth. Only
  // the actuals fields go; consensus stays, since a forward-looking consensus
  // on a future date is not a claim that the quarter printed.
  const clearInheritedActuals = db.prepare(
    `UPDATE calendar_events SET
       actual_value = NULL,
       enriched_at = NULL,
       reaction_snapshot = NULL,
       raw_json = CASE
         WHEN raw_json IS NOT NULL AND json_valid(raw_json)
           THEN json_remove(raw_json, '$.entry.epsActual', '$.entry.revenueActual')
         ELSE raw_json
       END
     WHERE id = ? AND manual_actuals_at IS NULL AND NOT ${PRINT_EVIDENCE_SQL}`,
  );
  /** Does this phantom carry anything the clear above would remove? */
  const carriesInheritedActuals = (r: EarningsRow): boolean =>
    r.manual_actuals_at == null &&
    !r.print_evidence &&
    (r.actual_value != null ||
      r.enriched_at != null ||
      r.reaction_snapshot != null ||
      hasActual(r));

  const foldIntoCanonical = createTwinFolder(db);
  const carryFinnhubData = createFinnhubDataCarrier(db);

  const result: ReconcileResult = {
    confirmed: 0,
    conflict: 0,
    single: 0,
    userConfirmed: 0,
    handEntered: 0,
    superseded: [],
    restored: [],
  };
  const passRowById = new Map(rows.map((r) => [r.id, r]));
  // [C-13] One outbox row per reconcile transaction, only when the merge
  // actually moved something. Already-superseded donors revisited on later
  // syncs report changed:false and write nothing, so the pass stays idempotent
  // at the outbox level too.
  let anyChanged = false;

  const apply = db.transaction(() => {
    for (const familyRows of byFamily.values()) {
      for (const proximityCluster of clusterByProximity(familyRows)) {
      const split = splitReportedFromManualCluster(proximityCluster, today);
      for (const cluster of split.groups) {
        const res = resolveCluster(cluster, today);
        const canonicalRow = cluster.find((r) => r.id === res.canonicalId)!;
        // A locked cluster keeps whatever confirmation its canonical row
        // already carried; the pass never adds one (see lockedStatusFor).
        const canonicalStatus =
          res.status === "user_confirmed" ? lockedStatusFor(canonicalRow) : res.status;
        setCanonical.run(canonicalStatus, res.conflictWith, res.canonicalId);
        const canonicalEventDate = canonicalRow.event_date;
        const preCanonical = passRowById.get(res.canonicalId);
        if (preCanonical?.superseded) anyChanged = true;
        // Hand-entered twins of a hand-entered canonical stay visible beside
        // it: same locked status, never folded (see keptManualTwins).
        const keptTwins = keptManualTwins(cluster, res, today);
        const keptIds = new Set(keptTwins.map((r) => r.id));
        for (const twin of keptTwins) {
          const twinStatus = lockedStatusFor(twin);
          setCanonical.run(twinStatus, null, twin.id);
          if (twinStatus) result.userConfirmed++;
          else result.handEntered++;
          // A twin an earlier pass had hidden comes back (today or later
          // only — the guard is inside keptManualTwins). Its arm and audit
          // rows were merged onto the canonical then and stay there; the
          // outbox writer is a no-op when the armed projection is unchanged
          // (D10), so asking is free and never wrong.
          const preTwin = passRowById.get(twin.id);
          if (preTwin?.superseded) {
            anyChanged = true;
            result.restored.push({
              eventId: twin.id,
              sourceKey: preTwin.source_key,
              symbol: twin.symbol,
              title: preTwin.title,
              eventDate: twin.event_date,
              source: twin.source,
              reason: `your entry now shows beside the one on ${canonicalEventDate}; delete one of the two`,
            });
          }
        }
        // Freshest-enriched donor first: with several superseded rows, the
        // first non-NULL value per column wins (COALESCE), so order matters.
        const superseded = cluster
          .filter((r) => r.id !== res.canonicalId && !keptIds.has(r.id))
          .sort((a, b) => (b.enriched_at ?? "").localeCompare(a.enriched_at ?? ""));
        for (const r of superseded) {
          const pre = passRowById.get(r.id);
          if (pre && !pre.superseded) {
            anyChanged = true;
            result.superseded.push({
              eventId: r.id,
              sourceKey: pre.source_key,
              symbol: r.symbol,
              title: pre.title,
              eventDate: r.event_date,
              source: r.source,
              reason: supersedeReason(r, canonicalRow, res),
            });
          }
          // Fold FIRST, then accumulate: `anyChanged ||= fold(...)` would
          // short-circuit and skip the fold (pre-refactor the same shape
          // skipped mergeEarningsEventState for every donor after the first
          // change in a pass).
          const changed = foldIntoCanonical(r, res.canonicalId, canonicalEventDate);
          anyChanged ||= changed;
        }
        // AFTER the folds (the fold's COALESCE has had first say on the
        // consensus column). `superseded` holds every hidden row of the
        // cluster on every pass, already-hidden ones included, so data the
        // weekly sync's upsert wiped off a vendor row is carried again by
        // the pass that ends that same sync.
        const finnhubDonor =
          canonicalRow.source === "finnhub" ? null : pickFinnhubDonor(superseded, canonicalEventDate);
        if (finnhubDonor) carryFinnhubData(finnhubDonor.id, res.canonicalId);
        if (res.status === "confirmed") result.confirmed++;
        else if (res.status === "conflict") result.conflict++;
        else if (res.status === "single") result.single++;
        else if (canonicalStatus) result.userConfirmed++;
        else result.handEntered++;
      }
      // LAST for this proximity cluster: the phantom is canonical inside its
      // own group, so its group's carryEnrichment has already run and could
      // have re-filled what we are about to strip. Gated on the row's
      // PRE-pass state so a second reconcile writes nothing (the fields are
      // NULL by then) and the outbox stays idempotent.
      for (const phantom of split.phantomManuals) {
        if (!carriesInheritedActuals(phantom)) continue;
        // Only a real write earns the outbox row: the evidence guard in the
        // UPDATE can refuse it (0 changes), and then nothing moved.
        if (clearInheritedActuals.run(phantom.id).changes > 0) anyChanged = true;
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
