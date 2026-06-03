#!/usr/bin/env tsx
/**
 * IBKR Tier 2 — TWS-independent holdings refresh via the headless Web API.
 *
 *   npx tsx scripts/ibkr-refresh-holdings.ts            # DRY: preview only
 *   npx tsx scripts/ibkr-refresh-holdings.ts --commit   # write to the DB
 *
 * Reads live positions + cost basis + account values over OAuth 1.0a (no TWS,
 * no Gateway), maps them, and writes EXACTLY like the TWS sync
 * (lib/tws/positions.ts): holdings source_key `tws-…`, prices/snapshot
 * source='tws', then computeDailyValuations. Reusing the 'tws' conventions means
 * zero changes to downstream queries/upserts — the Web API is functionally a
 * TWS-equivalent live sync of the same account. Writes today's (ET) snapshot;
 * prior dates are untouched.
 */

import { db } from "@/lib/db";
import { loadIbkrConfig } from "@/lib/ibkr/config";
import { openSession, getPortfolioAccounts, getPositions, getLedger } from "@/lib/ibkr/web-api";
import { mapPosition } from "@/lib/ibkr/map-positions";
import { upsertSecurity } from "@/lib/mutations/securities";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { todayET } from "@/lib/calendar/date-utils";

const COMMIT = process.argv.includes("--commit");
const DB_ACCOUNT_NAME = "IBKR";

async function main() {
  const cfg = loadIbkrConfig();
  if (!cfg) {
    console.error("IBKR OAuth not configured (data/ibkr-oauth/credentials.json missing or incomplete).");
    process.exit(1);
  }

  console.log("→ opening IBKR session (headless OAuth 1.0a, no TWS)…");
  const lst = await openSession(cfg);
  const accts = await getPortfolioAccounts(cfg, lst.token);
  const ibkr = accts[0];
  console.log(`  account ${ibkr.accountId} (${ibkr.accountTitle ?? ""}), LST expires ${new Date(lst.expirationMs).toISOString()}`);

  const raw = await getPositions(cfg, lst.token, ibkr.accountId);
  const mapped = raw.map(mapPosition);
  const nonzero = mapped.filter((m) => m.quantity !== 0);
  const today = todayET();

  // Ledger → base-currency net liq + cash.
  const ledger = (await getLedger(cfg, lst.token, ibkr.accountId)) as Record<string, Record<string, unknown>>;
  const base =
    ledger.BASE ??
    ledger.USD ??
    Object.values(ledger).find((v) => (v as { currency?: string })?.currency === "USD") ??
    {};
  const netLiq = (base.netliquidationvalue as number | undefined) ?? null;
  const cash = (base.cashbalance as number | undefined) ?? (base.settledcash as number | undefined) ?? null;

  // Existing-security lookup to flag any symbol that would create a NEW row
  // (an option OCC mismatch vs the TWS path would silently duplicate).
  const existing = new Set(
    (db.prepare("SELECT symbol FROM securities").all() as { symbol: string }[]).map((r) => r.symbol),
  );

  console.log(`\n=== LIVE IBKR POSITIONS — ${nonzero.length} nonzero / ${mapped.length} total — as of ${today} ===`);
  let newSecs = 0;
  for (const m of [...nonzero].sort((a, b) => Math.abs(b.mktValue ?? 0) - Math.abs(a.mktValue ?? 0))) {
    const isNew = !existing.has(m.symbol);
    if (isNew) newSecs++;
    const cb = m.costBasis != null ? m.costBasis.toFixed(0) : "?";
    console.log(
      `  ${m.symbol.padEnd(22)} ${String(m.quantity).padStart(6)} @ ${(m.mktPrice ?? 0).toFixed(2).padStart(9)}` +
        `  mktVal ${(m.mktValue ?? 0).toFixed(0).padStart(10)}  cost ${cb.padStart(9)}  [${m.securityType}]${isNew ? "  ⚠ NEW security" : ""}`,
    );
  }
  console.log(`\n  Net liquidation: ${netLiq}   Cash: ${cash}`);
  console.log(`  Securities already in DB: ${nonzero.length - newSecs}/${nonzero.length}` + (newSecs ? `  (${newSecs} would be NEW — verify these aren't OCC dupes)` : "  (all match existing — no dupes)"));

  const acctRow = db.prepare("SELECT id FROM accounts WHERE name = ?").get(DB_ACCOUNT_NAME) as { id: number } | undefined;
  if (!acctRow) {
    console.error(`DB account '${DB_ACCOUNT_NAME}' not found.`);
    process.exit(1);
  }
  const accountId = acctRow.id;
  const dbLatest = db.prepare("SELECT MAX(as_of_date) d FROM holdings WHERE account_id = ?").get(accountId) as { d: string };
  console.log(`  DB '${DB_ACCOUNT_NAME}' (id ${accountId}) latest holdings date: ${dbLatest.d} → writing ${today}`);

  if (!COMMIT) {
    console.log("\n[DRY RUN] no writes. Re-run with --commit to write today's positions + prices + account snapshot (source='tws', mirrors the TWS sync).");
    return;
  }

  const upsertHolding = db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?,?,?,?,?,?)`,
  );
  const upsertPrice = db.prepare(
    `INSERT OR REPLACE INTO prices (security_id, date, close_price, source) VALUES (?,?,?,'tws')`,
  );
  const updateConId = db.prepare(`UPDATE securities SET ib_con_id = ? WHERE id = ? AND ib_con_id IS NULL`);

  let positionsWritten = 0;
  let pricesWritten = 0;
  db.transaction(() => {
    for (const m of nonzero) {
      const securityId = upsertSecurity(db, {
        symbol: m.symbol,
        securityType: m.securityType,
        assetClass: m.assetClass,
        underlyingSymbol: m.underlyingSymbol,
        strikePrice: m.strikePrice,
        expirationDate: m.expirationDate,
        optionType: m.optionType,
        multiplier: m.multiplier,
      });
      if (m.conid != null) updateConId.run(m.conid, securityId);
      upsertHolding.run(accountId, securityId, m.quantity, m.costBasis, today, `tws-${accountId}-${securityId}-${today}`);
      positionsWritten++;
      if (m.mktPrice != null && m.mktPrice > 0) {
        upsertPrice.run(securityId, today, m.mktPrice);
        pricesWritten++;
      }
    }
  })();

  if (netLiq != null) {
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source)
       VALUES (?,?,?,?,'tws')
       ON CONFLICT(account_id, month_end_date) DO UPDATE SET
         total_value = excluded.total_value, cash_value = excluded.cash_value, source = excluded.source
       WHERE monthly_snapshots.source IN ('tws','manual')`,
    ).run(accountId, today, netLiq, cash);
  }

  try {
    computeDailyValuations(db);
  } catch (e) {
    console.warn("valuations recompute warning:", (e as Error)?.message);
  }

  console.log(`\n✓ COMMITTED ${positionsWritten} positions + ${pricesWritten} prices + account snapshot (netLiq ${netLiq}) as of ${today}, source='tws'. Valuations recomputed.`);
}

main().catch((e) => {
  console.error("FAILED:", (e as Error)?.message ?? e);
  process.exit(1);
});
