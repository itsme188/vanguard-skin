import type Database from "better-sqlite3";
import type { IBApiNext, Contract } from "@stoqey/ib";
import { SecType, OptionType } from "@stoqey/ib";
import type { Position } from "@stoqey/ib/dist/api-next";
import type { AccountUpdate } from "@stoqey/ib/dist/api-next/account/account-update";
import { getIbApi } from "./client";
import { upsertSecurity } from "../mutations/securities";
import { computeDailyValuations } from "../compute/daily-valuation";
import type { PositionSyncProgress, PositionSyncResult } from "./types";

// ── Type mappings ────────────────────────────────────────────────

function twsSecTypeToDbType(secType: string | undefined): string {
  switch (secType) {
    case SecType.STK: return "stock";
    case SecType.OPT: return "option";
    case SecType.BOND: return "bond";
    case SecType.FUND: return "mutual_fund";
    case SecType.FUT: return "future";
    case SecType.CASH: return "forex";
    default: return "stock";
  }
}

function twsSecTypeToAssetClass(secType: string | undefined): string {
  switch (secType) {
    case SecType.OPT: return "option";
    case SecType.BOND:
    case SecType.BILL: return "fixed_income";
    case SecType.FUND: return "fund";
    default: return "equity";
  }
}

// ── Symbol construction ──────────────────────────────────────────

/**
 * Build the canonical symbol for a TWS contract.
 * Options use OCC format to avoid stock/option collisions in upsertSecurity().
 */
export function buildSymbol(contract: Contract): string {
  if (
    contract.secType === SecType.OPT &&
    contract.symbol &&
    contract.strike != null &&
    contract.right
  ) {
    const underlying = (contract.symbol ?? "").padEnd(6, " ");
    const expiry = contract.lastTradeDateOrContractMonth ?? "";
    // TWS sends YYYYMMDD; OCC needs YYMMDD
    const yymmdd = expiry.length >= 8 ? expiry.slice(2, 8) : expiry.slice(2);
    const right = contract.right === OptionType.Put ? "P" : "C";
    const strike = String(Math.round(contract.strike * 1000)).padStart(8, "0");
    return `${underlying}${yymmdd}${right}${strike}`;
  }
  return contract.symbol ?? `UNKNOWN_${contract.conId}`;
}

// ── Observable helpers ───────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;

/** IBKR account code for the personal (non-advisor) account.
 *  getPositions() returns ALL linked accounts — we filter to just this one.
 *  Set IBKR_ACCOUNT_CODE in .env.local to your personal account ID. */
export const IBKR_PERSONAL_ACCOUNT = process.env.IBKR_ACCOUNT_CODE || "UXXXXXXXX";

/** Result from the combined getAccountUpdates() subscription. */
interface AccountData {
  positions: Position[];
  netLiquidation: number | null;
  cashBalance: number | null;
}

/**
 * Fetch positions + account values + market prices in a single TWS subscription.
 * getAccountUpdates() returns Position objects WITH marketPrice/marketValue
 * populated, unlike getPositions() which omits them. It also returns account
 * summary values (NLV, cash), eliminating the need for a separate
 * getAccountSummary() call.
 *
 * Uses a debounce pattern: TWS fires individual updatePortfolio and
 * updateAccountValue events, then signals completion via accountDownloadEnd.
 * We wait 1s after the last emission to capture the complete snapshot.
 */
async function fetchAccountDataFromTws(
  api: IBApiNext,
  accountFilter?: string,
): Promise<AccountData> {
  return new Promise<AccountData>((resolve, reject) => {
    let latestUpdate: AccountUpdate | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(overallTimeout);
      if (debounceTimer) clearTimeout(debounceTimer);
      sub.unsubscribe();
      resolve(extractAccountData(latestUpdate, accountFilter));
    };

    const overallTimeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      sub.unsubscribe();
      // Timeout with partial data is OK — return what we have
      resolve(extractAccountData(latestUpdate, accountFilter));
    }, FETCH_TIMEOUT_MS);

    const sub = api.getAccountUpdates(accountFilter).subscribe({
      next: (update) => {
        latestUpdate = update.all;

        // Detect accountDownloadEnd: TWS emits { all } with no added/changed/removed
        // after the initial snapshot is fully delivered. This is the fastest resolution path.
        if (!update.added && !update.changed && !update.removed) {
          finish();
          return;
        }

        // Fallback debounce for incremental updates: wait 1s after last emission.
        // This covers edge cases where accountDownloadEnd might not fire.
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(finish, 1_000);
      },
      error: (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(overallTimeout);
        if (debounceTimer) clearTimeout(debounceTimer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    });
  });
}

/** Extract positions and account values from an AccountUpdate snapshot. */
function extractAccountData(
  update: AccountUpdate | null,
  accountFilter?: string,
): AccountData {
  if (!update) {
    return { positions: [], netLiquidation: null, cashBalance: null };
  }

  // Extract positions (with marketPrice populated)
  const positions: Position[] = [];
  if (update.portfolio) {
    for (const [acctId, acctPositions] of update.portfolio) {
      if (accountFilter && acctId !== accountFilter) continue;
      positions.push(...acctPositions);
    }
  }

  // Extract account summary values
  let netLiquidation: number | null = null;
  let cashBalance: number | null = null;
  if (update.value) {
    for (const [acctId, tags] of update.value) {
      if (accountFilter && acctId !== accountFilter) continue;
      const nlvValues = tags.get("NetLiquidation");
      const cashValues = tags.get("TotalCashValue");
      // Try USD first, then BASE (for accounts with non-USD base)
      const nlv = nlvValues?.get("USD")?.value ?? nlvValues?.get("BASE")?.value;
      const cash = cashValues?.get("USD")?.value ?? cashValues?.get("BASE")?.value;
      if (nlv != null) {
        netLiquidation = parseFloat(nlv);
        cashBalance = cash != null ? parseFloat(cash) : 0;
      }
    }
  }

  return { positions, netLiquidation, cashBalance };
}

// ── Main sync function ───────────────────────────────────────────

export async function syncPortfolio(
  db: Database.Database,
  options?: {
    onProgress?: (progress: PositionSyncProgress) => void;
    /** IBKR account code to filter positions. Defaults to personal account. */
    ibkrAccountCode?: string;
  },
): Promise<PositionSyncResult> {
  const api = getIbApi();
  if (!api) {
    throw new Error("TWS not connected");
  }

  const onProgress = options?.onProgress;

  // Look up IBKR account
  const account = db
    .prepare("SELECT id FROM accounts WHERE name = 'IBKR'")
    .get() as { id: number } | undefined;
  if (!account) {
    throw new Error("IBKR account not found in database");
  }
  const accountId = account.id;
  const today = new Date().toISOString().slice(0, 10);

  const accountCode = options?.ibkrAccountCode ?? IBKR_PERSONAL_ACCOUNT;

  // Phase 1: Fetch positions + account values + market prices in one call
  onProgress?.({ phase: "positions", message: "Fetching portfolio from TWS..." });
  const accountData = await fetchAccountDataFromTws(api, accountCode);
  const { positions } = accountData;

  // Phase 2: Commit positions to database
  onProgress?.({
    phase: "committing",
    message: `Processing ${positions.length} positions...`,
    total: positions.length,
  });

  let securitiesCreated = 0;
  let securitiesUpdated = 0;
  let positionsSynced = 0;
  let pricesSaved = 0;

  const upsertHolding = db.prepare(
    `INSERT OR REPLACE INTO holdings
     (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const updateConId = db.prepare(
    `UPDATE securities SET ib_con_id = ? WHERE id = ? AND ib_con_id IS NULL`
  );

  const upsertPrice = db.prepare(
    `INSERT OR REPLACE INTO prices (security_id, date, close_price, source)
     VALUES (?, ?, ?, 'tws')`
  );

  const existingSecurityIds = new Set(
    (db.prepare("SELECT id FROM securities").all() as { id: number }[]).map(r => r.id)
  );

  // Map securityId → marketPrice for saving prices after position commit
  const priceMap = new Map<number, number>();

  db.transaction(() => {
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];

      // Skip zero-quantity positions (recently closed)
      if (pos.pos === 0) continue;

      const contract = pos.contract;
      const symbol = buildSymbol(contract);
      const dbType = twsSecTypeToDbType(contract.secType);
      const assetClass = twsSecTypeToAssetClass(contract.secType);

      // Build option-specific params
      const isOption = contract.secType === SecType.OPT;

      const securityId = upsertSecurity(db, {
        symbol,
        name: contract.localSymbol || undefined,
        securityType: dbType,
        assetClass,
        underlyingSymbol: isOption ? contract.symbol : undefined,
        strikePrice: isOption ? contract.strike : undefined,
        expirationDate: isOption ? contract.lastTradeDateOrContractMonth : undefined,
        optionType: isOption
          ? (contract.right === OptionType.Put ? "PUT" : "CALL")
          : undefined,
        multiplier: contract.multiplier ? Number(contract.multiplier) : undefined,
      });

      if (!existingSecurityIds.has(securityId)) {
        securitiesCreated++;
        existingSecurityIds.add(securityId);
      }

      // Update ib_con_id if not already set
      if (contract.conId) {
        const changes = updateConId.run(contract.conId, securityId);
        if (changes.changes > 0) securitiesUpdated++;
      }

      // Upsert holding
      const costBasis = pos.avgCost != null ? pos.pos * pos.avgCost : null;
      const sourceKey = `tws-${accountId}-${securityId}-${today}`;
      upsertHolding.run(accountId, securityId, pos.pos, costBasis, today, sourceKey);

      // Collect market prices from getAccountUpdates() (not available from getPositions)
      if (pos.marketPrice != null && pos.marketPrice > 0) {
        priceMap.set(securityId, pos.marketPrice);
      }

      positionsSynced++;

      onProgress?.({
        phase: "committing",
        message: `${symbol} — ${pos.pos} shares`,
        current: i + 1,
        total: positions.length,
      });
    }
  })();

  // Phase 2.5: Save market prices (included in getAccountUpdates response)
  if (priceMap.size > 0) {
    onProgress?.({ phase: "prices", message: `Saving ${priceMap.size} market prices...` });

    db.transaction(() => {
      for (const [securityId, price] of priceMap) {
        upsertPrice.run(securityId, today, price);
        pricesSaved++;
      }
    })();

    console.log(`[syncPortfolio] Saved ${pricesSaved} market prices from getAccountUpdates()`);
  }

  // Phase 3: Save account summary (already fetched via getAccountUpdates)
  const { netLiquidation, cashBalance } = accountData;
  let snapshotInserted = false;

  if (netLiquidation != null) {
    onProgress?.({ phase: "account_summary", message: "Saving account summary..." });

    try {
      // Insert as a monthly_snapshots anchor — the cash inference in
      // computeDailyValuations will pick this up automatically.
      db.prepare(
        `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value, source)
         VALUES (?, ?, ?, 'tws')`
      ).run(accountId, today, netLiquidation);
      snapshotInserted = true;
    } catch (err) {
      console.warn("[syncPortfolio] Snapshot insert failed:", err);
    }
  }

  // Phase 4: Recompute daily valuations
  onProgress?.({ phase: "recomputing", message: "Recomputing valuations..." });

  let valuationsRecomputed = false;
  try {
    computeDailyValuations(db);
    valuationsRecomputed = true;
  } catch {
    // Non-critical
  }

  return {
    positionsSynced,
    securitiesCreated,
    securitiesUpdated,
    pricesSaved,
    netLiquidation,
    cashBalance,
    snapshotInserted,
    valuationsRecomputed,
  };
}
