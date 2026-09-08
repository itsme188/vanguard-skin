import type Database from "better-sqlite3";

/**
 * Generation-bound convention markers for the tax-lots dollar convention
 * (spec: number-trust durable fixes, WS1). The generation counter advances
 * on every MATERIAL tax-input mutation; both markers bind to it so a stale
 * stamp can never survive new data. All readers go through
 * getTaxConventionState — never parse the settings rows elsewhere.
 */

export interface AcceptanceCoverage { accountId: number; taxYear: number }
export interface TaxConventionState {
  generation: number;
  recomputeCurrent: boolean;
  /**
   * Which engine convention wrote the stored lots: "v3" for the current
   * stamp shape, "legacy" for ANY other non-empty stamp (`v2:42`, or an
   * unrecognized value after a rollback), null when nothing ever stamped.
   * Read-only introspection for the UI — `recomputeCurrent` remains the only
   * gate any engine/export decision may use.
   */
  stampedConvention: "v3" | "legacy" | null;
  /**
   * The generation embedded in the stamp (`v3:42` -> 42), for either
   * convention, so the UI can say how many tax-input changes the stored lots
   * predate. Null when there is no stamp, or when the stamp carries no
   * parseable generation.
   */
  stampedGeneration: number | null;
  acceptance: { current: boolean; coverage: AcceptanceCoverage[] };
}

/**
 * Why the stored tax lots do not describe the current inputs, in the shape
 * the Tax Lots page's staleness notice renders. Pure — derived entirely from
 * a TaxConventionState, no database access (QA finding
 * tax-lots--headline-tiles-stale-until-recompute-no-marker).
 */
export interface TaxLotStalenessMarker {
  stale: boolean;
  /** Tax-input changes recorded since the stored lots were computed. */
  inputChangesSince: number | null;
  reason: "behind" | "legacy" | "never" | null;
}

const GEN_KEY = "tax_input_generation";
const CONVENTION_KEY = "tax_lots_convention";
const ACCEPTANCE_KEY = "tax_report_broker_accepted";

function readSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function getTaxInputGeneration(db: Database.Database): number {
  const raw = readSetting(db, GEN_KEY);
  const n = raw == null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Call inside the mutating transaction. Returns the new generation. */
export function bumpTaxInputGeneration(db: Database.Database): number {
  const next = getTaxInputGeneration(db) + 1;
  writeSetting(db, GEN_KEY, String(next));
  return next;
}

export function stampTaxLotsConvention(db: Database.Database): void {
  // A new engine convention cannot revive acceptance of the old engine's output.
  if (!readSetting(db, CONVENTION_KEY)?.startsWith("v3:")) {
    writeSetting(db, ACCEPTANCE_KEY, JSON.stringify({ generation: -1, coverage: [] }));
  }
  writeSetting(db, CONVENTION_KEY, `v3:${getTaxInputGeneration(db)}`);
}

export function stampBrokerAcceptance(
  db: Database.Database,
  coverage: AcceptanceCoverage[]
): void {
  writeSetting(
    db,
    ACCEPTANCE_KEY,
    JSON.stringify({ generation: getTaxInputGeneration(db), coverage })
  );
}

export function getTaxConventionState(db: Database.Database): TaxConventionState {
  const generation = getTaxInputGeneration(db);
  const conv = readSetting(db, CONVENTION_KEY);
  const m = conv == null ? null : /^v3:(\d+)$/.exec(conv);
  const recomputeCurrent = m != null && Number.parseInt(m[1], 10) === generation;

  const stampedConvention: TaxConventionState["stampedConvention"] =
    conv == null || conv === "" ? null : m != null ? "v3" : "legacy";
  // Any `<convention>:<generation>` stamp carries its generation, including
  // the superseded `v2:` shape — the distance is what the UI quotes, and it
  // is just as meaningful across a convention change.
  const stampedGenMatch = conv == null ? null : /^[a-z0-9]+:(\d+)$/i.exec(conv);
  const parsedStampedGen =
    stampedGenMatch == null ? NaN : Number.parseInt(stampedGenMatch[1], 10);
  const stampedGeneration = Number.isFinite(parsedStampedGen) ? parsedStampedGen : null;

  let acceptance: TaxConventionState["acceptance"] = { current: false, coverage: [] };
  const rawAcc = readSetting(db, ACCEPTANCE_KEY);
  if (rawAcc != null) {
    try {
      const parsed = JSON.parse(rawAcc) as { generation?: number; coverage?: AcceptanceCoverage[] };
      const coverage = Array.isArray(parsed.coverage) ? parsed.coverage : [];
      acceptance = { current: parsed.generation === generation && recomputeCurrent, coverage };
    } catch {
      // unparseable stamp = no acceptance (fail closed)
    }
  }
  return { generation, recomputeCurrent, stampedConvention, stampedGeneration, acceptance };
}

/**
 * Turn a convention state into the staleness notice the Tax Lots page shows
 * beside its Recompute button. Never triggers anything — the page reads this
 * and says so; only an explicit Recompute changes the stored lots.
 *
 * Reason precedence is deliberate: an earlier lot convention outranks a
 * plain generation gap, because a v3 recompute moves the figures whether or
 * not the ledger also moved (commit 14a90c5c changed lot direction/matching).
 * The change count is still reported alongside it when it is known.
 */
export function describeTaxLotStaleness(state: TaxConventionState): TaxLotStalenessMarker {
  if (state.recomputeCurrent) {
    return { stale: false, inputChangesSince: null, reason: null };
  }
  // A stamp ahead of the counter (restored/edited settings row) yields no
  // quotable distance — never a negative one.
  const inputChangesSince =
    state.stampedGeneration != null && state.generation > state.stampedGeneration
      ? state.generation - state.stampedGeneration
      : null;
  const reason: TaxLotStalenessMarker["reason"] =
    state.stampedConvention == null
      ? "never"
      : state.stampedConvention === "legacy"
        ? "legacy"
        : "behind";
  return { stale: true, inputChangesSince, reason };
}

export function isYearAccepted(
  state: TaxConventionState,
  taxYear: number,
  accountIds: number[]
): boolean {
  if (!state.acceptance.current) return false;
  return accountIds.every((accountId) =>
    state.acceptance.coverage.some((c) => c.accountId === accountId && c.taxYear === taxYear)
  );
}

/**
 * The one settings-table probe. Mutation sites run against minimal test DBs
 * that never created `settings`; every guarded wrapper below shares this
 * check rather than inlining its own sqlite_master query.
 */
function hasSettingsTable(db: Database.Database): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
      .get() != null
  );
}

/**
 * Wrapper for mutation sites that run on minimal test DBs (no settings table).
 * No-ops if the settings table is missing.
 */
export function bumpTaxGenerationIfPresent(db: Database.Database): number {
  if (!hasSettingsTable(db)) {
    return 0; // settings table doesn't exist; return 0 (no-op)
  }

  return bumpTaxInputGeneration(db);
}

/**
 * Same guard for the recompute marker: `computeTaxLots` stamps as its final
 * in-transaction act, and it too runs against minimal test DBs.
 */
export function stampTaxLotsConventionIfPresent(db: Database.Database): void {
  if (!hasSettingsTable(db)) return;
  stampTaxLotsConvention(db);
}

/**
 * Fail-closed price invalidation for synthetic closes (spec 2026-08-30
 * reconciler-hardening §4). computeTaxLots' RECONCILE_CLOSE pass prices a
 * broker-closed position off the latest `prices` row at-or-before the
 * position's zero-quantity date — so a price write/delete in that window
 * changes realized tax output. Callers pass the (securityId, date) pairs
 * they mutated (capture BEFORE a delete); this bumps the generation once
 * when any pair can affect a synthetic close. Held securities (latest
 * holdings row non-zero) never match, so routine daily price syncs never
 * bump. Deliberately over-approximate: an older-than-selected price for a
 * tombstoned security still bumps — over-bump is fail-closed and cheap.
 *
 * The zero-quantity check below is deliberately NOT filtered to stock/ETF,
 * even though RECONCILE_CLOSE itself only synthesizes for stock/ETF
 * (`computeTaxLots`' orphan query, `lib/compute/tax-lots.ts`). This is an
 * invalidation trigger, not the synthesis query — matching a bond/fund/option
 * tombstone here just costs an occasional harmless extra bump. Never narrow
 * this to stock/ETF to "fix" the mismatch: that would risk a fail-OPEN hole
 * if RECONCILE_CLOSE's own scope ever widens without this trigger widening
 * in lockstep.
 */
export function bumpIfPricesAffectSyntheticCloses(
  db: Database.Database,
  pairs: { securityId: number; date: string }[],
): boolean {
  if (pairs.length === 0) return false;
  const stmt = db.prepare(
    `SELECT 1 AS hit FROM holdings h
      WHERE h.security_id = ? AND h.quantity = 0
        AND h.as_of_date >= ?
        AND h.as_of_date = (
          SELECT MAX(h2.as_of_date) FROM holdings h2
           WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id)
      LIMIT 1`,
  );
  for (const p of pairs) {
    if (stmt.get(p.securityId, p.date) != null) {
      bumpTaxGenerationIfPresent(db);
      return true;
    }
  }
  return false;
}
