/**
 * The enrichment pass that writes `securities.leverage_factor` (migration
 * 102) and, for a leveraged or inverse fund whose sector the AI guessed, the
 * sector of the index the fund actually tracks.
 *
 * Deterministic and idempotent: it reads stored fields, runs
 * `deriveLeverageFactor`, and writes only where the stored value differs. No
 * AI call, no network. It runs in the TWS sync's classify step and behind the
 * Classify button, and `scripts/apply-leverage-factors.ts` runs it by hand
 * against a named database (a copy, for a rehearsal).
 *
 * WHY THE SECTOR TOO (QA finding #44). A 3x bear semiconductor fund was
 * stored in Financials: the AI classifier saw "DIREX DAI SEMI BE 3X ETF-USD"
 * and guessed from the issuer, not the index. A leveraged or inverse fund
 * names the index it tracks, so for a FLAGGED row that index decides the
 * sector. Only a sector the AI wrote and nobody verified is overwritten — the
 * same protection `classify-option-sectors.ts` applies: an import,
 * the verification sweep, the broker, or an unstamped value of unknown origin
 * is never touched here.
 */

import type Database from "better-sqlite3";
import { normalizeSector } from "@/lib/securities/normalize-sector";
import { deriveLeverageFactor, type LeverageFactorIdentity } from "@/lib/securities/leverage-factor";

/** `sector_source` written by this pass. */
export const LEVERAGED_INDEX_SECTOR_SOURCE = "leveraged_index";
/** The one source this pass is allowed to overwrite (plus a blank sector). */
const OVERWRITABLE_SECTOR_SOURCES = new Set(["ai_classify", LEVERAGED_INDEX_SECTOR_SOURCE]);

/**
 * The index a leveraged or inverse fund's name states, mapped to the GICS-11
 * sector of that index. ONE SECTOR INDEX PER ENTRY: a fund on a broad index
 * (DOW30, QQQ, S&P 500) has no single sector and must get no entry, which is
 * why this table is short rather than clever. Add an entry only for an index
 * token that is unambiguous in a fund name.
 *
 *   SEMI / SEMICONDUCTOR -- the semiconductor indices (SOXX / ICE Semi), the
 *                           Technology sector. Closes QA finding #44.
 */
const TRACKED_INDEX_SECTORS: Array<[RegExp, string]> = [[/\bSEMI(?:CONDUCTORS?)?\b/i, "Technology"]];

/** The sector of the index a flagged fund's name states, or null. */
export function trackedIndexSector(name: string | null): string | null {
  const text = name ?? "";
  for (const [pattern, sector] of TRACKED_INDEX_SECTORS) {
    if (pattern.test(text)) return normalizeSector(sector);
  }
  return null;
}

export type LeverageFactorAssignment = {
  securityId: number;
  symbol: string;
  name: string | null;
  fundCategory: string | null;
  securityType: string | null;
  /** The factor the rule produced; null when the row could not be signed. */
  factor: number | null;
  source: "name" | "seed" | null;
  /** Why there is no factor (only set when `factor` is null). */
  reason?: "no_multiple";
  /** The value stored before this pass. */
  previousFactor: number | null;
  /** Set when this pass rewrote the sector: the sector of the tracked index. */
  sectorRewrittenTo?: string;
  previousSector?: string | null;
};

export type LeverageFactorPassResult = {
  /** Rows the flag rule matched (every one of them is reported). */
  flagged: LeverageFactorAssignment[];
  /** Flagged rows whose factor the rule could not derive — these stay NULL. */
  unsigned: LeverageFactorAssignment[];
  factorsWritten: number;
  factorsCleared: number;
  sectorsRewritten: number;
  /** Candidate rows read (stock, ETF and mutual-fund typed). */
  candidates: number;
};

type CandidateRow = {
  id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
  fund_category: string | null;
  sector: string | null;
  sector_source: string | null;
  sector_verified_at: string | null;
  leverage_factor: number | null;
};

/**
 * Derive and store the factor for every flagged fund. `dryRun` computes the
 * same report and writes nothing — what a rehearsal against a copy prints.
 */
export function applyLeverageFactors(
  db: Database.Database,
  opts: { dryRun?: boolean } = {},
): LeverageFactorPassResult {
  const dryRun = opts.dryRun === true;
  // Only the types the flag rule can match on their own fields. An option
  // never gets its own factor: it reads its underlying's at query time.
  const candidates = db
    .prepare(
      `SELECT id, symbol, name, security_type, fund_category, sector, sector_source,
              sector_verified_at, leverage_factor
         FROM securities
        WHERE LOWER(COALESCE(security_type, '')) IN ('stock', 'etf', 'mutual fund', 'mutual_fund')
        ORDER BY symbol`,
    )
    .all() as CandidateRow[];

  const updateFactor = db.prepare(`UPDATE securities SET leverage_factor = ? WHERE id = ?`);
  const updateSector = db.prepare(
    `UPDATE securities SET sector = ?, sector_source = '${LEVERAGED_INDEX_SECTOR_SOURCE}' WHERE id = ?`,
  );

  const flagged: LeverageFactorAssignment[] = [];
  let factorsWritten = 0;
  let factorsCleared = 0;
  let sectorsRewritten = 0;

  const run = db.transaction(() => {
    for (const row of candidates) {
      const identity: LeverageFactorIdentity = {
        symbol: row.symbol,
        security_type: row.security_type,
        fund_category: row.fund_category,
        name: row.name,
      };
      const derived = deriveLeverageFactor(identity);
      if (derived.reason === "not_flagged") {
        // A row that is not a leveraged or inverse fund must not keep a factor
        // from an earlier run (a renamed or retyped security).
        if (row.leverage_factor !== null) {
          if (!dryRun) updateFactor.run(null, row.id);
          factorsCleared++;
        }
        continue;
      }

      const assignment: LeverageFactorAssignment = {
        securityId: row.id,
        symbol: row.symbol,
        name: row.name,
        fundCategory: row.fund_category,
        securityType: row.security_type,
        factor: derived.factor,
        source: derived.source ?? null,
        previousFactor: row.leverage_factor,
        ...(derived.factor === null ? { reason: "no_multiple" as const } : {}),
      };

      if (derived.factor !== row.leverage_factor) {
        if (!dryRun) updateFactor.run(derived.factor, row.id);
        if (derived.factor === null) factorsCleared++;
        else factorsWritten++;
      }

      // The tracked index decides a flagged fund's sector — but only over a
      // sector the AI wrote and nobody verified, or a blank one.
      const indexSector = trackedIndexSector(row.name);
      const storedSector = (row.sector ?? "").trim();
      const mayRewrite =
        row.sector_verified_at === null &&
        (storedSector === "" || OVERWRITABLE_SECTOR_SOURCES.has((row.sector_source ?? "").trim()));
      if (indexSector !== null && mayRewrite && storedSector !== indexSector) {
        if (!dryRun) updateSector.run(indexSector, row.id);
        sectorsRewritten++;
        assignment.sectorRewrittenTo = indexSector;
        assignment.previousSector = row.sector;
      }

      flagged.push(assignment);
    }
  });
  run();

  return {
    flagged,
    unsigned: flagged.filter((a) => a.factor === null),
    factorsWritten,
    factorsCleared,
    sectorsRewritten,
    candidates: candidates.length,
  };
}
