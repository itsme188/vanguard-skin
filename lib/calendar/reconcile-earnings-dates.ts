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

  const finnhub = rows.find((r) => r.source === "finnhub");
  const nasdaq = rows.find((r) => r.source === "nasdaq");

  // 3 & 4. Both calendars present.
  if (finnhub && nasdaq) {
    if (finnhub.event_date === nasdaq.event_date) {
      // Agree → confirmed. Keep Finnhub canonical (richer raw_json/history that
      // the earnings-email composer already relies on); supersede the Nasdaq dup.
      return { canonicalId: finnhub.id, status: "confirmed", conflictWith: null };
    }
    // Disagree → Nasdaq provisional, flagged for the user to confirm vs IBKR.
    return {
      canonicalId: nasdaq.id,
      status: "conflict",
      conflictWith: `finnhub:${finnhub.event_date}`,
    };
  }

  // 5. Single source.
  const only = finnhub ?? nasdaq ?? rows[0];
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
  // data" invariant as the enrichment-runner), and child audit rows re-point.
  // UPDATE OR IGNORE keeps the canonical's own row on a UNIQUE collision,
  // leaving the superseded-side duplicate in place for audit.
  const carryEnrichment = db.prepare(
    `UPDATE calendar_events SET
       consensus_estimate = COALESCE(consensus_estimate, ?),
       consensus_value = COALESCE(consensus_value, ?),
       actual_value = COALESCE(actual_value, ?),
       reaction_snapshot = COALESCE(reaction_snapshot, ?),
       enriched_at = COALESCE(enriched_at, ?)
     WHERE id = ?`,
  );
  const repointChildren = ["earnings_emails", "earnings_bogeys", "earnings_email_skips"].map(
    (table) => db.prepare(`UPDATE OR IGNORE ${table} SET event_id = ? WHERE event_id = ?`),
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

      for (const cluster of clusters) {
        const res = resolveCluster(cluster, today);
        setCanonical.run(res.status, res.conflictWith, res.canonicalId);
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
          for (const repoint of repointChildren) repoint.run(res.canonicalId, r.id);
        }
        if (res.status === "confirmed") result.confirmed++;
        else if (res.status === "conflict") result.conflict++;
        else if (res.status === "single") result.single++;
        else result.userConfirmed++;
      }
    }
  });
  apply();

  return result;
}
