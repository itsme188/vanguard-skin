/**
 * Daily-bar capture (Gains at risk addendum, Task A4; rulings B5, C1-C4, C8, C9).
 *
 * The Gains at risk betas are measured from true daily closes in
 * `ohlcv_bars`. Those rows used to exist only for securities someone opened
 * on the Charts page. This step, started by the sync pipeline after Step 6,
 * fetches two years of regular-hours daily TRADES bars from TWS for every
 * held non-option security, every live option's underlying, the three
 * driver indexes and every seeded tracked index, a few at a time.
 *
 * Rules that keep the stored bars trustworthy:
 *   - Never a bar for today or for a closed market day: every request ends
 *     at the previous trading day (`maxBarDate`), and the result is filtered
 *     again here before it is written.
 *   - Never trust a stored trailing bar (C1): every capture refetches the 14
 *     calendar days before the stored latest priced bar and overwrites them,
 *     so a mid-session bar the Charts page stored becomes the true close.
 *   - A change of adjustment basis (C2): when any refetched close compared
 *     with a stored close (the stored latest bar left out) differs by more
 *     than 0.5%, the full two years are refetched and the window is replaced
 *     in one transaction, with the older daily bars (old basis) deleted, so a
 *     split TWS has applied since is never spliced onto old-basis bars. When
 *     fewer than 5 sessions compare (a halt, a sparse name), the window is
 *     refetched and replaced the same way, but nothing older is deleted and
 *     no basis change is counted (final review, 2026-11-24).
 *   - "Done for today" is this process's own ledger (C1, C9), reset when the
 *     Eastern day changes: a stored latest date never marks a security fresh.
 *   - Budget (C8): at most 20 securities per run, at most one run per 25
 *     minutes per process, one run at a time, every request through the same
 *     global OHLCV limiter as the Charts daily path (`fetchOhlcvBars`).
 *
 * Writes only `ohlcv_bars`, only from TWS, only through the bad-bar guard.
 * Never throws: a failure is counted and logged with a symbol and an error
 * class, never a message, a price or a quantity.
 */

import type Database from "better-sqlite3";
import { getIbApi } from "./client";
import { fetchOhlcvBars, storableDailyBars, type FetchedOhlcvBar } from "./ohlcv";
import { getPricedDailyBarRange, getPricedDailyCloses } from "@/lib/queries/ohlcv";
import { replaceDailyBarsInWindow, upsertOhlcvBars } from "@/lib/mutations/ohlcv";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { getLiveHeldOptionUnderlyings } from "./option-underlyings";
import { isOptionSecurityType } from "@/lib/compute/option-elasticity";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { LEVERAGED_TRACKED_INDEX_SEEDS } from "@/lib/securities/leveraged-tracked-index";
import { GAINS_AT_RISK_DRIVERS } from "@/lib/analysis/gains-at-risk-input";
import { addDays, calendarDaysBetween, todayET } from "@/lib/calendar/date-utils";
import { isMarketClosed, previousTradingDay } from "@/lib/calendar/market-holidays";
import { isUsSessionSecurity } from "@/lib/compute/security-regression";
import { isBondFundWithoutMarketMove } from "@/lib/compute/scenarios";

export const DAILY_BAR_CAPTURE_MAX_PER_BATCH = 20;
export const DAILY_BAR_BATCH_MIN_INTERVAL_MS = 25 * 60 * 1000;
export const DAILY_BAR_HISTORY_DAYS = 730;
/** Calendar days refetched before the stored latest bar: at least 5 sessions in any two weeks. */
export const DAILY_BAR_OVERLAP_CALENDAR_DAYS = 14;
export const DAILY_BAR_MIN_OVERLAP_SESSIONS = 5;
/** 0.5% on a close. */
export const DAILY_BAR_BASIS_TOLERANCE = 0.005;

/**
 * A stored history whose earliest priced bar is later than this many days
 * before today is treated as short and fetched in full (730 days less a
 * week of slack for the first session of the window falling on a weekend
 * or holiday).
 */
const DAILY_BAR_FULL_HISTORY_DAYS = DAILY_BAR_HISTORY_DAYS - 7;
const FULL_DURATION = "2 Y";
/** TWS's "N D" form is used up to a year; past that the full window is asked for. */
const MAX_DAY_DURATION = 365;
const BAR_SIZE = "1 day";

interface DailyBarLedger {
  day: string;
  succeeded: Set<number>;
  exhausted: Set<number>;
  failed: Set<number>;
}

type CaptureGlobals = {
  __tws_dailyBarLedger?: DailyBarLedger;
  __tws_dailyBarLastBatchAt?: number;
  __tws_dailyBarRunning?: boolean;
};
const g = globalThis as unknown as CaptureGlobals;

function ledgerFor(today: string): DailyBarLedger {
  const cur = g.__tws_dailyBarLedger;
  if (cur && cur.day === today) return cur;
  const fresh: DailyBarLedger = { day: today, succeeded: new Set(), exhausted: new Set(), failed: new Set() };
  g.__tws_dailyBarLedger = fresh;
  return fresh;
}

/**
 * The fields of one `securities` row that decide whether the capture fetches
 * its daily bars. Column names are the table's own.
 */
export interface DailyBarEligibilityRow {
  /** `securities.security_type` (any casing). */
  security_type: string | null;
  /** `securities.fund_category`. */
  fund_category: string | null;
  /** `securities.sector`. */
  sector: string | null;
  /** `securities.name`. */
  name: string | null;
  /** `securities.duration_years`. */
  duration_years: number | null;
  /** `securities.currency` (NULL reads as USD). */
  currency: string | null;
  /** `securities.ib_con_id`. */
  ib_con_id: number | null;
}

export type DailyBarIneligibleReason =
  | "option"
  | "mutual-fund"
  | "bond-fund"
  | "bond-or-cash"
  | "no-contract-id"
  | "not-us-session";

export type DailyBarEligibility = { eligible: true } | { eligible: false; reason: DailyBarIneligibleReason };

function isMutualFundType(type: string | null): boolean {
  const t = (type ?? "").trim().toLowerCase();
  return t === "mutual fund" || t === "mutual_fund";
}

/**
 * Whether the daily-bar capture will ever fetch this security's bars: the
 * ONE rule, read by `listDailyBarTargets` and by the Gains at risk engine
 * (to tell a name the capture never fetches from one still waiting).
 * Pure: no database, no broker. Checked in this order:
 *   - `option`: an option (its underlying is captured instead);
 *   - `bond-or-cash`: an individual bond, or a cash-equivalent
 *     (`isCashEquivalentSecurity`);
 *   - `mutual-fund`: the shared fetcher asks for TRADES, a fund needs
 *     another data type (`getWhatToShow`);
 *   - `bond-fund`: a bond fund with no equity market move, by the scenario
 *     engine's own test (`isBondFundWithoutMarketMove`);
 *   - `not-us-session`: stored currency not USD (ruling C4,
 *     `isUsSessionSecurity`);
 *   - `no-contract-id`: no IB contract id yet (it becomes eligible once the
 *     enrichment step finds one).
 */
export function dailyBarCaptureEligibility(row: DailyBarEligibilityRow): DailyBarEligibility {
  const type = (row.security_type ?? "").trim().toLowerCase();
  if (isOptionSecurityType(row.security_type)) return { eligible: false, reason: "option" };
  if (type === "bond" || isCashEquivalentSecurity({ security_type: row.security_type, fund_category: row.fund_category })) {
    return { eligible: false, reason: "bond-or-cash" };
  }
  if (isMutualFundType(row.security_type)) return { eligible: false, reason: "mutual-fund" };
  if (
    isBondFundWithoutMarketMove({
      security_type: row.security_type ?? "",
      security_name: row.name,
      sector: row.sector,
      fund_category: row.fund_category,
      duration_years: row.duration_years,
    })
  ) {
    return { eligible: false, reason: "bond-fund" };
  }
  if (!isUsSessionSecurity(row.currency)) return { eligible: false, reason: "not-us-session" };
  if (row.ib_con_id == null) return { eligible: false, reason: "no-contract-id" };
  return { eligible: true };
}

interface CandidateRow extends DailyBarEligibilityRow {
  id: number;
  symbol: string;
}

const CANDIDATE_COLUMNS = `s.id, s.symbol, s.security_type, s.ib_con_id, s.currency,
       s.name, s.sector, s.fund_category, s.duration_years`;

export interface DailyBarTargets {
  /** Security ids to capture, no priced bars first, then the oldest priced latest bar. */
  targets: number[];
  /** Left out: stored currency not USD (C4). */
  foreignSession: number;
  /** Left out: no IB contract id yet. */
  noContractId: number;
  /**
   * Left out: a mutual fund. The shared fetcher asks for TRADES and a fund
   * needs another data type (`getWhatToShow`), so its request would fail.
   */
  mutualFund: number;
  /**
   * Left out: a bond fund that takes no equity market move, by the scenario
   * engine's own test (`isBondFundWithoutMarketMove`). Its beta is fixed, so
   * its bars are never read for one.
   */
  bondFund: number;
}


/**
 * Every security whose daily bars the Gains at risk betas read (C3):
 *   - the identity of every held row (latest holdings per account and
 *     security, any account, non-zero quantity, shorts included): the
 *     security itself for a non-option, the underlying's row for a live
 *     option (`getLiveHeldOptionUnderlyings`, the sync's one definition);
 *   - the three drivers and every tracked index in the seed map, held or not,
 *     whenever a securities row with a contract id exists.
 * Left out: options, bonds and cash-equivalents (silently); counted: a
 * mutual fund (`mutualFund`), a bond fund with no market move (`bondFund`),
 * a non-USD security (`foreignSession`) and a row with no contract id
 * (`noContractId`).
 *
 * `opts.trackedIndexSeeds` defaults to `LEVERAGED_TRACKED_INDEX_SEEDS`;
 * tests pass a synthetic map.
 */
export function listDailyBarTargets(
  db: Database.Database,
  today: string,
  opts: { trackedIndexSeeds?: Readonly<Record<string, string>> } = {},
): DailyBarTargets {
  const candidates = new Map<number, CandidateRow>();

  const held = db
    .prepare(
      `SELECT DISTINCT ${CANDIDATE_COLUMNS}
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE ${latestHoldingsPredicate({})}`,
    )
    .all() as CandidateRow[];
  for (const row of held) if (!isOptionSecurityType(row.security_type)) candidates.set(row.id, row);

  const underlyingIds = getLiveHeldOptionUnderlyings(db, today).map((u) => u.id);
  const byId = db.prepare(`SELECT ${CANDIDATE_COLUMNS} FROM securities s WHERE s.id = ?`);
  for (const id of underlyingIds) {
    if (candidates.has(id)) continue;
    const row = byId.get(id) as CandidateRow | undefined;
    if (row) candidates.set(id, row);
  }

  const seeds = opts.trackedIndexSeeds ?? LEVERAGED_TRACKED_INDEX_SEEDS;
  const named = new Set<string>(GAINS_AT_RISK_DRIVERS.map((d) => d.toUpperCase()));
  for (const tracked of Object.values(seeds)) {
    if (typeof tracked === "string" && tracked.trim() !== "") named.add(tracked.trim().toUpperCase());
  }
  const bySymbol = db.prepare(
    `SELECT ${CANDIDATE_COLUMNS} FROM securities s
      WHERE UPPER(TRIM(s.symbol)) = ? AND s.ib_con_id IS NOT NULL
      ORDER BY s.id`,
  );
  for (const symbol of named) {
    for (const row of bySymbol.all(symbol) as CandidateRow[]) {
      if (!candidates.has(row.id)) candidates.set(row.id, row);
    }
  }

  let foreignSession = 0;
  let noContractId = 0;
  let mutualFund = 0;
  let bondFund = 0;
  const kept: { id: number; latest: string | null }[] = [];
  for (const row of candidates.values()) {
    const verdict = dailyBarCaptureEligibility(row);
    if (!verdict.eligible) {
      if (verdict.reason === "mutual-fund") mutualFund++;
      else if (verdict.reason === "bond-fund") bondFund++;
      else if (verdict.reason === "not-us-session") foreignSession++;
      else if (verdict.reason === "no-contract-id") noContractId++;
      continue; // options, bonds and cash-equivalents are left out silently
    }
    kept.push({ id: row.id, latest: getPricedDailyBarRange(db, row.id)?.latest ?? null });
  }
  kept.sort((a, b) => {
    if (a.latest == null && b.latest != null) return -1;
    if (a.latest != null && b.latest == null) return 1;
    if (a.latest != null && b.latest != null && a.latest !== b.latest) return a.latest < b.latest ? -1 : 1;
    return a.id - b.id;
  });
  return { targets: kept.map((k) => k.id), foreignSession, noContractId, mutualFund, bondFund };
}

export interface DailyBarCaptureResult {
  /** Securities tried this run. */
  attempted: number;
  /** Securities whose bars were written this run. */
  written: number;
  /** Two-year requests sent this run (first fill, short stored history, or a basis change). */
  fullRefetches: number;
  /** Overlaps that disagreed with the stored closes this run (C2). */
  basisChanges: number;
  /** Daily bars older than the window deleted after a basis change this run (they were on the old basis). */
  staleOlderBarsDeleted: number;
  /** Securities whose capture failed this run (not retried today). A short full reply that was refused counts here. */
  failed: number;
  /** Securities this process has captured successfully today, this run included. */
  doneToday: number;
  /** Securities whose broker history is shorter than two years, found today. */
  exhausted: number;
  foreignSession: number;
  noContractId: number;
  mutualFund: number;
  bondFund: number;
  skippedReason?: "tws-not-connected" | "already-running" | "batch-window";
}

export interface DailyBarCaptureOptions {
  /** Eastern date; defaults to `todayET()`. */
  today?: string;
  /** Epoch ms for the batch window; defaults to `Date.now()`. */
  now?: number;
  /** Cap on securities this run; defaults to 20. The backfill script passes Infinity. */
  maxSecurities?: number;
  /** The backfill script's one-shot run ignores the 25-minute window. */
  ignoreBatchWindow?: boolean;
  /** Injected for tests; defaults to the shared, rate-limited fetcher. */
  fetch?: typeof fetchOhlcvBars;
}

function emptyResult(skippedReason?: DailyBarCaptureResult["skippedReason"]): DailyBarCaptureResult {
  return {
    attempted: 0,
    written: 0,
    fullRefetches: 0,
    basisChanges: 0,
    staleOlderBarsDeleted: 0,
    failed: 0,
    doneToday: 0,
    exhausted: 0,
    foreignSession: 0,
    noContractId: 0,
    mutualFund: 0,
    bondFund: 0,
    ...(skippedReason ? { skippedReason } : {}),
  };
}

/** A content-free class for a failure: never the message, which can carry contract detail. */
function errorClass(err: unknown): string {
  if (err instanceof ShortFullReplyError) return "short-full-reply";
  const msg = err instanceof Error ? err.message : "";
  if (/timeout/i.test(msg)) return "timeout";
  if (/not connected/i.test(msg)) return "not-connected";
  if (/pacing/i.test(msg)) return "pacing";
  if (/no ib contract id/i.test(msg)) return "no-contract-id";
  return err instanceof Error ? err.name || "Error" : typeof err;
}

/** A two-year reply that would delete good stored bars (see `checkFullReply`). */
class ShortFullReplyError extends Error {
  constructor() {
    super("short full reply");
    this.name = "ShortFullReplyError";
  }
}

/** "N D" covering `fromDate` through today, or the full window past a year. */
function durationFrom(fromDate: string, today: string): string {
  const days = calendarDaysBetween(fromDate, today) + 1;
  return days > MAX_DAY_DURATION ? FULL_DURATION : `${days} D`;
}

/** Open market days strictly after `from` and on or before `to`. */
function sessionsAfter(from: string, to: string): number {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (!isMarketClosed(d)) n++;
  return n;
}

/**
 * A full reply may replace the stored window only when it covers what is
 * stored (fix round 1, 2026-11-24): its first bar no more than
 * `FULL_REPLY_MAX_LATE_SESSIONS` sessions after the stored earliest priced
 * bar in the window, and at least `FULL_REPLY_MIN_SHARE` as many bars as are
 * stored there. A reply holding only the last few weeks would otherwise
 * delete two years of good bars. With nothing stored in the window there is
 * nothing to lose: a plain first fill.
 */
const FULL_REPLY_MAX_LATE_SESSIONS = 5;
const FULL_REPLY_MIN_SHARE = 0.9;

function fullReplyCovers(bars: FetchedOhlcvBar[], storedInWindow: Map<string, number>): boolean {
  if (storedInWindow.size === 0) return true;
  if (bars.length === 0) return false;
  const storedEarliest = [...storedInWindow.keys()].sort()[0];
  if (bars[0].date > storedEarliest && sessionsAfter(storedEarliest, bars[0].date) > FULL_REPLY_MAX_LATE_SESSIONS) {
    return false;
  }
  return bars.length >= FULL_REPLY_MIN_SHARE * storedInWindow.size;
}

type OverlapVerdict = "agree" | "mismatch" | "too-few";

/** Compare the refetched overlap with the stored closes (C2), the stored latest bar left out. */
function compareOverlap(
  fetched: FetchedOhlcvBar[],
  stored: Map<string, number>,
  storedLatest: string,
): OverlapVerdict {
  let compared = 0;
  for (const b of fetched) {
    if (b.date === storedLatest) continue; // may be a mid-session bar
    const s = stored.get(b.date);
    if (s == null) continue;
    if (!(b.close > 0)) return "mismatch";
    compared++;
    if (Math.abs(b.close / s - 1) > DAILY_BAR_BASIS_TOLERANCE) return "mismatch";
  }
  return compared >= DAILY_BAR_MIN_OVERLAP_SESSIONS ? "agree" : "too-few";
}

type Outcome = "succeeded" | "exhausted" | "failed";

/**
 * Capture one batch. Never throws (a caller in the sync pipeline does not
 * await it); every answer is a result with counts.
 *
 * Per security:
 *   - nothing stored in the window (no bars, or a stored latest older than
 *     the window): one two-year request, written as a plain fill;
 *   - a stored history that starts too late: one two-year request, replacing
 *     the window when the reply covers what is stored;
 *   - otherwise the overlap request. If it agrees, it is upserted. If closes
 *     compare and differ, that is a basis change: a two-year request (or the
 *     overlap reply itself, when the overlap request was already two years)
 *     replaces the window, and the daily bars older than the window, which
 *     are on the old basis, are deleted in the same transaction. If too few
 *     sessions compare, the same full reply replaces the window, but nothing
 *     older is deleted and no basis change is counted.
 * Every replace first passes the short-reply guard; a refused reply is a
 * failure and changes nothing. A security is marked exhausted only by a full
 * reply that was written. A disconnect during a request leaves the security
 * unrecorded, so it is retried after a reconnect.
 */
export async function runDailyBarCapture(
  db: Database.Database,
  opts: DailyBarCaptureOptions = {},
): Promise<DailyBarCaptureResult> {
  if (!getIbApi()) return emptyResult("tws-not-connected");
  if (g.__tws_dailyBarRunning) return emptyResult("already-running");
  const now = opts.now ?? Date.now();
  const last = g.__tws_dailyBarLastBatchAt;
  if (!opts.ignoreBatchWindow && last !== undefined && now - last < DAILY_BAR_BATCH_MIN_INTERVAL_MS && now >= last) {
    return emptyResult("batch-window");
  }

  g.__tws_dailyBarRunning = true;
  g.__tws_dailyBarLastBatchAt = now;
  const result = emptyResult();
  try {
    const today = opts.today ?? todayET();
    const fetchBars = opts.fetch ?? fetchOhlcvBars;
    const cap = opts.maxSecurities ?? DAILY_BAR_CAPTURE_MAX_PER_BATCH;
    const ledger = ledgerFor(today);
    const maxBarDate = previousTradingDay(today);
    const windowStart = addDays(today, -DAILY_BAR_HISTORY_DAYS);
    const fullHistoryFloor = addDays(today, -DAILY_BAR_FULL_HISTORY_DAYS);

    let listed: DailyBarTargets;
    try {
      listed = listDailyBarTargets(db, today);
    } catch (err) {
      console.warn(`[daily-bars] target list failed: ${errorClass(err)}`);
      return result;
    }
    result.foreignSession = listed.foreignSession;
    result.noContractId = listed.noContractId;
    result.mutualFund = listed.mutualFund;
    result.bondFund = listed.bondFund;

    const due = listed.targets.filter(
      (id) => !ledger.succeeded.has(id) && !ledger.exhausted.has(id) && !ledger.failed.has(id),
    );

    const request = async (securityId: number, durationStr: string): Promise<FetchedOhlcvBar[]> => {
      if (durationStr === FULL_DURATION) result.fullRefetches++;
      const res = await fetchBars(db, { securityId, durationStr, incremental: false, store: false, maxBarDate });
      return storableDailyBars(res.bars, maxBarDate);
    };
    const fullOutcome = (bars: FetchedOhlcvBar[]): Outcome =>
      bars[0].date <= fullHistoryFloor ? "succeeded" : "exhausted";

    /** Replace the window with a full reply, behind the short-reply guard. */
    const replaceWithFull = (securityId: number, bars: FetchedOhlcvBar[], basisChanged: boolean): Outcome => {
      if (bars.length === 0) throw new Error("empty full fetch");
      const storedInWindow = getPricedDailyCloses(db, securityId, windowStart);
      if (!fullReplyCovers(bars, storedInWindow)) throw new ShortFullReplyError();
      if (storedInWindow.size === 0 && !basisChanged) {
        upsertOhlcvBars(db, securityId, BAR_SIZE, bars);
      } else {
        const r = replaceDailyBarsInWindow(db, securityId, windowStart, bars, { deleteOlderDailyBars: basisChanged });
        if (r.inserted === 0) throw new Error("no sane bar in full fetch");
        if (r.olderDeleted > 0) {
          result.staleOlderBarsDeleted += r.olderDeleted;
          console.log(`[daily-bars] #${securityId}: ${r.olderDeleted} older daily bars on the old basis deleted`);
        }
      }
      return fullOutcome(bars);
    };

    for (const securityId of due) {
      if (result.attempted >= cap) break;
      if (!getIbApi()) break; // disconnected mid-run: stop, count nothing as failed
      result.attempted++;
      let outcome: Outcome;
      try {
        const range = getPricedDailyBarRange(db, securityId);
        if (!range || range.latest < windowStart || range.earliest > fullHistoryFloor) {
          outcome = replaceWithFull(securityId, await request(securityId, FULL_DURATION), false);
        } else {
          const overlapStart = addDays(range.latest, -DAILY_BAR_OVERLAP_CALENDAR_DAYS);
          const duration = durationFrom(overlapStart, today);
          const overlap = await request(securityId, duration);
          const verdict = compareOverlap(overlap, getPricedDailyCloses(db, securityId, overlapStart), range.latest);
          if (verdict === "agree") {
            upsertOhlcvBars(db, securityId, BAR_SIZE, overlap);
            outcome = "succeeded";
          } else if (verdict === "too-few") {
            // Too few sessions compare: a halt or a sparse name as often as a split.
            // Refetch the window in full (reusing a reply that already is), replace it
            // behind the guard, but delete nothing older and count no basis change.
            const full = duration === FULL_DURATION ? overlap : await request(securityId, FULL_DURATION);
            outcome = replaceWithFull(securityId, full, false);
          } else {
            // Closes compared and differ beyond the tolerance: a real basis change.
            result.basisChanges++;
            const full = duration === FULL_DURATION ? overlap : await request(securityId, FULL_DURATION);
            outcome = replaceWithFull(securityId, full, true);
          }
        }
        result.written++;
      } catch (err) {
        if (!getIbApi()) {
          // Disconnected during the request: leave it unrecorded so a reconnect retries it.
          break;
        }
        outcome = "failed";
        result.failed++;
        const sym = (db.prepare("SELECT symbol FROM securities WHERE id = ?").get(securityId) as
          | { symbol: string }
          | undefined)?.symbol;
        console.warn(`[daily-bars] ${sym ?? `#${securityId}`}: ${errorClass(err)}`);
      }
      ledger[outcome].add(securityId);
    }

    result.doneToday = ledger.succeeded.size;
    result.exhausted = ledger.exhausted.size;
    return result;
  } catch (err) {
    console.warn(`[daily-bars] capture stopped: ${errorClass(err)}`);
    return result;
  } finally {
    g.__tws_dailyBarRunning = false;
  }
}
