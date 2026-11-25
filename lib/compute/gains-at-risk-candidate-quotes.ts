/**
 * Gains at risk, step 3: the server glue the routes share (Task S4).
 *
 *   - `quoteCandidates` (call 1, P10, P13, F2, F5, F9): the quote batch for
 *     one underlying, then, per two-sided row, the entry solved ONCE by
 *     security id at the quote's own underlying price (`buildTrialEntryById`).
 *     One clock (`now`) reaches the batch and every entry. A batch row without
 *     the quote's own underlying within the allowed gap is answered
 *     "not quoted: prices read too far apart" and no entry is solved for it.
 *   - `resolveGainsAtRiskInput` (the compute and candidates routes): the body
 *     turned into the engine's input. With no `driver` it is exactly step 2's
 *     input (P8); with one, the name must be on the server's own list
 *     (`listSingleNameDrivers` + `findSingleNameDriver`, P1, T20).
 *
 * Read-only over the database; nothing about a candidate or a quote is stored.
 */

import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";
import { quoteSessionLabel } from "@/lib/calendar/market-session";
import { CANDIDATE_MAX_OBSERVATION_GAP_SECONDS } from "@/lib/analysis/gains-at-risk-constants";
import { cleanTrialPositions, trialPositionSecurityId, type GainsAtRiskBody } from "@/lib/analysis/gains-at-risk-input";
import {
  batchRefusalSentence,
  DRIVER_NOT_LISTED_SENTENCE,
  type CandidateEntryRecord,
  type QuoteRow,
  type QuotesBody,
  type QuotesResponse,
} from "@/lib/analysis/gains-at-risk-candidates-input";
import { trialEntryRefusalSentence } from "@/lib/analysis/gains-at-risk-input";
import { fetchOptionQuoteBatch, type OptionQuoteBatchDeps, type OptionQuoteBatchResult } from "@/lib/tws/option-quote-batch";
import type { GainsAtRiskInput } from "./gains-at-risk";
import { buildTrialEntryById, checkTrialSecurity, trialValuationPrice } from "./gains-at-risk-trial";
import { isExpiredAsOf } from "./options-greeks";
import { findSingleNameDriver, listSingleNameDrivers } from "./gains-at-risk-drivers";
import type { CandidateQuoteFields } from "./gains-at-risk-candidate-check";

export type QuoteCandidatesFailure = Extract<OptionQuoteBatchResult, { ok: false }>;

/** Call 1. `deps.now` (F9) is the one clock of the batch and of every entry. */
export async function quoteCandidates(
  db: Database.Database,
  body: QuotesBody,
  deps: OptionQuoteBatchDeps = {},
): Promise<{ ok: true; data: QuotesResponse } | QuoteCandidatesFailure> {
  const now = deps.now ?? (() => new Date());
  const batch = await fetchOptionQuoteBatch(db, body, { ...deps, now });
  if (!batch.ok) return batch;

  const gapMs = CANDIDATE_MAX_OBSERVATION_GAP_SECONDS * 1000;
  const rows: QuoteRow[] = body.contracts.map((want, i): QuoteRow => {
    const got = batch.contracts[i];
    if (got === undefined || got.conId !== want.conId) {
      // The batch answers one row per contract in request order; anything else is a fault, never a guess.
      return notQuoted(want.conId, "broker-error", null, null);
    }
    if (!got.ok) {
      return {
        conId: got.conId,
        status: "not-quoted",
        reason: got.reason,
        ...(got.retryAfterSeconds !== undefined ? { retryAfterSeconds: got.retryAfterSeconds } : {}),
        sentence: batchRefusalSentence(got.reason, got.retryAfterSeconds),
        bid: got.bid,
        ask: got.ask,
      };
    }
    // F5: the entry is solved only at the quote's own underlying, read within the gap.
    const optionAt = Date.parse(got.optionObservedAt);
    const underlyingAt = Date.parse(got.underlyingObservedAt);
    if (
      !(Number.isFinite(got.underlyingPrice) && got.underlyingPrice > 0) ||
      !Number.isFinite(optionAt) ||
      !Number.isFinite(underlyingAt) ||
      Math.abs(optionAt - underlyingAt) > gapMs
    ) {
      return notQuoted(got.conId, "not-quoted-prices-too-far-apart", got.bid, got.ask);
    }
    const quote: CandidateQuoteFields = {
      bid: got.bid,
      ask: got.ask,
      mid: got.mid,
      tickKind: got.tickKind,
      session: quoteSessionLabel(new Date(optionAt)),
      optionObservedAt: got.optionObservedAt,
      underlyingObservedAt: got.underlyingObservedAt,
      underlyingPrice: got.underlyingPrice,
    };
    const entry = buildTrialEntryById(
      db,
      {
        kind: "option",
        underlyingSecurityId: body.underlyingSecurityId,
        right: want.right,
        side: "buy",
        expiry: want.expiry,
        strike: want.strike,
        contracts: 1,
        price: got.mid,
        quotedUnderlyingPrice: got.underlyingPrice,
        brokerContractId: got.conId,
      },
      { now },
    );
    if (!entry.ok) {
      return {
        conId: got.conId,
        status: "no-entry",
        quote,
        refusal: entry.reason,
        sentence: trialEntryRefusalSentence(entry.reason, entry.symbol),
      };
    }
    const record: CandidateEntryRecord = {
      entry,
      underlyingPriceSource: "client-quote",
      appValuation: trialValuationPrice(db, body.underlyingSecurityId, { today: todayET(now()) }),
    };
    return { conId: got.conId, status: "quoted", quote, record };
  });

  return {
    ok: true,
    data: { underlyingSecurityId: body.underlyingSecurityId, requestedConIds: body.contracts.map((c) => c.conId), rows },
  };
}

function notQuoted(
  conId: number,
  reason: Extract<QuoteRow, { status: "not-quoted" }>["reason"],
  bid: number | null,
  ask: number | null,
): QuoteRow {
  return { conId, status: "not-quoted", reason, sentence: batchRefusalSentence(reason), bid, ask };
}

/**
 * A body that passed `gainsAtRiskBodyProblem`, as the engine's input. With no
 * `driver` the input carries exactly step 2's keys (P8: the reply stays
 * byte-identical); `selectedMove` is passed only when the body has one. A
 * single-name driver must be on the server-built list (the trial positions'
 * underlyings included); else `{ ok: false }` with the 400 sentence.
 * `accountIds` is the route's own `gainsAtRiskAccountIds(db, body.scope)` (the
 * one stress-scope rule, called in the route itself).
 */
export function resolveGainsAtRiskInput(
  db: Database.Database,
  body: GainsAtRiskBody,
  accountIds: number[] | undefined,
  today: string,
): { ok: true; input: GainsAtRiskInput } | { ok: false; error: string } {
  const trialPositions = body.trialPositions ? cleanTrialPositions(body.trialPositions) : undefined;
  let driver: GainsAtRiskInput["driver"];
  if (body.driver !== undefined) {
    const list = listSingleNameDrivers(db, {
      trialUnderlyingIds: possibleTrialUnderlyings(db, (trialPositions ?? []).map(trialPositionSecurityId)),
      today,
    });
    const found = findSingleNameDriver(
      list,
      "securityId" in body.driver ? { securityId: body.driver.securityId } : { symbol: body.driver.symbol },
    );
    if (found === null) return { ok: false, error: DRIVER_NOT_LISTED_SENTENCE };
    driver = { kind: "single-name", symbol: found.symbol, securityId: found.securityId };
  }
  const input: GainsAtRiskInput = {
    accountIds,
    driverSymbol: body.driverSymbol,
    valuationDate: body.valuationDate,
    moves: body.moves,
    volChangePoints: body.volChangePoints,
    priceOverrides: body.priceOverrides,
    // Keyed by the underlying identity's security id (C6); the engine counts unmatched keys.
    betaOverrides: body.betaOverrides,
    trialPositions,
    today,
    ...(driver !== undefined ? { driver } : {}),
    ...(body.selectedMove !== undefined ? { selectedMove: body.selectedMove } : {}),
  };
  return { ok: true, input };
}

/**
 * Fix round 1: the trial underlying ids that may join the driver list, those
 * that pass `checkTrialSecurity` (known, not an option, US dollar: a real
 * possible trial underlying). The list itself then applies the price rule
 * (`hasUsableDriverPrice`). Order kept, repeats dropped.
 */
export function possibleTrialUnderlyings(db: Database.Database, ids: readonly number[]): number[] {
  return [...new Set(ids)].filter((id) => checkTrialSecurity(db, id, { requireContractId: false }).ok);
}

/**
 * Fix round 1: an expiry the body check passed but that no longer trades by
 * the chain reader's own rule (`isExpiredAsOf`: any day before today, and
 * today from the 16:00 Eastern close). One sentence naming the field, or null.
 */
export function expiryNotLiveProblem(
  expiries: readonly { field: string; expiry: string }[],
  now: Date,
): string | null {
  const today = todayET(now);
  for (const { field, expiry } of expiries) {
    if (isExpiredAsOf(expiry, today, now)) return `${field} has stopped trading (today's expiry ends at the 16:00 Eastern close).`;
  }
  return null;
}
