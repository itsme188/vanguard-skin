/**
 * Gains at risk, step 3: call 2, the candidate table (P10, P12, P13, D3, D9).
 *
 * Every candidate arrives with its quote and the entry call 1 solved for it
 * (never solved again: a budget change changes the contract count and the
 * dollars only, R1). Each row is sized in exact whole units (D9): contracts =
 * floor(budget / (mid x 100)), capped at `maxContracts`; cost + unspent =
 * budget. A row of zero contracts is left out of the engine call. Then ONE
 * engine run prices the book, the trial positions and every sized candidate on
 * one run context (the book loads once). The book's own figures never include
 * a candidate.
 *
 * Pure over the database (read-only); no broker. The route runs the body
 * checks first; this module re-runs the candidate validator (D3, F4) and
 * throws `GainsAtRiskInputError` on a bad input, so it cannot size on one
 * price and value on another.
 */

import type Database from "better-sqlite3";
import { budgetToUnits, sizeCandidate, toMoneyUnits, unitsToUsd } from "@/lib/analysis/gains-at-risk-candidate-money";
import {
  computeGainsAtRisk,
  GainsAtRiskInputError,
  type GainsAtRiskCandidateInput,
  type GainsAtRiskCandidateResult,
  type GainsAtRiskInput,
  type GainsAtRiskOptions,
  type GainsAtRiskResult,
  type TrialRefusal,
} from "./gains-at-risk";
import { candidatesProblem, type CandidateQuoteFields, type CandidateRequestItem } from "./gains-at-risk-candidate-check";

type ClientQuote = CandidateQuoteFields & { source: "client-supplied" };

export type CandidateRow =
  | {
      conId: number;
      status: "priced";
      contracts: number;
      capped: boolean;
      perContractUsd: number;
      costUsd: number;
      unspentUsd: number;
      quote: ClientQuote;
      engine: GainsAtRiskCandidateResult;
    }
  | { conId: number; status: "zero-contracts"; perContractUsd: number; quote: ClientQuote }
  | { conId: number; status: "refused"; refusal: TrialRefusal; contracts: number; perContractUsd: number; quote: ClientQuote };

/** The engine id of a candidate: its broker contract id (D1). */
function candidateId(conId: number): string {
  return String(conId);
}

/** Sizes (D9), then ONE engine run with every candidate of at least one contract. `result` carries no candidates key. */
export function computeGainsAtRiskCandidates(
  db: Database.Database,
  input: GainsAtRiskInput,
  req: { budgetUsd: number; selectedMove: number; candidates: CandidateRequestItem[] },
  opts?: GainsAtRiskOptions,
): { result: GainsAtRiskResult; rows: CandidateRow[] } {
  const budgetUnits = budgetToUnits(req.budgetUsd);
  if (budgetUnits === null) throw new GainsAtRiskInputError("budgetUsd must be whole cents above 0, within the bound");
  const problem = candidatesProblem(req.candidates);
  if (problem !== null) throw new GainsAtRiskInputError(problem);

  const sized = req.candidates.map((item) => {
    // The validator has proved both prices sit on the grid as safe whole units.
    const sizing = sizeCandidate(budgetUnits, toMoneyUnits(item.quote.bid) as number, toMoneyUnits(item.quote.ask) as number);
    return { item, sizing, quote: { ...item.quote, source: "client-supplied" as const } };
  });

  const engineCandidates: GainsAtRiskCandidateInput[] = sized
    .filter((s) => s.sizing.contracts > 0)
    .map(({ item, sizing }) => ({
      id: candidateId(item.conId),
      position: {
        kind: "option",
        id: candidateId(item.conId),
        underlyingSecurityId: item.entry.underlyingSecurityId,
        right: item.entry.right,
        side: "buy",
        expiry: item.entry.expiry,
        strike: item.entry.strike,
        contracts: sizing.contracts,
        // Equal to the quote's mid (D3): the one price that sized the row drives its P&L.
        pricePaid: item.entry.pricePaid,
        entryUnderlyingPrice: item.entry.entryUnderlyingPrice,
        valuationPriceAtEntry: item.entry.valuationPriceAtEntry,
        entryVolatility: item.entry.entryVolatility,
        brokerContractId: item.entry.brokerContractId,
      },
    }));

  const full = computeGainsAtRisk(
    db,
    { ...input, selectedMove: req.selectedMove, candidates: engineCandidates },
    opts,
  );
  const { candidates: engineRows, ...result } = full;
  const byId = new Map((engineRows ?? []).map((r) => [r.id, r]));

  const rows = sized.map(({ item, sizing, quote }): CandidateRow => {
    const perContractUsd = unitsToUsd(sizing.perContractUnits);
    if (sizing.contracts === 0) return { conId: item.conId, status: "zero-contracts", perContractUsd, quote };
    const engine = byId.get(candidateId(item.conId));
    if (engine === undefined) throw new Error("a sized candidate has no engine row");
    if (engine.refusal !== undefined) {
      return { conId: item.conId, status: "refused", refusal: engine.refusal, contracts: sizing.contracts, perContractUsd, quote };
    }
    return {
      conId: item.conId,
      status: "priced",
      contracts: sizing.contracts,
      capped: sizing.capped,
      perContractUsd,
      costUsd: unitsToUsd(sizing.costUnits),
      unspentUsd: unitsToUsd(sizing.unspentUnits),
      quote,
      engine,
    };
  });
  return { result, rows };
}
