/**
 * Gains at risk, step 3: the lists the single-name driver and the candidate
 * section choose from (spec docs/superpowers/specs/2026-11-25-gains-at-risk-step3-candidates-design.md,
 * P1 and controller ruling F8). Built on the server; no free text.
 *
 *   - `listSingleNameDrivers` (P1): every non-option security held (a
 *     non-zero latest row, shorts included) in ANY account; the underlying of
 *     every held live option, by its row when one exists, else by its stored
 *     underlying symbol with no id (step 1 ruling F7); and every trial
 *     underlying id that is a non-option row. Cash-equivalent funds, bonds
 *     and names with no usable price (`hasUsableDriverPrice`) are left out:
 *     a driver that moves nothing misleads (controller ruling, fix round 1).
 *     An option underlying with no securities row has no price, so it is
 *     never listed. One entry per security id. It never depends on the
 *     stress scope.
 *   - `listCandidateUnderlyings` (F8): the driver list's names with a row,
 *     the index rows (SPY, QQQ, VTI) and the active watchlist, each kept only
 *     when `checkTrialSecurity` passes with a contract id required (the
 *     broker needs a contract on file to pull a chain).
 *
 * READ-ONLY. Imports no engine code.
 */

import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { getActiveWatchlistSecurityIds } from "@/lib/queries/watchlist";
import { GAINS_AT_RISK_DRIVERS } from "@/lib/analysis/gains-at-risk-input";
import { mapSecurityType } from "@/lib/tws/security-type-map";
import { isCashEquivalentSecurity } from "./cash-equivalents";
import { liveOptionExpirationSql } from "./option-expiry";
import { isOptionSecurityType, OPTION_ROW_SQL } from "./option-elasticity";
import { checkTrialSecurity, lookupTrialSecurity } from "./gains-at-risk-trial";

export type SingleNameDriverReason = "held" | "option-underlying" | "trial";

export interface SingleNameDriverEntry {
  /** Upper-cased, trimmed. */
  symbol: string;
  name: string | null;
  /** Null: an option underlying with no securities row (F7). */
  securityId: number | null;
  /** In this order, no duplicates. */
  reasons: SingleNameDriverReason[];
  /** A broker contract id is on file: candidates can be pulled for it. */
  hasContractId: boolean;
}

export type CandidateUnderlyingReason = "driver-list" | "index" | "watchlist";

export interface CandidateUnderlyingEntry {
  securityId: number;
  symbol: string;
  name: string | null;
  reasons: CandidateUnderlyingReason[];
}

const DRIVER_REASON_ORDER: readonly SingleNameDriverReason[] = ["held", "option-underlying", "trial"];
const CANDIDATE_REASON_ORDER: readonly CandidateUnderlyingReason[] = ["driver-list", "index", "watchlist"];
const BOND_CLASS = mapSecurityType("bond");

interface SecurityRow {
  id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
  fund_category: string | null;
  ib_con_id: number | null;
}

function norm(symbol: string | null | undefined): string {
  return (symbol ?? "").trim().toUpperCase();
}

/**
 * True when a name has a price the engine will actually move (fix round 1).
 *
 * The reader is the POSITION LOADER's price (`loadScenarioPositionsByAccount`,
 * its `latest_prices` CTE): the close of the name's latest `prices` row by
 * date, positive. A held share row is priced from exactly that row (its
 * `market_value`), and an option on the name takes it as `underlying_price`;
 * with no such price the loader leaves both "not modelled: no price", so the
 * name would move nothing. `trialValuationPrice` is NOT the test: it also
 * accepts a daily-bar close, which the loader never reads, so a name priced
 * only by bars would be listed while its held rows stay flat. Whenever this
 * returns true, `trialValuationPrice` returns a price too (that same row or a
 * bar), so a trial on a listed name is priced as well.
 *
 * Exported for the compute route (S4): a request naming a driver must find it
 * through `listSingleNameDrivers` + `findSingleNameDriver`, which apply this.
 */
export function hasUsableDriverPrice(db: Database.Database, securityId: number): boolean {
  if (!Number.isSafeInteger(securityId) || securityId <= 0) return false;
  const latest = db
    .prepare("SELECT close_price FROM prices WHERE security_id = ? ORDER BY date DESC LIMIT 1")
    .get(securityId) as { close_price: number | null } | undefined;
  return latest !== undefined && latest.close_price !== null && Number.isFinite(latest.close_price) && latest.close_price > 0;
}

/** A row the list may carry: not an option, not a cash-equivalent fund, not a bond (P1). */
function isDriverRow(row: SecurityRow): boolean {
  if (isOptionSecurityType(row.security_type)) return false;
  if (isCashEquivalentSecurity({ security_type: row.security_type, fund_category: row.fund_category })) return false;
  const type = (row.security_type ?? "").trim();
  return !(type !== "" && mapSecurityType(type) === BOND_CLASS);
}

function bySymbolThenId<T extends { symbol: string; securityId: number | null }>(a: T, b: T): number {
  if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
  if (a.securityId === b.securityId) return 0;
  if (a.securityId === null) return 1;
  if (b.securityId === null) return -1;
  return a.securityId - b.securityId;
}

const SECURITY_COLUMNS = "s.id, s.symbol, s.name, s.security_type, s.fund_category, s.ib_con_id";

/** P1: the single-name driver list, sorted by symbol. See the module comment. */
export function listSingleNameDrivers(
  db: Database.Database,
  opts: { trialUnderlyingIds: readonly number[]; today?: string },
): SingleNameDriverEntry[] {
  const today = opts.today ?? todayET();
  const byKey = new Map<string, { entry: SingleNameDriverEntry; reasons: Set<SingleNameDriverReason> }>();
  const priceMemo = new Map<number, boolean>();
  const add = (row: SecurityRow | null, symbol: string, reason: SingleNameDriverReason) => {
    // No row means no price: such an underlying is never listed (fix round 1).
    if (row === null || !isDriverRow(row)) return;
    let usable = priceMemo.get(row.id);
    if (usable === undefined) {
      usable = hasUsableDriverPrice(db, row.id);
      priceMemo.set(row.id, usable);
    }
    if (!usable) return;
    const sym = norm(row?.symbol ?? symbol);
    if (sym === "") return;
    const key = row !== null ? `id:${row.id}` : `sym:${sym}`;
    let hit = byKey.get(key);
    if (hit === undefined) {
      hit = {
        entry: {
          symbol: sym,
          name: row?.name ?? null,
          securityId: row?.id ?? null,
          reasons: [],
          hasContractId: row !== null && row.ib_con_id !== null,
        },
        reasons: new Set(),
      };
      byKey.set(key, hit);
    }
    hit.reasons.add(reason);
  };

  // Held non-option rows, any account, shorts included.
  const held = db
    .prepare(
      `SELECT DISTINCT ${SECURITY_COLUMNS}
         FROM holdings h JOIN securities s ON s.id = h.security_id
        WHERE ${latestHoldingsPredicate({ includeShorts: true })} AND NOT (${OPTION_ROW_SQL})`,
    )
    .all() as SecurityRow[];
  for (const row of held) add(row, row.symbol, "held");

  // The underlying of every held live option: its row when one exists, else its stored symbol.
  const underlyings = db
    .prepare(
      `SELECT DISTINCT UPPER(TRIM(s.underlying_symbol)) AS underlying
         FROM holdings h JOIN securities s ON s.id = h.security_id
        WHERE ${latestHoldingsPredicate({ includeShorts: true })}
          AND ${OPTION_ROW_SQL}
          AND ${liveOptionExpirationSql("s", today)}
          AND s.underlying_symbol IS NOT NULL AND TRIM(s.underlying_symbol) <> ''`,
    )
    .all() as { underlying: string }[];
  const rowBySymbol = db.prepare(
    `SELECT ${SECURITY_COLUMNS} FROM securities s
      WHERE UPPER(TRIM(s.symbol)) = ?
      ORDER BY (s.ib_con_id IS NULL) ASC, s.id ASC`,
  );
  for (const { underlying } of underlyings) {
    const rows = rowBySymbol.all(underlying) as SecurityRow[];
    const row = rows.find((r) => !isOptionSecurityType(r.security_type)) ?? null;
    add(row, underlying, "option-underlying");
  }

  // Trial underlyings: ids of non-option rows only.
  const byId = db.prepare(`SELECT ${SECURITY_COLUMNS} FROM securities s WHERE s.id = ?`);
  for (const id of new Set(opts.trialUnderlyingIds)) {
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const row = byId.get(id) as SecurityRow | undefined;
    if (row) add(row, row.symbol, "trial");
  }

  return [...byKey.values()]
    .map(({ entry, reasons }) => ({ ...entry, reasons: DRIVER_REASON_ORDER.filter((r) => reasons.has(r)) }))
    .sort(bySymbolThenId);
}

/**
 * One entry of the list by security id, or by symbol for an entry with no
 * row (an option underlying held only by its stored symbol). Null when the
 * list does not carry it.
 */
export function findSingleNameDriver(
  list: readonly SingleNameDriverEntry[],
  req: { securityId: number } | { symbol: string },
): SingleNameDriverEntry | null {
  if ("securityId" in req) return list.find((e) => e.securityId !== null && e.securityId === req.securityId) ?? null;
  const sym = norm(req.symbol);
  if (sym === "") return null;
  return list.find((e) => e.securityId === null && e.symbol === sym) ?? null;
}

/** F8: the names the candidate section may pull a chain for, sorted by symbol. See the module comment. */
export function listCandidateUnderlyings(
  db: Database.Database,
  opts: { drivers: readonly SingleNameDriverEntry[]; today?: string },
): CandidateUnderlyingEntry[] {
  const today = opts.today ?? todayET();
  const reasonsById = new Map<number, Set<CandidateUnderlyingReason>>();
  const add = (id: number, reason: CandidateUnderlyingReason) => {
    const set = reasonsById.get(id) ?? new Set<CandidateUnderlyingReason>();
    set.add(reason);
    reasonsById.set(id, set);
  };
  for (const d of opts.drivers) if (d.securityId !== null) add(d.securityId, "driver-list");
  for (const symbol of GAINS_AT_RISK_DRIVERS) {
    const found = lookupTrialSecurity(db, symbol, { today });
    if (found !== null) add(found.securityId, "index");
  }
  for (const id of getActiveWatchlistSecurityIds(db)) add(id, "watchlist");

  const nameOf = db.prepare("SELECT name FROM securities WHERE id = ?");
  const out: CandidateUnderlyingEntry[] = [];
  for (const [securityId, reasons] of reasonsById) {
    const check = checkTrialSecurity(db, securityId, { requireContractId: true });
    if (!check.ok) continue;
    const row = nameOf.get(securityId) as { name: string | null } | undefined;
    out.push({
      securityId,
      symbol: norm(check.symbol),
      name: row?.name ?? null,
      reasons: CANDIDATE_REASON_ORDER.filter((r) => reasons.has(r)),
    });
  }
  return out.sort(bySymbolThenId);
}
